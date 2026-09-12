import { describe, expect, it } from 'vitest';

import { createComparisonSnapshot } from '../../src/tools/data/text-diff.model';
import { TextDiffLive, type LiveWorkerLike } from '../../src/tools/data/text-diff.live';
import type { LiveWorkerToMain, MainToLiveWorker, ReadyResponse } from '../../src/tools/data/text-diff.protocol';

function worker(): Worker {
  return new Worker(new URL('../../src/tools/data/text-diff.live.worker.ts', import.meta.url), { type: 'module' });
}

function send(target: Worker, request: MainToLiveWorker): Promise<LiveWorkerToMain> {
  return new Promise((resolve) => {
    const receive = (event: MessageEvent<LiveWorkerToMain>): void => {
      const response = event.data;
      if (response.revision !== request.revision || ('requestId' in request && response.kind !== 'progress' && response.kind !== 'ready' && response.requestId !== request.requestId)) return;
      if (response.kind === 'progress') return;
      target.removeEventListener('message', receive);
      resolve(response);
    };
    target.addEventListener('message', receive);
    target.postMessage(request);
  });
}

class ManualWorker implements LiveWorkerLike {
  readonly sent: MainToLiveWorker[] = [];
  terminated = false;
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();
  postMessage(message: MainToLiveWorker): void { this.sent.push(message); }
  terminate(): void { this.terminated = true; }
  addEventListener(type: 'message' | 'error' | 'messageerror', listener: (event: Event) => void): void { (this.listeners.get(type) ?? this.listeners.set(type, new Set()).get(type)!).add(listener); }
  removeEventListener(type: 'message' | 'error' | 'messageerror', listener: (event: Event) => void): void { this.listeners.get(type)?.delete(listener); }
  emit(message: LiveWorkerToMain): void { for (const listener of this.listeners.get('message') ?? []) listener({ data: message } as MessageEvent); }
  crash(): void { for (const listener of this.listeners.get('error') ?? []) listener(new Event('error')); }
}

function source(text: string) {
  return createComparisonSnapshot({ revision: 1, sources: [{ text, name: 'same.txt', origin: 'text' }, { text: '', name: 'empty.txt', origin: 'empty' }], rules: { ignoreWhitespace: false, ignoreCase: false } }).sources[0];
}

function ready(revision: number): ReadyResponse {
  const snapshot = createComparisonSnapshot({ revision, sources: [{ text: 'a', name: 'a', origin: 'text' }, { text: 'b', name: 'b', origin: 'text' }], rules: { ignoreWhitespace: false, ignoreCase: false } });
  return { kind: 'ready', revision, snapshot, identity: { rawIdentical: false, exactDisplayLinesIdentical: false, normalizedIdentical: false, metadataOnlyDifference: false }, stats: { added: 0, removed: 0, changed: 1, unchanged: 0, hunks: 1, similarity: 0 }, sourceMeta: [{ lineCount: 1, ending: 'none', hasBom: false, endsWithNewline: false }, { lineCount: 1, ending: 'none', hasBom: false, endsWithNewline: false }], logicalRows: 1, hunks: [], notices: [] };
}

function page(revision: number, requestId: number) {
  return { kind: 'window' as const, revision, requestId, start: { row: 0, aOffset: 0, bOffset: 0 }, next: null, endOfComparison: true, rows: [], displayedRows: 0, displayedCharacters: 0, notices: [] };
}

describe('Text Diff live worker (real module worker)', () => {
  it('decodes each pending file once, then returns compact windows without cloning source text', async () => {
    const target = worker();
    try {
      const first = await send(target, { kind: 'read', revision: 1, requestId: 1, source: { kind: 'file', file: new File(['before\n'], 'same.txt'), name: 'same.txt' } });
      const second = await send(target, { kind: 'read', revision: 1, requestId: 2, source: { kind: 'file', file: new File(['after\n'], 'same.txt'), name: 'same.txt' } });
      expect(first).toMatchObject({ kind: 'source', source: { text: 'before\n' } });
      expect(second).toMatchObject({ kind: 'source', source: { text: 'after\n' } });

      const ready = await send(target, { kind: 'compare', revision: 2, sources: [{ kind: 'text', text: 'before\n', name: 'same.txt', origin: 'file' }, { kind: 'text', text: 'after\n', name: 'same.txt', origin: 'file' }], rules: { ignoreWhitespace: false, ignoreCase: false } });
      expect(ready).toMatchObject({ kind: 'ready', snapshot: { sources: [{ text: 'before\n' }, { text: 'after\n' }] } });
      const page = await send(target, { kind: 'window', revision: 2, requestId: 3, cursor: { row: 0, aOffset: 0, bOffset: 0 }, detail: 'word', context: 'whole', expansions: [] });
      expect(page).toMatchObject({ kind: 'window', displayedRows: 1 });
      expect(page).not.toHaveProperty('snapshot');
    } finally { target.terminate(); }
  });

  it('reports fatal UTF-8 decoding failures from the real worker', async () => {
    const target = worker();
    try {
      const response = await send(target, { kind: 'read', revision: 1, requestId: 1, source: { kind: 'file', file: new File([new Uint8Array([0xc3, 0x28])], 'bad.txt'), name: 'bad.txt' } });
      expect(response).toMatchObject({ kind: 'error', code: 'InvalidEncoding', requestId: 1 });
    } finally { target.terminate(); }
  });

  it('returns an exact source range for an oversized grapheme from the real worker', async () => {
    const target = worker();
    const oversized = `a${'\u0301'.repeat(100_000)}`;
    try {
      await send(target, { kind: 'compare', revision: 1, sources: [{ kind: 'text', text: '', name: 'a.txt', origin: 'empty' }, { kind: 'text', text: oversized, name: 'b.txt', origin: 'text' }], rules: { ignoreWhitespace: false, ignoreCase: false } });
      const window = await send(target, { kind: 'window', revision: 1, requestId: 1, cursor: { row: 0, aOffset: 0, bOffset: 0 }, detail: 'character', context: 'whole', expansions: [] });
      if (window.kind !== 'window') throw new Error('expected window');
      const row = window.rows.find((item) => item.kind !== 'gap');
      if (!row || !row.b?.oversizedGrapheme) throw new Error('expected oversized B fragment');
      const copied = await send(target, { kind: 'copy', revision: 1, requestId: 2, copy: 'source', side: 'a', range: row.b.sourceRange });
      expect(copied).toMatchObject({ kind: 'copy', text: oversized });
    } finally { target.terminate(); }
  });

  it('terminates a superseded comparison and retries through a fresh real worker', async () => {
    const source = createComparisonSnapshot({ revision: 1, sources: [{ text: 'a\n'.repeat(50_000), name: 'a.txt', origin: 'text' }, { text: 'b\n'.repeat(50_000), name: 'b.txt', origin: 'text' }], rules: { ignoreWhitespace: false, ignoreCase: false } }).sources;
    const live = new TextDiffLive();
    try {
      const stale = live.compare(1, source, { ignoreWhitespace: false, ignoreCase: false });
      live.cancel();
      await expect(stale).rejects.toMatchObject({ code: 'Superseded' });
      const retried = await live.compare(2, source, { ignoreWhitespace: false, ignoreCase: false });
      expect(retried).toMatchObject({ kind: 'ready', revision: 2 });
    } finally { live.destroy(); }
  }, 20_000);

  it('allows concurrent source reads, retains a new comparison after retired-worker crash callbacks, and makes destroy terminal', async () => {
    const reader = new ManualWorker();
    const crashed = new ManualWorker();
    const replacementWorker = new ManualWorker();
    const workers = [reader, crashed, replacementWorker];
    const live = new TextDiffLive(() => workers.shift() ?? new ManualWorker());
    try {
      const first = live.readSource(1, { kind: 'text', text: 'old', name: 'same.txt', origin: 'text' });
      const replacement = live.readSource(2, { kind: 'text', text: 'new', name: 'same.txt', origin: 'text' });
      expect(reader.sent.filter((message) => message.kind === 'read')).toHaveLength(2);
      reader.emit({ kind: 'source', revision: 2, requestId: 2, source: source('new') });
      reader.emit({ kind: 'source', revision: 1, requestId: 1, source: source('old') });
      await expect(replacement).resolves.toMatchObject({ text: 'new' });
      await expect(first).resolves.toMatchObject({ text: 'old' });

      const stale = live.compare(3, [source('a'), source('b')], { ignoreWhitespace: false, ignoreCase: false });
      const current = live.compare(4, [source('a'), source('b')], { ignoreWhitespace: false, ignoreCase: false });
      await expect(stale).rejects.toMatchObject({ code: 'Superseded' });
      // Retired worker callbacks arrive after a replacement is already pending.
      crashed.emit(ready(3));
      crashed.crash();
      replacementWorker.emit(ready(4));
      await expect(current).resolves.toMatchObject({ revision: 4 });
      live.destroy();
      expect(() => live.window({ revision: 4, cursor: { row: 0, aOffset: 0, bOffset: 0 }, detail: 'line', context: 3 })).toThrow(/destroyed/i);
    } finally { live.destroy(); }
  });

  it('treats cached-window selection as newer than an in-flight window response', async () => {
    const worker = new ManualWorker();
    const live = new TextDiffLive(() => worker);
    try {
      const comparison = live.compare(1, [source('a'), source('b')], { ignoreWhitespace: false, ignoreCase: false });
      worker.emit(ready(1));
      await comparison;
      const a = live.window({ revision: 1, cursor: { row: 0, aOffset: 0, bOffset: 0 }, detail: 'line', context: 3 });
      await Promise.resolve();
      const first = worker.sent.at(-1) as Extract<MainToLiveWorker, { kind: 'window' }>;
      worker.emit(page(1, first.requestId));
      await a;
      const b = live.window({ revision: 1, cursor: { row: 1, aOffset: 0, bOffset: 0 }, detail: 'line', context: 3 });
      await Promise.resolve();
      const second = worker.sent.at(-1) as Extract<MainToLiveWorker, { kind: 'window' }>;
      await expect(live.window({ revision: 1, cursor: { row: 0, aOffset: 0, bOffset: 0 }, detail: 'line', context: 3 })).resolves.toMatchObject({ requestId: first.requestId });
      await expect(b).rejects.toMatchObject({ code: 'Superseded' });
      worker.emit(page(1, second.requestId));
    } finally { live.destroy(); }
  });

  it('reports a current worker crash distinctly from cancellation', async () => {
    const worker = new ManualWorker();
    const live = new TextDiffLive(() => worker);
    try {
      const pending = live.compare(1, [source('a'), source('b')], { ignoreWhitespace: false, ignoreCase: false });
      worker.crash();
      await expect(pending).rejects.toMatchObject({ code: 'WorkerCrashed' });
    } finally { live.destroy(); }
  });
});
