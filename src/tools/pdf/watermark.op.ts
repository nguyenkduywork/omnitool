import {
  PDFDocument, StandardFonts, concatTransformationMatrix, degrees,
  popGraphicsState, pushGraphicsState, rgb,
  type PDFFont, type PDFPage,
} from 'pdf-lib';

import { OpError, type Op, type OpInput, type OpOutput } from '../../types';

const POSITIONS = ['diagonal', 'center', 'top-left', 'top-right', 'bottom-left', 'bottom-right'] as const;
type Position = typeof POSITIONS[number];
const COLOURS = { black: rgb(0, 0, 0), white: rgb(1, 1, 1) };

function stop(signal: AbortSignal): void {
  if (signal.aborted) throw new OpError('Cancelled', 'Cancelled');
}

function numberOption(raw: unknown, fallback: number, min: number, max: number, name: string): number {
  const value = raw === undefined ? fallback : raw;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new OpError('InvalidOptions', `${name} must be a number between ${min} and ${max}.`);
  }
  return value;
}

function textOption(raw: unknown): string {
  const value = raw === undefined ? 'CONFIDENTIAL' : raw;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new OpError('InvalidOptions', 'Enter the text to stamp on the PDF.');
  }
  if (Array.from(value).some((char) => {
    const code = char.codePointAt(0)!;
    return code < 32 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029;
  })) {
    throw new OpError('InvalidOptions', 'Use a single line of watermark text without tabs or control characters.');
  }
  return value.trim();
}

async function loadPdf(input: OpInput): Promise<PDFDocument> {
  const head = new TextDecoder().decode(new Uint8Array(input.buffer, 0, Math.min(5, input.buffer.byteLength)));
  if (head !== '%PDF-') {
    throw new OpError('UnsupportedFormat', `${input.name} is not a PDF (missing the "%PDF-" header).`, input.name);
  }
  try {
    const doc = await PDFDocument.load(input.buffer, { updateMetadata: false });
    if (doc.getPageCount() === 0) throw new Error('The PDF has no pages.');
    return doc;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new OpError('CorruptFile', /encrypt/i.test(reason)
      ? `${input.name} is password-protected. Decrypt it first.`
      : `${input.name} could not be read as a PDF (${reason}).`, input.name);
  }
}

/** Work in the visible page's upright coordinates, including nonzero crop origins. */
function visiblePage(page: PDFPage): { width: number; height: number; matrix: [number, number, number, number, number, number] } {
  const crop = page.getCropBox();
  const media = page.getMediaBox();
  const x = Math.max(crop.x, media.x);
  const y = Math.max(crop.y, media.y);
  const width = Math.min(crop.x + crop.width, media.x + media.width) - x;
  const height = Math.min(crop.y + crop.height, media.y + media.height) - y;
  if (!(width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height))) {
    throw new Error('The PDF has an invalid visible page size.');
  }
  const rotation = ((page.getRotation().angle % 360) + 360) % 360;
  switch (rotation) {
    case 0: return { width, height, matrix: [1, 0, 0, 1, x, y] };
    case 90: return { width: height, height: width, matrix: [0, 1, -1, 0, x + width, y] };
    case 180: return { width, height, matrix: [-1, 0, 0, -1, x + width, y + height] };
    case 270: return { width: height, height: width, matrix: [0, -1, 1, 0, x, y + height] };
    default: throw new Error('The PDF page rotation must be a multiple of 90 degrees.');
  }
}

function stamp(page: PDFPage, font: PDFFont, text: string, position: Position, size: number, opacity: number, colour: keyof typeof COLOURS): void {
  const view = visiblePage(page);
  const shorter = Math.min(view.width, view.height);
  const margin = shorter * 0.04;
  const angle = position === 'diagonal' ? Math.atan2(view.height, view.width) : 0;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const unitWidth = font.widthOfTextAtSize(text, 1);
  const unitHeight = font.heightAtSize(1);
  // Fit the entire rotated text box, including descenders, within the crop.
  const fontSize = Math.min(
    shorter * size / 100,
    (view.width - margin * 2) / (unitWidth * cosine + unitHeight * sine),
    (view.height - margin * 2) / (unitWidth * sine + unitHeight * cosine),
  );
  const textWidth = unitWidth * fontSize;
  const ascent = font.heightAtSize(fontSize, { descender: false });
  const descent = unitHeight * fontSize - ascent;
  const minX = -ascent * sine;
  const minY = -descent * cosine;
  const boxWidth = textWidth * cosine + (ascent + descent) * sine;
  const boxHeight = textWidth * sine + (ascent + descent) * cosine;
  const left = position.endsWith('left') ? margin
    : position.endsWith('right') ? view.width - margin - boxWidth : (view.width - boxWidth) / 2;
  const bottom = position.startsWith('bottom') ? margin
    : position.startsWith('top') ? view.height - margin - boxHeight : (view.height - boxHeight) / 2;

  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...view.matrix));
  page.drawText(text, {
    font, size: fontSize, x: left - minX, y: bottom - minY,
    rotate: degrees(angle * 180 / Math.PI), color: COLOURS[colour], opacity: opacity / 100,
  });
  page.pushOperators(popGraphicsState());
}

const watermark: Op = async (inputs, options, ctx): Promise<OpOutput[]> => {
  if (inputs.length === 0) throw new OpError('InvalidOptions', 'Watermark needs at least one PDF.');
  const text = textOption(options.text);
  const position = options.position === undefined ? 'diagonal' : options.position;
  if (typeof position !== 'string' || !POSITIONS.includes(position as Position)) {
    throw new OpError('InvalidOptions', `Position must be one of: ${POSITIONS.join(', ')}.`);
  }
  const colour = options.colour === undefined ? 'black' : options.colour;
  if (typeof colour !== 'string' || !Object.hasOwn(COLOURS, colour)) {
    throw new OpError('InvalidOptions', 'Colour must be black or white.');
  }
  const size = numberOption(options.size, 6, 1, 25, 'Text size');
  const opacity = numberOption(options.opacity, 35, 5, 100, 'Opacity');
  const outputs: OpOutput[] = [];
  stop(ctx.signal);

  for (const [index, input] of inputs.entries()) {
    stop(ctx.signal);
    const doc = await loadPdf(input);
    stop(ctx.signal);
    const font = await doc.embedFont(StandardFonts.HelveticaBold);
    stop(ctx.signal);
    try {
      font.encodeText(text);
    } catch {
      throw new OpError('InvalidOptions', 'The PDF watermark font supports Latin text. Replace unsupported characters and try again.');
    }

    try {
      const pages = doc.getPages();
      for (const [pageIndex, page] of pages.entries()) {
        stop(ctx.signal);
        stamp(page, font, text, position as Position, size, opacity, colour as keyof typeof COLOURS);
        ctx.onProgress((index + (pageIndex + 1) / (pages.length + 1)) / inputs.length);
      }
      stop(ctx.signal);
      const bytes = await doc.save();
      stop(ctx.signal);
      const buffer = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buffer).set(bytes);
      const name = input.name.split(/[/\\]/).pop()!.replace(/\.pdf$/i, '');
      outputs.push({ name: `${name}-watermarked.pdf`, type: 'application/pdf', buffer });
    } catch (error) {
      if (error instanceof OpError) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      throw new OpError('CorruptFile', `${input.name} could not be watermarked (${reason}).`, input.name);
    }
    ctx.onProgress((index + 1) / inputs.length);
  }
  return outputs;
};

export default watermark;
