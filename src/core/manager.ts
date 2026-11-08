import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { categoryOf, FOLDER_KINDS } from '../shared/categories.ts';
import type { FolderKind } from '../shared/categories.ts';
import { isValidTime, withinWindow } from '../shared/schedule.ts';
import type { AddRequest, ApiState, Download, Language, Problem, ProblemKind, Settings } from '../shared/types.ts';
import { Aria2Engine } from './engine.ts';
import type { EngineStatus } from './engine.ts';
import { filenameFromUrl, isSafeHeaderValue, sanitizeFilename, uniqueName } from './names.ts';
import { compareValidators, probe } from './probe.ts';
import type { ProbeResult } from './probe.ts';
import { JsonStore, memoryOnlySecrets } from './store.ts';
import type { SecretStore } from './store.ts';
import { isSafeFormat, readVideoInfo, VideoError, VideoJob } from './video.ts';
import type { VideoInfo, VideoProgress } from './video.ts';
import type { SeenMedia } from './bridge.ts';
import { markFromInternet } from './zone.ts';
import type { Scanner } from './scan.ts';
import { emptyStats, parseStats } from '../shared/stats.ts';
import type { ReliabilityStats } from '../shared/stats.ts';

export interface ManagerOptions {
  aria2Path: string;
  stateDir: string;
  defaultDir: string;
  secrets?: SecretStore;
  pollMs?: number;
  fileAllocation?: string;
  defaultLanguage?: Language;
  engineConf?: Record<string, string>;
  /** Length of one "second" while waiting on a busy server. Tests shorten it. */
  busyDelayMs?: number;
  /** Videos cannot be added without yt-dlp. ffmpeg is optional and allows higher quality. */
  ytDlpPath?: string | null;
  ffmpegPath?: string | null;
  nodePath?: string | null;
  /** Tests replace the clock and check the schedule more often. */
  now?: () => Date;
  scheduleCheckMs?: number;
  /** Adds the Windows "Mark of the Web" to finished files, as a browser would. Off where Windows policy says not to keep it. */
  markDownloads?: boolean;
  /** Checks each finished file, one at a time. Left out where Microsoft Defender is not available. */
  scanner?: Scanner | null;
}

const MAX_ENGINE_RESTARTS = 5;
const MAX_BUSY_RETRIES = 4;
const BUSY_RETRY_SECONDS = 5;
const MAX_BUSY_WAIT_SECONDS = 60;
const MAX_TORRENT_FILE_BYTES = 16 * 1024 * 1024;

const isMagnet = (url: string) => /^magnet:\?/i.test(url);

function validatedHttpUrl(request: Pick<AddRequest, 'url' | 'cookie' | 'referrer' | 'userAgent'>): string {
  const url = new URL(request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`Unsupported address type: ${url.protocol}`);
  for (const value of [request.cookie, request.referrer, request.userAgent]) {
    if (value && !isSafeHeaderValue(value)) throw new Error('A request header contains a line break.');
  }
  return url.href;
}

const REMOTE_CHANGED_MESSAGE = 'The file on the server has changed since this download started. Continuing would corrupt it, so it needs to start again.';

function decodeName(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
}

const DEFAULT_SETTINGS: Omit<Settings, 'defaultDir' | 'language'> = {
  categoryDirs: {},
  maxConcurrent: 3,
  // Measured on four real servers: 16 was up to five times faster than one connection on a
  // congested route and about equal elsewhere. Servers that refuse so many are handled by backing off.
  connections: 16,
  minSplitSize: '4M',
  speedLimit: '0',
  shutdownWhenDone: false,
  scheduleEnabled: false,
  scheduleStart: '01:00',
  scheduleEnd: '06:00',
  browserCapture: true,
  extraExtensions: '',
};

/**
 * Owns the download queue. aria2 only ever knows about the downloads running right now; the
 * queue, validators and cookies live here, so every start and resume goes through one path that
 * checks the file on the server has not changed.
 */
export class DownloadManager extends EventEmitter {
  private readonly options: ManagerOptions;
  private readonly secrets: SecretStore;
  private readonly store: JsonStore;
  private readonly engine: Aria2Engine;
  private readonly records = new Map<string, Download>();
  private readonly cookies = new Map<string, string>();
  private readonly gids = new Map<string, string>();
  private readonly runs = new Map<string, number>();
  private readonly allowUnverified = new Set<string>();
  /** Lowered for a download when its server refuses many connections, for example with HTTP 429. */
  private readonly connectionLimits = new Map<string, number>();
  private readonly videos = new Map<string, VideoJob>();
  private readonly busyRetries = new Map<string, number>();
  private readonly busyDelayMs: number;
  private settings: Settings;
  private pollTimer: NodeJS.Timeout | null = null;
  private scheduleTimer: NodeJS.Timeout | null = null;
  private windowWasOpen = true;
  private finishedSinceArmed = false;
  private saveTimer: NodeJS.Timeout | null = null;
  private readonly scanQueue: string[] = [];
  private stats: ReliabilityStats = emptyStats(Date.now());
  /** Bytes each unfinished file already had when the app started, for counting what a resume kept. */
  private readonly heldAtStart = new Map<string, number>();
  private scanning = false;
  private polling = false;
  private engineRestarts = 0;
  private closing = false;

  constructor(options: ManagerOptions) {
    super();
    this.options = options;
    this.busyDelayMs = options.busyDelayMs ?? 1000;
    this.secrets = options.secrets ?? memoryOnlySecrets;
    this.store = new JsonStore(options.stateDir);
    this.engine = new Aria2Engine({ aria2Path: options.aria2Path, stateDir: options.stateDir, fileAllocation: options.fileAllocation, extraConf: options.engineConf });
    this.engine.on('crashed', () => void this.onEngineCrash());
    this.settings = { ...DEFAULT_SETTINGS, defaultDir: options.defaultDir, language: options.defaultLanguage ?? 'th' };
  }

  async start(): Promise<void> {
    // Cookies for yt-dlp live only as long as its run. A crash could leave some, so clear them here.
    fs.rmSync(this.videoCookieDir, { recursive: true, force: true });
    const state = this.store.load();
    this.stats = parseStats(state.stats, Date.now());
    // Waking up to a computer that turns itself off would be a nasty surprise, so this never carries over.
    this.settings = { ...this.settings, ...state.settings, shutdownWhenDone: false };
    for (const download of state.downloads) {
      const restored: Download = { ...download, speed: 0, connections: 0 };
      if (restored.status === 'downloading' || restored.status === 'probing') restored.status = 'queued';
      if (restored.status !== 'completed' && restored.completedBytes > 0) this.heldAtStart.set(restored.id, restored.completedBytes);
      this.records.set(restored.id, restored);
      const encrypted = state.cookies[restored.id];
      if (encrypted && this.secrets.available) {
        try {
          this.cookies.set(restored.id, this.secrets.decrypt(encrypted));
        } catch {
          restored.hasCookie = false;
        }
      } else if (restored.hasCookie && restored.status !== 'completed') {
        restored.hasCookie = false;
      }
    }
    await this.engine.start();
    await this.applySpeedLimit();
    this.pollTimer = setInterval(() => void this.poll(), this.options.pollMs ?? 1000);
    this.windowWasOpen = this.windowOpen();
    this.scheduleTimer = setInterval(() => void this.applySchedule(), this.options.scheduleCheckMs ?? 15000);
    this.schedule();
    // A scan cut short by closing the app runs again.
    for (const record of this.records.values()) if (record.status === 'completed' && record.scan === 'pending') this.queueScan(record);
    this.changed();
  }

  state(): ApiState {
    return { downloads: this.list(), settings: { ...this.settings }, engineReady: this.engine.running, stats: { ...this.stats, problems: { ...this.stats.problems } } };
  }

  list(): Download[] {
    return [...this.records.values()].map((record) => ({ ...record }));
  }

  get(id: string): Download | undefined {
    const record = this.records.get(id);
    return record ? { ...record } : undefined;
  }

  add(request: AddRequest): Download {
    if (isMagnet(request.url)) return this.addMagnet(request.url);
    const record = this.newRecord('http', validatedHttpUrl(request), request);
    this.records.set(record.id, record);
    if (request.cookie) this.cookies.set(record.id, request.cookie);
    this.schedule();
    this.changed();
    return { ...record };
  }

  /** Adds a page holding a video. yt-dlp finds the video and names the file. */
  addVideo(rawUrl: string, choice: { format?: string; referrer?: string; origin?: string; userAgent?: string; cookie?: string; title?: string; audioOnly?: boolean } = {}): Download {
    if (!this.options.ytDlpPath) throw new Error('Video downloads are not available because yt-dlp is missing.');
    if (choice.format && !isSafeFormat(choice.format)) throw new Error('This video quality is not valid.');
    const url = validatedHttpUrl({ url: rawUrl, referrer: choice.referrer, userAgent: choice.userAgent });
    if (choice.origin && !isSafeHeaderValue(choice.origin)) throw new Error('A request header contains a line break.');
    // A page title is free text, so a slash in it separates words rather than folders.
    const title = choice.title?.trim() ? sanitizeFilename(choice.title.replace(/[\\/]+/g, '-')).slice(0, 150).trim() : '';
    const record = this.newRecord('video', url, { url, referrer: choice.referrer, userAgent: choice.userAgent, filename: title || undefined });
    if (choice.format) record.videoFormat = choice.format;
    if (choice.audioOnly) {
      record.audioOnly = true;
      record.dir = this.folderFor('audio');
    }
    if (title) record.videoTitle = title;
    if (choice.origin) record.videoOrigin = choice.origin;
    if (choice.cookie) {
      this.cookies.set(record.id, choice.cookie);
      record.hasCookie = true;
    }
    return this.enqueue(record);
  }

  /**
   * Lists the qualities a page offers. `fallback` is the address the player was showing: some pages
   * yield nothing themselves, while the file they play can still be read directly.
   */
  async videoChoices(rawUrl: string, options: { referrer?: string; fallback?: string; userAgent?: string; title?: string; duration?: number; media?: SeenMedia[] } = {}): Promise<VideoInfo & { url: string; sources: number }> {
    const ytDlpPath = this.options.ytDlpPath;
    if (!ytDlpPath) throw new VideoError('engine', 'yt-dlp is missing.');
    const url = validatedHttpUrl({ url: rawUrl, referrer: options.referrer });
    const shared = { ytDlpPath, ffmpegPath: this.options.ffmpegPath, nodePath: this.options.nodePath, userAgent: options.userAgent, cookieDir: this.videoCookieDir };
    const read = (target: string) => readVideoInfo({ ...shared, url: target, referrer: options.referrer });

    // What the player really requested comes first. It needs no knowledge of the site.
    const seen = options.media ?? [];
    const results = await Promise.allSettled(seen.map(async (media) => {
      const target = validatedHttpUrl({ url: media.url, referrer: media.referrer ?? undefined });
      const info = await readVideoInfo({ ...shared, url: target, referrer: media.referrer, origin: media.origin, cookieText: media.cookie, duration: options.duration });
      const single = info.choices.length === 1;
      return { target, info, bytes: single ? media.bytes : null };
    }));
    const found = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
    if (found.length > 0) {
      // A master playlist offers several qualities, so it goes ahead of a single stray stream.
      found.sort((a, b) => b.info.choices.length - a.info.choices.length);
      const choices = found.flatMap(({ target, info, bytes }) => info.choices.map((choice) => ({ ...choice, url: target, duration: info.duration, bytes: choice.bytes ?? bytes, approximate: choice.bytes === null ? false : choice.approximate })));
      return { url: found[0]!.target, title: options.title || found[0]!.info.title, duration: found[0]!.info.duration, choices, sources: found.length };
    }

    try {
      const info = await read(url);
      return { url, sources: 1, ...info, choices: info.choices.map((choice) => ({ ...choice, url })) };
    } catch (error) {
      if (!options.fallback || !(error instanceof VideoError) || error.kind !== 'video-unsupported') throw error;
      const direct = validatedHttpUrl({ url: options.fallback });
      const info = await read(direct);
      return { url: direct, sources: 1, ...info, choices: info.choices.map((choice) => ({ ...choice, url: direct })) };
    }
  }

  private get videoCookieDir(): string {
    return path.join(this.options.stateDir, 'video-cookies');
  }

  /** Adds a magnet link. Its files are named once the peers have sent the metadata. */
  private addMagnet(link: string): Download {
    if (!/[?&]xt=urn:btih:[a-z0-9]{32,40}(&|$)/i.test(link) || !isSafeHeaderValue(link)) {
      throw new Error('This magnet link has no valid BitTorrent hash.');
    }
    const name = /[?&]dn=([^&]*)/i.exec(link)?.[1];
    const record = this.newRecord('torrent', link, { url: link, filename: name ? decodeName(name) : undefined });
    return this.enqueue(record);
  }

  /** Adds a .torrent file. A copy is kept so the download can resume after a restart. */
  addTorrentFile(name: string, data: Buffer): Download {
    if (data.length === 0 || data.length > MAX_TORRENT_FILE_BYTES || data[0] !== 0x64 /* "d" */) {
      throw new Error('This is not a valid .torrent file.');
    }
    const record = this.newRecord('torrent', `torrent:${sanitizeFilename(name)}`, { url: name, filename: name.replace(/\.torrent$/i, '') });
    fs.mkdirSync(this.torrentDir, { recursive: true });
    fs.writeFileSync(this.torrentPath(record.id), data);
    return this.enqueue(record);
  }

  private enqueue(record: Download): Download {
    this.records.set(record.id, record);
    this.schedule();
    this.changed();
    return { ...record };
  }

  private get torrentDir(): string {
    return path.join(this.options.stateDir, 'torrents');
  }

  private torrentPath(id: string): string {
    return path.join(this.torrentDir, `${id}.torrent`);
  }

  /** Where a kind of file goes. With no kind yet known, as before a server names a file, the main folder. */
  private folderFor(kind: FolderKind | null): string {
    return (kind && this.settings.categoryDirs[kind]) || this.settings.defaultDir;
  }

  private newRecord(kind: 'http' | 'torrent' | 'video', url: string, request: AddRequest): Download {
    return {
      id: randomUUID(),
      kind,
      url,
      filename: request.filename ? sanitizeFilename(request.filename) : null,
      dir: request.dir ?? this.folderFor(kind === 'torrent' ? 'torrent' : kind === 'video' ? 'video' : request.filename ? categoryOf(request.filename) : null),
      ...(request.dir ? { dirChosen: true } : {}),
      status: 'queued',
      totalBytes: 0,
      completedBytes: 0,
      speed: 0,
      connections: 0,
      acceptsRanges: null,
      validator: null,
      problem: null,
      referrer: request.referrer ?? null,
      userAgent: request.userAgent ?? null,
      hasCookie: !!request.cookie,
      createdAt: Date.now(),
      completedAt: null,
    };
  }

  async pause(id: string): Promise<void> {
    const record = this.require(id);
    if (record.status === 'completed' || record.status === 'paused') return;
    await this.halt(record);
    record.status = 'paused';
    record.runNow = false;
    this.afterHalt();
  }

  /** Starts a download right away, even outside the scheduled hours. */
  startNow(id: string): void {
    const record = this.require(id);
    record.runNow = true;
    this.resume(id);
  }

  /** Continues a paused or stopped download. The server file is checked again first. */
  resume(id: string): void {
    const record = this.require(id);
    if (record.status === 'completed' || record.status === 'downloading' || record.status === 'probing') return;
    record.problem = null;
    record.status = 'queued';
    this.schedule();
    this.changed();
  }

  /** Continues even though the server gave nothing to compare. The result may be corrupt. */
  resumeUnverified(id: string): void {
    const record = this.require(id);
    if (record.problem?.kind !== 'cannot-verify') return;
    this.allowUnverified.add(id);
    this.resume(id);
  }

  async pauseAll(): Promise<void> {
    for (const record of this.records.values()) {
      if (record.status === 'downloading' || record.status === 'probing' || record.status === 'queued') await this.pause(record.id);
    }
  }

  resumeAll(): void {
    for (const record of this.records.values()) {
      if (record.status === 'paused') this.resume(record.id);
    }
  }

  /** Throws away progress and starts the file again. */
  async restart(id: string): Promise<void> {
    const record = this.require(id);
    await this.halt(record);
    // Starting over keeps nothing, so it is not counted as a resume.
    this.heldAtStart.delete(id);
    await this.deletePartial(record);
    record.validator = null;
    record.completedBytes = 0;
    record.totalBytes = 0;
    record.problem = null;
    record.completedAt = null;
    delete record.scan;
    delete record.threatName;
    record.status = 'queued';
    this.afterHalt();
  }

  /** Points a download at a fresh link, optionally with new login cookies, then continues. */
  async replaceUrl(id: string, request: Pick<AddRequest, 'url' | 'cookie' | 'referrer' | 'userAgent'>): Promise<void> {
    const record = this.require(id);
    const url = validatedHttpUrl(request);
    await this.halt(record);
    record.url = url;
    if (request.referrer !== undefined) record.referrer = request.referrer;
    if (request.userAgent !== undefined) record.userAgent = request.userAgent;
    if (request.cookie !== undefined) {
      this.cookies.set(id, request.cookie);
      record.hasCookie = !!request.cookie;
    }
    if (record.problem?.kind === 'link-expired') this.stats.linksReplaced += 1;
    record.problem = null;
    record.status = 'queued';
    this.afterHalt();
  }

  async remove(id: string, options: { deleteFile?: boolean } = {}): Promise<void> {
    const record = this.require(id);
    await this.halt(record);
    if (record.status !== 'completed') await this.deletePartial(record);
    if (options.deleteFile && record.status === 'completed' && record.filename) {
      await fs.promises.rm(path.join(record.dir, record.filename), { force: true, recursive: record.kind === 'torrent' });
    }
    if (record.kind === 'torrent') fs.rmSync(this.torrentPath(id), { force: true });
    this.records.delete(id);
    this.connectionLimits.delete(id);
    this.cookies.delete(id);
    this.runs.delete(id);
    this.allowUnverified.delete(id);
    this.afterHalt();
  }

  async updateSettings(patch: Partial<Settings>): Promise<void> {
    const next: Settings = { ...this.settings, ...patch };
    if (!Number.isInteger(next.maxConcurrent) || next.maxConcurrent < 1 || next.maxConcurrent > 16) throw new Error('Concurrent downloads must be from 1 to 16.');
    if (!Number.isInteger(next.connections) || next.connections < 1 || next.connections > 16) throw new Error('Connections must be from 1 to 16.');
    if (!/^\d+[KM]$/i.test(next.minSplitSize)) throw new Error('Minimum split size must look like 4M.');
    if (!/^\d+[KM]?$/i.test(next.speedLimit)) throw new Error('Speed limit must look like 500K, 2M or 0.');
    if (next.extraExtensions.length > 500) throw new Error('The file type list is too long.');
    if (next.language !== 'th' && next.language !== 'en') throw new Error('Unknown language.');
    if (!isValidTime(next.scheduleStart) || !isValidTime(next.scheduleEnd)) throw new Error('Schedule times must look like 01:30.');
    if (next.scheduleStart === next.scheduleEnd) throw new Error('The schedule must start and end at different times.');
    for (const [kind, dir] of Object.entries(next.categoryDirs)) {
      if (!FOLDER_KINDS.includes(kind as FolderKind) || typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error('A file type folder is not valid.');
    }
    // Only files finished after this is turned on count, so it never fires on old results.
    if (next.shutdownWhenDone && !this.settings.shutdownWhenDone) this.finishedSinceArmed = false;
    this.settings = next;
    await this.applySpeedLimit();
    await this.applySchedule();
    this.changed();
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.scheduleTimer) clearInterval(this.scheduleTimer);
    this.pollTimer = null;
    this.scheduleTimer = null;
    await Promise.all([...this.videos.values()].map((job) => job.stop()));
    this.videos.clear();
    await this.engine.stop();
    this.flush();
  }

  /** Test seam: ends aria2 abruptly, as a crash would. */
  killEngineForTest(): void {
    this.engine.killForTest();
  }

  private require(id: string): Download {
    const record = this.records.get(id);
    if (!record) throw new Error('Download not found.');
    return record;
  }

  private partPath(record: Download): string | null {
    return record.filename && record.kind !== 'torrent' && record.kind !== 'video' ? path.join(record.dir, `${record.filename}.part`) : null;
  }

  /** yt-dlp's unfinished files live here, on the same drive as the finished file will be. */
  private videoTempDir(record: Download): string {
    return path.join(record.dir, `.speed-downloader-${record.id}`);
  }

  private cleanupControlFiles(part: string): void {
    fs.rmSync(`${part}.aria2`, { force: true });
    fs.rmSync(`${part}.aria2__temp`, { force: true });
  }

  /** Partial files can be many gigabytes, so this must not hold up the window while it deletes them. */
  private async deletePartial(record: Download): Promise<void> {
    const remove = (target: string) => fs.promises.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    if (record.kind === 'video') return remove(this.videoTempDir(record));
    if (record.kind === 'torrent') {
      // aria2's control file proves these files belong to this unfinished download.
      if (!record.filename) return;
      const data = path.join(record.dir, record.filename);
      if (fs.existsSync(`${data}.aria2`)) {
        await remove(data);
        this.cleanupControlFiles(data);
      }
      return;
    }
    const part = this.partPath(record);
    if (!part) return;
    await remove(part);
    this.cleanupControlFiles(part);
  }

  /** Stops whatever is running for a record. Any in-flight start sees its run has been replaced. */
  private async halt(record: Download): Promise<void> {
    this.runs.set(record.id, (this.runs.get(record.id) ?? 0) + 1);
    const gid = this.gids.get(record.id);
    if (gid) {
      this.gids.delete(record.id);
      // A torrent's files use the name inside it, which the regular update may not have read yet.
      // Without it, cancelling could not find them and would leave them on disk.
      if (record.kind === 'torrent') {
        const name = await this.engine.tellStatus(gid).then((status) => status.bittorrent?.info?.name).catch(() => undefined);
        if (name) record.filename = sanitizeFilename(name);
      }
      await this.engine.stopDownload(gid);
    }
    const job = this.videos.get(record.id);
    if (job) {
      this.videos.delete(record.id);
      await job.stop();
    }
    record.speed = 0;
    record.connections = 0;
  }

  private afterHalt(): void {
    this.schedule();
    this.changed();
  }

  private schedule(): void {
    if (this.closing || !this.engine.running) return;
    let active = 0;
    for (const record of this.records.values()) {
      if (record.status === 'downloading' || record.status === 'probing') active++;
    }
    const open = this.windowOpen();
    for (const record of this.records.values()) {
      if (active >= this.settings.maxConcurrent) return;
      if (record.status !== 'queued' || (!open && !record.runNow)) continue;
      active++;
      record.status = 'probing';
      void this.begin(record);
    }
  }

  private windowOpen(): boolean {
    const { scheduleEnabled, scheduleStart, scheduleEnd } = this.settings;
    return !scheduleEnabled || withinWindow(this.options.now?.() ?? new Date(), scheduleStart, scheduleEnd);
  }

  /** Holds running downloads when the scheduled hours end, and starts the queue when they begin. */
  private async applySchedule(): Promise<void> {
    if (this.closing) return;
    const open = this.windowOpen();
    if (!open) {
      for (const record of this.records.values()) {
        if ((record.status === 'downloading' || record.status === 'probing') && !record.runNow) {
          await this.halt(record);
          record.status = 'queued';
        }
      }
    }
    this.schedule();
    // The window shows a "waiting" label that depends on the clock, so it must hear about the change.
    if (open !== this.windowWasOpen) {
      this.windowWasOpen = open;
      this.changed();
    }
  }

  private async begin(record: Download): Promise<void> {
    if (record.kind === 'torrent') return this.beginTorrent(record);
    if (record.kind === 'video') return this.beginVideo(record);
    const run = (this.runs.get(record.id) ?? 0) + 1;
    this.runs.set(record.id, run);
    const current = () => this.runs.get(record.id) === run;
    const cookie = this.cookies.get(record.id) ?? null;
    let found: ProbeResult;
    try {
      found = await probe({ url: record.url, cookie, referrer: record.referrer, userAgent: record.userAgent });
    } catch (error) {
      if (current()) this.fail(record, 'failed', 'network', `Could not reach the server: ${(error as Error).message}`);
      return;
    }
    if (!current()) return;

    if (this.failOnRefusal(record, found.status)) return;
    if (found.status === 429 || found.status === 503) return this.retryWhenBusy(record, found.retryAfterSeconds);
    this.busyRetries.delete(record.id);
    if (found.status >= 400 && found.status !== 416) return this.fail(record, 'failed', 'server', `The server returned HTTP ${found.status}.`);

    if (!record.filename) {
      const wanted = found.filename ?? filenameFromUrl(found.finalUrl);
      // Only now is the file's type known, so only now can it go to its own folder.
      if (!record.dirChosen) record.dir = this.folderFor(categoryOf(wanted));
      try {
        fs.mkdirSync(record.dir, { recursive: true });
      } catch (error) {
        return this.fail(record, 'failed', 'disk', `Could not use the folder: ${(error as Error).message}`);
      }
      record.filename = uniqueName(wanted, (candidate) => this.nameTaken(record, candidate));
    }

    const part = this.partPath(record) as string;
    if (fs.existsSync(part)) {
      const comparison = compareValidators(record.validator, found.validator);
      if (comparison === 'changed') return this.fail(record, 'attention', 'remote-changed', REMOTE_CHANGED_MESSAGE);
      if (comparison === 'unknown' && !this.allowUnverified.has(record.id)) {
        return this.fail(record, 'attention', 'cannot-verify', 'The server gave no way to check that the file is unchanged, so continuing could produce a corrupt file.');
      }
      if (!found.acceptsRanges) await this.deletePartial(record);
    }
    this.allowUnverified.delete(record.id);

    record.acceptsRanges = found.acceptsRanges;
    record.validator = record.validator && fs.existsSync(part) ? record.validator : found.validator;
    if (found.validator.size !== null) record.totalBytes = found.validator.size;

    // aria2's RPC ignores option values that are not strings, without reporting an error.
    const connections = String(found.acceptsRanges ? this.connectionTarget(record) : 1);
    const engineOptions: Record<string, unknown> = {
      dir: record.dir,
      out: `${record.filename}.part`,
      split: connections,
      'max-connection-per-server': connections,
      'min-split-size': this.settings.minSplitSize,
    };
    if (record.userAgent) engineOptions['user-agent'] = record.userAgent;
    if (record.referrer) engineOptions.referer = record.referrer;
    if (cookie && new URL(found.finalUrl).origin === new URL(record.url).origin) engineOptions.header = [`Cookie: ${cookie}`];

    try {
      const gid = await this.engine.addUri(found.finalUrl, engineOptions);
      if (!current()) {
        await this.engine.stopDownload(gid);
        return;
      }
      this.gids.set(record.id, gid);
      record.status = 'downloading';
      this.changed();
    } catch (error) {
      if (current()) this.fail(record, 'failed', 'engine', `The download engine rejected this file: ${(error as Error).message}`);
    }
  }

  /**
   * BitTorrent checks every piece against its hash, so a torrent needs no server probe and can
   * safely continue from whatever is already on disk.
   */
  private async beginTorrent(record: Download): Promise<void> {
    const run = (this.runs.get(record.id) ?? 0) + 1;
    this.runs.set(record.id, run);
    const options = { dir: record.dir, 'check-integrity': 'true' };
    try {
      fs.mkdirSync(record.dir, { recursive: true });
      const gid = isMagnet(record.url)
        ? await this.engine.addUri(record.url, options)
        : await this.engine.addTorrent(fs.readFileSync(this.torrentPath(record.id)), options);
      if (this.runs.get(record.id) !== run) {
        await this.engine.stopDownload(gid);
        return;
      }
      this.gids.set(record.id, gid);
      record.status = 'downloading';
      this.changed();
    } catch (error) {
      if (this.runs.get(record.id) === run) this.fail(record, 'failed', 'engine', `The download engine rejected this torrent: ${(error as Error).message}`);
    }
  }

  private beginVideo(record: Download): void {
    const ytDlpPath = this.options.ytDlpPath;
    if (!ytDlpPath) return this.fail(record, 'failed', 'engine', 'yt-dlp is missing.');
    const tempDir = this.videoTempDir(record);
    try {
      fs.mkdirSync(tempDir, { recursive: true });
    } catch (error) {
      return this.fail(record, 'failed', 'disk', `Could not use the folder: ${(error as Error).message}`);
    }
    const job = new VideoJob({ ytDlpPath, ffmpegPath: this.options.ffmpegPath, nodePath: this.options.nodePath, url: record.url, dir: record.dir, tempDir, rateLimit: this.settings.speedLimit, format: record.videoFormat, referrer: record.referrer, userAgent: record.userAgent, origin: record.videoOrigin, title: record.videoTitle, cookieText: this.cookies.get(record.id), cookieDir: this.videoCookieDir });
    this.videos.set(record.id, job);
    record.status = 'downloading';
    // A video and its sound arrive as separate files, one after the other, so their sizes add up.
    let finishedParts = 0;
    let lastFile = '';
    let lastTotal = 0;
    job.on('name', (title: string) => {
      if (record.videoTitle) return;
      record.filename = sanitizeFilename(title);
      this.changed();
    });
    job.on('progress', (progress: VideoProgress) => {
      if (progress.filename !== lastFile) {
        if (lastFile) finishedParts += lastTotal;
        lastFile = progress.filename;
      }
      lastTotal = progress.total || progress.downloaded;
      record.completedBytes = finishedParts + progress.downloaded;
      record.totalBytes = finishedParts + lastTotal;
      record.speed = progress.speed;
      this.changed();
    });
    job.once('finished', async (file: string) => {
      this.videos.delete(record.id);
      // A finished download must not still have temporary files beside it.
      await this.deletePartial(record).catch(() => {});
      record.filename = path.basename(file);
      let size = record.completedBytes;
      try {
        size = fs.statSync(file).size;
      } catch (error) {
        return this.fail(record, 'failed', 'disk', `The finished file is missing: ${(error as Error).message}`);
      }
      this.markDownloaded(record, file);
      this.markCompleted(record, size);
      this.queueScan(record);
      this.changed();
    });
    job.once('failed', (problem: { kind: ProblemKind; message: string }) => {
      this.videos.delete(record.id);
      // A partial file stays for the next try. An empty folder is only clutter.
      try {
        fs.rmdirSync(tempDir);
      } catch {
        // It holds a partial file.
      }
      this.fail(record, 'failed', problem.kind, problem.message);
    });
    job.start();
    this.changed();
  }

  private connectionTarget(record: Download): number {
    return Math.min(this.settings.connections, this.connectionLimits.get(record.id) ?? this.settings.connections);
  }

  private nameTaken(record: Download, candidate: string): boolean {
    const dest = path.join(record.dir, candidate);
    if (fs.existsSync(dest) || fs.existsSync(`${dest}.part`)) return true;
    // A finished record only holds a name while its file exists, which the check above covers.
    for (const other of this.records.values()) {
      if (other !== record && other.status !== 'completed' && other.dir === record.dir && other.filename === candidate) return true;
    }
    return false;
  }

  /** A busy server is temporary, so wait and try again, with fewer connections, before giving up. */
  private retryWhenBusy(record: Download, retryAfterSeconds: number | null): void {
    const attempt = (this.busyRetries.get(record.id) ?? 0) + 1;
    if (attempt > MAX_BUSY_RETRIES) {
      this.busyRetries.delete(record.id);
      return this.fail(record, 'failed', 'network', 'The server is too busy right now (HTTP 429 or 503). You can try again later.');
    }
    this.busyRetries.set(record.id, attempt);
    this.connectionLimits.set(record.id, Math.max(1, Math.floor(this.connectionTarget(record) / 2)));
    const run = this.runs.get(record.id);
    const seconds = Math.min(retryAfterSeconds ?? BUSY_RETRY_SECONDS * attempt, MAX_BUSY_WAIT_SECONDS);
    setTimeout(() => {
      if (this.closing || this.runs.get(record.id) !== run || record.status !== 'probing') return;
      void this.begin(record);
    }, seconds * this.busyDelayMs);
  }

  /** Handles the HTTP answers that mean this link will not work. Returns true if it handled one. */
  private failOnRefusal(record: Download, status: number): boolean {
    if (status === 401 || status === 403 || status === 410) {
      this.fail(record, 'attention', 'link-expired', `The server refused this link (HTTP ${status}). It may have expired or need a new login.`);
      return true;
    }
    if (status === 404) {
      this.fail(record, 'failed', 'not-found', 'The file was not found on the server (HTTP 404).');
      return true;
    }
    return false;
  }

  private fail(record: Download, status: 'attention' | 'failed', kind: ProblemKind, message: string): void {
    const problem: Problem = { kind, message };
    this.stats.problems[kind] = (this.stats.problems[kind] ?? 0) + 1;
    record.status = status;
    record.problem = problem;
    record.speed = 0;
    record.connections = 0;
    this.gids.delete(record.id);
    this.schedule();
    this.changed();
  }

  private async poll(): Promise<void> {
    if (this.polling || this.gids.size === 0) return;
    this.polling = true;
    try {
      for (const [id, gid] of [...this.gids]) {
        const record = this.records.get(id);
        if (!record) continue;
        let status: EngineStatus;
        try {
          status = await this.engine.tellStatus(gid);
        } catch {
          continue;
        }
        if (this.gids.get(id) !== gid) continue;
        record.completedBytes = Number(status.completedLength);
        if (Number(status.totalLength) > 0) record.totalBytes = Number(status.totalLength);
        record.speed = Number(status.downloadSpeed);
        record.connections = Number(status.connections);
        const torrentName = status.bittorrent?.info?.name;
        if (record.kind === 'torrent' && torrentName) record.filename = sanitizeFilename(torrentName);
        const next = status.followedBy?.[0];
        if (status.status === 'complete' && next) {
          // A magnet first fetches metadata, then aria2 starts the real download under a new gid.
          this.gids.set(id, next);
          await this.engine.call('removeDownloadResult', gid).catch(() => {});
        } else if (status.status === 'complete') await this.finish(record, gid);
        else if (status.status === 'error') await this.onEngineError(record, gid, status);
      }
      this.changed();
    } finally {
      this.polling = false;
    }
  }

  private async finish(record: Download, gid: string): Promise<void> {
    this.gids.delete(record.id);
    await this.engine.call('removeDownloadResult', gid).catch(() => {});
    if (record.kind === 'torrent') {
      if (record.filename) this.markDownloaded(record, path.join(record.dir, record.filename));
      this.markCompleted(record, record.completedBytes);
      return this.queueScan(record);
    }
    const part = this.partPath(record) as string;
    const expected = record.validator?.size ?? null;
    let actual: number;
    try {
      actual = fs.statSync(part).size;
    } catch (error) {
      return this.fail(record, 'failed', 'disk', `The finished file is missing: ${(error as Error).message}`);
    }
    if (expected !== null && actual !== expected) {
      return this.fail(record, 'failed', 'size-mismatch', `The file is ${actual} bytes but the server said ${expected}.`);
    }
    const name = record.filename as string;
    const finalName = uniqueName(name, (candidate) => fs.existsSync(path.join(record.dir, candidate)));
    try {
      fs.renameSync(part, path.join(record.dir, finalName));
    } catch (error) {
      return this.fail(record, 'failed', 'disk', `Could not finish the file: ${(error as Error).message}`);
    }
    this.cleanupControlFiles(part);
    record.filename = finalName;
    this.markDownloaded(record, path.join(record.dir, finalName));
    this.markCompleted(record, actual);
    this.queueScan(record);
  }

  /** Finished files wait their turn, so several large ones do not compete for the disk. */
  private queueScan(record: Download): void {
    if (!this.options.scanner || !record.filename) return;
    record.scan = 'pending';
    if (!this.scanQueue.includes(record.id)) this.scanQueue.push(record.id);
    void this.runScans();
  }

  private async runScans(): Promise<void> {
    if (this.scanning || !this.options.scanner) return;
    this.scanning = true;
    try {
      for (let id = this.scanQueue.shift(); id !== undefined && !this.closing; id = this.scanQueue.shift()) {
        const record = this.records.get(id);
        if (!record || record.status !== 'completed' || record.scan !== 'pending' || !record.filename) continue;
        const target = path.join(record.dir, record.filename);
        const verdict = await this.options.scanner.scan(target);
        // The file may have been removed or downloaded again while it was being checked.
        if (this.records.get(id) !== record || record.status !== 'completed' || record.scan !== 'pending') continue;
        record.scan = verdict.result;
        if (verdict.result === 'threat' && verdict.name) record.threatName = verdict.name;
        if (verdict.result !== 'unavailable') this.stats.scanned += 1;
        if (verdict.result === 'threat') this.stats.threats += 1;
        this.changed();
      }
    } finally {
      this.scanning = false;
    }
  }

  /** Done before the file shows as finished, so it is never opened without the mark. */
  private markDownloaded(record: Download, target: string): void {
    if (!this.options.markDownloads) return;
    markFromInternet(target, record.url, record.referrer);
  }

  private markCompleted(record: Download, bytes: number): void {
    this.stats.completed += 1;
    this.stats.completedBytes += bytes;
    const held = this.heldAtStart.get(record.id);
    if (held !== undefined) {
      this.stats.resumedAfterClose += 1;
      this.stats.bytesKept += Math.min(held, bytes);
      this.heldAtStart.delete(record.id);
    }
    record.status = 'completed';
    this.finishedSinceArmed = true;
    record.completedAt = Date.now();
    record.completedBytes = bytes;
    record.totalBytes = bytes;
    record.speed = 0;
    record.connections = 0;
    record.problem = null;
    this.cookies.delete(record.id);
    record.hasCookie = false;
    this.schedule();
  }

  private async onEngineError(record: Download, gid: string, status: EngineStatus): Promise<void> {
    this.gids.delete(record.id);
    await this.engine.call('removeDownloadResult', gid).catch(() => {});
    const code = status.errorCode;
    const message = status.errorMessage ?? 'Unknown error';
    if (code === '9' || code === '15' || code === '16' || code === '17' || code === '18') {
      return this.fail(record, 'failed', 'disk', `Could not write the file (aria2 error ${code}). Check free space and folder permissions.`);
    }
    if (record.kind === 'torrent') return this.fail(record, 'failed', 'network', `The torrent stopped (aria2 error ${code ?? '?'}): ${message}`);
    // aria2's errors are often generic, such as "No URI available" or "Download aborted", so
    // ask the server what is actually wrong before deciding what to tell the user.
    const run = this.runs.get(record.id);
    let found: ProbeResult | null = null;
    try {
      found = await probe({ url: record.url, cookie: this.cookies.get(record.id) ?? null, referrer: record.referrer, userAgent: record.userAgent });
    } catch {
      found = null;
    }
    if (this.runs.get(record.id) !== run) return;
    if (found) {
      if (this.failOnRefusal(record, found.status)) return;
      if (compareValidators(record.validator, found.validator) === 'changed') return this.fail(record, 'attention', 'remote-changed', REMOTE_CHANGED_MESSAGE);
    }
    // A busy server is temporary even on the last connection, so wait instead of failing.
    if (found?.status === 429 || found?.status === 503 || /status=(429|503)/.test(message)) {
      record.status = 'probing';
      record.speed = 0;
      record.connections = 0;
      return this.retryWhenBusy(record, found?.retryAfterSeconds ?? null);
    }
    // The server still offers the same file, so too many connections is the likely cause: some
    // servers answer extra ones with HTTP 429. Continue with fewer before reporting a failure.
    const current = this.connectionTarget(record);
    if (found && current > 1 && record.acceptsRanges) {
      this.connectionLimits.set(record.id, Math.floor(current / 2));
      record.status = 'queued';
      record.speed = 0;
      record.connections = 0;
      this.schedule();
      return;
    }
    // aria2 reports many connection failures as generic error 1, so read the message too.
    if (!found || code === '2' || code === '6' || code === '19' || /network problem|socket|unreachable|timed out|resolve/i.test(message)) {
      return this.fail(record, 'failed', 'network', `The connection failed (aria2 error ${code ?? '?'}). You can try again.`);
    }
    this.fail(record, 'failed', 'server', `The download stopped (aria2 error ${code ?? '?'}): ${message}`);
  }

  private async onEngineCrash(): Promise<void> {
    if (this.closing) return;
    this.gids.clear();
    for (const record of this.records.values()) {
      // yt-dlp does not depend on aria2, so a video keeps going.
      if (record.kind !== 'video' && (record.status === 'downloading' || record.status === 'probing')) {
        this.runs.set(record.id, (this.runs.get(record.id) ?? 0) + 1);
        record.status = 'queued';
        record.speed = 0;
        record.connections = 0;
      }
    }
    this.engineRestarts++;
    if (this.engineRestarts > MAX_ENGINE_RESTARTS) {
      for (const record of this.records.values()) {
        if (record.status === 'queued') {
          record.status = 'failed';
          record.problem = { kind: 'engine', message: 'The download engine keeps stopping. Restart the app to try again.' };
        }
      }
      this.changed();
      return;
    }
    try {
      await this.engine.start();
      await this.applySpeedLimit();
      this.schedule();
    } catch {
      await this.onEngineCrash();
      return;
    }
    this.changed();
  }

  private async applySpeedLimit(): Promise<void> {
    if (this.engine.running) await this.engine.call('changeGlobalOption', { 'max-overall-download-limit': this.settings.speedLimit }).catch(() => {});
  }

  /**
   * Announces once that the queue has run out. Anything queued, including what waits for scheduled
   * hours, still counts as work. A paused file does not, because the user stopped it on purpose.
   */
  private checkQueueFinished(): void {
    if (!this.settings.shutdownWhenDone || !this.finishedSinceArmed || this.closing) return;
    let failed = 0;
    for (const record of this.records.values()) {
      if (record.status === 'downloading' || record.status === 'probing' || record.status === 'queued') return;
      if (record.status === 'failed' || record.status === 'attention') failed++;
    }
    this.settings = { ...this.settings, shutdownWhenDone: false };
    this.finishedSinceArmed = false;
    this.emit('queue-finished', { failed });
  }

  private changed(): void {
    this.checkQueueFinished();
    if (!this.saveTimer && !this.closing) {
      this.saveTimer = setTimeout(() => {
        this.saveTimer = null;
        this.flush();
      }, 2000);
    }
    this.emit('changed', this.state());
  }

  private flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const cookies: Record<string, string> = {};
    if (this.secrets.available) {
      for (const [id, value] of this.cookies) cookies[id] = this.secrets.encrypt(value);
    }
    this.store.save({ version: 1, settings: this.settings, downloads: this.list(), cookies, stats: this.stats });
  }
}
