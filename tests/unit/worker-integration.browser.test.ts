// tests/unit/worker-integration.browser.test.ts
//
// Every other kernel test (pool.test.ts, pipeline.test.ts) runs the real
// runner (`createRunner` from src/core/workers/runner.worker.ts) but hosted by
// tests/helpers/fake-worker.ts's FakeWorker, because the vitest `node`
// project has no global `Worker` class at all. That leaves three things
// completely untested end-to-end: Vite's actual worker bundling, REAL
// `postMessage` transfer semantics, and REAL crash/cancel behaviour of a
// genuine `Worker` instance.
//
// This file closes that gap. It runs under the `browser` vitest project
// (see vitest.workspace.ts — headless Chromium via the Playwright provider),
// where `Worker` is a real, spec-compliant class. Every test below spawns a
// REAL `Worker` from the actual `src/core/workers/runner.worker.ts` module —
// the exact file the production `WorkerPool.defaultFactory` in
// src/core/workers/pool.ts points at — using the real `WorkerPool` and (for
// the first test) the real `pipeline.run()`. Nothing here is faked, stubbed,
// or mocked: a real Worker cannot be swapped for a custom loader map (that
// would require reaching into a separate global scope), so every op that
// runs below is one of the 19 real production ops, loaded through the real
// static id -> loader map.

import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';

import { run } from '../../src/core/pipeline';
import { WorkerPool, type WorkerLike } from '../../src/core/workers/pool';
import type { RunMessage, WorkerToMainMessage } from '../../src/core/workers/protocol';

async function fixtureBytes(name: string): Promise<ArrayBuffer> {
  const url = new URL(`../fixtures/${name}`, import.meta.url).href;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fixture ${name}: HTTP ${res.status}`);
  return res.arrayBuffer();
}

async function smallPdfFile(name = 'small.pdf'): Promise<File> {
  return new File([await fixtureBytes('small.pdf')], name, { type: 'application/pdf' });
}

/**
 * Spawns the ACTUAL production worker module, exactly the way
 * src/core/workers/pool.ts's own `defaultFactory` does. No id -> loader
 * override is injected — there is no way to reach into a real Worker's own
 * module scope from outside it, so this always runs the real, static LOADERS
 * map baked into runner.worker.ts.
 */
function realFactory(): WorkerLike {
  return new Worker(new URL('../../src/core/workers/runner.worker.ts', import.meta.url), {
    type: 'module',
  });
}

function realPool(capacity = 2): WorkerPool {
  return new WorkerPool({ factory: realFactory, capacity });
}

describe('sanity: this is a genuine global Worker, not the FakeWorker test double', () => {
  it('the browser vitest project provides a real Worker constructor', () => {
    expect(typeof Worker).toBe('function');
    // FakeWorker (tests/helpers/fake-worker.ts) is a plain class with no
    // relation to the platform Worker; a real instance must not be one.
    const probe = realFactory();
    expect(probe).toBeInstanceOf(Worker);
    probe.terminate();
  });
});

describe('pdf-merge end-to-end through a REAL Worker', () => {
  it(
    'merges small.pdf with itself into 6 real pages, with monotonic progress ending at exactly 1',
    async () => {
      const pool = realPool();
      try {
        const files = [await smallPdfFile(), await smallPdfFile()];
        const job = run('pdf-merge', files, {}, { pool });

        const seen: number[] = [];
        job.onProgress((fraction) => seen.push(fraction));

        const result = await job.done;

        expect(result.partial).toBe(false);
        expect(result.results).toEqual([
          { status: 'ok', name: 'small.pdf' },
          { status: 'ok', name: 'small.pdf' },
        ]);
        expect(result.outputs).toHaveLength(1);
        expect(result.outputs[0]!.type).toBe('application/pdf');

        // The real proof this ran through a real op in a real worker and got
        // real bytes back: decode them and count the pages.
        const merged = await PDFDocument.load(result.outputs[0]!.buffer);
        expect(merged.getPageCount()).toBe(6);

        expect(seen.length).toBeGreaterThan(0);
        expect(seen.at(-1)).toBe(1);
        expect([...seen].sort((a, b) => a - b)).toEqual(seen);
        expect(seen.every((fraction) => fraction >= 0 && fraction <= 1)).toBe(true);
      } finally {
        pool.terminateAll();
      }
    },
    20_000,
  );
});

describe('transfer, never clone — through a REAL Worker', () => {
  it(
    'detaches the sending-side ArrayBuffers the instant postMessage is called, and the worker still receives the full bytes',
    async () => {
      const pool = realPool();
      try {
        const worker = await pool.acquire();

        const bufA = await fixtureBytes('small.pdf');
        const bufB = await fixtureBytes('small.pdf');
        expect(bufA.byteLength).toBeGreaterThan(0);
        expect(bufB.byteLength).toBeGreaterThan(0);

        const message: RunMessage = {
          kind: 'run',
          jobId: 'transfer-check',
          toolId: 'pdf-merge',
          inputs: [
            { name: 'small.pdf', type: 'application/pdf', buffer: bufA },
            { name: 'small.pdf', type: 'application/pdf', buffer: bufB },
          ],
          options: {},
        };

        const settled = new Promise<WorkerToMainMessage>((resolve) => {
          worker.listen({
            message: (m) => {
              if (m.kind === 'done' || m.kind === 'error') resolve(m);
            },
          });
        });

        worker.post(message, [bufA, bufB]);

        // THE ASSERTION: real `postMessage` transfer detaches a Transferable
        // synchronously, at the call site — not on some later tick. This is
        // only observable with a genuine Worker; FakeWorker's
        // `structuredClone(msg, { transfer })` proves the same *contract* but
        // not the real platform behaviour this test exists to cover.
        expect(bufA.byteLength).toBe(0);
        expect(bufB.byteLength).toBe(0);

        const outcome = await settled;
        expect(outcome.kind).toBe('done');
        if (outcome.kind !== 'done') throw new Error('expected a done message');
        expect(outcome.outputs).toHaveLength(1);
        const merged = await PDFDocument.load(outcome.outputs[0]!.buffer);
        expect(merged.getPageCount()).toBe(6);

        pool.release(worker);
      } finally {
        pool.terminateAll();
      }
    },
    20_000,
  );
});

describe('cancellation through a REAL Worker', () => {
  it(
    'settles as Cancelled when cancelled mid-run, and never reaches progress 1',
    async () => {
      const pool = realPool();
      try {
        // Several duplicate 3-page inputs, rasterised through the real
        // pdfjs + OffscreenCanvas path in to-images.op.ts, give genuine async
        // work spread across ~24 pages — enough that cancelling right after
        // the very first real progress tick reliably lands well before the
        // whole job finishes.
        const files = await Promise.all(
          Array.from({ length: 8 }, (_, i) => smallPdfFile(`copy-${i}.pdf`)),
        );
        const job = run('pdf-to-images', files, { format: 'png', dpi: 200 }, { pool });

        const seen: number[] = [];
        let cancelled = false;
        job.onProgress((fraction) => {
          seen.push(fraction);
          if (fraction > 0 && !cancelled) {
            cancelled = true;
            job.cancel();
          }
        });

        await expect(job.done).rejects.toMatchObject({ name: 'OpError', code: 'Cancelled' });

        expect(seen.length).toBeGreaterThan(0);
        expect(seen.at(-1)).not.toBe(1);
      } finally {
        pool.terminateAll();
      }
    },
    30_000,
  );
});
