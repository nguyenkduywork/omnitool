import { describe, expect, it } from 'vitest';

import { TOOLS, getTool } from '../../src/core/registry';
import { applicabilityFor, countReason, typesMatch } from '../../src/core/format';

describe('every tool declares a kind', () => {
  it('assigns exactly one kind to each of the 29 tools', () => {
    expect(TOOLS).toHaveLength(29);
    for (const tool of TOOLS) {
      expect(['transform', 'generate', 'utility']).toContain(tool.kind);
    }
  });

  it('has exactly one generator, and it accepts no files', () => {
    const generators = TOOLS.filter((t) => t.kind === 'generate');
    expect(generators.map((t) => t.id)).toEqual(['qr-generate']);
    expect(generators[0]?.accepts).toEqual([]);
    expect(generators[0]?.minInputs).toBe(0);
  });

  // The two must not drift: a utility IS a tool that takes any bytes.
  it('marks utility on exactly the seven tools accepting everything', () => {
    const utilities = TOOLS.filter((t) => t.kind === 'utility').map((t) => t.id).sort();
    const universal = TOOLS.filter((t) => t.accepts.includes('*')).map((t) => t.id).sort();

    expect(utilities).toEqual([
      'base64', 'file-join', 'file-split', 'gzip', 'hash', 'tar-create', 'zip-create',
    ]);
    expect(universal).toEqual(utilities);
  });

  it('leaves the remaining 21 as transforms, including the extractors', () => {
    expect(TOOLS.filter((t) => t.kind === 'transform')).toHaveLength(21);
    expect(getTool('zip-extract')?.kind).toBe('transform');
    expect(getTool('tar-extract')?.kind).toBe('transform');
  });
});

const PDF = 'application/pdf';

describe('countReason', () => {
  it('is null when the count fits', () => {
    expect(countReason(getTool('pdf-merge')!, 2)).toBeNull();
    expect(countReason(getTool('pdf-split')!, 1)).toBeNull();
  });

  it('names an exact requirement when min equals max', () => {
    expect(countReason(getTool('pdf-organize')!, 2)).toBe('Needs exactly 1 file — you have 2.');
  });

  it('names a minimum when there are too few', () => {
    expect(countReason(getTool('pdf-merge')!, 1)).toBe('Needs at least 2 files — you have 1.');
  });

  it('says "none" rather than "0"', () => {
    expect(countReason(getTool('pdf-merge')!, 0)).toBe('Needs at least 2 files — you have none.');
  });
});

describe('typesMatch — types only, count ignored', () => {
  it('accepts a count that would fail the range', () => {
    expect(typesMatch(getTool('pdf-organize')!, [PDF, PDF])).toBe(true);
  });

  it('rejects a foreign type', () => {
    expect(typesMatch(getTool('pdf-merge')!, [PDF, 'image/png'])).toBe(false);
  });

  it('honours the image/* wildcard', () => {
    expect(typesMatch(getTool('image-resize')!, ['image/png', 'image/jpeg'])).toBe(true);
  });
});

describe('applicabilityFor — the four buckets', () => {
  it('puts two PDFs into primary, blocks the one-file-only tool, and quiets the utilities', () => {
    const { primary, blocked, utility } = applicabilityFor(TOOLS, [PDF, PDF]);

    expect(primary.map((t) => t.id)).toContain('pdf-merge');
    expect(primary.map((t) => t.id)).not.toContain('pdf-organize');

    // The whole point of `blocked`: it is EXPLAINED, not silently absent.
    expect(blocked.map((b) => b.tool.id)).toContain('pdf-organize');
    expect(blocked.find((b) => b.tool.id === 'pdf-organize')?.reason).toBe(
      'Needs exactly 1 file — you have 2.',
    );

    expect(utility.map((t) => t.id)).toContain('hash');
    expect(primary.map((t) => t.id)).not.toContain('hash');
  });

  it('never lets a generator into any bucket, whatever is loaded', () => {
    for (const mimes of [[], [PDF], ['image/png', 'image/png']]) {
      const { primary, blocked, utility } = applicabilityFor(TOOLS, mimes);
      const all = [...primary, ...utility, ...blocked.map((b) => b.tool)];
      expect(all.map((t) => t.id)).not.toContain('qr-generate');
    }
  });

  // A utility failing only on COUNT stays absent rather than nagging.
  it('never puts a utility into blocked', () => {
    const { blocked } = applicabilityFor(TOOLS, [PDF]);
    expect(blocked.map((b) => b.tool.id)).not.toContain('file-join');
    expect(blocked.every((b) => b.tool.kind === 'transform')).toBe(true);
  });

  it('is empty in every bucket when nothing is loaded', () => {
    expect(applicabilityFor(TOOLS, [])).toEqual({ primary: [], blocked: [], utility: [] });
  });
});
