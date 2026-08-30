// src/tools/pdf/page-range.ts — parsing 1-based page-range specs.
//
// Its own module rather than a member of split.op.ts so that any tool needing
// page selection can import it WITHOUT dragging pdf-lib into its bundle chunk.
// Pure, DOM-free, and covered by its own tests.

import { OpError } from '../../types';

/** Human-facing label for one parsed group, used in output filenames. */
export type PageRangeGroup = { label: string; pages: number[] };

/**
 * Parse a 1-based page-range spec into groups of 0-based page indices.
 *
 * Accepted token forms: `N`, `N-M`, `N-` (N to the last page). Groups are
 * separated by commas. Whitespace around tokens is ignored.
 *
 * Anything else — an empty spec, an empty group, a non-integer, a zero or
 * negative page, a reversed range, or a page beyond `pageCount` — raises
 * `OpError('InvalidOptions', ...)`.
 */
export function parsePageRanges(spec: string, pageCount: number): PageRangeGroup[] {
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    throw new OpError('InvalidOptions', `Page count must be a positive integer, got ${String(pageCount)}`);
  }
  const trimmed = spec.trim();
  if (trimmed === '') {
    throw new OpError('InvalidOptions', 'Page ranges are empty — enter something like "1-3,7,9-"');
  }

  const groups: PageRangeGroup[] = [];
  for (const raw of trimmed.split(',')) {
    const token = raw.trim();
    if (token === '') {
      throw new OpError('InvalidOptions', `Empty page range in "${spec}" — remove the stray comma`);
    }

    const match = /^(\d+)(-(\d+)?)?$/.exec(token);
    if (!match) {
      throw new OpError('InvalidOptions', `"${token}" is not a page range — use forms like "4", "1-3" or "9-"`);
    }

    const startText = match[1] ?? '';
    const start = Number(startText);
    const hasDash = match[2] !== undefined;
    const endText = match[3];
    const end = hasDash ? (endText === undefined ? pageCount : Number(endText)) : start;

    if (start < 1) {
      throw new OpError('InvalidOptions', `Pages are numbered from 1, so "${token}" is out of range`);
    }
    if (end < start) {
      throw new OpError('InvalidOptions', `"${token}" runs backwards — the end page must not precede the start`);
    }
    if (start > pageCount || end > pageCount) {
      throw new OpError('InvalidOptions', `"${token}" is beyond the last page (${pageCount})`);
    }

    const pages: number[] = [];
    for (let page = start; page <= end; page++) pages.push(page - 1);
    groups.push({ label: start === end ? `${start}` : `${start}-${end}`, pages });
  }
  return groups;
}
