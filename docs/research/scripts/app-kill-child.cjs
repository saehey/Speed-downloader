// Runs the real app with its own profile and adds one download when asked. The parent kills it.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
app.setPath('userData', process.env.SD_PROFILE);
app.setPath('downloads', process.env.SD_DOWNLOADS);
require(path.join(process.env.SD_ROOT, 'dist', 'main.cjs'));
(async () => {
  await app.whenReady();
  let win;
  for (let i = 0; i < 100 && !win; i++) { win = BrowserWindow.getAllWindows()[0]; await new Promise((r) => setTimeout(r, 100)); }
  if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
  if (process.env.SD_ADD) await win.webContents.executeJavaScript(`window.api.add(${JSON.stringify(process.env.SD_ADD)})`);
  setInterval(async () => {
    const s = await win.webContents.executeJavaScript('window.api.getState()');
    const d = s.downloads[0];
    if (d) console.log(`STATE ${d.status} ${d.completedBytes}`);
  }, 500);
})();
