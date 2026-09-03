import { describe, expect, it } from 'vitest';

import { TOOLS, getTool } from '../../src/core/registry';
import { applicabilityFor, countReason, typesMatch } from '../../src/core/format';
import type { ToolDef } from '../../src/types';

describe('every tool declares a kind', () => {
  it('assigns exactly one kind to each of the 30 tools', () => {
    expect(TOOLS).toHaveLength(30);
    for (const tool of TOOLS) {
      expect(['transform', 'generate', 'utility']).toContain(tool.kind);
    }
  });

  it('has exactly one generator, and it accepts no files', () => {
    const generators = TOOLS.filter((t) => t.kind === 'generate');
    expect(generators.map((t) => t.id)).toEqual(['qr-generate']);
    expect(generators[0]?.accepts).toEqual([]);
    expect(generators[0]?.minInputs).toBe(0);
    // Pinned too: a generator takes NO files, so the ceiling matters as much
    // as the floor. Reverting this to `null` would let `shell.ts`'s run path
    // hand a generator every loaded file again — the bug that made running
    // the QR tool read a 64 KB PDF it never looks at.
    expect(generators[0]?.maxInputs).toBe(0);
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

  // `renderOptions` only threads `presetValues`/`presetBecause` into the
  // DECLARATIVE schema path; the bespoke-`editor` branch (crop box, page
  // board) ignores them, because an editor derives its options from the files
  // itself. That is fine while no tool declares both — but it fails SILENTLY,
  // dropping the preset with no error. So the invariant is asserted here
  // instead: adding a tool with both makes this red, forcing a decision about
  // what should happen rather than letting the preset quietly vanish.
  it('never declares both a bespoke editor and a preset on the same tool', () => {
    const both = TOOLS.filter((tool) => tool.editor && tool.preset).map((tool) => tool.id);
    expect(both).toEqual([]);
  });

  it('leaves the remaining 22 as transforms, including the extractors', () => {
    expect(TOOLS.filter((t) => t.kind === 'transform')).toHaveLength(22);
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

  // The "Takes at most N" branch is unreachable through the registry: every
  // real tool has min === max or max === null, so no fixture can exercise it.
  // It is still live code the moment anyone adds a bounded-range tool, so it
  // gets a synthetic ToolDef rather than staying the one untested branch.
  describe('a bounded range with min < max — no such tool exists yet', () => {
    const ranged = (minInputs: number, maxInputs: number): ToolDef => ({
      id: 'ranged',
      name: 'Ranged',
      blurb: '',
      group: 'data',
      kind: 'transform',
      accepts: ['*'],
      minInputs,
      maxInputs,
      load: () => Promise.reject(new Error('not used')),
    });

    it('names the ceiling when there are too many', () => {
      expect(countReason(ranged(2, 4), 5)).toBe('Takes at most 4 files — you have 5.');
    });

    it('says "file" singular when the ceiling is 1', () => {
      expect(countReason(ranged(0, 1), 2)).toBe('Takes at most 1 file — you have 2.');
    });

    it('still reports the floor when there are too few', () => {
      expect(countReason(ranged(2, 4), 1)).toBe('Needs at least 2 files — you have 1.');
    });

    it('is null anywhere inside the range, including both ends', () => {
      expect(countReason(ranged(2, 4), 2)).toBeNull();
      expect(countReason(ranged(2, 4), 3)).toBeNull();
      expect(countReason(ranged(2, 4), 4)).toBeNull();
    });
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
