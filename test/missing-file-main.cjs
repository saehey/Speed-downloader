// The real window, on what happens when a button cannot do its job: a finished file that went missing,
// a bad link, and an error on the Settings page. Run with: npm run build, then electron test/missing-file-main.cjs
const { app, BrowserWindow, dialog, shell } = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speed-downloader-missing-'));
app.setPath('userData', path.join(root, 'profile'));
app.setPath('downloads', path.join(root, 'downloads'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const body = Buffer.alloc(256 * 1024, 7);
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Length': body.length });
  res.end(body);
});
const shown = [];
shell.showItemInFolder = (file) => { shown.push(file); };
shell.openPath = async (file) => { shown.push(file); return /broken/.test(file) ? 'no program' : ''; };
dialog.showOpenDialog = () => new Promise(() => {});
require('../dist/main.cjs');

const fail = (message) => { console.log(`FAIL ${message}`); process.exitCode = 1; };
const check = (ok, message) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`); if (!ok) process.exitCode = 1; };

(async () => {
  await app.whenReady();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let win;
  for (let i = 0; i < 100 && !win; i++) { win = BrowserWindow.getAllWindows()[0]; await sleep(100); }
  if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
  await sleep(500);
  const js = (code) => win.webContents.executeJavaScript(code);
  await js(`window.api.updateSettings({ language: 'en' })`);
  const finished = async (name) => {
    await js(`window.api.add(${JSON.stringify(`${base}/${name}`)})`);
    for (let i = 0; i < 100; i++) {
      const d = (await js('window.api.getState()')).downloads.find((x) => x.url.endsWith(name));
      if (d?.status === 'completed') return d;
      await sleep(100);
    }
    throw new Error(`${name} did not finish`);
  };
  const rowText = (name) => js(`[...document.querySelectorAll('.item')].find((r) => r.querySelector('.name').textContent.includes(${JSON.stringify(name)}))?.innerText ?? ''`);
  const clickInRow = (name, selector) => js(`[...document.querySelectorAll('.item')].find((r) => r.querySelector('.name').textContent.includes(${JSON.stringify(name)})).querySelector(${JSON.stringify(selector)}).click()`);
  const errorShown = () => js(`document.getElementById('error').hidden ? '' : document.getElementById('error-text').textContent`);

  const d = await finished('moved.bin');
  let zone = '';
  try { zone = fs.readFileSync(path.join(d.dir, `${d.filename}:Zone.Identifier`), 'utf8'); } catch {}
  check(/ZoneId=3/.test(zone) && zone.includes(`HostUrl=${base}/moved.bin`), 'a finished file is marked as coming from the internet');
  await clickInRow('moved.bin', '.controls .icon-button');
  await sleep(200);
  check(shown.length === 1 && !(await rowText('moved.bin')).includes('File not found'), 'a file still in place opens its folder');
  fs.rmSync(path.join(d.dir, d.filename));
  await clickInRow('moved.bin', '.controls .icon-button');
  await sleep(200);
  const missing = await rowText('moved.bin');
  check(missing.includes('File not found') && missing.includes('no longer where it was saved'), 'a missing file says so on its row');
  check(missing.includes('Download again') && missing.includes('Remove from list'), 'it offers a way on');
  check(shown.length === 1, 'Windows was not asked to show a missing file');
  fs.writeFileSync(path.join(d.dir, d.filename), body);
  await clickInRow('moved.bin', '.controls .icon-button');
  await sleep(200);
  check(!(await rowText('moved.bin')).includes('File not found'), 'the mark clears when the file comes back');
  fs.rmSync(path.join(d.dir, d.filename));
  await clickInRow('moved.bin', '.controls .icon-button');
  await sleep(200);
  await js(`[...document.querySelectorAll('.item .fixes button')].find((b) => b.textContent === 'Download again').click()`);
  for (let i = 0; i < 50 && !fs.existsSync(path.join(d.dir, d.filename)); i++) await sleep(100);
  await sleep(500);
  check(fs.existsSync(path.join(d.dir, d.filename)), 'Download again brings the file back');
  check(!(await rowText('moved.bin')).includes('File not found'), 'and the row is normal again');

  const openFails = await finished('broken.bin');
  await js(`window.api.openFile(${JSON.stringify(openFails.id)}).catch((e) => { window.__openError = e.message; })`);
  await sleep(100);
  check((await js('window.__openError')).includes('could not be opened'), 'a file that cannot open explains why, in plain words');

  await js(`document.getElementById('add-url').value = 'not a link'; document.getElementById('add-form').requestSubmit()`);
  await sleep(200);
  check((await errorShown()) === 'This link is not valid.', 'a bad link gets a plain message');
  await js(`document.getElementById('error-close').click()`);
  check((await errorShown()) === '', 'the message can be closed');
  await js(`document.getElementById('add-url').value = ''; document.activeElement.blur(); document.getElementById('add-form').requestSubmit()`);
  check(await js(`document.activeElement.id === 'add-url'`), 'Download with an empty box goes to the box');

  await js(`document.getElementById('open-settings').click()`);
  await js(`document.getElementById('folder').click()`);
  await sleep(150);
  await js(`document.getElementById('folder').click()`);
  await sleep(200);
  const onSettings = await errorShown();
  check(onSettings.includes('already open') && await js(`document.getElementById('error').getBoundingClientRect().height > 0`), 'a second picker says one is open, and shows on the Settings page');
  const box = await js(`document.getElementById('error').getBoundingClientRect().toJSON()`);
  check(box.top >= 48, 'the message sits below the top bar');
  server.closeAllConnections();
  server.close();
  app.exit(process.exitCode ?? 0);
})().catch((error) => { fail(String(error)); app.exit(1); });
