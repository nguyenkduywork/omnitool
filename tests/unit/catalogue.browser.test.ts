// tests/unit/catalogue.browser.test.ts — ui/zones/catalogue.ts's warm density.
//
// Real headless Chromium (see vitest.workspace.ts's `browser` project):
// catalogue.ts calls `document.createElement`/`createElementNS` directly, so
// it cannot run under the `node` project's DOM-less environment.
//
// `createCatalogue` is exercised directly here, with hand-built snapshots,
// rather than through the whole shell + real registry: the scenario under
// test — every one of the three applicability tiers coming up empty — is
// fiddly to provoke with real files against the real 29-tool registry, and
// is not this test's business anyway. `applicabilityFor`'s own bucketing
// rules are `core/format.test.ts`'s job; this only asks what the catalogue
// PAINTS once handed a snapshot with all three buckets empty.

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
