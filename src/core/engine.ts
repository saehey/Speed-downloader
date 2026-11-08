import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export interface EngineOptions {
  aria2Path: string;
  stateDir: string;
  fileAllocation?: string;
  /** Extra aria2 options. Tests use this to keep BitTorrent on the loopback interface. */
  extraConf?: Record<string, string>;
}

export interface EngineStatus {
  gid: string;
  status: 'active' | 'waiting' | 'paused' | 'error' | 'complete' | 'removed';
  totalLength: string;
  completedLength: string;
  downloadSpeed: string;
  connections: string;
  errorCode?: string;
  errorMessage?: string;
  /** A magnet's metadata download names the real download here when it finishes. */
  followedBy?: string[];
  bittorrent?: { info?: { name?: string } };
}

const STATUS_KEYS = ['gid', 'status', 'totalLength', 'completedLength', 'downloadSpeed', 'connections', 'errorCode', 'errorMessage', 'followedBy', 'bittorrent'];

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => (address && typeof address === 'object' ? resolve(address.port) : reject(new Error('No port'))));
    });
  });
}

/**
 * Owns one aria2c process. The RPC port and secret change on every start and the config file
 * holding the secret is deleted once aria2 is up. No session file is used, because aria2 writes
 * request headers, including cookies, into it as plain text.
 */
export class Aria2Engine extends EventEmitter {
  private readonly options: EngineOptions;
  private child: ChildProcess | null = null;
  private port = 0;
  private secret = '';
  private stopping = false;

  constructor(options: EngineOptions) {
    super();
    this.options = options;
  }

  get running(): boolean {
    return this.child !== null;
  }

  async start(): Promise<void> {
    if (this.child) return;
    this.stopping = false;
    this.port = await freePort();
    this.secret = randomBytes(24).toString('hex');
    fs.mkdirSync(this.options.stateDir, { recursive: true });
    const confPath = path.join(this.options.stateDir, `aria2-${process.pid}.conf`);
    const conf: Record<string, string | number> = {
      'enable-rpc': 'true',
      'rpc-listen-port': this.port,
      'rpc-listen-all': 'false',
      'rpc-secret': this.secret,
      'max-concurrent-downloads': 64,
      continue: 'true',
      'auto-file-renaming': 'false',
      'allow-overwrite': 'false',
      'file-allocation': this.options.fileAllocation ?? 'falloc',
      'auto-save-interval': 1,
      'max-tries': 5,
      'retry-wait': 3,
      'connect-timeout': 30,
      timeout: 60,
      'console-log-level': 'error',
      'summary-interval': 0,
      'stop-with-process': process.pid,
      // aria2 does not fall back to IPv4 when a host has an IPv6 address the network cannot reach,
      // so such downloads failed every time even though the browser could fetch them.
      'disable-ipv6': 'true',
      // A download ends when the file is complete, so the app never keeps uploading afterwards.
      'seed-time': 0,
      'follow-torrent': 'mem',
      'bt-save-metadata': 'false',
      // Otherwise each added torrent leaves a <hash>.torrent in the user's folder. The app keeps its own copy.
      'rpc-save-upload-metadata': 'false',
      'dht-file-path': path.join(this.options.stateDir, 'dht.dat'),
      ...this.options.extraConf,
    };
    fs.writeFileSync(confPath, Object.entries(conf).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });

    const child = spawn(this.options.aria2Path, [`--conf-path=${confPath}`], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
    this.child = child;
    let failure: Error | null = null;
    child.once('error', (error) => { failure = error; });
    child.once('exit', (code) => {
      this.child = null;
      if (!this.stopping) this.emit('crashed', code);
    });

    try {
      for (let attempt = 0; ; attempt++) {
        if (failure) throw failure;
        if (!this.child) throw new Error('aria2 exited during start');
        try {
          await this.call('getVersion');
          return;
        } catch (error) {
          if (attempt >= 100) throw error;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    } catch (error) {
      this.stopping = true;
      child.kill();
      throw error;
    } finally {
      fs.rmSync(confPath, { force: true });
    }
  }

  async call<T = unknown>(method: string, ...params: unknown[]): Promise<T> {
    const response = await fetch(`http://127.0.0.1:${this.port}/jsonrpc`, {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: '1', method: `aria2.${method}`, params: [`token:${this.secret}`, ...params] }),
      signal: AbortSignal.timeout(10000),
    });
    const json = (await response.json()) as { result?: T; error?: { code: number; message: string } };
    if (json.error) throw new Error(`aria2 ${method}: ${json.error.message}`);
    return json.result as T;
  }

  addUri(url: string, options: Record<string, unknown>): Promise<string> {
    return this.call<string>('addUri', [url], options);
  }

  addTorrent(data: Buffer, options: Record<string, unknown>): Promise<string> {
    return this.call<string>('addTorrent', data.toString('base64'), [], options);
  }

  tellStatus(gid: string): Promise<EngineStatus> {
    return this.call<EngineStatus>('tellStatus', gid, STATUS_KEYS);
  }

  /** Stops one download and leaves its partial file and control file on disk. */
  async stopDownload(gid: string): Promise<void> {
    try {
      await this.call('forceRemove', gid);
    } catch {
      return;
    }
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const status = await this.tellStatus(gid);
        if (status.status === 'removed' || status.status === 'error' || status.status === 'complete') break;
      } catch {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await this.call('removeDownloadResult', gid).catch(() => {});
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    // Partial files stay resumable: the control file is saved every second and tests cover a hard stop.
    await this.call('forceShutdown').catch(() => {});
    const timer = setTimeout(() => child.kill(), 1500);
    await exited;
    clearTimeout(timer);
  }

  /** Ends the process abruptly. Only tests use this, to simulate a crash. */
  killForTest(): void {
    this.child?.kill();
  }
}
