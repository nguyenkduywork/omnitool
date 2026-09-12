import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountShell } from '../../src/ui/shell';
import { createWorkspaceHost } from '../../src/ui/workspace-host';
import { createResults } from '../../src/ui/results';
import type { ResultsHandle, ResultsView } from '../../src/ui/results';
import type {
  Job, JobResult, PreparedToolRun, ToolDef, ToolWorkspaceHandle, WorkspaceExportFormat,
  WorkspaceJobState,
} from '../../src/types';

const roots: HTMLElement[] = [];
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const root of roots.splice(0)) root.remove();
  location.hash = '';
});

function element(): HTMLElement {
  const root = document.createElement('div');
  document.body.append(root);
  roots.push(root);
  return root;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function until(ready: () => boolean): Promise<void> {
  const start = performance.now();
  while (!ready()) {
    if (performance.now() - start > 3000) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function fixture() {
  const states: WorkspaceJobState[] = [];
  const activations: (readonly File[])[] = [];
  const focus = vi.fn();
  const deactivate = vi.fn();
  const destroy = vi.fn();
  let onRun!: (format: WorkspaceExportFormat) => void;
  const prepared: PreparedToolRun = {
    revision: 7,
    files: [],
    options: { comparisonSnapshot: { revision: 7, sources: ['original', 'revised'] }, format: 'html' },
    inputs: [{ name: 'original.txt', size: 8, type: 'text/plain' },
      { name: 'revised.txt', size: 9, type: 'text/plain' }],
  };
  const handle: ToolWorkspaceHandle = {
    activate: (files) => activations.push(files),
    deactivate,
    destroy,
    focusPrimary: focus,
    prepareRun: () => prepared,
    setJobState: (state) => states.push(state),
  };
  const factory = vi.fn((_mount: HTMLElement, host: { onRun(format: WorkspaceExportFormat): void }) => {
    onRun = host.onRun;
    return handle;
  });
  const tool: ToolDef = {
    id: 'test-workspace', name: 'Test workspace', blurb: 'Owns sources', group: 'data',
    kind: 'transform', accepts: ['text/plain'], minInputs: 2, maxInputs: 2,
    workspace: () => Promise.resolve({ default: factory }),
    load: () => Promise.reject(new Error('not used')),
  };
  return { tool, handle, states, activations, focus, deactivate, destroy, factory, prepared,
    run: (format: WorkspaceExportFormat) => onRun(format) };
}

function results() {
  const shown: ResultsView[] = [];
  const clear = vi.fn();
  const revealOutput = vi.fn();
  const handle: ResultsHandle = {
    el: element(),
    show: async (view) => { shown.push(view); },
    clear,
    revealOutput,
  };
  return { handle, shown, clear, revealOutput };
}

describe('lazy workspace host', () => {
  it('rejects an unavailable snapshot before loading the pipeline', async () => {
    const source = fixture();
    source.handle.prepareRun = () => { throw new Error('Compare both sources first.'); };
    const loadPipeline = vi.fn();
    const host = createWorkspaceHost({ mount: element(), results: results().handle,
      announce: () => undefined, back: () => undefined, loadPipeline });
    cleanups.push(() => host.destroy());
    await host.activate(source.tool, []);
    source.run('html');
    expect(source.states.at(-1)).toEqual({ phase: 'failed', message: 'Compare both sources first.' });
    expect(loadPipeline).not.toHaveBeenCalled();
  });

  it('ignores a workspace import that resolves after navigation', async () => {
    const source = fixture();
    const pending = deferred<{ default: typeof source.factory }>();
    source.tool.workspace = () => pending.promise;
    const host = createWorkspaceHost({ mount: element(), results: results().handle,
      announce: () => undefined, back: () => undefined });
    cleanups.push(() => host.destroy());
    const loading = host.activate(source.tool, []);
    host.deactivate();
    pending.resolve({ default: source.factory });
    await loading;
    expect(source.factory).not.toHaveBeenCalled();
    expect(source.focus).not.toHaveBeenCalled();
  });

  it('caches the handle and retains first-use tray candidates through a failed-load retry', async () => {
    const source = fixture();
    let calls = 0;
    source.tool.workspace = () => ++calls === 1
      ? Promise.reject(new Error('offline chunk'))
      : Promise.resolve({ default: source.factory });
    const mount = element();
    const host = createWorkspaceHost({ mount, results: results().handle,
      announce: () => undefined, back: () => undefined });
    cleanups.push(() => host.destroy());
    const original = new File(['a'], 'original.txt');
    await host.activate(source.tool, [original]);
    expect(mount.textContent).toContain('Retry workspace');
    mount.querySelector<HTMLButtonElement>('button')!.click();
    await until(() => source.activations.length === 1);
    expect(source.activations[0]).toEqual([original]);
    host.deactivate();
    await host.activate(source.tool, [original]);
    expect(source.factory).toHaveBeenCalledTimes(1);
    expect(source.activations).toHaveLength(2);
    expect(source.focus).toHaveBeenCalledTimes(2);
    expect(source.destroy).not.toHaveBeenCalled();
  });

  it('pre-import cancel prevents dispatch, and a later ready export uses only prepared provenance', async () => {
    const source = fixture();
    const tray = new File(['unrelated'], 'unrelated.pdf');
    const view = results();
    const pending = deferred<{ run: typeof import('../../src/core/pipeline').run }>();
    const run = vi.fn((_id: string, _files: File[], _options: Record<string, unknown>) => {
      const value: JobResult = {
        outputs: [{ name: 'comparison.html', type: 'text/html', buffer: new TextEncoder().encode('report').buffer }],
        results: [], partial: false,
      };
      return { id: 'fake', done: Promise.resolve(value), cancel: vi.fn(), onProgress: vi.fn() } as Job;
    });
    const host = createWorkspaceHost({ mount: element(), results: view.handle,
      announce: () => undefined, back: () => undefined,
      loadPipeline: () => pending.promise });
    cleanups.push(() => host.destroy());
    await host.activate(source.tool, [tray]);
    source.run('html');
    expect(source.states.at(-1)?.phase).toBe('preparing');
    const preparing = source.states.at(-1);
    if (preparing?.phase !== 'preparing') throw new Error('missing preparing state');
    preparing.cancel();
    pending.resolve({ run: run as unknown as typeof import('../../src/core/pipeline').run });
    await until(() => source.states.at(-1)?.phase === 'cancelled');
    expect(run).not.toHaveBeenCalled();

    source.run('html');
    await until(() => source.states.at(-1)?.phase === 'preparing');
    await until(() => run.mock.calls.length === 1);
    await until(() => source.states.at(-1)?.phase === 'ready');
    expect(run.mock.calls[0]![1]).toEqual([]);
    expect(run.mock.calls[0]![2]).toBe(source.prepared.options);
    expect(view.shown[0]?.inputs).toEqual(source.prepared.inputs);
    expect(view.shown[0]?.showSizeDelta).toBe(false);
    const ready = source.states.at(-1);
    if (ready?.phase !== 'ready') throw new Error('missing ready state');
    ready.revealOutput();
    expect(view.revealOutput).toHaveBeenCalledWith('comparison.html');
    host.deactivate();
    ready.revealOutput();
    expect(view.revealOutput).toHaveBeenCalledTimes(1);
    expect(source.states.at(-1)?.phase).toBe('idle');
    await host.activate(source.tool, []);
    expect(source.states.at(-1)?.phase).toBe('idle');
  });
});

describe('results adapter', () => {
  it('focuses the named download and omits a misleading one-source size comparison', async () => {
    const tray = createResults();
    const root = element();
    root.append(tray.el);
    const bytes = new TextEncoder().encode('a short patch');
    await tray.show({
      toolName: 'Test workspace',
      inputs: [{ name: 'original.patch', size: 100, type: 'text/plain' }],
      showSizeDelta: false,
      result: { outputs: [{ name: 'original.patch', type: 'text/plain', buffer: bytes.buffer }],
        results: [], partial: false },
    });
    tray.revealOutput('original.patch');
    expect(document.activeElement).toBe(root.querySelector('.card__head button'));
    expect(root.querySelector('.card__meta')?.textContent).not.toMatch(/smaller|larger|same size/i);
    tray.clear();
  });
});

describe('shell workspace route', () => {
  it('does not mount a late workspace after the route has left', async () => {
    const source = fixture();
    const pending = deferred<{ default: typeof source.factory }>();
    let loading = false;
    source.tool.workspace = () => { loading = true; return pending.promise; };
    location.hash = `#/${source.tool.id}`;
    const root = element();
    const shell = mountShell(root, [source.tool]);
    cleanups.push(() => shell.destroy());
    await until(() => loading);
    location.hash = '#/';
    await until(() => root.querySelector<HTMLElement>('.workspace-host')!.hidden);
    pending.resolve({ default: source.factory });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(source.factory).not.toHaveBeenCalled();
    expect(source.focus).not.toHaveBeenCalled();
  });

  it('opens full-width beside the workbench, keeps the tray, and restores focus on return', async () => {
    const source = fixture();
    location.hash = `#/${source.tool.id}`;
    const root = element();
    const shell = mountShell(root, [source.tool]);
    cleanups.push(() => shell.destroy());
    await until(() => source.activations.length === 1);
    const slot = root.querySelector<HTMLElement>('.workspace-host')!;
    expect(slot.previousElementSibling?.classList.contains('workbench')).toBe(true);
    expect(root.querySelector<HTMLElement>('.workbench')?.hidden).toBe(true);
    expect(slot.hidden).toBe(false);
    location.hash = '#/';
    await until(() => source.deactivate.mock.calls.length === 1);
    expect(root.querySelector<HTMLElement>('.workbench')?.hidden).toBe(false);
    location.hash = `#/${source.tool.id}`;
    await until(() => source.activations.length === 2);
    expect(source.factory).toHaveBeenCalledTimes(1);
    expect(source.focus).toHaveBeenCalledTimes(2);
  });

  it('keeps unrelated tray files untouched and palette selection does not run the operation', async () => {
    const source = fixture();
    const root = element();
    const shell = mountShell(root, [source.tool]);
    cleanups.push(() => shell.destroy());
    const picker = root.querySelector<HTMLInputElement>('input[type="file"]')!;
    const files = [new File(['a'], 'a.pdf'), new File(['b'], 'b.png'),
      new File(['c'], 'c.zip')];
    const transfer = new DataTransfer();
    for (const file of files) transfer.items.add(file);
    picker.files = transfer.files;
    picker.dispatchEvent(new Event('change'));
    await until(() => root.querySelectorAll('.tray__item').length === 3);

    root.querySelector<HTMLButtonElement>('.searchbtn')!.click();
    const input = document.querySelector<HTMLInputElement>('.palette__input')!;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await until(() => source.activations.length === 1);
    expect(source.activations[0]).toEqual(files);
    expect(root.querySelectorAll('.tray__item')).toHaveLength(3);
    expect(root.querySelector<HTMLElement>('.workbench')?.hidden).toBe(true);
    expect(root.querySelector('.results:not([hidden])')).toBeNull();
  });
});
