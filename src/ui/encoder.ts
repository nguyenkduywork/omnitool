// src/ui/encoder.ts — "can this browser actually WRITE that format?"
//
// The image ops export their own `canEncode` helper, but importing it from
// src/tools/image/** would drag an op module (and with it a decoding engine)
// into the entry bundle and blow the §1 size budget instantly. So the shell
// keeps its own three-line probe. It is the same test, run on the main thread:
//
//   encode a 1x1 OffscreenCanvas to the requested type and compare blob.type
//   STRICTLY against what was asked for.
//
// The strictness is the entire point. Canvas encoders do not reject an
// unsupported type — they silently hand back a PNG. Measured 2026-08-29 in
// Chrome for Testing 151: `image/webp` encodes genuinely; `image/avif` comes
// back as `{ type: 'image/png' }`. So a `blob instanceof Blob` check would
// happily "confirm" AVIF support that does not exist.
//
// The result is used to DISABLE the choice with the reason visible, rather than
// offering a format that then fails mid-run (§5.2 of the spec).

import type { OptionSchema } from '../types';
import type { DisabledChoices } from './optionspanel';

/** Choice value (as written in a tool's OptionSchema) -> the mime it means. */
const CHOICE_MIME: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
};

const HUMAN: Record<string, string> = {
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'image/webp': 'WebP',
  'image/avif': 'AVIF',
};

const probes = new Map<string, Promise<boolean>>();

async function probe(mime: string): Promise<boolean> {
  if (typeof OffscreenCanvas === 'undefined') return false;
  try {
    const canvas = new OffscreenCanvas(1, 1);
    const context = canvas.getContext('2d');
    if (!context) return false;
    context.fillStyle = '#000';
    context.fillRect(0, 0, 1, 1);
    const blob = await canvas.convertToBlob({ type: mime });
    // STRICT: a silent PNG fallback must read as "unsupported".
    return blob.type === mime;
  } catch {
    return false;
  }
}

/** True when this browser genuinely encodes `mime`. Probed once, then cached. */
export function canEncodeHere(mime: string): Promise<boolean> {
  let pending = probes.get(mime);
  if (!pending) {
    pending = probe(mime);
    probes.set(mime, pending);
  }
  return pending;
}

/**
 * Every select choice in `schema` that names an image format this browser cannot
 * write, mapped to the reason to show. Choices that are not image formats
 * (`fit`, `a4`, `svg`, ...) are left alone.
 */
export async function disabledFormatChoices(
  schema: OptionSchema | undefined,
): Promise<DisabledChoices> {
  if (!schema) return {};

  const blocked: DisabledChoices = {};
  for (const [key, def] of Object.entries(schema)) {
    if (def.kind !== 'select') continue;
    for (const choice of def.choices) {
      const mime = CHOICE_MIME[choice.value];
      if (!mime) continue;
      if (await canEncodeHere(mime)) continue;
      const reasons = (blocked[key] ??= {});
      reasons[choice.value] =
        `${HUMAN[mime] ?? choice.label} is unavailable — this browser has no ${HUMAN[mime] ?? 'that'} encoder, so it would silently write a PNG instead.`;
    }
  }
  return blocked;
}
