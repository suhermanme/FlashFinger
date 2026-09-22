// @vitest-environment jsdom

import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { HistoryDashboard } from '../../src/features/history/HistoryDashboard.js';
import { aggregateSessions } from '../../src/domain/metrics/aggregates.js';
import { completedSession } from '../fixtures/contracts/index.js';

describe('history session expansion', () => {
  it('segregates all training types beneath their local calendar day', () => {
    const sessions = [
      completedSession,
      { ...completedSession, id: '31111111-1111-4111-8111-111111111111', endedAt: '2026-09-18T11:00:00.000Z', config: { ...completedSession.config, mode: 'lessons' as const, sourceRef: 'home-row-fj' } },
      { ...completedSession, id: '41111111-1111-4111-8111-111111111111', endedAt: '2026-09-18T12:00:00.000Z', config: { ...completedSession.config, mode: 'custom' as const, sourceRef: 'document-1' } },
    ];
    render(<HistoryDashboard bars={aggregateSessions(sessions)} calendar={[]} sessions={sessions} />);

    const day = screen.getByRole('button', { name: /2026-09-18/ });
    fireEvent.click(day);

    const details = screen.getByRole('region', { name: /2026-09-18/ });
    expect(within(details).getByText('Practice')).toBeTruthy();
    expect(within(details).getByText('Lesson')).toBeTruthy();
    expect(within(details).getByText('Custom text')).toBeTruthy();
    expect(within(details).getAllByRole('listitem')).toHaveLength(3);

    fireEvent.click(day);
    expect(screen.queryByRole('region', { name: /2026-09-18/ })).toBeNull();
  });
});
