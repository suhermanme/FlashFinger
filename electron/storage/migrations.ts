/** Versioned logical state and sequential migrations for desktop storage. */

import type {
  ActiveCheckpoint,
  CharacterExposure,
  CustomDocument,
  DailyAggregate,
  DocumentChunk,
  InstallationSettings,
  LessonProgress,
  MistakeBucket,
  Profile,
  SessionDaySlice,
  SessionRecord,
  SessionSeries,
} from '../../src/contracts/models.js';
import type { SessionCommit } from '../../src/contracts/repository.js';
import {
  validateActiveCheckpoint,
  validateCharacterExposure,
  validateCustomDocument,
  validateDailyAggregate,
  validateDocumentChunk,
  validateInstallationSettings,
  validateLessonProgress,
  validateMistakeBucket,
  validateOwnershipReferences,
  validateProfile,
  validateSessionDaySlice,
  validateSessionRecord,
  validateSessionSeries,
  type ValidationResult,
} from '../../src/contracts/validation.js';
import { SCHEMA_VERSION } from '../../src/contracts/versions.js';

export interface CharacterStatRow {
  profileId: string;
  expected: string;
  attempts: number;
  errors: number;
  mistakes: Record<string, number>;
}

/** Serialized collections deliberately mirror the browser repository stores. */
export interface DesktopRepositoryState {
  schemaVersion: number;
  installationSettings: InstallationSettings | null;
  profiles: Profile[];
  sessions: SessionRecord[];
  sessionSeries: SessionSeries[];
  sessionDaySlices: SessionDaySlice[];
  sessionMistakes: MistakeBucket[];
  sessionExposures: CharacterExposure[];
  lessonProgress: LessonProgress[];
  dailyAggregates: DailyAggregate[];
  profileCharacterStats: CharacterStatRow[];
  customDocuments: CustomDocument[];
  documentChunks: DocumentChunk[];
  checkpoints: ActiveCheckpoint[];
}

export type DesktopMutation =
  | { kind: 'create-profile'; profile: Profile }
  | { kind: 'update-profile'; profile: Profile }
  | { kind: 'delete-profile'; profileId: string }
  | { kind: 'save-installation-settings'; settings: InstallationSettings }
  | { kind: 'commit-session'; commit: SessionCommit }
  | { kind: 'replace-aggregates'; profileId: string; rows: DailyAggregate[] }
  | { kind: 'replace-character-stats'; profileId: string; rows: CharacterStatRow[] }
  | { kind: 'save-checkpoint'; checkpoint: ActiveCheckpoint }
  | { kind: 'delete-checkpoint'; sessionId: string }
  | { kind: 'save-document'; document: CustomDocument; chunks: DocumentChunk[] }
  | { kind: 'delete-document'; documentId: string };

export function createEmptyState(): DesktopRepositoryState {
  return {
    schemaVersion: SCHEMA_VERSION,
    installationSettings: null,
    profiles: [],
    sessions: [],
    sessionSeries: [],
    sessionDaySlices: [],
    sessionMistakes: [],
    sessionExposures: [],
    lessonProgress: [],
    dailyAggregates: [],
    profileCharacterStats: [],
    customDocuments: [],
    documentChunks: [],
    checkpoints: [],
  };
}

function requireValid<T>(label: string, result: ValidationResult<T>): T {
  if (result.valid) return result.value;
  const detail = result.errors.slice(0, 8).map((item) => `${item.path}: ${item.message}`).join('; ');
  throw new Error(`${label} failed validation: ${detail}`);
}

function requireUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label} key in desktop state`);
}

/** Validate an untrusted snapshot after migration and before it is accepted. */
export function validateDesktopState(value: unknown): DesktopRepositoryState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Desktop state is not an object');
  const state = value as Partial<DesktopRepositoryState>;
  if (state.schemaVersion !== SCHEMA_VERSION) throw new Error('Desktop state has an unsupported schema version');
  const arrayKeys: (keyof DesktopRepositoryState)[] = [
    'profiles', 'sessions', 'sessionSeries', 'sessionDaySlices', 'sessionMistakes',
    'sessionExposures', 'lessonProgress', 'dailyAggregates', 'profileCharacterStats',
    'customDocuments', 'documentChunks', 'checkpoints',
  ];
  for (const key of arrayKeys) if (!Array.isArray(state[key])) throw new Error(`Desktop state collection ${key} is missing`);

  const checked = state as DesktopRepositoryState;
  checked.profiles.forEach((item) => requireValid('Stored profile', validateProfile(item)));
  checked.sessions.forEach((item) => requireValid('Stored session', validateSessionRecord(item)));
  checked.sessionSeries.forEach((item) => requireValid('Stored series', validateSessionSeries(item)));
  checked.sessionDaySlices.forEach((item) => requireValid('Stored day slice', validateSessionDaySlice(item)));
  checked.sessionMistakes.forEach((item) => requireValid('Stored mistake', validateMistakeBucket(item)));
  checked.sessionExposures.forEach((item) => requireValid('Stored exposure', validateCharacterExposure(item)));
  checked.lessonProgress.forEach((item) => requireValid('Stored lesson progress', validateLessonProgress(item)));
  checked.dailyAggregates.forEach((item) => requireValid('Stored aggregate', validateDailyAggregate(item)));
  checked.customDocuments.forEach((item) => requireValid('Stored document', validateCustomDocument(item)));
  checked.documentChunks.forEach((item) => requireValid('Stored document chunk', validateDocumentChunk(item)));
  checked.checkpoints.forEach((item) => requireValid('Stored checkpoint', validateActiveCheckpoint(item)));
  if (checked.installationSettings !== null) {
    requireValid('Stored installation settings', validateInstallationSettings(checked.installationSettings));
  }
  for (const row of checked.profileCharacterStats) {
    if (!row || typeof row !== 'object' || typeof row.profileId !== 'string' || typeof row.expected !== 'string'
      || !Number.isSafeInteger(row.attempts) || row.attempts < 0
      || !Number.isSafeInteger(row.errors) || row.errors < 0 || row.errors > row.attempts
      || !row.mistakes || typeof row.mistakes !== 'object' || Array.isArray(row.mistakes)) {
      throw new Error('Stored character-stat row failed validation');
    }
    for (const count of Object.values(row.mistakes)) {
      if (!Number.isSafeInteger(count) || count < 0) throw new Error('Stored character-stat mistake count failed validation');
    }
  }

  requireUnique(checked.profiles.map((item) => item.id), 'profile');
  requireUnique(checked.sessions.map((item) => item.id), 'session');
  requireUnique(checked.sessionSeries.map((item) => item.sessionId), 'series');
  requireUnique(checked.customDocuments.map((item) => item.id), 'document');
  requireUnique(checked.checkpoints.map((item) => item.sessionId), 'checkpoint');
  const graph = validateOwnershipReferences({
    installationSettings: checked.installationSettings ?? undefined,
    profiles: checked.profiles,
    sessions: checked.sessions,
    series: checked.sessionSeries,
    daySlices: checked.sessionDaySlices,
    mistakes: checked.sessionMistakes,
    exposures: checked.sessionExposures,
    lessonProgress: checked.lessonProgress,
    dailyAggregates: checked.dailyAggregates,
    documents: checked.customDocuments,
    documentChunks: checked.documentChunks,
    checkpoints: checked.checkpoints,
  });
  requireValid('Desktop ownership graph', graph);
  return checked;
}

type Migration = (value: Record<string, unknown>) => Record<string, unknown>;
const migrations = new Map<number, Migration>();

/** Migrate every sequential version. v1 is the initial materialized shape. */
export function migrateDesktopState(value: unknown, fromVersion: number): DesktopRepositoryState {
  if (fromVersion > SCHEMA_VERSION) {
    const error = new Error(`Schema version ${fromVersion} is newer than supported ${SCHEMA_VERSION}`);
    error.name = 'VersionTooNewError';
    throw error;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Desktop state is not an object');
  let current = value as Record<string, unknown>;
  for (let version = fromVersion + 1; version <= SCHEMA_VERSION; version += 1) {
    const migration = migrations.get(version);
    if (!migration) throw new Error(`Missing desktop migration for schema version ${version}`);
    current = migration(current);
  }
  return validateDesktopState(current);
}
