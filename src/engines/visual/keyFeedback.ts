import type { FrameScheduler } from './motion.js';

export type KeyElementResolver = (code: string) => HTMLElement | null;
export interface KeyFeedbackOptions {
  resolve: KeyElementResolver;
  frames: FrameScheduler;
  reducedMotion: boolean;
  pulseMs?: number;
  setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

/** Physical-key decoration only; it never participates in scoring. */
export class KeyFeedbackController {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly touched = new Set<HTMLElement>();
  private readonly pulseMs: number;
  private readonly setTimer: NonNullable<KeyFeedbackOptions['setTimer']>;
  private readonly clearTimer: NonNullable<KeyFeedbackOptions['clearTimer']>;
  constructor(private readonly options: KeyFeedbackOptions) {
    this.pulseMs = Math.max(60, Math.min(90, options.pulseMs ?? 75));
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }
  update(code: string, pressed: boolean): void {
    const element = this.options.resolve(code);
    if (!element) return;
    this.touched.add(element);
    if (pressed) {
      this.clear(code);
      element.dataset.ffKeyState = 'pressed';
      element.dataset.ffKeyMotion = this.options.reducedMotion ? 'static' : 'pulse';
      return;
    }
    if (this.options.reducedMotion) { element.dataset.ffKeyState = 'idle'; return; }
    this.clear(code);
    this.options.frames.schedule(() => { element.dataset.ffKeyState = 'releasing'; });
    const handle = this.setTimer(() => {
      element.dataset.ffKeyState = 'idle';
      this.timers.delete(code);
    }, this.pulseMs);
    this.timers.set(code, handle);
  }
  cancel(): void {
    for (const handle of this.timers.values()) this.clearTimer(handle);
    this.timers.clear();
    this.options.frames.cancel();
    for (const element of this.touched) element.dataset.ffKeyState = 'idle';
    this.touched.clear();
  }
  private clear(code: string): void {
    const prior = this.timers.get(code);
    if (prior !== undefined) this.clearTimer(prior);
    this.timers.delete(code);
  }
  get pendingPulseCount(): number { return this.timers.size; }
}
