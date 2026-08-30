import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { unzipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { download, downloadBundle, readFiles } from '../../src/core/fs';
import type { OpOutput } from '../../src/types';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

async function fixtureFile(onDisk: string, as = onDisk): Promise<File> {
  const buf = await readFile(path.join(FIXTURES, onDisk));
  return new File([buf], as);
}

function textOutput(name: string, body: string): OpOutput {
  const bytes = new TextEncoder().encode(body);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return { name, type: 'text/plain', buffer };
}

function binaryOutput(name: string, type: string, size: number): OpOutput {
  const buffer = new ArrayBuffer(size);
  const bytes = new Uint8Array(buffer);
  // Incompressible on purpose: this stands in for a PNG or JPEG, whose bytes
  // are already deflate output.
  for (let i = 0; i < size; i++) bytes[i] = (i * 2654435761) & 0xff;
  return { name, type, buffer };
}

/**
 * The compression method each entry was written with, read out of the zip's
 * local file headers: 0 = stored, 8 = deflated.
 * Layout per PK\x03\x04 record: method at +8, name length at +26, extra at +28.
 */
function compressionMethods(zipBytes: Uint8Array): Record<string, number> {
  const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  const found: Record<string, number> = {};
  for (let at = 0; at + 30 <= zipBytes.length; at++) {
    if (view.getUint32(at, true) !== 0x04034b50) continue;
    const method = view.getUint16(at + 8, true);
    const nameLength = view.getUint16(at + 26, true);
    const name = new TextDecoder().decode(zipBytes.subarray(at + 30, at + 30 + nameLength));
    found[name] = method;
  }
  return found;
}

/** Minimal stand-in for the two DOM touchpoints download() uses. */
function stubDom() {
  const clicked: { href: string; download: string }[] = [];
  const revoked: string[] = [];
  const anchors: { href: string; download: string; click: () => void; rel?: string }[] = [];
  const blobs = new Map<string, Blob>();
  let n = 0;

  vi.stubGlobal('document', {
    createElement: (tag: string) => {
      if (tag !== 'a') throw new Error(`unexpected element ${tag}`);
      const a = {
        href: '',
        download: '',
        click() {
          clicked.push({ href: a.href, download: a.download });
        },
      };
      anchors.push(a);
      return a;
    },
    body: { appendChild: () => undefined, removeChild: () => undefined },
  });
  vi.stubGlobal('URL', {
    createObjectURL: (b: Blob) => {
      const url = `blob:fake/${n++}`;
      blobs.set(url, b);
      return url;
    },
    revokeObjectURL: (url: string) => {
      revoked.push(url);
    },
  });

  return { clicked, revoked, blobs };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('readFiles', () => {
  it('turns File objects into OpInputs with sniffed types', async () => {
    const inputs = await readFiles([
      await fixtureFile('small.pdf'),
      await fixtureFile('a.png'),
    ]);

    expect(inputs.map((i) => i.name)).toEqual(['small.pdf', 'a.png']);
    expect(inputs.map((i) => i.type)).toEqual(['application/pdf', 'image/png']);
    expect(inputs[0]?.buffer.byteLength).toBeGreaterThan(0);
    expect(inputs[0]?.buffer).toBeInstanceOf(ArrayBuffer);
  });

  it('sniffs by content, not by the File name or the browser-reported type', async () => {
    const lying = await fixtureFile('small.pdf', 'photo.png');
    const [input] = await readFiles([lying]);

    expect(input?.type).toBe('application/pdf');
  });

  it('preserves tray order', async () => {
    const inputs = await readFiles([
      await fixtureFile('c.png'),
      await fixtureFile('a.png'),
      await fixtureFile('b.png'),
    ]);
    expect(inputs.map((i) => i.name)).toEqual(['c.png', 'a.png', 'b.png']);
  });
});

describe('download', () => {
  it('clicks an anchor carrying the output name', () => {
    const dom = stubDom();

    download(textOutput('hello.txt', 'hi'));

    expect(dom.clicked).toHaveLength(1);
    expect(dom.clicked[0]?.download).toBe('hello.txt');
  });

  it('releases the object URL after the download has started, not during it', () => {
    vi.useFakeTimers();
    try {
      const dom = stubDom();

      download(textOutput('hello.txt', 'hi'));
      expect(dom.revoked).toEqual([]);

      vi.advanceTimersByTime(5000);
      expect(dom.revoked).toEqual([dom.clicked[0]?.href]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('wraps the buffer in a Blob of the declared mime type', async () => {
    const dom = stubDom();

    download(textOutput('hello.txt', 'payload'));

    const blob = dom.blobs.get(dom.clicked[0]?.href ?? '');
    expect(blob?.type).toBe('text/plain');
    expect(await blob?.text()).toBe('payload');
  });
});

describe('downloadBundle', () => {
  it('produces a real zip holding every output', async () => {
    const dom = stubDom();

    await downloadBundle([textOutput('a.txt', 'AAA'), textOutput('b.txt', 'BBB')], 'outputs');

    expect(dom.clicked[0]?.download).toBe('outputs.zip');
    const blob = dom.blobs.get(dom.clicked[0]?.href ?? '');
    expect(blob).toBeDefined();
    const entries = unzipSync(new Uint8Array(await (blob as Blob).arrayBuffer()));
    expect(Object.keys(entries).sort()).toEqual(['a.txt', 'b.txt']);
    expect(new TextDecoder().decode(entries['a.txt'])).toBe('AAA');
  });

  it('stores already-compressed outputs and deflates the rest', async () => {
    const dom = stubDom();
    const compressible = 'id,name\n1,alpha\n'.repeat(500);

    await downloadBundle(
      [
        binaryOutput('shot.png', 'image/png', 64 * 1024),
        binaryOutput('photo.jpg', 'image/jpeg', 64 * 1024),
        binaryOutput('inner.zip', 'application/zip', 64 * 1024),
        textOutput('rows.csv', compressible),
        binaryOutput('doc.pdf', 'application/pdf', 64 * 1024),
      ],
      'mixed',
    );

    const blob = dom.blobs.get(dom.clicked[0]?.href ?? '');
    const zipBytes = new Uint8Array(await (blob as Blob).arrayBuffer());
    const methods = compressionMethods(zipBytes);

    // Deflating these again costs time and gains nothing — see fs.ts.
    expect(methods['shot.png']).toBe(0);
    expect(methods['photo.jpg']).toBe(0);
    expect(methods['inner.zip']).toBe(0);
    // ...while these are exactly where deflate pays for itself.
    expect(methods['rows.csv']).toBe(8);
    expect(methods['doc.pdf']).toBe(8);

    // Whatever the method, every entry must still come back byte-for-byte.
    const entries = unzipSync(zipBytes);
    expect(new TextDecoder().decode(entries['rows.csv'])).toBe(compressible);
    expect(entries['shot.png']?.length).toBe(64 * 1024);
  });

  it('does not double up the .zip suffix', async () => {
    const dom = stubDom();
    await downloadBundle([textOutput('a.txt', 'AAA')], 'bundle.zip');
    expect(dom.clicked[0]?.download).toBe('bundle.zip');
  });

  it('de-duplicates colliding entry names instead of silently dropping one', async () => {
    const dom = stubDom();

    await downloadBundle([textOutput('same.txt', 'first'), textOutput('same.txt', 'second')], 'dup');

    const blob = dom.blobs.get(dom.clicked[0]?.href ?? '');
    const entries = unzipSync(new Uint8Array(await (blob as Blob).arrayBuffer()));
    expect(Object.keys(entries)).toHaveLength(2);
  });
});
