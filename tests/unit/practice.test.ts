import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import type { PracticeConfig } from '../../src/contracts/models.js';
import {
  DictionaryConfigurationError,
  filterDictionary,
  parseDictionaryManifest,
  type DictionaryManifest,
} from '../../src/domain/training/dictionary.js';
import {
  BoundedPracticeBuffer,
  MAX_BUFFERED_PRACTICE_WORDS,
  PracticeWordGenerator,
  generatePracticeWords,
  preparePractice,
} from '../../src/domain/training/practice.js';
import { prepareDictionaryPayload } from '../../src/workers/dictionary.worker.js';

const words = ['able', 'bake', 'calm', 'dare', 'echo', 'flame', 'grape', 'house', 'ideal', 'jolly'];

function manifest(): DictionaryManifest {
  const entries = words.map((spelling, index) => ({
    id: `ff-en-${String(index + 1).padStart(5, '0')}`,
    spelling, graphemeLength: spelling.length,
    difficulty: index < 3 ? 'beginner' as const : index < 7 ? 'intermediate' as const : 'advanced' as const,
    frequencyBand: index < 3 ? 'high' as const : index < 7 ? 'general' as const : 'extended' as const,
    punctuationSuitable: true, capitalizationSuitable: true,
  }));
  return { id: 'ff-english-10k-v1', version: 'ff-english-10k-v1', language: 'en-US', source: 'fixture',
    sourceSha256: 'fixture', selectionPolicy: 'fixture',
    counts: { beginner: 3, intermediate: 4, advanced: 3, total: 10 }, entries };
}

function config(overrides: Partial<PracticeConfig> = {}): PracticeConfig {
  return { tier: 'mixed', termination: { kind: 'words', count: 25 }, punctuation: false,
    capitalization: false, seed: 'seed-a', correctionPolicy: 'advance', keyFilter: null, configVersion: 1,
    ...overrides };
}

describe('M13 dictionary preparation', () => {
  it('validates the licensed production pool and exact disjoint manifest counts', async () => {
    const raw = JSON.parse(await readFile(new URL('../../public/content/dictionaries/ff-english-10k-v1.json', import.meta.url), 'utf8'));
    const production = parseDictionaryManifest(raw);
    expect(production.counts).toEqual({ beginner: 1_000, intermediate: 4_000, advanced: 5_000, total: 10_000 });
    expect(new Set(production.entries.map((item) => item.spelling))).toHaveLength(10_000);
    expect(production.entries.every((item) => /^[a-z]{2,14}$/.test(item.spelling))).toBe(true);
  });

  it('filters explicit tiers and key focus, and rejects an empty pool', () => {
    const value = manifest();
    expect(filterDictionary(value, config({ tier: 'beginner' }))).toHaveLength(3);
    expect(filterDictionary(value, config({ keyFilter: 'j' })).map((item) => item.spelling)).toEqual(['jolly']);
    expect(() => filterDictionary(value, config({ keyFilter: 'z' }))).toThrow(DictionaryConfigurationError);
    expect(prepareDictionaryPayload({ requestId: 'empty', manifest: value, config: config({ keyFilter: 'z' }) }))
      .toMatchObject({ ok: false, message: expect.stringContaining('No local dictionary words') });
  });
});

describe('M13 seeded shuffled bags and bounded refill', () => {
  it('is reproducible, resumes from state, and applies explicit presentation flags', () => {
    const pool = manifest().entries;
    expect(generatePracticeWords(pool, config(), 40).words).toEqual(generatePracticeWords(pool, config(), 40).words);
    expect(generatePracticeWords(pool, config({ seed: 'seed-b' }), 40).words)
      .not.toEqual(generatePracticeWords(pool, config(), 40).words);
    const first = generatePracticeWords(pool, config(), 7);
    const continued = generatePracticeWords(pool, config(), 8, first.state);
    const all = generatePracticeWords(pool, config(), 15);
    expect([...first.words, ...continued.words]).toEqual(all.words);
    const decorated = generatePracticeWords(pool, config({ punctuation: true, capitalization: true }), 10).words;
    expect(decorated[0][0]).toBe(decorated[0][0].toUpperCase());
    expect(/[.,?!]$/.test(decorated[4])).toBe(true);
  });

  it('shrinks the recent exclusion for one/two-word pools without looping', () => {
    const pool = manifest().entries;
    const one = new PracticeWordGenerator(pool.slice(0, 1), 'tiny').generate(30);
    expect(new Set(one.map((item) => item.id))).toHaveLength(1);
    const two = new PracticeWordGenerator(pool.slice(0, 2), 'tiny').generate(30).map((item) => item.id);
    expect(two.every((id, index) => index === 0 || id !== two[index - 1])).toBe(true);
  });

  it('refills 100 words at the 80-word low-water mark, stays bounded, and reports recoverable stalls', async () => {
    const buffer = new BoundedPracticeBuffer(manifest().entries, config({ termination: { kind: 'endless' } }));
    expect(buffer.bufferedWordCount).toBe(200);
    buffer.consume(119);
    expect(await buffer.refillIfNeeded()).toBe(false);
    buffer.consume(1);
    expect(await buffer.refillIfNeeded()).toBe(true);
    expect(buffer.bufferedWordCount).toBe(180);
    expect(buffer.bufferedWordCount).toBeLessThanOrEqual(MAX_BUFFERED_PRACTICE_WORDS);
    buffer.consume(100);
    const stalled = vi.fn();
    expect(await buffer.refillIfNeeded(async () => { throw new Error('worker stopped'); }, stalled)).toBe(false);
    expect(buffer.stalled).toBe(true);
    expect(stalled).toHaveBeenCalledOnce();
    expect(await buffer.refillIfNeeded()).toBe(true);
    expect(buffer.stalled).toBe(false);
  });

  it('prepares timed, exact word-target, and explicit-finish endless sources', () => {
    const value = manifest();
    const timed = preparePractice(value, config({ termination: { kind: 'timed', seconds: 30 } }));
    expect(timed.source.termination).toEqual({ kind: 'duration', durationMs: 30_000 });
    expect(timed.sessionConfig).toMatchObject({ durationLimitMs: 30_000, targetLength: null });
    const target = preparePractice(value, config({ termination: { kind: 'words', count: 25 } }));
    expect(target.source.termination).toEqual({ kind: 'word-target', wordCount: 25 });
    expect(target.source.graphemeCount).toBe(target.sessionConfig.targetLength);
    const endless = preparePractice(value, config({ termination: { kind: 'endless' } }));
    expect(endless.source.termination).toEqual({ kind: 'endless' });
    expect(endless.controller?.bufferedWordCount).toBe(200);
  });
});
