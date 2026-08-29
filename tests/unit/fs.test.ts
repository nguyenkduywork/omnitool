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
