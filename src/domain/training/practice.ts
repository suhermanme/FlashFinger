import type { PracticeConfig, SessionConfig } from '../../contracts/models.js';
import type { TrainingSource } from '../../contracts/training.js';
import { DICTIONARY_VERSION, METRIC_VERSION } from '../../contracts/versions.js';
import { filterDictionary, type DictionaryEntry, type DictionaryManifest } from './dictionary.js';

export const INITIAL_PRACTICE_WORDS = 200;
export const REFILL_PRACTICE_WORDS = 100;
export const REFILL_LOW_WATER_WORDS = 80;
export const MAX_BUFFERED_PRACTICE_WORDS = 400;
export const RECENT_WORD_WINDOW = 20;

export interface PracticeGeneratorState {
  randomState: number;
  generationIndex: number;
  bagIds: string[];
  recentIds: string[];
}

function seedState(seed: string): number {
  let state = 2166136261;
  for (const character of seed) { state ^= character.codePointAt(0) ?? 0; state = Math.imul(state, 16777619); }
  return state >>> 0 || 1;
}

export class PracticeWordGenerator {
  private randomState: number;
  private generationIndex = 0;
  private bag: DictionaryEntry[] = [];
  private recent: string[] = [];
  private readonly byId: Map<string, DictionaryEntry>;

  constructor(private readonly pool: readonly DictionaryEntry[], seed: string, state?: PracticeGeneratorState) {
    if (pool.length === 0) throw new Error('Practice generator requires a non-empty pool');
    this.byId = new Map(pool.map((item) => [item.id, item]));
    this.randomState = state?.randomState ?? seedState(seed);
    this.generationIndex = state?.generationIndex ?? 0;
    this.recent = (state?.recentIds ?? []).filter((id) => this.byId.has(id)).slice(-RECENT_WORD_WINDOW);
    this.bag = (state?.bagIds ?? []).map((id) => this.byId.get(id)).filter((item): item is DictionaryEntry => item !== undefined);
  }

  private random(): number {
    let value = this.randomState += 0x6D2B79F5;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    this.randomState = (value ^ value >>> 14) >>> 0;
    return this.randomState / 4294967296;
  }

  private refillBag(): void {
    this.bag = [...this.pool];
    for (let index = this.bag.length - 1; index > 0; index -= 1) {
      const other = Math.floor(this.random() * (index + 1));
      [this.bag[index], this.bag[other]] = [this.bag[other], this.bag[index]];
    }
  }

  next(): DictionaryEntry {
    if (this.bag.length === 0) this.refillBag();
    const exclusionSize = Math.min(RECENT_WORD_WINDOW, this.pool.length - 1);
    const excluded = new Set(this.recent.slice(-exclusionSize));
    let index = this.bag.findIndex((item) => !excluded.has(item.id));
    if (index < 0) {
      this.refillBag();
      index = this.bag.findIndex((item) => !excluded.has(item.id));
    }
    if (index < 0) index = 0;
    const [entry] = this.bag.splice(index, 1);
    this.recent.push(entry.id);
    if (this.recent.length > RECENT_WORD_WINDOW) this.recent.shift();
    this.generationIndex += 1;
    return entry;
  }

  generate(count: number): DictionaryEntry[] {
    return Array.from({ length: count }, () => this.next());
  }

  snapshot(): PracticeGeneratorState {
    return { randomState: this.randomState, generationIndex: this.generationIndex,
      bagIds: this.bag.map((item) => item.id), recentIds: [...this.recent] };
  }
}

function presentWord(entry: DictionaryEntry, index: number, config: PracticeConfig): string {
  let word = entry.spelling;
  if (config.capitalization && index % 7 === 0) word = `${word[0].toUpperCase()}${word.slice(1)}`;
  if (config.punctuation && index % 5 === 4) word += ['.', ',', '?', '!'][Math.floor(index / 5) % 4];
  return word;
}

export function generatePracticeWords(
  pool: readonly DictionaryEntry[],
  config: PracticeConfig,
  count: number,
  state?: PracticeGeneratorState,
): { words: string[]; state: PracticeGeneratorState } {
  const generator = new PracticeWordGenerator(pool, config.seed, state);
  const start = state?.generationIndex ?? 0;
  const words = generator.generate(count).map((entry, index) => presentWord(entry, start + index, config));
  return { words, state: generator.snapshot() };
}

export class BoundedPracticeBuffer {
  private generatorState: PracticeGeneratorState | undefined;
  private words: string[] = [];
  private stalledError: Error | null = null;

  constructor(private readonly pool: readonly DictionaryEntry[], private readonly config: PracticeConfig) {
    this.append(INITIAL_PRACTICE_WORDS);
  }

  get bufferedWordCount(): number { return this.words.length; }
  get stalled(): boolean { return this.stalledError !== null; }
  get error(): Error | null { return this.stalledError; }
  get generationState(): PracticeGeneratorState { return structuredClone(this.generatorState!); }
  text(): string { return this.words.join(' '); }

  consume(count: number): void {
    this.words.splice(0, Math.max(0, Math.min(count, this.words.length)));
  }

  async refillIfNeeded(
    schedule: (work: () => void) => Promise<void> = async (work) => work(),
    onStall?: (error: Error) => void,
  ): Promise<boolean> {
    if (this.words.length > REFILL_LOW_WATER_WORDS) return false;
    try {
      await schedule(() => this.append(Math.min(REFILL_PRACTICE_WORDS,
        MAX_BUFFERED_PRACTICE_WORDS - this.words.length)));
      this.stalledError = null;
      return true;
    } catch (error) {
      this.stalledError = error instanceof Error ? error : new Error(String(error));
      onStall?.(this.stalledError);
      return false;
    }
  }

  private append(count: number): void {
    if (count <= 0) return;
    const generated = generatePracticeWords(this.pool, this.config, count, this.generatorState);
    this.generatorState = generated.state;
    this.words.push(...generated.words);
    if (this.words.length > MAX_BUFFERED_PRACTICE_WORDS) {
      this.words.splice(0, this.words.length - MAX_BUFFERED_PRACTICE_WORDS);
    }
  }
}

export interface PreparedPractice {
  source: TrainingSource;
  sessionConfig: SessionConfig;
  controller: BoundedPracticeBuffer | null;
}

export function preparePractice(manifest: DictionaryManifest, config: PracticeConfig): PreparedPractice {
  const pool = filterDictionary(manifest, config);
  const wordCount = config.termination.kind === 'words' ? config.termination.count
    : config.termination.kind === 'timed' ? MAX_BUFFERED_PRACTICE_WORDS : INITIAL_PRACTICE_WORDS;
  const generated = generatePracticeWords(pool, config, wordCount);
  const controller = config.termination.kind === 'endless' ? new BoundedPracticeBuffer(pool, config) : null;
  const text = controller?.text() ?? generated.words.join(' ');
  const graphemes = [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text)].map((item) => item.segment);
  const chunks: string[] = [];
  for (let index = 0; index < graphemes.length; index += 4_096) chunks.push(graphemes.slice(index, index + 4_096).join(''));
  const termination = config.termination.kind === 'timed'
    ? { kind: 'duration' as const, durationMs: config.termination.seconds * 1_000 }
    : config.termination.kind === 'words'
      ? { kind: 'word-target' as const, wordCount: config.termination.count }
      : { kind: 'endless' as const };
  const source: TrainingSource = {
    id: `dictionary:${config.tier}`,
    version: manifest.version,
    mode: 'practice',
    title: `${config.tier[0].toUpperCase()}${config.tier.slice(1)} practice`,
    correctionPolicy: config.correctionPolicy,
    termination,
    eligibility: { disqualifiedByCompatibility: false, disqualifiedByPause: false, minimumActiveMs: 15_000 },
    graphemeCount: graphemes.length,
    chunkSize: 4_096,
    chunkAt: (index) => chunks[index] ?? null,
  };
  return {
    source,
    controller,
    sessionConfig: {
      mode: 'practice', correctionPolicy: config.correctionPolicy,
      durationLimitMs: config.termination.kind === 'timed' ? config.termination.seconds * 1_000 : null,
      targetLength: config.termination.kind === 'words' ? graphemes.length : null,
      sourceRef: source.id, contentVersion: DICTIONARY_VERSION, metricVersion: METRIC_VERSION,
      layout: 'us-qwerty', compatibilityInput: false, heldKeyRepeat: 'ignored',
    },
  };
}
