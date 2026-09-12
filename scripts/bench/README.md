# scripts/bench

Harnesses for the performance claims this codebase makes, so that "measured"
means *you* can measure it, not that someone once did.

```bash
npm run bench                 # all module benchmarks
node scripts/bench/csv.mjs    # or one at a time
node scripts/bench/text-diff.mjs
npm run build
node scripts/bench/text-diff-browser.mjs  # separate production browser matrix
```

Nothing here runs in CI. Timings on a shared runner are noise, and a benchmark
that fails randomly is a benchmark people learn to ignore. The *correctness*
halves do exit non-zero on a mismatch, so a harness is usable as a gate by hand
— and the fast, seeded slice of the CSV fuzz lives in `tests/unit/data.test.ts`,
where CI does run it.

## What each one answers

| Harness | Question |
| --- | --- |
| `csv.mjs` | Is the rewritten parser still the *same parser*, and still faster? |
| `base64.mjs` | Is the hand-written encoder byte-identical to `btoa`, and is decode still better off native? |
| `bundle.mjs` | What does storing already-compressed output save, and what does deflating the rest still earn? |
| `md5.mjs` | The optimisation that was measured and **rejected** — kept so the rejection stays checkable. |
| `text-diff.mjs` | Indexed comparison, bounded page reads, literal Find, many-hunk navigation, and ending-only metadata using the shipped modules. |
| `text-diff-browser.mjs` | Actual production worker/UI timing with filesystem-backed input, bounded rendering, navigation, typing, and cancellation at normal speed and 4x CPU throttling. Requires installed Playwright Chromium and a fresh build; starts its own local preview on port 4175. Optional first argument saves detailed JSON. |

## Two rules these follow

**They measure the shipped code.** Module harnesses import the real module from
`src/` through `_bundle.mjs`, which builds it with Vite — the same build the app
ships through. A benchmark against a pasted copy measures a fossil: it keeps
reporting its number long after the real function has changed, which is worse
than having no benchmark.

The browser harness serves `dist/` directly. It samples each comparison three times,
Wrap twenty times, Next change ten times, and Cancel three times. The small-prose
fixture additionally samples twenty native keystrokes. Timings stop at the next
animation frame, not a compositor paint. Cold worker/module startup can appear in
the first sample. `firstWindowP95` starts at the comparison worker's `postMessage`;
it excludes file selection and decoding. Typing starts in a capture-phase input
listener before the app handler. Cancellation follows Clear/Undo through visible
controls to make the comparison stale before dispatch. It records all page long
tasks, including page startup; 4x CDP
throttling models slower main-thread work, not a physical phone or uniform worker
slowdown. Timing values are observations, never tight CI assertions.

**The "before" is frozen, not maintained.** `reference/` holds the
pre-optimisation implementations, extracted verbatim from the commit they were
replaced in and named for its SHA. They are golden references: never update
them. Their whole job is to be the thing the current code is checked against,
so "the rewrite changed no answer" stays a fact anyone can re-establish.

## Reading the numbers

Ratios move with the machine, the Node version, and how the module was loaded —
the CSV parser measures ~2–4× faster than its reference depending on all three.
What is stable, and what these harnesses are for, is the **direction and rough
magnitude**, plus the correctness half, which is exact and must never disagree.

Both fuzzers are seeded (`BENCH_SEED`), so a failure is reproducible rather than
a story about a case you saw once. `BENCH_CASES` and `BENCH_BYTES` size the runs.

## Text Diff reference run — 2026-09-12

Windows 10.0.26200, Core Ultra 9 275HX (24 logical CPUs), 63.42 GiB RAM,
Node 24.15.0, Chromium 151.0.7922.34, 1440×900 viewport. All 18 production
fixture/throttle combinations completed; no page contained more than 200 review rows.
Values below are comparison dispatch → first-window-frame p95 in milliseconds
(three samples, so p95 is the largest sample).

| Fixture | Combined UTF-8 bytes | Normal | 4x CPU throttle |
| --- | ---: | ---: | ---: |
| Small prose | 84 | 569.0 | 29.3 |
| Source code | 28,558 | 40.0 | 41.2 |
| Repetitive lines | 280,001 | 48.4 | 48.4 |
| Unrelated lines | 557,778 | 98.6 | 164.6 |
| 1 MiB typical | 1,048,560 | 48.4 | 71.2 |
| 10 MiB typical | 10,485,600 | 181.1 | 253.2 |
| 200k combined lines | 954,024 | 264.8 | 381.0 |
| Minified | 1,024,000 | 47.8 | 47.6 |
| Long Unicode line | 38,004 | 21.2 | 31.1 |

The first small-prose sample had a delayed frame: its worker window arrived at
15.6 ms, but the measured animation frame arrived at 569 ms. The next two samples
were fast; the outlier is retained. Timing here includes frame scheduling noise.

Across fixtures, normal p95 was at most 29.5 ms for Wrap, 69.0 ms for Next change,
and 16.0 ms for Cancel. Small-source typing p95 was 13.7 ms. At 4x throttle these
maxima were 231.3, 259.3, 21.1, and 3.5 ms respectively. The maximum observed page
long task was 51 ms normally and 342 ms throttled. Dense 200-row DOM renders are
the slower interaction cases; a throttle run is not a guarantee for physical phones.

[Recorded samples](../../docs/plans/2026-09-12-text-diff-performance.json) retain
per-comparison timing and row counts plus observed page long tasks. Large-file
native editors are deferred to avoid expensive input layout; explicitly loading
the full editor can still pause the browser. Minified/long-line fixtures use the
disclosed line-detail fallback. The module benchmark separately measured a
100k-row/50k-hunk index at 178.7 ms, first bounded window at 43.7 ms, final window
below 0.1 ms, mass-ending index at 25.5 ms, and literal Find at 4.5 ms.
