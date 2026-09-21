import { aggregateSessions } from '../domain/metrics/aggregates.js';
import { calendarDays } from '../domain/metrics/calendar.js';
import type { SessionRecord } from '../contracts/models.js';
export type AnalyticsRequest = { id: string; sessions: SessionRecord[]; from: string; to: string };
export function prepareAnalyticsPayload(sessions: readonly SessionRecord[], from: string, to: string) { const bars = aggregateSessions(sessions, { from, to }); return { bars, calendar: calendarDays(bars, from, to) }; }
const scope = globalThis as typeof globalThis & { postMessage?: (value: unknown) => void; onmessage?: (event: MessageEvent<AnalyticsRequest>) => void };
if (scope.constructor?.name === 'DedicatedWorkerGlobalScope') scope.onmessage = (event) => scope.postMessage?.({ id: event.data.id, ...prepareAnalyticsPayload(event.data.sessions, event.data.from, event.data.to) });
