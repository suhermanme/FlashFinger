import type { LessonId } from '../../contracts/models.js';
import type { Curriculum, ExercisePolicy, LessonDefinition, TrainingSource } from '../../contracts/training.js';
import { CURRICULUM_VERSION, METRIC_VERSION } from '../../contracts/versions.js';
import { createLessonEvaluator, validateCurriculumGraph } from './progression.js';

type Finger = LessonDefinition['fingerHints'][string];

export interface LessonAssetEntry {
  id: LessonId;
  title: string;
  stage: 1 | 2 | 3 | 4 | 5 | 6;
  prerequisites: LessonId[];
  introducedKeys: string[];
  reviewKeys: string[];
  exercisePolicy: ExercisePolicy;
  targetLength: number;
  newUnits: string[];
  reviewUnits: string[];
}

export interface CurriculumMigration {
  fromVersion: string;
  unchangedLessons: Record<LessonId, LessonId>;
}

export interface LessonCatalog {
  curriculum: Curriculum;
  entries: readonly LessonAssetEntry[];
  migrations: readonly CurriculumMigration[];
}

const FINGERS: Record<string, Finger> = {
  q: 'left-pinky', a: 'left-pinky', z: 'left-pinky', '1': 'left-pinky',
  w: 'left-ring', s: 'left-ring', x: 'left-ring', '2': 'left-ring',
  e: 'left-middle', d: 'left-middle', c: 'left-middle', '3': 'left-middle',
  r: 'left-index', f: 'left-index', v: 'left-index', t: 'left-index', g: 'left-index', b: 'left-index', '4': 'left-index', '5': 'left-index',
  y: 'right-index', h: 'right-index', n: 'right-index', u: 'right-index', j: 'right-index', m: 'right-index', '6': 'right-index', '7': 'right-index',
  i: 'right-middle', k: 'right-middle', ',': 'right-middle', '8': 'right-middle',
  o: 'right-ring', l: 'right-ring', '.': 'right-ring', '9': 'right-ring',
  p: 'right-pinky', ';': 'right-pinky', '/': 'right-pinky', '0': 'right-pinky',
  "'": 'right-pinky', '"': 'right-pinky', '?': 'right-pinky', '[': 'right-pinky', ']': 'right-pinky', '-': 'right-pinky', '=': 'right-pinky',
  '!': 'left-pinky',
  ' ': 'right-thumb',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error(`${label} must be a string array`);
  return value as string[];
}

function fingerFor(key: string): Finger | null {
  return FINGERS[key.toLowerCase()] ?? null;
}

function definitionFromEntry(version: string, entry: LessonAssetEntry): LessonDefinition {
  const threshold = entry.stage === 1 ? [95, 10] : entry.stage === 2 ? [95, 15]
    : entry.stage === 3 ? [96, 20] : entry.stage === 4 || entry.stage === 5 ? [96, 25] : [97, 30];
  const fingerHints: LessonDefinition['fingerHints'] = {};
  for (const key of entry.introducedKeys) {
    const finger = fingerFor(key);
    if (!finger) throw new Error(`${entry.id} has no finger hint for ${JSON.stringify(key)}`);
    fingerHints[key] = finger;
  }
  return {
    id: entry.id,
    curriculumVersion: version,
    title: entry.title,
    stage: entry.stage,
    prerequisites: [...entry.prerequisites],
    introducedKeys: [...entry.introducedKeys],
    reviewKeys: [...entry.reviewKeys],
    fingerHints,
    exercisePolicy: entry.exercisePolicy,
    targetGraphemes: [...new Set([...entry.introducedKeys, ...entry.reviewKeys, ' '])],
    correctionPolicy: 'strict',
    minimumAccuracy: threshold[0],
    minimumWpm: threshold[1],
    requiredQualifyingPasses: 2,
    contentSeedPolicy: 'profile-seeded',
  };
}

function parseEntry(value: unknown, index: number): LessonAssetEntry {
  if (!isRecord(value)) throw new Error(`lessons[${index}] must be an object`);
  const stage = value.stage;
  const targetLength = value.targetLength;
  if (typeof value.id !== 'string' || !/^ff-[a-z0-9-]+$/.test(value.id)) throw new Error(`lessons[${index}].id is invalid`);
  if (typeof value.title !== 'string' || value.title.length === 0) throw new Error(`${value.id}.title is invalid`);
  if (!Number.isInteger(stage) || Number(stage) < 1 || Number(stage) > 6) throw new Error(`${value.id}.stage is invalid`);
  if (!Number.isInteger(targetLength) || Number(targetLength) < (stage === 1 ? 120 : 240)) {
    throw new Error(`${value.id}.targetLength is below the stage minimum`);
  }
  if (!['new-key-drill', 'mixed-review', 'prose'].includes(String(value.exercisePolicy))) {
    throw new Error(`${value.id}.exercisePolicy is invalid`);
  }
  const entry: LessonAssetEntry = {
    id: value.id,
    title: value.title,
    stage: stage as LessonAssetEntry['stage'],
    prerequisites: strings(value.prerequisites, `${value.id}.prerequisites`),
    introducedKeys: strings(value.introducedKeys, `${value.id}.introducedKeys`),
    reviewKeys: strings(value.reviewKeys, `${value.id}.reviewKeys`),
    exercisePolicy: value.exercisePolicy as ExercisePolicy,
    targetLength: targetLength as number,
    newUnits: strings(value.newUnits, `${value.id}.newUnits`),
    reviewUnits: strings(value.reviewUnits, `${value.id}.reviewUnits`),
  };
  if (entry.newUnits.length + entry.reviewUnits.length === 0) throw new Error(`${entry.id} has no exercise units`);
  const allowed = new Set([...entry.introducedKeys, ...entry.reviewKeys, ' ']);
  for (const unit of [...entry.newUnits, ...entry.reviewUnits]) {
    for (const grapheme of segment(unit)) if (!allowed.has(grapheme)) {
      throw new Error(`${entry.id} exercise unit contains locked grapheme ${JSON.stringify(grapheme)}`);
    }
  }
  if (entry.exercisePolicy === 'new-key-drill') {
    const introduced = new Set([...entry.introducedKeys, ' ']);
    const review = new Set([...entry.reviewKeys, ' ']);
    if (entry.introducedKeys.length === 0 || entry.newUnits.length === 0) {
      throw new Error(`${entry.id} new-key drill has no introduced-key units`);
    }
    for (const unit of entry.newUnits) for (const grapheme of segment(unit)) {
      if (!introduced.has(grapheme)) throw new Error(`${entry.id} new unit contains review key ${JSON.stringify(grapheme)}`);
    }
    if (entry.reviewKeys.length > 0 && entry.reviewUnits.length === 0) throw new Error(`${entry.id} has no review units`);
    for (const unit of entry.reviewUnits) for (const grapheme of segment(unit)) {
      if (!review.has(grapheme)) throw new Error(`${entry.id} review unit contains a new key ${JSON.stringify(grapheme)}`);
    }
  }
  return entry;
}

export function parseCurriculumAsset(value: unknown): LessonCatalog {
  if (!isRecord(value) || value.version !== CURRICULUM_VERSION || !Array.isArray(value.lessons)) {
    throw new Error(`Expected curriculum asset ${CURRICULUM_VERSION}`);
  }
  const entries = value.lessons.map(parseEntry);
  const curriculum: Curriculum = { version: value.version, lessons: entries.map((entry) => definitionFromEntry(value.version as string, entry)) };
  const graphErrors = validateCurriculumGraph(curriculum);
  if (graphErrors.length > 0) throw new Error(graphErrors.join('; '));
  const migrations = Array.isArray(value.migrations) ? value.migrations.map((migration, index) => {
    if (!isRecord(migration) || typeof migration.fromVersion !== 'string' || !isRecord(migration.unchangedLessons)) {
      throw new Error(`migrations[${index}] is invalid`);
    }
    const unchangedLessons = Object.fromEntries(Object.entries(migration.unchangedLessons).map(([from, to]) => {
      if (typeof to !== 'string') throw new Error(`migrations[${index}] has an invalid lesson mapping`);
      return [from, to];
    }));
    return { fromVersion: migration.fromVersion, unchangedLessons };
  }) : [];
  return { curriculum, entries, migrations };
}

export async function loadCurriculumAsset(
  url = './content/lessons/ff-curriculum-v1.json',
  fetcher: typeof fetch = fetch,
): Promise<LessonCatalog> {
  const response = await fetcher(url);
  if (!response.ok) throw new Error(`Unable to load curriculum (${response.status})`);
  return parseCurriculumAsset(await response.json());
}

function segment(text: string): string[] {
  return [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text)].map((item) => item.segment);
}

function seededRandom(seed: string): () => number {
  let state = 2166136261;
  for (const character of seed) { state ^= character.codePointAt(0) ?? 0; state = Math.imul(state, 16777619); }
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function shuffledBag(values: readonly string[], random: () => number): string[] {
  const bag = [...values];
  for (let index = bag.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [bag[index], bag[other]] = [bag[other], bag[index]];
  }
  return bag;
}

export function generateLessonText(entry: LessonAssetEntry, seed: string): string {
  const random = seededRandom(`${entry.id}:${seed}`);
  const newUnits = entry.newUnits.length > 0 ? entry.newUnits : entry.reviewUnits;
  const reviewUnits = entry.reviewUnits.length > 0 ? entry.reviewUnits : newUnits;
  let newBag: string[] = [];
  let reviewBag: string[] = [];
  let newIndex = 0;
  let reviewIndex = 0;
  const take = (kind: 'new' | 'review'): string => {
    if (kind === 'new') {
      if (newIndex >= newBag.length) { newBag = shuffledBag(newUnits, random); newIndex = 0; }
      return newBag[newIndex++];
    }
    if (reviewIndex >= reviewBag.length) { reviewBag = shuffledBag(reviewUnits, random); reviewIndex = 0; }
    return reviewBag[reviewIndex++];
  };
  const units: string[] = [];
  let length = 0;
  let introducedPositions = 0;
  let reviewPositions = 0;
  while (length < entry.targetLength) {
    const weighted = entry.exercisePolicy === 'new-key-drill' && entry.reviewUnits.length > 0;
    const totalScoredPositions = introducedPositions + reviewPositions;
    const kind = weighted && totalScoredPositions > 0 && introducedPositions / totalScoredPositions >= 0.6
      ? 'review' : 'new';
    const unit = take(kind);
    const addition = `${units.length === 0 ? '' : ' '}${unit}`;
    units.push(unit);
    length += segment(addition).length;
    const scoredPositions = segment(unit).filter((grapheme) => grapheme !== ' ').length;
    if (kind === 'new') introducedPositions += scoredPositions;
    else reviewPositions += scoredPositions;
  }
  return segment(units.join(' ')).slice(0, entry.targetLength).join('');
}

export function createLessonSource(catalog: LessonCatalog, lessonId: LessonId, seed: string): TrainingSource {
  const entry = catalog.entries.find((item) => item.id === lessonId);
  const definition = catalog.curriculum.lessons.find((item) => item.id === lessonId);
  if (!entry || !definition) throw new Error(`Unknown lesson ${lessonId}`);
  const text = generateLessonText(entry, seed);
  const chunks: string[] = [];
  const graphemes = segment(text);
  for (let index = 0; index < graphemes.length; index += 4_096) chunks.push(graphemes.slice(index, index + 4_096).join(''));
  return {
    id: definition.id,
    version: definition.curriculumVersion,
    mode: 'lessons',
    title: definition.title,
    correctionPolicy: definition.correctionPolicy,
    termination: { kind: 'complete-target' },
    eligibility: { disqualifiedByCompatibility: false, disqualifiedByPause: false, minimumActiveMs: MINIMUM_LESSON_ACTIVE_MS },
    graphemeCount: graphemes.length,
    chunkSize: 4_096,
    chunkAt: (index) => chunks[index] ?? null,
    progressEvaluator: createLessonEvaluator(definition),
  };
}

export function createLessonSessionConfig(source: TrainingSource) {
  return {
    mode: 'lessons' as const,
    correctionPolicy: source.correctionPolicy,
    durationLimitMs: null,
    targetLength: source.graphemeCount,
    sourceRef: source.id,
    contentVersion: source.version,
    metricVersion: METRIC_VERSION,
    layout: 'us-qwerty',
    compatibilityInput: false,
    heldKeyRepeat: 'ignored' as const,
  };
}

const MINIMUM_LESSON_ACTIVE_MS = 15_000;
