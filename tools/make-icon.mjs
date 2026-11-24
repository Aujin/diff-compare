/**
 * Generates the marketplace icon (media/icon.png) without any dependency.
 *
 * The drawing is a dark rounded square with two light columns and two orange
 * arrows in between, which is exactly what the extension does: compare two
 * sides and move the differences from one side to the other.
 *
 * Usage: node tools/make-icon.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 128;
const here = dirname(fileURLToPath(import.meta.url));
const output = join(here, '..', 'media', 'icon.png');

const pixels = new Uint8Array(SIZE * SIZE * 4);

function blend(x, y, color) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) {
    return;
  }
  const offset = (y * SIZE + x) * 4;
  const alpha = color[3] / 255;
  if (alpha <= 0) {
    return;
  }
  for (let channel = 0; channel < 3; channel += 1) {
    pixels[offset + channel] = Math.round(
      pixels[offset + channel] * (1 - alpha) + color[channel] * alpha,
    );
  }
  pixels[offset + 3] = Math.max(pixels[offset + 3], color[3]);
}

function fillRect(x0, y0, x1, y1, color) {
  for (let y = Math.floor(y0); y < Math.ceil(y1); y += 1) {
    for (let x = Math.floor(x0); x < Math.ceil(x1); x += 1) {
      blend(x, y, color);
    }
  }
}

function fillRoundRect(x0, y0, x1, y1, radius, color) {
  for (let y = Math.floor(y0); y < Math.ceil(y1); y += 1) {
    for (let x = Math.floor(x0); x < Math.ceil(x1); x += 1) {
      const dx = Math.max(x0 + radius - x, 0, x - (x1 - radius));
      const dy = Math.max(y0 + radius - y, 0, y - (y1 - radius));
      if (dx * dx + dy * dy <= radius * radius) {
        blend(x, y, color);
      }
    }
  }
}

function strokeLine(x0, y0, x1, y1, width, color) {
  const half = width / 2;
  const minX = Math.floor(Math.min(x0, x1) - half - 1);
  const maxX = Math.ceil(Math.max(x0, x1) + half + 1);
  const minY = Math.floor(Math.min(y0, y1) - half - 1);
  const maxY = Math.ceil(Math.max(y0, y1) + half + 1);
  const dx = x1 - x0;
  const dy = y1 - y0;
  const lengthSq = dx * dx + dy * dy;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      let t = lengthSq === 0 ? 0 : ((x - x0) * dx + (y - y0) * dy) / lengthSq;
      t = Math.max(0, Math.min(1, t));
      const px = x0 + t * dx;
      const py = y0 + t * dy;
      const distance = Math.hypot(x - px, y - py);
      if (distance <= half) {
        blend(x, y, color);
      }
    }
  }
}

function fillTriangle(points, color) {
  const [[ax, ay], [bx, by], [cx, cy]] = points;
  const minX = Math.floor(Math.min(ax, bx, cx));
  const maxX = Math.ceil(Math.max(ax, bx, cx));
  const minY = Math.floor(Math.min(ay, by, cy));
  const maxY = Math.ceil(Math.max(ay, by, cy));
  const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const w0 = ((bx - ax) * (y - ay) - (by - ay) * (x - ax)) / area;
      const w1 = ((cx - bx) * (y - by) - (cy - by) * (x - bx)) / area;
      const w2 = ((ax - cx) * (y - cy) - (ay - cy) * (x - cx)) / area;
      if (w0 >= 0 && w1 >= 0 && w2 >= 0) {
        blend(x, y, color);
      }
    }
  }
}

// Background.
const background = [31, 36, 48, 255];
const accent = [255, 152, 55, 255];
const light = [232, 236, 244, 255];
const dim = [150, 160, 180, 255];

fillRoundRect(0, 0, SIZE, SIZE, 24, background);

// Two columns.
fillRoundRect(20, 26, 50, 102, 6, light);
fillRoundRect(78, 26, 108, 102, 6, light);

// Line hints inside the columns.
for (let index = 0; index < 5; index += 1) {
  const y = 36 + index * 14;
  fillRect(27, y, 43, y + 4, dim);
}
for (let index = 0; index < 5; index += 1) {
  const y = 36 + index * 14;
  fillRect(85, y, 101, y + 4, dim);
}

// Arrows in the middle.
strokeLine(54, 50, 68, 50, 6, accent);
fillTriangle([[72, 50], [62, 43], [62, 57]], accent);

strokeLine(74, 78, 60, 78, 6, accent);
fillTriangle([[56, 78], [66, 71], [66, 85]], accent);

// Encode the PNG.
function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc ^= buffer[index];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header[8] = 8; // bit depth
header[9] = 6; // colour type RGBA
header[10] = 0;
header[11] = 0;
header[12] = 0;

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y += 1) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  for (let x = 0; x < SIZE * 4; x += 1) {
    raw[y * (SIZE * 4 + 1) + 1 + x] = pixels[y * SIZE * 4 + x];
  }
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

mkdirSync(join(here, '..', 'media'), { recursive: true });
writeFileSync(output, png);
console.log(`icon written: ${output} (${png.length} bytes)`);
