// tests/unit/motion-duration.test.ts — the one number that lives in two files.
//
// `fadeHero` resolves on a JS timeout while the visual it waits for is a CSS
// transition, so `HERO_EXIT_DURATION_MS` (motion.ts) and `--dur-fast`
// (tokens.css) have to agree. Reading the custom property at runtime was
// judged not worth a `getComputedStyle` round trip on every call, which
// leaves two independent literals — and two literals that must match are a
// drift waiting to happen. Asserting it costs nothing and turns "someone
// edits one and the promise starts resolving at the wrong moment" into a
// failing test.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { HERO_EXIT_DURATION_MS } from '../../src/ui/motion';

const TOKENS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src',
  'styles',
  'tokens.css',
);

/** Every `--dur-fast` declaration in tokens.css, in source order. */
function durFastDeclarations(): string[] {
  const css = readFileSync(TOKENS, 'utf8');
  return [...css.matchAll(/--dur-fast:\s*([^;]+);/g)].map((m) => m[1]!.trim());
}

describe('the hero-exit duration lives in two files and must agree', () => {
  it('matches --dur-fast in tokens.css', () => {
    const [base] = durFastDeclarations();
    expect(base).toBeDefined();
    expect(base).toBe(`${HERO_EXIT_DURATION_MS}ms`);
  });

  // The second declaration is the reduced-motion override. fadeHero does not
  // read it — it returns early on `reduced` without waiting at all — so this
  // only pins that the override still exists and is still effectively
  // instant. If it ever became a real duration, fadeHero's early return would
  // start resolving before the visual finished.
  it('keeps a reduced-motion override that is effectively instant', () => {
    const declarations = durFastDeclarations();
    expect(declarations.length).toBeGreaterThanOrEqual(2);
    const reduced = Number.parseFloat(declarations[1]!);
    expect(reduced).toBeLessThanOrEqual(1);
  });
});
