import { describe, expect, it } from 'vitest';
import { capRollingPoints, sampleRolling } from '../../../src/domain/metrics/rolling.js';

describe('release performance qualification', () => {
  it('keeps the live analytics window bounded under synthetic bursts', () => {
    const points = Array.from({ length: 30_000 }, (_, i) => ({ atMs: i * 33, activeMs: 33, attempts: 1, correctAttempts: 1 }));
    const start = performance.now(); const capped = capRollingPoints(points, 240); const sample = sampleRolling(capped, points[points.length - 1].atMs); const elapsed = performance.now() - start;
    expect(capped).toHaveLength(240); expect(sample.wpm).not.toBeNull(); expect(elapsed).toBeLessThan(100);
  });
});
