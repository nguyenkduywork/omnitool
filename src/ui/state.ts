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
export type FileEntry = { readonly file: File; readonly type: string };

export type Phase =
  | 'browsing'     // no files, no tool: the catalogue
  | 'filtered'     // files in, no tool picked
  | 'tool-picked'  // tool picked, still missing what it needs
  | 'ready'        // Run is live
  | 'running'
  | 'results';

export type Snapshot = {
  phase: Phase;
  /** A defensive copy of readonly-fielded entries: splicing it, or writing to
   *  an entry's `file`/`type`, cannot corrupt the store's own mime tracking. */
  entries: readonly FileEntry[];
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
 * True only for a hard TYPE mismatch — nothing about adding more files of the
 * SAME kind could ever fix it. Never true for a mere count shortfall,
 * including zero files loaded: that is an invitation ("needs 2 files, bring
 * them"), not a refusal, the same way the cold catalogue's cards are all
 * clickable with nothing loaded yet.
 *
 * This is the one piece of `runBlockedReason`'s logic the palette needs
 * SEPARATELY from the reason string itself (see palette.ts's `commit`): the
 * string alone cannot tell a "doesn't work with these files" refusal apart
 * from a "needs at least 2 files" invitation without re-parsing English.
 */
export function typeMismatch(selected: ToolDef, mimes: string[]): boolean {
  if (selected.kind === 'generate') return false;
  return mimes.length > 0 && !typesMatch(selected, mimes);
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
   *
   * Gated on `running`: a job already holds its own copy of the file list
   * (`shell.ts`'s `start()` reads `snap.entries` once, before the run
   * starts), so nothing about a LATER file change can affect what it is
   * doing. But `pruneSelection` changing `selected` behind the shell's back
   * is exactly what used to tear down the run's own controls out from under
   * it — `refreshTools`'s prune-teardown (shell.ts) reacts to a selection
   * dropping to null by tearing down the options panel and, via
   * `clearSelection`, the whole `.run` card the Cancel button and progress
   * ring live in. Skipping the prune while a job is running is what keeps
   * that card on screen, Cancel reachable and the job stoppable, for as long
   * as it is actually running — see tests/unit/state.test.ts's "does not
   * prune the selection while a job is running".
   */
  function pruneSelection(): void {
    if (running) return;
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
      hasResults = false;
      pruneSelection();
      emit();
    },
    clearFiles() {
      // I2: identical to `setFiles([])`, on purpose — an empty tray is a COUNT
      // shortfall ("you have none"), never a TYPE mismatch, and
      // `pruneSelection` already knows that (it is gated on `entries.length >
      // 0`). Nulling `selected` unconditionally here, as this used to do, gave
      // "Remove all files" and "remove every file one at a time" — the two
      // routes to the exact same zero-files state — opposite outcomes: the
      // tray's own per-row `x` left TOOL PICKED (spec §4.2) selected and
      // waiting for files, while this button discarded the pick entirely and
      // fell all the way back to the cold hero. Letting `pruneSelection`
      // decide, the same as every other file-count change already does, makes
      // both routes agree.
      entries = [];
      hasResults = false;
      pruneSelection();
      emit();
    },
    /**
     * Installs `id` WITHOUT the type check `pruneSelection` applies. The
     * asymmetry is deliberate, not an oversight — the two answer different
     * questions:
     *
     *   pruneSelection: "the files changed under a tool the user already
     *     picked; should it survive?" No — its options now describe files
     *     that are not there, and the user did not ask for this.
     *   selectTool: "the user just asked for this tool." Honour it. A route
     *     to `#/pdf-merge` with a PNG loaded then shows the tool with
     *     `runBlockedReason`'s own "Merge PDFs doesn't work with these
     *     files.", Run disabled, and "Change tool" as the way out.
     *
     * Refusing instead would drop the request on the floor and send the user
     * back to a catalogue that never explains why their bookmark did not
     * open. An honest, self-explaining screen beats a silently ignored
     * navigation, so the catalogue having no card for it is accepted: the
     * work zone is what does the explaining.
     *
     * Pinned by "honours a type-mismatched selection rather than refusing it"
     * in tests/unit/state.test.ts, so changing it is a decision.
     */
    selectTool(id) {
      selected = id === null ? null : (tools.find((tool) => tool.id === id) ?? null);
      hasResults = false;
      emit();
    },
    setRunning(on) {
      running = on;
      if (on) hasResults = false;
      // The moment a run ENDS, re-assert the invariant `pruneSelection`
      // enforces everywhere else: a selection whose type no longer matches
      // the files is dropped. While `running` was true, a file change could
      // have made that true without anything acting on it (see
      // `pruneSelection`'s own comment) — catching up here, rather than
      // waiting for the next unrelated `addFiles`/`setFiles`, means a stale
      // mismatch never outlives the run that protected it a moment longer
      // than it has to.
      if (!on) pruneSelection();
      emit();
    },
    setResults(shown) {
      hasResults = shown;
      emit();
    },
  };
}
