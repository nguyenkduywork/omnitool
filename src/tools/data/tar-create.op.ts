// src/tools/data/tar-create.op.ts — tar-create: bundle the dropped files into
// one .tar, optionally gzipped to .tar.gz.
//
// TAR beside ZIP because they are not the same archive: a tar keeps the byte
// stream and the entry names, and `.tar.gz` is what most Unix tooling expects
// to receive. The format work lives in ./tar.ts; this file is options,
// progress and naming.

import { gzipSync } from 'fflate';

import { OpError } from '../../types';
import type { Op, OpOutput } from '../../types';
import { writeTar, type TarEntry } from './tar';

/** See gzip.op.ts: never hand back a view's slack as if it were file content. */
function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  return view.byteOffset === 0 && view.byteLength === view.buffer.byteLength
    ? (view.buffer as ArrayBuffer)
    : (view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer);
}

function validateName(raw: unknown): string {
  const value = raw === undefined ? 'archive' : raw;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new OpError('InvalidOptions', `name must be a non-empty string, got ${JSON.stringify(raw)}`);
  }
  return value.trim();
}

function validateBool(raw: unknown, def: boolean, label: string): boolean {
  const value = raw === undefined ? def : raw;
  if (typeof value !== 'boolean') {
    throw new OpError('InvalidOptions', `${label} must be a boolean, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function validateLevel(raw: unknown): 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 {
  const value = raw === undefined ? 6 : raw;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 9) {
    throw new OpError('InvalidOptions', `level must be an integer between 0 and 9, got ${JSON.stringify(raw)}`);
  }
  return value as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
}

const tarCreate: Op = async (inputs, options, ctx): Promise<OpOutput[]> => {
  if (inputs.length === 0) {
    throw new OpError('InvalidOptions', 'tar-create requires at least one input file');
  }
  const name = validateName(options.name);
  const compress = validateBool(options.gzip, false, 'gzip');
  const level = validateLevel(options.level);

  const entries: TarEntry[] = inputs.map((input) => ({
    name: input.name,
    bytes: new Uint8Array(input.buffer),
  }));

  // writeTar calls back as each header is genuinely built, which is what makes
  // this progress real rather than a 0-then-1 impression of work.
  const archive = writeTar(entries, (index) => {
    if (ctx.signal.aborted) throw new OpError('Cancelled', 'tar-create cancelled');
    ctx.onProgress((index + 1) / (compress ? inputs.length + 1 : inputs.length));
  });

  if (!compress) {
    return [{ name: `${name}.tar`, type: 'application/x-tar', buffer: toArrayBuffer(archive) }];
  }

  if (ctx.signal.aborted) throw new OpError('Cancelled', 'tar-create cancelled');
  const packed = gzipSync(archive, { level, mtime: 0 });
  ctx.onProgress(1);
  return [{ name: `${name}.tar.gz`, type: 'application/gzip', buffer: toArrayBuffer(packed) }];
};

export default tarCreate;
