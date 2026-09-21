import { describe, expect, it } from 'vitest';
import type { InstallationSettings, Profile, ProfileSettings } from '../../src/contracts/models.js';
import { err, ok, type Repository } from '../../src/contracts/repository.js';
import { createMockRepository } from '../../src/platform/mock-repository.js';
import { ProfileCoordinator } from '../../src/app/profileCoordinator.js';
import { createAppStore } from '../../src/state/app.js';
import { createProfilesStore } from '../../src/state/profiles.js';
import { createRuntimeStore } from '../../src/state/runtime.js';
import { createSettingsStore, updateSettings } from '../../src/state/settings.js';
import { PROFILE_A_ID, PROFILE_B_ID, profileA, profileB } from '../fixtures/contracts/index.js';

const installation: InstallationSettings = {
  schemaVersion: 1,
  activeProfileId: PROFILE_A_ID,
  lastResolvedTheme: 'light',
  appBuild: 'test',
  onboardingComplete: true,
};

function stores() {
  return {
    app: createAppStore(),
    profiles: createProfilesStore(),
    settings: createSettingsStore(),
    runtime: createRuntimeStore(),
  };
}

function repository(overrides: Partial<Repository> = {}): Repository {
  return Object.assign(createMockRepository(), {
    initialize: async () => ok(undefined),
    listProfiles: async () => ok([profileA, profileB] as Profile[]),
    loadInstallationSettings: async () => ok(installation),
    saveInstallationSettings: async () => ok(undefined),
    loadProfileSettings: async (profileId: string) => {
      const profile = [profileA, profileB].find((item) => item.id === profileId);
      return profile ? ok(profile.settings as ProfileSettings) : err({ code: 'not-found', message: 'missing', retryable: false });
    },
    saveProfileSettings: async () => ok(undefined),
    ...overrides,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('M06 profile lifecycle coordinator', () => {
  it('hydrates installation, active profile, settings, and runtime coherently', async () => {
    const state = stores();
    const coordinator = new ProfileCoordinator(repository(), state);
    expect(await coordinator.initialize()).toEqual({ ok: true, value: undefined });
    expect(state.app.getState()).toMatchObject({ bootState: 'ready', activeProfileId: PROFILE_A_ID });
    expect(state.profiles.getState()).toMatchObject({ activeProfileId: PROFILE_A_ID, hydration: 'ready' });
    expect(state.settings.getState()).toMatchObject({ profileId: PROFILE_A_ID, values: profileA.settings, dirty: false });
    expect(state.runtime.getState()).toMatchObject({ profileId: PROFILE_A_ID, engineState: 'idle', pendingResult: null });
  });

  it('blocks profile switching for active and unsaved sessions until explicitly discarded', async () => {
    const state = stores();
    const coordinator = new ProfileCoordinator(repository(), state);
    await coordinator.initialize();
    state.runtime.setSession('99999999-9999-4999-8999-999999999999', 'running');
    expect(await coordinator.switchProfile(PROFILE_B_ID)).toEqual({ status: 'blocked', reason: 'active-session' });
    state.runtime.setSession(null, 'completed');
    state.runtime.setPendingResult({ sessionId: '99999999-9999-4999-8999-999999999999', saved: false });
    expect(await coordinator.switchProfile(PROFILE_B_ID)).toEqual({ status: 'blocked', reason: 'unsaved-result' });
    expect(await coordinator.switchProfile(PROFILE_B_ID, { discardUnsavedResult: true })).toEqual({
      status: 'switched', profileId: PROFILE_B_ID,
    });
    expect(state.runtime.getState()).toMatchObject({ profileId: PROFILE_B_ID, pendingResult: null, sessionId: null });
  });

  it('does not delete the active profile while a session or unsaved result owns it', async () => {
    const state = stores();
    let deletions = 0;
    const coordinator = new ProfileCoordinator(repository({ deleteProfile: async () => { deletions += 1; return ok(undefined); } }), state);
    await coordinator.initialize();
    state.runtime.setSession('99999999-9999-4999-8999-999999999999', 'running');
    expect(await coordinator.deleteProfile(PROFILE_A_ID)).toMatchObject({ ok: false, error: { code: 'conflict' } });
    state.runtime.setSession(null, 'completed');
    state.runtime.setPendingResult({ sessionId: '99999999-9999-4999-8999-999999999999', saved: false });
    expect(await coordinator.deleteProfile(PROFILE_A_ID)).toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect(deletions).toBe(0);
  });

  it('generation-fences a delayed old profile request', async () => {
    const oldRequest = deferred<ReturnType<typeof ok<ProfileSettings>>>();
    const state = stores();
    state.profiles.setState({ profiles: [profileA, profileB] as Profile[] });
    const repo = repository({
      loadProfileSettings: async (profileId) => profileId === PROFILE_A_ID
        ? oldRequest.promise
        : ok(profileB.settings),
    });
    const coordinator = new ProfileCoordinator(repo, state);
    const oldSwitch = coordinator.switchProfile(PROFILE_A_ID, { initial: true });
    const newSwitch = coordinator.switchProfile(PROFILE_B_ID, { initial: true });
    expect(await newSwitch).toEqual({ status: 'switched', profileId: PROFILE_B_ID });
    oldRequest.resolve(ok(profileA.settings));
    expect(await oldSwitch).toEqual({ status: 'cancelled' });
    expect(state.settings.getState()).toMatchObject({ profileId: PROFILE_B_ID, values: profileB.settings });
    expect(state.runtime.getState().profileId).toBe(PROFILE_B_ID);
  });

  it('keeps failed saves dirty and never writes into a newly switched profile', async () => {
    const save = deferred<ReturnType<typeof err<void>>>();
    const state = stores();
    const repo = repository({ saveProfileSettings: async () => save.promise });
    const coordinator = new ProfileCoordinator(repo, state);
    await coordinator.initialize();
    updateSettings(state.settings, { muted: true });
    const saving = coordinator.saveActiveSettings();
    expect(state.settings.getState()).toMatchObject({ profileId: PROFILE_A_ID, dirty: true, saveState: 'saving' });
    await coordinator.switchProfile(PROFILE_B_ID);
    save.resolve(err({ code: 'quota', message: 'full', retryable: true }));
    expect(await saving).toMatchObject({ ok: false, error: { code: 'quota' } });
    expect(state.settings.getState()).toMatchObject({ profileId: PROFILE_B_ID, values: profileB.settings, dirty: false });
  });

  it('publishes metric snapshots no faster than four hertz', () => {
    const runtime = createRuntimeStore();
    let publications = 0;
    runtime.subscribe((state, previous) => {
      if (state.metricPublishedAt !== previous.metricPublishedAt) publications += 1;
    });
    const metrics = { activeMs: 100, attempts: 1, correctAttempts: 1, adjustedWpm: 12, accuracy: 100 };
    expect(runtime.publishMetrics(metrics, 0)).toBe(true);
    for (let now = 1; now < 1_000; now += 10) runtime.publishMetrics({ ...metrics, activeMs: now }, now);
    expect(publications).toBe(4);
    expect(runtime.getState().metricPublishedAt).toBe(751);
  });
});
