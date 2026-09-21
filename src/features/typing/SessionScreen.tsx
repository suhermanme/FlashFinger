import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { SessionCoordinator } from '../../app/sessionCoordinator.js';
import { Button } from '../../components/Button.js';
import type { InputSink } from './inputAdapter.js';
import { ResultScreen } from './ResultScreen.js';
import { TypingSurface, type TypingFeedback } from './TypingSurface.js';

export interface SessionScreenProps {
  coordinator: SessionCoordinator;
  sink?: InputSink;
  feedback?: TypingFeedback;
  onRetrySession?(): void;
  onDiscardUnsaved?(): void;
  nextLessonTitle?: string;
  onNextLesson?(): void;
}

export function SessionScreen({ coordinator, sink, feedback, onRetrySession, onDiscardUnsaved,
  nextLessonTitle, onNextLesson }: SessionScreenProps) {
  const snapshot = useSyncExternalStore(coordinator.subscribe, coordinator.getSnapshot, coordinator.getSnapshot);
  useEffect(() => { void coordinator.prepare(); }, [coordinator]);
  const stableSink = useMemo(() => sink ?? { onCommit: () => undefined }, [sink]);

  if (snapshot.result) {
    return <ResultScreen result={snapshot.result} saving={snapshot.phase === 'finalizing'}
      onRetrySave={() => { void coordinator.retrySave(); }}
      onDiscardUnsaved={onDiscardUnsaved
        ? () => { void coordinator.discardUnsavedResult().then(onDiscardUnsaved); }
        : undefined}
      onRetrySession={onRetrySession} nextLessonTitle={nextLessonTitle} onNextLesson={onNextLesson} />;
  }

  const paused = snapshot.phase === 'paused';
  return <section aria-labelledby="session-heading">
    <div className="ff-session-heading">
      <div><h2 id="session-heading">Typing session</h2><p className="ff-muted">Start typing when ready.</p></div>
      <div className="ff-session-controls">
        {paused
          ? <Button variant="primary" onClick={() => coordinator.resume()}>Resume</Button>
          : <Button disabled={snapshot.phase !== 'running'} onClick={() => coordinator.pause(true)}>Pause</Button>}
        <Button disabled={!['running', 'paused'].includes(snapshot.phase)} onClick={() => { void coordinator.finish('aborted'); }}>Finish</Button>
      </div>
    </div>
    <TypingSurface engine={coordinator} targetText={coordinator.targetText} sink={stableSink} feedback={feedback} />
    <dl className="ff-session-metrics" aria-label="Current session metrics">
      <div><dt>Speed</dt><dd>{snapshot.metrics.adjustedWpm === null ? '—' : `${snapshot.metrics.adjustedWpm.toFixed(1)} WPM`}</dd></div>
      <div><dt>Accuracy</dt><dd>{snapshot.metrics.accuracy === null ? '—' : `${snapshot.metrics.accuracy.toFixed(1)}%`}</dd></div>
      <div><dt>Time</dt><dd>{(snapshot.metrics.activeMs / 1_000).toFixed(1)} s</dd></div>
    </dl>
    {snapshot.phase === 'finalizing' ? <p role="status">Saving result…</p> : null}
    {snapshot.checkpointError ? <p className="ff-save-error" role="status">Checkpoint unavailable: {snapshot.checkpointError.message}</p> : null}
  </section>;
}
