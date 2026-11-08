// Measures the real window for design faults a screenshot can hide, in both themes, and writes enlarged
// captures of its controls. Run with SMOKE_OUT set: npm run build, then electron test/quality-main.cjs
const { app, BrowserWindow, nativeTheme } = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speed-downloader-quality-'));
app.setPath('userData', path.join(root, 'profile'));
app.setPath('downloads', path.join(root, 'downloads'));
const out = process.env.SMOKE_OUT ?? root;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const body = Buffer.alloc(16 * 1024 * 1024, 7);
const server = http.createServer(async (req, res) => {
  res.setMaxListeners(0);
  if (req.url.startsWith('/expired')) { res.writeHead(403); return res.end(); }
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
  const start = m ? Number(m[1]) : 0;
  const end = m && m[2] ? Math.min(Number(m[2]), body.length - 1) : body.length - 1;
  res.writeHead(m ? 206 : 200, { 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', ETag: '"1"', ...(m ? { 'Content-Range': `bytes ${start}-${end}/${body.length}` } : {}) });
  let closed = false;
  res.on('close', () => { closed = true; });
  for (let off = start; off <= end && !closed;) {
    const c = body.subarray(off, Math.min(off + 4096, end + 1));
    off += c.length;
    if (!res.write(c)) await new Promise((r) => { res.once('drain', r); res.once('close', r); });
    await sleep(8);
  }
  if (!closed) res.end();
});

require('../dist/main.cjs');

// Runs inside the page. Colours are composited through parents to get what is really on screen.
const AUDIT = `(() => {
  const parse = (c) => { const m = c.match(/[\\d.]+/g)?.map(Number) ?? [0, 0, 0, 0]; return { r: m[0], g: m[1], b: m[2], a: m[3] ?? 1 }; };
  const over = (top, under) => { const a = top.a + under.a * (1 - top.a); return a === 0 ? { r: 0, g: 0, b: 0, a: 0 } : { r: (top.r * top.a + under.r * under.a * (1 - top.a)) / a, g: (top.g * top.a + under.g * under.a * (1 - top.a)) / a, b: (top.b * top.a + under.b * under.a * (1 - top.a)) / a, a }; };
  const toRgb = (c) => { if (!c.startsWith('color(')) return c; const canvas = document.createElement('canvas').getContext('2d'); canvas.fillStyle = c; return canvas.fillStyle; };
  const hexOrRgb = (c) => { const v = toRgb(c); if (v.startsWith('#')) { const n = parseInt(v.slice(1, 7), 16); return { r: n >> 16, g: (n >> 8) & 255, b: n & 255, a: 1 }; } return parse(v); };
  const backgroundOf = (el) => { const layers = []; for (let e = el; e; e = e.parentElement) layers.push(hexOrRgb(getComputedStyle(e).backgroundColor)); return layers.reduceRight((under, top) => over(top, under), { r: 255, g: 255, b: 255, a: 1 }); };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const describe = (el) => (el.id ? '#' + el.id : el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : '')) ;
  const contrast = new Map();
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el) || !['INPUT', 'SELECT', 'BUTTON'].includes(el.tagName) && ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    const s = getComputedStyle(el);
    const value = ratio(hexOrRgb(s.color), backgroundOf(el));
    const large = parseFloat(s.fontSize) >= 24 || (parseFloat(s.fontSize) >= 18.66 && Number(s.fontWeight) >= 700);
    if (value < (large ? 3 : 4.5)) contrast.set(describe(el), +value.toFixed(2));
  }
  const placeholders = [...document.querySelectorAll('input[placeholder]')].filter(visible).map((el) => ({ id: el.id, ratio: +ratio(hexOrRgb(getComputedStyle(el, '::placeholder').color), backgroundOf(el)).toFixed(2) })).filter((p) => p.ratio < 4.5);
  const targets = [];
  const insets = [];
  for (const el of document.querySelectorAll('button, select, input, [role=switch]')) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.height < 28 || r.width < 28) targets.push(describe(el) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
    const s = getComputedStyle(el);
    if (el.tagName === 'SELECT') insets.push({ id: describe(el), appearance: s.appearance, left: s.paddingLeft, right: s.paddingRight, backgroundImage: s.backgroundImage.slice(0, 24) });
  }
  const unnamed = [...document.querySelectorAll('button, select, input')].filter(visible).filter((el) => !(el.textContent.trim() || el.getAttribute('aria-label') || el.title || el.labels?.length)).map(describe);
  const clipped = [...document.querySelectorAll('button, .filter, .card-title, .card-note')].filter(visible).filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => describe(el) + ': ' + el.textContent.slice(0, 24));
  const sizes = [...new Set([...document.querySelectorAll('body *')].filter((el) => visible(el) && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())).map((el) => parseFloat(getComputedStyle(el).fontSize)))].sort((a, b) => a - b);
  return { contrast: [...contrast], placeholders, targets, selects: insets, unnamed, clipped, fontSizes: sizes };
})()`;

async function focusOrder(js, win) {
  // Walks real Tab presses and reports each stop, and whether a focus ring is visible on it.
  const stops = [];
  for (let i = 0; i < 16; i++) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
    await sleep(60);
    stops.push(await js(`(() => { const e = document.activeElement; const s = getComputedStyle(e); return { el: e.id || e.className || e.tagName, ring: s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0 }; })()`));
  }
  return stops;
}

(async () => {
  await app.whenReady();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let win;
  for (let i = 0; i < 100 && !win; i++) { win = BrowserWindow.getAllWindows()[0]; await sleep(100); }
  if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
  await sleep(500);
  const js = (code) => win.webContents.executeJavaScript(code);
  await js(`window.api.updateSettings({ language: 'th' })`);
  for (const name of ['annual-report.pdf', 'expired-archive.zip', 'conference-recording.mp4', 'paused-installer.exe']) {
    await js(`window.api.add(${JSON.stringify(`${base}/${name}`)})`);
    await sleep(300);
  }
  await sleep(1500);
  await js(`(async () => window.api.pause((await window.api.getState()).downloads.find((d) => d.url.includes('paused-installer')).id))()`);
  await sleep(600);
  win.setContentSize(1200, 900);
  await sleep(300);
  const results = {};
  const zoomShot = async (name, expression, pad = 10) => {
    const r = await js(`(() => { ${expression}.scrollIntoView({ block: 'nearest' }); const r = ${expression}.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })()`);
    const whole = await win.webContents.capturePage();
    const size = whole.getSize();
    const scale = size.width / (await js('innerWidth'));
    const x = Math.max(0, Math.floor((r.x - pad) * scale));
    const y = Math.max(0, Math.floor((r.y - pad) * scale));
    const rect = { x, y, width: Math.min(size.width - x, Math.ceil((r.width + pad * 2) * scale)), height: Math.min(size.height - y, Math.ceil((r.height + pad * 2) * scale)) };
    fs.writeFileSync(path.join(out, name), whole.crop(rect).resize({ width: rect.width * 2, quality: 'best' }).toPNG());
  };
  for (const theme of ['light', 'dark']) {
    nativeTheme.themeSource = theme;
    await sleep(400);
    await js(`document.querySelector('.filter').click()`);
    await sleep(200);
    results[`${theme}-list`] = await js(AUDIT);
    await zoomShot(`q-${theme}-filters.png`, `document.querySelector('.filter-row')`);
    await js(`document.getElementById('open-settings').click()`);
    await sleep(300);
    results[`${theme}-settings`] = await js(AUDIT);
    await zoomShot(`q-${theme}-card.png`, `document.getElementById('connections').closest('.panel')`);
    await js(`document.getElementById('schedule-enabled').click()`);
    await sleep(200);
    await sleep(100);
    await zoomShot(`q-${theme}-schedule.png`, `document.getElementById('schedule-start').closest('.panel')`);
    await js(`document.getElementById('schedule-enabled').click()`);
    await js(`document.getElementById('back').click()`);
    await sleep(150);
    await zoomShot(`q-${theme}-row.png`, `document.querySelector('.list')`, 2);
    await zoomShot(`q-${theme}-bar.png`, `document.querySelector('.topbar')`, 0);
  }
  nativeTheme.themeSource = 'light';
  await js(`document.activeElement.blur()`);
  results.tabStops = await focusOrder(js, win);
  fs.writeFileSync(path.join(out, 'quality-results.json'), JSON.stringify(results, null, 1));
  console.log(JSON.stringify(results));
  server.closeAllConnections();
  server.close();
  app.quit();
})().catch((error) => {
  fs.writeFileSync(path.join(out, 'quality-results.json'), JSON.stringify({ error: String(error) }));
  app.exit(1);
});
