import type { ExtensionStatus } from './extension-link.ts';

import type { FolderKind } from './categories.ts';

export type DownloadStatus =
  | 'queued'
  | 'probing'
  | 'downloading'
  | 'paused'
  | 'completed'
  | 'attention'
  | 'failed';

export type ProblemKind =
  | 'link-expired'
  | 'remote-changed'
  | 'cannot-verify'
  | 'not-found'
  | 'network'
  | 'disk'
  | 'size-mismatch'
  | 'server'
  | 'engine'
  | 'video-drm'
  | 'video-unsupported'
  | 'video-login';

export interface Problem {
  kind: ProblemKind;
  message: string;
}

export interface Validator {
  etag: string | null;
  lastModified: string | null;
  size: number | null;
}

export type Language = 'th' | 'en';

export interface Download {
  id: string;
  /** 'torrent' covers magnet links and .torrent files. 'video' runs through yt-dlp. Older saved records have no kind. */
  kind?: 'http' | 'torrent' | 'video';
  url: string;
  filename: string | null;
  dir: string;
  status: DownloadStatus;
  totalBytes: number;
  completedBytes: number;
  speed: number;
  connections: number;
  acceptsRanges: boolean | null;
  validator: Validator | null;
  problem: Problem | null;
  referrer: string | null;
  userAgent: string | null;
  hasCookie: boolean;
  createdAt: number;
  completedAt: number | null;
  /** Runs even outside the scheduled hours, because the user asked for it. */
  runNow?: boolean;
  /** The quality chosen beside a video in the browser, kept so a resume gets the same one. */
  videoFormat?: string;
  /** A file seen in the player has no useful name of its own, so it takes the page's title. */
  videoTitle?: string;
  videoOrigin?: string;
  /** Sound only, chosen beside a video in the browser, so it belongs with the audio files. */
  audioOnly?: boolean;
  /** The folder was asked for by name, so the per-type folders do not apply. */
  dirChosen?: boolean;
}

export interface AddRequest {
  url: string;
  dir?: string;
  filename?: string;
  referrer?: string;
  userAgent?: string;
  cookie?: string;
}

export interface Settings {
  defaultDir: string;
  /** Folders for particular kinds of file. Any kind not listed uses `defaultDir`. */
  categoryDirs: Partial<Record<FolderKind, string>>;
  maxConcurrent: number;
  connections: number;
  minSplitSize: string;
  speedLimit: string;
  /** Downloads run only between these daily times, as HH:MM, when this is on. */
  /** Turns the computer off once the queue has finished. It applies once, and never survives a restart. */
  shutdownWhenDone: boolean;
  scheduleEnabled: boolean;
  scheduleStart: string;
  scheduleEnd: string;
  browserCapture: boolean;
  extraExtensions: string;
  language: Language;
}

/** Facts that belong to the desktop shell rather than the download queue. */
export interface DesktopInfo {
  packaged: boolean;
  autoStart: boolean;
  extensionDir: string | null;
  version: string;
  extension: ExtensionStatus;
}

/** A place the tray can open the window on. */
export type NavigateTarget = 'settings' | 'problem';

export interface ApiState {
  downloads: Download[];
  settings: Settings;
  engineReady: boolean;
}
