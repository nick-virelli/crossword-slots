// Draws the app icon (a little crossword grid) and writes PNG files. Run: node tools/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, sum]);
};

function icon(size) {
  const px = Buffer.alloc(size * (size * 3 + 1));
  const bg = [10, 47, 36], cream = [251, 248, 238], gold = [245, 200, 75], dark = [22, 60, 46];
  const pad = size * 0.16, cell = (size - pad * 2) / 3, gap = cell * 0.1, rad = cell * 0.16;
  // crossword pattern: gold cells form a cross, one dark "blocked" corner
  const kind = [[1, 2, 1], [2, 2, 2], [1, 2, 0]];
  for (let y = 0; y < size; y++) {
    px[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let col = bg;
      const cx = Math.floor((x - pad) / cell), cy = Math.floor((y - pad) / cell);
      if (cx >= 0 && cx < 3 && cy >= 0 && cy < 3) {
        const lx = x - pad - cx * cell, ly = y - pad - cy * cell;
        const w = cell - gap;
        if (lx >= gap / 2 && lx <= w + gap / 2 && ly >= gap / 2 && ly <= w + gap / 2) {
          const dx = Math.max(gap / 2 + rad - lx, lx - (w + gap / 2 - rad), 0);
          const dy = Math.max(gap / 2 + rad - ly, ly - (w + gap / 2 - rad), 0);
          if (dx * dx + dy * dy <= rad * rad) col = [dark, cream, gold][kind[cy][cx]];
        }
      }
      px.set(col, y * (size * 3 + 1) + 1 + x * 3);
    }
  }
  const head = Buffer.alloc(13);
  head.writeUInt32BE(size, 0); head.writeUInt32BE(size, 4); head[8] = 8; head[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', deflateSync(px)), chunk('IEND', Buffer.alloc(0))]);
}

for (const size of [180, 192, 512]) writeFileSync(new URL(`../icons/icon-${size}.png`, import.meta.url), icon(size));
console.log('icons written');
