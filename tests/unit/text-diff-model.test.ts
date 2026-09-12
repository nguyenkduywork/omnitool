import { describe, expect, it } from 'vitest';

import {
  comparisonIdentity,
  createComparisonSnapshot,
  TextDiffModelError,
  validateComparisonSnapshot,
} from '../../src/tools/data/text-diff.model';

const source = (text: string, origin: 'file' | 'text' | 'empty' = 'text') => ({
  text,
  name: origin === 'file' ? 'source.txt' : 'pasted text',
  origin,
});

describe('ComparisonSnapshot', () => {
  it('distinguishes explicit empty sources from a missing source state', () => {
    const snapshot = createComparisonSnapshot({
      revision: 2,
      sources: [source('', 'empty'), source('', 'empty')],
      rules: { ignoreWhitespace: false, ignoreCase: false },
    });
    expect(snapshot.sources.map((item) => item.provided)).toEqual([true, true]);
    expect(comparisonIdentity(snapshot)).toMatchObject({ rawIdentical: true, normalizedIdentical: true });
  });

  it('recomputes byte metadata and records separate raw, exact-line, and rule identity', () => {
    const snapshot = validateComparisonSnapshot({
      schemaVersion: 1,
      revision: 3,
      sources: [
        { provided: true, ...source('Alpha\r\n', 'file'), byteLength: 0 },
        { provided: true, ...source(' alpha\n'), byteLength: 1 },
      ],
      rules: { ignoreWhitespace: true, ignoreCase: true },
    });
    expect(snapshot.sources[0].byteLength).toBe(7);
    expect(comparisonIdentity(snapshot)).toEqual({
      rawIdentical: false,
      exactDisplayLinesIdentical: false,
      normalizedIdentical: true,
      metadataOnlyDifference: false,
    });
  });

  it('labels BOM/terminator-only changes as metadata-only differences', () => {
    const snapshot = createComparisonSnapshot({
      revision: 1,
      sources: [source('\ufeffsame\r\n'), source('same\n')],
      rules: { ignoreWhitespace: false, ignoreCase: false },
    });
    expect(comparisonIdentity(snapshot)).toMatchObject({ metadataOnlyDifference: true });
  });

  it('rejects a final unpaired high surrogate', () => {
    expect(() =>
      createComparisonSnapshot({
        revision: 0,
        sources: [source('ok'), source('broken\ud800')],
        rules: { ignoreWhitespace: false, ignoreCase: false },
      }),
    ).toThrow(TextDiffModelError);
  });

  it('enforces decoded byte and display-line limits', () => {
    expect(() =>
      createComparisonSnapshot({
        revision: 0,
        sources: [source('x'.repeat(10 * 1024 * 1024 + 1)), source('')],
        rules: { ignoreWhitespace: false, ignoreCase: false },
      }),
    ).toThrow(TextDiffModelError);
    expect(() =>
      createComparisonSnapshot({
        revision: 0,
        sources: [source(`${'x\n'.repeat(200_000)}x`), source('')],
        rules: { ignoreWhitespace: false, ignoreCase: false },
      }),
    ).toThrow(TextDiffModelError);
  });
});
