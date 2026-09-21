import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { AudioContextService, createAudioInputSink, type AudioContextLike } from '../../src/engines/audio/context.js';
import { loadSoundPackManifest, SoundBank, type AssetFetcher, type AudioBufferLike, type SoundPackDefinition } from '../../src/engines/audio/soundBank.js';
import type { AudioNodeLike, BufferSourceLike, GainNodeLike, GainParamLike } from '../../src/engines/audio/voices.js';

const publicRoot = fileURLToPath(new URL('../../public/', import.meta.url));

const fileFetcher: AssetFetcher = async (assetPath) => ({
  async arrayBuffer() {
    const bytes = await readFile(`${publicRoot}${assetPath}`);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  },
});

class FakeParam implements GainParamLike {
  value = 1;
  readonly ramps: number[] = [];
  cancelScheduledValues(): void {}
  setValueAtTime(value: number): void { this.value = value; }
  linearRampToValueAtTime(value: number): void { this.value = value; this.ramps.push(value); }
}

class FakeGain implements GainNodeLike {
  readonly gain = new FakeParam();
  connect(): unknown { return this; }
  disconnect(): void {}
}

class FakeSource implements BufferSourceLike {
  buffer: AudioBufferLike | null = null;
  onended: (() => void) | null = null;
  startedAt: number | null = null;
  stoppedAt: number | null = null;
  connect(): unknown { return this; }
  disconnect(): void {}
  start(when = 0): void { this.startedAt = when; }
  stop(when = 0): void { this.stoppedAt = when; }
}

class FakeAudioContext implements AudioContextLike {
  state: 'suspended' | 'running' | 'closed' = 'suspended';
  currentTime = 4.25;
  baseLatency = 0.006;
  outputLatency = 0.012;
  destination: AudioNodeLike = { connect: () => undefined, disconnect: () => undefined };
  readonly sources: FakeSource[] = [];
  readonly gains: FakeGain[] = [];
  failResume = false;
  async resume(): Promise<void> { if (this.failResume) throw new Error('device unavailable'); this.state = 'running'; }
  async close(): Promise<void> { this.state = 'closed'; }
  createGain(): FakeGain { const gain = new FakeGain(); this.gains.push(gain); return gain; }
  createBufferSource(): FakeSource { const source = new FakeSource(); this.sources.push(source); return source; }
  createBuffer(channels: number, length: number, sampleRate: number) {
    return { length, sampleRate, numberOfChannels: channels, copyToChannel: (_source: Float32Array) => undefined };
  }
}

async function definition(): Promise<SoundPackDefinition> {
  return (await loadSoundPackManifest(fileFetcher)).packs[0];
}

describe('M09 sound pack and Web Audio lifecycle', () => {
  it('verifies the checked-in manifest assets and creates audio only after a gesture', async () => {
    const context = new FakeAudioContext();
    const factory = vi.fn(() => context);
    const audio = new AudioContextService(factory, fileFetcher);
    expect(factory).not.toHaveBeenCalled();
    expect(audio.diagnostics().state).toBe('locked');
    expect(await audio.unlockFromGesture()).toBe(true);
    expect(factory).toHaveBeenCalledOnce();
    expect(context.state).toBe('running');
    expect(await audio.prepare(await definition())).toBe(true);
    expect(audio.diagnostics()).toMatchObject({ state: 'ready', baseLatency: 0.006, outputLatency: 0.012 });
    const scheduled = audio.trigger('letter', 10);
    expect(scheduled).toMatchObject({ inputAt: 10, scheduledAt: 4.25 });
    expect(context.sources).toHaveLength(1);
  });

  it('fails closed on a checksum mismatch and keeps at most two decoded packs', async () => {
    const context = new FakeAudioContext();
    const bank = new SoundBank(fileFetcher);
    const base = await definition();
    const bad = structuredClone(base);
    bad.id = 'bad';
    bad.samples.letter[0].sha256 = '0'.repeat(64);
    await expect(bank.load(bad, context)).rejects.toThrow('checksum mismatch');
    for (const id of ['one', 'two', 'three']) await bank.load({ ...base, id }, context);
    expect(bank.cachedPackCount).toBe(2);
    expect(bank.decodedBytes).toBeGreaterThan(0);
  });

  it('caps simultaneous one-shot voices and ramps the oldest voice on overflow', async () => {
    const context = new FakeAudioContext();
    const audio = new AudioContextService(() => context, fileFetcher);
    await audio.unlockFromGesture();
    await audio.prepare(await definition());
    for (let index = 0; index < 25; index += 1) audio.trigger('letter');
    expect(audio.activeVoiceCount).toBe(24);
    expect(context.sources[0].stoppedAt).toBe(4.255);
    expect(context.gains[1].gain.ramps).toEqual([0]);
  });

  it('schedules one sound for an IME composition and maps delete/error categories', async () => {
    const context = new FakeAudioContext();
    const audio = new AudioContextService(() => context, fileFetcher);
    await audio.unlockFromGesture();
    await audio.prepare(await definition());
    const sink = createAudioInputSink(audio);
    sink.onCommit({ kind: 'composition', graphemes: ['你', '好'], deltas: [
      { kind: 'accepted', grapheme: '你', correct: true, position: 0 },
      { kind: 'accepted', grapheme: '好', correct: true, position: 1 },
    ] });
    sink.onCommit({ kind: 'text', graphemes: ['x'], deltas: [{ kind: 'accepted', grapheme: 'x', correct: false, position: 2 }] });
    sink.onCommit({ kind: 'delete', graphemes: [], deltas: [] });
    expect(context.sources).toHaveLength(3);
  });

  it('reports suspension without scheduling and degrades safely after resume failure', async () => {
    const context = new FakeAudioContext();
    const audio = new AudioContextService(() => context, fileFetcher);
    await audio.unlockFromGesture();
    await audio.prepare(await definition());
    context.state = 'suspended';
    expect(audio.trigger('space')).toBeNull();
    expect(audio.diagnostics().state).toBe('suspended');

    const failedContext = new FakeAudioContext();
    failedContext.failResume = true;
    const failed = new AudioContextService(() => failedContext, fileFetcher);
    expect(await failed.unlockFromGesture()).toBe(false);
    expect(failed.diagnostics().state).toBe('failed');
    expect(failed.trigger('letter')).toBeNull();
  });

  it('stops voices, clears cached buffers, and closes the context', async () => {
    const context = new FakeAudioContext();
    const audio = new AudioContextService(() => context, fileFetcher);
    await audio.unlockFromGesture();
    await audio.prepare(await definition());
    audio.trigger('letter');
    await audio.close();
    expect(context.state).toBe('closed');
    expect(audio.diagnostics().state).toBe('closed');
    expect(audio.bank.cachedPackCount).toBe(0);
  });
});
