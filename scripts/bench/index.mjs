// scripts/bench/index.mjs — run every harness. `npm run bench`.
//
// Each harness is also runnable on its own (`node scripts/bench/csv.mjs`), and
// the correctness halves exit non-zero on a mismatch, so this is usable as a
// gate even though it is deliberately NOT part of the CI suite: timings on a
// shared CI runner are noise, and a benchmark that fails randomly is a
// benchmark people learn to ignore.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HARNESSES = ['csv.mjs', 'base64.mjs', 'bundle.mjs', 'md5.mjs'];

let failed = 0;

for (const harness of HARNESSES) {
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(HERE, harness)], { stdio: 'inherit' });
    child.on('close', resolve);
  });
  if (code !== 0) {
    failed += 1;
    console.log(`\n  ${harness} exited ${code}\n`);
  }
}

console.log(
  failed === 0
    ? '\nbench: every harness agreed with its reference.\n'
    : `\nbench: ${failed} harness(es) reported a mismatch.\n`,
);
process.exitCode = failed === 0 ? 0 : 1;
