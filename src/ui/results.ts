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

/** `type` is the magic-byte sniffed mime, needed by comparable() below. */
export type ResultInput = { name: string; size: number; type: string };

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
  // Covers BOTH halves of this code: a file that lies about its type, and a
  // valid file whose particular variant a tool cannot handle (a scanned PDF
  // has no text layer to extract, yet is a perfectly well-formed PDF). The
  // earlier wording only described the first half, so it told people to
  // re-export a file that was never malformed — contradicting the specific
  // reason printed directly above it.
  UnsupportedFormat:
    'Either the file is not the format its contents claim, or this tool cannot handle this particular variant of it. The reason above says which.',
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

/**
 * How many outputs came from the same source input.
 *
 * A size delta only means something ONE-TO-ONE. When a single PDF becomes 40
 * PNGs, comparing each PNG against the whole PDF is a category error: every
 * card ends up reading "357 kB → 2.5 MB, 603% LARGER", which is both alarming
 * and arithmetically meaningless, since the 357 kB was never that page's
 * "before". So count the fan-out first and suppress the delta when it is > 1.
 */
/**
 * Total bytes produced. Shown on the summary line so the tools whose per-card
 * delta is now (correctly) suppressed still report a real number — for zipping
 * or rasterising, "how much did this make?" is the useful question.
 */
function totalBytes(outputs: OpOutput[]): number {
  return outputs.reduce((sum, output) => sum + output.buffer.byteLength, 0);
}

function fanOut(outputs: OpOutput[], inputs: ResultInput[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const output of outputs) {
    const source = sourceOf(output, inputs);
    if (!source) continue;
    counts.set(source.name, (counts.get(source.name) ?? 0) + 1);
  }
  return counts;
}

/**
 * Is comparing these two sizes meaningful at all?
 *
 * Only when the output is the same KIND of thing as the input. Shrinking a PDF
 * or re-encoding an image to another image is a size story — that is the whole
 * point of those tools. Extracting a PDF's text layer is not: "100% smaller ·
 * 1.3 MB → 4 kB" invites you to read a category error as a compression win.
 * The tool did not shrink anything; it produced a different kind of artefact.
 */
function comparable(output: OpOutput, source: ResultInput): boolean {
  if (output.type === source.type) return true;
  return output.type.startsWith('image/') && source.type.startsWith('image/');
}

function deltaChip(
  output: OpOutput,
  source: ResultInput | undefined,
  siblings: number,
): HTMLElement | null {
  // One input, many outputs — see fanOut(). Fall through to a plain size.
  if (!source || source.size === 0 || siblings > 1) return null;
  if (!comparable(output, source)) return null;
  const after = output.buffer.byteLength;
  const ratio = after / source.size;
  const change = Math.round(Math.abs(1 - ratio) * 100);

  if (change === 0) {
    return el('span', 'chip chip--flat', `same size · ${formatBytes(source.size)}`);
  }
  const smaller = after < source.size;
  // "larger" not "LARGER": growth is the expected, correct outcome for plenty
  // of conversions (PNG from JPEG, rasterising vectors). It is information,
  // not a warning, and shouting it makes a good result look like a failure.
  return el(
    'span',
    smaller ? 'chip chip--good' : 'chip chip--up',
    `${change}% ${smaller ? 'smaller' : 'larger'} · ${formatBytes(source.size)} → ${formatBytes(after)}`,
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

function outputCard(
  output: OpOutput,
  inputs: ResultInput[],
  siblings: number,
  urls: string[],
): HTMLElement {
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
  const chip = deltaChip(output, sourceOf(output, inputs), siblings);
  if (chip) meta.append(chip);
  else meta.append(el('span', 'chip chip--flat', formatBytes(output.buffer.byteLength)));

  card.append(head, meta);

  // A tool whose entire output is an image should SHOW the image. Otherwise
  // the only way to find out whether a render came out right is to download
  // it and open it in something else. SVG is excluded on purpose: it lands in
  // the textual branch below, where its source is more useful than a preview.
  if (output.type.startsWith('image/') && output.type !== 'image/svg+xml') {
    const url = URL.createObjectURL(new Blob([output.buffer], { type: output.type }));
    // Caller owns revocation — held until the tray is cleared or replaced, so
    // the URL stays valid for as long as the card is on screen.
    urls.push(url);

    const figure = el('div', 'card__thumb');
    const img = el('img');
    img.src = url;
    img.alt = `Preview of ${output.name}`;
    img.loading = 'lazy';
    img.decoding = 'async';
    figure.append(img);
    card.append(figure);
  }

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
  const glyph = el('span', 'results__glyph');
  glyph.append(icon('check'));
  const titles = el('div', 'results__titles');
  const heading = el('h2', 'panel__title', 'Results');
  heading.id = 'results-heading';
  const summary = el('p', 'results__summary');
  titles.append(heading, summary);
  const actions = el('div', 'results__actions');
  head.append(glyph, titles, actions);

  const banner = el('div', 'banner');
  banner.hidden = true;

  const grid = el('div', 'results__grid');
  root.append(head, banner, grid);

  /** Object URLs backing image previews, revoked whenever the tray is reset. */
  let previewUrls: string[] = [];

  function revokePreviews(): void {
    for (const url of previewUrls) URL.revokeObjectURL(url);
    previewUrls = [];
  }

  return {
    el: root,

    clear(): void {
      root.hidden = true;
      banner.hidden = true;
      revokePreviews();
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
      // The glyph says the same thing as the words. A green tick over a run
      // that failed would be a lie told in a colour, which is worse than one
      // told in a sentence because nobody reads it consciously.
      root.dataset.state = view.error ? 'error' : view.result?.partial ? 'partial' : 'ok';
      glyph.replaceChildren(icon(view.error || view.result?.partial ? 'alert' : 'check'));

      if (view.error) {
        summary.textContent = `${view.toolName} could not finish.`;
      } else if (view.result?.partial) {
        const ok = view.result.results.length - failures.length;
        summary.textContent = `${view.toolName}: ${outputs.length} ${outputs.length === 1 ? 'file' : 'files'} ready · ${formatBytes(totalBytes(outputs))}.`;
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
        summary.textContent = `${view.toolName}: ${outputs.length} ${outputs.length === 1 ? 'file' : 'files'} ready · ${formatBytes(totalBytes(outputs))}.`;
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
      // A previous run's previews are dead the moment we rebuild the grid.
      revokePreviews();
      const siblings = fanOut(outputs, view.inputs);

      const cards: HTMLElement[] = [];
      for (const output of outputs) {
        const source = sourceOf(output, view.inputs);
        const count = source ? (siblings.get(source.name) ?? 1) : 1;
        cards.push(outputCard(output, view.inputs, count, previewUrls));
      }
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
