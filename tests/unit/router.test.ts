// tests/unit/router.test.ts — the pure parse/serialise half of the router.
//
// `toolIdFromHash` and `hashForTool` touch no DOM, so they run here under
// plain Node. `createRouter` itself is DOM-bound (location, hashchange) and
// is exercised for real in router.browser.test.ts.

import { describe, expect, it } from 'vitest';

import { hashForTool, toolIdFromHash } from '../../src/ui/router';

describe('toolIdFromHash', () => {
  it('reads a tool id', () => {
    expect(toolIdFromHash('#/merge-pdfs')).toBe('merge-pdfs');
    expect(toolIdFromHash('#/qr-generate')).toBe('qr-generate');
  });

  it('treats the root and an empty hash as the catalogue', () => {
    expect(toolIdFromHash('#/')).toBeNull();
    expect(toolIdFromHash('#')).toBeNull();
    expect(toolIdFromHash('')).toBeNull();
  });

  it('ignores a trailing slash and decodes percent-escapes', () => {
    expect(toolIdFromHash('#/merge-pdfs/')).toBe('merge-pdfs');
    expect(toolIdFromHash('#/csv%2Djson')).toBe('csv-json');
  });

  it('rejects a nested path rather than guessing', () => {
    expect(toolIdFromHash('#/merge-pdfs/extra')).toBeNull();
  });

  it('falls back to the catalogue on a malformed percent-escape rather than throwing', () => {
    // A truncated multi-byte escape: decodeURIComponent throws URIError on
    // this. A router that let that throw escape would crash the app on a
    // bad deep link instead of just showing the catalogue.
    expect(() => toolIdFromHash('#/%E0%A4%A')).not.toThrow();
    expect(toolIdFromHash('#/%E0%A4%A')).toBeNull();
  });
});

describe('hashForTool', () => {
  it('round-trips every shape', () => {
    expect(hashForTool('merge-pdfs')).toBe('#/merge-pdfs');
    expect(hashForTool(null)).toBe('#/');
    expect(toolIdFromHash(hashForTool('qr-generate'))).toBe('qr-generate');
  });

  it('percent-encodes a tool id, so hashForTool and toolIdFromHash agree', () => {
    // Not a real tool id in this app, but the pair must still round-trip
    // for anything hashForTool is willing to produce a hash for.
    expect(hashForTool('a b')).toBe('#/a%20b');
    expect(toolIdFromHash(hashForTool('a b'))).toBe('a b');
  });
});
