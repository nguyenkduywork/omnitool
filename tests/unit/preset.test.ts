import { describe, expect, it } from 'vitest';

import { getTool } from '../../src/core/registry';
import type { SniffedFile } from '../../src/types';

function file(name: string, type: string, size = 1024): SniffedFile {
  return { name, size, type };
}

function preset(id: string, files: SniffedFile[]) {
  const fn = getTool(id)?.preset;
  if (!fn) throw new Error(`${id} declares no preset`);
  return fn(files);
}

describe('gzip preset — direction from the signature', () => {
  it('preselects decompress for a real gzip, and says why', () => {
    const { values, because } = preset('gzip', [file('a.tar.gz', 'application/gzip')]);
    expect(values.direction).toBe('decode');
    expect(because.direction).toBe("from the file's gzip signature");
  });

  it('leaves compress unstated for anything else', () => {
    const { values, because } = preset('gzip', [file('a.pdf', 'application/pdf')]);
    expect(values.direction).toBe('encode');
    expect(because.direction).toBeUndefined();
  });
});

describe('base64 preset — direction from the extension', () => {
  it('preselects decode for .b64 and .base64', () => {
    for (const name of ['payload.b64', 'payload.base64', 'PAYLOAD.B64']) {
      const { values, because } = preset('base64', [file(name, 'text/plain')]);
      expect(values.direction).toBe('decode');
      expect(because.direction).toBe('from the file extension');
    }
  });

  it('leaves encode unstated otherwise', () => {
    const { values, because } = preset('base64', [file('notes.txt', 'text/plain')]);
    expect(values.direction).toBe('encode');
    expect(because.direction).toBeUndefined();
  });
});

describe('csv-json preset — admits when it cannot tell', () => {
  it('preselects csv-to-json for a real CSV', () => {
    const { values, because } = preset('csv-json', [file('people.csv', 'text/csv')]);
    expect(values.direction).toBe('csv-to-json');
    expect(because.direction).toBe('from the .csv file');
  });

  it('preselects json-to-csv for real JSON', () => {
    const { values, because } = preset('csv-json', [file('p.json', 'application/json')]);
    expect(values.direction).toBe('json-to-csv');
    expect(because.direction).toBe('from the .json file');
  });

  // The honest case: text/plain carries no signal, so it must not guess.
  it('sets nothing on plain text and says so', () => {
    const { values, because } = preset('csv-json', [file('data.txt', 'text/plain')]);
    expect(values.direction).toBeUndefined();
    expect(because.direction).toBe("couldn't tell from the file — pick a direction");
  });
});

describe('archive-name presets', () => {
  it('names a zip after the first file, without its extension', () => {
    const { values, because } = preset('zip-create', [
      file('holiday-photos.png', 'image/png'),
      file('b.png', 'image/png'),
    ]);
    expect(values.name).toBe('holiday-photos');
    expect(because.name).toBe('from the first file');
  });

  it('does the same for tar', () => {
    expect(preset('tar-create', [file('report.pdf', 'application/pdf')]).values.name).toBe('report');
  });

  it('falls back to "archive" when there are no files', () => {
    const { values, because } = preset('zip-create', []);
    expect(values.name).toBe('archive');
    expect(because.name).toBeUndefined();
  });

  it('keeps a dotless name whole', () => {
    expect(preset('zip-create', [file('Makefile', 'text/plain')]).values.name).toBe('Makefile');
  });
});
