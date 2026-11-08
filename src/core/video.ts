import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { ProblemKind } from '../shared/types.ts';

export interface VideoJobOptions {
  ytDlpPath: string;
  /** Without ffmpeg only formats that already hold both picture and sound can be used. */
  ffmpegPath?: string | null;
  /** Some sites, YouTube among them, offer more formats when yt-dlp can run their JavaScript. */
  nodePath?: string | null;
  url: string;
  dir: string;
  tempDir: string;
  rateLimit?: string;
  /** A choice from `pickVideoChoices`. Without one, yt-dlp takes the best it can. */
  format?: string | null;
  referrer?: string | null;
  origin?: string | null;
  userAgent?: string | null;
  /** Names the file when the address itself says nothing, as with a playlist. */
  title?: string | null;
  /** Browser cookies in Netscape format. They go in a short-lived file, never on the command line. */
  cookieText?: string | null;
  cookieDir?: string;
  /** Set by the job to the file holding `cookieText`. */
  cookieFile?: string;
}

function writeCookieFile(options: Pick<VideoJobOptions, 'cookieText' | 'cookieDir'>): string | undefined {
  if (!options.cookieText || !options.cookieDir) return undefined;
  fs.mkdirSync(options.cookieDir, { recursive: true });
  const file = path.join(options.cookieDir, `${randomUUID()}.txt`);
  fs.writeFileSync(file, options.cookieText, { mode: 0o600 });
  return file;
}

const removeCookieFile = (file: string | undefined) => {
  if (file) fs.rmSync(file, { force: true });
};

function requestArgs(options: Pick<VideoJobOptions, 'referrer' | 'origin' | 'userAgent' | 'cookieFile'>): string[] {
  const args: string[] = [];
  if (options.referrer) args.push('--referer', options.referrer);
  if (options.origin) args.push('--add-headers', `Origin:${options.origin}`);
  if (options.userAgent) args.push('--user-agent', options.userAgent);
  if (options.cookieFile) args.push('--cookies', options.cookieFile);
  return args;
}

/** One line in the quality menu beside a video. */
export interface VideoChoice {
  format: string;
  /** Picture height, or null for audio or a file of unknown size. */
  height: number | null;
  fps: number | null;
  ext: string;
  audioOnly: boolean;
  bytes: number | null;
  /** True when the site only gave an estimate of the size. */
  approximate: boolean;
}

export interface VideoInfo {
  title: string;
  duration: number | null;
  choices: VideoChoice[];
}

export class VideoError extends Error {
  readonly kind: ProblemKind;
  constructor(kind: ProblemKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

interface RawFormat {
  format_id?: string;
  ext?: string;
  vcodec?: string | null;
  acodec?: string | null;
  height?: number | null;
  fps?: number | null;
  tbr?: number | null;
  abr?: number | null;
  filesize?: number | null;
  filesize_approx?: number | null;
  has_drm?: boolean;
}

const MAX_CHOICES = 8;
const MAX_INFO_BYTES = 64 * 1024 * 1024;
const INFO_TIMEOUT_MS = 45000;

/** A format reaches yt-dlp as a command line value, so only plain IDs joined by "+" pass. */
export const isSafeFormat = (format: string): boolean => /^[A-Za-z0-9][\w.-]{0,63}(\+[A-Za-z0-9][\w.-]{0,63})?$/.test(format);

/**
 * Reduces a site's long format list to one choice per height, plus sound alone. Separate picture
 * and sound need ffmpeg to combine, so without it only formats that hold both are offered. Streams
 * often state no size, so it is estimated from their bit rate and the video's length.
 */
export function pickVideoChoices(formats: RawFormat[], canMerge: boolean, duration: number | null = null): VideoChoice[] {
  const sizeOf = (f: RawFormat): number | null => f.filesize ?? f.filesize_approx ?? (f.tbr && duration ? Math.round((f.tbr * 1000 * duration) / 8) : null);
  const usable = formats.filter((f) => f.format_id && isSafeFormat(f.format_id) && !f.has_drm && f.ext !== 'mhtml' && !(f.vcodec === 'none' && f.acodec === 'none'));
  const audioRate = (f: RawFormat) => f.abr ?? f.tbr ?? 0;
  const audio = usable
    .filter((f) => f.vcodec === 'none')
    // "-drc" is YouTube's compressed-loudness copy of the same sound, not a better one.
    .sort((a, b) => Number(!b.format_id?.endsWith('-drc')) - Number(!a.format_id?.endsWith('-drc')) || Number(b.ext === 'm4a') - Number(a.ext === 'm4a') || audioRate(b) - audioRate(a))[0];

  const best = new Map<number | null, RawFormat>();
  for (const f of usable) {
    if (f.vcodec === 'none') continue;
    if (f.acodec === 'none' && (!canMerge || !audio)) continue;
    const height = f.height ?? null;
    const held = best.get(height);
    const better = !held || Number(f.ext === 'mp4') - Number(held.ext === 'mp4') > 0 || (f.ext === held.ext && (f.tbr ?? 0) > (held.tbr ?? 0));
    if (better) best.set(height, f);
  }

  const choices = [...best.entries()]
    .sort(([a], [b]) => (b ?? -1) - (a ?? -1))
    .slice(0, MAX_CHOICES)
    .map(([height, f]): VideoChoice => {
      const separate = f.acodec === 'none' && audio;
      const parts = separate ? [f, audio] : [f];
      const sizes = parts.map(sizeOf);
      return {
        format: parts.map((p) => p.format_id).join('+'),
        height,
        fps: f.fps ?? null,
        ext: separate ? 'mp4' : f.ext ?? 'mp4',
        audioOnly: false,
        bytes: sizes.every((s) => s !== null) ? sizes.reduce<number>((sum, s) => sum + (s as number), 0) : null,
        approximate: parts.some((p) => p.filesize == null),
      };
    });
  if (audio) {
    choices.push({ format: audio.format_id as string, height: null, fps: null, ext: audio.ext ?? 'm4a', audioOnly: true, bytes: sizeOf(audio), approximate: audio.filesize == null });
  }
  return choices;
}

/** Asks yt-dlp what a page offers, without downloading it. */
export async function readVideoInfo(options: Pick<VideoJobOptions, 'ytDlpPath' | 'ffmpegPath' | 'nodePath' | 'url' | 'referrer' | 'origin' | 'userAgent' | 'cookieText' | 'cookieDir'> & { duration?: number | null }): Promise<VideoInfo> {
  const cookieFile = writeCookieFile(options);
  try {
    return await runVideoInfo(options, cookieFile);
  } finally {
    removeCookieFile(cookieFile);
  }
}

function runVideoInfo(options: Parameters<typeof readVideoInfo>[0], cookieFile: string | undefined): Promise<VideoInfo> {
  const args = ['--ignore-config', '--no-playlist', '--dump-single-json', '--encoding', 'utf-8', '--match-filter', '!is_live'];
  if (options.nodePath) args.push('--js-runtimes', `node:${options.nodePath}`);
  args.push(...requestArgs({ ...options, cookieFile }));
  args.push('--', options.url);
  return new Promise((resolve, reject) => {
    const child = spawn(options.ytDlpPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } });
    const chunks: Buffer[] = [];
    let size = 0;
    let errors = '';
    const stopTree = () => {
      if (child.pid) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
    };
    const timer = setTimeout(() => {
      errors = 'ERROR: timed out reading the page';
      stopTree();
    }, INFO_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_INFO_BYTES) stopTree();
      else chunks.push(chunk);
    });
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      errors = (errors + chunk).slice(-MAX_ERROR_TEXT);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(new VideoError('engine', `yt-dlp could not start: ${error.message}`));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new VideoError(classifyVideoError(errorLines(errors)), errorLines(errors) || `yt-dlp stopped with code ${code}.`));
      try {
        const info = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { title?: string; formats?: RawFormat[]; url?: string; ext?: string; duration?: number };
        // A page that is one plain file may have no format list at all.
        const formats = info.formats ?? (info.url ? [{ format_id: 'best', ext: info.ext }] : []);
        // A plain playlist states no length, but the player on the page knows it.
        const duration = info.duration ?? options.duration ?? null;
        const choices = pickVideoChoices(formats, !!options.ffmpegPath, duration);
        if (choices.length === 0) return reject(new VideoError('video-unsupported', 'yt-dlp found no format the app can use.'));
        resolve({ title: info.title ?? '', duration, choices });
      } catch (error) {
        reject(new VideoError('server', `yt-dlp returned unreadable data: ${(error as Error).message}`));
      }
    });
  });
}

export interface VideoProgress {
  filename: string;
  downloaded: number;
  total: number;
  speed: number;
}

const PROGRESS_MARK = 'SDPROGRESS';
const NAME_MARK = 'SDNAME';
const FILE_MARK = 'SDFILE';
const MAX_ERROR_TEXT = 8192;

/**
 * DRM stays closed: `--allow-unplayable-formats` is never passed, so yt-dlp refuses protected
 * videos. `--ignore-config` keeps a user's yt-dlp settings from changing what runs, and the `--`
 * stops an address from being read as an option.
 */
export function videoArgs(options: VideoJobOptions): string[] {
  const args = [
    '--ignore-config',
    '--no-playlist',
    '--no-mtime',
    '--newline',
    '--no-colors',
    '--windows-filenames',
    '--encoding', 'utf-8',
    '--continue',
    '--progress',
    '--progress-delta', '0.5',
    '--progress-template', `download:${PROGRESS_MARK} %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s %(progress.filename)s`,
    '--print', `video:${NAME_MARK} %(title)s`,
    '--print', `after_move:${FILE_MARK} %(filepath)s`,
    // A live stream would never finish, so it does not belong in a download queue.
    '--match-filter', '!is_live',
    '--concurrent-fragments', '8',
    '--retries', '5',
    '--paths', `home:${options.dir}`,
    '--paths', `temp:${options.tempDir}`,
    // "%" starts a field in yt-dlp's template, so one in a title has to be doubled.
    '--output', options.title ? `${options.title.replaceAll('%', '%%')}.%(ext)s` : '%(title).150B [%(id)s].%(ext)s',
  ];
  if (options.ffmpegPath) args.push('--ffmpeg-location', options.ffmpegPath, '--format', options.format ?? 'bv*+ba/b', '--merge-output-format', 'mp4');
  else args.push('--format', options.format ?? 'b');
  args.push(...requestArgs(options));
  if (options.nodePath) args.push('--js-runtimes', `node:${options.nodePath}`);
  if (options.rateLimit && options.rateLimit !== '0') args.push('--limit-rate', options.rateLimit);
  args.push('--', options.url);
  return args;
}

const number = (value: string | undefined): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

export function parseProgress(line: string): VideoProgress | null {
  const match = new RegExp(`^${PROGRESS_MARK} (\\S+) (\\S+) (\\S+) (\\S+) (.*)$`).exec(line);
  if (!match) return null;
  return { downloaded: number(match[1]), total: number(match[2]) || number(match[3]), speed: number(match[4]), filename: match[5] ?? '' };
}

/** yt-dlp mixes warnings into its error output. Only the error lines say what went wrong. */
export function errorLines(text: string): string {
  const lines = text.split(/\r?\n/).filter((line) => line.startsWith('ERROR:'));
  return (lines.length ? lines.join('\n') : text).trim();
}

/** Puts yt-dlp's error text into the problem types the window can explain and offer fixes for. */
export function classifyVideoError(text: string): ProblemKind {
  if (/DRM/i.test(text)) return 'video-drm';
  if (/unsupported url|no video could be found|does not pass filter|is_live|no video formats|video is unavailable/i.test(text)) return 'video-unsupported';
  if (/sign in|log ?in|private video|members-only|age[- ]restricted|cookies/i.test(text)) return 'video-login';
  if (/no space left|permission denied|errno 13|errno 28/i.test(text)) return 'disk';
  if (/timed out|unable to download|connection|getaddrinfo|http error (429|5\d\d)|network/i.test(text)) return 'network';
  return 'server';
}

/** Runs yt-dlp once. Emits `name`, `progress`, then one of `finished` or `failed`. */
export class VideoJob extends EventEmitter {
  private readonly options: VideoJobOptions;
  private child: ChildProcess | null = null;
  private exited: Promise<void> = Promise.resolve();

  constructor(options: VideoJobOptions) {
    super();
    this.options = options;
  }

  start(): void {
    let file: string | null = null;
    let errors = '';
    const cookieFile = writeCookieFile(this.options);
    const child = spawn(this.options.ytDlpPath, videoArgs({ ...this.options, cookieFile }), {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    });
    this.child = child;
    readline.createInterface({ input: child.stdout as NodeJS.ReadableStream }).on('line', (line) => {
      const progress = parseProgress(line);
      if (progress) this.emit('progress', progress);
      else if (line.startsWith(`${NAME_MARK} `)) this.emit('name', line.slice(NAME_MARK.length + 1));
      else if (line.startsWith(`${FILE_MARK} `)) file = line.slice(FILE_MARK.length + 1);
    });
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      errors = (errors + chunk).slice(-MAX_ERROR_TEXT);
    });
    this.exited = new Promise((resolve) => {
      child.once('error', (error) => {
        this.child = null;
        removeCookieFile(cookieFile);
        this.emit('failed', { kind: 'engine', message: `yt-dlp could not start: ${error.message}` });
        resolve();
      });
      child.once('close', (code) => {
        this.child = null;
        removeCookieFile(cookieFile);
        if (code === 0 && file) this.emit('finished', file);
        else if (code === 0) this.emit('failed', { kind: 'video-unsupported', message: errorLines(errors) || 'yt-dlp produced no file.' });
        else this.emit('failed', { kind: classifyVideoError(errorLines(errors)), message: errorLines(errors) || `yt-dlp stopped with code ${code}.` });
        resolve();
      });
    });
  }

  /** Ends yt-dlp and whatever it started, such as ffmpeg. Partial files stay for the next run. */
  async stop(): Promise<void> {
    this.removeAllListeners();
    const pid = this.child?.pid;
    if (pid) await new Promise<void>((resolve) => execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve()));
    await this.exited;
  }
}
