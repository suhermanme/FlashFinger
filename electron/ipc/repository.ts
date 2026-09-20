/** Validated IPC router from the isolated renderer to the main-owned repository. */

import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import {
  FF_IPC_CHANNELS,
  FF_INVOKE_TRANSPORT,
  IPC_PROTOCOL_VERSION,
  type BridgeInvokeRequest,
  type BridgeInvokeResponse,
  type FfIpcChannel,
} from '../../src/contracts/platform.js';
import type { Repository, RepositoryResult } from '../../src/contracts/repository.js';

export { FF_INVOKE_TRANSPORT };
export const MAX_IPC_PAYLOAD_BYTES = 8 * 1024 * 1024;
const REPOSITORY_CHANNELS = new Set<string>(FF_IPC_CHANNELS.filter((channel) => channel.startsWith('repo.')));

interface SenderLike {
  sender: { id: number; mainFrame?: unknown; isDestroyed?(): boolean };
  senderFrame?: { url: string } | null;
}

export function isTrustedRepositorySender(event: SenderLike, expectedWebContentsId?: number): boolean {
  if (expectedWebContentsId !== undefined && event.sender.id !== expectedWebContentsId) return false;
  if (event.sender.isDestroyed?.()) return false;
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) return false;
  try {
    const url = new URL(event.senderFrame.url);
    return url.protocol === 'flashfinger:' && url.hostname === 'app';
  } catch { return false; }
}

function invalid(requestId: string, message: string): BridgeInvokeResponse {
  return { protocol: IPC_PROTOCOL_VERSION, requestId, ok: false,
    error: { code: 'invalid', message, retryable: false } };
}

function unavailable(requestId: string, message: string): BridgeInvokeResponse {
  return { protocol: IPC_PROTOCOL_VERSION, requestId, ok: false,
    error: { code: 'unavailable', message, retryable: false } };
}

function payloadSize(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return 0;
  return Buffer.byteLength(serialized, 'utf8');
}

function argsFor(request: BridgeInvokeRequest, count: number): unknown[] {
  if (!Array.isArray(request.payload) || request.payload.length !== count) {
    throw new TypeError(`${request.channel} expects ${count} argument(s)`);
  }
  return request.payload;
}

function stringArg(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512) throw new TypeError(`${label} must be a bounded string`);
  return value;
}

function integerArg(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${label} must be a nonnegative integer`);
  return value as number;
}

async function dispatch(repository: Repository, request: BridgeInvokeRequest): Promise<RepositoryResult<unknown>> {
  const channel = request.channel;
  switch (channel) {
    case 'repo.initialize': argsFor(request, 0); return repository.initialize();
    case 'repo.schemaVersion': argsFor(request, 0); return repository.schemaVersion();
    case 'repo.storageStatus': argsFor(request, 0); return repository.storageStatus();
    case 'repo.listProfiles': argsFor(request, 0); return repository.listProfiles();
    case 'repo.createProfile': return repository.createProfile(argsFor(request, 1)[0] as Parameters<Repository['createProfile']>[0]);
    case 'repo.updateProfile': return repository.updateProfile(argsFor(request, 1)[0] as Parameters<Repository['updateProfile']>[0]);
    case 'repo.deleteProfile': return repository.deleteProfile(stringArg(argsFor(request, 1)[0], 'profileId'));
    case 'repo.loadProfileSettings': return repository.loadProfileSettings(stringArg(argsFor(request, 1)[0], 'profileId'));
    case 'repo.saveProfileSettings': {
      const args = argsFor(request, 2); return repository.saveProfileSettings(stringArg(args[0], 'profileId'), args[1] as Parameters<Repository['saveProfileSettings']>[1]);
    }
    case 'repo.loadInstallationSettings': argsFor(request, 0); return repository.loadInstallationSettings();
    case 'repo.saveInstallationSettings': return repository.saveInstallationSettings(argsFor(request, 1)[0] as Parameters<Repository['saveInstallationSettings']>[0]);
    case 'repo.querySessions': return repository.querySessions(argsFor(request, 1)[0] as Parameters<Repository['querySessions']>[0]);
    case 'repo.getSession': return repository.getSession(stringArg(argsFor(request, 1)[0], 'sessionId'));
    case 'repo.commitSession': return repository.commitSession(argsFor(request, 1)[0] as Parameters<Repository['commitSession']>[0]);
    case 'repo.getSessionSeries': return repository.getSessionSeries(stringArg(argsFor(request, 1)[0], 'sessionId'));
    case 'repo.getLessonProgress': {
      const args = argsFor(request, 2); return repository.getLessonProgress(stringArg(args[0], 'profileId'), stringArg(args[1], 'curriculumVersion'));
    }
    case 'repo.getDailyAggregates': {
      const args = argsFor(request, 3); return repository.getDailyAggregates(stringArg(args[0], 'profileId'), stringArg(args[1], 'from'), stringArg(args[2], 'to'));
    }
    case 'repo.rebuildAggregates': return repository.rebuildAggregates(stringArg(argsFor(request, 1)[0], 'profileId'));
    case 'repo.getCharacterStats': return repository.getCharacterStats(stringArg(argsFor(request, 1)[0], 'profileId'));
    case 'repo.rebuildCharacterStats': return repository.rebuildCharacterStats(stringArg(argsFor(request, 1)[0], 'profileId'));
    case 'repo.saveCheckpoint': return repository.saveCheckpoint(argsFor(request, 1)[0] as Parameters<Repository['saveCheckpoint']>[0]);
    case 'repo.getCheckpoint': return repository.getCheckpoint(stringArg(argsFor(request, 1)[0], 'sessionId'));
    case 'repo.findLatestCheckpoint': return repository.findLatestCheckpoint(stringArg(argsFor(request, 1)[0], 'profileId'));
    case 'repo.deleteCheckpoint': return repository.deleteCheckpoint(stringArg(argsFor(request, 1)[0], 'sessionId'));
    case 'repo.saveDocument': return repository.saveDocument(argsFor(request, 1)[0] as Parameters<Repository['saveDocument']>[0]);
    case 'repo.getDocument': return repository.getDocument(stringArg(argsFor(request, 1)[0], 'documentId'));
    case 'repo.listDocuments': return repository.listDocuments(stringArg(argsFor(request, 1)[0], 'profileId'));
    case 'repo.getDocumentChunks': {
      const args = argsFor(request, 3); return repository.getDocumentChunks(stringArg(args[0], 'documentId'), integerArg(args[1], 'fromChunkIndex'), integerArg(args[2], 'maxChunks'));
    }
    case 'repo.deleteDocument': return repository.deleteDocument(stringArg(argsFor(request, 1)[0], 'documentId'));
    case 'repo.exportBackup': return repository.exportBackup(argsFor(request, 1)[0] as Parameters<Repository['exportBackup']>[0]);
    case 'repo.importBackup': {
      const args = argsFor(request, 2); return repository.importBackup(args[0] as Parameters<Repository['importBackup']>[0], args[1] as Parameters<Repository['importBackup']>[1]);
    }
    default: throw new TypeError(`Unsupported repository channel: ${channel}`);
  }
}

export function createRepositoryRequestHandler(
  repository: Repository,
  expectedWebContentsId?: () => number | undefined,
): (event: SenderLike, request: unknown) => Promise<BridgeInvokeResponse> {
  return async (event, value) => {
    const requestId = value && typeof value === 'object' && typeof (value as { requestId?: unknown }).requestId === 'string'
      ? (value as { requestId: string }).requestId : '';
    if (!isTrustedRepositorySender(event, expectedWebContentsId?.())) return unavailable(requestId, 'IPC sender is not trusted');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid(requestId, 'IPC request must be an object');
    const request = value as Partial<BridgeInvokeRequest>;
    if (request.protocol !== IPC_PROTOCOL_VERSION) return invalid(requestId, 'Unsupported IPC protocol version');
    if (typeof request.requestId !== 'string' || request.requestId.length < 1 || request.requestId.length > 128) {
      return invalid(requestId, 'IPC request id is invalid');
    }
    if (typeof request.channel !== 'string' || !REPOSITORY_CHANNELS.has(request.channel)) {
      return invalid(request.requestId, 'Unknown repository IPC channel');
    }
    try {
      if (payloadSize(request.payload) > MAX_IPC_PAYLOAD_BYTES) return invalid(request.requestId, 'IPC payload exceeds the 8 MiB limit');
    } catch { return invalid(request.requestId, 'IPC payload is not serializable'); }
    try {
      const result = await dispatch(repository, request as BridgeInvokeRequest & { channel: FfIpcChannel });
      if (!result.ok) return { protocol: IPC_PROTOCOL_VERSION, requestId: request.requestId, ok: false, error: result.error };
      if (payloadSize(result.value) > MAX_IPC_PAYLOAD_BYTES) {
        return invalid(request.requestId, 'IPC response exceeds the 8 MiB limit');
      }
      return { protocol: IPC_PROTOCOL_VERSION, requestId: request.requestId, ok: true, value: result.value };
    } catch (error) {
      return invalid(request.requestId, error instanceof Error ? error.message : 'Repository IPC dispatch failed');
    }
  };
}

export function registerRepositoryIpc(
  ipcMain: Pick<IpcMain, 'handle' | 'removeHandler'>,
  repository: Repository,
  expectedWebContentsId?: () => number | undefined,
): void {
  ipcMain.removeHandler(FF_INVOKE_TRANSPORT);
  const handler = createRepositoryRequestHandler(repository, expectedWebContentsId);
  ipcMain.handle(FF_INVOKE_TRANSPORT, (event: IpcMainInvokeEvent, request: unknown) => handler(event, request));
}
