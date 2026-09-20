/**
 * Mock repository — M02 FlashFinger shell.
 *
 * Implements the Repository interface but returns an explicit
 * `unavailable` result for every operation. Used when the real
 * persistence layer (IndexedDB / desktop journal) is not yet wired.
 *
 * See DESIGN_SPECIFICATION §2.2.
 */

import type {
  Repository,
  RepositoryResult,
  SessionQuery,
  SessionPage,
  SessionCommit,
  CommitOutcome,
  StorageStatus,
  RepositoryError,
  CharacterStatTotals,
  DocumentWrite,
  ImportOptions,
  ImportOutcome,
} from '../contracts/repository.js';
import type {
  SessionRecord,
  SessionSeries,
  Profile,
  ProfileId,
  ProfileSettings,
  InstallationSettings,
  LessonProgress,
  LessonId,
  DailyAggregate,
  DocumentId,
  CustomDocument,
  DocumentChunk,
  ActiveCheckpoint,
  BackupEnvelope,
} from '../contracts/models.js';

function makeUnavailable (extra?: string): RepositoryError {
  return {
    code: 'unavailable',
    message: 'Repository backend not yet connected',
    retryable: true,
    detail: extra,
  };
}

/**
 * A Repository implementation that rejects every operation with
 * `unavailable`. Suitable for M02 shell testing where persistence
 * is out of scope.
 */
export function createMockRepository (): Repository {
  const unavailable: RepositoryResult<never> = {
    ok: false,
    error: makeUnavailable(),
  };

  return {
    // lifecycle ---------------------------------------------------------
    initialize: () => Promise.resolve(unavailable),
    schemaVersion: () => Promise.resolve(unavailable),
    storageStatus: () =>
      Promise.resolve({
        ok: false,
        error: makeUnavailable(),
      }),

    // profiles ----------------------------------------------------------
    listProfiles: () => Promise.resolve(unavailable),
    createProfile: () => Promise.resolve(unavailable),
    updateProfile: () => Promise.resolve(unavailable),
    deleteProfile: () => Promise.resolve(unavailable),

    // settings ----------------------------------------------------------
    loadProfileSettings: () => Promise.resolve(unavailable),
    saveProfileSettings: () => Promise.resolve(unavailable),
    loadInstallationSettings: () => Promise.resolve(unavailable),
    saveInstallationSettings: () => Promise.resolve(unavailable),

    // sessions ----------------------------------------------------------
    querySessions: () => Promise.resolve(unavailable),
    getSession: () => Promise.resolve(unavailable),
    commitSession: () => Promise.resolve(unavailable),
    getSessionSeries: () => Promise.resolve(unavailable),

    // analytics ---------------------------------------------------------
    getLessonProgress: () => Promise.resolve(unavailable),
    getDailyAggregates: () => Promise.resolve(unavailable),
    rebuildAggregates: () => Promise.resolve(unavailable),
    getCharacterStats: () => Promise.resolve(unavailable),
    rebuildCharacterStats: () => Promise.resolve(unavailable),

    // checkpoints -------------------------------------------------------
    saveCheckpoint: () => Promise.resolve(unavailable),
    getCheckpoint: () => Promise.resolve(unavailable),
    findLatestCheckpoint: () => Promise.resolve(unavailable),
    deleteCheckpoint: () => Promise.resolve(unavailable),

    // documents ---------------------------------------------------------
    saveDocument: () => Promise.resolve(unavailable),
    getDocument: () => Promise.resolve(unavailable),
    listDocuments: () => Promise.resolve(unavailable),
    getDocumentChunks: () => Promise.resolve(unavailable),
    deleteDocument: () => Promise.resolve(unavailable),

    // backup ------------------------------------------------------------
    exportBackup: () => Promise.resolve(unavailable),
    importBackup: () => Promise.resolve(unavailable),
  };
}
