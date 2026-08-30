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

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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

// ---------------------------------------------------------------------------
// Metadata-carrying images, for image-strip-metadata. Each one is a real file
// that genuinely contains the block the tool has to remove — an EXIF record
// with GPS coordinates, a PNG text chunk, a WebP EXIF/XMP pair — so the test
// proves removal rather than proving that nothing was there.
// ---------------------------------------------------------------------------

/** A minimal but structurally valid little-endian TIFF/EXIF payload. */
function makeExifPayload() {
  const out = Buffer.alloc(26);
  out.write('II', 0, 'latin1');
  out.writeUInt16LE(42, 2);
  out.writeUInt32LE(8, 4);
  out.writeUInt16LE(1, 8); // one IFD entry
  out.writeUInt16LE(0x010e, 10); // ImageDescription
  out.writeUInt16LE(2, 12); // ASCII
  out.writeUInt32LE(4, 14); // four bytes, so the value is stored inline
  out.write('fix\0', 18, 'latin1');
  out.writeUInt32LE(0, 22); // no next IFD
  return out;
}

function makeExifJpg() {
  return sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 200, g: 100, b: 50 } } })
    .withExif({
      IFD0: { Make: 'omnitool', Model: 'Fixture Camera', Software: 'make-fixtures' },
      // libvips exposes the GPS IFD as IFD3: real coordinates, so a test can
      // assert that stripping actually removes a location.
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '48/1 51/1 2976/100',
        GPSLongitudeRef: 'E',
        GPSLongitude: '2/1 17/1 2712/100',
      },
    })
    .jpeg()
    .toBuffer();
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), 8 + data.length);
  return out;
}

/** a.png plus a tEXt comment and an eXIf record, inserted before IEND. */
async function makeMetaPng() {
  const base = await makePng(4, 4, { r: 120, g: 160, b: 200 });
  const iendAt = base.length - 12; // length + 'IEND' + CRC
  const text = pngChunk('tEXt', Buffer.from('Comment\0built by make-fixtures', 'latin1'));
  const exif = pngChunk('eXIf', makeExifPayload());
  return Buffer.concat([base.subarray(0, iendAt), text, exif, base.subarray(iendAt)]);
}

function riffChunk(fourCC, data) {
  const padded = data.length + (data.length % 2);
  const out = Buffer.alloc(8 + padded);
  out.write(fourCC, 0, 'latin1');
  out.writeUInt32LE(data.length, 4);
  data.copy(out, 8);
  return out;
}

/**
 * An extended-format (VP8X) WebP carrying EXIF and XMP, wrapped around a real
 * VP8 bitstream produced by sharp. The VP8X flag bits say the metadata is
 * there, which is what image-strip-metadata has to clear on the way out.
 */
async function makeMetaWebp() {
  const width = 6;
  const height = 4;
  const base = await makeWebp(width, height, { r: 200, g: 90, b: 40 });
  // Everything after the 12-byte RIFF/WEBP header is the image's own chunk.
  const imageChunk = base.subarray(12);

  const vp8xData = Buffer.alloc(10);
  vp8xData[0] = 0x08 | 0x04; // EXIF and XMP present
  vp8xData.writeUIntLE(width - 1, 4, 3);
  vp8xData.writeUIntLE(height - 1, 7, 3);

  const body = Buffer.concat([
    riffChunk('VP8X', vp8xData),
    imageChunk,
    riffChunk('EXIF', makeExifPayload()),
    riffChunk('XMP ', Buffer.from('<x:xmpmeta xmlns:x="adobe:ns:meta/"></x:xmpmeta>', 'utf8')),
  ]);

  const out = Buffer.alloc(12 + body.length);
  out.write('RIFF', 0, 'latin1');
  out.writeUInt32LE(out.length - 8, 4);
  out.write('WEBP', 8, 'latin1');
  body.copy(out, 12);
  return out;
}

// ---------------------------------------------------------------------------
// TAR archives, for tar-extract. Built by GNU tar itself rather than by the
// reader's own writer, so the test proves interoperability instead of
// self-consistency. --mtime/--owner/--group keep the bytes deterministic and
// free of whoever ran the script.
// ---------------------------------------------------------------------------

// One path component well past the 100-byte ustar name field, which forces
// GNU tar into a long-name ('L') entry and bsdtar/pax into a 'path=' record.
const LONG_NAME = `${'long-'.repeat(24)}name.txt`;

const TAR_FLAGS = ['--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '--sort=name'];

async function withTarSourceDir(run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'omnitool-fixtures-'));
  try {
    await mkdir(path.join(dir, 'dir'), { recursive: true });
    await writeFile(path.join(dir, 'hello.txt'), 'hello from omnitool\n');
    await writeFile(path.join(dir, 'dir', 'nested.txt'), 'nested file contents\n');
    await writeFile(path.join(dir, LONG_NAME), 'stored under a name too long for a ustar header\n');
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function tarInto(dir, outFile, extraFlags) {
  execFileSync('tar', [...extraFlags, ...TAR_FLAGS, '-cf', outFile, '-C', dir, 'hello.txt', 'dir/nested.txt', LONG_NAME]);
}

function makeSampleTar() {
  return withTarSourceDir(async (dir) => {
    const out = path.join(dir, 'out.tar');
    tarInto(dir, out, ['--format=gnu']);
    return readFile(out);
  });
}

function makeSampleTarGz() {
  return withTarSourceDir(async (dir) => {
    const out = path.join(dir, 'out.tar.gz');
    execFileSync('tar', ['--format=gnu', ...TAR_FLAGS, '-czf', out, '-C', dir, 'hello.txt', 'dir/nested.txt']);
    return readFile(out);
  });
}

function makePaxTar() {
  return withTarSourceDir(async (dir) => {
    const out = path.join(dir, 'pax.tar');
    tarInto(dir, out, ['--format=pax']);
    return readFile(out);
  });
}

/**
 * A tar with a genuine "../evil.txt" entry. GNU tar refuses to write one (it
 * strips the leading "../"), so this header is assembled here, independently
 * of the reader under test — the same reason traversal.zip exists.
 */
function makeTraversalTar() {
  const entries = [
    { name: 'ok.txt', body: 'this one is fine\n' },
    { name: '../evil.txt', body: 'if you can read this, traversal succeeded\n' },
  ];

  const blocks = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.body, 'utf8');
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 'latin1');
    header.write('0000644\0', 100, 'latin1');
    header.write('0000000\0', 108, 'latin1');
    header.write('0000000\0', 116, 'latin1');
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 'latin1');
    header.write('00000000000\0', 136, 'latin1');
    header.write('        ', 148, 'latin1'); // checksum field, blank while summing
    header.write('0', 156, 'latin1'); // regular file
    header.write('ustar\0', 257, 'latin1');
    header.write('00', 263, 'latin1');
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');

    const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
    blocks.push(header, data, padding);
  }
  blocks.push(Buffer.alloc(1024)); // end-of-archive
  return Buffer.concat(blocks);
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

async function verifyExifJpg(bytes) {
  const meta = await sharp(bytes).metadata();
  if (!meta.exif || meta.exif.length === 0) throw new Error('exif.jpg: sharp reports no EXIF block');
  if (!bytes.includes(Buffer.from('Exif\0\0', 'latin1'))) throw new Error('exif.jpg: no APP1 Exif segment');
  if (!bytes.includes(Buffer.from('Fixture Camera', 'latin1'))) throw new Error('exif.jpg: EXIF does not carry the camera model');
}

async function verifyMetaPng(bytes) {
  const meta = await sharp(bytes).metadata();
  if (meta.width !== 4) throw new Error(`meta.png: expected a 4px-wide PNG, got ${meta.width}`);
  for (const chunk of ['tEXt', 'eXIf']) {
    if (!bytes.includes(Buffer.from(chunk, 'latin1'))) throw new Error(`meta.png: no ${chunk} chunk`);
  }
}

async function verifyMetaWebp(bytes) {
  const meta = await sharp(bytes).metadata();
  if (meta.width !== 6) throw new Error(`meta.webp: expected a 6px-wide WebP, got ${meta.width}`);
  if (!meta.exif || meta.exif.length === 0) throw new Error('meta.webp: sharp reports no EXIF block');
  for (const chunk of ['VP8X', 'EXIF', 'XMP ']) {
    if (!bytes.includes(Buffer.from(chunk, 'latin1'))) throw new Error(`meta.webp: no ${chunk} chunk`);
  }
}

/** Lists an archive with the system tar, which must accept what we wrote. */
function tarList(file) {
  return execFileSync('tar', ['-tf', file], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line !== '');
}

function verifyTarWith(expected) {
  return async (bytes, file) => {
    const listed = tarList(file);
    for (const name of expected) {
      if (!listed.includes(name)) {
        throw new Error(`${path.basename(file)}: system tar did not list "${name}" (got ${listed.join(', ')})`);
      }
    }
    // Only meaningful for an uncompressed archive; a .tar.gz is deflate output.
    if (!file.endsWith('.gz') && bytes.length % 512 !== 0) {
      throw new Error(`${path.basename(file)}: not a whole number of 512-byte blocks`);
    }
  };
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
    { name: 'exif.jpg', build: makeExifJpg, verify: verifyExifJpg },
    { name: 'meta.png', build: makeMetaPng, verify: verifyMetaPng },
    { name: 'meta.webp', build: makeMetaWebp, verify: verifyMetaWebp },
    { name: 'sample.zip', build: makeSampleZip },
    { name: 'traversal.zip', build: makeTraversalZip, verify: verifyTraversalZip },
    { name: 'sample.tar', build: makeSampleTar, verify: verifyTarWith(['hello.txt', 'dir/nested.txt', LONG_NAME]) },
    { name: 'sample.tar.gz', build: makeSampleTarGz, verify: verifyTarWith(['hello.txt', 'dir/nested.txt']) },
    { name: 'pax.tar', build: makePaxTar, verify: verifyTarWith(['hello.txt', 'dir/nested.txt', LONG_NAME]) },
    { name: 'traversal.tar', build: makeTraversalTar, verify: verifyTarWith(['ok.txt', '../evil.txt']) },
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
    const filePath = path.join(OUT_DIR, fixture.name);
    const onDisk = await readFile(filePath);
    if (onDisk.length === 0) throw new Error(`${fixture.name}: written file is empty`);
    if (fixture.verify) await fixture.verify(onDisk, filePath);
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
