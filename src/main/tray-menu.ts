import type { MenuItemConstructorOptions } from 'electron';
import type { Messages } from '../shared/i18n.ts';
import { withinWindow } from '../shared/schedule.ts';
import type { ApiState, Download } from '../shared/types.ts';

export type TrayState = 'idle' | 'active' | 'paused' | 'problem';

export interface TrayActions {
  open(): void;
  openProblems(): void;
  openSettings(): void;
  addLink(url: string): void;
  pauseAll(): void;
  resumeAll(): void;
  showFile(id: string): void;
  openFolder(): void;
  setCapture(enabled: boolean): void;
  setSchedule(enabled: boolean): void;
  setShutdown(enabled: boolean): void;
  quit(): void;
}

const RECENT_FILES = 5;
const MAX_LABEL = 44;

const isRunning = (status: string) => status === 'downloading' || status === 'probing' || status === 'queued';
/** A file Defender flagged needs the user as much as a failed download does. */
const hasProblem = (d: Pick<Download, 'status' | 'scan'>) => d.status === 'attention' || d.status === 'failed' || d.scan === 'threat';

/** What the tray icon should say. A problem matters most, because it needs the user to act. */
export function trayState(state: ApiState): TrayState {
  const statuses = state.downloads.map((d) => d.status);
  if (state.downloads.some(hasProblem)) return 'problem';
  if (statuses.some((s) => s === 'downloading' || s === 'probing')) return 'active';
  if (statuses.some((s) => s === 'paused' || s === 'queued')) return 'paused';
  return 'idle';
}

/** Accepts one web address or magnet link from the clipboard, and names it by host only. */
export function linkFromClipboard(text: string): { url: string; label: string } | null {
  const url = text.trim();
  if (!url || url.length > 16384 || /\s/.test(url)) return null;
  if (/^magnet:\?/i.test(url)) return { url, label: 'magnet' };
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? { url, label: parsed.hostname } : null;
  } catch {
    return null;
  }
}

/** Windows menus read "&" as a keyboard shortcut marker, and long file names keep their ending. */
function menuLabel(text: string): string {
  const parts = [...text];
  const short = parts.length > MAX_LABEL ? `${parts.slice(0, MAX_LABEL - 13).join('')}â€¦${parts.slice(-12).join('')}` : text;
  return short.replaceAll('&', '&&');
}

/** Everything the tray offers. It is rebuilt each time it opens, so it costs nothing until then. */
export function trayMenu(state: ApiState, m: Messages, actions: TrayActions, clipboard: { url: string; label: string } | null, speedText: string, now = new Date()): MenuItemConstructorOptions[] {
  const { downloads, settings } = state;
  const downloading = downloads.filter((d) => d.status === 'downloading');
  const problems = downloads.filter(hasProblem).length;
  const recent = downloads
    .filter((d) => d.status === 'completed' && d.filename)
    .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))
    .slice(0, RECENT_FILES);
  const waiting = settings.scheduleEnabled && !withinWindow(now, settings.scheduleStart, settings.scheduleEnd);

  const status: MenuItemConstructorOptions[] = [
    { label: downloading.length ? m.trayActive(downloading.length, speedText) : m.trayIdle, enabled: false },
  ];
  if (waiting) status.push({ label: m.waitingSchedule(settings.scheduleStart), enabled: false });
  if (problems) status.push({ label: m.trayProblems(problems), click: () => actions.openProblems() });

  return [
    ...status,
    { type: 'separator' },
    { label: m.trayOpen, click: () => actions.open() },
    clipboard
      ? { label: m.trayAddLink(menuLabel(clipboard.label)), click: () => actions.addLink(clipboard.url) }
      : { label: m.trayAddLinkNone, enabled: false },
    { type: 'separator' },
    { label: m.trayPauseAll, enabled: downloads.some((d) => isRunning(d.status)), click: () => actions.pauseAll() },
    { label: m.trayResumeAll, enabled: downloads.some((d) => d.status === 'paused'), click: () => actions.resumeAll() },
    { type: 'separator' },
    {
      label: m.trayRecent,
      enabled: recent.length > 0,
      submenu: recent.map((d) => ({ label: menuLabel(d.filename as string), click: () => actions.showFile(d.id) })),
    },
    { label: m.trayOpenFolder, click: () => actions.openFolder() },
    { type: 'separator' },
    { label: m.capture, type: 'checkbox', checked: settings.browserCapture, click: (item) => actions.setCapture(item.checked) },
    { label: m.scheduleEnabled, type: 'checkbox', checked: settings.scheduleEnabled, click: (item) => actions.setSchedule(item.checked) },
    { label: m.shutdownWhenDone, type: 'checkbox', checked: settings.shutdownWhenDone, click: (item) => actions.setShutdown(item.checked) },
    { label: m.settings, click: () => actions.openSettings() },
    { type: 'separator' },
    { label: m.trayQuit, click: () => actions.quit() },
  ];
}
