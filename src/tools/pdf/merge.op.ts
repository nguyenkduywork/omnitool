// src/tools/pdf/merge.op.ts — the reference op.
//
// The shape every other op copies: import nothing but src/types.ts and the npm
// engine it needs, take (inputs, options, ctx), report progress, honour
// ctx.signal, and raise an OpError NAMING THE FILE when one input is at fault —
// that name is what lets the runner report per-file failure instead of binning
// the whole job.

import { PDFDocument } from 'pdf-lib';

import { OpError, type Op, type OpOutput } from '../../types';

function stop(signal: AbortSignal): void {
  if (signal.aborted) throw new OpError('Cancelled', 'Cancelled');
}

/** Copy into a fresh, exactly-sized ArrayBuffer so it can be transferred. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

const merge: Op = async (inputs, _options, ctx): Promise<OpOutput[]> => {
  if (inputs.length === 0) {
    throw new OpError('InvalidOptions', 'Merging needs at least one PDF.');
  }

  stop(ctx.signal);
  const merged = await PDFDocument.create();

  let read = 0;
  for (const input of inputs) {
    stop(ctx.signal);
    try {
      const source = await PDFDocument.load(input.buffer);
      const pages = await merged.copyPages(source, source.getPageIndices());
      for (const page of pages) merged.addPage(page);
    } catch (error) {
      if (error instanceof OpError) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      // Naming the file is what makes this a per-file failure, not a job failure.
      throw new OpError('CorruptFile', `Could not read ${input.name}: ${reason}`, input.name);
    }
    read += 1;
    // Saving is the last step, so reading n files is n/(n+1) of the work.
    ctx.onProgress(read / (inputs.length + 1));
  }

  stop(ctx.signal);
  const bytes = await merged.save();
  ctx.onProgress(1);

  return [{ name: 'merged.pdf', type: 'application/pdf', buffer: toArrayBuffer(bytes) }];
};

export default merge;
