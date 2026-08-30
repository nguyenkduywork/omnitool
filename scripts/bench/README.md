# scripts/bench

Harnesses for the performance claims this codebase makes, so that "measured"
means *you* can measure it, not that someone once did.

```bash
npm run bench                 # all four
node scripts/bench/csv.mjs    # or one at a time
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

## Two rules these follow

**They measure the shipped code.** Every harness imports the real module from
`src/` through `_bundle.mjs`, which builds it with Vite — the same build the app
ships through. A benchmark against a pasted copy measures a fossil: it keeps
reporting its number long after the real function has changed, which is worse
than having no benchmark.

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
