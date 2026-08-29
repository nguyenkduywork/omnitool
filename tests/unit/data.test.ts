// tests/unit/data.test.ts
//
// Task 5 — data and text tools. Covers zip-create, zip-extract, hash, base64,
// csv-json, json-format, qr-generate (SVG path only; the PNG/OffscreenCanvas
// path lives in tests/unit/data-qr.browser.test.ts, run under real Chromium).
//
// Every op gets, at minimum, the four tests required by plan §2:
//   1. happy path
//   2. invalid/corrupt input raising the correct OpErrorCode
//   3. cancellation part-way through via AbortSignal
//   4. onProgress monotonically non-decreasing, ending at exactly 1

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { OpError } from '../../src/types';
import type { OpContext, OpInput } from '../../src/types';

import zipCreate from '../../src/tools/data/zip-create.op';
import zipExtract from '../../src/tools/data/zip-extract.op';
import hash from '../../src/tools/data/hash.op';
import base64 from '../../src/tools/data/base64.op';
import csvJson from '../../src/tools/data/csv-json.op';
import jsonFormat from '../../src/tools/data/json-format.op';
import qrGenerate from '../../src/tools/data/qr.op';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');

function loadFixture(name: string, type = 'application/octet-stream'): OpInput {
  const buf = readFileSync(path.join(FIXTURES_DIR, name));
  const buffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return { name, type, buffer };
}

function textInput(name: string, text: string, type = 'text/plain'): OpInput {
  const buffer = new TextEncoder().encode(text).buffer;
  return { name, type, buffer };
}

function bufferToText(buffer: ArrayBuffer): string {
  return new TextDecoder().decode(buffer);
}

/** A recording OpContext. Progress values land in `progress`. */
function makeCtx(signal = new AbortController().signal): OpContext & { progress: number[] } {
  const progress: number[] = [];
  return {
    signal,
    progress,
    onProgress(fraction: number) {
      progress.push(fraction);
    },
  };
}

function assertMonotonicEndingAtOne(progress: number[]): void {
  expect(progress.length).toBeGreaterThan(0);
  for (let i = 1; i < progress.length; i++) {
    expect(progress[i]).toBeGreaterThanOrEqual(progress[i - 1] as number);
  }
  expect(progress[progress.length - 1]).toBe(1);
}

async function expectOpError(promise: Promise<unknown>, code: string): Promise<OpError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(OpError);
    expect((e as OpError).code).toBe(code);
    return e as OpError;
  }
  throw new Error('expected promise to reject with an OpError, but it resolved');
}

// ---------------------------------------------------------------------------
// zip-create
// ---------------------------------------------------------------------------

describe('zip-create', () => {
  it('bundles multiple inputs into one valid zip (happy path)', async () => {
    const inputs = [textInput('a.txt', 'hello a'), textInput('b.txt', 'hello b')];
    const ctx = makeCtx();

    const outputs = await zipCreate(inputs, { name: 'bundle', level: 6 }, ctx);

    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.name).toBe('bundle.zip');
    expect(outputs[0]?.type).toBe('application/zip');

    // Round-trip through zip-extract to prove it is a real, valid archive.
    const extracted = await zipExtract(outputs, {}, makeCtx());
    const byName = new Map(extracted.map((o) => [o.name, bufferToText(o.buffer)]));
    expect(byName.get('a.txt')).toBe('hello a');
    expect(byName.get('b.txt')).toBe('hello b');
  });

  it('rejects an out-of-range compression level with InvalidOptions', async () => {
    const inputs = [textInput('a.txt', 'x')];
    await expectOpError(zipCreate(inputs, { level: 42 }, makeCtx()), 'InvalidOptions');
  });

  it('cancels part-way through via AbortSignal', async () => {
    const controller = new AbortController();
    const inputs = [textInput('a.txt', 'x'), textInput('b.txt', 'y'), textInput('c.txt', 'z')];
    const ctx = makeCtx(controller.signal);
    const originalOnProgress = ctx.onProgress.bind(ctx);
    ctx.onProgress = (fraction: number) => {
      originalOnProgress(fraction);
      if (fraction >= 1 / inputs.length) controller.abort();
    };

    await expectOpError(zipCreate(inputs, {}, ctx), 'Cancelled');
  });

  it('reports monotonic progress ending at 1', async () => {
    const inputs = [textInput('a.txt', 'x'), textInput('b.txt', 'y')];
    const ctx = makeCtx();
    await zipCreate(inputs, {}, ctx);
    assertMonotonicEndingAtOne(ctx.progress);
  });
});

// ---------------------------------------------------------------------------
// zip-extract
// ---------------------------------------------------------------------------

describe('zip-extract', () => {
  it('extracts every entry from a real zip (happy path)', async () => {
    const outputs = await zipExtract([loadFixture('sample.zip', 'application/zip')], {}, makeCtx());
    const byName = new Map(outputs.map((o) => [o.name, bufferToText(o.buffer)]));
    expect(byName.get('hello.txt')).toBe('hello from omnitool\n');
    expect(byName.get('dir/nested.txt')).toBe('nested file contents\n');
  });

  it('neutralises path traversal in traversal.zip so nothing escapes the extraction root', async () => {
    const outputs = await zipExtract([loadFixture('traversal.zip', 'application/zip')], {}, makeCtx());

    // The fixture genuinely contains an entry literally named "../evil.txt".
    expect(outputs.some((o) => o.name === '../evil.txt')).toBe(false);
    for (const o of outputs) {
      expect(o.name.startsWith('/')).toBe(false);
      expect(o.name.split('/')).not.toContain('..');
      expect(/^[a-zA-Z]:/.test(o.name)).toBe(false);
    }

    const byName = new Map(outputs.map((o) => [o.name, bufferToText(o.buffer)]));
    expect(byName.get('ok.txt')).toBe('this one is fine\n');
    // The traversal entry survives extraction, but sanitised to a safe, root-relative name.
    expect(byName.get('evil.txt')).toBe('if you can read this, traversal succeeded\n');
  });

  it('raises CorruptFile for a non-zip input', async () => {
    const err = await expectOpError(
      zipExtract([loadFixture('corrupt.pdf', 'application/pdf')], {}, makeCtx()),
      'CorruptFile',
    );
    expect(err.file).toBe('corrupt.pdf');
  });

  it('cancels via AbortSignal (aborted while the async unzip is in flight)', async () => {
    const controller = new AbortController();
    const ctx = makeCtx(controller.signal);

    const promise = zipExtract([loadFixture('sample.zip', 'application/zip')], {}, ctx);
    // fflate's unzip() always defers its callback by at least one microtask,
    // so aborting synchronously right after the call lands mid-flight.
    controller.abort();

    await expectOpError(promise, 'Cancelled');
  });

  it('reports monotonic progress ending at 1', async () => {
    const ctx = makeCtx();
    await zipExtract([loadFixture('sample.zip', 'application/zip')], {}, ctx);
    assertMonotonicEndingAtOne(ctx.progress);
  });
});

// ---------------------------------------------------------------------------
// hash
// ---------------------------------------------------------------------------

describe('hash', () => {
  it('hashes a file with sha-256 (happy path)', async () => {
    const outputs = await hash([textInput('a.txt', 'hello')], { algorithm: 'sha-256' }, makeCtx());
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.name).toBe('a.txt.sha-256.txt');
    expect(outputs[0]?.type).toBe('text/plain');
    // sha256("hello")
    expect(bufferToText(outputs[0]!.buffer)).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });

  it('vendored MD5 matches the known test vector md5("abc")', async () => {
    const outputs = await hash([textInput('abc.txt', 'abc')], { algorithm: 'md5' }, makeCtx());
    expect(bufferToText(outputs[0]!.buffer)).toBe('900150983cd24fb0d6963f7d28e17f72');
  });

  it('sha-1 and sha-512 also work', async () => {
    const sha1 = await hash([textInput('a.txt', 'hello')], { algorithm: 'sha-1' }, makeCtx());
    expect(bufferToText(sha1[0]!.buffer)).toBe('aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d');

    const sha512 = await hash([textInput('a.txt', 'hello')], { algorithm: 'sha-512' }, makeCtx());
    expect(bufferToText(sha512[0]!.buffer)).toBe(
      '9b71d224bd62f3785d96d46ad3ea3d73319bfbc2890caadae2dff72519673ca72323c3d99ba5c11d7c7' +
        'acc6e14b8c5da0c4663475c2e5c3adef46f73bcdec043',
    );
  });

  it('rejects an unknown algorithm with InvalidOptions', async () => {
    await expectOpError(hash([textInput('a.txt', 'x')], { algorithm: 'sha-999' }, makeCtx()), 'InvalidOptions');
  });

  it('cancels part-way through via AbortSignal', async () => {
    const controller = new AbortController();
    const inputs = [textInput('a.txt', 'x'), textInput('b.txt', 'y')];
    const ctx = makeCtx(controller.signal);
    const originalOnProgress = ctx.onProgress.bind(ctx);
    ctx.onProgress = (fraction: number) => {
      originalOnProgress(fraction);
      if (fraction < 1) controller.abort();
    };

    await expectOpError(hash(inputs, { algorithm: 'sha-256' }, ctx), 'Cancelled');
  });

  it('reports monotonic progress ending at 1', async () => {
    const inputs = [textInput('a.txt', 'x'), textInput('b.txt', 'y')];
    const ctx = makeCtx();
    await hash(inputs, { algorithm: 'sha-256' }, ctx);
    assertMonotonicEndingAtOne(ctx.progress);
  });
});

// ---------------------------------------------------------------------------
// base64
// ---------------------------------------------------------------------------

describe('base64', () => {
  it('encodes bytes to base64 (happy path)', async () => {
    const outputs = await base64([textInput('a.txt', 'hello world')], { direction: 'encode' }, makeCtx());
    expect(outputs[0]?.name).toBe('a.txt.base64.txt');
    expect(bufferToText(outputs[0]!.buffer)).toBe('aGVsbG8gd29ybGQ=');
  });

  it('decodes base64 back to the original bytes', async () => {
    const outputs = await base64(
      [textInput('a.txt.base64.txt', 'aGVsbG8gd29ybGQ=')],
      { direction: 'decode' },
      makeCtx(),
    );
    expect(outputs[0]?.name).toBe('a.txt');
    expect(bufferToText(outputs[0]!.buffer)).toBe('hello world');
  });

  it('raises CorruptFile when decoding invalid base64', async () => {
    const err = await expectOpError(
      base64([textInput('bad.txt', 'not-valid-base64!!! ***')], { direction: 'decode' }, makeCtx()),
      'CorruptFile',
    );
    expect(err.file).toBe('bad.txt');
  });

  it('cancels part-way through via AbortSignal', async () => {
    const controller = new AbortController();
    const inputs = [textInput('a.txt', 'x'), textInput('b.txt', 'y')];
    const ctx = makeCtx(controller.signal);
    const originalOnProgress = ctx.onProgress.bind(ctx);
    ctx.onProgress = (fraction: number) => {
      originalOnProgress(fraction);
      if (fraction < 1) controller.abort();
    };

    await expectOpError(base64(inputs, { direction: 'encode' }, ctx), 'Cancelled');
  });

  it('reports monotonic progress ending at 1', async () => {
    const inputs = [textInput('a.txt', 'x'), textInput('b.txt', 'y')];
    const ctx = makeCtx();
    await base64(inputs, { direction: 'encode' }, ctx);
    assertMonotonicEndingAtOne(ctx.progress);
  });
});

// ---------------------------------------------------------------------------
// csv-json
// ---------------------------------------------------------------------------

describe('csv-json', () => {
  it('converts the committed sample.csv (quoted commas, escaped quotes, CRLF) to JSON', async () => {
    const outputs = await csvJson(
      [loadFixture('sample.csv', 'text/csv')],
      { direction: 'csv-to-json', delimiter: 'auto', header: true },
      makeCtx(),
    );
    expect(outputs[0]?.name).toBe('sample.json');
    const data = JSON.parse(bufferToText(outputs[0]!.buffer));
    expect(data).toEqual([
      { name: 'Alice', age: '30', note: 'Loves cats, dogs' },
      { name: 'Bob', age: '25', note: 'Said "hi" to everyone' },
      { name: 'Cara', age: '22', note: 'plain' },
    ]);
  });

  it('round-trips json-to-csv back to csv-to-json', async () => {
    const json = JSON.stringify([{ a: '1', b: 'two, three' }, { a: '4', b: 'has "quotes"' }]);
    const csvOut = await csvJson(
      [textInput('data.json', json, 'application/json')],
      { direction: 'json-to-csv', delimiter: ',', header: true },
      makeCtx(),
    );
    expect(csvOut[0]?.name).toBe('data.csv');

    const roundTrip = await csvJson(
      [{ name: 'data.csv', type: 'text/csv', buffer: csvOut[0]!.buffer }],
      { direction: 'csv-to-json', delimiter: ',', header: true },
      makeCtx(),
    );
    expect(JSON.parse(bufferToText(roundTrip[0]!.buffer))).toEqual([
      { a: '1', b: 'two, three' },
      { a: '4', b: 'has "quotes"' },
    ]);
  });

  it('auto-detects semicolon and tab delimiters', async () => {
    const semi = await csvJson(
      [textInput('s.csv', 'a;b;c\r\n1;2;3\r\n', 'text/csv')],
      { direction: 'csv-to-json', delimiter: 'auto', header: true },
      makeCtx(),
    );
    expect(JSON.parse(bufferToText(semi[0]!.buffer))).toEqual([{ a: '1', b: '2', c: '3' }]);

    const tab = await csvJson(
      [textInput('t.csv', 'a\tb\tc\r\n1\t2\t3\r\n', 'text/csv')],
      { direction: 'csv-to-json', delimiter: 'auto', header: true },
      makeCtx(),
    );
    expect(JSON.parse(bufferToText(tab[0]!.buffer))).toEqual([{ a: '1', b: '2', c: '3' }]);
  });

  it('raises CorruptFile for malformed CSV (unterminated quote)', async () => {
    const err = await expectOpError(
      csvJson(
        [textInput('bad.csv', 'name,note\r\n"unterminated,oops\r\n', 'text/csv')],
        { direction: 'csv-to-json', delimiter: ',', header: true },
        makeCtx(),
      ),
      'CorruptFile',
    );
    expect(err.file).toBe('bad.csv');
  });

  it('raises InvalidOptions with a character position for malformed JSON', async () => {
    const err = await expectOpError(
      csvJson(
        [textInput('bad.json', '{ "a": 1, }', 'application/json')],
        { direction: 'json-to-csv', delimiter: ',', header: true },
        makeCtx(),
      ),
      'InvalidOptions',
    );
    expect(err.message).toMatch(/position \d+/);
  });

  it('cancels part-way through via AbortSignal', async () => {
    const controller = new AbortController();
    const inputs = [
      textInput('a.csv', 'a,b\r\n1,2\r\n', 'text/csv'),
      textInput('b.csv', 'a,b\r\n3,4\r\n', 'text/csv'),
    ];
    const ctx = makeCtx(controller.signal);
    const originalOnProgress = ctx.onProgress.bind(ctx);
    ctx.onProgress = (fraction: number) => {
      originalOnProgress(fraction);
      if (fraction < 1) controller.abort();
    };

    await expectOpError(csvJson(inputs, { direction: 'csv-to-json', delimiter: ',', header: true }, ctx), 'Cancelled');
  });

  it('reports monotonic progress ending at 1', async () => {
    const inputs = [
      textInput('a.csv', 'a,b\r\n1,2\r\n', 'text/csv'),
      textInput('b.csv', 'a,b\r\n3,4\r\n', 'text/csv'),
    ];
    const ctx = makeCtx();
    await csvJson(inputs, { direction: 'csv-to-json', delimiter: ',', header: true }, ctx);
    assertMonotonicEndingAtOne(ctx.progress);
  });
});

// ---------------------------------------------------------------------------
// json-format
// ---------------------------------------------------------------------------

describe('json-format', () => {
  it('pretty-prints JSON with the requested indent (happy path)', async () => {
    const outputs = await jsonFormat(
      [textInput('a.json', '{"b":2,"a":1}', 'application/json')],
      { mode: 'pretty', indent: 2 },
      makeCtx(),
    );
    expect(outputs[0]?.name).toBe('a.json');
    expect(bufferToText(outputs[0]!.buffer)).toBe(JSON.stringify({ b: 2, a: 1 }, null, 2));
  });

  it('minifies JSON', async () => {
    const outputs = await jsonFormat(
      [textInput('a.json', '{\n  "a": 1\n}', 'application/json')],
      { mode: 'minify', indent: 2 },
      makeCtx(),
    );
    expect(bufferToText(outputs[0]!.buffer)).toBe('{"a":1}');
  });

  it('raises InvalidOptions with a character position for malformed JSON', async () => {
    const err = await expectOpError(
      jsonFormat([textInput('bad.json', '{ bad json', 'application/json')], { mode: 'pretty', indent: 2 }, makeCtx()),
      'InvalidOptions',
    );
    expect(err.message).toMatch(/position \d+/);
  });

  it('cancels part-way through via AbortSignal', async () => {
    const controller = new AbortController();
    const inputs = [textInput('a.json', '{"a":1}', 'application/json'), textInput('b.json', '{"b":2}', 'application/json')];
    const ctx = makeCtx(controller.signal);
    const originalOnProgress = ctx.onProgress.bind(ctx);
    ctx.onProgress = (fraction: number) => {
      originalOnProgress(fraction);
      if (fraction < 1) controller.abort();
    };

    await expectOpError(jsonFormat(inputs, { mode: 'pretty', indent: 2 }, ctx), 'Cancelled');
  });

  it('reports monotonic progress ending at 1', async () => {
    const inputs = [textInput('a.json', '{"a":1}', 'application/json'), textInput('b.json', '{"b":2}', 'application/json')];
    const ctx = makeCtx();
    await jsonFormat(inputs, { mode: 'pretty', indent: 2 }, ctx);
    assertMonotonicEndingAtOne(ctx.progress);
  });
});

// ---------------------------------------------------------------------------
// qr-generate (SVG path — fully node-testable; PNG/OffscreenCanvas path is
// covered separately in tests/unit/data-qr.browser.test.ts)
// ---------------------------------------------------------------------------

describe('qr-generate', () => {
  it('generates a valid SVG QR code from text (happy path)', async () => {
    const outputs = await qrGenerate([], { text: 'hello omnitool', format: 'svg', size: 256 }, makeCtx());
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.name).toBe('qr.svg');
    expect(outputs[0]?.type).toBe('image/svg+xml');

    const svg = bufferToText(outputs[0]!.buffer);
    expect(svg).toContain('<svg');
    expect(svg).toContain('viewBox');
    expect(svg).toContain('width="256"');
    expect(svg).toContain('height="256"');
  });

  it('raises InvalidOptions when text is empty', async () => {
    await expectOpError(qrGenerate([], { text: '', format: 'svg', size: 256 }, makeCtx()), 'InvalidOptions');
  });

  it('raises InvalidOptions for an unknown format', async () => {
    await expectOpError(
      qrGenerate([], { text: 'hi', format: 'bmp', size: 256 }, makeCtx()),
      'InvalidOptions',
    );
  });

  it('cancels via AbortSignal (aborted immediately after invocation, before the internal yield)', async () => {
    const controller = new AbortController();
    const ctx = makeCtx(controller.signal);

    const promise = qrGenerate([], { text: 'hello', format: 'svg', size: 256 }, ctx);
    controller.abort();

    await expectOpError(promise, 'Cancelled');
  });

  it('reports monotonic progress ending at 1', async () => {
    const ctx = makeCtx();
    await qrGenerate([], { text: 'hello', format: 'svg', size: 256 }, ctx);
    assertMonotonicEndingAtOne(ctx.progress);
  });
});
