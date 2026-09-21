import type { AudioBufferLike, LoadedSample } from './soundBank.js';

export interface GainParamLike { value: number; cancelScheduledValues(time: number): void; setValueAtTime(value: number, time: number): void; linearRampToValueAtTime(value: number, time: number): void }
export interface AudioNodeLike { connect(destination: unknown): unknown; disconnect(): void }
export interface GainNodeLike extends AudioNodeLike { gain: GainParamLike }
export interface BufferSourceLike extends AudioNodeLike { buffer: AudioBufferLike | null; onended: (() => void) | null; start(when?: number): void; stop(when?: number): void }
export interface VoiceContext { currentTime: number; createGain(): GainNodeLike; createBufferSource(): BufferSourceLike }

interface Voice { source: BufferSourceLike; gain: GainNodeLike; startedAt: number }
export const MAX_SIMULTANEOUS_VOICES = 24;

export class VoicePool {
  private readonly voices: Voice[] = [];
  constructor(private readonly context: VoiceContext, private readonly output: AudioNodeLike, private readonly cap = MAX_SIMULTANEOUS_VOICES) {}
  play(sample: LoadedSample): number {
    if (this.voices.length >= this.cap) this.release(this.voices[0], true);
    const gain = this.context.createGain();
    gain.gain.value = sample.gain;
    gain.connect(this.output);
    const source = this.context.createBufferSource();
    source.buffer = sample.buffer;
    source.connect(gain);
    const voice: Voice = { source, gain, startedAt: this.context.currentTime };
    source.onended = () => this.release(voice, false);
    this.voices.push(voice);
    source.start(this.context.currentTime);
    return voice.startedAt;
  }
  stopAll(): void { for (const voice of [...this.voices]) this.release(voice, true); }
  private release(voice: Voice, ramp: boolean): void {
    const index = this.voices.indexOf(voice);
    if (index >= 0) this.voices.splice(index, 1);
    if (ramp) {
      const now = this.context.currentTime;
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
      voice.gain.gain.linearRampToValueAtTime(0, now + 0.005);
      voice.source.onended = () => this.disconnect(voice);
      try { voice.source.stop(now + 0.005); } catch { this.disconnect(voice); }
      return;
    }
    this.disconnect(voice);
  }
  private disconnect(voice: Voice): void {
    try { voice.source.disconnect(); } catch { /* already disconnected */ }
    try { voice.gain.disconnect(); } catch { /* already disconnected */ }
  }
  get activeVoiceCount(): number { return this.voices.length; }
}
