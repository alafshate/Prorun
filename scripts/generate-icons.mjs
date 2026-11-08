import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
const crc32 = (buffer) => {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
};
const chunk = (name, data) => {
  const type = Buffer.from(name),
    size = Buffer.alloc(4),
    crc = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([size, type, data, crc]);
};
const points = [
  [146, 40],
  [69, 140],
  [118, 140],
  [105, 216],
  [190, 108],
  [140, 108],
];
const inside = (x, y) => {
  let hit = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [a, b] = points[i],
      [c, d] = points[j];
    if (b > y !== d > y && x < ((c - a) * (y - b)) / (d - b) + a) hit = !hit;
  }
  return hit;
};
const pixels = Buffer.alloc((256 * 4 + 1) * 256);
for (let y = 0; y < 256; y++)
  for (let x = 0; x < 256; x++) {
    let r = 0,
      g = 0,
      b = 0,
      a = 0;
    for (let sy = 0; sy < 4; sy++)
      for (let sx = 0; sx < 4; sx++) {
        const px = x + (sx + 0.5) / 4,
          py = y + (sy + 0.5) / 4;
        const dx = Math.max(36 - px, px - 220, 0),
          dy = Math.max(36 - py, py - 220, 0);
        if (dx * dx + dy * dy > 36 * 36) continue;
        const color = inside(px, py) ? [165, 237, 154] : [25, 31, 29];
        r += color[0];
        g += color[1];
        b += color[2];
        a++;
      }
    const offset = y * (256 * 4 + 1) + 1 + x * 4;
    if (a) {
      pixels[offset] = r / a;
      pixels[offset + 1] = g / a;
      pixels[offset + 2] = b / a;
      pixels[offset + 3] = (255 * a) / 16;
    }
  }
const header = Buffer.alloc(13);
header.writeUInt32BE(256);
header.writeUInt32BE(256, 4);
header[8] = 8;
header[9] = 6;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(pixels)),
  chunk('IEND', Buffer.alloc(0)),
]);
mkdirSync(new URL('../src-tauri/icons/', import.meta.url), { recursive: true });
writeFileSync(new URL('../src-tauri/icons/icon.png', import.meta.url), png);
const ico = Buffer.alloc(22);
ico.writeUInt16LE(1, 2);
ico.writeUInt16LE(1, 4);
ico.writeUInt16LE(1, 10);
ico.writeUInt16LE(32, 12);
ico.writeUInt32LE(png.length, 14);
ico.writeUInt32LE(22, 18);
writeFileSync(new URL('../src-tauri/icons/icon.ico', import.meta.url), Buffer.concat([ico, png]));
console.log('Generated ProRun PNG and Windows ICO.');
