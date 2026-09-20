/** Low-level IndexedDB lifecycle and transaction helpers. */

import { SCHEMA_VERSION } from '../../contracts/versions.js';
import {
  applyStructuralMigrations,
  STORE_NAMES,
  STORE_SCHEMA,
  STORES,
  type MigrationHooks,
  type StoreName,
} from './migrations.js';

export { STORE_NAMES, STORE_SCHEMA as SCHEMA, STORES };
export type { StoreName };

export const DB_NAME = 'flashfinger-db';
export const DB_VERSION = SCHEMA_VERSION;

export interface OpenDatabaseOptions {
  readonly name?: string;
  readonly factory?: IDBFactory;
  readonly version?: number;
  readonly migrationHooks?: MigrationHooks;
}

function defaultFactory(): IDBFactory {
  if (typeof globalThis.indexedDB === 'undefined') {
    throw new DOMException('IndexedDB is not available in this context', 'NotSupportedError');
  }
  return globalThis.indexedDB;
}

/** Open the current schema. A failed migration rejects and is rolled back by IndexedDB. */
export function openDatabase(nameOrOptions: string | OpenDatabaseOptions = DB_NAME): Promise<IDBDatabase> {
  const options = typeof nameOrOptions === 'string' ? { name: nameOrOptions } : nameOrOptions;
  const name = options.name ?? DB_NAME;
  const version = options.version ?? DB_VERSION;

  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = (options.factory ?? defaultFactory()).open(name, version);
    } catch (error) {
      reject(error);
      return;
    }

    request.onupgradeneeded = (event) => {
      try {
        applyStructuralMigrations(
          request.result,
          request.transaction as IDBTransaction,
          event.oldVersion,
          event.newVersion ?? version,
          options.migrationHooks,
        );
      } catch (error) {
        try { request.transaction?.abort(); } catch { /* already aborting */ }
        reject(error);
      }
    };
    request.onerror = () => reject(
      request.error ?? new DOMException(`Could not open IndexedDB database ${name}`, 'UnknownError'),
    );
    request.onblocked = () => reject(
      new DOMException(`Opening IndexedDB database ${name} was blocked by another context`, 'InvalidStateError'),
    );
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
  });
}

export function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new DOMException('IndexedDB request failed', 'UnknownError'));
  });
}

export function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(
      transaction.error ?? new DOMException('IndexedDB transaction aborted', 'AbortError'),
    );
    transaction.onerror = () => {
      // `onabort` carries the final transaction result. Prevent bubbling only.
    };
  });
}

export async function withTransaction<T>(
  database: IDBDatabase,
  storeNames: readonly StoreName[],
  mode: IDBTransactionMode,
  work: (transaction: IDBTransaction) => Promise<T>,
): Promise<T> {
  const transaction = database.transaction([...storeNames], mode);
  const done = transactionDone(transaction);
  try {
    const value = await work(transaction);
    await done;
    return value;
  } catch (error) {
    try { transaction.abort(); } catch { /* transaction already completed/aborted */ }
    try { await done; } catch { /* preserve the original request/domain error */ }
    throw error;
  }
}

export function deleteDatabase(name: string, factory: IDBFactory = defaultFactory()): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = factory.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new DOMException('Could not delete IndexedDB', 'UnknownError'));
    request.onblocked = () => reject(new DOMException('Deleting IndexedDB was blocked', 'InvalidStateError'));
  });
}
