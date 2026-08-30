# omnitool UI/UX Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `ToolDef` a second axis (`kind`) so generators and universal utilities stop pretending to be file transformers, then rebuild the shell around two entry doors, three zones, and hash routing.

**Architecture:** Every symptom traces to one axis (`accepts` + `minInputs`/`maxInputs`) carrying more meaning than it can hold. Stage 1 adds `kind` and buckets applicability into primary/blocked/utility. Stage 2 lifts the state machine out of the 647-line `shell.ts` so it is unit-testable under Node for the first time. Stage 3 builds the three-zone layout on top of that machine, with the landing catalogue and the filtered grid as one component. Stage 4 adds the hash router the original spec called for and rewrites the docs.

**Tech Stack:** TypeScript (strict), Vite 5, Vitest 2 (two projects: Node + headless Chromium), Playwright, anime.js v4, no framework.

**Spec:** [docs/superpowers/specs/2026-08-30-ui-overhaul-design.md](../specs/2026-08-30-ui-overhaul-design.md)

## Global Constraints

Every task's requirements implicitly include this section.

- **No `*.op.ts` file is modified.** Nothing about what a tool computes changes. Registry entries, `core/format.ts`, `src/ui/**`, `src/types.ts`, styles, tests and docs are in scope; `src/tools/**` is not.
- **Import boundaries, lint-enforced** (`eslint.config.js`): `src/tools/**` imports only `src/types.ts` + npm; `src/core/**` never imports `src/ui/**`; only `src/ui/motion.ts` imports `animejs`.
- **The metadata-only rule** (spec §3.2): a `preset` predicate may read a file's `name`, `size` and sniffed `type` — **never its contents**. Predicates stay pure and synchronous.
- **Size budget, CI-enforced** (`npm run size`): initial JS ≤ 40 KB gzip, initial CSS ≤ 12 KB gzip, total first-paint ≤ 60 KB gzip (1 KB = 1024 B).
- **WCAG AA contrast in both themes**, verified by `npm run contrast`.
- **The full CI gate must pass at the end of every stage:**
  ```bash
  npm run typecheck && npm run lint && npm run test && npm run build && npm run size && npm run test:e2e
  ```
- **Node ≥ 20** (`package.json` `engines`).
- Commit messages: lowercase `type(scope): subject`, imperative, matching the existing log.

## Wording note

Spec §3.3 illustrates blocked reasons as *"needs exactly one PDF — you have two"*. This plan implements them as type-agnostic (`"Needs exactly 1 file — you have 2."`). The spec's phrasing was illustrative; a mixed-but-valid selection (a PNG and a JPEG both matching `image/*`) has no single type name to use, and "file" is always correct.

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `src/ui/state.ts` | The state machine: files, selection, derived buckets, phase. **DOM-free**, unit-tested under Node. |
| `src/ui/router.ts` | Hash ⇄ tool id. Nothing else. |
| `src/ui/theme.ts` | Theme preference read/apply/cycle, lifted from `shell.ts` unchanged. |
| `src/ui/zones/catalogue.ts` | Zone 2. Renders all 29 tools when cold, the three buckets when files are loaded. One component. |
| `src/ui/zones/files.ts` | Zone 1. Wraps the existing `filetray` + dropzone add-bar. |
| `src/ui/zones/work.ts` | Zone 3. Options + Run + progress + results for the selected tool. |
| `tests/unit/applicability.test.ts` | Bucketing, `typesMatch`, `countReason`. |
| `tests/unit/preset.test.ts` | The four `preset` predicates. |
| `tests/unit/state.test.ts` | Every transition in spec §4.2. |
| `tests/unit/router.test.ts` | Parse, serialise, unknown-id fallback. |
| `tests/e2e/tool-first.spec.ts` | The second entry door, QR from cold, blocked cards, back/forward. |

**Modified**

| File | Change |
|---|---|
| `src/types.ts` | `ToolKind`, `SniffedFile`, `Preset`; `kind` and `preset?` on `ToolDef`. |
| `src/core/registry.{pdf,image,data}.ts` | `kind` on all 29 entries; `preset` on four; `qr-generate` re-declared. |
| `src/core/format.ts` | `typesMatch`, `countReason`, `applicabilityFor`. |
| `src/ui/shell.ts` | 647 lines → composition root (~150). |
| `src/ui/dropzone.ts` | Hero gains the catalogue mount; "Browse the tools" stops opening the palette. |
| `src/ui/palette.ts` | `unavailableReason` becomes bucket-aware (consumed, not restructured). |
| `src/ui/filetray.ts` | `TrayEntry` becomes an alias of `state.ts`'s `FileEntry`. |
| `src/styles/app.css` | Three-zone layout, responsive breakpoints. |
| `eslint.config.js` | `src/ui/state.ts` may not touch `document`/`window`/`HTMLElement`. |
| `tests/unit/format.test.ts` | Its local `tool()` factory needs `kind`. |
| `tests/e2e/a11y.spec.ts` | Reworked for three zones. |
| `README.md`, `docs/superpowers/specs/2026-08-29-omnitool-design.md` | §7 rewritten. |

---

# Stage 1 — The tool model

Ends in one commit. The grid gains two tiers; no layout change.

### Task 1: `kind` on `ToolDef` and all 29 registry entries

**Files:**
- Modify: `src/types.ts:55-72`
- Modify: `src/core/registry.pdf.ts`, `src/core/registry.image.ts`, `src/core/registry.data.ts`
- Modify: `tests/unit/format.test.ts:19-31` (the local `tool()` factory)
- Test: `tests/unit/applicability.test.ts` (created here, extended in Task 2)

**Interfaces:**
- Consumes: nothing.
- Produces: `ToolKind`, `SniffedFile`, `Preset` types; `ToolDef.kind` (required) and `ToolDef.preset` (optional).

- [ ] **Step 1: Write the failing test**

Create `tests/unit/applicability.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { TOOLS, getTool } from '../../src/core/registry';

describe('every tool declares a kind', () => {
  it('assigns exactly one kind to each of the 29 tools', () => {
    expect(TOOLS).toHaveLength(29);
    for (const tool of TOOLS) {
      expect(['transform', 'generate', 'utility']).toContain(tool.kind);
    }
  });

  it('has exactly one generator, and it accepts no files', () => {
    const generators = TOOLS.filter((t) => t.kind === 'generate');
    expect(generators.map((t) => t.id)).toEqual(['qr-generate']);
    expect(generators[0]?.accepts).toEqual([]);
    expect(generators[0]?.minInputs).toBe(0);
  });

  // The two must not drift: a utility IS a tool that takes any bytes.
  it('marks utility on exactly the seven tools accepting everything', () => {
    const utilities = TOOLS.filter((t) => t.kind === 'utility').map((t) => t.id).sort();
    const universal = TOOLS.filter((t) => t.accepts.includes('*')).map((t) => t.id).sort();

    expect(utilities).toEqual([
      'base64', 'file-join', 'file-split', 'gzip', 'hash', 'tar-create', 'zip-create',
    ]);
    expect(universal).toEqual(utilities);
  });

  it('leaves the remaining 21 as transforms, including the extractors', () => {
    expect(TOOLS.filter((t) => t.kind === 'transform')).toHaveLength(21);
    expect(getTool('zip-extract')?.kind).toBe('transform');
    expect(getTool('tar-extract')?.kind).toBe('transform');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project node tests/unit/applicability.test.ts`
Expected: FAIL — TypeScript reports `kind` does not exist on `ToolDef`.

- [ ] **Step 3: Add the types**

In `src/types.ts`, above `ToolDef`:

```ts
/**
 * What KIND of thing a tool is. `accepts` describes a transform completely and
 * a generator not at all, which is why one axis was never enough.
 *
 *   transform — files in, files out; `accepts` is the whole story
 *   generate  — no files at all: options in, files out
 *   utility   — runs on any bytes; never the reason you opened the app
 */
export type ToolKind = 'transform' | 'generate' | 'utility';

/** All a registry predicate may see: metadata, never contents. */
export type SniffedFile = { name: string; size: number; type: string };

/** Option defaults derived from the inputs, each with a reason to show. */
export type Preset = {
  values: Record<string, unknown>;
  /** option key -> why it was preset, e.g. "from the file's gzip signature". */
  because: Record<string, string>;
};
```

Then in `ToolDef`, after `group`:

```ts
  kind: ToolKind;
```

and after `editor`:

```ts
  /** Defaults read off the inputs' metadata. Pure and synchronous — never
   *  reads file contents (see the design spec, §3.2). */
  preset?: (files: readonly SniffedFile[]) => Preset;
```

- [ ] **Step 4: Add `kind` to all 29 entries**

`registry.pdf.ts` — add `kind: 'transform',` after each `group: 'pdf',` (8 entries).

`registry.image.ts` — add `kind: 'transform',` after each `group: 'image',` (8 entries).

`registry.data.ts` — add after each `group: 'data',`:

| Entries | Line to add |
|---|---|
| `zip-create`, `gzip`, `tar-create`, `file-split`, `file-join`, `hash`, `base64` | `kind: 'utility',` |
| `zip-extract`, `tar-extract`, `csv-json`, `json-format`, `text-clean` | `kind: 'transform',` |
| `qr-generate` | `kind: 'generate',` |

Then re-declare `qr-generate`'s inputs — it takes none:

```ts
    kind: 'generate',
    accepts: [],
    minInputs: 0,
    maxInputs: 0,
```

- [ ] **Step 5: Update the registry header comments**

In all three `registry.*.ts`, replace `METADATA ONLY - no logic.` with:

```
 * Metadata, plus pure predicates over file METADATA (name, size, sniffed
 * type) — never over file contents. That rule is what keeps this module
 * synchronous, allocation-free, and testable under plain Node.
```

- [ ] **Step 6: Fix the existing test factory**

`tests/unit/format.test.ts`, in `function tool()`, add after `group: 'pdf',`:

```ts
    kind: 'transform',
```

- [ ] **Step 7: Run the full node suite**

Run: `npm run typecheck && npx vitest run --project node`
Expected: PASS. `applicability.test.ts` green, `format.test.ts` still green.

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/core/registry.pdf.ts src/core/registry.image.ts src/core/registry.data.ts tests/unit/applicability.test.ts tests/unit/format.test.ts
git commit -m "feat(registry): give every tool a kind"
```

---

### Task 2: Applicability bucketing in `core/format.ts`

**Files:**
- Modify: `src/core/format.ts:155-172`
- Modify: `src/core/registry.ts:18-21`
- Test: `tests/unit/applicability.test.ts`

**Interfaces:**
- Consumes: `ToolKind`, `ToolDef.kind` (Task 1).
- Produces: `typesMatch(tool, mimes): boolean`, `countReason(tool, count): string | null`, `applicabilityFor(tools, mimes): Applicability`, and the types `Applicability` and `BlockedTool`. `accepts()` keeps its current signature and meaning.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/applicability.test.ts`:

```ts
import { applicabilityFor, countReason, typesMatch } from '../../src/core/format';

const PDF = 'application/pdf';

describe('countReason', () => {
  it('is null when the count fits', () => {
    expect(countReason(getTool('pdf-merge')!, 2)).toBeNull();
    expect(countReason(getTool('pdf-split')!, 1)).toBeNull();
  });

  it('names an exact requirement when min equals max', () => {
    expect(countReason(getTool('pdf-organize')!, 2)).toBe('Needs exactly 1 file — you have 2.');
  });

  it('names a minimum when there are too few', () => {
    expect(countReason(getTool('pdf-merge')!, 1)).toBe('Needs at least 2 files — you have 1.');
  });

  it('says "none" rather than "0"', () => {
    expect(countReason(getTool('pdf-merge')!, 0)).toBe('Needs at least 2 files — you have none.');
  });
});

describe('typesMatch — types only, count ignored', () => {
  it('accepts a count that would fail the range', () => {
    expect(typesMatch(getTool('pdf-organize')!, [PDF, PDF])).toBe(true);
  });

  it('rejects a foreign type', () => {
    expect(typesMatch(getTool('pdf-merge')!, [PDF, 'image/png'])).toBe(false);
  });

  it('honours the image/* wildcard', () => {
    expect(typesMatch(getTool('image-resize')!, ['image/png', 'image/jpeg'])).toBe(true);
  });
});

describe('applicabilityFor — the four buckets', () => {
  it('puts two PDFs into primary, blocks the one-file-only tool, and quiets the utilities', () => {
    const { primary, blocked, utility } = applicabilityFor(TOOLS, [PDF, PDF]);

    expect(primary.map((t) => t.id)).toContain('pdf-merge');
    expect(primary.map((t) => t.id)).not.toContain('pdf-organize');

    // The whole point of `blocked`: it is EXPLAINED, not silently absent.
    expect(blocked.map((b) => b.tool.id)).toContain('pdf-organize');
    expect(blocked.find((b) => b.tool.id === 'pdf-organize')?.reason).toBe(
      'Needs exactly 1 file — you have 2.',
    );

    expect(utility.map((t) => t.id)).toContain('hash');
    expect(primary.map((t) => t.id)).not.toContain('hash');
  });

  it('never lets a generator into any bucket, whatever is loaded', () => {
    for (const mimes of [[], [PDF], ['image/png', 'image/png']]) {
      const { primary, blocked, utility } = applicabilityFor(TOOLS, mimes);
      const all = [...primary, ...utility, ...blocked.map((b) => b.tool)];
      expect(all.map((t) => t.id)).not.toContain('qr-generate');
    }
  });

  // A utility failing only on COUNT stays absent rather than nagging.
  it('never puts a utility into blocked', () => {
    const { blocked } = applicabilityFor(TOOLS, [PDF]);
    expect(blocked.map((b) => b.tool.id)).not.toContain('file-join');
    expect(blocked.every((b) => b.tool.kind === 'transform')).toBe(true);
  });

  it('is empty in every bucket when nothing is loaded', () => {
    expect(applicabilityFor(TOOLS, [])).toEqual({ primary: [], blocked: [], utility: [] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project node tests/unit/applicability.test.ts`
Expected: FAIL — `applicabilityFor is not a function`.

- [ ] **Step 3: Implement in `src/core/format.ts`**

Replace the existing `accepts()` at the bottom of the file with:

```ts
/** True when EVERY mime matches one of `tool.accepts`. The count is ignored. */
export function typesMatch(tool: ToolDef, mimes: string[]): boolean {
  return mimes.every((mime) => tool.accepts.some((pattern) => patternMatches(pattern, mime)));
}

/**
 * Why `count` inputs is the wrong number for `tool`, or null when it is fine.
 *
 * Type-agnostic on purpose: a selection can be valid and still mixed (a PNG
 * and a JPEG both match `image/*`), so there is no single type name to use.
 */
export function countReason(tool: ToolDef, count: number): string | null {
  const { minInputs, maxInputs } = tool;
  if (count >= minInputs && (maxInputs === null || count <= maxInputs)) return null;

  const have = `you have ${count === 0 ? 'none' : count}`;
  const files = (n: number): string => (n === 1 ? 'file' : 'files');

  if (maxInputs !== null && minInputs === maxInputs) {
    return `Needs exactly ${minInputs} ${files(minInputs)} — ${have}.`;
  }
  if (count < minInputs) {
    return `Needs at least ${minInputs} ${files(minInputs)} — ${have}.`;
  }
  return `Takes at most ${maxInputs} ${files(maxInputs as number)} — ${have}.`;
}

/**
 * True when `tool` can run against exactly this selection: the count is within
 * [minInputs, maxInputs] and EVERY mime matches one of `tool.accepts`
 * (supporting the 'image/*' and '*' wildcards).
 */
export function accepts(tool: ToolDef, mimes: string[]): boolean {
  return countReason(tool, mimes.length) === null && typesMatch(tool, mimes);
}

export type BlockedTool = { tool: ToolDef; reason: string };

/** The tool grid's three tiers. Anything in none of them is not rendered. */
export type Applicability = {
  /** Format-aware tools that fit. Prominent cards. */
  primary: ToolDef[];
  /** Format-aware tools whose TYPE fits but whose COUNT does not. Explained. */
  blocked: BlockedTool[];
  /** Any-bytes tools that fit. Quiet row. */
  utility: ToolDef[];
};

/**
 * Bucket `tools` against this selection.
 *
 * Buckets key off `kind`, never off re-inspecting `accepts` patterns — that is
 * what `kind` is for, and it removes the question of whether 'image/*' counts
 * as "concrete". Generators are structurally excluded: they read no file, so
 * no file-driven grid can describe them.
 */
export function applicabilityFor(tools: readonly ToolDef[], mimes: string[]): Applicability {
  const result: Applicability = { primary: [], blocked: [], utility: [] };
  if (mimes.length === 0) return result;

  for (const tool of tools) {
    if (tool.kind === 'generate') continue;
    if (!typesMatch(tool, mimes)) continue;

    const reason = countReason(tool, mimes.length);
    if (tool.kind === 'utility') {
      // A utility that merely has the wrong count stays absent. Showing it
      // blocked would nag on every unrelated file set, since '*' always matches.
      if (reason === null) result.utility.push(tool);
      continue;
    }
    if (reason === null) result.primary.push(tool);
    else result.blocked.push({ tool, reason });
  }
  return result;
}
```

- [ ] **Step 4: Re-export from the registry**

In `src/core/registry.ts`, replace `toolsFor` with:

```ts
import { accepts, applicabilityFor as bucket, type Applicability } from './format';

/** The tools that can run against exactly this selection of mime types. */
export function toolsFor(mimes: string[]): ToolDef[] {
  return TOOLS.filter((tool) => accepts(tool, mimes));
}

/** The same question, answered in the three tiers the grid renders. */
export function applicabilityFor(mimes: string[]): Applicability {
  return bucket(TOOLS, mimes);
}
```

- [ ] **Step 5: Run the tests**

Run: `npm run typecheck && npx vitest run --project node`
Expected: PASS, including the untouched `format.test.ts` — `accepts()` keeps its meaning.

- [ ] **Step 6: Commit**

```bash
git add src/core/format.ts src/core/registry.ts tests/unit/applicability.test.ts
git commit -m "feat(core): bucket tool applicability into primary, blocked and utility"
```

---

### Task 3: The four `preset` predicates

**Files:**
- Modify: `src/core/registry.data.ts` (`gzip`, `base64`, `csv-json`, `zip-create`, `tar-create`)
- Test: `tests/unit/preset.test.ts`

**Interfaces:**
- Consumes: `SniffedFile`, `Preset`, `ToolDef.preset` (Task 1).
- Produces: `preset` populated on five registry entries. Callers read `preset(files).values` for defaults and `.because[key]` for the note to render under a control.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/preset.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { getTool } from '../../src/core/registry';
import type { SniffedFile } from '../../src/types';

function file(name: string, type: string, size = 1024): SniffedFile {
  return { name, size, type };
}

function preset(id: string, files: SniffedFile[]) {
  const fn = getTool(id)?.preset;
  if (!fn) throw new Error(`${id} declares no preset`);
  return fn(files);
}

describe('gzip preset — direction from the signature', () => {
  it('preselects decompress for a real gzip, and says why', () => {
    const { values, because } = preset('gzip', [file('a.tar.gz', 'application/gzip')]);
    expect(values.direction).toBe('decode');
    expect(because.direction).toBe("from the file's gzip signature");
  });

  it('leaves compress unstated for anything else', () => {
    const { values, because } = preset('gzip', [file('a.pdf', 'application/pdf')]);
    expect(values.direction).toBe('encode');
    expect(because.direction).toBeUndefined();
  });
});

describe('base64 preset — direction from the extension', () => {
  it('preselects decode for .b64 and .base64', () => {
    for (const name of ['payload.b64', 'payload.base64', 'PAYLOAD.B64']) {
      const { values, because } = preset('base64', [file(name, 'text/plain')]);
      expect(values.direction).toBe('decode');
      expect(because.direction).toBe('from the file extension');
    }
  });

  it('leaves encode unstated otherwise', () => {
    const { values, because } = preset('base64', [file('notes.txt', 'text/plain')]);
    expect(values.direction).toBe('encode');
    expect(because.direction).toBeUndefined();
  });
});

describe('csv-json preset — admits when it cannot tell', () => {
  it('preselects csv-to-json for a real CSV', () => {
    const { values, because } = preset('csv-json', [file('people.csv', 'text/csv')]);
    expect(values.direction).toBe('csv-to-json');
    expect(because.direction).toBe('from the .csv file');
  });

  it('preselects json-to-csv for real JSON', () => {
    const { values, because } = preset('csv-json', [file('p.json', 'application/json')]);
    expect(values.direction).toBe('json-to-csv');
    expect(because.direction).toBe('from the .json file');
  });

  // The honest case: text/plain carries no signal, so it must not guess.
  it('sets nothing on plain text and says so', () => {
    const { values, because } = preset('csv-json', [file('data.txt', 'text/plain')]);
    expect(values.direction).toBeUndefined();
    expect(because.direction).toBe("couldn't tell from the file — pick a direction");
  });
});

describe('archive-name presets', () => {
  it('names a zip after the first file, without its extension', () => {
    const { values, because } = preset('zip-create', [
      file('holiday-photos.png', 'image/png'),
      file('b.png', 'image/png'),
    ]);
    expect(values.name).toBe('holiday-photos');
    expect(because.name).toBe('from the first file');
  });

  it('does the same for tar', () => {
    expect(preset('tar-create', [file('report.pdf', 'application/pdf')]).values.name).toBe('report');
  });

  it('falls back to "archive" when there are no files', () => {
    const { values, because } = preset('zip-create', []);
    expect(values.name).toBe('archive');
    expect(because.name).toBeUndefined();
  });

  it('keeps a dotless name whole', () => {
    expect(preset('zip-create', [file('Makefile', 'text/plain')]).values.name).toBe('Makefile');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project node tests/unit/preset.test.ts`
Expected: FAIL — `gzip declares no preset`.

- [ ] **Step 3: Add the shared helpers**

At the top of `src/core/registry.data.ts`, under the import:

```ts
import type { Preset, SniffedFile, ToolDef } from '../types.js';

/** `holiday.tar.gz` -> `holiday.tar`. One extension, so `.tar.gz` keeps `.tar`. */
function basename(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? name : name.slice(0, dot);
}

/** Both archive tools name their output after the first file dropped. */
function archiveNamePreset(files: readonly SniffedFile[]): Preset {
  const first = files[0];
  if (!first) return { values: { name: 'archive' }, because: {} };
  return { values: { name: basename(first.name) }, because: { name: 'from the first file' } };
}
```

- [ ] **Step 4: Add `preset` to the five entries**

`gzip`, after its `options` block:

```ts
    preset: (files) =>
      files.some((f) => f.type === 'application/gzip')
        ? { values: { direction: 'decode' }, because: { direction: "from the file's gzip signature" } }
        : { values: { direction: 'encode' }, because: {} },
```

`base64`:

```ts
    preset: (files) =>
      files.some((f) => /\.(b64|base64)$/i.test(f.name))
        ? { values: { direction: 'decode' }, because: { direction: 'from the file extension' } }
        : { values: { direction: 'encode' }, because: {} },
```

`csv-json` — note the third branch sets **no value**, so the schema default stands and the UI shows the reason it could not tell:

```ts
    preset: (files) => {
      if (files.some((f) => f.type === 'text/csv')) {
        return { values: { direction: 'csv-to-json' }, because: { direction: 'from the .csv file' } };
      }
      if (files.some((f) => f.type === 'application/json')) {
        return { values: { direction: 'json-to-csv' }, because: { direction: 'from the .json file' } };
      }
      // text/plain carries no signal. Saying so beats guessing wrong.
      return { values: {}, because: { direction: "couldn't tell from the file — pick a direction" } };
    },
```

`zip-create` and `tar-create` both get:

```ts
    preset: archiveNamePreset,
```

- [ ] **Step 5: Run the tests**

Run: `npm run typecheck && npm run lint && npx vitest run --project node`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/registry.data.ts tests/unit/preset.test.ts
git commit -m "feat(registry): preset tool options from the files' own metadata"
```

---

### Task 4: Render the two tiers, and honour presets

**Files:**
- Modify: `src/ui/shell.ts:288-360` (`refreshTools`), `:396-420` (`mountOptions`)
- Modify: `src/ui/optionspanel.ts:30-40`, and its render path
- Modify: `src/styles/app.css` (append)
- Test: `tests/e2e/golden.spec.ts` (one new assertion)

**Interfaces:**
- Consumes: `applicabilityFor` (Task 2), `ToolDef.preset` (Task 3).
- Produces: `renderOptions` accepts `presetBecause?: Record<string, string>` and renders each reason as `.opt__because` under its control. `defaultOptions(schema, preset?)` layers preset values over schema defaults.

- [ ] **Step 1: Write the failing e2e assertion**

In `tests/e2e/golden.spec.ts`, add inside the existing top-level `test.describe`:

```ts
test('offers PDF tools prominently and byte utilities quietly', async ({ page }) => {
  await page.goto('/');
  await page
    .locator('input[type=file]')
    .setInputFiles([fixturePath('small.pdf'), fixturePath('small.pdf')]);

  // Format-aware tools are cards.
  await expect(page.locator('.toolcard[data-tool="pdf-merge"]')).toBeVisible();
  // Any-bytes tools are demoted, not removed.
  await expect(page.locator('.toolcard[data-tool="hash"]')).toHaveCount(0);
  await expect(page.locator('.utilitybar [data-tool="hash"]')).toBeVisible();
  // The generator is nowhere in a file-driven grid.
  await expect(page.locator('[data-tool="qr-generate"]')).toHaveCount(0);
  // A tool blocked only on count is explained, not vanished.
  await expect(page.locator('.toolcard--blocked[data-tool="pdf-organize"]')).toContainText(
    'Needs exactly 1 file',
  );
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx playwright test tests/e2e/golden.spec.ts -g "byte utilities quietly"`
Expected: FAIL — `.utilitybar` does not exist.

- [ ] **Step 3: Teach `optionspanel.ts` about presets**

Change the exported signature:

```ts
export type RenderOptionsInit = {
  tool: ToolDef;
  files: File[];
  onChange: (values: Record<string, unknown>) => void;
  disabled?: DisabledChoices;
  /** option key -> why it was preset. Rendered under the control. */
  presetBecause?: Record<string, string>;
};
```

Extend `defaultOptions`:

```ts
/** Schema defaults, with any preset values layered over them. */
export function defaultOptions(
  schema: OptionSchema | undefined,
  presetValues?: Record<string, unknown>,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(schema ?? {})) values[key] = def.default;
  for (const [key, value] of Object.entries(presetValues ?? {})) {
    // A preset for an option this tool does not have is a registry bug, not
    // something to pass silently through to the op.
    if (key in values) values[key] = value;
  }
  return values;
}
```

In the per-control render loop, after appending the control, append its reason:

```ts
    const because = init.presetBecause?.[key];
    if (because) {
      const note = el('p', 'opt__because', because);
      note.id = `${id}-because`;
      row.append(note);
    }
```

Append to `row`, next to the existing `.opt__reason` line (`optionspanel.ts:270`) — that one says *why a choice is unavailable*, this one says *why a value was chosen for you*, so they are separate classes deliberately.

- [ ] **Step 4: Call it from the shell**

In `shell.ts`'s `mountOptions`, replace the first two lines of the body with:

```ts
    lastFilesSignature = filesSignature();
    const sniffed = entries.map((entry) => ({
      name: entry.file.name,
      size: entry.file.size,
      type: entry.type,
    }));
    const preset = tool.preset?.(sniffed);
    options = defaultOptions(tool.options, preset?.values);
```

and pass it through to `renderOptions`:

```ts
      disabled,
      presetBecause: preset?.because,
```

- [ ] **Step 5: Render the buckets in `refreshTools`**

Replace the `applicable` computation and the group loop. The signature must cover all three buckets so a change in any of them rebuilds:

```ts
  function gridSignature(app: Applicability): string {
    return [
      entries.length,
      app.primary.map((t) => t.id).join(','),
      app.blocked.map((b) => b.tool.id).join(','),
      app.utility.map((t) => t.id).join(','),
    ].join('|');
  }
```

In `refreshTools`, replace `const applicable = …` with:

```ts
    const app = entries.length === 0
      ? { primary: [], blocked: [], utility: [] }
      : applicabilityFor(mimes());
```

Render `app.primary` through the existing group loop unchanged. Then, after it, append the blocked cards into their own family group and the utility bar:

```ts
    for (const { tool, reason } of app.blocked) {
      const card = toolCard(tool, cards);
      card.classList.add('toolcard--blocked');
      card.disabled = true;
      card.append(el('span', 'toolcard__reason', reason));
      blockedGrid.append(card);
    }

    utilityBar.replaceChildren();
    for (const tool of app.utility) {
      const pill = el('button', 'utilitypill');
      pill.type = 'button';
      pill.dataset.tool = tool.id;
      pill.append(icon(toolIcon(tool)), el('span', undefined, tool.name));
      pill.addEventListener('click', () => void select(tool.id));
      utilityBar.append(pill);
    }
    utilityWrap.hidden = app.utility.length === 0;
```

Declare the three new nodes next to `toolsGrid`:

```ts
  const blockedGrid = el('div', 'toolgroup__grid toolgroup__grid--blocked');
  const utilityWrap = el('section', 'utility');
  utilityWrap.append(el('h3', 'utility__title', 'Works on any file'));
  const utilityBar = el('div', 'utilitybar');
  utilityWrap.append(utilityBar);
```

and append `blockedGrid` then `utilityWrap` to `toolsPanel` after `toolsGrid`.

Selection guard: replace the `applicable.some(...)` check with

```ts
    const selectable = [...app.primary, ...app.utility];
    if (selected && !selectable.some((tool) => tool.id === selected?.id)) {
```

Count line:

```ts
    const runnable = app.primary.length + app.utility.length;
    toolsCount.textContent =
      runnable === 0 ? '' : `${runnable === 1 ? '1 tool' : `${runnable} tools`} can run on ${subject}.`;
```

- [ ] **Step 6: Style the two tiers**

Append to `src/styles/app.css`:

```css
/* ------------------------------------------------- the second tier
 * Any-bytes tools are always available and never the reason you came, so
 * they read as a quiet row rather than competing with the format-aware grid. */
.utility { margin-top: var(--s-5); }
.utility__title {
  font-size: var(--fs-xs);
  text-transform: uppercase;
  letter-spacing: 0.09em;
  color: var(--ink-3);
  margin: 0 0 var(--s-2);
}
.utilitybar { display: flex; flex-wrap: wrap; gap: var(--s-2); }
.utilitypill {
  display: inline-flex;
  align-items: center;
  gap: var(--s-2);
  padding: var(--s-2) var(--s-3);
  border: 1px solid var(--line);
  border-radius: var(--r-pill);
  background: var(--bg-2);
  color: var(--ink-2);
  font-size: var(--fs-sm);
  cursor: pointer;
}
.utilitypill:hover { border-color: var(--line-2); color: var(--ink); }
.utilitypill.is-selected { border-color: var(--accent); color: var(--accent); }

/* A tool whose TYPE fits but whose COUNT does not: explained, not vanished. */
.toolcard--blocked { opacity: 0.55; cursor: not-allowed; }
.toolcard__reason {
  display: block;
  margin-top: var(--s-2);
  font-size: var(--fs-xs);
  color: var(--ink-2);
}
.opt__because {
  margin: var(--s-1) 0 0;
  font-size: var(--fs-xs);
  color: var(--ink-2);
}
```

These are the real token names from `src/styles/tokens.css`: spacing is `--s-1`…`--s-8` (not `--space-N`), type sizes are `--fs-xs`/`--fs-sm` (not `--text-N`), surfaces are `--bg`/`--bg-1`/`--bg-2`/`--bg-3`, and there is one `--line` plus `--line-2`.

`--ink-2` rather than `--ink-3` for the two reason lines: `npm run contrast` checks every ink/surface pairing, and these carry meaning rather than decoration.

- [ ] **Step 7: Run the gate**

```bash
npm run typecheck && npm run lint && npm run contrast && npm run test && npm run build && npm run size && npm run test:e2e
```
Expected: all PASS. `--ink-2` is already used for the two reason lines for this reason; if `contrast` still flags the `.utility__title` pairing, move that to `--ink-2` as well.

- [ ] **Step 8: Commit**

```bash
git add src/ui/shell.ts src/ui/optionspanel.ts src/styles/app.css tests/e2e/golden.spec.ts
git commit -m "feat(ui): rank tools in two tiers and preset options from the files"
```

---

# Stage 2 — Extract the machine

Ends in one commit. **Pure refactor: zero behaviour change**, proven by the existing suite passing untouched.

### Task 5: Lift `ui/theme.ts` out of the shell

**Files:**
- Create: `src/ui/theme.ts`
- Modify: `src/ui/shell.ts:37-49` (constants), `:52-66` (functions), `:113-137` (the button)

**Interfaces:**
- Consumes: nothing.
- Produces: `createThemeControl(announce: (m: string) => void): { el: HTMLButtonElement; destroy(): void }`, which owns the preference, the `<html data-theme>` attribute and the button. `ThemePref` is not exported — nothing outside needs it.

- [ ] **Step 1: Create the module**

Move `THEME_KEY`, `ThemePref`, `THEME_CYCLE`, `THEME_NAME`, `readThemePref` and `applyThemePref` from `shell.ts` verbatim into `src/ui/theme.ts`, then wrap the button:

```ts
// src/ui/theme.ts — the theme preference and the one control that changes it.
//
// Lifted out of shell.ts unchanged: it shares no state with anything else
// there, and a composition root should not also be a preference store.

import { el, icon } from './dom';

// …the six moved declarations, verbatim…

export type ThemeHandle = { readonly el: HTMLButtonElement; destroy(): void };

export function createThemeControl(announce: (message: string) => void): ThemeHandle {
  let theme = readThemePref();
  applyThemePref(theme);

  const button = el('button', 'btn btn--icon');
  button.type = 'button';
  button.append(icon('theme'));

  function paint(): void {
    button.title = THEME_NAME[theme];
    button.setAttribute('aria-label', `${THEME_NAME[theme]}. Change.`);
    button.dataset.theme = theme;
  }
  paint();

  const onClick = (): void => {
    const at = THEME_CYCLE.indexOf(theme);
    theme = THEME_CYCLE[(at + 1) % THEME_CYCLE.length] ?? 'system';
    applyThemePref(theme);
    paint();
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // A blocked storage is not an error worth showing anyone.
    }
    announce(THEME_NAME[theme]);
  };
  button.addEventListener('click', onClick);

  return { el: button, destroy: () => button.removeEventListener('click', onClick) };
}
```

- [ ] **Step 2: Use it from the shell**

Delete the moved declarations and the `themeButton` block from `shell.ts`. Add `import { createThemeControl } from './theme';`, then:

```ts
  const themeControl = createThemeControl(announce);
```

Replace `themeButton` with `themeControl.el` in the `topbarInner.append(...)` call, and add `themeControl.destroy();` to the returned `destroy()`.

- [ ] **Step 3: Prove nothing changed**

```bash
npm run typecheck && npm run lint && npm run test && npm run build && npm run test:e2e
```
Expected: all PASS with no test edits. The a11y suite already exercises the theme button.

- [ ] **Step 4: Commit**

```bash
git add src/ui/theme.ts src/ui/shell.ts
git commit -m "refactor(ui): lift the theme control out of the shell"
```

---

### Task 6: The DOM-free state machine

**Files:**
- Create: `src/ui/state.ts`
- Modify: `eslint.config.js`
- Modify: `src/ui/filetray.ts` (`TrayEntry` becomes an alias)
- Test: `tests/unit/state.test.ts`

**Interfaces:**
- Consumes: `applicabilityFor` (Task 2), `Applicability` (Task 2), `ToolDef`/`ToolKind` (Task 1).
- Produces:
  - `type FileEntry = { file: File; type: string }`
  - `type Phase = 'browsing' | 'filtered' | 'tool-picked' | 'ready' | 'running' | 'results'`
  - `type Snapshot = { phase: Phase; entries: FileEntry[]; selected: ToolDef | null; applicability: Applicability; runBlockedReason: string | null }`
  - `derivePhase(input): Phase` and `runBlockedReason(selected, mimes): string | null` — pure, exported for test
  - `createState(tools: readonly ToolDef[]): StateHandle` with `snapshot()`, `subscribe(fn): () => void`, `addFiles`, `setFiles`, `clearFiles`, `selectTool(id | null)`, `setRunning(bool)`, `setResults(bool)`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/state.test.ts`:

```ts
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

  it('stops notifying after unsubscribe', () => {
    const state = createState(TOOLS);
    const seen = vi.fn();
    state.subscribe(seen)();
    state.addFiles([pdf()]);
    expect(seen).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project node tests/unit/state.test.ts`
Expected: FAIL — cannot resolve `../../src/ui/state`.

- [ ] **Step 3: Implement `src/ui/state.ts`**

```ts
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
```

- [ ] **Step 4: Make the DOM-free rule structural**

In `eslint.config.js`, after the `src/ui/**` block (3a), add:

```js
  // 3b. src/ui/state.ts is the shell's logic, and it is unit-tested under
  //     plain Node. Touching the DOM here would silently make that
  //     impossible, so the rule is enforced rather than documented.
  {
    files: ['src/ui/state.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'document', message: 'src/ui/state.ts must stay DOM-free.' },
        { name: 'window', message: 'src/ui/state.ts must stay DOM-free.' },
        { name: 'HTMLElement', message: 'src/ui/state.ts must stay DOM-free.' },
      ],
    },
  },
```

- [ ] **Step 5: Alias `TrayEntry`**

In `src/ui/filetray.ts`, replace the local `TrayEntry` declaration with:

```ts
import type { FileEntry } from './state';

/** The tray renders exactly what the state machine holds. */
export type TrayEntry = FileEntry;
```

- [ ] **Step 6: Run the tests**

Run: `npm run typecheck && npm run lint && npx vitest run --project node`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/ui/state.ts src/ui/filetray.ts eslint.config.js tests/unit/state.test.ts
git commit -m "feat(ui): extract the shell's state machine, DOM-free and tested"
```

---

### Task 7: Drive the shell from the machine

**Files:**
- Modify: `src/ui/shell.ts` (the `entries`/`selected` locals and every reader)

**Interfaces:**
- Consumes: `createState`, `Snapshot`, `FileEntry` (Task 6).
- Produces: no new exports. `shell.ts` keeps `mountShell(root): ShellHandle`.

- [ ] **Step 1: Replace the locals with the machine**

Delete `let entries` and `let selected`. Add:

```ts
  const state = createState(TOOLS);
  let snap = state.snapshot();
```

and subscribe once, before the first paint:

```ts
  state.subscribe((next) => {
    snap = next;
    refreshTools();
    syncRunPanel();
  });
```

- [ ] **Step 2: Point every reader at the snapshot**

Mechanical, throughout the file:

| Was | Becomes |
|---|---|
| `entries` | `snap.entries` |
| `selected` | `snap.selected` |
| `entries = [...entries, ...added]` (in `intake`) | `state.addFiles(added)` |
| `entries = next` (tray `onChange`) | `state.setFiles(next)` |
| the `clearButton` body's three assignments | `state.clearFiles()` |
| `selected = tool` in `select()` | `state.selectTool(id)` |
| `clearSelection()`'s `selected = null` | `state.selectTool(null)` |
| `setRunning(on)`'s `running = on` | `state.setRunning(on)` |

`refreshTools` reads `snap.applicability` instead of calling `applicabilityFor` itself.

- [ ] **Step 3: Add `syncRunPanel`**

The run panel now renders from the snapshot rather than being poked at each call site:

```ts
  /** The run panel is a pure function of the snapshot. */
  function syncRunPanel(): void {
    const tool = snap.selected;
    runPanel.hidden = tool === null;
    if (!tool) return;

    runHeading.textContent = tool.name;
    runBlurb.textContent = tool.blurb;
    runGlyph.replaceChildren(icon(toolIcon(tool)));
    runPanel.dataset.kind = tool.group;

    const blocked = snap.runBlockedReason;
    runButton.disabled = snap.phase === 'running' || blocked !== null;
    runLabel.textContent = blocked ?? 'Run';
  }
```

Give the Run button a addressable label span when it is built:

```ts
  const runLabel = el('span', undefined, 'Run');
  runButton.append(icon('play'), runLabel);
```

- [ ] **Step 4: Prove nothing changed**

```bash
npm run typecheck && npm run lint && npm run test && npm run build && npm run size && npm run test:e2e
```
Expected: all PASS with no test edits.

If `golden.spec.ts` times out waiting for Run to take focus, that is the documented synchronisation signal (its header explains it). Keep `runButton.focus()` at the end of `select()`.

- [ ] **Step 5: Commit**

```bash
git add src/ui/shell.ts
git commit -m "refactor(ui): drive the shell from the state machine"
```

---

# Stage 3 — Two doors, three zones

Ends in one commit.

### Task 8: `ui/zones/catalogue.ts` — one component, two densities

**Files:**
- Create: `src/ui/zones/catalogue.ts`
- Modify: `src/ui/shell.ts` (tool-grid code moves out)

**Interfaces:**
- Consumes: `Snapshot`, `Applicability`, `toolIcon`, `GROUP_ORDER`/`GROUP_TITLE`/`GROUP_ICON`.
- Produces: `createCatalogue(init: { tools: readonly ToolDef[]; onPick: (id: string) => void; onWarm: (tool: ToolDef) => void }): CatalogueHandle` where `CatalogueHandle = { readonly el: HTMLElement; render(snapshot: Snapshot): void; destroy(): void }`.

- [ ] **Step 1: Create the module**

```ts
// src/ui/zones/catalogue.ts — zone 2, in both of its densities.
//
// Cold, this renders all 29 tools grouped by family: the tool-first door.
// With files loaded, the SAME component renders the three applicability tiers.
// One component, because two would drift — and because the whole reason the
// second entry door is cheap is that there is no second landing page.

import { applicabilityFor } from '../../core/format';
import type { ToolDef } from '../../types';
import { el, icon } from '../dom';
import type { Snapshot } from '../state';
import { GROUP_ICON, GROUP_ORDER, GROUP_TITLE, toolIcon } from '../toolicons';

export type CatalogueHandle = {
  readonly el: HTMLElement;
  render(snapshot: Snapshot): void;
  destroy(): void;
};

export function createCatalogue(init: {
  tools: readonly ToolDef[];
  onPick: (id: string) => void;
  onWarm: (tool: ToolDef) => void;
}): CatalogueHandle {
  const root = el('section', 'catalogue');
  root.setAttribute('aria-labelledby', 'catalogue-heading');

  const heading = el('h2', 'panel__title', '');
  heading.id = 'catalogue-heading';
  const count = el('p', 'catalogue__count');
  const head = el('div', 'catalogue__head');
  head.append(heading, count);

  const groups = el('div', 'catalogue__groups');
  const blockedWrap = el('section', 'blocked');
  blockedWrap.hidden = true;
  blockedWrap.append(el('h3', 'blocked__title', 'Not for this selection'));
  const blockedGrid = el('div', 'blocked__grid');
  blockedWrap.append(blockedGrid);

  const utilityWrap = el('section', 'utility');
  utilityWrap.hidden = true;
  utilityWrap.append(el('h3', 'utility__title', 'Works on any file'));
  const utilityBar = el('div', 'utilitybar');
  utilityWrap.append(utilityBar);

  root.append(head, groups, blockedWrap, utilityWrap);

  let selectedId: string | null = null;

  function card(tool: ToolDef): HTMLButtonElement {
    const node = el('button', 'toolcard');
    node.type = 'button';
    node.dataset.tool = tool.id;
    node.dataset.kind = tool.group;
    node.setAttribute('aria-pressed', String(tool.id === selectedId));
    node.classList.toggle('is-selected', tool.id === selectedId);

    const top = el('span', 'toolcard__top');
    const glyph = el('span', 'toolcard__icon');
    glyph.append(icon(toolIcon(tool)));
    const check = el('span', 'toolcard__check');
    check.append(icon('check'));
    top.append(glyph, el('span', 'toolcard__name', tool.name), check);
    node.append(top, el('span', 'toolcard__blurb', tool.blurb));

    const warm = (): void => init.onWarm(tool);
    node.addEventListener('pointerenter', warm);
    node.addEventListener('focus', warm);
    node.addEventListener('click', () => init.onPick(tool.id));
    return node;
  }

  function renderGroups(list: readonly ToolDef[]): void {
    groups.replaceChildren();
    for (const group of GROUP_ORDER) {
      const inGroup = list.filter((tool) => tool.group === group);
      if (inGroup.length === 0) continue;

      const section = el('div', 'toolgroup');
      section.dataset.kind = group;
      const glyph = el('span', 'toolgroup__icon');
      glyph.append(icon(GROUP_ICON[group]));
      const groupHead = el('div', 'toolgroup__head');
      groupHead.append(
        glyph,
        el('h3', 'toolgroup__title', GROUP_TITLE[group]),
        el('span', 'toolgroup__count', String(inGroup.length)),
      );
      const grid = el('div', 'toolgroup__grid');
      for (const tool of inGroup) grid.append(card(tool));
      section.append(groupHead, grid);
      groups.append(section);
    }
  }

  return {
    el: root,
    render(snapshot) {
      selectedId = snapshot.selected?.id ?? null;

      // COLD: the tool-first door. Every tool, generators included.
      if (snapshot.entries.length === 0) {
        heading.textContent = 'All tools';
        count.textContent = `${init.tools.length} tools, in three families. Pick one, or drop files to narrow the list.`;
        renderGroups(init.tools);
        blockedWrap.hidden = true;
        utilityWrap.hidden = true;
        return;
      }

      // WARM: the three tiers.
      const { primary, blocked, utility } = snapshot.applicability;
      const subject = snapshot.entries.length === 1 ? 'this file' : `these ${snapshot.entries.length} files`;
      const runnable = primary.length + utility.length;

      heading.textContent = 'Tools for these files';
      count.textContent =
        runnable === 0 ? '' : `${runnable === 1 ? '1 tool' : `${runnable} tools`} can run on ${subject}.`;

      renderGroups(primary);

      blockedGrid.replaceChildren();
      for (const { tool, reason } of blocked) {
        const node = card(tool);
        node.classList.add('toolcard--blocked');
        node.disabled = true;
        node.append(el('span', 'toolcard__reason', reason));
        blockedGrid.append(node);
      }
      blockedWrap.hidden = blocked.length === 0;

      utilityBar.replaceChildren();
      for (const tool of utility) {
        const pill = el('button', 'utilitypill');
        pill.type = 'button';
        pill.dataset.tool = tool.id;
        pill.classList.toggle('is-selected', tool.id === selectedId);
        pill.setAttribute('aria-pressed', String(tool.id === selectedId));
        pill.append(icon(toolIcon(tool)), el('span', undefined, tool.name));
        pill.addEventListener('click', () => init.onPick(tool.id));
        utilityBar.append(pill);
      }
      utilityWrap.hidden = utility.length === 0;
    },
    destroy() {
      root.replaceChildren();
    },
  };
}
```

Remove the now-unused `applicabilityFor` import if lint flags it — the snapshot already carries the buckets.

- [ ] **Step 2: Delete the shell's grid code**

Remove from `shell.ts`: `toolsPanel`, `toolsHead`, `toolsHeading`, `toolsCount`, `toolsGrid`, `toolsEmpty`, `blockedGrid`, `utilityWrap`, `utilityBar`, `toolCard`, `markSelected`, `gridSignature`, and the body of `refreshTools`. Replace with:

```ts
  const catalogue = createCatalogue({
    tools: TOOLS,
    onPick: (id) => void select(id),
    onWarm: prefetchTool,
  });

  function refreshTools(): void {
    catalogue.render(snap);
    syncEditor();
  }
```

Append `catalogue.el` where `toolsPanel` was appended, and add `catalogue.destroy();` to `destroy()`.

The reveal-stagger (`revealTools`) moves into the catalogue as a first-paint-only effect, exactly as it was: a module-level `let revealed = false` guarded by `if (!revealed && cards.length > 0)`.

- [ ] **Step 3: Run the gate**

```bash
npm run typecheck && npm run lint && npm run test && npm run build && npm run test:e2e
```
Expected: PASS. The catalogue now renders when cold, which is new — the hero still covers it until Task 10 restyles the stage, so e2e should be unaffected.

- [ ] **Step 4: Commit**

```bash
git add src/ui/zones/catalogue.ts src/ui/shell.ts
git commit -m "feat(ui): make the tool grid and the landing catalogue one component"
```

---

### Task 9: Zones 1 and 3

**Files:**
- Create: `src/ui/zones/files.ts`, `src/ui/zones/work.ts`
- Modify: `src/ui/shell.ts`

**Interfaces:**
- Consumes: `Snapshot`, `createFileTray`, `createDropzone`, `renderOptions`, `createProgressRing`, `createResults`.
- Produces:
  - `createFilesZone(init: { addbar: HTMLElement; tray: FileTrayHandle; onClear: () => void }): ZoneHandle`
  - `createWorkZone(init: { onRun: () => void; onCancel: () => void }): WorkZoneHandle` where `WorkZoneHandle = ZoneHandle & { readonly options: HTMLElement; readonly results: ResultsHandle; readonly progress: ProgressHandle; focusRun(): void }`
  - `type ZoneHandle = { readonly el: HTMLElement; render(snapshot: Snapshot): void; destroy(): void }`

- [ ] **Step 1: Create `src/ui/zones/files.ts`**

```ts
// src/ui/zones/files.ts — zone 1. Intake and order, nothing else.
//
// The tray and the add-bar already exist and already work; this zone owns
// where they sit and when the "remove all" control is live.

import { el } from '../dom';
import type { FileTrayHandle } from '../filetray';
import type { Snapshot } from '../state';

export type ZoneHandle = {
  readonly el: HTMLElement;
  render(snapshot: Snapshot): void;
  destroy(): void;
};

export function createFilesZone(init: {
  addbar: HTMLElement;
  tray: FileTrayHandle;
  onClear: () => void;
}): ZoneHandle {
  const root = el('aside', 'zone zone--files');
  root.setAttribute('aria-labelledby', 'files-heading');

  const heading = el('h2', 'panel__title', 'Files');
  heading.id = 'files-heading';
  const empty = el('p', 'zone__empty', 'No files yet. Drop, paste, or choose them — or pick a tool first.');

  const clear = el('button', 'btn btn--quiet btn--sm clearbtn', 'Remove all files');
  clear.type = 'button';
  clear.addEventListener('click', init.onClear);

  root.append(heading, init.addbar, empty, init.tray.el, clear);

  return {
    el: root,
    render(snapshot) {
      const has = snapshot.entries.length > 0;
      empty.hidden = has;
      init.tray.el.hidden = !has;
      clear.hidden = !has;
      clear.disabled = snapshot.phase === 'running';
    },
    destroy() {
      clear.removeEventListener('click', init.onClear);
    },
  };
}
```

- [ ] **Step 2: Create `src/ui/zones/work.ts`**

```ts
// src/ui/zones/work.ts — zone 3. Everything about the CHOSEN tool.
//
// Options, Run, progress and results live here together and never move, which
// is the point of the three-zone layout: picking a tool low in the catalogue
// used to push its own options off-screen.

import { el, icon } from '../dom';
import { createProgressRing, type ProgressHandle } from '../progress';
import { createResults, type ResultsHandle } from '../results';
import type { Snapshot } from '../state';
import { toolIcon } from '../toolicons';
import type { ZoneHandle } from './files';

export type WorkZoneHandle = ZoneHandle & {
  /** Where the option panel mounts. Owned by the shell, which builds it. */
  readonly options: HTMLElement;
  readonly results: ResultsHandle;
  readonly progress: ProgressHandle;
  focusRun(): void;
};

export function createWorkZone(init: { onRun: () => void; onCancel: () => void }): WorkZoneHandle {
  const root = el('section', 'zone zone--work');
  root.setAttribute('aria-labelledby', 'work-heading');

  const empty = el('div', 'zone__empty');
  empty.append(
    el('p', undefined, 'Pick a tool to get started.'),
    el('p', 'zone__hint', 'Some tools need files; the QR code generator does not.'),
  );

  const glyph = el('span', 'run__glyph');
  const heading = el('h2', 'panel__title', '');
  heading.id = 'work-heading';
  const blurb = el('p', 'run__blurb');
  const titles = el('div', 'run__titles');
  titles.append(heading, blurb);
  const head = el('div', 'run__head');
  head.append(glyph, titles);

  const options = el('div', 'run__options');

  const runButton = el('button', 'btn btn--primary');
  runButton.type = 'button';
  const runLabel = el('span', undefined, 'Run');
  runButton.append(icon('play'), runLabel);
  runButton.addEventListener('click', init.onRun);

  const cancel = el('button', 'btn btn--ghost', 'Cancel');
  cancel.type = 'button';
  cancel.hidden = true;
  cancel.addEventListener('click', init.onCancel);

  const progress = createProgressRing();
  const progressWrap = el('div', 'run__progress');
  progressWrap.hidden = true;
  progressWrap.append(progress.el);

  const bar = el('div', 'run__bar');
  bar.append(runButton, cancel, progressWrap);

  const results = createResults();
  const panel = el('div', 'run');
  panel.hidden = true;
  panel.append(head, options, bar, results.el);

  root.append(empty, panel);

  return {
    el: root,
    options,
    results,
    progress,
    focusRun: () => runButton.focus(),
    render(snapshot) {
      const tool = snapshot.selected;
      empty.hidden = tool !== null;
      panel.hidden = tool === null;
      if (!tool) return;

      heading.textContent = tool.name;
      blurb.textContent = tool.blurb;
      glyph.replaceChildren(icon(toolIcon(tool)));
      panel.dataset.kind = tool.group;

      const running = snapshot.phase === 'running';
      const blocked = snapshot.runBlockedReason;
      // The reason IS the label: a disabled button with no explanation is the
      // thing this overhaul exists to remove.
      runLabel.textContent = blocked ?? 'Run';
      runButton.disabled = running || blocked !== null;
      cancel.hidden = !running;
      progressWrap.hidden = !running;
    },
    destroy() {
      runButton.removeEventListener('click', init.onRun);
      cancel.removeEventListener('click', init.onCancel);
    },
  };
}
```

- [ ] **Step 3: Rewire `shell.ts`**

Replace the hand-built `runPanel` block and `filesPanel` with the two zones, delete `syncRunPanel` (the work zone owns it), and point the subscriber at all three:

```ts
  state.subscribe((next) => {
    snap = next;
    filesZone.render(snap);
    catalogue.render(snap);
    workZone.render(snap);
    syncEditor();
  });
```

`start()` keeps its body but reads `workZone.progress` / `workZone.results`, and `select()` ends with `workZone.focusRun()`.

- [ ] **Step 4: Run the gate**

```bash
npm run typecheck && npm run lint && npm run test && npm run build && npm run test:e2e
```
Expected: PASS. e2e selectors for `.run`, `.toolcard` and the results tray are preserved by construction; fix any selector drift in the specs rather than renaming the classes back.

- [ ] **Step 5: Commit**

```bash
git add src/ui/zones/files.ts src/ui/zones/work.ts src/ui/shell.ts
git commit -m "feat(ui): split the workbench into files, catalogue and work zones"
```

---

### Task 10: The three-zone layout and the second door

**Files:**
- Modify: `src/styles/app.css:477-500` (`.workbench`) and the hero block
- Modify: `src/ui/dropzone.ts:96-190` (hero) — the catalogue replaces the static family list
- Modify: `src/ui/shell.ts` (`showHero`/`showWorkbench` collapse into one stage)

**Interfaces:**
- Consumes: `CatalogueHandle` (Task 8).
- Produces: `createDropzone` gains `catalogue: HTMLElement` in its init and drops `onBrowse`. The hero renders it beneath the drop panel.

- [ ] **Step 1: Put the catalogue on the landing screen**

In `dropzone.ts`, change the init type: delete `onBrowse` and `toolCount`, add `catalogue: HTMLElement`.

Delete the `FAMILIES` constant and the `families` block that renders it — the real catalogue replaces that stand-in. Replace the `browseButton` with nothing (the catalogue below is the browse affordance) and change the hero append to:

```ts
  hero.append(drop, facts, init.catalogue, picker);
```

Update the hint copy under the buttons:

```ts
  const sub = el(
    'p',
    'hero__sub',
    'Drop files and the list below narrows to what can run on them — or pick a tool from it and bring the files after.',
  );
```

- [ ] **Step 2: One stage, three zones**

In `shell.ts`, delete `showHero`, `showWorkbench`, the `stageswitch` wrapper and the `workbench.hidden` handling. The stage is always the same three zones; the hero is the `browsing` presentation of them:

```ts
  const stageEl = el('div', 'workbench');
  stageEl.append(filesZone.el, catalogue.el, workZone.el);
  stage.append(dropzone.hero, stageEl);
```

**Keep `morphToTray`.** It is still the right transition — the browsing screen
handing over to the workbench — and it already carries the reduced-motion
handling and the two tests in `motion.browser.test.ts`. It is now driven by the
phase leaving `browsing` rather than by the old subtree swap. In the subscriber:

```ts
  let wasCold = true;

  state.subscribe((next) => {
    snap = next;
    stage.dataset.phase = snap.phase;
    filesZone.render(snap);
    catalogue.render(snap);
    workZone.render(snap);
    syncEditor();

    const cold = snap.entries.length === 0 && snap.selected === null;
    if (wasCold && !cold) {
      // The one transition worth animating: the landing screen giving way.
      dropzone.hero.classList.add('is-exiting');
      void morphToTray(dropzone.hero, stageEl).then(() => {
        dropzone.hero.hidden = true;
      });
    } else if (!wasCold && cold) {
      dropzone.hero.classList.remove('is-exiting');
      dropzone.hero.style.opacity = '';
      dropzone.hero.style.transform = '';
      dropzone.hero.hidden = false;
    }
    wasCold = cold;
  });
```

The subscriber stays synchronous — `morphToTray` is fired and awaited off to the
side, so a render is never blocked on an animation, and nothing functional
depends on it finishing (spec §7.5's reduced-motion promise).

- [ ] **Step 3: The layout CSS**

Replace the `.workbench` block in `app.css` with:

```css
/* ---------------------------------------------------------- three zones
 * files · tools · work. The work zone is fixed so that options, Run and
 * results never scroll out from under the person using them — the single
 * biggest complaint about the old one-column stack. */
.workbench {
  display: grid;
  gap: var(--s-4);
  grid-template-columns: minmax(0, 1fr);
  align-items: start;
}

/* Two zones: files and catalogue share the left, work is pinned right. */
@media (min-width: 48rem) {
  .workbench { grid-template-columns: minmax(0, 1fr) minmax(0, 20rem); }
  .zone--files    { grid-column: 1; }
  .catalogue      { grid-column: 1; }
  .zone--work     { grid-column: 2; grid-row: 1 / span 2; position: sticky; top: var(--s-4); }
}

/* Three zones. */
@media (min-width: 75rem) {
  .workbench { grid-template-columns: minmax(0, 17rem) minmax(0, 1fr) minmax(0, 22rem); }
  .zone--files { grid-column: 1; grid-row: 1; position: sticky; top: var(--s-4); }
  .catalogue   { grid-column: 2; grid-row: 1; }
  .zone--work  { grid-column: 3; grid-row: 1; }
}

/* Narrow: one step open at a time. Picking a tool folds the catalogue away,
 * so the work zone is on screen without adding a second implementation. */
@media (max-width: 47.99rem) {
  [data-phase='tool-picked'] .catalogue,
  [data-phase='ready'] .catalogue,
  [data-phase='running'] .catalogue,
  [data-phase='results'] .catalogue { display: none; }
}
```

Add the fold-away control, rendered by the catalogue only when a tool is selected — a button that calls `onPick` with the current id to deselect. Put it in `catalogue.render`'s warm branch:

```ts
      backBar.hidden = selectedId === null;
```

with, at build time:

```ts
  const backBar = el('div', 'catalogue__back');
  const back = el('button', 'btn btn--quiet btn--sm', 'Change tool');
  back.type = 'button';
  back.addEventListener('click', () => { if (selectedId) init.onPick(selectedId); });
  backBar.append(back);
  backBar.hidden = true;
```

appended into `root` before `groups`. `onPick` with the already-selected id toggles it off, which is the existing `select()` behaviour.

- [ ] **Step 4: Verify in the browser**

Start the dev server and check all three widths, both themes:

```bash
npm run dev
```

Confirm: cold landing shows the catalogue with QR present; picking QR fills the work zone with Run enabled and no files; dropping 2 PDFs narrows the catalogue and shows the blocked *Organize pages*; at 375px wide, picking a tool folds the catalogue.

- [ ] **Step 5: Run the gate**

```bash
npm run typecheck && npm run lint && npm run contrast && npm run test && npm run build && npm run size && npm run test:e2e
```
Expected: PASS except a11y and any golden test asserting the hero — those are Task 11.

- [ ] **Step 6: Commit**

```bash
git add src/ui/dropzone.ts src/ui/shell.ts src/ui/zones/catalogue.ts src/styles/app.css
git commit -m "feat(ui): open the second door and lay the workbench out in three zones"
```

---

### Task 11: Accessibility and the tool-first e2e flows

**Files:**
- Modify: `tests/e2e/a11y.spec.ts`
- Create: `tests/e2e/tool-first.spec.ts`

**Interfaces:**
- Consumes: everything from Tasks 8–10.
- Produces: no source exports; this task may change source to satisfy the tests.

- [ ] **Step 1: Write the failing tool-first spec**

Create `tests/e2e/tool-first.spec.ts`:

```ts
// tests/e2e/tool-first.spec.ts — the SECOND entry door.
//
// Everything here starts from a cold landing screen with no file ever
// dropped, which the old app could not express at all: it filtered the tool
// list to nothing until a file arrived, so the one tool that needs no file
// was reachable only by supplying one it then ignored.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const fixturePath = (name: string): string => path.join(FIXTURES, name);

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
});

test('shows every tool before any file is dropped', async ({ page }) => {
  await expect(page.locator('.toolcard')).toHaveCount(29);
  await expect(page.locator('.toolcard[data-tool="qr-generate"]')).toBeVisible();
});

test('generates a QR code without a file ever being dropped', async ({ page }) => {
  await page.locator('.toolcard[data-tool="qr-generate"]').click();

  const run = page.getByRole('button', { name: 'Run' });
  await expect(run).toBeEnabled();

  await page.getByLabel('Text or URL').fill('https://example.com');
  const download = page.waitForEvent('download');
  await run.click();

  const file = await download;
  expect(file.suggestedFilename()).toMatch(/\.png$/);
});

test('asks for what a file tool needs instead of failing', async ({ page }) => {
  await page.locator('.toolcard[data-tool="pdf-merge"]').click();

  // The reason IS the button label — never a dead disabled control.
  const run = page.getByRole('button', { name: /Needs at least 2 files/ });
  await expect(run).toBeDisabled();

  await page
    .locator('input[type=file]')
    .setInputFiles([fixturePath('small.pdf'), fixturePath('small.pdf')]);

  await expect(page.getByRole('button', { name: 'Run' })).toBeEnabled();
});

test('explains a tool blocked only on count, rather than hiding it', async ({ page }) => {
  await page
    .locator('input[type=file]')
    .setInputFiles([fixturePath('small.pdf'), fixturePath('small.pdf')]);

  const organize = page.locator('[data-tool="pdf-organize"]');
  await expect(organize).toBeVisible();
  await expect(organize).toContainText('Needs exactly 1 file');
  await expect(organize).toBeDisabled();
});
```

- [ ] **Step 2: Run it**

Run: `npx playwright test tests/e2e/tool-first.spec.ts`
Expected: FAIL initially; fix source until green. The QR download exercises `core/fs.ts`'s single-file path unchanged.

- [ ] **Step 3: Rework the a11y suite**

In `tests/e2e/a11y.spec.ts`, replace the file's header note about the hero with the three-zone reality, and add two tests:

```ts
test('gives each zone a labelled landmark', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('aside[aria-labelledby="files-heading"]')).toBeVisible();
  await expect(page.locator('section[aria-labelledby="catalogue-heading"]')).toBeVisible();
  await expect(page.locator('section[aria-labelledby="work-heading"]')).toBeVisible();
});

test('reaches a tool card, then its Run button, by keyboard alone', async ({ page }) => {
  await page.goto('/');
  const toCard = await tabUntil(page, (info) => info.label?.startsWith('Merge PDFs') === true);
  expect(toCard).toBeLessThan(40);

  await page.keyboard.press('Enter');
  // select() moves focus onto Run once the option panel has mounted.
  await expect(page.getByRole('button', { name: /Needs at least 2 files|Run/ })).toBeFocused();
});
```

Any existing assertion that tabs to "Browse the tools" must be updated — that button no longer exists.

- [ ] **Step 4: Run the full gate**

```bash
npm run typecheck && npm run lint && npm run contrast && npm run test && npm run build && npm run size && npm run test:e2e
```
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/a11y.spec.ts tests/e2e/tool-first.spec.ts
git commit -m "test(e2e): cover the tool-first door and the three-zone landmarks"
```

---

# Stage 4 — Router and docs

Ends in one commit.

### Task 12: `ui/router.ts`

**Files:**
- Create: `src/ui/router.ts`
- Test: `tests/unit/router.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `toolIdFromHash(hash: string): string | null`, `hashForTool(id: string | null): string`, and `createRouter(init: { isKnownTool: (id: string) => boolean; onRoute: (id: string | null) => void }): { navigate(id: string | null): void; start(): void; destroy(): void }`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/router.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { hashForTool, toolIdFromHash } from '../../src/ui/router';

describe('toolIdFromHash', () => {
  it('reads a tool id', () => {
    expect(toolIdFromHash('#/merge-pdfs')).toBe('merge-pdfs');
    expect(toolIdFromHash('#/qr-generate')).toBe('qr-generate');
  });

  it('treats the root and an empty hash as the catalogue', () => {
    expect(toolIdFromHash('#/')).toBeNull();
    expect(toolIdFromHash('#')).toBeNull();
    expect(toolIdFromHash('')).toBeNull();
  });

  it('ignores a trailing slash and decodes percent-escapes', () => {
    expect(toolIdFromHash('#/merge-pdfs/')).toBe('merge-pdfs');
    expect(toolIdFromHash('#/csv%2Djson')).toBe('csv-json');
  });

  it('rejects a nested path rather than guessing', () => {
    expect(toolIdFromHash('#/merge-pdfs/extra')).toBeNull();
  });
});

describe('hashForTool', () => {
  it('round-trips every shape', () => {
    expect(hashForTool('merge-pdfs')).toBe('#/merge-pdfs');
    expect(hashForTool(null)).toBe('#/');
    expect(toolIdFromHash(hashForTool('qr-generate'))).toBe('qr-generate');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project node tests/unit/router.test.ts`
Expected: FAIL — cannot resolve `../../src/ui/router`.

- [ ] **Step 3: Implement `src/ui/router.ts`**

```ts
// src/ui/router.ts — hash <-> tool id, and nothing else.
//
// The original design spec called for hash routing in §1 and it was never
// built. A hash is the right mechanism here for a reason worth stating: it
// never reaches the network, so a deep link needs no service-worker rule and
// no server rewrite — `#/merge-pdfs` is the same document request as `/`.
//
// FILES ARE NEVER IN THE URL. They stay in memory. A shared link opens the
// tool empty, so it can never carry anyone's data anywhere.

/** The tool id in `hash`, or null for the catalogue. */
export function toolIdFromHash(hash: string): string | null {
  const path = hash.replace(/^#/, '').replace(/\/$/, '');
  if (path === '' || path === '/') return null;
  const id = path.startsWith('/') ? path.slice(1) : path;
  // One segment only — a nested path is a typo, not a route to guess at.
  if (id === '' || id.includes('/')) return null;
  try {
    return decodeURIComponent(id);
  } catch {
    return null;
  }
}

export function hashForTool(id: string | null): string {
  return id === null ? '#/' : `#/${encodeURIComponent(id)}`;
}

export type RouterHandle = {
  /** Push a route without re-entering `onRoute`. */
  navigate(id: string | null): void;
  /** Read the current URL and fire `onRoute` once. */
  start(): void;
  destroy(): void;
};

export function createRouter(init: {
  isKnownTool: (id: string) => boolean;
  onRoute: (id: string | null) => void;
}): RouterHandle {
  // Set while WE are writing the hash, so our own write does not echo back
  // through hashchange and re-select what is already selected.
  let writing = false;

  function read(): string | null {
    const id = toolIdFromHash(location.hash);
    // An unknown id falls back to the catalogue rather than a blank screen.
    return id !== null && init.isKnownTool(id) ? id : null;
  }

  const onHashChange = (): void => {
    if (writing) return;
    init.onRoute(read());
  };

  window.addEventListener('hashchange', onHashChange);

  return {
    navigate(id) {
      const next = hashForTool(id);
      if (location.hash === next) return;
      writing = true;
      location.hash = next;
      // hashchange is async; clear the guard after it has been delivered.
      setTimeout(() => {
        writing = false;
      }, 0);
    },
    start() {
      init.onRoute(read());
    },
    destroy() {
      window.removeEventListener('hashchange', onHashChange);
    },
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `npm run typecheck && npm run lint && npx vitest run --project node`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/router.ts tests/unit/router.test.ts
git commit -m "feat(ui): add the hash router the original spec called for"
```

---

### Task 13: Wire the router, and make the palette bucket-aware

**Files:**
- Modify: `src/ui/shell.ts`
- Modify: `src/ui/palette.ts` (call site only — `unavailableReason` is supplied by the shell)
- Modify: `tests/e2e/tool-first.spec.ts`

**Interfaces:**
- Consumes: `createRouter` (Task 12), `runBlockedReason` (Task 6).
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Append to `tests/e2e/tool-first.spec.ts`:

```ts
test('gives a tool its own URL, and keeps back inside the app', async ({ page }) => {
  await page.locator('.toolcard[data-tool="qr-generate"]').click();
  await expect(page).toHaveURL(/#\/qr-generate$/);

  await page.goBack();
  await expect(page).toHaveURL(/#\/$|\/$/);
  await expect(page.locator('.toolcard')).toHaveCount(29);

  await page.goForward();
  await expect(page.locator('.toolcard[data-tool="qr-generate"]')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('opens a deep link straight into the tool, with no files attached', async ({ page }) => {
  await page.goto('/#/merge-pdfs');
  await expect(page.getByRole('heading', { name: 'Merge PDFs' })).toBeVisible();
  await expect(page.locator('.tray__item')).toHaveCount(0);
});

test('falls back to the catalogue for an unknown tool id', async ({ page }) => {
  await page.goto('/#/not-a-real-tool');
  await expect(page.locator('.toolcard')).toHaveCount(29);
});
```

- [ ] **Step 2: Run it**

Run: `npx playwright test tests/e2e/tool-first.spec.ts -g "own URL"`
Expected: FAIL — the URL never changes.

- [ ] **Step 3: Wire it in the shell**

```ts
  const router = createRouter({
    isKnownTool: (id) => getTool(id) !== undefined,
    onRoute: (id) => void select(id, { fromRouter: true }),
  });
```

Give `select` the flag so a route-driven selection does not write the hash back, and so it never toggles off:

```ts
  async function select(id: string | null, opts: { fromRouter?: boolean } = {}): Promise<void> {
    if (snap.phase === 'running') return;

    // A click on the CURRENT tool deselects; a route never does.
    if (!opts.fromRouter && id !== null && snap.selected?.id === id) {
      state.selectTool(null);
      router.navigate(null);
      announce('Tool deselected.');
      return;
    }

    const tool = id === null ? null : getTool(id);
    state.selectTool(tool?.id ?? null);
    if (!opts.fromRouter) router.navigate(tool?.id ?? null);
    if (!tool) return;

    announce(`${tool.name} selected. ${tool.blurb}`);
    await mountOptions(tool);
    if (snap.selected?.id !== id) return;
    workZone.focusRun();
  }
```

Call `router.start()` once, after the first render, and add `router.destroy()` to `destroy()`.

- [ ] **Step 4: Make the palette bucket-aware**

Replace `unavailableReason` in `shell.ts` with:

```ts
  /**
   * Why `tool` can't run right now, or null when it can.
   *
   * A generator is always runnable — it reads no file. A tool that merely
   * needs files reports WHAT it needs, so the palette invites rather than
   * refuses: selecting it and dropping the files afterwards is a real flow.
   */
  function unavailableReason(tool: ToolDef): string | null {
    if (tool.kind === 'generate') return null;
    return runBlockedReason(tool, snap.entries.map((entry) => entry.type));
  }
```

- [ ] **Step 5: Run the full gate**

```bash
npm run typecheck && npm run lint && npm run contrast && npm run test && npm run build && npm run size && npm run test:e2e
```
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ui/shell.ts tests/e2e/tool-first.spec.ts
git commit -m "feat(ui): route tools by hash and let the palette invite rather than refuse"
```

---

### Task 14: Rewrite the documentation

**Files:**
- Modify: `README.md` ("Getting around", "The tools", "Project structure")
- Modify: `docs/superpowers/specs/2026-08-29-omnitool-design.md` (§7)

**Interfaces:**
- Consumes: the finished behaviour.
- Produces: documentation matching it.

- [ ] **Step 1: Rewrite the README's "Getting around"**

Replace the "Drop first, choose second" paragraph with:

```markdown
**Two doors, both first-class.** Drop your files and the tool list narrows to
what can actually run on them — drop two PDFs and you get PDF tools. Or pick a
tool first and bring the files after; the tool tells you what it needs instead
of refusing. Tools that need no files at all, like the QR code generator, just
open and run.

- **Drag, paste, or pick.** Drop files anywhere in the window, paste with
  `Ctrl/Cmd+V`, or use the Choose files button.
- **Every tool has its own address.** `#/merge-pdfs` is bookmarkable and
  shareable, and the back button moves between a tool and the catalogue rather
  than leaving the app. Files are never in the URL — a link you share opens the
  tool empty.
- **Tools that don't fit are explained, not hidden.** A tool that works on your
  file type but wants a different number of them stays visible and says so
  ("Needs exactly 1 file — you have 2"). A tool for a different format entirely
  is simply absent, so the list stays scannable.
- **Tools that work on any bytes** — zip, hash, Base64, gzip — sit in a quiet
  row of their own rather than competing with the tools that understand your
  format.
- **Order matters for merging**, so the file tray is reorderable…
```

(keep the remaining bullets on reordering, `Ctrl/Cmd+K`, keyboard operation and reduced motion unchanged)

- [ ] **Step 2: Update the project structure block**

In the `src/` tree in the README, add under `ui/`:

```
  ui/                # DOM, dropzone, results tray, command palette, animation
    state.ts         #   the state machine — DOM-free, unit-tested under Node
    router.ts        #   hash <-> tool id
    zones/           #   files · catalogue · work
```

- [ ] **Step 3: Supersede §7 of the original spec**

At the top of `docs/superpowers/specs/2026-08-29-omnitool-design.md`'s §7, insert:

```markdown
> **Superseded (2026-08-30).** §7.1 ("drop first, choose second") and §7.2
> ("one screen, no navigation") describe the v1 model. They were replaced by
> [2026-08-30-ui-overhaul-design.md](./2026-08-30-ui-overhaul-design.md): two
> equal entry doors, a three-zone workbench, and the hash routing §1 of this
> document already called for. §7.3–§7.5 (components, option schema, theme and
> accessibility) still hold.
```

- [ ] **Step 4: Verify every README claim still holds**

Re-read the "Known limitations" section against the code — none of them were touched by this work, so all should still be accurate. Confirm the tool count in the README's tables is still 29.

Run: `npm run build && npm run size`
Expected: PASS — confirm the reported initial JS/CSS numbers still sit under budget, and update any size figure quoted in the README to the real one.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/superpowers/specs/2026-08-29-omnitool-design.md
git commit -m "docs: describe the two doors, three zones and hash routing"
```

---

## Self-Review

**Spec coverage.** Every section maps to a task:

| Spec § | Task |
|---|---|
| §3.1 second axis | 1 |
| §3.2 metadata-only rule | 1 (comment), 3 (predicates) |
| §3.3 buckets | 2, 4, 8 |
| §3.4 tool changes | 1 (`qr-generate`, `file-join`), 3 (presets) |
| §4.1 shell split | 5, 6, 8, 9 |
| §4.2 state machine | 6, 7 |
| §4.3 layout + responsive | 10 |
| §4.4 routing | 12, 13 |
| §4.5 palette | 13 |
| §5 testing | 1, 2, 3, 6, 11, 12 |
| §6 documentation | 14 |
| §7 staging | stage boundaries |

**Known deviation from the spec, deliberate:** blocked reasons are type-agnostic (see the Wording note above).

**Type consistency.** `FileEntry` is defined in Task 6 and aliased by `filetray.ts` in the same task. `ZoneHandle` is defined in `zones/files.ts` (Task 9) and imported by `zones/work.ts` in the same task. `Applicability`/`BlockedTool` come from Task 2 and are consumed in 4, 6 and 8. `runBlockedReason` is defined in Task 6 and reused in Task 13. `derivePhase` takes `runBlocked` as an input rather than recomputing it, so its Task 6 tests and its one caller (`snapshot()`) agree. `select()` gains its `opts` parameter in Task 13 only; Tasks 8–10 call it with one argument, which stays valid.

**Verified against the codebase while writing this plan** — these are the values the plan's code depends on, checked rather than assumed:

| Claim | Verified |
|---|---|
| CSS tokens | `--s-1`…`--s-8`, `--fs-xs`/`--fs-sm`, `--bg`/`--bg-1..3`, `--line`/`--line-2`, `--ink`/`--ink-2`/`--ink-3`, `--r-pill` (`tokens.css`) |
| File tray row class | `.tray__item` (`filetray.ts:185`) |
| Option label association | `label.htmlFor = id` (`optionspanel.ts:172`), so `getByLabel('Text or URL')` resolves |
| Option row container | `row` (`optionspanel.ts:270`) |
| QR option label | `'Text or URL'` (`registry.data.ts`) |
| `pdf-merge` options | none — which is why it gets no `preset` |
| Vitest node project | `tests/unit/**/*.test.ts` minus `*.browser.test.ts` (`vitest.workspace.ts`) |
