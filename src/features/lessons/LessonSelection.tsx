import { Button } from '../../components/Button.js';
import type { LessonAvailability } from '../../domain/training/progression.js';

export interface LessonSelectionProps {
  lessons: readonly LessonAvailability[];
  onSelect(lessonId: string): void;
}

export function LessonSelection({ lessons, onSelect }: LessonSelectionProps) {
  const stages = [...new Set(lessons.map((item) => item.definition.stage))];
  return <section aria-labelledby="lesson-selection-heading">
    <h2 id="lesson-selection-heading">Lessons</h2>
    <p className="ff-muted">Master two of your latest three completed attempts to unlock the next lesson.</p>
    {stages.map((stage) => <section key={stage} className="ff-card" aria-labelledby={`lesson-stage-${stage}`}>
      <h3 id={`lesson-stage-${stage}`}>Stage {stage}</h3>
      <ol className="ff-lesson-list">
        {lessons.filter((item) => item.definition.stage === stage).map((item) => <li key={item.definition.id}>
          <div>
            <strong>{item.definition.title}</strong>{' '}
            <span className="ff-status">{item.mastered ? 'Mastered' : item.unlocked ? 'Available' : 'Locked'}</span>
            <p className="ff-muted">{item.definition.minimumAccuracy}% accuracy · {item.definition.minimumWpm} WPM</p>
          </div>
          <Button disabled={!item.unlocked} onClick={() => onSelect(item.definition.id)}>
            {item.mastered ? 'Replay' : 'Start'}
          </Button>
        </li>)}
      </ol>
    </section>)}
  </section>;
}
