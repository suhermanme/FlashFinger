/** Checksummed desktop snapshot IO and crash-safe compaction primitives. */

import { createHash } from 'node:crypto';
import { copyFile, mkdir, open, readFile, rename, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { SCHEMA_VERSION } from '../../src/contracts/versions.js';
import { migrateDesktopState, type DesktopRepositoryState } from './migrations.js';

export const SNAPSHOT_FORMAT_VERSION = 1;
export const SNAPSHOT_FILE = 'repository.snapshot.json';
export const PREVIOUS_SNAPSHOT_FILE = 'repository.snapshot.previous.json';
export const SNAPSHOT_TEMP_FILE = 'repository.snapshot.tmp';
export const JOURNAL_FILE = 'repository.journal';
export const PREVIOUS_JOURNAL_FILE = 'repository.journal.previous';
export const JOURNAL_TEMP_FILE = 'repository.journal.tmp';
export const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;

interface SnapshotCore {
  formatVersion: number;
  schemaVersion: number;
  generation: number;
  lastSequence: number;
  state: DesktopRepositoryState;
}

interface SnapshotEnvelope extends SnapshotCore { checksum: string }

export interface LoadedSnapshot {
  state: DesktopRepositoryState;
  generation: number;
  lastSequence: number;
}

export function resolveStoragePath(root: string, fileName: string): string {
  if (path.basename(fileName) !== fileName || fileName === '.' || fileName === '..') {
    throw new Error('Storage path is not a confined file name');
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, fileName);
  if (path.dirname(resolved) !== resolvedRoot) throw new Error('Storage path escapes the repository root');
  return resolved;
}

function hashCore(core: SnapshotCore): string {
  return createHash('sha256').update(JSON.stringify(core), 'utf8').digest('hex');
}

export function serializeSnapshot(snapshot: LoadedSnapshot): Buffer {
  const core: SnapshotCore = {
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    generation: snapshot.generation,
    lastSequence: snapshot.lastSequence,
    state: snapshot.state,
  };
  const bytes = Buffer.from(JSON.stringify({ ...core, checksum: hashCore(core) } satisfies SnapshotEnvelope), 'utf8');
  if (bytes.byteLength > MAX_SNAPSHOT_BYTES) throw new RangeError('Desktop snapshot exceeds the payload limit');
  return bytes;
}

export async function readSnapshot(filePath: string): Promise<LoadedSnapshot | null> {
  let bytes: Buffer;
  try {
    const info = await stat(filePath);
    if (info.size > MAX_SNAPSHOT_BYTES) throw new Error('Desktop snapshot exceeds the payload limit');
    bytes = await readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Desktop snapshot is not valid JSON'); }
  if (!parsed || typeof parsed !== 'object') throw new Error('Desktop snapshot envelope is invalid');
  const envelope = parsed as Partial<SnapshotEnvelope>;
  if (envelope.formatVersion !== SNAPSHOT_FORMAT_VERSION) {
    if (typeof envelope.formatVersion === 'number' && envelope.formatVersion > SNAPSHOT_FORMAT_VERSION) {
      const error = new Error(`Snapshot format ${envelope.formatVersion} is newer than supported ${SNAPSHOT_FORMAT_VERSION}`);
      error.name = 'VersionTooNewError';
      throw error;
    }
    throw new Error('Unsupported desktop snapshot format');
  }
  if (!Number.isSafeInteger(envelope.schemaVersion) || !Number.isSafeInteger(envelope.generation)
    || !Number.isSafeInteger(envelope.lastSequence) || typeof envelope.checksum !== 'string') {
    throw new Error('Desktop snapshot metadata is invalid');
  }
  const core: SnapshotCore = {
    formatVersion: envelope.formatVersion,
    schemaVersion: envelope.schemaVersion as number,
    generation: envelope.generation as number,
    lastSequence: envelope.lastSequence as number,
    state: envelope.state as DesktopRepositoryState,
  };
  if (hashCore(core) !== envelope.checksum) throw new Error('Desktop snapshot checksum mismatch');
  return {
    state: migrateDesktopState(core.state, core.schemaVersion),
    generation: core.generation,
    lastSequence: core.lastSequence,
  };
}

async function syncDirectory(root: string): Promise<void> {
  const handle = await open(root, 'r');
  try {
    await handle.sync().catch((error: NodeJS.ErrnoException) => {
      if (!['EINVAL', 'ENOTSUP', 'EBADF'].includes(error.code ?? '')) throw error;
    });
  } finally { await handle.close(); }
}

async function writeSynced(filePath: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(filePath, 'w');
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

export type CompactionFailurePoint =
  | 'after-snapshot-temp-sync'
  | 'after-snapshot-verify'
  | 'after-previous-snapshot-sync'
  | 'after-snapshot-replace'
  | 'after-journal-temp-sync'
  | 'after-previous-journal-sync'
  | 'after-journal-rotate';

export interface SnapshotFailureInjector { at?(point: CompactionFailurePoint): void }

/** Snapshot replacement completes before the old journal is ever rotated. */
export async function compactSnapshot(
  root: string,
  snapshot: LoadedSnapshot,
  injector: SnapshotFailureInjector = {},
): Promise<void> {
  await mkdir(root, { recursive: true });
  const current = resolveStoragePath(root, SNAPSHOT_FILE);
  const previous = resolveStoragePath(root, PREVIOUS_SNAPSHOT_FILE);
  const previousTemporary = resolveStoragePath(root, `${PREVIOUS_SNAPSHOT_FILE}.tmp`);
  const temporary = resolveStoragePath(root, SNAPSHOT_TEMP_FILE);
  const journal = resolveStoragePath(root, JOURNAL_FILE);
  const previousJournal = resolveStoragePath(root, PREVIOUS_JOURNAL_FILE);
  const previousJournalTemporary = resolveStoragePath(root, `${PREVIOUS_JOURNAL_FILE}.tmp`);
  const journalTemporary = resolveStoragePath(root, JOURNAL_TEMP_FILE);

  await writeSynced(temporary, serializeSnapshot(snapshot));
  injector.at?.('after-snapshot-temp-sync');
  await readSnapshot(temporary);
  injector.at?.('after-snapshot-verify');

  try {
    await copyFile(current, previousTemporary);
    const previousHandle = await open(previousTemporary, 'r');
    try { await previousHandle.sync(); } finally { await previousHandle.close(); }
    await rename(previousTemporary, previous);
    await syncDirectory(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  injector.at?.('after-previous-snapshot-sync');
  await rename(temporary, current);
  await syncDirectory(root);
  injector.at?.('after-snapshot-replace');

  await writeSynced(journalTemporary, new Uint8Array());
  injector.at?.('after-journal-temp-sync');
  try {
    await copyFile(journal, previousJournalTemporary);
    const previousHandle = await open(previousJournalTemporary, 'r');
    try { await previousHandle.sync(); } finally { await previousHandle.close(); }
    await rename(previousJournalTemporary, previousJournal);
    await syncDirectory(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  injector.at?.('after-previous-journal-sync');
  await rename(journalTemporary, journal);
  await syncDirectory(root);
  injector.at?.('after-journal-rotate');
}
