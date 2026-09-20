/**
 * Monotonic clock abstraction for the typing engine — DESIGN_SPECIFICATION §3.2.
 *
 * Framework-independent: no React, DOM, audio, or storage imports.
 *
 * The engine owns the monotonic clock; wall timestamps are labels only.
 * Active elapsed time excludes pauses. All metric denominators use activeMs.
 */

// ---------------------------------------------------------------------------
// Internal state (private to this module)
// ---------------------------------------------------------------------------

let _nowMs: number; // current monotonic base (ms)
let _activeElapsedMs: number; // total active time accumulated so far
let _paused: boolean;
let _lastMark: number; // last nowMs mark (for delta calculation)
let _deadline: number | null; // absolute monotonic deadline or null

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialise / reset the clock.
 * `baseNowMs` is the monotonic reference (e.g. performance.now()).
 */
export function initClock(baseNowMs: number): void {
  _nowMs = baseNowMs;
  _activeElapsedMs = 0;
  _paused = false;
  _lastMark = baseNowMs;
  _deadline = null;
}

/**
 * Advance the clock to a new monotonic time.
 * Must be called before every command to keep active elapsed accurate.
 */
export function tick(newNowMs: number): void {
  if (newNowMs < _nowMs) {
    // Clock should be monotonic; clamp to avoid negative deltas.
    _nowMs = newNowMs;
    return;
  }
  const delta = newNowMs - _nowMs;

  if (!_paused) {
    _activeElapsedMs += delta;
  }

  _nowMs = newNowMs;
  _lastMark = newNowMs;
}

/**
 * Toggle pause state.
 * Returns whether the session is now paused.
 */
export function togglePause(): boolean {
  _paused = !_paused;
  if (_paused) {
    // Pause: record the boundary so resume only counts forward from now.
    _lastMark = _nowMs;
  }
  return _paused;
}

/**
 * Check whether a future input time would violate the session deadline.
 * Returns true when the deadline has been reached or passed.
 */
export function isDeadlineReached(): boolean {
  return _deadline !== null && _nowMs >= _deadline;
}

/**
 * Set an absolute monotonic deadline (for timed sessions).
 * null clears any deadline.
 */
export function setDeadline(deadlineMs: number | null): void {
  _deadline = deadlineMs;
}

/**
 * Get the active elapsed time in milliseconds (monotonic, excludes pauses).
 */
export function getActiveElapsedMs(): number {
  return _activeElapsedMs;
}

/**
 * Get the current monotonic time.
 */
export function getNowMs(): number {
  return _nowMs;
}

/**
 * Check whether the clock is paused.
 */
export function isPaused(): boolean {
  return _paused;
}

/**
 * Get the deadline (absolute monotonic ms) or null.
 */
export function getDeadline(): number | null {
  return _deadline;
}

/**
 * Reset the clock to a fresh state (used when preparing a new session).
 */
export function resetClock(baseNowMs: number): void {
  initClock(baseNowMs);
}
