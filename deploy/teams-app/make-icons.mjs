import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The two PNG icons a Teams app package requires.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SCRIPT AND NOT TWO BINARY FILES IN GIT
 *
 * A reviewer cannot read a PNG in a diff. Committing the generator means the
 * icons are reviewable, reproducible byte-for-byte, and changeable by editing
 * three numbers rather than by opening an image editor nobody has.
 *
 * No dependency: a PNG is a signature, an IHDR, one deflated IDAT of filtered
 * RGBA scanlines, and an IEND. `node:zlib` supplies the only hard part.
 * ---------------------------------------------------------------------------
 */

const here = dirname(fileURLToPath(import.meta.url));

/** Mac's slate. Dark enough to carry a light glyph in both Teams themes. */
const SLATE = [31, 42, 55];
const LIGHT = [232, 237, 242];

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(size, pixel) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10, 11, 12 are compression, filter and interlace: all zero, all default.

  const raw = Buffer.alloc(size * (size * 4 + 1));
  let offset = 0;
  for (let y = 0; y < size; y += 1) {
    raw[offset] = 0; // filter type "None": these are tiny and flat.
    offset += 1;
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = pixel(x, y, size);
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = a;
      offset += 4;
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Shortest distance from a point to a line segment, in normalised units. */
function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/**
 * An "M", as four stroked segments in a unit square with y running downward.
 *
 * Drawn rather than typeset because rendering a font without a font library is
 * a much larger problem than four line segments.
 */
const STROKES = [
  [0.20, 0.78, 0.20, 0.22],
  [0.20, 0.22, 0.50, 0.60],
  [0.50, 0.60, 0.80, 0.22],
  [0.80, 0.22, 0.80, 0.78],
];

/** Coverage of the glyph at a point, antialiased across one pixel. */
function glyphCoverage(x, y, size, halfWidth) {
  const px = (x + 0.5) / size;
  const py = (y + 0.5) / size;
  let nearest = Infinity;
  for (const [ax, ay, bx, by] of STROKES) {
    nearest = Math.min(nearest, distanceToSegment(px, py, ax, ay, bx, by));
  }
  const feather = 1 / size;
  return Math.max(0, Math.min(1, (halfWidth - nearest) / feather + 0.5));
}

/** Rounded-square coverage, so the colour icon is not a hard rectangle. */
function tileCoverage(x, y, size, radius) {
  const px = (x + 0.5) / size;
  const py = (y + 0.5) / size;
  const dx = Math.max(Math.abs(px - 0.5) - (0.5 - radius), 0);
  const dy = Math.max(Math.abs(py - 0.5) - (0.5 - radius), 0);
  const outside = Math.hypot(dx, dy) - radius;
  const feather = 1 / size;
  return Math.max(0, Math.min(1, -outside / feather + 0.5));
}

const mix = (from, to, t) => Math.round(from + (to - from) * t);

/** 192×192 full colour: light "M" on Mac's slate, rounded. */
const colour = png(192, (x, y, size) => {
  const tile = tileCoverage(x, y, size, 0.18);
  if (tile <= 0) return [0, 0, 0, 0];
  const glyph = glyphCoverage(x, y, size, 0.058);
  return [
    mix(SLATE[0], LIGHT[0], glyph),
    mix(SLATE[1], LIGHT[1], glyph),
    mix(SLATE[2], LIGHT[2], glyph),
    Math.round(255 * tile),
  ];
});

/**
 * 32×32 outline: a white glyph on transparency.
 *
 * Teams tints this one itself, so any colour but white would fight the theme.
 */
const outline = png(32, (x, y, size) => {
  const glyph = glyphCoverage(x, y, size, 0.075);
  return [255, 255, 255, Math.round(255 * glyph)];
});

writeFileSync(join(here, 'color.png'), colour);
writeFileSync(join(here, 'outline.png'), outline);
console.log(`color.png ${colour.length} bytes, outline.png ${outline.length} bytes`);
