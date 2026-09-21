import type { CanvasThemeSnapshot } from '../../app/themeController.js';

export interface MotionPolicy { reduced: boolean; precisionCaret: boolean }
export interface FrameSource {
  request(callback: FrameRequestCallback): number;
  cancel(handle: number): void;
}

export const browserFrameSource: FrameSource = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle),
};

export function motionPolicy(theme: CanvasThemeSnapshot, precisionCaret = false): MotionPolicy {
  return { reduced: theme.reducedMotion, precisionCaret };
}

/** Coalesces unrelated paint requests into one callback for a browser frame. */
export class FrameScheduler {
  private handle: number | null = null;
  private readonly work = new Set<(timestamp: number) => void>();
  constructor(private readonly source: FrameSource = browserFrameSource) {}
  schedule(callback: (timestamp: number) => void): void {
    this.work.add(callback);
    if (this.handle !== null) return;
    this.handle = this.source.request((timestamp) => {
      this.handle = null;
      const pending = [...this.work];
      this.work.clear();
      for (const item of pending) item(timestamp);
    });
  }
  cancel(): void {
    if (this.handle !== null) this.source.cancel(this.handle);
    this.handle = null;
    this.work.clear();
  }
  get pending(): boolean { return this.handle !== null; }
}
