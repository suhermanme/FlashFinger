/**
 * Typing engine domain types — DESIGN_SPECIFICATION §3.2 / §4.1 / §5.1.
 *
 * Framework-independent: no React, DOM, audio, or storage imports.
 */

// ---------------------------------------------------------------------------
// Engine state
// ---------------------------------------------------------------------------

export const ENGINE_STATES = [
  'idle',
  'preparing',
  'ready',
  'running',
  'paused',
  'finalizing',
  'completed',
  'aborted',
  'interrupted',
] as const;
export type EngineState = (typeof ENGINE_STATES)[number];

// ---------------------------------------------------------------------------
// Commands accepted by the engine
// ---------------------------------------------------------------------------

export const COMMAND_KINDS = [
  'character',
  'delete',
  'clock',
  'pause',
] as const;
export type CommandKind = (typeof COMMAND_KINDS)[number];

/**
 * Engine command — the unified input interface for all sources
 * (keyboard, IME commit, automated tests).
 */
export type EngineCommand =
  /** Normalised character (one grapheme). */
  | { kind: 'character'; grapheme: string }
  /** Backspace / delete one editable position. */
  | { kind: 'delete' }
  /** Monotonic clock update (ms). Supplies active-elapsed delta. */
  | { kind: 'clock'; nowMs: number }
  /** Pause / resume toggle. */
  | { kind: 'pause' };

// ---------------------------------------------------------------------------
// Delta — output from engine.process(command)
// ---------------------------------------------------------------------------

export const DELTA_KINDS = [
  'accepted',
  'rejected',
  'corrected',
  'progress',
  'sessionEnd',
] as const;
export type DeltaKind = (typeof DELTA_KINDS)[number];

export interface AcceptedDelta {
  kind: 'accepted';
  /** Grapheme that was typed. */
  grapheme: string;
  /** Whether it matches the target at the current position. */
  correct: boolean;
  /** Position (grapheme index) in the target where this was applied. */
  position: number;
}

export interface RejectedDelta {
  kind: 'rejected';
  /** Why it was rejected. */
  reason: 'past-target' | 'not-editable' | 'wrong-policy' | 'deadline-passed';
}

export interface CorrectedDelta {
  kind: 'corrected';
  /** Position (grapheme index) that was removed. */
  position: number;
  /** Grapheme that was at that position. */
  grapheme: string;
  /** Whether the removed position was correct (decrements retainedCorrect). */
  wasCorrect: boolean;
}

export interface ProgressDelta {
  kind: 'progress';
  /** Text cursor position (grapheme index). */
  textCursor: number;
  /** Active elapsed ms since session start. */
  activeElapsedMs: number;
}

export interface SessionEndDelta {
  kind: 'sessionEnd';
  status: 'completed' | 'aborted' | 'interrupted';
  /** Final snapshot of all counters (serialisable). */
  snapshot: EngineSnapshot;
}

/** Union of every delta the engine can produce. */
export type EngineDelta =
  | AcceptedDelta
  | RejectedDelta
  | CorrectedDelta
  | ProgressDelta
  | SessionEndDelta;

// ---------------------------------------------------------------------------
// Snapshot — serialisable engine state for checkpoints / persistence
// ---------------------------------------------------------------------------

export interface EngineSnapshot {
  state: EngineState;
  /** Monotonic active elapsed ms. */
  activeElapsedMs: number;
  /** Sequence number incremented on every accepted/rejected/processed input. */
  sequence: number;
  /** Total accepted character attempts (correct + incorrect). */
  attempts: number;
  /** Correct accepted attempts (C). */
  correctAttempts: number;
  /** Incorrect accepted attempts (E). */
  errorAttempts: number;
  /** Total backspaces. */
  backspaces: number;
  /** Correct characters currently retained in the target buffer (R). */
  retainedCorrect: number;
  /** Incorrect characters currently retained in the target buffer. */
  retainedErrors: number;
  /** Completed dictionary words count. */
  completedWords: number;
  /** Current target cursor position (grapheme index). */
  textCursor: number;
  /** Generation state (PRNG state for endless modes). */
  generationState: string | null;
  /** Bounded recent-edit history for display recovery. */
  cappedRecentEdits: CheckpointEdit[];
}

/** An edit recorded in the bounded correction history. */
export interface CheckpointEdit {
  sequence: number;
  kind: 'insert' | 'delete';
  /** Grapheme position in the target at edit time. */
  position: number;
  grapheme: string;
  correct: boolean;
}

// ---------------------------------------------------------------------------
// Correction policy (from contracts) — re-exported for engine use
// ---------------------------------------------------------------------------

export type CorrectionPolicy = 'strict' | 'advance';

/**
 * Termination rule for a session (from contracts — re-exported for engine).
 */
export type TerminationRule =
  | { kind: 'complete-target' }
  | { kind: 'duration'; durationMs: number }
  | { kind: 'word-target'; wordCount: number }
  | { kind: 'endless' };

/** Eligibility rules (from contracts — re-exported for engine). */
export interface EligibilityRules {
  disqualifiedByCompatibility: boolean;
  disqualifiedByPause: boolean;
  minimumActiveMs: number;
}

/**
 * Training source interface consumed by the engine — subset of contracts.
 * Only the synchronous read path is needed for the typing engine itself.
 */
export interface TrainingSource {
  readonly correctionPolicy: CorrectionPolicy;
  readonly termination: TerminationRule;
  readonly eligibility: EligibilityRules;
  readonly graphemeCount: number | null;
  readonly chunkSize: number;
  chunkAt(chunkIndex: number): string | null;
  ensureAvailable?(fromChunkIndex: number, toChunkIndex: number): Promise<void>;
  releaseBefore?(chunkIndex: number): void;
}

/**
 * Maximum correction history entries (bounded window).
 */
export const MAX_CORRECTION_HISTORY = 512;

/**
 * Maximum text window size for mounted range.
 */
export const MAX_TEXT_WINDOW = 2048;
