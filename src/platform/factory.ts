/**
 * Platform factory — M02 FlashFinger shell.
 *
 * Selects the platform adapter based on the validated preload
 * capability. Domain code never imports Electron or Node APIs.
 * See DESIGN_SPECIFICATION §1.3/§1.4.
 */

import {
  FF_BRIDGE_GLOBAL,
  asDesktopBridgeCapability,
  type DesktopBridgeCapability,
  type PlatformAdapter,
  type PlatformCapabilities,
} from '../contracts/platform.js';
import { DesktopRepositoryAdapter } from './desktop/repository.js';
import { IndexedDbRepository } from './web/repository.js';

// ---------------------------------------------------------------------------
// Platform capabilities
// ---------------------------------------------------------------------------

const BROWSER_CAPABILITIES: PlatformCapabilities = {
  target: 'browser',
  persistence: 'indexeddb',
  fileDialogs: false,
  windowControls: false,
  serviceWorker: true,
  durableStorageGuarantee: false,
};

function createBrowserAdapter (): PlatformAdapter {
  return {
    target: 'browser',
    capabilities: BROWSER_CAPABILITIES,
    repository: new IndexedDbRepository(),
    fileAccess: {
      openTextFile: () =>
        Promise.resolve({ cancelled: true }),
      saveTextFile: () =>
        Promise.resolve({ ok: false, cancelled: true }),
    },
  };
}

// ---------------------------------------------------------------------------
// Desktop bridge capability detection
// ---------------------------------------------------------------------------

function detectDesktopBridge (): DesktopBridgeCapability | null {
  const win = typeof globalThis !== 'undefined' ? (globalThis as Record<string, unknown>) : null;
  if (!win || !(FF_BRIDGE_GLOBAL in win)) return null;
  const value = win[FF_BRIDGE_GLOBAL];
  return asDesktopBridgeCapability(value);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

let cachedAdapter: PlatformAdapter | null = null;

export function getPlatformAdapter (): PlatformAdapter {
  if (cachedAdapter) {
    return cachedAdapter;
  }

  // Try to detect the desktop bridge (preload-exposed).
  const bridge = detectDesktopBridge();
  if (bridge) {
    cachedAdapter = {
      target: 'desktop',
      capabilities: {
        ...BROWSER_CAPABILITIES,
        target: 'desktop',
        persistence: 'desktop-journal',
        fileDialogs: true,
        windowControls: true,
        serviceWorker: false,
        durableStorageGuarantee: true,
      },
      repository: new DesktopRepositoryAdapter(bridge.bridge),
      fileAccess: {
        openTextFile: () =>
          Promise.resolve({ cancelled: true }),
        saveTextFile: () =>
          Promise.resolve({ ok: false, cancelled: true }),
      },
      windowControls: {
        minimize: () => { /* M05: bridge.invoke('window.minimize') */ },
        toggleMaximize: () => { /* M05: bridge.invoke('window.toggleMaximize') */ },
        close: () => { /* M05: bridge.invoke('window.close') */ },
      },
    };
    return cachedAdapter;
  }

  // No bridge detected — browser target with IndexedDB as its authority.
  cachedAdapter = createBrowserAdapter();
  return cachedAdapter;
}
