/**
 * Bounded edit ledger for correction history and checkpoint recovery
 * — DESIGN_SPECIFICATION §2.1 (ActiveCheckpoint / CheckpointEdit).
 *
 * Framework-independent: no React, DOM, audio, or storage imports.
 */

import type { CheckpointEdit, EngineSnapshot } from './types.js';
import { MAX_CORRECTION_HISTORY } from './types.js';

// ---------------------------------------------------------------------------
// Edit ledger — bounded circular buffer
// ---------------------------------------------------------------------------

interface EditEntry {
  sequence: number;
  kind: 'insert' | 'delete';
  position: number;
  grapheme: string;
  correct: boolean;
}

export class EditLedger {
  private entries: EditEntry[] = [];
  private nextSeq = 0;

  /**
   * Record an edit and return a bounded snapshot slice.
   * Maintains the last `MAX_CORRECTION_HISTORY` edits.
   */
  record(entry: Omit<EditEntry, 'sequence'>): EngineSnapshot['cappedRecentEdits'] {
    const fullEntry: EditEntry = { ...entry, sequence: this.nextSeq++ };
    this.entries.push(fullEntry);

    // Keep bounded
    if (this.entries.length > MAX_CORRECTION_HISTORY) {
      this.entries = this.entries.slice(this.entries.length - MAX_CORRECTION_HISTORY);
    }

    return this.toSnapshot();
  }

  /**
   * Export the current bounded history as checkpoint-compatible edits.
   */
  toSnapshot(): EngineSnapshot['cappedRecentEdits'] {
    return this.entries.map((e) => ({
      sequence: e.sequence,
      kind: e.kind,
      position: e.position,
      grapheme: e.grapheme,
      correct: e.correct,
    }));
  }

  /**
   * Get the current sequence number (monotonically increasing).
   */
  getSequence(): number {
    return this.nextSeq;
  }

  /**
   * Clear the ledger (used when starting a new session).
   */
  clear(): void {
    this.entries = [];
    this.nextSeq = 0;
  }
}
