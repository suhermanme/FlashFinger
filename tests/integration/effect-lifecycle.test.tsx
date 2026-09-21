// @vitest-environment jsdom

import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CANVAS_THEME_TOKENS, type CanvasThemeSnapshot } from '../../src/app/themeController.js';
import { TypingEngine } from '../../src/domain/typing/engine.js';
import { CompletionEffects, MAX_EFFECT_PARTICLES } from '../../src/engines/visual/effects.js';
import { KeyFeedbackController } from '../../src/engines/visual/keyFeedback.js';
import { FrameScheduler, type FrameSource } from '../../src/engines/visual/motion.js';
import { TextRenderer } from '../../src/engines/visual/textRenderer.js';
import { TypingSurface, type TypingFeedback } from '../../src/features/typing/TypingSurface.js';

function theme(reducedMotion = false): CanvasThemeSnapshot {
  return Object.freeze({ ...Object.fromEntries(CANVAS_THEME_TOKENS.map((token) => [token, token === '--ff-typing-correct' ? '#22c55e' : '1'])),
    resolvedTheme: 'dark', reducedMotion }) as CanvasThemeSnapshot;
}

class FakeFrames implements FrameSource {
  next = 1;
  requested = 0;
  cancelled = 0;
  callbacks = new Map<number, FrameRequestCallback>();
  request(callback: FrameRequestCallback): number { const id = this.next++; this.requested += 1; this.callbacks.set(id, callback); return id; }
  cancel(handle: number): void { if (this.callbacks.delete(handle)) this.cancelled += 1; }
  flush(timestamp: number): void { const callbacks = [...this.callbacks.values()]; this.callbacks.clear(); for (const callback of callbacks) callback(timestamp); }
}

function engine() {
  const value = new TypingEngine({ targetText: 'abc', correctionPolicy: 'advance', termination: { kind: 'complete-target' },
    eligibility: { disqualifiedByCompatibility: false, disqualifiedByPause: false, minimumActiveMs: 0 }, generationState: null, baseNowMs: 0 });
  value.transitionToPreparing(); value.transitionToReady();
  return value;
}

describe('M10 bounded feedback lifecycle', () => {
  it('keeps essential character and caret changes synchronous without layout reads', () => {
    const root = document.createElement('div');
    const caret = document.createElement('div');
    const read = vi.spyOn(root, 'getBoundingClientRect').mockImplementation(() => { throw new Error('hot-path layout read'); });
    const renderer = new TextRenderer({ root, caret, text: 'abc', width: 320, measure: () => 16 });
    renderer.apply([{ kind: 'accepted', grapheme: 'a', correct: true, position: 0 }, { kind: 'progress', textCursor: 1, activeElapsedMs: 1 }]);
    expect(root.querySelector('[data-index="0"]')?.getAttribute('data-state')).toBe('correct');
    expect(caret.style.transform).toContain('translate3d');
    expect(read).not.toHaveBeenCalled();
  });

  it('uses a fixed particle pool and one coalesced animation callback', () => {
    const host = document.createElement('div');
    const caret = document.createElement('div');
    const frames = new FakeFrames();
    const effects = new CompletionEffects({ host, caret, theme: theme(), motion: { reduced: false, precisionCaret: false }, frames, particleCount: 100 });
    effects.complete();
    expect(host.dataset.ffCompletion).toBe('active');
    expect(caret.dataset.ffCaretMotion).toBe('interpolate');
    expect(effects.particleCapacity).toBe(MAX_EFFECT_PARTICLES);
    expect(effects.activeParticleCount).toBe(MAX_EFFECT_PARTICLES);
    expect(frames.callbacks.size).toBe(1);
    frames.flush(0); frames.flush(100); frames.flush(221);
    expect(effects.activeParticleCount).toBe(0);
    expect(host.dataset.ffCompletion).toBe('complete');
  });

  it('cancels pending completion work on pause and renders reduced motion statically', () => {
    const fullFrames = new FakeFrames();
    const full = new CompletionEffects({ host: document.createElement('div'), caret: document.createElement('div'), theme: theme(),
      motion: { reduced: false, precisionCaret: true }, frames: fullFrames });
    full.complete(); full.pause();
    expect(full.activeParticleCount).toBe(0);
    expect(full.framePending).toBe(false);
    expect(fullFrames.cancelled).toBe(1);

    const reducedFrames = new FakeFrames();
    const host = document.createElement('div');
    const caret = document.createElement('div');
    const reduced = new CompletionEffects({ host, caret, theme: theme(true), motion: { reduced: true, precisionCaret: false }, frames: reducedFrames });
    reduced.complete();
    expect(host.dataset.ffCompletion).toBe('static');
    expect(caret.dataset.ffCaretMotion).toBe('snap');
    expect(reduced.activeParticleCount).toBe(0);
    expect(reducedFrames.requested).toBe(0);
  });

  it('bounds key pulses, keeps reduced feedback static, and performs no layout reads', () => {
    const key = document.createElement('button');
    const read = vi.spyOn(key, 'getBoundingClientRect').mockImplementation(() => { throw new Error('layout read'); });
    const frames = new FakeFrames();
    const scheduler = new FrameScheduler(frames);
    const timers = new Map<number, () => void>();
    let nextTimer = 1;
    const feedback = new KeyFeedbackController({ resolve: () => key, frames: scheduler, reducedMotion: false,
      setTimer: ((callback: () => void) => { const id = nextTimer++; timers.set(id, callback); return id; }) as typeof setTimeout,
      clearTimer: ((id: number) => { timers.delete(id); }) as typeof clearTimeout });
    feedback.update('KeyA', true);
    expect(key.dataset.ffKeyState).toBe('pressed');
    feedback.update('KeyA', false);
    feedback.update('KeyA', false);
    expect(feedback.pendingPulseCount).toBe(1);
    expect(frames.callbacks.size).toBe(1);
    frames.flush(16);
    expect(key.dataset.ffKeyState).toBe('releasing');
    feedback.cancel();
    expect(key.dataset.ffKeyState).toBe('idle');
    expect(read).not.toHaveBeenCalled();

    const reduced = new KeyFeedbackController({ resolve: () => key, frames: new FrameScheduler(new FakeFrames()), reducedMotion: true });
    reduced.update('KeyA', true); reduced.update('KeyA', false);
    expect(key.dataset.ffKeyMotion).toBe('static');
    expect(key.dataset.ffKeyState).toBe('idle');
  });

  it('cancels injected feedback when TypingSurface unmounts', () => {
    const feedback: TypingFeedback = { onDeltas: vi.fn(), cancel: vi.fn(), pause: vi.fn() };
    const view = render(<TypingSurface engine={engine()} targetText="abc" feedback={feedback} />);
    view.unmount();
    expect(feedback.cancel).toHaveBeenCalledOnce();
  });
});
