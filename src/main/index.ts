import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, safeStorage, session, shell, Tray } from 'electron';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { BrowserBridge } from '../core/bridge.ts';
import { decideCapture } from '../core/capture.ts';
import type { BrowserDownload, CaptureDecision } from '../core/capture.ts';
import { DownloadManager } from '../core/manager.ts';
import { probe } from '../core/probe.ts';
import { policyKeepsZone } from '../core/zone.ts';
import type { SecretStore } from '../core/store.ts';
import { CHANNELS } from '../shared/api.ts';
import type { FileCheck } from '../shared/api.ts';
import { FOLDER_KINDS, parseExtensions } from '../shared/categories.ts';
import type { FolderKind } from '../shared/categories.ts';
import { defaultLanguage, MESSAGES } from '../shared/i18n.ts';
import { markCoverage } from '../shared/mark.ts';
import { startTracker } from '../shared/started.ts';
import type { ApiState, DesktopInfo, NavigateTarget, Settings } from '../shared/types.ts';
import { bridgeConfig, extensionDir } from './browser-setup.ts';
import { runShutdownCountdown, SHUTDOWN_ARGS } from './shutdown.ts';
import { linkFromClipboard, trayMenu, trayState } from './tray-menu.ts';
import type { TrayState } from './tray-menu.ts';

const APP_NAME = 'Speed Downloader';
const RISKY_EXTENSIONS = /\.(exe|msi|msp|bat|cmd|com|scr|pif|ps1|vbs|vbe|js|jse|wsf|wsh|hta|lnk|reg|jar|cpl)$/i;
const BACKGROUND_ARG = '--background';
const TITLE_BAR_HEIGHT = 48;
const TRAY_TOOLTIP_MS = 5000;
const ACTIVITY_LOG_LIMIT = 256 * 1024;
const TRAY_BLINK_MS = 300;
const TRAY_BLINK_STEPS = 6;
const TASKBAR_FLASH_MS = 3000;

let manager: DownloadManager;
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let bridge: BrowserBridge | null = null;
let quitting = false;
let trayIconKey = '';
let trayTooltip = '';
let trayTooltipActive = 0;
let trayTooltipAt = 0;
let pickingPath = false;
let trayBlink: NodeJS.Timeout | null = null;
let taskbarFlash: NodeJS.Timeout | null = null;
let startedDownloads: ReturnType<typeof startTracker> | null = null;
const startedInBackground = process.argv.includes(BACKGROUND_ARG);

app.setName(APP_NAME);
// Electron makes a Start menu shortcut for this ID, and notifications are tied to it. A development run sharing
// the installed ID could leave a shortcut to electron.exe, which opens a blank window.
app.setAppUserModelId(app.isPackaged ? 'com.speeddownloader.app' : 'com.speeddownloader.dev');
// The interface is flat text and dots, so a GPU process would only cost memory.
app.disableHardwareAcceleration();

function findAria2(): string {
  const candidates = [
    process.env.ARIA2C_PATH,
    app.isPackaged ? path.join(process.resourcesPath, 'aria2c.exe') : undefined,
    path.join(app.getAppPath(), 'resources', 'aria2c.exe'),
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  const wingetRoot = path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Packages');
  if (fs.existsSync(wingetRoot)) {
    for (const entry of fs.readdirSync(wingetRoot)) {
      if (!entry.startsWith('aria2.aria2')) continue;
      for (const inner of fs.readdirSync(path.join(wingetRoot, entry))) {
        const exe = path.join(wingetRoot, entry, inner, 'aria2c.exe');
        if (fs.existsSync(exe)) return exe;
      }
    }
  }
  const found = execFileSync('where.exe', ['aria2c'], { encoding: 'utf8' }).split(/\r?\n/)[0]?.trim();
  if (found) return found;
  throw new Error('aria2c.exe was not found.');
}

function findBundled(name: string): string | null {
  const candidates = [
    app.isPackaged ? path.join(process.resourcesPath, name) : undefined,
    path.join(app.getAppPath(), 'resources', 'yt-dlp', name),
  ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) ?? null;
}

function findOnPath(name: string): string | null {
  try {
    return execFileSync('where.exe', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/)[0]?.trim() || null;
  } catch {
    return null;
  }
}

const electronSecrets: SecretStore = {
  get available() {
    return safeStorage.isEncryptionAvailable();
  },
  encrypt: (value) => safeStorage.encryptString(value).toString('base64'),
  decrypt: (value) => safeStorage.decryptString(Buffer.from(value, 'base64')),
};

const messages = () => MESSAGES[manager?.state().settings.language ?? defaultLanguage(app.getLocale())];

const paperColor = () => (nativeTheme.shouldUseDarkColors ? '#141c17' : '#f2f0ea');

function titleBarColors() {
  // The window buttons sit on the green top bar.
  return { color: nativeTheme.shouldUseDarkColors ? '#1e3227' : '#2a4234', symbolColor: '#eef2ea', height: TITLE_BAR_HEIGHT };
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 740,
    minWidth: 760,
    minHeight: 480,
    show: false,
    title: APP_NAME,
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarColors(),
    backgroundColor: paperColor(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.removeMenu();
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  // Closing destroys the window to give its memory back. Downloads run in this main process, and
  // the tray opens a new window when one is wanted.
  mainWindow.on('close', () => {
    if (!quitting) showTrayHintOnce();
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  void mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

function showWindow(): void {
  if (!mainWindow) return createWindow();
  mainWindow.show();
  mainWindow.focus();
}

/** Opens the window on a particular page, waiting for it to load if it had to be created. */
function openAt(target: NavigateTarget): void {
  showWindow();
  const contents = mainWindow?.webContents;
  if (contents?.isLoading()) contents.once('did-finish-load', () => contents.send(CHANNELS.navigate, target));
  else contents?.send(CHANNELS.navigate, target);
}

/** The first close should not look as though downloads stopped. */
function showTrayHintOnce(): void {
  const flag = path.join(app.getPath('userData'), 'tray-hint-shown');
  try {
    if (fs.existsSync(flag)) return;
    fs.writeFileSync(flag, '');
  } catch {
    return;
  }
  if (Notification.isSupported()) {
    new Notification({ title: APP_NAME, body: messages().trayHint }).show();
  }
}

function formatSpeed(bytes: number): string {
  const perSecond = messages().perSecond;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB${perSecond}`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB${perSecond}`;
}

const totalSpeed = (state: ApiState) => state.downloads.reduce((sum, d) => sum + (d.status === 'downloading' ? d.speed : 0), 0);

function updateTray(state: ApiState): void {
  if (!tray) return;
  const dark = nativeTheme.shouldUseDarkColorsForSystemIntegratedUI;
  const kind = trayState(state);
  const key = `${kind}:${dark}`;
  if (key !== trayIconKey && !trayBlink) {
    trayIconKey = key;
    tray.setImage(trayIcon(kind, dark));
  }
  const active = state.downloads.filter((d) => d.status === 'downloading').length;
  const tooltip = active ? `${APP_NAME}\n${messages().trayActive(active, formatSpeed(totalSpeed(state)))}` : APP_NAME;
  // Each change is a call into Explorer, which can be slow, so speed updates are spaced out.
  const now = Date.now();
  if (tooltip !== trayTooltip && (active !== trayTooltipActive || now - trayTooltipAt >= TRAY_TOOLTIP_MS)) {
    trayTooltip = tooltip;
    trayTooltipActive = active;
    trayTooltipAt = now;
    tray.setToolTip(tooltip);
  }
}

const TRAY_COLORS: Record<TrayState, (dark: boolean) => [number, number, number]> = {
  idle: (dark) => (dark ? [240, 240, 238] : [55, 53, 47]),
  active: (dark) => (dark ? [92, 192, 138] : [43, 122, 75]),
  paused: (dark) => (dark ? [224, 168, 74] : [143, 91, 8]),
  problem: (dark) => (dark ? [240, 240, 238] : [55, 53, 47]),
};

/** The dotted mark at each screen scale. Its colour shows the state, and a problem adds a red dot. */
function trayIcon(kind: TrayState, dark: boolean): Electron.NativeImage {
  const image = nativeImage.createEmpty();
  const [red, green, blue] = TRAY_COLORS[kind](dark);
  for (const scale of [1, 1.5, 2]) {
    const size = 16 * scale;
    const coverage = markCoverage(size, scale);
    const pixels = Buffer.alloc(size * size * 4);
    coverage.forEach((amount, index) => {
      const i = index * 4;
      pixels[i] = blue;
      pixels[i + 1] = green;
      pixels[i + 2] = red;
      pixels[i + 3] = Math.round(amount * 255);
    });
    if (kind === 'problem') {
      const radius = 3.5 * scale;
      for (let y = 0; y < radius * 2; y++) {
        for (let x = 0; x < radius * 2; x++) {
          const i = (Math.floor(y) * size + (size - 1 - Math.floor(x))) * 4;
          if (Math.hypot(x + 0.5 - radius, y + 0.5 - radius) > radius) continue;
          pixels[i] = 0x2a;
          pixels[i + 1] = 0x35;
          pixels[i + 2] = 0xe0;
          pixels[i + 3] = 0xff;
        }
      }
    }
    image.addRepresentation({ scaleFactor: scale, width: size, height: size, buffer: pixels });
  }
  return image;
}

/** Blinks the tray icon a few times. It is the one sign that still shows when the window is closed. */
function blinkTray(): void {
  if (!tray || trayBlink) return;
  const dark = nativeTheme.shouldUseDarkColorsForSystemIntegratedUI;
  const shown = trayIcon('active', dark);
  const hidden = nativeImage.createFromBuffer(Buffer.alloc(16 * 16 * 4), { width: 16, height: 16 });
  let step = 0;
  trayBlink = setInterval(() => {
    if (!tray || tray.isDestroyed()) return;
    step++;
    if (step < TRAY_BLINK_STEPS) {
      tray.setImage(step % 2 ? hidden : shown);
      return;
    }
    if (trayBlink) clearInterval(trayBlink);
    trayBlink = null;
    trayIconKey = '';
    updateTray(manager.state());
  }, TRAY_BLINK_MS);
}

/** Tells the user a download has begun, without taking the focus from what they are doing. */
function signalStarted(): void {
  noteActivity('download-started');
  blinkTray();
  if (!mainWindow?.isVisible() || mainWindow.isFocused()) return;
  mainWindow.flashFrame(true);
  if (taskbarFlash) clearTimeout(taskbarFlash);
  taskbarFlash = setTimeout(() => {
    taskbarFlash = null;
    mainWindow?.flashFrame(false);
  }, TASKBAR_FLASH_MS);
}

/** The tray menu has no page to show a problem on, so a notification says it. */
function trayProblem(body: string): void {
  if (!Notification.isSupported()) return;
  const note = new Notification({ title: APP_NAME, body });
  note.on('click', showWindow);
  note.show();
}

function showFinishedFile(id: string): void {
  const file = completedPath(id);
  if (fs.existsSync(file)) shell.showItemInFolder(file);
  else trayProblem(messages().fileMissing);
}

async function openTrayMenu(): Promise<void> {
  const state = manager.state();
  const template = trayMenu(state, messages(), {
    open: showWindow,
    openProblems: () => openAt('problem'),
    openSettings: () => openAt('settings'),
    addLink: (url) => {
      try {
        manager.add({ url });
      } catch (error) {
        trayProblem(messages().errors[(error as Error).message.split(':')[0] as string] ?? (error as Error).message);
      }
    },
    pauseAll: () => void manager.pauseAll(),
    resumeAll: () => manager.resumeAll(),
    showFile: showFinishedFile,
    openFolder: () => void shell.openPath(state.settings.defaultDir).then((error) => { if (error) trayProblem(messages().errorOpenFolder); }),
    setCapture: (enabled) => void manager.updateSettings({ browserCapture: enabled }),
    setSchedule: (enabled) => void manager.updateSettings({ scheduleEnabled: enabled }),
    setShutdown: (enabled) => void manager.updateSettings({ shutdownWhenDone: enabled }),
    quit: () => app.quit(),
  }, linkFromClipboard(await clipboard.readText()), formatSpeed(totalSpeed(state)));
  tray?.popUpContextMenu(Menu.buildFromTemplate(template));
}

function createTray(): void {
  tray = new Tray(trayIcon('idle', nativeTheme.shouldUseDarkColorsForSystemIntegratedUI));
  tray.setToolTip(APP_NAME);
  tray.on('click', showWindow);
  tray.on('right-click', () => void openTrayMenu());
}

const asId = (value: unknown): string => {
  if (typeof value !== 'string' || value.length > 64) throw new Error('Invalid download ID.');
  return value;
};
const asUrl = (value: unknown): string => {
  if (typeof value !== 'string' || value.length > 16384) throw new Error('Invalid address.');
  return value.trim();
};

function asSettings(value: unknown): Partial<Settings> {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid settings.');
  const input = value as Record<string, unknown>;
  const patch: Partial<Settings> = {};
  if (typeof input.maxConcurrent === 'number') patch.maxConcurrent = input.maxConcurrent;
  if (typeof input.connections === 'number') patch.connections = input.connections;
  if (typeof input.speedLimit === 'string') patch.speedLimit = input.speedLimit;
  if (typeof input.shutdownWhenDone === 'boolean') patch.shutdownWhenDone = input.shutdownWhenDone;
  if (typeof input.scheduleEnabled === 'boolean') patch.scheduleEnabled = input.scheduleEnabled;
  if (typeof input.scheduleStart === 'string') patch.scheduleStart = input.scheduleStart;
  if (typeof input.scheduleEnd === 'string') patch.scheduleEnd = input.scheduleEnd;
  if (typeof input.browserCapture === 'boolean') patch.browserCapture = input.browserCapture;
  if (typeof input.extraExtensions === 'string') patch.extraExtensions = parseExtensions(input.extraExtensions).join(', ');
  if (input.language === 'th' || input.language === 'en') patch.language = input.language;
  return patch;
}

function completedPath(id: string): string {
  const record = manager.get(id);
  if (!record || record.status !== 'completed' || !record.filename) throw new Error('This file is not finished.');
  return path.join(record.dir, record.filename);
}

function desktopInfo(): DesktopInfo {
  return {
    packaged: app.isPackaged,
    autoStart: app.isPackaged && app.getLoginItemSettings({ args: [BACKGROUND_ARG] }).openAtLogin,
    extensionDir: extensionDir(),
    version: app.getVersion(),
  };
}

/**
 * Notes what the app was doing, for working out where a freeze happened: the last line before one
 * names the step. It holds step names only, never addresses, file names or cookies.
 */
function noteActivity(step: string): void {
  try {
    const file = path.join(app.getPath('userData'), 'activity-log.jsonl');
    if (fs.existsSync(file) && fs.statSync(file).size > ACTIVITY_LOG_LIMIT) fs.rmSync(file, { force: true });
    fs.appendFileSync(file, `${JSON.stringify({ t: new Date().toISOString(), step, version: app.getVersion() })}\n`);
  } catch {
    // Logging must never affect the app.
  }
}

/**
 * Opens the Windows file picker with no owner window. Shell extensions from other programs load
 * into the picker and can stall it, and an owned picker can hold up the owner's window with it.
 */
async function pickPath(step: string, options: Electron.OpenDialogOptions): Promise<Electron.OpenDialogReturnValue> {
  // With no owner the picker can end up behind the window, so a second click must say where it went.
  if (pickingPath) throw new Error(messages().pickerOpen);
  pickingPath = true;
  noteActivity(`${step}-picker-open`);
  try {
    return await dialog.showOpenDialog(options);
  } finally {
    pickingPath = false;
    noteActivity(`${step}-picker-closed`);
  }
}

function registerIpc(): void {
  const handle = (channel: string, listener: (...args: unknown[]) => unknown) => {
    ipcMain.handle(channel, (event, ...args) => {
      if (event.senderFrame?.url !== mainWindow?.webContents.getURL()) throw new Error('Unexpected sender.');
      return listener(...args);
    });
  };
  handle(CHANNELS.getState, () => manager.state());
  handle(CHANNELS.getDesktop, desktopInfo);
  handle(CHANNELS.add, (url) => { manager.add({ url: asUrl(url) }); });
  handle(CHANNELS.addVideo, (url) => { manager.addVideo(asUrl(url)); });
  handle(CHANNELS.startNow, (id) => manager.startNow(asId(id)));
  handle(CHANNELS.openTorrentFile, async () => {
    const result = await pickPath('torrent', { properties: ['openFile'], filters: [{ name: 'BitTorrent', extensions: ['torrent'] }] });
    const file = result.filePaths[0];
    if (!result.canceled && file) manager.addTorrentFile(path.basename(file), fs.readFileSync(file));
  });
  handle(CHANNELS.pause, (id) => manager.pause(asId(id)));
  handle(CHANNELS.resume, (id) => manager.resume(asId(id)));
  handle(CHANNELS.resumeUnverified, (id) => manager.resumeUnverified(asId(id)));
  handle(CHANNELS.restart, (id) => manager.restart(asId(id)));
  handle(CHANNELS.replaceUrl, (id, url) => manager.replaceUrl(asId(id), { url: asUrl(url) }));
  handle(CHANNELS.remove, (id) => manager.remove(asId(id)));
  // The Recycle Bin keeps this reversible, so it needs no extra confirmation step.
  handle(CHANNELS.trashFile, async (id) => {
    const file = completedPath(asId(id));
    if (fs.existsSync(file)) await shell.trashItem(file).catch(() => { throw new Error(messages().errorTrash); });
    await manager.remove(asId(id));
  });
  // Windows gives no sign when the file to show is gone, so this checks first.
  handle(CHANNELS.showInFolder, (id): FileCheck => {
    const file = completedPath(asId(id));
    if (!fs.existsSync(file)) return 'missing';
    shell.showItemInFolder(file);
    return 'ok';
  });
  handle(CHANNELS.openFile, async (id): Promise<FileCheck> => {
    const file = completedPath(asId(id));
    if (!fs.existsSync(file)) return 'missing';
    if (RISKY_EXTENSIONS.test(file)) {
      const m = messages();
      const answer = await dialog.showMessageBox(mainWindow as BrowserWindow, {
        type: 'warning',
        buttons: [m.riskyCancel, m.riskyOpen],
        defaultId: 0,
        cancelId: 0,
        message: m.riskyTitle(path.basename(file)),
        detail: m.riskyDetail,
      });
      if (answer.response !== 1) return 'ok';
    }
    if (await shell.openPath(file)) throw new Error(messages().errorOpenFile);
    return 'ok';
  });
  const asFolderKind = (value: unknown): FolderKind => {
    if (!FOLDER_KINDS.includes(value as FolderKind)) throw new Error('Unknown file type.');
    return value as FolderKind;
  };
  handle(CHANNELS.chooseFolder, async (rawKind) => {
    const kind = rawKind === undefined ? null : asFolderKind(rawKind);
    const { defaultDir, categoryDirs } = manager.state().settings;
    const result = await pickPath('folder', { properties: ['openDirectory', 'createDirectory'], defaultPath: (kind && categoryDirs[kind]) || defaultDir });
    const chosen = result.canceled ? undefined : result.filePaths[0];
    if (!chosen) return;
    noteActivity('folder-save');
    await manager.updateSettings(kind ? { categoryDirs: { ...manager.state().settings.categoryDirs, [kind]: chosen } } : { defaultDir: chosen });
    noteActivity('folder-saved');
  });
  handle(CHANNELS.clearCategoryFolder, (rawKind) => {
    const kind = asFolderKind(rawKind);
    const categoryDirs = { ...manager.state().settings.categoryDirs };
    delete categoryDirs[kind];
    return manager.updateSettings({ categoryDirs });
  });
  handle(CHANNELS.updateSettings, (patch) => manager.updateSettings(asSettings(patch)));
  handle(CHANNELS.setAutoStart, (enabled) => {
    if (!app.isPackaged) throw new Error(messages().errorInstalledOnly);
    app.setLoginItemSettings({ openAtLogin: enabled === true, args: [BACKGROUND_ARG] });
  });
  handle(CHANNELS.openExtensionFolder, async () => {
    if (await shell.openPath(extensionDir())) throw new Error(messages().errorOpenFolder);
  });
}

const CAPTURE_LOG_LIMIT = 256 * 1024;

/** Records why a browser download was or was not taken. Host and file type only, never the path or cookies. */
function logCapture(download: BrowserDownload, decision: CaptureDecision): void {
  try {
    const target = new URL(download.finalUrl || download.url);
    const name = download.filename || target.pathname;
    const dot = name.lastIndexOf('.');
    const row = { t: new Date().toISOString(), host: target.hostname, type: dot > 0 ? name.slice(dot, dot + 10) : '', mime: download.mime ?? null, size: download.totalBytes ?? null, hasFinalUrl: !!download.finalUrl, hasCookie: !!download.cookie, accept: decision.accept, reason: decision.reason };
    const file = path.join(app.getPath('userData'), 'capture-log.jsonl');
    if (fs.existsSync(file) && fs.statSync(file).size > CAPTURE_LOG_LIMIT) fs.rmSync(file, { force: true });
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
  } catch {
    // Logging must never affect a download.
  }
}

/** The queue has run out while "turn off when done" was on. */
async function onQueueFinished(failed: number): Promise<void> {
  const m = messages();
  noteActivity('shutdown-countdown');
  const result = await runShutdownCountdown({
    ask: async () => {
      const answer = await dialog.showMessageBox({
        type: 'warning',
        title: APP_NAME,
        message: m.shutdownTitle,
        detail: m.shutdownDetail(failed),
        buttons: [m.shutdownCancel, m.shutdownNow],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      return answer.response === 1 ? 'now' : 'cancel';
    },
    shutDown: () => {
      noteActivity('shutdown');
      // Tests set this so that they check everything up to the command, without turning off the computer.
      if (process.env.SPEED_DOWNLOADER_TEST_NO_SHUTDOWN) return;
      execFile(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'shutdown.exe'), SHUTDOWN_ARGS, { windowsHide: true }, (error) => {
        if (error && Notification.isSupported()) new Notification({ title: APP_NAME, body: m.shutdownFailed }).show();
      });
    },
  });
  noteActivity(result);
}

/** A note is enough, and opening a window for every file would cost memory and attention. */
function noteCaptured(body: string): void {
  if (mainWindow?.isVisible() || !Notification.isSupported()) return;
  const note = new Notification({ title: messages().trayCaptured, body });
  note.on('click', showWindow);
  note.show();
}

async function startBridge(): Promise<void> {
  const config = await bridgeConfig();
  if (!config) return;
  bridge = new BrowserBridge(config, {
    decide: async (download) => {
      const settings = manager.state().settings;
      const decision = await decideCapture(download, settings.browserCapture, probe, parseExtensions(settings.extraExtensions));
      logCapture(download, decision);
      return decision;
    },
    accepted: (download, decision) => {
      manager.add({
        url: decision.url as string,
        filename: download.filename ?? undefined,
        referrer: download.referrer ?? undefined,
        userAgent: download.userAgent ?? undefined,
        cookie: download.cookie || undefined,
      });
      noteCaptured(download.filename ?? new URL(decision.url as string).hostname);
    },
    videoInfo: (request) => manager.videoChoices(request.url, {
      referrer: request.referrer ?? undefined,
      fallback: request.src ?? undefined,
      userAgent: request.userAgent ?? undefined,
      title: request.title ?? undefined,
      duration: request.duration ?? undefined,
      media: request.media,
    }) as unknown as Promise<Record<string, unknown>>,
    videoAdd: (request) => {
      manager.addVideo(request.url, {
        format: request.format ?? undefined,
        referrer: request.referrer ?? undefined,
        origin: request.origin ?? undefined,
        userAgent: request.userAgent ?? undefined,
        cookie: request.cookie ?? undefined,
        audioOnly: request.audioOnly,
        title: request.title ?? undefined,
      });
      noteCaptured(new URL(request.url).hostname);
    },
  });
  await bridge.listen();
}

/** Follows the Windows policy on keeping "downloaded from the internet" marks. */
function zoneMarksAllowed(): boolean {
  if (process.platform !== 'win32') return false;
  const key = 'Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Attachments';
  const outputs = ['HKCU', 'HKLM'].map((hive) => {
    try {
      return execFileSync('reg.exe', ['query', `${hive}\\${key}`, '/v', 'SaveZoneInformation'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      // The value is missing on most computers, which means the marks are kept.
      return '';
    }
  });
  return policyKeepsZone(outputs);
}

async function boot(): Promise<void> {
  noteActivity('start');
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  manager = new DownloadManager({
    aria2Path: findAria2(),
    ytDlpPath: findBundled('yt-dlp.exe'),
    ffmpegPath: findBundled('ffmpeg.exe') ?? findOnPath('ffmpeg'),
    nodePath: findOnPath('node'),
    stateDir: app.getPath('userData'),
    defaultDir: app.getPath('downloads'),
    secrets: electronSecrets,
    defaultLanguage: defaultLanguage(app.getLocale()),
    markDownloads: zoneMarksAllowed(),
  });
  manager.on('changed', (state: ApiState) => {
    mainWindow?.webContents.send(CHANNELS.state, state);
    updateTray(state);
    if (startedDownloads?.(state.downloads).length) signalStarted();
  });
  manager.on('queue-finished', ({ failed }: { failed: number }) => void onQueueFinished(failed));
  nativeTheme.on('updated', () => {
    mainWindow?.setTitleBarOverlay(titleBarColors());
    updateTray(manager.state());
  });
  registerIpc();
  if (!startedInBackground) createWindow();
  createTray();
  await manager.start();
  // Files that carry on after a restart are not new, so tracking begins here.
  startedDownloads = startTracker();
  startedDownloads(manager.state().downloads);
  // The browser link is optional: a failure here must not stop the app from downloading.
  await startBridge().catch((error: unknown) => console.error('Browser connection is unavailable:', error));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (!argv.includes(BACKGROUND_ARG)) showWindow();
  });
  app.on('window-all-closed', () => { /* Keeps running in the tray. */ });
  app.on('before-quit', (event) => {
    if (quitting) return;
    quitting = true;
    noteActivity('quit');
    event.preventDefault();
    if (trayBlink) clearInterval(trayBlink);
    if (taskbarFlash) clearTimeout(taskbarFlash);
    void Promise.allSettled([bridge?.close(), manager?.close()]).finally(() => {
      tray?.destroy();
      app.exit(0);
    });
  });
  void app.whenReady().then(boot).catch((error: unknown) => {
    dialog.showErrorBox(`${APP_NAME}: ${MESSAGES[defaultLanguage(app.getLocale())].startFailed}`, String(error));
    quitting = true;
    app.exit(1);
  });
}
