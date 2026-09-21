import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { SessionRecord } from '../../src/contracts/models.js';
import {
  createLessonSource,
  generateLessonText,
  parseCurriculumAsset,
} from '../../src/domain/training/lessons.js';
import {
  buildLessonAvailability,
  deriveLessonProgress,
  evaluateLessonSession,
  projectLessonProgressMigration,
  validateCurriculumGraph,
} from '../../src/domain/training/progression.js';
import { PROFILE_A_ID } from '../fixtures/contracts/index.js';

const assetPath = new URL('../../public/content/lessons/ff-curriculum-v1.json', import.meta.url);

async function catalog() {
  return parseCurriculumAsset(JSON.parse(await readFile(assetPath, 'utf8')));
}

function session(id: string, lessonId: string, options: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id,
    profileId: PROFILE_A_ID,
    config: {
      mode: 'lessons', correctionPolicy: 'strict', durationLimitMs: null, targetLength: 120,
      sourceRef: lessonId, contentVersion: 'ff-curriculum-v1', metricVersion: 1,
      layout: 'us-qwerty', compatibilityInput: false, heldKeyRepeat: 'ignored',
    },
    startedAt: '2026-09-21T08:00:00.000Z', endedAt: '2026-09-21T08:00:15.000Z',
    analyticsZone: 'Asia/Jakarta', status: 'completed', activeMs: 15_000,
    attempts: 120, correctAttempts: 118, errorAttempts: 2, backspaces: 2,
    retainedCorrect: 120, retainedErrors: 0, completedWords: 20,
    grossCpm: 480, adjustedWpm: 96, accuracy: 98.3333333333,
    eligibleForBest: true, seed: 'lesson-seed',
    ...options,
  };
}

describe('M12 curriculum validation and deterministic generation', () => {
  it('ships the complete planned six-stage graph with stage minimum lengths', async () => {
    const value = await catalog();
    expect(value.curriculum.version).toBe('ff-curriculum-v1');
    expect(value.curriculum.lessons).toHaveLength(26);
    expect(validateCurriculumGraph(value.curriculum)).toEqual([]);
    expect([1, 2, 3, 4, 5, 6].map((stage) => value.curriculum.lessons.filter((item) => item.stage === stage).length))
      .toEqual([5, 2, 6, 6, 5, 2]);
    for (const entry of value.entries) expect(entry.targetLength).toBeGreaterThanOrEqual(entry.stage === 1 ? 120 : 240);
    expect(value.migrations).toEqual([]);
  });

  it('rejects cycles and exercise units containing locked keys', async () => {
    const value = await catalog();
    const [first, second] = value.curriculum.lessons;
    const cyclic = { version: value.curriculum.version, lessons: [
      { ...first, prerequisites: [second.id] }, { ...second, prerequisites: [first.id] },
    ] };
    expect(validateCurriculumGraph(cyclic).some((error) => error.includes('cycle'))).toBe(true);

    const raw = JSON.parse(await readFile(assetPath, 'utf8'));
    raw.lessons[0].newUnits.push('x');
    expect(() => parseCurriculumAsset(raw)).toThrow(/locked grapheme/);
  });

  it('reproduces seeded text, varies other seeds, and keeps the 60/40 drill weighting', async () => {
    const value = await catalog();
    const entry = value.entries.find((item) => item.id === 'ff-stage1-dk')!;
    const first = generateLessonText(entry, 'profile-a');
    expect(generateLessonText(entry, 'profile-a')).toBe(first);
    expect(generateLessonText(entry, 'profile-b')).not.toBe(first);
    expect([...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(first)]).toHaveLength(120);
    const nonSpaces = [...first].filter((item) => item !== ' ');
    const introduced = nonSpaces.filter((item) => item === 'd' || item === 'k').length;
    expect(introduced / nonSpaces.length).toBeGreaterThanOrEqual(0.55);
    expect(introduced / nonSpaces.length).toBeLessThanOrEqual(0.65);
    expect(nonSpaces.every((item) => new Set(['d', 'k', 'f', 'j']).has(item))).toBe(true);
    for (const drill of value.entries.filter((item) => item.exercisePolicy === 'new-key-drill' && item.reviewKeys.length > 0)) {
      const generated = [...generateLessonText(drill, 'ratio-audit')].filter((item) => item !== ' ');
      const introducedSet = new Set(drill.introducedKeys);
      const ratio = generated.filter((item) => introducedSet.has(item)).length / generated.length;
      expect(ratio, drill.id).toBeGreaterThanOrEqual(0.55);
      expect(ratio, drill.id).toBeLessThanOrEqual(0.65);
    }
    expect(createLessonSource(value, entry.id, 'profile-a').progressEvaluator?.lessonId).toBe(entry.id);
  });
});

describe('M12 lesson qualification and progression', () => {
  it('explains every failed gate exactly', async () => {
    const value = await catalog();
    const definition = value.curriculum.lessons[0];
    const result = evaluateLessonSession(definition, session('11111111-1111-4111-8111-111111111111', definition.id, {
      status: 'aborted', activeMs: 9_000, accuracy: 90, adjustedWpm: 5,
      config: { ...session('11111111-1111-4111-8111-111111111111', definition.id).config, compatibilityInput: true },
    }), { voluntarilyPaused: true });
    expect(result.qualifies).toBe(false);
    expect(result.criteria.filter((item) => !item.met).map((item) => item.id))
      .toEqual(['completed', 'duration', 'accuracy', 'speed', 'compatibility', 'pause']);
    expect(result.criteria.every((item) => item.detail.length > 0)).toBe(true);
  });

  it('masters two qualifying sessions among the latest three and never revokes mastery', async () => {
    const value = await catalog();
    const definition = value.curriculum.lessons[0];
    const one = session('11111111-1111-4111-8111-111111111111', definition.id);
    const failed = session('22222222-2222-4222-8222-222222222222', definition.id, { accuracy: 80 });
    const two = session('33333333-3333-4333-8333-333333333333', definition.id);
    const failEvaluation = evaluateLessonSession(definition, failed);
    const first = deriveLessonProgress({ definition, session: one,
      evaluation: evaluateLessonSession(definition, one), recentCompletedSessions: [] });
    const second = deriveLessonProgress({ definition, existing: first, session: failed,
      evaluation: failEvaluation, recentCompletedSessions: [one] });
    const mastered = deriveLessonProgress({ definition, existing: second, session: two,
      evaluation: evaluateLessonSession(definition, two), recentCompletedSessions: [failed, one] });
    expect(mastered).toMatchObject({ attemptCount: 3, passCount: 2, masteredAt: two.endedAt });
    expect(mastered.qualifyingSessionIds).toEqual([one.id, two.id]);

    const lateFailure = session('44444444-4444-4444-8444-444444444444', definition.id, { accuracy: 70 });
    const retained = deriveLessonProgress({ definition, existing: mastered, session: lateFailure,
      evaluation: evaluateLessonSession(definition, lateFailure), recentCompletedSessions: [two, failed, one] });
    expect(retained.masteredAt).toBe(mastered.masteredAt);
    expect(buildLessonAvailability(value.curriculum, [retained])[1]).toMatchObject({ unlocked: true });
  });

  it('retains prior-version progress and projects only explicitly unchanged lessons', async () => {
    const value = await catalog();
    const definition = value.curriculum.lessons[0];
    const completed = session('71111111-1111-4111-8111-111111111111', definition.id);
    const current = deriveLessonProgress({ definition, session: completed,
      evaluation: evaluateLessonSession(definition, completed), recentCompletedSessions: [] });
    const prior = { ...current, curriculumVersion: 'ff-curriculum-v0' };
    const projected = projectLessonProgressMigration([prior], 'ff-curriculum-v0', value.curriculum.version,
      { [definition.id]: definition.id });
    expect(prior.curriculumVersion).toBe('ff-curriculum-v0');
    expect(projected).toEqual([{ ...prior, curriculumVersion: value.curriculum.version }]);
    expect(projectLessonProgressMigration([prior], 'ff-curriculum-v0', value.curriculum.version, {})).toEqual([]);
  });
});
