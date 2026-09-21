// @vitest-environment jsdom

import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SessionCoordinator } from '../../src/app/sessionCoordinator.js';
import type { PracticeConfig } from '../../src/contracts/models.js';
import { ok, type SessionCommit } from '../../src/contracts/repository.js';
import type { DictionaryManifest } from '../../src/domain/training/dictionary.js';
import { preparePractice } from '../../src/domain/training/practice.js';
import { PracticeSetup } from '../../src/features/practice/PracticeSetup.js';
import { PracticeSession, scrollPracticeCaretIntoView } from '../../src/features/practice/PracticeSession.js';
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
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Start practice/ })); });
    expect(onStart).toHaveBeenCalledOnce();
    expect(onStart.mock.calls[0][1]).toMatchObject({ seed: 'repeatable', tier: 'beginner' });

    fireEvent.change(screen.getByLabelText('Focus keys'), { target: { value: 'z' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Start practice/ })); });
    expect(screen.getByRole('alert').textContent).toContain('No local dictionary words');
  });

  it('types directly on the generated passage without a visible input box', () => {
    const prepared = preparePractice(manifest, baseConfig);
    const { container } = render(<PracticeSession prepared={prepared} onExit={() => undefined} />);
    const text = targetText(prepared);
    fireEvent.change(screen.getByLabelText('Typing input'), { target: { value: `${text[0]}x` } });
    expect(container.querySelectorAll('.ff-target-correct')).toHaveLength(1);
    expect(container.querySelectorAll('.ff-target-error')).toHaveLength(1);
    expect(container.querySelector('.ff-target-current')).not.toBeNull();
    expect(container.querySelector('.ff-practice-input')).toBeNull();
  });

  it('shows a clear result when a timed session ends and can restart it', () => {
    vi.useFakeTimers();
    try {
      const prepared = preparePractice(manifest, { ...baseConfig, termination: { kind: 'timed', seconds: 15 } });
      render(<PracticeSession prepared={prepared} onExit={() => undefined} soundEnabled={false} />);
      fireEvent.change(screen.getByLabelText('Typing input'), { target: { value: targetText(prepared)[0] } });
      act(() => { vi.advanceTimersByTime(15_000); });

      expect(screen.getByRole('dialog', { name: 'Session complete' })).toBeTruthy();
      expect(screen.getByText('Time’s up')).toBeTruthy();
      expect(screen.getByText('15s')).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      expect(screen.queryByRole('dialog', { name: 'Session complete' })).toBeNull();
      expect(screen.getByLabelText('Typing input')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('scrolls the passage before the caret leaves the final visible line', () => {
    const viewport = document.createElement('div');
    const caret = document.createElement('span');
    viewport.style.lineHeight = '40px';
    Object.defineProperties(viewport, { clientHeight: { value: 200 }, scrollHeight: { value: 800 }, scrollTop: { value: 0, writable: true } });
    Object.defineProperties(caret, { offsetTop: { value: 180 }, offsetHeight: { value: 40 } });
    viewport.getBoundingClientRect = () => ({ top: 0, bottom: 200, left: 0, right: 600, width: 600, height: 200, x: 0, y: 0, toJSON: () => ({}) });
    caret.getBoundingClientRect = () => ({ top: 180, bottom: 220, left: 500, right: 520, width: 20, height: 40, x: 500, y: 180, toJSON: () => ({}) });
    scrollPracticeCaretIntoView(viewport, caret);
    expect(viewport.scrollTop).toBeCloseTo(70);
    caret.getBoundingClientRect = () => ({ top: -10, bottom: 30, left: 20, right: 40, width: 20, height: 40, x: 20, y: -10, toJSON: () => ({}) });
    scrollPracticeCaretIntoView(viewport, caret, 'forward');
    expect(viewport.scrollTop).toBeCloseTo(70);
    scrollPracticeCaretIntoView(viewport, caret, 'backward');
    expect(viewport.scrollTop).toBe(0);
  });
});
