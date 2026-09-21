// @vitest-environment jsdom

import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TypingEngine } from '../../src/domain/typing/engine.js';
import { InputAdapter, type BeforeInputLike, type InputCommit, type KeyDownLike } from '../../src/features/typing/inputAdapter.js';
import { layoutText, mountedWindow, MAX_MOUNTED_GRAPHEMES } from '../../src/engines/visual/layout.js';
import { TextRenderer } from '../../src/engines/visual/textRenderer.js';
import { TypingSurface } from '../../src/features/typing/TypingSurface.js';

function engine(targetText = 'abc') {
  const value = new TypingEngine({
    targetText,
    correctionPolicy: 'advance',
    termination: { kind: 'complete-target' },
    eligibility: { disqualifiedByCompatibility: false, disqualifiedByPause: false, minimumActiveMs: 15_000 },
    generationState: null,
    baseNowMs: 0,
  });
  value.transitionToPreparing();
  value.transitionToReady();
  return value;
}

function before(inputType: string, data: string | null = null) {
  let prevented = false;
  const event: BeforeInputLike = { inputType, data, preventDefault: () => { prevented = true; } };
  return { event, prevented: () => prevented };
}

function key(overrides: Partial<KeyDownLike> = {}): KeyDownLike & { prevented: () => boolean } {
  let didPrevent = false;
  return {
    key: 'a', code: 'KeyA', repeat: false, ctrlKey: false, altKey: false, metaKey: false,
    preventDefault: () => { didPrevent = true; }, prevented: () => didPrevent, ...overrides,
  };
}

describe('M08 native input normalization', () => {
  it('scores committed beforeinput once and uses keydown only for physical feedback', () => {
    const value = engine();
    const commits: InputCommit[] = [];
    const physical: string[] = [];
    const adapter = new InputAdapter(value, { onCommit: (commit) => commits.push(commit), onPhysicalKey: (code) => physical.push(code) });
    adapter.handleKeyDown(key());
    expect(value.takeSnapshot().attempts).toBe(0);
    const input = before('insertText', 'a');
    adapter.handleBeforeInput(input.event);
    expect(input.prevented()).toBe(true);
    expect(value.takeSnapshot()).toMatchObject({ attempts: 1, correctAttempts: 1, textCursor: 1 });
    expect(commits).toHaveLength(1);
    expect(physical).toEqual(['KeyA']);
  });

  it('blocks paste, drop/replacement, shortcuts, forward delete, multi-character ordinary input, and held repeats', () => {
    const value = engine('abcdef');
    const commits: InputCommit[] = [];
    const adapter = new InputAdapter(value, { onCommit: (commit) => commits.push(commit) });
    for (const type of ['insertFromPaste', 'insertFromDrop', 'insertReplacementText', 'deleteContentForward']) {
      const input = before(type, 'abc'); adapter.handleBeforeInput(input.event); expect(input.prevented()).toBe(true);
    }
    const shortcut = key({ key: 'c', code: 'KeyC', ctrlKey: true });
    adapter.handleKeyDown(shortcut);
    expect(shortcut.prevented()).toBe(false);
    adapter.handleBeforeInput(before('insertText', 'ab').event);
    adapter.handleKeyDown(key({ repeat: true }));
    adapter.handleBeforeInput(before('insertText', 'a').event);
    expect(value.takeSnapshot().attempts).toBe(0);
    expect(commits).toHaveLength(0);
  });

  it('processes an IME batch once at composition commit and emits one commit notification', () => {
    const value = engine('你好');
    const commits: InputCommit[] = [];
    const adapter = new InputAdapter(value, { onCommit: (commit) => commits.push(commit) });
    adapter.handleCompositionStart();
    const composing = before('insertCompositionText', '你');
    adapter.handleBeforeInput(composing.event);
    expect(composing.prevented()).toBe(false);
    adapter.handleCompositionEnd('你好');
    adapter.handleBeforeInput(before('insertText', '你好').event);
    expect(value.takeSnapshot()).toMatchObject({ attempts: 2, correctAttempts: 2, textCursor: 2 });
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({ kind: 'composition', graphemes: ['你', '好'] });
  });

  it('suppresses only a matching composition echo and keeps the next ordinary character', () => {
    const value = engine('你a');
    const adapter = new InputAdapter(value, { onCommit: () => undefined });
    adapter.handleCompositionStart();
    adapter.handleCompositionEnd('你');
    adapter.handleBeforeInput(before('insertText', 'a').event);
    expect(value.takeSnapshot()).toMatchObject({ attempts: 2, correctAttempts: 2, textCursor: 2 });
  });

  it('auto-pauses a running engine on focus loss and rate-limits repeat backspace', () => {
    const value = engine('abc');
    let now = 0;
    const commits: InputCommit[] = [];
    const adapter = new InputAdapter(value, { onCommit: (commit) => commits.push(commit) }, () => now);
    adapter.handleBeforeInput(before('insertText', 'a').event);
    adapter.handleBeforeInput(before('deleteContentBackward').event);
    now = 10;
    adapter.handleBeforeInput(before('deleteContentBackward').event);
    expect(commits.filter((item) => item.kind === 'delete')).toHaveLength(1);
    adapter.pauseForFocusLoss('blur');
    expect(value.getState()).toBe('paused');
  });
});

describe('M08 bounded layout and imperative renderer', () => {
  it('lays out long lines and Unicode by grapheme and mounts at most five bounded lines', () => {
    const text = `${'word '.repeat(100)}👩‍💻e\u0301🇮🇩\n${'x'.repeat(3_000)}`;
    const layout = layoutText(text, 160, () => 16, 32);
    expect(layout.graphemes).toContain('👩‍💻');
    expect(layout.graphemes).toContain('é');
    expect(layout.graphemes).toContain('🇮🇩');
    expect(layout.lines.length).toBeGreaterThan(100);
    const range = mountedWindow(layout, 2_500);
    expect(range.end - range.start).toBeLessThanOrEqual(MAX_MOUNTED_GRAPHEMES);
    expect(range.lastLine - range.firstLine + 1).toBeLessThanOrEqual(5);
  });

  it('updates character/caret state without layout reads and recomputes only on explicit resize', () => {
    const root = document.createElement('div');
    const caret = document.createElement('div');
    root.getBoundingClientRect = vi.fn(() => { throw new Error('layout read in hot path'); });
    const renderer = new TextRenderer({ root, caret, text: 'a'.repeat(300), width: 320, measure: () => 16 });
    const initialLines = renderer.getLayout().lines.length;
    renderer.apply([{ kind: 'accepted', grapheme: 'a', correct: true, position: 0 }, { kind: 'progress', textCursor: 1, activeElapsedMs: 0 }]);
    expect(root.querySelector('[data-index="0"]')?.getAttribute('data-state')).toBe('correct');
    expect(caret.style.transform).toContain('translate3d');
    expect(root.getBoundingClientRect).not.toHaveBeenCalled();
    renderer.relayout(160);
    expect(renderer.getLayout().lines.length).toBeGreaterThan(initialLines);
    expect(renderer.mountedCount).toBeLessThanOrEqual(MAX_MOUNTED_GRAPHEMES);
  });

  it('preserves correctness state when the mounted line window advances', () => {
    const root = document.createElement('div');
    const caret = document.createElement('div');
    const renderer = new TextRenderer({ root, caret, text: 'a'.repeat(80), width: 16, measure: () => 16, lineHeight: 20 });
    renderer.apply([{ kind: 'accepted', grapheme: 'a', correct: true, position: 4 }, { kind: 'progress', textCursor: 5, activeElapsedMs: 0 }]);
    renderer.apply([{ kind: 'progress', textCursor: 20, activeElapsedMs: 0 }]);
    renderer.apply([{ kind: 'progress', textCursor: 5, activeElapsedMs: 0 }]);
    expect(root.querySelector('[data-index="4"]')?.getAttribute('data-state')).toBe('correct');
  });

  it('enforces the 512-grapheme correction boundary', () => {
    const value = engine('a'.repeat(600));
    for (let index = 0; index < 600; index += 1) value.processCommand({ kind: 'character', grapheme: 'a' });
    for (let index = 0; index < 512; index += 1) {
      expect(value.processCommand({ kind: 'delete' }).some((delta) => delta.kind === 'corrected')).toBe(true);
    }
    expect(value.processCommand({ kind: 'delete' })).toEqual([{ kind: 'rejected', reason: 'not-editable' }]);
  });

  it('does not issue a React commit for each accepted character', () => {
    let renders = 0;
    const value = engine('a'.repeat(300));
    const commits: InputCommit[] = [];
    function Probe() { renders += 1; return <TypingSurface engine={value} targetText={'a'.repeat(300)} sink={{ onCommit: (commit) => commits.push(commit) }} />; }
    const view = render(<Probe />);
    expect(view.getByRole('textbox', { name: 'Typing input' })).toBeTruthy();
    const adapter = new InputAdapter(value, { onCommit: (commit) => commits.push(commit) });
    for (let index = 0; index < 100; index += 1) adapter.handleBeforeInput(before('insertText', 'a').event);
    expect(renders).toBe(1);
    expect(value.takeSnapshot().attempts).toBe(100);
  });
});
