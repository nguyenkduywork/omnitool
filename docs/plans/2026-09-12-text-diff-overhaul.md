# Text Diff overhaul — implementation plan

Date: 2026-09-12

Status: Execution in progress on `codex/text-diff-overhaul`.

Mode: **BALANCED**, with senior review of shell integration, worker cancellation, and export correctness. The work is reversible, but stale results, lost drafts, and incorrect patches are material correctness risks.

Execution base: `838cbb5856e2e9856a508d1ed4fefa6e6d5db7b9` (`origin/main` inspected during planning). The user's local `main` is `3bb9405` and predates Text Diff. `git fetch origin main --no-tags` updated the remote tracking ref without changing working files.

## 1. Objective and approved direction

Turn Compare text into a focused, responsive workspace where users can supply any combination of two files, pasted texts, or explicitly empty texts; inspect precise changes; navigate an entire supported comparison; and export trustworthy results without losing their work or blocking the page.

The user approved the brainstorm's dedicated workspace, separate input/review modes, adaptive split/unified layouts, independent source controls, retained drafts, word/character detail, visible whitespace, search, wrapping, change navigation, explicit exports, and cancellable background computation. Retain omnitool's system fonts, themes, keyboard support, lazy loading, and offline processing.

The conversation's interactive concept is a layout reference, not production code or an algorithm specification:
`C:/Users/kimdu/.codex/visualizations/2026/09/12/01a09670-5fa3-7732-bcaa-e50288e979cc/text-diff-direction.html`.
All decisions needed for implementation are recorded below; execution does not require that preview file.

### Non-goals

- Merge editing, conflict resolution, three-way diff, folder diff, or selecting arbitrary pairs from a large file tray.
- Rich-document/PDF comparison, semantic JSON comparison, syntax highlighting, or installing a full code editor.
- Cloud uploads, accounts, shared links containing source text, persistent comparison history, or saving drafts in browser storage.
- Reworking other tools' editors, the general catalogue design, or the default cancellation policy for other operations.
- Unlimited input sizes or a promise of instant completion on every device. Supported limits and any reduction in comparison detail must be explicit.
- Deployment or merging as part of this plan.

## 2. Current evidence

Paths in this section refer to the inspected upstream commit, not the older working tree. Read them with `git show 838cbb5:<path>` until the execution branch is created.

| Surface | Verified behavior and implication |
| --- | --- |
| `src/tools/data/text-diff.editor.ts` | `ToolEditor` holds pasted text, view preferences, expanded gaps, and navigation in its closure. `recompute()` runs `diffLines` on the main thread after a 150 ms typing pause; `LIVE_LIMIT` is 3,000,000 combined characters. `render()` materializes rows and stops at `MAX_ROWS = 4000`; navigation uses rendered DOM anchors. |
| `src/tools/data/text-diff.editor.css` and `src/styles/app.css` | The comparison inherits a 20rem/22rem work column and a nested comparison scroller. Word wrapping prevents page overflow but cannot make two narrow columns comfortably readable. |
| `src/tools/data/diff.ts` | Patience anchors plus bounded Myers; line/word comparisons, line metadata, counts, row folding, unified serialization. `splitLines` strips BOM/terminators for display. `diffWords` has a 2,000-character line guard. Keep the established line alignment unless executable evidence requires a fix. |
| `src/tools/data/text-diff.op.ts` | Supports HTML and unified exports, positional files plus `leftText`/`rightText`, and swap. UTF-8 decoding preserves BOM with `ignoreBOM: true`. Unified export currently consumes the normalized display result, so ignored differences and terminator-only changes are not necessarily reproduced by a patch. |
| `src/types.ts`, `src/ui/optionspanel.ts`, `src/ui/shell.ts` | `ToolEditor(mount, File[], onChange)` returns teardown. `syncEditor()` remounts on tray signature changes, losing pasted state. `start()` reads current tray files/options, which cannot represent independently assigned sources reliably. `select`, `clearSelection`, `runFromPalette`, and async mounting all participate in lifecycle. |
| `src/core/format.ts`, `src/ui/state.ts` | `accepts`, `applicabilityFor`, `runBlockedReason`, `typeMismatch`, and `pruneSelection` tie availability to tray contents. Workspace-owned input must be an explicit exception throughout these paths. |
| `src/core/pipeline.ts`, `src/core/workers/pool.ts` | Cancellation posts a message, then discards the worker after a 2-second grace. A synchronous diff cannot service the cancel message; a `done` during grace can still succeed. `pool.discard()` already provides immediate termination/replacement. |
| `tests/unit/diff.test.ts`, `tests/unit/text-diff.browser.test.ts`, `tests/e2e/text-diff.spec.ts` | Existing engine/editor/export coverage. Tests intentionally expect ignored-whitespace patches to contain no hunks and a third tray file to block the tool; both expectations must change under this plan. |
| `CONTRIBUTING.md`, `eslint.config.js`, `vite.config.ts`, `src/sw.ts` | Tool code cannot import `core/` or `ui/`; operations are DOM-free. Workers and editors are lazy. Initial budgets are 40 KB JS, 12 KB CSS, 60 KB total, gzip. Service worker runtime-caches same-origin build assets. |

No production tests were run during planning: the checked-out product predates the implementation under review. Browser observations and the concept checks from brainstorming are design evidence, not validation of the future feature.

## 3. Acceptance criteria

| ID | Observable pass condition |
| --- | --- |
| AC1 — Focused workspace | Opening `#/text-diff` from catalogue, palette, or URL mounts one full-width workspace. Its main controls and comparison do not remain inside the narrow work card. Back to tools restores the existing tray and catalogue. |
| AC2 — Independent inputs | Either side accepts a file, pasted text, or intentional empty text. File/text mixtures work in both directions. Swap swaps the entire source state. Replace/clear has one-step undo. Untouched and explicitly empty are distinct; two explicit empty sources correctly report identical. |
| AC3 — Retained state | Source text, filenames, source assignments, preferences, current change, and review position survive resizing, layout changes, and navigation away/back within the same tab. Tray changes never overwrite an initialized workspace. Same-name/same-size file replacement is read as a new source. Reload/close clears in-memory drafts by design. |
| AC4 — Responsive and accessible | At viewport widths 320, 375, 390, 768, 1024, 1440, and 2560 px there is no document horizontal overflow, clipped action, or overlapping text. At 200% zoom and a 320-CSS-pixel reflow equivalent, all actions remain reachable. Mobile inputs use at least 16px type and coarse-pointer targets are at least 44px. Keyboard, focus return, screen-reader labels, themes, and reduced motion work. |
| AC5 — Accurate review | Word detail remains the default; line and grapheme-safe character detail are available. Old/new line numbers, additions/removals/modifications, and change-group totals agree with the model. Whitespace/case ignore rules are off initially and visibly disclosed when active. Identical bytes, identical under rules, and line-ending/BOM-only differences have distinct messages. |
| AC6 — Complete navigation | Every supported change and line remains reachable beyond the old 4,000-row boundary. Previous/next change, literal search, context expansion, and whole-file review use model positions, not currently mounted DOM rows. Wrapping, paging, search, and layout changes do not silently restart comparison. |
| AC7 — Responsive computation | Decode, line/token comparison, search scans, and export serialization run in workers. New input invalidates old work immediately; stale replies never become current. Cancel stops CPU work through termination when necessary. Busy, cancelled, failed, limited-detail, and too-large states are truthful and recoverable. |
| AC8 — Trustworthy outputs | HTML report and Copy changes use the displayed snapshot and review rules. Patch export uses strict raw content and applies to produce exactly the revised UTF-8 bytes, including supported BOM/terminator cases, regardless of ignore rules. Export cannot race newer input, silently truncate, execute source markup, or claim unrelated tray files were processed. |
| AC9 — Integration and budgets | Existing tools retain their behavior and tests. Text Diff's new workspace/worker code remains lazy and within existing initial-load budgets. After warming Text Diff and its export paths online, reload and use work offline with no source data in storage or network requests. |

## 4. Product behavior to implement

### Inputs and retained session

Use labels **Original** and **Revised**. An empty workspace starts in Inputs mode with both sources unprovided. At desktop/tablet widths show both editors when readable; on narrow screens use accessible Original/Revised tabs with source status and a Review changes action. Background comparison must not switch modes, steal the caret, or scroll while the user types.

Each side has paste/edit text, Open file, a side-specific drop target, Use empty text, clear, and replace. Clear returns that side to unprovided and offers Undo; Use empty text creates a provided empty source. Keep one undo snapshot per side, replaced by the next source replacement/clear; ordinary text editing retains native undo while that textarea remains mounted. A cancelled picker has no effect. Invalid file reading leaves the prior good source recoverable and names the failing side/file.

On the workspace's first activation only, seed from the tray when it contains exactly one or two compatible text candidates: one seeds Original, two follow tray order. If there are more than two entries or incompatible candidates, start unprovided and offer the workspace's own pickers. Do not guess a pair from many. Subsequent activations retain the session. Side pickers/drops never add, remove, or reorder tray files. Keep global paste/drop behavior intact outside the workspace; inside side controls, stop duplicate global file ingestion. A drop on the workspace background asks for a side without replacing either automatically.

Retain one session in memory for the lifetime of `mountShell`. Leaving the tool terminates live work and detaches/hides its DOM, retaining drafts and logical review position. Returning recomputes as necessary and restores the view. Explicit Start over clears both sources and undo references. Shell teardown releases the entire session, workers, listeners, timers, and object URLs. No persistence or URL serialization of text. Update the inaccurate `src/sw.ts` comment claiming the app has no drafts; do not introduce automatic page reload on service-worker updates.

### Review and responsive layout

Replace the tool catalogue and tray region with the full-width workspace while selected; keep the app header, Back to tools, and tool-search access. The DOM order must match visual/focus order. Mount the workspace beside the old workbench, rather than stretching an inner editor through its parent's grid.

Review starts with compact source identities, counts, Edit inputs, and a toolbar. Keep the common controls visible: layout, wrap, previous/next change, current position, Find, and Export. Put detail, context, whitespace visibility, and ignore rules in a labeled Options disclosure; show a compact active-rules indicator outside it. Replace similarity percentage with concrete line counts and change groups. A modified line counts once, with additions/removals representing unpaired lines.

- Auto layout uses side by side at a workspace content width of at least 52rem and unified below it. Use a container query/ResizeObserver, not device detection.
- Remember `Auto | Side by side | Unified` as the preference. An explicit split choice below 40rem becomes stacked Original/Revised pairs within each change group; restore split when enough width returns. Never present two unreadable phone columns.
- Split rows share one grid/vertical flow and aligned heights. Unified rows retain both source line-number meanings. Gutters grow for six-digit numbers without pushing content off the page.
- Wrap is on initially. When off, horizontal scrolling is contained and labeled inside the comparison; the document never scrolls sideways. Keep one document vertical scroll flow. Avoid textarea/viewer/page scroll traps and fixed viewport-height cards.
- On phones, Review is its own mode so the input editors do not push the comparison below the fold. Use a compact sticky review toolbar with safe-area spacing; it must not cover focused controls or content when the software keyboard opens. Do not use a permanent bottom Run bar.
- Preserve the active hunk and logical row anchor across layout/width changes. Preserve the exact scroll offset where possible; use the anchor when reflow changes row height.

Use line/word/character detail with grapheme-safe segmentation. Keep the current word token behavior for code identifiers while extending tokenization safely for Unicode. If native grapheme segmentation is unavailable, disable character detail with a visible reason; do not split surrogate pairs or combining sequences. Long/tangled lines can fall back to line detail, with an explicit notice. Whitespace glyphs are presentation only and cannot alter the original strings, search contents, or copied source text.

Identity messages use three separate checks: raw string equality after valid UTF-8 decoding; exact display-line equality before ignore rules; and equality under the selected rules. A byte/terminator-only label requires raw inequality plus exact display-line equality, not merely equality under ignore rules. Preserve per-line terminator information or derive it from raw sources so two mixed-ending files with different terminator positions are detected even if both summaries say Mixed. Metadata changes and ignored text differences may coexist and must both be disclosed.

Find is literal text across both sources, case-sensitive by default, with a match-case toggle. It searches the whole supported source, including folded/unmounted text. It reveals and pages to the next/previous matching range and distinguishes search matches from changed spans. Every returned offset/range addresses the original source: case folding can change UTF-16 length, so never use an index in a lowercased copy as a source index. Use an escaped literal matcher that preserves original indices, or an explicit folding-to-source offset map. No user-supplied regular-expression search in this release. Provide keyboard shortcuts scoped to the workspace: F7/Shift+F7 for next/previous change outside editable controls; a visible Find action and Escape to close its disclosure. Do not hijack the browser's global Find or omit keyboard equivalents for touch actions.

### Bounded rendering and performance policy

Keep compact diff blocks and prefix offsets in the worker. Add indexed row-range primitives; do not build a full `toRows()` array just to display or find a small region. Use explicit bounded pages/windows first, rather than a new virtual-editor dependency:

- At most 200 alignment rows and 100,000 displayed source characters per window. A window response reports actual start/end and a continuation cursor `{ row, aOffset, bOffset }`; consumers advance from that cursor, never from the requested count. Per-side offsets permit continuing inside a long paired row without repeating or skipping text. End-of-comparison is explicit.
- Context defaults to 3 lines; offer 0, 3, 10, and Whole file. Fold gaps have logical ranges; expansion reveals up to 50 lines at a time and offers the rest through paging. Whole file makes all rows reachable through pages, not all resident in the DOM.
- A line longer than the display-character budget is shown in expandable slices targeting 4,000 characters with explicit continuation and complete-source copy. Search navigates to its matching slice. End slices at grapheme boundaries and keep offsets in the original string; never split surrogate pairs, combining sequences, or ZWJ emoji. A single grapheme may exceed the slice target up to the window's total character budget. If it exceeds that hard budget, show an explicit oversized-character placeholder with exact copy, rather than rendering a broken prefix or silently dropping it. If grapheme segmentation is unavailable, disclose code-point-safe line-preview fallback and disable character detail. Never label a clipped line complete.
- Navigation loads the window containing the target hunk/match before focusing/scrolling to it. Maintain hunk identifiers and source line indices separately from page indices. Use a small window/detail cache bounded to three pages, reset on comparison revision.

Initial execution limits, to be tested rather than advertised as measured capability: 10 MiB combined UTF-8 source bytes and 200,000 combined display lines; retain the existing bounded Myers behavior and 2,000-character per-line detail guard initially. Check File sizes before reads and enforce the decoded limits too. Large pasted strings are checked off the main thread; reject invalid UTF-16 surrogate sequences with a clear invalid-text message before claiming UTF-8 fidelity.

Auto compare after the existing 150ms pause for text up to 250,000 combined UTF-16 code units or files up to 1 MiB combined. Above those thresholds, show an explicit Compare action and keep the last result visibly out of date; do not relaunch expensive work for every edit. Changing a source invalidates export immediately, before the debounce or file read. Suppress compares during IME composition until composition ends.

Performance gate on a recorded reference machine: for supported fixtures, typing/navigation/cancel should visibly respond within 100ms in normal runs; inspect p95 over repeated runs and main-thread tasks, with no diff/decode/search loop on the main thread. A 1 MiB typical comparison should show its first review window within 1 second after dispatch; a 10 MiB typical comparison within 5 seconds. These are acceptance targets, not existing measurements; CI correctness gates must not use tight wall-clock assertions. On 4x CPU-throttled Chromium, controls must remain responsive throughout even if completion is slower. Record physical mobile keyboard/touch checks when a device is available; emulation is not a substitute for claiming physical-device coverage.

If these limits/targets fail, profile the failing stage and fix it within scope. Do not silently raise memory limits or shrink supported functionality. Escalate the bounded bottleneck to Sol/root with measurements and a proposed revised limit; record any root-approved adjustment and visible UI notice in this plan's execution ledger.

### Output semantics

Use explicit **Download report**, **Download patch**, **Copy changes**, and per-source Copy actions. Output downloads continue through the existing results/download machinery; use a text-diff-specific ready/cancel status in the workspace. If browser policy requires a second download click, label the ready download clearly. Avoid automatically scrolling the review to raw HTML output; direct users to the ready artifact through a nearby status/link.

HTML is self-contained, script-free, and responsive: paired rows stack on narrow screens, text is escaped, full content is included for the chosen scope, and print styles remain readable. Include source names, direction, line counts, context/detail choices, active ignore rules, and notices about coarse alignment. It follows the displayed comparison settings and may fold unchanged context; it never clips later changes due to a UI window limit.

Copy changes copies all change groups under the current rules with the chosen context, source labels, and an active-rules preamble. It is a readable review summary, not a machine patch. If there are no changes under the rules, copy that explicit summary. Native source-copy actions copy the exact retained source string, without line numbers, signs, highlights, or whitespace glyphs. Clipboard rejection exposes selectable text and an explanatory status instead of pretending success.

Patch generation is independent of normalized display comparison. Tokenize raw text into LF-delimited records while retaining CR and BOM in payload and preserving final-LF presence; do not reuse display `splitLines` for the patch path. Feed those exact records through the shared alignment core and emit valid unified hunks. This handles CRLF/mixed/lone-CR content as raw records even where display line segmentation differs. A change solely in final newline or BOM must create a real hunk. Keep bounded coarse replacement as a valid fallback if precise alignment exceeds the algorithm budget.

Use one safe target basename on both headers (`a/<target>` and `b/<target>`). Preserve the Original filename only if it is a portable safe basename; otherwise use `comparison.txt`. Define safe as ASCII letters/digits/dot/underscore/hyphen, excluding empty, `.`/`..`, trailing dot, Windows device names, controls, and path separators. Show the target basename beside Download patch. Original/Revised display names remain unchanged in the UI/report. Do not inject source names into raw patch headers or invent directory paths.

When ignore rules are active, label the patch action **Exact patch · includes ignored differences**. If the raw sources are identical, show No patch needed and do not emit a headers-only file described as an applicable patch. Never turn a failed exact serialization into a normalized patch. All changed raw pairs within supported limits must pass the actual `git apply` oracle before shipping.

## 5. Architecture and contracts

### A. Small optional workspace lifecycle

Add these dependency-free types to `src/types.ts` (names are prescribed; implementations may refine readonly annotations without changing semantics):

```ts
type WorkspaceExportFormat = 'html' | 'unified';
type PreparedToolRun = {
  revision: number;
  files: File[];
  options: Record<string, unknown>;
  inputs: SniffedFile[]; // metadata for only the two actual sources
};
type WorkspaceJobState =
  | { phase: 'idle' }
  | { phase: 'preparing' | 'running'; progress: number; cancel: () => void }
  | { phase: 'ready'; revision: number; format: WorkspaceExportFormat;
      outputName: string; revealOutput: () => void }
  | { phase: 'cancelled' }
  | { phase: 'failed'; message: string };
type ToolWorkspace = (mount: HTMLElement, host: {
  announce(message: string): void;
  onRun(format: WorkspaceExportFormat): void;
}) => ToolWorkspaceHandle;
type ToolWorkspaceHandle = {
  activate(trayFiles: readonly File[]): void;
  deactivate(): void;
  destroy(): void;
  focusPrimary(): void;
  prepareRun(format: WorkspaceExportFormat): PreparedToolRun;
  setJobState(state: WorkspaceJobState): void;
};
// Add to ToolDef:
// workspace?: () => Promise<{ default: ToolWorkspace }>;
```

`prepareRun` throws a typed `InvalidOptions` when no current ready/displayed snapshot exists. It is synchronous and copies immutable snapshot/settings values before the first shell await. Text Diff returns `files: []`; raw source text travels in a validated tool-specific snapshot in options. `inputs` contains source metadata solely for output provenance, never tray receipts or reduction percentages. The shell's announcements say comparison/report, rather than incorrectly saying the job read zero source files. On completion, `ready.revealOutput` focuses/reveals the existing results download without exposing or duplicating its object-URL ownership. A ready artifact is tagged with its comparison revision; new input marks it as belonging to an earlier comparison instead of presenting it as a new result.

Keep `ToolEditor` and options-panel APIs unchanged. Define `workspace` as the explicit indication that the tool owns source collection; selection/applicability code must bypass tray restrictions for such tools. Metadata still has the old 0..2 file limits for legacy/direct operation entry, but they do not restrict workspace selection. Palette selection opens a workspace and stops; it must never run it blindly. A failed lazy workspace load offers Retry and Back to tools, preserving the tray.

`shell.ts` owns one cached workspace instance, lazy-mount generation guards, route activation/deactivation, the existing results host, and export lifecycle. Hide the old workbench with an actual hidden state while workspace mode is active, preserving its underlying state and DOM. A late import after navigation must not attach a stale workspace, focus it, or retain an unowned worker. Existing `clearSelection`, `destroy`, readiness/focus tests, and running-route behavior must cover the new path.

### B. Tool-specific immutable snapshot

Add `src/tools/data/text-diff.model.ts` for source/session types and pure snapshot validation. Use:

```ts
type ComparisonRules = { ignoreWhitespace: boolean; ignoreCase: boolean };
type ReadySource = {
  provided: true;
  text: string;
  name: string;
  origin: 'file' | 'text' | 'empty';
  byteLength: number;
};
type ComparisonSnapshot = {
  schemaVersion: 1;
  revision: number;
  sources: readonly [ReadySource, ReadySource];
  rules: ComparisonRules;
};
```

Unprovided/reading/error states exist in the live session and cannot form a ready snapshot. Serialize as `options.comparisonSnapshot`, with `format`, `scope`, `context`, and `detail` as separate validated export options. The op rejects ambiguous use of a snapshot together with positional input files or legacy source/rule overrides. Without a snapshot, keep existing positional-file and pasted-option entry points working, with corrected exact patch semantics.

The snapshot is a runtime execution payload, not a declarative form field. Update the registry-contract tests to distinguish documented public options from the explicitly validated snapshot protocol. Do not add File objects, opaque sessions, or revision fields to `OptionSchema`.

File decode runs in the preview worker using fatal UTF-8 and `ignoreBOM: true`. Return raw decoded text once per accepted source revision; main retains it for source copy and export. Window responses never repeat entire source text. Track source identity with a monotonically increasing source revision, not name/size/lastModified alone. The same frozen raw strings, names, direction, and rules drive the displayed revision and `prepareRun`.

### C. Live worker and indexed presentation

New files: `text-diff.live.worker.ts`, `text-diff.live.ts`, `text-diff.protocol.ts`, and `diff-view.ts`, all under `src/tools/data/`. The first is the real lazy worker entry, the second owns worker lifecycle/request routing, the third has cloneable discriminated message types, and the last contains pure hunk/range/folding/search helpers. Tool modules import only siblings, `src/types.ts`, and permitted dependencies.

Protocol request kinds: `compare`, `window`, `find`, `copy`. All carry a comparison revision; non-compare requests also carry a monotonically increasing request ID. Responses are `ready`, `window`, `find`, `copy`, `progress`, or typed `error`, echoing revision/request IDs where applicable. `ready` contains a compact summary, notices, line/byte metadata, hunk index, logical row count, and newly decoded file sources once. `window` contains bounded raw row/segment data plus actual continuation cursors. `find` yields a match count, current ordinal, and one source range; it must not retain/clone every match when a short query matches millions of positions. Search ranges use original-string offsets, including when Match case is off. `copy` yields the complete bounded output text or a typed size error.

The worker retains the full compact comparison model. `diff-view.ts` indexes blocks by cumulative alignment-row count and provides `buildViewIndex`, `readRowWindow`, `findText`, and `formatChanges`. Hunk IDs are stable within one comparison revision. Line-ending/BOM differences are structured metadata changes: they remain navigable even if no display-text row changed. Keep line-change counts distinct from metadata changes. On edits/rule changes, increment revision and invalidate all old requests. Resize/wrap/detail/context/search only change view request IDs and never change source revision.

Cancel/new-source/deactivate/destroy must terminate an occupied preview worker immediately and ignore all late messages, reads, and promises. Retain the accepted input snapshot for retry. An idle worker may be reused; a terminated one is recreated lazily. A worker crash produces a recoverable state and Retry; never fall back to an expensive synchronous main-thread compare. Request queueing coalesces superseded window/search requests. If a view task must be terminated, rebuild from the retained snapshot before serving the new request.

### D. Export adapter and immediate cancellation

Keep the existing `pipeline.run` and results/download path. Extend `RunDeps` with `cancelImmediately?: boolean`, default false. Text Diff workspace export calls `run('text-diff', [], prepared.options, { cancelImmediately: true })`. When cancelled with a held worker, reject `Cancelled` and use the existing discard/terminate path synchronously; never accept a late `done`. Preserve existing other-tool cancellation behavior.

The shell captures `prepareRun` before importing the pipeline. It enters `preparing` synchronously and records cancellation during that import; a pre-job cancel must prevent dispatch. During export freeze source mutations and comparison-rule changes, while allowing layout/wrap/context/navigation/search. The prepared report settings remain the click-time settings even if presentation later changes. On completion/cancel/error restore controls and sensible focus, release references, and avoid publishing results after shell destruction or a superseded run.

## 6. Assumptions and uncertainties

| Tag | Item | Resolution |
| --- | --- | --- |
| verified | Upstream `838cbb5` contains the reviewed Text Diff; local `3bb9405` does not. | Execute from the pinned upstream base, preserving the user's local main branch. |
| verified | Current main-thread compare, closure drafts, normalized patch path, and grace-period cancellation require more than CSS changes. | Address through the bounded contracts above. |
| verified | Vite worker bundling, lazy imports, a reusable pool discard path, and existing browser/unit test infrastructure are available. | Reuse them; no dependency installation is planned beyond `npm ci` when needed. |
| verify-during-execution | The proposed 10 MiB/200k-line limits and timing targets fit memory/performance on the reference machine. | Profile real worker plus UI fixtures; lower-level guards and honest errors remain mandatory. Escalate measured failures before changing limits. |
| verify-during-execution | All supported raw terminator/BOM vectors apply exactly through platform Git. | Real `git apply` plus byte equality is the authority, before UI export completion. |
| verify-during-execution | Physical Safari/mobile keyboard behavior. | Exercise available WebKit/emulation and a physical device when available; explicitly record unavailable coverage. |
| blocking | None for starting implementation. | New conflicts with upstream or unrelated working changes are handled by the preparation gate, without overwriting user work. |

## 7. Execution chunks and routing

All children are leaves. Use fresh context and named roles. Root Astra Medium owns sequencing, scope decisions, evidence ledger, and final acceptance. Serialize all product writers; each chunk is one coherent deliverable with a useful validation gate. Do not create one agent per file.

### Step 0 — Establish the execution base and baseline

**Owner:** root Astra Medium; batch any delegated inventory into one `terra_scout` at Terra Medium.

**Dependencies:** none.

**Scope:** repository/branch state, dependencies, baseline evidence only.

1. Inspect `git status`, local/remote tips, project instructions, and this plan. Preserve this plan file and all unrelated work. Do not reset or fast-forward the user's local main as a shortcut.
2. Create `codex/text-diff-overhaul` from the pinned commit. If a newer upstream exists, inspect the delta on affected surfaces and reconcile the plan before writing, rather than silently mixing bases.
3. Prefer the current workspace for one serialized writer when clean except this plan. If unrelated dirty work prevents that, create an isolated worktree under `C:/Users/kimdu/Dev/omnitool/.worktrees/text-diff-overhaul`, record its absolute path, and locally exclude `.worktrees/` through Git metadata; do not stash user work automatically. Copy this plan into that worktree as the planning artifact.
4. Use `npm ci` if dependencies are missing or lockfile/runtime differs. Capture baseline focused diff/browser tests, typecheck, production build, size, and existing Text Diff e2e on the current implementation. Record pre-existing failures separately.

**Oracle:** the actual diff files are present on the execution branch, baseline failures are classified, and unrelated user work is intact.

**Escalation:** upstream overlaps or reproducible baseline failures that obscure the new change go to root before broad implementation.

### Step 1 — Establish exact source, diff, and output contracts

**Owner:** `terra_engineer`, Terra High.

**Dependencies:** Step 0.

**Owned files:** `src/tools/data/diff.ts`, new `text-diff.model.ts`, new `text-diff.export.ts`, `text-diff.op.ts`, new `tests/unit/text-diff-model.test.ts`, new `tests/unit/text-diff-patch.test.ts`, relevant cases in `tests/unit/diff.test.ts`.

Implement validated immutable source snapshots; explicit empty versus missing; preserved raw input; exact/normalized identity metadata; safe patch target naming; and strict raw-record unified export. Factor the alignment core enough to accept display lines or raw LF records without duplicating Myers/patience. Preserve existing public engine functions where compatible; introduce `toUnifiedExact(rawA, rawB, options)` for production patch generation. Extract serializers into `text-diff.export.ts` so report/copy and op paths share semantics. Preserve legacy direct op inputs while rejecting ambiguous snapshot combinations.

Upgrade token boundaries for Unicode and add grapheme character detail with bounded fallback. Exact source reassembly must hold for every segment result. Keep all four required op-test categories: success, typed error, cancellation, and progress. Correct tests that encode normalized patches as the desired behavior.

**Oracle:** focused Node tests pass; seeded display/raw replay properties pass; actual `git apply` recreates every revised byte for the matrix in Section 9. Malicious content is escaped; patch target names cannot create paths.

**Escalation:** an unrepresentable valid raw fixture or inconsistent source/normalization model goes to Sol/root with the smallest failing fixture. Do not weaken the byte equality assertion.

### Step 2 — Add the workspace host and safe export lifecycle

**Owner:** `sol_engineer`, Sol High, because selection, asynchronous mounting, cancellation, and result provenance interact.

**Dependencies:** Steps 0–1.

**Owned files:** `src/types.ts`, `src/ui/shell.ts`, `src/ui/state.ts`, `src/core/format.ts`, `src/core/pipeline.ts`, minimal workspace container rules in `src/styles/app.css`, targeted `src/ui/results.ts` changes if needed, `tests/unit/pipeline.test.ts`, shell/router/applicability/worker integration tests.

Implement the optional workspace API and a full-width slot beside `.workbench`, without yet registering the unfinished Text Diff workspace. Cover the API using small test workspaces. Add tray-independent selection/applicability and palette handling; cache/deactivate/destroy lifecycle; guarded lazy loading; focus routing; immutable `PreparedToolRun`; pre-job cancel; opt-in immediate cancellation; and output provenance from prepared sources rather than tray entries. Keep generic editor behavior and other operations unchanged.

**Oracle:** focused shell/router/applicability tests and pipeline cancellation tests pass. A real worker cancelled while computing never publishes a success output. Late workspace imports cannot steal focus or attach after navigation. Other editor/run tests remain green.

**Review checkpoint A:** fresh `sol_reviewer` reviews lifecycle, source provenance, and cancellation before the final UI is wired; root resolves material findings.

**Escalation:** changes spreading into unrelated tool semantics require root scope review; prefer one optional workspace seam over rewriting all editors.

### Step 3 — Build bounded background comparison and navigation

**Owner:** `terra_engineer`, Terra High; escalate proven concurrency/performance blockers to `sol_debugger`, Sol High.

**Dependencies:** Step 1; run after Step 2 under the single-writer rule.

**Owned files:** new `src/tools/data/text-diff.live.worker.ts`, `text-diff.live.ts`, `text-diff.protocol.ts`, `diff-view.ts`; new `tests/unit/diff-view.test.ts`, `tests/unit/text-diff-worker.browser.test.ts`, and `scripts/bench/text-diff.mjs`; bench registration/docs.

Implement source decode, size guards, compact model indexing, bounded windows, metadata-change navigation, whole-source literal search, copy serialization, revision/request guards, worker replacement, typed errors, and cleanup. Add exact string/segment budgets and continuation cursors. Do not leak cloned full sources on every response or allocate full row arrays for a window. Keep caches bounded. Add a real-module benchmark harness using Vite's transform/server mechanism already used by repository benches; no pasted production algorithm.

**Oracle:** Node range tests agree with full small-input reference expansion; navigate directly to a hunk after row 4,000 and to final rows of supported large fixtures. Include case-insensitive Find in `AİB` (the B source offset is 2, not the lowercase-copy offset 3), and emoji/combining/ZWJ sequences crossing the 4,000-character slice target; slicing/reassembly and highlighted ranges must retain original content. Real-worker tests cover rapid same-name file replacement, superseded compare/search/window replies, file-read errors, cancellation, termination, crashes, retry, and teardown. Record computation/transfer timings and memory observations.

**Escalation:** provide trace, failing revision sequence, or memory profile; never retry the same failed hypothesis without new evidence.

### Step 4 — Implement and integrate the responsive workspace

**Owner:** `sol_engineer`, Sol High, for the interacting input/session, accessibility, and responsive review behavior.

**Dependencies:** Steps 1–3 and checkpoint A.

**Owned files:** new `src/tools/data/text-diff.workspace.ts`, `text-diff.workspace.css`, `src/core/registry.data.ts`, narrowly necessary shell/DOM integration, `tests/unit/text-diff.browser.test.ts`, `tests/e2e/text-diff.spec.ts`, new `tests/e2e/text-diff-responsive.spec.ts`.

Implement all input/session behavior, Inputs/Review, compact controls, adaptive layouts, wrap/detail/whitespace/rules, counts, paging, context expansion, Find, keyboard navigation, loading/errors, and progress/cancel. Register the lazy `workspace` for `text-diff` and remove its old `editor` registration. Migrate tests and remove superseded `text-diff.editor.ts`/`.css` only once no references remain. Use existing theme and diff tokens; extend tokens/contrast checks only for actual new state pairings.

Keep source/caret state outside replaceable results DOM; do not rebuild textareas on keystrokes or width changes. Implement first-use tray seeding and route retention exactly as specified. Coalesce view requests and restore logical anchors after reflow. A stale result is labeled and cannot be exported. Expose the workspace readiness signal after it is mounted, rather than waiting for a hidden generic Run button.

**Oracle:** tests exercise actual controls for file/file, file/text both directions, text/text, explicit empty, swap, clear/undo, same-name replacement, IME-safe typing, and navigation away/back. Three-plus/unrelated tray entries do not block or get modified. Responsive/browser checks prove visible primary actions, exact source retention, complete navigation, and no document overflow.

**Escalation:** persistent layout/focus failures go to root with screenshots plus DOM/focus evidence; do not fix them by shrinking essential text or hiding required actions.

### Step 5 — Finish useful exports, offline behavior, and performance verification

**Owner:** `terra_engineer`, Terra High; root handles final visual acceptance.

**Dependencies:** Step 4.

**Owned files:** `text-diff.workspace.ts` export controls, `text-diff.export.ts`, `text-diff.op.ts`, `src/ui/results.ts` only where needed, export/browser/e2e tests, new `tests/e2e/text-diff-offline.spec.ts`, `README.md`, `src/sw.ts` comment, benchmark documentation and `scripts/contrast-check.mjs` if tokens changed.

Connect Download report/patch to frozen snapshots and the host, implement Copy changes/source with truthful failure behavior, and make HTML output responsive/script-free/printable. Ensure scope and rules match the click-time snapshot; patches intentionally include ignored changes. Do not inherit UI window limits in export. Bound generated output to 32 MiB UTF-8 for reports/copy/patch; if exceeded, return a typed TooLarge before retaining a huge serialized string and offer another smaller output where applicable. Plain source inputs still obey their own smaller limits.

Add production-build offline coverage by warming comparison, search/detail, and export worker chunks before disabling network. Assert requests contain no user source and browser storage contains no drafts; compiled-asset caches are allowed. Run the real UI benchmark matrix and record browser, CPU, viewport, source sizes, dispatch/first-window/interaction timings, and any detail fallback. Update user documentation with measured supported behavior and explicit limits.

**Oracle:** actual browser downloads and clipboard payloads match tests; exported HTML can be opened at phone/desktop widths with scripts/network disabled; patch oracle remains green; offline reload works after warm-up; budget/contrast checks pass; performance acceptance is evidenced, not inferred from worker use.

**Escalation:** failing fidelity or output caps are implementation defects to resolve; unsupported environment coverage is recorded accurately, not reported as passing.

### Step 6 — Independent review and final acceptance

**Owner:** root Astra Medium plus a fresh `sol_reviewer`, Sol High, independent of implementers. Use `terra_reviewer`, Terra High, for a distinct bounded UI/test-coverage pass only if useful.

**Dependencies:** Steps 0–5.

**Scope:** final diff, coverage matrix, browser artifacts, worker/profile evidence, and known risks.

Run the final gate once after integration/fixes. Review exact-vs-normalized semantics, source lifetime, async mount/export/cancel races, bounded allocation, incomplete navigation, user-text escaping, keyboard/touch behavior, worker bundling, and compatibility of all other tools. Reviewers return `STATUS`, `RESULT`, `EVIDENCE`, `VALIDATION`, `RISKS`, `NEXT`; no children spawn grandchildren.

Root inspects representative desktop/phone states and exported report, checks every AC against evidence, fixes material findings with a serialized writer, and repeats only affected checks plus any required gate invalidated by those changes. Do not call the work complete with unresolved material defects. Report residual device/performance coverage honestly; do not claim zero bugs.

## 8. Ownership, rollback, and recovery

One implementation writer at a time on `codex/text-diff-overhaul`; read-only reviewers may overlap useful root work. Shared `types.ts`, registry, shell, pipeline, styles/tokens, benchmark registry, and lockfile are always single-writer. No new production dependency is planned. Any necessary dependency change needs evidence about purpose/bundle cost and root reconciliation, not a silent package addition.

Keep coherent checkpoints aligned with Steps 1–5. No data migration occurs because session storage is in memory. To roll back before merge, stop work on the feature branch and leave the original branch and user files intact. For an integrated rollback, revert workspace registration/UI plus the optional host integration in reverse dependency order; preserve independently validated patch-correctness fixes when appropriate. Never remove source files before removing imports or leave a registry entry pointing at a removed worker. Do not use reset/clean on user work.

Cancel/retry is a product recovery path: terminate the worker, clear pending request handlers, keep source/session state, and offer recompute. Clear/destroy releases retained raw/undo snapshots and object URLs. No automatic clipboard access, source storage, or resumption of cancelled exports.

## 9. Coverage matrix and executable oracles

| Acceptance / risky surface | Required evidence |
| --- | --- |
| AC1/AC3/AC9 — shell, routing, tray independence | Shell/router/applicability tests; catalogue/palette/direct URL entry; back/forward; lazy-load failure/retry; late mount/destroy; old-tool regression suites. |
| AC2/AC3 — input lifecycle | Browser journeys for each source combination, two provided empty sources, missing source, replace/cancel picker, swap, clear/undo, invalid UTF-8, same-name/same-size replacement, inactive tool tray changes, IME composition, and no source text in URL/storage. |
| AC4 — responsive/accessibility | Production screenshots and overflow/focus checks at 320/375/390/768/1024/1440/2560; 200% zoom and 320-CSS-pixel reflow; long names/long lines/six-digit gutters; light/dark contrast; keyboard-only, screen-reader smoke, coarse touch, reduced motion; available WebKit/mobile keyboard evidence. |
| AC5 — comparison semantics | Existing patience/Myers replay properties plus Unicode/CJK/emoji/combining/ZWJ vectors; raw and normalized identity; whitespace/case rules; correct line/group/metadata counts; detail fallback notices. |
| AC6 — complete bounded review | Indexed windows compared with full expansion on small seeded fixtures; changes after 4,000 rows; jump to final hunk; all-context paging; expanded gaps spanning pages; search in hidden regions and long-line slices; original offsets after Unicode case folding; grapheme-safe continuation across slice boundaries; explicit oversized-grapheme fallback; stable hunk/selection after reflow; DOM and character budgets. |
| AC7 — async races/cancellation | Real worker tests, not only FakeWorker: replace during file read/compare, stale replies, queued search/window invalidation, cancel CPU-bound computation, retry/crash/destroy, and cancelled pipeline imports. No output after Cancel and no orphan worker. |
| AC8 — exact patch | Node test creates an isolated temporary repository/directory, writes original bytes at the safe target path, runs `git -c core.autocrlf=false apply --whitespace=nowarn <patch>`, and compares the resulting bytes with revised bytes. Use actual process arguments, no shell-built commands. Configure the temporary repo only; do not alter user Git config. |
| AC8 — patch vectors | LF↔CRLF, mixed LF/CRLF, lone CR, BOM add/remove/only, all combinations of final newline, terminator change outside ordinary context, ignored whitespace/case with nonempty exact patch, empty-side insertion/deletion, zero-context hunks, coarse alignment, hostile/control/path names, and unsupported lone surrogates. Identical pairs have no downloadable patch and are tested separately. |
| AC8 — report/copy | Open actual downloaded HTML with network/script execution disabled; inspect mobile/desktop/print; assert escaped hostile text and metadata; all later changes present; copied summary vs current rules; copied raw source exact; clipboard blocked fallback; size-error behavior. |
| AC9 — offline and bundle | Build/size check; actual production worker loading; warm then offline reload/recompare/export; inspect storage and outgoing requests for source-data absence. |
| AC7/AC9 — performance | Real worker+UI harness for small prose, source code, repetitive/unrelated lines, 1 MiB typical, 10 MiB typical, 200k combined lines, and minified/long-line inputs; normal and 4x throttle interaction traces with environment recorded. Hard correctness caps tested in CI; tight timing targets evaluated in recorded local runs. |

All temporary patch-test files must live beneath the test-created resolved temp root. Before recursive cleanup, verify the resolved target remains within that root and use the platform's native filesystem API. Do not execute source text, report scripts, or user filenames as shell code.

### Focused commands during implementation

Use the files present at the corresponding step; do not pass future test paths until created:

```text
npx vitest run --project node tests/unit/diff.test.ts tests/unit/text-diff-model.test.ts tests/unit/text-diff-patch.test.ts tests/unit/diff-view.test.ts tests/unit/pipeline.test.ts
npx vitest run --project browser tests/unit/text-diff.browser.test.ts tests/unit/text-diff-worker.browser.test.ts tests/unit/worker-integration.browser.test.ts
npx playwright test tests/e2e/text-diff.spec.ts tests/e2e/text-diff-responsive.spec.ts tests/e2e/text-diff-offline.spec.ts
node scripts/bench/text-diff.mjs
```

Run relevant shell/router/applicability focused suites at Step 2. Browser suites must use the real bundled worker where the invariant concerns message transfer, termination, or production loading. Existing unit fixtures remain useful for deterministic protocol races, but they cannot substitute for real-worker proof.

### Final gate

Run separately so failures are easy to attribute:

```text
npm run typecheck
npm run lint
npm run contrast
npm test
npm run build
npm run size
npm run test:e2e
node scripts/bench/text-diff.mjs
```

The browser Vitest project must actually run and meet the existing CI floor (150 tests); do not infer its execution from a combined test total. Ensure no stale preview server bypasses Playwright's fresh production build. Timing runs are recorded separately from pass/fail correctness gates. Re-run broader suites after fixes only when new changes or unresolved concerns justify them.

## 10. Execution evidence ledger

Update this section during execution with concise evidence, without replacing the specification:

Historical checkpoints; the final acceptance record below supersedes interim follow-ups.

| Gate | Status at recorded checkpoint | Evidence |
| --- | --- | --- |
| Approved direction | Complete | User approved brainstorm and requested `$writeplan`. |
| Upstream inspection | Complete | `origin/main` pinned to `838cbb5`; source/architecture/patch investigations completed read-only. |
| Independent plan review | Complete | Sol reviewer identified Unicode Find offsets and grapheme slice boundaries; both contracts and concrete Step 3/coverage fixtures were added. Root also clarified within-row cursors, artifact-status callbacks, and raw/logical/normalized identity. |
| Baseline / branch preparation | Complete | Branch `codex/text-diff-overhaul` created from `838cbb5`; local `main` preserved. Typecheck, 70 engine/op + 21 browser tests, 11 Text Diff production e2e journeys, build and size passed. Initial gzip: JS 38.64 KiB, CSS 6.22 KiB, total 44.86 KiB. esbuild/Chromium require escalated execution because the sandbox returns spawn EPERM. |
| Core and patch contracts | Complete; serializer allocation follow-up retained | Root fresh focused run: 98 Node tests pass (74 engine/op, 5 model, 19 exact-patch); actual Git application compares resulting bytes. Implementer typecheck/lint pass. Trailing high surrogate and redundant identity diffing corrected. Zero-context patches require Git's documented `--unidiff-zero` option. Step 5 must move the 32 MiB export cap ahead of whole-output allocation; current serializer measures afterward. |
| Workspace host review | Complete — checkpoint A passed | Root and fresh Sol reviewer each ran 48 host/contract/pipeline/real-worker tests successfully, including termination/replacement of a busy real worker. Reviewer found no material defect in lifecycle, provenance, or cancellation. Implementer typecheck/lint, 160 focused tests, 12 tool-first/results e2e, build/size pass; initial JS 39.15 KiB, CSS 6.27 KiB. Actual workspace integration remains for Steps 3–5. A late failed import may require one explicit Retry after returning; recovery is available. |
| Worker / bounded view | Implemented; focused gate passed | Root fresh 9 range + 7 real-worker/client tests pass; implementer typecheck/targeted lint pass. Actual-module benchmark: 100k rows/50k hunks 137.9 ms index, 1.6 ms first window, <0.1 ms final window; mass-EOL index 24.8 ms; Find 3.8 ms. Root-found retired-worker, cache-hit ordering, crash-state, and terminal-destroy issues corrected with regression fixtures. Extra independent bounded range review is running alongside UI work. Reference environment: Windows 10.0.26200, Core Ultra 9 275HX, 24 logical CPUs, 63.42 GiB RAM, Node 24.15.0, Playwright 1.62.1. Physical mobile hardware is unavailable here. |
| Responsive UI / exports | Responsive UI complete; export hardening in progress | Root fresh focused gate passed 33 tests: 13 range, 12 workspace, 7 real-worker/client, and 1 global-drop reset. Sol reports 752 full-suite tests, 231 latest browser-project tests, 9 Text Diff e2e journeys, typecheck/lint/build/contrast/size passing; initial JS 39.17 KiB. Root inspected desktop and 320px review; no document overflow, correct unified equal-row rendering. Step 5 now owns serializer pre-allocation cap, enriched reports/copy, offline and full browser performance. |
| Final acceptance | Complete | Fresh full gates, independent review, production visuals, exact Git oracle, offline journey, and recorded performance matrix passed. See final record below for limitations. |

Early core-only timing probe (Vite-bundled production modules in Node, unique 120-byte lines, one changed line; diagnostic, not the worker/UI acceptance gate): 1,048,560 combined bytes / 8,738 lines took 4.0 ms snapshot validation, 0.8 ms identity, and 5.6 ms diff. 10,485,600 combined bytes / 87,380 lines took 36.3 ms validation, 5.8 ms identity, and 27.3 ms diff. Transfer, decode, windows, browser scheduling, and throttled responsiveness remain to be measured.

Root independent patch probes: 37 additional actual-Git byte-equality cases passed using the Vite-bundled production serializer. Seed 93123 generated 32 raw UTF-8 pairs mixing Unicode, BOM, LF, CRLF, and lone CR; another fixture replaced 4,000 repetitive lines. Four further fixtures covered embedded NUL, U+2028, BOM-only to BOM-plus-LF, and empty to BOM-only. Temporary files were isolated and removed after verifying the resolved cleanup target.

Root-approved protocol refinement: add independent `read`/`source` worker messages if required so a user can open, validate, and edit Original while Revised is still unprovided. A missing side must never be silently converted to an explicit empty source merely to decode the other. Decode stays in the dedicated worker, with side-specific errors and prior-good-source recovery.

Browser runtime available for final checks: Chromium 151.0.7922.34 (version read by launching the installed Playwright runtime). WebKit and Firefox executables are not installed. Cross-engine and physical mobile behavior must therefore remain explicitly unclaimed unless that environment changes.

Step 3 draft inspection cases queued for the worker gate: concurrent Original/Revised reads retain both current intents; metadata uses aligned source rows, coalescing adjacent changes while separate changes at rows 1/5,000 remain navigable; metadata-only BOM changes work with zero display rows; equal-gap lookup uses block boundaries; expanded 50-line context is actually rendered; paired 70k-unit graphemes continue across windows without exceeding the 100k cap; Find returns a worker-computed, grapheme-aligned window cursor for hits inside long lines. These are implementation checks in progress, not reported passes.

Additional independent range review found four P2 corrections, assigned to the sole UI writer as adjacent integration work: normalize all hunk `endRow` values to exclusive; expose stable origin/cumulative state for repeated 50-line gap expansion; prevent the no-Segmenter fallback splitting an emoji when prior rows leave exactly one character of page budget; prevent a collapsed equal gap from jumping over later metadata/reveal targets. Public reproductions confirmed the latter two. All four findings are fixed and their regressions pass in the root fresh 33-test UI/range/worker gate. A final segment-local gap-origin fix ensures metadata-separated gaps expand the clicked segment.

Root-approved performance refinement (2026-09-12): actual filesystem-backed 100k-line files per side caused a 1,124 ms main-thread task before comparison; Chromium metrics showed 622 ms layout plus 189 ms style recalculation. The same sources with native textareas hidden required 1.5 ms layout and had no 50 ms long tasks. Keep full 10 MiB / 200k-line comparison support. Large file sources (over 250,000 UTF-16 units OR over 5,000 line terminators, using a bounded threshold check) therefore default to a bounded preview with an explicit Load full text for editing action. This changes editor presentation only: comparison, exact copy, and export remain backed by complete raw sources; clear/undo/swap/route return preserve deferred state. Small sources and ordinary typed text remain directly editable. Full native editing is opt-in and must disclose a possible browser pause. Large blocked-clipboard fallback likewise requires an explicit full manual-copy action rather than eagerly laying out all source text. Fresh Sol architecture review confirmed the state/lifecycle scope and exact-CRLF preservation requirements. Reprofile after the fix; this is an evidence-based presentation adjustment, not a reduced comparison limit.
Step 5 serializer gate: root fresh 23 tests passed (4 bounded export regressions and 19 actual Git patch cases). Reports now carry context/detail/scope/identity/rules, escape source names/text, stack on phones, and drop similarity. Worker copy uses shared serialization. IME invalidation, reachable denied-clipboard fallback, worker startup rejection, and view-crash recovery were corrected. Implementer fresh typecheck/lint, 14 workspace browser tests, and 5 production Text Diff journeys passed; the download journey opens saved HTML with JavaScript disabled and HTTP(S) blocked at desktop and 320px. Offline failed concretely at precached startup asset lookup and was escalated to fresh Sol: hashed asset requests must search APP_CACHE as well as RUNTIME_CACHE, and tolerate the static preview server's Vary: Origin. The narrowed production offline journey passes after this lookup fix; best-effort cache-write regression checks and the final broad gate remain pending.

### Final acceptance — 2026-09-12

Steps 0–6 are complete on `codex/text-diff-overhaul`. Changes remain uncommitted;
no deployment or merge was requested. No dependencies or bundle budgets changed.

| Fresh parent gate | Result |
| --- | --- |
| Typecheck / lint / whitespace | Passed `npm run typecheck`, `npm run lint`, and `git diff --check`. |
| Full unit and browser suite | 775 tests passed across 40 files. |
| Explicit browser-project floor | 239 tests passed across 16 files; exceeds the existing CI floor of 150. |
| Production build / size | Passed. Initial gzip JS 39.17 KiB, CSS 6.27 KiB, total 45.44 KiB; existing 40/12/60 KiB budgets retained. |
| Contrast | All 72 checked pairings pass WCAG AA in both themes. |
| Full production end-to-end suite | 51 tests passed, including offline reload → compare → Find → character detail → report → patch. Source markers absent from observed request URL/body and local/session storage values. |
| Downloaded report | Actual saved HTML opened with JavaScript disabled and HTTP(S) blocked, at desktop and 320px. Additional focused print-media download test passed; root inspected desktop, phone, and print screenshots. |
| Exact patch | All 19 committed-suite fixtures pass actual Git application/byte equality; 37 additional root probes passed. Final independent reviewer also applied swapped-op output to the correct target and byte-compared successfully. |
| Production visual acceptance | Root inspected 1440px dark review, 390px dark navigation, and 320px inputs/light review. Responsive automation covers 320/375/390/768/1024/1440/2560px, 200% text-size emulation, keyboard source tabs/disclosures, and emulated coarse-pointer targets. Temporary viewport/theme overrides restored. |
| Performance | Corrected production harness completed all 18 fixture/throttle combinations. Detailed samples: `2026-09-12-text-diff-performance.json`; interpretation: `scripts/bench/README.md`. |
| Independent review | Fresh Sol reviewers covered host lifetime/cancellation, bounded ranges, and final cross-file integration. All introduced material findings were fixed. Final narrow benchmark review corrections also applied. |

AC1/AC3/AC9 are covered by workspace/host/shell/routing and old-tool regression tests;
AC2 by source lifecycle/validation/IME/clipboard tests; AC4 by responsive, keyboard,
contrast, and actual visual inspection; AC5/AC6 by exact/normalized identity, Unicode,
metadata, bounded ranges, long-line continuation, hidden Find, and distant navigation
tests; AC7 by real-worker cancellation/replacement/crash tests and performance evidence;
AC8 by actual downloads, script-free reports, bounded exports, and the Git byte oracle.

Final review corrections include swap-aware patch target names, cancellation settlement
even when worker replacement throws, cleared/no-match Find rendering, complete metadata
disclosure when text and endings change together, and visible CRLF/CR normalization
warnings before native file editing. The serializer now enforces its 32 MiB limit while
writing bounded chunks, before retaining a whole oversized output.

The separate filesystem-backed 100k-line-per-side ingestion profile confirms the large-file
presentation fix: normal source acceptance now spends 2.196 ms in layout and 1.202 ms in
style recalculation, with no main-thread task over 50 ms (previously 622 ms layout,
189 ms style, and a 1,124 ms task). Full source editing remains an explicit opt-in;
the benchmark does not promise fast native editing of the largest sources.

Coverage limits: only installed Chromium 151.0.7922.34 was tested. Firefox, WebKit,
physical mobile keyboards/touch, and an actual assistive-technology session are
unverified; accessibility-tree inspection and browser keyboard tests are the available
smoke evidence. The 200% check emulates text scaling, not browser chrome zoom. CPU
throttling is a local main-thread simulation, not a device benchmark. Dense 200-row
review interactions reached about 259 ms p95 and page long tasks reached 342 ms under
4x throttling, so slower-device rendering remains a performance limitation.

The final reviewer identified two pre-existing follow-ups outside this feature:
service-worker installation clears its fixed shell cache before a potentially failing
precache, and shared pool waiters can remain pending when replacement construction
fails. Neither was introduced by the overhaul; this change fixes current workspace
cancellation settlement and offline asset lookup without redesigning those systems.

### Subsequent review — open findings

The separate requested review identified three P2 issues after the acceptance run:
failed file replacement can leave the previous comparison exportable; the sticky
review toolbar sits beneath the app header when scrolled; and narrowing the layout
while editing Revised selects Original and drops focus. These remain open in this
revision. Focused core and integration suites passed during that review; the findings
require additional browser coverage. The requested main-branch publication does not
include fixes for these findings.
