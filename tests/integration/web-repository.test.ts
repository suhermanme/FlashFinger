// @vitest-environment node

import 'fake-indexeddb/auto';

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';
import type {
  ActiveCheckpoint,
  DailyAggregate,
  Profile,
  SessionDaySlice,
  SessionRecord,
  SessionSeries,
} from '../../src/contracts/models.js';
import type { SessionCommit } from '../../src/contracts/repository.js';
import {
  deleteDatabase,
  openDatabase,
  requestResult,
  withTransaction,
} from '../../src/platform/web/database.js';
import { STORE_NAMES, STORES } from '../../src/platform/web/migrations.js';
import {
  IndexedDbRepository,
  type IndexedDbRepositoryOptions,
} from '../../src/platform/web/repository.js';
import { SCHEMA_VERSION } from '../../src/contracts/versions.js';
import {
  COMPLETED_SESSION_ID,
  MIDNIGHT_SESSION_ID,
  completedSession,
  midnightSession,
  midnightSessionDaySlices,
  profileA,
  profileB,
} from '../fixtures/contracts/index.js';

const repositories: IndexedDbRepository[] = [];
const databaseNames = new Set<string>();

function randomDatabaseName(): string {
  const name = `flashfinger-m04-${crypto.randomUUID()}`;
  databaseNames.add(name);
  return name;
}

function makeRepository(options: IndexedDbRepositoryOptions = {}): IndexedDbRepository {
  const databaseName = options.databaseName ?? randomDatabaseName();
  databaseNames.add(databaseName);
  const repository = new IndexedDbRepository({
    databaseName,
    ownership: { forceLeaseFallback: true, ...options.ownership },
    ...options,
  });
  repositories.push(repository);
  return repository;
}

afterEach(async () => {
  for (const repository of repositories.splice(0)) repository.close();
  for (const name of databaseNames) {
    try { await deleteDatabase(name); } catch { /* a failed-open test may leave no database */ }
  }
  databaseNames.clear();
});

async function createFixtureProfile(
  repository: IndexedDbRepository,
  fixture: Profile = profileA,
): Promise<Profile> {
  const result = await repository.createProfile({
    name: fixture.name,
    avatarToken: fixture.avatarToken,
    analyticsZone: fixture.analyticsZone,
    settings: fixture.settings,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function sessionId(index: number): string {
  return `70000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function daySliceFor(session: SessionRecord, day = '2026-09-18'): SessionDaySlice {
  return {
    sessionId: session.id,
    profileId: session.profileId,
    day,
    zone: session.analyticsZone,
    activeMs: session.activeMs,
    attempts: session.attempts,
    correctAttempts: session.correctAttempts,
    errorAttempts: session.errorAttempts,
    completedWords: session.completedWords,
    eligibleActiveMs: session.eligibleForBest ? session.activeMs : 0,
    eligibleRetainedCorrect: session.eligibleForBest ? session.retainedCorrect : 0,
  };
}

function aggregateFor(session: SessionRecord, slice: SessionDaySlice): DailyAggregate {
  return {
    profileId: session.profileId,
    day: slice.day,
    zone: slice.zone,
    metricVersion: session.config.metricVersion,
    activeMs: slice.activeMs,
    attempts: slice.attempts,
    correctAttempts: slice.correctAttempts,
    errorAttempts: slice.errorAttempts,
    completedWords: slice.completedWords,
    eligibleActiveMs: slice.eligibleActiveMs,
    eligibleRetainedCorrect: slice.eligibleRetainedCorrect,
    eligibleSessionCount: slice.eligibleActiveMs > 0 ? 1 : 0,
    bestWpm: slice.eligibleActiveMs > 0 ? session.adjustedWpm : null,
    revision: 0,
  };
}

function checkpointFor(session: SessionRecord): ActiveCheckpoint {
  return {
    sessionId: session.id,
    profileId: session.profileId,
    config: session.config,
    checkpointAt: session.startedAt,
    lastSequence: 1,
    activeMs: 1_000,
    counts: {
      attempts: 5,
      correctAttempts: 4,
      errorAttempts: 1,
      backspaces: 0,
      retainedCorrect: 4,
    },
    textCursor: 5,
    generationState: session.seed,
    cappedRecentEdits: [{
      sequence: 1,
      kind: 'insert',
      position: 4,
      grapheme: 'a',
      correct: true,
    }],
  };
}

function fullCommit(session: SessionRecord, slices = [daySliceFor(session)]): SessionCommit {
  const series: SessionSeries = {
    sessionId: session.id,
    samplePeriodMs: 1_000,
    samples: [{
      activeElapsedMs: 1_000,
      windowMs: 1_000,
      attempts: 5,
      correctAttempts: 4,
      grossCpm: 300,
      adjustedWpm: 48,
      accuracy: 80,
    }],
  };
  return {
    session,
    series,
    daySlices: slices,
    mistakes: [{
      profileId: session.profileId,
      sessionId: session.id,
      expected: 'a',
      attempted: 's',
      count: 2,
    }],
    exposures: [{
      profileId: session.profileId,
      sessionId: session.id,
      expected: 'a',
      attempts: 10,
      errors: 2,
    }],
    lessonProgress: [{
      profileId: session.profileId,
      lessonId: 'ff-home-row-1',
      curriculumVersion: 'ff-curriculum-v1',
      attemptCount: 1,
      passCount: 1,
      bestWpm: session.adjustedWpm,
      bestAccuracy: session.accuracy,
      lastAttemptAt: session.endedAt,
      masteredAt: session.endedAt,
      qualifyingSessionIds: [session.id],
    }],
    aggregateChanges: slices.map((slice) => aggregateFor(session, slice)),
    updateProfileCharacterStats: true,
    removeCheckpointId: session.id,
  };
}

describe('M04 IndexedDB finalized-session transaction', () => {
  it('commits every finalized effect atomically and removes the checkpoint', async () => {
    const repository = makeRepository();
    expect((await repository.initialize()).ok).toBe(true);
    const profile = await createFixtureProfile(repository);
    const session = { ...completedSession, profileId: profile.id };
    expect((await repository.saveCheckpoint(checkpointFor(session))).ok).toBe(true);

    const committed = await repository.commitSession(fullCommit(session));
    expect(committed).toEqual({
      ok: true,
      value: { alreadyCommitted: false, sessionId: COMPLETED_SESSION_ID },
    });
    expect(await repository.getSession(COMPLETED_SESSION_ID)).toMatchObject({ ok: true, value: session });
    expect(await repository.getSessionSeries(COMPLETED_SESSION_ID)).toMatchObject({
      ok: true,
      value: { sessionId: COMPLETED_SESSION_ID, samplePeriodMs: 1_000 },
    });
    expect(await repository.getCheckpoint(COMPLETED_SESSION_ID)).toEqual({ ok: true, value: null });
    expect(await repository.getLessonProgress(profile.id, 'ff-curriculum-v1')).toMatchObject({
      ok: true,
      value: [{ qualifyingSessionIds: [COMPLETED_SESSION_ID] }],
    });
    expect(await repository.getDailyAggregates(profile.id, '2026-09-18', '2026-09-19')).toMatchObject({
      ok: true,
      value: [{ attempts: 300, eligibleRetainedCorrect: 270, bestWpm: 54 }],
    });
    expect(await repository.getCharacterStats(profile.id)).toEqual({
      ok: true,
      value: {
        exposures: [{ expected: 'a', attempts: 10, errors: 2 }],
        mistakes: [{ expected: 'a', attempted: 's', count: 2 }],
      },
    });
  });

  it('rolls back earlier writes when a later write hits quota', async () => {
    let failAggregate = false;
    const repository = makeRepository({
      faultInjector: {
        beforeWrite(store) {
          if (failAggregate && store === STORES.dailyAggregates) {
            throw new DOMException('simulated quota', 'QuotaExceededError');
          }
        },
      },
    });
    await repository.initialize();
    const profile = await createFixtureProfile(repository);
    const session = { ...completedSession, profileId: profile.id };
    await repository.saveCheckpoint(checkpointFor(session));
    failAggregate = true;

    const result = await repository.commitSession(fullCommit(session));
    expect(result).toMatchObject({ ok: false, error: { code: 'quota', retryable: true } });
    expect(await repository.getSession(session.id)).toMatchObject({ ok: false, error: { code: 'not-found' } });
    expect(await repository.getSessionSeries(session.id)).toEqual({ ok: true, value: null });
    expect(await repository.getDailyAggregates(profile.id, '2026-09-18', '2026-09-19')).toEqual({ ok: true, value: [] });
    expect(await repository.getCharacterStats(profile.id)).toEqual({
      ok: true,
      value: { exposures: [], mistakes: [] },
    });
    expect(await repository.getCheckpoint(session.id)).toMatchObject({ ok: true, value: { sessionId: session.id } });
  });

  it('treats the session UUID as an idempotency key without doubling effects', async () => {
    const repository = makeRepository();
    await repository.initialize();
    const profile = await createFixtureProfile(repository);
    const session = { ...completedSession, profileId: profile.id };
    const commit = fullCommit(session);
    expect(await repository.commitSession(commit)).toMatchObject({ ok: true, value: { alreadyCommitted: false } });
    expect(await repository.commitSession(commit)).toMatchObject({ ok: true, value: { alreadyCommitted: true } });
    expect(await repository.getCharacterStats(profile.id)).toMatchObject({
      ok: true,
      value: { exposures: [{ attempts: 10, errors: 2 }], mistakes: [{ count: 2 }] },
    });
    expect(await repository.getDailyAggregates(profile.id, '2026-09-18', '2026-09-19')).toMatchObject({
      ok: true,
      value: [{ attempts: 300, eligibleSessionCount: 1 }],
    });
  });
});

describe('M04 profile isolation and deletion', () => {
  it('atomically cascades profile-owned records without touching another profile', async () => {
    const repository = makeRepository();
    await repository.initialize();
    const first = await createFixtureProfile(repository, profileA);
    const second = await createFixtureProfile(repository, profileB);
    const sessionA = { ...completedSession, profileId: first.id };
    const sessionB = { ...completedSession, id: sessionId(2), profileId: second.id };
    await repository.commitSession(fullCommit(sessionA));
    await repository.commitSession(fullCommit(sessionB));
    await repository.saveCheckpoint(checkpointFor({ ...sessionA, id: sessionId(3) }));
    await repository.saveDocument({
      document: {
        id: '80000000-0000-4000-8000-000000000001',
        profileId: first.id,
        title: 'Local fixture',
        createdAt: '2026-09-18T09:00:00.000Z',
        normalizationVersion: 1,
        hash: '0'.repeat(64),
        graphemeCount: 3,
        byteLength: 3,
        chunkCount: 1,
        retained: true,
      },
      chunks: [{
        documentId: '80000000-0000-4000-8000-000000000001',
        chunkIndex: 0,
        startGrapheme: 0,
        text: 'abc',
      }],
    });

    expect((await repository.deleteProfile(first.id)).ok).toBe(true);
    expect(await repository.querySessions({ profileId: first.id, includeIneligible: true, limit: 20 })).toEqual({
      ok: true,
      value: { sessions: [], nextCursor: null },
    });
    expect(await repository.getSessionSeries(sessionA.id)).toEqual({ ok: true, value: null });
    expect(await repository.findLatestCheckpoint(first.id)).toEqual({ ok: true, value: null });
    expect(await repository.listDocuments(first.id)).toEqual({ ok: true, value: [] });
    expect(await repository.querySessions({ profileId: second.id, includeIneligible: true, limit: 20 })).toMatchObject({
      ok: true,
      value: { sessions: [{ id: sessionB.id }] },
    });
    expect(await repository.getCharacterStats(second.id)).toMatchObject({
      ok: true,
      value: { exposures: [{ attempts: 10 }] },
    });
    expect(await repository.listProfiles()).toMatchObject({ ok: true, value: [{ id: second.id }] });
  });
});

describe('M04 migrations and schema gates', () => {
  it('creates every v1 store and records a completed migration', async () => {
    const name = randomDatabaseName();
    const database = await openDatabase(name);
    expect(database.version).toBe(SCHEMA_VERSION);
    expect([...database.objectStoreNames].sort()).toEqual([...STORE_NAMES].sort());
    const version = await withTransaction(database, [STORES.metadata], 'readonly', async (transaction) => {
      const record = await requestResult<{ value: number }>(transaction.objectStore(STORES.metadata).get('schemaVersion'));
      return record.value;
    });
    expect(version).toBe(SCHEMA_VERSION);
    database.close();
  });

  it('rolls back a structural migration that throws and can retry cleanly', async () => {
    const name = randomDatabaseName();
    const failingRepository = makeRepository({
      databaseName: name,
      migrationHooks: { beforeStep: () => { throw new Error('fixture migration failure'); } },
    });
    expect(await failingRepository.initialize()).toMatchObject({
      ok: false,
      error: { code: 'corrupt', retryable: false },
    });

    const database = await openDatabase(name);
    expect([...database.objectStoreNames].sort()).toEqual([...STORE_NAMES].sort());
    database.close();
  });

  it('returns version-too-new instead of overwriting a newer database', async () => {
    const name = randomDatabaseName();
    const newer = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, SCHEMA_VERSION + 1);
      request.onupgradeneeded = () => request.result.createObjectStore('future');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    newer.close();
    const repository = makeRepository({ databaseName: name });
    expect(await repository.initialize()).toMatchObject({
      ok: false,
      error: { code: 'version-too-new', retryable: false },
    });
    const untouched = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    expect(untouched.version).toBe(SCHEMA_VERSION + 1);
    expect(untouched.objectStoreNames.contains('future')).toBe(true);
    untouched.close();
  });
});

describe('M04 multi-tab ownership', () => {
  it('serializes acquisition and fences a stale owner from checkpoint writes', async () => {
    const name = randomDatabaseName();
    let clock = Date.parse('2026-09-21T00:00:00.000Z');
    const shared = {
      databaseName: name,
      now: () => clock,
      ownership: { forceLeaseFallback: true, ttlMs: 1_000 },
    } satisfies IndexedDbRepositoryOptions;
    const firstTab = makeRepository({ ...shared, ownership: { ...shared.ownership, ownerId: 'tab-a' } });
    const secondTab = makeRepository({ ...shared, ownership: { ...shared.ownership, ownerId: 'tab-b' } });
    await firstTab.initialize();
    await secondTab.initialize();
    const profile = await createFixtureProfile(firstTab);
    const session = { ...completedSession, profileId: profile.id };

    const firstToken = await firstTab.acquireSessionOwnership(profile.id);
    expect(firstToken.ok).toBe(true);
    expect(await secondTab.acquireSessionOwnership(profile.id)).toMatchObject({
      ok: false,
      error: { code: 'conflict' },
    });

    clock += 1_001;
    const secondToken = await secondTab.acquireSessionOwnership(profile.id);
    expect(secondToken.ok).toBe(true);
    if (firstToken.ok && secondToken.ok) expect(secondToken.value.fence).toBeGreaterThan(firstToken.value.fence);
    expect(await firstTab.saveCheckpoint(checkpointFor(session))).toMatchObject({
      ok: false,
      error: { code: 'conflict' },
    });
    expect((await secondTab.saveCheckpoint(checkpointFor(session))).ok).toBe(true);
  });
});

describe('M04 quota and storage status', () => {
  it('maps IndexedDB quota failures to the typed quota error', async () => {
    const repository = makeRepository({
      faultInjector: {
        beforeWrite(store) {
          if (store === STORES.profiles) throw new DOMException('full', 'QuotaExceededError');
        },
      },
    });
    await repository.initialize();
    expect(await repository.createProfile({
      name: profileA.name,
      avatarToken: profileA.avatarToken,
      analyticsZone: profileA.analyticsZone,
      settings: profileA.settings,
    })).toMatchObject({ ok: false, error: { code: 'quota', retryable: true } });
    expect(await repository.listProfiles()).toEqual({ ok: true, value: [] });
  });

  it('reports quota estimates and a granted durable-storage request', async () => {
    const repository = makeRepository({
      storageManager: {
        persisted: async () => false,
        persist: async () => true,
        estimate: async () => ({ quota: 10_000, usage: 2_000 }),
      },
    });
    await repository.initialize();
    expect(await repository.storageStatus()).toEqual({
      ok: true,
      value: {
        available: true,
        persisted: true,
        quotaBytes: 10_000,
        usageBytes: 2_000,
        mode: 'durable',
      },
    });
  });
});

describe('M04 cursor pagination', () => {
  it('uses a query-bound opaque cursor without skipping equal timestamps', async () => {
    const repository = makeRepository();
    await repository.initialize();
    const profile = await createFixtureProfile(repository);
    const ids = [1, 2, 3, 4, 5].map(sessionId);
    for (const id of ids) {
      const session: SessionRecord = {
        ...completedSession,
        id,
        profileId: profile.id,
        startedAt: '2026-09-18T09:59:00.000Z',
        endedAt: '2026-09-18T10:00:00.000Z',
      };
      const commit = fullCommit(session);
      commit.aggregateChanges = undefined;
      commit.lessonProgress = undefined;
      commit.series = undefined;
      commit.mistakes = [];
      commit.exposures = [];
      commit.updateProfileCharacterStats = false;
      await repository.commitSession(commit);
    }

    const found: string[] = [];
    let cursor: string | null | undefined;
    do {
      const page = await repository.querySessions({
        profileId: profile.id,
        mode: 'practice',
        includeIneligible: true,
        from: '2026-09-18T00:00:00.000Z',
        to: '2026-09-19T00:00:00.000Z',
        limit: 2,
        cursor,
      });
      expect(page.ok).toBe(true);
      if (!page.ok) break;
      found.push(...page.value.sessions.map((session) => session.id));
      cursor = page.value.nextCursor;
    } while (cursor);

    expect(found).toEqual([...ids].reverse());
    expect(new Set(found).size).toBe(ids.length);
    expect(await repository.querySessions({ profileId: profile.id, limit: 201 })).toMatchObject({
      ok: false,
      error: { code: 'invalid' },
    });
  });
});

describe('M04 aggregate rebuilding', () => {
  it('rebuilds daily and character aggregates solely from retained source records', async () => {
    const name = randomDatabaseName();
    const repository = makeRepository({ databaseName: name });
    await repository.initialize();
    const profile = await createFixtureProfile(repository);
    const session = { ...midnightSession, profileId: profile.id };
    const slices = midnightSessionDaySlices.map((slice) => ({ ...slice, profileId: profile.id }));
    await repository.commitSession(fullCommit(session, slices));
    const expectedCharacters = await repository.getCharacterStats(profile.id);

    const database = await openDatabase(name);
    await withTransaction(database, [STORES.dailyAggregates, STORES.profileCharacterStats], 'readwrite', async (transaction) => {
      await requestResult(transaction.objectStore(STORES.dailyAggregates).clear());
      await requestResult(transaction.objectStore(STORES.profileCharacterStats).clear());
    });
    database.close();

    expect((await repository.rebuildAggregates(profile.id)).ok).toBe(true);
    expect((await repository.rebuildCharacterStats(profile.id)).ok).toBe(true);
    expect(await repository.getDailyAggregates(profile.id, '2026-09-20', '2026-09-22')).toMatchObject({
      ok: true,
      value: [
        { day: '2026-09-20', activeMs: 30_000, attempts: 100, eligibleRetainedCorrect: 90, bestWpm: 37 },
        { day: '2026-09-21', activeMs: 90_000, attempts: 300, eligibleRetainedCorrect: 280, bestWpm: 37 },
      ],
    });
    expect(await repository.getCharacterStats(profile.id)).toEqual(expectedCharacters);
  });
});

describe('M04 native browser IndexedDB', () => {
  const chrome = '/usr/bin/google-chrome';

  it.skipIf(!existsSync(chrome))('runs atomic commit, duplicate detection, and cascade deletion in headless Chrome', async () => {
    let server: ViteDevServer | null = null;
    let browserProfile: string | null = null;
    let browser: ChildProcessWithoutNullStreams | null = null;
    let devtools: WebSocket | null = null;
    try {
      const html = `<!doctype html><html><body><pre id="result">pending</pre><script type="module">
        import { IndexedDbRepository } from '/src/platform/web/repository.ts';
        import { completedSession, profileA } from '/tests/fixtures/contracts/index.ts';
        const output = document.querySelector('#result');
        try {
          const repo = new IndexedDbRepository('m04-native-' + crypto.randomUUID());
          const initialized = await repo.initialize();
          if (!initialized.ok) throw new Error(initialized.error.code);
          const created = await repo.createProfile({ name: profileA.name, avatarToken: profileA.avatarToken, analyticsZone: profileA.analyticsZone, settings: profileA.settings });
          if (!created.ok) throw new Error(created.error.code);
          const session = { ...completedSession, profileId: created.value.id };
          const slice = { sessionId: session.id, profileId: session.profileId, day: '2026-09-18', zone: session.analyticsZone, activeMs: session.activeMs, attempts: session.attempts, correctAttempts: session.correctAttempts, errorAttempts: session.errorAttempts, completedWords: session.completedWords, eligibleActiveMs: session.activeMs, eligibleRetainedCorrect: session.retainedCorrect };
          const commit = { session, daySlices: [slice], mistakes: [], exposures: [], aggregateChanges: [{ profileId: session.profileId, day: slice.day, zone: slice.zone, metricVersion: 1, activeMs: slice.activeMs, attempts: slice.attempts, correctAttempts: slice.correctAttempts, errorAttempts: slice.errorAttempts, completedWords: slice.completedWords, eligibleActiveMs: slice.eligibleActiveMs, eligibleRetainedCorrect: slice.eligibleRetainedCorrect, eligibleSessionCount: 1, bestWpm: session.adjustedWpm, revision: 0 }] };
          const first = await repo.commitSession(commit);
          const duplicate = await repo.commitSession(commit);
          const aggregate = await repo.getDailyAggregates(created.value.id, '2026-09-18', '2026-09-19');
          const deleted = await repo.deleteProfile(created.value.id);
          const after = await repo.querySessions({ profileId: created.value.id, includeIneligible: true, limit: 10 });
          const passed = first.ok && !first.value.alreadyCommitted && duplicate.ok && duplicate.value.alreadyCommitted && aggregate.ok && aggregate.value[0]?.attempts === 300 && deleted.ok && after.ok && after.value.sessions.length === 0 && localStorage.length === 0;
          output.textContent = passed ? 'M04_BROWSER_OK' : 'M04_BROWSER_FAIL:' + JSON.stringify({ first, duplicate, aggregate, deleted, after });
          repo.close();
        } catch (error) {
          output.textContent = 'M04_BROWSER_ERROR:' + (error?.stack ?? String(error));
        }
      </script></body></html>`;
      server = await createServer({
        configFile: false,
        root: process.cwd(),
        logLevel: 'silent',
        server: { host: '127.0.0.1', port: 0 },
        plugins: [{
          name: 'm04-browser-harness',
          configureServer(viteServer) {
            viteServer.middlewares.use('/__m04_browser__', (_request, response) => {
              response.statusCode = 200;
              response.setHeader('Content-Type', 'text/html');
              response.end(html);
            });
          },
        }],
      });
      await server.listen();
      const address = server.httpServer?.address();
      if (!address || typeof address === 'string') throw new Error('Vite did not expose a test port');
      browserProfile = await mkdtemp(join(tmpdir(), 'flashfinger-m04-chrome-'));
      browser = spawn(chrome, [
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--remote-debugging-port=0',
        `--user-data-dir=${browserProfile}`,
        'about:blank',
      ]);
      browser.stderr.setEncoding('utf8');
      const browserWebSocket = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Chrome DevTools endpoint timed out')), 10_000);
        browser?.stderr.on('data', (chunk: string) => {
          const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(chunk);
          if (match?.[1]) {
            clearTimeout(timeout);
            resolve(match[1]);
          }
        });
        browser?.once('exit', (code) => {
          clearTimeout(timeout);
          reject(new Error(`Chrome exited before DevTools was ready (${code})`));
        });
      });
      const debuggingPort = new URL(browserWebSocket).port;
      const harnessUrl = `http://127.0.0.1:${address.port}/__m04_browser__`;
      const targetResponse = await fetch(
        `http://127.0.0.1:${debuggingPort}/json/new?${encodeURIComponent(harnessUrl)}`,
        { method: 'PUT' },
      );
      const target = await targetResponse.json() as { webSocketDebuggerUrl: string };
      devtools = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise<void>((resolve, reject) => {
        devtools?.addEventListener('open', () => resolve(), { once: true });
        devtools?.addEventListener('error', () => reject(new Error('Could not connect to Chrome target')), { once: true });
      });
      let commandId = 0;
      const pending = new Map<number, (value: unknown) => void>();
      devtools.addEventListener('message', (event) => {
        const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: unknown };
        if (message.id !== undefined) {
          pending.get(message.id)?.(message.error ?? message.result);
          pending.delete(message.id);
        }
      });
      const command = (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
        const id = ++commandId;
        const response = new Promise<unknown>((resolve) => pending.set(id, resolve));
        devtools?.send(JSON.stringify({ id, method, params }));
        return response;
      };
      await command('Runtime.enable');
      const deadline = Date.now() + 20_000;
      let browserResult = 'pending';
      while (Date.now() < deadline) {
        const evaluated = await command('Runtime.evaluate', {
          expression: "document.querySelector('#result')?.textContent ?? 'missing'",
          returnByValue: true,
        }) as { result?: { value?: string } };
        browserResult = evaluated.result?.value ?? 'missing';
        if (browserResult.startsWith('M04_BROWSER_')) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(browserResult).toBe('M04_BROWSER_OK');
    } finally {
      devtools?.close();
      if (browser && browser.exitCode === null) {
        const exited = new Promise<void>((resolve) => browser?.once('exit', () => resolve()));
        browser.kill('SIGTERM');
        await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
        if (browser.exitCode === null) browser.kill('SIGKILL');
      }
      if (server) await server.close();
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (browserProfile) await rm(browserProfile, { recursive: true, force: true });
    }
  }, 35_000);
});
