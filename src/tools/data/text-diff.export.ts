// Shared, DOM-free serializers. Every output is capped before it is retained.

import {
  collapseRows,
  diffCharacters,
  diffWords,
  toRows,
  toUnifiedExact,
  type DiffOptions,
  type DiffResult,
  type SplitText,
  type WordSegment,
} from './diff';
import { alignedLineEndingsDiffer } from './text-diff.metadata';
import type { ComparisonIdentity } from './text-diff.model';

export const MAX_EXPORT_BYTES = 32 * 1024 * 1024;
export type ExportDetail = 'line' | 'word' | 'character';

export class TextDiffExportError extends Error {
  constructor(public readonly code: 'TooLarge', message: string) { super(message); this.name = 'TextDiffExportError'; }
}

/** Avoid a giant escaped/body string before the export-size decision. */
export class BoundedTextWriter {
  private readonly encoder = new TextEncoder();
  private readonly parts: string[] = [];
  private bytes = 0;
  write(text: string): void {
    for (let start = 0; start < text.length;) {
      let end = Math.min(text.length, start + 8192);
      if (end < text.length && /[\uD800-\uDBFF]/u.test(text.charAt(end - 1)) && /[\uDC00-\uDFFF]/u.test(text.charAt(end))) end--;
      if (end === start) end++;
      const part = text.slice(start, end);
      this.bytes += this.encoder.encode(part).byteLength;
      if (this.bytes > MAX_EXPORT_BYTES) throw new TextDiffExportError('TooLarge', `This export exceeds the ${MAX_EXPORT_BYTES} byte limit.`);
      this.parts.push(part);
      start = end;
    }
  }
  escaped(text: string): void {
    let buffered = '';
    const append = (part: string): void => {
      buffered += part;
      if (buffered.length >= 4096) { this.write(buffered); buffered = ''; }
    };
    let start = 0;
    for (let index = 0; index < text.length; index++) {
      const replacement = text[index] === '&' ? '&amp;' : text[index] === '<' ? '&lt;' : text[index] === '>' ? '&gt;' : text[index] === '"' ? '&quot;' : null;
      if (!replacement) continue;
      if (index > start) append(text.slice(start, index));
      append(replacement);
      start = index + 1;
    }
    if (start < text.length) append(text.slice(start));
    if (buffered) this.write(buffered);
  }
  finish(): string { return this.parts.join(''); }
}

/** A portable basename suitable for both sides of a git patch header. */
export function safePatchTarget(name: string): string {
  const devices = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
  return !/^[A-Za-z0-9._-]+$/.test(name) || name === '' || name === '.' || name === '..' || name.endsWith('.') || devices.test(name) ? 'comparison.txt' : name;
}

export function serializeExactPatch(rawA: string, rawB: string, options: { target: string; context: number }): string | null {
  if (rawA === rawB) return null;
  // The raw-record patch generator is bounded internally before joining.
  try {
    return toUnifiedExact(rawA, rawB, { aName: safePatchTarget(options.target), bName: safePatchTarget(options.target), context: options.context, maxBytes: MAX_EXPORT_BYTES });
  } catch (error) {
    if (error instanceof RangeError) throw new TextDiffExportError('TooLarge', error.message);
    throw error;
  }
}

function writeSegments(writer: BoundedTextWriter, segments: readonly WordSegment[]): void {
  for (const segment of segments) {
    if (segment.changed) writer.write('<mark>');
    writer.escaped(segment.text);
    if (segment.changed) writer.write('</mark>');
  }
}

const REPORT_CSS = `:root{color-scheme:light dark;--bg:#fff;--panel:#f6f7f9;--ink:#12161c;--quiet:#5b6570;--line:#dfe3e8;--add:#e7f6ec;--add-word:#b7e7c6;--del:#fdeceb;--del-word:#f7c3bf;--gap:#f1f3f5}@media(prefers-color-scheme:dark){:root{--bg:#0f1319;--panel:#161c25;--ink:#e9eef4;--quiet:#98a3b0;--line:#28313d;--add:#12301f;--add-word:#1f5a37;--del:#331a1a;--del-word:#6d2b28;--gap:#1a212b}}*{box-sizing:border-box}body{margin:0;padding:24px;background:var(--bg);color:var(--ink);font:14px/1.5 ui-sans-serif,system-ui,sans-serif}h1{font-size:17px;margin:0 0 4px}h1,.sub{overflow-wrap:anywhere}.sub,.meta{color:var(--quiet);font-size:13px;margin:0 0 12px}.stats{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 16px;padding:0;list-style:none}.stats li,.note{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:3px 10px;font-size:12px}.note{padding:10px 12px;margin:0 0 12px;font-size:13px}table{border-collapse:collapse;width:100%;table-layout:fixed;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;tab-size:4}col.num,td.num{width:6.5em}td{padding:1px 8px;vertical-align:top;white-space:pre-wrap;overflow-wrap:anywhere}td.num{color:var(--quiet);background:var(--panel);border-right:1px solid var(--line);user-select:none;white-space:nowrap}tr.insert td.code-b,tr.replace td.code-b{background:var(--add)}tr.delete td.code-a,tr.replace td.code-a{background:var(--del)}tr.insert td.code-a,tr.delete td.code-b,tr.gap td{background:var(--gap)}td.code-b mark{background:var(--add-word);color:inherit}td.code-a mark{background:var(--del-word);color:inherit}tr.gap td{color:var(--quiet);text-align:center;font-size:11px;padding:4px}@media(max-width:560px){body{padding:12px}table,tbody,tr,td{display:block;width:100%}colgroup{display:none}td.num{border:0;padding-top:6px}td.num::before{content:attr(data-side) ' ';font-family:ui-sans-serif,system-ui,sans-serif;font-size:11px}tr{border:1px solid var(--line);margin:0 0 10px}.gap td{display:block}}@media print{body{padding:0}.note{border-color:#777}tr{break-inside:avoid}}`;

function sourceMetadata(source: SplitText): string {
  const ending = source.ending === 'none' ? 'no line endings' : `${source.ending.toUpperCase()} line endings`;
  return `${ending}; ${source.hasBom ? 'BOM present' : 'no BOM'}; ${source.endsWithNewline ? 'final newline present' : 'no final newline'}`;
}

export function serializeHtmlReport(input: {
  result: DiffResult; names: { a: string; b: string }; options: DiffOptions & { ignoreWhitespace: boolean; ignoreCase: boolean };
  scope: 'changes' | 'whole'; context: number; detail?: ExportDetail; identity?: ComparisonIdentity;
  rawSources?: Readonly<{ a: string; b: string }>;
}): string {
  const writer = new BoundedTextWriter();
  const detail = input.detail ?? 'word';
  const rows = collapseRows(toRows(input.result.blocks), input.scope === 'whole' ? Infinity : input.context);
  const notes: string[] = [];
  const identity = input.identity;
  if (identity?.rawIdentical) notes.push('No differences: the two sources have identical contents.');
  else if (identity?.metadataOnlyDifference || (input.result.identicalLines && input.result.onlyEndingsDiffer)) notes.push('Display lines match; line endings or byte-order mark differ.');
  else if (identity?.normalizedIdentical) notes.push('No displayed changes under the active rules.');
  if (input.rawSources && alignedLineEndingsDiffer(input.result, input.rawSources.a, input.rawSources.b)) notes.push('Aligned line endings differ.');
  if (input.result.degraded) notes.push('A region is reported as a wholesale replacement because it exceeded the alignment budget.');
  if (input.options.ignoreWhitespace) notes.push('Whitespace changes were ignored in the review.');
  if (input.options.ignoreCase) notes.push('Letter case was ignored in the review.');
  writer.write(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>`); writer.escaped(input.names.a); writer.write(' vs '); writer.escaped(input.names.b); writer.write(`</title><style>${REPORT_CSS}</style></head><body><h1>`); writer.escaped(input.names.a); writer.write(` <span aria-hidden="true">&rarr;</span> `); writer.escaped(input.names.b); writer.write(`</h1><p class="sub">Original: `); writer.escaped(input.names.a); writer.write(` · Revised: `); writer.escaped(input.names.b); writer.write(`</p><p class="meta">${input.result.a.lines.length} original lines · ${input.result.b.lines.length} revised lines · ${input.scope === 'whole' ? 'Whole file' : `${input.context} lines context`} · ${detail} detail</p><ul class="stats"><li>${input.result.stats.added} added</li><li>${input.result.stats.removed} removed</li><li>${input.result.stats.changed} modified</li></ul>`);
  if (input.rawSources) writer.write(`<p class="meta">Original source: ${sourceMetadata(input.result.a)}<br>Revised source: ${sourceMetadata(input.result.b)}</p>`);
  for (const note of notes) { writer.write('<p class="note">'); writer.escaped(note); writer.write('</p>'); }
  writer.write('<table><colgroup><col class="num"><col><col class="num"><col></colgroup><tbody>');
  for (const row of rows) {
    if (row.kind === 'gap') { writer.write(`<tr class="gap"><td colspan="4">${row.count} unchanged lines</td></tr>`); continue; }
    const a = row.a === null ? null : (input.result.a.lines[row.a] ?? '');
    const b = row.b === null ? null : (input.result.b.lines[row.b] ?? '');
    const pair = row.kind === 'replace' && a !== null && b !== null ? detail === 'word' ? diffWords(a, b, input.options) : detail === 'character' ? diffCharacters(a, b, input.options) : null : null;
    writer.write(`<tr class="${row.kind}"><td class="num" data-side="Original">${row.a === null ? '' : row.a + 1}</td><td class="code-a">`);
    if (pair) writeSegments(writer, pair.a); else if (a !== null) writer.escaped(a);
    writer.write(`</td><td class="num" data-side="Revised">${row.b === null ? '' : row.b + 1}</td><td class="code-b">`);
    if (pair) writeSegments(writer, pair.b); else if (b !== null) writer.escaped(b);
    writer.write('</td></tr>');
  }
  writer.write('</tbody></table></body></html>');
  return writer.finish();
}

export function serializeChanges(input: {
  result: DiffResult; names: { a: string; b: string }; context: number; rules: { ignoreWhitespace: boolean; ignoreCase: boolean };
  scope?: 'changes' | 'whole'; identity?: ComparisonIdentity; rawSources?: Readonly<{ a: string; b: string }>;
}): string {
  const writer = new BoundedTextWriter();
  writer.write(`Changes: ${input.names.a} → ${input.names.b}\n`);
  if (input.rawSources) writer.write(`Original source: ${sourceMetadata(input.result.a)}\nRevised source: ${sourceMetadata(input.result.b)}\n`);
  if (input.rules.ignoreWhitespace || input.rules.ignoreCase) writer.write(`Active rules: ${[input.rules.ignoreWhitespace ? 'ignore whitespace' : '', input.rules.ignoreCase ? 'ignore case' : ''].filter(Boolean).join(', ')}\n`);
  if (input.identity?.metadataOnlyDifference) writer.write('Metadata-only difference: line endings or byte-order mark differ.\n');
  if (input.rawSources && alignedLineEndingsDiffer(input.result, input.rawSources.a, input.rawSources.b)) writer.write('Aligned line endings differ.\n');
  if (input.identity?.normalizedIdentical && !input.identity.rawIdentical) writer.write('No displayed changes under the active rules; raw sources still differ.\n');
  const rows = collapseRows(toRows(input.result.blocks), input.scope === 'whole' ? Infinity : input.context);
  if (input.result.stats.hunks === 0) { writer.write(input.identity?.rawIdentical ? 'No differences.\n' : 'No line changes.\n'); return writer.finish(); }
  for (const row of rows) {
    if (row.kind === 'gap') writer.write(`… ${row.count} unchanged lines …\n`);
    else if (row.kind === 'equal') writer.write(`  ${input.result.a.lines[row.a] ?? ''}\n`);
    else if (row.kind === 'delete') writer.write(`- ${input.result.a.lines[row.a] ?? ''}\n`);
    else if (row.kind === 'insert') writer.write(`+ ${input.result.b.lines[row.b] ?? ''}\n`);
    else { writer.write(`- ${input.result.a.lines[row.a] ?? ''}\n+ ${input.result.b.lines[row.b] ?? ''}\n`); }
  }
  return writer.finish();
}
