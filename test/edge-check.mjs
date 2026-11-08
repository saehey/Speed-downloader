// Runs the browser hand-off check in Microsoft Edge with a temporary profile, using real mouse
// clicks sent over the DevTools protocol. Your normal Edge profile is not touched.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const DEBUG_PORT = 9347;
const PAGE = 'http://127.0.0.1:8766/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'speed-downloader-edge-'));
const downloads = path.join(os.homedir(), 'Downloads');

fs.mkdirSync(path.join(profile, 'Default'), { recursive: true });
fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false }, savefile: { default_directory: downloads } }));

const page = spawn(process.execPath, [path.join(root, 'test', 'browser-check.mjs')], { stdio: 'ignore' });
await sleep(1500);
const edge = spawn(EDGE, [`--user-data-dir=${profile}`, `--remote-debugging-port=${DEBUG_PORT}`, '--no-first-run', '--no-default-browser-check', `--load-extension=${path.join(root, 'extension')}`, PAGE], { stdio: 'ignore', detached: true });
edge.unref();

function stopEdge() {
  const ps = `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${profile}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  try { execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'pipe' }); } catch { /* Already gone. */ }
}

async function target() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json();
      const found = list.find((t) => t.type === 'page' && t.url.startsWith(PAGE));
      if (found) return found;
    } catch { /* Edge is still starting. */ }
    await sleep(500);
  }
  throw new Error('Edge did not open the page');
}

const result = { edgeVersion: null, extensionSeen: false, labels: [], received: null };
try {
  const t = await target();
  const version = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json();
  result.edgeVersion = version.Browser;
  const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json();
  result.extensionSeen = list.some((x) => x.url.includes('kmgjcjjcnbhhfgecajfmdpiopdicilif'));

  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let nextId = 1;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message.result ?? message.error);
      pending.delete(message.id);
    }
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result?.value;

  await send('Page.bringToFront');
  await sleep(1500);
  const names = await evaluate(`[...document.querySelectorAll('li')].map((li) => li.dataset.n)`);
  for (const name of names) {
    const box = await evaluate(`(() => { const el = document.querySelector('li[data-n="${name}"] a, li[data-n="${name}"] button'); const r = el.getBoundingClientRect(); return { x: r.left + 8, y: r.top + r.height / 2 }; })()`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    result.labels.push(name);
    await sleep(7000);
  }
  result.received = await evaluate(`document.getElementById('count')?.textContent`);
  await sleep(5000);
  ws.close();
} finally {
  stopEdge();
  page.kill();
  await sleep(500);
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
const report = path.join(root, 'native-host', 'build', 'browser-check.json');
console.log(JSON.stringify(result));
const data = JSON.parse(fs.readFileSync(report, 'utf8'));
for (const c of data.cases) {
  const verdict = c.expected === 'app' ? c.clients.app.requests > 0 : c.clients.app.requests === 0;
  console.log(`${verdict && c.hashOk ? 'PASS' : 'CHECK'} ${c.name} expected=${c.expected} saved=${c.savedAs} hash=${c.hashOk} browser=${c.clients.browser.requests}/${c.clients.browser.bytes} check=${c.clients['app-check'].requests} app=${c.clients.app.requests}/${c.clients.app.bytes} idm=${c.clients.idm.requests}`);
}
process.exit(0);
