import { createStore, type StoreApi } from 'zustand/vanilla';
import type { InstallationSettings, ProfileId } from '../contracts/models.js';
import type { RepositoryError } from '../contracts/repository.js';

export type AppRoute = 'profiles' | 'typing' | 'settings';
export type BootState = 'idle' | 'booting' | 'ready' | 'error';

export interface AppState {
  bootState: BootState;
  route: AppRoute;
  activeProfileId: ProfileId | null;
  installationSettings: InstallationSettings | null;
  adapterAvailable: boolean;
  error: RepositoryError | null;
}

export type AppStore = StoreApi<AppState>;

export function createAppStore(initial: Partial<AppState> = {}): AppStore {
  return createStore<AppState>()(() => ({
    bootState: 'idle',
    route: 'profiles',
    activeProfileId: null,
    installationSettings: null,
    adapterAvailable: true,
    error: null,
    ...initial,
  }));
}
