// src/tools/data/gzip.op.ts — gzip: compress files to .gz, or decompress them.
//
// Direction is an option rather than two tools because a .gz and the file it
// came from are the same tool's two halves, exactly as base64 encode/decode
// is. Decompression checks the 1f 8b magic itself before handing bytes to
// fflate, so "this isn't a gzip file" is a typed UnsupportedFormat naming the
// file rather than a decoder's internal complaint.
//
// The gzip header records mtime 0, not "now". An OpInput carries a name, a
// type and bytes; the file's real modification time is not among them, so
// there is nothing honest to write there — and 0 has the side benefit of
// making the output byte-deterministic for the same input and level.

import { gunzipSync, gzipSync } from 'fflate';

import { OpError } from '../../types';
import type { Op, OpOutput } from '../../types';

/**
 * The exact bytes of a view as an ArrayBuffer, without copying when the view
 * already owns its whole buffer. fflate returns exact-size arrays today, but
 * an output that was a subarray would otherwise hand back trailing slack as
 * if it were file content.
 */
function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  return view.byteOffset === 0 && view.byteLength === view.buffer.byteLength
    ? (view.buffer as ArrayBuffer)
    : (view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer);
}

function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

type Direction = 'encode' | 'decode';
const DIRECTIONS: Direction[] = ['encode', 'decode'];

function validateDirection(raw: unknown): Direction {
  const value = raw === undefined ? 'encode' : raw;
  if (typeof value !== 'string' || !DIRECTIONS.includes(value as Direction)) {
    throw new OpError('InvalidOptions', `direction must be one of ${DIRECTIONS.join(', ')}, got ${JSON.stringify(raw)}`);
  }
  return value as Direction;
}

function validateLevel(raw: unknown): 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 {
  const value = raw === undefined ? 6 : raw;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 9) {
    throw new OpError('InvalidOptions', `level must be an integer between 0 and 9, got ${JSON.stringify(raw)}`);
  }
  return value as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
}

/** `photos.tar.gz` -> `photos.tar`, `photos.tgz` -> `photos.tar`. */
function decompressedName(name: string): string {
  if (/\.tgz$/i.test(name)) return `${name.slice(0, -4)}.tar`;
  if (/\.gz$/i.test(name)) return name.slice(0, -3);
  return `${name}.out`;
}

const gzip: Op = async (inputs, options, ctx): Promise<OpOutput[]> => {
  if (inputs.length === 0) {
    throw new OpError('InvalidOptions', 'gzip needs at least one file');
  }
  const direction = validateDirection(options.direction);
  const level = validateLevel(options.level);

  const outputs: OpOutput[] = [];
  for (let index = 0; index < inputs.length; index++) {
    if (ctx.signal.aborted) throw new OpError('Cancelled', 'gzip cancelled');
    const input = inputs[index];
    if (input === undefined) continue;
    const bytes = new Uint8Array(input.buffer);

    if (direction === 'encode') {
      const packed = gzipSync(bytes, { level, mtime: 0 });
      outputs.push({
        name: `${input.name}.gz`,
        type: 'application/gzip',
        buffer: toArrayBuffer(packed),
      });
    } else {
      if (!isGzip(bytes)) {
        throw new OpError('UnsupportedFormat', `${input.name} is not a gzip file (no 1f 8b header).`, input.name);
      }
      let unpacked: Uint8Array;
      try {
        unpacked = gunzipSync(bytes);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new OpError('CorruptFile', `Could not decompress ${input.name}: ${reason}`, input.name);
      }
      outputs.push({
        name: decompressedName(input.name),
        type: 'application/octet-stream',
        buffer: toArrayBuffer(unpacked),
      });
    }

    ctx.onProgress((index + 1) / inputs.length);
  }

  return outputs;
};

export default gzip;
