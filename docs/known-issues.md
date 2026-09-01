# Known issues

Open items found during the UI overhaul (2026-08-30) and deliberately deferred rather
than fixed, with the reasoning. Recorded because a deferred item nobody writes down is
a silently discarded one.

None of these block use of the app. Each was judged either genuinely separate work, or
small enough to carry. User-facing behavioural limits live in the README instead — this
file is engineering debt.

## 1. Worth doing next

### `disabled` → `aria-disabled` for Run and blocked tool cards

The largest item, and the only one with a real user impact.

A native `disabled` button is not focusable. So when a tool's requirements are unmet
and **the Run button's label is the reason** — *"Needs at least 2 files — you have
one"* — someone who relies on focus to read that label (a screen-magnifier user
following focus, for instance) cannot reach it. The same holds for a blocked tool
card, where the reason is the card's entire purpose.

Two qualifications kept this out of the overhaul:

- The reason is **visibly** on the button, and a screen reader's virtual cursor reads
  disabled elements, so it is exposed as the accessible name. WCAG AA does not require
  disabled controls to be focusable, and no *operable* control is unreachable — the
  README's "fully keyboard operable" claim stays true.
- Moving to `aria-disabled` changes activation semantics: the control becomes
  focusable and must be explicitly prevented from acting. That deserves its own change
  with its own tests, not a bolt-on.

`src/styles/app.css` already carries `.toolcard--blocked:focus-visible { box-shadow:
var(--ring) }`, added pre-emptively in anticipation of this. It is dead until the
switch happens.

**Done:** `runButton` (`zones/work.ts`) and blocked tool cards (`zones/catalogue.ts`)
now carry `aria-disabled` instead of `disabled`, so both stay in the tab order; each
one's own click handler checks the attribute and refuses to act when it reads
`'true'`, which is the "explicitly prevented from acting" half the qualification
above asked for. `app.css`'s pre-emptive `.toolcard--blocked:focus-visible` rule (and
the equivalent added for `.btn[aria-disabled='true']`) are live now, not dead.
Covered by the "followups" describe blocks in `tests/unit/shell-fixes.browser.test.ts`
and by `tests/e2e/a11y.spec.ts`'s "reaches a BLOCKED Run by keyboard alone" test.

### The file tray's hint copy during a run

`.tray__hint` reads *"Drag a file, use the arrow buttons, or focus a file and press
the arrow keys."* All three are frozen while a job runs. The controls now
**look** disabled (`opacity: 0.3`, `cursor: not-allowed`), so nothing silently
no-ops — but the hint still advertises them. A small change in `src/ui/filetray.ts`
to swap or hide the text while frozen.

**Done:** `filetray.ts` swaps `.tray__hint`'s text to a frozen-specific message in
`setRunning`, restoring the idle copy once the run ends. Covered by
`tests/unit/shell-fixes.browser.test.ts`.

### The work zone's landmark loses the tool name

`src/ui/zones/work.ts` labels zone 3 with a static `aria-label="Selected tool"`. It
was chosen over `aria-labelledby` pointing at a heading inside a `hidden` panel, which
resolved to an empty accessible name in the cold state. But it means every tool
announces as the generic "Selected tool, region" during landmark navigation.

A dynamic `aria-label` — `tool ? tool.name : 'Selected tool'`, set in `render()` the
way `heading.textContent` already is — keeps a name in every state *and* the tool's
name when there is one. One line, and it avoids both risks the original choice was
dodging.

**Done:** exactly the fix sketched above. Covered by
`tests/unit/shell-fixes.browser.test.ts` and by `tests/e2e/a11y.spec.ts`'s zone-3
landmark test, which now asserts the name changes on selection instead of asserting
it stays fixed.

## 2. Real, small, safe to carry

- **A route can install a type-mismatched transform the catalogue has no card for.**
  `state.selectTool` applies no `typesMatch` check while `pruneSelection` does.
  **Correction (independent review pass #4):** this was originally recorded as reachable
  only via Back/Forward. It is not — `select()` applies no `typesMatch` check on ANY
  route, so an address-bar edit or an external link reaches it exactly the same way:
  the work zone shows *"X doesn't work with these files."* while nothing is ticked in
  the catalogue. The generator half of this divergence was reconciled in
  `zones/catalogue.ts`; the transform-shaped remnant is open. Still deferred — the
  correction is to the reachability claim, not to the triage.
- **Returning to the catalogue via Back/Forward announces nothing**, where
  click-to-deselect says *"Tool deselected."* Consistent with the existing "only
  explicit in-tab actions announce" philosophy, so a decision rather than a bug.
- **"N tools can run on these files" undercounts a persisted generator** — the header
  reads 7 beside 8 pills. Off by one; the blank-header case is unreachable.
- **Below 768px, a cold visitor scrolls past all 29 tools** before reaching the work
  zone's placeholder. Spec §4.3 specifies only the *picked* fold, which ships.
- **`HERO_EXIT_DURATION_MS` (120) and `--dur-fast` (120ms) are independent literals.**
  Documented in-code with each pointing at the other; a runtime `getComputedStyle` read
  was judged not worth the round trip. They can drift.
- **`router.destroy()` does not reset `lastWrittenHash`.** Inert — the listener is
  already removed.
- **`navigate()`'s JSDoc** ("push a route without re-entering `onRoute`") overstates
  slightly: under same-tick multi-write patterns `onRoute` can fire a harmless
  duplicate with the same id. `select()` is idempotent to it by design.
- **A narrow race in `mountOptions`.** If the file list changes during the
  `disabledFormatChoices` await, the panel mounts with a caption computed from the
  pre-await files. The next emit retracts it, but nothing forces one.
- **`registry.*.ts` header comments** lost a pre-existing "Owned by the *group* tools
  task" line. That note referred to the original build's task split and is long stale.

## 3. Test gaps

- **No frame-level "no intermediate paint" test** for the hero handoff. **Still open,
  deliberately.** Not meaningfully assertable here — no rAF-sampling or screenshot-diff
  infrastructure, and a hand-rolled version would mostly measure compositing timing.
  Mitigated structurally instead: `fadeHero` takes a single element, so animating an
  already-visible target is unrepresentable rather than merely avoided.
- **`countReason`'s "Takes at most N files" branch was unreachable** through the
  registry — every real tool has `min === max` or `max === null`, so no fixture could
  exercise it. **Done:** covered by four cases against a synthetic `ToolDef` with
  `min < max` (`applicability.test.ts`), including the singular "1 file" wording and
  both ends of the valid range.
- **`applicability.test.ts` did not assert `qr-generate`'s `maxInputs === 0`.**
  **Done.** This is the field that keeps `shell.ts` from handing a generator every
  loaded file, so reverting it to `null` now fails a test.
- **`preset.test.ts` never exercised `basename`'s two documented edge cases.**
  **Done:** the double extension (`holiday.tar.gz` → `holiday.tar`, the example in its
  own comment) and leading-dot names (`.gitignore` kept whole, `.env.local` → `.env`).
- **`state.test.ts`'s `derivePhase` cases hardcoded their `runBlocked` input.**
  `derivePhase` only cares whether it is null, so hand-written strings would pass
  forever even if it and `runBlockedReason` stopped agreeing — and the shell feeds one
  into the other on every emit. **Done:** every case now routes through the real
  `runBlockedReason`, plus one test asserting the two agree about when a run is
  possible.
- **`organize.spec.ts` promised to verify the op's output** but only asserted a
  Download button appeared. **Done:** it now downloads the real bytes and asserts the
  emitted PDF has exactly 2 pages, so the board's reorder-and-delete genuinely reaching
  the op is measured rather than assumed.
- **`presetValues`/`presetBecause` are ignored on the `tool.editor` branch.** An editor
  derives its options from the files itself, so this is fine — but it fails SILENTLY,
  dropping the preset with no error. **Done:** a registry invariant test asserts no tool
  declares both, so creating that combination goes red and forces a decision instead of
  quietly losing the preset.
- **The `aria-describedby` compose branch was dead by construction** — nothing else set
  that attribute, so the append-to-existing arm was unreachable and therefore
  untrustworthy. **Done:** extracted as `composeDescribedBy` and unit-tested on both
  arms. That also fixed a latent bug the inline version had — it would have listed the
  same id twice on a re-render.
- **`npm test`'s summary line was the only signal that the `browser` vitest project
  actually ran** (independent review pass #4, M7). Twelve suites live only in that
  project — anything touching `OffscreenCanvas`, real DOM, or real key events. **Done:**
  a CI step asserts `--project browser` reports at least 150 passing tests (it reports
  200 today), so a project that silently contributed nothing is a red build rather than
  a total that merely looks short.
