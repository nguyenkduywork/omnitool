// Source-owning, in-memory Text Diff workspace. Heavy comparison stays in its worker.
import { OpError, type PreparedToolRun, type SniffedFile, type ToolWorkspace, type WorkspaceJobState } from '../../types';
import { TextDiffLive, TextDiffLiveError } from './text-diff.live';
import { safePatchTarget } from './text-diff.export';
import { MAX_COMPARISON_BYTES, type ReadySource, type ComparisonRules } from './text-diff.model';
import type {
  DiffContext, DiffDetail, FindResponse, GapExpansion, LiveSource,
  ReadyResponse, WindowCursor, WindowFragment, WindowGap, WindowResponse, WindowRow,
} from './text-diff.protocol';
import './text-diff.workspace.css';

type SideIndex = 0 | 1;
type Mode = 'inputs' | 'review';
type Layout = 'auto' | 'split' | 'unified';
type UndoSource = { source: ReadySource | null; text: string; candidate: LiveSource | null; provenance: SniffedFile | null; deferred: boolean; preview: string; lineEndingWarning: boolean };
type Side = {
  source: ReadySource | null;
  provenance: SniffedFile | null;
  deferred: boolean;
  preview: string;
  lineEndingWarning: boolean;
  undo: UndoSource | undefined;
  pending: boolean;
  intent: number;
  error: string;
  candidate: LiveSource | null;
};

const LABEL = ['Original', 'Revised'] as const;
const START: WindowCursor = { row: 0, aOffset: 0, bOffset: 0 };
const AUTO_TEXT = 250_000;
const AUTO_FILE = 1024 * 1024;
const AUTO_DELAY = 150;
const DEFER_UNITS = 250_000;
const DEFER_ENDINGS = 5_000;
const PREVIEW_UNITS = 1_024;
const PREVIEW_LINES = 8;
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|xml|html?|log|diff|patch|rst|tex|[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|h|cc|cpp|hpp|cs|php|sh|bash|zsh|ps1|sql|ya?ml|toml|ini|cfg|conf|lua|pl|scala|dart|vue|svelte|tf|gradle|graphql|proto|s?css|less)$/i;

function make<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, content?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

function button(label: string, className = 'tdw__button'): HTMLButtonElement {
  const node = make('button', className, label);
  node.type = 'button';
  return node;
}

function candidate(file: File): boolean {
  return file.type.startsWith('text/') || file.type === 'application/json' ||
    file.type === 'application/xml' || TEXT_EXT.test(file.name);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function deferFileEditor(text: string): boolean {
  if (text.length > DEFER_UNITS) return true;
  let endings = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 13) {
      if (++endings > DEFER_ENDINGS) return true;
      if (text.charCodeAt(index + 1) === 10) index++;
    } else if (code === 10 && ++endings > DEFER_ENDINGS) return true;
  }
  return false;
}

function previewOf(text: string): string {
  let limit = Math.min(PREVIEW_UNITS, text.length);
  let lines = 0;
  for (let index = 0; index < limit; index++) {
    const code = text.charCodeAt(index);
    if (code === 13 || code === 10) {
      if (code === 13 && text.charCodeAt(index + 1) === 10) index++;
      if (++lines >= PREVIEW_LINES) { limit = index + 1; break; }
    }
  }
  const Segmenter = (Intl as typeof Intl & { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (Segmenter && limit < text.length) {
    let boundary = 0;
    const prefix = text.slice(0, Math.min(text.length, limit + 64));
    for (const part of new Segmenter(undefined, { granularity: 'grapheme' }).segment(prefix)) {
      const end = part.index + part.segment.length;
      if (end > limit) break;
      boundary = end;
    }
    limit = boundary;
  }
  if (limit > 0 && limit < text.length && /[\uD800-\uDBFF]/u.test(text.charAt(limit - 1)) && /[\uDC00-\uDFFF]/u.test(text.charAt(limit))) limit--;
  return `${text.slice(0, limit)}${limit < text.length ? '\n… preview ends here' : ''}`;
}

const workspace: ToolWorkspace = (mount, host) => {
  const live = new TextDiffLive();
  const side: [Side, Side] = [0, 1].map(() => ({
    source: null, provenance: null, deferred: false, preview: '', lineEndingWarning: false, undo: undefined, pending: false, intent: 0, error: '', candidate: null,
  })) as [Side, Side];
  let active = false;
  let destroyed = false;
  let initialized = false;
  let mode: Mode = 'inputs';
  let phoneSide: SideIndex = 0;
  let narrowInputs = false;
  let layout: Layout = 'auto';
  let wrap = true;
  let detail: DiffDetail = 'word';
  let context: DiffContext = 3;
  let showWhitespace = false;
  let rules: ComparisonRules = { ignoreWhitespace: false, ignoreCase: false };
  let composing = false;
  let compareRevision = 0;
  let sourceRevision = 0;
  let comparing = false;
  let stale = false;
  let ready: ReadyResponse | null = null;
  let view: WindowResponse | null = null;
  let currentCursor: WindowCursor = START;
  let history: WindowCursor[] = [];
  let activeHunk = -1;
  let expansions: GapExpansion[] = [];
  let search: FindResponse | null = null;
  let findIntent = 0;
  let searchQuery = '';
  let searchMatchCase = true;
  let jobState: WorkspaceJobState = { phase: 'idle' };
  let timer: ReturnType<typeof setTimeout> | null = null;
  const textTimers: [ReturnType<typeof setTimeout> | null, ReturnType<typeof setTimeout> | null] = [null, null];
  let fallbackText = '';
  let pendingDrop: File | null = null;

  mount.replaceChildren();
  const root = make('article', 'tdw');
  root.dataset.ready = 'true';
  root.tabIndex = -1;
  root.setAttribute('aria-label', 'Compare text workspace');
  const header = make('header', 'tdw__header');
  const back = make('a', 'tdw__back', '← Back to tools');
  back.href = '#/';
  const title = make('h1', 'tdw__title', 'Compare text');
  const intro = make('p', 'tdw__intro', 'Compare two sources locally. Your text stays in this tab.');
  header.append(back, title, intro);
  const modes = make('nav', 'tdw__modes');
  modes.setAttribute('aria-label', 'Workspace mode');
  const inputsMode = button('Inputs', 'tdw__mode');
  const reviewMode = button('Review changes', 'tdw__mode');
  modes.append(inputsMode, reviewMode);

  const inputSection = make('section', 'tdw__inputs');
  inputSection.setAttribute('aria-label', 'Comparison sources');
  const sourceTabs = make('div', 'tdw__tabs');
  sourceTabs.setAttribute('role', 'tablist');
  sourceTabs.setAttribute('aria-label', 'Choose a source');
  sourceTabs.addEventListener('keydown', (event) => {
    if (!tabButtons.includes(event.target as HTMLButtonElement)) return;
    let target: SideIndex | null = null;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') target = (phoneSide === 0 ? 1 : 0);
    if (event.key === 'Home') target = 0;
    if (event.key === 'End') target = 1;
    if (target === null) return;
    event.preventDefault();
    phoneSide = target;
    renderSources();
    tabButtons[target].focus();
  });
  const tabButtons = [0, 1].map((index) => button(LABEL[index]!, 'tdw__tab')) as [HTMLButtonElement, HTMLButtonElement];
  const sourcePanels = [0, 1].map(() => make('section', 'tdw__source')) as [HTMLElement, HTMLElement];
  const textareas = [0, 1].map(() => make('textarea', 'tdw__textarea')) as [HTMLTextAreaElement, HTMLTextAreaElement];
  const sourceLabels = [0, 1].map(() => make('label', 'tdw__label')) as [HTMLLabelElement, HTMLLabelElement];
  const deferredPanels: [HTMLElement, HTMLElement] = [make('div', 'tdw__deferred'), make('div', 'tdw__deferred')];
  const previewNodes: [HTMLElement, HTMLElement] = [make('pre', 'tdw__source-preview'), make('pre', 'tdw__source-preview')];
  const loadFullButtons = [0, 1].map(() => button('Load full text for editing')) as [HTMLButtonElement, HTMLButtonElement];
  const sourceStatus: [HTMLElement, HTMLElement] = [make('p', 'tdw__source-status'), make('p', 'tdw__source-status')];
  const lineEndingWarnings: [HTMLElement, HTMLElement] = [make('p', 'tdw__source-warning'), make('p', 'tdw__source-warning')];
  const undoButtons = [0, 1].map(() => button('Undo', 'tdw__button')) as [HTMLButtonElement, HTMLButtonElement];
  const clearButtons = [0, 1].map(() => button('Clear', 'tdw__button')) as [HTMLButtonElement, HTMLButtonElement];
  const emptyButtons = [0, 1].map(() => button('Use empty text', 'tdw__button')) as [HTMLButtonElement, HTMLButtonElement];
  const fileInputs = [0, 1].map(() => make('input')) as [HTMLInputElement, HTMLInputElement];
  const fileButtons = [0, 1].map(() => button('Open file', 'tdw__button')) as [HTMLButtonElement, HTMLButtonElement];
  const copySourceButtons = [0, 1].map(() => button('Copy source', 'tdw__button')) as [HTMLButtonElement, HTMLButtonElement];
  for (const index of [0, 1] as const) {
    const tab = tabButtons[index];
    const panel = sourcePanels[index];
    const box = textareas[index];
    tab.id = `tdw-tab-${index}`;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', `tdw-panel-${index}`);
    tab.addEventListener('click', () => { phoneSide = index; renderSources(); focusSource(index); });
    sourceTabs.append(tab);
    panel.id = `tdw-panel-${index}`;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', tab.id);
    panel.addEventListener('dragover', (event) => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
    });
    panel.addEventListener('drop', (event) => {
      if (!event.dataTransfer?.types.includes('Files')) return;
      event.preventDefault();
      event.stopPropagation();
      const files = [...event.dataTransfer.files];
      if (files.length === 1) void acceptFile(index, files[0]!);
      else showSourceError(index, 'Choose one file for this side.');
    });
    const heading = make('h2', 'tdw__source-title', LABEL[index]);
    const label = sourceLabels[index];
    label.textContent = `${LABEL[index]} text`;
    box.id = `tdw-text-${index}`;
    label.htmlFor = box.id;
    box.rows = 8;
    box.spellcheck = false;
    box.placeholder = `Paste or type ${LABEL[index].toLowerCase()} text`;
    box.addEventListener('compositionstart', () => beginComposition(index));
    box.addEventListener('compositionend', () => { composing = false; onTextInput(index); });
    box.addEventListener('input', () => { if (!composing) onTextInput(index); });
    box.addEventListener('paste', (event) => {
      if (event.clipboardData?.files.length) event.stopPropagation();
    });
    const deferredPanel = deferredPanels[index];
    deferredPanel.append(
      make('p', undefined, 'Preview only. Comparison, copy, and export use the complete file.'),
      previewNodes[index], loadFullButtons[index],
      make('p', 'tdw__source-warning', 'Loading the full text into the editor may pause this browser.'),
    );
    loadFullButtons[index].addEventListener('click', () => {
      const item = side[index];
      if (!item.deferred || !item.source || busyExport()) return;
      // This is an explicit native-editor load, not a source edit. Its raw
      // ReadySource remains authoritative until the first actual input event.
      box.value = item.source.text;
      item.deferred = false;
      renderSources();
      box.focus();
    });
    const actions = make('div', 'tdw__source-actions');
    const picker = fileInputs[index];
    picker.type = 'file';
    picker.hidden = true;
    picker.tabIndex = -1;
    picker.addEventListener('change', () => {
      const file = picker.files?.[0];
      picker.value = '';
      if (file) void acceptFile(index, file);
    });
    fileButtons[index].addEventListener('click', () => picker.click());
    emptyButtons[index].addEventListener('click', () => void replaceWithText(index, '', 'empty'));
    clearButtons[index].addEventListener('click', () => clearSource(index));
    undoButtons[index].addEventListener('click', () => undoSource(index));
    copySourceButtons[index].addEventListener('click', () => void copyAcceptedSource(index));
    actions.append(fileButtons[index], emptyButtons[index], clearButtons[index], undoButtons[index], copySourceButtons[index]);
    lineEndingWarnings[index].textContent = 'Editing converts this file’s CRLF or CR line endings to LF. Until you edit, comparison and export use the original text.';
    lineEndingWarnings[index].hidden = true;
    panel.append(heading, sourceStatus[index], lineEndingWarnings[index], label, box, deferredPanel, actions, picker);
    inputSection.append(panel);
  }
  inputSection.prepend(sourceTabs);
  const inputFooter = make('div', 'tdw__input-footer');
  const swap = button('Swap Original and Revised');
  const startOver = button('Start over');
  const compareNow = button('Compare now', 'tdw__button tdw__button--primary');
  const inputMessage = make('p', 'tdw__message', 'Provide Original and Revised. Paste text, open a file, or choose empty text.');
  inputMessage.setAttribute('role', 'status');
  swap.addEventListener('click', swapSources);
  startOver.addEventListener('click', resetSources);
  compareNow.addEventListener('click', () => void compareAccepted(true));
  const cancelCompare = button('Cancel comparison');
  cancelCompare.addEventListener('click', () => {
    if (!comparing) return;
    compareRevision++;
    comparing = false;
    stale = true;
    live.cancel();
    inputMessage.textContent = 'Comparison cancelled. Choose Compare now to retry.';
    renderStatus();
  });
  inputFooter.append(swap, startOver, compareNow, cancelCompare);
  inputSection.append(inputFooter, inputMessage);

  const reviewSection = make('section', 'tdw__review');
  reviewSection.setAttribute('aria-label', 'Review changes');
  const reviewHead = make('div', 'tdw__review-head');
  const identities = make('p', 'tdw__identities');
  const editInputs = button('Edit inputs');
  editInputs.addEventListener('click', () => showMode('inputs', true));
  reviewHead.append(identities, editInputs);
  const stats = make('div', 'tdw__stats');
  const notice = make('div', 'tdw__notices');
  notice.setAttribute('role', 'status');
  const toolbar = make('div', 'tdw__toolbar');
  const layoutLabel = make('label', 'tdw__toolbar-label', 'Layout');
  const layoutSelect = make('select', 'tdw__select');
  for (const [value, label] of [['auto', 'Auto'], ['split', 'Side by side'], ['unified', 'Unified']] as const) {
    const option = make('option', undefined, label); option.value = value; layoutSelect.append(option);
  }
  layoutLabel.append(layoutSelect);
  layoutSelect.addEventListener('change', () => { layout = layoutSelect.value as Layout; renderLayout(); });
  const wrapButton = button('Wrap on');
  wrapButton.addEventListener('click', () => { wrap = !wrap; renderLayout(); });
  const prev = button('Previous change');
  const next = button('Next change');
  prev.addEventListener('click', () => void navigateChange(-1));
  next.addEventListener('click', () => void navigateChange(1));
  const position = make('span', 'tdw__position', 'No changes');
  const findButton = button('Find');
  const exportButton = button('Export');
  const findPanel = make('div', 'tdw__find');
  findPanel.id = 'tdw-find';
  findButton.setAttribute('aria-controls', findPanel.id);
  findButton.setAttribute('aria-expanded', 'false');
  const findLabel = make('label', 'tdw__label', 'Find literal text');
  const findInput = make('input', 'tdw__find-input');
  findInput.type = 'search';
  findLabel.append(findInput);
  const matchCase = make('input');
  matchCase.type = 'checkbox'; matchCase.checked = true;
  const caseLabel = make('label', 'tdw__check', 'Match case');
  caseLabel.prepend(matchCase);
  const findPrevious = button('Previous match');
  const findNext = button('Next match');
  const findPosition = make('span', 'tdw__position');
  const closeFind = button('Close Find');
  findPanel.append(findLabel, caseLabel, findPrevious, findNext, findPosition, closeFind);
  findPanel.hidden = true;
  findButton.addEventListener('click', () => { findPanel.hidden = !findPanel.hidden; findButton.setAttribute('aria-expanded', String(!findPanel.hidden)); if (!findPanel.hidden) findInput.focus(); });
  closeFind.addEventListener('click', () => { findPanel.hidden = true; findButton.setAttribute('aria-expanded', 'false'); findButton.focus(); });
  findInput.addEventListener('input', () => { searchQuery = findInput.value; void find(0); });
  matchCase.addEventListener('change', () => { searchMatchCase = matchCase.checked; void find(0); });
  findPrevious.addEventListener('click', () => void find((search?.ordinal ?? 0) - 1));
  findNext.addEventListener('click', () => void find((search?.ordinal ?? -1) + 1));
  const exportPanel = make('div', 'tdw__export');
  exportPanel.id = 'tdw-export';
  exportButton.setAttribute('aria-controls', exportPanel.id);
  exportButton.setAttribute('aria-expanded', 'false');
  exportPanel.hidden = true;
  const downloadReport = button('Download report');
  const downloadPatch = button('Download patch');
  const copyChanges = button('Copy changes');
  const patchTarget = make('span', 'tdw__patch-target');
  const exportStatus = make('p', 'tdw__export-status');
  exportStatus.setAttribute('role', 'status');
  downloadReport.addEventListener('click', () => host.onRun('html'));
  downloadPatch.addEventListener('click', () => host.onRun('unified'));
  copyChanges.addEventListener('click', () => void copyReview());
  exportButton.addEventListener('click', () => { exportPanel.hidden = !exportPanel.hidden; exportButton.setAttribute('aria-expanded', String(!exportPanel.hidden)); if (!exportPanel.hidden) downloadReport.focus(); });
  exportPanel.append(downloadReport, downloadPatch, copyChanges, patchTarget, exportStatus);
  toolbar.append(layoutLabel, wrapButton, prev, position, next, findButton, exportButton);
  const options = make('details', 'tdw__options');
  options.append(make('summary', undefined, 'Options'));
  const activeRules = make('span', 'tdw__rules');
  const detailLabel = make('label', 'tdw__option', 'Detail');
  const detailSelect = make('select', 'tdw__select');
  for (const value of ['word', 'line', 'character'] as const) {
    const option = make('option', undefined, value === 'character' ? 'Character' : value === 'word' ? 'Word' : 'Line');
    option.value = value;
    if (value === 'character' && typeof Intl.Segmenter !== 'function') {
      option.disabled = true;
      option.title = 'Character detail requires grapheme segmentation in this browser.';
    }
    detailSelect.append(option);
  }
  detailLabel.append(detailSelect);
  detailSelect.addEventListener('change', () => { detail = detailSelect.value as DiffDetail; void requestWindow(currentCursor); });
  const contextLabel = make('label', 'tdw__option', 'Context');
  const contextSelect = make('select', 'tdw__select');
  for (const [value, label] of [['0', '0 lines'], ['3', '3 lines'], ['10', '10 lines'], ['whole', 'Whole file']] as const) {
    const option = make('option', undefined, label); option.value = value; contextSelect.append(option);
  }
  contextSelect.value = '3';
  contextLabel.append(contextSelect);
  contextSelect.addEventListener('change', () => { context = contextSelect.value === 'whole' ? 'whole' : Number(contextSelect.value) as DiffContext; history = []; void requestWindow(currentCursor); });
  function check(label: string, initial: boolean, action: (value: boolean) => void): HTMLLabelElement {
    const wrapper = make('label', 'tdw__check', label);
    const box = make('input'); box.type = 'checkbox'; box.checked = initial;
    box.addEventListener('change', () => action(box.checked));
    wrapper.prepend(box);
    options.append(wrapper);
    return wrapper;
  }
  check('Show whitespace', false, (value) => { showWhitespace = value; if (view) renderWindow(view); });
  const ignoreWhitespaceCheck = check('Ignore whitespace changes', false, (value) => changeRules({ ...rules, ignoreWhitespace: value }));
  const ignoreCaseCheck = check('Ignore case', false, (value) => changeRules({ ...rules, ignoreCase: value }));
  options.prepend(detailLabel, contextLabel);
  const viewport = make('div', 'tdw__viewport');
  viewport.setAttribute('aria-label', 'Comparison');
  const rows = make('div', 'tdw__rows');
  viewport.append(rows);
  const pages = make('div', 'tdw__pages');
  const firstPage = button('First page');
  const previousPage = button('Previous page');
  const nextPage = button('Next page');
  const pageStatus = make('span', 'tdw__position');
  firstPage.addEventListener('click', () => { history = []; void requestWindow(START); });
  previousPage.addEventListener('click', () => void page(-1));
  nextPage.addEventListener('click', () => void page(1));
  pages.append(firstPage, previousPage, pageStatus, nextPage);
  const copyFallback = make('div', 'tdw__copy-fallback');
  copyFallback.tabIndex = 0;
  copyFallback.hidden = true;
  reviewSection.append(reviewHead, stats, notice, toolbar, activeRules, findPanel, exportPanel, options, viewport, pages, copyFallback);
  root.append(header, modes, inputSection, reviewSection);
  mount.append(root);

  const resize = new ResizeObserver(() => {
    const width = root.getBoundingClientRect().width;
    const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    narrowInputs = width < 40 * rem;
    root.dataset.compact = String(narrowInputs);
    root.dataset.autoSplit = String(width >= 52 * rem);
    renderSources();
    renderLayout();
  });
  resize.observe(root);

  function busyExport(): boolean { return jobState.phase === 'preparing' || jobState.phase === 'running'; }
  function capture(index: SideIndex): UndoSource {
    return { source: side[index].source, text: textareas[index].value, candidate: side[index].candidate,
      provenance: side[index].provenance, deferred: side[index].deferred, preview: side[index].preview,
      lineEndingWarning: side[index].lineEndingWarning };
  }
  function stopTextTimer(index: SideIndex): void {
    if (textTimers[index]) clearTimeout(textTimers[index]);
    textTimers[index] = null;
  }
  function invalidate(): void {
    const wasStale = stale;
    compareRevision++;
    stale = true;
    view = null;
    search = null;
    findIntent++;
    history = [];
    expansions = [];
    currentCursor = START;
    activeHunk = -1;
    if (comparing || (!wasStale && ready)) live.cancel();
    comparing = false;
    if (timer) clearTimeout(timer);
    timer = null;
    renderStatus();
  }
  function showSourceError(index: SideIndex, message: string): void {
    side[index].error = `${LABEL[index]}: ${message}`;
    renderSources();
    host.announce(side[index].error);
  }
  function scheduleCompare(): void {
    if (!active || composing || side.some((item) => item.pending || item.candidate || !item.source)) return;
    const sources = side.map((item) => item.source!) as [ReadySource, ReadySource];
    const bytes = sources[0].byteLength + sources[1].byteLength;
    const textUnits = sources.reduce((sum, source) => sum + source.text.length, 0);
    const fileBytes = sources.reduce((sum, source) => sum + (source.origin === 'file' ? source.byteLength : 0), 0);
    if (bytes > MAX_COMPARISON_BYTES || textUnits > AUTO_TEXT || fileBytes > AUTO_FILE) {
      inputMessage.textContent = bytes > MAX_COMPARISON_BYTES
        ? 'These sources exceed the 10 MiB comparison limit.'
        : 'Sources are ready. Choose Compare now to avoid recomputing every edit.';
      renderStatus();
      return;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void compareAccepted(false); }, AUTO_DELAY);
  }
  async function readSource(index: SideIndex, source: LiveSource, saveUndo: boolean): Promise<void> {
    if (busyExport() || destroyed) return;
    const item = side[index];
    stopTextTimer(index);
    const intent = ++item.intent;
    const previous = item.source;
    const previousProvenance = item.provenance;
    const previousDeferred = item.deferred;
    const previousPreview = item.preview;
    const previousLineEndingWarning = item.lineEndingWarning;
    if (saveUndo) item.undo = capture(index);
    item.pending = true;
    item.candidate = source;
    item.error = '';
    invalidate();
    renderSources();
    const readRevision = ++sourceRevision;
    try {
      const accepted = await live.readSource(readRevision, source);
      if (!active || destroyed || item.intent !== intent) return;
      item.source = accepted;
      item.provenance = source.kind === 'file' ? { name: source.file.name, size: source.file.size, type: source.file.type || 'text/plain' } : null;
      item.deferred = source.kind === 'file' && deferFileEditor(accepted.text);
      item.preview = item.deferred ? previewOf(accepted.text) : '';
      item.lineEndingWarning = source.kind === 'file' && accepted.text.includes('\r');
      item.pending = false;
      item.candidate = null;
      // An untouched file retains the exact worker-decoded raw text. A textarea
      // normalizes CRLF, so its value is never used to reconstruct that file.
      if (source.kind === 'file') textareas[index].value = item.deferred ? '' : accepted.text;
      renderSources();
      scheduleCompare();
    } catch (error) {
      if (!active || destroyed || item.intent !== intent) return;
      if (error instanceof TextDiffLiveError && error.code === 'Superseded') {
        void readSource(index, source, false);
        return;
      }
      item.source = previous;
      item.provenance = previousProvenance;
      item.deferred = previousDeferred;
      item.preview = previousPreview;
      item.lineEndingWarning = previousLineEndingWarning;
      item.pending = false;
      item.candidate = source.kind === 'text' ? source : null;
      if (source.kind === 'file') item.candidate = null;
      showSourceError(index, `${source.name} could not be read: ${messageOf(error)}`);
    }
  }
  async function acceptFile(index: SideIndex, file: File): Promise<void> {
    if (file.size > MAX_COMPARISON_BYTES) { showSourceError(index, `${file.name} exceeds the 10 MiB limit.`); return; }
    await readSource(index, { kind: 'file', file, name: file.name }, true);
  }
  async function replaceWithText(index: SideIndex, text: string, origin: 'text' | 'empty', saveUndo = true): Promise<void> {
    if (saveUndo) side[index].undo = capture(index);
    textareas[index].value = text;
    await readSource(index, { kind: 'text', text, name: `${LABEL[index].toLowerCase()} text`, origin }, false);
  }
  function onTextInput(index: SideIndex): void {
    if (busyExport()) return;
    const text = textareas[index].value;
    const origin = text === '' ? 'empty' : 'text';
    side[index].intent++;
    side[index].pending = true;
    side[index].candidate = { kind: 'text', text, name: `${LABEL[index].toLowerCase()} text`, origin };
    side[index].error = '';
    invalidate();
    renderSources();
    if (textTimers[index]) clearTimeout(textTimers[index]);
    textTimers[index] = setTimeout(() => {
      textTimers[index] = null;
      const current = side[index].candidate;
      if (current) void readSource(index, current, false);
    }, AUTO_DELAY);
  }
  function beginComposition(index: SideIndex): void {
    if (busyExport() || composing) return;
    composing = true;
    stopTextTimer(index);
    const item = side[index];
    item.intent++;
    item.pending = true;
    item.candidate = null;
    item.error = '';
    invalidate();
    renderSources();
  }
  function clearSource(index: SideIndex): void {
    if (busyExport()) return;
    stopTextTimer(index);
    const item = side[index];
    item.undo = capture(index);
    item.intent++;
    item.source = null;
    item.provenance = null;
    item.deferred = false;
    item.preview = '';
    item.lineEndingWarning = false;
    item.pending = false;
    item.candidate = null;
    item.error = '';
    textareas[index].value = '';
    invalidate();
    renderSources();
  }
  function undoSource(index: SideIndex): void {
    if (busyExport()) return;
    stopTextTimer(index);
    const item = side[index];
    const undo = item.undo;
    if (undo === undefined) return;
    item.intent++;
    item.source = undo.source;
    item.provenance = undo.provenance;
    item.deferred = undo.deferred;
    item.preview = undo.preview;
    item.lineEndingWarning = undo.lineEndingWarning;
    item.undo = undefined;
    item.pending = false;
    item.candidate = undo.candidate;
    item.error = '';
    textareas[index].value = undo.text;
    invalidate();
    renderSources();
    if (undo.candidate) void readSource(index, undo.candidate, false);
    else scheduleCompare();
  }
  function swapSources(): void {
    if (busyExport() || side.some((item) => item.pending || item.candidate)) return;
    const [aText, bText] = [textareas[0].value, textareas[1].value];
    [side[0], side[1]] = [side[1], side[0]];
    side[0].intent++; side[1].intent++;
    textareas[0].value = bText;
    textareas[1].value = aText;
    invalidate();
    renderSources();
    scheduleCompare();
  }
  function resetSources(): void {
    if (busyExport()) return;
    for (const index of [0, 1] as const) {
      stopTextTimer(index);
      side[index].intent++;
      side[index].source = null;
      side[index].provenance = null;
      side[index].deferred = false;
      side[index].preview = '';
      side[index].lineEndingWarning = false;
      side[index].undo = undefined;
      side[index].pending = false;
      side[index].candidate = null;
      side[index].error = '';
      textareas[index].value = '';
    }
    ready = null; view = null; activeHunk = -1; history = [];
    invalidate();
    showMode('inputs', true);
    renderSources();
  }
  function changeRules(next: ComparisonRules): void {
    if (busyExport()) return;
    rules = next;
    invalidate();
    renderStatus();
    scheduleCompare();
  }
  async function compareAccepted(manual: boolean, resume = false): Promise<void> {
    if (!active || destroyed || busyExport() || side.some((item) => item.pending || item.candidate || !item.source)) return;
    const sources = side.map((item) => item.source!) as [ReadySource, ReadySource];
    if (sources[0].byteLength + sources[1].byteLength > MAX_COMPARISON_BYTES) {
      inputMessage.textContent = 'These sources exceed the 10 MiB comparison limit.';
      return;
    }
    const revision = ++compareRevision;
    comparing = true;
    stale = true;
    inputMessage.textContent = 'Comparing…';
    renderStatus();
    try {
      const response = await live.compare(revision, sources, rules);
      if (!active || destroyed || revision !== compareRevision) return;
      comparing = false;
      ready = response;
      stale = false;
      inputMessage.textContent = 'Comparison ready.';
      activeHunk = Math.min(activeHunk, response.hunks.length - 1);
      if (!resume) {
        history = [];
        expansions = [];
      }
      currentCursor = manual && currentCursor.row < response.logicalRows ? currentCursor : START;
      renderStatus();
      await requestWindow(currentCursor);
      if (resume && searchQuery) await find(search?.ordinal ?? 0);
    } catch (error) {
      if (!active || destroyed || revision !== compareRevision) return;
      comparing = false;
      if (error instanceof TextDiffLiveError && error.code === 'Superseded') return;
      inputMessage.textContent = error instanceof TextDiffLiveError && error.code === 'WorkerCrashed'
        ? 'The comparison worker stopped. Choose Compare now to retry.'
        : `Comparison failed: ${messageOf(error)} Choose Compare now to retry.`;
      renderStatus();
    }
  }
  async function requestWindow(cursor: WindowCursor, revealRow?: number): Promise<void> {
    const current = ready;
    if (!active || !current || stale) return;
    try {
      const response = await live.window({ revision: current.revision, cursor, detail, context, expansions, revealRow });
      if (!active || ready !== current || stale) return;
      currentCursor = response.start;
      view = response;
      renderWindow(response);
    } catch (error) {
      if (error instanceof TextDiffLiveError && error.code === 'Superseded') return;
      if (!active) return;
      if (error instanceof TextDiffLiveError && (error.code === 'WorkerCrashed' || error.code === 'NotReady')) {
        stale = true;
        inputMessage.textContent = 'The comparison worker stopped. Choose Compare now to retry.';
        renderStatus();
      }
      notice.textContent = `Could not load this part of the comparison: ${messageOf(error)}`;
    }
  }
  async function page(direction: 1 | -1): Promise<void> {
    if (!view) return;
    if (direction > 0) {
      if (!view.next) return;
      history.push(currentCursor);
      await requestWindow(view.next);
    } else {
      const previous = history.pop();
      if (previous) await requestWindow(previous);
    }
    rows.querySelector<HTMLElement>('[data-row]')?.focus();
  }
  async function navigateChange(direction: 1 | -1): Promise<void> {
    const hunks = ready?.hunks ?? [];
    if (!hunks.length || stale) return;
    activeHunk = activeHunk < 0 ? (direction > 0 ? 0 : hunks.length - 1)
      : (activeHunk + direction + hunks.length) % hunks.length;
    const target = hunks[activeHunk]!;
    history = [];
    currentCursor = { row: target.row, aOffset: 0, bOffset: 0 };
    await requestWindow(currentCursor, target.row);
    const node = rows.querySelector<HTMLElement>(`[data-row="${target.row}"]`);
    node?.scrollIntoView({ block: 'center' });
    node?.focus();
    renderStatus();
    host.announce(`Change ${activeHunk + 1} of ${hunks.length}.`);
  }
  async function find(ordinal: number): Promise<void> {
    const intent = ++findIntent;
    const current = ready;
    const query = searchQuery;
    const matchCaseValue = searchMatchCase;
    if (!active || !current || stale || !query) {
      search = null;
      findPosition.textContent = '';
      if (view) renderWindow(view);
      return;
    }
    try {
      const result = await live.find({ revision: current.revision, query, matchCase: matchCaseValue, ordinal });
      if (!active || ready !== current || stale || intent !== findIntent || query !== searchQuery || matchCaseValue !== searchMatchCase) return;
      search = result;
      findPosition.textContent = result.matchCount === 0 ? 'No matches'
        : `Match ${(result.ordinal ?? 0) + 1} of ${result.matchCount}`;
      if (result.cursor && result.row !== null) {
        history = [];
        currentCursor = result.cursor;
        await requestWindow(result.cursor, result.row);
        if (intent !== findIntent || query !== searchQuery || matchCaseValue !== searchMatchCase) return;
        rows.querySelector<HTMLElement>(`[data-row="${result.row}"]`)?.scrollIntoView({ block: 'center' });
      } else if (view) renderWindow(view);
    } catch (error) {
      if (error instanceof TextDiffLiveError && error.code === 'Superseded') return;
      if (intent !== findIntent) return;
      findPosition.textContent = `Find failed: ${messageOf(error)}`;
    }
  }
  async function copyText(text: string, label: string): Promise<void> {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable.');
      await navigator.clipboard.writeText(text);
      host.announce(`${label} copied.`);
      copyFallback.hidden = true;
      copyFallback.replaceChildren();
      fallbackText = '';
    } catch {
      fallbackText = text;
      if (text.length > DEFER_UNITS) {
        const load = button('Load full text for manual copy');
        load.addEventListener('click', () => {
          copyFallback.textContent = fallbackText;
          copyFallback.focus();
        });
        copyFallback.replaceChildren(
          make('p', undefined, 'Clipboard access was blocked. Loading the complete text for manual copy may pause this browser.'),
          load,
        );
      } else copyFallback.textContent = fallbackText;
      copyFallback.hidden = false;
      showMode('review', true);
      copyFallback.focus();
      host.announce(text.length > DEFER_UNITS
        ? 'Copy blocked. Choose Load full text for manual copy to reveal the complete text.'
        : 'Copy blocked. Select the text shown below and copy it manually.');
    }
  }
  async function copyAcceptedSource(index: SideIndex): Promise<void> {
    const source = side[index].source;
    if (source) await copyText(source.text, LABEL[index]);
  }
  async function copyReview(): Promise<void> {
    const current = ready;
    if (!current || stale) return;
    try {
      const result = await live.copy({ revision: current.revision, copy: 'changes', context });
      if (ready === current && !stale) await copyText(result.text, 'Changes');
    } catch (error) {
      if (error instanceof TextDiffLiveError && error.code === 'Superseded') return;
      exportStatus.textContent = `Copy changes failed: ${messageOf(error)}`;
    }
  }
  function showMode(next: Mode, focus = false): void {
    mode = next;
    inputSection.hidden = mode !== 'inputs';
    reviewSection.hidden = mode !== 'review';
    inputsMode.setAttribute('aria-current', mode === 'inputs' ? 'page' : 'false');
    reviewMode.setAttribute('aria-current', mode === 'review' ? 'page' : 'false');
    if (focus) {
      if (mode === 'inputs') focusSource(phoneSide);
      else reviewSection.focus();
    }
  }
  function focusSource(index: SideIndex): void {
    (side[index].deferred ? loadFullButtons[index] : textareas[index]).focus();
  }
  function renderSources(): void {
    for (const index of [0, 1] as const) {
      const item = side[index];
      sourcePanels[index].hidden = narrowInputs && phoneSide !== index;
      tabButtons[index].setAttribute('aria-selected', String(phoneSide === index));
      tabButtons[index].tabIndex = phoneSide === index ? 0 : -1;
      const identity = item.source ? `${item.source.origin === 'file' ? 'File' : item.source.origin === 'empty' ? 'Explicitly empty' : 'Text'} · ${item.source.name}` : 'Not provided';
      sourceStatus[index].textContent = item.pending ? `${identity} · checking new source…` : item.error || (item.deferred ? `${identity} · bounded preview` : identity);
      sourceStatus[index].classList.toggle('tdw__source-status--error', Boolean(item.error));
      lineEndingWarnings[index].hidden = !item.lineEndingWarning;
      sourceLabels[index].hidden = item.deferred;
      textareas[index].hidden = item.deferred;
      deferredPanels[index].hidden = !item.deferred;
      if (item.deferred && previewNodes[index].textContent !== item.preview) previewNodes[index].textContent = item.preview;
      loadFullButtons[index].disabled = busyExport();
      undoButtons[index].hidden = item.undo === undefined;
      clearButtons[index].disabled = !item.source && !item.pending && !item.candidate;
      copySourceButtons[index].disabled = !item.source || item.pending || !!item.candidate;
      textareas[index].readOnly = busyExport();
      fileButtons[index].disabled = busyExport();
      emptyButtons[index].disabled = busyExport();
      clearButtons[index].disabled ||= busyExport();
      undoButtons[index].disabled = busyExport();
    }
    swap.disabled = busyExport() || side.some((item) => item.pending || item.candidate);
    startOver.disabled = busyExport();
    compareNow.disabled = busyExport() || side.some((item) => item.pending || item.candidate || !item.source);
    compareNow.hidden = !stale && !!ready;
    cancelCompare.hidden = !comparing;
    reviewMode.disabled = !ready;
  }
  function renderLayout(): void {
    root.dataset.layout = layout;
    root.dataset.wrap = String(wrap);
    wrapButton.textContent = wrap ? 'Wrap on' : 'Wrap off';
    wrapButton.setAttribute('aria-pressed', String(wrap));
    layoutSelect.value = layout;
    viewport.setAttribute('aria-label', wrap ? 'Comparison' : 'Comparison; scroll sideways to read long lines');
  }
  function renderStatus(): void {
    renderSources();
    const current = ready;
    const readyNow = !!current && !stale;
    reviewHead.hidden = !current;
    if (current) {
      const [a, b] = current.snapshot.sources;
      const meta = current.sourceMeta;
      const describe = (source: ReadySource, index: SideIndex) => `${source.name} (${meta[index].lineCount} lines, ${meta[index].ending.toUpperCase()}${meta[index].hasBom ? ', BOM' : ''}${meta[index].endsWithNewline ? ', final newline' : ''})`;
      identities.textContent = `Original: ${describe(a, 0)} → Revised: ${describe(b, 1)}`;
      const counts = current.stats;
      const metadataCount = current.hunks.filter((hunk) => hunk.kind === 'metadata').length;
      stats.textContent = `${counts.added} added · ${counts.removed} removed · ${counts.changed} modified · ${counts.hunks} change ${counts.hunks === 1 ? 'group' : 'groups'}${metadataCount ? ` · ${metadataCount} metadata ${metadataCount === 1 ? 'change' : 'changes'}` : ''}`;
      const id = current.identity;
      const messages = [...current.notices];
      if (id.rawIdentical) messages.unshift('The two sources are exactly identical.');
      else if (id.metadataOnlyDifference) messages.unshift('Display lines match; line endings or BOM differ.');
      else if (id.normalizedIdentical) messages.unshift('No displayed changes under the active rules.');
      if (stale) messages.unshift('Comparison is out of date. Compare again before exporting.');
      notice.textContent = messages.join(' ');
      patchTarget.textContent = `Patch target: ${safePatchTarget(a.name)}`;
      downloadPatch.textContent = rules.ignoreCase || rules.ignoreWhitespace
        ? 'Exact patch · includes ignored differences' : 'Download patch';
      downloadPatch.disabled = !readyNow || id.rawIdentical || busyExport();
      if (id.rawIdentical) patchTarget.textContent += ' · No patch needed';
    } else {
      stats.textContent = '';
      notice.textContent = 'Provide both sources to compare.';
      patchTarget.textContent = '';
    }
    activeRules.textContent = rules.ignoreWhitespace || rules.ignoreCase
      ? `Active rules: ${[rules.ignoreWhitespace ? 'ignore whitespace' : '', rules.ignoreCase ? 'ignore case' : ''].filter(Boolean).join(', ')}`
      : 'Exact comparison';
    downloadReport.disabled = !readyNow || busyExport();
    copyChanges.disabled = !readyNow || busyExport();
    ignoreWhitespaceCheck.querySelector<HTMLInputElement>('input')!.disabled = busyExport();
    ignoreCaseCheck.querySelector<HTMLInputElement>('input')!.disabled = busyExport();
    prev.disabled = !readyNow || current!.hunks.length === 0;
    next.disabled = prev.disabled;
    position.textContent = !current || current.hunks.length === 0 ? 'No changes'
      : activeHunk < 0 ? `${current.hunks.length} ${current.hunks.length === 1 ? 'change' : 'changes'}` : `Change ${activeHunk + 1} of ${current.hunks.length}`;
    if (jobState.phase === 'preparing' || jobState.phase === 'running') {
      exportStatus.replaceChildren(document.createTextNode(`${jobState.phase === 'preparing' ? 'Preparing' : 'Exporting'}… ${Math.round(jobState.progress * 100)}% `));
      const cancel = button('Cancel export'); cancel.addEventListener('click', jobState.cancel); exportStatus.append(cancel);
    } else if (jobState.phase === 'ready') {
      exportStatus.replaceChildren(document.createTextNode(`Download ready: ${jobState.outputName}${stale || jobState.revision !== current?.revision ? ' (earlier comparison)' : ''}. `));
      const reveal = button('Show download'); reveal.addEventListener('click', jobState.revealOutput); exportStatus.append(reveal);
    } else {
      exportStatus.textContent = jobState.phase === 'failed' ? `Export failed: ${jobState.message}`
        : jobState.phase === 'cancelled' ? 'Export cancelled.' : '';
    }
  }
  function renderFragment(fragment: WindowFragment | null): HTMLElement {
    const cell = make('span', 'tdw__code');
    if (!fragment) return cell;
    if (fragment.oversizedGrapheme) {
      cell.textContent = 'Oversized character — use Copy source for complete text.';
      return cell;
    }
    const segments = fragment.segments.length ? fragment.segments : [{ text: fragment.text, changed: false }];
    let offset = fragment.sourceRange.start;
    for (const segment of segments) {
      const mark = make('span', segment.changed ? 'tdw__mark' : undefined);
      const start = offset;
      const end = start + segment.text.length;
      const match = search?.range;
      if (match && match.side === fragment.sourceRange.side && match.start < end && match.end > start) {
        const hitStart = Math.max(0, match.start - start);
        const hitEnd = Math.min(segment.text.length, match.end - start);
        mark.append(document.createTextNode(present(segment.text.slice(0, hitStart))));
        mark.append(make('span', 'tdw__match', present(segment.text.slice(hitStart, hitEnd))));
        mark.append(document.createTextNode(present(segment.text.slice(hitEnd))));
      } else mark.textContent = present(segment.text);
      cell.append(mark);
      offset = end;
    }
    if (!fragment.complete) cell.append(make('span', 'tdw__slice', ' · line continues'));
    return cell;
  }
  function present(text: string): string {
    return showWhitespace ? text.replace(/ /g, '·').replace(/\t/g, '→\t') : text;
  }
  function renderRow(row: WindowRow): HTMLElement {
    const node = make('div', `tdw__row tdw__row--${row.kind}`);
    if (row.kind === 'equal' && row.a?.text !== row.b?.text) node.classList.add('tdw__row--normalized');
    node.dataset.row = String(row.row);
    node.tabIndex = -1;
    if (ready?.hunks[activeHunk]?.row === row.row) node.classList.add('is-current');
    const a = make('div', 'tdw__half tdw__half--a');
    const b = make('div', 'tdw__half tdw__half--b');
    const gutter = (line: number | null, sign: string) => make('span', 'tdw__gutter', line === null ? '' : `${sign}${line + 1}`);
    const aGutter = gutter(row.aLine, row.kind === 'delete' || row.kind === 'replace' ? '−' : '');
    if (row.kind === 'equal' && row.bLine !== null) aGutter.append(make('span', 'tdw__unified-number', ` · ${row.bLine + 1}`));
    a.append(aGutter, renderFragment(row.a));
    b.append(gutter(row.bLine, row.kind === 'insert' || row.kind === 'replace' ? '+' : ''), renderFragment(row.b));
    node.append(a, b);
    return node;
  }
  function renderGap(gap: WindowGap): HTMLElement {
    const node = make('div', 'tdw__gap');
    const expand = button(`${gap.hiddenRows} unchanged lines · show 50 more`);
    expand.disabled = gap.expandable <= 0;
    expand.addEventListener('click', () => {
      const at = expansions.findIndex((item) => item.startRow === gap.expansionStart);
      const next = gap.expandedLines + gap.expandable;
      if (at < 0) expansions.push({ startRow: gap.expansionStart, lines: next });
      else expansions[at] = { startRow: gap.expansionStart, lines: next };
      void requestWindow(currentCursor);
    });
    node.append(expand);
    return node;
  }
  function renderWindow(response: WindowResponse): void {
    rows.replaceChildren(...response.rows.map((row) => row.kind === 'gap' ? renderGap(row) : renderRow(row)));
    firstPage.disabled = response.start.row === 0 && response.start.aOffset === 0 && response.start.bOffset === 0;
    previousPage.disabled = history.length === 0;
    nextPage.disabled = !response.next;
    pageStatus.textContent = `Rows ${response.start.row + 1}–${response.next?.row ?? ready?.logicalRows ?? response.start.row}`;
    if (response.notices.length) notice.textContent += ` ${response.notices.join(' ')}`;
  }
  function onKeydown(event: KeyboardEvent): void {
    if (!active || event.defaultPrevented || !root.contains(event.target as Node)) return;
    if (event.key === 'Escape' && !findPanel.hidden) { event.preventDefault(); findPanel.hidden = true; findButton.setAttribute('aria-expanded', 'false'); findButton.focus(); return; }
    const editable = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
    if (event.key === 'F7' && !editable) {
      event.preventDefault(); void navigateChange(event.shiftKey ? -1 : 1);
    }
  }
  root.addEventListener('keydown', onKeydown);
  root.addEventListener('dragover', (event) => {
    if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
  });
  root.addEventListener('drop', (event) => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault(); event.stopPropagation();
    const files = [...event.dataTransfer.files];
    if (files.length !== 1) { inputMessage.textContent = 'Drop one file, then choose Original or Revised.'; return; }
    pendingDrop = files[0]!;
    inputMessage.replaceChildren(document.createTextNode(`Use ${pendingDrop.name} as `));
    for (const index of [0, 1] as const) {
      const choice = button(LABEL[index]);
      choice.addEventListener('click', () => {
        const file = pendingDrop; pendingDrop = null;
        if (file) void acceptFile(index, file);
      });
      inputMessage.append(choice);
    }
    showMode('inputs');
  });
  inputsMode.addEventListener('click', () => showMode('inputs', true));
  reviewMode.addEventListener('click', () => showMode('review', true));
  reviewSection.tabIndex = -1;
  const unsubscribeProgress = live.onProgress((progress) => {
    if (comparing) inputMessage.textContent = `Comparing… ${Math.round(progress * 100)}%`;
  });
  renderSources(); renderLayout(); renderStatus(); showMode(mode);

  return {
    activate(trayFiles) {
      if (destroyed) return;
      active = true;
      if (!initialized) {
        initialized = true;
        if (trayFiles.length > 0 && trayFiles.length <= 2 && trayFiles.every(candidate)) {
          trayFiles.forEach((file, index) => void acceptFile(index as SideIndex, file));
        }
      } else {
        for (const index of [0, 1] as const) {
          const pending = side[index].candidate;
          if (pending) void readSource(index, pending, false);
        }
        if (side[0].source && side[1].source && stale && side.every((item) => !item.candidate)) void compareAccepted(true, true);
      }
      renderStatus();
    },
    deactivate() {
      active = false;
      compareRevision++;
      side[0].intent++; side[1].intent++;
      side[0].pending = false; side[1].pending = false;
      stopTextTimer(0); stopTextTimer(1);
      if (timer) clearTimeout(timer);
      timer = null;
      live.cancel();
      comparing = false;
      stale = true;
      renderStatus();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      resize.disconnect();
      unsubscribeProgress();
      if (timer) clearTimeout(timer);
      stopTextTimer(0); stopTextTimer(1);
      live.destroy();
      mount.replaceChildren();
    },
    focusPrimary() { if (mode === 'inputs') focusSource(phoneSide); else reviewSection.focus(); },
    prepareRun(format): PreparedToolRun {
      if (!ready || stale || ready.revision !== compareRevision || busyExport() || side.some((item) => item.pending || item.candidate)) {
        throw new OpError('InvalidOptions', 'Compare the current sources before exporting.');
      }
      const accepted = ready.snapshot;
      const frozen = Object.freeze({ schemaVersion: 1 as const, revision: accepted.revision,
        sources: Object.freeze(accepted.sources.map((source) => Object.freeze({ ...source })) as [ReadySource, ReadySource]),
        rules: Object.freeze({ ...accepted.rules }) });
      const exportContext = context === 'whole' ? 3 : context;
      return { revision: accepted.revision, files: [], inputs: accepted.sources.map((source, index) =>
        side[index as SideIndex].provenance ?? { name: source.name, size: source.byteLength, type: 'text/plain' }),
      options: { comparisonSnapshot: frozen, format,
        scope: context === 'whole' ? 'whole' : 'changes', context: exportContext, detail } };
    },
    setJobState(state) { jobState = state; renderStatus(); },
  };
};

export default workspace;
