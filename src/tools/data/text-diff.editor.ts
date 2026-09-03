// src/tools/data/text-diff.editor.ts — the bespoke options editor for text-diff.
//
// Implements ToolEditor from src/types.ts exactly:
//   (mount, inputs, onChange) => teardown
// and emits { format, scope, context, ignoreWhitespace, ignoreCase, swap } —
// the same option names text-diff.op.ts validates, so the declarative schema in
// registry.data.ts stays a working fallback.
//
// WHY THIS TOOL NEEDS AN EDITOR RATHER THAN A SCHEMA
//
// Every other tool in the app answers "what should I do to these files?" — you
// pick, you run, you download. Comparing two files is the one job where the
// ANSWER IS THE LOOKING. Exporting a report you have not seen tells you
// nothing about whether the two files differ in a way you care about, and a
// tool whose whole purpose is "show me what changed" cannot make you download
// a file to find out. So the comparison runs here, live, and Run exists only to
// keep a copy of what is already on screen.
//
// WHAT THE VIEW DOES THAT A NAIVE LINE DIFF DOES NOT
//
//   - Pairs a rewritten line with the line it replaced and highlights only the
//     TOKENS that moved inside it. Finding a changed argument in a 120-character
//     line is the actual problem; "this line changed" is not an answer.
//   - Folds unchanged regions away, expandable in place, so a three-line change
//     in a 2,000-line file is three lines on screen.
//   - Says so when two files differ ONLY in their line endings, instead of
//     painting every line red the way a byte comparison would.
//   - Marks every changed row with a sign (+, -, ~) as well as a colour, so
//     nothing here depends on being able to tell green from red.
//
// This runs on the MAIN THREAD, which is a deliberate trade: the diff has to be
// synchronous to be interactive, and an editor cannot reach into core/'s worker
// pool (the import rules in CONTRIBUTING.md §1 exist precisely to keep tools
// inert). Both guards below — LIVE_LIMIT and MAX_ROWS — exist so that trade can
// never cost a frozen tab, and both say what they did rather than degrading
// quietly.

import type { ToolEditor } from '../../types';

import './text-diff.editor.css';
import {
  collapseRows,
  diffLines,
  diffWords,
  toRows,
  type DiffResult,
  type DiffRow,
  type GapRow,
} from './diff';

/** Combined characters above which the live view steps aside and says so. */
const LIVE_LIMIT = 3_000_000;

/** Rendered rows above which the view stops and says how many it is showing. */
const MAX_ROWS = 4000;

type View = 'split' | 'unified';
type Scope = '3' | '10' | 'whole';

const CONTEXT: Record<Scope, number> = { '3': 3, '10': 10, whole: Number.POSITIVE_INFINITY };

const editor: ToolEditor = (mount, inputs, onChange) => {
  const doc = mount.ownerDocument;
  let disposed = false;

  // ---- state ---------------------------------------------------------------
  let texts: { a: string; b: string } | null = null;
  let failure: string | null = null;
  let result: DiffResult | null = null;
  // Unified by default: the work zone is a ~22rem column, and a side-by-side
  // view only earns its keep once there is room for two readable columns.
  let view: View = 'unified';
  let scope: Scope = '3';
  let ignoreWhitespace = false;
  let ignoreCase = false;
  let swapped = false;
  let format: 'html' | 'unified' = 'html';
  /** Gaps the reader has opened, keyed by the A-line they start at. */
  const expanded = new Set<number>();
  /** First row element of each run of change, in document order. */
  let hunkAnchors: HTMLElement[] = [];
  let currentHunk = -1;

  const names = (): { a: string; b: string } => {
    const first = inputs[0]?.name ?? 'first file';
    const second = inputs[1]?.name ?? 'second file';
    return swapped ? { a: second, b: first } : { a: first, b: second };
  };

  // ---- shell ---------------------------------------------------------------
  mount.replaceChildren();

  const root = doc.createElement('div');
  root.className = 'tdiff';

  const make = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
  ): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const head = make('div', 'tdiff__head');
  const title = make('p', 'tdiff__files');
  const stats = make('ul', 'tdiff__stats');
  head.append(title, stats);

  // ---- controls ------------------------------------------------------------
  const controls = make('div', 'tdiff__controls');

  function segmented(
    label: string,
    choices: readonly { value: string; label: string }[],
    initial: string,
    onPick: (value: string) => void,
  ): HTMLElement {
    const group = make('div', 'tdiff__seg');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', label);
    const buttons = new Map<string, HTMLButtonElement>();
    for (const choice of choices) {
      const button = make('button', 'tdiff__segbtn', choice.label);
      button.type = 'button';
      button.setAttribute('aria-pressed', String(choice.value === initial));
      button.addEventListener('click', () => {
        for (const [value, node] of buttons) node.setAttribute('aria-pressed', String(value === choice.value));
        onPick(choice.value);
      });
      buttons.set(choice.value, button);
      group.append(button);
    }
    return group;
  }

  function checkbox(label: string, onToggle: (on: boolean) => void): HTMLElement {
    const wrap = make('label', 'tdiff__check');
    const box = make('input');
    box.type = 'checkbox';
    box.addEventListener('change', () => onToggle(box.checked));
    wrap.append(box, make('span', undefined, label));
    return wrap;
  }

  controls.append(
    segmented(
      'Layout',
      [
        { value: 'unified', label: 'Unified' },
        { value: 'split', label: 'Side by side' },
      ],
      view,
      (value) => {
        view = value as View;
        render();
      },
    ),
    segmented(
      'How much to show',
      [
        { value: '3', label: '3 lines' },
        { value: '10', label: '10 lines' },
        { value: 'whole', label: 'Whole file' },
      ],
      scope,
      (value) => {
        scope = value as Scope;
        emit();
        render();
      },
    ),
    checkbox('Ignore whitespace', (on) => {
      ignoreWhitespace = on;
      emit();
      recompute();
    }),
    checkbox('Ignore case', (on) => {
      ignoreCase = on;
      emit();
      recompute();
    }),
  );

  const swap = make('button', 'tdiff__btn', 'Swap sides');
  swap.type = 'button';
  swap.addEventListener('click', () => {
    swapped = !swapped;
    expanded.clear();
    emit();
    recompute();
  });
  controls.append(swap);

  // ---- change navigation ---------------------------------------------------
  const nav = make('div', 'tdiff__nav');
  const prev = make('button', 'tdiff__btn tdiff__btn--icon', '↑');
  prev.type = 'button';
  prev.title = 'Previous change';
  prev.setAttribute('aria-label', 'Previous change');
  const next = make('button', 'tdiff__btn tdiff__btn--icon', '↓');
  next.type = 'button';
  next.title = 'Next change';
  next.setAttribute('aria-label', 'Next change');
  const position = make('span', 'tdiff__pos');
  const status = make('p', 'tdiff__sr');
  status.setAttribute('role', 'status');
  nav.append(prev, next, position, status);
  prev.addEventListener('click', () => step(-1));
  next.addEventListener('click', () => step(1));

  const notices = make('div', 'tdiff__notices');
  const viewport = make('div', 'tdiff__view');
  viewport.tabIndex = 0;
  viewport.setAttribute('role', 'group');
  viewport.setAttribute('aria-label', 'The comparison');

  // ---- export --------------------------------------------------------------
  const exportRow = make('div', 'tdiff__export');
  const exportId = `tdiff-format-${Math.random().toString(36).slice(2, 8)}`;
  const exportLabel = make('label', undefined, 'Run downloads');
  exportLabel.htmlFor = exportId;
  const exportSelect = make('select', 'tdiff__select');
  exportSelect.id = exportId;
  for (const option of [
    { value: 'html', label: 'this comparison as an HTML report' },
    { value: 'unified', label: 'a .diff patch file' },
  ]) {
    const node = make('option', undefined, option.label);
    node.value = option.value;
    exportSelect.append(node);
  }
  exportSelect.addEventListener('change', () => {
    format = exportSelect.value === 'unified' ? 'unified' : 'html';
    emit();
  });
  exportRow.append(exportLabel, exportSelect);

  root.append(head, controls, nav, notices, viewport, exportRow);
  mount.append(root);

  // ---- options -------------------------------------------------------------
  function emit(): void {
    onChange({
      format,
      scope: scope === 'whole' ? 'whole' : 'changes',
      context: CONTEXT[scope] === Number.POSITIVE_INFINITY ? 3 : CONTEXT[scope],
      ignoreWhitespace,
      ignoreCase,
      swap: swapped,
    });
  }
  emit();

  // ---- reading -------------------------------------------------------------
  function noticeOf(text: string, tone: 'info' | 'warn' = 'info'): HTMLElement {
    const node = make('p', `tdiff__notice tdiff__notice--${tone}`, text);
    return node;
  }

  async function read(): Promise<void> {
    const [first, second] = inputs;
    if (!first || !second) {
      failure = 'Drop two text or source files to compare them.';
      render();
      return;
    }
    try {
      const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
      const buffers = await Promise.all([first.arrayBuffer(), second.arrayBuffer()]);
      if (disposed) return;
      texts = { a: decoder.decode(buffers[0]), b: decoder.decode(buffers[1]) };
    } catch {
      if (disposed) return;
      failure = 'One of these files is not valid UTF-8 text, so there is nothing to compare.';
      render();
      return;
    }
    recompute();
  }

  function recompute(): void {
    if (disposed || !texts) return;
    const left = swapped ? texts.b : texts.a;
    const right = swapped ? texts.a : texts.b;

    if (left.length + right.length > LIVE_LIMIT) {
      result = null;
      failure = null;
      render();
      return;
    }
    result = diffLines(left, right, { ignoreWhitespace, ignoreCase });
    currentHunk = -1;
    render();
  }

  // ---- rendering -----------------------------------------------------------
  function chip(text: string, tone?: string): HTMLElement {
    const node = make('li', tone ? `tdiff__chip tdiff__chip--${tone}` : 'tdiff__chip', text);
    return node;
  }

  function codeCell(
    className: string,
    text: string | null,
    marks: readonly { text: string; changed: boolean }[] | null,
  ): HTMLElement {
    const cell = make('div', className);
    if (text === null) return cell;
    if (!marks) {
      cell.textContent = text;
      return cell;
    }
    for (const segment of marks) {
      if (!segment.changed) {
        cell.append(doc.createTextNode(segment.text));
        continue;
      }
      cell.append(make('mark', 'tdiff__mark', segment.text));
    }
    return cell;
  }

  function gutter(number: number | null, sign: string): HTMLElement {
    const cell = make('div', 'tdiff__gutter');
    cell.append(make('span', 'tdiff__num', number === null ? '' : String(number + 1)));
    cell.append(make('span', 'tdiff__sign', sign));
    return cell;
  }

  /** No sign, as a non-breaking space: an empty cell would let the gutter
   *  collapse and the numbers would stop lining up column to column. */
  const BLANK = '\u00a0';

  /** Side-by-side signs. A rewritten line is `~` on BOTH sides, because there
   *  it really is one row showing one change — unified splits it in two and
   *  signs the halves `-` and `+` instead (see `render`). */
  const SIGN: Record<DiffRow['kind'], { a: string; b: string }> = {
    equal: { a: BLANK, b: BLANK },
    delete: { a: '−', b: BLANK },
    insert: { a: BLANK, b: '+' },
    replace: { a: '~', b: '~' },
  };

  function gapRow(gap: GapRow): HTMLElement {
    const row = make('div', 'tdiff__row tdiff__row--gap');
    const button = make(
      'button',
      'tdiff__expand',
      `Show ${gap.count} unchanged line${gap.count === 1 ? '' : 's'}`,
    );
    button.type = 'button';
    button.addEventListener('click', () => {
      expanded.add(gap.a);
      render();
    });
    row.append(button);
    return row;
  }

  function render(): void {
    if (disposed) return;

    title.textContent = `${names().a} → ${names().b}`;
    stats.replaceChildren();
    notices.replaceChildren();
    viewport.replaceChildren();
    hunkAnchors = [];

    if (failure) {
      notices.append(noticeOf(failure, 'warn'));
      updateNav();
      return;
    }
    if (!texts) {
      notices.append(noticeOf('Reading the files…'));
      updateNav();
      return;
    }
    if (!result) {
      notices.append(
        noticeOf(
          'These files are too large to compare on screen without blocking the page. Run the tool to build the full report instead.',
          'warn',
        ),
      );
      updateNav();
      return;
    }

    const { stats: counts } = result;
    stats.append(
      chip(`${counts.added} added`, 'add'),
      chip(`${counts.removed} removed`, 'del'),
      chip(`${counts.changed} changed`, 'rep'),
      chip(`${Math.round(counts.similarity * 100)}% unchanged`),
    );

    if (result.identicalLines && result.onlyEndingsDiffer) {
      notices.append(
        noticeOf(
          'Every line is identical — these files differ only in their line endings or byte-order mark.',
        ),
      );
    } else if (result.identicalLines) {
      notices.append(noticeOf('No differences: these two files have identical contents.'));
    }
    if (result.degraded) {
      notices.append(
        noticeOf(
          'These files share too little structure to align line by line, so one region is shown as a wholesale replacement.',
          'warn',
        ),
      );
    }

    // Fold, then re-open any gap the reader has expanded.
    const all = toRows(result.blocks);
    const folded = collapseRows(all, CONTEXT[scope]).flatMap((row) =>
      row.kind === 'gap' && expanded.has(row.a) ? all.slice(row.at, row.at + row.count) : [row],
    );

    const table = make('div', `tdiff__grid tdiff__grid--${view}`);
    const shown = Math.min(folded.length, MAX_ROWS);
    let previousWasChange = false;

    for (let i = 0; i < shown; i++) {
      const row = folded[i] as DiffRow | GapRow;
      if (row.kind === 'gap') {
        table.append(gapRow(row));
        previousWasChange = false;
        continue;
      }

      const aText = row.a === null ? null : (result.a.lines[row.a] ?? '');
      const bText = row.b === null ? null : (result.b.lines[row.b] ?? '');
      const words =
        row.kind === 'replace' && aText !== null && bText !== null
          ? diffWords(aText, bText, { ignoreWhitespace, ignoreCase })
          : null;

      const node = make('div', `tdiff__row tdiff__row--${row.kind}`);
      if (view === 'split') {
        node.append(
          gutter(row.a, SIGN[row.kind].a),
          codeCell('tdiff__code tdiff__code--a', aText, words?.a ?? null),
          gutter(row.b, SIGN[row.kind].b),
          codeCell('tdiff__code tdiff__code--b', bText, words?.b ?? null),
        );
      } else {
        // Unified puts a rewritten line on two rows, which is what the format
        // IS: a removal followed by an addition. So the sign here is - or +,
        // never the ~ that only means something when both halves share a row.
        //
        // The sign sits in the SECOND gutter, against the code, so it is in
        // the same place on every row whatever the row is — and each row's
        // number is blank on the side that line does not exist on, exactly
        // where `git diff` leaves a blank too.
        const removal = row.kind === 'delete' || row.kind === 'replace';
        node.append(
          gutter(row.a, BLANK),
          gutter(removal ? null : row.b, row.kind === 'equal' ? BLANK : removal ? '−' : '+'),
          codeCell('tdiff__code', row.kind === 'insert' ? bText : aText, words?.a ?? null),
        );
        if (row.kind === 'replace') {
          if (!previousWasChange) {
            hunkAnchors.push(node);
            previousWasChange = true;
          }
          table.append(node);
          const added = make('div', 'tdiff__row tdiff__row--insert');
          added.append(
            gutter(null, BLANK),
            gutter(row.b, '+'),
            codeCell('tdiff__code', bText, words?.b ?? null),
          );
          table.append(added);
          continue;
        }
      }

      if (row.kind === 'equal') {
        previousWasChange = false;
      } else {
        if (!previousWasChange) hunkAnchors.push(node);
        previousWasChange = true;
      }
      table.append(node);
    }

    viewport.append(table);

    // Re-mark where the reader had got to. Opening a gap, switching layout or
    // changing how much context is shown all rebuild these rows, but none of
    // them adds or removes a CHANGE — so the position through the changes
    // survives, and only the highlight has to be put back.
    const current = hunkAnchors[currentHunk];
    if (current) current.classList.add('is-current');

    if (folded.length > shown) {
      notices.append(
        noticeOf(
          `Showing the first ${shown.toLocaleString()} of ${folded.length.toLocaleString()} lines. Run the tool for the whole comparison.`,
          'warn',
        ),
      );
    }

    updateNav();
  }

  function updateNav(): void {
    const total = hunkAnchors.length;
    prev.disabled = total === 0;
    next.disabled = total === 0;
    position.textContent =
      total === 0 ? 'No changes' : currentHunk < 0 ? `${total} change${total === 1 ? '' : 's'}` : `Change ${currentHunk + 1} of ${total}`;
  }

  function step(direction: 1 | -1): void {
    if (hunkAnchors.length === 0) return;
    currentHunk =
      currentHunk < 0
        ? direction > 0
          ? 0
          : hunkAnchors.length - 1
        : (currentHunk + direction + hunkAnchors.length) % hunkAnchors.length;

    for (const anchor of hunkAnchors) anchor.classList.remove('is-current');
    const target = hunkAnchors[currentHunk] as HTMLElement;
    target.classList.add('is-current');
    // `nearest` keeps the page still: only the viewport scrolls, never the
    // document under it.
    target.scrollIntoView({ block: 'center', inline: 'nearest' });
    updateNav();
    status.textContent = position.textContent ?? '';
  }

  void read();

  return () => {
    disposed = true;
    mount.replaceChildren();
  };
};

export default editor;
