// Builds the native host and writes everything needed to connect Chrome and Edge to this app.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeIcon } from './shared.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = path.join(root, 'native-host', 'build');
const HOST_NAME = 'com.downloader.host';
fs.mkdirSync(buildDir, { recursive: true });

// The extension ID comes from the public key in its manifest. No private key is kept.
const { key } = JSON.parse(fs.readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8'));
if (!key) throw new Error('extension/manifest.json has no key, so the extension ID would change.');
const digest = crypto.createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32);
const extensionId = [...digest].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
const origin = `chrome-extension://${extensionId}/`;
fs.writeFileSync(path.join(root, 'extension', 'icon.png'), makeIcon(48));

const csc = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const relayExe = path.join(buildDir, 'downloader-host.exe');
execFileSync(csc, ['/nologo', '/optimize+', '/target:exe', `/out:${relayExe}`, path.join(root, 'native-host', 'relay.cs')], { stdio: 'pipe' });

// Keep the token across runs so an app already running stays valid.
const bridgePath = path.join(buildDir, 'bridge.json');
const old = fs.existsSync(bridgePath) ? JSON.parse(fs.readFileSync(bridgePath, 'utf8')) : {};
const userTag = crypto.createHash('sha256').update(os.userInfo().username).digest('hex').slice(0, 12);
const bridge = { pipe: `downloader-bridge-${userTag}`, token: old.token ?? crypto.randomBytes(32).toString('hex'), origin };
fs.writeFileSync(bridgePath, JSON.stringify(bridge, null, 2));

const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
fs.writeFileSync(path.join(buildDir, 'host-config.txt'), [bridge.pipe, bridge.token, electron, `"${root}" --background`].join('\r\n') + '\r\n');

const hostManifest = path.join(buildDir, `${HOST_NAME}.json`);
fs.writeFileSync(hostManifest, JSON.stringify({
  name: HOST_NAME,
  description: 'Connects the Downloader extension to the Downloader app',
  path: relayExe,
  type: 'stdio',
  allowed_origins: [origin],
}, null, 2));

const keys = [`HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`, `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`];
fs.writeFileSync(path.join(root, 'native-host', 'register.cmd'), [
  '@echo off',
  'rem Connects Chrome and Edge to Downloader for this Windows user. Double-click in File Explorer.',
  ...keys.map((k) => `reg add "${k}" /ve /t REG_SZ /d "${hostManifest}" /f`),
  'echo.',
  'pause',
  '',
].join('\r\n'));
fs.writeFileSync(path.join(root, 'native-host', 'unregister.cmd'), [
  '@echo off',
  'rem Disconnects Chrome and Edge from Downloader. Double-click in File Explorer.',
  ...keys.map((k) => `reg delete "${k}" /f`),
  'echo.',
  'pause',
  '',
].join('\r\n'));

console.log(JSON.stringify({ extensionId, hostKilobytes: Math.round(fs.statSync(relayExe).size / 1024) }, null, 2));
