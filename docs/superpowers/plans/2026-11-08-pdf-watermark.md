# PDF Watermark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide PDF text watermarks and verify the existing PDF merge workflow.

**Architecture:** Register a lazy, DOM-free pdf-lib operation using the existing generic options panel and worker protocol. Preserve the current PDF merge implementation.

**Tech Stack:** TypeScript, pdf-lib, Vite, Vitest, Chromium.

**Spec:** `docs/superpowers/specs/2026-11-08-pdf-watermark-design.md`

## Global Constraints

- All file processing remains local, in the existing worker pipeline.
- No new dependencies; preserve existing UI and import boundaries.
- Defaults: CONFIDENTIAL, diagonal, size 6%, opacity 35%, black.
- Named typed file errors; monotonic progress; cancellation.

## Review Focus

- Rotated, cropped, and unusually small pages must keep the label visible.
- Long labels must fit; unsupported font characters must produce useful errors.
- Batch outputs must preserve page counts, original text, and metadata.
- Malformed/encrypted inputs must identify the failed file.
- A merged result must be reusable as a watermark input.

### Task 1: Watermark operation and registration

**Files:** Create `src/tools/pdf/watermark.op.ts`, `tests/unit/pdf-watermark.test.ts`; modify `src/core/registry.pdf.ts`, `src/core/workers/loaders.pdf.ts`, `src/ui/toolicons.ts`.

**Interfaces:** Consume `Op` and `OpContext`; produce a default `Op` export registered under `pdf-watermark`. UI options: text, position, size, opacity.

- [x] Write tests for registration, page content preservation, defaults, positions, fitting, crop/rotation, named errors, validation, cancellation, and progress.
- [x] Run the registration test and observe failure because the tool is absent.
- [x] Implement the operation and its registry/loader/icon entries.
- [x] Run the focused Node tests and verify they pass.

### Task 2: Browser workflow, docs, and verification

**Files:** Create `tests/unit/pdf-watermark.browser.test.ts`; update `README.md`.

**Interfaces:** Use the registered `pdf-watermark` operation and independent PDF.js rendering with system-font substitution. The existing merge production test remains the merge acceptance check.

- [x] Verify rendered placement on cropped and rotated pages using actual PDF rasterization.
- [x] Document the new PDF tool and watermark behaviour.
- [x] Run typecheck, lint, the complete test suite, build, size, and production browser tests.
- [x] Inspect the desktop and mobile UI and review the diff before delivery.

Execution: inline in the existing shared workspace. Keep changes uncommitted for user review. No worktree or branch changes are needed for this focused addition.

Verification: 830 unit/browser tests and 61 production browser tests pass. A direct production browser smoke check combined two PDFs into six pages, handed the result to Watermark PDF, and verified DRAFT text in the downloaded content of all six pages. Desktop and mobile screenshots were inspected; no overflow or page errors occurred. Typecheck, lint, build, and the unchanged size budget pass.

Implementation rulings: use the image-watermark defaults of 6% size and 35% opacity for consistency. Keep the standard PDF UI focused on text, placement, size, and opacity to fit the existing initial-load budget. Test rendering independently with PDF.js standard-font substitution, because the existing app rasterizer suppresses those fonts.
