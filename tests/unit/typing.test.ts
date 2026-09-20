/**
 * M03 — Pure typing and timing engine tests.
 *
 * Covers: ASCII, spaces, newlines, emoji, corrections, state transitions,
 * strict vs advance policy, deleted-correct counters, zero-time metrics,
 * late-input rejection, bounded correction history, and timed deadlines.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TypingEngine, type EngineOptions } from '@/domain/typing/engine.js';
import type { EngineCommand } from '@/domain/typing/types.js';
import * as clock from '@/domain/typing/clock.js';
import { EditLedger } from '@/domain/typing/ledger.js';
import { MAX_CORRECTION_HISTORY } from '@/domain/typing/types.js';

const BASE_NOW = 1_000_000;

function makeSource(
  text: string,
  policy: 'strict' | 'advance' = 'advance',
  durationMs: number | null = null,
): EngineOptions {
  const chunkSize = 4096;
  const chunks: Record<number, string> = {};
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks[Math.floor(i / chunkSize)] = text.slice(i, i + chunkSize);
  }
  return {
    targetText: text,
    correctionPolicy: policy,
    termination: durationMs
      ? { kind: 'duration', durationMs }
      : { kind: 'complete-target' },
    eligibility: {
      disqualifiedByCompatibility: false,
      disqualifiedByPause: false,
      minimumActiveMs: 15_000,
    },
    generationState: null,
    baseNowMs: BASE_NOW,
    source: {
      chunkSize,
      chunkAt(idx: number) { return chunks[idx] ?? null; },
    },
  };
}

function tick(engine: TypingEngine, ms: number) { clock.tick(BASE_NOW + ms); }
function charCmd(g: string): EngineCommand { return { kind: 'character', grapheme: g }; }
function deleteCmd(): EngineCommand { return { kind: 'delete' }; }

// ===================================================================
// 1. Clock
// ===================================================================

describe('M03 — Clock', () => {
  beforeEach(() => { clock.resetClock(BASE_NOW); });

  it('starts at zero active elapsed', () => {
    expect(clock.getActiveElapsedMs()).toBe(0);
  });

  it('accumulates active elapsed time', () => {
    clock.tick(BASE_NOW + 500);
    expect(clock.getActiveElapsedMs()).toBe(500);
    clock.tick(BASE_NOW + 1000);
    expect(clock.getActiveElapsedMs()).toBe(1000);
  });

  it('excludes paused time from active elapsed', () => {
    clock.tick(BASE_NOW + 500);
    expect(clock.getActiveElapsedMs()).toBe(500);
    clock.togglePause();
    clock.tick(BASE_NOW + 1500);
    expect(clock.getActiveElapsedMs()).toBe(500);
    clock.togglePause();
    clock.tick(BASE_NOW + 2000);
    expect(clock.getActiveElapsedMs()).toBe(1000);
  });

  it('tracks pause state', () => {
    expect(clock.isPaused()).toBe(false);
    clock.togglePause();
    expect(clock.isPaused()).toBe(true);
    clock.togglePause();
    expect(clock.isPaused()).toBe(false);
  });

  it('deadline is null by default', () => { expect(clock.getDeadline()).toBeNull(); });

  it('deadline returns true when reached', () => {
    clock.setDeadline(BASE_NOW + 5000);
    clock.tick(BASE_NOW + 3000);
    expect(clock.isDeadlineReached()).toBe(false);
    clock.tick(BASE_NOW + 6000);
    expect(clock.isDeadlineReached()).toBe(true);
  });

  it('clears deadline when set to null', () => {
    clock.setDeadline(BASE_NOW + 5000);
    clock.setDeadline(null);
    expect(clock.isDeadlineReached()).toBe(false);
    expect(clock.getDeadline()).toBeNull();
  });
});

// ===================================================================
// 2. Edit Ledger
// ===================================================================

describe('M03 — EditLedger', () => {
  it('records inserts', () => {
    const l = new EditLedger();
    l.record({ kind: 'insert', position: 0, grapheme: 'h', correct: true });
    expect(l.getSequence()).toBe(1);
  });

  it('records deletes', () => {
    const l = new EditLedger();
    l.record({ kind: 'delete', position: 0, grapheme: 'x', correct: true });
    expect(l.getSequence()).toBe(1);
  });

  it('is bounded to MAX_CORRECTION_HISTORY', () => {
    const l = new EditLedger();
    for (let i = 0; i < 600; i++) {
      l.record({ kind: 'insert', position: i, grapheme: String.fromCharCode(97 + (i % 26)), correct: true });
    }
    expect(l.toSnapshot().length).toBe(MAX_CORRECTION_HISTORY);
  });

  it('increments sequence monotonically', () => {
    const l = new EditLedger();
    for (let i = 0; i < 10; i++) {
      l.record({ kind: 'insert', position: i, grapheme: 'a', correct: true });
    }
    expect(l.getSequence()).toBe(10);
  });

  it('clears on reset', () => {
    const l = new EditLedger();
    l.record({ kind: 'insert', position: 0, grapheme: 'a', correct: true });
    l.clear();
    expect(l.getSequence()).toBe(0);
    expect(l.toSnapshot()).toEqual([]);
  });
});

// ===================================================================
// 3. State transitions
// ===================================================================

describe('M03 — State transitions', () => {
  it('starts idle', () => {
    const e = new TypingEngine(makeSource('hello'));
    expect(e.getState()).toBe('idle');
  });

  it('transitions idle → preparing → ready → running', () => {
    const e = new TypingEngine(makeSource('hello'));
    e.transitionToPreparing();
    expect(e.getState()).toBe('preparing');
    e.transitionToReady();
    expect(e.getState()).toBe('ready');
    e.transitionToRunning();
    expect(e.getState()).toBe('running');
  });

  it('first accepted character in ready auto-starts running', () => {
    const e = new TypingEngine(makeSource('hello'));
    e.transitionToPreparing();
    e.transitionToReady();
    tick(e, 10);
    const deltas = e.processCommand(charCmd('h'));
    expect(e.getState()).toBe('running');
    expect(deltas.some(d => d.kind === 'accepted')).toBe(true);
  });

  it('rejects input in idle state', () => {
    const e = new TypingEngine(makeSource('hello'));
    const d = e.processCommand(charCmd('h'));
    expect(d.some(d => d.kind === 'rejected')).toBe(true);
  });

  it('transitions to completed on target completion', () => {
    const e = new TypingEngine(makeSource('hello'));
    e.transitionToPreparing();
    e.transitionToReady();
    tick(e, 10);
    for (const ch of 'hello') {
      tick(e, 10);
      e.processCommand(charCmd(ch));
    }
    const endDeltas = e.finalize('completed');
    expect(e.getState()).toBe('completed');
    expect(endDeltas.some(d => d.kind === 'sessionEnd')).toBe(true);
  });

  it('transitions to aborted', () => {
    const e = new TypingEngine(makeSource('hello'));
    e.transitionToPreparing();
    e.transitionToReady();
    tick(e, 10);
    e.processCommand(charCmd('h'));
    const endDeltas = e.finalize('aborted');
    expect(e.getState()).toBe('aborted');
  });

  it('toggles pause', () => {
    const e = new TypingEngine(makeSource('hello'));
    e.transitionToPreparing();
    e.transitionToReady();
    tick(e, 10);
    e.processCommand(charCmd('h'));
    e.togglePause();
    expect(e.getState()).toBe('paused');
    e.togglePause();
    expect(e.getState()).toBe('running');
  });

  it('rejects input while paused', () => {
    const e = new TypingEngine(makeSource('hello'));
    e.transitionToPreparing();
    e.transitionToReady();
    tick(e, 10);
    e.processCommand(charCmd('h'));
    e.togglePause();
    const d = e.processCommand(charCmd('e'));
    expect(d.some(d => d.kind === 'rejected')).toBe(true);
  });
});

// ===================================================================
// 4. Strict vs advance correction policy
// ===================================================================

describe('M03 — Correction policies', () => {
  it('advance: wrong char fills position and advances', () => {
    const e = new TypingEngine(makeSource('ab', 'advance'));
    e.transitionToPreparing();
    e.transitionToReady();
    tick(e, 10);
    e.processCommand(charCmd('x'));
    tick(e, 10);
    e.processCommand(charCmd('b'));
    expect(e.getCounters().textCursor).toBe(2);
  });

  it('strict: wrong char stays at position', () => {
    const e = new TypingEngine(makeSource('ab', 'strict'));
    e.transitionToPreparing();
    e.transitionToReady();
    tick(e, 10);
    e.processCommand(charCmd('x'));
    expect(e.getCounters().textCursor).toBe(0);
    tick(e, 10);
    e.processCommand(charCmd('a'));
    expect(e.getCounters().textCursor).toBe(1);
  });

  it('advance: correct char advances cursor', () => {
    const e = new TypingEngine(makeSource('abc', 'advance'));
    e.transitionToPreparing();
    e.transitionToReady();
    tick(e, 10);
    e.processCommand(charCmd('a'));
    expect(e.getCounters().textCursor).toBe(1);
    tick(e, 10);
    e.processCommand(charCmd('b'));
    expect(e.getCounters().textCursor).toBe(2);
  });

  it('strict: correct char at wrong position advances cursor', () => {
    const e = new TypingEngine(makeSource('ab', 'strict'));
    e.transitionToPreparing();
    e.transitionToReady();
    tick(e, 10);
    e.processCommand(charCmd('a'));
    expect(e.getCounters().textCursor).toBe(1);
  });
});

// ===================================================================
// 5. Deleted-correct counters
// ===================================================================

describe('M03 — Deleted-correct counters', () => {
  it('backspace on correct char decrements retainedCorrect', () => {
    const e = new TypingEngine(makeSource('abc'));
    e.transitionToPreparing();
    e.transitionToReady();
    tick(e, 10);
    e.processCommand(charCmd('a'));
    expect(e.getCounters().retainedCorrect).toBe(1);
    tick(e, 10);
    const d = e.processCommand(deleteCmd());
    expect(d.some(d => d.kind === 'corrected' && (d as any).wasCorrect === true)).toBe(true);
    expect(e.getCounters().retainedCorrect).toBe(0);
  });

  it('backspace on error decrements retainedErrors', () => {
    const e = new TypingEngine(makeSource('ab'));
    e.transitionToPreparing();
    e.transitionToReady();
    tick(e, 10);
    e.processCommand(charCmd('x'));
    expect(e.getCounters().retainedErrors).toBe(1);
    tick(e, 10);
    e.processCommand(deleteCmd());
    expect(e.getCounters().retainedErrors).toBe(0);
  });

  it('retyping after delete increments correctAttempts again', () => {
    const e = new TypingEngine(makeSource('abc'));
    e.transitionToPreparing();
    e.transitionToReady();
    tick(e, 10);
    e.processCommand(charCmd('a'));
    expect(e.getCounters().correctAttempts).toBe(1);
    tick(e, 10);
    e.processCommand(deleteCmd());
    tick(e, 10);
    e.processCommand(charCmd('a'));
    expect(e.getCounters().correctAttempts).toBe(2);
    expect(e.getCounters().retainedCorrect).toBe(1);
  });

  it('backspace on empty buffer is rejected', () => {
    const e = new TypingEngine(makeSource('abc'));
    e.transitionToPreparing();
    e.transitionToReady();
    const d = e.processCommand(deleteCmd());
    expect(d.some(d => d.kind === 'rejected')).toBe(true);
  });
});

// ===================================================================
// 6. Zero-time metrics
// ===================================================================

describe('M03 — Zero-time metrics', () => {
  it('produces progress delta on zero time', () => {
    const e = new TypingEngine(makeSource('ab'));
    e.transitionToPreparing();
    e.transitionToReady();
    tick(e, 0);
    const deltas = e.processCommand(charCmd('a'));
    expect(deltas.some(d => d.kind === 'progress')).toBe(true);
    expect(e.getActiveElapsedMs()).toBe(0);
  });
});

// ===================================================================
// 7. Timed deadline and late-input rejection
// ===================================================================

describe('M03 — Timed deadline and late-input rejection', () => {
  it('rejects input after deadline passes', () => {
    const e = new TypingEngine(makeSource('ab', 'advance', 300));
    e.transitionToPreparing();
    e.transitionToReady();
    clock.setDeadline(BASE_NOW + 300);
    tick(e, 100);
    e.processCommand(charCmd('a'));
    tick(e, 500);
    const d = e.processCommand(charCmd('b'));
    expect(d.some(d => d.kind === 'rejected' && (d as any).reason === 'deadline-passed')).toBe(true);
  });

  it('accepts input before deadline', () => {
    const e = new TypingEngine(makeSource('ab', 'advance', 300));
    e.transitionToPreparing();
    e.transitionToReady();
    clock.setDeadline(BASE_NOW + 300);
    tick(e, 200);
    const d = e.processCommand(charCmd('a'));
    expect(d.some(d => d.kind === 'accepted')).toBe(true);
  });

  it('deadline is checked per input, not once at start', () => {
    const e = new TypingEngine(makeSource('abc', 'advance', 200));
    e.transitionToPreparing();
    e.transitionToReady();
    clock.setDeadline(BASE_NOW + 200);
    tick(e, 100); // BASE_NOW + 100 < deadline
    e.processCommand(charCmd('a'));
    tick(e, 150); // BASE_NOW + 150 < deadline
    e.processCommand(charCmd('b'));
    tick(e, 300); // BASE_NOW + 300 > deadline
    const d3 = e.processCommand(charCmd('c'));
    expect(d3.some(d => d.kind === 'rejected' && (d as any).reason === 'deadline-passed')).toBe(true);
  });
});

// ===================================================================
// 8. ASCII, spaces, newlines
// ===================================================================

describe('M03 — ASCII, spaces, newlines', () => {
  it('accepts space characters', () => {
    const e = new TypingEngine(makeSource('a b'));
    e.transitionToPreparing();
    e.transitionToReady();
    tick(e, 10); e.processCommand(charCmd('a'));
    tick(e, 10); e.processCommand(charCmd(' '));
    tick(e, 10); e.processCommand(charCmd('b'));
    expect(e.getCounters().attempts).toBe(3);
    expect(e.getCounters().correctAttempts).toBe(3);
  });

  it('accepts newline characters', () => {
    const e = new TypingEngine(makeSource('a\nb'));
    e.transitionToPreparing();
    e.transitionToReady();
    tick(e, 10); e.processCommand(charCmd('a'));
    tick(e, 10); e.processCommand(charCmd('\n'));
    tick(e, 10); e.processCommand(charCmd('b'));
    expect(e.getCounters().attempts).toBe(3);
    expect(e.getCounters().correctAttempts).toBe(3);
  });

  it('space errors are tracked', () => {
    const e = new TypingEngine(makeSource('a b'));
    e.transitionToPreparing();
    e.transitionToReady();
    tick(e, 10); e.processCommand(charCmd('a'));
    tick(e, 10); e.processCommand(charCmd('x'));
    expect(e.getCounters().errorAttempts).toBe(1);
  });
});

// ===================================================================
// 9. Emoji (multi-codepoint graphemes)
// ===================================================================

describe('M03 — Emoji', () => {
  it('accepts emoji graphemes', () => {
    const e = new TypingEngine(makeSource('a👋b'));
    e.transitionToPreparing();
    e.transitionToReady();
    tick(e, 10); e.processCommand(charCmd('a'));
    tick(e, 10); e.processCommand(charCmd('👋'));
    tick(e, 10); e.processCommand(charCmd('b'));
    expect(e.getCounters().attempts).toBe(3);
    expect(e.getCounters().correctAttempts).toBe(3);
  });

  it('emoji at cursor position is validated correctly', () => {
    const e = new TypingEngine(makeSource('👋'));
    e.transitionToPreparing();
    e.transitionToReady();
    tick(e, 10);
    const d = e.processCommand(charCmd('👋'));
    const a = d.find(x => x.kind === 'accepted') as any;
    expect(a).toBeDefined();
    expect(a.correct).toBe(true);
  });

  it('wrong emoji at emoji position is error', () => {
    const e = new TypingEngine(makeSource('👋'));
    e.transitionToPreparing();
    e.transitionToReady();
    tick(e, 10);
    const d = e.processCommand(charCmd('a'));
    const a = d.find(x => x.kind === 'accepted') as any;
    expect(a).toBeDefined();
    expect(a.correct).toBe(false);
  });
});

// ===================================================================
// 10. Corrections and history
// ===================================================================

describe('M03 — Corrections and history', () => {
  it('corrected delta reports wasCorrect', () => {
    const e = new TypingEngine(makeSource('abc'));
    e.transitionToPreparing();
    e.transitionToReady();
    tick(e, 10);
    e.processCommand(charCmd('a'));
    tick(e, 10);
    const d1 = e.processCommand(deleteCmd());
    expect((d1.find(x => x.kind === 'corrected') as any).wasCorrect).toBe(true);

    tick(e, 10);
    e.processCommand(charCmd('x'));
    tick(e, 10);
    const d2 = e.processCommand(deleteCmd());
    expect((d2.find(x => x.kind === 'corrected') as any).wasCorrect).toBe(false);
  });

  it('ledger records both inserts and deletes', () => {
    const e = new TypingEngine(makeSource('ab'));
    e.transitionToPreparing();
    e.transitionToReady();
    tick(e, 10);
    e.processCommand(charCmd('a'));
    tick(e, 10);
    e.processCommand(deleteCmd());
    tick(e, 10);
    e.processCommand(charCmd('a'));
    const snap = e.takeSnapshot();
    expect(snap.cappedRecentEdits.length).toBe(3);
    expect(snap.cappedRecentEdits[0].kind).toBe('insert');
    expect(snap.cappedRecentEdits[1].kind).toBe('delete');
    expect(snap.cappedRecentEdits[2].kind).toBe('insert');
  });
});

// ===================================================================
// 11. Snapshot serialisability
// ===================================================================

describe('M03 — Snapshot serialisability', () => {
  it('produces a serialisable snapshot', () => {
    const e = new TypingEngine(makeSource('hello world'));
    e.transitionToPreparing();
    e.transitionToReady();
    tick(e, 100);
    for (const ch of 'hello') {
      e.processCommand(charCmd(ch));
      tick(e, 10);
    }
    const snap = e.takeSnapshot();
    const json = JSON.stringify(snap);
    const p = JSON.parse(json);
    expect(p.state).toBe('running');
    expect(p.activeElapsedMs).toBeGreaterThan(0);
    expect(p.sequence).toBeGreaterThan(0);
    expect(p.attempts).toBe(5);
    expect(p.correctAttempts).toBe(5);
    expect(p.retainedCorrect).toBe(5);
    expect(typeof p.cappedRecentEdits).toBe('object');
  });
});

// ===================================================================
// 12. Bounded correction history
// ===================================================================

describe('M03 — Bounded correction history', () => {
  it('caps recent edits at MAX_CORRECTION_HISTORY', () => {
    const e = new TypingEngine(makeSource('a'.repeat(600)));
    e.transitionToPreparing();
    e.transitionToReady();
    for (let i = 0; i < 600; i++) {
      tick(e, 10);
      e.processCommand(charCmd('a'));
    }
    const snap = e.takeSnapshot();
    expect(snap.cappedRecentEdits.length).toBeLessThanOrEqual(MAX_CORRECTION_HISTORY);
  });
});

// ===================================================================
// 13. Counter invariants
// ===================================================================

describe('M03 — Counter invariants', () => {
  it('A = C + E always holds', () => {
    const e = new TypingEngine(makeSource('ab'));
    e.transitionToPreparing();
    e.transitionToReady();
    tick(e, 10); e.processCommand(charCmd('a'));
    tick(e, 10); e.processCommand(charCmd('x'));
    tick(e, 10); e.processCommand(charCmd('b'));
    const c = e.getCounters();
    expect(c.attempts).toBe(c.correctAttempts + c.errorAttempts);
  });

  it('backspace does not affect attempt counters', () => {
    const e = new TypingEngine(makeSource('ab'));
    e.transitionToPreparing();
    e.transitionToReady();
    tick(e, 10); e.processCommand(charCmd('a'));
    tick(e, 10); e.processCommand(charCmd('b'));
    const before = e.getCounters();
    tick(e, 10); e.processCommand(deleteCmd());
    const after = e.getCounters();
    expect(after.attempts).toBe(before.attempts);
    expect(after.correctAttempts).toBe(before.correctAttempts);
    expect(after.errorAttempts).toBe(before.errorAttempts);
  });

  it('backspace increments backspaces counter', () => {
    const e = new TypingEngine(makeSource('abc'));
    e.transitionToPreparing();
    e.transitionToReady();
    tick(e, 10); e.processCommand(charCmd('a'));
    tick(e, 10); e.processCommand(charCmd('b'));
    expect(e.getCounters().backspaces).toBe(0);
    tick(e, 10); e.processCommand(deleteCmd());
    expect(e.getCounters().backspaces).toBe(1);
  });
});

// ===================================================================
// 14. Rejected delta reasons
// ===================================================================

describe('M03 — Rejected delta reasons', () => {
  it('rejects past-target input', () => {
    const e = new TypingEngine(makeSource('ab'));
    e.transitionToPreparing();
    e.transitionToReady();
    tick(e, 10); e.processCommand(charCmd('a'));
    tick(e, 10); e.processCommand(charCmd('b'));
    tick(e, 10);
    const d = e.processCommand(charCmd('c'));
    const r = d.find(x => x.kind === 'rejected' && (x as any).reason === 'past-target');
    expect(r).toBeDefined();
  });
});

// ===================================================================
// 15. Clock command
// ===================================================================

describe('M03 — Clock command', () => {
  it('advances time via clock command', () => {
    const e = new TypingEngine(makeSource('ab'));
    e.transitionToPreparing();
    e.transitionToReady();
    tick(e, 500);    // BASE_NOW + 500 → active 500ms
    expect(clock.getActiveElapsedMs()).toBe(500);
    tick(e, 800);    // BASE_NOW + 800 → active 800ms (500 more)
    expect(clock.getActiveElapsedMs()).toBe(800);
  });
});

// ===================================================================
// 16. Pause command
// ===================================================================

describe('M03 — Pause command', () => {
  it('pause toggles state and returns progress deltas', () => {
    const e = new TypingEngine(makeSource('ab'));
    e.transitionToPreparing();
    e.transitionToReady();
    tick(e, 10);
    e.processCommand(charCmd('a'));
    tick(e, 100);
    const pd = e.processCommand({ kind: 'pause' });
    expect(pd.some(d => d.kind === 'progress')).toBe(true);
    expect(e.getState()).toBe('paused');
    tick(e, 100);
    const rd = e.processCommand({ kind: 'pause' });
    expect(e.getState()).toBe('running');
  });
});

// ===================================================================
// 17. Word counting
// ===================================================================

describe('M03 — Word counting', () => {
  it('counts words terminated by space', () => {
    const e = new TypingEngine(makeSource('hello world'));
    e.transitionToPreparing();
    e.transitionToReady();
    for (const ch of 'hello') {
      tick(e, 10);
      e.processCommand(charCmd(ch));
    }
    expect(e.getCounters().completedWords).toBe(1);
    tick(e, 10); e.processCommand(charCmd(' '));
    for (const ch of 'world') {
      tick(e, 10);
      e.processCommand(charCmd(ch));
    }
    expect(e.getCounters().completedWords).toBe(2);
  });
});

// ===================================================================
// 18. Engine reset
// ===================================================================

describe('M03 — Engine reset', () => {
  it('resets all counters and state', () => {
    const e = new TypingEngine(makeSource('abc'));
    e.transitionToPreparing();
    e.transitionToReady();
    tick(e, 10);
    e.processCommand(charCmd('a'));
    tick(e, 10);
    e.processCommand(charCmd('b'));
    e.reset();
    expect(e.getState()).toBe('idle');
    const c = e.getCounters();
    expect(c.attempts).toBe(0);
    expect(c.correctAttempts).toBe(0);
    expect(c.errorAttempts).toBe(0);
    expect(c.backspaces).toBe(0);
    expect(c.retainedCorrect).toBe(0);
    expect(c.retainedErrors).toBe(0);
  });
});

// ===================================================================
// 19. Grapheme segmentation — ZWJ emoji, flags, combining marks
//     Validates that Intl.Segmenter correctly handles multi-codepoint
//     grapheme clusters as single logical target/input units.
// ===================================================================

describe('M03 — Grapheme segmentation (ZWJ, flags, combining)', () => {

  // --- ZWJ emoji (woman + ZWJ + laptop = 👩‍💻) ---

  it('ZWJ emoji 👩‍💻 is one grapheme: target length and cursor', () => {
    const e = new TypingEngine(makeSource('👩‍💻'));
    e.transitionToPreparing();
    e.transitionToReady();
    // The target should be exactly 1 grapheme, not 3 code points
    expect(e.getActiveElapsedMs()).toBe(0);
    // After typing the single ZWJ emoji, cursor should be at 1 (past target)
    tick(e, 10);
    const d = e.processCommand(charCmd('👩‍💻'));
    const a = d.find(x => x.kind === 'accepted') as any;
    expect(a).toBeDefined();
    expect(a.correct).toBe(true);
    expect(e.getActiveElapsedMs()).toBe(10);
    // Cursor should be past the single-grapheme target
    expect(e.getCounters().textCursor).toBe(1);
  });

  it('ZWJ emoji deletion does not split the cluster', () => {
    const e = new TypingEngine(makeSource('a👩‍💻b'));
    e.transitionToPreparing();
    e.transitionToReady();
    // Type 'a' then the ZWJ emoji
    tick(e, 10); e.processCommand(charCmd('a'));
    tick(e, 10); e.processCommand(charCmd('👩‍💻'));
    // Cursor should be at position 2 (after a + ZWJ)
    const counters = e.getCounters();
    expect(counters.textCursor).toBe(2);
    expect(counters.retainedCorrect).toBe(2);
    // Delete: should remove the ZWJ emoji as a single unit
    tick(e, 10);
    e.processCommand(deleteCmd());
    const afterDel = e.getCounters();
    expect(afterDel.retainedCorrect).toBe(1); // only 'a' remains
    expect(afterDel.backspaces).toBe(1);
    expect(afterDel.textCursor).toBe(1);
  });

  it('ZWJ emoji wrong input is rejected correctly', () => {
    const e = new TypingEngine(makeSource('👩‍💻'));
    e.transitionToPreparing();
    e.transitionToReady();
    tick(e, 10);
    // Typing just the woman emoji (not the full ZWJ sequence)
    const d = e.processCommand(charCmd('👩'));
    const a = d.find(x => x.kind === 'accepted') as any;
    expect(a).toBeDefined();
    expect(a.correct).toBe(false); // '👩' ≠ '👩‍💻'
    expect(e.getCounters().errorAttempts).toBe(1);
  });

  // --- Regional indicator pairs (flags) ---

  it('flag 🇮🇩 is one grapheme: target length and cursor', () => {
    const e = new TypingEngine(makeSource('🇮🇩'));
    e.transitionToPreparing();
    e.transitionToReady();
    tick(e, 10);
    const d = e.processCommand(charCmd('🇮🇩'));
    const a = d.find(x => x.kind === 'accepted') as any;
    expect(a).toBeDefined();
    expect(a.correct).toBe(true);
    expect(e.getCounters().textCursor).toBe(1);
  });

  it('partial flag input is error (one regional indicator ≠ flag)', () => {
    const e = new TypingEngine(makeSource('🇮🇩'));
    e.transitionToPreparing();
    e.transitionToReady();
    tick(e, 10);
    // Typing only the first regional indicator
    const d = e.processCommand(charCmd('🇮'));
    const a = d.find(x => x.kind === 'accepted') as any;
    expect(a).toBeDefined();
    expect(a.correct).toBe(false);
    expect(e.getCounters().errorAttempts).toBe(1);
  });

  it('flag deletion keeps surrounding graphemes intact', () => {
    const e = new TypingEngine(makeSource('x🇮🇩y'));
    e.transitionToPreparing();
    e.transitionToReady();
    tick(e, 10); e.processCommand(charCmd('x'));
    tick(e, 10); e.processCommand(charCmd('🇮🇩'));
    tick(e, 10); e.processCommand(charCmd('y'));
    expect(e.getCounters().retainedCorrect).toBe(3);
    // Delete y, then the flag (last-typed first)
    tick(e, 10); e.processCommand(deleteCmd());
    expect(e.getCounters().retainedCorrect).toBe(2);
    expect(e.getCounters().textCursor).toBe(2);
    tick(e, 10); e.processCommand(deleteCmd());
    expect(e.getCounters().retainedCorrect).toBe(1);
    expect(e.getCounters().textCursor).toBe(1);
    // Retype the flag correctly
    tick(e, 10); e.processCommand(charCmd('🇮🇩'));
    expect(e.getCounters().retainedCorrect).toBe(2);
    expect(e.getCounters().textCursor).toBe(2);
    // Retype y
    tick(e, 10); e.processCommand(charCmd('y'));
    expect(e.getCounters().retainedCorrect).toBe(3);
    expect(e.getCounters().textCursor).toBe(3);
  });

  // --- Decomposed combining marks ---

  it('decomposed é (e + U+0301) is one grapheme', () => {
    const decomposed = 'e\u0301'; // e + combining acute accent
    const e = new TypingEngine(makeSource(decomposed));
    e.transitionToPreparing();
    e.transitionToReady();
    tick(e, 10);
    const d = e.processCommand(charCmd(decomposed));
    const a = d.find(x => x.kind === 'accepted') as any;
    expect(a).toBeDefined();
    expect(a.correct).toBe(true);
    expect(e.getCounters().textCursor).toBe(1);
  });

  it('decomposed é vs precomposed é are different graphemes', () => {
    const decomposed = 'e\u0301'; // e + combining acute
    const precomposed = 'é';       // U+00E9
    // Target is decomposed
    const e = new TypingEngine(makeSource(decomposed));
    e.transitionToPreparing();
    e.transitionToReady();
    tick(e, 10);
    // Typing precomposed should be an error (different code point sequence)
    const d = e.processCommand(charCmd(precomposed));
    const a = d.find(x => x.kind === 'accepted') as any;
    expect(a).toBeDefined();
    expect(a.correct).toBe(false);
  });

  it('decomposed é deletion does not corrupt the cluster', () => {
    const decomposed = 'e\u0301';
    const e = new TypingEngine(makeSource('a' + decomposed + 'b'));
    e.transitionToPreparing();
    e.transitionToReady();
    tick(e, 10); e.processCommand(charCmd('a'));
    tick(e, 10); e.processCommand(charCmd(decomposed));
    tick(e, 10); e.processCommand(charCmd('b'));
    expect(e.getCounters().retainedCorrect).toBe(3);
    // Delete b, then the decomposed é (last-typed first)
    tick(e, 10); e.processCommand(deleteCmd());
    expect(e.getCounters().retainedCorrect).toBe(2);
    expect(e.getCounters().textCursor).toBe(2);
    tick(e, 10); e.processCommand(deleteCmd());
    expect(e.getCounters().retainedCorrect).toBe(1);
    expect(e.getCounters().textCursor).toBe(1);
    // Retype the decomposed é
    tick(e, 10); e.processCommand(charCmd(decomposed));
    expect(e.getCounters().retainedCorrect).toBe(2);
    expect(e.getCounters().textCursor).toBe(2);
    // Retype b
    tick(e, 10); e.processCommand(charCmd('b'));
    expect(e.getCounters().retainedCorrect).toBe(3);
  });

  // --- Mixed grapheme sequences ---

  it('mixed: ASCII + ZWJ + flag + combining in correct order', () => {
    const decomposed = 'e\u0301';
    const text = 'a👩‍💻🇮🇩' + decomposed + 'z';
    const e = new TypingEngine(makeSource(text));
    e.transitionToPreparing();
    e.transitionToReady();
    const chars = ['a', '👩‍💻', '🇮🇩', decomposed, 'z'];
    for (const ch of chars) {
      tick(e, 5);
      e.processCommand(charCmd(ch));
    }
    expect(e.getCounters().correctAttempts).toBe(5);
    expect(e.getCounters().attempts).toBe(5);
    expect(e.getCounters().textCursor).toBe(5);
    expect(e.getCounters().retainedCorrect).toBe(5);
  });

  it('mixed: delete from end of mixed grapheme sequence', () => {
    const decomposed = 'e\u0301';
    const text = 'a👩‍💻🇮🇩' + decomposed;
    const e = new TypingEngine(makeSource(text));
    e.transitionToPreparing();
    e.transitionToReady();
    const chars = ['a', '👩‍💻', '🇮🇩', decomposed];
    for (const ch of chars) {
      tick(e, 5);
      e.processCommand(charCmd(ch));
    }
    // Delete 3 times: remove combining é, flag, ZWJ
    for (let i = 0; i < 3; i++) {
      tick(e, 5); e.processCommand(deleteCmd());
    }
    expect(e.getCounters().retainedCorrect).toBe(1); // only 'a'
    expect(e.getCounters().backspaces).toBe(3);
  });
});
