// src/tools/data/text-diff.op.ts — text-diff: compare two text or source files.
//
// The comparison itself lives in ./diff.ts, shared with text-diff.editor.ts so
// the report you export is the one you were just looking at. This module is
// only the two OUTPUT formats, and the choice between them is a choice between
// two audiences:
//
//   html     — a self-contained side-by-side report for a person. Inline CSS,
//              no script, no network reference of any kind, so it opens from a
//              file:// URL on a machine with no internet and still looks right
//              in both light and dark. That is not decoration: an "offline
//              tools" app that emits a report needing a CDN would be lying.
//   unified  — a real `.diff` patch for a machine: `---`/`+++` headers, `@@`
//              hunks numbered from 1, and `\ No newline at end of file` where
//              a side lacks one. `patch -p1` and `git apply` read it.
//
// BINARY INPUT IS REFUSED BY NAME. A file that is not valid UTF-8 raises
// UnsupportedFormat carrying the filename — not CorruptFile, which would claim
// something about the file that is not true: a PNG is a perfectly good PNG,
// it just is not text. strip-metadata.op.ts refuses the same way.

import { OpError, type Op, type OpInput, type OpOutput } from '../../types';

import {
  collapseRows,
  diffLines,
  diffWords,
  toRows,
  toUnified,
  type DiffResult,
  type DiffRow,
  type GapRow,
  type WordSegment,
} from './diff';

type Format = 'html' | 'unified';
type Scope = 'changes' | 'whole';

const FORMATS: Format[] = ['html', 'unified'];
const SCOPES: Scope[] = ['changes', 'whole'];

function stop(signal: AbortSignal): void {
  if (signal.aborted) throw new OpError('Cancelled', 'Cancelled');
}

function validateChoice<T extends string>(raw: unknown, allowed: T[], def: T, label: string): T {
  const value = raw === undefined ? def : raw;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new OpError(
      'InvalidOptions',
      `${label} must be one of ${allowed.join(', ')}, got ${JSON.stringify(raw)}`,
    );
  }
  return value as T;
}

function validateBool(raw: unknown, def: boolean, label: string): boolean {
  const value = raw === undefined ? def : raw;
  if (typeof value !== 'boolean') {
    throw new OpError('InvalidOptions', `${label} must be a boolean, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function validateNumber(raw: unknown, def: number, min: number, max: number, label: string): number {
  const value = raw === undefined ? def : raw;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new OpError(
      'InvalidOptions',
      `${label} must be a number between ${min} and ${max}, got ${JSON.stringify(raw)}`,
    );
  }
  return Math.round(value);
}

function decodeText(input: OpInput): string {
  try {
    // `ignoreBOM` keeps the mark in the string, so splitLines can report it
    // rather than silently swallowing a real difference between the files.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input.buffer);
  } catch {
    throw new OpError(
      'UnsupportedFormat',
      `${input.name} is not valid UTF-8 text — this tool compares text and source files`,
      input.name,
    );
  }
}

function stem(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? name : name.slice(0, dot);
}

function toArrayBuffer(text: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(text);
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

// ---------------------------------------------------------------------------
// The HTML report
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** One cell's text, with the changed runs wrapped in a `<mark>`. */
function cellHtml(segments: readonly WordSegment[]): string {
  return segments
    .map((segment) =>
      segment.changed ? `<mark>${escapeHtml(segment.text)}</mark>` : escapeHtml(segment.text),
    )
    .join('');
}

/**
 * Styles for the exported report. Deliberately NOT the app's design tokens: the
 * report is a standalone file that has to survive being emailed, so it carries
 * its own tiny palette rather than a dangling `var(--ink)` that resolves to
 * nothing outside the app.
 */
const REPORT_CSS = `
:root { color-scheme: light dark; --bg:#ffffff; --panel:#f6f7f9; --ink:#12161c; --quiet:#5b6570;
  --line:#dfe3e8; --add:#e7f6ec; --add-word:#b7e7c6; --del:#fdeceb; --del-word:#f7c3bf; --gap:#f1f3f5; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#0f1319; --panel:#161c25; --ink:#e9eef4; --quiet:#98a3b0; --line:#28313d;
    --add:#12301f; --add-word:#1f5a37; --del:#331a1a; --del-word:#6d2b28; --gap:#1a212b; }
}
* { box-sizing: border-box; }
body { margin:0; padding:24px; background:var(--bg); color:var(--ink);
  font:14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
h1 { font-size:17px; margin:0 0 4px; }
.sub { color:var(--quiet); font-size:13px; margin:0 0 16px; }
.stats { display:flex; flex-wrap:wrap; gap:8px; margin:0 0 16px; padding:0; list-style:none; }
.stats li { background:var(--panel); border:1px solid var(--line); border-radius:999px;
  padding:3px 10px; font-size:12px; }
.note { background:var(--panel); border:1px solid var(--line); border-left-width:3px;
  border-radius:6px; padding:10px 12px; margin:0 0 16px; font-size:13px; }
table { border-collapse:collapse; width:100%; table-layout:fixed;
  font:12px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; tab-size:4; }
col.num { width:3.5em; }
td { padding:1px 8px; vertical-align:top; white-space:pre-wrap; overflow-wrap:anywhere;
  border-bottom:1px solid transparent; }
td.num { width:3.5em; text-align:right; color:var(--quiet); background:var(--panel);
  border-right:1px solid var(--line); user-select:none; white-space:nowrap; }
tr.add td.code-b, tr.rep td.code-b { background:var(--add); }
tr.del td.code-a, tr.rep td.code-a { background:var(--del); }
tr.add td.code-a, tr.del td.code-b { background:var(--gap); }
td.code-b mark { background:var(--add-word); color:inherit; border-radius:2px; }
td.code-a mark { background:var(--del-word); color:inherit; border-radius:2px; }
tr.gap td { background:var(--gap); color:var(--quiet); text-align:center; font-size:11px;
  padding:4px; border-top:1px solid var(--line); border-bottom:1px solid var(--line); }
@media print { body { padding:0; } .note, .stats li { border-color:#999; } }
`;

function reportHtml(
  result: DiffResult,
  rows: readonly (DiffRow | GapRow)[],
  names: { a: string; b: string },
  options: { ignoreWhitespace: boolean; ignoreCase: boolean },
): string {
  const { stats } = result;
  const body: string[] = [];

  for (const row of rows) {
    if (row.kind === 'gap') {
      body.push(
        `<tr class="gap"><td colspan="4">${row.count} unchanged line${row.count === 1 ? '' : 's'}</td></tr>`,
      );
      continue;
    }

    const aText = row.a === null ? null : (result.a.lines[row.a] ?? '');
    const bText = row.b === null ? null : (result.b.lines[row.b] ?? '');
    let aHtml = aText === null ? '' : escapeHtml(aText);
    let bHtml = bText === null ? '' : escapeHtml(bText);
    if (row.kind === 'replace' && aText !== null && bText !== null) {
      const words = diffWords(aText, bText, options);
      aHtml = cellHtml(words.a);
      bHtml = cellHtml(words.b);
    }

    const cls = row.kind === 'equal' ? 'eq' : row.kind === 'insert' ? 'add' : row.kind === 'delete' ? 'del' : 'rep';
    body.push(
      `<tr class="${cls}">` +
        `<td class="num">${row.a === null ? '' : row.a + 1}</td>` +
        `<td class="code-a">${aHtml}</td>` +
        `<td class="num">${row.b === null ? '' : row.b + 1}</td>` +
        `<td class="code-b">${bHtml}</td>` +
        `</tr>`,
    );
  }

  const notes: string[] = [];
  if (result.identicalLines && result.onlyEndingsDiffer) {
    notes.push(
      'Every line is identical. The files differ only in their line endings or byte-order mark.',
    );
  } else if (result.identicalLines) {
    notes.push('No differences: these two files have identical contents.');
  }
  if (result.degraded) {
    notes.push(
      'These files share too little structure to align line by line, so one region is reported as a wholesale replacement.',
    );
  }
  if (options.ignoreWhitespace) notes.push('Whitespace changes were ignored.');
  if (options.ignoreCase) notes.push('Letter case was ignored.');

  const percent = Math.round(stats.similarity * 100);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(names.a)} vs ${escapeHtml(names.b)}</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<h1>${escapeHtml(names.a)} <span aria-hidden="true">&rarr;</span> ${escapeHtml(names.b)}</h1>
<p class="sub">Left is ${escapeHtml(names.a)}, right is ${escapeHtml(names.b)}.</p>
<ul class="stats">
<li>${stats.added} added</li>
<li>${stats.removed} removed</li>
<li>${stats.changed} changed</li>
<li>${percent}% unchanged</li>
</ul>
${notes.map((note) => `<p class="note">${escapeHtml(note)}</p>`).join('\n')}
<table>
<colgroup><col class="num"><col><col class="num"><col></colgroup>
<tbody>
${body.join('\n')}
</tbody>
</table>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// The op
// ---------------------------------------------------------------------------

const textDiff: Op = async (inputs, options, ctx): Promise<OpOutput[]> => {
  if (inputs.length !== 2) {
    throw new OpError(
      'InvalidOptions',
      `Compare text needs exactly 2 files — it was given ${inputs.length}.`,
    );
  }

  const format = validateChoice(options.format, FORMATS, 'html', 'format');
  const scope = validateChoice(options.scope, SCOPES, 'changes', 'scope');
  const context = validateNumber(options.context, 3, 0, 100, 'context');
  const ignoreWhitespace = validateBool(options.ignoreWhitespace, false, 'ignoreWhitespace');
  const ignoreCase = validateBool(options.ignoreCase, false, 'ignoreCase');
  // The editor's "Swap sides" button. It has to reach the op, or the report you
  // export would be the reverse of the one you were just looking at.
  const swap = validateBool(options.swap, false, 'swap');

  const [first, second] = inputs as [OpInput, OpInput];
  const left = swap ? second : first;
  const right = swap ? first : second;

  stop(ctx.signal);
  const aText = decodeText(left);
  ctx.onProgress(0.25);
  stop(ctx.signal);
  const bText = decodeText(right);
  ctx.onProgress(0.5);

  const result = diffLines(aText, bText, {
    ignoreWhitespace,
    ignoreCase,
    check: () => stop(ctx.signal),
  });
  ctx.onProgress(0.8);
  stop(ctx.signal);

  const effectiveContext = scope === 'whole' ? Number.POSITIVE_INFINITY : context;
  const name = `${stem(left.name)}-vs-${stem(right.name)}`;

  const output: OpOutput =
    format === 'unified'
      ? {
          name: `${name}.diff`,
          type: 'text/plain',
          buffer: toArrayBuffer(
            toUnified(result, {
              aName: left.name,
              bName: right.name,
              // A patch with unbounded context is a patch of the whole file,
              // which is what `scope: whole` asks for on this side too.
              context: scope === 'whole' ? Number.MAX_SAFE_INTEGER : context,
            }),
          ),
        }
      : {
          name: `${name}.html`,
          type: 'text/html',
          buffer: toArrayBuffer(
            reportHtml(
              result,
              collapseRows(toRows(result.blocks), effectiveContext),
              { a: left.name, b: right.name },
              { ignoreWhitespace, ignoreCase },
            ),
          ),
        };

  ctx.onProgress(1);
  return [output];
};

export default textDiff;
