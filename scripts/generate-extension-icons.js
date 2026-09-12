#!/usr/bin/env node
/**
 * Generates the extension's PNG icons (16 / 48 / 128 px).
 *
 * Written with Node's built-in zlib rather than an image library so the repo
 * needs no extra dependency just to produce three small icons. Run it with:
 *   node scripts/generate-extension-icons.js
 *
 * Draws the TruthLens mark: a rounded indigo-to-violet square with a white
 * check, matching the web app's favicon and header logo.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.join(__dirname, '..', 'extension', 'icons');

/** CRC32, required by the PNG chunk format. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

/** Encode raw RGBA pixels as a PNG buffer. */
function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;  // bit depth
  header[9] = 6;  // colour type: RGBA
  // 10-12 are compression, filter and interlace: all 0 (default).

  // Each scanline is prefixed with a filter byte; 0 means "no filter".
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG signature
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Distance from a point to a line segment — used to draw the check stroke. */
function distanceToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;
  let t = lengthSq === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const radius = size * 0.22;
  const stroke = Math.max(1.4, size * 0.085);

  // Check-mark geometry, expressed as fractions of the canvas so it scales.
  const p1 = [size * 0.28, size * 0.52];
  const p2 = [size * 0.44, size * 0.68];
  const p3 = [size * 0.73, size * 0.34];

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      const cx = x + 0.5;
      const cy = y + 0.5;

      // --- Rounded-square mask, anti-aliased at the corners ---
      const nx = Math.max(radius - cx, cx - (size - radius), 0);
      const ny = Math.max(radius - cy, cy - (size - radius), 0);
      const cornerDistance = Math.hypot(nx, ny);
      const squareAlpha = Math.max(0, Math.min(1, radius - cornerDistance + 0.5));

      if (squareAlpha <= 0) continue;

      // --- Diagonal indigo -> violet gradient ---
      const t = (cx / size + cy / size) / 2;
      const r = Math.round(99 + (168 - 99) * t);
      const g = Math.round(102 + (85 - 102) * t);
      const b = Math.round(241 + (247 - 241) * t);

      // --- White check on top ---
      const checkDistance = Math.min(
        distanceToSegment(cx, cy, p1[0], p1[1], p2[0], p2[1]),
        distanceToSegment(cx, cy, p2[0], p2[1], p3[0], p3[1]),
      );
      const checkAlpha = Math.max(0, Math.min(1, stroke / 2 - checkDistance + 0.5));

      rgba[i] = Math.round(r + (255 - r) * checkAlpha);
      rgba[i + 1] = Math.round(g + (255 - g) * checkAlpha);
      rgba[i + 2] = Math.round(b + (255 - b) * checkAlpha);
      rgba[i + 3] = Math.round(255 * squareAlpha);
    }
  }

  return encodePng(size, size, rgba);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const size of [16, 48, 128]) {
  const file = path.join(OUT_DIR, `icon${size}.png`);
  fs.writeFileSync(file, drawIcon(size));
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
}
