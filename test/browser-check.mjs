// Test page for the real browser hand-off. Run it, open the printed address, click each link.
// Logs every request with its client, so a second downloader on the machine would be visible.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const PORT = 8766;
const MB = 1024 * 1024;
// Bodies change on every run, so the ETag must too, or Chrome's cache mixes old and new bytes.
const RUN = crypto.randomBytes(6).toString('hex');
const COOKIE = 'dltest=FAKE_COOKIE_FOR_TESTING';
const downloads = path.join(os.homedir(), 'Downloads');
const resultFile = path.join(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '..', 'native-host', 'build', 'browser-check.json');

const files = {
  'chk-normal.zip': crypto.randomBytes(24 * MB),
  'chk-login.zip': crypto.randomBytes(24 * MB),
  'chk-once.zip': crypto.randomBytes(8 * MB),
  'chk-post.zip': crypto.randomBytes(8 * MB),
  'chk-named.bin': crypto.randomBytes(8 * MB),
  'chk-small.zip': crypto.randomBytes(64 * 1024),
  // Real text: Chrome reports random bytes served as text/plain as application/octet-stream.
  'chk-page.txt': Buffer.alloc(2 * MB, 'This is a plain text test file.\n'),
};
const log = [];
const onceUsed = new Set();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(req) {
  const ua = req.headers['user-agent'] ?? '';
  if (/idm|internet download/i.test(ua) || /Trident/.test(ua)) return 'idm';
  // Only a real browser navigation sends Sec-Fetch-Dest. The app's one-byte check does not.
  if (req.headers['sec-fetch-dest']) return 'browser';
  return req.headers.range === 'bytes=0-0' ? 'app-check' : 'app';
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const name = url.pathname.slice(1);
  res.setMaxListeners(0);
  if (name === '') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': `${COOKIE}; Path=/; SameSite=Lax` });
    return res.end(`<!doctype html><meta charset="utf-8"><title>Downloader check</title><h1>Downloader check</h1>
<p>Click once each, top to bottom. Each line shows <b>[OK]</b> when the server receives it. <b id="count"></b></p><ol>
<li data-n="chk-normal.zip"><a href="/chk-normal.zip">Normal file</a>: goes to the app</li>
<li data-n="chk-login.zip"><a href="/chk-login.zip">File that needs a cookie</a>: goes to the app</li>
<li data-n="chk-named.bin"><a href="/chk-named.bin" download="chk-renamed.bin">Link with a download name</a>: goes to the app as chk-renamed.bin</li>
<li data-n="chk-once.zip"><a href="/chk-once.zip">Single-use link</a>: stays in Chrome</li>
<li data-n="chk-post.zip"><form method="post" action="/chk-post.zip" style="display:inline"><button>POST download</button></form>: stays in Chrome</li>
<li data-n="chk-small.zip"><a href="/chk-small.zip">Small file</a>: stays in Chrome</li>
<li data-n="chk-page.txt"><a href="/chk-page.txt">Text file</a>: stays in Chrome</li></ol>
<script>setInterval(async () => {
  const hit = await (await fetch('/__status')).json();
  const rows = document.querySelectorAll('li');
  rows.forEach((li) => {
    let s = li.querySelector('.ok');
    if (hit.includes(li.dataset.n) && !s) { s = document.createElement('b'); s.className = 'ok'; s.textContent = ' [OK]'; li.append(s); }
  });
  document.getElementById('count').textContent = document.querySelectorAll('.ok').length + ' of ' + rows.length + ' received.';
}, 1000);</script>`);
  }
  if (name === '__status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify([...new Set(log.filter((h) => h.client === 'browser').map((h) => h.name))]));
  }
  const body = files[name];
  const entry = { name, method: req.method, client: client(req), range: req.headers.range ?? null, cookie: (req.headers.cookie ?? '').split('; ').includes(COOKIE), ua: (req.headers['user-agent'] ?? '').slice(0, 50), status: 0, bytes: 0 };
  if (!body) { if (name !== 'favicon.ico') log.push(entry); res.writeHead(404); return res.end(); }
  log.push(entry);
  const deny = (code) => { entry.status = code; res.writeHead(code); res.end(); };
  if (name === 'chk-login.zip' && !entry.cookie) return deny(403);
  if (name === 'chk-post.zip' && req.method !== 'POST') return deny(405);
  if (name === 'chk-once.zip') {
    if (onceUsed.has(name)) return deny(403);
    onceUsed.add(name);
  }
  let start = 0; let end = body.length - 1; let code = 200;
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
  if (m) { start = Number(m[1]); if (m[2]) end = Math.min(Number(m[2]), end); code = 206; }
  const headers = { 'Content-Type': name.endsWith('.txt') ? 'text/plain' : 'application/octet-stream', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', ETag: `"${RUN}"`, 'Content-Disposition': name === 'chk-named.bin' ? undefined : `attachment; filename="${name}"` };
  if (!headers['Content-Disposition']) delete headers['Content-Disposition'];
  if (code === 206) headers['Content-Range'] = `bytes ${start}-${end}/${body.length}`;
  entry.status = code;
  res.writeHead(code, headers);
  let closed = false;
  res.on('close', () => { closed = true; });
  for (let off = start; off <= end && !closed;) {
    const c = body.subarray(off, Math.min(off + 64 * 1024, end + 1));
    off += c.length;
    entry.bytes += c.length;
    if (!res.write(c)) await new Promise((r) => { res.once('drain', r); res.once('close', r); });
    await sleep(10);
  }
  if (!closed) res.end();
});

function report() {
  const expected = { 'chk-normal.zip': 'app', 'chk-login.zip': 'app', 'chk-named.bin': 'app', 'chk-once.zip': 'browser', 'chk-post.zip': 'browser', 'chk-small.zip': 'browser', 'chk-page.txt': 'browser' };
  const saved = (n) => [n, n.replace('chk-named', 'chk-renamed')].filter((f) => fs.existsSync(path.join(downloads, f)));
  const hash = (f) => crypto.createHash('sha256').update(f).digest('hex');
  const cases = Object.entries(expected).map(([name, want]) => {
    const hits = log.filter((h) => h.name === name);
    const file = saved(name)[0] ?? null;
    return {
      name,
      expected: want,
      clicked: hits.length > 0,
      savedAs: file,
      hashOk: file ? hash(fs.readFileSync(path.join(downloads, file))) === hash(files[name]) : false,
      leftovers: fs.readdirSync(downloads).filter((f) => f.startsWith(name) && f !== file),
      clients: Object.fromEntries(['browser', 'app-check', 'app', 'idm'].map((c) => [c, { requests: hits.filter((h) => h.client === c).length, bytes: hits.filter((h) => h.client === c).reduce((s, h) => s + h.bytes, 0) }])),
      statuses: [...new Set(hits.map((h) => `${h.client}:${h.status}`))],
      cookieSentByApp: hits.filter((h) => h.client === 'app').some((h) => h.cookie),
      userAgents: [...new Set(hits.map((h) => h.ua))],
    };
  });
  fs.writeFileSync(resultFile, JSON.stringify({ at: new Date().toISOString(), cases }, null, 2));
}

for (const n of Object.keys(files)) for (const f of [n, n.replace('chk-named', 'chk-renamed')]) fs.rmSync(path.join(downloads, f), { force: true });
server.listen(PORT, '127.0.0.1', () => console.log(`Open http://127.0.0.1:${PORT}/`));
setInterval(report, 1000);
