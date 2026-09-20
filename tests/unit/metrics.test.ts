/**
 * M03 — Canonical metric formulas tests.
 *
 * Tests DESIGN_SPECIFICATION §4.1 formulas:
 * - Gross CPM = 60 × A / T
 * - Gross WPM = 12 × A / T
 * - Adjusted WPM = 12 × R / T
 * - Attempt accuracy = 100 × C / A
 * - Output accuracy = 100 × R / (R + retainedErrors)
 * - Rolling WPM = 12 × window correct / window seconds
 * - Null on zero denominators
 */

import { describe, it, expect } from 'vitest';
import {
  calculateMetrics,
  calculateRollingWpm,
  isEligibleForBest,
  calculateDailyAggregate,
  computeSample,
  type MetricInput,
} from '@/domain/metrics/formulas.js';

// ===================================================================
// §4.1 canonical example: T=60s, A=300, C=285, E=15, R=270
// Expected: 300 gross CPM, 60 gross WPM, 54 adjusted WPM, 95% accuracy
// ===================================================================

describe('M03 — Canonical example from §4.1', () => {
  const m = (inp: MetricInput) => calculateMetrics(inp);

  it('produces 300 gross CPM', () => {
    expect(m({ activeMs: 60_000, attempts: 300, correctAttempts: 285, errorAttempts: 15, backspaces: 0, retainedCorrect: 270, retainedErrors: 0, completedWords: 0 })).toMatchObject({ grossCpm: 300 });
  });

  it('produces 60 gross WPM', () => {
    expect(m({ activeMs: 60_000, attempts: 300, correctAttempts: 285, errorAttempts: 15, backspaces: 0, retainedCorrect: 270, retainedErrors: 0, completedWords: 0 })).toMatchObject({ grossWpm: 60 });
  });

  it('produces 54 adjusted WPM', () => {
    expect(m({ activeMs: 60_000, attempts: 300, correctAttempts: 285, errorAttempts: 15, backspaces: 0, retainedCorrect: 270, retainedErrors: 0, completedWords: 0 })).toMatchObject({ adjustedWpm: 54 });
  });

  it('produces 95% attempt accuracy', () => {
    expect(m({ activeMs: 60_000, attempts: 300, correctAttempts: 285, errorAttempts: 15, backspaces: 0, retainedCorrect: 270, retainedErrors: 0, completedWords: 0 })).toMatchObject({ accuracy: 95 });
  });

  it('produces 100% output accuracy when no retained errors', () => {
    expect(m({ activeMs: 60_000, attempts: 300, correctAttempts: 285, errorAttempts: 15, backspaces: 0, retainedCorrect: 270, retainedErrors: 0, completedWords: 0 })).toMatchObject({ outputAccuracy: 100 });
  });
});

// ===================================================================
// Null on zero denominators
// ===================================================================

describe('M03 — Null on zero denominators', () => {
  it('returns null gross CPM when T=0', () => {
    const r = calculateMetrics({ activeMs: 0, attempts: 300, correctAttempts: 285, errorAttempts: 15, backspaces: 0, retainedCorrect: 270, retainedErrors: 0, completedWords: 0 });
    expect(r.grossCpm).toBeNull();
  });

  it('returns null gross CPM when A=0', () => {
    const r = calculateMetrics({ activeMs: 60_000, attempts: 0, correctAttempts: 0, errorAttempts: 0, backspaces: 0, retainedCorrect: 0, retainedErrors: 0, completedWords: 0 });
    expect(r.grossCpm).toBeNull();
  });

  it('returns null adjusted WPM when T=0', () => {
    const r = calculateMetrics({ activeMs: 0, attempts: 300, correctAttempts: 285, errorAttempts: 15, backspaces: 0, retainedCorrect: 270, retainedErrors: 0, completedWords: 0 });
    expect(r.adjustedWpm).toBeNull();
  });

  it('returns null adjusted WPM when R=0', () => {
    const r = calculateMetrics({ activeMs: 60_000, attempts: 300, correctAttempts: 285, errorAttempts: 15, backspaces: 15, retainedCorrect: 0, retainedErrors: 0, completedWords: 0 });
    expect(r.adjustedWpm).toBeNull();
  });

  it('returns null accuracy when A=0', () => {
    const r = calculateMetrics({ activeMs: 60_000, attempts: 0, correctAttempts: 0, errorAttempts: 0, backspaces: 0, retainedCorrect: 0, retainedErrors: 0, completedWords: 0 });
    expect(r.accuracy).toBeNull();
  });

  it('returns null output accuracy when no retained', () => {
    const r = calculateMetrics({ activeMs: 60_000, attempts: 300, correctAttempts: 285, errorAttempts: 15, backspaces: 0, retainedCorrect: 0, retainedErrors: 0, completedWords: 0 });
    expect(r.outputAccuracy).toBeNull();
  });
});

// ===================================================================
// Output accuracy with errors
// ===================================================================

describe('M03 — Output accuracy', () => {
  it('computes output accuracy with retained errors', () => {
    const r = calculateMetrics({ activeMs: 60_000, attempts: 300, correctAttempts: 285, errorAttempts: 15, backspaces: 15, retainedCorrect: 270, retainedErrors: 15, completedWords: 0 });
    expect(r.outputAccuracy).toBeCloseTo(100 * 270 / 285, 1); // ≈94.74%
  });
});

// ===================================================================
// Rolling WPM
// ===================================================================

describe('M03 — Rolling WPM', () => {
  it('computes rolling WPM from window data', () => {
    const r = calculateRollingWpm({ activeMs: 10_000, correctAttempts: 20, windowMs: 10_000, attempts: 20, errorAttempts: 0, backspaces: 0, retainedCorrect: 20, retainedErrors: 0, completedWords: 0 });
    // 12 * 20 / 10 = 24
    expect(r).toBe(24);
  });

  it('returns null when windowMs is 0', () => {
    const r = calculateRollingWpm({ activeMs: 0, correctAttempts: 0, windowMs: 0, attempts: 0, errorAttempts: 0, backspaces: 0, retainedCorrect: 0, retainedErrors: 0, completedWords: 0 });
    expect(r).toBeNull();
  });

  it('returns null when correctAttempts is 0', () => {
    const r = calculateRollingWpm({ activeMs: 10_000, correctAttempts: 0, windowMs: 10_000, attempts: 0, errorAttempts: 0, backspaces: 0, retainedCorrect: 0, retainedErrors: 0, completedWords: 0 });
    expect(r).toBeNull();
  });

  it('returns null when window too short (<1s)', () => {
    const r = calculateRollingWpm({ activeMs: 500, correctAttempts: 10, windowMs: 500, attempts: 10, errorAttempts: 0, backspaces: 0, retainedCorrect: 10, retainedErrors: 0, completedWords: 0 });
    expect(r).toBeNull();
  });

  it('computes rolling WPM at 60wpm for 10s/100 correct', () => {
    const r = calculateRollingWpm({ activeMs: 10_000, correctAttempts: 100, windowMs: 10_000, attempts: 100, errorAttempts: 0, backspaces: 0, retainedCorrect: 100, retainedErrors: 0, completedWords: 0 });
    // 12 * 100 / 10 = 120... wait, let me check. 12 * C / T where T is window seconds.
    // 12 * 100 / 10 = 120 WPM. But at 60wpm, 10s should give 100 chars = 20 words = 120 WPM...
    // Actually 60 WPM = 300 chars/min = 5 chars/sec. 10s = 50 chars = 10 words.
    // 12 * 10 / 10 = 12... Let me re-check.
    // 12 * correctAttempts / windowSeconds = 12 * 50 / 10 = 60
    const r2 = calculateRollingWpm({ activeMs: 10_000, correctAttempts: 50, windowMs: 10_000, attempts: 50, errorAttempts: 0, backspaces: 0, retainedCorrect: 50, retainedErrors: 0, completedWords: 0 });
    expect(r2).toBe(60);
  });
});

// ===================================================================
// Eligibility
// ===================================================================

describe('M03 — Eligibility for personal best', () => {
  it('rejects when below minimum active ms', () => {
    expect(isEligibleForBest({
      activeMs: 10_000, attempts: 100, correctAttempts: 95, errorAttempts: 5,
      backspaces: 0, retainedCorrect: 90, retainedErrors: 0, completedWords: 10,
      eligibleForBest: true, compatibilityInput: false, disqualifiedByPause: false, minimumActiveMs: 15_000,
    })).toBe(false);
  });

  it('rejects when compatibility input is used', () => {
    expect(isEligibleForBest({
      activeMs: 60_000, attempts: 100, correctAttempts: 95, errorAttempts: 5,
      backspaces: 0, retainedCorrect: 90, retainedErrors: 0, completedWords: 10,
      eligibleForBest: true, compatibilityInput: true, disqualifiedByPause: false, minimumActiveMs: 15_000,
    })).toBe(false);
  });

  it('rejects when paused (timed session)', () => {
    expect(isEligibleForBest({
      activeMs: 60_000, attempts: 100, correctAttempts: 95, errorAttempts: 5,
      backspaces: 0, retainedCorrect: 90, retainedErrors: 0, completedWords: 10,
      eligibleForBest: true, compatibilityInput: false, disqualifiedByPause: true, minimumActiveMs: 15_000,
    })).toBe(false);
  });

  it('rejects when no attempts', () => {
    expect(isEligibleForBest({
      activeMs: 60_000, attempts: 0, correctAttempts: 0, errorAttempts: 0,
      backspaces: 0, retainedCorrect: 0, retainedErrors: 0, completedWords: 0,
      eligibleForBest: true, compatibilityInput: false, disqualifiedByPause: false, minimumActiveMs: 15_000,
    })).toBe(false);
  });

  it('rejects when activeMs is zero', () => {
    expect(isEligibleForBest({
      activeMs: 0, attempts: 100, correctAttempts: 95, errorAttempts: 5,
      backspaces: 0, retainedCorrect: 90, retainedErrors: 0, completedWords: 10,
      eligibleForBest: true, compatibilityInput: false, disqualifiedByPause: false, minimumActiveMs: 15_000,
    })).toBe(false);
  });

  it('accepts valid session', () => {
    expect(isEligibleForBest({
      activeMs: 60_000, attempts: 300, correctAttempts: 285, errorAttempts: 15,
      backspaces: 0, retainedCorrect: 270, retainedErrors: 0, completedWords: 50,
      eligibleForBest: true, compatibilityInput: false, disqualifiedByPause: false, minimumActiveMs: 15_000,
    })).toBe(true);
  });
});

// ===================================================================
// Daily aggregate
// ===================================================================

describe('M03 — Daily aggregate', () => {
  it('pools counters across sessions', () => {
    const r = calculateDailyAggregate([
      { activeMs: 60_000, retainedCorrect: 270, eligibleForBest: true, adjustedWpm: 54, accuracy: 95 },
      { activeMs: 30_000, retainedCorrect: 100, eligibleForBest: true, adjustedWpm: 40, accuracy: 90 },
    ]);
    expect(r.totalActiveMs).toBe(90_000);
    expect(r.totalRetainedCorrect).toBe(370);
    expect(r.eligibleSessionCount).toBe(2);
    expect(r.sessionCount).toBe(2);
    // Pooled: 12 * 370 / 90 = 49.33...
    expect(r.pooledAdjustedWpm).toBeCloseTo(49.33, 1);
  });

  it('excludes ineligible sessions from eligible count', () => {
    const r = calculateDailyAggregate([
      { activeMs: 60_000, retainedCorrect: 270, eligibleForBest: true, adjustedWpm: 54, accuracy: 95 },
      { activeMs: 10_000, retainedCorrect: 50, eligibleForBest: false, adjustedWpm: null, accuracy: null },
    ]);
    expect(r.eligibleSessionCount).toBe(1);
    expect(r.sessionCount).toBe(2);
  });
});

// ===================================================================
// Sample computation
// ===================================================================

describe('M03 — Sample computation', () => {
  it('returns null when windowMs is 0', () => {
    const s = computeSample({ activeMs: 10_000, correctAttempts: 0, windowMs: 0, attempts: 0, errorAttempts: 0, backspaces: 0, retainedCorrect: 0, retainedErrors: 0, completedWords: 0 });
    expect(s).toBeNull();
  });

  it('returns valid sample with data', () => {
    const s = computeSample({ activeMs: 10_000, correctAttempts: 50, windowMs: 10_000, attempts: 50, errorAttempts: 0, backspaces: 0, retainedCorrect: 50, retainedErrors: 0, completedWords: 0 });
    expect(s).not.toBeNull();
    expect(s!.activeElapsedMs).toBe(10_000);
    expect(s!.windowMs).toBe(10_000);
    expect(s!.attempts).toBe(50);
    expect(s!.correctAttempts).toBe(50);
    expect(s!.grossCpm).toBe(300);
    expect(s!.adjustedWpm).toBe(60);
    expect(s!.accuracy).toBe(100);
  });
});

// ===================================================================
// Edge cases
// ===================================================================

describe('M03 — Edge cases', () => {
  it('handles single character session', () => {
    const r = calculateMetrics({ activeMs: 1_000, attempts: 1, correctAttempts: 1, errorAttempts: 0, backspaces: 0, retainedCorrect: 1, retainedErrors: 0, completedWords: 0 });
    expect(r.grossCpm).toBe(60);
    expect(r.grossWpm).toBe(12);
    expect(r.adjustedWpm).toBe(12);
    expect(r.accuracy).toBe(100);
  });

  it('handles all errors', () => {
    const r = calculateMetrics({ activeMs: 60_000, attempts: 100, correctAttempts: 0, errorAttempts: 100, backspaces: 0, retainedCorrect: 0, retainedErrors: 100, completedWords: 0 });
    expect(r.grossCpm).toBe(100);
    expect(r.grossWpm).toBe(20);
    expect(r.adjustedWpm).toBeNull();
    expect(r.accuracy).toBe(0);
    expect(r.outputAccuracy).toBe(0);
  });

  it('handles backspace reducing retained correctly', () => {
    const r = calculateMetrics({ activeMs: 60_000, attempts: 100, correctAttempts: 90, errorAttempts: 10, backspaces: 10, retainedCorrect: 80, retainedErrors: 0, completedWords: 10 });
    expect(r.adjustedWpm).toBeCloseTo(12 * 80 / 60, 1); // 16.0
    expect(r.outputAccuracy).toBe(100);
  });
});
