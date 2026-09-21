import type { CharacterExposure, MistakeBucket, Profile, SessionRecord } from '../contracts/models.js';
import { ok, type Repository, type RepositoryResult, type SessionCommit } from '../contracts/repository.js';
import { calculateMetrics, isEligibleForBest } from '../domain/metrics/formulas.js';
import { buildDaySlices, calendarDayAt, mergeDailyAggregate, nextCalendarDay } from '../domain/metrics/sessionSummary.js';
import { deriveLessonProgress, evaluateLessonSession } from '../domain/training/progression.js';
import type { PreparedPractice } from '../domain/training/practice.js';

export interface PracticeResultSummary {
  startedAt: string;
  endedAt: string;
  activeMs: number;
  attempts: number;
  correctAttempts: number;
  errorAttempts: number;
  backspaces: number;
  retainedCorrect: number;
  retainedErrors: number;
  completedWords: number;
  exposures: Array<{ expected: string; attempts: number; errors: number }>;
  mistakes: Array<{ expected: string; attempted: string; count: number }>;
}

export async function persistPracticeResult(
  repository: Repository,
  profile: Profile,
  prepared: PreparedPractice,
  result: PracticeResultSummary,
  randomUUID = () => crypto.randomUUID(),
): Promise<RepositoryResult<SessionRecord>> {
  const metrics = calculateMetrics(result);
  const sessionId = randomUUID();
  const session: SessionRecord = {
    id: sessionId,
    profileId: profile.id,
    config: structuredClone(prepared.sessionConfig),
    startedAt: result.startedAt,
    endedAt: result.endedAt,
    analyticsZone: profile.analyticsZone,
    status: 'completed',
    activeMs: result.activeMs,
    attempts: result.attempts,
    correctAttempts: result.correctAttempts,
    errorAttempts: result.errorAttempts,
    backspaces: result.backspaces,
    retainedCorrect: result.retainedCorrect,
    retainedErrors: result.retainedErrors,
    completedWords: result.completedWords,
    grossCpm: metrics.grossCpm,
    adjustedWpm: metrics.adjustedWpm,
    accuracy: metrics.accuracy,
    eligibleForBest: isEligibleForBest({
      ...result,
      eligibleForBest: true,
      compatibilityInput: prepared.sessionConfig.compatibilityInput || prepared.source.eligibility.disqualifiedByCompatibility,
      disqualifiedByPause: prepared.source.eligibility.disqualifiedByPause,
      minimumActiveMs: prepared.source.eligibility.minimumActiveMs,
    }),
    seed: null,
  };
  const day = calendarDayAt(Date.parse(result.endedAt), profile.analyticsZone);
  const slices = buildDaySlices(session, [{
    day,
    activeMs: result.activeMs,
    attempts: result.attempts,
    correctAttempts: result.correctAttempts,
    errorAttempts: result.errorAttempts,
    completedWords: result.completedWords,
    retainedCorrect: result.retainedCorrect,
  }]);
  const existing = await repository.getDailyAggregates(profile.id, day, nextCalendarDay(day));
  if (!existing.ok) return existing;
  const prior = existing.value.find((row) => row.day === day && row.zone === profile.analyticsZone
    && row.metricVersion === prepared.sessionConfig.metricVersion);
  const exposures: CharacterExposure[] = result.exposures.map((item) => ({ ...item, profileId: profile.id, sessionId }));
  const mistakes: MistakeBucket[] = result.mistakes.map((item) => ({ ...item, profileId: profile.id, sessionId }));
  let lessonProgress: SessionCommit['lessonProgress'];
  const evaluator = prepared.source.progressEvaluator;
  if (evaluator) {
    const existing = await repository.getLessonProgress(profile.id, prepared.sessionConfig.contentVersion);
    if (!existing.ok) return existing;
    const recent: SessionRecord[] = [];
    let cursor: string | null = null;
    do {
      const page = await repository.querySessions({ profileId: profile.id, mode: 'lessons', includeIneligible: true, limit: 200, cursor });
      if (!page.ok) return page;
      for (const item of page.value.sessions) {
        if (item.id !== session.id && item.status === 'completed'
          && item.config.sourceRef === evaluator.lessonId
          && item.config.contentVersion === session.config.contentVersion) recent.push(item);
        if (recent.length >= 3) break;
      }
      cursor = page.value.nextCursor;
    } while (recent.length < 3 && cursor !== null);
    const evaluation = evaluateLessonSession(evaluator.definition, session);
    lessonProgress = [deriveLessonProgress({
      definition: evaluator.definition,
      existing: existing.value.find((item) => item.lessonId === evaluator.lessonId),
      session,
      evaluation,
      recentCompletedSessions: recent,
    })];
  }
  const committed = await repository.commitSession({
    session,
    daySlices: slices,
    mistakes,
    exposures,
    lessonProgress,
    aggregateChanges: [mergeDailyAggregate(prior, session, slices[0])],
    updateProfileCharacterStats: true,
    removeCheckpointId: sessionId,
  });
  return committed.ok ? ok(session) : committed;
}
