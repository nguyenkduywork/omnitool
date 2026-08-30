import { describe, expect, it } from 'vitest';

import { TOOLS, getTool } from '../../src/core/registry';

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
