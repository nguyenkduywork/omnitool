// Main-thread lifecycle and request routing for the lazy Text Diff worker.

import type { ComparisonRules, ReadySource } from './text-diff.model';
import type {
  ComparisonRequest,
  CopyRequest,
  CopyResponse,
  DiffContext,
  DiffDetail,
  FindResponse,
  GapExpansion,
  LiveSource,
  LiveWorkerToMain,
  MainToLiveWorker,
  ReadyResponse,
  SourceResponse,
  WindowCursor,
  WindowResponse,
} from './text-diff.protocol';

type Listener = (event: Event) => void;
export type LiveWorkerLike = Readonly<{
  postMessage(message: MainToLiveWorker): void;
  terminate(): void;
  addEventListener(type: 'message' | 'error' | 'messageerror', listener: Listener): void;
  removeEventListener(type: 'message' | 'error' | 'messageerror', listener: Listener): void;
}>;

export class TextDiffLiveError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'TextDiffLiveError';
  }
}

type Pending = { resolve: (value: never) => void; reject: (reason: unknown) => void; kind?: 'window' | 'find'; cacheKey?: string };
type Queued = { request: MainToLiveWorker; pending: Pending };

function defaultFactory(): LiveWorkerLike {
  return new Worker(new URL('./text-diff.live.worker.ts', import.meta.url), { type: 'module' }) as unknown as LiveWorkerLike;
}

function cacheKey(input: { revision: number; cursor: WindowCursor; detail: DiffDetail; context: DiffContext; expansions: readonly GapExpansion[]; revealRow?: number }): string {
  return JSON.stringify([input.revision, input.cursor, input.detail, input.context, input.expansions, input.revealRow]);
}

/**
 * One instance owns one lazily-created worker. `readSource` is deliberately
 * independent from comparison invalidation so Original and Revised can decode
 * concurrently. The host assigns side/revision ownership to its own closure.
 */
export class TextDiffLive {
  private worker: LiveWorkerLike | null = null;
  private workerListeners: { worker: LiveWorkerLike; message: Listener; crash: Listener } | null = null;
  private destroyed = false;
  private requestId = 0;
  private comparisonRevision: number | null = null;
  private comparePending: { revision: number; resolve: (value: ReadyResponse) => void; reject: (reason: unknown) => void } | null = null;
  private pending = new Map<number, Pending>();
  private queued = new Map<'window' | 'find', Queued>();
  private latestViewRequest = { window: 0, find: 0 };
  private windows = new Map<string, WindowResponse>();
  private progressListeners = new Set<(progress: number) => void>();

  constructor(private readonly factory: () => LiveWorkerLike = defaultFactory) {}

  onProgress(listener: (progress: number) => void): () => void {
    if (this.destroyed) return () => undefined;
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  async readSource(revision: number, source: LiveSource): Promise<ReadySource> {
    this.assertActive();
    const requestId = ++this.requestId;
    return this.request<SourceResponse>({ kind: 'read', revision, requestId, source }).then((response) => response.source);
  }

  async compare(revision: number, sources: readonly [ReadySource, ReadySource], rules: ComparisonRules): Promise<ReadyResponse> {
    this.assertActive();
    this.invalidate(`Comparison ${revision} superseded the previous preview.`);
    this.comparisonRevision = revision;
    const request: ComparisonRequest = { kind: 'compare', revision, sources: sources.map((source) => ({ kind: 'text', text: source.text, name: source.name, origin: source.origin })) as [LiveSource, LiveSource], rules };
    return new Promise<ReadyResponse>((resolve, reject) => {
      this.comparePending = { revision, resolve, reject };
      this.ensureWorker().postMessage(request);
    });
  }

  window(input: { revision: number; cursor: WindowCursor; detail: DiffDetail; context: DiffContext; expansions?: readonly GapExpansion[]; revealRow?: number }): Promise<WindowResponse> {
    this.assertActive();
    const expansions = input.expansions ?? [];
    const key = cacheKey({ ...input, expansions });
    const cached = this.windows.get(key);
    if (cached) {
      this.supersedeView('window');
      return Promise.resolve(cached);
    }
    return this.queue('window', (requestId) => ({ kind: 'window', ...input, requestId, expansions }), key) as Promise<WindowResponse>;
  }

  find(input: { revision: number; query: string; matchCase: boolean; ordinal: number }): Promise<FindResponse> {
    this.assertActive();
    return this.queue('find', (requestId) => ({ kind: 'find', ...input, requestId })) as Promise<FindResponse>;
  }

  /** Requires a ready comparison. Before that, the workspace copies its accepted raw source directly. */
  copy(input: Omit<CopyRequest, 'kind' | 'requestId'>): Promise<CopyResponse> {
    this.assertActive();
    const requestId = ++this.requestId;
    return this.request<CopyResponse>({ kind: 'copy', ...input, requestId });
  }

  cancel(): void {
    if (this.destroyed) return;
    this.invalidate('Comparison cancelled.');
    this.comparisonRevision = null;
  }

  destroy(): void {
    this.cancel();
    this.destroyed = true;
    this.progressListeners.clear();
  }

  private queue(kind: 'window' | 'find', make: (requestId: number) => MainToLiveWorker, key?: string): Promise<unknown> {
    const request = make(this.supersedeView(kind));
    return new Promise((resolve, reject) => {
      this.queued.set(kind, { request, pending: { resolve: resolve as (value: never) => void, reject } });
      queueMicrotask(() => {
        const queued = this.queued.get(kind);
        if (!queued || queued.request !== request) return;
        this.queued.delete(kind);
        const requestId = (request as { requestId: number }).requestId;
        this.pending.set(requestId, { ...queued.pending, kind, cacheKey: key });
        try {
          this.ensureWorker().postMessage(request);
        } catch (error) {
          this.pending.delete(requestId);
          queued.pending.reject(new TextDiffLiveError('WorkerCrashed', `Could not start the comparison worker: ${error instanceof Error ? error.message : String(error)}`));
        }
      });
    });
  }

  private request<T extends LiveWorkerToMain>(message: MainToLiveWorker): Promise<T> {
    const requestId = (message as { requestId: number }).requestId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, { resolve: resolve as (value: never) => void, reject });
      try {
        this.ensureWorker().postMessage(message);
      } catch (error) {
        this.pending.delete(requestId);
        reject(new TextDiffLiveError('WorkerCrashed', `Could not start the comparison worker: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  }

  private ensureWorker(): LiveWorkerLike {
    this.assertActive();
    if (this.worker) return this.worker;
    const worker = this.factory();
    const message = (event: Event): void => {
      if (this.worker === worker) this.receive((event as MessageEvent<LiveWorkerToMain>).data);
    };
    const crash = (): void => {
      if (this.worker === worker) this.invalidate('The comparison worker stopped unexpectedly. Retry the comparison.', 'WorkerCrashed');
    };
    worker.addEventListener('message', message);
    worker.addEventListener('error', crash);
    worker.addEventListener('messageerror', crash);
    this.worker = worker;
    this.workerListeners = { worker, message, crash };
    return worker;
  }

  private receive(message: LiveWorkerToMain): void {
    if (message.kind === 'progress') {
      if (message.revision === this.comparisonRevision) for (const listener of this.progressListeners) listener(message.progress);
      return;
    }
    if (message.kind === 'ready') {
      if (this.comparePending?.revision === message.revision) {
        const pending = this.comparePending;
        this.comparePending = null;
        pending.resolve(message);
      }
      return;
    }
    if (message.kind === 'error') {
      if (message.requestId !== undefined) {
        const pending = this.pending.get(message.requestId);
        this.pending.delete(message.requestId);
        pending?.reject(new TextDiffLiveError(message.code, message.message));
      } else if (this.comparePending?.revision === message.revision) {
        const pending = this.comparePending;
        this.comparePending = null;
        pending.reject(new TextDiffLiveError(message.code, message.message));
      }
      return;
    }
    const requestId = message.requestId;
    const pending = this.pending.get(requestId);
    this.pending.delete(requestId);
    if (!pending) return;
    if ((message.kind === 'window' || message.kind === 'find') && requestId !== this.latestViewRequest[message.kind]) {
      pending.reject(new TextDiffLiveError('Superseded', 'A newer view response is current.'));
      return;
    }
    if (message.kind === 'window') {
      const key = pending.cacheKey;
      if (key) {
        this.windows.set(key, message);
        while (this.windows.size > 3) this.windows.delete(this.windows.keys().next().value as string);
      }
    }
    pending.resolve(message as never);
  }

  private supersedeView(kind: 'window' | 'find'): number {
    const selection = ++this.requestId;
    this.latestViewRequest[kind] = selection;
    const queued = this.queued.get(kind);
    if (queued) {
      queued.pending.reject(new TextDiffLiveError('Superseded', 'A newer view request replaced this one.'));
      this.queued.delete(kind);
    }
    for (const [requestId, pending] of this.pending) {
      if (pending.kind === kind) {
        this.pending.delete(requestId);
        pending.reject(new TextDiffLiveError('Superseded', 'A newer view request replaced this one.'));
      }
    }
    return selection;
  }

  private assertActive(): void {
    if (this.destroyed) throw new TextDiffLiveError('Destroyed', 'The Text Diff preview has been destroyed.');
  }

  private invalidate(reason: string, code = 'Superseded'): void {
    const listeners = this.workerListeners;
    if (listeners) {
      listeners.worker.removeEventListener('message', listeners.message);
      listeners.worker.removeEventListener('error', listeners.crash);
      listeners.worker.removeEventListener('messageerror', listeners.crash);
      listeners.worker.terminate();
    }
    this.workerListeners = null;
    this.worker = null;
    this.windows.clear();
    this.comparePending?.reject(new TextDiffLiveError(code, reason));
    this.comparePending = null;
    for (const pending of this.pending.values()) pending.reject(new TextDiffLiveError(code, reason));
    this.pending.clear();
    for (const queued of this.queued.values()) queued.pending.reject(new TextDiffLiveError(code, reason));
    this.queued.clear();
  }
}
