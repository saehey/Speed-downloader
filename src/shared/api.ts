import type { FolderKind } from './categories.ts';
import type { ApiState, DesktopInfo, NavigateTarget, Settings } from './types.ts';

/** A finished file can be moved or deleted at any time, so the window is told and can offer a way on. */
export type FileCheck = 'ok' | 'missing';

/** Everything the window can ask for. It passes IDs, never file paths. */
export interface DesktopApi {
  getState(): Promise<ApiState>;
  getDesktop(): Promise<DesktopInfo>;
  add(url: string): Promise<void>;
  addVideo(url: string): Promise<void>;
  openTorrentFile(): Promise<void>;
  startNow(id: string): Promise<void>;
  pause(id: string): Promise<void>;
  resume(id: string): Promise<void>;
  resumeUnverified(id: string): Promise<void>;
  restart(id: string): Promise<void>;
  replaceUrl(id: string, url: string): Promise<void>;
  remove(id: string): Promise<void>;
  trashFile(id: string): Promise<void>;
  openFile(id: string): Promise<FileCheck>;
  showInFolder(id: string): Promise<FileCheck>;
  /** Picks the main folder, or the folder for one kind of file. */
  chooseFolder(kind?: FolderKind): Promise<void>;
  clearCategoryFolder(kind: FolderKind): Promise<void>;
  updateSettings(patch: Partial<Settings>): Promise<void>;
  setAutoStart(enabled: boolean): Promise<void>;
  openExtensionFolder(): Promise<void>;
  onState(listener: (state: ApiState) => void): void;
  onNavigate(listener: (target: NavigateTarget) => void): void;
  onDesktop(listener: (info: DesktopInfo) => void): void;
}

export const CHANNELS = {
  getState: 'downloads:get-state',
  getDesktop: 'desktop:get',
  add: 'downloads:add',
  addVideo: 'downloads:add-video',
  openTorrentFile: 'downloads:open-torrent-file',
  startNow: 'downloads:start-now',
  pause: 'downloads:pause',
  resume: 'downloads:resume',
  resumeUnverified: 'downloads:resume-unverified',
  restart: 'downloads:restart',
  replaceUrl: 'downloads:replace-url',
  remove: 'downloads:remove',
  trashFile: 'downloads:trash-file',
  openFile: 'downloads:open-file',
  showInFolder: 'downloads:show-in-folder',
  chooseFolder: 'settings:choose-folder',
  clearCategoryFolder: 'settings:clear-category-folder',
  updateSettings: 'settings:update',
  setAutoStart: 'desktop:set-auto-start',
  openExtensionFolder: 'desktop:open-extension-folder',
  state: 'downloads:state',
  navigate: 'window:navigate',
  desktop: 'desktop:changed',
} as const;
