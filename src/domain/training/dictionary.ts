import type { PracticeConfig, PracticeTier } from '../../contracts/models.js';
import { DICTIONARY_VERSION } from '../../contracts/versions.js';

export type DictionaryDifficulty = Exclude<PracticeTier, 'mixed'>;
export type FrequencyBand = 'high' | 'general' | 'extended';

export interface DictionaryEntry {
  id: string;
  spelling: string;
  graphemeLength: number;
  difficulty: DictionaryDifficulty;
  frequencyBand: FrequencyBand;
  punctuationSuitable: boolean;
  capitalizationSuitable: boolean;
}

export interface DictionaryManifest {
  id: string;
  version: string;
  language: string;
  source: string;
  sourceSha256: string;
  selectionPolicy: string;
  counts: { beginner: number; intermediate: number; advanced: number; total: number };
  entries: DictionaryEntry[];
}

export class DictionaryConfigurationError extends Error {
  constructor(message: string) { super(message); this.name = 'DictionaryConfigurationError'; }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseDictionaryManifest(value: unknown, expectedCounts = true): DictionaryManifest {
  if (!record(value) || value.id !== DICTIONARY_VERSION || value.version !== DICTIONARY_VERSION
    || typeof value.language !== 'string' || typeof value.source !== 'string'
    || typeof value.sourceSha256 !== 'string' || typeof value.selectionPolicy !== 'string'
    || !record(value.counts) || !Array.isArray(value.entries)) throw new Error('Dictionary manifest shape is invalid');
  const entries: DictionaryEntry[] = value.entries.map((candidate, index) => {
    if (!record(candidate) || typeof candidate.id !== 'string' || !/^ff-en-\d{5}$/.test(candidate.id)
      || typeof candidate.spelling !== 'string' || !/^[a-z]{2,14}$/.test(candidate.spelling)
      || !Number.isInteger(candidate.graphemeLength) || candidate.graphemeLength !== candidate.spelling.length
      || !['beginner', 'intermediate', 'advanced'].includes(String(candidate.difficulty))
      || !['high', 'general', 'extended'].includes(String(candidate.frequencyBand))
      || typeof candidate.punctuationSuitable !== 'boolean' || typeof candidate.capitalizationSuitable !== 'boolean') {
      throw new Error(`Dictionary entry ${index} is invalid`);
    }
    return candidate as unknown as DictionaryEntry;
  });
  const uniqueIds = new Set(entries.map((item) => item.id));
  const uniqueWords = new Set(entries.map((item) => item.spelling));
  if (uniqueIds.size !== entries.length || uniqueWords.size !== entries.length) throw new Error('Dictionary IDs and spellings must be unique');
  const actual = {
    beginner: entries.filter((item) => item.difficulty === 'beginner').length,
    intermediate: entries.filter((item) => item.difficulty === 'intermediate').length,
    advanced: entries.filter((item) => item.difficulty === 'advanced').length,
    total: entries.length,
  };
  const declared = value.counts as Record<string, unknown>;
  for (const key of Object.keys(actual) as Array<keyof typeof actual>) {
    if (declared[key] !== actual[key]) throw new Error(`Dictionary ${key} count does not match entries`);
  }
  if (expectedCounts && (actual.beginner !== 1_000 || actual.intermediate !== 4_000
    || actual.advanced !== 5_000 || actual.total !== 10_000)) throw new Error('Production dictionary counts must be 1000/4000/5000');
  return { ...(value as unknown as DictionaryManifest), entries };
}

export function filterDictionary(manifest: DictionaryManifest, config: PracticeConfig): DictionaryEntry[] {
  const keys = config.keyFilter === null ? null : new Set([...config.keyFilter.toLowerCase()]);
  const pool = manifest.entries.filter((entry) => (config.tier === 'mixed' || entry.difficulty === config.tier)
    && (!config.punctuation || entry.punctuationSuitable)
    && (!config.capitalization || entry.capitalizationSuitable)
    && (keys === null || [...entry.spelling].some((character) => keys.has(character))));
  if (pool.length === 0) throw new DictionaryConfigurationError('No local dictionary words match this configuration. Change the tier or key filter.');
  return pool;
}

export async function loadDictionaryManifest(
  url = './content/dictionaries/ff-english-10k-v1.json',
  fetcher: typeof fetch = fetch,
): Promise<DictionaryManifest> {
  const response = await fetcher(url);
  if (!response.ok) throw new Error(`Unable to load local dictionary (${response.status})`);
  return parseDictionaryManifest(await response.json());
}
