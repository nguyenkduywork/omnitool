// scripts/bench/md5.mjs — the optimisation that was measured and REJECTED.
//
// This harness exists to keep a negative result honest. hash.op.ts's vendored
// MD5 allocates a fresh Uint32Array per 64-byte block and reads its constants
// from plain arrays, both of which look like easy wins. They are not: the
// measurement below is what says so, and it is cheap to re-run when someone
// (or some future V8) is tempted again.
//
// The shipped code keeps the clearer version. If this harness ever shows a
// real gap, that decision should change — which is the point of committing the
// harness rather than a sentence in a commit message.

import { loadFromSource, cleanUp, measure, bytes } from './_bundle.mjs';

const MB = 1024 * 1024;
const SIZE = Number(process.env.BENCH_BYTES ?? 16 * MB);

const K = [
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501, 0x698098d8,
  0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340,
  0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8, 0x21e1cde6, 0xc33707d6, 0xf4d50d87,
  0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
  0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70, 0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039,
  0xe6db99e5, 0x1fa27cf8, 0xc4ac5665, 0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92,
  0xffeff47d, 0x85845dd1, 0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb,
  0xeb86d391,
];
const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14,
  20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6,
  10, 15, 21,
];
const K_TYPED = new Int32Array(K);
const S_TYPED = new Uint8Array(S);

/** The shipped algorithm, with the two candidate tweaks behind flags. */
function md5(data, { typed, hoist }) {
  const constants = typed ? K_TYPED : K;
  const shifts = typed ? S_TYPED : S;
  const n = data.length;
  const padLength = (((55 - n) % 64) + 64) % 64;
  const total = n + 1 + padLength + 8;
  const buffer = new Uint8Array(total);
  buffer.set(data, 0);
  buffer[n] = 0x80;
  const view = new DataView(buffer.buffer);
  view.setUint32(total - 8, (n * 8) >>> 0, true);
  view.setUint32(total - 4, Math.floor((n * 8) / 0x100000000) >>> 0, true);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const shared = new Uint32Array(16);

  for (let at = 0; at < total; at += 64) {
    const m = hoist ? shared : new Uint32Array(16);
    for (let j = 0; j < 16; j++) m[j] = view.getUint32(at + j * 4, true);

    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      f = (f + a + constants[i] + m[g]) >>> 0;
      a = d; d = c; c = b;
      const shift = shifts[i];
      b = (b + (((f << shift) | (f >>> (32 - shift))) >>> 0)) >>> 0;
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
  }

  const hex = (word) =>
    [word & 0xff, (word >>> 8) & 0xff, (word >>> 16) & 0xff, (word >>> 24) & 0xff]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  return hex(a0) + hex(b0) + hex(c0) + hex(d0);
}

// The shipped op is the reference for correctness: every variant must agree
// with it, and with RFC 1321's own vector.
const { default: hashOp } = await loadFromSource('src/tools/data/hash.op.ts');
const context = { onProgress() {}, signal: new AbortController().signal };
const abc = new TextEncoder().encode('abc');
const [digest] = await hashOp(
  [{ name: 'abc.txt', type: 'text/plain', buffer: abc.buffer.slice(0) }],
  { algorithm: 'md5' },
  context,
);
const shipped = new TextDecoder().decode(digest.buffer).trim();
console.log('\nmd5 — the shipped op against RFC 1321\'s md5("abc")');
console.log(`  ${shipped.includes('900150983cd24fb0d6963f7d28e17f72') ? 'matches' : 'DOES NOT MATCH'}`);

const payload = bytes(SIZE, 11);
const baseline = md5(payload, { typed: false, hoist: false });
for (const variant of [{ typed: true, hoist: false }, { typed: false, hoist: true }, { typed: true, hoist: true }]) {
  if (md5(payload, variant) !== baseline) console.log(`  VARIANT DISAGREES: ${JSON.stringify(variant)}`);
}

console.log(`\nmd5 — ${(SIZE / MB).toFixed(0)} MB, four variants`);
const rows = [
  ['as shipped (plain arrays, per-block alloc)', { typed: false, hoist: false }],
  ['typed constants', { typed: true, hoist: false }],
  ['hoisted block buffer', { typed: false, hoist: true }],
  ['both', { typed: true, hoist: true }],
];
const times = rows.map(([label, variant]) => [label, measure((p) => md5(p, variant), payload, 3)]);
const slowest = Math.max(...times.map(([, ms]) => ms));
const width = Math.max(...times.map(([label]) => label.length));
for (const [label, ms] of times) {
  const delta = ((1 - ms / slowest) * 100).toFixed(1);
  console.log(`  ${label.padEnd(width)}  ${ms.toFixed(1).padStart(8)} ms   ${delta.padStart(5)}% off the slowest`);
}
console.log('\n  Verdict: keep the clearer code unless one of these opens a real gap.');

await cleanUp();
