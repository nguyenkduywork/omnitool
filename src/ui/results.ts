// src/ui/results.ts — the results tray.
//
// Three things this file refuses to do:
//
//   1. CLAIM AN OUTCOME IT DID NOT ACHIEVE. The size delta is computed from real
//      byte counts and is labelled honestly — "12% smaller", "3% LARGER", or
//      "same size". A job that came back `partial: true` says so in a banner
//      before any output card, with the count that failed. Partial success is
//      never dressed up as success (§9).
//   2. USE alert() OR THE CONSOLE for failures. Every per-file failure is a card
//      in this tray, naming the file and what to do next.
//   3. FORCE A DOWNLOAD TO READ A STRING. Textual outputs — a checksum, a
//      formatted JSON, base64, extracted PDF text — render inline with a copy
//      button, because downloading a file to look at a SHA-256 would be absurd.
//
// `core/fs` (and with it fflate) is imported LAZILY: it is only needed once the
// user actually saves something, and keeping it out of the entry chunk is part
// of holding the §1 size budget.

import type { JobResult, OpErrorCode, OpOutput } from '../types';
import { label } from '../core/format';
import { el, formatBytes, icon } from './dom';
import { flyToResults } from './motion';

export type ResultInput = { name: string; size: number };

export type ResultsView = {
  toolName: string;
  inputs: ResultInput[];
  result?: JobResult;
  /** A job-level failure: nothing succeeded, or the cause is not one file. */
  error?: { code: OpErrorCode; message: string; file?: string };
};

export type ResultsHandle = {
  readonly el: HTMLElement;
  show(view: ResultsView): Promise<void>;
  clear(): void;
};

/** What to do next, per error code. Every message must be actionable (§9). */
const NEXT_STEP: Record<OpErrorCode, string> = {
  UnsupportedFormat:
    'The file is not the format its contents claim. Re-export or re-save it, then try again.',
  CorruptFile:
    'The file could not be parsed — it may be damaged or password-protected. Open it in its own app, re-save a copy, and retry with that.',
  TooLarge: 'This file is beyond what the browser can hold in memory. Split it up and retry.',
  EncoderUnavailable:
    'This browser cannot write that format. Choose a different output format above.',
  InvalidOptions: 'Adjust the options above and run again.',
  Cancelled: 'Nothing was written. Run it again when you are ready.',
  OutOfMemory: 'The browser ran out of memory. Try fewer files, or smaller ones, in one run.',
};

const TEXT_PREVIEW_LIMIT = 20_000;

function isTextual(type: string): boolean {
  return (
    type.startsWith('text/') ||
    type === 'application/json' ||
    type === 'application/xml' ||
    type === 'image/svg+xml'
  );
}

function decode(buffer: ArrayBuffer, limit = Number.POSITIVE_INFINITY): string {
  const bytes = new Uint8Array(buffer);
  const slice = bytes.length > limit ? bytes.subarray(0, limit) : bytes;
  return new TextDecoder().decode(slice);
}

function stemOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return (dot > 0 ? name.slice(0, dot) : name).toLowerCase();
}

/** The input an output most plausibly came from, for an honest size delta. */
function sourceOf(output: OpOutput, inputs: ResultInput[]): ResultInput | undefined {
  const stem = stemOf(output.name);
  const exact = inputs.find((input) => stemOf(input.name) === stem);
  if (exact) return exact;
  const derived = inputs.find((input) => stem.startsWith(stemOf(input.name)));
  if (derived) return derived;
  return inputs.length === 1 ? inputs[0] : undefined;
}

function deltaChip(output: OpOutput, source: ResultInput | undefined): HTMLElement | null {
  if (!source || source.size === 0) return null;
  const after = output.buffer.byteLength;
  const ratio = after / source.size;
  const change = Math.round(Math.abs(1 - ratio) * 100);

  if (change === 0) {
    return el('span', 'chip chip--flat', `same size · ${formatBytes(source.size)}`);
  }
  const smaller = after < source.size;
  return el(
    'span',
    smaller ? 'chip chip--good' : 'chip chip--up',
    `${change}% ${smaller ? 'smaller' : 'LARGER'} · ${formatBytes(source.size)} → ${formatBytes(after)}`,
  );
}

async function saveOne(output: OpOutput): Promise<void> {
  const { download } = await import('../core/fs');
  download(output);
}

async function saveAll(outputs: OpOutput[], zipName: string): Promise<void> {
  const { downloadBundle } = await import('../core/fs');
  await downloadBundle(outputs, zipName);
}

function copyButton(getText: () => string): HTMLButtonElement {
  const button = el('button', 'btn btn--quiet btn--sm');
  button.type = 'button';
  const face = el('span', undefined, 'Copy');
  button.append(icon('copy'), face);

  button.addEventListener('click', () => {
    const text = getText();
    const settle = (message: string): void => {
      face.textContent = message;
      setTimeout(() => {
        face.textContent = 'Copy';
      }, 1600);
    };
    // No clipboard permission, no problem: say so in place, never alert.
    if (!navigator.clipboard?.writeText) {
      settle('Select and press Ctrl+C');
      return;
    }
    navigator.clipboard.writeText(text).then(
      () => settle('Copied'),
      () => settle('Copy blocked — select the text'),
    );
  });

  return button;
}

function outputCard(output: OpOutput, inputs: ResultInput[]): HTMLElement {
  const card = el('article', 'card card--output');

  const head = el('div', 'card__head');
  const name = el('h3', 'card__name', output.name);
  name.title = output.name;
  head.append(name);

  const save = el('button', 'btn btn--ghost btn--sm');
  save.type = 'button';
  save.append(icon('download'), el('span', undefined, 'Download'));
  save.addEventListener('click', () => {
    void saveOne(output);
  });
  head.append(save);

  const meta = el('div', 'card__meta');
  meta.append(el('span', 'card__type', label(output.type)));
  const chip = deltaChip(output, sourceOf(output, inputs));
  if (chip) meta.append(chip);
  else meta.append(el('span', 'chip chip--flat', formatBytes(output.buffer.byteLength)));

  card.append(head, meta);

  if (isTextual(output.type)) {
    const preview = decode(output.buffer, TEXT_PREVIEW_LIMIT);
    const body = el('pre', 'card__text');
    body.tabIndex = 0;
    body.append(el('code', undefined, preview));
    card.append(body);

    const foot = el('div', 'card__foot');
    foot.append(copyButton(() => decode(output.buffer)));
    if (preview.length >= TEXT_PREVIEW_LIMIT) {
      foot.append(
        el(
          'span',
          'card__note',
          `Showing the first ${TEXT_PREVIEW_LIMIT.toLocaleString()} characters. Copy and download give you all of it.`,
        ),
      );
    }
    card.append(foot);
  }

  return card;
}

function failureCard(name: string, code: OpErrorCode, message: string): HTMLElement {
  const card = el('article', 'card card--failed');

  const head = el('div', 'card__head');
  const badge = el('span', 'card__badge');
  badge.append(icon('alert'));
  const title = el('h3', 'card__name', name);
  title.title = name;
  head.append(badge, title, el('span', 'chip chip--bad', code));

  card.append(head);
  // Some codes come back with the code as their message (`Cancelled`); repeating
  // it under the chip that already says it is noise.
  if (message && message !== code) card.append(el('p', 'card__why', message));
  card.append(
    el('p', 'card__hint', NEXT_STEP[code] ?? 'Try again with different files or options.'),
  );
  return card;
}

export function createResults(): ResultsHandle {
  const root = el('section', 'results');
  root.hidden = true;
  root.setAttribute('aria-labelledby', 'results-heading');

  const head = el('div', 'results__head');
  const heading = el('h2', 'panel__title', 'Results');
  heading.id = 'results-heading';
  const summary = el('p', 'results__summary');
  const actions = el('div', 'results__actions');
  head.append(heading, summary, actions);

  const banner = el('div', 'banner');
  banner.hidden = true;

  const grid = el('div', 'results__grid');
  root.append(head, banner, grid);

  return {
    el: root,

    clear(): void {
      root.hidden = true;
      banner.hidden = true;
      grid.replaceChildren();
      actions.replaceChildren();
      summary.textContent = '';
    },

    async show(view: ResultsView): Promise<void> {
      const outputs = view.result?.outputs ?? [];
      const failures = (view.result?.results ?? []).filter(
        (entry): entry is Extract<typeof entry, { status: 'failed' }> => entry.status === 'failed',
      );

      grid.replaceChildren();
      actions.replaceChildren();
      banner.hidden = true;
      banner.className = 'banner';
      root.hidden = false;

      // ---- honest headline -------------------------------------------
      if (view.error) {
        summary.textContent = `${view.toolName} could not finish.`;
      } else if (view.result?.partial) {
        const ok = view.result.results.length - failures.length;
        summary.textContent = `${view.toolName}: ${outputs.length} ${outputs.length === 1 ? 'file' : 'files'} ready.`;
        banner.hidden = false;
        banner.className = 'banner banner--warn';
        banner.append(
          icon('alert'),
          el(
            'span',
            undefined,
            `Partial result — ${ok} of ${view.result.results.length} files were processed and ${failures.length} failed. The failures are listed below; everything else finished normally.`,
          ),
        );
      } else {
        summary.textContent = `${view.toolName}: ${outputs.length} ${outputs.length === 1 ? 'file' : 'files'} ready.`;
      }

      if (outputs.length > 1) {
        const all = el('button', 'btn btn--primary btn--sm');
        all.type = 'button';
        all.append(icon('download'), el('span', undefined, `Download all (${outputs.length})`));
        all.addEventListener('click', () => {
          const note = el('span', 'results__note', 'Building the archive…');
          actions.append(note);
          void saveAll(outputs, `omnitool-${view.toolName.toLowerCase().replace(/\s+/g, '-')}`)
            .then(() => note.remove())
            .catch((error: unknown) => {
              note.className = 'results__note results__note--error';
              note.textContent =
                error instanceof Error
                  ? `The archive could not be built: ${error.message}`
                  : 'The archive could not be built.';
            });
        });
        actions.append(all);
      }

      // ---- cards ------------------------------------------------------
      const cards: HTMLElement[] = [];
      for (const output of outputs) cards.push(outputCard(output, view.inputs));
      for (const failure of failures) {
        cards.push(failureCard(failure.name, failure.code, failure.message));
      }
      if (view.error) {
        cards.push(
          failureCard(view.error.file ?? view.toolName, view.error.code, view.error.message),
        );
      }
      if (cards.length === 0) {
        cards.push(
          el('p', 'results__empty', 'The run finished but produced no output files.'),
        );
      }

      grid.append(...cards);
      await flyToResults(cards);
    },
  };
}
