// Génère l'icône NovaMail (enveloppe orange sur carré sombre) en PNG et ICO,
// sans dépendance externe : rendu 1024 px supersamplé puis réduction.

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'build');
mkdirSync(outDir, { recursive: true });

const MASTER = 1024;
const CANVAS = 256;

const BG_TOP = [18, 26, 36];
const BG_BOTTOM = [9, 13, 19];
const BORDER = [34, 48, 65];
const ACCENT = [255, 140, 66];

function roundedRectContains(x, y, left, top, right, bottom, radius) {
  const cx = Math.min(Math.max(x, left + radius), right - radius);
  const cy = Math.min(Math.max(y, top + radius), bottom - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const lengthSq = abx * abx + aby * aby;
  let t = lengthSq === 0 ? 0 : ((px - ax) * abx + (py - ay) * aby) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  const dx = px - (ax + t * abx);
  const dy = py - (ay + t * aby);
  return Math.sqrt(dx * dx + dy * dy);
}

function distanceToRectBorder(px, py, left, top, right, bottom) {
  if (px < left || px > right || py < top || py > bottom) return Infinity;
  return Math.min(px - left, right - px, py - top, bottom - py);
}

function renderMaster() {
  const buffer = Buffer.alloc(MASTER * MASTER * 4);
  const scale = MASTER / CANVAS;

  const outer = { left: 6, top: 6, right: 250, bottom: 250, radius: 54 };
  const borderWidth = 3;
  const inner = {
    left: outer.left + borderWidth,
    top: outer.top + borderWidth,
    right: outer.right - borderWidth,
    bottom: outer.bottom - borderWidth,
    radius: outer.radius - borderWidth,
  };

  // Enveloppe : cadre + rabat en V, tracés en unités 256.
  const envelope = { left: 58, top: 80, right: 198, bottom: 176 };
  const stroke = 17;
  const flap = [
    [envelope.left + 4, envelope.top + 6, 128, 136],
    [128, 136, envelope.right - 4, envelope.top + 6],
  ];

  for (let y = 0; y < MASTER; y += 1) {
    for (let x = 0; x < MASTER; x += 1) {
      const ux = (x + 0.5) / scale;
      const uy = (y + 0.5) / scale;
      const index = (y * MASTER + x) * 4;

      let color = null;

      if (roundedRectContains(ux, uy, outer.left, outer.top, outer.right, outer.bottom, outer.radius)) {
        const ratio = (uy - outer.top) / (outer.bottom - outer.top);
        color = [
          Math.round(BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * ratio),
          Math.round(BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * ratio),
          Math.round(BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * ratio),
        ];
      }

      if (color && !roundedRectContains(ux, uy, inner.left, inner.top, inner.right, inner.bottom, inner.radius)) {
        color = BORDER.slice();
      }

      if (color) {
        const edge = distanceToRectBorder(ux, uy, envelope.left, envelope.top, envelope.right, envelope.bottom);
        if (edge <= stroke / 2) color = ACCENT.slice();
      }

      if (color) {
        for (const [ax, ay, bx, by] of flap) {
          if (distanceToSegment(ux, uy, ax, ay, bx, by) <= stroke / 2) {
            color = ACCENT.slice();
            break;
          }
        }
      }

      if (!color) {
        buffer[index] = 0;
        buffer[index + 1] = 0;
        buffer[index + 2] = 0;
        buffer[index + 3] = 0;
      } else {
        buffer[index] = color[0];
        buffer[index + 1] = color[1];
        buffer[index + 2] = color[2];
        buffer[index + 3] = 255;
      }
    }
  }

  return buffer;
}

function downsample(master, size) {
  const ratio = MASTER / size;
  const out = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;
      const startX = Math.floor(x * ratio);
      const startY = Math.floor(y * ratio);
      const endX = Math.min(MASTER, Math.ceil((x + 1) * ratio));
      const endY = Math.min(MASTER, Math.ceil((y + 1) * ratio));

      for (let sy = startY; sy < endY; sy += 1) {
        for (let sx = startX; sx < endX; sx += 1) {
          const i = (sy * MASTER + sx) * 4;
          const alpha = master[i + 3] / 255;
          r += master[i] * alpha;
          g += master[i + 1] * alpha;
          b += master[i + 2] * alpha;
          a += alpha;
          count += 1;
        }
      }

      const index = (y * size + x) * 4;
      if (a === 0 || count === 0) {
        out[index] = 0;
        out[index + 1] = 0;
        out[index + 2] = 0;
        out[index + 3] = 0;
      } else {
        out[index] = Math.round(r / a);
        out[index + 1] = Math.round(g / a);
        out[index + 2] = Math.round(b / a);
        out[index + 3] = Math.round((a / count) * 255);
      }
    }
  }

  return out;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(size, rgba) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  let offset = 6 + images.length * 16;
  const entries = [];

  for (const image of images) {
    const entry = Buffer.alloc(16);
    entry[0] = image.size >= 256 ? 0 : image.size;
    entry[1] = image.size >= 256 ? 0 : image.size;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(image.png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += image.png.length;
    entries.push(entry);
  }

  return Buffer.concat([header, ...entries, ...images.map((image) => image.png)]);
}

const master = renderMaster();
const sizes = [256, 128, 64, 48, 32, 16];
const images = sizes.map((size) => ({ size, png: encodePng(size, downsample(master, size)) }));

writeFileSync(path.join(outDir, 'icon.png'), images[0].png);
writeFileSync(path.join(outDir, 'icon.ico'), buildIco(images));

console.log('icône NovaMail: build/icon.png et build/icon.ico (' + sizes.join(', ') + ')');
