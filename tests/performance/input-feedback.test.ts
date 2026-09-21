// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { CANVAS_THEME_TOKENS, type CanvasThemeSnapshot } from '../../src/app/themeController.js';
import { TypingEngine } from '../../src/domain/typing/engine.js';
import { CompletionEffects } from '../../src/engines/visual/effects.js';
import type { FrameSource } from '../../src/engines/visual/motion.js';
import { TextRenderer } from '../../src/engines/visual/textRenderer.js';
import { InputAdapter, type BeforeInputLike } from '../../src/features/typing/inputAdapter.js';

const INPUT_COUNT = 10_000;

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function run(feedbackEnabled: boolean) {
  const targetText = 'a'.repeat(INPUT_COUNT);
  const engine = new TypingEngine({ targetText, correctionPolicy: 'advance', termination: { kind: 'complete-target' },
    eligibility: { disqualifiedByCompatibility: false, disqualifiedByPause: false, minimumActiveMs: 0 }, generationState: null, baseNowMs: 0 });
  engine.transitionToPreparing(); engine.transitionToReady();
  const root = document.createElement('div');
  const caret = document.createElement('div');
  root.getBoundingClientRect = () => { throw new Error('layout read during measured input path'); };
  const renderer = new TextRenderer({ root, caret, text: targetText, width: 800, measure: () => 12 });
  const frames: FrameSource = { request: () => 1, cancel: () => undefined };
  const theme = Object.freeze({ ...Object.fromEntries(CANVAS_THEME_TOKENS.map((token) => [token, '#22c55e'])),
    resolvedTheme: 'dark', reducedMotion: false }) as CanvasThemeSnapshot;
  const effects = feedbackEnabled ? new CompletionEffects({ host: document.createElement('div'), caret, theme,
    motion: { reduced: false, precisionCaret: false }, frames }) : null;
  let scheduledAudio = 0;
  const adapter = new InputAdapter(engine, { onCommit(commit) {
    renderer.apply(commit.deltas);
    effects?.handleDeltas(commit.deltas);
    scheduledAudio += 1;
  } });
  const event: BeforeInputLike = { inputType: 'insertText', data: 'a', preventDefault: () => undefined };
  const samples: number[] = [];
  const startedAt = performance.now();
  for (let index = 0; index < INPUT_COUNT; index += 1) {
    const before = performance.now();
    adapter.handleBeforeInput(event);
    samples.push(performance.now() - before);
  }
  const totalMs = performance.now() - startedAt;
  samples.sort((left, right) => left - right);
  effects?.cancel();
  renderer.destroy();
  return { totalMs, scheduledAudio, p50: percentile(samples, 0.5), p95: percentile(samples, 0.95),
    p99: percentile(samples, 0.99), max: samples.at(-1) ?? 0 };
}

describe('M08–M10 synthetic input scheduling baseline', () => {
  it('keeps feedback bounded and detects a material hot-path regression', () => {
    const essential = run(false);
    const feedback = run(true);
    console.info(`PERFORMANCE_BASELINE ${JSON.stringify({ environment: 'vitest-jsdom-node', inputCount: INPUT_COUNT, essential, feedback })}`);
    expect(essential.scheduledAudio).toBe(INPUT_COUNT);
    expect(feedback.scheduledAudio).toBe(INPUT_COUNT);
    // jsdom is not a qualification browser; compare M10 against the M08 control
    // and keep a generous absolute guard only for runaway work.
    expect(feedback.p99).toBeLessThan(Math.max(essential.p99 * 2, essential.p99 + 2));
    expect(feedback.p99).toBeLessThan(25);
    expect(feedback.max).toBeLessThan(250);
    expect(feedback.totalMs).toBeLessThan(Math.max(essential.totalMs * 5, essential.totalMs + 1_000));
  });
});
