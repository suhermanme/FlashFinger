import type { InstallationSettings, Profile, ProfileId, ProfileSettings } from '../contracts/models.js';
import type { Repository, RepositoryError, RepositoryResult } from '../contracts/repository.js';
import type { AppStore } from '../state/app.js';
import type { ProfilesStore } from '../state/profiles.js';
import type { RuntimeStore } from '../state/runtime.js';
import type { SettingsStore } from '../state/settings.js';

export interface ProfileCoordinatorStores {
  app: AppStore;
  profiles: ProfilesStore;
  settings: SettingsStore;
  runtime: RuntimeStore;
}

export type SwitchOutcome =
  | { status: 'switched'; profileId: ProfileId }
  | { status: 'blocked'; reason: 'active-session' | 'unsaved-result' }
  | { status: 'cancelled' }
  | { status: 'failed'; error: RepositoryError };

function unavailable(message: string): RepositoryError {
  return { code: 'unavailable', message, retryable: true };
}

export class ProfileCoordinator {
  private generation = 0;

  constructor(
    private readonly repository: Repository,
    private readonly stores: ProfileCoordinatorStores,
  ) {}

  async initialize(): Promise<RepositoryResult<void>> {
    this.stores.app.setState({ bootState: 'booting', error: null });
    const initialized = await this.repository.initialize();
    if (!initialized.ok) {
      this.stores.app.setState({ bootState: 'error', adapterAvailable: false, error: initialized.error });
      return initialized;
    }
    const [profilesResult, installationResult] = await Promise.all([
      this.repository.listProfiles(),
      this.repository.loadInstallationSettings(),
    ]);
    if (!profilesResult.ok) {
      this.stores.app.setState({ bootState: 'error', error: profilesResult.error });
      return profilesResult;
    }
    if (!installationResult.ok) {
      this.stores.app.setState({ bootState: 'error', error: installationResult.error });
      return installationResult;
    }
    this.stores.profiles.setState({ profiles: profilesResult.value, hydration: 'idle', error: null });
    this.stores.app.setState({ installationSettings: installationResult.value, adapterAvailable: true });
    const preferred = installationResult.value.activeProfileId;
    const target = preferred && profilesResult.value.some((profile) => profile.id === preferred)
      ? preferred
      : profilesResult.value[0]?.id ?? null;
    if (!target) {
      this.stores.app.setState({ bootState: 'ready', activeProfileId: null });
      return { ok: true, value: undefined };
    }
    const switched = await this.switchProfile(target, { initial: true });
    if (switched.status === 'failed') return { ok: false, error: switched.error };
    return { ok: true, value: undefined };
  }

  cancelPendingHydration(): void {
    this.generation += 1;
  }

  async switchProfile(
    profileId: ProfileId,
    options: { discardUnsavedResult?: boolean; initial?: boolean } = {},
  ): Promise<SwitchOutcome> {
    const runtime = this.stores.runtime.getState();
    if (!options.initial && runtime.profileId !== profileId) {
      if (runtime.engineState === 'running' || runtime.engineState === 'paused' || runtime.engineState === 'finalizing') {
        return { status: 'blocked', reason: 'active-session' };
      }
      if (runtime.pendingResult && !runtime.pendingResult.saved && !options.discardUnsavedResult) {
        return { status: 'blocked', reason: 'unsaved-result' };
      }
    }
    const profile = this.stores.profiles.getState().profiles.find((item) => item.id === profileId);
    if (!profile) return { status: 'failed', error: unavailable(`Profile not found: ${profileId}`) };
    const token = ++this.generation;
    this.stores.profiles.setState({ hydration: 'loading', generation: token, error: null });
    const settingsResult = await this.repository.loadProfileSettings(profileId);
    if (token !== this.generation) return { status: 'cancelled' };
    if (!settingsResult.ok) {
      this.stores.profiles.setState({ hydration: 'error', error: settingsResult.error });
      return { status: 'failed', error: settingsResult.error };
    }

    // Publish only after all profile-owned reads have succeeded. Consumers never
    // see new settings paired with the prior profile's runtime state.
    this.stores.settings.setState({
      profileId,
      values: settingsResult.value,
      dirty: false,
      saveState: 'idle',
      error: null,
    });
    this.stores.runtime.resetForProfile(profileId);
    this.stores.profiles.setState({ activeProfileId: profileId, hydration: 'ready', generation: token, error: null });

    const installation = this.stores.app.getState().installationSettings;
    const nextInstallation: InstallationSettings | null = installation
      ? { ...installation, activeProfileId: profileId }
      : null;
    this.stores.app.setState({
      bootState: 'ready',
      activeProfileId: profileId,
      installationSettings: nextInstallation,
      error: null,
    });
    if (nextInstallation && installation?.activeProfileId !== profileId) {
      const saved = await this.repository.saveInstallationSettings(nextInstallation);
      if (!saved.ok && token === this.generation) this.stores.app.setState({ error: saved.error });
    }
    return { status: 'switched', profileId };
  }

  async saveActiveSettings(): Promise<RepositoryResult<void>> {
    const state = this.stores.settings.getState();
    if (!state.profileId || !state.values) {
      return { ok: false, error: unavailable('No hydrated profile settings are available') };
    }
    const profileId = state.profileId;
    const values = structuredClone(state.values);
    const token = this.generation;
    this.stores.settings.setState({ saveState: 'saving', error: null });
    const result = await this.repository.saveProfileSettings(profileId, values);
    if (token !== this.generation || this.stores.settings.getState().profileId !== profileId) return result;
    this.stores.settings.setState(result.ok
      ? { dirty: false, saveState: 'saved', error: null }
      : { dirty: true, saveState: 'error', error: result.error });
    if (result.ok) {
      this.stores.profiles.setState((current) => ({
        profiles: current.profiles.map((profile) => profile.id === profileId
          ? { ...profile, settings: values, revision: profile.revision + 1 }
          : profile),
      }));
    }
    return result;
  }

  async createProfile(input: {
    name: string;
    avatarToken: string;
    analyticsZone: string;
    settings: ProfileSettings;
  }): Promise<RepositoryResult<Profile>> {
    const result = await this.repository.createProfile(input);
    if (result.ok) this.stores.profiles.setState((state) => ({ profiles: [...state.profiles, result.value] }));
    return result;
  }

  async updateProfile(profile: Profile): Promise<RepositoryResult<Profile>> {
    const result = await this.repository.updateProfile(profile);
    if (result.ok) this.stores.profiles.setState((state) => ({
      profiles: state.profiles.map((item) => item.id === result.value.id ? result.value : item),
    }));
    return result;
  }

  async deleteProfile(profileId: ProfileId): Promise<RepositoryResult<void>> {
    const runtime = this.stores.runtime.getState();
    if (runtime.profileId === profileId
      && (runtime.engineState === 'running' || runtime.engineState === 'paused' || runtime.engineState === 'finalizing')) {
      return { ok: false, error: { code: 'conflict', message: 'Active session blocks profile deletion', retryable: true } };
    }
    if (runtime.profileId === profileId && runtime.pendingResult?.saved === false) {
      return { ok: false, error: { code: 'conflict', message: 'Unsaved result blocks profile deletion', retryable: true } };
    }
    const result = await this.repository.deleteProfile(profileId);
    if (!result.ok) return result;
    this.stores.profiles.setState((state) => ({ profiles: state.profiles.filter((item) => item.id !== profileId) }));
    if (this.stores.profiles.getState().activeProfileId === profileId) {
      this.cancelPendingHydration();
      this.stores.settings.setState({ profileId: null, values: null, dirty: false, saveState: 'idle', error: null });
      this.stores.runtime.resetForProfile(null);
      this.stores.profiles.setState({ activeProfileId: null, hydration: 'idle' });
      this.stores.app.setState({ activeProfileId: null });
    }
    return result;
  }
}
