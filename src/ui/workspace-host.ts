// Lazily loaded shell adapter for tools that own their input sources.
import type {
  Job,
  PreparedToolRun,
  ToolDef,
  ToolWorkspace,
  ToolWorkspaceHandle,
  WorkspaceExportFormat,
} from '../types';
import type { ResultsHandle } from './results';

export type WorkspaceHostHandle = {
  activate(tool: ToolDef, trayFiles: readonly File[]): Promise<void>;
  deactivate(): void;
  destroy(): void;
};

type ExportAttempt = { cancelled: boolean; job: Job | null };

export function createWorkspaceHost(init: {
  mount: HTMLElement;
  results: ResultsHandle;
  announce(message: string): void;
  back(): void;
  loadPipeline?: () => Promise<{ run: typeof import('../core/pipeline').run }>;
}): WorkspaceHostHandle {
  let active = false;
  let destroyed = false;
  let generation = 0;
  let tool: ToolDef | null = null;
  let handle: ToolWorkspaceHandle | null = null;
  let loadedFor: string | null = null;
  let loading: Promise<{ default: ToolWorkspace }> | null = null;
  let loadingFor: string | null = null;
  let attempt: ExportAttempt | null = null;
  let readyToken: object | null = null;
  let lastTrayFiles: readonly File[] = [];

  function cancelExport(): void {
    const current = attempt;
    if (!current) return;
    current.cancelled = true;
    attempt = null;
    current.job?.cancel();
    readyToken = null;
    handle?.setJobState({ phase: 'cancelled' });
    init.announce('Export cancelled.');
  }

  async function exportSnapshot(format: WorkspaceExportFormat): Promise<void> {
    if (!active || destroyed || !tool || !handle || attempt) return;
    const workspace = handle;
    const selected = tool;
    let prepared: PreparedToolRun;
    try {
      // This MUST precede the first await: the displayed revision is frozen
      // before the pipeline chunk can load or a source can change.
      prepared = workspace.prepareRun(format);
    } catch (error) {
      workspace.setJobState({
        phase: 'failed',
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const current: ExportAttempt = { cancelled: false, job: null };
    attempt = current;
    readyToken = null;
    const cancel = (): void => {
      if (attempt === current) cancelExport();
    };
    workspace.setJobState({ phase: 'preparing', progress: 0, cancel });
    init.results.clear();
    init.announce('Preparing comparison export…');

    const isCurrent = (): boolean =>
      !destroyed && active && attempt === current && !current.cancelled && handle === workspace;

    try {
      const { run } = await (init.loadPipeline?.() ?? import('../core/pipeline'));
      if (!isCurrent()) return; // Cancelled while the chunk was loading.
      const job = run(selected.id, prepared.files, prepared.options, { cancelImmediately: true });
      current.job = job;
      workspace.setJobState({ phase: 'running', progress: 0, cancel });
      job.onProgress((progress) => {
        if (isCurrent()) workspace.setJobState({ phase: 'running', progress, cancel });
      });
      const result = await job.done;
      if (!isCurrent()) return;
      const output = result.outputs[0];
      if (!output) throw new Error('The export produced no output.');
      await init.results.show({
        toolName: selected.name,
        inputs: prepared.inputs,
        result,
        showSizeDelta: false,
      });
      if (!isCurrent()) return;
      const token = {};
      readyToken = token;
      workspace.setJobState({
        phase: 'ready',
        revision: prepared.revision,
        format,
        outputName: output.name,
        revealOutput: () => {
          if (active && !destroyed && readyToken === token) init.results.revealOutput(output.name);
        },
      });
      init.announce(`${selected.name} export ready. Download ${output.name} from the results.`);
    } catch (error) {
      if (!isCurrent()) return;
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
      if (code === 'Cancelled') {
        workspace.setJobState({ phase: 'cancelled' });
        init.announce('Export cancelled.');
      } else {
        const message = error instanceof Error ? error.message : String(error);
        workspace.setJobState({ phase: 'failed', message });
        init.announce(`Export failed: ${message}`);
      }
    } finally {
      if (attempt === current) attempt = null;
      current.job = null;
    }
  }

  function showLoadError(message: string): void {
    init.mount.replaceChildren();
    const panel = document.createElement('div');
    panel.className = 'workspace-host__error';
    panel.setAttribute('role', 'alert');
    const explanation = document.createElement('p');
    explanation.textContent = `The workspace could not load: ${message}`;
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = 'Retry workspace';
    retry.addEventListener('click', () => {
      if (tool && active) void activate(tool, lastTrayFiles);
    });
    const back = document.createElement('button');
    back.type = 'button';
    back.textContent = 'Back to tools';
    back.addEventListener('click', init.back);
    panel.append(explanation, retry, back);
    init.mount.append(panel);
    retry.focus();
  }

  async function activate(next: ToolDef, trayFiles: readonly File[]): Promise<void> {
    if (destroyed || !next.workspace) return;
    const mine = ++generation;
    active = true;
    lastTrayFiles = [...trayFiles];
    if (handle && loadedFor !== next.id) {
      cancelExport();
      handle.destroy();
      handle = null;
      loadedFor = null;
      init.mount.replaceChildren();
    }
    tool = next;
    if (handle) {
      try {
        handle.activate(lastTrayFiles);
        handle.focusPrimary();
      } catch (error) {
        handle.destroy();
        handle = null;
        loadedFor = null;
        showLoadError(error instanceof Error ? error.message : String(error));
      }
      return;
    }

    init.mount.textContent = `Loading ${next.name}…`;
    try {
      if (!loading || loadingFor !== next.id) {
        loadingFor = next.id;
        loading = next.workspace();
      }
      const module = await loading;
      if (destroyed || !active || mine !== generation || tool?.id !== next.id) return;
      init.mount.replaceChildren();
      handle = module.default(init.mount, {
        announce: init.announce,
        onRun: (format) => void exportSnapshot(format),
      });
      loadedFor = next.id;
      handle.activate(lastTrayFiles);
      handle.focusPrimary();
    } catch (error) {
      if (destroyed || !active || mine !== generation) return;
      handle?.destroy();
      handle = null;
      loadedFor = null;
      loading = null; // Retry must really retry a failed import.
      loadingFor = null;
      showLoadError(error instanceof Error ? error.message : String(error));
    }
  }

  function deactivate(): void {
    generation += 1;
    active = false;
    cancelExport();
    readyToken = null;
    handle?.setJobState({ phase: 'idle' });
    handle?.deactivate();
    init.results.clear();
  }

  return {
    activate,
    deactivate,
    destroy(): void {
      if (destroyed) return;
      deactivate();
      destroyed = true;
      handle?.destroy();
      handle = null;
      init.mount.replaceChildren();
    },
  };
}
