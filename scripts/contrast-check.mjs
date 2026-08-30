#!/usr/bin/env node
// scripts/contrast-check.mjs
//
// CI gate for the one design claim that is a promise rather than a taste:
// "contrast meets WCAG AA" (design spec §7.5).
//
// The palette lives in src/styles/tokens.css as two blocks of custom
// properties — one dark, one light. Every pairing the UI actually uses is
// listed below with the ratio it has to clear, and this script recomputes them
// from the stylesheet itself. Nudging a token by a couple of points is a
// one-character edit; noticing that it dropped a pairing from 4.6 to 4.3 is
// not something anyone does by eye. So this is checked, not intended.
//
// The light theme is declared twice in tokens.css (once under
// `prefers-color-scheme`, once under `[data-theme='light']`) because CSS
// cannot share a block between a media query and a selector. Only the
// `[data-theme='light']` copy is read here, and the two are asserted
// identical, so a drifted copy fails rather than passing silently.
//
// Thresholds: 4.5:1 is WCAG 2.1 AA for normal-size text (1.4.3). Every pairing
// below carries text at body size or smaller, so 4.5 is the bar throughout;
// the 3:1 large-text allowance is deliberately not claimed anywhere.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const TOKENS = path.resolve(process.cwd(), 'src', 'styles', 'tokens.css');

const AA = 4.5;

/**
 * Every foreground/background pairing the stylesheet actually renders text or
 * a meaningful glyph in. Surfaces are listed as a group because the ink ramp
 * has to survive on every step of it — `--ink-3` on `--bg-3` is the pairing
 * that quietly fails when the surface ramp is widened.
 */
const SURFACES = ['--bg', '--bg-1', '--bg-2', '--bg-3'];

const PAIRS = [
  ...['--ink', '--ink-2', '--ink-3'].flatMap((fg) =>
    SURFACES.map((bg) => [fg, bg, 'body and supporting text']),
  ),
  ['--accent', '--bg', 'accent text on the page'],
  ['--accent', '--bg-1', 'accent text on a panel'],
  ['--accent', '--accent-quiet', 'selected tool card, hero eyebrow'],
  ['--accent-ink', '--accent', 'the label on a primary button'],
  ['--fam-pdf', '--bg', 'family label'],
  ['--fam-pdf', '--bg-1', 'family label on a panel'],
  ['--fam-pdf', '--fam-pdf-quiet', 'family glyph on its own tint'],
  ['--fam-image', '--bg', 'family label'],
  ['--fam-image', '--bg-1', 'family label on a panel'],
  ['--fam-image', '--fam-image-quiet', 'family glyph on its own tint'],
  ['--fam-data', '--bg', 'family label'],
  ['--fam-data', '--bg-1', 'family label on a panel'],
  ['--fam-data', '--fam-data-quiet', 'family glyph on its own tint'],
  ['--good', '--good-quiet', 'size-reduction chip'],
  ['--good', '--bg-1', 'results glyph'],
  ['--warn', '--warn-quiet', 'warning banner, palette tag'],
  ['--warn', '--bg-1', 'warning text'],
  ['--bad', '--bad-quiet', 'failure card, size-increase chip'],
  ['--bad', '--bg-1', 'error text'],
];

/** Pull the custom properties out of one `{ … }` block, by its opening line. */
function blockVars(css, marker) {
  const at = css.indexOf(marker);
  if (at < 0) throw new Error(`contrast-check: could not find "${marker}" in tokens.css`);
  const open = css.indexOf('{', at);
  let depth = 0;
  let end = open;
  for (; end < css.length; end++) {
    if (css[end] === '{') depth++;
    else if (css[end] === '}' && --depth === 0) break;
  }
  const vars = {};
  for (const m of css.slice(open, end).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    vars[m[1]] = m[2].trim();
  }
  return vars;
}

function toRgb(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}

/** WCAG 2.1 relative luminance. */
function luminance([r, g, b]) {
  const channel = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function ratio(a, b) {
  const [x, y] = [luminance(toRgb(a)), luminance(toRgb(b))];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

function check(themeName, vars, failures) {
  console.log(`\n${themeName}`);
  for (const [fg, bg, note] of PAIRS) {
    const a = vars[fg];
    const b = vars[bg];
    if (!a || !b) {
      failures.push(`${themeName}: ${!a ? fg : bg} is not defined`);
      continue;
    }
    if (!a.startsWith('#') || !b.startsWith('#')) {
      failures.push(`${themeName}: ${fg} on ${bg} is not a hex pair (${a} on ${b})`);
      continue;
    }
    const r = ratio(a, b);
    const ok = r >= AA;
    if (!ok) failures.push(`${themeName}: ${fg} on ${bg} is ${r.toFixed(2)}:1, below ${AA}:1 — ${note}`);
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${r.toFixed(2).padStart(6)}:1  ${fg} on ${bg}  — ${note}`);
  }
}

async function main() {
  const css = await readFile(TOKENS, 'utf8');

  const dark = blockVars(css, ':root {');
  // The light theme overrides only some of the dark values; the rest cascade.
  const lightOverrides = blockVars(css, ":root[data-theme='light'] {");
  const light = { ...dark, ...lightOverrides };

  const failures = [];

  // The two light-theme copies must stay identical, or the media-query path
  // and the manual override would render different palettes.
  const mediaCopy = blockVars(css, ":root:not([data-theme='dark']) {");
  for (const [key, value] of Object.entries(lightOverrides)) {
    if (mediaCopy[key] !== value) {
      failures.push(
        `light theme drift: ${key} is "${value}" under [data-theme='light'] but "${mediaCopy[key] ?? '(absent)'}" under prefers-color-scheme`,
      );
    }
  }
  for (const key of Object.keys(mediaCopy)) {
    if (!(key in lightOverrides)) {
      failures.push(`light theme drift: ${key} is set under prefers-color-scheme but not under [data-theme='light']`);
    }
  }

  check('DARK', dark, failures);
  check('LIGHT', light, failures);

  if (failures.length > 0) {
    console.error('\ncontrast-check: FAILED');
    for (const line of failures) console.error(`  ${line}`);
    process.exit(1);
  }

  console.log(`\ncontrast-check: ${PAIRS.length * 2} pairings clear WCAG AA (${AA}:1) in both themes.`);
}

main();
