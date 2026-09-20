/**
 * Training source contract and content definitions — DESIGN_SPECIFICATION §5.
 * The typing engine knows none of the curriculum or dictionary UI (§5.1).
 */

import type {
  CorrectionPolicy,
  LessonId,
  PracticeConfig,
  SessionMode,
  SessionRecord,
} from './models';

// ---------------------------------------------------------------------------
// Shared mode contract (§5.1)
// ---------------------------------------------------------------------------

export const TERMINATION_KINDS = [
  'complete-target', // finish when the target grapheme stream ends
  'duration', // timed practice
  'word-target', // finish after N words
  'endless', // explicit finish action
] as const;
export type TerminationKind = (typeof TERMINATION_KINDS)[number];

export type TerminationRule =
  | { kind: 'complete-target' }
  | { kind: 'duration'; durationMs: number }
  | { kind: 'word-target'; wordCount: number }
  | { kind: 'endless' };

export interface EligibilityRules {
  /** Compatibility input disqualifies comparative records (§4.3). */
  disqualifiedByCompatibility: boolean;
  /** Voluntary pauses disqualify timed practice records from bests (§3.2). */
  disqualifiedByPause: boolean;
  /** Sessions shorter than this active time are excluded from trends (§4.3). */
  minimumActiveMs: number;
}

/**
 * A chunked, grapheme-safe text source. Chunks must never split grapheme
 * clusters (§5.4); positions are logical grapheme indices independent of
 * page width.
 */
export interface TrainingSource {
  readonly id: string;
  readonly version: string;
  readonly mode: SessionMode;
  readonly title: string;
  readonly correctionPolicy: CorrectionPolicy;
  readonly termination: TerminationRule;
  readonly eligibility: EligibilityRules;
  /** Total graphemes, or null for endless sources. */
  readonly graphemeCount: number | null;
  /** Chunk size in graphemes; chunks align to grapheme boundaries. */
  readonly chunkSize: number;
  /** Synchronous read of a prepared chunk; null when out of range. */
  chunkAt(chunkIndex: number): string | null;
  /**
   * Asynchronous refill hook (endless modes). Must resolve while the engine
   * still has buffered text; failure pauses active time (§5.3).
   */
  ensureAvailable?(fromChunkIndex: number, toChunkIndex: number): Promise<void>;
  /** Release committed chunks before this chunk index (bounded memory). */
  releaseBefore?(chunkIndex: number): void;
  /** Optional lesson progress evaluation used by results screens. */
  readonly progressEvaluator?: ProgressEvaluator;
}

// ---------------------------------------------------------------------------
// Progress evaluation (§5.2)
// ---------------------------------------------------------------------------

export interface CriterionResult {
  id: string;
  label: string;
  met: boolean;
  /** Exact unmet explanation for result screens (§5.2). */
  detail: string;
}

export interface LessonEvaluation {
  qualifies: boolean;
  criteria: CriterionResult[];
}

export interface ProgressEvaluator {
  lessonId: LessonId;
  /** Pure evaluation of a completed session against lesson gates. */
  evaluate(session: SessionRecord): LessonEvaluation;
}

// ---------------------------------------------------------------------------
// Curriculum (§5.2)
// ---------------------------------------------------------------------------

export const CURRICULUM_STAGES = [1, 2, 3, 4, 5, 6] as const;
export type CurriculumStage = (typeof CURRICULUM_STAGES)[number];

export const EXERCISE_POLICIES = ['new-key-drill', 'mixed-review', 'prose'] as const;
export type ExercisePolicy = (typeof EXERCISE_POLICIES)[number];

export interface LessonDefinition {
  id: LessonId; // stable bundled id (ff- prefixed slug)
  curriculumVersion: string;
  title: string;
  stage: CurriculumStage;
  prerequisites: LessonId[];
  /** Logical QWERTY key labels introduced here (e.g. "d", "k"). */
  introducedKeys: string[];
  /** Already-taught keys mixed into exercises (40% policy). */
  reviewKeys: string[];
  /** Instructional only: key label -> finger name. Never detected (§5.2). */
  fingerHints: Record<string, 'left-pinky' | 'left-ring' | 'left-middle' | 'left-index' | 'right-index' | 'right-middle' | 'right-ring' | 'right-pinky' | 'right-thumb' | 'left-thumb'>;
  exercisePolicy: ExercisePolicy;
  /** Explicit allowed characters including allowed spaces token ' '. */
  targetGraphemes: string[];
  correctionPolicy: CorrectionPolicy;
  minimumAccuracy: number; // attempt accuracy, percent
  minimumWpm: number; // adjusted WPM
  requiredQualifyingPasses: number; // 2 (two-of-three) in v1
  contentSeedPolicy: 'static' | 'profile-seeded';
}

export interface Curriculum {
  version: string;
  lessons: LessonDefinition[];
}

// ---------------------------------------------------------------------------
// Dictionary (§5.3)
// ---------------------------------------------------------------------------

export interface DictionaryEntry {
  /** Stable id within the dictionary version. */
  id: number;
  /** Lowercase spelling. */
  word: string;
  graphemeLength: number;
  tier: 'beginner' | 'intermediate' | 'advanced';
  /** Curated frequency band 1 (most common) .. 9. */
  frequencyBand: number;
  suitableForPunctuation: boolean;
  suitableForCapitalization: boolean;
}

export interface DictionaryManifest {
  version: string;
  license: string;
  licenseRecordPath: string;
  entryCount: number;
  tierCounts: { beginner: number; intermediate: number; advanced: number };
  /** SHA-256 of the canonical dictionary payload (build-validated §5.3). */
  hash: string;
}

/** Practice configuration is part of profile defaults; re-exported here for
 * modules that only import the training contract. */
export type { PracticeConfig };
