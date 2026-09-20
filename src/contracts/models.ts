/**
 * Shared data models — DESIGN_SPECIFICATION §2.1.
 *
 * Conventions (enforced by src/contracts/validation.ts at every
 * storage/import/IPC boundary):
 * - Identifier aliases are UUID v4 strings (stable bundled lesson IDs are the
 *   exception and use `ff-` prefixed slugs).
 * - `Instant` is an ISO-8601 UTC string; `DateString` is `YYYY-MM-DD`.
 * - Serialized records contain no Date objects, functions, `undefined`
 *   fields, or class instances.
 * - Enumerated fields reject unknown values unless handled by a version
 *   migration.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export type ProfileId = string;
export type SessionId = string;
export type LessonId = string;
export type DocumentId = string;
export type Instant = string; // ISO-8601 UTC
export type DateString = string; // YYYY-MM-DD (calendar date in a given zone)
export type DurationMs = number; // nonnegative finite
export type Revision = number; // nonnegative safe integer

export type Uuid = string;

// ---------------------------------------------------------------------------
// Enums (whitelisted by validation)
// ---------------------------------------------------------------------------

export const THEME_PREFERENCES = ['light', 'dark', 'system'] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

export const RESOLVED_THEMES = ['light', 'dark'] as const;
export type ResolvedTheme = (typeof RESOLVED_THEMES)[number];

export const MOTION_PREFERENCES = ['full', 'reduced', 'system'] as const;
export type MotionPreference = (typeof MOTION_PREFERENCES)[number];

export const CORRECTION_POLICIES = ['strict', 'advance'] as const;
export type CorrectionPolicy = (typeof CORRECTION_POLICIES)[number];

export const SESSION_MODES = ['lessons', 'practice', 'custom'] as const;
export type SessionMode = (typeof SESSION_MODES)[number];

export const SESSION_STATUSES = ['completed', 'aborted', 'interrupted'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const PRACTICE_TIERS = ['beginner', 'intermediate', 'advanced', 'mixed'] as const;
export type PracticeTier = (typeof PRACTICE_TIERS)[number];

/** Named whitespace tokens used in mistake/exposure buckets (§2.1, §4.5). */
export const WHITESPACE_TOKENS = ['space', 'newline', 'tab'] as const;
export type WhitespaceToken = (typeof WHITESPACE_TOKENS)[number];

/** A single typed unit inside buckets: one grapheme or a named whitespace token. */
export type GraphemeToken = string; // length-1..cluster grapheme, or a WHITESPACE_TOKENS member

// ---------------------------------------------------------------------------
// Profiles and settings
// ---------------------------------------------------------------------------

/** Termination choice for practice (§5.3) — exactly one active rule. */
export type PracticeTermination =
  | { kind: 'timed'; seconds: 15 | 30 | 60 | 120 }
  | { kind: 'words'; count: 25 | 50 | 100 }
  | { kind: 'endless' };

export interface PracticeConfig {
  /** Target pool tier (§5.3 disjoint pools). */
  tier: PracticeTier;
  termination: PracticeTermination;
  punctuation: boolean;
  capitalization: boolean;
  /** Seeded generation state (§5.1 explicit seed/state). */
  seed: string;
  correctionPolicy: CorrectionPolicy;
  /** Optional explicit key filter (mistake focus); never hidden difficulty. */
  keyFilter: string | null;
  configVersion: Revision;
}

export interface ProfileSettings {
  themePreference: ThemePreference;
  /** Sound pack id from public/content/sound-packs.json. */
  soundProfileId: string;
  /** 0..1 linear gain. */
  volume: number;
  muted: boolean;
  motion: MotionPreference;
  /** 16..40 px typing font size. */
  fontSizePx: number;
  /** Keyboard layout id, e.g. 'us-qwerty' (initial lesson layout). */
  keyboardLayout: string;
  showKeyboard: boolean;
  practiceDefaults: PracticeConfig;
}

export interface Profile {
  id: ProfileId;
  /** 1–40 graphemes. */
  name: string;
  /** Stable token selecting a local avatar glyph; never user-supplied markup. */
  avatarToken: string;
  createdAt: Instant;
  updatedAt: Instant;
  /** IANA timezone name used for calendar attribution (§4.4). */
  analyticsZone: string;
  settings: ProfileSettings;
  revision: Revision;
}

/** Installation-level, not shared across profile exports unless selected. */
export interface InstallationSettings {
  schemaVersion: number;
  activeProfileId: ProfileId | null;
  lastResolvedTheme: ResolvedTheme;
  appBuild: string;
  onboardingComplete: boolean;
}

// ---------------------------------------------------------------------------
// Sessions and metrics
// ---------------------------------------------------------------------------

export interface SessionConfig {
  mode: SessionMode;
  correctionPolicy: CorrectionPolicy;
  /** Timed termination, or null. */
  durationLimitMs: DurationMs | null;
  /** Target grapheme/word length for the mode, or null (endless). */
  targetLength: number | null;
  /** Source identity: lessonId, dictionary tier manifest id, or document id/hash. */
  sourceRef: string;
  /** Content version of the generating pack (curriculum/dictionary/document). */
  contentVersion: string;
  metricVersion: number;
  /** Physical layout id used for illustration only (§3.2). */
  layout: string;
  /**
   * IME / non-Latin compatibility session marker (§3.2). Compatibility
   * sessions are excluded from comparative speed trends (§4.3).
   */
  compatibilityInput: boolean;
  /** Held-key repeat policy recorded in session config (§3.2). Fixed in v1. */
  heldKeyRepeat: 'ignored';
}

export interface SessionRecord {
  id: SessionId; // UUID — also the commit idempotency key (§2.3)
  profileId: ProfileId;
  config: SessionConfig;
  startedAt: Instant;
  endedAt: Instant;
  /** Profile analytics zone captured at session start (§4.4). */
  analyticsZone: string;
  status: SessionStatus;
  /** Monotonic active time; wall time labels records only (§3.2). */
  activeMs: DurationMs;
  attempts: number;
  correctAttempts: number;
  errorAttempts: number;
  backspaces: number;
  /** Correct characters currently retained in the target buffer. */
  retainedCorrect: number;
  /** Incorrect characters currently retained in the target buffer. */
  retainedErrors: number;
  completedWords: number;
  /** Null when denominator is zero (§4.1); never NaN. */
  grossCpm: number | null;
  adjustedWpm: number | null;
  accuracy: number | null;
  /** Eligibility for personal-best/comparative records (§4.3). */
  eligibleForBest: boolean;
  /** Seeded generation state, when the mode used one. */
  seed: string | null;
}

export interface MetricSample {
  /** Active elapsed ms at sample boundary. */
  activeElapsedMs: DurationMs;
  /** Rolling window length in ms the rates were computed over. */
  windowMs: DurationMs;
  attempts: number;
  correctAttempts: number;
  grossCpm: number | null;
  /** Rolling correct-attempt WPM (§4.1). */
  adjustedWpm: number | null;
  accuracy: number | null;
}

export interface SessionSeries {
  sessionId: SessionId;
  /** Durable sample period; 1000 ms default (§2.1). */
  samplePeriodMs: number;
  samples: MetricSample[];
}

export interface SessionDaySlice {
  sessionId: SessionId;
  profileId: ProfileId;
  day: DateString;
  zone: string;
  activeMs: DurationMs;
  attempts: number;
  correctAttempts: number;
  errorAttempts: number;
  completedWords: number;
  /** Eligibility determined for the whole session first (§4.4). */
  eligibleActiveMs: DurationMs;
  eligibleRetainedCorrect: number;
}

export interface MistakeBucket {
  profileId: ProfileId;
  sessionId: SessionId;
  /** Expected grapheme or named whitespace token. */
  expected: GraphemeToken;
  /** Attempted grapheme or named token. No raw custom-text sequence (§2.1). */
  attempted: GraphemeToken;
  count: number;
}

export interface CharacterExposure {
  profileId: ProfileId;
  sessionId: SessionId;
  /** Expected token; includes repeated attempts (§2.1). */
  expected: GraphemeToken;
  attempts: number;
  errors: number;
}

export interface LessonProgress {
  profileId: ProfileId;
  lessonId: LessonId;
  curriculumVersion: string;
  attemptCount: number;
  passCount: number;
  bestWpm: number | null;
  bestAccuracy: number | null;
  lastAttemptAt: Instant | null;
  masteredAt: Instant | null;
  /** Idempotency guard: duplicate save cannot award twice (§2.1). */
  qualifyingSessionIds: SessionId[];
}

export interface DailyAggregate {
  profileId: ProfileId;
  day: DateString;
  zone: string;
  metricVersion: number;
  activeMs: DurationMs;
  attempts: number;
  correctAttempts: number;
  errorAttempts: number;
  completedWords: number;
  /** Activity vs comparable performance are separated (§2.1). */
  eligibleActiveMs: DurationMs;
  eligibleRetainedCorrect: number;
  eligibleSessionCount: number;
  bestWpm: number | null;
  revision: Revision;
}

// ---------------------------------------------------------------------------
// Custom documents
// ---------------------------------------------------------------------------

export interface CustomDocument {
  id: DocumentId;
  profileId: ProfileId;
  title: string;
  createdAt: Instant;
  /** Normalization policy version (§5.4). */
  normalizationVersion: number;
  /** Content hash (opaque, for change detection / history reference). */
  hash: string;
  graphemeCount: number;
  byteLength: number;
  chunkCount: number;
  /** Retention is opt-in; default is session-only memory (§2.1, §5.4). */
  retained: boolean;
}

export interface DocumentChunk {
  documentId: DocumentId;
  chunkIndex: number;
  /** Grapheme index of the first character in this chunk. */
  startGrapheme: number;
  text: string;
}

// ---------------------------------------------------------------------------
// Checkpoints (§2.1, §2.3) — interrupted-run detection, not silent resume
// ---------------------------------------------------------------------------

export interface CheckpointCounts {
  attempts: number;
  correctAttempts: number;
  errorAttempts: number;
  backspaces: number;
  retainedCorrect: number;
}

export interface CheckpointEdit {
  sequence: number;
  /** 'insert' | 'delete' */
  kind: 'insert' | 'delete';
  /** Grapheme position in the target at edit time. */
  position: number;
  grapheme: string;
  correct: boolean;
}

export interface ActiveCheckpoint {
  sessionId: SessionId;
  profileId: ProfileId;
  config: SessionConfig;
  checkpointAt: Instant;
  /** Last engine sequence number included in this snapshot. */
  lastSequence: number;
  activeMs: DurationMs;
  counts: CheckpointCounts;
  /** Target cursor position (grapheme index). */
  textCursor: number;
  /** Mode generation state (e.g. PRNG state), opaque to storage. */
  generationState: string | null;
  /** Bounded recent-edit ledger for display recovery. */
  cappedRecentEdits: CheckpointEdit[];
}

// ---------------------------------------------------------------------------
// Derived read model (§2.1) — never embedded into Profile
// ---------------------------------------------------------------------------

export interface ProfileSummary {
  profileId: ProfileId;
  lifetimeActiveMs: DurationMs;
  completedSessions: number;
  /** Historical adjusted WPM series (day-weighted, eligible sessions). */
  wpmSeries: { day: DateString; adjustedWpm: number }[];
  /** Duration-weighted attempt accuracy over eligible sessions. */
  weightedAccuracy: number | null;
  completedLessonCount: number;
  /** Aggregated exposure/error totals per expected token. */
  exposures: Record<string, { attempts: number; errors: number }>;
}

// ---------------------------------------------------------------------------
// Backup envelope (§2.1, §7 M16)
// ---------------------------------------------------------------------------

export interface BackupPayloads {
  sessions: SessionRecord[];
  sessionSeries: SessionSeries[];
  daySlices: SessionDaySlice[];
  mistakes: MistakeBucket[];
  exposures: CharacterExposure[];
  lessonProgress: LessonProgress[];
  dailyAggregates: DailyAggregate[];
  /** Excluded unless selected at export time (§2.3). */
  documents: { document: CustomDocument; chunks: DocumentChunk[] }[];
}

export interface BackupEnvelope {
  formatVersion: number;
  schemaVersion: number;
  exportedAt: Instant;
  /** App build string for forensics only; never used for gating downgrades. */
  appBuild: string;
  profiles: Profile[];
  payloads: BackupPayloads;
  contentVersions: Record<string, string>;
  /** SHA-256 over canonical JSON of everything above `checksum` (§M16). */
  checksum: string;
}
