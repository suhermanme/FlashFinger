import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PreparedPractice } from '../../domain/training/practice.js';
import { KeyboardSoundPlayer, type KeyboardSoundProfile } from '../../engines/audio/keyboardSynth.js';

function graphemes(value: string): string[] {
  return Array.from(new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(value), (part) => part.segment);
}

export function scrollPracticeCaretIntoView(container: HTMLElement, caret: HTMLElement, direction: 'forward' | 'backward' = 'forward'): void {
  if (container.clientHeight <= 0) return;
  const lineHeight = Number.parseFloat(getComputedStyle(container).lineHeight) || caret.offsetHeight || 40;
  const viewport = container.getBoundingClientRect();
  const active = caret.getBoundingClientRect();
  const lowerThreshold = viewport.bottom - lineHeight * 1.5;
  const upperThreshold = viewport.top + lineHeight * .5;
  if (direction === 'forward' && active.bottom > lowerThreshold) {
    const stableAnchor = viewport.top + container.clientHeight * .55;
    container.scrollTop = Math.min(container.scrollHeight - container.clientHeight, container.scrollTop + Math.max(lineHeight, active.top - stableAnchor));
  } else if (direction === 'backward' && active.top < upperThreshold && container.scrollTop > 0) {
    const stableAnchor = viewport.top + container.clientHeight * .35;
    container.scrollTop = Math.max(0, container.scrollTop - Math.max(lineHeight, stableAnchor - active.top));
  }
}

export interface PracticeSessionProps {
  prepared: PreparedPractice;
  onExit(): void;
  showKeyboard?: boolean;
  soundEnabled?: boolean;
  soundProfile?: KeyboardSoundProfile;
  soundVolume?: number;
}

export function PracticeSession({ prepared, onExit, showKeyboard = true, soundEnabled = true, soundProfile = 'thocky', soundVolume = .8 }: PracticeSessionProps) {
  const [value, setValue] = useState('');
  const [elapsedMs, setElapsedMs] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const targetRef = useRef<HTMLDivElement>(null);
  const caretRef = useRef<HTMLSpanElement>(null);
  const startedAt = useRef<number | null>(null);
  const finished = useRef(false);
  const previousTypedLength = useRef(0);
  const completionPlayed = useRef(false);
  const suppressReleaseSound = useRef(false);
  const soundPlayer = useRef<KeyboardSoundPlayer | null>(null);
  const text = useMemo(() => Array.from({ length: Math.ceil((prepared.source.graphemeCount ?? 0) / prepared.source.chunkSize) }, (_, index) => prepared.source.chunkAt(index) ?? '').join(''), [prepared]);
  const target = useMemo(() => graphemes(text), [text]);
  const typed = useMemo(() => graphemes(value), [value]);
  const durationMs = prepared.sessionConfig.durationLimitMs;
  const remainingMs = durationMs === null ? null : Math.max(0, durationMs - elapsedMs);
  const finishedByTime = durationMs !== null && remainingMs === 0;
  const finishedByTarget = typed.length >= target.length;
  const done = finishedByTarget || finishedByTime;
  const correct = typed.reduce((total, char, index) => total + Number(char === target[index]), 0);
  const accuracy = typed.length ? Math.round(100 * correct / typed.length) : 100;
  const wpm = elapsedMs >= 1_000 ? Math.round(correct / 5 / (elapsedMs / 60_000)) : 0;
  useEffect(() => {
    inputRef.current?.focus();
    const timer = window.setInterval(() => {
      if (startedAt.current !== null && !finished.current) {
        const elapsed = performance.now() - startedAt.current;
        if (durationMs !== null && elapsed >= durationMs) finished.current = true;
        setElapsedMs(durationMs === null ? elapsed : Math.min(durationMs, elapsed));
      }
    }, 100);
    return () => {
      window.clearInterval(timer);
      void soundPlayer.current?.close();
    };
  }, [durationMs]);
  useLayoutEffect(() => {
    const direction = typed.length < previousTypedLength.current ? 'backward' : 'forward';
    previousTypedLength.current = typed.length;
    const frame = window.requestAnimationFrame(() => {
      if (targetRef.current && caretRef.current) scrollPracticeCaretIntoView(targetRef.current, caretRef.current, direction);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [typed.length]);

  useEffect(() => {
    if (!done || startedAt.current === null || completionPlayed.current) return;
    completionPlayed.current = true;
    if (soundEnabled) void (soundPlayer.current ??= new KeyboardSoundPlayer()).playFeedback('complete', soundVolume);
  }, [done]);

  useEffect(() => { soundPlayer.current?.setVolume(soundVolume); }, [soundVolume]);

  const acceptInput = (next: string) => {
    if (done) return;
    if (startedAt.current === null && next.length > 0) startedAt.current = performance.now();
    const nextTyped = graphemes(next);
    if (soundEnabled && nextTyped.length > typed.length) {
      const index = nextTyped.length - 1;
      const incorrect = nextTyped[index] !== target[index];
      suppressReleaseSound.current = incorrect;
      const player = soundPlayer.current ??= new KeyboardSoundPlayer();
      if (incorrect) void player.playFeedback('mistake', soundVolume);
      else void player.playKey(nextTyped[index] === ' ' ? 'space' : 'letter', 'down', soundProfile, soundVolume);
    } else if (soundEnabled && nextTyped.length < typed.length) {
      suppressReleaseSound.current = false;
      void (soundPlayer.current ??= new KeyboardSoundPlayer()).playKey('backspace', 'down', soundProfile, soundVolume);
    }
    if (nextTyped.length >= target.length && startedAt.current !== null) {
      finished.current = true;
      setElapsedMs(performance.now() - startedAt.current);
    }
    setValue(next);
  };
  const releaseKey = (key: string) => {
    if (!soundEnabled || !soundPlayer.current || !([...key].length === 1 || key === 'Backspace' || key === 'Enter')) return;
    if (suppressReleaseSound.current) { suppressReleaseSound.current = false; return; }
    const kind = key === 'Backspace' ? 'backspace' : key === ' ' || key === 'Enter' ? 'space' : 'letter';
    void soundPlayer.current.playKey(kind, 'up', soundProfile, soundVolume);
  };
  const restart = () => {
    startedAt.current = null;
    finished.current = false;
    previousTypedLength.current = 0;
    completionPlayed.current = false;
    setValue('');
    setElapsedMs(0);
    if (targetRef.current) targetRef.current.scrollTop = 0;
    window.requestAnimationFrame(() => inputRef.current?.focus());
  };
  const sessionLabel = durationMs !== null ? `${Math.round(durationMs / 1_000)} second sprint` : prepared.sessionConfig.targetLength !== null ? `${target.length} character target` : 'Open practice';
  return <section className="ff-practice-workspace" aria-labelledby="practice-session-heading">
    <header className="ff-practice-toolbar"><div><span className="ff-eyebrow">Now typing</span><h2 id="practice-session-heading">{prepared.source.title}</h2></div><span className="ff-session-kind">{sessionLabel}</span><button className="ff-button ff-button-quiet" type="button" onClick={onExit}>Exit session</button></header>
    <div className="ff-live-stats"><div><small>TIME</small><strong>{remainingMs === null ? '∞' : `${Math.ceil(remainingMs / 1000)}`}</strong></div><div><small>WPM</small><strong>{wpm}</strong></div><div><small>ACCURACY</small><strong>{accuracy}%</strong></div><div><small>PROGRESS</small><strong>{Math.min(100, Math.round(100 * typed.length / Math.max(1, target.length)))}%</strong></div></div>
    {done ? <section className="ff-finish-panel" role="dialog" aria-labelledby="practice-finish-heading" aria-describedby="practice-finish-copy">
      <span className="ff-finish-icon" aria-hidden="true">✓</span>
      <span className="ff-eyebrow">{finishedByTime ? 'Time’s up' : 'Passage complete'}</span>
      <h3 id="practice-finish-heading">Session complete</h3>
      <p id="practice-finish-copy">Nice work. Here is how this run turned out.</p>
      <div className="ff-result-summary"><div><strong>{wpm}</strong><small>WPM</small></div><div><strong>{accuracy}%</strong><small>Accuracy</small></div><div><strong>{correct}</strong><small>Correct keys</small></div><div><strong>{Math.round(elapsedMs / 1_000)}s</strong><small>Active time</small></div></div>
      <div className="ff-finish-actions"><button className="ff-button" data-variant="primary" type="button" onClick={restart}>Try again</button><button className="ff-button" type="button" onClick={onExit}>Back to setup</button></div>
    </section> : <>
      <div ref={targetRef} className="ff-practice-target" role="textbox" aria-label="Practice text. Start typing." tabIndex={0} onClick={() => inputRef.current?.focus()} onFocus={() => inputRef.current?.focus()}>
        {target.map((char, index) => <span ref={index === typed.length ? caretRef : undefined} key={index} className={index < typed.length ? typed[index] === char ? 'ff-target-correct' : 'ff-target-error' : index === typed.length ? 'ff-target-current' : 'ff-target-upcoming'}>{char}</span>)}
        <textarea ref={inputRef} className="ff-practice-capture" value={value} onChange={(event) => acceptInput(event.target.value)} onKeyUp={(event) => releaseKey(event.key)} onPaste={(event) => event.preventDefault()} spellCheck={false} autoCapitalize="off" autoCorrect="off" aria-label="Typing input" />
      </div>
      {showKeyboard ? <div className="ff-keyboard" aria-label="Keyboard preview">{['qwertyuiop', 'asdfghjkl', 'zxcvbnm'].map((row) => <div key={row}>{[...row].map((key) => <span key={key} className={value.endsWith(key) ? 'ff-key ff-key-active' : 'ff-key'}>{key}</span>)}</div>)}</div> : null}
      <p className="ff-session-status" role="status">{typed.length ? 'Keep your rhythm' : 'Start typing to begin the timer'}</p>
    </>}
  </section>;
}
