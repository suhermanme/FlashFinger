import type { CanvasThemeSnapshot } from '../../app/themeController.js';
import type { EngineDelta } from '../../domain/typing/types.js';
import { FrameScheduler, type FrameSource, type MotionPolicy, browserFrameSource } from './motion.js';
import type { KeyFeedbackController } from './keyFeedback.js';

export const MAX_EFFECT_PARTICLES = 24;
const COMPLETION_DURATION_MS = 220;

interface Particle { active: boolean; x: number; y: number; vx: number; vy: number; bornAt: number; size: number }
export interface CompletionEffectsOptions {
  host: HTMLElement;
  caret: HTMLElement;
  canvas?: HTMLCanvasElement | null;
  theme: CanvasThemeSnapshot;
  motion: MotionPolicy;
  frames?: FrameSource;
  particleCount?: number;
}

export class CompletionEffects {
  private readonly particles: Particle[];
  private readonly frames: FrameScheduler;
  private readonly context: CanvasRenderingContext2D | null;
  private running = false;
  private startAt = 0;
  constructor(private readonly options: CompletionEffectsOptions) {
    const count = Math.max(0, Math.min(MAX_EFFECT_PARTICLES, options.particleCount ?? MAX_EFFECT_PARTICLES));
    this.particles = Array.from({ length: count }, () => ({ active: false, x: 0, y: 0, vx: 0, vy: 0, bornAt: 0, size: 2 }));
    this.frames = new FrameScheduler(options.frames ?? browserFrameSource);
    this.context = options.canvas?.getContext('2d') ?? null;
    options.caret.dataset.ffCaretMotion = options.motion.reduced || options.motion.precisionCaret ? 'snap' : 'interpolate';
  }
  handleDeltas(deltas: readonly EngineDelta[]): void {
    if (deltas.some((delta) => delta.kind === 'sessionEnd' && delta.status === 'completed')) this.complete();
  }
  complete(): void {
    this.cancel();
    this.options.host.dataset.ffCompletion = this.options.motion.reduced ? 'static' : 'active';
    if (this.options.motion.reduced) return;
    this.running = true;
    this.startAt = -1;
    for (let index = 0; index < this.particles.length; index += 1) {
      const angle = (Math.PI * 2 * index) / Math.max(1, this.particles.length);
      Object.assign(this.particles[index], { active: true, x: 0.5, y: 0.55, vx: Math.cos(angle) * 0.22,
        vy: Math.sin(angle) * 0.18 - 0.08, bornAt: 0, size: 1.5 + (index % 3) });
    }
    this.frames.schedule(this.paint);
  }
  pause(): void { this.cancel(); }
  cancel(): void {
    this.running = false;
    this.frames.cancel();
    for (const particle of this.particles) particle.active = false;
    this.context?.clearRect(0, 0, this.options.canvas?.width ?? 0, this.options.canvas?.height ?? 0);
    if (this.options.host.dataset.ffCompletion === 'active') this.options.host.dataset.ffCompletion = 'idle';
  }
  private readonly paint = (timestamp: number): void => {
    if (!this.running) return;
    if (this.startAt < 0) this.startAt = timestamp;
    const elapsed = timestamp - this.startAt;
    const progress = Math.min(1, elapsed / COMPLETION_DURATION_MS);
    const canvas = this.options.canvas;
    if (canvas && this.context) {
      this.context.clearRect(0, 0, canvas.width, canvas.height);
      this.context.fillStyle = this.options.theme['--ff-typing-correct'] || '#3b82f6';
      for (const particle of this.particles) {
        if (!particle.active) continue;
        const seconds = elapsed / 1_000;
        const x = (particle.x + particle.vx * seconds) * canvas.width;
        const y = (particle.y + particle.vy * seconds + seconds * seconds * 0.3) * canvas.height;
        this.context.globalAlpha = 1 - progress;
        this.context.fillRect(x, y, particle.size, particle.size);
      }
      this.context.globalAlpha = 1;
    }
    if (progress >= 1) {
      this.running = false;
      for (const particle of this.particles) particle.active = false;
      this.options.host.dataset.ffCompletion = 'complete';
      return;
    }
    this.frames.schedule(this.paint);
  };
  get activeParticleCount(): number { return this.particles.filter((item) => item.active).length; }
  get particleCapacity(): number { return this.particles.length; }
  get framePending(): boolean { return this.frames.pending; }
}

export class TypingFeedbackEffects {
  constructor(private readonly effects: CompletionEffects, private readonly keys?: KeyFeedbackController) {}
  onDeltas(deltas: readonly EngineDelta[]): void { this.effects.handleDeltas(deltas); }
  onPhysicalKey(code: string, pressed: boolean): void { this.keys?.update(code, pressed); }
  pause(): void { this.effects.pause(); this.keys?.cancel(); }
  cancel(): void { this.effects.cancel(); this.keys?.cancel(); }
}
