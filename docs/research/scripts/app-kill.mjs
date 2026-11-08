import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Force-closes the real app halfway through a download, opens it again, and counts what the server sends.
// Run `npm run build` first. Usage: node docs/research/scripts/app-kill.mjs
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const body = crypto.randomBytes(48 * 1024 * 1024);
const etag = '"k1"';
let served = 0; const reqs = []; let active = 0;
const server = http.createServer(async (req, res) => {
  reqs.push({ method: req.method, range: req.headers.range ?? null, ifRange: req.headers['if-range'] ?? null });
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
  const start = m ? Number(m[1]) : 0; const end = m && m[2] ? Number(m[2]) : body.length - 1;
  const h = { 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', ETag: etag, 'Content-Type': 'application/octet-stream' };
  if (m) h['Content-Range'] = `bytes ${start}-${end}/${body.length}`;
  res.writeHead(m ? 206 : 200, h);
  if (req.method === 'HEAD') return res.end();
  res.setMaxListeners(0);
  active++; res.on('close', () => active--);
  for (let off = start; off <= end && !res.destroyed;) {
    const c = body.subarray(off, Math.min(off + 65536, end + 1)); off += c.length; served += c.length;
    if (!res.write(c)) await new Promise((r) => { res.once('drain', r); res.once('close', r); });
    await sleep(c.length / (4 * 1024 * 1024) * 1000 * Math.max(1, active)); // 4 MB/s shared by all connections, as in the browser test
  }
  if (!res.destroyed) res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/killed.bin`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-appkill-'));
const env = { ...process.env, SD_ROOT: ROOT, SD_PROFILE: path.join(root, 'profile'), SD_DOWNLOADS: path.join(root, 'dl') };
const electron = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const run = (extra) => { const c = spawn(electron, [path.join(HERE, 'app-kill-child.cjs')], { env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'ignore'] }); c.last = ''; c.stdout.on('data', (d) => { const l = String(d).trim().split('\n').pop(); if (l.startsWith('STATE')) c.last = l; }); return c; };
const first = run({ SD_ADD: url });
let before = 0;
for (let i = 0; i < 120; i++) { await sleep(250); const b = Number(first.last.split(' ')[2] ?? 0); if (b > 14 * 1024 * 1024) { before = b; break; } }
await sleep(1500);
const servedBeforeKill = served;
execFileSync('taskkill', ['/PID', String(first.pid), '/T', '/F'], { stdio: 'ignore' });
await sleep(2000);
const reqsBefore = reqs.length;
const second = run({});
let final = '';
for (let i = 0; i < 240; i++) { await sleep(500); if (second.last.startsWith('STATE completed')) { final = second.last; break; } }
const file = path.join(env.SD_DOWNLOADS, 'killed.bin');
const ok = fs.existsSync(file) && crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') === crypto.createHash('sha256').update(body).digest('hex');
execFileSync('taskkill', ['/PID', String(second.pid), '/T', '/F'], { stdio: 'ignore' });
console.log(JSON.stringify({ progressAtKillMB: Math.round(before / 1048576), servedBeforeKillMB: Math.round(servedBeforeKill / 1048576), totalServedMB: Math.round(served / 1048576), fileMB: 48, final, hashOk: ok, requestsAfterRestart: reqs.slice(reqsBefore).slice(0, 6) }, null, 1));
server.closeAllConnections(); server.close();
await sleep(1000);
try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
process.exit(0);
