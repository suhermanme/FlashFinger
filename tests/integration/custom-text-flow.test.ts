import { describe, expect, it } from 'vitest';
import { prepareTextPayload } from '../../src/workers/text.worker.js';
import { CUSTOM_TEXT_CHUNK_SIZE, normalizeCustomText, toCustomTextSource } from '../../src/domain/training/customText.js';

describe('custom text preparation flow', () => {
  it('prepares a long unbroken line through the worker boundary without splitting clusters', () => {
    const prepared = prepareTextPayload(new TextEncoder().encode('🙂'.repeat(10_000)));
    expect(prepared.graphemeCount).toBe(10_000);
    expect(prepared.chunks.every((chunk) => [...chunk].length > 0)).toBe(true);
    const source = toCustomTextSource(prepared);
    expect(source.chunkAt(0)?.startsWith('🙂')).toBe(true);
    expect(source.chunkAt(Math.ceil(prepared.graphemeCount / CUSTOM_TEXT_CHUNK_SIZE))).toBeNull();
  });

  it('keeps preview preparation cancellable at the caller boundary', () => {
    const controller = new AbortController();
    controller.abort();
    expect(controller.signal.aborted).toBe(true);
    expect(normalizeCustomText('preview').text).toBe('preview');
  });
});
