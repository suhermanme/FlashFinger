import type { TrainingSource, EligibilityRules, TerminationRule } from '../../contracts/training.js';
import type { CorrectionPolicy } from '../../contracts/models.js';

export const CUSTOM_TEXT_MAX_BYTES = 5 * 1024 * 1024;
export const CUSTOM_TEXT_MAX_GRAPHEMES = 500_000;
export const CUSTOM_TEXT_CHUNK_SIZE = 4_096;
export const CUSTOM_TEXT_NORMALIZATION_VERSION = 1;

export type CustomTextPolicy = 'reading' | 'preserve';

export interface CustomTextOptions {
  policy?: CustomTextPolicy;
  curlyPunctuation?: boolean;
  trimWhitespace?: boolean;
  title?: string;
}

export interface PreparedCustomText {
  title: string;
  text: string;
  graphemes: string[];
  graphemeCount: number;
  byteLength: number;
  hash: string;
  chunks: string[];
  normalizationVersion: number;
  warnings: string[];
}

export class CustomTextError extends Error {
  constructor(public readonly code: 'too-large' | 'invalid-encoding' | 'binary' | 'empty' | 'unsupported', message: string) {
    super(message); this.name = 'CustomTextError';
  }
}

const encoder = new TextEncoder();
function graphemeList(value: string): string[] {
  const Segmenter = (globalThis as any).Intl?.Segmenter;
  if (Segmenter) return Array.from(new Segmenter('en', { granularity: 'grapheme' }).segment(value), (part: any) => part.segment);
  return Array.from(value);
}

function hashText(value: string): string {
  let hash = 2166136261;
  for (const byte of encoder.encode(value)) { hash ^= byte; hash = Math.imul(hash, 16777619); }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function decode(bytes: Uint8Array): string {
  if (bytes.byteLength > CUSTOM_TEXT_MAX_BYTES) throw new CustomTextError('too-large', 'Text files must be 5 MiB or smaller.');
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le', { fatal: true }).decode(bytes.slice(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = new Uint8Array(bytes.length - 2);
    for (let i = 2; i + 1 < bytes.length; i += 2) { swapped[i - 2] = bytes[i + 1]; swapped[i - 1] = bytes[i]; }
    return new TextDecoder('utf-16le', { fatal: true }).decode(swapped);
  }
  if (bytes.includes(0)) throw new CustomTextError('binary', 'This file appears to contain binary data, not plain text.');
  const start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes.slice(start)); }
  catch { throw new CustomTextError('invalid-encoding', 'The file is not valid UTF-8. Save it as UTF-8 and try again.'); }
}

export function normalizeCustomText(input: string, options: CustomTextOptions = {}): PreparedCustomText {
  const policy = options.policy ?? 'reading';
  let text = input.replace(/\r\n?/g, '\n').normalize('NFC');
  if (policy === 'reading') {
    text = text.replace(/[ \t\f\v]+/g, ' ').replace(/ *\n */g, '\n');
    if (options.curlyPunctuation) text = text.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/—|–/g, '-');
  } else text = text.replace(/\t/g, '    ').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '�');
  if (options.trimWhitespace) text = text.trim();
  const graphemes = graphemeList(text);
  if (!graphemes.length) throw new CustomTextError('empty', 'Enter or choose non-empty text before starting.');
  if (graphemes.length > CUSTOM_TEXT_MAX_GRAPHEMES) throw new CustomTextError('too-large', 'Normalized text must contain 500,000 graphemes or fewer.');
  const chunks: string[] = [];
  for (let i = 0; i < graphemes.length; i += CUSTOM_TEXT_CHUNK_SIZE) chunks.push(graphemes.slice(i, i + CUSTOM_TEXT_CHUNK_SIZE).join(''));
  return { title: options.title?.trim() || 'Custom text', text, graphemes, graphemeCount: graphemes.length,
    byteLength: encoder.encode(text).length, hash: hashText(text), chunks, normalizationVersion: CUSTOM_TEXT_NORMALIZATION_VERSION,
    warnings: policy === 'preserve' && /�/.test(text) ? ['Unsupported control characters were replaced.'] : [] };
}

export function prepareCustomTextBytes(bytes: Uint8Array, options: CustomTextOptions = {}): PreparedCustomText {
  return normalizeCustomText(decode(bytes), options);
}

export interface CustomTextSourceOptions { termination?: TerminationRule; correctionPolicy?: CorrectionPolicy; }
export function toCustomTextSource(prepared: PreparedCustomText, options: CustomTextSourceOptions = {}): TrainingSource {
  const termination = options.termination ?? { kind: 'complete-target' };
  const eligibility: EligibilityRules = { disqualifiedByCompatibility: false, disqualifiedByPause: false, minimumActiveMs: 15_000 };
  return { id: `document:${prepared.hash}`, version: `custom-${prepared.normalizationVersion}`, mode: 'custom', title: prepared.title,
    correctionPolicy: options.correctionPolicy ?? 'strict', termination, eligibility, graphemeCount: prepared.graphemeCount,
    chunkSize: CUSTOM_TEXT_CHUNK_SIZE, chunkAt: (index) => prepared.chunks[index] ?? null };
}
