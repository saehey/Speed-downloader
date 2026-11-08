// Downloads the pinned official yt-dlp build once and checks it against the release's own checksums.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '2026.10.26';
const BASE = `https://github.com/yt-dlp/yt-dlp/releases/download/${VERSION}`;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'resources', 'yt-dlp');
const exe = path.join(dir, 'yt-dlp.exe');
fs.mkdirSync(dir, { recursive: true });

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

async function fetchBytes(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

const sums = (await fetchBytes(`${BASE}/SHA2-256SUMS`)).toString('utf8');
const expected = /^([0-9a-f]{64})\s+yt-dlp\.exe$/m.exec(sums)?.[1];
if (!expected) throw new Error('The release lists no checksum for yt-dlp.exe.');

if (fs.existsSync(exe) && sha256(fs.readFileSync(exe)) === expected) {
  console.log(`yt-dlp ${VERSION} is already here.`);
} else {
  const data = await fetchBytes(`${BASE}/yt-dlp.exe`);
  if (sha256(data) !== expected) throw new Error('yt-dlp.exe does not match the release checksum, so it was not saved.');
  fs.writeFileSync(exe, data);
  console.log(`yt-dlp ${VERSION} saved, ${data.length} bytes, checksum ${expected}.`);
}
fs.writeFileSync(path.join(dir, 'SOURCE.txt'), `yt-dlp ${VERSION} unmodified. Licence and source: https://github.com/yt-dlp/yt-dlp/releases/tag/${VERSION}\r\n`);
