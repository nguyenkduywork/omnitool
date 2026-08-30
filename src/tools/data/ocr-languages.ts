// src/tools/data/ocr-languages.ts — the OCR language packs this build vendors.
//
// Pure data, no DOM, no npm engine — safe for both ocr.op.ts (runs in a
// worker) and ocr.editor.ts (runs on the main thread) to import.
//
// MUST stay in sync with the `LANGUAGES` list in scripts/vendor-ocr.mjs,
// which is the script that actually copies each language's `.traineddata.gz`
// out of `node_modules/@tesseract.js-data/<code>/4.0.0_best_int/` into
// `public/ocr/lang-data/` — see that file for why only these 15 codes, and
// why the "best_int" variant specifically (3-9x smaller, near-identical
// accuracy, versus the plain "4.0.0" variant).
//
// Real per-language download sizes are NOT hardcoded here — they come from
// the generated manifest at `/ocr/languages.json` (also written by
// scripts/vendor-ocr.mjs), which ocr.editor.ts fetches at runtime. Sizes
// belong to measured bytes on disk, not a second, driftable copy in source.
export type OcrLanguage = { code: string; name: string };

export const OCR_LANGUAGES: readonly OcrLanguage[] = [
  { code: 'eng', name: 'English' },
  { code: 'fra', name: 'French' },
  { code: 'deu', name: 'German' },
  { code: 'spa', name: 'Spanish' },
  { code: 'ita', name: 'Italian' },
  { code: 'por', name: 'Portuguese' },
  { code: 'nld', name: 'Dutch' },
  { code: 'pol', name: 'Polish' },
  { code: 'tur', name: 'Turkish' },
  { code: 'rus', name: 'Russian' },
  { code: 'ara', name: 'Arabic' },
  { code: 'vie', name: 'Vietnamese' },
  { code: 'chi_sim', name: 'Chinese (Simplified)' },
  { code: 'jpn', name: 'Japanese' },
  { code: 'kor', name: 'Korean' },
];

export const OCR_LANGUAGE_CODES: ReadonlySet<string> = new Set(OCR_LANGUAGES.map((l) => l.code));

export const DEFAULT_OCR_LANGUAGE = 'eng';
