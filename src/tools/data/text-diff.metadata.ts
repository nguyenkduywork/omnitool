// Raw source metadata shared by the preview index and DOM-free serializers.
import type { DiffResult } from './diff';

export type RawLine = Readonly<{ start: number; end: number; terminatorEnd: number; terminator: string }>;

/** Records retain the physical CR/LF choice and initial BOM offset. */
export function rawLineRecords(text: string): readonly RawLine[] {
  if (text === '') return [];
  const out: RawLine[] = [];
  let start = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let cursor = start;
  while (cursor < text.length) {
    const code = text.charCodeAt(cursor);
    if (code !== 10 && code !== 13) {
      cursor++;
      continue;
    }
    const end = cursor;
    const crlf = code === 13 && text.charCodeAt(cursor + 1) === 10;
    const terminatorEnd = cursor + (crlf ? 2 : 1);
    out.push({ start, end, terminatorEnd, terminator: crlf ? '\r\n' : code === 13 ? '\r' : '\n' });
    start = terminatorEnd;
    cursor = terminatorEnd;
  }
  if (start < text.length) out.push({ start, end: text.length, terminatorEnd: text.length, terminator: '' });
  return out;
}

/** Only paired, aligned lines support a claim that their terminators changed. */
export function alignedLineEndingsDiffer(result: DiffResult, rawA: string, rawB: string): boolean {
  const a = rawLineRecords(rawA);
  const b = rawLineRecords(rawB);
  for (const block of result.blocks) {
    if (block.kind !== 'equal' && block.kind !== 'replace') continue;
    const paired = Math.min(block.aCount, block.bCount);
    for (let offset = 0; offset < paired; offset++) {
      if (a[block.aStart + offset]?.terminator !== b[block.bStart + offset]?.terminator) return true;
    }
  }
  return false;
}
