import type { InputSink } from '../../features/typing/inputAdapter.js';
import { SoundBank, type AssetFetcher, type BufferFactory, type LoadedSoundPack, type SoundCategory, type SoundPackDefinition } from './soundBank.js';
import { VoicePool, type AudioNodeLike, type GainNodeLike, type VoiceContext } from './voices.js';

export type AudioReadiness = 'locked' | 'loading' | 'ready' | 'suspended' | 'failed' | 'muted' | 'closed';
export interface AudioContextLike extends VoiceContext, BufferFactory {
  state: 'suspended' | 'running' | 'closed';
  destination: AudioNodeLike;
  baseLatency?: number;
  outputLatency?: number;
  resume(): Promise<void>;
  close(): Promise<void>;
}
export interface SchedulingSample { inputAt: number; handlerAt: number; scheduledAt: number; applicationLatencyMs: number }
export interface AudioDiagnostics { state: AudioReadiness; baseLatency: number | null; outputLatency: number | null; samples: SchedulingSample[] }

export class AudioContextService {
  private context: AudioContextLike | null = null;
  private master: GainNodeLike | null = null;
  private voices: VoicePool | null = null;
  private pack: LoadedSoundPack | null = null;
  private state: AudioReadiness = 'locked';
  private muted = false;
  private volume = 1;
  private variant = 0;
  private readonly samples: SchedulingSample[] = [];
  readonly bank: SoundBank;

  constructor(
    private readonly factory: () => AudioContextLike,
    fetcher: AssetFetcher,
    private readonly now = () => performance.now(),
    verifyHashes = true,
  ) { this.bank = new SoundBank(fetcher, verifyHashes); }

  async unlockFromGesture(): Promise<boolean> {
    if (this.state === 'closed') return false;
    if (this.muted) { this.state = 'muted'; return true; }
    try {
      this.context ??= this.factory();
      if (this.context.state === 'suspended') await this.context.resume();
      if (this.context.state !== 'running') throw new Error('Audio context did not enter running state');
      if (!this.master) {
        this.master = this.context.createGain();
        this.master.gain.value = this.volume * 0.8;
        this.master.connect(this.context.destination);
        this.voices = new VoicePool(this.context, this.master);
      }
      this.state = this.pack ? 'ready' : 'locked';
      return true;
    } catch {
      this.voices?.stopAll();
      try { await this.context?.close(); } catch { /* device already failed */ }
      this.context = null;
      this.master = null;
      this.voices = null;
      this.pack = null;
      this.bank.clear();
      this.state = 'failed';
      return false;
    }
  }

  async prepare(definition: SoundPackDefinition): Promise<boolean> {
    if (this.muted) { this.state = 'muted'; return true; }
    if (!this.context && !await this.unlockFromGesture()) return false;
    this.state = 'loading';
    try {
      this.pack = await this.bank.load(definition, this.context!);
      this.state = this.context!.state === 'running' ? 'ready' : 'suspended';
      return this.state === 'ready';
    } catch { this.state = 'failed'; return false; }
  }

  trigger(category: SoundCategory, inputAt = this.now()): SchedulingSample | null {
    const handlerAt = this.now();
    if (this.state === 'closed' || this.muted || !this.context || !this.pack || !this.voices) return null;
    if (this.context.state !== 'running') { this.state = 'suspended'; return null; }
    const variants = this.pack.categories[category];
    if (variants.length === 0) return null;
    const scheduledAt = this.voices.play(variants[this.variant++ % variants.length]);
    const sample = { inputAt, handlerAt, scheduledAt, applicationLatencyMs: this.now() - handlerAt };
    this.samples.push(sample);
    if (this.samples.length > 10_000) this.samples.shift();
    return sample;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) {
      this.voices?.stopAll();
      this.state = 'muted';
      return;
    }
    this.state = this.context?.state === 'running' && this.pack ? 'ready'
      : this.context?.state === 'suspended' ? 'suspended' : 'locked';
  }
  setVolume(volume: number): void { this.volume = Math.max(0, Math.min(1, volume)); if (this.master) this.master.gain.value = this.volume * 0.8; }
  async close(): Promise<void> { this.voices?.stopAll(); await this.context?.close(); this.state = 'closed'; this.bank.clear(); }
  diagnostics(): AudioDiagnostics { return { state: this.state, baseLatency: this.context?.baseLatency ?? null,
    outputLatency: this.context?.outputLatency ?? null, samples: [...this.samples] }; }
  get activeVoiceCount(): number { return this.voices?.activeVoiceCount ?? 0; }
}

export function createAudioInputSink(audio: AudioContextService): InputSink {
  return {
    onCommit(commit) {
      if (commit.kind === 'delete') { audio.trigger('backspace'); return; }
      const accepted = commit.deltas.filter((delta) => delta.kind === 'accepted');
      if (accepted.length === 0) return;
      const first = commit.graphemes[0];
      const category: SoundCategory = accepted.some((delta) => delta.kind === 'accepted' && !delta.correct)
        ? 'error' : first === ' ' ? 'space' : first === '\n' ? 'enter' : 'letter';
      // Composition batches intentionally schedule one sound for the whole commit.
      audio.trigger(category);
    },
  };
}

/** Production browser/Electron renderer factory. Construction remains lazy: an
 * AudioContext is not created until unlockFromGesture() is called. */
export function createBrowserAudioContextService(): AudioContextService {
  const fetcher: AssetFetcher = async (assetPath) => fetch(new URL(assetPath, document.baseURI));
  return new AudioContextService(() => {
    const Constructor = window.AudioContext;
    if (!Constructor) throw new Error('Web Audio is unavailable');
    return new Constructor({ latencyHint: 'interactive' }) as unknown as AudioContextLike;
  }, fetcher);
}
