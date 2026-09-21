import { prepareCustomTextBytes, type CustomTextOptions, type PreparedCustomText } from '../domain/training/customText.js';

export interface TextWorkerRequest { id: string; bytes: Uint8Array; options?: CustomTextOptions; }
export type TextWorkerResponse = { id: string; ok: true; prepared: PreparedCustomText } | { id: string; ok: false; error: string; code: string };
export function prepareTextPayload(bytes: Uint8Array, options?: CustomTextOptions): PreparedCustomText { return prepareCustomTextBytes(bytes, options); }

const scope = globalThis as typeof globalThis & { postMessage?: (value: unknown) => void; onmessage?: (event: MessageEvent<TextWorkerRequest>) => void };
if (scope.constructor?.name === 'DedicatedWorkerGlobalScope') scope.onmessage = (event) => {
  try { scope.postMessage?.({ id: event.data.id, ok: true, prepared: prepareTextPayload(event.data.bytes, event.data.options) }); }
  catch (error) { const cause = error as { code?: string; message?: string }; scope.postMessage?.({ id: event.data.id, ok: false, code: cause.code ?? 'invalid', error: cause.message ?? 'Text preparation failed.' }); }
};
