/**
 * Sandbox-compatible preload — M02 FlashFinger shell.
 *
 * Exposes a narrow typed bridge on `window.__flashfingerBridge__`.
 * The bridge invokes IPC channels registered in the main process.
 * No Node.js APIs are exposed to the renderer.
 */

import { contextBridge, ipcRenderer } from 'electron';
import {
  FF_BRIDGE_GLOBAL,
  FF_INVOKE_TRANSPORT,
  IPC_PROTOCOL_VERSION,
  type BridgeInvokeRequest,
  type BridgeInvokeResponse,
  type FfBridge,
} from '../src/contracts/platform.js';

// ---------------------------------------------------------------------------
// Narrow bridge API — no raw IPC, no arbitrary channels
// ---------------------------------------------------------------------------

function createBridge (): FfBridge {
  const invoke = async (
    request: Omit<BridgeInvokeRequest, 'protocol' | 'requestId'>,
  ): Promise<BridgeInvokeResponse> => {
    // Validate channel against the whitelist before sending to main.
    const knownChannels = [
      'repo.initialize',
      'repo.schemaVersion',
      'repo.storageStatus',
      'repo.listProfiles',
      'repo.createProfile',
      'repo.updateProfile',
      'repo.deleteProfile',
      'repo.loadProfileSettings',
      'repo.saveProfileSettings',
      'repo.loadInstallationSettings',
      'repo.saveInstallationSettings',
      'repo.querySessions',
      'repo.getSession',
      'repo.commitSession',
      'repo.getSessionSeries',
      'repo.getLessonProgress',
      'repo.getDailyAggregates',
      'repo.rebuildAggregates',
      'repo.getCharacterStats',
      'repo.rebuildCharacterStats',
      'repo.saveCheckpoint',
      'repo.getCheckpoint',
      'repo.findLatestCheckpoint',
      'repo.deleteCheckpoint',
      'repo.saveDocument',
      'repo.getDocument',
      'repo.listDocuments',
      'repo.getDocumentChunks',
      'repo.deleteDocument',
      'repo.exportBackup',
      'repo.importBackup',
      'file.openText',
      'file.saveText',
      'window.minimize',
      'window.toggleMaximize',
      'window.close',
      'app.themeHintChanged',
    ] as const;

    const channelSet = new Set(knownChannels);
    if (!channelSet.has(request.channel)) {
      return {
        protocol: IPC_PROTOCOL_VERSION,
        requestId: '',
        ok: false,
        error: {
          code: 'invalid',
          message: `Unknown IPC channel: ${String(request.channel)}`,
          retryable: false,
        },
      };
    }

    const requestId = crypto.randomUUID();
    const response = await ipcRenderer.invoke(FF_INVOKE_TRANSPORT, {
      protocol: IPC_PROTOCOL_VERSION,
      requestId,
      channel: request.channel,
      payload: request.payload,
    } satisfies BridgeInvokeRequest) as BridgeInvokeResponse;
    if (!response || response.protocol !== IPC_PROTOCOL_VERSION || response.requestId !== requestId) {
      return {
        protocol: IPC_PROTOCOL_VERSION,
        requestId,
        ok: false,
        error: { code: 'corrupt', message: 'Main process returned an invalid IPC response', retryable: false },
      };
    }
    return response;
  };

  return { invoke };
}

// ---------------------------------------------------------------------------
// Expose bridge — only to the renderer context
// ---------------------------------------------------------------------------

const bridge = createBridge();

contextBridge.exposeInMainWorld(FF_BRIDGE_GLOBAL, {
  ...bridge,
  protocol: IPC_PROTOCOL_VERSION,
});
