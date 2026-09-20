/** Append-only, framed and checksummed desktop transaction journal. */

import { createHash } from 'node:crypto';
import { open, readFile, truncate } from 'node:fs/promises';
import * as path from 'node:path';
import type { DesktopMutation } from './migrations.js';
import { SCHEMA_VERSION } from '../../src/contracts/versions.js';

const MAGIC = 'FFJ1';
const HEADER_RE = /^FFJ1 ([0-9]+) ([a-f0-9]{64})\n$/;
export const MAX_JOURNAL_RECORD_BYTES = 8 * 1024 * 1024;

export interface JournalRecord {
  schemaVersion: number;
  sequence: number;
  mutation: DesktopMutation;
}

export interface JournalReplay {
  records: JournalRecord[];
  validBytes: number;
  truncatedTail: boolean;
}

export class JournalCorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JournalCorruptionError';
  }
}

function checksum(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function encodeJournalRecord(record: JournalRecord): Buffer {
  const payload = Buffer.from(JSON.stringify(record), 'utf8');
  if (payload.byteLength > MAX_JOURNAL_RECORD_BYTES) throw new RangeError('Journal transaction exceeds the payload limit');
  const header = Buffer.from(`${MAGIC} ${payload.byteLength} ${checksum(payload)}\n`, 'ascii');
  return Buffer.concat([header, payload, Buffer.from('\n', 'ascii')]);
}

function parseRecord(payload: Buffer): JournalRecord {
  let parsed: unknown;
  try { parsed = JSON.parse(payload.toString('utf8')); } catch { throw new JournalCorruptionError('Journal payload is not valid JSON'); }
  if (!parsed || typeof parsed !== 'object') throw new JournalCorruptionError('Journal payload is not an object');
  const record = parsed as Partial<JournalRecord>;
  if (!Number.isSafeInteger(record.sequence) || (record.sequence ?? 0) < 1 || !record.mutation || typeof record.mutation !== 'object') {
    throw new JournalCorruptionError('Journal record shape is invalid');
  }
  if (!Number.isSafeInteger(record.schemaVersion)) throw new JournalCorruptionError('Journal schema version is invalid');
  if ((record.schemaVersion as number) > SCHEMA_VERSION) {
    const error = new Error(`Journal schema version ${record.schemaVersion} is newer than supported ${SCHEMA_VERSION}`);
    error.name = 'VersionTooNewError';
    throw error;
  }
  if (record.schemaVersion !== SCHEMA_VERSION) throw new JournalCorruptionError('Journal record requires an unavailable migration');
  return record as JournalRecord;
}

export async function readJournal(filePath: string): Promise<JournalReplay> {
  let bytes: Buffer;
  try { bytes = await readFile(filePath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { records: [], validBytes: 0, truncatedTail: false };
    throw error;
  }
  const records: JournalRecord[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const headerEnd = bytes.indexOf(0x0a, offset);
    if (headerEnd < 0) return { records, validBytes: offset, truncatedTail: true };
    const header = bytes.subarray(offset, headerEnd + 1).toString('ascii');
    const match = HEADER_RE.exec(header);
    if (!match) throw new JournalCorruptionError(`Invalid journal frame header at byte ${offset}`);
    const length = Number(match[1]);
    if (!Number.isSafeInteger(length) || length < 1 || length > MAX_JOURNAL_RECORD_BYTES) {
      throw new JournalCorruptionError(`Invalid journal frame length at byte ${offset}`);
    }
    const payloadStart = headerEnd + 1;
    const frameEnd = payloadStart + length + 1;
    if (frameEnd > bytes.length) {
      const laterMagic = bytes.indexOf(Buffer.from(`\n${MAGIC} `), payloadStart);
      if (laterMagic >= 0) throw new JournalCorruptionError(`Damaged journal record in the middle at byte ${offset}`);
      return { records, validBytes: offset, truncatedTail: true };
    }
    if (bytes[frameEnd - 1] !== 0x0a) throw new JournalCorruptionError(`Missing journal frame terminator at byte ${offset}`);
    const payload = bytes.subarray(payloadStart, payloadStart + length);
    if (checksum(payload) !== match[2]) throw new JournalCorruptionError(`Journal checksum mismatch at byte ${offset}`);
    records.push(parseRecord(payload));
    offset = frameEnd;
  }
  return { records, validBytes: offset, truncatedTail: false };
}

export async function discardTruncatedTail(filePath: string, validBytes: number): Promise<void> {
  await truncate(filePath, validBytes).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
  const handle = await open(filePath, 'a');
  try { await handle.sync(); } finally { await handle.close(); }
  await syncParent(filePath);
}

async function syncParent(filePath: string): Promise<void> {
  const directory = await open(path.dirname(filePath), 'r');
  try {
    await directory.sync().catch((error: NodeJS.ErrnoException) => {
      if (!['EINVAL', 'ENOTSUP', 'EBADF'].includes(error.code ?? '')) throw error;
    });
  } finally { await directory.close(); }
}

/** Resolves only after the frame has crossed fsync, which is the save acknowledgement boundary. */
export async function appendJournalRecord(filePath: string, record: JournalRecord): Promise<number> {
  const frame = encodeJournalRecord(record);
  const handle = await open(filePath, 'a');
  try {
    await handle.writeFile(frame);
    await handle.sync();
  } finally {
    await handle.close();
  }
  // Covers durability of the directory entry when this append created the journal.
  await syncParent(filePath);
  return frame.byteLength;
}
