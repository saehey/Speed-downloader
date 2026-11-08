import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DownloadManager } from '../src/core/manager.ts';
import type { ManagerOptions } from '../src/core/manager.ts';
import type { SecretStore } from '../src/core/store.ts';
import type { Download } from '../src/shared/types.ts';

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export const sha = (data: Buffer) => crypto.createHash('sha256').update(data).digest('hex');
export const MB = 1024 * 1024;

export function findAria2(): string {
  if (process.env.ARIA2C_PATH) return process.env.ARIA2C_PATH;
  const pathVar = `${process.env.Path ?? ''};${execFileSync('powershell.exe', ['-NoProfile', '-Command', "[Environment]::GetEnvironmentVariable('Path','User')"], { encoding: 'utf8' }).trim()}`;
  return execFileSync('where.exe', ['aria2c'], { encoding: 'utf8', env: { ...process.env, Path: pathVar } }).split(/\r?\n/)[0]!.trim();
}

export interface Route {
  body: Buffer;
  etag?: string | null;
  lastModified?: string | null;
  ranges?: boolean;
  cookie?: string;
  deny?: number;
  disposition?: string;
  redirect?: string;
  /** Answers HTTP 429 once this many transfers of the route are running. */
  maxConnections?: number;
  contentType?: string;
}

export interface Hit {
  path: string;
  range: string | null;
  cookie: string | null;
  bytes: number;
  refused?: boolean;
}

export class TestServer {
  readonly routes = new Map<string, Route>();
  readonly hits: Hit[] = [];
  active = 0;
  private readonly server: http.Server;
  private readonly live = new Set<http.ServerResponse>();
  private readonly running = new Map<string, number>();

  constructor() {
    this.server = http.createServer((req, res) => void this.handle(req, res));
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
  }

  get base(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  bytes(p: string): number {
    return this.hits.filter((h) => h.path === p).reduce((sum, h) => sum + h.bytes, 0);
  }

  dropConnections(): void {
    for (const res of this.live) res.destroy();
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const p = new URL(req.url ?? '/', 'http://x').pathname;
    const route = this.routes.get(p);
    const hit: Hit = { path: p, range: req.headers.range ?? null, cookie: req.headers.cookie ?? null, bytes: 0 };
    this.hits.push(hit);
    res.setMaxListeners(0);
    if (!route) { res.writeHead(404); res.end(); return; }
    if (route.redirect) { res.writeHead(302, { Location: route.redirect }); res.end(); return; }
    if (route.deny) { res.writeHead(route.deny); res.end(); return; }
    if (route.cookie && req.headers.cookie !== route.cookie) { res.writeHead(403); res.end(); return; }
    const isProbe = req.headers.range === 'bytes=0-0';
    const running = this.running.get(p) ?? 0;
    if (route.maxConnections !== undefined && !isProbe && running >= route.maxConnections) {
      hit.refused = true;
      res.writeHead(429);
      res.end();
      return;
    }
    if (!isProbe) this.running.set(p, running + 1);
    res.on('close', () => { if (!isProbe) this.running.set(p, (this.running.get(p) ?? 1) - 1); });
    const body = route.body;
    const ranges = route.ranges !== false;
    let start = 0;
    let end = body.length - 1;
    let code = 200;
    const m = ranges ? /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '') : null;
    if (m) {
      start = Number(m[1]);
      if (m[2]) end = Math.min(Number(m[2]), end);
      code = 206;
    }
    const headers: Record<string, string | number> = { 'Content-Type': route.contentType ?? 'application/octet-stream', 'Content-Length': end - start + 1 };
    if (ranges) headers['Accept-Ranges'] = 'bytes';
    if (route.etag) headers.ETag = route.etag;
    if (route.lastModified) headers['Last-Modified'] = route.lastModified;
    if (route.disposition) headers['Content-Disposition'] = route.disposition;
    if (code === 206) headers['Content-Range'] = `bytes ${start}-${end}/${body.length}`;
    res.writeHead(code, headers);
    this.live.add(res);
    this.active++;
    let closed = false;
    res.on('close', () => { closed = true; });
    let offset = start;
    while (offset <= end && !closed) {
      const chunk = body.subarray(offset, Math.min(offset + 16 * 1024, end + 1));
      offset += chunk.length;
      hit.bytes += chunk.length;
      if (!res.write(chunk)) await new Promise((resolve) => { res.once('drain', resolve); res.once('close', resolve); });
      await sleep(10);
    }
    if (!closed) res.end();
    this.active--;
    this.live.delete(res);
  }
}

export const fakeSecrets: SecretStore = {
  available: true,
  encrypt: (value) => Buffer.from(value).reverse().toString('base64'),
  decrypt: (value) => Buffer.from(value, 'base64').reverse().toString(),
};

export interface Harness {
  dir: string;
  state: string;
  manager: DownloadManager;
  server: TestServer;
  aria2: string;
  open(options?: Partial<ManagerOptions>): Promise<DownloadManager>;
  dispose(): Promise<void>;
}

export async function harness(options: Partial<ManagerOptions> = {}): Promise<Harness> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'downloader-test-'));
  const dir = path.join(root, 'files');
  const state = path.join(root, 'state');
  fs.mkdirSync(dir);
  const server = new TestServer();
  await server.listen();
  const aria2 = findAria2();
  const open = async (more: Partial<ManagerOptions> = {}) => {
    const manager = new DownloadManager({ aria2Path: aria2, stateDir: state, defaultDir: dir, pollMs: 100, ...options, ...more });
    await manager.start();
    h.manager = manager;
    return manager;
  };
  const h: Harness = {
    dir,
    state,
    server,
    aria2,
    manager: null as unknown as DownloadManager,
    open,
    dispose: async () => {
      await h.manager?.close().catch(() => {});
      await server.close();
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          fs.rmSync(root, { recursive: true, force: true });
          return;
        } catch {
          await sleep(100);
        }
      }
    },
  };
  await open();
  return h;
}

export async function waitFor(manager: DownloadManager, id: string, test: (d: Download) => boolean, ms = 60000): Promise<Download> {
  const limit = Date.now() + ms;
  for (;;) {
    const d = manager.get(id);
    if (d && test(d)) return d;
    if (Date.now() > limit) throw new Error(`Timed out. Last state: ${JSON.stringify(d)}`);
    await sleep(50);
  }
}

export const settled = (d: Download) => d.status === 'completed' || d.status === 'failed' || d.status === 'attention';
export const atProgress = (fraction: number) => (d: Download) => settled(d) || (d.totalBytes > 0 && d.completedBytes >= fraction * d.totalBytes);

export function randomBody(size: number): Buffer {
  return crypto.randomBytes(size);
}

export function filesIn(dir: string): string[] {
  return fs.readdirSync(dir).sort();
}
