import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('release acceptance assets', () => {
  it('ships offline and licensed content entry points', () => {
    for (const file of ['public/manifest.webmanifest', 'public/sw.js', 'public/content/dictionaries/LICENSE-SCOWL.txt', 'public/content/sound-packs.json']) expect(existsSync(resolve(file))).toBe(true);
  });
  it('keeps the PWA shell relative-path deployable', () => {
    const manifest = JSON.parse(readFileSync(resolve('public/manifest.webmanifest'), 'utf8'));
    expect(manifest.start_url).toBe('./');
    expect(readFileSync(resolve('public/sw.js'), 'utf8')).toContain("'./index.html'");
  });
});
