# UI Overhaul — Known Follow-ups

- **Date:** 2026-08-30
- **Branch:** `feat/ui-overhaul`
- **Spec:** [2026-08-30-ui-overhaul-design.md](./2026-08-30-ui-overhaul-design.md)

Everything the overhaul's own reviews found and deliberately did **not** fix, triaged
by the final whole-branch review. Recorded here because a deferred item nobody wrote
down is a silently discarded one.

Nothing below blocks the overhaul. Each was judged either genuinely separate work, or
small enough to carry.

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

### The file tray's hint copy during a run

`.tray__hint` reads *"Drag a file, use the arrow buttons, or focus a file and press
the arrow keys."* All three are frozen while a job runs. The controls now
**look** disabled (`opacity: 0.3`, `cursor: not-allowed`), so nothing silently
no-ops — but the hint still advertises them. A small change in `src/ui/filetray.ts`
to swap or hide the text while frozen.

### The work zone's landmark loses the tool name

`src/ui/zones/work.ts` labels zone 3 with a static `aria-label="Selected tool"`. It
was chosen over `aria-labelledby` pointing at a heading inside a `hidden` panel, which
resolved to an empty accessible name in the cold state. But it means every tool
announces as the generic "Selected tool, region" during landmark navigation.

A dynamic `aria-label` — `tool ? tool.name : 'Selected tool'`, set in `render()` the
way `heading.textContent` already is — keeps a name in every state *and* the tool's
name when there is one. One line, and it avoids both risks the original choice was
dodging.

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

## 3. Test gaps, each understood

- **No frame-level "no intermediate paint" test** for the hero handoff. Not
  meaningfully assertable here — no rAF-sampling or screenshot-diff infrastructure, and
  a hand-rolled version would mostly measure compositing timing. Mitigated structurally:
  `fadeHero` takes a single element, so animating an already-visible target is
  unrepresentable rather than merely avoided.
- **`countReason`'s "Takes at most N files" branch is unreachable** with the current
  registry — every tool has `min === max` or `max === null`. Hand-verified correct,
  untested, and will matter the first time a bounded-range tool is added.
- **`applicability.test.ts` asserts `qr-generate`'s `minInputs` but not
  `maxInputs === 0`.** A regression reverting it to `null` would slip through.
- **`preset.test.ts` never exercises `basename`'s two documented edge cases** — the
  double extension (`holiday.tar.gz` → `holiday.tar`, the example in its own comment)
  and a leading-dot name. Both hand-verified correct.
- **`state.test.ts`'s first `derivePhase` case is tautological** — it hardcodes
  `runBlocked: null` in its own input.
- **`organize.spec.ts`'s comment promises to verify the op's output** but the test only
  asserts a Download button appeared.
- **`presetValues`/`presetBecause` are ignored on the `tool.editor` branch.** Harmless
  today: no tool has both an editor and a preset.
- **The `aria-describedby` compose branch is dead by construction** — nothing else sets
  that attribute, so only the else-branch is live.
- **`npm test`'s summary line is the only signal that the `browser` vitest project
  actually ran** (independent review pass #4, M7). Nothing in the test run itself
  asserts that the browser project's own suites — five of this branch's new test files
  among them — contributed to the total; a run where that project silently produced
  zero tests (as opposed to failing outright, which the reviewer confirmed it does: an
  unbootable browser provider exits 1 with `Errors: 1 error`, not a quiet pass) would
  still need a human to notice the count looked short. Cheap insurance, not acted on: a
  CI step asserting `--project browser` reports at least its known-minimum test count.
