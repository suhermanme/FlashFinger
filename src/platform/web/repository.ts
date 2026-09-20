/** IndexedDB-backed browser implementation of the shared Repository contract. */

import type {
  ActiveCheckpoint,
  BackupEnvelope,
  CharacterExposure,
  CustomDocument,
  DailyAggregate,
  DocumentChunk,
  DocumentId,
  InstallationSettings,
  LessonProgress,
  MistakeBucket,
  Profile,
  ProfileId,
  ProfileSettings,
  SessionDaySlice,
  SessionId,
  SessionRecord,
  SessionSeries,
} from '../../contracts/models.js';
import {
  err,
  ok,
  type CharacterStatTotals,
  type CommitOutcome,
  type DocumentWrite,
  type ImportOptions,
  type ImportOutcome,
  type Repository,
  type RepositoryError,
  type RepositoryResult,
  type SessionCommit,
  type SessionPage,
  type SessionQuery,
  type StorageStatus,
} from '../../contracts/repository.js';
import {
  checkMetricVersion,
  validateActiveCheckpoint,
  validateCharacterExposure,
  validateCustomDocument,
  validateDailyAggregate,
  validateDocumentChunk,
  validateInstallationSettings,
  validateLessonProgress,
  validateMistakeBucket,
  validateProfile,
  validateProfileSettings,
  validateSessionDaySlice,
  validateSessionRecord,
  validateSessionSeries,
  type ValidationResult,
} from '../../contracts/validation.js';
import { APP_BUILD, SCHEMA_VERSION } from '../../contracts/versions.js';
import {
  DB_NAME,
  openDatabase,
  requestResult,
  withTransaction,
  type OpenDatabaseOptions,
} from './database.js';
import { readStoredVersion, STORES, type MigrationHooks, type StoreName } from './migrations.js';
import {
  assertLeaseForWrite,
  BrowserSessionOwnership,
  OwnershipConflictError,
  renewLeaseForWrite,
  type OwnershipCoordinatorOptions,
  type OwnershipToken,
} from './ownership.js';

const MAX_STRING_KEY = '\uffff';
const MAX_SESSION_PAGE_SIZE = 200;
const MAX_DOCUMENT_CHUNKS_PER_READ = 200;
const RETAINED_SERIES_PER_PROFILE = 1_000;

interface CharacterStatRow {
  profileId: ProfileId;
  expected: string;
  attempts: number;
  errors: number;
  mistakes: Record<string, number>;
}

export interface RepositoryFaultInjector {
  beforeWrite?(store: StoreName, operation: string, value: unknown): void;
}

export interface IndexedDbRepositoryOptions {
  readonly databaseName?: string;
  readonly factory?: IDBFactory;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
  readonly storageManager?: Pick<StorageManager, 'estimate' | 'persist' | 'persisted'> | null;
  readonly migrationHooks?: MigrationHooks;
  readonly faultInjector?: RepositoryFaultInjector;
  readonly ownership?: Omit<OwnershipCoordinatorOptions, 'now' | 'randomUUID'>;
}

class RepositoryOperationError extends Error {
  constructor(readonly repositoryError: RepositoryError) {
    super(repositoryError.message);
    this.name = 'RepositoryOperationError';
  }
}

function repositoryError(
  code: RepositoryError['code'],
  message: string,
  retryable = false,
  detail?: string,
): RepositoryError {
  return detail === undefined ? { code, message, retryable } : { code, message, retryable, detail };
}

function failure(code: RepositoryError['code'], message: string, retryable = false, detail?: string): never {
  throw new RepositoryOperationError(repositoryError(code, message, retryable, detail));
}

function errorName(error: unknown): string {
  return typeof error === 'object' && error !== null && 'name' in error
    ? String((error as { name: unknown }).name)
    : '';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mapError(error: unknown): RepositoryError {
  if (error instanceof RepositoryOperationError) return error.repositoryError;
  if (error instanceof OwnershipConflictError) return repositoryError('conflict', error.message, true);
  const name = errorName(error);
  const detail = errorMessage(error);
  if (name === 'QuotaExceededError') return repositoryError('quota', 'Browser storage quota was exceeded', true, detail);
  if (name === 'VersionError') return repositoryError('version-too-new', 'The browser database uses a newer schema', false, detail);
  if (name === 'SecurityError' || name === 'NotAllowedError') {
    return repositoryError('permission', 'Browser storage access was denied', false, detail);
  }
  if (name === 'NotSupportedError' || name === 'InvalidStateError') {
    return repositoryError('unavailable', 'IndexedDB is unavailable', true, detail);
  }
  if (name === 'ConstraintError') return repositoryError('conflict', 'A stored key already exists', false, detail);
  if (name === 'DataError') return repositoryError('invalid', 'A value is not a valid IndexedDB record', false, detail);
  return repositoryError('corrupt', 'The browser database operation failed', false, detail);
}

function attempt<T>(work: () => Promise<T>): Promise<RepositoryResult<T>> {
  return work().then(ok, (error: unknown) => err(mapError(error)));
}

function requireValid<T>(label: string, result: ValidationResult<T>): T {
  if (result.valid) return result.value;
  const detail = result.errors.slice(0, 8).map((item) => `${item.path}: ${item.message}`).join('; ');
  failure('invalid', `${label} failed validation`, false, detail);
}

function getOne<T>(store: IDBObjectStore, key: IDBValidKey): Promise<T | undefined> {
  return requestResult<T | undefined>(store.get(key));
}

function getAll<T>(source: IDBObjectStore | IDBIndex, range?: IDBKeyRange): Promise<T[]> {
  return requestResult<T[]>(range === undefined ? source.getAll() : source.getAll(range));
}

function prefixRange(prefix: readonly IDBValidKey[]): IDBKeyRange {
  return IDBKeyRange.bound([...prefix], [...prefix, MAX_STRING_KEY]);
}

async function deleteByCursor(source: IDBObjectStore | IDBIndex, range: IDBKeyRange): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = source.openCursor(range);
    request.onerror = () => reject(request.error ?? new DOMException('Cursor delete failed', 'UnknownError'));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      cursor.delete();
      cursor.continue();
    };
  });
}

interface SessionCursor {
  v: 1;
  signature: string;
  endedAt: string;
  id: string;
}

function querySignature(query: SessionQuery): string {
  return JSON.stringify({
    profileId: query.profileId,
    mode: query.mode ?? null,
    from: query.from ?? null,
    to: query.to ?? null,
    includeIneligible: query.includeIneligible ?? false,
  });
}

function encodeCursor(cursor: SessionCursor): string {
  return btoa(JSON.stringify(cursor));
}

function decodeCursor(value: string, signature: string): SessionCursor {
  try {
    const parsed = JSON.parse(atob(value)) as Partial<SessionCursor>;
    if (parsed.v !== 1 || parsed.signature !== signature || typeof parsed.endedAt !== 'string' || typeof parsed.id !== 'string') {
      failure('invalid', 'The session cursor does not belong to this query');
    }
    return parsed as SessionCursor;
  } catch (error) {
    if (error instanceof RepositoryOperationError) throw error;
    failure('invalid', 'The session cursor is malformed');
  }
}

function sum(items: readonly number[]): number {
  return items.reduce((total, value) => total + value, 0);
}

function validateCommit(commit: SessionCommit): void {
  const session = requireValid('Session', validateSessionRecord(commit.session));
  const metricGate = checkMetricVersion(session.config.metricVersion);
  if (!metricGate.ok) throw new RepositoryOperationError(metricGate.error);

  if (commit.series) {
    const series = requireValid('Session series', validateSessionSeries(commit.series));
    if (series.sessionId !== session.id) failure('invalid', 'Session series belongs to another session');
  }

  const slices = commit.daySlices.map((value) => requireValid('Session day slice', validateSessionDaySlice(value)));
  if (slices.length === 0) failure('invalid', 'A finalized session requires at least one day slice');
  for (const slice of slices) {
    if (slice.sessionId !== session.id || slice.profileId !== session.profileId) {
      failure('invalid', 'A day slice belongs to another session or profile');
    }
  }
  const totals = {
    activeMs: sum(slices.map((item) => item.activeMs)),
    attempts: sum(slices.map((item) => item.attempts)),
    correctAttempts: sum(slices.map((item) => item.correctAttempts)),
    errorAttempts: sum(slices.map((item) => item.errorAttempts)),
    completedWords: sum(slices.map((item) => item.completedWords)),
    eligibleActiveMs: sum(slices.map((item) => item.eligibleActiveMs)),
    eligibleRetainedCorrect: sum(slices.map((item) => item.eligibleRetainedCorrect)),
  };
  if (totals.activeMs !== session.activeMs
    || totals.attempts !== session.attempts
    || totals.correctAttempts !== session.correctAttempts
    || totals.errorAttempts !== session.errorAttempts
    || totals.completedWords !== session.completedWords) {
    failure('invalid', 'Day-slice source counters do not equal the finalized session counters');
  }
  const expectedEligibleActive = session.eligibleForBest ? session.activeMs : 0;
  const expectedEligibleRetained = session.eligibleForBest ? session.retainedCorrect : 0;
  if (totals.eligibleActiveMs !== expectedEligibleActive
    || totals.eligibleRetainedCorrect !== expectedEligibleRetained) {
    failure('invalid', 'Day-slice eligible counters do not match session eligibility');
  }

  for (const value of commit.mistakes) {
    const bucket = requireValid('Mistake bucket', validateMistakeBucket(value));
    if (bucket.sessionId !== session.id || bucket.profileId !== session.profileId) {
      failure('invalid', 'A mistake bucket belongs to another session or profile');
    }
  }
  for (const value of commit.exposures) {
    const exposure = requireValid('Character exposure', validateCharacterExposure(value));
    if (exposure.sessionId !== session.id || exposure.profileId !== session.profileId) {
      failure('invalid', 'A character exposure belongs to another session or profile');
    }
  }
  for (const value of commit.lessonProgress ?? []) {
    const progress = requireValid('Lesson progress', validateLessonProgress(value));
    if (progress.profileId !== session.profileId) failure('invalid', 'Lesson progress belongs to another profile');
  }
  for (const value of commit.aggregateChanges ?? []) {
    const aggregate = requireValid('Daily aggregate', validateDailyAggregate(value));
    if (aggregate.profileId !== session.profileId) failure('invalid', 'Daily aggregate belongs to another profile');
  }
  if (commit.removeCheckpointId !== undefined && commit.removeCheckpointId !== session.id) {
    failure('invalid', 'Finalization may only remove the finalized session checkpoint');
  }
}

export class IndexedDbRepository implements Repository {
  private database: IDBDatabase | null = null;
  private ownership: BrowserSessionOwnership | null = null;
  private readonly ownedTokens = new Map<ProfileId, OwnershipToken>();
  private readonly options: IndexedDbRepositoryOptions;
  private readonly databaseName: string;
  private readonly now: () => number;
  private readonly randomUUID: () => string;

  constructor(options: string | IndexedDbRepositoryOptions = {}) {
    this.options = typeof options === 'string' ? { databaseName: options } : options;
    this.databaseName = this.options.databaseName ?? DB_NAME;
    this.now = this.options.now ?? (() => Date.now());
    this.randomUUID = this.options.randomUUID ?? (() => crypto.randomUUID());
  }

  private requireDatabase(): IDBDatabase {
    if (!this.database) failure('unavailable', 'The browser repository is not initialized', true);
    return this.database;
  }

  private write<T>(store: StoreName, operation: string, value: unknown, request: () => IDBRequest<T>): Promise<T> {
    this.options.faultInjector?.beforeWrite?.(store, operation, value);
    return requestResult(request());
  }

  async initialize(): Promise<RepositoryResult<void>> {
    if (this.database) return ok(undefined);
    return attempt(async () => {
      const openOptions: OpenDatabaseOptions = {
        name: this.databaseName,
        factory: this.options.factory,
        migrationHooks: this.options.migrationHooks,
      };
      const database = await openDatabase(openOptions);
      try {
        const storedVersion = await readStoredVersion(database);
        if (storedVersion > SCHEMA_VERSION) {
          failure('version-too-new', `Schema version ${storedVersion} is newer than supported ${SCHEMA_VERSION}`);
        }
        if (storedVersion !== SCHEMA_VERSION || database.version !== SCHEMA_VERSION) {
          failure('corrupt', 'IndexedDB schema metadata is incomplete');
        }
      } catch (error) {
        database.close();
        throw error;
      }
      this.database = database;
      this.ownership = new BrowserSessionOwnership(database, {
        ...this.options.ownership,
        now: this.now,
        randomUUID: this.randomUUID,
      });
    });
  }

  close(): void {
    this.ownership?.close();
    this.ownership = null;
    this.ownedTokens.clear();
    this.database?.close();
    this.database = null;
  }

  async schemaVersion(): Promise<RepositoryResult<number>> {
    return attempt(() => readStoredVersion(this.requireDatabase()));
  }

  async storageStatus(): Promise<RepositoryResult<StorageStatus>> {
    return attempt(async () => {
      const storage = this.options.storageManager
        ?? (typeof navigator === 'undefined' ? null : navigator.storage);
      let persisted = false;
      let quotaBytes: number | null = null;
      let usageBytes: number | null = null;
      if (storage) {
        try {
          persisted = await storage.persisted();
          if (!persisted) persisted = await storage.persist();
        } catch { /* denied persistence remains a valid temporary mode */ }
        try {
          const estimate = await storage.estimate();
          quotaBytes = estimate.quota ?? null;
          usageBytes = estimate.usage ?? null;
        } catch { /* estimates are optional */ }
      }
      return {
        available: this.database !== null,
        persisted,
        quotaBytes,
        usageBytes,
        mode: persisted ? 'durable' : 'temporary',
      };
    });
  }

  async listProfiles(): Promise<RepositoryResult<Profile[]>> {
    return attempt(async () => {
      const profiles = await withTransaction(this.requireDatabase(), [STORES.profiles], 'readonly', (transaction) =>
        getAll<Profile>(transaction.objectStore(STORES.profiles).index('byUpdatedAt')));
      for (const profile of profiles) requireValid('Stored profile', validateProfile(profile));
      return profiles.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
    });
  }

  async createProfile(input: {
    name: string;
    avatarToken: string;
    analyticsZone: string;
    settings: ProfileSettings;
  }): Promise<RepositoryResult<Profile>> {
    return attempt(async () => {
      requireValid('Profile settings', validateProfileSettings(input.settings));
      const timestamp = new Date(this.now()).toISOString();
      const profile: Profile = {
        id: this.randomUUID(),
        name: input.name,
        avatarToken: input.avatarToken,
        analyticsZone: input.analyticsZone,
        settings: input.settings,
        createdAt: timestamp,
        updatedAt: timestamp,
        revision: 0,
      };
      requireValid('Profile', validateProfile(profile));
      await withTransaction(this.requireDatabase(), [STORES.profiles], 'readwrite', async (transaction) => {
        await this.write(STORES.profiles, 'add', profile, () => transaction.objectStore(STORES.profiles).add(profile));
      });
      return profile;
    });
  }

  async updateProfile(profile: Profile): Promise<RepositoryResult<Profile>> {
    return attempt(async () => {
      requireValid('Profile', validateProfile(profile));
      return withTransaction(this.requireDatabase(), [STORES.profiles], 'readwrite', async (transaction) => {
        const store = transaction.objectStore(STORES.profiles);
        const current = await getOne<Profile>(store, profile.id);
        if (!current) failure('not-found', `Profile not found: ${profile.id}`);
        if (current.revision !== profile.revision) failure('conflict', 'The profile revision is stale', true);
        const updated: Profile = {
          ...profile,
          createdAt: current.createdAt,
          updatedAt: new Date(this.now()).toISOString(),
          revision: current.revision + 1,
        };
        requireValid('Updated profile', validateProfile(updated));
        await this.write(STORES.profiles, 'put', updated, () => store.put(updated));
        return updated;
      });
    });
  }

  async deleteProfile(profileId: ProfileId): Promise<RepositoryResult<void>> {
    return attempt(async () => {
      const database = this.requireDatabase();
      const stores = Object.values(STORES);
      await withTransaction(database, stores, 'readwrite', async (transaction) => {
        const profiles = transaction.objectStore(STORES.profiles);
        if (!(await getOne<Profile>(profiles, profileId))) failure('not-found', `Profile not found: ${profileId}`);
        const sessionsStore = transaction.objectStore(STORES.sessions);
        const sessions = await getAll<SessionRecord>(
          sessionsStore.index('byProfileEndedAt'),
          prefixRange([profileId]),
        );
        const documentsStore = transaction.objectStore(STORES.customDocuments);
        const documents = await getAll<CustomDocument>(
          documentsStore.index('byProfileCreatedAt'),
          prefixRange([profileId]),
        );

        await requestResult(profiles.delete(profileId));
        for (const session of sessions) {
          await requestResult(sessionsStore.delete(session.id));
          await requestResult(transaction.objectStore(STORES.sessionSeries).delete(session.id));
        }
        await deleteByCursor(
          transaction.objectStore(STORES.sessionDaySlices).index('byProfileSession'),
          prefixRange([profileId]),
        );
        await deleteByCursor(
          transaction.objectStore(STORES.sessionMistakes).index('byProfileSession'),
          prefixRange([profileId]),
        );
        await deleteByCursor(
          transaction.objectStore(STORES.sessionExposures).index('byProfileSession'),
          prefixRange([profileId]),
        );
        await deleteByCursor(transaction.objectStore(STORES.lessonProgress).index('byProfile'), IDBKeyRange.only(profileId));
        await deleteByCursor(transaction.objectStore(STORES.dailyAggregates).index('byProfileDay'), prefixRange([profileId]));
        await deleteByCursor(transaction.objectStore(STORES.profileCharacterStats).index('byProfile'), IDBKeyRange.only(profileId));
        await deleteByCursor(transaction.objectStore(STORES.checkpoints).index('byProfileCheckpointAt'), prefixRange([profileId]));
        for (const document of documents) {
          await requestResult(documentsStore.delete(document.id));
          await deleteByCursor(transaction.objectStore(STORES.documentChunks), prefixRange([document.id]));
        }

        const metadata = transaction.objectStore(STORES.metadata);
        const settingsRecord = await getOne<{ key: string; value: InstallationSettings }>(metadata, 'installationSettings');
        if (settingsRecord?.value.activeProfileId === profileId) {
          await requestResult(metadata.put({
            key: 'installationSettings',
            value: { ...settingsRecord.value, activeProfileId: null },
          }));
        }
        await requestResult(metadata.delete(`sessionLease:${profileId}`));
      });

      const token = this.ownedTokens.get(profileId);
      this.ownedTokens.delete(profileId);
      if (token) await this.ownership?.release(token);
    });
  }

  async loadProfileSettings(profileId: ProfileId): Promise<RepositoryResult<ProfileSettings>> {
    return attempt(async () => {
      const profile = await withTransaction(this.requireDatabase(), [STORES.profiles], 'readonly', (transaction) =>
        getOne<Profile>(transaction.objectStore(STORES.profiles), profileId));
      if (!profile) failure('not-found', `Profile not found: ${profileId}`);
      requireValid('Stored profile', validateProfile(profile));
      return profile.settings;
    });
  }

  async saveProfileSettings(profileId: ProfileId, settings: ProfileSettings): Promise<RepositoryResult<void>> {
    return attempt(async () => {
      requireValid('Profile settings', validateProfileSettings(settings));
      await withTransaction(this.requireDatabase(), [STORES.profiles], 'readwrite', async (transaction) => {
        const store = transaction.objectStore(STORES.profiles);
        const profile = await getOne<Profile>(store, profileId);
        if (!profile) failure('not-found', `Profile not found: ${profileId}`);
        const updated: Profile = {
          ...profile,
          settings,
          updatedAt: new Date(this.now()).toISOString(),
          revision: profile.revision + 1,
        };
        await this.write(STORES.profiles, 'put-settings', updated, () => store.put(updated));
      });
    });
  }

  async loadInstallationSettings(): Promise<RepositoryResult<InstallationSettings>> {
    return attempt(async () => {
      const record = await withTransaction(this.requireDatabase(), [STORES.metadata], 'readonly', (transaction) =>
        getOne<{ key: string; value: InstallationSettings }>(transaction.objectStore(STORES.metadata), 'installationSettings'));
      const settings: InstallationSettings = record?.value ?? {
        schemaVersion: SCHEMA_VERSION,
        activeProfileId: null,
        lastResolvedTheme: 'light',
        appBuild: APP_BUILD,
        onboardingComplete: false,
      };
      return requireValid('Installation settings', validateInstallationSettings(settings));
    });
  }

  async saveInstallationSettings(settings: InstallationSettings): Promise<RepositoryResult<void>> {
    return attempt(async () => {
      requireValid('Installation settings', validateInstallationSettings(settings));
      if (settings.schemaVersion !== SCHEMA_VERSION) failure('invalid', 'Installation settings use the wrong schema version');
      await withTransaction(this.requireDatabase(), [STORES.metadata, STORES.profiles], 'readwrite', async (transaction) => {
        if (settings.activeProfileId && !(await getOne<Profile>(transaction.objectStore(STORES.profiles), settings.activeProfileId))) {
          failure('invalid', 'Installation settings reference a missing active profile');
        }
        const record = { key: 'installationSettings', value: settings };
        await this.write(STORES.metadata, 'put-installation-settings', record, () =>
          transaction.objectStore(STORES.metadata).put(record));
      });
    });
  }

  async querySessions(query: SessionQuery): Promise<RepositoryResult<SessionPage>> {
    return attempt(async () => {
      if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > MAX_SESSION_PAGE_SIZE) {
        failure('invalid', `Session query limit must be between 1 and ${MAX_SESSION_PAGE_SIZE}`);
      }
      if (query.from && query.to && query.from >= query.to) failure('invalid', 'Session query range is empty');
      const signature = querySignature(query);
      const cursor = query.cursor ? decodeCursor(query.cursor, signature) : null;
      const prefix: IDBValidKey[] = query.mode ? [query.profileId, query.mode] : [query.profileId];
      const lower = [...prefix, query.from ?? ''];
      const baseUpper = [...prefix, query.to ?? MAX_STRING_KEY];
      const upper = cursor ? [...prefix, cursor.endedAt, cursor.id] : baseUpper;
      const upperOpen = cursor !== null || query.to !== undefined;
      const range = IDBKeyRange.bound(lower, upper, false, upperOpen);

      const sessions = await withTransaction(this.requireDatabase(), [STORES.sessions], 'readonly', async (transaction) => {
        const indexName = query.mode ? 'byProfileModeEndedAt' : 'byProfileEndedAt';
        const index = transaction.objectStore(STORES.sessions).index(indexName);
        const accepted: SessionRecord[] = [];
        await new Promise<void>((resolve, reject) => {
          const request = index.openCursor(range, 'prev');
          request.onerror = () => reject(request.error ?? new DOMException('Session cursor failed', 'UnknownError'));
          request.onsuccess = () => {
            const item = request.result;
            if (!item || accepted.length >= query.limit + 1) {
              resolve();
              return;
            }
            const session = item.value as SessionRecord;
            if (query.includeIneligible || session.eligibleForBest) accepted.push(session);
            item.continue();
          };
        });
        return accepted;
      });
      for (const session of sessions) requireValid('Stored session', validateSessionRecord(session));
      const page = sessions.slice(0, query.limit);
      const last = page.at(-1);
      return {
        sessions: page,
        nextCursor: sessions.length > query.limit && last
          ? encodeCursor({ v: 1, signature, endedAt: last.endedAt, id: last.id })
          : null,
      };
    });
  }

  async getSession(sessionId: SessionId): Promise<RepositoryResult<SessionRecord>> {
    return attempt(async () => {
      const session = await withTransaction(this.requireDatabase(), [STORES.sessions], 'readonly', (transaction) =>
        getOne<SessionRecord>(transaction.objectStore(STORES.sessions), sessionId));
      if (!session) failure('not-found', `Session not found: ${sessionId}`);
      return requireValid('Stored session', validateSessionRecord(session));
    });
  }

  async commitSession(commit: SessionCommit): Promise<RepositoryResult<CommitOutcome>> {
    return attempt(async () => {
      validateCommit(commit);
      const database = this.requireDatabase();
      const storeNames: StoreName[] = [
        STORES.metadata,
        STORES.profiles,
        STORES.sessions,
        STORES.sessionSeries,
        STORES.sessionDaySlices,
        STORES.sessionMistakes,
        STORES.sessionExposures,
        STORES.lessonProgress,
        STORES.dailyAggregates,
        STORES.profileCharacterStats,
        STORES.checkpoints,
      ];
      return withTransaction(database, storeNames, 'readwrite', async (transaction) => {
        const sessions = transaction.objectStore(STORES.sessions);
        if (await getOne<SessionRecord>(sessions, commit.session.id)) {
          return { alreadyCommitted: true, sessionId: commit.session.id };
        }
        if (!(await getOne<Profile>(transaction.objectStore(STORES.profiles), commit.session.profileId))) {
          failure('invalid', 'The finalized session references a missing profile');
        }
        const ownershipToken = this.ownedTokens.get(commit.session.profileId);
        if (ownershipToken) {
          await assertLeaseForWrite(transaction.objectStore(STORES.metadata), ownershipToken, this.now());
        }
        for (const progress of commit.lessonProgress ?? []) {
          for (const qualifyingId of progress.qualifyingSessionIds) {
            if (qualifyingId !== commit.session.id && !(await getOne<SessionRecord>(sessions, qualifyingId))) {
              failure('invalid', `Lesson progress references missing session ${qualifyingId}`);
            }
          }
        }

        await this.write(STORES.sessions, 'add-session', commit.session, () => sessions.add(commit.session));
        if (commit.series) {
          await this.write(STORES.sessionSeries, 'put-series', commit.series, () =>
            transaction.objectStore(STORES.sessionSeries).put(commit.series as SessionSeries));
        }
        for (const slice of commit.daySlices) {
          await this.write(STORES.sessionDaySlices, 'put-day-slice', slice, () =>
            transaction.objectStore(STORES.sessionDaySlices).put(slice));
        }
        for (const bucket of commit.mistakes) {
          await this.write(STORES.sessionMistakes, 'put-mistake', bucket, () =>
            transaction.objectStore(STORES.sessionMistakes).put(bucket));
        }
        for (const exposure of commit.exposures) {
          await this.write(STORES.sessionExposures, 'put-exposure', exposure, () =>
            transaction.objectStore(STORES.sessionExposures).put(exposure));
        }
        for (const progress of commit.lessonProgress ?? []) {
          await this.write(STORES.lessonProgress, 'put-lesson-progress', progress, () =>
            transaction.objectStore(STORES.lessonProgress).put(progress));
        }
        for (const aggregate of commit.aggregateChanges ?? []) {
          await this.write(STORES.dailyAggregates, 'put-daily-aggregate', aggregate, () =>
            transaction.objectStore(STORES.dailyAggregates).put(aggregate));
        }
        if (commit.updateProfileCharacterStats) {
          await this.updateCharacterStatsInTransaction(transaction, commit.exposures, commit.mistakes);
        }
        if (commit.removeCheckpointId) {
          await this.write(STORES.checkpoints, 'delete-checkpoint', commit.removeCheckpointId, () =>
            transaction.objectStore(STORES.checkpoints).delete(commit.removeCheckpointId as SessionId));
        }
        await this.compactOldSeries(transaction, commit.session.profileId);
        return { alreadyCommitted: false, sessionId: commit.session.id };
      });
    });
  }

  private async compactOldSeries(transaction: IDBTransaction, profileId: ProfileId): Promise<void> {
    const index = transaction.objectStore(STORES.sessions).index('byProfileEndedAt');
    const oldIds: SessionId[] = [];
    let position = 0;
    await new Promise<void>((resolve, reject) => {
      const request = index.openCursor(prefixRange([profileId]), 'prev');
      request.onerror = () => reject(request.error ?? new DOMException('Series retention cursor failed', 'UnknownError'));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve();
          return;
        }
        if (position >= RETAINED_SERIES_PER_PROFILE) oldIds.push((cursor.value as SessionRecord).id);
        position += 1;
        cursor.continue();
      };
    });
    const series = transaction.objectStore(STORES.sessionSeries);
    for (const id of oldIds) await requestResult(series.delete(id));
  }

  private async updateCharacterStatsInTransaction(
    transaction: IDBTransaction,
    exposures: readonly CharacterExposure[],
    mistakes: readonly MistakeBucket[],
  ): Promise<void> {
    const store = transaction.objectStore(STORES.profileCharacterStats);
    const keys = new Set([...exposures.map((item) => item.expected), ...mistakes.map((item) => item.expected)]);
    for (const expected of keys) {
      const profileId = exposures.find((item) => item.expected === expected)?.profileId
        ?? mistakes.find((item) => item.expected === expected)?.profileId;
      if (!profileId) continue;
      const row = await getOne<CharacterStatRow>(store, [profileId, expected]) ?? {
        profileId,
        expected,
        attempts: 0,
        errors: 0,
        mistakes: {},
      };
      for (const exposure of exposures.filter((item) => item.expected === expected)) {
        row.attempts += exposure.attempts;
        row.errors += exposure.errors;
      }
      for (const mistake of mistakes.filter((item) => item.expected === expected)) {
        row.mistakes[mistake.attempted] = (row.mistakes[mistake.attempted] ?? 0) + mistake.count;
      }
      await this.write(STORES.profileCharacterStats, 'put-character-stat', row, () => store.put(row));
    }
  }

  async getSessionSeries(sessionId: SessionId): Promise<RepositoryResult<SessionSeries | null>> {
    return attempt(async () => {
      const series = await withTransaction(this.requireDatabase(), [STORES.sessionSeries], 'readonly', (transaction) =>
        getOne<SessionSeries>(transaction.objectStore(STORES.sessionSeries), sessionId));
      return series ? requireValid('Stored session series', validateSessionSeries(series)) : null;
    });
  }

  async getLessonProgress(profileId: ProfileId, curriculumVersion: string): Promise<RepositoryResult<LessonProgress[]>> {
    return attempt(async () => {
      const rows = await withTransaction(this.requireDatabase(), [STORES.lessonProgress], 'readonly', (transaction) =>
        getAll<LessonProgress>(transaction.objectStore(STORES.lessonProgress), prefixRange([profileId, curriculumVersion])));
      for (const row of rows) requireValid('Stored lesson progress', validateLessonProgress(row));
      return rows;
    });
  }

  async getDailyAggregates(profileId: ProfileId, from: string, to: string): Promise<RepositoryResult<DailyAggregate[]>> {
    return attempt(async () => {
      if (from >= to) failure('invalid', 'Aggregate date range is empty');
      const rows = await withTransaction(this.requireDatabase(), [STORES.dailyAggregates], 'readonly', (transaction) =>
        getAll<DailyAggregate>(
          transaction.objectStore(STORES.dailyAggregates).index('byProfileDay'),
          IDBKeyRange.bound([profileId, from], [profileId, to], false, true),
        ));
      for (const row of rows) requireValid('Stored daily aggregate', validateDailyAggregate(row));
      return rows.sort((left, right) => left.day.localeCompare(right.day) || left.zone.localeCompare(right.zone));
    });
  }

  async rebuildAggregates(profileId: ProfileId): Promise<RepositoryResult<void>> {
    return attempt(async () => {
      await withTransaction(
        this.requireDatabase(),
        [STORES.profiles, STORES.sessions, STORES.sessionDaySlices, STORES.dailyAggregates],
        'readwrite',
        async (transaction) => {
          if (!(await getOne<Profile>(transaction.objectStore(STORES.profiles), profileId))) {
            failure('not-found', `Profile not found: ${profileId}`);
          }
          const sessions = await getAll<SessionRecord>(
            transaction.objectStore(STORES.sessions).index('byProfileEndedAt'),
            prefixRange([profileId]),
          );
          const slices = await getAll<SessionDaySlice>(
            transaction.objectStore(STORES.sessionDaySlices).index('byProfileSession'),
            prefixRange([profileId]),
          );
          const sessionById = new Map(sessions.map((session) => [session.id, session]));
          const aggregates = new Map<string, DailyAggregate>();
          for (const slice of slices) {
            const session = sessionById.get(slice.sessionId);
            if (!session) failure('corrupt', `Day slice references missing session ${slice.sessionId}`);
            const key = JSON.stringify([slice.zone, slice.day, session.config.metricVersion]);
            const aggregate = aggregates.get(key) ?? {
              profileId,
              day: slice.day,
              zone: slice.zone,
              metricVersion: session.config.metricVersion,
              activeMs: 0,
              attempts: 0,
              correctAttempts: 0,
              errorAttempts: 0,
              completedWords: 0,
              eligibleActiveMs: 0,
              eligibleRetainedCorrect: 0,
              eligibleSessionCount: 0,
              bestWpm: null,
              revision: 0,
            };
            aggregate.activeMs += slice.activeMs;
            aggregate.attempts += slice.attempts;
            aggregate.correctAttempts += slice.correctAttempts;
            aggregate.errorAttempts += slice.errorAttempts;
            aggregate.completedWords += slice.completedWords;
            aggregate.eligibleActiveMs += slice.eligibleActiveMs;
            aggregate.eligibleRetainedCorrect += slice.eligibleRetainedCorrect;
            if (slice.eligibleActiveMs > 0) {
              aggregate.eligibleSessionCount += 1;
              if (session.adjustedWpm !== null) {
                aggregate.bestWpm = aggregate.bestWpm === null
                  ? session.adjustedWpm
                  : Math.max(aggregate.bestWpm, session.adjustedWpm);
              }
            }
            aggregates.set(key, aggregate);
          }
          const aggregateStore = transaction.objectStore(STORES.dailyAggregates);
          await deleteByCursor(aggregateStore.index('byProfileDay'), prefixRange([profileId]));
          for (const aggregate of aggregates.values()) {
            requireValid('Rebuilt daily aggregate', validateDailyAggregate(aggregate));
            await this.write(STORES.dailyAggregates, 'rebuild-daily-aggregate', aggregate, () => aggregateStore.put(aggregate));
          }
        },
      );
    });
  }

  async getCharacterStats(profileId: ProfileId): Promise<RepositoryResult<CharacterStatTotals>> {
    return attempt(async () => {
      const rows = await withTransaction(this.requireDatabase(), [STORES.profileCharacterStats], 'readonly', (transaction) =>
        getAll<CharacterStatRow>(
          transaction.objectStore(STORES.profileCharacterStats).index('byProfile'),
          IDBKeyRange.only(profileId),
        ));
      rows.sort((left, right) => left.expected.localeCompare(right.expected));
      return {
        exposures: rows.map(({ expected, attempts, errors }) => ({ expected, attempts, errors })),
        mistakes: rows.flatMap((row) => Object.entries(row.mistakes)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([attempted, count]) => ({ expected: row.expected, attempted, count }))),
      };
    });
  }

  async rebuildCharacterStats(profileId: ProfileId): Promise<RepositoryResult<void>> {
    return attempt(async () => {
      await withTransaction(
        this.requireDatabase(),
        [STORES.profiles, STORES.sessionExposures, STORES.sessionMistakes, STORES.profileCharacterStats],
        'readwrite',
        async (transaction) => {
          if (!(await getOne<Profile>(transaction.objectStore(STORES.profiles), profileId))) {
            failure('not-found', `Profile not found: ${profileId}`);
          }
          const exposures = await getAll<CharacterExposure>(
            transaction.objectStore(STORES.sessionExposures).index('byProfileSession'),
            prefixRange([profileId]),
          );
          const mistakes = await getAll<MistakeBucket>(
            transaction.objectStore(STORES.sessionMistakes).index('byProfileSession'),
            prefixRange([profileId]),
          );
          await deleteByCursor(
            transaction.objectStore(STORES.profileCharacterStats).index('byProfile'),
            IDBKeyRange.only(profileId),
          );
          await this.updateCharacterStatsInTransaction(transaction, exposures, mistakes);
        },
      );
    });
  }

  async acquireSessionOwnership(profileId: ProfileId): Promise<RepositoryResult<OwnershipToken>> {
    return attempt(async () => {
      const database = this.requireDatabase();
      const profile = await withTransaction(database, [STORES.profiles], 'readonly', (transaction) =>
        getOne<Profile>(transaction.objectStore(STORES.profiles), profileId));
      if (!profile) failure('not-found', `Profile not found: ${profileId}`);
      if (!this.ownership) failure('unavailable', 'Session ownership is unavailable', true);
      const token = await this.ownership.acquire(profileId);
      if (!token) failure('conflict', 'Another browser tab owns this profile session', true);
      this.ownedTokens.set(profileId, token);
      return token;
    });
  }

  async renewSessionOwnership(token: OwnershipToken): Promise<RepositoryResult<OwnershipToken>> {
    return attempt(async () => {
      if (!this.ownership) failure('unavailable', 'Session ownership is unavailable', true);
      const renewed = await this.ownership.renew(token);
      if (!renewed) failure('conflict', 'The active-session ownership token is stale', true);
      this.ownedTokens.set(token.profileId, renewed);
      return renewed;
    });
  }

  async releaseSessionOwnership(token: OwnershipToken): Promise<RepositoryResult<void>> {
    return attempt(async () => {
      if (!this.ownership) failure('unavailable', 'Session ownership is unavailable', true);
      const released = await this.ownership.release(token);
      if (!released) failure('conflict', 'The active-session ownership token is stale', false);
      this.ownedTokens.delete(token.profileId);
    });
  }

  async saveCheckpoint(checkpoint: ActiveCheckpoint): Promise<RepositoryResult<void>> {
    return attempt(async () => {
      requireValid('Checkpoint', validateActiveCheckpoint(checkpoint));
      let token = this.ownedTokens.get(checkpoint.profileId);
      if (!token) {
        const acquired = await this.acquireSessionOwnership(checkpoint.profileId);
        if (!acquired.ok) throw new RepositoryOperationError(acquired.error);
        token = acquired.value;
      }
      const renewed = await withTransaction(
        this.requireDatabase(),
        [STORES.metadata, STORES.profiles, STORES.checkpoints],
        'readwrite',
        async (transaction) => {
          if (!(await getOne<Profile>(transaction.objectStore(STORES.profiles), checkpoint.profileId))) {
            failure('invalid', 'Checkpoint references a missing profile');
          }
          const refreshed = await renewLeaseForWrite(
            transaction.objectStore(STORES.metadata),
            token as OwnershipToken,
            this.now(),
            this.options.ownership?.ttlMs,
          );
          await this.write(STORES.checkpoints, 'put-checkpoint', checkpoint, () =>
            transaction.objectStore(STORES.checkpoints).put(checkpoint));
          return refreshed;
        },
      );
      this.ownedTokens.set(checkpoint.profileId, renewed);
    });
  }

  async getCheckpoint(sessionId: SessionId): Promise<RepositoryResult<ActiveCheckpoint | null>> {
    return attempt(async () => {
      const checkpoint = await withTransaction(this.requireDatabase(), [STORES.checkpoints], 'readonly', (transaction) =>
        getOne<ActiveCheckpoint>(transaction.objectStore(STORES.checkpoints), sessionId));
      return checkpoint ? requireValid('Stored checkpoint', validateActiveCheckpoint(checkpoint)) : null;
    });
  }

  async findLatestCheckpoint(profileId: ProfileId): Promise<RepositoryResult<ActiveCheckpoint | null>> {
    return attempt(async () => {
      const checkpoint = await withTransaction(this.requireDatabase(), [STORES.checkpoints], 'readonly', async (transaction) =>
        new Promise<ActiveCheckpoint | null>((resolve, reject) => {
          const request = transaction.objectStore(STORES.checkpoints)
            .index('byProfileCheckpointAt')
            .openCursor(prefixRange([profileId]), 'prev');
          request.onerror = () => reject(request.error ?? new DOMException('Checkpoint cursor failed', 'UnknownError'));
          request.onsuccess = () => resolve((request.result?.value as ActiveCheckpoint | undefined) ?? null);
        }));
      return checkpoint ? requireValid('Stored checkpoint', validateActiveCheckpoint(checkpoint)) : null;
    });
  }

  async deleteCheckpoint(sessionId: SessionId): Promise<RepositoryResult<void>> {
    return attempt(async () => {
      await withTransaction(this.requireDatabase(), [STORES.checkpoints], 'readwrite', async (transaction) => {
        await this.write(STORES.checkpoints, 'delete-checkpoint', sessionId, () =>
          transaction.objectStore(STORES.checkpoints).delete(sessionId));
      });
    });
  }

  async saveDocument(write: DocumentWrite): Promise<RepositoryResult<CustomDocument>> {
    return attempt(async () => {
      const document = requireValid('Custom document', validateCustomDocument(write.document));
      if (write.chunks.length !== document.chunkCount) failure('invalid', 'Document chunk count does not match metadata');
      for (const [index, value] of write.chunks.entries()) {
        const chunk = requireValid('Document chunk', validateDocumentChunk(value));
        if (chunk.documentId !== document.id || chunk.chunkIndex !== index) {
          failure('invalid', 'Document chunks must be sequential and owned by the document');
        }
      }
      await withTransaction(
        this.requireDatabase(),
        [STORES.profiles, STORES.customDocuments, STORES.documentChunks],
        'readwrite',
        async (transaction) => {
          if (!(await getOne<Profile>(transaction.objectStore(STORES.profiles), document.profileId))) {
            failure('invalid', 'Document references a missing profile');
          }
          const documents = transaction.objectStore(STORES.customDocuments);
          const chunks = transaction.objectStore(STORES.documentChunks);
          await this.write(STORES.customDocuments, 'put-document', document, () => documents.put(document));
          await deleteByCursor(chunks, prefixRange([document.id]));
          for (const chunk of write.chunks) {
            await this.write(STORES.documentChunks, 'put-document-chunk', chunk, () => chunks.put(chunk));
          }
        },
      );
      return document;
    });
  }

  async getDocument(documentId: DocumentId): Promise<RepositoryResult<CustomDocument>> {
    return attempt(async () => {
      const document = await withTransaction(this.requireDatabase(), [STORES.customDocuments], 'readonly', (transaction) =>
        getOne<CustomDocument>(transaction.objectStore(STORES.customDocuments), documentId));
      if (!document) failure('not-found', `Document not found: ${documentId}`);
      return requireValid('Stored document', validateCustomDocument(document));
    });
  }

  async listDocuments(profileId: ProfileId): Promise<RepositoryResult<CustomDocument[]>> {
    return attempt(async () => {
      const documents = await withTransaction(this.requireDatabase(), [STORES.customDocuments], 'readonly', (transaction) =>
        getAll<CustomDocument>(
          transaction.objectStore(STORES.customDocuments).index('byProfileCreatedAt'),
          prefixRange([profileId]),
        ));
      for (const document of documents) requireValid('Stored document', validateCustomDocument(document));
      return documents.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
    });
  }

  async getDocumentChunks(
    documentId: DocumentId,
    fromChunkIndex: number,
    maxChunks: number,
  ): Promise<RepositoryResult<DocumentChunk[]>> {
    return attempt(async () => {
      if (!Number.isSafeInteger(fromChunkIndex) || fromChunkIndex < 0
        || !Number.isSafeInteger(maxChunks) || maxChunks < 1 || maxChunks > MAX_DOCUMENT_CHUNKS_PER_READ) {
        failure('invalid', `Chunk reads require a nonnegative start and 1-${MAX_DOCUMENT_CHUNKS_PER_READ} chunks`);
      }
      const chunks = await withTransaction(this.requireDatabase(), [STORES.documentChunks], 'readonly', (transaction) =>
        requestResult<DocumentChunk[]>(transaction.objectStore(STORES.documentChunks).getAll(
          IDBKeyRange.bound([documentId, fromChunkIndex], [documentId, Number.MAX_SAFE_INTEGER]),
          maxChunks,
        )));
      for (const chunk of chunks) requireValid('Stored document chunk', validateDocumentChunk(chunk));
      return chunks;
    });
  }

  async deleteDocument(documentId: DocumentId): Promise<RepositoryResult<void>> {
    return attempt(async () => {
      await withTransaction(
        this.requireDatabase(),
        [STORES.customDocuments, STORES.documentChunks],
        'readwrite',
        async (transaction) => {
          const documents = transaction.objectStore(STORES.customDocuments);
          if (!(await getOne<CustomDocument>(documents, documentId))) failure('not-found', `Document not found: ${documentId}`);
          await requestResult(documents.delete(documentId));
          await deleteByCursor(transaction.objectStore(STORES.documentChunks), prefixRange([documentId]));
        },
      );
    });
  }

  async exportBackup(_options: {
    profileIds: ProfileId[];
    includeDocumentIds: DocumentId[];
  }): Promise<RepositoryResult<BackupEnvelope>> {
    return err(repositoryError('unsupported', 'Backup export is implemented in M16, not M04', false));
  }

  async importBackup(
    _envelope: BackupEnvelope,
    _options: ImportOptions,
  ): Promise<RepositoryResult<ImportOutcome>> {
    return err(repositoryError('unsupported', 'Backup import is implemented in M16, not M04', false));
  }
}
