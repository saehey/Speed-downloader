// Measures what Chrome or Edge does with a big download: pause and resume, a forced close, a file that
// changes on the server, an expired link, and how many connections it opens. Uses a temporary profile
// and a local server only. Usage: node docs/research/scripts/browser-compare.mjs chrome|edge <outDir>
// Edge's downloads page is built differently, so the pause and resume clicks only work in Chrome.
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const which = process.argv[2] ?? 'chrome';
const out = process.argv[3] ?? os.tmpdir();
const EXE = which === 'edge' ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' : 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROC = which === 'edge' ? 'msedge.exe' : 'chrome.exe';
const PORT = which === 'edge' ? 9361 : 9362;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 16);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), `sd-compare-${which}-`));
const dl = path.join(profile, 'dl');
fs.mkdirSync(dl);
fs.mkdirSync(path.join(profile, 'Default'), { recursive: true });
fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: dl, prompt_for_download: false, directory_upgrade: true }, savefile: { default_directory: dl } }));

// ---- server -------------------------------------------------------------
const SIZE = 48 * 1024 * 1024;
const RATE = 4 * 1024 * 1024; // bytes per second per response
const files = new Map(); // name -> { body, etag, expired, noRange }
const log = [];
const live = new Map(); // name -> Set of responses
let open = 0, peak = 0;
const server = http.createServer(async (req, res) => {
  const name = decodeURIComponent(new URL(req.url, 'http://x').pathname.slice(1));
  const f = files.get(name);
  log.push({ t: Date.now(), name, range: req.headers.range ?? null, ifRange: req.headers['if-range'] ?? null });
  if (!f) { res.writeHead(404); return res.end(); }
  if (f.expired) { res.writeHead(403); return res.end('expired'); }
  const m = !f.noRange && /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
  const body = f.body;
  const ifRangeOk = !req.headers['if-range'] || req.headers['if-range'] === f.etag;
  const ranged = m && ifRangeOk;
  const start = ranged ? Number(m[1]) : 0;
  const end = ranged && m[2] ? Number(m[2]) : body.length - 1;
  const h = { 'Content-Length': end - start + 1, 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${name}"`, ETag: f.etag };
  if (!f.noRange) h['Accept-Ranges'] = 'bytes';
  if (ranged) h['Content-Range'] = `bytes ${start}-${end}/${body.length}`;
  res.writeHead(ranged ? 206 : 200, h);
  open++; peak = Math.max(peak, open);
  if (!live.has(name)) live.set(name, new Set());
  live.get(name).add(res);
  res.setMaxListeners(0);
  let closed = false;
  res.on('close', () => { if (!closed) { closed = true; open--; live.get(name)?.delete(res); } });
  const chunk = 64 * 1024;
  for (let off = start; off <= end && !res.destroyed;) {
    const c = body.subarray(off, Math.min(off + chunk, end + 1));
    off += c.length;
    if (!res.write(c)) await new Promise((r) => { res.once('drain', r); res.once('close', r); });
    await sleep((chunk / RATE) * 1000);
  }
  if (!res.destroyed) res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
/** What a server does to a connection left idle too long during a pause. */
const drop = (name) => { for (const r of live.get(name) ?? []) r.socket?.destroy(); };
const addFile = (name, opts = {}) => { const body = crypto.randomBytes(SIZE); files.set(name, { body, etag: `"${sha(body)}"`, ...opts }); return files.get(name); };

// ---- browser ------------------------------------------------------------
let browser;
function launch() {
  browser = spawn(EXE, [`--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, '--no-first-run', '--no-default-browser-check', '--disable-features=msEdgeSidebarV2,msUndersideButton', 'about:blank'], { stdio: 'ignore', detached: true });
  browser.unref();
}
function kill() {
  const ps = `Get-CimInstance Win32_Process -Filter "Name='${PROC}'" | Where-Object { $_.CommandLine -like '*${path.basename(profile)}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  try { execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'pipe' }); } catch {}
}
async function json(p) {
  for (let i = 0; i < 60; i++) { try { return await (await fetch(`http://127.0.0.1:${PORT}${p}`)).json(); } catch { await sleep(500); } }
  throw new Error('browser did not answer');
}
function connect(url) {
  const ws = new WebSocket(url);
  let id = 0; const wait = new Map(); const listeners = [];
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); } else listeners.forEach((l) => l(m)); };
  const ready = new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const send = async (method, params = {}) => { await ready; const n = ++id; ws.send(JSON.stringify({ id: n, method, params })); return new Promise((r) => wait.set(n, r)); };
  return { send, on: (l) => listeners.push(l), close: () => ws.close(), ready };
}
let cdp, page;
const progress = new Map(); // guid -> last event
const guids = new Map(); // name -> guid
async function attach() {
  const v = await json('/json/version');
  cdp = connect(v.webSocketDebuggerUrl);
  await cdp.ready;
  cdp.on((m) => {
    if (m.method === 'Browser.downloadWillBegin') guids.set(m.params.suggestedFilename, m.params.guid);
    if (m.method === 'Browser.downloadProgress') progress.set(m.params.guid, m.params);
  });
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'default', eventsEnabled: true });
  const t = (await json('/json')).find((x) => x.type === 'page');
  page = connect(t.webSocketDebuggerUrl);
  await page.ready;
  return v.Browser;
}
const go = (url) => page.send('Page.navigate', { url });
const evalPage = async (expr) => (await page.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
const stateOf = (name) => progress.get(guids.get(name));
async function waitState(name, pred, ms) { const end = Date.now() + ms; while (Date.now() < end) { const s = stateOf(name); if (s && pred(s)) return s; await sleep(200); } return stateOf(name); }

// The downloads page is the only way to pause and resume without the mouse.
const ITEMS = `[...document.querySelector('downloads-manager').shadowRoot.querySelectorAll('downloads-item')]`;
async function downloadsPage() { await go(which === 'edge' ? 'edge://downloads/all' : 'chrome://downloads'); await sleep(1500); }
async function itemsText() { return evalPage(`${ITEMS}.map((i) => i.shadowRoot.textContent.replace(/\\s+/g, ' ').trim().slice(0, 220))`); }
async function clickInItem(label) {
  return evalPage(`(() => { for (const i of ${ITEMS}) for (const b of i.shadowRoot.querySelectorAll('cr-button, button, cr-icon-button, [role=button]')) { const t = (b.textContent + ' ' + (b.getAttribute('aria-label') ?? '') + ' ' + (b.id ?? '')).toLowerCase(); if (t.includes('${label}')) { b.click(); return t.trim().slice(0, 60); } } return null; })()`);
}
const finalFile = (name) => path.join(dl, name);
const requestsFor = (name, since = 0) => log.filter((l) => l.name === name && l.t >= since).map(({ range, ifRange }) => ({ range, ifRange }));

const result = { browser: null, scenarios: {} };
try {
  launch();
  result.browser = await attach();
  // Edge's downloads page is not built from the same parts; this records what it shows either way.
  // A. pause, wait, resume
  {
    const f = addFile('pause.bin');
    const t0 = Date.now();
    await go(`${base}/pause.bin`);
    await waitState('pause.bin', (s) => s.receivedBytes > 8 * 1024 * 1024, 20000);
    await downloadsPage();
    const paused = await clickInItem('pause');
    await sleep(3000);
    const atPause = stateOf('pause.bin')?.receivedBytes;
    const resumed = await clickInItem('resume');
    const done = await waitState('pause.bin', (s) => s.state !== 'inProgress', 60000);
    const file = finalFile('pause.bin');
    result.scenarios.pauseResume = { pausedButton: paused, resumedButton: resumed, atPauseMB: Math.round((atPause ?? 0) / 1048576), state: done?.state, hashOk: file && fs.existsSync(file) ? sha(fs.readFileSync(file)) === sha(f.body) : false, requests: requestsFor('pause.bin', t0), peakConnections: peak };
  }
  // B. browser closed by force halfway, then opened again
  {
    const f = addFile('crash.bin');
    const t0 = Date.now();
    await go(`${base}/crash.bin`);
    await waitState('crash.bin', (s) => s.receivedBytes > 12 * 1024 * 1024, 20000);
    const before = stateOf('crash.bin')?.receivedBytes;
    cdp.close(); page.close(); kill(); await sleep(2500);
    progress.clear();
    launch();
    await attach();
    await sleep(3000);
    const autoRequests = requestsFor('crash.bin', t0).length;
    await downloadsPage();
    const shownAfterRestart = await itemsText();
    const resumed = await clickInItem('resume');
    await sleep(500);
    const retried = resumed ? null : await clickInItem('retry');
    await sleep(15000 + SIZE / RATE * 1000);
    const parts = fs.readdirSync(dl);
    const whole = parts.map((p) => path.join(dl, p)).find((p) => fs.statSync(p).size === SIZE && sha(fs.readFileSync(p)) === sha(f.body));
    const leftovers = parts.filter((p) => p.startsWith('crash'));
    result.scenarios.forcedClose = { beforeMB: Math.round(before / 1048576), requestsBeforeClick: autoRequests, shownAfterRestart, resumedButton: resumed, retriedButton: retried, completeIntactFileFound: Boolean(whole), filesNamedCrash: leftovers, requests: requestsFor('crash.bin', t0) };
  }
  // C. the file changes on the server while paused
  {
    const f = addFile('changed.bin');
    const t0 = Date.now();
    await go(`${base}/changed.bin`);
    await waitState('changed.bin', (s) => s.receivedBytes > 8 * 1024 * 1024, 20000);
    await downloadsPage();
    await clickInItem('pause');
    await sleep(1500);
    drop('changed.bin');
    await sleep(500);
    const oldHash = sha(f.body);
    const newBody = crypto.randomBytes(SIZE);
    f.body = newBody; f.etag = `"${sha(newBody)}"`;
    await clickInItem('resume');
    const done = await waitState('changed.bin', (s) => s.state !== 'inProgress', 60000);
    const file = finalFile('changed.bin');
    const got = file && fs.existsSync(file) ? sha(fs.readFileSync(file)) : null;
    result.scenarios.changedOnServer = { state: done?.state, result: got === sha(newBody) ? 'restarted and got the new file' : got === oldHash ? 'kept the old file (fetched before the change)' : got ? 'MIXED: corrupt' : 'no file', requests: requestsFor('changed.bin', t0) };
  }
  // C2. paused long enough that the server dropped the connection, file unchanged
  {
    const f = addFile('longpause.bin');
    const t0 = Date.now();
    await go(`${base}/longpause.bin`);
    await waitState('longpause.bin', (s) => s.receivedBytes > 8 * 1024 * 1024, 20000);
    await downloadsPage();
    await clickInItem('pause');
    await sleep(1500);
    drop('longpause.bin');
    await sleep(500);
    await clickInItem('resume');
    const done = await waitState('longpause.bin', (s) => s.state !== 'inProgress', 60000);
    const file = finalFile('longpause.bin');
    result.scenarios.longPause = { state: done?.state, hashOk: fs.existsSync(file) && sha(fs.readFileSync(file)) === sha(f.body), requests: requestsFor('longpause.bin', t0) };
  }
  // D. the link expires while paused
  {
    const f = addFile('expired.bin');
    const t0 = Date.now();
    await go(`${base}/expired.bin`);
    await waitState('expired.bin', (s) => s.receivedBytes > 8 * 1024 * 1024, 20000);
    await downloadsPage();
    await clickInItem('pause');
    await sleep(1500);
    drop('expired.bin');
    await sleep(500);
    f.expired = true;
    await clickInItem('resume');
    await sleep(4000);
    await sleep(4000);
    result.scenarios.expiredLink = { state: stateOf('expired.bin')?.state, shown: await itemsText(), requests: requestsFor('expired.bin', t0) };
  }
  // E. a server that does not allow ranges, closed by force halfway
  {
    addFile('norange.bin', { noRange: true });
    const t0 = Date.now();
    await go(`${base}/norange.bin`);
    await waitState('norange.bin', (s) => s.receivedBytes > 8 * 1024 * 1024, 20000);
    await downloadsPage();
    const pausable = await clickInItem('pause');
    await sleep(1500);
    drop('norange.bin');
    await sleep(500);
    await clickInItem('resume');
    await sleep(2500);
    await sleep(3000);
    result.scenarios.noRanges = { pauseButton: pausable, received: Math.round((stateOf('norange.bin')?.receivedBytes ?? 0) / 1048576), requests: requestsFor('norange.bin', t0) };
  }
  // F. the Mark of the Web on what the browser saved
  {
    const file = finalFile('pause.bin');
    let zone = null;
    try { zone = fs.readFileSync(`${file}:Zone.Identifier`, 'utf8'); } catch {}
    result.scenarios.markOfTheWeb = { zone: zone?.replace(/\r\n/g, ' | ') ?? null };
  }
} catch (e) {
  result.error = String(e?.stack ?? e);
} finally {
  try { cdp?.close(); page?.close(); } catch {}
  kill();
  server.closeAllConnections(); server.close();
  fs.writeFileSync(path.join(out, `compare-${which}.json`), JSON.stringify(result, null, 1));
  console.log(JSON.stringify(result, null, 1));
  await sleep(1500);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(0);
}
