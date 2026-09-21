import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { PreparedPractice } from '../../domain/training/practice.js';
import { KeyboardSoundPlayer, type KeyboardSoundProfile } from '../../engines/audio/keyboardSynth.js';
import type { PracticeResultSummary } from '../../app/practicePersistence.js';
import { CompletionConfetti } from './CompletionConfetti.js';

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
  paceGuideWpm?: number;
  paceGuideLabel?: string;
  profileName?: string | null;
  onComplete?(result: PracticeResultSummary): Promise<boolean>;
  onRestart?(): void;
}

export function PracticeSession({ prepared, onExit, showKeyboard = true, soundEnabled = true, soundProfile = 'thocky', soundVolume = .8, paceGuideWpm = 40, paceGuideLabel = 'Target pace', profileName = null, onComplete, onRestart }: PracticeSessionProps) {
  const [value, setValue] = useState('');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const [blockedAttempt, setBlockedAttempt] = useState<{ expected: string; attempted: string } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const targetRef = useRef<HTMLDivElement>(null);
  const caretRef = useRef<HTMLSpanElement>(null);
  const startedAt = useRef<number | null>(null);
  const finished = useRef(false);
  const previousTypedLength = useRef(0);
  const completionPlayed = useRef(false);
  const suppressReleaseSound = useRef(false);
  const reportedCompletion = useRef(false);
  const startedWallAt = useRef<number | null>(null);
  const attempts = useRef(0);
  const correctAttempts = useRef(0);
  const errorAttempts = useRef(0);
  const accuracyAttempts = useRef(0);
  const accuracyCorrectAttempts = useRef(0);
  const backspaces = useRef(0);
  const exposures = useRef(new Map<string, { attempts: number; errors: number }>());
  const mistakes = useRef(new Map<string, { expected: string; attempted: string; count: number }>());
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
  const accuracy = accuracyAttempts.current ? Math.round(100 * accuracyCorrectAttempts.current / accuracyAttempts.current) : 100;
  const wpm = elapsedMs >= 1_000 ? Math.round(correct / 5 / (elapsedMs / 60_000)) : 0;
  const progressRatio = durationMs !== null ? Math.min(1, elapsedMs / durationMs) : Math.min(1, typed.length / Math.max(1, target.length));
  const paceDelta = wpm - paceGuideWpm;
  const paceState = typed.length === 0 || elapsedMs < 1_000 ? 'warming' : wpm >= paceGuideWpm ? 'ahead' : wpm >= paceGuideWpm * .85 ? 'close' : 'behind';
  const paceStyle = { '--ff-pace-progress': `${Math.max(1, progressRatio * 100)}%` } as CSSProperties;
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

  useEffect(() => {
    if (!done || reportedCompletion.current || startedWallAt.current === null || !onComplete) return;
    reportedCompletion.current = true;
    setSaveState('saving');
    const prefix = target.slice(0, Math.min(typed.length, target.length)).join('');
    const completePrefix = typed.length >= target.length ? prefix : prefix.replace(/\S+$/, '');
    void onComplete({
      startedAt: new Date(startedWallAt.current).toISOString(),
      endedAt: new Date().toISOString(),
      activeMs: elapsedMs,
      attempts: attempts.current,
      correctAttempts: correctAttempts.current,
      errorAttempts: errorAttempts.current,
      backspaces: backspaces.current,
      retainedCorrect: correct,
      retainedErrors: typed.length - correct,
      completedWords: completePrefix.match(/\S+/g)?.length ?? 0,
      exposures: [...exposures.current.entries()].map(([expected, counts]) => ({ expected, ...counts })),
      mistakes: [...mistakes.current.values()],
    }).then((saved) => setSaveState(saved ? 'saved' : 'failed')).catch(() => setSaveState('failed'));
  }, [done, onComplete]);

  useEffect(() => { soundPlayer.current?.setVolume(soundVolume); }, [soundVolume]);

  const acceptInput = (next: string) => {
    if (done) return;
    if (startedAt.current === null && next.length > 0) {
      startedAt.current = performance.now();
      startedWallAt.current = Date.now();
    }
    const nextTyped = graphemes(next);
    let acceptedTyped = typed.slice();
    let attemptedKey: string | null = null;
    let incorrectAttempt = false;
    if (nextTyped.length > typed.length) {
      for (let index = typed.length; index < nextTyped.length; index += 1) {
        const expected = target[index] ?? '';
        const attempted = nextTyped[index];
        const correctAttempt = attempted === expected;
        const isCorrection = blockedAttempt !== null && index === typed.length && correctAttempt;
        attemptedKey = attempted;
        attempts.current += 1;
        if (correctAttempt) correctAttempts.current += 1;
        else errorAttempts.current += 1;
        if (!isCorrection) {
          accuracyAttempts.current += 1;
          if (correctAttempt) accuracyCorrectAttempts.current += 1;
          const exposure = exposures.current.get(expected) ?? { attempts: 0, errors: 0 };
          exposure.attempts += 1;
          if (!correctAttempt) exposure.errors += 1;
          exposures.current.set(expected, exposure);
          if (!correctAttempt) {
            const key = `${expected}\u0000${attempted}`;
            const mistake = mistakes.current.get(key) ?? { expected, attempted, count: 0 };
            mistake.count += 1;
            mistakes.current.set(key, mistake);
          }
        }
        if (!correctAttempt) {
          incorrectAttempt = true;
          setBlockedAttempt({ expected, attempted });
          break;
        }
        acceptedTyped.push(attempted);
        if (isCorrection) setBlockedAttempt(null);
      }
      if (!incorrectAttempt) setBlockedAttempt(null);
    } else if (nextTyped.length < typed.length) {
      acceptedTyped = nextTyped;
      backspaces.current += typed.length - nextTyped.length;
      setBlockedAttempt(null);
    }
    if (soundEnabled && nextTyped.length > typed.length) {
      const incorrect = incorrectAttempt;
      suppressReleaseSound.current = incorrect;
      const player = soundPlayer.current ??= new KeyboardSoundPlayer();
      if (incorrect) void player.playFeedback('mistake', soundVolume);
      else if (attemptedKey !== null) void player.playKey(attemptedKey === ' ' ? 'space' : 'letter', 'down', soundProfile, soundVolume);
    } else if (soundEnabled && nextTyped.length < typed.length) {
      suppressReleaseSound.current = false;
      void (soundPlayer.current ??= new KeyboardSoundPlayer()).playKey('backspace', 'down', soundProfile, soundVolume);
    }
    if (acceptedTyped.length >= target.length && startedAt.current !== null) {
      finished.current = true;
      setElapsedMs(performance.now() - startedAt.current);
    }
    setValue(acceptedTyped.join(''));
  };
  const releaseKey = (key: string) => {
    if (!soundEnabled || !soundPlayer.current || !([...key].length === 1 || key === 'Backspace' || key === 'Enter')) return;
    if (suppressReleaseSound.current) { suppressReleaseSound.current = false; return; }
    const kind = key === 'Backspace' ? 'backspace' : key === ' ' || key === 'Enter' ? 'space' : 'letter';
    void soundPlayer.current.playKey(kind, 'up', soundProfile, soundVolume);
  };
  const restart = () => {
    startedAt.current = null;
    startedWallAt.current = null;
    finished.current = false;
    previousTypedLength.current = 0;
    completionPlayed.current = false;
    reportedCompletion.current = false;
    attempts.current = 0;
    correctAttempts.current = 0;
    errorAttempts.current = 0;
    accuracyAttempts.current = 0;
    accuracyCorrectAttempts.current = 0;
    backspaces.current = 0;
    exposures.current.clear();
    mistakes.current.clear();
    setBlockedAttempt(null);
    setValue('');
    setElapsedMs(0);
    setSaveState('idle');
    if (targetRef.current) targetRef.current.scrollTop = 0;
    window.requestAnimationFrame(() => inputRef.current?.focus());
  };
  const sessionLabel = durationMs !== null ? `${Math.round(durationMs / 1_000)} second sprint` : prepared.sessionConfig.targetLength !== null ? `${target.length} character target` : 'Open practice';
  return <section className="ff-practice-workspace" aria-labelledby="practice-session-heading">
    <CompletionConfetti completedAt={done ? startedWallAt.current : null} />
    <header className="ff-practice-toolbar"><div><span className="ff-eyebrow">Now typing</span><h2 id="practice-session-heading">{prepared.source.title}</h2></div><span className="ff-session-kind">{sessionLabel}</span><button className="ff-button ff-button-quiet" type="button" onClick={onExit}>Exit session</button></header>
    <div className="ff-live-stats"><div><small>TIME</small><strong>{remainingMs === null ? '∞' : `${Math.ceil(remainingMs / 1000)}`}</strong></div><div><small>WPM</small><strong>{wpm}</strong></div><div><small>ACCURACY</small><strong>{accuracy}%</strong></div><div><small>PROGRESS</small><strong>{Math.round(progressRatio * 100)}%</strong></div></div>
    {done ? <section className="ff-finish-panel" role="dialog" aria-labelledby="practice-finish-heading" aria-describedby="practice-finish-copy">
      <span className="ff-finish-icon" aria-hidden="true">✓</span>
      <span className="ff-eyebrow">{finishedByTime ? 'Time’s up' : 'Passage complete'}</span>
      <h3 id="practice-finish-heading">Session complete</h3>
      <p id="practice-finish-copy">Nice work. Here is how this run turned out.</p>
      <div className="ff-result-summary"><div><strong>{wpm}</strong><small>WPM</small></div><div><strong>{accuracy}%</strong><small>Accuracy</small></div><div><strong>{correct}</strong><small>Correct keys</small></div><div><strong>{Math.round(elapsedMs / 1_000)}s</strong><small>Active time</small></div></div>
      <div className="ff-finish-actions"><button className="ff-button" data-variant="primary" type="button" onClick={onRestart ?? restart}>Try again</button><button className="ff-button" type="button" onClick={onExit}>Back to setup</button></div>
      <p className={`ff-save-status${saveState === 'failed' ? ' ff-save-error' : ''}`} role="status">{!profileName ? 'Create or select a profile before practicing to save history.' : saveState === 'saving' ? `Saving to ${profileName}…` : saveState === 'saved' ? `Saved to ${profileName}.` : saveState === 'failed' ? 'The result could not be saved.' : ''}</p>
    </section> : <>
      <div className="ff-pace-surface" data-pace-state={paceState} style={paceStyle}>
        <div className="ff-pace-readout"><span aria-hidden="true" /><span>{paceGuideLabel}</span><strong>{paceGuideWpm} WPM</strong><em>{paceState === 'warming' ? 'Calibrating' : paceDelta >= 0 ? `+${paceDelta} ahead` : `${Math.abs(paceDelta)} behind`}</em></div>
        <div ref={targetRef} className="ff-practice-target" role="textbox" aria-label="Practice text. Start typing." tabIndex={0} onClick={() => inputRef.current?.focus()} onFocus={() => inputRef.current?.focus()}>
          {target.map((char, index) => <span ref={index === typed.length ? caretRef : undefined} key={index} className={index < typed.length ? typed[index] === char ? 'ff-target-correct' : 'ff-target-error' : index === typed.length ? `ff-target-current${blockedAttempt ? ' ff-target-current-error' : ''}` : 'ff-target-upcoming'}>{char}</span>)}
          <textarea ref={inputRef} className="ff-practice-capture" value={value} onChange={(event) => acceptInput(event.target.value)} onKeyUp={(event) => releaseKey(event.key)} onPaste={(event) => event.preventDefault()} spellCheck={false} autoCapitalize="off" autoCorrect="off" aria-label="Typing input" />
        </div>
      </div>
      {showKeyboard ? <div className="ff-keyboard" aria-label="Keyboard preview">{['qwertyuiop', 'asdfghjkl', 'zxcvbnm'].map((row) => <div key={row}>{[...row].map((key) => <span key={key} className={value.endsWith(key) ? 'ff-key ff-key-active' : 'ff-key'}>{key}</span>)}</div>)}</div> : null}
      <p className="ff-session-status" role="status">{blockedAttempt ? `Expected “${blockedAttempt.expected}” — try again` : typed.length ? 'Keep your rhythm' : 'Start typing to begin the timer'}</p>
    </>}
  </section>;
}
