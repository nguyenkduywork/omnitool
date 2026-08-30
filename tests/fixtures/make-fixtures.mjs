#!/usr/bin/env node
// tests/fixtures/make-fixtures.mjs
//
// Generates the committed binary test fixtures used across tests/unit/**.
// Every fixture here is a REAL, format-valid file — never a placeholder or a
// zero-byte stand-in. Where practical, this script also self-verifies what it
// just wrote using the same libraries the app (and its tests) will use to
// read them: pdf-lib and pdfjs-dist for PDFs, fflate for zips.
//
// Run with: npm run make-fixtures

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PDFDocument } from 'pdf-lib';
import { zipSync, strToU8, unzipSync } from 'fflate';
import sharp from 'sharp';
// Node-compatible ("legacy") build — the browser build assumes DOM globals
// that don't exist under plain Node.
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = __dirname;

// ---------------------------------------------------------------------------
// RC4 + the PDF standard security handler (revision 2, 40-bit), used only to
// build encrypted.pdf. Verified against the classic "Key"/"Plaintext" RC4
// test vector (ciphertext BBF316E8D940AF0AD3) before being used here.
// ---------------------------------------------------------------------------

function rc4(key, data) {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 0xff;
    const t = s[i];
    s[i] = s[j];
    s[j] = t;
  }
  const out = new Uint8Array(data.length);
  let i = 0;
  j = 0;
  for (let k = 0; k < data.length; k++) {
    i = (i + 1) & 0xff;
    j = (j + s[i]) & 0xff;
    const t = s[i];
    s[i] = s[j];
    s[j] = t;
    out[k] = data[k] ^ s[(s[i] + s[j]) & 0xff];
  }
  return out;
}

function md5(...bufs) {
  const h = createHash('md5');
  for (const b of bufs) h.update(b);
  return h.digest();
}

// ISO 32000-1 standard password-padding string (Algorithm 2).
const PAD = Buffer.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

function pad32(password) {
  const pw = Buffer.from(password, 'latin1').subarray(0, 32);
  const out = Buffer.alloc(32);
  pw.copy(out, 0);
  PAD.copy(out, pw.length, 0, 32 - pw.length);
  return out;
}

function p32le(p) {
  const b = Buffer.alloc(4);
  b.writeInt32LE(p, 0);
  return b;
}

function computeOwnerHash(ownerPw, userPw) {
  const rc4Key = md5(pad32(ownerPw)).subarray(0, 5);
  return Buffer.from(rc4(rc4Key, pad32(userPw)));
}

function computeFileKey(userPw, ownerHash, permissions, id1) {
  const input = Buffer.concat([pad32(userPw), ownerHash, p32le(permissions), id1]);
  return md5(input).subarray(0, 5);
}

function computeUserHash(fileKey) {
  return Buffer.from(rc4(fileKey, PAD));
}

function hexString(buf) {
  return `<${buf.toString('hex')}>`;
}

/**
 * Hand-built, minimally-structured single-page PDF encrypted with the
 * standard security handler (V1/R2, 40-bit RC4). pdf-lib cannot write
 * encrypted PDFs (no encryption API), so this fixture is assembled by hand
 * and verified below with pdfjs-dist — the same library Task 3's ops use.
 */
function buildEncryptedPdf({ userPassword, ownerPassword }) {
  const permissions = -256; // bits 1-8 = 0 (deny), bits 9-32 = 1 (reserved) — internally consistent only.
  const id1 = randomBytes(16);

  const ownerHash = computeOwnerHash(ownerPassword, userPassword);
  const fileKey = computeFileKey(userPassword, ownerHash, permissions, id1);
  const userHash = computeUserHash(fileKey);

  const chunks = [];
  let offset = 0;
  const objOffsets = [];

  function push(str) {
    const buf = Buffer.from(str, 'latin1');
    chunks.push(buf);
    offset += buf.length;
  }
  function beginObj(num) {
    objOffsets[num] = offset;
    push(`${num} 0 obj\n`);
  }
  function endObj() {
    push('endobj\n');
  }

  push('%PDF-1.4\n');

  beginObj(1);
  push('<< /Type /Catalog /Pages 2 0 R >>\n');
  endObj();

  beginObj(2);
  push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>\n');
  endObj();

  beginObj(3);
  push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << >> >>\n');
  endObj();

  // Empty content stream: nothing to draw, so nothing needs RC4 encryption
  // in the body of this fixture — only the standard security handler's own
  // O/U hashes need to be right, and those are verified below.
  beginObj(4);
  push('<< /Length 0 >>\nstream\n\nendstream\n');
  endObj();

  beginObj(5);
  push(`<< /Filter /Standard /V 1 /R 2 /O ${hexString(ownerHash)} /U ${hexString(userHash)} /P ${permissions} >>\n`);
  endObj();

  const numObjs = 6;
  const xrefOffset = offset;
  push(`xref\n0 ${numObjs}\n`);
  push('0000000000 65535 f \n');
  for (let n = 1; n < numObjs; n++) {
    push(`${String(objOffsets[n]).padStart(10, '0')} 00000 n \n`);
  }
  push('trailer\n');
  push(`<< /Size ${numObjs} /Root 1 0 R /Encrypt 5 0 R /ID [${hexString(id1)} ${hexString(id1)}] >>\n`);
  push(`startxref\n${xrefOffset}\n%%EOF`);

  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

async function makeSmallPdf() {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 3; i++) {
    const page = doc.addPage([200, 200]);
    page.drawText(`Page ${i + 1}`, { x: 20, y: 100 });
  }
  return Buffer.from(await doc.save());
}

async function makeCorruptPdf() {
  // A real "%PDF-" header so a sniffer/parser starts reading it as a PDF,
  // followed by random bytes so it fails partway through parsing rather
  // than being rejected instantly by a magic-byte check.
  const header = Buffer.from('%PDF-1.4\n', 'latin1');
  const garbage = randomBytes(256);
  return Buffer.concat([header, garbage]);
}

async function makeEncryptedPdf() {
  return buildEncryptedPdf({ userPassword: 'omnitool', ownerPassword: 'omnitool-owner' });
}

async function makePng(width, height, color) {
  return sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
}

async function makeJpg(width, height, color) {
  return sharp({ create: { width, height, channels: 3, background: color } }).jpeg().toBuffer();
}

/**
 * A crisp, high-contrast, known-text image for tests/e2e/ocr.spec.ts (and
 * anything else that wants a real OCR fixture rather than building one on
 * the fly). Bold and large deliberately: the point is reliable recognition,
 * not testing OCR's tolerance for small or thin text. Rendered via sharp's
 * SVG support so the exact text is data, not a screenshot.
 */
function makeOcrTextPng() {
  const svg = `<svg width="1100" height="220" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="white"/>
    <text x="30" y="145" font-family="sans-serif" font-weight="bold" font-size="90" fill="black">OMNITOOL OCR TEST</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function makeWebp(width, height, color) {
  return sharp({ create: { width, height, channels: 4, background: { ...color, alpha: 1 } } })
    .webp()
    .toBuffer();
}

function makeSampleZip() {
  return Buffer.from(
    zipSync({
      'hello.txt': strToU8('hello from omnitool\n'),
      'dir/nested.txt': strToU8('nested file contents\n'),
    }),
  );
}

function makeTraversalZip() {
  // Genuinely contains an entry named "../evil.txt" — fflate performs no
  // path sanitisation on the way in. zip-extract (Task 5) must sanitise on
  // the way out; this fixture exists to prove it does.
  return Buffer.from(
    zipSync({
      'ok.txt': strToU8('this one is fine\n'),
      '../evil.txt': strToU8('if you can read this, traversal succeeded\n'),
    }),
  );
}

function makeSampleCsv() {
  const rows = [
    'name,age,note',
    'Alice,30,"Loves cats, dogs"',
    'Bob,25,"Said ""hi"" to everyone"',
    'Cara,22,plain',
  ];
  return Buffer.from(rows.join('\r\n') + '\r\n', 'utf8');
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

async function verifySmallPdf(bytes) {
  const doc = await PDFDocument.load(bytes);
  const pages = doc.getPageCount();
  if (pages !== 3) throw new Error(`small.pdf: expected 3 pages, got ${pages}`);
}

async function verifyCorruptPdf(bytes) {
  // The only requirement is that pdfjs rejects it cleanly (any parse error
  // is fine) rather than succeeding or crashing the process.
  await pdfjsLib.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false }).promise.then(
    () => {
      throw new Error('corrupt.pdf: expected pdfjs to reject this file, but it opened successfully');
    },
    () => {
      /* expected: parsing failed */
    },
  );
}

async function verifyEncryptedPdf(bytes) {
  const attempt = (password) =>
    pdfjsLib.getDocument({ data: new Uint8Array(bytes), password, isEvalSupported: false }).promise;

  let openedWithoutPassword = false;
  try {
    await attempt(undefined);
    openedWithoutPassword = true;
  } catch (err) {
    if (err.name !== 'PasswordException') throw err;
  }
  if (openedWithoutPassword) throw new Error('encrypted.pdf: opened without a password — not actually encrypted');

  const doc = await attempt('omnitool'); // must succeed
  if (doc.numPages !== 1) throw new Error(`encrypted.pdf: expected 1 page, got ${doc.numPages}`);

  let openedWithWrongPassword = false;
  try {
    await attempt('definitely-wrong');
    openedWithWrongPassword = true;
  } catch (err) {
    if (err.name !== 'PasswordException') throw err;
  }
  if (openedWithWrongPassword) throw new Error('encrypted.pdf: opened with the wrong password');
}

function verifyTraversalZip(bytes) {
  const entries = unzipSync(new Uint8Array(bytes));
  if (!('../evil.txt' in entries)) {
    throw new Error('traversal.zip: missing literal "../evil.txt" entry');
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const fixtures = [
    { name: 'small.pdf', build: makeSmallPdf, verify: verifySmallPdf },
    { name: 'corrupt.pdf', build: makeCorruptPdf, verify: verifyCorruptPdf },
    { name: 'encrypted.pdf', build: makeEncryptedPdf, verify: verifyEncryptedPdf },
    { name: 'a.png', build: () => makePng(4, 4, { r: 220, g: 40, b: 40 }) },
    { name: 'b.png', build: () => makePng(6, 4, { r: 40, g: 200, b: 60 }) },
    { name: 'c.png', build: () => makePng(8, 6, { r: 40, g: 80, b: 220 }) },
    { name: 'a.jpg', build: () => makeJpg(5, 5, { r: 230, g: 180, b: 20 }) },
    { name: 'a.webp', build: () => makeWebp(6, 4, { r: 30, g: 200, b: 200 }) },
    { name: 'ocr-text.png', build: makeOcrTextPng },
    { name: 'sample.zip', build: makeSampleZip },
    { name: 'traversal.zip', build: makeTraversalZip, verify: verifyTraversalZip },
    { name: 'sample.csv', build: makeSampleCsv },
  ];

  const rows = [];
  for (const fixture of fixtures) {
    const bytes = await fixture.build();
    if (!bytes || bytes.length === 0) {
      throw new Error(`${fixture.name}: builder produced an empty buffer`);
    }
    await writeFile(path.join(OUT_DIR, fixture.name), bytes);
    rows.push({ name: fixture.name, bytes: bytes.length });
  }

  // Re-read from disk for verification, so we're checking exactly what was
  // committed to the filesystem, not an in-memory buffer.
  for (const fixture of fixtures) {
    const onDisk = await readFile(path.join(OUT_DIR, fixture.name));
    if (onDisk.length === 0) throw new Error(`${fixture.name}: written file is empty`);
    if (fixture.verify) await fixture.verify(onDisk);
  }

  const widest = Math.max(...rows.map((r) => r.name.length));
  console.log('Generated fixtures:');
  for (const row of rows) {
    console.log(`  ${row.name.padEnd(widest)}  ${row.bytes} bytes`);
  }
  console.log('\nAll fixtures written and verified.');
}

main().catch((err) => {
  console.error('make-fixtures failed:', err);
  process.exit(1);
});
