// tests/unit/catalogue.browser.test.ts — ui/zones/catalogue.ts's warm density.
//
// Real headless Chromium (see vitest.workspace.ts's `browser` project):
// catalogue.ts calls `document.createElement`/`createElementNS` directly, so
// it cannot run under the `node` project's DOM-less environment.
//
// `createCatalogue` is exercised directly here, with hand-built snapshots,
// rather than through the whole shell + real registry: the scenario under
// test — every one of the three applicability tiers coming up empty — is not
// merely fiddly to provoke against the real 29-tool registry, it is
// UNREACHABLE (M1, independent review pass #4): six tools declare
// `accepts: ['*']`, `minInputs: 1`, `maxInputs: null`, so with at least one
// file loaded the utility bucket alone already guarantees `allEmpty` can
// never be true. The snapshots below are SYNTHETIC — built by hand
// specifically to reach a branch the real app cannot drive it into today —
// covering `.catalogue__empty` and the `runnable === 0` header defensively,
// for the day a bounded-range or narrower-than-'*' utility tool makes the
// branch reachable again (see catalogue.ts's own comments on both branches).
// `applicabilityFor`'s own bucketing rules are `core/format.test.ts`'s job;
// this only asks what the catalogue PAINTS once handed a snapshot with all
// three buckets empty.

import { describe, expect, it } from 'vitest';

import type { Applicability } from '../../src/core/format';
import type { ToolDef } from '../../src/types';
import type { Snapshot } from '../../src/ui/state';
import { createCatalogue } from '../../src/ui/zones/catalogue';

function tool(over: Partial<ToolDef> = {}): ToolDef {
  return {
    id: 't',
    name: 'T',
    blurb: '',
    group: 'data',
    kind: 'transform',
    accepts: ['text/plain'],
    minInputs: 1,
    maxInputs: 1,
    load: () => Promise.reject(new Error('not used')),
    ...over,
  };
}

const FILE: Snapshot['entries'][number] = {
  file: new File([new Uint8Array([1, 2, 3])], 'a.txt', { type: 'text/plain' }),
  type: 'text/plain',
};

function snapshot(applicability: Applicability, entries = [FILE]): Snapshot {
  return {
    phase: 'filtered',
    entries,
    selected: null,
    applicability,
    runBlockedReason: null,
  };
}

const EMPTY_MESSAGE =
  'No tool works with this exact mix of files. Remove the odd one out — most tools want every file to be the same kind.';

describe('createCatalogue — the all-empty warm message', () => {
  it('explains an all-empty selection instead of leaving a blank panel', () => {
    const catalogue = createCatalogue({ tools: [tool()], onPick: () => undefined, onWarm: () => undefined });

    catalogue.render(snapshot({ primary: [], blocked: [], utility: [] }));

    const empty = catalogue.el.querySelector<HTMLElement>('.catalogue__empty');
    expect(empty).not.toBeNull();
    expect(empty?.hidden).toBe(false);
    expect(empty?.textContent).toBe(EMPTY_MESSAGE);

    catalogue.destroy();
  });

  it('hides the message once anything is runnable', () => {
    const t = tool();
    const catalogue = createCatalogue({ tools: [t], onPick: () => undefined, onWarm: () => undefined });

    catalogue.render(snapshot({ primary: [t], blocked: [], utility: [] }));

    expect(catalogue.el.querySelector<HTMLElement>('.catalogue__empty')?.hidden).toBe(true);

    catalogue.destroy();
  });

  it('hides the message once a utility tool is runnable', () => {
    const t = tool({ id: 'u', kind: 'utility', accepts: ['*'] });
    const catalogue = createCatalogue({ tools: [t], onPick: () => undefined, onWarm: () => undefined });

    catalogue.render(snapshot({ primary: [], blocked: [], utility: [t] }));

    expect(catalogue.el.querySelector<HTMLElement>('.catalogue__empty')?.hidden).toBe(true);

    catalogue.destroy();
  });

  // A blocked card already tells the story on its own ("Needs exactly 1
  // file — you have 2."); a second, generic "no tool works" message right
  // next to it would be redundant, not helpful.
  it('hides the message when a blocked card already explains itself', () => {
    const t = tool();
    const catalogue = createCatalogue({ tools: [t], onPick: () => undefined, onWarm: () => undefined });

    catalogue.render(
      snapshot({ primary: [], blocked: [{ tool: t, reason: 'Needs exactly 1 file — you have 2.' }], utility: [] }),
    );

    expect(catalogue.el.querySelector<HTMLElement>('.catalogue__empty')?.hidden).toBe(true);

    catalogue.destroy();
  });

  it('never shows the message cold, even with all three buckets empty', () => {
    const catalogue = createCatalogue({ tools: [tool()], onPick: () => undefined, onWarm: () => undefined });

    catalogue.render(snapshot({ primary: [], blocked: [], utility: [] }, []));

    expect(catalogue.el.querySelector<HTMLElement>('.catalogue__empty')?.hidden).toBe(true);

    catalogue.destroy();
  });
});

// Task 13: reconciling state.ts's pruneSelection (which deliberately keeps a
// generator selected straight through a file change — it never depended on
// them) against applicabilityFor's bucketing (which just as deliberately
// never lets a generator into primary, blocked, or utility — see
// applicability.test.ts's "never lets a generator into any bucket"). Before
// this, a generator selected cold and then made to survive a warm file set —
// by dropping a file under it, or by picking one from the now bucket-aware
// palette while already warm — left the grid showing no selection anywhere,
// while the work zone kept it mounted and running.
describe('createCatalogue — a persisted generator selection, warm', () => {
  const GENERATOR: ToolDef = tool({
    id: 'gen',
    name: 'Generate QR code',
    kind: 'generate',
    accepts: [],
    minInputs: 0,
    maxInputs: 0,
  });

  it('shows the selected generator, ticked, in the warm grid even though it fits no bucket', () => {
    const other = tool({ id: 'other' });
    const catalogue = createCatalogue({
      tools: [GENERATOR, other],
      onPick: () => undefined,
      onWarm: () => undefined,
    });

    catalogue.render({
      phase: 'ready',
      entries: [FILE],
      selected: GENERATOR,
      applicability: { primary: [other], blocked: [], utility: [] },
      runBlockedReason: null,
    });

    const pill = catalogue.el.querySelector<HTMLElement>('.utilitypill[data-tool="gen"]');
    expect(pill).not.toBeNull();
    expect(pill?.classList.contains('is-selected')).toBe(true);
    expect(pill?.getAttribute('aria-pressed')).toBe('true');
    expect(catalogue.el.querySelector<HTMLElement>('.utility')?.hidden).toBe(false);

    catalogue.destroy();
  });

  it('does not claim "no tool works" when only a persisted generator can run', () => {
    const catalogue = createCatalogue({
      tools: [GENERATOR],
      onPick: () => undefined,
      onWarm: () => undefined,
    });

    catalogue.render({
      phase: 'ready',
      entries: [FILE],
      selected: GENERATOR,
      applicability: { primary: [], blocked: [], utility: [] },
      runBlockedReason: null,
    });

    expect(catalogue.el.querySelector<HTMLElement>('.catalogue__empty')?.hidden).toBe(true);

    catalogue.destroy();
  });

  it('drops the pill again once the generator is deselected', () => {
    const catalogue = createCatalogue({
      tools: [GENERATOR],
      onPick: () => undefined,
      onWarm: () => undefined,
    });

    catalogue.render({
      phase: 'ready',
      entries: [FILE],
      selected: GENERATOR,
      applicability: { primary: [], blocked: [], utility: [] },
      runBlockedReason: null,
    });
    expect(catalogue.el.querySelector('.utilitypill[data-tool="gen"]')).not.toBeNull();

    catalogue.render({
      phase: 'filtered',
      entries: [FILE],
      selected: null,
      applicability: { primary: [], blocked: [], utility: [] },
      runBlockedReason: null,
    });
    expect(catalogue.el.querySelector('.utilitypill[data-tool="gen"]')).toBeNull();

    catalogue.destroy();
  });
});
