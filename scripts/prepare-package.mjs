// Gathers everything the installer ships beside the app: aria2 and its licence, the icon, and uninstall steps.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findAria2, makeIcon } from './shared.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resources = path.join(root, 'resources');
const buildDir = path.join(root, 'build');
const licenceDir = path.join(resources, 'aria2-licence');
fs.mkdirSync(licenceDir, { recursive: true });
fs.mkdirSync(buildDir, { recursive: true });

const aria2 = findAria2();
fs.copyFileSync(aria2, path.join(resources, 'aria2c.exe'));
// aria2 is GPL-2.0-or-later, so its licence text travels with it.
for (const name of ['COPYING', 'AUTHORS', 'README.html']) {
  const source = path.join(path.dirname(aria2), name);
  if (fs.existsSync(source)) fs.copyFileSync(source, path.join(licenceDir, name));
}
fs.writeFileSync(path.join(licenceDir, 'SOURCE.txt'), 'aria2 1.37.0 unmodified. Source: https://github.com/aria2/aria2/releases/tag/release-1.37.0\r\n');

fs.writeFileSync(path.join(buildDir, 'icon.png'), makeIcon(512));

// Removes the browser connection when the app is uninstalled.
fs.writeFileSync(path.join(buildDir, 'installer.nsh'), [
  '!macro customUnInstall',
  '  DeleteRegKey HKCU "Software\\Google\\Chrome\\NativeMessagingHosts\\com.downloader.host"',
  '  DeleteRegKey HKCU "Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.downloader.host"',
  '!macroend',
  '',
].join('\r\n'));

console.log(JSON.stringify({ aria2, licenceFiles: fs.readdirSync(licenceDir) }));
