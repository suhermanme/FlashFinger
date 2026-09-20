/**
 * Pure runtime validation for every persisted or imported structure —
 * DESIGN_SPECIFICATION §2.1/§2.3. No platform APIs: runs identically in the
 * browser, Electron main, and Node tests.
 *
 * Rejects unknown enum values, missing IDs, invalid dates, negative counts,
 * impossible session totals, NaN/Infinity metrics, and unbounded strings with
 * field-level errors.
 */

import type * as M from './models';
import {
  CORRECTION_POLICIES,
  MOTION_PREFERENCES,
  PRACTICE_TIERS,
  RESOLVED_THEMES,
  SESSION_MODES,
  SESSION_STATUSES,
  THEME_PREFERENCES,
  WHITESPACE_TOKENS,
} from './models';
import type { RepositoryError, RepositoryResult } from './repository';
import {
  BACKUP_FORMAT_VERSION,
  CURRICULUM_VERSION,
  METRIC_VERSION,
  NORMALIZATION_VERSION,
  SCHEMA_VERSION,
} from './versions';

// ---------------------------------------------------------------------------
// Result plumbing
// ---------------------------------------------------------------------------

export interface FieldError {
  path: string;
  message: string;
}

export type ValidationResult<T> =
  | { valid: true; value: T; errors: []; warnings: string[] }
  | { valid: false; value: null; errors: FieldError[]; warnings: string[] };

class Ctx {
  errors: FieldError[] = [];
  warnings: string[] = [];
  fail(path: string, message: string): void {
    this.errors.push({ path, message });
  }
}

type V<T> = (value: unknown, path: string, ctx: Ctx) => T;

function finish<T>(ctx: Ctx, value: T): ValidationResult<T> {
  if (ctx.errors.length > 0) {
    return { valid: false, value: null, errors: ctx.errors, warnings: ctx.warnings };
  }
  return { valid: true, value, errors: [], warnings: ctx.warnings };
}

// ---------------------------------------------------------------------------
// Grapheme helper (Intl.Segmenter when available, code-point fallback)
// ---------------------------------------------------------------------------

let segmenter: Intl.Segmenter | undefined;
try {
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  }
} catch {
  segmenter = undefined;
}

export function graphemeLength(text: string): number {
  if (segmenter) {
    let n = 0;
    for (const _seg of segmenter.segment(text)) n++;
    return n;
  }
  return Array.from(text).length;
}

// ---------------------------------------------------------------------------
// Scalar validators
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LESSON_ID_RE = /^(ff-[a-z0-9][a-z0-9-]{0,62}|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ZONE_RE = /^[A-Za-z][A-Za-z0-9_+./-]{0,63}$/;

function vString(max: number, opts: { minLength?: number; pattern?: RegExp; allowEmpty?: boolean } = {}): V<string> {
  return (value, path, ctx) => {
    if (typeof value !== 'string') {
      ctx.fail(path, `expected string, got ${typeof value}`);
      return '';
    }
    if (value.length > max) {
      ctx.fail(path, `string exceeds ${max} code units (got ${value.length})`);
    }
    if (CONTROL_SCAN.test(value)) {
      ctx.fail(path, 'control characters are not allowed');
    }
    const gl = graphemeLength(value);
    if (!opts.allowEmpty && gl === 0) ctx.fail(path, 'string must not be empty');
    if (opts.minLength !== undefined && gl < opts.minLength) {
      ctx.fail(path, `must be at least ${opts.minLength} graphemes (got ${gl})`);
    }
    if (opts.pattern && !opts.pattern.test(value)) {
      ctx.fail(path, 'value does not match required pattern');
    }
    return value;
  };
}
const CONTROL_SCAN = /[\p{Cc}\p{Cf}]/u;
const TEXT_CONTROL_SCAN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\p{Cf}]/u;

/** Text payload validator that permits the meaningful LF, CR, and TAB controls. */
function vText(max: number, opts: { allowEmpty?: boolean } = {}): V<string> {
  return (value, path, ctx) => {
    if (typeof value !== 'string') {
      ctx.fail(path, `expected string, got ${typeof value}`);
      return '';
    }
    if (value.length > max) ctx.fail(path, `string exceeds ${max} code units (got ${value.length})`);
    if (TEXT_CONTROL_SCAN.test(value)) ctx.fail(path, 'unsupported control characters are not allowed');
    if (!opts.allowEmpty && value.length === 0) ctx.fail(path, 'string must not be empty');
    return value;
  };
}

function vUuid(): V<string> {
  return (value, path, ctx) => {
    if (typeof value !== 'string' || !UUID_RE.test(value)) {
      ctx.fail(path, 'must be a UUID v4 string');
      return '';
    }
    return value;
  };
}

function vLessonId(): V<M.LessonId> {
  return (value, path, ctx) => {
    if (typeof value !== 'string' || !LESSON_ID_RE.test(value)) {
      ctx.fail(path, 'must be a UUID or ff-prefixed lesson slug');
      return '';
    }
    return value;
  };
}

function vInstant(): V<M.Instant> {
  return (value, path, ctx) => {
    if (typeof value !== 'string' || !INSTANT_RE.test(value)) {
      ctx.fail(path, 'must be an ISO-8601 UTC instant (YYYY-MM-DDTHH:mm:ss.sssZ)');
      return '';
    }
    const parsed = Date.parse(value);
    const fraction = /\.(\d{1,3})Z$/.exec(value)?.[1] ?? '';
    const canonicalInput = fraction.length > 0
      ? value.replace(/\.\d{1,3}Z$/, `.${fraction.padEnd(3, '0')}Z`)
      : value.replace(/Z$/, '.000Z');
    if (Number.isNaN(parsed) || new Date(parsed).toISOString() !== canonicalInput) {
      ctx.fail(path, 'must be a real ISO-8601 UTC instant');
      return '';
    }
    return value;
  };
}

function vDateString(): V<M.DateString> {
  return (value, path, ctx) => {
    if (typeof value !== 'string' || !DATE_RE.test(value)) {
      ctx.fail(path, 'must be a calendar date YYYY-MM-DD');
      return '';
    }
    const parts = value.split('-').map(Number);
    const probe = new Date(Date.UTC(parts[0] as number, (parts[1] as number) - 1, parts[2] as number));
    if (probe.getUTCMonth() !== (parts[1] as number) - 1 || probe.getUTCDate() !== parts[2]) {
      ctx.fail(path, 'not a real calendar date');
      return '';
    }
    return value;
  };
}

function vZone(): V<string> {
  return (value, path, ctx) => {
    if (typeof value !== 'string' || !ZONE_RE.test(value)) {
      ctx.fail(path, 'must be an IANA timezone name');
      return '';
    }
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value });
    } catch {
      ctx.fail(path, `unknown IANA timezone "${String(value)}"`);
      return '';
    }
    return value;
  };
}

function vInt(opts: { min?: number; max?: number } = {}): V<number> {
  const min = opts.min ?? 0;
  const max = opts.max ?? Number.MAX_SAFE_INTEGER;
  return (value, path, ctx) => {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      ctx.fail(path, 'must be an integer');
      return 0;
    }
    if (value < min || value > max) {
      ctx.fail(path, `must be between ${min} and ${max} (got ${value})`);
    }
    return value;
  };
}

function vFinite(opts: { min?: number; max?: number } = {}): V<number> {
  const min = opts.min ?? Number.NEGATIVE_INFINITY;
  const max = opts.max ?? Number.POSITIVE_INFINITY;
  return (value, path, ctx) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      ctx.fail(path, 'must be a finite number (NaN/Infinity rejected)');
      return 0;
    }
    if (value < min || value > max) {
      ctx.fail(path, `must be between ${min} and ${max} (got ${value})`);
    }
    return value;
  };
}

function vNullableNumber(opts: { min?: number; max?: number } = {}): V<number | null> {
  const inner = vFinite(opts);
  return (value, path, ctx) => {
    if (value === null) return null;
    return inner(value, path, ctx);
  };
}

/** Lift any validator to accept an explicit `null` (§2.1: nullable fields are `null`, never `undefined`). */
function vNullable<T>(inner: V<T>): V<T | null> {
  return (value, path, ctx) => {
    if (value === null) return null;
    return inner(value, path, ctx);
  };
}

function vBoolean(): V<boolean> {
  return (value, path, ctx) => {
    if (typeof value !== 'boolean') {
      ctx.fail(path, 'must be a boolean');
      return false;
    }
    return value;
  };
}

function vEnum<K extends readonly string[]>(values: K): V<(typeof values)[number]> {
  return (value, path, ctx) => {
    if (typeof value !== 'string' || !values.includes(value)) {
      ctx.fail(path, `must be one of: ${values.join(' | ')}`);
      return values[0] as (typeof values)[number];
    }
    return value as (typeof values)[number];
  };
}

function vLiteral(literal: 'ignored'): V<'ignored'> {
  return (value, path, ctx) => {
    if (value !== literal) {
      ctx.fail(path, `must be "${literal}"`);
    }
    return literal;
  };
}

function vArray<T>(item: V<T>, opts: { minLength?: number; maxLength?: number } = {}): V<T[]> {
  const maxLength = opts.maxLength ?? 10000;
  return (value, path, ctx) => {
    if (!Array.isArray(value)) {
      ctx.fail(path, 'must be an array');
      return [];
    }
    if (value.length > maxLength) {
      ctx.fail(path, `array exceeds cap ${maxLength} (got ${value.length})`);
      return [];
    }
    if (opts.minLength !== undefined && value.length < opts.minLength) {
      ctx.fail(path, `array must have at least ${opts.minLength} items`);
    }
    const out: T[] = [];
    for (let i = 0; i < value.length; i++) {
      out.push(item(value[i], `${path}[${i}]`, ctx));
    }
    return out;
  };
}

function vRecord<T>(item: V<T>, maxEntries = 1000): V<Record<string, T>> {
  return (value, path, ctx) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      ctx.fail(path, 'must be an object record');
      return {};
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      ctx.fail(path, 'must be a plain object');
      return {};
    }
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > maxEntries) {
      ctx.fail(path, `record exceeds ${maxEntries} entries`);
      return {};
    }
    const out: Record<string, T> = {};
    for (const [key, raw] of entries) {
      if (key.length > 128) ctx.fail(`${path}.${key}`, 'record key too long');
      out[key] = item(raw, `${path}.${key}`, ctx);
    }
    return out;
  };
}

interface Field<T> {
  (value: unknown, path: string, ctx: Ctx): T;
  optional?: boolean;
}

function opt<T>(inner: V<T>): Field<T | undefined> {
  const wrapped = ((value: unknown, path: string, ctx: Ctx) => {
    if (value === undefined) return undefined;
    return inner(value, path, ctx);
  }) as Field<T | undefined>;
  wrapped.optional = true;
  return wrapped;
}

function vObject<T>(fields: Record<string, Field<unknown>>): V<T> {
  return (value, path, ctx) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      ctx.fail(path, 'must be an object');
      return {} as T;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      ctx.fail(path, 'must be a plain object');
      return {} as T;
    }
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
      if (!(key in fields)) ctx.fail(`${path}.${key}`, 'unknown field');
    }
    for (const [key, field] of Object.entries(fields)) {
      const sub = `${path}.${key}`;
      if (!(key in source) || source[key] === undefined) {
        if (!field.optional) ctx.fail(sub, 'missing required field');
        continue;
      }
      out[key] = field(source[key], sub, ctx);
    }
    return out as T;
  };
}

/** Bucket token: exactly one grapheme, or a named whitespace token (§2.1). */
const vToken: V<string> = (value, path, ctx) => {
  if (typeof value !== 'string') {
    ctx.fail(path, 'must be a string token');
    return '';
  }
  if ((WHITESPACE_TOKENS as readonly string[]).includes(value)) return value;
  if (value.length === 0 || graphemeLength(value) !== 1 || value.length > 32) {
    ctx.fail(path, 'token must be exactly one grapheme or a named whitespace token');
  }
  return value;
};

// ---------------------------------------------------------------------------
// Shared sub-structures
// ---------------------------------------------------------------------------

const TIMED_SECONDS = [15, 30, 60, 120] as const;
const WORD_COUNTS = [25, 50, 100] as const;

const practiceTerminationV: V<M.PracticeTermination> = (value, path, ctx) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    ctx.fail(path, 'must be a termination rule object');
    return { kind: 'timed', seconds: 60 };
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    ctx.fail(path, 'must be a plain object');
    return { kind: 'timed', seconds: 60 };
  }
  const source = value as Record<string, unknown>;
  if (source.kind === 'timed') {
    rejectUnknownKeys(source, ['kind', 'seconds'], path, ctx);
    const seconds = source.seconds;
    if (!(TIMED_SECONDS as readonly number[]).includes(seconds as number)) {
      ctx.fail(`${path}.seconds`, 'timed seconds must be 15, 30, 60, or 120');
    }
    return { kind: 'timed', seconds: (TIMED_SECONDS as readonly number[]).includes(seconds as number) ? (seconds as 15 | 30 | 60 | 120) : 60 };
  }
  if (source.kind === 'words') {
    rejectUnknownKeys(source, ['kind', 'count'], path, ctx);
    const count = source.count;
    if (!(WORD_COUNTS as readonly number[]).includes(count as number)) {
      ctx.fail(`${path}.count`, 'word target must be 25, 50, or 100');
    }
    return { kind: 'words', count: (WORD_COUNTS as readonly number[]).includes(count as number) ? (count as 25 | 50 | 100) : 50 };
  }
  if (source.kind === 'endless') {
    rejectUnknownKeys(source, ['kind'], path, ctx);
    return { kind: 'endless' };
  }
  ctx.fail(path, 'termination kind must be timed | words | endless');
  return { kind: 'timed', seconds: 60 };
};

function rejectUnknownKeys(
  source: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  ctx: Ctx,
): void {
  for (const key of Object.keys(source)) {
    if (!allowed.includes(key)) ctx.fail(`${path}.${key}`, 'unknown field');
  }
}

const practiceConfigV = vObject<M.PracticeConfig>({
  tier: vEnum(PRACTICE_TIERS),
  termination: practiceTerminationV,
  punctuation: vBoolean(),
  capitalization: vBoolean(),
  seed: vString(128, { pattern: /^[A-Za-z0-9_-]+$/ }),
  correctionPolicy: vEnum(CORRECTION_POLICIES),
  keyFilter: vNullableString(),
  configVersion: vInt({ min: 1, max: 1000 }),
});

function vNullableString(): V<string | null> {
  return (value, path, ctx) => {
    if (value === null) return null;
    return vString(4, { allowEmpty: true })(value, path, ctx);
  };
}

const profileSettingsV = vObject<M.ProfileSettings>({
  themePreference: vEnum(THEME_PREFERENCES),
  soundProfileId: vString(64, { pattern: SLUG_RE }),
  volume: vFinite({ min: 0, max: 1 }),
  muted: vBoolean(),
  motion: vEnum(MOTION_PREFERENCES),
  fontSizePx: vFinite({ min: 16, max: 40 }),
  keyboardLayout: vString(32, { pattern: SLUG_RE }),
  showKeyboard: vBoolean(),
  practiceDefaults: practiceConfigV,
});

const sessionConfigFieldsV = vObject<M.SessionConfig>({
  mode: vEnum(SESSION_MODES),
  correctionPolicy: vEnum(CORRECTION_POLICIES),
  durationLimitMs: vNullableNumber({ min: 1 }),
  targetLength: vNullable(vInt({ min: 1, max: 10_000_000 })),
  sourceRef: vString(256, { pattern: /^[A-Za-z0-9][A-Za-z0-9:._/@-]*$/ }),
  contentVersion: vString(64, { pattern: /^[A-Za-z0-9][A-Za-z0-9._-]*$/ }),
  metricVersion: vInt({ min: 1, max: 1000 }),
  layout: vString(32, { pattern: SLUG_RE }),
  compatibilityInput: vBoolean(),
  heldKeyRepeat: vLiteral('ignored'),
});

const sessionConfigV: V<M.SessionConfig> = (value, path, ctx) => {
  const errorsBefore = ctx.errors.length;
  const config = sessionConfigFieldsV(value, path, ctx);
  if (ctx.errors.length !== errorsBefore) return config;
  if (config.durationLimitMs !== null && config.targetLength !== null) {
    ctx.fail(path, 'durationLimitMs and targetLength cannot both be set');
  }
  if (config.metricVersion > METRIC_VERSION) {
    ctx.fail(`${path}.metricVersion`, `metric version ${config.metricVersion} is newer than supported ${METRIC_VERSION}`);
  }
  if (config.mode !== 'practice' && config.targetLength === null) {
    ctx.fail(`${path}.targetLength`, `${config.mode} sessions require a target length`);
  }
  if (config.mode !== 'practice' && config.durationLimitMs !== null) {
    ctx.fail(`${path}.durationLimitMs`, 'timed termination is supported only for practice sessions');
  }
  return config;
};

// ---------------------------------------------------------------------------
// Record-level validators (§2.1)
// Exported below in two forms: the `V<T>` shape (composable into larger record
// schemas inside this module) and a `validate*` entry point (the boundary API).
// ---------------------------------------------------------------------------

/** Serialized seed/generation state is opaque to storage but must stay bounded. */
const SEED_RE = /^[A-Za-z0-9_+/=-]+$/;
/** App build identity is a dot/plus-separated label, e.g. `dev`, `0.1.0`, `2026.09.20+local`. */
const BUILD_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

/** Profile name: 1–40 graphemes (§2.1). The code-unit cap bounds storage; the grapheme cap is the rule. */
const profileNameV: V<string> = (value, path, ctx) => {
  const name = vString(160, { minLength: 1 })(value, path, ctx);
  const gl = graphemeLength(name);
  if (gl > 40) ctx.fail(path, `name must be at most 40 graphemes (got ${gl})`);
  return name;
};

const profileFieldsV = vObject<M.Profile>({
  id: vUuid(),
  name: profileNameV,
  avatarToken: vString(64, { pattern: SLUG_RE }),
  createdAt: vInstant(),
  updatedAt: vInstant(),
  analyticsZone: vZone(),
  settings: profileSettingsV,
  revision: vInt({ min: 0 }),
});

/**
 * `Profile` (§2.1). Unknown fields, bad enums, bad instants, out-of-range
 * settings, and non-UUID ids are errors. `updatedAt` earlier than `createdAt`
 * is a warning only: §2.1 fixes the field set but never declares an ordering.
 */
const profileV: V<M.Profile> = (value, path, ctx) => {
  const errorsBefore = ctx.errors.length;
  const profile = profileFieldsV(value, path, ctx);
  if (ctx.errors.length === errorsBefore && profile.createdAt !== '' && profile.updatedAt !== '') {
    if (Date.parse(profile.updatedAt) < Date.parse(profile.createdAt)) {
      ctx.warnings.push(`${path}.updatedAt precedes ${path}.createdAt`);
    }
  }
  return profile;
};

/**
 * `InstallationSettings` (§2.1). The schema version rejects unsupported future
 * data here; `activeProfileId` is resolved by `validateOwnershipReferences`.
 */
const installationSettingsFieldsV = vObject<M.InstallationSettings>({
  schemaVersion: vInt({ min: 1, max: 1000 }),
  activeProfileId: vNullable(vUuid()),
  lastResolvedTheme: vEnum(RESOLVED_THEMES),
  appBuild: vString(64, { pattern: BUILD_RE }),
  onboardingComplete: vBoolean(),
});

const installationSettingsV: V<M.InstallationSettings> = (value, path, ctx) => {
  const errorsBefore = ctx.errors.length;
  const settings = installationSettingsFieldsV(value, path, ctx);
  if (ctx.errors.length === errorsBefore && settings.schemaVersion > SCHEMA_VERSION) {
    ctx.fail(`${path}.schemaVersion`, `schema version ${settings.schemaVersion} is newer than supported ${SCHEMA_VERSION}`);
  }
  return settings;
};

const sessionRecordFieldsV = vObject<M.SessionRecord>({
  id: vUuid(),
  profileId: vUuid(),
  config: sessionConfigV,
  startedAt: vInstant(),
  endedAt: vInstant(),
  analyticsZone: vZone(),
  status: vEnum(SESSION_STATUSES),
  activeMs: vFinite({ min: 0 }),
  attempts: vInt(),
  correctAttempts: vInt(),
  errorAttempts: vInt(),
  backspaces: vInt(),
  retainedCorrect: vInt(),
  retainedErrors: vInt(),
  completedWords: vInt(),
  grossCpm: vNullableNumber({ min: 0 }),
  adjustedWpm: vNullableNumber({ min: 0 }),
  accuracy: vNullableNumber({ min: 0, max: 100 }),
  eligibleForBest: vBoolean(),
  seed: vNullable(vString(256, { pattern: SEED_RE })),
});

/**
 * `SessionRecord` (§2.1, §4.1). Beyond field constraints, the canonical totals
 * must be internally consistent:
 * - `A = C + E` (§4.1);
 * - `R ≤ C` — retained correct characters are never re-counted correct attempts;
 * - the record cannot end before it started;
 * - every zero-denominator rate is explicit `null`, never `NaN` (§4.1): gross
 *   CPM and adjusted WPM when active time is zero, attempt accuracy when there
 *   are no attempts. Non-zero rates are accepted as stored, because recomputing
 *   them is the M03 formula module's job, not the boundary's.
 * Cross-field checks are skipped whenever a field-level error was recorded, so
 * one bad field cannot cascade into impossible-total noise.
 */
const sessionRecordV: V<M.SessionRecord> = (value, path, ctx) => {
  const errorsBefore = ctx.errors.length;
  const record = sessionRecordFieldsV(value, path, ctx);
  if (ctx.errors.length !== errorsBefore) return record;

  const { attempts, correctAttempts, errorAttempts, retainedCorrect, retainedErrors, activeMs } = record;
  if (attempts !== correctAttempts + errorAttempts) {
    ctx.fail(
      `${path}.attempts`,
      `attempts must equal correctAttempts + errorAttempts (A = C + E: ${attempts} != ${correctAttempts} + ${errorAttempts})`,
    );
  }
  if (retainedCorrect > correctAttempts) {
    ctx.fail(
      `${path}.retainedCorrect`,
      `retained correct (${retainedCorrect}) cannot exceed correct attempts (${correctAttempts})`,
    );
  }
  if (retainedErrors > errorAttempts) {
    ctx.fail(
      `${path}.retainedErrors`,
      `retained errors (${retainedErrors}) cannot exceed historical error attempts (${errorAttempts})`,
    );
  }
  if (Date.parse(record.endedAt) < Date.parse(record.startedAt)) {
    ctx.fail(`${path}.endedAt`, 'endedAt precedes startedAt');
  }
  if (record.status !== 'completed' && record.eligibleForBest) {
    ctx.fail(`${path}.eligibleForBest`, `${record.status} sessions cannot be eligible for personal bests`);
  }
  if (record.config.compatibilityInput && record.eligibleForBest) {
    ctx.fail(`${path}.eligibleForBest`, 'compatibility-input sessions cannot be eligible for comparative records');
  }
  if (activeMs <= 0) {
    for (const field of ['grossCpm', 'adjustedWpm'] as const) {
      if (record[field] !== null) {
        ctx.fail(`${path}.${field}`, 'must be null at zero active time (§4.1), never NaN or 0');
      }
    }
  }
  if (attempts === 0 && record.accuracy !== null) {
    ctx.fail(`${path}.accuracy`, 'must be null with zero attempts (§4.1), never NaN or 0');
  }
  return record;
};

const metricSampleFieldsV = vObject<M.MetricSample>({
  activeElapsedMs: vFinite({ min: 0 }),
  windowMs: vFinite({ min: 0 }),
  attempts: vInt(),
  correctAttempts: vInt(),
  grossCpm: vNullableNumber({ min: 0 }),
  adjustedWpm: vNullableNumber({ min: 0 }),
  accuracy: vNullableNumber({ min: 0, max: 100 }),
});

const metricSampleV: V<M.MetricSample> = (value, path, ctx) => {
  const errorsBefore = ctx.errors.length;
  const sample = metricSampleFieldsV(value, path, ctx);
  if (ctx.errors.length !== errorsBefore) return sample;
  if (sample.correctAttempts > sample.attempts) {
    ctx.fail(`${path}.correctAttempts`, 'correctAttempts cannot exceed attempts');
  }
  if (sample.windowMs === 0) {
    if (sample.grossCpm !== null) ctx.fail(`${path}.grossCpm`, 'must be null with a zero window');
    if (sample.adjustedWpm !== null) ctx.fail(`${path}.adjustedWpm`, 'must be null with a zero window');
  }
  if (sample.attempts === 0 && sample.accuracy !== null) {
    ctx.fail(`${path}.accuracy`, 'must be null with zero attempts');
  }
  return sample;
};

const sessionSeriesFieldsV = vObject<M.SessionSeries>({
  sessionId: vUuid(),
  samplePeriodMs: vInt({ min: 1 }),
  samples: vArray(metricSampleV, { maxLength: 3_600 }),
});

const sessionSeriesV: V<M.SessionSeries> = (value, path, ctx) => {
  const errorsBefore = ctx.errors.length;
  const series = sessionSeriesFieldsV(value, path, ctx);
  if (ctx.errors.length !== errorsBefore) return series;
  for (let i = 1; i < series.samples.length; i++) {
    if ((series.samples[i]?.activeElapsedMs ?? 0) <= (series.samples[i - 1]?.activeElapsedMs ?? 0)) {
      ctx.fail(`${path}.samples[${i}].activeElapsedMs`, 'sample times must be strictly increasing');
    }
  }
  return series;
};

const sessionDaySliceFieldsV = vObject<M.SessionDaySlice>({
  sessionId: vUuid(),
  profileId: vUuid(),
  day: vDateString(),
  zone: vZone(),
  activeMs: vFinite({ min: 0 }),
  attempts: vInt(),
  correctAttempts: vInt(),
  errorAttempts: vInt(),
  completedWords: vInt(),
  eligibleActiveMs: vFinite({ min: 0 }),
  eligibleRetainedCorrect: vInt(),
});

const sessionDaySliceV: V<M.SessionDaySlice> = (value, path, ctx) => {
  const errorsBefore = ctx.errors.length;
  const slice = sessionDaySliceFieldsV(value, path, ctx);
  if (ctx.errors.length !== errorsBefore) return slice;
  if (slice.attempts !== slice.correctAttempts + slice.errorAttempts) {
    ctx.fail(`${path}.attempts`, 'attempts must equal correctAttempts + errorAttempts');
  }
  if (slice.eligibleActiveMs > slice.activeMs) {
    ctx.fail(`${path}.eligibleActiveMs`, 'eligible active time cannot exceed total active time');
  }
  if (slice.eligibleRetainedCorrect > slice.correctAttempts) {
    ctx.fail(`${path}.eligibleRetainedCorrect`, 'eligible retained correct cannot exceed correct attempts');
  }
  return slice;
};

const mistakeBucketV = vObject<M.MistakeBucket>({
  profileId: vUuid(),
  sessionId: vUuid(),
  expected: vToken,
  attempted: vToken,
  count: vInt(),
});

const characterExposureFieldsV = vObject<M.CharacterExposure>({
  profileId: vUuid(),
  sessionId: vUuid(),
  expected: vToken,
  attempts: vInt(),
  errors: vInt(),
});

const characterExposureV: V<M.CharacterExposure> = (value, path, ctx) => {
  const errorsBefore = ctx.errors.length;
  const exposure = characterExposureFieldsV(value, path, ctx);
  if (ctx.errors.length === errorsBefore && exposure.errors > exposure.attempts) {
    ctx.fail(`${path}.errors`, 'errors cannot exceed attempts');
  }
  return exposure;
};

const lessonProgressFieldsV = vObject<M.LessonProgress>({
  profileId: vUuid(),
  lessonId: vLessonId(),
  curriculumVersion: vString(64, { pattern: /^[A-Za-z0-9][A-Za-z0-9._-]*$/ }),
  attemptCount: vInt(),
  passCount: vInt(),
  bestWpm: vNullableNumber({ min: 0 }),
  bestAccuracy: vNullableNumber({ min: 0, max: 100 }),
  lastAttemptAt: vNullable(vInstant()),
  masteredAt: vNullable(vInstant()),
  qualifyingSessionIds: vArray(vUuid(), { maxLength: 10_000 }),
});

const lessonProgressV: V<M.LessonProgress> = (value, path, ctx) => {
  const errorsBefore = ctx.errors.length;
  const progress = lessonProgressFieldsV(value, path, ctx);
  if (ctx.errors.length !== errorsBefore) return progress;
  if (progress.passCount > progress.attemptCount) {
    ctx.fail(`${path}.passCount`, 'passCount cannot exceed attemptCount');
  }
  if (new Set(progress.qualifyingSessionIds).size !== progress.qualifyingSessionIds.length) {
    ctx.fail(`${path}.qualifyingSessionIds`, 'session ids must be unique');
  }
  if (progress.qualifyingSessionIds.length > progress.passCount) {
    ctx.fail(`${path}.qualifyingSessionIds`, 'qualifying session count cannot exceed passCount');
  }
  if (progress.masteredAt !== null && progress.lastAttemptAt !== null && Date.parse(progress.masteredAt) > Date.parse(progress.lastAttemptAt)) {
    ctx.fail(`${path}.masteredAt`, 'masteredAt cannot be later than lastAttemptAt');
  }
  return progress;
};

const dailyAggregateFieldsV = vObject<M.DailyAggregate>({
  profileId: vUuid(),
  day: vDateString(),
  zone: vZone(),
  metricVersion: vInt({ min: 1, max: 1000 }),
  activeMs: vFinite({ min: 0 }),
  attempts: vInt(),
  correctAttempts: vInt(),
  errorAttempts: vInt(),
  completedWords: vInt(),
  eligibleActiveMs: vFinite({ min: 0 }),
  eligibleRetainedCorrect: vInt(),
  eligibleSessionCount: vInt(),
  bestWpm: vNullableNumber({ min: 0 }),
  revision: vInt(),
});

const dailyAggregateV: V<M.DailyAggregate> = (value, path, ctx) => {
  const errorsBefore = ctx.errors.length;
  const aggregate = dailyAggregateFieldsV(value, path, ctx);
  if (ctx.errors.length !== errorsBefore) return aggregate;
  if (aggregate.metricVersion > METRIC_VERSION) {
    ctx.fail(`${path}.metricVersion`, `metric version ${aggregate.metricVersion} is newer than supported ${METRIC_VERSION}`);
  }
  if (aggregate.attempts !== aggregate.correctAttempts + aggregate.errorAttempts) {
    ctx.fail(`${path}.attempts`, 'attempts must equal correctAttempts + errorAttempts');
  }
  if (aggregate.eligibleActiveMs > aggregate.activeMs) {
    ctx.fail(`${path}.eligibleActiveMs`, 'eligible active time cannot exceed total active time');
  }
  if (aggregate.eligibleRetainedCorrect > aggregate.correctAttempts) {
    ctx.fail(`${path}.eligibleRetainedCorrect`, 'eligible retained correct cannot exceed correct attempts');
  }
  return aggregate;
};

const customDocumentFieldsV = vObject<M.CustomDocument>({
  id: vUuid(),
  profileId: vUuid(),
  title: vString(256),
  createdAt: vInstant(),
  normalizationVersion: vInt({ min: 1, max: 1000 }),
  hash: vString(64, { pattern: HASH_RE }),
  graphemeCount: vInt(),
  byteLength: vInt(),
  chunkCount: vInt({ max: 100_000 }),
  retained: vBoolean(),
});

const customDocumentV: V<M.CustomDocument> = (value, path, ctx) => {
  const errorsBefore = ctx.errors.length;
  const document = customDocumentFieldsV(value, path, ctx);
  if (ctx.errors.length === errorsBefore && document.normalizationVersion > NORMALIZATION_VERSION) {
    ctx.fail(
      `${path}.normalizationVersion`,
      `normalization version ${document.normalizationVersion} is newer than supported ${NORMALIZATION_VERSION}`,
    );
  }
  return document;
};

const documentChunkV = vObject<M.DocumentChunk>({
  documentId: vUuid(),
  chunkIndex: vInt(),
  startGrapheme: vInt(),
  text: vText(262_144, { allowEmpty: true }),
});

const checkpointCountsFieldsV = vObject<M.CheckpointCounts>({
  attempts: vInt(),
  correctAttempts: vInt(),
  errorAttempts: vInt(),
  backspaces: vInt(),
  retainedCorrect: vInt(),
});

const checkpointCountsV: V<M.CheckpointCounts> = (value, path, ctx) => {
  const errorsBefore = ctx.errors.length;
  const counts = checkpointCountsFieldsV(value, path, ctx);
  if (ctx.errors.length !== errorsBefore) return counts;
  if (counts.attempts !== counts.correctAttempts + counts.errorAttempts) {
    ctx.fail(`${path}.attempts`, 'attempts must equal correctAttempts + errorAttempts');
  }
  if (counts.retainedCorrect > counts.correctAttempts) {
    ctx.fail(`${path}.retainedCorrect`, 'retainedCorrect cannot exceed correctAttempts');
  }
  return counts;
};

const checkpointEditV = vObject<M.CheckpointEdit>({
  sequence: vInt(),
  kind: vEnum(['insert', 'delete'] as const),
  position: vInt(),
  grapheme: vToken,
  correct: vBoolean(),
});

const activeCheckpointFieldsV = vObject<M.ActiveCheckpoint>({
  sessionId: vUuid(),
  profileId: vUuid(),
  config: sessionConfigV,
  checkpointAt: vInstant(),
  lastSequence: vInt(),
  activeMs: vFinite({ min: 0 }),
  counts: checkpointCountsV,
  textCursor: vInt(),
  generationState: vNullable(vString(4_096, { allowEmpty: true })),
  cappedRecentEdits: vArray(checkpointEditV, { maxLength: 512 }),
});

const activeCheckpointV: V<M.ActiveCheckpoint> = (value, path, ctx) => {
  const errorsBefore = ctx.errors.length;
  const checkpoint = activeCheckpointFieldsV(value, path, ctx);
  if (ctx.errors.length !== errorsBefore) return checkpoint;
  let previous = -1;
  for (let i = 0; i < checkpoint.cappedRecentEdits.length; i++) {
    const sequence = checkpoint.cappedRecentEdits[i]?.sequence ?? -1;
    if (sequence <= previous) ctx.fail(`${path}.cappedRecentEdits[${i}].sequence`, 'edit sequences must be strictly increasing');
    if (sequence > checkpoint.lastSequence) ctx.fail(`${path}.cappedRecentEdits[${i}].sequence`, 'edit sequence exceeds lastSequence');
    previous = sequence;
  }
  return checkpoint;
};

const wpmPointV = vObject<{ day: M.DateString; adjustedWpm: number }>({
  day: vDateString(),
  adjustedWpm: vFinite({ min: 0 }),
});

const exposureTotalsFieldsV = vObject<{ attempts: number; errors: number }>({
  attempts: vInt(),
  errors: vInt(),
});

const exposureTotalsV: V<{ attempts: number; errors: number }> = (value, path, ctx) => {
  const errorsBefore = ctx.errors.length;
  const totals = exposureTotalsFieldsV(value, path, ctx);
  if (ctx.errors.length === errorsBefore && totals.errors > totals.attempts) {
    ctx.fail(`${path}.errors`, 'errors cannot exceed attempts');
  }
  return totals;
};

const profileSummaryV = vObject<M.ProfileSummary>({
  profileId: vUuid(),
  lifetimeActiveMs: vFinite({ min: 0 }),
  completedSessions: vInt(),
  wpmSeries: vArray(wpmPointV, { maxLength: 100_000 }),
  weightedAccuracy: vNullableNumber({ min: 0, max: 100 }),
  completedLessonCount: vInt(),
  exposures: vRecord(exposureTotalsV, 10_000),
});

const backupDocumentFieldsV = vObject<{ document: M.CustomDocument; chunks: M.DocumentChunk[] }>({
  document: customDocumentV,
  chunks: vArray(documentChunkV, { maxLength: 100_000 }),
});

const backupDocumentV: V<{ document: M.CustomDocument; chunks: M.DocumentChunk[] }> = (value, path, ctx) => {
  const errorsBefore = ctx.errors.length;
  const entry = backupDocumentFieldsV(value, path, ctx);
  if (ctx.errors.length !== errorsBefore) return entry;
  if (entry.chunks.length !== entry.document.chunkCount) {
    ctx.fail(`${path}.chunks`, `chunk count does not match document.chunkCount (${entry.document.chunkCount})`);
  }
  entry.chunks.forEach((chunk, index) => {
    if (chunk.documentId !== entry.document.id) {
      ctx.fail(`${path}.chunks[${index}].documentId`, 'chunk belongs to a different document');
    }
    if (chunk.chunkIndex !== index) {
      ctx.fail(`${path}.chunks[${index}].chunkIndex`, `expected sequential chunk index ${index}`);
    }
  });
  return entry;
};

const backupPayloadsV = vObject<M.BackupPayloads>({
  sessions: vArray(sessionRecordV, { maxLength: 100_000 }),
  sessionSeries: vArray(sessionSeriesV, { maxLength: 100_000 }),
  daySlices: vArray(sessionDaySliceV, { maxLength: 200_000 }),
  mistakes: vArray(mistakeBucketV, { maxLength: 500_000 }),
  exposures: vArray(characterExposureV, { maxLength: 500_000 }),
  lessonProgress: vArray(lessonProgressV, { maxLength: 100_000 }),
  dailyAggregates: vArray(dailyAggregateV, { maxLength: 100_000 }),
  documents: vArray(backupDocumentV, { maxLength: 100_000 }),
});

const backupEnvelopeFieldsV = vObject<M.BackupEnvelope>({
  formatVersion: vInt({ min: 1, max: 1000 }),
  schemaVersion: vInt({ min: 1, max: 1000 }),
  exportedAt: vInstant(),
  appBuild: vString(64, { pattern: BUILD_RE }),
  profiles: vArray(profileV, { maxLength: 1_000 }),
  payloads: backupPayloadsV,
  contentVersions: vRecord(vString(128, { pattern: /^[A-Za-z0-9][A-Za-z0-9._+-]*$/ }), 100),
  checksum: vString(64, { pattern: HASH_RE }),
});

const backupEnvelopeV: V<M.BackupEnvelope> = (value, path, ctx) => {
  const errorsBefore = ctx.errors.length;
  const envelope = backupEnvelopeFieldsV(value, path, ctx);
  if (ctx.errors.length !== errorsBefore) return envelope;
  if (envelope.formatVersion > BACKUP_FORMAT_VERSION) {
    ctx.fail(`${path}.formatVersion`, `backup format ${envelope.formatVersion} is newer than supported ${BACKUP_FORMAT_VERSION}`);
  }
  if (envelope.schemaVersion > SCHEMA_VERSION) {
    ctx.fail(`${path}.schemaVersion`, `schema version ${envelope.schemaVersion} is newer than supported ${SCHEMA_VERSION}`);
  }
  const curriculumVersion = envelope.contentVersions.curriculum;
  if (curriculumVersion !== undefined) {
    const curriculumGate = checkCurriculumVersion(curriculumVersion);
    if (!curriculumGate.ok) ctx.fail(`${path}.contentVersions.curriculum`, curriculumGate.error.message);
  }
  const ownership = validateOwnershipReferences({
    profiles: envelope.profiles,
    sessions: envelope.payloads.sessions,
    series: envelope.payloads.sessionSeries,
    daySlices: envelope.payloads.daySlices,
    mistakes: envelope.payloads.mistakes,
    exposures: envelope.payloads.exposures,
    lessonProgress: envelope.payloads.lessonProgress,
    dailyAggregates: envelope.payloads.dailyAggregates,
    documents: envelope.payloads.documents.map((entry) => entry.document),
    documentChunks: envelope.payloads.documents.flatMap((entry) => entry.chunks),
  });
  if (!ownership.valid) {
    for (const error of ownership.errors) {
      ctx.fail(`${path}.ownership${error.path.slice(1)}`, error.message);
    }
  }
  return envelope;
};

export interface OwnershipGraph {
  installationSettings?: M.InstallationSettings;
  profiles: readonly M.Profile[];
  sessions?: readonly M.SessionRecord[];
  series?: readonly M.SessionSeries[];
  daySlices?: readonly M.SessionDaySlice[];
  mistakes?: readonly M.MistakeBucket[];
  exposures?: readonly M.CharacterExposure[];
  lessonProgress?: readonly M.LessonProgress[];
  dailyAggregates?: readonly M.DailyAggregate[];
  documents?: readonly M.CustomDocument[];
  documentChunks?: readonly M.DocumentChunk[];
  checkpoints?: readonly M.ActiveCheckpoint[];
}

/** Validate foreign-key ownership after individual records pass shape validation. */
export function validateOwnershipReferences(graph: OwnershipGraph): ValidationResult<true> {
  const ctx = new Ctx();
  const profileIds = new Set<string>();
  graph.profiles.forEach((profile, index) => {
    if (profileIds.has(profile.id)) ctx.fail(`$.profiles[${index}].id`, 'duplicate profile id');
    profileIds.add(profile.id);
  });

  const requireProfile = (profileId: string, path: string): void => {
    if (!profileIds.has(profileId)) ctx.fail(path, `references missing profile ${profileId}`);
  };
  if (graph.installationSettings?.activeProfileId !== null && graph.installationSettings?.activeProfileId !== undefined) {
    requireProfile(graph.installationSettings.activeProfileId, '$.installationSettings.activeProfileId');
  }

  const sessionOwners = new Map<string, string>();
  graph.sessions?.forEach((session, index) => {
    requireProfile(session.profileId, `$.sessions[${index}].profileId`);
    if (sessionOwners.has(session.id)) ctx.fail(`$.sessions[${index}].id`, 'duplicate session id');
    sessionOwners.set(session.id, session.profileId);
  });
  const requireSession = (sessionId: string, profileId: string | undefined, path: string): void => {
    const owner = sessionOwners.get(sessionId);
    if (owner === undefined) {
      ctx.fail(path, `references missing session ${sessionId}`);
    } else if (profileId !== undefined && owner !== profileId) {
      ctx.fail(path, `session ${sessionId} belongs to a different profile`);
    }
  };
  graph.series?.forEach((series, index) => requireSession(series.sessionId, undefined, `$.series[${index}].sessionId`));
  graph.daySlices?.forEach((slice, index) => {
    requireProfile(slice.profileId, `$.daySlices[${index}].profileId`);
    requireSession(slice.sessionId, slice.profileId, `$.daySlices[${index}].sessionId`);
  });
  graph.mistakes?.forEach((bucket, index) => {
    requireProfile(bucket.profileId, `$.mistakes[${index}].profileId`);
    requireSession(bucket.sessionId, bucket.profileId, `$.mistakes[${index}].sessionId`);
  });
  graph.exposures?.forEach((exposure, index) => {
    requireProfile(exposure.profileId, `$.exposures[${index}].profileId`);
    requireSession(exposure.sessionId, exposure.profileId, `$.exposures[${index}].sessionId`);
  });
  graph.lessonProgress?.forEach((progress, index) => {
    requireProfile(progress.profileId, `$.lessonProgress[${index}].profileId`);
    progress.qualifyingSessionIds.forEach((sessionId, sessionIndex) => {
      requireSession(sessionId, progress.profileId, `$.lessonProgress[${index}].qualifyingSessionIds[${sessionIndex}]`);
    });
  });
  graph.dailyAggregates?.forEach((aggregate, index) => {
    requireProfile(aggregate.profileId, `$.dailyAggregates[${index}].profileId`);
  });

  const documentOwners = new Map<string, string>();
  graph.documents?.forEach((document, index) => {
    requireProfile(document.profileId, `$.documents[${index}].profileId`);
    if (documentOwners.has(document.id)) ctx.fail(`$.documents[${index}].id`, 'duplicate document id');
    documentOwners.set(document.id, document.profileId);
  });
  graph.documentChunks?.forEach((chunk, index) => {
    if (!documentOwners.has(chunk.documentId)) {
      ctx.fail(`$.documentChunks[${index}].documentId`, `references missing document ${chunk.documentId}`);
    }
  });
  graph.checkpoints?.forEach((checkpoint, index) => {
    requireProfile(checkpoint.profileId, `$.checkpoints[${index}].profileId`);
  });
  return finish(ctx, true);
}

function versionTooNew(label: string, actual: number | string, supported: number | string): RepositoryResult<void> {
  const error: RepositoryError = {
    code: 'version-too-new',
    message: `${label} ${actual} is newer than supported ${supported}`,
    retryable: false,
  };
  return { ok: false, error };
}

export function checkSchemaVersion(actual: number): RepositoryResult<void> {
  return actual > SCHEMA_VERSION ? versionTooNew('Schema version', actual, SCHEMA_VERSION) : { ok: true, value: undefined };
}

export function checkBackupFormatVersion(actual: number): RepositoryResult<void> {
  return actual > BACKUP_FORMAT_VERSION
    ? versionTooNew('Backup format', actual, BACKUP_FORMAT_VERSION)
    : { ok: true, value: undefined };
}

export function checkMetricVersion(actual: number): RepositoryResult<void> {
  return actual > METRIC_VERSION ? versionTooNew('Metric version', actual, METRIC_VERSION) : { ok: true, value: undefined };
}

/** Curriculum versions use the required `ff-curriculum-vN` ordering. */
export function checkCurriculumVersion(actual: string): RepositoryResult<void> {
  if (actual === CURRICULUM_VERSION) return { ok: true, value: undefined };
  const currentMatch = /^ff-curriculum-v(\d+)$/.exec(CURRICULUM_VERSION);
  const actualMatch = /^ff-curriculum-v(\d+)$/.exec(actual);
  if (currentMatch && actualMatch && Number(actualMatch[1]) > Number(currentMatch[1])) {
    return versionTooNew('Curriculum version', actual, CURRICULUM_VERSION);
  }
  return { ok: true, value: undefined };
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/** Run a validator over a whole external value, rooted at `$`. */
function runRoot<T>(validator: V<T>, value: unknown): ValidationResult<T> {
  const ctx = new Ctx();
  return finish(ctx, validator(value, '$', ctx));
}

/** Validate an untrusted `Profile` at a storage/import/IPC boundary (§2.1). */
export function validateProfile(value: unknown): ValidationResult<M.Profile> {
  return runRoot(profileV, value);
}

/** Validate untrusted `InstallationSettings` at a storage boundary (§2.1). */
export function validateInstallationSettings(value: unknown): ValidationResult<M.InstallationSettings> {
  return runRoot(installationSettingsV, value);
}

/** Validate an untrusted finalized `SessionRecord` before commit/import (§2.1, §4.1). */
export function validateSessionRecord(value: unknown): ValidationResult<M.SessionRecord> {
  return runRoot(sessionRecordV, value);
}

export function validateSessionConfig(value: unknown): ValidationResult<M.SessionConfig> {
  return runRoot(sessionConfigV, value);
}

export function validateProfileSettings(value: unknown): ValidationResult<M.ProfileSettings> {
  return runRoot(profileSettingsV, value);
}

export function validatePracticeConfig(value: unknown): ValidationResult<M.PracticeConfig> {
  return runRoot(practiceConfigV, value);
}

export function validateSessionSeries(value: unknown): ValidationResult<M.SessionSeries> {
  return runRoot(sessionSeriesV, value);
}

export function validateMetricSample(value: unknown): ValidationResult<M.MetricSample> {
  return runRoot(metricSampleV, value);
}

export function validateSessionDaySlice(value: unknown): ValidationResult<M.SessionDaySlice> {
  return runRoot(sessionDaySliceV, value);
}

export function validateMistakeBucket(value: unknown): ValidationResult<M.MistakeBucket> {
  return runRoot(mistakeBucketV, value);
}

export function validateCharacterExposure(value: unknown): ValidationResult<M.CharacterExposure> {
  return runRoot(characterExposureV, value);
}

export function validateLessonProgress(value: unknown): ValidationResult<M.LessonProgress> {
  return runRoot(lessonProgressV, value);
}

export function validateDailyAggregate(value: unknown): ValidationResult<M.DailyAggregate> {
  return runRoot(dailyAggregateV, value);
}

export function validateCustomDocument(value: unknown): ValidationResult<M.CustomDocument> {
  return runRoot(customDocumentV, value);
}

export function validateDocumentChunk(value: unknown): ValidationResult<M.DocumentChunk> {
  return runRoot(documentChunkV, value);
}

export function validateCheckpointCounts(value: unknown): ValidationResult<M.CheckpointCounts> {
  return runRoot(checkpointCountsV, value);
}

export function validateCheckpointEdit(value: unknown): ValidationResult<M.CheckpointEdit> {
  return runRoot(checkpointEditV, value);
}

export function validateActiveCheckpoint(value: unknown): ValidationResult<M.ActiveCheckpoint> {
  return runRoot(activeCheckpointV, value);
}

export function validateProfileSummary(value: unknown): ValidationResult<M.ProfileSummary> {
  return runRoot(profileSummaryV, value);
}

export function validateBackupEnvelope(value: unknown): ValidationResult<M.BackupEnvelope> {
  return runRoot(backupEnvelopeV, value);
}

export function validateBackupPayloads(value: unknown): ValidationResult<M.BackupPayloads> {
  return runRoot(backupPayloadsV, value);
}

export {
  vUuid,
  vLessonId,
  vInstant,
  vDateString,
  vZone,
  vInt,
  vFinite,
  vNullableNumber,
  vNullableString,
  vBoolean,
  vEnum,
  vLiteral,
  vArray,
  vRecord,
  vString,
  vText,
  vToken,
  vObject,
  vNullable,
  opt,
  finish,
  Ctx,
  HASH_RE,
  practiceTerminationV,
  practiceConfigV,
  profileSettingsV,
  sessionConfigV,
  profileV,
  installationSettingsV,
  sessionRecordV,
  metricSampleV,
  sessionSeriesV,
  sessionDaySliceV,
  mistakeBucketV,
  characterExposureV,
  lessonProgressV,
  dailyAggregateV,
  customDocumentV,
  documentChunkV,
  checkpointCountsV,
  checkpointEditV,
  activeCheckpointV,
  profileSummaryV,
  backupPayloadsV,
  backupEnvelopeV,
};
export type { V, Field };
