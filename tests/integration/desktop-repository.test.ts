import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DesktopRepository, MAX_DOCUMENT_BYTES } from '../../electron/storage/repository.js';
import { appendJournalRecord, encodeJournalRecord, MAX_JOURNAL_RECORD_BYTES } from '../../electron/storage/journal.js';
import {
  JOURNAL_FILE,
  SNAPSHOT_FILE,
  resolveStoragePath,
  type CompactionFailurePoint,
} from '../../electron/storage/snapshot.js';
import { createEmptyState } from '../../electron/storage/migrations.js';
import { createRepositoryRequestHandler, MAX_IPC_PAYLOAD_BYTES } from '../../electron/ipc/repository.js';
import { IPC_PROTOCOL_VERSION, type BridgeInvokeRequest } from '../../src/contracts/platform.js';
import { DesktopRepositoryAdapter } from '../../src/platform/desktop/repository.js';
import type { SessionCommit } from '../../src/contracts/repository.js';
import {
  COMPLETED_SESSION_ID,
  PROFILE_A_ID,
  completedSession,
  profileA,
} from '../fixtures/contracts/index.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'flashfinger-m05-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function profileInput() {
  return {
    name: profileA.name,
    avatarToken: profileA.avatarToken,
    analyticsZone: profileA.analyticsZone,
    settings: profileA.settings,
  };
}

function finalizedCommit(): SessionCommit {
  return {
    session: completedSession,
    daySlices: [{
      sessionId: COMPLETED_SESSION_ID,
      profileId: PROFILE_A_ID,
      day: '2026-09-18',
      zone: 'Asia/Jakarta',
      activeMs: completedSession.activeMs,
      attempts: completedSession.attempts,
      correctAttempts: completedSession.correctAttempts,
      errorAttempts: completedSession.errorAttempts,
      completedWords: completedSession.completedWords,
      eligibleActiveMs: completedSession.activeMs,
      eligibleRetainedCorrect: completedSession.retainedCorrect,
    }],
    mistakes: [{ profileId: PROFILE_A_ID, sessionId: COMPLETED_SESSION_ID, expected: 'a', attempted: 's', count: 2 }],
    exposures: [{ profileId: PROFILE_A_ID, sessionId: COMPLETED_SESSION_ID, expected: 'a', attempts: 12, errors: 2 }],
    updateProfileCharacterStats: true,
  };
}

async function repositoryWithProfile(directory: string, options: ConstructorParameters<typeof DesktopRepository>[0] = { rootDirectory: directory }) {
  const repository = new DesktopRepository({
    ...options,
    rootDirectory: directory,
    randomUUID: () => PROFILE_A_ID,
    compactAfterRecords: 0,
  });
  expect(await repository.initialize()).toEqual({ ok: true, value: undefined });
  expect((await repository.createProfile(profileInput())).ok).toBe(true);
  return repository;
}

describe('M05 desktop journal durability and replay', () => {
  it('commits one complete finalized mutation and retries by session UUID without double effects', async () => {
    const directory = await temporaryDirectory();
    const repository = await repositoryWithProfile(directory);
    expect(await repository.commitSession(finalizedCommit())).toEqual({
      ok: true, value: { alreadyCommitted: false, sessionId: COMPLETED_SESSION_ID },
    });
    expect(await repository.commitSession(finalizedCommit())).toEqual({
      ok: true, value: { alreadyCommitted: true, sessionId: COMPLETED_SESSION_ID },
    });
    expect(await repository.getCharacterStats(PROFILE_A_ID)).toMatchObject({
      ok: true,
      value: { exposures: [{ expected: 'a', attempts: 12, errors: 2 }], mistakes: [{ expected: 'a', attempted: 's', count: 2 }] },
    });

    const reopened = new DesktopRepository({ rootDirectory: directory, compactAfterRecords: 0 });
    expect(await reopened.initialize()).toEqual({ ok: true, value: undefined });
    expect(await reopened.commitSession(finalizedCommit())).toEqual({
      ok: true, value: { alreadyCommitted: true, sessionId: COMPLETED_SESSION_ID },
    });
  });

  it('serializes concurrent retries so exactly one reports a new commit', async () => {
    const directory = await temporaryDirectory();
    const repository = await repositoryWithProfile(directory);
    const [first, second] = await Promise.all([
      repository.commitSession(finalizedCommit()),
      repository.commitSession(finalizedCommit()),
    ]);
    expect([first, second].filter((result) => result.ok && !result.value.alreadyCommitted)).toHaveLength(1);
    expect([first, second].filter((result) => result.ok && result.value.alreadyCommitted)).toHaveLength(1);
    expect(await repository.getCharacterStats(PROFILE_A_ID)).toMatchObject({
      ok: true, value: { exposures: [{ expected: 'a', attempts: 12, errors: 2 }] },
    });
  });

  it('durably resets character analytics without deleting completed sessions', async () => {
    const directory = await temporaryDirectory();
    const repository = await repositoryWithProfile(directory);
    await repository.commitSession(finalizedCommit());

    expect(await repository.resetCharacterStats(PROFILE_A_ID)).toEqual({ ok: true, value: undefined });
    expect(await repository.getCharacterStats(PROFILE_A_ID)).toEqual({ ok: true, value: { exposures: [], mistakes: [] } });
    expect(await repository.getSession(COMPLETED_SESSION_ID)).toMatchObject({ ok: true, value: { id: COMPLETED_SESSION_ID } });
    expect(await repository.rebuildCharacterStats(PROFILE_A_ID)).toEqual({ ok: true, value: undefined });

    const reopened = new DesktopRepository({ rootDirectory: directory, compactAfterRecords: 0 });
    expect(await reopened.initialize()).toEqual({ ok: true, value: undefined });
    expect(await reopened.getCharacterStats(PROFILE_A_ID)).toEqual({ ok: true, value: { exposures: [], mistakes: [] } });
  });

  it('does not expose or acknowledge a mutation before the injected durable append boundary resolves', async () => {
    const directory = await temporaryDirectory();
    let release!: () => void;
    let started!: () => void;
    const hasStarted = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const repository = new DesktopRepository({
      rootDirectory: directory,
      randomUUID: () => PROFILE_A_ID,
      compactAfterRecords: 0,
      appendRecord: async (filePath, record) => {
        started();
        await gate;
        return appendJournalRecord(filePath, record);
      },
    });
    await repository.initialize();
    let acknowledged = false;
    const save = repository.createProfile(profileInput()).then((result) => { acknowledged = true; return result; });
    await hasStarted;
    expect(acknowledged).toBe(false);
    expect(await repository.listProfiles()).toEqual({ ok: true, value: [] });
    release();
    expect((await save).ok).toBe(true);
    expect((await repository.listProfiles()).ok && (await repository.listProfiles() as { ok: true; value: unknown[] }).value).toHaveLength(1);
  });

  it('ignores and durably truncates only an incomplete final frame', async () => {
    const directory = await temporaryDirectory();
    const repository = await repositoryWithProfile(directory);
    const journalPath = resolveStoragePath(directory, JOURNAL_FILE);
    const partial = encodeJournalRecord({
      schemaVersion: 1,
      sequence: 2,
      mutation: { kind: 'delete-profile', profileId: PROFILE_A_ID },
    });
    const handle = await open(journalPath, 'a');
    await handle.write(partial.subarray(0, Math.floor(partial.length / 2)));
    await handle.close();

    const reopened = new DesktopRepository({ rootDirectory: directory, compactAfterRecords: 0 });
    expect(await reopened.initialize()).toEqual({ ok: true, value: undefined });
    expect(await reopened.listProfiles()).toMatchObject({ ok: true, value: [{ id: PROFILE_A_ID }] });
    const recoveredLength = (await readFile(journalPath)).byteLength;
    expect(recoveredLength).toBeLessThan(partial.byteLength + 1_000);

    expect(await reopened.deleteProfile(PROFILE_A_ID)).toEqual({ ok: true, value: undefined });
    const twice = new DesktopRepository({ rootDirectory: directory, compactAfterRecords: 0 });
    expect(await twice.initialize()).toEqual({ ok: true, value: undefined });
    expect(await twice.listProfiles()).toEqual({ ok: true, value: [] });
  });

  it('does not acknowledge an injected partial journal write and recovers it after restart', async () => {
    const directory = await temporaryDirectory();
    let crashed = false;
    const repository = new DesktopRepository({
      rootDirectory: directory,
      randomUUID: () => PROFILE_A_ID,
      compactAfterRecords: 0,
      appendRecord: async (filePath, record) => {
        const frame = encodeJournalRecord(record);
        const handle = await open(filePath, 'a');
        try {
          await handle.write(frame.subarray(0, Math.floor(frame.length / 2)));
          await handle.sync();
        } finally { await handle.close(); }
        crashed = true;
        throw new Error('injected process crash');
      },
    });
    await repository.initialize();
    expect(await repository.createProfile(profileInput())).toMatchObject({ ok: false });
    expect(crashed).toBe(true);
    expect(await repository.listProfiles()).toEqual({ ok: true, value: [] });

    const recovered = new DesktopRepository({ rootDirectory: directory, randomUUID: () => PROFILE_A_ID, compactAfterRecords: 0 });
    expect(await recovered.initialize()).toEqual({ ok: true, value: undefined });
    expect(await recovered.listProfiles()).toEqual({ ok: true, value: [] });
    expect((await recovered.createProfile(profileInput())).ok).toBe(true);
  });

  it('fails closed on a checksummed record damaged in the middle', async () => {
    const directory = await temporaryDirectory();
    const repository = await repositoryWithProfile(directory);
    await repository.saveProfileSettings(PROFILE_A_ID, { ...profileA.settings, muted: true });
    const journalPath = resolveStoragePath(directory, JOURNAL_FILE);
    const bytes = await readFile(journalPath);
    const firstHeaderEnd = bytes.indexOf(0x0a);
    bytes[firstHeaderEnd + 5] ^= 1;
    await writeFile(journalPath, bytes);

    const reopened = new DesktopRepository({ rootDirectory: directory, compactAfterRecords: 0 });
    expect(await reopened.initialize()).toMatchObject({ ok: false, error: { code: 'corrupt', retryable: false } });
  });

  it('rejects a journal produced by a newer schema version', async () => {
    const directory = await temporaryDirectory();
    const journalPath = resolveStoragePath(directory, JOURNAL_FILE);
    await writeFile(journalPath, encodeJournalRecord({
      schemaVersion: 2,
      sequence: 1,
      mutation: { kind: 'delete-checkpoint', sessionId: COMPLETED_SESSION_ID },
    }));
    const repository = new DesktopRepository({ rootDirectory: directory, compactAfterRecords: 0 });
    expect(await repository.initialize()).toMatchObject({ ok: false, error: { code: 'version-too-new', retryable: false } });
  });

  it('rejects a checksummed snapshot produced by a newer schema version', async () => {
    const directory = await temporaryDirectory();
    const state = { ...createEmptyState(), schemaVersion: 2 };
    const core = { formatVersion: 1, schemaVersion: 2, generation: 1, lastSequence: 0, state };
    const checksum = createHash('sha256').update(JSON.stringify(core), 'utf8').digest('hex');
    await writeFile(resolveStoragePath(directory, SNAPSHOT_FILE), JSON.stringify({ ...core, checksum }));
    const repository = new DesktopRepository({ rootDirectory: directory, compactAfterRecords: 0 });
    expect(await repository.initialize()).toMatchObject({ ok: false, error: { code: 'version-too-new', retryable: false } });
  });
});

describe('M05 compaction crash matrix', () => {
  const points: CompactionFailurePoint[] = [
    'after-snapshot-temp-sync', 'after-snapshot-verify', 'after-previous-snapshot-sync',
    'after-snapshot-replace', 'after-journal-temp-sync', 'after-previous-journal-sync', 'after-journal-rotate',
  ];

  it.each(points)('recovers committed data after %s', async (point) => {
    const directory = await temporaryDirectory();
    const repository = await repositoryWithProfile(directory, {
      rootDirectory: directory,
      compactionFailures: { at(candidate) { if (candidate === point) throw new Error(`crash:${point}`); } },
    });
    expect(await repository.compact()).toMatchObject({ ok: false });

    const reopened = new DesktopRepository({ rootDirectory: directory, compactAfterRecords: 0 });
    expect(await reopened.initialize()).toEqual({ ok: true, value: undefined });
    expect(await reopened.listProfiles()).toMatchObject({ ok: true, value: [{ id: PROFILE_A_ID }] });
  });
});

describe('M05 path and IPC boundary security', () => {
  it('confines all repository file names to the configured root', async () => {
    const directory = await temporaryDirectory();
    expect(() => resolveStoragePath(directory, '../outside')).toThrow(/confined/);
    expect(() => resolveStoragePath(directory, '/tmp/outside')).toThrow(/confined/);
    expect(resolveStoragePath(directory, JOURNAL_FILE)).toBe(path.join(directory, JOURNAL_FILE));
  });

  it('rejects oversized IPC payloads before repository dispatch', async () => {
    const directory = await temporaryDirectory();
    const repository = new DesktopRepository({ rootDirectory: directory, compactAfterRecords: 0 });
    const handler = createRepositoryRequestHandler(repository);
    const frame = { url: 'flashfinger://app/index.html' };
    const event = { sender: { id: 1, mainFrame: frame, isDestroyed: () => false }, senderFrame: frame };
    const request: BridgeInvokeRequest = {
      protocol: IPC_PROTOCOL_VERSION,
      requestId: 'oversized',
      channel: 'repo.initialize',
      payload: ['x'.repeat(MAX_IPC_PAYLOAD_BYTES + 1)],
    };
    expect(await handler(event, request)).toMatchObject({ ok: false, error: { code: 'invalid', message: expect.stringContaining('8 MiB') } });

    (repository as unknown as { listProfiles(): Promise<unknown> }).listProfiles = async () => ({
      ok: true,
      value: ['x'.repeat(MAX_IPC_PAYLOAD_BYTES + 1)],
    });
    expect(await handler(event, { ...request, requestId: 'oversized-response', channel: 'repo.listProfiles', payload: [] }))
      .toMatchObject({ ok: false, error: { code: 'invalid', message: expect.stringContaining('response') } });
  });

  it('enforces journal and retained-document payload limits', async () => {
    expect(() => encodeJournalRecord({
      schemaVersion: 1,
      sequence: 1,
      mutation: { kind: 'delete-checkpoint', sessionId: 'x'.repeat(MAX_JOURNAL_RECORD_BYTES) },
    })).toThrow(/payload limit/);

    const directory = await temporaryDirectory();
    const repository = await repositoryWithProfile(directory);
    expect(await repository.saveDocument({
      document: {
        id: '77777777-7777-4777-8777-777777777777',
        profileId: PROFILE_A_ID,
        title: 'Oversized',
        createdAt: '2026-09-20T00:00:00.000Z',
        normalizationVersion: 1,
        hash: 'a'.repeat(64),
        graphemeCount: 1,
        byteLength: MAX_DOCUMENT_BYTES + 1,
        chunkCount: 0,
        retained: true,
      },
      chunks: [],
    })).toMatchObject({ ok: false, error: { code: 'invalid', message: expect.stringContaining('5 MiB') } });
  });

  it('accepts only the expected main frame and flashfinger app origin', async () => {
    const directory = await temporaryDirectory();
    const repository = new DesktopRepository({ rootDirectory: directory, compactAfterRecords: 0 });
    const handler = createRepositoryRequestHandler(repository, () => 7);
    const request: BridgeInvokeRequest = { protocol: IPC_PROTOCOL_VERSION, requestId: 'sender', channel: 'repo.initialize', payload: [] };
    const trustedFrame = { url: 'flashfinger://app/index.html' };
    const trusted = { sender: { id: 7, mainFrame: trustedFrame, isDestroyed: () => false }, senderFrame: trustedFrame };
    expect(await handler(trusted, request)).toEqual({ protocol: 1, requestId: 'sender', ok: true, value: undefined });

    const foreignFrame = { url: 'https://attacker.invalid/' };
    expect(await handler({ sender: { id: 7, mainFrame: foreignFrame }, senderFrame: foreignFrame }, request))
      .toMatchObject({ ok: false, error: { code: 'unavailable' } });
    expect(await handler({ sender: { id: 8, mainFrame: trustedFrame }, senderFrame: trustedFrame }, request))
      .toMatchObject({ ok: false, error: { code: 'unavailable' } });
    expect(await handler({ sender: { id: 7, mainFrame: trustedFrame }, senderFrame: { url: trustedFrame.url } }, request))
      .toMatchObject({ ok: false, error: { code: 'unavailable' } });
  });

  it('renderer adapter forwards typed arguments and preserves repository errors', async () => {
    const calls: { channel: string; payload?: unknown }[] = [];
    const adapter = new DesktopRepositoryAdapter({
      invoke: async (request) => {
        calls.push(request);
        if (request.channel === 'repo.getSession') {
          return { protocol: 1, requestId: 'bridge', ok: false,
            error: { code: 'not-found', message: 'missing', retryable: false } };
        }
        return { protocol: 1, requestId: 'bridge', ok: true, value: [] };
      },
    });
    expect(await adapter.listProfiles()).toEqual({ ok: true, value: [] });
    expect(await adapter.getSession(COMPLETED_SESSION_ID)).toEqual({
      ok: false, error: { code: 'not-found', message: 'missing', retryable: false },
    });
    expect(calls).toEqual([
      { channel: 'repo.listProfiles', payload: [] },
      { channel: 'repo.getSession', payload: [COMPLETED_SESSION_ID] },
    ]);
  });
});
