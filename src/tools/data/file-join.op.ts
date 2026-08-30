// src/tools/data/file-join.op.ts — file-join: concatenate parts back into the
// file they came from.
//
// Parts are joined in FILE-TRAY ORDER, like every other order-sensitive tool
// here. But when the names say what order they belong in — `<file>.partNNN`
// from file-split, or the `<file.ext>.NNN` convention other splitters use —
// that claim is checked against the tray: the numbers must run 1, 2, 3 with
// no gaps and no repeats. A file joined from parts in the wrong order is
// silently corrupt, and silent corruption is the one outcome worth refusing.
//
// The refusal is deliberately NOT attributed to a single file: an OpError
// carrying a file name tells the worker to drop that input and retry (see
// runner.worker.ts's per-file-failure loop), which here would "succeed" by
// joining a subset — exactly the corrupt output the check exists to prevent.

import { OpError } from '../../types';
import type { Op, OpInput, OpOutput } from '../../types';

/** `photos.zip.part003` and `photos.zip.003` — the two conventions in the wild. */
const PART_SUFFIX = /^(.*)\.part(\d+)$/i;
const NUMERIC_SUFFIX = /^(.*\..+)\.(\d{3,})$/;

type Part = { stem: string; number: number };

function parsePart(name: string): Part | null {
  const explicit = PART_SUFFIX.exec(name);
  if (explicit) return { stem: explicit[1] as string, number: Number(explicit[2]) };
  // Requires the stem to keep an extension, so `notes.2024` is a file called
  // notes.2024 rather than part 2024 of something called notes.
  const numeric = NUMERIC_SUFFIX.exec(name);
  if (numeric) return { stem: numeric[1] as string, number: Number(numeric[2]) };
  return null;
}

/** The joined file's name, and the sequence check, from the inputs' names. */
function outputName(inputs: OpInput[]): string {
  const parts = inputs.map((input) => parsePart(input.name));
  const first = parts[0];
  const named = first !== null && first !== undefined;
  const allMatch = named && parts.every((part) => part !== null && part.stem === first.stem);
  if (!allMatch) {
    // Nothing to verify against: the tray order is all there is to go on.
    return `${inputs[0]?.name ?? 'joined'}.joined`;
  }

  const numbers = (parts as Part[]).map((part) => part.number);
  const sorted = [...numbers].sort((left, right) => left - right);
  const isCompleteRun = sorted.every((number, index) => number === index + 1);

  if (isCompleteRun) {
    // Every part is here; the only thing that can be wrong is the tray order.
    const outOfPlace = numbers.findIndex((number, index) => number !== sorted[index]);
    if (outOfPlace >= 0) {
      throw new OpError(
        'InvalidOptions',
        `These parts are not in order: ${inputs[outOfPlace]?.name} is part ${numbers[outOfPlace]} of ${numbers.length}. Reorder the file tray so the part numbers run 1 to ${numbers.length}.`,
      );
    }
    return first.stem;
  }

  const smallest = sorted[0] as number;
  if (smallest > 1) {
    throw new OpError(
      'InvalidOptions',
      `These parts start at ${smallest}, so part 1 is missing. Add it before joining.`,
    );
  }
  throw new OpError(
    'InvalidOptions',
    `These parts are numbered ${sorted.join(', ')}, which is not a complete run from 1 to ${numbers.length} — one is missing or listed twice.`,
  );
}

const fileJoin: Op = async (inputs, _options, ctx): Promise<OpOutput[]> => {
  if (inputs.length < 2) {
    throw new OpError('InvalidOptions', 'file-join needs at least two parts');
  }
  const name = outputName(inputs);

  const total = inputs.reduce((sum, input) => sum + input.buffer.byteLength, 0);
  let joined: Uint8Array;
  try {
    joined = new Uint8Array(total);
  } catch {
    throw new OpError(
      'OutOfMemory',
      `Joining these parts needs ${total} contiguous bytes, which this browser would not allocate.`,
    );
  }

  let at = 0;
  for (let index = 0; index < inputs.length; index++) {
    if (ctx.signal.aborted) throw new OpError('Cancelled', 'file-join cancelled');
    const input = inputs[index];
    if (input === undefined) continue;
    joined.set(new Uint8Array(input.buffer), at);
    at += input.buffer.byteLength;
    ctx.onProgress((index + 1) / inputs.length);
  }

  return [{ name, type: 'application/octet-stream', buffer: joined.buffer as ArrayBuffer }];
};

export default fileJoin;
