import type { LessonEvaluation } from '../../contracts/training.js';
import { Button } from '../../components/Button.js';

export interface LessonResultProps {
  evaluation: LessonEvaluation;
  highErrorKeys?: readonly string[];
  nextLessonTitle?: string;
  onRetry?(): void;
  onNext?(): void;
}

export function LessonResult({ evaluation, highErrorKeys = [], nextLessonTitle, onRetry, onNext }: LessonResultProps) {
  return <section aria-labelledby="lesson-result-heading">
    <h3 id="lesson-result-heading">{evaluation.qualifies ? 'Qualifying pass' : 'Keep practicing'}</h3>
    <ul className="ff-criteria-list">
      {evaluation.criteria.map((item) => <li key={item.id} data-met={item.met ? 'true' : 'false'}>
        <strong>{item.met ? 'Met' : 'Not met'}: {item.label}</strong>
        <span>{item.detail}</span>
      </li>)}
    </ul>
    {highErrorKeys.length > 0
      ? <p><strong>Keys to review:</strong> {highErrorKeys.join(', ')}</p>
      : <p className="ff-muted">No error-heavy keys in this attempt.</p>}
    <div className="ff-result-actions">
      {onRetry ? <Button onClick={onRetry}>Retry lesson</Button> : null}
      {onNext && nextLessonTitle
        ? <Button variant="primary" onClick={onNext}>Next: {nextLessonTitle}</Button>
        : null}
    </div>
  </section>;
}
