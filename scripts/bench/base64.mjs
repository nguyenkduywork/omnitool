// scripts/bench/base64.mjs — the base64 encoder: still byte-identical, still
// worth its hand-written implementation?
//
// Encoding is hand-rolled (7d0e86d) because the obvious route builds three
// whole-file intermediates. Decoding deliberately is NOT: the platform's atob
// beat every hand-rolled decoder tried. Both halves of that decision are
// measured here, so the second one stays a finding rather than folklore.

import { loadFromSource, cleanUp, measure, bytes } from './_bundle.mjs';
import { encodeBase64 as reference } from './reference/base64-encode-97aaa82.mjs';

const MB = 1024 * 1024;
const SIZE = Number(process.env.BENCH_BYTES ?? 16 * MB);

const { encodeBase64 } = await loadFromSource('src/tools/data/base64.op.ts');

function same(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// --------------------------------------------------------------- equivalence
// Every tail length (0, 1 and 2 bytes over a group) at every size boundary,
// since padding is where a hand-written encoder goes wrong.
console.log('\nbase64 — output identical to the platform btoa route');
let wrong = 0;
for (let length = 0; length <= 300; length++) {
  for (const seed of [1, 7, 99]) {
    const payload = bytes(length, seed + length);
    if (!same(encodeBase64(payload), reference(payload))) {
      wrong++;
      if (wrong <= 5) console.log(`  MISMATCH at length ${length}, seed ${seed}`);
    }
  }
}
// The byte values a naive String.fromCharCode round trip mangles.
for (const fill of [0x00, 0x80, 0xff]) {
  for (let length = 1; length <= 5; length++) {
    const payload = new Uint8Array(length).fill(fill);
    if (!same(encodeBase64(payload), reference(payload))) {
      wrong++;
      console.log(`  MISMATCH on ${length} bytes of 0x${fill.toString(16)}`);
    }
  }
}
console.log(wrong === 0 ? '  identical across 903 payloads and every tail length' : `  ${wrong} MISMATCHES`);

// ----------------------------------------------------------------- the speed
const payload = bytes(SIZE, 4);
console.log(`\nbase64 — encode ${(SIZE / MB).toFixed(0)} MB`);
const current = measure(encodeBase64, payload);
const before = measure(reference, payload);
console.log(`  current    ${current.toFixed(1).padStart(8)} ms`);
console.log(`  reference  ${before.toFixed(1).padStart(8)} ms   (${(before / current).toFixed(1)}x slower)`);

// ------------------------------------------------- and the road not taken
// Decoding stayed on the platform's atob. This is the measurement that says so;
// if a future runtime flips the answer, this is where it will show up.
const encoded = encodeBase64(payload);
const encodedText = new TextDecoder().decode(encoded);

function decodeWithAtob(text) {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

const TABLE = new Int8Array(256).fill(-1);
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
for (let i = 0; i < 64; i++) TABLE[ALPHABET.charCodeAt(i)] = i;

function decodeByHand(source) {
  let count = 0;
  for (let i = 0; i < source.length; i++) if (TABLE[source[i]] >= 0) count++;
  const out = new Uint8Array((count * 3) >> 2);
  let o = 0, acc = 0, bits = 0;
  for (let i = 0; i < source.length; i++) {
    const value = TABLE[source[i]];
    if (value < 0) continue;
    acc = (acc << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >>> bits) & 0xff;
    }
  }
  return out;
}

if (!same(decodeByHand(encoded), payload)) console.log('  the hand-rolled decoder does not round-trip');

console.log(`\nbase64 — decode ${(SIZE / MB).toFixed(0)} MB (why decode is NOT hand-rolled)`);
const native = measure(decodeWithAtob, encodedText);
const byHand = measure(decodeByHand, encoded);
console.log(`  atob (shipped)     ${native.toFixed(1).padStart(8)} ms`);
console.log(`  hand-rolled        ${byHand.toFixed(1).padStart(8)} ms   ${byHand > native ? '(slower — hence not shipped)' : '(FASTER — worth revisiting)'}`);

await cleanUp();
process.exitCode = wrong === 0 ? 0 : 1;
