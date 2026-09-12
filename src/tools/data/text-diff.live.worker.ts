// Real module-worker entry for live Text Diff comparison. It owns decoding,
// comparison, searching and serialization; the main thread only routes state.

import { diffLines } from './diff';
import { buildViewIndex, findText, formatChanges, readRowWindow, type ViewIndex } from './diff-view';
import { MAX_EXPORT_BYTES, TextDiffExportError } from './text-diff.export';
import { MAX_COMPARISON_BYTES, TextDiffModelError, comparisonIdentity, createComparisonSnapshot, type ReadySource, type SourceInput } from './text-diff.model';
import type { ComparisonRequest, LiveErrorCode, LiveSource, LiveWorkerToMain, MainToLiveWorker, ReadyResponse } from './text-diff.protocol';

type WorkerState = { revision: number; index: ViewIndex } | null;
type Send = (message: LiveWorkerToMain) => void;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): LiveErrorCode {
  if (error instanceof TextDiffModelError) return error.code === 'InvalidText' ? 'InvalidText' : error.code;
  if (error instanceof TextDiffExportError) return 'ExportTooLarge';
  return 'Internal';
}

function sourceInput(source: LiveSource, text: string): SourceInput {
  return { text, name: source.name, origin: source.kind === 'file' ? 'file' : source.origin };
}

function validateSingle(source: SourceInput): ReadySource {
  // The public model deliberately only validates complete comparisons. An
  // explicit empty peer supplies that boundary without claiming it is provided
  // in the eventual session.
  return createComparisonSnapshot({
    revision: 0,
    sources: [source, { text: '', name: '', origin: 'empty' }],
    rules: { ignoreWhitespace: false, ignoreCase: false },
  }).sources[0];
}

async function readSource(source: LiveSource): Promise<ReadySource> {
  if (source.kind === 'text') return validateSingle(sourceInput(source, source.text));
  if (source.file.size > MAX_COMPARISON_BYTES) {
    throw new TextDiffModelError('TooLarge', `Text Diff supports at most ${MAX_COMPARISON_BYTES} combined UTF-8 bytes.`);
  }
  let bytes: ArrayBuffer;
  try {
    bytes = await source.file.arrayBuffer();
  } catch (error) {
    const wrapped = new Error(`Could not read ${source.name}: ${messageOf(error)}`);
    wrapped.name = 'FileRead';
    throw wrapped;
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    const wrapped = new Error(`${source.name} is not valid UTF-8 text.`);
    wrapped.name = 'InvalidEncoding';
    throw wrapped;
  }
  return validateSingle(sourceInput(source, text));
}

function specialCode(error: unknown): LiveErrorCode | null {
  if (error instanceof Error && error.name === 'FileRead') return 'FileRead';
  if (error instanceof Error && error.name === 'InvalidEncoding') return 'InvalidEncoding';
  return null;
}

async function snapshotFor(request: ComparisonRequest) {
  const sources = await Promise.all(request.sources.map(readSource));
  return createComparisonSnapshot({
    revision: request.revision,
    sources: sources.map((source) => ({ text: source.text, name: source.name, origin: source.origin })) as [SourceInput, SourceInput],
    rules: request.rules,
  });
}

export function createLiveWorker(send: Send): { handle(message: MainToLiveWorker): Promise<void> } {
  let state: WorkerState = null;
  const fail = (revision: number, error: unknown, requestId?: number): void => {
    send({ kind: 'error', revision, ...(requestId === undefined ? {} : { requestId }), code: specialCode(error) ?? errorCode(error), message: messageOf(error) });
  };

  return {
    async handle(message): Promise<void> {
      try {
        if (message.kind === 'read') {
          const source = await readSource(message.source);
          send({ kind: 'source', revision: message.revision, requestId: message.requestId, source });
          return;
        }
        if (message.kind === 'compare') {
          send({ kind: 'progress', revision: message.revision, progress: 0.1 });
          const snapshot = await snapshotFor(message);
          send({ kind: 'progress', revision: message.revision, progress: 0.35 });
          const result = diffLines(snapshot.sources[0].text, snapshot.sources[1].text, snapshot.rules);
          const index = buildViewIndex(snapshot, result);
          state = { revision: message.revision, index };
          send({ kind: 'ready', revision: message.revision, snapshot, identity: comparisonIdentity(snapshot), stats: result.stats,
            sourceMeta: [result.a, result.b].map((source) => ({ lineCount: source.lines.length, ending: source.ending, hasBom: source.hasBom, endsWithNewline: source.endsWithNewline })) as unknown as ReadyResponse['sourceMeta'],
            logicalRows: index.logicalRows, hunks: index.hunks, notices: result.degraded ? ['A tangled region uses coarse line alignment.'] : [] });
          return;
        }
        if (!state || state.revision !== message.revision) {
          send({ kind: 'error', revision: message.revision, requestId: message.requestId, code: 'NotReady', message: 'This comparison is no longer available. Retry it.' });
          return;
        }
        if (message.kind === 'window') {
          const window = readRowWindow(state.index, message);
          send({ kind: 'window', revision: message.revision, requestId: message.requestId, ...window });
          return;
        }
        if (message.kind === 'find') {
          send({ kind: 'find', revision: message.revision, requestId: message.requestId, ...findText(state.index, message.query, message.matchCase, message.ordinal) });
          return;
        }
        const copySide = message.range?.side ?? message.side ?? 'a';
        const text = message.copy === 'source'
          ? state.index.snapshot.sources[copySide === 'b' ? 1 : 0].text.slice(message.range?.start ?? 0, message.range?.end)
          : formatChanges(state.index, message.context ?? 3);
        if (new TextEncoder().encode(text).byteLength > MAX_EXPORT_BYTES) throw new TextDiffExportError('TooLarge', `This export exceeds the ${MAX_EXPORT_BYTES} byte limit.`);
        send({ kind: 'copy', revision: message.revision, requestId: message.requestId, copy: message.copy, text });
      } catch (error) {
        fail(message.revision, error, message.kind === 'compare' ? undefined : message.requestId);
      }
    },
  };
}

const scope = globalThis as typeof globalThis & { postMessage?: (message: LiveWorkerToMain) => void; addEventListener?: (type: string, listener: (event: MessageEvent<MainToLiveWorker>) => void) => void; document?: unknown };
if (typeof scope.postMessage === 'function' && typeof scope.addEventListener === 'function' && !scope.document) {
  const worker = createLiveWorker((message) => scope.postMessage?.(message));
  scope.addEventListener('message', (event) => { void worker.handle(event.data); });
}
