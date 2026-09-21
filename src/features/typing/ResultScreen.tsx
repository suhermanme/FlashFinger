import type { DurableSessionResult } from '../../app/sessionCoordinator.js';
import { Button } from '../../components/Button.js';
import { LessonResult } from '../lessons/LessonResult.js';

export interface ResultScreenProps {
  result: DurableSessionResult;
  saving?: boolean;
  onRetrySave?(): void;
  onDiscardUnsaved?(): void;
  onRetrySession?(): void;
  nextLessonTitle?: string;
  onNextLesson?(): void;
}

function metric(value: number | null, suffix = ''): string {
  return value === null ? '—' : `${value.toFixed(1)}${suffix}`;
}

export function ResultScreen({ result, saving = false, onRetrySave, onDiscardUnsaved, onRetrySession,
  nextLessonTitle, onNextLesson }: ResultScreenProps) {
  const { session } = result;
  return <section className="ff-card" aria-labelledby="result-heading">
    <h2 id="result-heading">{session.status === 'completed' ? 'Session complete' : session.status === 'interrupted' ? 'Interrupted session saved' : 'Session ended'}</h2>
    <dl className="ff-result-metrics">
      <div><dt>Adjusted speed</dt><dd>{metric(session.adjustedWpm, ' WPM')}</dd></div>
      <div><dt>Accuracy</dt><dd>{metric(session.accuracy, '%')}</dd></div>
      <div><dt>Active time</dt><dd>{metric(session.activeMs / 1_000, ' s')}</dd></div>
      <div><dt>Attempts</dt><dd>{session.attempts}</dd></div>
    </dl>
    <p role="status" className={result.saved ? 'ff-muted' : 'ff-save-error'}>
      {saving ? 'Saving result locally…' : result.saved
        ? result.alreadyCommitted ? 'Result was already safely stored.' : 'Result saved locally.'
        : `Result is still in memory and has not been saved${result.error ? `: ${result.error.message}` : '.'}`}
    </p>
    {result.lessonEvaluation ? <LessonResult evaluation={result.lessonEvaluation}
      highErrorKeys={result.highErrorKeys} nextLessonTitle={nextLessonTitle}
      onRetry={onRetrySession} onNext={onNextLesson} /> : null}
    <div className="ff-result-actions">
      {!result.saved && !saving && onRetrySave ? <Button variant="primary" onClick={onRetrySave}>Retry save</Button> : null}
      {!result.saved && !saving && onDiscardUnsaved ? <Button onClick={onDiscardUnsaved}>Discard unsaved result</Button> : null}
      {!result.lessonEvaluation && onRetrySession ? <Button onClick={onRetrySession}>Try again</Button> : null}
    </div>
  </section>;
}
