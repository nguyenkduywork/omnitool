// src/tools/data/zip-create.op.ts
//
// zip-create — bundles every input file into a single ZIP archive using
// fflate's streaming async API (Zip + AsyncZipDeflate), so compression is
// genuine per-file async work rather than a synchronous zipSync() call
// dressed up with a fake 0-then-1 progress report.

import { AsyncZipDeflate, Zip } from 'fflate';

import { OpError } from '../../types.js';
import type { Op } from '../../types.js';

type ZipLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

function isValidLevel(v: unknown): v is ZipLevel {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 9;
}

const zipCreateOp: Op = async (inputs, options, ctx) => {
  if (inputs.length === 0) {
    throw new OpError('InvalidOptions', 'zip-create requires at least one input file');
  }

  const rawName = options.name;
  const name = rawName === undefined ? 'archive' : rawName;
  if (typeof name !== 'string' || name.trim() === '') {
    throw new OpError('InvalidOptions', `name must be a non-empty string, got ${JSON.stringify(rawName)}`);
  }

  const rawLevel = options.level;
  const level = rawLevel === undefined ? 6 : rawLevel;
  if (!isValidLevel(level)) {
    throw new OpError('InvalidOptions', `level must be an integer between 0 and 9, got ${JSON.stringify(rawLevel)}`);
  }

  const total = inputs.length;

  const zipped = await new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Uint8Array[] = [];

    const archive = new Zip((err, chunk, final) => {
      if (err) {
        reject(err);
        return;
      }
      chunks.push(chunk);
      if (final) {
        const size = chunks.reduce((sum, c) => sum + c.length, 0);
        const out = new Uint8Array(size);
        let offset = 0;
        for (const c of chunks) {
          out.set(c, offset);
          offset += c.length;
        }
        resolve(out);
      }
    });

    try {
      for (let i = 0; i < total; i++) {
        if (ctx.signal.aborted) {
          archive.terminate();
          reject(new OpError('Cancelled', 'zip-create cancelled'));
          return;
        }
        const input = inputs[i];
        if (!input) continue;

        const entry = new AsyncZipDeflate(input.name, { level });
        archive.add(entry);
        entry.push(new Uint8Array(input.buffer), true);

        ctx.onProgress((i + 1) / total);
      }
      archive.end();
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });

  return [
    {
      name: `${name}.zip`,
      type: 'application/zip',
      // Freshly allocated above, so always a real ArrayBuffer at runtime.
      buffer: zipped.buffer as ArrayBuffer,
    },
  ];
};

export default zipCreateOp;
