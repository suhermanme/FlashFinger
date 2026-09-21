import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const required = ['public/manifest.webmanifest', 'public/sw.js', 'public/content/dictionaries/ff-english-10k-v1.json', 'public/content/lessons/ff-curriculum-v1.json'];
const missing = required.filter((file) => !existsSync(join(root, file)));
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const result = { ok: missing.length === 0 && packageJson.private === true, checks: { requiredAssets: missing.length === 0, privatePackage: packageJson.private === true }, missing };
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
