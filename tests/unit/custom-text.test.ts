import { describe, expect, it } from 'vitest';
import { CUSTOM_TEXT_CHUNK_SIZE, CustomTextError, normalizeCustomText, prepareCustomTextBytes, toCustomTextSource } from '../../src/domain/training/customText.js';

describe('custom text preparation', () => {
  it('decodes BOMs, normalizes line endings, NFC, and grapheme-safe chunks', () => {
    const value = prepareCustomTextBytes(new TextEncoder().encode('\ufeffe\u0301\r\n👩‍💻\tword'));
    expect(value.text).toBe('é\n👩‍💻 word');
    expect(value.graphemeCount).toBe(8);
    expect(value.chunks[0]).toBe(value.text);
  });
  it('supports UTF-16 little endian and rejects invalid/binary input', () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x61, 0x00, 0x0a, 0x00]);
    expect(prepareCustomTextBytes(bytes).text).toBe('a\n');
    expect(() => prepareCustomTextBytes(new Uint8Array([0xc3, 0x28]))).toThrowError(CustomTextError);
    expect(() => prepareCustomTextBytes(new Uint8Array([65, 0, 66]))).toThrowError(/binary/i);
  });
  it('keeps formatting with expanded tabs and trims only when requested', () => {
    expect(normalizeCustomText('  a\t\n', { policy: 'preserve', trimWhitespace: false }).text).toBe('  a    \n');
    expect(normalizeCustomText('  a  ', { trimWhitespace: true }).text).toBe('a');
  });
  it('enforces limits before producing a source and keeps chunk boundaries stable', () => {
    expect(() => normalizeCustomText('x'.repeat(500_001))).toThrow(/500,000/);
    const prepared = normalizeCustomText('a'.repeat(CUSTOM_TEXT_CHUNK_SIZE + 2));
    const source = toCustomTextSource(prepared);
    expect(source.chunkAt(0)?.length).toBe(CUSTOM_TEXT_CHUNK_SIZE);
    expect(source.chunkAt(1)).toBe('aa');
    expect(source.chunkAt(2)).toBeNull();
  });
});
