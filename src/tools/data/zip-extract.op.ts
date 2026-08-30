// src/tools/data/zip-extract.op.ts
//
// zip-extract — unpacks every entry from one or more ZIP inputs using
// fflate's async unzip() API.
//
// SECURITY: entry names inside a ZIP are attacker-controlled strings and are
// never trusted verbatim. sanitizeEntryName() (./entry-name.ts, shared with
// tar-extract) neutralises path traversal (leading "../" or "/" segments)
// and Windows drive prefixes ("C:\") by dropping every ".."/"."/empty path
// segment, so the sanitised name can never resolve outside the extraction
// root. tests/fixtures/traversal.zip contains a real "../evil.txt" entry
// that must not be able to escape.

import { unzip as fflateUnzip } from 'fflate';

import { OpError } from '../../types.js';
import type { Op, OpOutput } from '../../types.js';
import { sanitizeEntryName } from './entry-name.js';

function unzipAsync(bytes: Uint8Array): Promise<Record<string, Uint8Array>> {
  return new Promise((resolve, reject) => {
    fflateUnzip(bytes, (err, files) => {
      if (err) reject(err);
      else resolve(files);
    });
  });
}

function isDirectoryEntry(rawName: string): boolean {
  return rawName.replace(/\\/g, '/').endsWith('/');
}

const zipExtractOp: Op = async (inputs, _options, ctx) => {
  if (inputs.length === 0) {
    throw new OpError('InvalidOptions', 'zip-extract requires at least one zip file');
  }

  const outputs: OpOutput[] = [];
  const total = inputs.length;
  const multi = total > 1;

  for (let i = 0; i < total; i++) {
    if (ctx.signal.aborted) throw new OpError('Cancelled', 'zip-extract cancelled');
    const input = inputs[i];
    if (!input) continue;

    let files: Record<string, Uint8Array>;
    try {
      files = await unzipAsync(new Uint8Array(input.buffer));
    } catch (e) {
      throw new OpError('CorruptFile', `could not read zip archive: ${e instanceof Error ? e.message : String(e)}`, input.name);
    }

    if (ctx.signal.aborted) throw new OpError('Cancelled', 'zip-extract cancelled');

    const stem = input.name.replace(/\.zip$/i, '');
    let unnamedCount = 0;

    for (const [rawName, bytes] of Object.entries(files)) {
      if (isDirectoryEntry(rawName)) continue;

      let safeName = sanitizeEntryName(rawName);
      if (safeName === null) {
        unnamedCount += 1;
        safeName = `unnamed-${unnamedCount}`;
      }

      outputs.push({
        name: multi ? `${stem}/${safeName}` : safeName,
        type: 'application/octet-stream',
        buffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      });
    }

    ctx.onProgress((i + 1) / total);
  }

  if (outputs.length === 0) {
    throw new OpError('CorruptFile', 'zip archive contained no extractable files');
  }

  return outputs;
};

export default zipExtractOp;
