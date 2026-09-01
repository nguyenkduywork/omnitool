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

## 2. Behaviour and consistency

- **A route can install a type-mismatched transform the catalogue has no card for.**
  **Resolved as intended, not changed.** `selectTool` and `pruneSelection` answer
  different questions, so the asymmetry is deliberate: `pruneSelection` drops a tool
  when the files change *underneath* one you already picked (its options would describe
  files that are gone, and you never asked for that), while `selectTool` honours a tool
  you just asked for. A route to `#/pdf-merge` with a PNG loaded therefore shows the
  tool with *"Merge PDFs doesn't work with these files."*, Run disabled, and "Change
  tool" as the way out. Refusing instead would drop the request on the floor and return
  you to a catalogue that never explains why your bookmark did not open. Now documented
  on `selectTool` and pinned by two tests, so changing it is a decision rather than a
  drift.
- **Returning to the catalogue via Back/Forward announced nothing**, where
  click-to-deselect says *"Tool deselected."* **Done:** every route to the catalogue now
  announces *"Back to all tools. No tool selected."* Route-driven *selection* already
  announced, which left Back/Forward as the one navigation that changed the screen and
  said nothing — the exact silence this overhaul exists to remove. Verified live via
  live-region mutation records.
- **"N tools can run on these files" undercounted a persisted generator** — the header
  read one short of the pills actually on screen. **Done:** verified live, the header now
  reads 12 beside 12 controls and 13 once a generator is selected.
- **`HERO_EXIT_DURATION_MS` (120) and `--dur-fast` (120ms) are independent literals.**
  `fadeHero` resolves on a JS timeout while the visual is a CSS transition, so the two
  must agree. **Done:** a unit test reads `tokens.css` and asserts they match, plus that
  the reduced-motion override is still effectively instant. A runtime
  `getComputedStyle` read is still judged not worth the round trip.
- **`router.destroy()` did not reset `lastWrittenHash`.** **Done** — inert either way,
  but a torn-down handle holding stale state misleads whoever reuses the module.
- **`navigate()`'s JSDoc overstated its guarantee.** **Done:** it now says what is
  actually true — the echo guard is per-write, so two writes in the same tick can
  surface one duplicate `onRoute` with the same id, which is why consumers only need to
  be idempotent.
- **A narrow race in `mountOptions`.** **Done.** Everything derived from the files is now
  read on the far side of the `disabledFormatChoices` await. Previously an intake landing
  during the encoder probe mounted a caption computed from files that were already gone
  — *"from the first file"* naming a file no longer in the tray — and set
  `lastFilesSignature` to that same stale list, so `syncEditor` saw no change and nothing
  ever corrected it. The pre-await `defaultOptions` seed is kept deliberately: the panel
  is already on screen during the probe, so a Run clicked then must still send the schema
  defaults rather than an empty object.
- **`registry.*.ts` header comments** lost a pre-existing "Owned by the *group* tools
  task" line. **Closed, won't restore** — that note described the original build's task
  split, which no longer exists.
- **Below 768px, a cold visitor scrolls past all 29 tools** before reaching the work
  zone's placeholder. **Still open, deliberately.** Spec §4.3 specifies only the *picked*
  fold, which ships. Fixing it means reordering the three-zone DOM, which changes tab
  order and the grid's placement rules — a layout change wanting its own design pass and
  its own a11y verification, not a carried one-liner.

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
