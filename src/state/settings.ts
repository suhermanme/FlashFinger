import { createStore, type StoreApi } from 'zustand/vanilla';
import type { ProfileId, ProfileSettings, ResolvedTheme } from '../contracts/models.js';
import type { RepositoryError } from '../contracts/repository.js';

export type SettingsSaveState = 'idle' | 'saving' | 'saved' | 'error';

export interface SettingsState {
  profileId: ProfileId | null;
  values: ProfileSettings | null;
  resolvedTheme: ResolvedTheme;
  dirty: boolean;
  saveState: SettingsSaveState;
  error: RepositoryError | null;
}

export type SettingsStore = StoreApi<SettingsState>;

export function createSettingsStore(): SettingsStore {
  return createStore<SettingsState>()(() => ({
    profileId: null,
    values: null,
    resolvedTheme: 'light',
    dirty: false,
    saveState: 'idle',
    error: null,
  }));
}

export function updateSettings(store: SettingsStore, patch: Partial<ProfileSettings>): void {
  const state = store.getState();
  if (!state.values) return;
  store.setState({ values: { ...state.values, ...patch }, dirty: true, saveState: 'idle', error: null });
}
