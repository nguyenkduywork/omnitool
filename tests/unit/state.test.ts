import { describe, expect, it, vi } from 'vitest';

import { TOOLS, getTool } from '../../src/core/registry';
import { createState, derivePhase, runBlockedReason } from '../../src/ui/state';
import type { FileEntry } from '../../src/ui/state';

function entry(name: string, type: string): FileEntry {
  return { file: new File([new Uint8Array([1, 2, 3])], name, { type }), type };
}

const PDF = 'application/pdf';
const pdf = (n = 'a.pdf'): FileEntry => entry(n, PDF);

describe('derivePhase — spec §4.2', () => {
  // `runBlocked` is runBlockedReason()'s answer for the same inputs. Passing
  // it in rather than recomputing keeps derivePhase a pure fold with no
  // opinion about WHY a tool is blocked.
  const base = {
    fileCount: 0,
    selected: null,
    runBlocked: 'Pick a tool first.' as string | null,
    running: false,
    hasResults: false,
  };
  const merge = getTool('pdf-merge')!;

  it('is browsing with nothing loaded and nothing picked', () => {
    expect(derivePhase(base)).toBe('browsing');
  });

  it('is filtered once files land with no tool picked', () => {
    expect(derivePhase({ ...base, fileCount: 2 })).toBe('filtered');
  });

  it('is tool-picked when a file tool is chosen with no files', () => {
    expect(
      derivePhase({ ...base, selected: merge, runBlocked: 'Needs at least 2 files — you have none.' }),
    ).toBe('tool-picked');
  });

  // The QR fix, as one transition: a generator is never blocked, so it is READY.
  it('goes straight to ready for a generator with no files', () => {
    expect(
      derivePhase({ ...base, selected: getTool('qr-generate')!, runBlocked: null }),
    ).toBe('ready');
  });

  it('is ready once the picked tool has what it needs', () => {
    expect(derivePhase({ ...base, fileCount: 2, selected: merge, runBlocked: null })).toBe('ready');
  });

  it('stays tool-picked while anything still blocks the run', () => {
    expect(
      derivePhase({ ...base, fileCount: 1, selected: merge, runBlocked: 'Needs at least 2 files — you have 1.' }),
    ).toBe('tool-picked');
    // A type mismatch holds it back exactly the same way.
    expect(
      derivePhase({ ...base, fileCount: 2, selected: merge, runBlocked: "Merge PDFs doesn't work with these files." }),
    ).toBe('tool-picked');
  });

  it('reports running and results', () => {
    const ready = { ...base, fileCount: 2, selected: merge, runBlocked: null };
    expect(derivePhase({ ...ready, running: true })).toBe('running');
    expect(derivePhase({ ...ready, hasResults: true })).toBe('results');
  });
});

describe('runBlockedReason', () => {
  it('asks for a tool when none is picked', () => {
    expect(runBlockedReason(null, [])).toBe('Pick a tool first.');
  });

  it('never blocks a generator', () => {
    expect(runBlockedReason(getTool('qr-generate')!, [])).toBeNull();
  });

  it('reports the count shortfall', () => {
    expect(runBlockedReason(getTool('pdf-merge')!, [PDF])).toBe('Needs at least 2 files — you have 1.');
  });

  it('reports a type mismatch by name', () => {
    expect(runBlockedReason(getTool('pdf-merge')!, [PDF, 'image/png'])).toBe(
      "Merge PDFs doesn't work with these files.",
    );
  });

  it('is null when the tool can run', () => {
    expect(runBlockedReason(getTool('pdf-merge')!, [PDF, PDF])).toBeNull();
  });
});

describe('createState', () => {
  it('notifies subscribers and reflects added files', () => {
    const state = createState(TOOLS);
    const seen = vi.fn();
    state.subscribe(seen);

    state.addFiles([pdf('one.pdf'), pdf('two.pdf')]);

    expect(seen).toHaveBeenCalledTimes(1);
    const snap = state.snapshot();
    expect(snap.phase).toBe('filtered');
    expect(snap.entries).toHaveLength(2);
    expect(snap.applicability.primary.map((t) => t.id)).toContain('pdf-merge');
  });

  it('drops a selection the new file set cannot run', () => {
    const state = createState(TOOLS);
    state.addFiles([pdf(), pdf()]);
    state.selectTool('pdf-merge');
    expect(state.snapshot().selected?.id).toBe('pdf-merge');

    state.setFiles([entry('a.png', 'image/png')]);
    expect(state.snapshot().selected).toBeNull();
  });

  // A generator survives any file change: it never depended on them.
  it('keeps a generator selected when the files change under it', () => {
    const state = createState(TOOLS);
    state.selectTool('qr-generate');
    state.addFiles([pdf()]);
    expect(state.snapshot().selected?.id).toBe('qr-generate');
    expect(state.snapshot().phase).toBe('ready');
  });

  it('keeps a tool selected while its count is merely short', () => {
    const state = createState(TOOLS);
    state.selectTool('pdf-merge');
    state.addFiles([pdf()]);

    const snap = state.snapshot();
    expect(snap.selected?.id).toBe('pdf-merge');
    expect(snap.phase).toBe('tool-picked');
    expect(snap.runBlockedReason).toBe('Needs at least 2 files — you have 1.');
  });

  it('clears files, selection and results together', () => {
    const state = createState(TOOLS);
    state.addFiles([pdf(), pdf()]);
    state.selectTool('pdf-merge');
    state.setResults(true);

    state.clearFiles();

    expect(state.snapshot()).toMatchObject({ phase: 'browsing', entries: [], selected: null });
  });

  // Regression: setFiles used to leave hasResults untouched, so a reorder or
  // removal right after a run left the screen showing stale results. A
  // reorder that leaves the tool still satisfiable returns to 'ready' — the
  // tool is still selected and can still run — not back to 'filtered'.
  it('setFiles drops a stale results screen back to ready when the tool still works', () => {
    const state = createState(TOOLS);
    const one = pdf('one.pdf');
    const two = pdf('two.pdf');
    state.addFiles([one, two]);
    state.selectTool('pdf-merge');
    state.setResults(true);
    expect(state.snapshot().phase).toBe('results');

    // Reorder: same two PDFs, swapped — order matters for a merge, so this
    // is the normal next thing a user does after seeing the result.
    state.setFiles([two, one]);

    const snap = state.snapshot();
    expect(snap.phase).toBe('ready');
    expect(snap.selected?.id).toBe('pdf-merge');
    expect(snap.runBlockedReason).toBeNull();
  });

  // Same bug, worse outcome: if the file change also breaks the type match,
  // pruneSelection drops the selection — without the hasResults reset this
  // would show 'results' with no tool selected at all.
  it('setFiles drops a stale results screen to filtered when the tool no longer fits', () => {
    const state = createState(TOOLS);
    state.addFiles([pdf(), pdf()]);
    state.selectTool('pdf-merge');
    state.setResults(true);

    state.setFiles([entry('a.png', 'image/png')]);

    const snap = state.snapshot();
    expect(snap.phase).toBe('filtered');
    expect(snap.selected).toBeNull();
  });

  // setFiles([]) goes through the same count-shortfall-never-drops path as
  // addFiles: pruneSelection's type check is gated on entries.length > 0.
  it('setFiles([]) keeps the selection — an empty tray is a count shortfall, not a type mismatch', () => {
    const state = createState(TOOLS);
    state.selectTool('pdf-merge');
    state.addFiles([pdf(), pdf()]);

    state.setFiles([]);

    const snap = state.snapshot();
    expect(snap.selected?.id).toBe('pdf-merge');
    expect(snap.entries).toHaveLength(0);
    expect(snap.phase).toBe('tool-picked');
  });

  it('stops notifying after unsubscribe', () => {
    const state = createState(TOOLS);
    const seen = vi.fn();
    state.subscribe(seen)();
    state.addFiles([pdf()]);
    expect(seen).not.toHaveBeenCalled();
  });

  // F1 of the final-branch review: dropping a mismatched file mid-run used to
  // prune the selection out from under a running job, which is what tore
  // down the run's own Cancel button and progress ring on screen (shell.ts's
  // `refreshTools` reacts to a selection the machine dropped by tearing down
  // the whole `.run` card). A job has already captured its own copy of the
  // file list by the time it starts (`shell.ts`'s `start()` reads
  // `snap.entries` once, before calling `setRunning(true)`), so nothing a
  // LATER file change does can affect it — the selection just has to survive
  // on screen for as long as the job that owns it is still running.
  describe('F1 — running protects the selection from pruneSelection', () => {
    it('does not prune a selection whose type stops fitting while a job is running', () => {
      const state = createState(TOOLS);
      state.addFiles([pdf(), pdf()]);
      state.selectTool('pdf-merge');
      state.setRunning(true);

      // A PNG next to two PDFs: pdf-merge's type no longer fits — exactly
      // the case pruneSelection prunes for outside of a run.
      state.addFiles([entry('a.png', 'image/png')]);

      const snap = state.snapshot();
      expect(snap.selected?.id).toBe('pdf-merge');
      expect(snap.phase).toBe('running');
    });

    it('the same mismatch still prunes normally once nothing is running', () => {
      const state = createState(TOOLS);
      state.addFiles([pdf(), pdf()]);
      state.selectTool('pdf-merge');

      state.addFiles([entry('a.png', 'image/png')]);

      expect(state.snapshot().selected).toBeNull();
    });

    it('re-asserts the prune the moment the run ends, without waiting for another file change', () => {
      const state = createState(TOOLS);
      state.addFiles([pdf(), pdf()]);
      state.selectTool('pdf-merge');
      state.setRunning(true);
      state.addFiles([entry('a.png', 'image/png')]);
      expect(state.snapshot().selected?.id).toBe('pdf-merge'); // still protected

      state.setRunning(false);

      expect(state.snapshot().selected).toBeNull();
    });

    it('setFiles mid-run is protected the same way as addFiles', () => {
      const state = createState(TOOLS);
      state.addFiles([pdf(), pdf()]);
      state.selectTool('pdf-merge');
      state.setRunning(true);

      state.setFiles([entry('a.png', 'image/png')]);

      expect(state.snapshot().selected?.id).toBe('pdf-merge');
    });

    it('a run ending with the files still fitting leaves the selection alone', () => {
      const state = createState(TOOLS);
      state.addFiles([pdf(), pdf()]);
      state.selectTool('pdf-merge');
      state.setRunning(true);
      state.setRunning(false);

      const snap = state.snapshot();
      expect(snap.selected?.id).toBe('pdf-merge');
      expect(snap.phase).toBe('ready');
    });
  });
});
