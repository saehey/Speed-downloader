import { timingSafeEqual } from 'node:crypto';
import net from 'node:net';
import type { BrowserDownload, CaptureDecision } from './capture.ts';

export interface BridgeConfig {
  pipe: string;
  token: string;
  origin: string;
}

const MAX_FRAME = 1024 * 1024;
const MAX_TEXT = 65536;

export function pipePath(name: string): string {
  return `\\\\.\\pipe\\${name}`;
}

export function encodeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

/** Splits a byte stream into messages. Returns null when a frame is too large to be trusted. */
export class FrameReader {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] | null {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: unknown[] = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length > MAX_FRAME) return null;
      if (this.buffer.length < 4 + length) break;
      try {
        messages.push(JSON.parse(this.buffer.subarray(4, 4 + length).toString('utf8')));
      } catch {
        return null;
      }
      this.buffer = this.buffer.subarray(4 + length);
    }
    return messages;
  }
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.length <= MAX_TEXT ? value : null);

export function parseDownloadMessage(message: Record<string, unknown>): BrowserDownload | null {
  const url = text(message.url);
  if (typeof message.id !== 'number' || !Number.isSafeInteger(message.id) || !url) return null;
  return {
    id: message.id,
    url,
    finalUrl: text(message.finalUrl),
    filename: text(message.filename),
    referrer: text(message.referrer),
    mime: text(message.mime),
    totalBytes: typeof message.totalBytes === 'number' ? message.totalBytes : null,
    userAgent: text(message.userAgent),
    cookie: text(message.cookie),
  };
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** A file the page's player really requested, as seen by the extension. */
export interface SeenMedia {
  url: string;
  referrer: string | null;
  origin: string | null;
  cookie: string | null;
  bytes: number | null;
}

export interface VideoRequest {
  url: string;
  referrer: string | null;
  origin: string | null;
  src: string | null;
  format: string | null;
  userAgent: string | null;
  cookie: string | null;
  title: string | null;
  duration: number | null;
  audioOnly: boolean;
  media: SeenMedia[];
}

const MAX_MEDIA = 4;
const number = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null);

function parseMedia(value: unknown): SeenMedia[] {
  if (!Array.isArray(value)) return [];
  const media: SeenMedia[] = [];
  for (const item of value.slice(0, MAX_MEDIA)) {
    if (typeof item !== 'object' || item === null) continue;
    const m = item as Record<string, unknown>;
    const url = text(m.url);
    if (url) media.push({ url, referrer: text(m.referrer), origin: text(m.origin), cookie: text(m.cookie), bytes: number(m.bytes) });
  }
  return media;
}

export interface BridgeHandlers {
  decide(download: BrowserDownload): Promise<CaptureDecision>;
  accepted(download: BrowserDownload, decision: CaptureDecision): void;
  /** Lists a page's qualities. The extension sends this only after the user clicks its button. */
  videoInfo?(request: VideoRequest): Promise<Record<string, unknown>>;
  videoAdd?(request: VideoRequest): void;
}

export function parseVideoMessage(message: Record<string, unknown>): VideoRequest | null {
  const url = text(message.url);
  if (typeof message.id !== 'number' || !Number.isSafeInteger(message.id) || !url) return null;
  return {
    url,
    referrer: text(message.referrer),
    origin: text(message.origin),
    src: text(message.src),
    format: text(message.format),
    userAgent: text(message.userAgent),
    cookie: text(message.cookie),
    title: text(message.title),
    duration: number(message.duration),
    audioOnly: message.audioOnly === true,
    media: parseMedia(message.media),
  };
}

/** The window explains each kind in the user's language, so raw error text stays in the app. */
const problemOf = (error: unknown): string => (error as { kind?: unknown })?.kind && typeof (error as { kind: unknown }).kind === 'string' ? (error as { kind: string }).kind : 'server';

/**
 * Local channel to the native host. A connection must prove itself with the install's token and
 * the extension's origin before anything else is read. Any failure ends the connection, and the
 * extension then lets the browser finish the download itself.
 */
export class BrowserBridge {
  private readonly config: BridgeConfig;
  private readonly handlers: BridgeHandlers;
  private readonly server: net.Server;
  private readonly sockets = new Set<net.Socket>();

  constructor(config: BridgeConfig, handlers: BridgeHandlers) {
    this.config = config;
    this.handlers = handlers;
    this.server = net.createServer((socket) => this.onConnection(socket));
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(pipePath(this.config.pipe), () => {
        this.server.off('error', reject);
        resolve();
      });
    });
  }

  close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private onConnection(socket: net.Socket): void {
    this.sockets.add(socket);
    const reader = new FrameReader();
    let authenticated = false;
    const helloTimer = setTimeout(() => socket.destroy(), 5000);
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      clearTimeout(helloTimer);
      this.sockets.delete(socket);
    });
    socket.on('data', (chunk) => {
      const messages = reader.push(chunk as Buffer);
      if (!messages) return void socket.destroy();
      for (const raw of messages) {
        if (typeof raw !== 'object' || raw === null) return void socket.destroy();
        const message = raw as Record<string, unknown>;
        if (!authenticated) {
          const token = text(message.token);
          if (message.type !== 'hello' || !token || !sameSecret(token, this.config.token) || message.origin !== this.config.origin) {
            return void socket.destroy();
          }
          authenticated = true;
          clearTimeout(helloTimer);
          socket.write(encodeFrame({ type: 'ready' }));
          continue;
        }
        if (message.type === 'download') void this.onDownload(socket, message);
        else if (message.type === 'video-info' || message.type === 'video-add') void this.onVideo(socket, message);
      }
    });
  }

  private async onVideo(socket: net.Socket, message: Record<string, unknown>): Promise<void> {
    const request = parseVideoMessage(message);
    if (!request) return;
    let reply: Record<string, unknown>;
    try {
      if (message.type === 'video-info') {
        if (!this.handlers.videoInfo) throw new Error('Not available.');
        reply = { ok: true, ...(await this.handlers.videoInfo(request)) };
      } else {
        if (!this.handlers.videoAdd) throw new Error('Not available.');
        this.handlers.videoAdd(request);
        reply = { ok: true };
      }
    } catch (error) {
      reply = { ok: false, problem: problemOf(error) };
    }
    if (!socket.destroyed) socket.write(encodeFrame({ type: 'video-result', id: message.id, ...reply }));
  }

  private async onDownload(socket: net.Socket, message: Record<string, unknown>): Promise<void> {
    const download = parseDownloadMessage(message);
    if (!download) return;
    let decision: CaptureDecision;
    try {
      decision = await this.handlers.decide(download);
    } catch {
      decision = { accept: false, reason: 'error' };
    }
    if (decision.accept) {
      try {
        this.handlers.accepted(download, decision);
      } catch {
        decision = { accept: false, reason: 'rejected-by-queue' };
      }
    }
    if (!socket.destroyed) {
      socket.write(encodeFrame({ type: 'decision', id: download.id, decision: decision.accept ? 'accept' : 'reject', reason: decision.reason }));
    }
  }
}
