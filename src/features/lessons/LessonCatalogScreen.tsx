import { useEffect, useState } from 'react';
import type { ProfileId, SessionConfig } from '../../contracts/models.js';
import type { Repository } from '../../contracts/repository.js';
import type { LessonDefinition, TrainingSource } from '../../contracts/training.js';
import {
  createLessonSessionConfig,
  createLessonSource,
  type LessonCatalog,
} from '../../domain/training/lessons.js';
import { buildLessonAvailability, type LessonAvailability } from '../../domain/training/progression.js';
import { LessonSelection } from './LessonSelection.js';

export interface PreparedLesson {
  definition: LessonDefinition;
  source: TrainingSource;
  config: SessionConfig;
}

export interface LessonCatalogScreenProps {
  repository: Repository;
  profileId: ProfileId;
  catalog: LessonCatalog;
  profileSeed: string;
  onStart(prepared: PreparedLesson): void;
}

export function LessonCatalogScreen({ repository, profileId, catalog, profileSeed, onStart }: LessonCatalogScreenProps) {
  const [lessons, setLessons] = useState<LessonAvailability[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    setLessons(null);
    setError(null);
    void repository.getLessonProgress(profileId, catalog.curriculum.version).then((result) => {
      if (!current) return;
      if (!result.ok) { setError(result.error.message); return; }
      setLessons(buildLessonAvailability(catalog.curriculum, result.value));
    });
    return () => { current = false; };
  }, [catalog, profileId, repository]);

  if (error) return <section className="ff-card" role="alert"><h2>Lessons unavailable</h2><p>{error}</p></section>;
  if (!lessons) return <p role="status">Loading lessons…</p>;
  return <LessonSelection lessons={lessons} onSelect={(lessonId) => {
    const source = createLessonSource(catalog, lessonId, profileSeed);
    const definition = catalog.curriculum.lessons.find((item) => item.id === lessonId);
    if (!definition) return;
    onStart({ definition, source, config: createLessonSessionConfig(source) });
  }} />;
}
