import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { accepts, label, sniffType } from '../../src/core/format';
import type { ToolDef } from '../../src/types';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

async function fixture(name: string): Promise<ArrayBuffer> {
  const buf = await readFile(path.join(FIXTURES, name));
  const out = new ArrayBuffer(buf.byteLength);
  new Uint8Array(out).set(buf);
  return out;
}

function tool(over: Partial<ToolDef> = {}): ToolDef {
  return {
    id: 't',
    name: 'T',
    blurb: '',
    group: 'pdf',
    accepts: ['application/pdf'],
    minInputs: 1,
    maxInputs: null,
    load: () => Promise.reject(new Error('not used')),
    ...over,
  };
}

describe('sniffType — magic bytes, never the extension', () => {
  it('detects each committed fixture from its bytes', async () => {
    expect(sniffType(await fixture('small.pdf'), 'small.pdf')).toBe('application/pdf');
    expect(sniffType(await fixture('corrupt.pdf'), 'corrupt.pdf')).toBe('application/pdf');
    expect(sniffType(await fixture('encrypted.pdf'), 'encrypted.pdf')).toBe('application/pdf');
    expect(sniffType(await fixture('a.png'), 'a.png')).toBe('image/png');
    expect(sniffType(await fixture('a.jpg'), 'a.jpg')).toBe('image/jpeg');
    expect(sniffType(await fixture('a.webp'), 'a.webp')).toBe('image/webp');
    expect(sniffType(await fixture('sample.zip'), 'sample.zip')).toBe('application/zip');
    expect(sniffType(await fixture('traversal.zip'), 'traversal.zip')).toBe('application/zip');
    expect(sniffType(await fixture('sample.tar'), 'sample.tar')).toBe('application/x-tar');
    expect(sniffType(await fixture('pax.tar'), 'pax.tar')).toBe('application/x-tar');
    expect(sniffType(await fixture('sample.tar.gz'), 'sample.tar.gz')).toBe('application/gzip');
  });

  // TAR's magic is 257 bytes in, further than any other signature here, so
  // this is also a test that sniffing reads a wide enough window.
  it('finds the ustar magic at offset 257, whatever the file is called', async () => {
    expect(sniffType(await fixture('sample.tar'), 'holiday.png')).toBe('application/x-tar');
  });

  it('falls back to the extension for a tar with no ustar magic (old v7 archives)', () => {
    const notTarBytes = new TextEncoder().encode('this has no ustar magic').buffer;
    expect(sniffType(notTarBytes, 'old.tar')).toBe('application/x-tar');
    expect(sniffType(notTarBytes, 'bundle.tgz')).toBe('application/gzip');
  });

  // REQUIREMENT 5: magic-byte sniffing, never extension-first.
  it('a PDF named photo.png is still application/pdf', async () => {
    expect(sniffType(await fixture('small.pdf'), 'photo.png')).toBe('application/pdf');
  });

  it('a PNG named report.pdf is still image/png', async () => {
    expect(sniffType(await fixture('a.png'), 'report.pdf')).toBe('image/png');
  });

  it('recognises GIF and AVIF headers', () => {
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0]);
    expect(sniffType(gif.buffer, 'x.bin')).toBe('image/gif');

    const avif = new Uint8Array(16);
    avif.set([0, 0, 0, 0x20], 0);
    avif.set([...'ftypavif'].map((c) => c.charCodeAt(0)), 4);
    expect(sniffType(avif.buffer, 'x.bin')).toBe('image/avif');
  });

  it('falls back to the extension when there are no magic bytes', async () => {
    expect(sniffType(await fixture('sample.csv'), 'sample.csv')).toBe('text/csv');
    expect(sniffType(new ArrayBuffer(0), 'notes.txt')).toBe('text/plain');
    expect(sniffType(new ArrayBuffer(0), 'data.JSON')).toBe('application/json');
  });

  it('falls back to application/octet-stream when nothing matches', () => {
    expect(sniffType(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer, 'mystery.qqq')).toBe(
      'application/octet-stream',
    );
    expect(sniffType(new ArrayBuffer(0), 'noextension')).toBe('application/octet-stream');
  });
});

describe('label', () => {
  it('gives human names for known mimes', () => {
    expect(label('application/pdf')).toBe('PDF document');
    expect(label('image/png')).toBe('PNG image');
    expect(label('image/jpeg')).toBe('JPEG image');
    expect(label('application/zip')).toBe('ZIP archive');
    expect(label('application/x-tar')).toBe('TAR archive');
    expect(label('application/gzip')).toBe('Gzip file');
    expect(label('text/csv')).toBe('CSV data');
  });

  it('degrades gracefully for unknown mimes', () => {
    expect(label('application/octet-stream')).toBe('Unknown file');
    expect(label('image/heic')).toBe('HEIC image');
    expect(label('audio/ogg')).toBe('OGG file');
  });
});

describe('accepts', () => {
  it('matches exact mimes', () => {
    expect(accepts(tool(), ['application/pdf'])).toBe(true);
    expect(accepts(tool(), ['image/png'])).toBe(false);
  });

  it("honours the 'image/*' wildcard", () => {
    const t = tool({ accepts: ['image/*'] });
    expect(accepts(t, ['image/png', 'image/webp'])).toBe(true);
    expect(accepts(t, ['image/png', 'application/pdf'])).toBe(false);
  });

  it("honours the '*' wildcard", () => {
    const t = tool({ accepts: ['*'] });
    expect(accepts(t, ['application/octet-stream', 'application/pdf'])).toBe(true);
  });

  it('requires every input to match, not just one', () => {
    const t = tool({ accepts: ['application/pdf'] });
    expect(accepts(t, ['application/pdf', 'application/pdf'])).toBe(true);
    expect(accepts(t, ['application/pdf', 'text/csv'])).toBe(false);
  });

  it('respects minInputs and maxInputs', () => {
    const twoOrMore = tool({ minInputs: 2, maxInputs: null });
    expect(accepts(twoOrMore, ['application/pdf'])).toBe(false);
    expect(accepts(twoOrMore, ['application/pdf', 'application/pdf'])).toBe(true);

    const exactlyOne = tool({ minInputs: 1, maxInputs: 1 });
    expect(accepts(exactlyOne, ['application/pdf'])).toBe(true);
    expect(accepts(exactlyOne, ['application/pdf', 'application/pdf'])).toBe(false);
  });

  it('a zero-input tool accepts an empty selection', () => {
    expect(accepts(tool({ minInputs: 0, accepts: ['*'] }), [])).toBe(true);
    expect(accepts(tool({ minInputs: 1 }), [])).toBe(false);
  });
});
