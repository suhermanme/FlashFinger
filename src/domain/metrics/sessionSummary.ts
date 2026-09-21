import type {
  ActiveCheckpoint,
  DailyAggregate,
  DateString,
  ProfileId,
  SessionConfig,
  SessionDaySlice,
  SessionId,
  SessionRecord,
  SessionStatus,
} from '../../contracts/models.js';
import type { EngineSnapshot, EligibilityRules } from '../typing/types.js';
import { calculateMetrics, isEligibleForBest } from './formulas.js';

export interface DayCounterDraft {
  day: DateString;
  activeMs: number;
  attempts: number;
  correctAttempts: number;
  errorAttempts: number;
  completedWords: number;
  retainedCorrect: number;
}

export interface SessionSummaryInput {
  sessionId: SessionId;
  profileId: ProfileId;
  config: SessionConfig;
  analyticsZone: string;
  status: SessionStatus;
  startedAt: string;
  endedAt: string;
  snapshot: EngineSnapshot;
  eligibility: EligibilityRules;
  voluntarilyPaused: boolean;
  seed: string | null;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

export function calendarDayAt(instantMs: number, zone: string): DateString {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatters.set(zone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(new Date(instantMs)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function nextCalendarDay(day: DateString): DateString {
  const [year, month, date] = day.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, date + 1));
  return `${next.getUTCFullYear().toString().padStart(4, '0')}-${(next.getUTCMonth() + 1).toString().padStart(2, '0')}-${next.getUTCDate().toString().padStart(2, '0')}`;
}

export function buildSessionRecord(input: SessionSummaryInput): SessionRecord {
  const counters = input.snapshot;
  const metrics = calculateMetrics({
    activeMs: counters.activeElapsedMs,
    attempts: counters.attempts,
    correctAttempts: counters.correctAttempts,
    errorAttempts: counters.errorAttempts,
    backspaces: counters.backspaces,
    retainedCorrect: counters.retainedCorrect,
    retainedErrors: counters.retainedErrors,
    completedWords: counters.completedWords,
  });
  const eligibleForBest = input.status === 'completed' && isEligibleForBest({
    activeMs: counters.activeElapsedMs,
    attempts: counters.attempts,
    correctAttempts: counters.correctAttempts,
    errorAttempts: counters.errorAttempts,
    backspaces: counters.backspaces,
    retainedCorrect: counters.retainedCorrect,
    retainedErrors: counters.retainedErrors,
    completedWords: counters.completedWords,
    eligibleForBest: true,
    compatibilityInput: input.config.compatibilityInput || input.eligibility.disqualifiedByCompatibility,
    disqualifiedByPause: input.eligibility.disqualifiedByPause || (input.config.durationLimitMs !== null && input.voluntarilyPaused),
    minimumActiveMs: input.eligibility.minimumActiveMs,
  });

  return {
    id: input.sessionId,
    profileId: input.profileId,
    config: structuredClone(input.config),
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    analyticsZone: input.analyticsZone,
    status: input.status,
    activeMs: counters.activeElapsedMs,
    attempts: counters.attempts,
    correctAttempts: counters.correctAttempts,
    errorAttempts: counters.errorAttempts,
    backspaces: counters.backspaces,
    retainedCorrect: counters.retainedCorrect,
    retainedErrors: counters.retainedErrors,
    completedWords: counters.completedWords,
    grossCpm: metrics.grossCpm,
    adjustedWpm: metrics.adjustedWpm,
    accuracy: metrics.accuracy,
    eligibleForBest,
    seed: input.seed,
  };
}

export function buildDaySlices(session: SessionRecord, drafts: readonly DayCounterDraft[]): SessionDaySlice[] {
  const rows = drafts.length > 0 ? drafts.map((item) => ({ ...item })) : [{
    day: calendarDayAt(Date.parse(session.endedAt), session.analyticsZone),
    activeMs: 0,
    attempts: 0,
    correctAttempts: 0,
    errorAttempts: 0,
    completedWords: 0,
    retainedCorrect: 0,
  }];
  const last = rows.at(-1)!;
  const sum = (key: keyof Omit<DayCounterDraft, 'day'>) => rows.reduce((total, row) => total + row[key], 0);

  // Reconcile any interval/counter not observed by the low-frequency tracker
  // into the final local day. Repository validation still enforces exact
  // equivalence with the immutable session record.
  last.activeMs += session.activeMs - sum('activeMs');
  last.attempts += session.attempts - sum('attempts');
  last.correctAttempts += session.correctAttempts - sum('correctAttempts');
  last.errorAttempts += session.errorAttempts - sum('errorAttempts');
  last.completedWords += session.completedWords - sum('completedWords');
  last.retainedCorrect += session.retainedCorrect - sum('retainedCorrect');

  return rows.filter((row) => row.activeMs !== 0 || row.attempts !== 0 || rows.length === 1).map((row) => ({
    sessionId: session.id,
    profileId: session.profileId,
    day: row.day,
    zone: session.analyticsZone,
    activeMs: row.activeMs,
    attempts: row.attempts,
    correctAttempts: row.correctAttempts,
    errorAttempts: row.errorAttempts,
    completedWords: row.completedWords,
    eligibleActiveMs: session.eligibleForBest ? row.activeMs : 0,
    eligibleRetainedCorrect: session.eligibleForBest ? row.retainedCorrect : 0,
  }));
}

export function mergeDailyAggregate(
  existing: DailyAggregate | undefined,
  session: SessionRecord,
  slice: SessionDaySlice,
): DailyAggregate {
  const eligible = slice.eligibleActiveMs > 0;
  return {
    profileId: session.profileId,
    day: slice.day,
    zone: slice.zone,
    metricVersion: session.config.metricVersion,
    activeMs: (existing?.activeMs ?? 0) + slice.activeMs,
    attempts: (existing?.attempts ?? 0) + slice.attempts,
    correctAttempts: (existing?.correctAttempts ?? 0) + slice.correctAttempts,
    errorAttempts: (existing?.errorAttempts ?? 0) + slice.errorAttempts,
    completedWords: (existing?.completedWords ?? 0) + slice.completedWords,
    eligibleActiveMs: (existing?.eligibleActiveMs ?? 0) + slice.eligibleActiveMs,
    eligibleRetainedCorrect: (existing?.eligibleRetainedCorrect ?? 0) + slice.eligibleRetainedCorrect,
    eligibleSessionCount: (existing?.eligibleSessionCount ?? 0) + (eligible ? 1 : 0),
    bestWpm: eligible && session.adjustedWpm !== null
      ? Math.max(existing?.bestWpm ?? 0, session.adjustedWpm)
      : existing?.bestWpm ?? null,
    revision: (existing?.revision ?? -1) + 1,
  };
}

/** Convert a crash checkpoint to the conservative interrupted snapshot that
 * schema-v1 can represent. The checkpoint contract does not retain completed
 * words; those are deliberately recorded as zero rather than inferred. */
export function snapshotFromCheckpoint(checkpoint: ActiveCheckpoint): EngineSnapshot {
  const retained = new Map<number, boolean>();
  for (const edit of checkpoint.cappedRecentEdits) {
    if (edit.kind === 'delete') retained.delete(edit.position);
    else retained.set(edit.position, edit.correct);
  }
  const retainedErrors = [...retained.values()].filter((correct) => !correct).length;
  return {
    state: 'interrupted',
    activeElapsedMs: checkpoint.activeMs,
    sequence: checkpoint.lastSequence,
    attempts: checkpoint.counts.attempts,
    correctAttempts: checkpoint.counts.correctAttempts,
    errorAttempts: checkpoint.counts.errorAttempts,
    backspaces: checkpoint.counts.backspaces,
    retainedCorrect: checkpoint.counts.retainedCorrect,
    retainedErrors,
    completedWords: 0,
    textCursor: checkpoint.textCursor,
    generationState: checkpoint.generationState,
    cappedRecentEdits: checkpoint.cappedRecentEdits,
  };
}
