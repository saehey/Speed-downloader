import { app } from 'electron';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BridgeConfig } from '../core/bridge.ts';

const HOST_NAME = 'com.downloader.host';
const REGISTRY_KEYS = [
  `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`,
  `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`,
];

/**
 * The project folder in a development run. This file is bundled into dist/main.cjs, so it is one level
 * up, whichever script started Electron; app.getAppPath() would point at a test script's folder.
 */
const projectRoot = (): string => path.resolve(__dirname, '..');

export function extensionDir(): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'extension') : path.join(projectRoot(), 'extension');
}

function extensionOrigin(): string {
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir(), 'manifest.json'), 'utf8')) as { key: string };
  const digest = crypto.createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32);
  const id = [...digest].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
  return `chrome-extension://${id}/`;
}

function setRegistry(key: string, value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('reg.exe', ['add', key, '/ve', '/t', 'REG_SZ', '/d', value, '/f'], { windowsHide: true }, (error) => (error ? reject(error) : resolve()));
  });
}

/**
 * The installed copy connects itself to Chrome and Edge. The host lives in the user's profile
 * because it reads a config file next to itself, and Program Files is not writable.
 */
async function setUpInstalledBridge(): Promise<BridgeConfig> {
  const dir = path.join(app.getPath('userData'), 'native-host');
  fs.mkdirSync(dir, { recursive: true });

  const tokenFile = path.join(dir, 'token');
  let token = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '';
  if (!token) {
    token = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  }
  const userTag = crypto.createHash('sha256').update(os.userInfo().username).digest('hex').slice(0, 12);
  const pipe = `speed-downloader-${userTag}`;
  const origin = extensionOrigin();

  const hostExe = path.join(dir, 'downloader-host.exe');
  const shippedHost = path.join(process.resourcesPath, 'native-host', 'downloader-host.exe');
  // The browser may have the host running, which locks the file. The existing copy still works.
  try {
    fs.copyFileSync(shippedHost, hostExe);
  } catch (error) {
    if (!fs.existsSync(hostExe)) throw error;
  }
  fs.writeFileSync(path.join(dir, 'host-config.txt'), [pipe, token, process.execPath, '--background'].join('\r\n') + '\r\n', { mode: 0o600 });
  const manifest = path.join(dir, `${HOST_NAME}.json`);
  fs.writeFileSync(manifest, JSON.stringify({ name: HOST_NAME, description: 'Connects the Speed Downloader extension to the app', path: hostExe, type: 'stdio', allowed_origins: [origin] }, null, 2));
  await Promise.all(REGISTRY_KEYS.map((key) => setRegistry(key, manifest)));
  return { pipe, token, origin };
}

function developmentBridge(): BridgeConfig | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(projectRoot(), 'native-host', 'build', 'bridge.json'), 'utf8')) as BridgeConfig;
  } catch {
    return null;
  }
}

export async function bridgeConfig(): Promise<BridgeConfig | null> {
  return app.isPackaged ? setUpInstalledBridge() : developmentBridge();
}
