// @vitest-environment jsdom

import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SessionCoordinator } from '../../src/app/sessionCoordinator.js';
import type { SessionConfig } from '../../src/contracts/models.js';
import { ok, type SessionCommit } from '../../src/contracts/repository.js';
import type { TrainingSource } from '../../src/contracts/training.js';
import { SessionScreen } from '../../src/features/typing/SessionScreen.js';
import { createMockRepository } from '../../src/platform/mock-repository.js';
import { createRuntimeStore } from '../../src/state/runtime.js';
import { PROFILE_A_ID } from '../fixtures/contracts/index.js';

const source: TrainingSource = {
  id: 'fixture:screen', version: 'fixture-v1', mode: 'practice', title: 'Screen fixture', correctionPolicy: 'advance',
  termination: { kind: 'complete-target' },
  eligibility: { disqualifiedByCompatibility: false, disqualifiedByPause: false, minimumActiveMs: 0 },
  graphemeCount: 1, chunkSize: 64, chunkAt: (index) => index === 0 ? 'a' : null,
};

const config: SessionConfig = {
  mode: 'practice', correctionPolicy: 'advance', durationLimitMs: null, targetLength: 1,
  sourceRef: source.id, contentVersion: source.version, metricVersion: 1, layout: 'us-qwerty',
  compatibilityInput: false, heldKeyRepeat: 'ignored',
};

describe('M11 session and result screens', () => {
  it('moves from a labeled typing surface to a durably saved result without per-key React state', async () => {
    const commits: SessionCommit[] = [];
    const repository = Object.assign(createMockRepository(), {
      getDailyAggregates: async () => ok([]),
      commitSession: async (commit: SessionCommit) => { commits.push(commit); return ok({ alreadyCommitted: false, sessionId: commit.session.id }); },
    });
    const runtime = createRuntimeStore();
    runtime.resetForProfile(PROFILE_A_ID);
    const coordinator = new SessionCoordinator({ repository, runtime, profileId: PROFILE_A_ID,
      analyticsZone: 'Asia/Jakarta', source, config, monotonicNow: () => 1_000, wallNow: () => Date.parse('2026-09-21T08:00:00.000Z'),
      randomUUID: () => '88888888-8888-4888-8888-888888888888' });
    const feedback = { onDeltas: vi.fn(), cancel: vi.fn() };
    render(<SessionScreen coordinator={coordinator} feedback={feedback} />);
    expect(await screen.findByRole('textbox', { name: 'Typing input' })).toBeTruthy();
    await waitFor(() => expect(coordinator.getSnapshot().phase).toBe('ready'));
    await act(async () => {
      coordinator.processCommand({ kind: 'character', grapheme: 'a' });
      await coordinator.finish('completed');
    });
    expect(screen.getByRole('heading', { name: 'Session complete' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Result saved locally');
    expect(commits).toHaveLength(1);
  });
});
