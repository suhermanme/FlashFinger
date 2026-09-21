import type { LessonProgress, SessionRecord } from '../../contracts/models.js';
import type {
  CriterionResult,
  Curriculum,
  LessonDefinition,
  LessonEvaluation,
  ProgressEvaluator,
  ProgressEvaluationContext,
} from '../../contracts/training.js';

export const MINIMUM_LESSON_ACTIVE_MS = 15_000;

export interface LessonProgressInput {
  definition: LessonDefinition;
  existing?: LessonProgress;
  session: SessionRecord;
  evaluation: LessonEvaluation;
  /** Newest first, completed attempts only, excluding `session`. */
  recentCompletedSessions: readonly SessionRecord[];
}

export interface LessonAvailability {
  definition: LessonDefinition;
  progress: LessonProgress | null;
  unlocked: boolean;
  mastered: boolean;
}

function criterion(id: string, label: string, met: boolean, detail: string): CriterionResult {
  return { id, label, met, detail };
}

function fixed(value: number | null): string {
  return value === null ? 'unavailable' : value.toFixed(1);
}

export function evaluateLessonSession(
  definition: LessonDefinition,
  session: SessionRecord,
  context: ProgressEvaluationContext = {},
): LessonEvaluation {
  const correctSource = session.config.mode === 'lessons'
    && session.config.sourceRef === definition.id
    && session.config.contentVersion === definition.curriculumVersion;
  const criteria = [
    criterion('source', 'Correct lesson and curriculum version', correctSource,
      correctSource ? 'Lesson identity matches.' : 'This result belongs to another lesson or curriculum version.'),
    criterion('completed', 'Complete the full lesson', session.status === 'completed',
      session.status === 'completed' ? 'The full target was completed.' : `Session ended as ${session.status}.`),
    criterion('duration', 'At least 15 seconds of active typing', session.activeMs >= MINIMUM_LESSON_ACTIVE_MS,
      session.activeMs >= MINIMUM_LESSON_ACTIVE_MS
        ? `${(session.activeMs / 1_000).toFixed(1)} seconds recorded.`
        : `${(session.activeMs / 1_000).toFixed(1)} seconds is below 15.0 seconds.`),
    criterion('accuracy', `Accuracy at least ${definition.minimumAccuracy}%`,
      session.accuracy !== null && session.accuracy >= definition.minimumAccuracy,
      session.accuracy !== null && session.accuracy >= definition.minimumAccuracy
        ? `${session.accuracy.toFixed(1)}% meets ${definition.minimumAccuracy.toFixed(1)}%.`
        : `${fixed(session.accuracy)}% is below ${definition.minimumAccuracy.toFixed(1)}%.`),
    criterion('speed', `Adjusted WPM at least ${definition.minimumWpm}`,
      session.adjustedWpm !== null && session.adjustedWpm >= definition.minimumWpm,
      session.adjustedWpm !== null && session.adjustedWpm >= definition.minimumWpm
        ? `${session.adjustedWpm.toFixed(1)} WPM meets ${definition.minimumWpm.toFixed(1)} WPM.`
        : `${fixed(session.adjustedWpm)} WPM is below ${definition.minimumWpm.toFixed(1)} WPM.`),
    criterion('compatibility', 'Standard scored keyboard input', !session.config.compatibilityInput,
      session.config.compatibilityInput ? 'Compatibility input does not qualify for mastery.' : 'Standard input recorded.'),
    criterion('pause', 'No voluntary pause', context.voluntarilyPaused !== true,
      context.voluntarilyPaused ? 'A voluntary pause disqualifies this attempt.' : 'No voluntary pause recorded.'),
  ];
  return { qualifies: criteria.every((item) => item.met), criteria };
}

export function createLessonEvaluator(definition: LessonDefinition): ProgressEvaluator {
  return {
    lessonId: definition.id,
    definition,
    requiredQualifyingPasses: definition.requiredQualifyingPasses,
    evaluate: (session, context) => evaluateLessonSession(definition, session, context),
  };
}

export function deriveLessonProgress(input: LessonProgressInput): LessonProgress {
  const { definition, existing, session, evaluation } = input;
  const priorQualifying = existing?.qualifyingSessionIds ?? [];
  const qualifyingSessionIds = evaluation.qualifies
    ? [...new Set([...priorQualifying, session.id])]
    : [...priorQualifying];
  const recent = session.status === 'completed'
    ? [session, ...input.recentCompletedSessions.filter((item) => item.id !== session.id)].slice(0, 3)
    : input.recentCompletedSessions.filter((item) => item.id !== session.id).slice(0, 3);
  const latestQualifyingCount = recent.filter((item) => qualifyingSessionIds.includes(item.id)).length;
  const newlyMastered = latestQualifyingCount >= definition.requiredQualifyingPasses;
  const bestWpm = evaluation.qualifies && session.adjustedWpm !== null
    ? Math.max(existing?.bestWpm ?? 0, session.adjustedWpm)
    : existing?.bestWpm ?? null;
  const bestAccuracy = evaluation.qualifies && session.accuracy !== null
    ? Math.max(existing?.bestAccuracy ?? 0, session.accuracy)
    : existing?.bestAccuracy ?? null;

  return {
    profileId: session.profileId,
    lessonId: definition.id,
    curriculumVersion: definition.curriculumVersion,
    attemptCount: (existing?.attemptCount ?? 0) + 1,
    passCount: qualifyingSessionIds.length,
    bestWpm,
    bestAccuracy,
    lastAttemptAt: session.endedAt,
    masteredAt: existing?.masteredAt ?? (newlyMastered ? session.endedAt : null),
    qualifyingSessionIds,
  };
}

export function validateCurriculumGraph(curriculum: Curriculum): string[] {
  const errors: string[] = [];
  const byId = new Map<string, LessonDefinition>();
  for (const lesson of curriculum.lessons) {
    if (byId.has(lesson.id)) errors.push(`Duplicate lesson id: ${lesson.id}`);
    byId.set(lesson.id, lesson);
    if (lesson.curriculumVersion !== curriculum.version) errors.push(`${lesson.id} has the wrong curriculum version`);
    if (lesson.requiredQualifyingPasses < 1 || lesson.requiredQualifyingPasses > 3) {
      errors.push(`${lesson.id} has an invalid qualifying-pass requirement`);
    }
  }
  for (const lesson of curriculum.lessons) {
    for (const prerequisite of lesson.prerequisites) {
      if (!byId.has(prerequisite)) errors.push(`${lesson.id} has unknown prerequisite ${prerequisite}`);
      if (prerequisite === lesson.id) errors.push(`${lesson.id} cannot require itself`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) { errors.push(`Curriculum prerequisite cycle includes ${id}`); return; }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const prerequisite of byId.get(id)?.prerequisites ?? []) visit(prerequisite);
    visiting.delete(id);
    visited.add(id);
  };
  for (const lesson of curriculum.lessons) visit(lesson.id);
  return [...new Set(errors)];
}

export function buildLessonAvailability(
  curriculum: Curriculum,
  progressRows: readonly LessonProgress[],
): LessonAvailability[] {
  const progress = new Map(progressRows
    .filter((item) => item.curriculumVersion === curriculum.version)
    .map((item) => [item.lessonId, item]));
  const mastered = new Set([...progress.values()].filter((item) => item.masteredAt !== null).map((item) => item.lessonId));
  return curriculum.lessons.map((definition, index) => ({
    definition,
    progress: progress.get(definition.id) ?? null,
    unlocked: index === 0 || definition.prerequisites.every((id) => mastered.has(id)),
    mastered: mastered.has(definition.id),
  }));
}

export function nextUnlockedLesson(
  availability: readonly LessonAvailability[],
  lessonId: string,
): LessonAvailability | null {
  const index = availability.findIndex((item) => item.definition.id === lessonId);
  return availability.slice(index + 1).find((item) => item.unlocked) ?? null;
}

/** Project achievements only through an explicit unchanged-lesson map. The
 * caller persists these as additional rows; prior-version rows remain intact. */
export function projectLessonProgressMigration(
  priorRows: readonly LessonProgress[],
  fromVersion: string,
  toVersion: string,
  unchangedLessons: Readonly<Record<string, string>>,
): LessonProgress[] {
  return priorRows
    .filter((item) => item.curriculumVersion === fromVersion && unchangedLessons[item.lessonId] !== undefined)
    .map((item) => ({
      ...structuredClone(item),
      lessonId: unchangedLessons[item.lessonId],
      curriculumVersion: toVersion,
    }));
}
