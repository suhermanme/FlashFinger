import type { SessionRecord } from '../../contracts/models.js';
import { calculateMetrics } from './formulas.js';

export interface HistoricalBar { day: string; sessions: number; activeMs: number; adjustedWpm: number | null; accuracy: number | null; modes: string[]; }
export interface AggregateOptions { from?: string; to?: string; modes?: readonly string[]; }

export function aggregateSessions(sessions: readonly SessionRecord[], options: AggregateOptions = {}): HistoricalBar[] {
  const modeSet = options.modes?.length ? new Set(options.modes) : null;
  const map = new Map<string, SessionRecord[]>();
  for (const session of sessions) {
    if (modeSet && !modeSet.has(session.config.mode)) continue;
    const day = session.endedAt.slice(0, 10);
    if (options.from && day < options.from || options.to && day > options.to) continue;
    const rows = map.get(day) ?? []; rows.push(session); map.set(day, rows);
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, rows]) => {
    const activeMs = rows.reduce((n, row) => n + row.activeMs, 0);
    const retained = rows.reduce((n, row) => n + row.retainedCorrect, 0);
    const attempts = rows.reduce((n, row) => n + row.attempts, 0);
    const correct = rows.reduce((n, row) => n + row.correctAttempts, 0);
    const metric = calculateMetrics({ activeMs, attempts, correctAttempts: correct, errorAttempts: attempts - correct, backspaces: 0, retainedCorrect: retained, retainedErrors: rows.reduce((n, row) => n + row.retainedErrors, 0), completedWords: 0 });
    return { day, sessions: rows.length, activeMs, adjustedWpm: metric.adjustedWpm, accuracy: metric.accuracy, modes: [...new Set(rows.map((row) => row.config.mode))] };
  });
}
