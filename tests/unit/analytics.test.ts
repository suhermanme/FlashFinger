import { describe, expect, it } from 'vitest';
import { aggregateSessions } from '../../src/domain/metrics/aggregates.js';
import { calendarDays, longestStreak } from '../../src/domain/metrics/calendar.js';
import { sampleRolling } from '../../src/domain/metrics/rolling.js';
import { prepareAnalyticsPayload } from '../../src/workers/analytics.worker.js';
import type { SessionRecord } from '../../src/contracts/models.js';

const session = (day: string, mode: 'practice' | 'custom' = 'practice', activeMs = 10_000): SessionRecord => ({ id: `${day}-${mode}`, profileId: 'p', config: { mode, correctionPolicy: 'strict', durationLimitMs: null, targetLength: null, sourceRef: 'x', contentVersion: '1', metricVersion: 1, layout: 'us-qwerty', compatibilityInput: false, heldKeyRepeat: 'ignored' }, startedAt: `${day}T00:00:00.000Z`, endedAt: `${day}T00:01:00.000Z`, analyticsZone: 'UTC', status: 'completed', activeMs, attempts: 100, correctAttempts: 90, errorAttempts: 10, backspaces: 0, retainedCorrect: 90, retainedErrors: 10, completedWords: 18, grossCpm: 600, adjustedWpm: 540, accuracy: 90, eligibleForBest: true, seed: null });
describe('analytics', () => {
  it('weights rolling bursts and caps old points', () => { const result = sampleRolling([{ atMs: 1000, activeMs: 1000, attempts: 10, correctAttempts: 8 }, { atMs: 4000, activeMs: 1000, attempts: 10, correctAttempts: 10 }], 5000, 5000); expect(result.attempts).toBe(20); expect(result.accuracy).toBe(90); expect(result.wpm).toBe(108); });
  it('aggregates modes and produces fixed calendar buckets', () => { const rows = aggregateSessions([session('2026-01-01'), session('2026-01-01', 'custom'), session('2026-01-02')], { modes: ['practice'] }); expect(rows).toHaveLength(2); const calendar = calendarDays(rows, '2026-01-01', '2026-01-04'); expect(calendar).toHaveLength(4); expect(longestStreak(calendar)).toBe(2); expect(prepareAnalyticsPayload([session('2026-01-01')], '2026-01-01', '2026-01-01').bars).toHaveLength(1); });
  it('handles zero-denominator rolling and sparse activity', () => { expect(sampleRolling([], 1000)).toMatchObject({ wpm: null, accuracy: null }); expect(calendarDays([], '2026-02-01', '2026-02-01')[0].level).toBe(0); });
});
