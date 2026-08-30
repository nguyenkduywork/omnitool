// src/tools/data/base64.op.ts
//
// base64 — encode raw bytes to a base64 text file, or decode a base64 text
// file back to raw bytes.
//
// The two directions deliberately use DIFFERENT machinery, because measurement
// disagreed with symmetry (16 MB, Node 24, median of 5):
//
//   encode — hand-rolled, 774 ms -> 30 ms. The obvious route (String.
//     fromCharCode over the bytes, btoa, then TextEncoder back to bytes)
//     builds three whole-file intermediates, two of them UTF-16 strings at
//     twice the file's size, before a single byte of output exists. Writing
//     alphabet character codes straight into the output buffer skips all
//     three. Output is byte-identical — asserted in tests/unit/data.test.ts.
//   decode — still native `atob`, 56 ms against 77 ms for the equivalent
//     hand-rolled decoder. The browser's own decoder is simply faster than
//     anything worth writing here, so this stays as it was.

import { OpError } from '../../types.js';
import type { Op, OpOutput } from '../../types.js';

type Direction = 'encode' | 'decode';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** The alphabet as character codes, so encoding writes bytes, never strings. */
const ENCODE_TABLE = /* @__PURE__ */ (() => {
  const table = new Uint8Array(64);
  for (let i = 0; i < 64; i++) table[i] = ALPHABET.charCodeAt(i);
  return table;
})();

const PAD = '='.charCodeAt(0);

/** Base64 as UTF-8 bytes: one pass, one allocation, no intermediate string. */
function encodeBase64(bytes: Uint8Array): Uint8Array {
  const n = bytes.length;
  const out = new Uint8Array(Math.ceil(n / 3) * 4);
  let o = 0;
  let i = 0;

  // Three bytes in, four characters out, for as long as a full group remains.
  for (; i + 2 < n; i += 3) {
    const word = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8) | (bytes[i + 2] as number);
    out[o++] = ENCODE_TABLE[(word >>> 18) & 63] as number;
    out[o++] = ENCODE_TABLE[(word >>> 12) & 63] as number;
    out[o++] = ENCODE_TABLE[(word >>> 6) & 63] as number;
    out[o++] = ENCODE_TABLE[word & 63] as number;
  }

  // The 1- or 2-byte tail, padded to a whole group with '='.
  const left = n - i;
  if (left === 1) {
    const word = (bytes[i] as number) << 16;
    out[o++] = ENCODE_TABLE[(word >>> 18) & 63] as number;
    out[o++] = ENCODE_TABLE[(word >>> 12) & 63] as number;
    out[o++] = PAD;
    out[o] = PAD;
  } else if (left === 2) {
    const word = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8);
    out[o++] = ENCODE_TABLE[(word >>> 18) & 63] as number;
    out[o++] = ENCODE_TABLE[(word >>> 12) & 63] as number;
    out[o++] = ENCODE_TABLE[(word >>> 6) & 63] as number;
    out[o] = PAD;
  }

  return out;
}

function binaryStringToBytes(binary: string): Uint8Array {
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function encodeName(name: string): string {
  return `${name}.base64.txt`;
}

function decodeName(name: string): string {
  return name.toLowerCase().endsWith('.base64.txt') ? name.slice(0, -'.base64.txt'.length) : `${name}.decoded`;
}

const base64Op: Op = async (inputs, options, ctx) => {
  const rawDirection = options.direction;
  const direction = rawDirection === undefined ? 'encode' : rawDirection;
  if (direction !== 'encode' && direction !== 'decode') {
    throw new OpError('InvalidOptions', `direction must be 'encode' or 'decode', got ${JSON.stringify(rawDirection)}`);
  }
  const dir: Direction = direction;

  if (inputs.length === 0) {
    throw new OpError('InvalidOptions', 'base64 requires at least one input file');
  }

  const outputs: OpOutput[] = [];
  const total = inputs.length;

  for (let i = 0; i < total; i++) {
    if (ctx.signal.aborted) throw new OpError('Cancelled', 'base64 cancelled');
    const input = inputs[i];
    if (!input) continue;

    if (dir === 'encode') {
      const encoded = encodeBase64(new Uint8Array(input.buffer));
      outputs.push({
        name: encodeName(input.name),
        type: 'text/plain',
        // Exactly sized by encodeBase64, so the view owns its whole buffer.
        buffer: encoded.buffer as ArrayBuffer,
      });
    } else {
      const text = new TextDecoder().decode(input.buffer).replace(/\s+/g, '');
      let binary: string;
      try {
        binary = atob(text);
      } catch (e) {
        throw new OpError(
          'CorruptFile',
          `not valid base64: ${e instanceof Error ? e.message : String(e)}`,
          input.name,
        );
      }
      const bytes = binaryStringToBytes(binary);
      outputs.push({
        name: decodeName(input.name),
        type: 'application/octet-stream',
        // Freshly allocated by binaryStringToBytes(), so this is always a
        // real ArrayBuffer at runtime, never a SharedArrayBuffer.
        buffer: bytes.buffer as ArrayBuffer,
      });
    }

    ctx.onProgress((i + 1) / total);
  }

  return outputs;
};

export default base64Op;
