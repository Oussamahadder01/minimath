#!/usr/bin/env node
// Draw the MiniMath icon (a white radical sign over x on a blue rounded
// square) without image libraries, and write the PNG sizes the web app,
// Office add-in and Tauri need. `tauri icon` derives .ico/.icns from
// assets/icon-1024.png.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { PROJECT_ROOT } from "../src/config.mjs";

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buffer) => {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function distanceToSegment(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Shapes in unit coordinates (0..1).
const RADICAL = [[0.16, 0.56], [0.25, 0.5], [0.36, 0.76], [0.5, 0.22], [0.86, 0.22]];
const X_STROKES = [
  [[0.56, 0.4], [0.8, 0.74]],
  [[0.8, 0.4], [0.56, 0.74]],
];

function coverage(u, v) {
  // Rounded-square background mask.
  const r = 0.2;
  const qx = Math.max(Math.abs(u - 0.5) - (0.5 - r), 0);
  const qy = Math.max(Math.abs(v - 0.5) - (0.5 - r), 0);
  const inside = Math.hypot(qx, qy) <= r;
  if (!inside) return null;
  let ink = false;
  for (let i = 0; i + 1 < RADICAL.length; i++) if (distanceToSegment(u, v, RADICAL[i], RADICAL[i + 1]) < 0.035) ink = true;
  for (const [a, b] of X_STROKES) if (distanceToSegment(u, v, a, b) < 0.032) ink = true;
  return ink;
}

function draw(size) {
  const samples = 4;
  const rgba = Buffer.alloc(size * size * 4);
  const blue = [31, 95, 209];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bg = 0;
      let fg = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const c = coverage((x + (sx + 0.5) / samples) / size, (y + (sy + 0.5) / samples) / size);
          if (c === null) continue;
          if (c) fg++;
          else bg++;
        }
      }
      const total = samples * samples;
      const alpha = (bg + fg) / total;
      const white = bg + fg === 0 ? 0 : fg / (bg + fg);
      const o = (y * size + x) * 4;
      for (let k = 0; k < 3; k++) rgba[o + k] = Math.round(blue[k] * (1 - white) + 255 * white);
      rgba[o + 3] = Math.round(alpha * 255);
    }
  }
  return encodePng(size, rgba);
}

const outputs = [
  ["assets/icon-1024.png", 1024],
  ["web/icon-32.png", 32],
  ["web/icon-192.png", 192],
  ["office/assets/icon-16.png", 16],
  ["office/assets/icon-32.png", 32],
  ["office/assets/icon-64.png", 64],
  ["office/assets/icon-80.png", 80],
];
for (const [path, size] of outputs) {
  const target = join(PROJECT_ROOT, path);
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, draw(size));
  console.log(`${path} (${size}x${size})`);
}
