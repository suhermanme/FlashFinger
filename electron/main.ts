/**
 * Electron main process — M02 FlashFinger shell.
 *
 * Creates a sandboxed BrowserWindow, registers the secure
 * flashfinger:// custom protocol, and loads the shared Vite
 * renderer artifact from dist/renderer/.
 */

import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'node:path';
import { registerProtocol } from './protocol.js';
import { DesktopRepository } from './storage/repository.js';
import { registerRepositoryIpc } from './ipc/repository.js';

// ---------------------------------------------------------------------------
// Singleton window
// ---------------------------------------------------------------------------

let mainWindow: BrowserWindow | null = null;

function createWindow (): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      // Security: disable Node integration entirely.
      nodeIntegration: false,
      // Security: isolate the renderer context.
      contextIsolation: true,
      // Security: use the Chromium sandbox.
      sandbox: true,
      // Preload runs in the renderer context, exposes the bridge.
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // Load the shared Vite renderer output through the confined app protocol.
  mainWindow.loadURL('flashfinger://app/index.html');

  // Dev-only: open DevTools (never in production builds).
  if (process.env.FLASHFINGER_DEV === '1') {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

// Single-instance guard.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

app.whenReady().then(() => {
  const repository = new DesktopRepository({
    rootDirectory: path.join(app.getPath('userData'), 'repository'),
  });
  registerProtocol();
  registerRepositoryIpc(ipcMain, repository, () => mainWindow?.webContents.id);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
