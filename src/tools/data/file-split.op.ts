// src/tools/data/file-split.op.ts — file-split: cut a file into fixed-size
// parts that file-join puts back together.
//
// Works on any file at all, because it never looks inside one: the parts are
// plain byte slices, so part 1 of a PDF is not a PDF and is not pretending to
// be. That is the point — this is for getting a file past a size limit and
// reassembling it on the other side, not for producing N usable documents.
//
// Parts are named `<file>.partNNN`, numbered from 1 and zero-padded so that
// alphabetical order (what a file picker gives you) is also numeric order —
// which is what lets file-join verify the sequence instead of trusting it.

import { OpError } from '../../types';
import type { Op, OpOutput } from '../../types';

/** A cap on parts, so a mistyped size cannot produce tens of thousands. */
const MAX_PARTS = 1000;

type Unit = 'KB' | 'MB';
const UNITS: Unit[] = ['KB', 'MB'];
const BYTES_PER: Record<Unit, number> = { KB: 1024, MB: 1024 * 1024 };

function validateSize(raw: unknown): number {
  const value = raw === undefined ? 10 : raw;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > 4096) {
    throw new OpError('InvalidOptions', `size must be a number between 1 and 4096, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function validateUnit(raw: unknown): Unit {
  const value = raw === undefined ? 'MB' : raw;
  if (typeof value !== 'string' || !UNITS.includes(value as Unit)) {
    throw new OpError('InvalidOptions', `unit must be one of ${UNITS.join(', ')}, got ${JSON.stringify(raw)}`);
  }
  return value as Unit;
}

const fileSplit: Op = async (inputs, options, ctx): Promise<OpOutput[]> => {
  if (inputs.length === 0) {
    throw new OpError('InvalidOptions', 'file-split needs at least one file');
  }
  const size = validateSize(options.size);
  const unit = validateUnit(options.unit);
  const partBytes = Math.round(size * BYTES_PER[unit]);

  // Counted up front so progress is per part written, not per file.
  const partsPerInput = inputs.map((input) => Math.max(1, Math.ceil(input.buffer.byteLength / partBytes)));
  const totalParts = partsPerInput.reduce((sum, count) => sum + count, 0);

  const outputs: OpOutput[] = [];
  let written = 0;

  for (let index = 0; index < inputs.length; index++) {
    const input = inputs[index];
    if (input === undefined) continue;
    const count = partsPerInput[index] as number;

    if (count > MAX_PARTS) {
      throw new OpError(
        'InvalidOptions',
        `Splitting ${input.name} at ${size} ${unit} would make ${count} parts, more than the ${MAX_PARTS}-part limit. Use a larger part size.`,
        input.name,
      );
    }

    const width = Math.max(3, String(count).length);
    for (let part = 0; part < count; part++) {
      if (ctx.signal.aborted) throw new OpError('Cancelled', 'file-split cancelled');
      const from = part * partBytes;
      const to = Math.min(from + partBytes, input.buffer.byteLength);
      outputs.push({
        name: `${input.name}.part${String(part + 1).padStart(width, '0')}`,
        type: 'application/octet-stream',
        buffer: input.buffer.slice(from, to),
      });
      written += 1;
      ctx.onProgress(written / totalParts);
    }
  }

  return outputs;
};

export default fileSplit;
