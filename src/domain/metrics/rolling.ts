import { calculateRollingWpm } from './formulas.js';

export interface RollingPoint { atMs: number; activeMs: number; correctAttempts: number; attempts: number; wpm?: number | null; accuracy?: number | null; }
export interface RollingSample { atMs: number; windowMs: number; wpm: number | null; accuracy: number | null; attempts: number; correctAttempts: number; }

/** Samples a bounded sliding window; callers may feed high-frequency input bursts. */
export function sampleRolling(points: readonly RollingPoint[], nowMs: number, windowMs = 5_000): RollingSample {
  const cutoff = nowMs - windowMs;
  const window = points.filter((point) => point.atMs > cutoff && point.atMs <= nowMs);
  const attempts = window.reduce((sum, point) => sum + point.attempts, 0);
  const correctAttempts = window.reduce((sum, point) => sum + point.correctAttempts, 0);
  const activeMs = window.reduce((sum, point) => sum + point.activeMs, 0);
  return { atMs: nowMs, windowMs: activeMs, attempts, correctAttempts,
    wpm: calculateRollingWpm({ activeMs, attempts, correctAttempts, errorAttempts: attempts - correctAttempts, backspaces: 0, retainedCorrect: 0, retainedErrors: 0, completedWords: 0, windowMs: activeMs }),
    accuracy: attempts ? 100 * correctAttempts / attempts : null };
}

export function capRollingPoints(points: readonly RollingPoint[], max = 240): RollingPoint[] { return points.slice(-max); }
