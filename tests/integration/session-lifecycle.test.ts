import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DesktopRepository } from '../../electron/storage/repository.js';
import type { ActiveCheckpoint, Profile, SessionConfig } from '../../src/contracts/models.js';
import { err, ok, type Repository, type RepositoryResult, type CommitOutcome, type SessionCommit } from '../../src/contracts/repository.js';
import type { TrainingSource } from '../../src/contracts/training.js';
import { ProfileCoordinator } from '../../src/app/profileCoordinator.js';
import { SessionCoordinator } from '../../src/app/sessionCoordinator.js';
import { createMockRepository } from '../../src/platform/mock-repository.js';
import { createAppStore } from '../../src/state/app.js';
import { createProfilesStore } from '../../src/state/profiles.js';
import { createRuntimeStore } from '../../src/state/runtime.js';
import { createSettingsStore } from '../../src/state/settings.js';
import { PROFILE_A_ID, PROFILE_B_ID, profileA, profileB } from '../fixtures/contracts/index.js';

const SESSION_ID = '77777777-7777-4777-8777-777777777777';
const START_WALL = Date.parse('2026-09-21T08:00:00.000Z');

function source(text = 'abc', termination: TrainingSource['termination'] = { kind: 'complete-target' }): TrainingSource {
  const chunks = [text];
  return {
    id: 'fixture:fixed',
    version: 'fixture-v1',
    mode: 'practice',
    title: 'Fixed M11 source',
    correctionPolicy: 'advance',
    termination,
    eligibility: { disqualifiedByCompatibility: false, disqualifiedByPause: false, minimumActiveMs: 0 },
    graphemeCount: [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text)].length,
    chunkSize: 4_096,
    chunkAt: (index) => chunks[index] ?? null,
  };
}

function config(targetLength: number | null = 3, durationLimitMs: number | null = null): SessionConfig {
  return {
    mode: 'practice',
    correctionPolicy: 'advance',
    durationLimitMs,
    targetLength,
    sourceRef: 'fixture:fixed',
    contentVersion: 'fixture-v1',
    metricVersion: 1,
    layout: 'us-qwerty',
    compatibilityInput: false,
    heldKeyRepeat: 'ignored',
  };
}

function time() {
  let monotonic = 1_000;
  let wall = START_WALL;
  return {
    monotonicNow: () => monotonic,
    wallNow: () => wall,
    advance(ms: number) { monotonic += ms; wall += ms; },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

interface RepositoryHarness {
  repository: Repository;
  commits: SessionCommit[];
  checkpoints: ActiveCheckpoint[];
  deletedCheckpoints: string[];
}

function repository(overrides: Partial<Repository> = {}): RepositoryHarness {
  const commits: SessionCommit[] = [];
  const checkpoints: ActiveCheckpoint[] = [];
  const deletedCheckpoints: string[] = [];
  const value = Object.assign(createMockRepository(), {
    initialize: async () => ok(undefined),
    listProfiles: async () => ok([profileA, profileB] as Profile[]),
    loadProfileSettings: async (profileId: string) => ok(profileId === PROFILE_A_ID ? profileA.settings : profileB.settings),
    saveInstallationSettings: async () => ok(undefined),
    getDailyAggregates: async () => ok([]),
    saveCheckpoint: async (checkpoint: ActiveCheckpoint) => { checkpoints.push(structuredClone(checkpoint)); return ok(undefined); },
    deleteCheckpoint: async (sessionId: string) => { deletedCheckpoints.push(sessionId); return ok(undefined); },
    findLatestCheckpoint: async () => ok(checkpoints.at(-1) ?? null),
    commitSession: async (commit: SessionCommit) => {
      commits.push(commit);
      return ok({ alreadyCommitted: false, sessionId: commit.session.id });
    },
    ...overrides,
  });
  return { repository: value, commits, checkpoints, deletedCheckpoints };
}

function coordinator(harness: RepositoryHarness, clock = time(), overrides: Partial<ConstructorParameters<typeof SessionCoordinator>[0]> = {}) {
  const runtime = createRuntimeStore();
  runtime.resetForProfile(PROFILE_A_ID);
  const value = new SessionCoordinator({
    repository: harness.repository,
    runtime,
    profileId: PROFILE_A_ID,
    analyticsZone: 'Asia/Jakarta',
    source: source(),
    config: config(),
    monotonicNow: clock.monotonicNow,
    wallNow: clock.wallNow,
    randomUUID: () => SESSION_ID,
    ...overrides,
  });
  value.prepare();
  return { value, runtime, clock };
}

describe('M11 session lifecycle and durable result integration', () => {
  it('starts on the first accepted input, excludes paused time, and snapshots immutable config', async () => {
    const harness = repository();
    const original = config();
    const clock = time();
    const runtime = createRuntimeStore();
    runtime.resetForProfile(PROFILE_A_ID);
    const value = new SessionCoordinator({ repository: harness.repository, runtime, profileId: PROFILE_A_ID,
      analyticsZone: 'Asia/Jakarta', source: source(), config: original, monotonicNow: clock.monotonicNow,
      wallNow: clock.wallNow, randomUUID: () => SESSION_ID });
    value.prepare();
    clock.advance(10_000); // ready dwell must not count
    value.processCommand({ kind: 'character', grapheme: 'a' });
    original.layout = 'mutated-after-ready';
    clock.advance(1_000); value.tick();
    value.pause(true);
    clock.advance(5_000); value.resume();
    clock.advance(1_000); value.processCommand({ kind: 'character', grapheme: 'b' });
    const saved = await value.finish('aborted');
    expect(saved.ok).toBe(true);
    expect(harness.commits[0].session).toMatchObject({ status: 'aborted', activeMs: 2_000,
      attempts: 2, startedAt: '2026-09-21T08:00:10.000Z', config: { layout: 'us-qwerty' } });
    expect(value.config.layout).toBe('us-qwerty');
  });

  it('queues checkpoints outside the input turn at five active seconds and on pause', async () => {
    const tasks: Array<() => void> = [];
    const harness = repository();
    const state = coordinator(harness, time(), { queueTask: (task) => tasks.push(task) });
    state.value.processCommand({ kind: 'character', grapheme: 'a' });
    state.clock.advance(4_999); state.value.tick();
    expect(tasks).toHaveLength(0);
    state.clock.advance(1); state.value.tick();
    expect(tasks).toHaveLength(1);
    expect(harness.checkpoints).toHaveLength(0);
    tasks.shift()!();
    await state.value.flushCheckpointWrites();
    expect(harness.checkpoints[0]).toMatchObject({ sessionId: SESSION_ID, activeMs: 5_000, counts: { attempts: 1 } });
    state.value.pause(true);
    expect(tasks).toHaveLength(1);
  });

  it('does not publish completion until the durable commit acknowledgement arrives', async () => {
    const acknowledgement = deferred<RepositoryResult<CommitOutcome>>();
    const harness = repository({ commitSession: async (commit) => { harness.commits.push(commit); return acknowledgement.promise; } });
    const state = coordinator(harness, time(), { source: source('a'), config: config(1) });
    const deltas = state.value.processCommand({ kind: 'character', grapheme: 'a' });
    expect(deltas.some((delta) => delta.kind === 'sessionEnd')).toBe(true);
    expect(state.value.getSnapshot()).toMatchObject({ phase: 'finalizing', result: { saved: false } });
    expect(state.runtime.getState()).toMatchObject({ engineState: 'finalizing', pendingResult: { saved: false } });
    acknowledgement.resolve(ok({ alreadyCommitted: false, sessionId: SESSION_ID }));
    expect(await state.value.finish('completed')).toEqual(ok({ alreadyCommitted: false, sessionId: SESSION_ID }));
    expect(state.value.getSnapshot()).toMatchObject({ phase: 'completed', result: { saved: true } });
  });

  it('retains a quota-failed result, blocks profile switching, and retries the identical commit idempotently', async () => {
    const attempts: SessionCommit[] = [];
    let call = 0;
    const harness = repository({ commitSession: async (commit) => {
      attempts.push(commit); call += 1;
      return call === 1
        ? err({ code: 'quota', message: 'Storage full', retryable: true })
        : ok({ alreadyCommitted: true, sessionId: commit.session.id });
    } });
    const state = coordinator(harness, time(), { source: source('a'), config: config(1) });
    state.value.processCommand({ kind: 'character', grapheme: 'a' });
    expect(await state.value.finish('completed')).toMatchObject({ ok: false, error: { code: 'quota' } });
    expect(state.value.getSnapshot()).toMatchObject({ phase: 'save-failed', result: { saved: false, error: { code: 'quota' } } });

    const stores = { app: createAppStore(), profiles: createProfilesStore(), settings: createSettingsStore(), runtime: state.runtime };
    stores.profiles.setState({ profiles: [profileA, profileB] as Profile[], activeProfileId: PROFILE_A_ID });
    const profileCoordinator = new ProfileCoordinator(harness.repository, stores);
    expect(await profileCoordinator.switchProfile(PROFILE_B_ID)).toEqual({ status: 'blocked', reason: 'unsaved-result' });

    const firstRetry = state.value.retrySave();
    const coalescedRetry = state.value.retrySave();
    expect(await firstRetry).toEqual(ok({ alreadyCommitted: true, sessionId: SESSION_ID }));
    expect(await coalescedRetry).toEqual(ok({ alreadyCommitted: true, sessionId: SESSION_ID }));
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toBe(attempts[0]);
    expect(state.value.getSnapshot()).toMatchObject({ phase: 'completed', result: { saved: true, alreadyCommitted: true } });
  });

  it('keeps or discards an interrupted checkpoint without treating it as a resumed scored run', async () => {
    const checkpoint: ActiveCheckpoint = {
      sessionId: SESSION_ID,
      profileId: PROFILE_A_ID,
      config: config(),
      checkpointAt: '2026-09-21T08:00:05.000Z',
      lastSequence: 1,
      activeMs: 5_000,
      counts: { attempts: 1, correctAttempts: 1, errorAttempts: 0, backspaces: 0, retainedCorrect: 1 },
      textCursor: 1,
      generationState: null,
      cappedRecentEdits: [{ sequence: 1, kind: 'insert', position: 0, grapheme: 'a', correct: true }],
    };
    const keepHarness = repository({ findLatestCheckpoint: async () => ok(checkpoint) });
    const keep = coordinator(keepHarness);
    expect(await keep.value.findInterruptedCheckpoint()).toEqual(ok(checkpoint));
    const kept = await keep.value.resolveInterruptedCheckpoint(checkpoint, 'keep');
    expect(kept.ok).toBe(true);
    expect(keepHarness.commits[0]).toMatchObject({ session: { id: SESSION_ID, status: 'interrupted', eligibleForBest: false },
      removeCheckpointId: SESSION_ID });

    const discardHarness = repository();
    const discard = coordinator(discardHarness);
    expect(await discard.value.resolveInterruptedCheckpoint(checkpoint, 'discard')).toEqual(ok(null));
    expect(discardHarness.deletedCheckpoints).toEqual([SESSION_ID]);
    expect(discardHarness.commits).toHaveLength(0);
  });

  it('finalizes a timed run before accepting input past its monotonic deadline', async () => {
    const harness = repository();
    const clock = time();
    const state = coordinator(harness, clock, { source: source('abcdef', { kind: 'duration', durationMs: 1_000 }),
      config: config(null, 1_000) });
    state.value.processCommand({ kind: 'character', grapheme: 'a' });
    clock.advance(1_000);
    const deltas = state.value.processCommand({ kind: 'character', grapheme: 'b' });
    expect(deltas.some((delta) => delta.kind === 'rejected' && delta.reason === 'deadline-passed')).toBe(true);
    expect(deltas.some((delta) => delta.kind === 'sessionEnd')).toBe(true);
    expect((await state.value.finish('completed')).ok).toBe(true);
    expect(harness.commits[0].session).toMatchObject({ attempts: 1, activeMs: 1_000, status: 'completed' });
  });

  it('acquires browser-style profile ownership before ready and releases it after durable save', async () => {
    const acquired = deferred<RepositoryResult<{ profileId: string; fence: number }>>();
    const releaseAcknowledgement = deferred<RepositoryResult<void>>();
    const released: unknown[] = [];
    const harness = repository();
    Object.assign(harness.repository, {
      acquireSessionOwnership: async () => acquired.promise,
      releaseSessionOwnership: async (token: unknown) => { released.push(token); return releaseAcknowledgement.promise; },
    });
    const clock = time();
    const runtime = createRuntimeStore();
    runtime.resetForProfile(PROFILE_A_ID);
    const value = new SessionCoordinator({ repository: harness.repository, runtime, profileId: PROFILE_A_ID,
      analyticsZone: 'Asia/Jakarta', source: source('a'), config: config(1), monotonicNow: clock.monotonicNow,
      wallNow: clock.wallNow, randomUUID: () => SESSION_ID });
    const preparing = value.prepare();
    expect(value.getSnapshot().phase).toBe('preparing');
    expect(value.processCommand({ kind: 'character', grapheme: 'a' })).toEqual([{ kind: 'rejected', reason: 'not-editable' }]);
    const token = { profileId: PROFILE_A_ID, fence: 1 };
    acquired.resolve(ok(token));
    expect(await preparing).toEqual(ok(undefined));
    value.processCommand({ kind: 'character', grapheme: 'a' });
    const finishing = value.finish('completed');
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    expect(value.getSnapshot()).toMatchObject({ phase: 'completed', result: { saved: true } });
    expect(released).toEqual([token]);
    releaseAcknowledgement.resolve(ok(undefined));
    expect((await finishing).ok).toBe(true);
  });

  it('commits through the real durable desktop repository contract', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'flashfinger-m11-'));
    try {
      const durable = new DesktopRepository({ rootDirectory: directory, randomUUID: () => PROFILE_A_ID, compactAfterRecords: 0 });
      expect(await durable.initialize()).toEqual(ok(undefined));
      expect((await durable.createProfile({ name: profileA.name, avatarToken: profileA.avatarToken,
        analyticsZone: profileA.analyticsZone, settings: profileA.settings })).ok).toBe(true);
      const runtime = createRuntimeStore();
      runtime.resetForProfile(PROFILE_A_ID);
      const clock = time();
      const value = new SessionCoordinator({ repository: durable, runtime, profileId: PROFILE_A_ID,
        analyticsZone: profileA.analyticsZone, source: source('a'), config: config(1), monotonicNow: clock.monotonicNow,
        wallNow: clock.wallNow, randomUUID: () => SESSION_ID });
      await value.prepare();
      value.processCommand({ kind: 'character', grapheme: 'a' });
      expect((await value.finish('completed')).ok).toBe(true);
      expect(await durable.getSession(SESSION_ID)).toMatchObject({ ok: true, value: { id: SESSION_ID, attempts: 1, status: 'completed' } });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('splits active time at the profile-local midnight boundary', async () => {
    let monotonic = 0;
    let wall = Date.parse('2026-09-20T16:59:59.000Z'); // 23:59:59 in Jakarta
    const harness = repository();
    const state = coordinator(harness, {
      monotonicNow: () => monotonic,
      wallNow: () => wall,
      advance(ms: number) { monotonic += ms; wall += ms; },
    }, { source: source('abc'), config: config(3) });
    state.value.processCommand({ kind: 'character', grapheme: 'a' });
    state.clock.advance(2_000);
    state.value.tick();
    expect((await state.value.finish('aborted')).ok).toBe(true);
    expect(harness.commits[0].daySlices).toEqual([
      expect.objectContaining({ day: '2026-09-20', activeMs: 1_000, attempts: 1 }),
      expect.objectContaining({ day: '2026-09-21', activeMs: 1_000, attempts: 0 }),
    ]);
  });
});
