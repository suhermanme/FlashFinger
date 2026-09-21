/**
 * Pure typing and timing engine — DESIGN_SPECIFICATION §3.2 / §4.1 / §5.1.
 *
 * Framework-independent: no React, DOM, audio, or storage imports.
 *
 * The engine processes normalised commands and produces bounded deltas.
 * It maintains internal state (text cursor, counters, correction policy)
 * and exposes a serialisable snapshot for checkpoints and finalization.
 *
 * Input: normalised character, delete, clock, and pause commands.
 * Output: EngineDelta array (one or more per command).
 * State transitions: idle → preparing → ready → running ↔ paused → finalizing → completed.
 */

import type {
  CommandKind,
  CorrectionPolicy,
  EngineCommand,
  EngineDelta,
  EngineSnapshot,
  EngineState,
  EligibilityRules,
  RejectedDelta,
  SessionEndDelta,
  TerminationRule,
} from './types.js';
import { MAX_CORRECTION_HISTORY } from './types.js';

import { EditLedger } from './ledger.js';
import * as clock from './clock.js';

// ---------------------------------------------------------------------------
// Position record for word counting
// ---------------------------------------------------------------------------

interface PositionRecord {
  position: number;
  correct: boolean;
}

// ---------------------------------------------------------------------------
// Chunked text buffer — reads TrainingSource chunks into an in-memory buffer
// ---------------------------------------------------------------------------

/**
 * Load a contiguous range of graphemes from a chunked TrainingSource
 * into an internal ArrayBuffer-like structure (string concat for simplicity;
 * real implementation would use typed arrays).
 *
 * Returns the full concatenated text, or null if any chunk is missing.
 */
function loadChunks(source: {
  chunkAt(index: number): string | null;
  chunkSize: number;
}, chunkStart: number, chunkEnd: number): string | null {
  if (chunkStart < 0 || chunkEnd > chunkStart + 10000) {
    // Safety cap: don't load more than 10K graphemes at once.
    return null;
  }

  const startChunk = Math.floor(chunkStart / source.chunkSize);
  const endChunk = Math.ceil(chunkEnd / source.chunkSize) - 1;

  let text = '';
  for (let ci = startChunk; ci <= endChunk; ci++) {
    const chunk = source.chunkAt(ci);
    if (chunk === null) return null;
    text += chunk;
  }

  // Adjust for partial start/end
  const globalStart = chunkStart;
  const globalEnd = chunkEnd;
  const localStart = globalStart - startChunk * source.chunkSize;
  const localEnd =
    globalEnd <= endChunk * source.chunkSize
      ? globalEnd - startChunk * source.chunkSize
      : source.chunkSize;

  return text.slice(localStart, localEnd) || '';
}

// ---------------------------------------------------------------------------
// Grapheme segmentation — uses Intl.Segmenter for correct Unicode grapheme
// cluster boundary detection (ZWJ emoji, flags, combining marks, etc.)
// ---------------------------------------------------------------------------

let _segmenter: Intl.Segmenter | null = null;

function getSegmenter(): Intl.Segmenter {
  if (!_segmenter) {
    _segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
  }
  return _segmenter;
}

function segmentGraphemes(text: string): string[] {
  return [...getSegmenter().segment(text)].map(s => s.segment);
}

// ---------------------------------------------------------------------------
// Text buffer — in-memory editable target with cursor
// ---------------------------------------------------------------------------

class TextBuffer {
  /** The full target text as an array of grapheme clusters. */
  private target: string[];
  /** Editable buffer: typed characters with undefined for empty slots. */
  private _buffer: (string | undefined)[];
  /** Current cursor position (grapheme index in target). */
  private _cursor: number;

  constructor(targetText: string) {
    // Segment into grapheme clusters using Intl.Segmenter (handles ZWJ emoji,
    // regional indicator pairs, combining marks, etc.)
    this.target = segmentGraphemes(targetText);
    this._buffer = new Array(this.target.length);
    this._cursor = 0;
  }

  get targetText(): string {
    return this.target.join('');
  }

  get targetLength(): number {
    return this.target.length;
  }

  get bufferText(): string {
    return this._buffer.filter((c): c is string => c !== undefined).join('');
  }

  get cursor(): number {
    return this._cursor;
  }

  set cursor(value: number) {
    this._cursor = value;
  }

  get buffer(): (string | undefined)[] {
    return this._buffer;
  }

  /**
   * Get the expected grapheme at a position in the target.
   */
  getExpected(index: number): string | undefined {
    return this.target[index];
  }

  /**
   * Get the buffer content at a position (for correction).
   */
  getBufferChar(index: number): string | undefined {
    return this._buffer[index];
  }
}

// ---------------------------------------------------------------------------
// Engine state machine
// ---------------------------------------------------------------------------

export interface EngineOptions {
  targetText: string;
  correctionPolicy: CorrectionPolicy;
  termination: TerminationRule;
  eligibility: EligibilityRules;
  /** Optional generation state (PRNG seed) for endless modes. */
  generationState: string | null;
  /** Optional monotonic base time (default: 0 for tests). */
  baseNowMs?: number;
  /** Optional training source for chunked loading (endless modes). */
  source?: {
    chunkAt(index: number): string | null;
    chunkSize: number;
    ensureAvailable?(fromChunkIndex: number, toChunkIndex: number): Promise<void>;
  };
}

export class TypingEngine {
  private state: EngineState = 'idle';
  private textBuffer: TextBuffer;
  private correctionPolicy: CorrectionPolicy;
  private termination: TerminationRule;
  private eligibility: EligibilityRules;
  private ledger = new EditLedger();
  private generationState: string | null;
  private source: EngineOptions['source'];

  // Counters (SessionRecord fields)
  private attempts = 0;
  private correctAttempts = 0;
  private errorAttempts = 0;
  private backspaces = 0;
  private completedWords = 0;

  // Derived
  private retainedCorrect = 0;
  private retainedErrors = 0;
  private activeElapsedMs = 0;

  // State tracking
  private _activeMsSnapshot: number = 0;
  private _positionHistory: PositionRecord[] = [];
  private _lastAcceptedPosition = 0;

  constructor(options: EngineOptions) {
    this.textBuffer = new TextBuffer(options.targetText);
    this.correctionPolicy = options.correctionPolicy;
    this.termination = options.termination;
    this.eligibility = options.eligibility;
    this.generationState = options.generationState;
    this.source = options.source;

    if (options.baseNowMs !== undefined) {
      clock.resetClock(options.baseNowMs);
    }
  }

  // ---------------------------------------------------------------------------
  // State transitions
  // ---------------------------------------------------------------------------

  /**
   * Transition: idle → preparing.
   */
  transitionToPreparing(): void {
    this.state = 'preparing';
  }

  /**
   * Transition: preparing → ready.
   */
  transitionToReady(): void {
    this.state = 'ready';
  }

  /**
   * Start the session: ready → running.
   * Records startedAt via clock; first accepted character triggers start.
   */
  transitionToRunning(): void {
    this.state = 'running';
  }

  /** Align the session clock to the first scored input. Coordinators call this
   * immediately before dispatching that input; direct engine consumers retain
   * the explicit clock semantics used by the pure-domain API. */
  synchronizeStart(nowMs: number): void {
    if (this.state !== 'ready') return;
    clock.resetClock(nowMs);
    if (this.termination.kind === 'duration') {
      clock.setDeadline(nowMs + this.termination.durationMs);
    }
  }

  /**
   * Pause: running ↔ paused.
   */
  togglePause(): boolean {
    const wasRunning = this.state === 'running';
    clock.togglePause();
    this.state = wasRunning ? 'paused' : 'running';
    return this.state === 'paused';
  }

  /**
   * Transition: running/paused → finalizing → completed/aborted/interrupted.
   */
  finalize(status: 'completed' | 'aborted' | 'interrupted'): EngineDelta[] {
    this.state = 'finalizing';
    const snapshot = this.takeSnapshot();
    this.state = status;

    return [
      { kind: 'progress', textCursor: this.textBuffer.cursor, activeElapsedMs: this.activeElapsedMs },
      { kind: 'sessionEnd', status, snapshot },
    ];
  }

  /**
   * Get the current state.
   */
  getState(): EngineState {
    return this.state;
  }

  // ---------------------------------------------------------------------------
  // Command processing — main entry point
  // ---------------------------------------------------------------------------

  /**
   * Process an engine command and return zero or more deltas.
   * This is the main public method for feeding input to the engine.
   */
  processCommand(cmd: EngineCommand): EngineDelta[] {
    // Advance the clock first
    if (cmd.kind === 'clock') {
      clock.tick(cmd.nowMs);
      this.activeElapsedMs = clock.getActiveElapsedMs();
      return [{ kind: 'progress', textCursor: this.textBuffer.cursor, activeElapsedMs: this.activeElapsedMs }];
    }

    if (cmd.kind === 'pause') {
      this.togglePause();
      return [{ kind: 'progress', textCursor: this.textBuffer.cursor, activeElapsedMs: this.activeElapsedMs }];
    }

    // Only accept character/delete in running state
    if (this.state !== 'running') {
      // In ready state, the first accepted character starts the session
      if (this.state === 'ready' && cmd.kind === 'character') {
        this.transitionToRunning();
      } else {
        // Idle, paused, finalizing, etc. — reject
        return [{ kind: 'rejected', reason: 'not-editable' }];
      }
    }

    // Check deadline for timed sessions
    if (this.termination.kind === 'duration' && clock.isDeadlineReached()) {
      return [{ kind: 'rejected', reason: 'deadline-passed' }];
    }

    if (cmd.kind === 'character') {
      return this.processCharacter(cmd.grapheme);
    }

    if (cmd.kind === 'delete') {
      return this.processDelete();
    }

    return [{ kind: 'rejected', reason: 'not-editable' }];
  }

  // ---------------------------------------------------------------------------
  // Character processing
  // ---------------------------------------------------------------------------

  private processCharacter(grapheme: string): EngineDelta[] {
    const targetLength = this.textBuffer.targetLength;
    const cursor = this.textBuffer.cursor;

    // Check if we've reached the end of the target
    if (cursor >= targetLength) {
      // Check for completion conditions
      const shouldComplete = this.checkTermination();
      if (shouldComplete) {
        // Session ended by target completion, will be finalized externally
        return [{ kind: 'rejected', reason: 'past-target' }];
      }
      return [{ kind: 'rejected', reason: 'past-target' }];
    }

    const expected = this.textBuffer.getExpected(cursor);
    const correct = grapheme === expected;

    // Strict mode can accept several attempts at the same target position.
    // Only the latest value is retained, while every attempt remains in the
    // historical C/E counters. Remove the replaced value from retained output
    // before installing the new one.
    const replaced = this.textBuffer.buffer[cursor];
    if (replaced !== undefined) {
      if (replaced === expected) {
        this.retainedCorrect = Math.max(0, this.retainedCorrect - 1);
      } else {
        this.retainedErrors = Math.max(0, this.retainedErrors - 1);
      }
    }

    // Apply the character
    this.textBuffer.buffer[cursor] = grapheme;
    this.attempts++;
    if (correct) {
      this.correctAttempts++;
    } else {
      this.errorAttempts++;
    }

    // Record edit in ledger
    this.ledger.record({
      kind: 'insert',
      position: cursor,
      grapheme,
      correct,
    });

    // Track position history for word counting
    this._positionHistory.push({ position: cursor, correct });
    this._lastAcceptedPosition = Math.max(this._lastAcceptedPosition, cursor + 1);

    if (correct) {
      this.retainedCorrect++;
      // Advance cursor in both policies (buffer position advances)
      this.textBuffer.cursor = cursor + 1;
    } else {
      this.retainedErrors++;
      if (this.correctionPolicy === 'advance') {
        // Advance fills the position and moves on
        this.textBuffer.cursor = cursor + 1;
      }
      // In strict policy, cursor stays at the same position
    }

    // Count completed words
    this._countCompletedWords();

    return [
      {
        kind: 'accepted',
        grapheme,
        correct,
        position: cursor,
      },
      { kind: 'progress', textCursor: this.textBuffer.cursor, activeElapsedMs: this.activeElapsedMs },
    ];
  }

  // ---------------------------------------------------------------------------
  // Delete (backspace) processing
  // ---------------------------------------------------------------------------

  private processDelete(): EngineDelta[] {
    const cursor = this.textBuffer.cursor;

    // Can only delete if there's something in the buffer to remove
    if (this.textBuffer.buffer.length === 0) {
      return [{ kind: 'rejected', reason: 'not-editable' }];
    }

    // Find the last non-empty buffer position to delete
    let deletePos = -1;
    for (let i = this.textBuffer.buffer.length - 1; i >= 0; i--) {
      if (this.textBuffer.buffer[i] !== undefined) {
        deletePos = i;
        break;
      }
    }

    if (deletePos < 0) {
      return [{ kind: 'rejected', reason: 'not-editable' }];
    }

    // Check correction window (512 grapheme boundary)
    // deletePos must be within cursor's correction window
    const correctionWindowStart = Math.max(0, this._lastAcceptedPosition - MAX_CORRECTION_HISTORY);
    if (deletePos < correctionWindowStart) {
      return [{ kind: 'rejected', reason: 'not-editable' }];
    }

    const deletedChar = this.textBuffer.buffer[deletePos]!;
    const wasCorrect = this.textBuffer.buffer[deletePos] === this.textBuffer.getExpected(deletePos);

    // Clear the buffer position
    this.textBuffer.buffer[deletePos] = undefined;

    // Update counters
    this.backspaces++;

    if (wasCorrect) {
      this.retainedCorrect = Math.max(0, this.retainedCorrect - 1);
    } else {
      this.retainedErrors = Math.max(0, this.retainedErrors - 1);
    }

    // Update cursor to the delete position
    this.textBuffer.cursor = deletePos;

    // Record in ledger
    this.ledger.record({
      kind: 'delete',
      position: deletePos,
      grapheme: deletedChar,
      correct: wasCorrect,
    });

    return [
      { kind: 'corrected', position: deletePos, grapheme: deletedChar, wasCorrect },
      { kind: 'progress', textCursor: this.textBuffer.cursor, activeElapsedMs: this.activeElapsedMs },
    ];
  }

  // ---------------------------------------------------------------------------
  // Termination checking
  // ---------------------------------------------------------------------------

  private checkTermination(): boolean {
    switch (this.termination.kind) {
      case 'complete-target':
        return this.textBuffer.cursor >= this.textBuffer.targetLength;
      case 'duration':
        // Deadline checked in processCommand via clock.isDeadlineReached()
        return false;
      case 'word-target':
        return this.completedWords >= this.termination.wordCount;
      case 'endless':
        return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Word counting
  // ---------------------------------------------------------------------------

  /**
   * Count completed dictionary words from position history.
   * A completed word is a sequence of correct characters that ends at a
   * whitespace position or at the target end.
   */
  private _countCompletedWords(): void {
    // Simple heuristic: count whitespace-terminated runs of correct chars
    // that match dictionary boundaries
    // For M03, we use the target text's word boundaries
    const bufferText = this.textBuffer.bufferText;
    const targetText = this.textBuffer.targetText;

    // Count whitespace-terminated words in the buffer
    let wordCount = 0;
    let inWord = false;

    for (let i = 0; i < bufferText.length; i++) {
      const ch = bufferText[i];
      if (ch === ' ' || ch === '\n' || ch === '\t') {
        if (inWord) {
          wordCount++;
          inWord = false;
        }
      } else {
        inWord = true;
      }
    }
    // Count trailing word (if buffer ends mid-word, count it too for simplicity)
    if (inWord) {
      wordCount++;
    }

    this.completedWords = wordCount;
  }

  // ---------------------------------------------------------------------------
  // Snapshot / checkpoint
  // ---------------------------------------------------------------------------

  /**
   * Take a serialisable snapshot of the current engine state.
   */
  takeSnapshot(): EngineSnapshot {
    this.activeElapsedMs = clock.getActiveElapsedMs();

    return {
      state: this.state,
      activeElapsedMs: this.activeElapsedMs,
      sequence: this.ledger.getSequence(),
      attempts: this.attempts,
      correctAttempts: this.correctAttempts,
      errorAttempts: this.errorAttempts,
      backspaces: this.backspaces,
      retainedCorrect: this.retainedCorrect,
      retainedErrors: this.retainedErrors,
      completedWords: this.completedWords,
      textCursor: this.textBuffer.cursor,
      generationState: this.generationState,
      cappedRecentEdits: this.ledger.toSnapshot(),
    };
  }

  /**
   * Get all counters needed for SessionRecord.
   */
  getCounters(): {
    activeMs: number;
    attempts: number;
    correctAttempts: number;
    errorAttempts: number;
    backspaces: number;
    retainedCorrect: number;
    retainedErrors: number;
    completedWords: number;
    textCursor: number;
  } {
    this.activeElapsedMs = clock.getActiveElapsedMs();
    return {
      activeMs: this.activeElapsedMs,
      attempts: this.attempts,
      correctAttempts: this.correctAttempts,
      errorAttempts: this.errorAttempts,
      backspaces: this.backspaces,
      retainedCorrect: this.retainedCorrect,
      retainedErrors: this.retainedErrors,
      completedWords: this.completedWords,
      textCursor: this.textBuffer.cursor,
    };
  }

  /**
   * Get the current active elapsed time.
   */
  getActiveElapsedMs(): number {
    this.activeElapsedMs = clock.getActiveElapsedMs();
    return this.activeElapsedMs;
  }

  /**
   * Reset the engine to idle state (for a new session).
   */
  reset(): void {
    this.state = 'idle';
    this.attempts = 0;
    this.correctAttempts = 0;
    this.errorAttempts = 0;
    this.backspaces = 0;
    this.retainedCorrect = 0;
    this.retainedErrors = 0;
    this.completedWords = 0;
    this.ledger.clear();
    this._positionHistory = [];
    this._lastAcceptedPosition = 0;
    this.generationState = null;
  }
}
