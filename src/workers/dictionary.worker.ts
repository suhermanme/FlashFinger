import type { PracticeConfig } from '../contracts/models.js';
import { filterDictionary, parseDictionaryManifest } from '../domain/training/dictionary.js';

export interface DictionaryWorkerRequest { requestId: string; manifest: unknown; config: PracticeConfig }
export type DictionaryWorkerResponse =
  | { requestId: string; ok: true; wordIds: string[] }
  | { requestId: string; ok: false; message: string };

export function prepareDictionaryPayload(request: DictionaryWorkerRequest): DictionaryWorkerResponse {
  try {
    const manifest = parseDictionaryManifest(request.manifest, false);
    return { requestId: request.requestId, ok: true,
      wordIds: filterDictionary(manifest, request.config).map((item) => item.id) };
  } catch (error) {
    return { requestId: request.requestId, ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

const worker = globalThis as typeof globalThis & {
  postMessage?: (value: DictionaryWorkerResponse) => void;
  onmessage?: ((event: MessageEvent<DictionaryWorkerRequest>) => void) | null;
};
if (globalThis.constructor?.name === 'DedicatedWorkerGlobalScope') {
  worker.onmessage = (event) => worker.postMessage?.(prepareDictionaryPayload(event.data));
}
