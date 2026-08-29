// src/tools/pdf/from-images.op.ts — build one PDF from a list of images.
//
// One image per page, in file-tray order. pdf-lib can only embed PNG and JPEG,
// so anything else (WebP, AVIF, GIF, TIFF) raises `UnsupportedFormat` naming
// the file instead of being silently dropped — converting it first is
// image-convert's job, not this op's.
//
// 'fit' sizes each page to its image (plus margin). 'a4'/'letter' use a fixed
// page and centre the image inside the margins, scaling DOWN to fit but never
// UP: blowing a thumbnail up to A4 would look like a bug, not a feature.

import { PDFDocument, PageSizes, type PDFImage } from 'pdf-lib';
import { OpError, type Op, type OpOutput } from '../../types';

const PAGE_SIZES = {
  a4: PageSizes.A4,
  letter: PageSizes.Letter,
} as const;

function baseName(name: string): string {
  const cut = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  const stem = cut >= 0 ? name.slice(cut + 1) : name;
  const dot = stem.lastIndexOf('.');
  return dot > 0 ? stem.slice(0, dot) : stem;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new OpError('Cancelled', 'Cancelled');
}

/** Magic-byte sniff — never trust the extension. */
export function imageKind(buffer: ArrayBuffer): 'png' | 'jpeg' | null {
  const head = new Uint8Array(buffer, 0, Math.min(8, buffer.byteLength));
  if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  return null;
}

const fromImages: Op = async (inputs, options, ctx): Promise<OpOutput[]> => {
  const first = inputs[0];
  if (first === undefined) throw new OpError('InvalidOptions', 'pdf-from-images needs at least one image');

  const pageSize = options['pageSize'] === undefined ? 'fit' : options['pageSize'];
  if (pageSize !== 'fit' && pageSize !== 'a4' && pageSize !== 'letter') {
    throw new OpError('InvalidOptions', `pageSize must be "fit", "a4" or "letter", got ${JSON.stringify(pageSize)}`);
  }
  const margin = options['margin'] === undefined ? 0 : options['margin'];
  if (typeof margin !== 'number' || !Number.isFinite(margin) || margin < 0 || margin > 72) {
    throw new OpError('InvalidOptions', `margin must be a number from 0 to 72 points, got ${JSON.stringify(margin)}`);
  }

  const doc = await PDFDocument.create();
  const total = inputs.length;

  for (let i = 0; i < total; i++) {
    const input = inputs[i];
    if (input === undefined) continue;
    throwIfAborted(ctx.signal);
    ctx.onProgress(i / total);

    const kind = imageKind(input.buffer);
    if (kind === null) {
      throw new OpError(
        'UnsupportedFormat',
        `${input.name} is not a PNG or JPEG — a PDF can only embed those two directly`,
        input.name,
      );
    }

    let image: PDFImage;
    try {
      image = kind === 'png' ? await doc.embedPng(input.buffer) : await doc.embedJpg(input.buffer);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      throw new OpError('CorruptFile', `${input.name} could not be decoded as ${kind.toUpperCase()} (${why})`, input.name);
    }

    if (pageSize === 'fit') {
      const page = doc.addPage([image.width + margin * 2, image.height + margin * 2]);
      page.drawImage(image, { x: margin, y: margin, width: image.width, height: image.height });
    } else {
      const [pageWidth, pageHeight] = PAGE_SIZES[pageSize];
      const page = doc.addPage([pageWidth, pageHeight]);
      const boxWidth = Math.max(1, pageWidth - margin * 2);
      const boxHeight = Math.max(1, pageHeight - margin * 2);
      const scale = Math.min(1, boxWidth / image.width, boxHeight / image.height);
      const width = image.width * scale;
      const height = image.height * scale;
      page.drawImage(image, {
        x: (pageWidth - width) / 2,
        y: (pageHeight - height) / 2,
        width,
        height,
      });
    }

    ctx.onProgress((i + 1) / (total + 1));
  }

  const bytes = await doc.save({ useObjectStreams: true });
  ctx.onProgress(1);

  return [
    {
      name: `${baseName(first.name)}.pdf`,
      type: 'application/pdf',
      buffer: toArrayBuffer(bytes),
    },
  ];
};

export default fromImages;
