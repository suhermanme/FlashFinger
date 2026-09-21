// @vitest-environment jsdom

import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SessionCoordinator } from '../../src/app/sessionCoordinator.js';
import type { PracticeConfig } from '../../src/contracts/models.js';
import { ok, type SessionCommit } from '../../src/contracts/repository.js';
import type { DictionaryManifest } from '../../src/domain/training/dictionary.js';
import { preparePractice } from '../../src/domain/training/practice.js';
import { PracticeSetup } from '../../src/features/practice/PracticeSetup.js';
import { createMockRepository } from '../../src/platform/mock-repository.js';
import { createRuntimeStore } from '../../src/state/runtime.js';
import { PROFILE_A_ID } from '../fixtures/contracts/index.js';

const manifest: DictionaryManifest = {
  id: 'ff-english-10k-v1', version: 'ff-english-10k-v1', language: 'en-US', source: 'fixture',
  sourceSha256: 'fixture', selectionPolicy: 'fixture', counts: { beginner: 2, intermediate: 0, advanced: 0, total: 2 },
  entries: ['able', 'bake'].map((spelling, index) => ({ id: `ff-en-${String(index + 1).padStart(5, '0')}`,
    spelling, graphemeLength: 4, difficulty: 'beginner', frequencyBand: 'high',
    punctuationSuitable: true, capitalizationSuitable: true })),
};
const baseConfig: PracticeConfig = { tier: 'beginner', termination: { kind: 'words', count: 25 },
  punctuation: false, capitalization: false, seed: 'flow-seed', correctionPolicy: 'advance',
  keyFilter: null, configVersion: 1 };

function targetText(prepared: ReturnType<typeof preparePractice>): string {
  return Array.from({ length: Math.ceil((prepared.source.graphemeCount ?? 0) / prepared.source.chunkSize) },
    (_, index) => prepared.source.chunkAt(index) ?? '').join('');
}

describe('M13 practice flow', () => {
  it('finishes a word target on the final word without requiring a trailing space', async () => {
    const prepared = preparePractice(manifest, baseConfig);
    const text = targetText(prepared);
    expect(text.endsWith(' ')).toBe(false);
    const commits: SessionCommit[] = [];
    const repository = Object.assign(createMockRepository(), {
      getDailyAggregates: async () => ok([]),
      commitSession: async (commit: SessionCommit) => { commits.push(commit); return ok({ alreadyCommitted: false, sessionId: commit.session.id }); },
    });
    let monotonic = 1_000;
    let wall = Date.parse('2026-09-21T10:00:00.000Z');
    const runtime = createRuntimeStore(); runtime.resetForProfile(PROFILE_A_ID);
    const coordinator = new SessionCoordinator({ repository, runtime, profileId: PROFILE_A_ID,
      analyticsZone: 'Asia/Jakarta', source: prepared.source, config: prepared.sessionConfig,
      monotonicNow: () => monotonic, wallNow: () => wall,
      randomUUID: () => '81111111-1111-4111-8111-111111111111' });
    await coordinator.prepare();
    const graphemes = [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text)].map((item) => item.segment);
    coordinator.processCommand({ kind: 'character', grapheme: graphemes[0] });
    expect(coordinator.getSnapshot().metrics.attempts).toBe(1);
    monotonic += 15_000; wall += 15_000;
    for (const grapheme of graphemes.slice(1)) coordinator.processCommand({ kind: 'character', grapheme });
    expect((await coordinator.finish('completed')).ok).toBe(true);
    expect(commits[0].session).toMatchObject({ status: 'completed', completedWords: 25 });
  });

  it('validates setup locally and prepares an explicit configuration', async () => {
    const onStart = vi.fn();
    render(<PracticeSetup manifest={manifest} initialConfig={baseConfig} onStart={onStart} />);
    fireEvent.change(screen.getByLabelText('Seed'), { target: { value: 'repeatable' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Prepare practice' })); });
    expect(onStart).toHaveBeenCalledOnce();
    expect(onStart.mock.calls[0][1]).toMatchObject({ seed: 'repeatable', tier: 'beginner' });

    fireEvent.change(screen.getByLabelText('Focus keys'), { target: { value: 'z' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Prepare practice' })); });
    expect(screen.getByRole('alert').textContent).toContain('No local dictionary words');
  });
});
