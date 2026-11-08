// Feeds the real interface the worst realistic data through its one data boundary, window.api,
// then measures overflow at several sizes and captures screenshots. Nothing is downloaded.
const { app, BrowserWindow, nativeTheme } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const out = process.env.SMOKE_OUT ?? fs.mkdtempSync(path.join(os.tmpdir(), 'speed-downloader-worst-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speed-downloader-worst-preload-'));
const preload = path.join(root, 'fake-api.cjs');
fs.writeFileSync(preload, `
const { contextBridge, ipcRenderer } = require('electron');
let listener = () => {};
const state = () => ipcRenderer.sendSync('fake-state');
ipcRenderer.on('push', () => listener(state()));
const noop = async () => {};
contextBridge.exposeInMainWorld('api', {
  getState: async () => state(),
  getDesktop: async () => ({ packaged: false, autoStart: false, extensionDir: 'x', version: '1.0.0' }),
  onState: (l) => { listener = l; },
  onNavigate: () => {},
  add: noop, addVideo: noop, startNow: noop, clearCategoryFolder: noop, openTorrentFile: noop, pause: noop, resume: noop, resumeUnverified: noop, restart: noop, replaceUrl: noop, remove: noop, trashFile: noop, openFile: noop, showInFolder: noop, chooseFolder: noop, updateSettings: noop, setAutoStart: noop, openExtensionFolder: noop,
});`);

const base = { kind: 'http', dir: 'C:\\Users\\Aleksandra Wiśniewska-Kowalczyk\\Downloads\\Project archives from the old file server\\2026', status: 'completed', totalBytes: 0, completedBytes: 0, speed: 0, connections: 0, acceptsRanges: true, validator: null, problem: null, referrer: null, userAgent: null, hasCookie: false, createdAt: Date.now(), completedAt: Date.now() };
let n = 0;
const row = (over) => ({ ...base, id: `id-${n++}`, url: 'https://example.com/x', filename: 'file.zip', createdAt: Date.now() - n * 60000, ...over });
const HOUR = 3600000;
const worst = () => [
  row({ filename: 'Q3 Board Deck — FINAL (revised) v12 [approved by legal and finance after the second review meeting].pdf', status: 'downloading', totalBytes: 4.7e9, completedBytes: 1.2e9, speed: 5.4e7, connections: 16 }),
  row({ filename: 'IMG_20250914_183022_HDR_portrait_edited_edited_edited_edited_edited_edited_edited_edited_edited_edited.HEIC', status: 'downloading', totalBytes: 0, completedBytes: 123456, speed: 0, connections: 0 }),
  row({ filename: null, url: 'https://storage.example.com/workspaces/acme/projects/q3-launch/docs/9f8e7d6c5b4a1234567890abcdef1234567890abcdef1234567890abcdef?signature=abcdefghijklmnopqrstuvwxyz0123456789&expires=1893456000', status: 'attention', problem: { kind: 'link-expired', message: 'x' }, completedAt: null }),
  row({ filename: 'a', status: 'paused', totalBytes: 1, completedBytes: 0, completedAt: null }),
  row({ filename: 'รายงานการประชุมคณะกรรมการบริหารประจำไตรมาสที่สาม ฉบับแก้ไขครั้งสุดท้ายพร้อมเอกสารแนบทั้งหมด.docx', status: 'failed', problem: { kind: 'disk', message: 'x' }, completedAt: null }),
  row({ filename: 'Đặng Thị Ngọc Hân — tổng hợp.mkv', status: 'attention', problem: { kind: 'cannot-verify', message: 'x' }, totalBytes: 2.5e11, completedBytes: 1.1e11, completedAt: null }),
  row({ filename: 'نور الهدى عبد الرحمن.mp3', status: 'attention', problem: { kind: 'remote-changed', message: 'x' }, completedAt: null }),
  row({ filename: '王秀英的报告最终版本第十二次修订版本王秀英的报告最终版本第十二次修订版本王秀英的报告.zip', status: 'queued', completedAt: null }),
  row({ filename: '<script>alert(1)</script> & **bold** &amp;.exe', totalBytes: 1 }),
  row({ filename: '🦊 Fox 👩🏽‍💻.iso', totalBytes: 1.2e15 }),
  row({ filename: 'zero-byte.bin', totalBytes: 0, completedBytes: 0 }),
  row({ filename: 'longest-size-text.zip', status: 'paused', totalBytes: 1073636966, completedBytes: 1073636966 - 1, completedAt: null }),
  row({ filename: 'overshoot.zip', status: 'downloading', totalBytes: 100, completedBytes: 142, speed: 1, connections: 1 }),
  row({ filename: 'old-file.pdf', totalBytes: 2048, createdAt: Date.UTC(2021, 0, 3), completedAt: Date.UTC(2021, 0, 4) }),
  row({ kind: 'torrent', filename: null, url: `magnet:?xt=urn:btih:${'a'.repeat(40)}&tr=${'https%3A%2F%2Ftracker.example.com%2Fannounce'.repeat(6)}`, status: 'downloading', totalBytes: 0, completedBytes: 0, connections: 0, speed: 0, completedAt: null }),
  row({ kind: 'torrent', filename: 'A very long torrent folder name with many words in it that keeps going for a while [2026] (complete edition)', status: 'downloading', totalBytes: 8e10, completedBytes: 4e9, connections: 87, speed: 2.3e7, completedAt: null }),
];
const thousand = () => Array.from({ length: 1000 }, (_, i) => row({ filename: `photo-${i}.zip`, totalBytes: 5e6 + i, status: i % 3 === 0 ? 'downloading' : 'completed', completedBytes: 2e6, speed: 1e5, connections: 4 }));

let dataset = worst();
let language = 'th';
const { ipcMain } = require('electron');
ipcMain.on('fake-state', (event) => {
  event.returnValue = { downloads: dataset, engineReady: true, settings: { defaultDir: base.dir, categoryDirs: { video: base.dir, torrent: 'E:\\Torrents' }, maxConcurrent: 3, connections: 8, minSplitSize: '4M', speedLimit: '0', shutdownWhenDone: true, scheduleEnabled: false, scheduleStart: '01:00', scheduleEnd: '06:00', browserCapture: true, extraExtensions: 'dat, nds, ' + 'abcdefgh, '.repeat(30), language } };
});

// Reports each visible element that spills out of its parent or the window.
const OVERFLOW = `(() => {
  const issues = [];
  if (!document.querySelector('.item')) issues.push('no rows were drawn');
  const vw = document.documentElement.clientWidth;
  if (document.documentElement.scrollWidth > vw) issues.push('page scrolls sideways by ' + (document.documentElement.scrollWidth - vw));
  const list = document.getElementById('list');
  if (list.scrollWidth > list.clientWidth + 1) issues.push('list scrolls sideways by ' + (list.scrollWidth - list.clientWidth));
  for (const item of document.querySelectorAll('.item')) {
    const box = item.getBoundingClientRect();
    for (const el of item.querySelectorAll('.controls, .controls button, .fixes button, .status')) {
      const r = el.getBoundingClientRect();
      if (r.width && (r.right > box.right + 1 || r.left < box.left - 1)) issues.push(el.className + ' outside row: ' + item.querySelector('.name').textContent.slice(0, 24));
    }
    const glyph = item.querySelector('.tile svg').getBoundingClientRect();
    if (Math.round(glyph.width) !== Math.round(glyph.height)) issues.push('icon not square ' + glyph.width + 'x' + glyph.height);
    const status = item.querySelector('.status');
    if (status.getBoundingClientRect().height > 30) issues.push('status wrapped: ' + status.textContent);
    const size = item.querySelector('.size');
    if (size.textContent) {
      const text = document.createRange();
      text.selectNodeContents(size);
      const sizeBox = text.getBoundingClientRect();
      const sizeCell = size.getBoundingClientRect();
      const meter = item.querySelector('.meter').getBoundingClientRect();
      if (text.getClientRects().length > 1) issues.push('size wrapped: ' + size.textContent);
      if (sizeBox.right > sizeCell.right + 1) issues.push('size wider than its column: ' + size.textContent);
      if (sizeBox.right > box.right + 1 || sizeBox.left < box.left - 1) issues.push('size outside row: ' + size.textContent);
      const sameLine = meter.top < sizeBox.bottom && meter.bottom > sizeBox.top;
      if (meter.width && sameLine && meter.right > sizeBox.left + 1 && meter.left < sizeBox.right - 1) issues.push('size over the dots: ' + size.textContent);
    }
  }
  for (const t of document.querySelectorAll('.item .details, .item .when, .item .status')) {
    if (/NaN|undefined|null|Infinity/.test(t.textContent)) issues.push('bad text: ' + t.textContent);
  }
  const row = document.querySelector('.filter-row');
  for (const el of row.children) if (el.getBoundingClientRect().right > row.getBoundingClientRect().right + 1) issues.push('filter row overflow: ' + el.id);
  for (const f of document.querySelectorAll('.filter')) if (f.scrollWidth > f.clientWidth + 1) issues.push('filter label clipped: ' + f.textContent);
  const bar = document.querySelector('.topbar');
  if (bar.scrollWidth > bar.clientWidth + 1) issues.push('top bar overflow');
  const scripted = document.querySelectorAll('.item script').length;
  if (scripted) issues.push('markup was injected');
  return [...new Set(issues)];
})()`;

async function main() {
  await app.whenReady();
  const win = new BrowserWindow({ width: 1080, height: 700, show: true, titleBarStyle: 'hidden', titleBarOverlay: { color: '#ffffff', symbolColor: '#000000', height: 44 }, webPreferences: { preload, contextIsolation: true, sandbox: false } });
  await win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  await sleep(500);
  const js = (code) => win.webContents.executeJavaScript(code);
  const push = async () => { win.webContents.send('push'); await sleep(250); };
  const results = {};

  const check = async (label, width, height, shot) => {
    win.setContentSize(width, height);
    await sleep(350);
    results[label] = await js(OVERFLOW);
    if (shot) fs.writeFileSync(path.join(out, shot), (await win.webContents.capturePage()).toPNG());
  };

  await check('th-1080', 1080, 700, 'worst-th-1080.png');
  await check('th-760-minimum', 760, 480, 'worst-th-760.png');
  await check('th-1920', 1920, 1080);
  language = 'en';
  await push();
  await check('en-1080', 1080, 700, 'worst-en-1080.png');
  await check('en-760-minimum', 760, 480, 'worst-en-760.png');
  nativeTheme.themeSource = 'dark';
  await check('en-dark', 1080, 700, 'worst-en-dark.png');
  nativeTheme.themeSource = 'light';

  win.webContents.setZoomFactor(2);
  await check('zoom-200', 1080, 700, 'worst-zoom-200.png');
  win.webContents.setZoomFactor(1);

  await js(`document.getElementById('open-settings').click()`);
  await sleep(400);
  win.setContentSize(760, 480);
  await sleep(300);
  results['settings-760'] = await js(`(() => { const d = document.querySelector('.settings-scroll'); return { sideways: d.scrollWidth > d.clientWidth, rowsOutside: [...d.querySelectorAll('.card select, .card button, .card-actions, .toggle')].filter((el) => el.getBoundingClientRect().right > d.getBoundingClientRect().right).length }; })()`);
  fs.writeFileSync(path.join(out, 'worst-settings-760.png'), (await win.webContents.capturePage()).toPNG());
  await js(`document.querySelector('.filter').click()`);
  results.counts = await js(`document.querySelectorAll('.count').length`);

  dataset = [];
  await push();
  results.emptyVisible = await js(`!document.getElementById('empty').hidden`);

  dataset = thousand();
  win.setContentSize(1080, 700);
  const t0 = Date.now();
  await js(`0`);
  win.webContents.send('push');
  await sleep(50);
  results.thousandRowsRendered = await js(`new Promise((resolve) => { const started = performance.now(); const wait = () => { if (document.querySelectorAll('.item').length === 1000) resolve(Math.round(performance.now() - started)); else requestAnimationFrame(wait); }; wait(); })`);
  results.thousandTotalMs = Date.now() - t0;
  const updates = [];
  for (let i = 0; i < 5; i++) {
    const before = Date.now();
    win.webContents.send('push');
    await js(`new Promise((r) => requestAnimationFrame(() => r()))`);
    updates.push(Date.now() - before);
  }
  results.thousandRowUpdateMs = updates;

  fs.writeFileSync(path.join(out, 'worst-results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  app.exit(0);
}

main().catch((error) => {
  console.error(error);
  fs.writeFileSync(path.join(out, 'worst-results.json'), JSON.stringify({ error: String(error) }, null, 2));
  app.exit(1);
});
