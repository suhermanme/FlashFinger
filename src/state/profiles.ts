import { createStore, type StoreApi } from 'zustand/vanilla';
import type { Profile, ProfileId } from '../contracts/models.js';
import type { RepositoryError } from '../contracts/repository.js';

export type ProfileHydrationState = 'idle' | 'loading' | 'ready' | 'error';

export interface ProfilesState {
  profiles: Profile[];
  activeProfileId: ProfileId | null;
  hydration: ProfileHydrationState;
  generation: number;
  error: RepositoryError | null;
}

export type ProfilesStore = StoreApi<ProfilesState>;

export function createProfilesStore(): ProfilesStore {
  return createStore<ProfilesState>()(() => ({
    profiles: [],
    activeProfileId: null,
    hydration: 'idle',
    generation: 0,
    error: null,
  }));
}
