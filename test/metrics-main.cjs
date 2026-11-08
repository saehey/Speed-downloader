// Measures the app's own memory and CPU with 200 finished rows: window open, then closed to the tray.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speed-downloader-metrics-'));
const profile = path.join(root, 'profile');
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
app.setPath('downloads', path.join(root, 'downloads'));
const row = (i) => ({ id: `row-${i}`, kind: 'http', url: `https://example.com/file-${i}.zip`, filename: `file-${i}.zip`, dir: root, status: 'completed', totalBytes: 5e7, completedBytes: 5e7, speed: 0, connections: 0, acceptsRanges: true, validator: null, problem: null, referrer: null, userAgent: null, hasCookie: false, createdAt: Date.now() - i * 1000, completedAt: Date.now() });
fs.writeFileSync(path.join(profile, 'downloads.json'), JSON.stringify({ version: 1, settings: { language: 'th' }, cookies: {}, downloads: Array.from({ length: 200 }, (_, i) => row(i)) }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

require('../dist/main.cjs');

function snapshot() {
  const metrics = app.getAppMetrics();
  return {
    processes: metrics.map((p) => p.type).join(','),
    memoryMB: Math.round(metrics.reduce((sum, p) => sum + p.memory.workingSetSize, 0) / 1024),
    privateMB: Math.round(metrics.reduce((sum, p) => sum + (p.memory.privateBytes ?? 0), 0) / 1024),
  };
}
/** Chromium reports CPU use since the previous call, so the first call only starts the clock. */
async function cpuOver(ms) {
  app.getAppMetrics();
  await sleep(ms);
  return +app.getAppMetrics().reduce((sum, p) => sum + p.cpu.percentCPUUsage, 0).toFixed(2);
}

(async () => {
  await app.whenReady();
  let win;
  for (let i = 0; i < 100 && !win; i++) { win = BrowserWindow.getAllWindows()[0]; await sleep(100); }
  await sleep(6000);
  const open = { ...snapshot(), idleCpuPercent: await cpuOver(5000) };
  win.close();
  await sleep(8000);
  const tray = { ...snapshot(), idleCpuPercent: await cpuOver(5000) };
  const report = JSON.stringify({ open, tray }, null, 1);
  console.log(report);
  if (process.env.METRICS_OUT) fs.writeFileSync(process.env.METRICS_OUT, report);
  app.quit();
})().catch((error) => {
  console.error(error);
  app.exit(1);
});
