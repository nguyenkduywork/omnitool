import { label } from '../core/format';
import type { OpOutput } from '../types';
import { el, formatBytes, icon, iconButton } from './dom';
import './image-preview.css';

/** The result cards own these URLs; the viewer only borrows them. */
export type PreviewImage = { output: OpOutput; url: string };
export type ImagePreviewHandle = { close(restoreFocus?: boolean): void };

export function openImagePreview(
  images: readonly PreviewImage[],
  initial: PreviewImage,
  returnTo: HTMLElement,
): ImagePreviewHandle {
  let index = images.indexOf(initial);
  let closed = false;
  let currentImage: HTMLImageElement | null = null;
  const dialog = el('dialog', 'image-preview');
  dialog.setAttribute('aria-label', 'Image preview');
  const header = el('div', 'image-preview__header');
  const titles = el('div', 'image-preview__titles');
  const title = el('h2', 'image-preview__title');
  const details = el('p', 'image-preview__details');
  details.setAttribute('aria-live', 'polite');
  titles.append(title, details);
  const dismiss = iconButton('close', 'Close image preview', 'btn btn--icon');
  header.append(titles, dismiss);

  const toolbar = el('div', 'image-preview__toolbar');
  const navigation = el('div', 'image-preview__navigation');
  const previous = iconButton('up', 'Previous image', 'btn btn--ghost btn--icon image-preview__previous');
  const next = iconButton('down', 'Next image', 'btn btn--ghost btn--icon image-preview__next');
  const position = el('span', 'image-preview__position');
  navigation.append(previous, position, next);
  navigation.hidden = images.length < 2;

  const zoomLabel = el('label', 'image-preview__zoom', 'Zoom');
  const zoom = el('select', 'field field--select');
  for (const [value, text] of [['fit', 'Fit'], ['50', '50%'], ['100', '100%'], ['200', '200%'], ['400', '400%']] as const) {
    const option = el('option', undefined, text);
    option.value = value;
    zoom.append(option);
  }
  zoomLabel.append(zoom);
  const download = el('a', 'btn btn--ghost btn--sm image-preview__download');
  download.append(icon('download'), el('span', undefined, 'Download'));
  toolbar.append(navigation, zoomLabel, download);

  const viewport = el('div', 'image-preview__viewport');
  viewport.tabIndex = 0;
  viewport.setAttribute('role', 'region');
  viewport.setAttribute('aria-label', 'Preview image area');
  const stage = el('div', 'image-preview__stage');
  viewport.append(stage);
  const hint = el('p', 'image-preview__hint', 'Scroll to inspect when zoomed. Esc closes the preview.');
  dialog.append(header, toolbar, viewport, hint);

  function close(restoreFocus = true): void {
    if (closed) return;
    closed = true;
    currentImage?.removeAttribute('src');
    currentImage = null;
    dialog.close();
    dialog.remove();
    if (restoreFocus && returnTo.isConnected) returnTo.focus({ preventScroll: true });
  }

  function applyZoom(): void {
    if (!currentImage?.naturalWidth) return;
    const fit = zoom.value === 'fit';
    dialog.dataset.fit = String(fit);
    currentImage.style.width = fit ? '' : `${currentImage.naturalWidth * Number(zoom.value) / 100}px`;
    currentImage.style.height = fit ? '' : `${currentImage.naturalHeight * Number(zoom.value) / 100}px`;
    viewport.scrollLeft = Math.max(0, (stage.scrollWidth - viewport.clientWidth) / 2);
    viewport.scrollTop = Math.max(0, (stage.scrollHeight - viewport.clientHeight) / 2);
  }

  function show(at: number): void {
    const entry = images[at];
    if (closed || !entry) return;
    index = at;
    const focused = document.activeElement;
    title.textContent = entry.output.name;
    title.title = entry.output.name;
    const metadata = `${label(entry.output.type)} · ${formatBytes(entry.output.buffer.byteLength)}`;
    details.textContent = metadata;
    position.textContent = `${index + 1} / ${images.length}`;
    previous.disabled = index === 0;
    next.disabled = index === images.length - 1;
    download.href = entry.url;
    download.download = entry.output.name;
    zoom.value = 'fit';
    zoom.disabled = true;
    dialog.dataset.fit = 'true';
    currentImage?.removeAttribute('src');
    const image = el('img', 'image-preview__image');
    currentImage = image;
    image.alt = `Preview of ${entry.output.name}`;
    image.decoding = 'async';
    image.addEventListener('load', () => {
      if (closed || currentImage !== image) return;
      details.textContent = `${index + 1} of ${images.length} · ${image.naturalWidth.toLocaleString()} × ${image.naturalHeight.toLocaleString()} px · ${metadata}`;
      zoom.disabled = false;
      applyZoom();
    });
    image.addEventListener('error', () => {
      if (closed || currentImage !== image) return;
      stage.replaceChildren(el('p', 'image-preview__error', 'This image could not be previewed. You can still download it.'));
    });
    image.src = entry.url;
    stage.replaceChildren(image);
    viewport.scrollTo(0, 0);
    if ((focused === previous && previous.disabled) || (focused === next && next.disabled)) {
      viewport.focus({ preventScroll: true });
    }
  }

  previous.addEventListener('click', () => show(index - 1));
  next.addEventListener('click', () => show(index + 1));
  zoom.addEventListener('change', applyZoom);
  dismiss.addEventListener('click', () => close());
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
  });
  dialog.addEventListener('keydown', (event) => {
    // Let the shell's search shortcut open its palette after this modal closes.
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { close(); return; }
    if (event.target === zoom) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      show(index + (event.key === 'ArrowLeft' ? -1 : 1));
    }
  });
  document.body.append(dialog);
  show(Math.max(0, index));
  dialog.showModal();
  dismiss.focus();
  return { close };
}
