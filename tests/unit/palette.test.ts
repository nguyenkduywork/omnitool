// tests/unit/palette.test.ts — the DOM-free half of the command palette.
//
// `fuzzyScore` and `searchTools` are pure functions with no DOM dependency,
// so they are tested here under Node. The dialog itself (keyboard nav, focus
// trap, Escape/focus-restore) is real-DOM behaviour, tested against a real
// browser in palette.browser.test.ts.

import { describe, expect, it } from 'vitest';

import { fuzzyScore, searchTools, type SearchableTool } from '../../src/ui/palette';

describe('fuzzyScore', () => {
  it('matches an empty query against anything, with score 0', () => {
    expect(fuzzyScore('', 'Merge PDFs')).toBe(0);
    expect(fuzzyScore('   ', 'Merge PDFs')).toBe(0);
  });

  it('returns null when the text does not contain the query at all', () => {
    expect(fuzzyScore('xyz', 'Merge PDFs')).toBeNull();
    expect(fuzzyScore('zzz', '')).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(fuzzyScore('PDF', 'merge pdfs')).not.toBeNull();
    expect(fuzzyScore('pdf', 'Merge PDFs')).not.toBeNull();
  });

  it('ranks an exact PREFIX match above a plain SUBSTRING match', () => {
    const prefix = fuzzyScore('pdf', 'PDF merge')!;
    const substring = fuzzyScore('pdf', 'Merge PDF files')!;
    expect(prefix).not.toBeNull();
    expect(substring).not.toBeNull();
    expect(prefix).toBeGreaterThan(substring);
  });

  it('ranks a plain SUBSTRING match above a SCATTERED subsequence match', () => {
    const substring = fuzzyScore('pdf', 'Merge PDF files')!;
    // "pdf" as a scattered subsequence: p...d...f, never contiguous.
    const scattered = fuzzyScore('pdf', 'Pack, then Download the File')!;
    expect(substring).not.toBeNull();
    expect(scattered).not.toBeNull();
    expect(substring).toBeGreaterThan(scattered);
  });

  it('still ranks prefix above scattered, transitively', () => {
    const prefix = fuzzyScore('pdf', 'PDF merge')!;
    const scattered = fuzzyScore('pdf', 'Pack, then Download the File')!;
    expect(prefix).toBeGreaterThan(scattered);
  });

  it('within the substring tier, an earlier occurrence ranks higher', () => {
    // Neither starts with "zip" — both are non-prefix substring matches, so
    // this isolates the tie-break WITHIN the substring tier.
    const early = fuzzyScore('zip', 'the zip file')!;
    const late = fuzzyScore('zip', 'download this here zip')!;
    expect(early).toBeGreaterThan(late);
  });

  it('within the prefix tier, a tighter (shorter) target ranks higher', () => {
    const tight = fuzzyScore('zip', 'zip files')!;
    const loose = fuzzyScore('zip', 'zip files into one archive, compressed')!;
    expect(tight).toBeGreaterThan(loose);
  });

  it('within the subsequence tier, a tighter spread ranks higher', () => {
    // "hsh" as a subsequence of "hash" (spread 1..3=3 chars) vs a target
    // where the same letters are spread much further apart.
    const tight = fuzzyScore('hsh', 'hash')!;
    const loose = fuzzyScore('hsh', 'h... a long way later ... s ... and further still ... h')!;
    expect(tight).not.toBeNull();
    expect(loose).not.toBeNull();
    expect(tight).toBeGreaterThan(loose);
  });
});

describe('searchTools', () => {
  const tools: SearchableTool[] = [
    { name: 'Merge PDFs', blurb: 'Combine several PDFs into one, in tray order.' },
    { name: 'Split PDF', blurb: 'One file per page, or one file per page range.' },
    { name: 'Convert image', blurb: 'PNG, JPEG, WebP and AVIF, back and forth.' },
    { name: 'Hash', blurb: 'SHA-256, SHA-1, SHA-512 or MD5 of a file.' },
    { name: 'Zip files', blurb: 'Bundle files into a single .zip archive.' },
  ];

  it('returns every tool, in original order, for an empty query', () => {
    expect(searchTools(tools, '')).toEqual(tools);
    expect(searchTools(tools, '   ')).toEqual(tools);
  });

  it('filters out tools that match neither the name nor the blurb', () => {
    const hits = searchTools(tools, 'nonexistentquery');
    expect(hits).toEqual([]);
  });

  it('matches on the name', () => {
    const hits = searchTools(tools, 'hash');
    expect(hits.map((t) => t.name)).toEqual(['Hash']);
  });

  it('matches on the blurb when the name does not match', () => {
    const hits = searchTools(tools, 'archive');
    expect(hits.map((t) => t.name)).toEqual(['Zip files']);
  });

  it('ranks a NAME match above a tool that only matches in its blurb', () => {
    // "pdf" is in the NAME of the first two tools, and nowhere near the name
    // for anything else, but IS present (as "PDFs"/"PDF") only in those blurbs
    // too. Add a tool that mentions "pdf" in its blurb only, to prove name
    // beats blurb-only.
    const withBlurbOnly: SearchableTool[] = [
      ...tools,
      { name: 'Extract text', blurb: "Pull text out of a pdf's pages." },
    ];
    const hits = searchTools(withBlurbOnly, 'pdf');
    expect(hits[0]?.name).toBe('Merge PDFs');
    expect(hits.map((t) => t.name)).toContain('Extract text');
    expect(hits.map((t) => t.name).indexOf('Extract text')).toBeGreaterThan(
      hits.map((t) => t.name).indexOf('Merge PDFs'),
    );
  });

  it('is case-insensitive over both fields', () => {
    expect(searchTools(tools, 'ZIP').map((t) => t.name)).toContain('Zip files');
    expect(searchTools(tools, 'sha-256').map((t) => t.name)).toContain('Hash');
  });
});
