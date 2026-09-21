// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Curriculum, LessonEvaluation } from '../../src/contracts/training.js';
import { ok } from '../../src/contracts/repository.js';
import type { LessonCatalog } from '../../src/domain/training/lessons.js';
import { LessonCatalogScreen } from '../../src/features/lessons/LessonCatalogScreen.js';
import { LessonResult } from '../../src/features/lessons/LessonResult.js';
import { LessonSelection } from '../../src/features/lessons/LessonSelection.js';
import { buildLessonAvailability } from '../../src/domain/training/progression.js';
import { createMockRepository } from '../../src/platform/mock-repository.js';
import { PROFILE_A_ID } from '../fixtures/contracts/index.js';

const curriculum: Curriculum = {
  version: 'ff-curriculum-v1',
  lessons: [
    { id: 'ff-first', curriculumVersion: 'ff-curriculum-v1', title: 'First', stage: 1, prerequisites: [],
      introducedKeys: ['f'], reviewKeys: [], fingerHints: { f: 'left-index' }, exercisePolicy: 'new-key-drill',
      targetGraphemes: ['f', ' '], correctionPolicy: 'strict', minimumAccuracy: 95, minimumWpm: 10,
      requiredQualifyingPasses: 2, contentSeedPolicy: 'profile-seeded' },
    { id: 'ff-second', curriculumVersion: 'ff-curriculum-v1', title: 'Second', stage: 1, prerequisites: ['ff-first'],
      introducedKeys: ['j'], reviewKeys: ['f'], fingerHints: { j: 'right-index' }, exercisePolicy: 'new-key-drill',
      targetGraphemes: ['f', 'j', ' '], correctionPolicy: 'strict', minimumAccuracy: 95, minimumWpm: 10,
      requiredQualifyingPasses: 2, contentSeedPolicy: 'profile-seeded' },
  ],
};

const catalog: LessonCatalog = {
  curriculum,
  migrations: [],
  entries: curriculum.lessons.map((lesson) => ({
    id: lesson.id, title: lesson.title, stage: lesson.stage, prerequisites: lesson.prerequisites,
    introducedKeys: lesson.introducedKeys, reviewKeys: lesson.reviewKeys,
    exercisePolicy: lesson.exercisePolicy, targetLength: 120,
    newUnits: lesson.introducedKeys, reviewUnits: lesson.reviewKeys,
  })),
};

describe('M12 lesson selection and result UI', () => {
  it('hydrates profile progress and prepares the selected deterministic source', async () => {
    const repository = Object.assign(createMockRepository(), { getLessonProgress: async () => ok([]) });
    const onStart = vi.fn();
    render(<LessonCatalogScreen repository={repository} profileId={PROFILE_A_ID} catalog={catalog}
      profileSeed="profile-a" onStart={onStart} />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Start' }))[0]);
    expect(onStart).toHaveBeenCalledOnce();
    expect(onStart.mock.calls[0][0]).toMatchObject({ definition: { id: 'ff-first' },
      source: { id: 'ff-first', mode: 'lessons', graphemeCount: 120 },
      config: { sourceRef: 'ff-first', targetLength: 120 } });
  });

  it('exposes only unlocked lessons and offers mastered lessons for replay', () => {
    const onSelect = vi.fn();
    const { rerender } = render(<LessonSelection lessons={buildLessonAvailability(curriculum, [])} onSelect={onSelect} />);
    const initialButtons = screen.getAllByRole('button', { name: 'Start' }) as HTMLButtonElement[];
    expect(initialButtons[0].disabled).toBe(false);
    expect(initialButtons[1].disabled).toBe(true);

    const mastered = [{ profileId: PROFILE_A_ID, lessonId: 'ff-first', curriculumVersion: curriculum.version,
      attemptCount: 2, passCount: 2, bestWpm: 20, bestAccuracy: 99, lastAttemptAt: '2026-09-21T08:00:00.000Z',
      masteredAt: '2026-09-21T08:00:00.000Z', qualifyingSessionIds: [
        '61111111-1111-4111-8111-111111111111', '62222222-2222-4222-8222-222222222222',
      ] }];
    rerender(<LessonSelection lessons={buildLessonAvailability(curriculum, mastered)} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: 'Replay' }));
    expect(onSelect).toHaveBeenCalledWith('ff-first');
    expect((screen.getByRole('button', { name: 'Start' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows exact unmet reasons, high-error keys, retry, and the next unlocked lesson', () => {
    const evaluation: LessonEvaluation = { qualifies: false, criteria: [
      { id: 'accuracy', label: 'Accuracy at least 95%', met: false, detail: '90.0% is below 95.0%.' },
      { id: 'speed', label: 'Adjusted WPM at least 10', met: true, detail: '20.0 WPM meets 10.0 WPM.' },
    ] };
    const retry = vi.fn();
    const next = vi.fn();
    render(<LessonResult evaluation={evaluation} highErrorKeys={['f', 'j']}
      nextLessonTitle="D and K" onRetry={retry} onNext={next} />);
    expect(screen.getByText('90.0% is below 95.0%.')).toBeTruthy();
    expect(screen.getByText((_, element) => element?.tagName === 'P'
      && element.textContent?.includes('Keys to review: f, j') === true)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry lesson' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next: D and K' }));
    expect(retry).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledOnce();
  });
});
