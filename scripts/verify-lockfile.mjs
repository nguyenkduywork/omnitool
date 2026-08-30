// scripts/verify-lockfile.mjs — fails fast when package-lock.json is missing,
// empty, or not valid JSON. `npm ci` already rejects a broken lockfile, but
// only when someone next runs it (CI, or another developer's next install) —
// this catches the same defect locally, before it reaches a shared branch.

import { readFileSync } from 'node:fs';

const path = 'package-lock.json';

let raw;
try {
  raw = readFileSync(path, 'utf8');
} catch (err) {
  console.error(`verify-lockfile: could not read ${path}: ${err.message}`);
  process.exit(1);
}

if (raw.trim().length === 0) {
  console.error(`verify-lockfile: ${path} is empty.`);
  process.exit(1);
}

try {
  JSON.parse(raw);
} catch (err) {
  console.error(`verify-lockfile: ${path} is not valid JSON: ${err.message}`);
  process.exit(1);
}
