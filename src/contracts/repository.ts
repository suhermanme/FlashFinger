/**
 * Repository contract — DESIGN_SPECIFICATION §2.2.
 *
 * One contract consumed identically by browser (IndexedDB) and desktop
 * (main-process journal/snapshot) implementations. Every operation returns a
 * typed Result (never a bare throw) so error semantics cross the IPC boundary.
 */

import type {
  ActiveCheckpoint,
  BackupEnvelope,
  CharacterExposure,
  CustomDocument,
  DailyAggregate,
  DocumentChunk,
  DocumentId,
  InstallationSettings,
  Instant,
  LessonId,
  LessonProgress,
  MistakeBucket,
  Profile,
  ProfileId,
  ProfileSettings,
  SessionDaySlice,
  SessionId,
  SessionMode,
  SessionRecord,
  SessionSeries,
} from './models';

// ---------------------------------------------------------------------------
// Results and errors
// ---------------------------------------------------------------------------

export const REPOSITORY_ERROR_CODES = [
  'quota',
  'permission',
  'corrupt',
  'conflict',
  'unavailable',
  'version-too-new',
  'not-found',
  'invalid',
  'storage-denied',
  'unsupported',
] as const;
export type RepositoryErrorCode = (typeof REPOSITORY_ERROR_CODES)[number];

export interface RepositoryError {
  code: RepositoryErrorCode;
  message: string;
  retryable: boolean;
  /** Safe for logging only; never user-visible markup. */
  detail?: string;
}

export type RepositoryResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: RepositoryError };

export function ok<T>(value: T): RepositoryResult<T> {
  return { ok: true, value };
}

export function err<T>(error: RepositoryError): RepositoryResult<T> {
  return { ok: false, error };
}

/** App-layer convenience: throws RepositoryFailure when not ok. */
export class RepositoryFailure extends Error {
  constructor(public readonly repositoryError: RepositoryError) {
    super(`${repositoryError.code}: ${repositoryError.message}`);
    this.name = 'RepositoryFailure';
  }
}

export function expect<T>(result: RepositoryResult<T>): T {
  if (result.ok) return result.value;
  throw new RepositoryFailure(result.error);
}

// ---------------------------------------------------------------------------
// Query and commit shapes
// ---------------------------------------------------------------------------

export interface SessionQuery {
  profileId: ProfileId;
  mode?: SessionMode;
  /** Inclusive lower bound / exclusive upper bound on endedAt (ISO). */
  from?: Instant;
  to?: Instant;
  includeIneligible?: boolean;
  /** Page size cap enforced at 200. */
  limit: number;
  /** Opaque cursor from a previous page. */
  cursor?: string | null;
}

export interface SessionPage {
  sessions: SessionRecord[];
  nextCursor: string | null;
}

/**
 * A finalized session plus every derived mutation, committed atomically in a
 * single logical transaction (§2.2). Idempotency key: session.id (§2.3).
 * Aggregate rows are fully replaced values merged by the domain layer.
 */
export interface SessionCommit {
  session: SessionRecord;
  series?: SessionSeries;
  daySlices: SessionDaySlice[];
  mistakes: MistakeBucket[];
  exposures: CharacterExposure[];
  /** Full replacement rows keyed by [profileId, curriculumVersion, lessonId]. */
  lessonProgress?: LessonProgress[];
  /** Full replacement rows keyed by [profileId, zone, day, metricVersion]. */
  aggregateChanges?: DailyAggregate[];
  /** Character-stat totals are rebuildable; repositories update them in-commit. */
  updateProfileCharacterStats?: boolean;
  /** Checkpoint removed as part of the same transaction when provided. */
  removeCheckpointId?: SessionId;
}

export interface CommitOutcome {
  /** True when this call was a duplicate of an already-stored session. */
  alreadyCommitted: boolean;
  sessionId: SessionId;
}

export interface CharacterStatTotals {
  exposures: { expected: string; attempts: number; errors: number }[];
  mistakes: { expected: string; attempted: string; count: number }[];
}

export interface DocumentWrite {
  document: CustomDocument;
  chunks: DocumentChunk[];
}

export interface ImportOptions {
  /** v1 imports always create fresh profile IDs; this names collision policy. */
  onProfileNameConflict: 'duplicate-label' | 'skip';
  includeDocuments: boolean;
}

export interface ImportOutcome {
  importedProfiles: { oldProfileId: ProfileId; newProfileId: ProfileId }[];
  sessionsImported: number;
  skipped: string[];
}

export interface StorageStatus {
  /** Backend is usable for durable writes. */
  available: boolean;
  /** PERSISTED storage granted (browser) or n/a true on desktop. */
  persisted: boolean;
  quotaBytes: number | null;
  usageBytes: number | null;
  /** Human-readable mode: 'durable' | 'temporary' (private mode / denied). */
  mode: 'durable' | 'temporary';
}

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

export interface Repository {
  // lifecycle -------------------------------------------------------------
  initialize(): Promise<RepositoryResult<void>>;
  schemaVersion(): Promise<RepositoryResult<number>>;
  storageStatus(): Promise<RepositoryResult<StorageStatus>>;

  // profiles --------------------------------------------------------------
  listProfiles(): Promise<RepositoryResult<Profile[]>>;
  createProfile(input: {
    name: string;
    avatarToken: string;
    analyticsZone: string;
    settings: ProfileSettings;
  }): Promise<RepositoryResult<Profile>>;
  /** Revision-checked update; stale revision yields `conflict`. */
  updateProfile(profile: Profile): Promise<RepositoryResult<Profile>>;
  /** Cascades through all owned records atomically (§2.3). */
  deleteProfile(profileId: ProfileId): Promise<RepositoryResult<void>>;

  // settings --------------------------------------------------------------
  loadProfileSettings(profileId: ProfileId): Promise<RepositoryResult<ProfileSettings>>;
  saveProfileSettings(
    profileId: ProfileId,
    settings: ProfileSettings,
  ): Promise<RepositoryResult<void>>;
  loadInstallationSettings(): Promise<RepositoryResult<InstallationSettings>>;
  saveInstallationSettings(settings: InstallationSettings): Promise<RepositoryResult<void>>;

  // sessions --------------------------------------------------------------
  querySessions(query: SessionQuery): Promise<RepositoryResult<SessionPage>>;
  getSession(sessionId: SessionId): Promise<RepositoryResult<SessionRecord>>;
  /** Atomic session + effects; duplicate commits return the existing result. */
  commitSession(commit: SessionCommit): Promise<RepositoryResult<CommitOutcome>>;
  getSessionSeries(sessionId: SessionId): Promise<RepositoryResult<SessionSeries | null>>;

  // analytics -------------------------------------------------------------
  getLessonProgress(
    profileId: ProfileId,
    curriculumVersion: string,
  ): Promise<RepositoryResult<LessonProgress[]>>;
  getDailyAggregates(
    profileId: ProfileId,
    from: string, // DateString
    to: string,
  ): Promise<RepositoryResult<DailyAggregate[]>>;
  /** Drops and rebuilds aggregates from source sessions + day slices. */
  rebuildAggregates(profileId: ProfileId): Promise<RepositoryResult<void>>;
  getCharacterStats(profileId: ProfileId): Promise<RepositoryResult<CharacterStatTotals>>;
  rebuildCharacterStats(profileId: ProfileId): Promise<RepositoryResult<void>>;
  /** Permanently clears source mistake/exposure rows and their derived character totals. */
  resetCharacterStats(profileId: ProfileId): Promise<RepositoryResult<void>>;

  // checkpoints -----------------------------------------------------------
  saveCheckpoint(checkpoint: ActiveCheckpoint): Promise<RepositoryResult<void>>;
  getCheckpoint(sessionId: SessionId): Promise<RepositoryResult<ActiveCheckpoint | null>>;
  findLatestCheckpoint(profileId: ProfileId): Promise<RepositoryResult<ActiveCheckpoint | null>>;
  deleteCheckpoint(sessionId: SessionId): Promise<RepositoryResult<void>>;

  // documents -------------------------------------------------------------
  saveDocument(write: DocumentWrite): Promise<RepositoryResult<CustomDocument>>;
  getDocument(documentId: DocumentId): Promise<RepositoryResult<CustomDocument>>;
  listDocuments(profileId: ProfileId): Promise<RepositoryResult<CustomDocument[]>>;
  /** Bounded sequential chunk read; never one giant payload. */
  getDocumentChunks(
    documentId: DocumentId,
    fromChunkIndex: number,
    maxChunks: number,
  ): Promise<RepositoryResult<DocumentChunk[]>>;
  deleteDocument(documentId: DocumentId): Promise<RepositoryResult<void>>;

  // backup ----------------------------------------------------------------
  /** documents are included only when their ids are listed (§2.3 retention). */
  exportBackup(options: {
    profileIds: ProfileId[];
    includeDocumentIds: DocumentId[];
  }): Promise<RepositoryResult<BackupEnvelope>>;
  importBackup(
    envelope: BackupEnvelope,
    options: ImportOptions,
  ): Promise<RepositoryResult<ImportOutcome>>;
}
