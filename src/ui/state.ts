// src/ui/state.ts — the shell's state machine. NO DOM.
//
// Everything the shell decides lives here so it can be tested under plain
// Node, which was impossible while it was tangled into 647 lines of DOM
// wiring. The rule is enforced by eslint: this module may not touch
// `document`, `window` or `HTMLElement`. It holds `File` objects, which are
// data, not DOM.

import { applicabilityFor, countReason, typesMatch } from '../core/format';
import type { Applicability } from '../core/format';
import type { ToolDef } from '../types';

/** A file plus the type its MAGIC BYTES said it was — never the extension. */
export type FileEntry = { file: File; type: string };

export type Phase =
  | 'browsing'     // no files, no tool: the catalogue
  | 'filtered'     // files in, no tool picked
  | 'tool-picked'  // tool picked, still missing what it needs
  | 'ready'        // Run is live
  | 'running'
  | 'results';

export type Snapshot = {
  phase: Phase;
  entries: FileEntry[];
  selected: ToolDef | null;
  applicability: Applicability;
  /** null when Run is enabled; otherwise why it is not. */
  runBlockedReason: string | null;
};

export type PhaseInput = {
  fileCount: number;
  selected: ToolDef | null;
  /** runBlockedReason()'s answer for these same inputs. */
  runBlocked: string | null;
  running: boolean;
  hasResults: boolean;
};

/**
 * Why the selected tool cannot run right now, or null when it can.
 *
 * A generator is never blocked: it reads no file, so no file set can be wrong
 * for it. That single branch is what makes the QR code reachable from cold.
 */
export function runBlockedReason(selected: ToolDef | null, mimes: string[]): string | null {
  if (!selected) return 'Pick a tool first.';
  if (selected.kind === 'generate') return null;
  if (mimes.length > 0 && !typesMatch(selected, mimes)) {
    return `${selected.name} doesn't work with these files.`;
  }
  return countReason(selected, mimes.length);
}

/**
 * A pure fold over the four things that decide what the screen shows.
 *
 * It takes `runBlocked` rather than recomputing it because the reason a tool
 * cannot run — wrong count, wrong type — is not this function's business:
 * anything that blocks the run leaves the tool merely PICKED.
 */
export function derivePhase(input: PhaseInput): Phase {
  const { fileCount, selected, runBlocked, running, hasResults } = input;
  if (running) return 'running';
  if (hasResults) return 'results';
  if (!selected) return fileCount === 0 ? 'browsing' : 'filtered';
  return runBlocked === null ? 'ready' : 'tool-picked';
}

export type StateHandle = {
  snapshot(): Snapshot;
  /** Returns an unsubscribe function. */
  subscribe(fn: (snapshot: Snapshot) => void): () => void;
  addFiles(entries: FileEntry[]): void;
  setFiles(entries: FileEntry[]): void;
  clearFiles(): void;
  selectTool(id: string | null): void;
  setRunning(on: boolean): void;
  setResults(shown: boolean): void;
};

export function createState(tools: readonly ToolDef[]): StateHandle {
  let entries: FileEntry[] = [];
  let selected: ToolDef | null = null;
  let running = false;
  let hasResults = false;
  const listeners = new Set<(snapshot: Snapshot) => void>();

  const mimes = (): string[] => entries.map((entry) => entry.type);

  function snapshot(): Snapshot {
    const currentMimes = mimes();
    const blocked = runBlockedReason(selected, currentMimes);
    return {
      phase: derivePhase({
        fileCount: entries.length,
        selected,
        runBlocked: blocked,
        running,
        hasResults,
      }),
      entries: [...entries],
      selected,
      applicability: applicabilityFor(tools, currentMimes),
      runBlockedReason: blocked,
    };
  }

  function emit(): void {
    const current = snapshot();
    for (const listener of listeners) listener(current);
  }

  /**
   * A transform whose TYPE no longer matches is dropped — its options would
   * describe files that are not there. A count shortfall is NOT a reason to
   * drop it: "you need one more PDF" is a better answer than a cleared panel.
   * A generator never depended on the files at all.
   */
  function pruneSelection(): void {
    if (!selected || selected.kind === 'generate') return;
    if (entries.length > 0 && !typesMatch(selected, mimes())) selected = null;
  }

  return {
    snapshot,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    addFiles(added) {
      if (added.length === 0) return;
      entries = [...entries, ...added];
      hasResults = false;
      pruneSelection();
      emit();
    },
    setFiles(next) {
      entries = [...next];
      pruneSelection();
      emit();
    },
    clearFiles() {
      entries = [];
      selected = null;
      hasResults = false;
      emit();
    },
    selectTool(id) {
      selected = id === null ? null : (tools.find((tool) => tool.id === id) ?? null);
      hasResults = false;
      emit();
    },
    setRunning(on) {
      running = on;
      if (on) hasResults = false;
      emit();
    },
    setResults(shown) {
      hasResults = shown;
      emit();
    },
  };
}
