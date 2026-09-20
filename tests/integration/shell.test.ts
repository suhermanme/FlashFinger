/**
 * M02 Shell integration test — validates the shared renderer shell
 * and Electron protocol security in the Node/vitest environment.
 *
 * Tests:
 * 1. Browser root build produces index.html + JS bundle.
 * 2. Platform factory detects browser target when no bridge present.
 * 3. Mock repository returns explicit unavailable on every method.
 * 4. Preload bridge whitelist rejects unknown channels.
 * 5. No Node/Electron imports leak into renderer code.
 * 6. Nested-path build (base './') compatibility.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Fixture paths
// ---------------------------------------------------------------------------

const DIST_RENDERER = path.resolve(__dirname, '..', '..', 'dist', 'renderer');

// ---------------------------------------------------------------------------
// Test 1: Browser root build produces expected artefacts
// ---------------------------------------------------------------------------

describe('M02 — Browser root build', () => {
  it('produces index.html', () => {
    const html = fs.readFileSync(path.join(DIST_RENDERER, 'index.html'), 'utf-8');
    expect(html).toContain('<title>FlashFinger</title>');
    expect(html).not.toContain('src/main.tsx');
    // Vite bundles TSX → JS, so the HTML has a <script type="module" src="./assets/..."> tag.
    expect(html).toContain('<script type="module"');
  });

  it('produces a JS bundle in assets/', () => {
    const assetsDir = path.join(DIST_RENDERER, 'assets');
    const files = fs.readdirSync(assetsDir);
    const jsFiles = files.filter((f) => f.endsWith('.js'));
    expect(jsFiles.length).toBeGreaterThan(0);

    const bundleContent = fs.readFileSync(path.join(assetsDir, jsFiles[0]), 'utf-8');
    expect(bundleContent).toContain('FlashFinger');
  });

  it('index.html does not reference Electron APIs', () => {
    const html = fs.readFileSync(path.join(DIST_RENDERER, 'index.html'), 'utf-8');
    expect(html).not.toContain('electron');
    expect(html).not.toContain('require(');
  });
});

// ---------------------------------------------------------------------------
// Test 2: Platform factory — browser target when no bridge
// ---------------------------------------------------------------------------

describe('M02 — Platform factory', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns browser target when no desktop bridge is present', async () => {
    const { getPlatformAdapter } = await import('@/platform/factory.js');
    const adapter = getPlatformAdapter();
    expect(adapter.target).toBe('browser');
    expect(adapter.capabilities.persistence).toBe('indexeddb');
    expect(adapter.capabilities.serviceWorker).toBe(true);
  });

  it('returns a mock repository (unavailable)', async () => {
    const { getPlatformAdapter } = await import('@/platform/factory.js');
    const adapter = getPlatformAdapter();
    expect(adapter.repository).toBeDefined();
    expect(typeof adapter.repository.initialize).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Test 3: Mock repository — every method returns unavailable
// ---------------------------------------------------------------------------

describe('M02 — Mock repository', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  const repoMethods = [
    'initialize', 'schemaVersion', 'storageStatus',
    'listProfiles', 'createProfile', 'updateProfile', 'deleteProfile',
    'loadProfileSettings', 'saveProfileSettings',
    'loadInstallationSettings', 'saveInstallationSettings',
    'querySessions', 'getSession', 'commitSession', 'getSessionSeries',
    'getLessonProgress', 'getDailyAggregates', 'rebuildAggregates',
    'getCharacterStats', 'rebuildCharacterStats',
    'saveCheckpoint', 'getCheckpoint', 'findLatestCheckpoint', 'deleteCheckpoint',
    'saveDocument', 'getDocument', 'listDocuments', 'getDocumentChunks', 'deleteDocument',
    'exportBackup', 'importBackup',
  ];

  it.each(repoMethods)('method %s returns unavailable', async (method) => {
    const { createMockRepository } = await import('@/platform/mock-repository.js');
    const repo = createMockRepository() as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const result = await repo[method]() as { ok: boolean; error: { code: string; retryable: boolean } };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('unavailable');
    expect(result.error.retryable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 4: Preload bridge — channel whitelist
// ---------------------------------------------------------------------------

describe('M02 — Preload bridge whitelist', () => {
  it('known channels are whitelisted in the source', () => {
    const preloadSource = fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'electron', 'preload.ts'),
      'utf-8',
    );

    // The whitelist should include core repo channels.
    expect(preloadSource).toContain("repo.initialize");
    expect(preloadSource).toContain("repo.listProfiles");
    expect(preloadSource).toContain("repo.commitSession");
    expect(preloadSource).toContain("window.minimize");
    expect(preloadSource).toContain("app.themeHintChanged");

    // Unknown channels should be rejected.
    expect(preloadSource).toContain("Unknown IPC channel");
  });
});

// ---------------------------------------------------------------------------
// Test 5: No Node/Electron imports in renderer
// ---------------------------------------------------------------------------

describe('M02 — Renderer isolation', () => {
  const rendererDirs = [
    'src/app',
    'src/platform',
  ];

  it.each(rendererDirs)('no Electron/Node imports in %s', (dir) => {
    const dirPath = path.resolve(__dirname, '..', '..', dir);
    const files = fs.readdirSync(dirPath);
    for (const file of files) {
      if (!/\.(ts|tsx)$/.test(file)) continue;
      const content = fs.readFileSync(path.join(dirPath, file), 'utf-8');
      expect(content).not.toContain("from 'electron'");
      expect(content).not.toContain(`from "electron"`);
      // platform files are allowed to import contracts, but not node:.
      if (file === 'factory.ts' || file === 'mock-repository.ts') {
        expect(content).not.toContain("from 'node:");
        expect(content).not.toContain(`from "node:`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Test 6: Nested-path build (base './') compatibility
// ---------------------------------------------------------------------------

describe('M02 — Nested-path build compatibility', () => {
  it('uses relative base paths', () => {
    const html = fs.readFileSync(path.join(DIST_RENDERER, 'index.html'), 'utf-8');
    // Relative base means asset references use ./ paths, not absolute / paths.
    expect(html).toContain('<link rel="icon" href="./favicon.svg"');
  });

  it('asset references are relative', () => {
    const assetsDir = path.join(DIST_RENDERER, 'assets');
    const files = fs.readdirSync(assetsDir);
    const jsFiles = files.filter((f) => f.endsWith('.js'));
    for (const jsFile of jsFiles) {
      const content = fs.readFileSync(path.join(assetsDir, jsFile), 'utf-8');
      // Should not have absolute path references that break under flashfinger://.
      expect(content).not.toContain("src='/'");
    }
  });
});
