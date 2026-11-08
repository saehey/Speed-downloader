// Captures the real window in both themes and on both pages, with downloads in several states.
const { app, BrowserWindow, nativeTheme } = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speed-downloader-shot-'));
app.setPath('userData', path.join(root, 'profile'));
app.setPath('downloads', path.join(root, 'downloads'));
const out = process.env.SMOKE_OUT ?? root;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const body = Buffer.alloc(32 * 1024 * 1024, 7);
const small = Buffer.alloc(2 * 1024 * 1024, 3);

const server = http.createServer(async (req, res) => {
  res.setMaxListeners(0);
  if (req.url.startsWith('/expired')) { res.writeHead(403); return res.end(); }
  const data = req.url.startsWith('/slow') ? body : small;
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
  const start = m ? Number(m[1]) : 0;
  const end = m && m[2] ? Math.min(Number(m[2]), data.length - 1) : data.length - 1;
  const h = { 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', ETag: '"1"' };
  if (m) h['Content-Range'] = `bytes ${start}-${end}/${data.length}`;
  res.writeHead(m ? 206 : 200, h);
  let closed = false;
  res.on('close', () => { closed = true; });
  for (let off = start; off <= end && !closed;) {
    const c = data.subarray(off, Math.min(off + 4096, end + 1));
    off += c.length;
    if (!res.write(c)) await new Promise((r) => { res.once('drain', r); res.once('close', r); });
    await sleep(req.url.startsWith('/slow') ? 8 : 0);
  }
  if (!closed) res.end();
});

require('../dist/main.cjs');

async function grab(win, name) {
  await sleep(500);
  fs.writeFileSync(path.join(out, name), (await win.webContents.capturePage()).toPNG());
  return true;
}

(async () => {
  await app.whenReady();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let win;
  for (let i = 0; i < 100 && !win; i++) { win = BrowserWindow.getAllWindows()[0]; await sleep(100); }
  if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
  await sleep(600);
  const js = (code) => win.webContents.executeJavaScript(code);
  await js(`window.api.updateSettings({ language: 'th' })`);
  nativeTheme.themeSource = 'light';
  const results = {};
  await grab(win, 'real-empty.png');
  for (const name of ['annual-report-2026.pdf', 'brand-assets-final.zip', 'expired-archive.zip', 'slow/paused-installer.exe', 'slow/conference-recording.mp4', 'slow/team-offsite-highlights.mov']) {
    await js(`window.api.add(${JSON.stringify(`${base}/${name}`)})`);
    await sleep(350);
  }
  await sleep(3500);
  await js(`(async () => window.api.pause((await window.api.getState()).downloads.find((d) => d.url.includes('paused-installer')).id))()`);
  await sleep(1500);
  results.light = await grab(win, 'real-light.png');
  nativeTheme.themeSource = 'dark';
  results.dark = await grab(win, 'real-dark.png');
  await js(`document.querySelector('.item .controls button:last-child').click()`);
  results.menu = await grab(win, 'real-menu-dark.png');
  await js(`document.getElementById('menu').hidePopover(); document.getElementById('open-settings').click()`);
  results.settingsDark = await grab(win, 'real-settings-dark.png');
  nativeTheme.themeSource = 'light';
  results.settingsLight = await grab(win, 'real-settings-light.png');
  results.embeddedFonts = await js(`document.fonts.size`);
  console.log(JSON.stringify(results));
  fs.writeFileSync(path.join(out, 'real-results.json'), JSON.stringify(results));
  server.closeAllConnections();
  server.close();
  app.quit();
})().catch((error) => {
  fs.writeFileSync(path.join(out, 'real-results.json'), JSON.stringify({ error: String(error) }));
  app.exit(1);
});
