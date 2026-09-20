/**
 * IndexedDB structural migrations for the browser repository.
 *
 * Upgrade steps are deliberately synchronous: IndexedDB keeps the
 * versionchange transaction active while these calls run and rolls the whole
 * schema back if a step throws.
 */

import { SCHEMA_VERSION } from '../../contracts/versions.js';

export const STORES = {
  metadata: 'metadata',
  profiles: 'profiles',
  sessions: 'sessions',
  sessionSeries: 'sessionSeries',
  sessionDaySlices: 'sessionDaySlices',
  sessionMistakes: 'sessionMistakes',
  sessionExposures: 'sessionExposures',
  lessonProgress: 'lessonProgress',
  dailyAggregates: 'dailyAggregates',
  profileCharacterStats: 'profileCharacterStats',
  customDocuments: 'customDocuments',
  documentChunks: 'documentChunks',
  checkpoints: 'checkpoints',
} as const;

export type StoreName = (typeof STORES)[keyof typeof STORES];

interface IndexDefinition {
  readonly name: string;
  readonly keyPath: string | readonly string[];
  readonly unique?: boolean;
}

interface StoreDefinition {
  readonly keyPath: string | readonly string[];
  readonly indexes: readonly IndexDefinition[];
}

/** Public for schema contract tests and future sequential migrations. */
export const STORE_SCHEMA: Readonly<Record<StoreName, StoreDefinition>> = {
  [STORES.metadata]: { keyPath: 'key', indexes: [] },
  [STORES.profiles]: {
    keyPath: 'id',
    indexes: [{ name: 'byUpdatedAt', keyPath: ['updatedAt', 'id'] }],
  },
  [STORES.sessions]: {
    keyPath: 'id',
    indexes: [
      { name: 'byProfileEndedAt', keyPath: ['profileId', 'endedAt', 'id'] },
      { name: 'byProfileModeEndedAt', keyPath: ['profileId', 'config.mode', 'endedAt', 'id'] },
    ],
  },
  [STORES.sessionSeries]: { keyPath: 'sessionId', indexes: [] },
  [STORES.sessionDaySlices]: {
    keyPath: ['sessionId', 'zone', 'day'],
    indexes: [
      { name: 'byProfileDay', keyPath: ['profileId', 'zone', 'day', 'sessionId'] },
      { name: 'byProfileSession', keyPath: ['profileId', 'sessionId'] },
    ],
  },
  [STORES.sessionMistakes]: {
    keyPath: ['sessionId', 'expected', 'attempted'],
    indexes: [{ name: 'byProfileSession', keyPath: ['profileId', 'sessionId'] }],
  },
  [STORES.sessionExposures]: {
    keyPath: ['sessionId', 'expected'],
    indexes: [{ name: 'byProfileSession', keyPath: ['profileId', 'sessionId'] }],
  },
  [STORES.lessonProgress]: {
    keyPath: ['profileId', 'curriculumVersion', 'lessonId'],
    indexes: [{ name: 'byProfile', keyPath: 'profileId' }],
  },
  [STORES.dailyAggregates]: {
    keyPath: ['profileId', 'zone', 'day', 'metricVersion'],
    indexes: [{ name: 'byProfileDay', keyPath: ['profileId', 'day', 'zone', 'metricVersion'] }],
  },
  [STORES.profileCharacterStats]: {
    keyPath: ['profileId', 'expected'],
    indexes: [{ name: 'byProfile', keyPath: 'profileId' }],
  },
  [STORES.customDocuments]: {
    keyPath: 'id',
    indexes: [{ name: 'byProfileCreatedAt', keyPath: ['profileId', 'createdAt', 'id'] }],
  },
  [STORES.documentChunks]: { keyPath: ['documentId', 'chunkIndex'], indexes: [] },
  [STORES.checkpoints]: {
    keyPath: 'sessionId',
    indexes: [{ name: 'byProfileCheckpointAt', keyPath: ['profileId', 'checkpointAt', 'sessionId'] }],
  },
};

export const STORE_NAMES = Object.values(STORES) as StoreName[];

export interface MigrationHooks {
  /** Test seam used to prove that a thrown migration rolls back completely. */
  beforeStep?(version: number): void;
}

type Migration = (database: IDBDatabase, transaction: IDBTransaction) => void;

function createStore(database: IDBDatabase, name: StoreName): IDBObjectStore {
  const definition = STORE_SCHEMA[name];
  const store = database.createObjectStore(name, {
    keyPath: typeof definition.keyPath === 'string' ? definition.keyPath : [...definition.keyPath],
  });
  for (const index of definition.indexes) {
    store.createIndex(
      index.name,
      typeof index.keyPath === 'string' ? index.keyPath : [...index.keyPath],
      { unique: index.unique ?? false },
    );
  }
  return store;
}

const migrations = new Map<number, Migration>([
  [1, (database) => {
    for (const name of STORE_NAMES) createStore(database, name);
  }],
]);

/** Apply every structural step `(oldVersion, newVersion]` in order. */
export function applyStructuralMigrations(
  database: IDBDatabase,
  transaction: IDBTransaction,
  oldVersion: number,
  newVersion: number,
  hooks: MigrationHooks = {},
): void {
  for (let version = oldVersion + 1; version <= newVersion; version += 1) {
    const migration = migrations.get(version);
    if (!migration) throw new Error(`Missing IndexedDB migration for schema version ${version}`);
    hooks.beforeStep?.(version);
    migration(database, transaction);
  }

  const metadata = transaction.objectStore(STORES.metadata);
  metadata.put({ key: 'schemaVersion', value: newVersion });
  metadata.put({ key: 'migrationStatus', value: { state: 'complete', version: newVersion } });
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new DOMException('IndexedDB request failed', 'UnknownError'));
  });
}

export async function readStoredVersion(database: IDBDatabase): Promise<number> {
  const transaction = database.transaction(STORES.metadata, 'readonly');
  const record = await requestValue<{ key: string; value: number } | undefined>(
    transaction.objectStore(STORES.metadata).get('schemaVersion'),
  );
  return record?.value ?? 0;
}

export async function checkMigrationStatus(database: IDBDatabase): Promise<{
  currentVersion: number;
  targetVersion: number;
  needsMigration: boolean;
  pendingMigrations: number[];
}> {
  const currentVersion = await readStoredVersion(database);
  const pendingMigrations: number[] = [];
  for (let version = currentVersion + 1; version <= SCHEMA_VERSION; version += 1) {
    pendingMigrations.push(version);
  }
  return {
    currentVersion,
    targetVersion: SCHEMA_VERSION,
    needsMigration: currentVersion < SCHEMA_VERSION,
    pendingMigrations,
  };
}
