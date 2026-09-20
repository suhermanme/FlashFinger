/**
 * Platform boundary contracts — DESIGN_SPECIFICATION §1.2/§2.2.
 *
 * The platform factory selects exactly one adapter at startup from a
 * validated preload capability; domain code never sees these types.
 */

import type { Repository, RepositoryError } from './repository';
import type { ResolvedTheme } from './models';

export const PLATFORM_TARGETS = ['browser', 'desktop'] as const;
export type PlatformTarget = (typeof PLATFORM_TARGETS)[number];

export interface PlatformCapabilities {
  target: PlatformTarget;
  persistence: 'indexeddb' | 'desktop-journal' | 'none';
  fileDialogs: boolean;
  windowControls: boolean;
  serviceWorker: boolean;
  /** Desktop-only: main-process storage survives browser-data eviction. */
  durableStorageGuarantee: boolean;
}

// ---------------------------------------------------------------------------
// Renderer-side adapter (what src/app may hold)
// ---------------------------------------------------------------------------

/** Distinguishing discriminator: `cancelled: true` records carry no payload. */
export interface FilePickResult {
  cancelled: true;
}

export interface OpenedTextFile {
  cancelled: false;
  name: string;
  /** Bytes capped by the main/extension layer (5 MiB, §5.4). */
  bytes: Uint8Array;
}

export interface FileAccessBridge {
  /** Opens a local .txt with an in-renderer picker (browser) or dialog (desktop). */
  openTextFile(): Promise<OpenedTextFile | FilePickResult>;
  /** Writes bytes through a save dialog (desktop) or download (browser). */
  saveTextFile(suggestedName: string, bytes: Uint8Array): Promise<{ ok: boolean; cancelled: boolean }>;
}

export interface WindowControls {
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
}

export interface PlatformAdapter {
  readonly target: PlatformTarget;
  readonly capabilities: PlatformCapabilities;
  readonly repository: Repository;
  readonly fileAccess: FileAccessBridge;
  /** Undefined in browser. */
  readonly windowControls?: WindowControls;
}

// ---------------------------------------------------------------------------
// Preload bridge (desktop only) — flashfinger:// renderer <-> main
// ---------------------------------------------------------------------------

export const IPC_PROTOCOL_VERSION = 1;
export const FF_BRIDGE_GLOBAL = '__flashfingerBridge__' as const;

/** Channels are closed whitelisted names; payload validation is per-channel
 * in the main process (electron/ipc/repository.ts, M05). */
export const FF_IPC_CHANNELS = [
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
export type FfIpcChannel = (typeof FF_IPC_CHANNELS)[number];

export interface BridgeInvokeRequest {
  protocol: number;
  requestId: string;
  channel: FfIpcChannel;
  /** JSON-cloneable payload; undefined allowed. */
  payload?: unknown;
}

export interface BridgeInvokeResponse {
  protocol: number;
  requestId: string;
  ok: boolean;
  /** Present when ok; JSON-cloneable repository value. */
  value?: unknown;
  /** Present when !ok; never a raw Error. */
  error?: RepositoryError;
}

/** Shape of the object the preload script exposes on window. */
export interface FfBridge {
  invoke(request: Omit<BridgeInvokeRequest, 'protocol' | 'requestId'>): Promise<BridgeInvokeResponse>;
}

/** Validated preload capability used by src/platform/factory.ts. */
export interface DesktopBridgeCapability {
  available: true;
  protocol: number;
  bridge: FfBridge;
}

export function asDesktopBridgeCapability(value: unknown): DesktopBridgeCapability | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<FfBridge> & { protocol?: unknown };
  if (typeof candidate.invoke !== 'function') return null;
  if (candidate.protocol !== IPC_PROTOCOL_VERSION) return null;
  return { available: true, protocol: IPC_PROTOCOL_VERSION, bridge: candidate as FfBridge };
}

// ---------------------------------------------------------------------------
// Theme hint (the ONLY sanctioned LocalStorage payload, §2.2/§6.1)
// ---------------------------------------------------------------------------

export const THEME_HINT_KEY = 'ff.themeHint' as const;

export function parseThemeHint(raw: string | null): ResolvedTheme | null {
  return raw === 'light' || raw === 'dark' ? raw : null;
}
