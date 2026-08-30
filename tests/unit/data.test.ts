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
import textClean from '../../src/tools/data/text-clean.op';

import { parseCsv } from '../../src/tools/data/csv-json.op';
import { parseCsv as parseCsvBefore } from '../../scripts/bench/reference/csv-parser-97aaa82.mjs';

import { DATA_TOOLS } from '../../src/core/registry.data';
import { DATA_LOADERS } from '../../src/core/workers/loaders.data';

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

  // The encoder is hand-written for speed (see the note at the top of
  // base64.op.ts), so these pin it to the standard rather than to itself.
  it.each([
    ['', ''],
    ['f', 'Zg=='],
    ['fo', 'Zm8='],
    ['foo', 'Zm9v'],
    ['foob', 'Zm9vYg=='],
    ['fooba', 'Zm9vYmE='],
    ['foobar', 'Zm9vYmFy'],
  ])('encodes %j to %j (RFC 4648 vectors, padding included)', async (plain, encoded) => {
    const outputs = await base64([textInput('a.txt', plain)], { direction: 'encode' }, makeCtx());
    expect(bufferToText(outputs[0]!.buffer)).toBe(encoded);
  });

  it('agrees with the platform btoa over 64 KB of arbitrary bytes', async () => {
    const bytes = new Uint8Array(64 * 1024);
    // Deterministic, and covers every byte value including the high ones that
    // a naive String.fromCharCode round trip would mangle.
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + (i >> 8)) & 0xff;
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);

    const outputs = await base64([{ name: 'a.bin', type: 'application/octet-stream', buffer }], { direction: 'encode' }, makeCtx());

    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    expect(bufferToText(outputs[0]!.buffer)).toBe(btoa(binary));
  });

  it('round-trips arbitrary bytes through encode then decode', async () => {
    const bytes = new Uint8Array(5000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7 + 13) & 0xff;
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);

    const encoded = await base64([{ name: 'a.bin', type: 'application/octet-stream', buffer }], { direction: 'encode' }, makeCtx());
    const decoded = await base64(
      [{ name: 'a.bin.base64.txt', type: 'text/plain', buffer: encoded[0]!.buffer }],
      { direction: 'decode' },
      makeCtx(),
    );

    expect(new Uint8Array(decoded[0]!.buffer)).toEqual(bytes);
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

  // The parser scans runs rather than single characters (see parseCsv's note).
  // These are the places where a run has to STOP, and the cases a fuzz run
  // flagged as the easy ones to get wrong.
  it('preserves the grammar at every place a run has to stop', async () => {
    const cases: [string, unknown][] = [
      // A bare CR ends a row, and swallows a following LF.
      ['a,b\rc,d', [['a', 'b'], ['c', 'd']]],
      // A quote that is not at the start of a field is literal content.
      ['ab"cd,e', [['ab"cd', 'e']]],
      // ...including a doubled one, which is NOT an escape outside quotes.
      ['ab""cd', [['ab""cd']]],
      // A quoted field may hold the delimiter, a newline, and escaped quotes.
      ['"a,b","c\nd","e""f"', [['a,b', 'c\nd', 'e"f']]],
      // Content after a closing quote joins the same field.
      ['"ab"cd', [['abcd']]],
      // An empty quoted field is empty, and an empty input has no rows at all.
      ['"",x', [['', 'x']]],
      ['', []],
    ];

    for (const [csv, expected] of cases) {
      const outputs = await csvJson(
        [textInput('t.csv', csv, 'text/csv')],
        { direction: 'csv-to-json', delimiter: ',', header: false },
        makeCtx(),
      );
      expect(JSON.parse(bufferToText(outputs[0]!.buffer))).toEqual(expected);
    }
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

// ---------------------------------------------------------------------------
// parseCsv, against the parser it replaced
//
// The scanning rewrite is only defensible if it is the SAME parser. The full
// 200,000-case fuzz lives in scripts/bench/csv.mjs; this is a seeded slice of
// it, small enough to belong in CI, holding the current parser against the
// frozen pre-rewrite copy in scripts/bench/reference/.
// ---------------------------------------------------------------------------

describe('parseCsv against the pre-rewrite reference', () => {
  /** Fragments that land on every decision the scanner makes. */
  const FRAGMENTS = [
    'a', 'bb', '', '"', '""', ',', ';', '\t', '\n', '\r', '\r\n', ' ', '  ',
    'x,y', '"q"', '"a,b"', '"a""b"', '"\n"', '"\r\n"', 'a"b', '""""', 'é', '\u{1D4B3}',
  ];

  /** Deterministic, so a failure names a case anyone can reproduce. */
  function seeded(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff;
      return state / 0x7fffffff;
    };
  }

  function outcome(parse: (text: string, delimiter: string) => string[][], text: string, delimiter: string): string {
    try {
      return JSON.stringify(parse(text, delimiter));
    } catch (error) {
      return `threw: ${(error as Error).message}`;
    }
  }

  it('answers identically on 5,000 generated inputs, errors included', () => {
    const next = seeded(12_345);
    const mismatches: string[] = [];

    for (let i = 0; i < 5_000; i++) {
      let text = '';
      const pieces = 1 + Math.floor(next() * 24);
      for (let piece = 0; piece < pieces; piece++) {
        text += FRAGMENTS[Math.floor(next() * FRAGMENTS.length)] as string;
      }
      const delimiter = i % 3 === 0 ? ';' : i % 3 === 1 ? '\t' : ',';

      if (outcome(parseCsv, text, delimiter) !== outcome(parseCsvBefore, text, delimiter)) {
        mismatches.push(`${JSON.stringify(text)} (delimiter ${JSON.stringify(delimiter)})`);
      }
    }

    expect(mismatches).toEqual([]);
  });

  it('agrees on the cases that are easiest to get wrong', () => {
    // Named explicitly, so a regression here reads as a sentence rather than
    // as "case 3,417 of the fuzz".
    const cases: [string, string][] = [
      ['a,b\rc,d', ','],
      ['ab"cd,e', ','],
      ['ab""cd', ','],
      ['"a,b","c\nd","e""f"', ','],
      ['"ab"cd', ','],
      ['"",x', ','],
      ['', ','],
      ['\r\n', ','],
      ['a;b\tc', ';'],
      ['"unterminated', ','],
    ];

    for (const [text, delimiter] of cases) {
      expect(outcome(parseCsv, text, delimiter)).toBe(outcome(parseCsvBefore, text, delimiter));
    }
  });
});

// ---------------------------------------------------------------------------
// text-clean
// ---------------------------------------------------------------------------

describe('text-clean', () => {
  /** U+FEFF, spelled out because the character itself is invisible here. */
  const BOM = String.fromCharCode(0xfeff);

  it('is registered with a matching loader entry and the documented schema', () => {
    const tool = DATA_TOOLS.find((t) => t.id === 'text-clean');
    expect(tool).toBeDefined();
    expect(DATA_LOADERS['text-clean']).toBeTypeOf('function');
    expect(tool?.accepts).toEqual([
      'text/plain',
      'text/markdown',
      'text/csv',
      'text/tab-separated-values',
    ]);
    expect(tool?.minInputs).toBe(1);
    expect(tool?.options?.['sort']).toMatchObject({ kind: 'select', default: 'none' });
    expect(tool?.options?.['trim']).toEqual({
      kind: 'toggle',
      label: 'Trim trailing whitespace',
      default: true,
    });
    expect(tool?.options?.['dedupe']).toMatchObject({ kind: 'toggle', default: false });
    expect(tool?.options?.['dropBlank']).toMatchObject({ kind: 'toggle', default: false });
    expect(tool?.options?.['endings']).toMatchObject({ kind: 'select', default: 'keep' });
  });

  it('trims, drops blanks, deduplicates and sorts — in that order (happy path)', async () => {
    // 'b  ' only equals 'b' after trimming, and the blank line is only blank
    // after it too: the fixed order is what makes both come out right.
    const outputs = await textClean(
      [textInput('list.txt', 'b  \n   \nb\na\n')],
      { trim: true, dropBlank: true, dedupe: true, sort: 'asc' },
      makeCtx(),
    );

    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.name).toBe('list.txt');
    expect(bufferToText(outputs[0]!.buffer)).toBe('a\nb\n');
  });

  it('sorts in code-unit order, not locale order', async () => {
    // Locale collation would put 'apple' first; LC_ALL=C order does not.
    const outputs = await textClean(
      [textInput('a.txt', 'apple\nZebra\nBanana')],
      { sort: 'asc' },
      makeCtx(),
    );
    expect(bufferToText(outputs[0]!.buffer)).toBe('Banana\nZebra\napple');
  });

  it('sorts descending when asked', async () => {
    const outputs = await textClean([textInput('a.txt', 'a\nc\nb')], { sort: 'desc' }, makeCtx());
    expect(bufferToText(outputs[0]!.buffer)).toBe('c\nb\na');
  });

  it('keeps the FIRST of each duplicate, in place, when not sorting', async () => {
    const outputs = await textClean(
      [textInput('a.txt', 'c\na\nc\nb\na')],
      { dedupe: true },
      makeCtx(),
    );
    expect(bufferToText(outputs[0]!.buffer)).toBe('c\na\nb');
  });

  it('trims only TRAILING whitespace, never indentation', async () => {
    const outputs = await textClean([textInput('a.txt', '    indented   ')], {}, makeCtx());
    expect(bufferToText(outputs[0]!.buffer)).toBe('    indented');
  });

  it('preserves a trailing newline, and the absence of one', async () => {
    const withNewline = await textClean([textInput('a.txt', 'b\na\n')], { sort: 'asc' }, makeCtx());
    expect(bufferToText(withNewline[0]!.buffer)).toBe('a\nb\n');

    const without = await textClean([textInput('a.txt', 'b\na')], { sort: 'asc' }, makeCtx());
    expect(bufferToText(without[0]!.buffer)).toBe('a\nb');
  });

  it('treats a lone newline as one blank line, not as nothing', async () => {
    const kept = await textClean([textInput('a.txt', '\n')], {}, makeCtx());
    expect(bufferToText(kept[0]!.buffer)).toBe('\n');

    // ...but a file whose every line was dropped must not come back as a
    // stray newline.
    const emptied = await textClean([textInput('a.txt', '\n\n\n')], { dropBlank: true }, makeCtx());
    expect(bufferToText(emptied[0]!.buffer)).toBe('');
  });

  it('preserves a leading byte-order mark', async () => {
    const outputs = await textClean(
      [textInput('a.txt', BOM + 'b\na')],
      { sort: 'asc' },
      makeCtx(),
    );
    // Asserted on the BYTES: `bufferToText`'s decoder strips a leading BOM, so
    // a check on the decoded string cannot tell "preserved" from "dropped".
    expect(new Uint8Array(outputs[0]!.buffer).slice(0, 3)).toEqual(
      new Uint8Array([0xef, 0xbb, 0xbf]),
    );
    // And the BOM is not a line: it stays at the front instead of sorting.
    expect(bufferToText(outputs[0]!.buffer)).toBe('a\nb');
    expect(new TextDecoder('utf-8', { ignoreBOM: true }).decode(outputs[0]!.buffer)).toBe(
      BOM + 'a\nb',
    );
  });

  it("follows the file's own line endings by default", async () => {
    const crlf = await textClean([textInput('a.txt', 'b\r\na\r\n')], { sort: 'asc' }, makeCtx());
    expect(bufferToText(crlf[0]!.buffer)).toBe('a\r\nb\r\n');

    const lf = await textClean([textInput('a.txt', 'b\na\n')], { sort: 'asc' }, makeCtx());
    expect(bufferToText(lf[0]!.buffer)).toBe('a\nb\n');
  });

  it('keeps bare CR endings under "keep", instead of quietly making them LF', async () => {
    // A classic-Mac file has CRs and no LF anywhere. "Keep the file's own" has
    // to mean keeping those.
    const kept = await textClean([textInput('a.txt', 'b\ra')], { sort: 'asc' }, makeCtx());
    expect(bufferToText(kept[0]!.buffer)).toBe('a\rb');

    // Asking for LF still converts them, which is the point of asking.
    const converted = await textClean([textInput('a.txt', 'b\ra')], { sort: 'asc', endings: 'lf' }, makeCtx());
    expect(bufferToText(converted[0]!.buffer)).toBe('a\nb');
  });

  it('normalises line endings on request, in both directions', async () => {
    const toLf = await textClean([textInput('a.txt', 'a\r\nb\r\n')], { endings: 'lf' }, makeCtx());
    expect(bufferToText(toLf[0]!.buffer)).toBe('a\nb\n');

    const toCrlf = await textClean([textInput('a.txt', 'a\nb\n')], { endings: 'crlf' }, makeCtx());
    expect(bufferToText(toCrlf[0]!.buffer)).toBe('a\r\nb\r\n');

    // A lone CR is a line ending too, and must not survive as content.
    const oldMac = await textClean([textInput('a.txt', 'a\rb')], { endings: 'lf' }, makeCtx());
    expect(bufferToText(oldMac[0]!.buffer)).toBe('a\nb');
  });

  it('returns the ORIGINAL bytes when nothing about the file changes', async () => {
    const source = textInput('a.txt', 'a\nb\n');
    const outputs = await textClean([source], {}, makeCtx());
    // Identity, not equality: an unchanged file is not re-encoded at all.
    expect(outputs[0]?.buffer).toBe(source.buffer);
  });

  it('keeps each file name and mime type', async () => {
    const outputs = await textClean(
      [textInput('rows.csv', 'b,2\na,1', 'text/csv')],
      { sort: 'asc' },
      makeCtx(),
    );
    expect(outputs[0]?.name).toBe('rows.csv');
    expect(outputs[0]?.type).toBe('text/csv');
  });

  it('raises CorruptFile naming the file for bytes that are not UTF-8', async () => {
    const bad: OpInput = {
      name: 'bad.txt',
      type: 'text/plain',
      buffer: new Uint8Array([0xff, 0xfe, 0xfd]).buffer,
    };
    const err = await expectOpError(textClean([bad], {}, makeCtx()), 'CorruptFile');
    expect(err.file).toBe('bad.txt');
  });

  it.each([
    [{ sort: 'sideways' }],
    [{ dedupe: 'yes' }],
    [{ trim: 1 }],
    [{ endings: 'cr' }],
  ])('raises InvalidOptions for %j', async (options) => {
    await expectOpError(textClean([textInput('a.txt', 'a')], options, makeCtx()), 'InvalidOptions');
  });

  it('raises InvalidOptions when given no files at all', async () => {
    await expectOpError(textClean([], {}, makeCtx()), 'InvalidOptions');
  });

  it('cancels part-way through via AbortSignal', async () => {
    const controller = new AbortController();
    const ctx = makeCtx(controller.signal);
    const originalOnProgress = ctx.onProgress.bind(ctx);
    ctx.onProgress = (fraction: number) => {
      originalOnProgress(fraction);
      if (fraction < 1) controller.abort();
    };

    await expectOpError(
      textClean([textInput('a.txt', 'a'), textInput('b.txt', 'b')], {}, ctx),
      'Cancelled',
    );
  });

  it('reports monotonic progress ending at 1', async () => {
    const ctx = makeCtx();
    await textClean([textInput('a.txt', 'a'), textInput('b.txt', 'b')], {}, ctx);
    expect(ctx.progress).toEqual([0.5, 1]);
    assertMonotonicEndingAtOne(ctx.progress);
  });
});
