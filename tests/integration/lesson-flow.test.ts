import { readFile, mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DesktopRepository } from '../../electron/storage/repository.js';
import { SessionCoordinator } from '../../src/app/sessionCoordinator.js';
import {
  createLessonSessionConfig,
  createLessonSource,
  parseCurriculumAsset,
  type LessonCatalog,
} from '../../src/domain/training/lessons.js';
import { createRuntimeStore } from '../../src/state/runtime.js';
import { PROFILE_A_ID, profileA } from '../fixtures/contracts/index.js';

const assetPath = new URL('../../public/content/lessons/ff-curriculum-v1.json', import.meta.url);
const sessionIds = [
  '51111111-1111-4111-8111-111111111111',
  '52222222-2222-4222-8222-222222222222',
  '53333333-3333-4333-8333-333333333333',
  '54444444-4444-4444-8444-444444444444',
];

async function runLesson(
  repository: DesktopRepository,
  catalog: LessonCatalog,
  sessionId: string,
  errorAttempts: number,
) {
  const source = createLessonSource(catalog, 'ff-stage1-fj', 'profile-seed');
  const target = [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(
    Array.from({ length: Math.ceil((source.graphemeCount ?? 0) / source.chunkSize) }, (_, index) => source.chunkAt(index) ?? '').join(''),
  )].map((item) => item.segment);
  let monotonic = 1_000;
  let wall = Date.parse('2026-09-21T08:00:00.000Z');
  const advance = (milliseconds: number) => { monotonic += milliseconds; wall += milliseconds; };
  const runtime = createRuntimeStore();
  runtime.resetForProfile(PROFILE_A_ID);
  const coordinator = new SessionCoordinator({
    repository, runtime, profileId: PROFILE_A_ID, analyticsZone: profileA.analyticsZone,
    source, config: createLessonSessionConfig(source), monotonicNow: () => monotonic,
    wallNow: () => wall, randomUUID: () => sessionId,
  });
  expect((await coordinator.prepare()).ok).toBe(true);
  let clockAdvanced = false;
  for (let index = 0; index < target.length; index += 1) {
    if (index < errorAttempts) {
      coordinator.processCommand({ kind: 'character', grapheme: target[index] === 'x' ? 'q' : 'x' });
      if (!clockAdvanced) { advance(15_000); clockAdvanced = true; }
    }
    coordinator.processCommand({ kind: 'character', grapheme: target[index] });
    if (!clockAdvanced) { advance(15_000); clockAdvanced = true; }
  }
  expect((await coordinator.finish('completed')).ok).toBe(true);
  return coordinator;
}

describe('M12 durable lesson flow', () => {
  it('commits mastery atomically, unlocks the next lesson, ignores duplicate finish, and preserves mastery after failures', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'flashfinger-m12-'));
    try {
      const catalog = parseCurriculumAsset(JSON.parse(await readFile(assetPath, 'utf8')));
      const repository = new DesktopRepository({ rootDirectory: directory, randomUUID: () => PROFILE_A_ID, compactAfterRecords: 0 });
      expect(await repository.initialize()).toMatchObject({ ok: true });
      expect(await repository.createProfile({ name: profileA.name, avatarToken: profileA.avatarToken,
        analyticsZone: profileA.analyticsZone, settings: profileA.settings })).toMatchObject({ ok: true });

      await runLesson(repository, catalog, sessionIds[0], 0);
      expect(await repository.getLessonProgress(PROFILE_A_ID, catalog.curriculum.version)).toMatchObject({
        ok: true, value: [{ attemptCount: 1, passCount: 1, masteredAt: null }],
      });

      const second = await runLesson(repository, catalog, sessionIds[1], 0);
      const afterMastery = await repository.getLessonProgress(PROFILE_A_ID, catalog.curriculum.version);
      expect(afterMastery).toMatchObject({ ok: true, value: [{ attemptCount: 2, passCount: 2 }] });
      if (!afterMastery.ok) throw new Error('progress unavailable');
      expect(afterMastery.value[0].masteredAt).not.toBeNull();
      expect(afterMastery.value[0].qualifyingSessionIds).toEqual(sessionIds.slice(0, 2));

      expect((await second.finish('completed')).ok).toBe(true);
      expect(await repository.getLessonProgress(PROFILE_A_ID, catalog.curriculum.version)).toMatchObject({
        ok: true, value: [{ attemptCount: 2, passCount: 2 }],
      });

      const firstMasteredAt = afterMastery.value[0].masteredAt;
      const failed = await runLesson(repository, catalog, sessionIds[2], 20);
      expect(failed.getSnapshot().result).toMatchObject({
        lessonEvaluation: { qualifies: false }, highErrorKeys: expect.arrayContaining(['f', 'j']),
      });
      await runLesson(repository, catalog, sessionIds[3], 20);
      const final = await repository.getLessonProgress(PROFILE_A_ID, catalog.curriculum.version);
      expect(final).toMatchObject({ ok: true, value: [{ attemptCount: 4, passCount: 2, masteredAt: firstMasteredAt }] });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
