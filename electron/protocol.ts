/**
 * Secure local asset protocol — M02 FlashFinger shell.
 *
 * Registers the `flashfinger://` custom protocol to serve the shared
 * Vite renderer output. Path resolution rejects traversal attacks
 * and serves only files from the renderer dist directory.
 *
 * Uses Electron's modern protocol.handle() API (Promise-based,
 * standard Request/Response) — DESIGN_SPECIFICATION §1.3/§1.4.
 */

import { protocol } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';

const PROTOCOL_SCHEME = 'flashfinger';
const RENDERER_ROOT = path.join(__dirname, '..', 'renderer');

// Must run before app readiness so Chromium assigns a stable secure origin.
protocol.registerSchemesAsPrivileged([{
  scheme: PROTOCOL_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true },
}]);

// Allowed MIME types for renderer assets.
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.opus': 'audio/opus',
};

function getMimeType (filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return CONTENT_TYPES[ext] || 'application/octet-stream';
}

/**
 * Resolve a protocol URL pathname to a safe filesystem path.
 * Strips the URL pathname's one leading slash and rejects traversal or absolute remnants.
 * Returns `null` if the path would escape RENDERER_ROOT.
 */
function safeResolve (pathname: string): string | null {
  const relativePath = pathname.startsWith('/') ? pathname.slice(1) : pathname;

  // Reject path traversal.
  if (!relativePath || relativePath.includes('..') || relativePath.includes('\\') || path.isAbsolute(relativePath)) {
    return null;
  }

  // Normalize: join with renderer root, resolve to absolute.
  const resolved = path.resolve(RENDERER_ROOT, relativePath);

  // Ensure the resolved path is inside RENDERER_ROOT.
  if (path.dirname(resolved) !== RENDERER_ROOT && !resolved.startsWith(`${RENDERER_ROOT}${path.sep}`)) {
    return null;
  }

  return resolved;
}

/**
 * Register the flashfinger:// protocol.
 * Serves files from dist/renderer/ with traversal protection.
 */
export function registerProtocol (): void {
  protocol.handle(PROTOCOL_SCHEME, (request: Request) => {
    const url = new URL(request.url);
    const pathname = url.pathname;

    const safePath = safeResolve(pathname);
    if (!safePath) {
      // 403 for traversal attempts, 404 for missing files.
      const status = pathname.includes('..')
        ? 403
        : 404;
      return new Response(null, { status });
    }

    try {
      const stat = fs.statSync(safePath);
      if (!stat.isFile()) {
        return new Response(null, { status: 404 });
      }

      // Read file content synchronously (acceptable for small renderer assets).
      const body = fs.readFileSync(safePath);

      return new Response(body, {
        headers: {
          'Content-Type': getMimeType(safePath),
          // Restrict renderer assets to same-origin context.
          'Content-Security-Policy':
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
            "img-src 'self' data:; font-src 'self'; connect-src 'self'; media-src 'self'; " +
            "object-src 'none'; frame-src 'none';",
          'X-Content-Type-Options': 'nosniff',
        },
      });
    } catch {
      return new Response(null, { status: 500 });
    }
  });
}
