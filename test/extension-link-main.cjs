// The real app and window, on what the Settings page says about the browser extension, and on the
// note that asks for an out-of-date extension to be reloaded. Connects to the app's own channel the
// way the native host does. Needs native-host/build from `npm run setup-browser`.
// Run with: npm run build, then electron test/extension-link-main.cjs
const { app, BrowserWindow, Notification } = require('electron');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speed-downloader-link-'));
const profile = path.join(root, 'profile');
fs.mkdirSync(profile, { recursive: true });
fs.writeFileSync(path.join(profile, 'aria2-999999.conf'), 'rpc-secret=left-behind\n');
app.setPath('userData', profile);
app.setPath('downloads', path.join(root, 'downloads'));
const shown = [];
Notification.prototype.show = function show() { shown.push(this.title); };
require('../dist/main.cjs');
setTimeout(() => { console.log('FAIL the check did not finish in time'); app.exit(1); }, 60000);

const bridge = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'native-host', 'build', 'bridge.json'), 'utf8'));
const shipped = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'extension', 'manifest.json'), 'utf8')).version;
const EDGE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/157.0.0.0 Safari/537.36 Edg/157.0.4341.42';
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/156.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (ok, message) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`); if (!ok) process.exitCode = 1; };
const frame = (message) => { const body = Buffer.from(JSON.stringify(message)); const head = Buffer.alloc(4); head.writeUInt32LE(body.length); return Buffer.concat([head, body]); };

async function connectAs(messages) {
  const socket = net.connect(`\\\\.\\pipe\\${bridge.pipe}`);
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
    setTimeout(() => reject(new Error('the app is not listening for the extension')), 5000);
  });
  socket.on('error', () => {});
  socket.write(frame({ type: 'hello', token: bridge.token, origin: bridge.origin }));
  for (const m of messages) socket.write(frame(m));
  await sleep(400);
  socket.destroy();
}

(async () => {
  await app.whenReady();
  let win;
  for (let i = 0; i < 100 && !win; i++) { win = BrowserWindow.getAllWindows()[0]; await sleep(100); }
  if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
  await sleep(1500);
  const js = (code) => win.webContents.executeJavaScript(code);
  await js(`window.api.updateSettings({ language: 'en' })`);
  await js(`document.getElementById('open-settings').click()`);
  await sleep(300);
  const lines = () => js(`[...document.querySelectorAll('#extension-links li')].map((li) => li.dataset.state + ': ' + li.textContent)`);

  check(!fs.existsSync(path.join(profile, 'aria2-999999.conf')), 'an aria2 config left by an earlier run is removed on start');
  const first = await lines();
  check(first.length === 1 && first[0].startsWith('none: Not connected yet'), `before any connection it says so (${first})`);

  await connectAs([{ type: 'about', version: '1.4.0', userAgent: EDGE }]);
  const old = await lines();
  check(old.some((l) => l.startsWith('problem: Edge: the extension is out of date')), `an old Edge extension is shown as out of date (${old})`);
  check(shown.length === 1 && shown[0] === 'Reload the extension in Edge', `a note asks for a reload (${shown})`);
  await connectAs([{ type: 'about', version: '1.4.0', userAgent: EDGE }]);
  check(shown.length === 1, 'the same old extension is not nagged about twice');

  await connectAs([{ type: 'about', version: shipped, userAgent: CHROME }]);
  const both = await lines();
  check(both.some((l) => /^ok: Chrome: last connected Today/.test(l)), `a current Chrome extension shows when it last connected (${both})`);
  check(shown.length === 1, 'a current extension brings no note');

  await connectAs([{ type: 'about', version: shipped, userAgent: EDGE }]);
  const fixed = await lines();
  check(fixed.every((l) => l.startsWith('ok: ')), `after a reload the warning goes away (${fixed})`);
  const saved = JSON.parse(fs.readFileSync(path.join(profile, 'extension-links.json'), 'utf8'));
  check(saved.length === 2 && saved.every((l) => l.version === shipped), 'what was seen is kept for the next start');
  const raw = fs.readFileSync(path.join(profile, 'extension-links.json'), 'utf8');
  check(!/Mozilla|Windows NT/.test(raw), 'the full user agent is not stored');
  app.exit(process.exitCode ?? 0);
})().catch((error) => { console.log(`FAIL ${error}`); app.exit(1); });
