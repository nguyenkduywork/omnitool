// src/tools/data/json-format.op.ts
//
// json-format — pretty-prints or minifies JSON text. Malformed JSON raises
// OpError('InvalidOptions', ...) with the character position taken from the
// parser's own error message, per plan Task 5.

import { OpError } from '../../types.js';
import type { Op, OpOutput } from '../../types.js';

type Mode = 'pretty' | 'minify';

function parseJsonOrThrow(text: string, file: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const match = /position (\d+)/.exec(message);
    const pos = match ? match[1] : 'unknown';
    throw new OpError('InvalidOptions', `Malformed JSON at position ${pos}: ${message}`, file);
  }
}

function stripExt(name: string): string {
  return name.replace(/\.[^./\\]+$/, '');
}

const jsonFormatOp: Op = async (inputs, options, ctx) => {
  const rawMode = options.mode;
  const mode = rawMode === undefined ? 'pretty' : rawMode;
  if (mode !== 'pretty' && mode !== 'minify') {
    throw new OpError('InvalidOptions', `mode must be 'pretty' or 'minify', got ${JSON.stringify(rawMode)}`);
  }
  const resolvedMode: Mode = mode;

  const rawIndent = options.indent;
  const indent = rawIndent === undefined ? 2 : rawIndent;
  if (typeof indent !== 'number' || !Number.isInteger(indent) || indent < 1 || indent > 8) {
    throw new OpError('InvalidOptions', `indent must be an integer between 1 and 8, got ${JSON.stringify(rawIndent)}`);
  }

  if (inputs.length === 0) {
    throw new OpError('InvalidOptions', 'json-format requires at least one input file');
  }

  const outputs: OpOutput[] = [];
  const total = inputs.length;

  for (let i = 0; i < total; i++) {
    if (ctx.signal.aborted) throw new OpError('Cancelled', 'json-format cancelled');
    const input = inputs[i];
    if (!input) continue;

    const text = new TextDecoder().decode(input.buffer);
    const data = parseJsonOrThrow(text, input.name);
    const formatted = resolvedMode === 'pretty' ? JSON.stringify(data, null, indent) : JSON.stringify(data);

    outputs.push({
      name: `${stripExt(input.name)}.json`,
      type: 'application/json',
      buffer: new TextEncoder().encode(formatted).buffer,
    });

    ctx.onProgress((i + 1) / total);
  }

  return outputs;
};

export default jsonFormatOp;
