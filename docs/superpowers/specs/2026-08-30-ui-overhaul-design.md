# omnitool — UI/UX Overhaul Design Spec

- **Date:** 2026-08-30
- **Status:** Approved
- **Owner:** Kim Duy NGUYEN
- **Supersedes:** §7 (UX specification) of
  [2026-08-29-omnitool-design.md](./2026-08-29-omnitool-design.md). Everything
  else in that spec — the op contract, module boundaries, worker pool,
  performance budgets, error handling — stands unchanged.

## 1. The problem

One structural decision produces every symptom. `ToolDef` describes a tool on a
single axis: `accepts` (mime patterns) plus `minInputs`/`maxInputs`. The shell
derives everything from that axis — what the grid shows, what the palette says,
whether a tool is reachable at all.

But the 29 tools are not one kind of thing. Three kinds share that one axis, and
two of them fit it badly:

- **Transformers** (Merge PDFs, Resize image) — files in, files out. `accepts`
  describes them completely. This is what the model was built for.
- **Generators** (Generate QR code) — take text, produce a file, read no input.
  There is nothing for `accepts` to describe.
- **Universal utilities** (Hash, Base64, Zip, Gzip, TAR, Split file) — genuinely
  run on any bytes, but are never the reason anyone opened the app.

Forcing all three onto one axis produces, in order of how visible each is:

1. **The QR code is only reachable by supplying a file it then ignores.**
   `registry.data.ts` declares `minInputs: 0`, but `shell.ts` hard-codes
   `entries.length === 0 ? [] : toolsFor(mimes())`. With no files there are no
   tools, so the one tool that needs no file cannot be reached — and once a file
   *is* dropped, QR appears in the grid as a tool *for that file*.
2. **"Browse the tools" is a dead end.** The hero's own button opens the command
   palette, where — with no files loaded — all 29 tools read *"Not for these
   files."* The invitation to explore lands on 29 refusals.
3. **The grid is mostly noise.** Two PDFs produce 14 cards: 6 that understand
   PDFs and 8 byte-level utilities at identical visual weight. *Join file parts*
   is offered as prominently as *Merge PDFs*, though on two unrelated PDFs it
   would produce a byte-wise concatenation nobody asked for — a legitimate
   operation presented as an obvious one.
4. **Tools vanish without explanation.** Adding a second PDF removes *Organize
   pages* (`maxInputs: 1`) from the grid with no trace. Inapplicable tools are
   absent by design, which is right for a wrong *type* and wrong for a wrong
   *count*.
5. **The app asks what it already knows.** Drop a `.gz` and Gzip defaults to
   *Compress*. Drop a `.txt` and CSV ⇄ JSON defaults to *CSV to JSON*. The
   sniffed type is right there and no tool reads it.
6. **The run panel sits below a long grid.** Selecting a tool low in the grid
   puts its options off-screen; results land below that again.

## 2. Decisions

| # | Decision | Rejected alternative |
|---|---|---|
| 1 | **Two equal entry doors.** Drop-first stays the fast path; tool-first becomes first-class. | Keeping drop-first absolute and giving generators a separate surface; inverting to tool-first only. |
| 2 | **Two-tier grid.** Format-aware tools prominent, universal utilities in a quiet secondary row. | One flat grid reordered; hiding utilities behind a toggle. |
| 3 | **Infer the obvious, show the reasoning.** Tools preset options from file metadata, with the control visible and the reason stated. | Splitting the direction-flip tools into separate registry entries (Compress/Decompress as two cards), which would grow the catalogue by four; doing both that and inference. |
| 4 | **Tools get hash URLs.** `#/merge-pdfs` is bookmarkable; back/forward stay in the app. | One URL forever; deferring the router to later work. |

Decision 4 restores an intent from the original spec's §1 — *"Routing is
hash-based accordingly"* — that was never implemented.

## 3. The tool model

### 3.1 The second axis

```ts
export type ToolKind =
  | 'transform'   // files in, files out — `accepts` describes it fully
  | 'generate'    // no files at all: options in, files out
  | 'utility';    // works on any bytes; never the reason you came

/** What a registry predicate is allowed to see: metadata, never bytes. */
export type SniffedFile = { name: string; size: number; type: string };

export type ToolDef = {
  // …existing fields unchanged…
  kind: ToolKind;

  /** Option defaults derived from the inputs, each with a reason to show. */
  preset?: (files: readonly SniffedFile[]) => {
    values:  Record<string, unknown>;
    because: Record<string, string>;   // option key -> "from the file's gzip signature"
  };
};
```

`kind` is the only new required field, and it is load-bearing: §3.3 buckets on it
directly rather than re-inspecting `accepts` patterns.

Classification of the existing 29:

- **generate** — `qr-generate`, alone.
- **utility** — `zip-create`, `tar-create`, `gzip`, `file-split`, `file-join`,
  `hash`, `base64`. Exactly the seven tools that will declare `accepts: ['*']`
  once `qr-generate` stops doing so.
- **transform** — the remaining 21, including `zip-extract` and `tar-extract`:
  they understand a specific container and are not generic.

### 3.2 The metadata-only rule

`preset` lives in the registry modules and may read a file's **name, size and
sniffed type — never its contents**.

This keeps them pure, synchronous, allocation-free and unit-testable under plain
Node, and it preserves the property that the registry costs nothing to evaluate
on every keystroke. It is also a real constraint: it rules out presets that would
need to decode a file, such as preselecting an image's own dimensions in Resize.
Every preset this spec calls for is satisfiable from metadata.

The header comment in `registry.*.ts` changes from *"METADATA ONLY - no logic"*
to state this rule, since pure predicates over file metadata are now permitted
where arbitrary logic still is not.

### 3.3 Applicability buckets

`core/format.ts` stops answering with a flat list:

```ts
export type Applicability = {
  primary: ToolDef[];                             // prominent cards
  blocked: { tool: ToolDef; reason: string }[];    // dimmed card + reason
  utility: ToolDef[];                             // quiet pill row
};
```

Buckets are decided by `kind` plus the two existing checks — *types match*
(every file's mime matches one of `tool.accepts`) and *count in range*
(`minInputs`/`maxInputs`):

| Bucket | Rule |
|---|---|
| **primary** | `transform`, types match, count in range |
| **blocked** | `transform`, types match, count **out of** range |
| **utility** | `utility`, count in range (types always match: `['*']`) |
| *absent* | types don't match · a `utility` tool out of count range · every `generate` tool |

A `blocked` entry's reason is generated from the count constraint it failed —
*"needs exactly one PDF — you have two"*, *"needs at least 2 PDFs — you have
one"*. No per-tool predicate is required to produce it.

`blocked` is deliberately restricted to `transform` tools, so a utility that
merely has too few files stays absent rather than nagging on every unrelated
file set. Two PDFs therefore show *Organize pages* dimmed and labelled, while
*Join file parts* is simply one of the quiet utility pills.

Generators never appear in a file-driven grid under any condition. That is
structural, not a filter.

### 3.4 The tool changes

Every one is registry-level. **No `*.op.ts` file changes** — nothing about what
a tool computes is touched.

| Tool | Change |
|---|---|
| `qr-generate` | `kind: 'generate'`, `accepts: []`, `minInputs: 0`. Structurally incapable of appearing in a file grid. |
| `file-join` | `kind: 'utility'` only. It drops out of the prominent grid into the quiet row, which is the whole fix — see below. |
| `gzip` | `preset`: type `application/gzip` → direction `decode`, because *"from the file's gzip signature"*. |
| `base64` | `preset`: extension `.b64`/`.base64` → direction `decode`. Otherwise `encode`, unstated. |
| `csv-json` | `preset`: `text/csv` → `csv-to-json`; `application/json` → `json-to-csv`. On `text/plain`, sets nothing and states *"couldn't tell from the file — pick a direction."* |
| `zip-create`, `tar-create` | `preset`: archive name from the first file's basename, replacing the hardcoded `archive`. |

Three notes on what is deliberately *not* changed:

- **`file-join` gets no new validation.** Its op already refuses a broken part
  sequence with a typed error and a precise message, and it deliberately joins
  arbitrary files in tray order when the names make no claim to be parts — its
  header calls that out as intentional. Adding a name-shape precondition would
  remove a real capability to fix a problem that is purely one of prominence.
  Demoting it to `utility` fixes the prominence and nothing else.
- **`pdf-merge` gets no `preset`.** It has no options at all today; adding an
  output-name option to have something to preset would be scope creep.
- **`csv-json` and `json-format` keep `text/plain` in `accepts`.** Removing it
  would be tidier but would drop a real capability (a `.txt` holding CSV).
  Admitting the tool cannot tell is more honest than guessing or refusing.

## 4. The shell

### 4.1 Why it is split first

`ui/shell.ts` is 647 lines and owns theme, intake, tool grid, run panel, results
wiring, palette wiring and global keyboard handling. None of its logic is
unit-testable — it is end-to-end coverage or nothing. Adding a catalogue, three
zones and a router to it would push it past 800 lines and make the new logic
equally untestable.

```
ui/state.ts             the machine: files, selection, derived buckets, running.
                        DOM-free -> unit tested under Node
ui/router.ts            hash <-> tool id
ui/theme.ts             lifted out of shell unchanged
ui/zones/files.ts       zone 1 — wraps the existing filetray + addbar
ui/zones/catalogue.ts   zone 2 — the tool grid AND the landing catalogue
ui/zones/work.ts        zone 3 — options + Run + progress + results
ui/shell.ts             composition root: builds zones, wires modules
```

`catalogue.ts` is **one component, not two**. Cold, it renders all 29 tools
grouped by family. With files, the same component renders the
primary/blocked/utility buckets. That identity is what makes two entry doors a
cheap change rather than a fork — there is no second landing page to keep in
sync with the first.

The existing `dropzone.ts`, `filetray.ts`, `optionspanel.ts`, `results.ts`,
`palette.ts`, `progress.ts` and `motion.ts` are reused as-is; the zones wrap
them.

### 4.2 The state machine

```
        +------------+  zone2 = all 29 tools · zone3 = empty
        |  BROWSING  |
        +-+--------+-+
     drop |        | pick tool
          v        v
  +------------+  +--------------+  zone3 = the tool, asking for
  |  FILTERED  |  | TOOL PICKED  |  what it needs. Run disabled,
  +--------+---+  +---+------+---+  with the reason.
  pick tool|          |drop  |
           +----+-----+      | kind === 'generate'
                v            |
          +------------+     |
          |   READY    |<----+
          +-----+------+
                v run
       RUNNING ---> RESULTS   (both in zone 3)
```

The edge `TOOL PICKED → READY` for `kind === 'generate'` is the entire QR fix,
expressed as one transition rather than a special case distributed through the
UI.

Selecting a tool that needs files it does not have is a legal, non-error state:
zone 3 shows the tool with its requirement (*"needs at least 2 PDFs"*), Run is
disabled with that reason as its label, and zone 1 becomes the live drop target.

### 4.3 Layout

Three zones — **files · tools · work** — with the work zone fixed so that
options, Run, progress and results never scroll out from under the user.

| Width | Layout |
|---|---|
| ≥ 1200px | three columns |
| 768–1200px | two columns: files + catalogue share the left, work pinned right |
| < 768px | one column, one step open at a time: picking a tool folds the catalogue into a chip and expands the work zone in place |

The narrow layout is a rendering of the same machine, not a second
implementation.

### 4.4 Routing

`#/` is the catalogue; `#/<tool-id>` selects that tool. Back and forward move
between catalogue and tool instead of leaving the app; reload preserves the
selection.

- **Files are never in the URL.** They stay in memory. A shared link opens the
  tool empty — it can never carry anyone's data.
- An unknown tool id falls back to `#/` rather than rendering a blank screen.
- No service-worker change is required: a hash fragment never reaches the
  network, so `#/merge-pdfs` is the same document request as `/`.

### 4.5 Palette

`unavailableReason` currently returns *"Drop files first"* for every tool when no
files are loaded. It becomes bucket-aware: a generator is always runnable, a
`blocked` tool reports its actual reason, and a tool needing files that are not
loaded reports what it needs rather than refusing.

## 5. Testing

New coverage, where none was possible before:

- **`ui/state.ts`** — every transition in §4.2, under Node.
- **`ui/router.ts`** — parse, serialise, unknown-id fallback.
- **`preset`** — one test per predicate, per §3.4, asserting both the value and
  the stated reason, including `csv-json`'s "couldn't tell" case on `text/plain`.
- **`core/format.ts` bucketing** — each of the four buckets in §3.3, including
  that generators never appear and that `utility` tools never enter `blocked`.

Reworked, not merely re-run:

- **`tests/e2e/a11y.spec.ts`** — three zones mean new landmarks and a new focus
  order. The README's claim of full keyboard operability must remain true and
  test-backed.
- **Every e2e golden flow** currently begins with a drop. Each gains a
  tool-first counterpart, plus new specs for: QR generated without any file ever
  being dropped, the blocked-with-reason card, and browser back/forward.

`npm run size` is checked at every stage. The catalogue renders registry metadata
already present in the entry chunk, so the budget is expected to hold, but it is
CI-enforced and will be verified rather than assumed.

## 6. Documentation

The README and the original spec state *"drop first, choose second"* and *"There
is NO NAVIGATION (§7.2)"* as product identity. Both are rewritten in this work,
in stage 4 — the product genuinely changed, and leaving the documentation
describing the old model would be worse than the old model.

## 7. Staging

Four commits, each independently reviewable and each green on the full CI gate.

1. **Tool model** — `types.ts`, `kind` on all 29 registry entries, `format.ts`
   bucketing, the four `preset` predicates, unit tests. The grid gains two
   tiers; no layout change.
2. **Extract** — state machine, theme and zones out of `shell.ts`. Pure
   refactor, zero behaviour change, proven by the existing suite.
3. **Two doors, three zones** — the catalogue, the layout, responsive
   behaviour, a11y rework.
4. **Router** — hash routes, back/forward, palette bucket-awareness, README and
   spec rewrite.

## 8. Out of scope

- Any change to `tools/**` — no op is modified.
- New tools, and any change to what an existing tool computes.
- The known limitations listed in the README (AVIF encoding, Shrink PDF's
  scope, lossless JPEG rotation, the partial-batch re-run cost). They are
  unaffected by this work and remain accurate.
- Presets that require reading file contents (§3.2).
