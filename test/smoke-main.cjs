// Drives the real built app through its real window, using a throwaway profile and a local server.
// The trash test moves one small test file to the Recycle Bin.
const { app, BrowserWindow, nativeTheme } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speed-downloader-smoke-'));
const downloads = path.join(root, 'downloads');
fs.mkdirSync(downloads);
app.setPath('userData', path.join(root, 'profile'));
app.setPath('downloads', downloads);

const out = process.env.SMOKE_OUT ?? root;
const big = crypto.randomBytes(24 * 1024 * 1024);
const small = crypto.randomBytes(2048);
const expected = crypto.createHash('sha256').update(big).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = {};

const server = http.createServer(async (req, res) => {
  res.setMaxListeners(0);
  if (req.url.startsWith('/gone')) { res.writeHead(403); res.end(); return; }
  const body = req.url.startsWith('/speed-downloader-trash-test') ? small : big;
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
  const start = m ? Number(m[1]) : 0;
  const end = m && m[2] ? Math.min(Number(m[2]), body.length - 1) : body.length - 1;
  const h = { 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', ETag: '"1"', 'Content-Type': 'application/octet-stream' };
  if (m) h['Content-Range'] = `bytes ${start}-${end}/${body.length}`;
  res.writeHead(m ? 206 : 200, h);
  let closed = false;
  res.on('close', () => { closed = true; });
  for (let off = start; off <= end && !closed;) {
    const c = body.subarray(off, Math.min(off + 16384, end + 1));
    off += c.length;
    if (!res.write(c)) await new Promise((r) => { res.once('drain', r); res.once('close', r); });
    await sleep(10);
  }
  if (!closed) res.end();
});

require('../dist/main.cjs');

async function shot(win, name) {
  await sleep(350);
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(out, name), image.toPNG());
}

async function main() {
  await app.whenReady();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let win;
  for (let i = 0; i < 100 && !win; i++) { win = BrowserWindow.getAllWindows()[0]; await sleep(100); }
  if (!win) throw new Error('No window');
  if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
  await sleep(800);
  win.show();
  const js = (code) => win.webContents.executeJavaScript(code);
  const rowOf = (name) => `[...document.querySelectorAll('.item')].find((r) => r.querySelector('.name').textContent.includes(${JSON.stringify(name)}))`;
  const statusOf = (name) => js(`${rowOf(name)}?.querySelector('.status').textContent`);
  const click = (name, label) => js(`[...${rowOf(name)}.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? b.textContent) === ${JSON.stringify(label)}).click()`);
  const add = (url) => js(`(() => { const i = document.getElementById('add-url'); i.value = ${JSON.stringify(url)}; document.getElementById('add-form').requestSubmit(); })()`);
  const waitStatus = async (name, want, tries = 400) => { for (let i = 0; i < tries && (await statusOf(name)) !== want; i++) await sleep(100); return statusOf(name); };
  const menuItems = () => js(`[...document.querySelectorAll('#menu button')].map((b) => b.textContent)`);
  const pickMenu = (label) => js(`[...document.querySelectorAll('#menu button')].find((b) => b.textContent === ${JSON.stringify(label)}).click()`);

  // The steps below look up Thai labels, whatever the language of this PC.
  await js(`window.api.updateSettings({ language: 'th' })`);
  await sleep(200);
  results.isolated = await js(`typeof require === 'undefined' && typeof process === 'undefined' && typeof window.api === 'object'`);
  results.title = await js(`document.title`);
  results.emptyVisible = await js(`!document.getElementById('empty').hidden`);
  await shot(win, 'ui-empty.png');

  await add(`${base}/movie-sample.mp4`);
  await sleep(150);
  await add(`${base}/gone-archive.zip`);
  await sleep(150);
  await add(`${base}/speed-downloader-trash-test.pdf`);
  await sleep(600);
  results.newestFirst = await js(`[...document.querySelectorAll('.item .name')].map((n) => n.textContent.split('/').pop())`);

  for (let i = 0; i < 100; i++) {
    if ((await statusOf('movie-sample')) === 'กำลังดาวน์โหลด' && (await js(`${rowOf('movie-sample')}.querySelector('.dots').getAttribute('aria-valuenow')`)) > 20) break;
    await sleep(100);
  }
  results.detailsWhileRunning = await js(`${rowOf('movie-sample')}.querySelector('.details').textContent`);
  results.stampWhileRunning = await js(`${rowOf('movie-sample')}.querySelector('.when').textContent`);
  await shot(win, 'ui-active-light.png');

  await click('movie-sample', 'หยุด');
  results.paused = await waitStatus('movie-sample', 'หยุดชั่วคราว', 50);
  await click('movie-sample', 'โหลดต่อ');
  results.final = await waitStatus('movie-sample', 'เสร็จแล้ว');
  results.stampWhenDone = await js(`${rowOf('movie-sample')}.querySelector('.when').textContent`);

  await js(`(() => { const s = document.getElementById('type-filter'); s.value = 'video'; s.dispatchEvent(new Event('change')); })()`);
  await sleep(100);
  results.videoFilter = await js(`[...document.querySelectorAll('.item .name')].map((n) => n.textContent)`);
  await js(`(() => { const s = document.getElementById('type-filter'); s.value = 'all'; s.dispatchEvent(new Event('change')); })()`);
  await js(`[...document.querySelectorAll('.filter')].find((b) => b.textContent.startsWith('ต้องดูแล')).click()`);
  await sleep(100);
  results.problemFilter = await js(`document.querySelectorAll('.item').length`);
  results.problemText = await js(`document.querySelector('.item .problem').textContent`);
  await js(`[...document.querySelectorAll('.filter')].find((b) => b.textContent.startsWith('ทั้งหมด')).click()`);

  nativeTheme.themeSource = 'dark';
  await sleep(200);
  await waitStatus('speed-downloader-trash-test', 'เสร็จแล้ว', 100);
  await click('speed-downloader-trash-test', 'ตัวเลือกเพิ่มเติม');
  results.menuForFinished = await menuItems();
  await shot(win, 'ui-menu-dark.png');
  const trashFile = path.join(downloads, 'speed-downloader-trash-test.pdf');
  results.trashFileExistedBefore = fs.existsSync(trashFile);
  await pickMenu('ย้ายไฟล์ไปถังขยะ');
  for (let i = 0; i < 50 && fs.existsSync(trashFile); i++) await sleep(100);
  await sleep(200);
  results.trashFileGone = !fs.existsSync(trashFile);
  results.trashRowGone = (await statusOf('speed-downloader-trash-test')) === undefined || (await statusOf('speed-downloader-trash-test')) === null;

  await js(`(() => { const s = document.getElementById('search'); s.value = 'movie'; s.dispatchEvent(new Event('input')); })()`);
  await sleep(150);
  results.searchMovie = await js(`[...document.querySelectorAll('.item .name')].map((n) => n.textContent)`);
  await js(`(() => { const s = document.getElementById('search'); s.value = 'no-such-file'; s.dispatchEvent(new Event('input')); })()`);
  await sleep(150);
  results.searchNoneTitle = await js(`document.getElementById('empty-title').textContent`);
  await js(`(() => { const s = document.getElementById('search'); s.value = ''; s.dispatchEvent(new Event('input')); })()`);
  await js(`document.getElementById('open-settings').click()`);
  await sleep(450);
  results.settingsOpen = await js(`!document.getElementById('settings-view').hidden && document.getElementById('downloads-view').hidden`);
  results.settingsFolder = await js(`document.getElementById('folder-path').textContent === ${JSON.stringify(downloads)}`);
  await shot(win, 'ui-settings-dark.png');
  await js(`(() => { const i = document.getElementById('extra'); i.value = '.DAT, nds; bad!value'; i.dispatchEvent(new Event('change')); })()`);
  await sleep(300);
  results.extraNormalised = await js(`document.getElementById('extra').value`);
  await js(`(() => { const s = document.getElementById('language'); s.value = 'en'; s.dispatchEvent(new Event('change')); })()`);
  await sleep(300);
  results.englishSettingsTitle = await js(`document.getElementById('settings-title').textContent`);
  results.englishHtmlLang = await js(`document.documentElement.lang`);
  await shot(win, 'ui-settings-en.png');
  await js(`document.querySelector('.filter').click()`);
  await sleep(350);
  results.englishRowStatus = await statusOf('movie-sample');
  results.englishRowDetails = await js(`${rowOf('movie-sample')}.querySelector('.when').textContent`);
  results.englishProblem = await js(`${rowOf('gone-archive')}.querySelector('.problem').textContent`);
  results.englishFixes = await js(`[...${rowOf('gone-archive')}.querySelectorAll('.fixes button')].map((b) => b.textContent)`);
  results.leftoverThaiInEnglish = await js(`/[\\u0E00-\\u0E7F]/.test(document.body.innerText.replace(document.getElementById('language').innerText, ''))`);
  await shot(win, 'ui-list-en-dark.png');
  nativeTheme.themeSource = 'light';
  await sleep(200);
  await shot(win, 'ui-list-en-light.png');

  const file = path.join(downloads, 'movie-sample.mp4');
  results.fileHashOk = fs.existsSync(file) && crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') === expected;
  results.filesInFolder = fs.readdirSync(downloads);

  win.close();
  await sleep(300);
  results.closeFreesWindowAndKeepsRunning = BrowserWindow.getAllWindows().length === 0;
  fs.writeFileSync(path.join(out, 'smoke-results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  server.closeAllConnections();
  server.close();
  app.quit();
}

main().catch((error) => {
  console.error('SMOKE FAILED', error);
  fs.writeFileSync(path.join(out, 'smoke-results.json'), JSON.stringify({ ...results, error: String(error) }, null, 2));
  app.exit(1);
});
