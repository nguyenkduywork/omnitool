// src/tools/data/tar-extract.op.ts — tar-extract: unpack a .tar or .tar.gz.
//
// A gzipped archive is gunzipped first and then read as a tar, so `.tar.gz`
// and `.tgz` work without a second tool. A .gz that turns out NOT to contain
// a tar fails as CorruptFile naming the file — the gzip tool is the one that
// unwraps those, and quietly emitting the decompressed blob under a made-up
// name would be a different operation than the one you asked for.
//
// SECURITY: entry names are sanitised through ./entry-name.ts, the same
// function zip-extract uses, so an entry called "../evil.txt" cannot escape.

import { gunzipSync } from 'fflate';

import { OpError } from '../../types';
import type { Op, OpOutput } from '../../types';
import { sanitizeEntryName } from './entry-name';
import { readTar } from './tar';

function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

function isTar(bytes: Uint8Array): boolean {
  // 'ustar' at offset 257 is the ustar/POSIX magic; older v7 tars have none,
  // which is why a failed read below still reports honestly rather than here.
  const magic = 'ustar';
  if (bytes.length < 262) return false;
  for (let i = 0; i < magic.length; i++) {
    if (bytes[257 + i] !== magic.charCodeAt(i)) return false;
  }
  return true;
}

function stemOf(name: string): string {
  return name.replace(/\.tar\.gz$/i, '').replace(/\.tgz$/i, '').replace(/\.tar$/i, '');
}

const tarExtract: Op = async (inputs, _options, ctx): Promise<OpOutput[]> => {
  if (inputs.length === 0) {
    throw new OpError('InvalidOptions', 'tar-extract requires at least one archive');
  }

  const outputs: OpOutput[] = [];
  const multi = inputs.length > 1;

  for (let index = 0; index < inputs.length; index++) {
    if (ctx.signal.aborted) throw new OpError('Cancelled', 'tar-extract cancelled');
    const input = inputs[index];
    if (input === undefined) continue;

    let bytes = new Uint8Array(input.buffer);
    if (isGzip(bytes)) {
      try {
        bytes = gunzipSync(bytes);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new OpError('CorruptFile', `Could not decompress ${input.name}: ${reason}`, input.name);
      }
      if (!isTar(bytes)) {
        throw new OpError(
          'UnsupportedFormat',
          `${input.name} is a gzip file, but what it contains is not a tar archive — use the gzip tool to unwrap it.`,
          input.name,
        );
      }
    }

    if (ctx.signal.aborted) throw new OpError('Cancelled', 'tar-extract cancelled');
    const entries = readTar(bytes, input.name);
    const stem = stemOf(input.name);
    let unnamed = 0;

    for (const entry of entries) {
      let safeName = sanitizeEntryName(entry.name);
      if (safeName === null) {
        unnamed += 1;
        safeName = `unnamed-${unnamed}`;
      }
      outputs.push({
        name: multi ? `${stem}/${safeName}` : safeName,
        type: 'application/octet-stream',
        buffer: entry.bytes.buffer.slice(
          entry.bytes.byteOffset,
          entry.bytes.byteOffset + entry.bytes.byteLength,
        ) as ArrayBuffer,
      });
    }

    ctx.onProgress((index + 1) / inputs.length);
  }

  if (outputs.length === 0) {
    throw new OpError('CorruptFile', 'the archive contained no extractable files');
  }

  return outputs;
};

export default tarExtract;
