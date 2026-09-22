// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { ok } from '../../src/contracts/repository.js';
import { createMockRepository } from '../../src/platform/mock-repository.js';
import { completedSession, profileA } from '../fixtures/contracts/index.js';

let resetCharacterStatsCalls = 0;
const repository = Object.assign(createMockRepository(), {
  initialize: async () => ok(undefined),
  listProfiles: async () => ok([profileA]),
  loadInstallationSettings: async () => ok({ schemaVersion: 1, activeProfileId: profileA.id, lastResolvedTheme: 'light', appBuild: 'test', onboardingComplete: true }),
  loadProfileSettings: async () => ok(profileA.settings),
  saveInstallationSettings: async () => ok(undefined),
  querySessions: async () => ok({ sessions: [completedSession], nextCursor: null }),
  getCharacterStats: async () => ok({ exposures: [{ expected: 'a', attempts: 10, errors: 2 }], mistakes: [{ expected: 'a', attempted: 's', count: 2 }] }),
  resetCharacterStats: async () => { resetCharacterStatsCalls += 1; return ok(undefined); },
});

vi.mock('../../src/platform/factory.js', () => ({ getPlatformAdapter: () => ({ repository, capabilities: {}, target: 'browser', fileAccess: {} }) }));

import { App } from '../../src/app/App.js';

const dictionary = JSON.parse(readFileSync('public/content/dictionaries/ff-english-10k-v1.json', 'utf8'));
const curriculum = JSON.parse(readFileSync('public/content/lessons/ff-curriculum-v1.json', 'utf8'));

describe('saved-session dashboards', () => {
  it('loads the active profile history and analytics from the repository', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes('lessons') ? curriculum : dictionary })));
    render(<App />);
    expect(await screen.findByText(profileA.name)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /History/ }));
    expect(await screen.findByText('54.0 WPM')).toBeTruthy();
    expect(screen.getByText(/95.0%/)).toBeTruthy();
    const day = screen.getByRole('button', { name: /2026-09-18/ });
    expect(day.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(day);
    expect(day.getAttribute('aria-expanded')).toBe('true');
    const sessionDetails = screen.getByRole('region', { name: /2026-09-18/ });
    expect(within(sessionDetails).getByText('Practice')).toBeTruthy();
    expect(within(sessionDetails).getByText('60-second sprint')).toBeTruthy();
    expect(within(sessionDetails).getByText('Active time')).toBeTruthy();
    expect(within(sessionDetails).getByText('15')).toBeTruthy();

    fireEvent.click(day);
    expect(day.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('region', { name: /2026-09-18/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Analytics/ }));
    expect(await screen.findByText('BEST WPM')).toBeTruthy();
    expect(screen.getAllByText('54.0').length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: 'Speed trend' })).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Reset' }));
    expect(screen.getByRole('heading', { name: 'Reset accuracy focus?' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reset statistics' }));
    await waitFor(() => expect(resetCharacterStatsCalls).toBe(1));
    expect(await screen.findByText('No character mistakes recorded yet.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Settings/ }));
    fireEvent.change(screen.getByLabelText('Pace guide benchmark'), { target: { value: 'best' } });
    fireEvent.click(screen.getByRole('button', { name: /Practice/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Start practice/ }));
    expect(screen.getByText('Personal best')).toBeTruthy();
    expect(screen.getByText('54 WPM')).toBeTruthy();
  });
});
