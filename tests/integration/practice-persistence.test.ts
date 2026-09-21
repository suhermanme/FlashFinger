import { describe, expect, it } from 'vitest';
import type { PracticeConfig } from '../../src/contracts/models.js';
import { ok, type SessionCommit } from '../../src/contracts/repository.js';
import type { DictionaryManifest } from '../../src/domain/training/dictionary.js';
import { preparePractice } from '../../src/domain/training/practice.js';
import { persistPracticeResult } from '../../src/app/practicePersistence.js';
import { createMockRepository } from '../../src/platform/mock-repository.js';
import { profileA } from '../fixtures/contracts/index.js';

const manifest: DictionaryManifest = {
  id: 'ff-english-10k-v1', version: 'ff-english-10k-v1', language: 'en-US', source: 'fixture', sourceSha256: 'fixture', selectionPolicy: 'fixture',
  counts: { beginner: 2, intermediate: 0, advanced: 0, total: 2 },
  entries: ['able', 'bake'].map((spelling, index) => ({ id: `ff-en-${index}`, spelling, graphemeLength: 4, difficulty: 'beginner', frequencyBand: 'high', punctuationSuitable: true, capitalizationSuitable: true })),
};
const config: PracticeConfig = { tier: 'beginner', termination: { kind: 'timed', seconds: 60 }, punctuation: false, capitalization: false, seed: 'unique', correctionPolicy: 'advance', keyFilter: null, configVersion: 1 };

describe('completed practice persistence', () => {
  it('commits the session, daily aggregate, mistakes, and exposures atomically', async () => {
    const commits: SessionCommit[] = [];
    const repository = Object.assign(createMockRepository(), {
      getDailyAggregates: async () => ok([]),
      commitSession: async (value: SessionCommit) => { commits.push(value); return ok({ alreadyCommitted: false, sessionId: value.session.id }); },
    });
    const result = await persistPracticeResult(repository, profileA, preparePractice(manifest, config), {
      startedAt: '2026-09-21T10:00:00.000Z', endedAt: '2026-09-21T10:01:00.000Z', activeMs: 60_000,
      attempts: 100, correctAttempts: 96, errorAttempts: 4, backspaces: 2, retainedCorrect: 95, retainedErrors: 1, completedWords: 19,
      exposures: [{ expected: 'a', attempts: 10, errors: 1 }], mistakes: [{ expected: 'a', attempted: 's', count: 1 }],
    }, () => '91111111-1111-4111-8111-111111111111');

    expect(result.ok).toBe(true);
    expect(commits[0].session).toMatchObject({ profileId: profileA.id, status: 'completed', adjustedWpm: 19, accuracy: 96 });
    expect(commits[0].aggregateChanges).toHaveLength(1);
    expect(commits[0].mistakes[0]).toMatchObject({ expected: 'a', attempted: 's' });
    expect(commits[0].exposures[0]).toMatchObject({ expected: 'a', attempts: 10, errors: 1 });
  });
});
