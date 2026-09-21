export const KEYBOARD_SOUND_PROFILES = [
  { id: 'clicky', name: 'Clicky', description: 'Bright, crisp switch clicks' },
  { id: 'thocky', name: 'Thocky', description: 'Deep, rounded key impacts' },
  { id: 'tactile', name: 'Tactile', description: 'Muted switch bumps' },
  { id: 'linear', name: 'Linear', description: 'Smooth, quiet keystrokes' },
] as const;

export type KeyboardSoundProfile = (typeof KEYBOARD_SOUND_PROFILES)[number]['id'];
export type KeyboardSoundKind = 'letter' | 'space' | 'backspace';
export type KeyDirection = 'down' | 'up';

interface SoundEvent {
  waveform: OscillatorType;
  frequency: number;
  durationMs: number;
  filterType: BiquadFilterType;
  filterFrequency: number;
  filterQ: number;
  gain: number;
}

interface SoundProfile {
  down: SoundEvent;
  up: SoundEvent;
}

const PROFILES: Record<KeyboardSoundProfile, SoundProfile> = {
  clicky: {
    down: { waveform: 'square', frequency: 2_800, durationMs: 45, filterType: 'bandpass', filterFrequency: 3_000, filterQ: 2, gain: .3 },
    up: { waveform: 'square', frequency: 3_200, durationMs: 25, filterType: 'bandpass', filterFrequency: 3_500, filterQ: 2, gain: .25 },
  },
  thocky: {
    down: { waveform: 'sine', frequency: 138, durationMs: 82, filterType: 'lowpass', filterFrequency: 430, filterQ: .8, gain: .58 },
    up: { waveform: 'sine', frequency: 96, durationMs: 42, filterType: 'lowpass', filterFrequency: 320, filterQ: .6, gain: .22 },
  },
  tactile: {
    down: { waveform: 'sawtooth', frequency: 450, durationMs: 25, filterType: 'lowpass', filterFrequency: 800, filterQ: 1, gain: .4 },
    up: { waveform: 'sine', frequency: 300, durationMs: 15, filterType: 'lowpass', filterFrequency: 500, filterQ: 1, gain: .15 },
  },
  linear: {
    down: { waveform: 'sine', frequency: 600, durationMs: 20, filterType: 'lowpass', filterFrequency: 1_000, filterQ: .5, gain: .2 },
    up: { waveform: 'sine', frequency: 500, durationMs: 12, filterType: 'lowpass', filterFrequency: 800, filterQ: .5, gain: .12 },
  },
};

function clampVolume(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Procedural keyboard audio adapted from KetakKetik's oscillator/filter model.
 * It creates no AudioContext until a user keystroke and requires no sound files. */
export class KeyboardSoundPlayer {
  private context: AudioContext | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private voices = new Set<OscillatorNode>();
  private volume = .8;
  private variant = 0;

  async playKey(kind: KeyboardSoundKind, direction: KeyDirection, profile: KeyboardSoundProfile, volume: number): Promise<void> {
    this.setVolume(volume);
    const context = await this.readyContext();
    if (!context || !this.compressor || this.volume === 0) return;
    const config = PROFILES[profile][direction];
    const kindPitch = kind === 'space' ? .78 : kind === 'backspace' ? .64 : 1;
    const variation = [.965, 1, 1.035, .985][this.variant++ % 4];
    const oscillator = context.createOscillator();
    const filter = context.createBiquadFilter();
    const gain = context.createGain();
    const start = context.currentTime;
    const stop = start + config.durationMs / 1_000;
    oscillator.type = config.waveform;
    oscillator.frequency.value = config.frequency * kindPitch * variation;
    filter.type = config.filterType;
    filter.frequency.value = config.filterFrequency;
    filter.Q.value = config.filterQ;
    const level = this.volume * config.gain * 10 ** ((Math.random() - .5) / 20);
    gain.gain.setValueAtTime(level, start);
    gain.gain.exponentialRampToValueAtTime(.0001, stop);
    oscillator.connect(filter).connect(gain).connect(this.compressor);
    this.track(oscillator, filter, gain);
    oscillator.start(start);
    oscillator.stop(stop);
  }

  async playFeedback(kind: 'complete' | 'mistake', volume: number): Promise<void> {
    this.setVolume(volume);
    const context = await this.readyContext();
    if (!context || !this.compressor || this.volume === 0) return;
    const notes = kind === 'complete' ? [523.25, 659.25, 783.99, 1_046.5, 1_318.5] : [220, 146.83];
    const spacing = kind === 'complete' ? .1 : .065;
    const duration = kind === 'complete' ? .27 : .09;
    notes.forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const start = context.currentTime + index * spacing;
      const stop = start + duration;
      oscillator.type = kind === 'complete' ? 'sine' : 'triangle';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(.0001, start);
      gain.gain.linearRampToValueAtTime(this.volume * (kind === 'mistake' ? .32 : .3), start + .008);
      gain.gain.exponentialRampToValueAtTime(.0001, stop);
      oscillator.connect(gain).connect(this.compressor!);
      this.track(oscillator, gain);
      oscillator.start(start);
      oscillator.stop(stop);
    });
  }

  setVolume(volume: number): void {
    this.volume = clampVolume(volume);
  }

  async close(): Promise<void> {
    for (const voice of this.voices) {
      try { voice.stop(); } catch { /* voice already ended */ }
      try { voice.disconnect(); } catch { /* voice already disconnected */ }
    }
    this.voices.clear();
    this.compressor?.disconnect();
    this.compressor = null;
    try { await this.context?.close(); } catch { /* audio device already closed */ }
    this.context = null;
  }

  private async readyContext(): Promise<AudioContext | null> {
    if (typeof window === 'undefined') return null;
    const Constructor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Constructor) return null;
    if (!this.context || this.context.state === 'closed') {
      this.context = new Constructor({ latencyHint: 'interactive' });
      this.compressor = this.context.createDynamicsCompressor();
      this.compressor.threshold.value = -6;
      this.compressor.knee.value = 10;
      this.compressor.ratio.value = 4;
      this.compressor.attack.value = .002;
      this.compressor.release.value = .02;
      this.compressor.connect(this.context.destination);
    }
    if (this.context.state !== 'running') await this.context.resume();
    return this.context;
  }

  private track(oscillator: OscillatorNode, ...nodes: AudioNode[]): void {
    this.voices.add(oscillator);
    oscillator.onended = () => {
      try { oscillator.disconnect(); } catch { /* already disconnected */ }
      for (const node of nodes) try { node.disconnect(); } catch { /* already disconnected */ }
      this.voices.delete(oscillator);
    };
  }
}
