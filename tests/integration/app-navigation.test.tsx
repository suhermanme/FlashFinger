// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../src/app/App.js';

const dictionary = JSON.parse(readFileSync('public/content/dictionaries/ff-english-10k-v1.json', 'utf8'));
const curriculum = JSON.parse(readFileSync('public/content/lessons/ff-curriculum-v1.json', 'utf8'));

describe('desktop application navigation', () => {
  it('opens lessons, history, analytics, settings, and changes theme', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes('lessons') ? curriculum : dictionary })));
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: /Create profile/ }));
    expect(screen.getByRole('heading', { name: 'Profiles' })).toBeTruthy();
    expect(document.getElementById('new-profile-name')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Lessons/ }));
    expect(await screen.findByRole('heading', { name: 'Lessons' })).toBeTruthy();
    expect(screen.getByText('F and J anchors')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /History/ }));
    expect(screen.getByRole('heading', { name: 'History' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Analytics/ }));
    expect(screen.getByRole('heading', { name: 'Analytics' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Settings/ }));
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open settings' })).toBeNull();
    expect((screen.getByRole('checkbox', { name: 'Play typing sounds' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole('radio', { name: /Clicky/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /Thocky/ }));
    expect((screen.getByRole('radio', { name: /Thocky/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.change(screen.getByRole('slider', { name: 'Sound volume' }), { target: { value: '95' } });
    expect(screen.getByText('95%')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Use dark theme' }));
    expect(document.documentElement.dataset.ffTheme).toBe('dark');
    expect(screen.queryByText('browser')).toBeNull();
  });
});
