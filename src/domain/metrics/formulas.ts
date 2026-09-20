/**
 * Canonical metric formulas — DESIGN_SPECIFICATION §4.1.
 *
 * Framework-independent: no React, DOM, audio, or storage imports.
 *
 * All metrics use active elapsed time and grapheme-based input units.
 * Spaces and explicit newlines count as one unit.
 * Backspaces/modifiers/rejected commands do not count as character attempts.
 *
 * Let T be active seconds, A all accepted character attempts,
 * C correct attempts at the moment attempted, E incorrect attempts,
 * R correct characters currently retained in the target buffer,
 * and B backspaces. A = C + E. R may decrease on correction
 * and must not be confused with C.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Input counters for metric calculation.
 * Mirrors SessionRecord counters.
 */
export interface MetricInput {
  /** Active elapsed milliseconds. */
  activeMs: number;
  /** A — total accepted character attempts. */
  attempts: number;
  /** C — correct accepted attempts. */
  correctAttempts: number;
  /** E — incorrect accepted attempts. */
  errorAttempts: number;
  /** B — backspaces. */
  backspaces: number;
  /** R — correct characters currently retained in the target buffer. */
  retainedCorrect: number;
  /** Incorrect characters currently retained in the target buffer. */
  retainedErrors: number;
  /** Completed dictionary words. */
  completedWords: number;
}

/**
 * Calculated metrics — null when denominator is zero (§4.1).
 */
export interface MetricResult {
  /** Gross CPM: 60 × A / T. Null when T=0 or A=0. */
  grossCpm: number | null;
  /** Gross WPM: 12 × A / T. Null when T=0 or A=0. */
  grossWpm: number | null;
  /** Adjusted WPM (primary final score): 12 × R / T. Null when T=0 or R=0. */
  adjustedWpm: number | null;
  /** Attempt accuracy: 100 × C / A. Null when A=0. */
  accuracy: number | null;
  /** Output accuracy: 100 × R / (R + retainedErrors). Null when no retained. */
  outputAccuracy: number | null;
  /** Rolling correct-attempt WPM (see below). */
  rollingWpm: number | null;
}

/**
 * Rolling window input — includes a time window for rolling metrics.
 */
export interface RollingMetricInput extends MetricInput {
  /** Window length in milliseconds for rolling calculations. */
  windowMs: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Characters per "word" in WPM calculation (§4.1). */
export const CHARS_PER_WORD = 5;

/** Characters per "word" in WPM calculation (for CPM-to-WPM conversion). */
const CPM_TO_WPM_FACTOR = 60 / CHARS_PER_WORD; // 12
const CPM_FACTOR = 60;

/** Minimum active seconds before rates are considered valid (§4.1). */
const MIN_ACTIVE_SECONDS = 1;

// ---------------------------------------------------------------------------
// Core formulas
// ---------------------------------------------------------------------------

/**
 * Calculate all canonical metrics from counters.
 * Returns null fields when denominators are zero (§4.1).
 *
 * Example: T=60s, A=300, C=285, E=15, R=270 gives
 * 300 gross CPM, 60 gross WPM, 54 adjusted WPM, 95% attempt accuracy.
 */
export function calculateMetrics(input: MetricInput): MetricResult {
  const { activeMs, attempts, correctAttempts, errorAttempts, retainedCorrect, retainedErrors } = input;

  // Convert ms to seconds
  const tSeconds = activeMs / 1000;

  // Gross CPM: 60 × A / T
  const grossCpm = tSeconds > 0 && attempts > 0
    ? CPM_FACTOR * attempts / tSeconds
    : null;

  // Gross WPM: 12 × A / T
  const grossWpm = grossCpm !== null
    ? grossCpm / CHARS_PER_WORD
    : null;

  // Adjusted WPM (primary): 12 × R / T
  const adjustedWpm = tSeconds > 0 && retainedCorrect > 0
    ? CPM_TO_WPM_FACTOR * retainedCorrect / tSeconds
    : null;

  // Attempt accuracy: 100 × C / A
  const accuracy = attempts > 0
    ? 100 * correctAttempts / attempts
    : null;

  // Output accuracy (secondary): 100 × R / (R + retainedErrors)
  const totalRetained = retainedCorrect + retainedErrors;
  const outputAccuracy = totalRetained > 0
    ? 100 * retainedCorrect / totalRetained
    : null;

  return {
    grossCpm,
    grossWpm,
    adjustedWpm,
    accuracy,
    outputAccuracy,
    rollingWpm: null, // Use calculateRollingWpm for windowed calculation
  };
}

/**
 * Calculate rolling correct-attempt WPM over a sliding window.
 * Uses windowMs and the correctAttempts within that window.
 *
 * Rolling WPM: 12 × window correct attempts / window seconds (§4.1).
 */
export function calculateRollingWpm(input: RollingMetricInput): number | null {
  const { activeMs, correctAttempts, windowMs } = input;

  // Only compute when there's enough data
  if (windowMs <= 0 || correctAttempts <= 0) {
    return null;
  }

  const windowSeconds = windowMs / 1000;
  if (windowSeconds < MIN_ACTIVE_SECONDS) {
    return null;
  }

  return CPM_TO_WPM_FACTOR * correctAttempts / windowSeconds;
}

/**
 * Calculate eligibility for personal-best / comparative records (§4.3).
 */
export function isEligibleForBest(input: MetricInput & {
  eligibleForBest: boolean;
  compatibilityInput: boolean;
  disqualifiedByPause: boolean;
  minimumActiveMs: number;
}): boolean {
  // Must meet minimum active time
  if (input.activeMs < input.minimumActiveMs) {
    return false;
  }

  // Compatibility input disqualifies (§4.3)
  if (input.compatibilityInput) {
    return false;
  }

  // Voluntary pauses disqualify timed practice (§3.2)
  if (input.disqualifiedByPause) {
    return false;
  }

  // Must have attempted at least one character
  if (input.attempts === 0) {
    return false;
  }

  // Must have at least some active time
  if (input.activeMs === 0) {
    return false;
  }

  return input.eligibleForBest;
}

/**
 * Calculate daily aggregate from multiple sessions.
 * Duration-weighted adjusted WPM over eligible completed sessions.
 *
 * Pooled counters: 12 × sum(retainedCorrect) / sum(activeMs).
 */
export function calculateDailyAggregate(sessionResults: {
  activeMs: number;
  retainedCorrect: number;
  eligibleForBest: boolean;
  adjustedWpm: number | null;
  accuracy: number | null;
}[]): {
  totalActiveMs: number;
  totalRetainedCorrect: number;
  totalAttempts: number;
  totalCorrectAttempts: number;
  totalErrorAttempts: number;
  totalCompletedWords: number;
  pooledAdjustedWpm: number | null;
  weightedAccuracy: number | null;
  sessionCount: number;
  eligibleSessionCount: number;
} {
  let totalActiveMs = 0;
  let totalRetainedCorrect = 0;
  let totalAttempts = 0;
  let totalCorrectAttempts = 0;
  let totalErrorAttempts = 0;
  let totalCompletedWords = 0;
  let eligibleSessionCount = 0;
  let eligibleActiveMs = 0;

  for (const s of sessionResults) {
    totalActiveMs += s.activeMs;
    totalRetainedCorrect += s.retainedCorrect;
    // Attempts not tracked in this aggregate input — set from session if available
    eligibleActiveMs += s.eligibleForBest ? s.activeMs : 0;
    if (s.eligibleForBest) {
      eligibleSessionCount++;
    }
  }

  // Pooled adjusted WPM: 12 × retainedCorrect / activeSeconds
  const pooledAdjustedWpm = totalActiveMs > 0 && totalRetainedCorrect > 0
    ? CPM_TO_WPM_FACTOR * totalRetainedCorrect / (totalActiveMs / 1000)
    : null;

  return {
    totalActiveMs,
    totalRetainedCorrect,
    totalAttempts,
    totalCorrectAttempts,
    totalErrorAttempts,
    totalCompletedWords,
    pooledAdjustedWpm,
    weightedAccuracy: null, // Needs per-session accuracy data
    sessionCount: sessionResults.length,
    eligibleSessionCount,
  };
}

// ---------------------------------------------------------------------------
// MetricSample computation (for §4.2 live sampling)
// ---------------------------------------------------------------------------

/**
 * Compute a MetricSample for the live pipeline (§4.2).
 * Published every 250 ms, uses trailing 5 active seconds (or less).
 */
export function computeSample(input: RollingMetricInput): {
  activeElapsedMs: number;
  windowMs: number;
  attempts: number;
  correctAttempts: number;
  grossCpm: number | null;
  adjustedWpm: number | null;
  accuracy: number | null;
} | null {
  if (input.windowMs <= 0) return null;

  const metrics = calculateMetrics(input);
  const rollingWpm = calculateRollingWpm(input);

  return {
    activeElapsedMs: input.activeMs,
    windowMs: input.windowMs,
    attempts: input.attempts,
    correctAttempts: input.correctAttempts,
    grossCpm: metrics.grossCpm,
    adjustedWpm: rollingWpm,
    accuracy: metrics.accuracy,
  };
}
