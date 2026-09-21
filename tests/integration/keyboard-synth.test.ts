// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { KeyboardSoundPlayer } from '../../src/engines/audio/keyboardSynth.js';

function parameter() {
  return { value: 0, setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() };
}

function audioNode() {
  return { connect: vi.fn((destination: unknown) => destination), disconnect: vi.fn() };
}

function audioHarness() {
  const oscillators: Array<ReturnType<typeof audioNode> & { type: OscillatorType; frequency: ReturnType<typeof parameter>; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; onended: (() => void) | null }> = [];
  const filters: Array<ReturnType<typeof audioNode> & { type: BiquadFilterType; frequency: ReturnType<typeof parameter>; Q: ReturnType<typeof parameter> }> = [];
  const gains: Array<ReturnType<typeof audioNode> & { gain: ReturnType<typeof parameter> }> = [];
  const compressor = { ...audioNode(), threshold: parameter(), knee: parameter(), ratio: parameter(), attack: parameter(), release: parameter() };
  const context = {
    state: 'running', currentTime: 1, destination: audioNode(), sampleRate: 48_000,
    resume: vi.fn(async () => undefined), close: vi.fn(async () => undefined),
    createDynamicsCompressor: vi.fn(() => compressor),
    createOscillator: vi.fn(() => { const value = { ...audioNode(), type: 'sine' as OscillatorType, frequency: parameter(), start: vi.fn(), stop: vi.fn(), onended: null }; oscillators.push(value); return value; }),
    createBiquadFilter: vi.fn(() => { const value = { ...audioNode(), type: 'lowpass' as BiquadFilterType, frequency: parameter(), Q: parameter() }; filters.push(value); return value; }),
    createGain: vi.fn(() => { const value = { ...audioNode(), gain: parameter() }; gains.push(value); return value; }),
  };
  const Constructor = vi.fn(function () { return context; });
  vi.stubGlobal('AudioContext', Constructor);
  return { context, oscillators, filters, gains };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('procedural keyboard sound', () => {
  it('uses distinct clicky and thocky switch profiles at the selected volume', async () => {
    const { oscillators, filters, gains } = audioHarness();
    const player = new KeyboardSoundPlayer();
    await player.playKey('letter', 'down', 'clicky', .9);
    await player.playKey('letter', 'down', 'thocky', .9);

    expect(oscillators[0].type).toBe('square');
    expect(filters[0].type).toBe('bandpass');
    expect(oscillators[1].type).toBe('sine');
    expect(filters[1].type).toBe('lowpass');
    expect(gains[1].gain.setValueAtTime.mock.calls[0][0]).toBeGreaterThan(.45);
  });

  it('uses a louder two-note descending cue for mistakes', async () => {
    const { oscillators, gains } = audioHarness();
    const player = new KeyboardSoundPlayer();
    await player.playFeedback('mistake', .8);

    expect(oscillators).toHaveLength(2);
    expect(oscillators.map((voice) => voice.type)).toEqual(['triangle', 'triangle']);
    expect(oscillators.map((voice) => voice.frequency.value)).toEqual([220, 146.83]);
    expect(gains[0].gain.linearRampToValueAtTime.mock.calls[0][0]).toBeCloseTo(.4);
  });
});
