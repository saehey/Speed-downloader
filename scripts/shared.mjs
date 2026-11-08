// Helpers shared by the build scripts.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { markCoverage } from '../src/shared/mark.ts';

export function findAria2() {
  if (process.env.ARIA2C_PATH) return process.env.ARIA2C_PATH;
  const wingetRoot = path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Packages');
  if (fs.existsSync(wingetRoot)) {
    for (const entry of fs.readdirSync(wingetRoot)) {
      if (!entry.startsWith('aria2.aria2')) continue;
      for (const inner of fs.readdirSync(path.join(wingetRoot, entry))) {
        const exe = path.join(wingetRoot, entry, inner, 'aria2c.exe');
        if (fs.existsSync(exe)) return exe;
      }
    }
  }
  return execFileSync('where.exe', ['aria2c'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data) {
  let c = 0xffffffff;
  for (const value of data) c = CRC_TABLE[(c ^ value) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

/** Draws the app icon as a PNG: the lime dotted mark on a forest green rounded square. */
export function makeIcon(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const radius = size * 0.22;
  const coverage = markCoverage(size, size * 0.17);
  const inRoundedSquare = (x, y) => {
    const dx = Math.max(radius - x, x - (size - 1 - radius), 0);
    const dy = Math.max(radius - y, y - (size - 1 - radius), 0);
    return dx * dx + dy * dy <= radius * radius;
  };
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    for (let x = 0; x < size; x++) {
      if (!inRoundedSquare(x, y)) continue;
      const white = coverage[y * size + x];
      const i = row + 1 + x * 4;
      raw[i] = Math.round(0x2a + (0xd6 - 0x2a) * white);
      raw[i + 1] = Math.round(0x42 + (0xe8 - 0x42) * white);
      raw[i + 2] = Math.round(0x34 + (0x6b - 0x34) * white);
      raw[i + 3] = 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header), pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })), pngChunk('IEND', Buffer.alloc(0))]);
}
