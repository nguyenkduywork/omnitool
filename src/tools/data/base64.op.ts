// src/tools/data/base64.op.ts
//
// base64 — encode raw bytes to a base64 text file, or decode a base64 text
// file back to raw bytes. Uses the Web-standard btoa/atob (available in both
// browsers and workers), chunked to avoid call-stack blowups on large files.

import { OpError } from '../../types.js';
import type { Op, OpOutput } from '../../types.js';

type Direction = 'encode' | 'decode';

const CHUNK_SIZE = 0x8000;

function bytesToBinaryString(bytes: Uint8Array): string {
  let out = '';
  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    const chunk = bytes.subarray(offset, offset + CHUNK_SIZE);
    out += String.fromCharCode(...chunk);
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
      const encoded = btoa(bytesToBinaryString(new Uint8Array(input.buffer)));
      outputs.push({
        name: encodeName(input.name),
        type: 'text/plain',
        buffer: new TextEncoder().encode(encoded).buffer,
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
