import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS } from '../shared/api.ts';
import type { DesktopApi } from '../shared/api.ts';
import type { ApiState, DesktopInfo, NavigateTarget } from '../shared/types.ts';

const api: DesktopApi = {
  getState: () => ipcRenderer.invoke(CHANNELS.getState),
  getDesktop: () => ipcRenderer.invoke(CHANNELS.getDesktop),
  add: (url) => ipcRenderer.invoke(CHANNELS.add, url),
  addVideo: (url) => ipcRenderer.invoke(CHANNELS.addVideo, url),
  openTorrentFile: () => ipcRenderer.invoke(CHANNELS.openTorrentFile),
  startNow: (id) => ipcRenderer.invoke(CHANNELS.startNow, id),
  pause: (id) => ipcRenderer.invoke(CHANNELS.pause, id),
  resume: (id) => ipcRenderer.invoke(CHANNELS.resume, id),
  resumeUnverified: (id) => ipcRenderer.invoke(CHANNELS.resumeUnverified, id),
  restart: (id) => ipcRenderer.invoke(CHANNELS.restart, id),
  replaceUrl: (id, url) => ipcRenderer.invoke(CHANNELS.replaceUrl, id, url),
  remove: (id) => ipcRenderer.invoke(CHANNELS.remove, id),
  trashFile: (id) => ipcRenderer.invoke(CHANNELS.trashFile, id),
  openFile: (id) => ipcRenderer.invoke(CHANNELS.openFile, id),
  showInFolder: (id) => ipcRenderer.invoke(CHANNELS.showInFolder, id),
  chooseFolder: (kind) => ipcRenderer.invoke(CHANNELS.chooseFolder, kind),
  clearCategoryFolder: (kind) => ipcRenderer.invoke(CHANNELS.clearCategoryFolder, kind),
  updateSettings: (patch) => ipcRenderer.invoke(CHANNELS.updateSettings, patch),
  setAutoStart: (enabled) => ipcRenderer.invoke(CHANNELS.setAutoStart, enabled),
  openExtensionFolder: () => ipcRenderer.invoke(CHANNELS.openExtensionFolder),
  onState: (listener) => {
    ipcRenderer.on(CHANNELS.state, (_event, state: ApiState) => listener(state));
  },
  onNavigate: (listener) => {
    ipcRenderer.on(CHANNELS.navigate, (_event, target: NavigateTarget) => listener(target));
  },
  onDesktop: (listener) => {
    ipcRenderer.on(CHANNELS.desktop, (_event, info: DesktopInfo) => listener(info));
  },
};

contextBridge.exposeInMainWorld('api', api);
