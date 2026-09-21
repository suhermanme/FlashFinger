// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ThemeController, CANVAS_THEME_TOKENS } from '../../src/app/themeController.js';
import { Button } from '../../src/components/Button.js';
import { Dialog } from '../../src/components/Dialog.js';
import { Navigation } from '../../src/components/Navigation.js';

class MediaQuery {
  private listeners = new Set<() => void>();
  constructor(public matches: boolean) {}
  addEventListener(_type: 'change', listener: () => void) { this.listeners.add(listener); }
  removeEventListener(_type: 'change', listener: () => void) { this.listeners.delete(listener); }
  change(matches: boolean) { this.matches = matches; for (const listener of this.listeners) listener(); }
  count() { return this.listeners.size; }
}

function environment() {
  const dark = new MediaQuery(false);
  const motion = new MediaQuery(false);
  let reads = 0;
  const stored = new Map<string, string>();
  const controller = new ThemeController({
    root: document.documentElement,
    storage: { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => { stored.set(key, value); } },
    matchMedia: (query) => query.includes('color-scheme') ? dark : motion,
    computedStyle: () => {
      reads += 1;
      return { getPropertyValue: (name: string) => `value:${name}` } as CSSStyleDeclaration;
    },
  });
  return { controller, dark, motion, stored, reads: () => reads };
}

function luminance(hex: string): number {
  const rgb = hex.slice(1).match(/../g)!.map((value) => Number.parseInt(value, 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

function contrast(left: string, right: string): number {
  const [bright, dark] = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return (bright + 0.05) / (dark + 0.05);
}

describe('M07 theme controller', () => {
  it('follows system changes, ignores them after explicit selection, and publishes one token read per change', () => {
    const state = environment();
    expect(document.documentElement.dataset.ffTheme).toBe('light');
    state.dark.change(true);
    expect(document.documentElement.dataset.ffTheme).toBe('dark');
    const snapshot = state.controller.applySettings({ themePreference: 'light', motion: 'system' });
    expect(snapshot.resolvedTheme).toBe('light');
    expect(CANVAS_THEME_TOKENS.every((token) => snapshot[token] === `value:${token}`)).toBe(true);
    state.dark.change(false);
    state.dark.change(true);
    expect(document.documentElement.dataset.ffTheme).toBe('light');
    expect(state.stored.get('ff.themeHint')).toBe('light');
    // Explicit light ignores later dark-palette changes without another
    // computed-style token sweep.
    expect(state.reads()).toBe(3);
    state.controller.destroy();
    expect(state.dark.count()).toBe(0);
  });

  it('resolves system reduced motion and permits an explicit full-motion preference', () => {
    const state = environment();
    state.motion.change(true);
    expect(state.controller.getSnapshot().reducedMotion).toBe(true);
    expect(document.documentElement.dataset.ffMotion).toBe('reduced');
    state.controller.applySettings({ themePreference: 'system', motion: 'full' });
    expect(state.controller.getSnapshot().reducedMotion).toBe(false);
    state.controller.destroy();
  });

  it('retains the tiny first-paint hint and has a no-hint fallback', () => {
    const html = readFileSync(path.resolve(__dirname, '../../index.html'), 'utf8');
    expect(html).toContain("localStorage.getItem('ff.themeHint')");
    expect(html).toContain("hint === 'light' || hint === 'dark'");
    expect(html).toContain('hint unavailable: boot still succeeds');
  });
});

describe('M07 accessible shell primitives', () => {
  it('provides landmark navigation, current-page semantics, native controls, and Escape-close behavior', () => {
    let closed = 0;
    render(<>
      <Navigation activeId="practice" items={[{ id: 'practice', label: 'Practice', href: '#practice' }, { id: 'history', label: 'History', href: '#history' }]} />
      <Button variant="primary">Start</Button>
      <Dialog open title="Confirm switch" onClose={() => { closed += 1; }}><p>Unsaved result</p></Dialog>
    </>);
    expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Practice' }).getAttribute('aria-current')).toBe('page');
    screen.getByRole('button', { name: 'Start' }).focus();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Start' }));
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { bubbles: false, cancelable: true }));
    expect(closed).toBe(1);
  });

  it('meets text contrast targets and uses scalable layout units for 200% zoom', () => {
    expect(contrast('#20242a', '#fffaf2')).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#626a73', '#fffaf2')).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#ffffff', '#2563eb')).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#e8e6f0', '#15151d')).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#c7c5d2', '#15151d')).toBeGreaterThanOrEqual(4.5);
    const css = readFileSync(path.resolve(__dirname, '../../src/styles/index.css'), 'utf8');
    expect(css).toContain('max-width: 72rem');
    expect(css).toContain('flex-wrap: wrap');
    expect(css).not.toMatch(/height:\s*\d+px/);
  });
});
