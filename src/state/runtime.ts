import { createStore, type StoreApi } from 'zustand/vanilla';
import type { ProfileId, SessionId } from '../contracts/models.js';
import type { EngineState } from '../domain/typing/types.js';

export interface RuntimeMetrics {
  activeMs: number;
  attempts: number;
  correctAttempts: number;
  adjustedWpm: number | null;
  accuracy: number | null;
}

export interface PendingResult {
  sessionId: SessionId;
  saved: boolean;
}

export interface RuntimeState {
  profileId: ProfileId | null;
  sessionId: SessionId | null;
  engineState: EngineState;
  metrics: RuntimeMetrics;
  metricPublishedAt: number | null;
  pendingResult: PendingResult | null;
}

export interface RuntimeActions {
  resetForProfile(profileId: ProfileId | null): void;
  setSession(sessionId: SessionId | null, engineState: EngineState): void;
  setPendingResult(result: PendingResult | null): void;
  publishMetrics(metrics: RuntimeMetrics, nowMs: number): boolean;
}

export type RuntimeStore = StoreApi<RuntimeState> & RuntimeActions;
export const METRIC_PUBLICATION_INTERVAL_MS = 250;

const EMPTY_METRICS: RuntimeMetrics = {
  activeMs: 0,
  attempts: 0,
  correctAttempts: 0,
  adjustedWpm: null,
  accuracy: null,
};

export function createRuntimeStore(): RuntimeStore {
  const store = createStore<RuntimeState>()(() => ({
    profileId: null,
    sessionId: null,
    engineState: 'idle',
    metrics: EMPTY_METRICS,
    metricPublishedAt: null,
    pendingResult: null,
  }));
  return Object.assign(store, {
    resetForProfile(profileId: ProfileId | null): void {
      store.setState({
        profileId,
        sessionId: null,
        engineState: 'idle',
        metrics: { ...EMPTY_METRICS },
        metricPublishedAt: null,
        pendingResult: null,
      });
    },
    setSession(sessionId: SessionId | null, engineState: EngineState): void {
      store.setState({ sessionId, engineState });
    },
    setPendingResult(pendingResult: PendingResult | null): void {
      store.setState({ pendingResult });
    },
    publishMetrics(metrics: RuntimeMetrics, nowMs: number): boolean {
      const last = store.getState().metricPublishedAt;
      if (last !== null && nowMs - last < METRIC_PUBLICATION_INTERVAL_MS) return false;
      store.setState({ metrics, metricPublishedAt: nowMs });
      return true;
    },
  });
}
