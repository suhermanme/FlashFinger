/** Main-process single-writer durable desktop Repository implementation. */

import { randomUUID } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
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
} from '../../src/contracts/models.js';
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
} from '../../src/contracts/repository.js';
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
} from '../../src/contracts/validation.js';
import { APP_BUILD, SCHEMA_VERSION } from '../../src/contracts/versions.js';
import {
  appendJournalRecord,
  discardTruncatedTail,
  JournalCorruptionError,
  readJournal,
  type JournalRecord,
} from './journal.js';
import {
  createEmptyState,
  validateDesktopState,
  type CharacterStatRow,
  type DesktopMutation,
  type DesktopRepositoryState,
} from './migrations.js';
import {
  compactSnapshot,
  JOURNAL_FILE,
  SNAPSHOT_FILE,
  resolveStoragePath,
  readSnapshot,
  type SnapshotFailureInjector,
} from './snapshot.js';

const MAX_SESSION_PAGE_SIZE = 200;
const MAX_DOCUMENT_CHUNKS_PER_READ = 200;
const RETAINED_SERIES_PER_PROFILE = 1_000;
export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;

export interface DesktopRepositoryOptions {
  rootDirectory: string;
  now?: () => number;
  randomUUID?: () => string;
  compactAfterRecords?: number;
  compactionFailures?: SnapshotFailureInjector;
  /** Test seam: runs after write but before fsync/ack when supplied by journal tests. */
  appendRecord?: typeof appendJournalRecord;
}

class RepositoryOperationError extends Error {
  constructor(readonly repositoryError: RepositoryError) {
    super(repositoryError.message);
    this.name = 'RepositoryOperationError';
  }
}

function repositoryError(
  code: RepositoryError['code'], message: string, retryable = false, detail?: string,
): RepositoryError {
  return detail === undefined ? { code, message, retryable } : { code, message, retryable, detail };
}

function failure(code: RepositoryError['code'], message: string, retryable = false, detail?: string): never {
  throw new RepositoryOperationError(repositoryError(code, message, retryable, detail));
}

function mapError(error: unknown): RepositoryError {
  if (error instanceof RepositoryOperationError) return error.repositoryError;
  if (error instanceof JournalCorruptionError) return repositoryError('corrupt', 'The desktop journal is damaged', false, error.message);
  const detail = error instanceof Error ? error.message : String(error);
  if (error instanceof Error && error.name === 'VersionTooNewError') {
    return repositoryError('version-too-new', 'Desktop data uses a newer storage version', false, detail);
  }
  if (error instanceof RangeError) return repositoryError('invalid', 'Desktop storage payload exceeds its limit', false, detail);
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'ENOSPC' || code === 'EDQUOT') return repositoryError('quota', 'Desktop storage is full', true, detail);
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return repositoryError('permission', 'Desktop storage access was denied', false, detail);
  if (code === 'ENOENT') return repositoryError('unavailable', 'Desktop storage path is unavailable', true, detail);
  return repositoryError('corrupt', 'The desktop repository operation failed', false, detail);
}

function attempt<T>(work: () => Promise<T>): Promise<RepositoryResult<T>> {
  return work().then(ok, (error: unknown) => err(mapError(error)));
}

function requireValid<T>(label: string, result: ValidationResult<T>): T {
  if (result.valid) return result.value;
  const detail = result.errors.slice(0, 8).map((item) => `${item.path}: ${item.message}`).join('; ');
  failure('invalid', `${label} failed validation`, false, detail);
}

function replaceByKey<T>(items: T[], value: T, key: (item: T) => string): void {
  const index = items.findIndex((item) => key(item) === key(value));
  if (index < 0) items.push(value); else items[index] = value;
}

function characterKey(row: CharacterStatRow): string { return JSON.stringify([row.profileId, row.expected]); }
function aggregateKey(row: DailyAggregate): string { return JSON.stringify([row.profileId, row.zone, row.day, row.metricVersion]); }
function progressKey(row: LessonProgress): string { return JSON.stringify([row.profileId, row.curriculumVersion, row.lessonId]); }
function sliceKey(row: SessionDaySlice): string { return JSON.stringify([row.sessionId, row.zone, row.day]); }
function mistakeKey(row: MistakeBucket): string { return JSON.stringify([row.sessionId, row.expected, row.attempted]); }
function exposureKey(row: CharacterExposure): string { return JSON.stringify([row.sessionId, row.expected]); }
function chunkKey(row: DocumentChunk): string { return JSON.stringify([row.documentId, row.chunkIndex]); }

function updateCharacterRows(
  state: DesktopRepositoryState,
  exposures: readonly CharacterExposure[],
  mistakes: readonly MistakeBucket[],
): void {
  const keys = new Set([...exposures.map((item) => item.expected), ...mistakes.map((item) => item.expected)]);
  for (const expected of keys) {
    const profileId = exposures.find((item) => item.expected === expected)?.profileId
      ?? mistakes.find((item) => item.expected === expected)?.profileId;
    if (!profileId) continue;
    const row = state.profileCharacterStats.find((item) => item.profileId === profileId && item.expected === expected)
      ?? { profileId, expected, attempts: 0, errors: 0, mistakes: {} };
    for (const exposure of exposures.filter((item) => item.expected === expected)) {
      row.attempts += exposure.attempts;
      row.errors += exposure.errors;
    }
    for (const mistake of mistakes.filter((item) => item.expected === expected)) {
      row.mistakes[mistake.attempted] = (row.mistakes[mistake.attempted] ?? 0) + mistake.count;
    }
    replaceByKey(state.profileCharacterStats, row, characterKey);
  }
}

function applyMutation(state: DesktopRepositoryState, mutation: DesktopMutation): void {
  switch (mutation.kind) {
    case 'create-profile':
      if (state.profiles.some((item) => item.id === mutation.profile.id)) throw new Error('Duplicate profile in journal');
      state.profiles.push(mutation.profile);
      return;
    case 'update-profile': replaceByKey(state.profiles, mutation.profile, (item) => item.id); return;
    case 'delete-profile': {
      const sessionIds = new Set(state.sessions.filter((item) => item.profileId === mutation.profileId).map((item) => item.id));
      const documentIds = new Set(state.customDocuments.filter((item) => item.profileId === mutation.profileId).map((item) => item.id));
      state.profiles = state.profiles.filter((item) => item.id !== mutation.profileId);
      state.sessions = state.sessions.filter((item) => item.profileId !== mutation.profileId);
      state.sessionSeries = state.sessionSeries.filter((item) => !sessionIds.has(item.sessionId));
      state.sessionDaySlices = state.sessionDaySlices.filter((item) => item.profileId !== mutation.profileId);
      state.sessionMistakes = state.sessionMistakes.filter((item) => item.profileId !== mutation.profileId);
      state.sessionExposures = state.sessionExposures.filter((item) => item.profileId !== mutation.profileId);
      state.lessonProgress = state.lessonProgress.filter((item) => item.profileId !== mutation.profileId);
      state.dailyAggregates = state.dailyAggregates.filter((item) => item.profileId !== mutation.profileId);
      state.profileCharacterStats = state.profileCharacterStats.filter((item) => item.profileId !== mutation.profileId);
      state.checkpoints = state.checkpoints.filter((item) => item.profileId !== mutation.profileId);
      state.customDocuments = state.customDocuments.filter((item) => item.profileId !== mutation.profileId);
      state.documentChunks = state.documentChunks.filter((item) => !documentIds.has(item.documentId));
      if (state.installationSettings?.activeProfileId === mutation.profileId) {
        state.installationSettings = { ...state.installationSettings, activeProfileId: null };
      }
      return;
    }
    case 'save-installation-settings': state.installationSettings = mutation.settings; return;
    case 'commit-session': {
      const commit = mutation.commit;
      if (state.sessions.some((item) => item.id === commit.session.id)) return;
      state.sessions.push(commit.session);
      if (commit.series) replaceByKey(state.sessionSeries, commit.series, (item) => item.sessionId);
      commit.daySlices.forEach((item) => replaceByKey(state.sessionDaySlices, item, sliceKey));
      commit.mistakes.forEach((item) => replaceByKey(state.sessionMistakes, item, mistakeKey));
      commit.exposures.forEach((item) => replaceByKey(state.sessionExposures, item, exposureKey));
      (commit.lessonProgress ?? []).forEach((item) => replaceByKey(state.lessonProgress, item, progressKey));
      (commit.aggregateChanges ?? []).forEach((item) => replaceByKey(state.dailyAggregates, item, aggregateKey));
      if (commit.updateProfileCharacterStats) updateCharacterRows(state, commit.exposures, commit.mistakes);
      if (commit.removeCheckpointId) state.checkpoints = state.checkpoints.filter((item) => item.sessionId !== commit.removeCheckpointId);
      const retained = state.sessions.filter((item) => item.profileId === commit.session.profileId)
        .sort((left, right) => right.endedAt.localeCompare(left.endedAt) || right.id.localeCompare(left.id))
        .slice(0, RETAINED_SERIES_PER_PROFILE);
      const retainedIds = new Set(retained.map((item) => item.id));
      state.sessionSeries = state.sessionSeries.filter((item) => {
        const session = state.sessions.find((candidate) => candidate.id === item.sessionId);
        return session?.profileId !== commit.session.profileId || retainedIds.has(item.sessionId);
      });
      return;
    }
    case 'replace-aggregates':
      state.dailyAggregates = state.dailyAggregates.filter((item) => item.profileId !== mutation.profileId).concat(mutation.rows);
      return;
    case 'replace-character-stats':
      state.profileCharacterStats = state.profileCharacterStats.filter((item) => item.profileId !== mutation.profileId).concat(mutation.rows);
      return;
    case 'reset-character-stats':
      state.sessionMistakes = state.sessionMistakes.filter((item) => item.profileId !== mutation.profileId);
      state.sessionExposures = state.sessionExposures.filter((item) => item.profileId !== mutation.profileId);
      state.profileCharacterStats = state.profileCharacterStats.filter((item) => item.profileId !== mutation.profileId);
      return;
    case 'save-checkpoint': replaceByKey(state.checkpoints, mutation.checkpoint, (item) => item.sessionId); return;
    case 'delete-checkpoint': state.checkpoints = state.checkpoints.filter((item) => item.sessionId !== mutation.sessionId); return;
    case 'save-document':
      replaceByKey(state.customDocuments, mutation.document, (item) => item.id);
      state.documentChunks = state.documentChunks.filter((item) => item.documentId !== mutation.document.id);
      mutation.chunks.forEach((item) => replaceByKey(state.documentChunks, item, chunkKey));
      return;
    case 'delete-document':
      state.customDocuments = state.customDocuments.filter((item) => item.id !== mutation.documentId);
      state.documentChunks = state.documentChunks.filter((item) => item.documentId !== mutation.documentId);
      return;
    default: throw new Error('Unknown desktop journal mutation');
  }
}

interface SessionCursor { v: 1; signature: string; endedAt: string; id: string }
function querySignature(query: SessionQuery): string {
  return JSON.stringify({ profileId: query.profileId, mode: query.mode ?? null, from: query.from ?? null,
    to: query.to ?? null, includeIneligible: query.includeIneligible ?? false });
}
function encodeCursor(cursor: SessionCursor): string { return Buffer.from(JSON.stringify(cursor)).toString('base64url'); }
function decodeCursor(value: string, signature: string): SessionCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<SessionCursor>;
    if (parsed.v !== 1 || parsed.signature !== signature || typeof parsed.endedAt !== 'string' || typeof parsed.id !== 'string') {
      failure('invalid', 'The session cursor does not belong to this query');
    }
    return parsed as SessionCursor;
  } catch (error) {
    if (error instanceof RepositoryOperationError) throw error;
    failure('invalid', 'The session cursor is malformed');
  }
}

function sum(values: readonly number[]): number { return values.reduce((total, value) => total + value, 0); }

function validateCommit(commit: SessionCommit): void {
  const session = requireValid('Session', validateSessionRecord(commit.session));
  const metricGate = checkMetricVersion(session.config.metricVersion);
  if (!metricGate.ok) throw new RepositoryOperationError(metricGate.error);
  if (commit.series) {
    const series = requireValid('Session series', validateSessionSeries(commit.series));
    if (series.sessionId !== session.id) failure('invalid', 'Session series belongs to another session');
  }
  const slices = commit.daySlices.map((item) => requireValid('Session day slice', validateSessionDaySlice(item)));
  if (slices.length === 0) failure('invalid', 'A finalized session requires at least one day slice');
  for (const slice of slices) if (slice.sessionId !== session.id || slice.profileId !== session.profileId) {
    failure('invalid', 'A day slice belongs to another session or profile');
  }
  const totals = {
    activeMs: sum(slices.map((item) => item.activeMs)), attempts: sum(slices.map((item) => item.attempts)),
    correctAttempts: sum(slices.map((item) => item.correctAttempts)), errorAttempts: sum(slices.map((item) => item.errorAttempts)),
    completedWords: sum(slices.map((item) => item.completedWords)), eligibleActiveMs: sum(slices.map((item) => item.eligibleActiveMs)),
    eligibleRetainedCorrect: sum(slices.map((item) => item.eligibleRetainedCorrect)),
  };
  if (totals.activeMs !== session.activeMs || totals.attempts !== session.attempts
    || totals.correctAttempts !== session.correctAttempts || totals.errorAttempts !== session.errorAttempts
    || totals.completedWords !== session.completedWords) failure('invalid', 'Day-slice counters do not equal the finalized session');
  if (totals.eligibleActiveMs !== (session.eligibleForBest ? session.activeMs : 0)
    || totals.eligibleRetainedCorrect !== (session.eligibleForBest ? session.retainedCorrect : 0)) {
    failure('invalid', 'Day-slice eligible counters do not match session eligibility');
  }
  commit.mistakes.forEach((item) => {
    const row = requireValid('Mistake bucket', validateMistakeBucket(item));
    if (row.sessionId !== session.id || row.profileId !== session.profileId) failure('invalid', 'Mistake belongs to another session');
  });
  commit.exposures.forEach((item) => {
    const row = requireValid('Character exposure', validateCharacterExposure(item));
    if (row.sessionId !== session.id || row.profileId !== session.profileId) failure('invalid', 'Exposure belongs to another session');
  });
  (commit.lessonProgress ?? []).forEach((item) => {
    const row = requireValid('Lesson progress', validateLessonProgress(item));
    if (row.profileId !== session.profileId) failure('invalid', 'Lesson progress belongs to another profile');
  });
  (commit.aggregateChanges ?? []).forEach((item) => {
    const row = requireValid('Daily aggregate', validateDailyAggregate(item));
    if (row.profileId !== session.profileId) failure('invalid', 'Aggregate belongs to another profile');
  });
  if (commit.removeCheckpointId !== undefined && commit.removeCheckpointId !== session.id) {
    failure('invalid', 'Finalization may only remove the finalized session checkpoint');
  }
}

export class DesktopRepository implements Repository {
  private state: DesktopRepositoryState | null = null;
  private sequence = 0;
  private generation = 0;
  private journalRecords = 0;
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly makeUuid: () => string;
  private readonly compactAfterRecords: number;
  private readonly appendRecord: typeof appendJournalRecord;

  constructor(private readonly options: DesktopRepositoryOptions) {
    this.now = options.now ?? (() => Date.now());
    this.makeUuid = options.randomUUID ?? randomUUID;
    this.compactAfterRecords = options.compactAfterRecords ?? 128;
    this.appendRecord = options.appendRecord ?? appendJournalRecord;
  }

  private requireState(): DesktopRepositoryState {
    if (!this.state) failure('unavailable', 'The desktop repository is not initialized', true);
    return this.state;
  }

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(work, work);
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async persist(mutation: DesktopMutation): Promise<void> {
    await this.serialized(async () => {
      const state = this.requireState();
      const next = structuredClone(state);
      applyMutation(next, mutation);
      validateDesktopState(next);
      const record: JournalRecord = { schemaVersion: SCHEMA_VERSION, sequence: this.sequence + 1, mutation };
      await this.appendRecord(resolveStoragePath(this.options.rootDirectory, JOURNAL_FILE), record);
      // In-memory visibility and acknowledgement happen only after fsync resolves.
      this.state = next;
      this.sequence = record.sequence;
      this.journalRecords += 1;
      if (this.compactAfterRecords > 0 && this.journalRecords >= this.compactAfterRecords) {
        try { await this.compactInternal(); } catch { /* journal is already durable; retry compaction later */ }
      }
    });
  }

  private async persistSession(commit: SessionCommit): Promise<boolean> {
    return this.serialized(async () => {
      const state = this.requireState();
      if (state.sessions.some((item) => item.id === commit.session.id)) return false;
      if (!state.profiles.some((item) => item.id === commit.session.profileId)) failure('invalid', 'Session references a missing profile');
      for (const progress of commit.lessonProgress ?? []) for (const id of progress.qualifyingSessionIds) {
        if (id !== commit.session.id && !state.sessions.some((item) => item.id === id)) {
          failure('invalid', `Lesson progress references missing session ${id}`);
        }
      }
      const next = structuredClone(state);
      const mutation: DesktopMutation = { kind: 'commit-session', commit };
      applyMutation(next, mutation);
      validateDesktopState(next);
      const record: JournalRecord = { schemaVersion: SCHEMA_VERSION, sequence: this.sequence + 1, mutation };
      await this.appendRecord(resolveStoragePath(this.options.rootDirectory, JOURNAL_FILE), record);
      this.state = next;
      this.sequence = record.sequence;
      this.journalRecords += 1;
      if (this.compactAfterRecords > 0 && this.journalRecords >= this.compactAfterRecords) {
        try { await this.compactInternal(); } catch { /* journal is already durable; retry compaction later */ }
      }
      return true;
    });
  }

  async initialize(): Promise<RepositoryResult<void>> {
    if (this.state) return ok(undefined);
    return attempt(() => this.serialized(async () => {
      if (this.state) return;
      await mkdir(this.options.rootDirectory, { recursive: true });
      const snapshot = await readSnapshot(resolveStoragePath(this.options.rootDirectory, SNAPSHOT_FILE));
      const replay = await readJournal(resolveStoragePath(this.options.rootDirectory, JOURNAL_FILE));
      let state = snapshot?.state ?? createEmptyState();
      let sequence = snapshot?.lastSequence ?? 0;
      let previousRecordSequence = 0;
      for (const record of replay.records) {
        if (record.sequence <= previousRecordSequence) throw new JournalCorruptionError('Journal sequence is not strictly increasing');
        previousRecordSequence = record.sequence;
        if (record.sequence <= sequence) continue;
        if (record.sequence !== sequence + 1) throw new JournalCorruptionError('Journal sequence has a gap');
        applyMutation(state, record.mutation);
        sequence = record.sequence;
      }
      state = validateDesktopState(state);
      if (replay.truncatedTail) {
        await discardTruncatedTail(resolveStoragePath(this.options.rootDirectory, JOURNAL_FILE), replay.validBytes);
      }
      this.state = state;
      this.sequence = sequence;
      this.generation = snapshot?.generation ?? 0;
      this.journalRecords = replay.records.filter((item) => item.sequence > (snapshot?.lastSequence ?? 0)).length;
    }));
  }

  async compact(): Promise<RepositoryResult<void>> {
    return attempt(() => this.serialized(() => this.compactInternal()));
  }

  private async compactInternal(): Promise<void> {
    const state = this.requireState();
    await compactSnapshot(this.options.rootDirectory, {
      state,
      generation: this.generation + 1,
      lastSequence: this.sequence,
    }, this.options.compactionFailures);
    this.generation += 1;
    this.journalRecords = 0;
  }

  async schemaVersion(): Promise<RepositoryResult<number>> { return attempt(async () => this.requireState().schemaVersion); }

  async storageStatus(): Promise<RepositoryResult<StorageStatus>> {
    return attempt(async () => {
      this.requireState();
      const paths = [SNAPSHOT_FILE, JOURNAL_FILE].map((name) => resolveStoragePath(this.options.rootDirectory, name));
      let usageBytes = 0;
      for (const filePath of paths) {
        try { usageBytes += (await stat(filePath)).size; } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      return { available: true, persisted: true, quotaBytes: null, usageBytes, mode: 'durable' };
    });
  }

  async listProfiles(): Promise<RepositoryResult<Profile[]>> {
    return attempt(async () => structuredClone(this.requireState().profiles)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)));
  }

  async createProfile(input: { name: string; avatarToken: string; analyticsZone: string; settings: ProfileSettings }): Promise<RepositoryResult<Profile>> {
    return attempt(async () => {
      requireValid('Profile settings', validateProfileSettings(input.settings));
      const timestamp = new Date(this.now()).toISOString();
      const profile: Profile = { id: this.makeUuid(), ...input, createdAt: timestamp, updatedAt: timestamp, revision: 0 };
      requireValid('Profile', validateProfile(profile));
      await this.persist({ kind: 'create-profile', profile });
      return profile;
    });
  }

  async updateProfile(profile: Profile): Promise<RepositoryResult<Profile>> {
    return attempt(async () => {
      requireValid('Profile', validateProfile(profile));
      const current = this.requireState().profiles.find((item) => item.id === profile.id);
      if (!current) failure('not-found', `Profile not found: ${profile.id}`);
      if (current.revision !== profile.revision) failure('conflict', 'The profile revision is stale', true);
      const updated: Profile = { ...profile, createdAt: current.createdAt, updatedAt: new Date(this.now()).toISOString(), revision: current.revision + 1 };
      requireValid('Updated profile', validateProfile(updated));
      await this.persist({ kind: 'update-profile', profile: updated });
      return updated;
    });
  }

  async deleteProfile(profileId: ProfileId): Promise<RepositoryResult<void>> {
    return attempt(async () => {
      if (!this.requireState().profiles.some((item) => item.id === profileId)) failure('not-found', `Profile not found: ${profileId}`);
      await this.persist({ kind: 'delete-profile', profileId });
    });
  }

  async loadProfileSettings(profileId: ProfileId): Promise<RepositoryResult<ProfileSettings>> {
    return attempt(async () => {
      const profile = this.requireState().profiles.find((item) => item.id === profileId);
      if (!profile) failure('not-found', `Profile not found: ${profileId}`);
      return structuredClone(profile.settings);
    });
  }

  async saveProfileSettings(profileId: ProfileId, settings: ProfileSettings): Promise<RepositoryResult<void>> {
    return attempt(async () => {
      requireValid('Profile settings', validateProfileSettings(settings));
      const profile = this.requireState().profiles.find((item) => item.id === profileId);
      if (!profile) failure('not-found', `Profile not found: ${profileId}`);
      const updated = { ...profile, settings, updatedAt: new Date(this.now()).toISOString(), revision: profile.revision + 1 };
      await this.persist({ kind: 'update-profile', profile: updated });
    });
  }

  async loadInstallationSettings(): Promise<RepositoryResult<InstallationSettings>> {
    return attempt(async () => structuredClone(this.requireState().installationSettings ?? {
      schemaVersion: SCHEMA_VERSION, activeProfileId: null, lastResolvedTheme: 'light', appBuild: APP_BUILD, onboardingComplete: false,
    }));
  }

  async saveInstallationSettings(settings: InstallationSettings): Promise<RepositoryResult<void>> {
    return attempt(async () => {
      requireValid('Installation settings', validateInstallationSettings(settings));
      if (settings.schemaVersion !== SCHEMA_VERSION) failure('invalid', 'Installation settings use the wrong schema version');
      if (settings.activeProfileId && !this.requireState().profiles.some((item) => item.id === settings.activeProfileId)) {
        failure('invalid', 'Installation settings reference a missing active profile');
      }
      await this.persist({ kind: 'save-installation-settings', settings });
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
      const rows = this.requireState().sessions.filter((item) => item.profileId === query.profileId
        && (!query.mode || item.config.mode === query.mode)
        && (!query.from || item.endedAt >= query.from) && (!query.to || item.endedAt < query.to)
        && (query.includeIneligible || item.eligibleForBest))
        .sort((a, b) => b.endedAt.localeCompare(a.endedAt) || b.id.localeCompare(a.id))
        .filter((item) => !cursor || item.endedAt < cursor.endedAt || (item.endedAt === cursor.endedAt && item.id < cursor.id));
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return { sessions: structuredClone(page), nextCursor: rows.length > query.limit && last
        ? encodeCursor({ v: 1, signature, endedAt: last.endedAt, id: last.id }) : null };
    });
  }

  async getSession(sessionId: SessionId): Promise<RepositoryResult<SessionRecord>> {
    return attempt(async () => {
      const value = this.requireState().sessions.find((item) => item.id === sessionId);
      if (!value) failure('not-found', `Session not found: ${sessionId}`);
      return structuredClone(value);
    });
  }

  async commitSession(commit: SessionCommit): Promise<RepositoryResult<CommitOutcome>> {
    return attempt(async () => {
      validateCommit(commit);
      const committed = await this.persistSession(commit);
      return { alreadyCommitted: !committed, sessionId: commit.session.id };
    });
  }

  async getSessionSeries(sessionId: SessionId): Promise<RepositoryResult<SessionSeries | null>> {
    return attempt(async () => structuredClone(this.requireState().sessionSeries.find((item) => item.sessionId === sessionId) ?? null));
  }

  async getLessonProgress(profileId: ProfileId, curriculumVersion: string): Promise<RepositoryResult<LessonProgress[]>> {
    return attempt(async () => structuredClone(this.requireState().lessonProgress.filter((item) => item.profileId === profileId && item.curriculumVersion === curriculumVersion)));
  }

  async getDailyAggregates(profileId: ProfileId, from: string, to: string): Promise<RepositoryResult<DailyAggregate[]>> {
    return attempt(async () => {
      if (from >= to) failure('invalid', 'Aggregate date range is empty');
      return structuredClone(this.requireState().dailyAggregates.filter((item) => item.profileId === profileId && item.day >= from && item.day < to)
        .sort((a, b) => a.day.localeCompare(b.day) || a.zone.localeCompare(b.zone)));
    });
  }

  async rebuildAggregates(profileId: ProfileId): Promise<RepositoryResult<void>> {
    return attempt(async () => {
      const state = this.requireState();
      if (!state.profiles.some((item) => item.id === profileId)) failure('not-found', `Profile not found: ${profileId}`);
      const sessions = new Map(state.sessions.filter((item) => item.profileId === profileId).map((item) => [item.id, item]));
      const aggregates = new Map<string, DailyAggregate>();
      for (const slice of state.sessionDaySlices.filter((item) => item.profileId === profileId)) {
        const session = sessions.get(slice.sessionId);
        if (!session) failure('corrupt', `Day slice references missing session ${slice.sessionId}`);
        const key = JSON.stringify([slice.zone, slice.day, session.config.metricVersion]);
        const row = aggregates.get(key) ?? { profileId, day: slice.day, zone: slice.zone, metricVersion: session.config.metricVersion,
          activeMs: 0, attempts: 0, correctAttempts: 0, errorAttempts: 0, completedWords: 0, eligibleActiveMs: 0,
          eligibleRetainedCorrect: 0, eligibleSessionCount: 0, bestWpm: null, revision: 0 };
        row.activeMs += slice.activeMs; row.attempts += slice.attempts; row.correctAttempts += slice.correctAttempts;
        row.errorAttempts += slice.errorAttempts; row.completedWords += slice.completedWords;
        row.eligibleActiveMs += slice.eligibleActiveMs; row.eligibleRetainedCorrect += slice.eligibleRetainedCorrect;
        if (slice.eligibleActiveMs > 0) {
          row.eligibleSessionCount += 1;
          if (session.adjustedWpm !== null) row.bestWpm = row.bestWpm === null ? session.adjustedWpm : Math.max(row.bestWpm, session.adjustedWpm);
        }
        aggregates.set(key, row);
      }
      const rows = [...aggregates.values()];
      rows.forEach((item) => requireValid('Rebuilt aggregate', validateDailyAggregate(item)));
      await this.persist({ kind: 'replace-aggregates', profileId, rows });
    });
  }

  async getCharacterStats(profileId: ProfileId): Promise<RepositoryResult<CharacterStatTotals>> {
    return attempt(async () => {
      const rows = this.requireState().profileCharacterStats.filter((item) => item.profileId === profileId)
        .sort((a, b) => a.expected.localeCompare(b.expected));
      return { exposures: rows.map(({ expected, attempts, errors }) => ({ expected, attempts, errors })),
        mistakes: rows.flatMap((row) => Object.entries(row.mistakes).sort(([a], [b]) => a.localeCompare(b))
          .map(([attempted, count]) => ({ expected: row.expected, attempted, count }))) };
    });
  }

  async rebuildCharacterStats(profileId: ProfileId): Promise<RepositoryResult<void>> {
    return attempt(async () => {
      const state = this.requireState();
      if (!state.profiles.some((item) => item.id === profileId)) failure('not-found', `Profile not found: ${profileId}`);
      const temporary = createEmptyState();
      updateCharacterRows(temporary, state.sessionExposures.filter((item) => item.profileId === profileId),
        state.sessionMistakes.filter((item) => item.profileId === profileId));
      await this.persist({ kind: 'replace-character-stats', profileId, rows: temporary.profileCharacterStats });
    });
  }

  async resetCharacterStats(profileId: ProfileId): Promise<RepositoryResult<void>> {
    return attempt(async () => {
      const state = this.requireState();
      if (!state.profiles.some((item) => item.id === profileId)) failure('not-found', `Profile not found: ${profileId}`);
      await this.persist({ kind: 'reset-character-stats', profileId });
    });
  }

  async saveCheckpoint(checkpoint: ActiveCheckpoint): Promise<RepositoryResult<void>> {
    return attempt(async () => {
      requireValid('Checkpoint', validateActiveCheckpoint(checkpoint));
      if (!this.requireState().profiles.some((item) => item.id === checkpoint.profileId)) failure('invalid', 'Checkpoint references a missing profile');
      await this.persist({ kind: 'save-checkpoint', checkpoint });
    });
  }

  async getCheckpoint(sessionId: SessionId): Promise<RepositoryResult<ActiveCheckpoint | null>> {
    return attempt(async () => structuredClone(this.requireState().checkpoints.find((item) => item.sessionId === sessionId) ?? null));
  }

  async findLatestCheckpoint(profileId: ProfileId): Promise<RepositoryResult<ActiveCheckpoint | null>> {
    return attempt(async () => structuredClone(this.requireState().checkpoints.filter((item) => item.profileId === profileId)
      .sort((a, b) => b.checkpointAt.localeCompare(a.checkpointAt) || b.sessionId.localeCompare(a.sessionId))[0] ?? null));
  }

  async deleteCheckpoint(sessionId: SessionId): Promise<RepositoryResult<void>> {
    return attempt(async () => { await this.persist({ kind: 'delete-checkpoint', sessionId }); });
  }

  async saveDocument(write: DocumentWrite): Promise<RepositoryResult<CustomDocument>> {
    return attempt(async () => {
      const document = requireValid('Custom document', validateCustomDocument(write.document));
      if (document.byteLength > MAX_DOCUMENT_BYTES) failure('invalid', 'Document exceeds the 5 MiB limit');
      if (write.chunks.length !== document.chunkCount) failure('invalid', 'Document chunk count does not match metadata');
      let byteLength = 0;
      write.chunks.forEach((value, index) => {
        const chunk = requireValid('Document chunk', validateDocumentChunk(value));
        if (chunk.documentId !== document.id || chunk.chunkIndex !== index) failure('invalid', 'Document chunks must be sequential and owned');
        byteLength += Buffer.byteLength(chunk.text, 'utf8');
      });
      if (byteLength !== document.byteLength || byteLength > MAX_DOCUMENT_BYTES) failure('invalid', 'Document byte length is invalid');
      if (!this.requireState().profiles.some((item) => item.id === document.profileId)) failure('invalid', 'Document references a missing profile');
      await this.persist({ kind: 'save-document', document, chunks: write.chunks });
      return document;
    });
  }

  async getDocument(documentId: DocumentId): Promise<RepositoryResult<CustomDocument>> {
    return attempt(async () => {
      const document = this.requireState().customDocuments.find((item) => item.id === documentId);
      if (!document) failure('not-found', `Document not found: ${documentId}`);
      return structuredClone(document);
    });
  }

  async listDocuments(profileId: ProfileId): Promise<RepositoryResult<CustomDocument[]>> {
    return attempt(async () => structuredClone(this.requireState().customDocuments.filter((item) => item.profileId === profileId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))));
  }

  async getDocumentChunks(documentId: DocumentId, fromChunkIndex: number, maxChunks: number): Promise<RepositoryResult<DocumentChunk[]>> {
    return attempt(async () => {
      if (!Number.isSafeInteger(fromChunkIndex) || fromChunkIndex < 0 || !Number.isSafeInteger(maxChunks)
        || maxChunks < 1 || maxChunks > MAX_DOCUMENT_CHUNKS_PER_READ) failure('invalid', 'Chunk read bounds are invalid');
      return structuredClone(this.requireState().documentChunks.filter((item) => item.documentId === documentId && item.chunkIndex >= fromChunkIndex)
        .sort((a, b) => a.chunkIndex - b.chunkIndex).slice(0, maxChunks));
    });
  }

  async deleteDocument(documentId: DocumentId): Promise<RepositoryResult<void>> {
    return attempt(async () => {
      if (!this.requireState().customDocuments.some((item) => item.id === documentId)) failure('not-found', `Document not found: ${documentId}`);
      await this.persist({ kind: 'delete-document', documentId });
    });
  }

  async exportBackup(_options: { profileIds: ProfileId[]; includeDocumentIds: DocumentId[] }): Promise<RepositoryResult<BackupEnvelope>> {
    return err(repositoryError('unsupported', 'Backup export is implemented in M16, not M05'));
  }

  async importBackup(_envelope: BackupEnvelope, _options: ImportOptions): Promise<RepositoryResult<ImportOutcome>> {
    return err(repositoryError('unsupported', 'Backup import is implemented in M16, not M05'));
  }
}
