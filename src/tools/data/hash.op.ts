// src/tools/data/hash.op.ts
//
// hash — computes a checksum for every input file.
// SHA-1 / SHA-256 / SHA-512 go through the standard SubtleCrypto API.
// MD5 is NOT available on SubtleCrypto, so it is vendored below (RFC 1321),
// self-tested against the classic vector md5("abc") ===
// "900150983cd24fb0d6963f7d28e17f72" in tests/unit/data.test.ts.

import { OpError } from '../../types.js';
import type { Op, OpOutput } from '../../types.js';

type Algorithm = 'sha-256' | 'sha-1' | 'sha-512' | 'md5';

const SUBTLE_NAME: Record<Exclude<Algorithm, 'md5'>, string> = {
  'sha-256': 'SHA-256',
  'sha-1': 'SHA-1',
  'sha-512': 'SHA-512',
};

const VALID_ALGORITHMS: Algorithm[] = ['sha-256', 'sha-1', 'sha-512', 'md5'];

function isAlgorithm(v: unknown): v is Algorithm {
  return typeof v === 'string' && (VALID_ALGORITHMS as string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Vendored MD5 (RFC 1321) — pure JS, no dependency on SubtleCrypto.
// ---------------------------------------------------------------------------

const MD5_K = [
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501, 0x698098d8,
  0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340,
  0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8, 0x21e1cde6, 0xc33707d6, 0xf4d50d87,
  0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
  0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70, 0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039,
  0xe6db99e5, 0x1fa27cf8, 0xc4ac5665, 0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92,
  0xffeff47d, 0x85845dd1, 0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb,
  0xeb86d391,
];

const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14,
  20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6,
  10, 15, 21,
];

function leftRotate(x: number, c: number): number {
  return ((x << c) | (x >>> (32 - c))) >>> 0;
}

function md5Hex(data: Uint8Array): string {
  const n = data.length;
  const padLen = ((55 - n) % 64 + 64) % 64;
  const total = n + 1 + padLen + 8;
  const buf = new Uint8Array(total);
  buf.set(data, 0);
  buf[n] = 0x80;

  const view = new DataView(buf.buffer);
  const msgLenBits = n * 8;
  view.setUint32(total - 8, msgLenBits >>> 0, true);
  view.setUint32(total - 4, Math.floor(msgLenBits / 0x100000000) >>> 0, true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let chunkStart = 0; chunkStart < total; chunkStart += 64) {
    const m = new Uint32Array(16);
    for (let j = 0; j < 16; j++) {
      m[j] = view.getUint32(chunkStart + j * 4, true);
    }

    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      f = (f + a + (MD5_K[i] as number) + (m[g] as number)) >>> 0;
      a = d;
      d = c;
      c = b;
      b = (b + leftRotate(f, MD5_S[i] as number)) >>> 0;
    }

    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  function toHexLE(word: number): string {
    const bytes = [word & 0xff, (word >>> 8) & 0xff, (word >>> 16) & 0xff, (word >>> 24) & 0xff];
    return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  return toHexLE(a0) + toHexLE(b0) + toHexLE(c0) + toHexLE(d0);
}

function bufToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

const hashOp: Op = async (inputs, options, ctx) => {
  const rawAlgorithm = options.algorithm;
  const candidateAlgorithm = rawAlgorithm === undefined ? 'sha-256' : rawAlgorithm;
  if (!isAlgorithm(candidateAlgorithm)) {
    throw new OpError(
      'InvalidOptions',
      `algorithm must be one of ${VALID_ALGORITHMS.join(', ')}, got ${JSON.stringify(rawAlgorithm)}`,
    );
  }
  const algorithm: Algorithm = candidateAlgorithm;

  if (inputs.length === 0) {
    throw new OpError('InvalidOptions', 'hash requires at least one input file');
  }

  const outputs: OpOutput[] = [];
  const total = inputs.length;

  for (let i = 0; i < total; i++) {
    if (ctx.signal.aborted) throw new OpError('Cancelled', 'hash cancelled');
    const input = inputs[i];
    if (!input) continue;

    let hex: string;
    if (algorithm === 'md5') {
      hex = md5Hex(new Uint8Array(input.buffer));
    } else {
      const digest = await crypto.subtle.digest(SUBTLE_NAME[algorithm], input.buffer);
      hex = bufToHex(digest);
    }

    outputs.push({
      name: `${input.name}.${algorithm}.txt`,
      type: 'text/plain',
      buffer: new TextEncoder().encode(hex).buffer,
    });

    ctx.onProgress((i + 1) / total);
  }

  return outputs;
};

export default hashOp;
