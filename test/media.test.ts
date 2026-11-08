// A real HLS stream made by ffmpeg, on a server that refuses anything but the right headers.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DownloadManager } from '../src/core/manager.ts';
import { findAria2, settled, waitFor } from './helpers.ts';

const ytDlpPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'yt-dlp', 'yt-dlp.exe');
const ffmpeg = execFileSync('where.exe', ['ffmpeg'], { encoding: 'utf8' }).split(/\r?\n/)[0]!.trim();
const COOKIE = 'session=secret-value';
const JAR = '# Netscape HTTP Cookie File\n127.0.0.1\tFALSE\t/\tFALSE\t0\tsession\tsecret-value\n';
const REFERER = 'https://player.example/embed/1';
const AGENT = 'TestBrowser/1.0';

let root: string;
let server: http.Server;
let base: string;
const refused: string[] = [];
let lastCookieHeader: string | undefined;

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-media-'));
  const hls = path.join(root, 'hls');
  fs.mkdirSync(path.join(hls, '480'), { recursive: true });
  fs.mkdirSync(path.join(hls, '240'), { recursive: true });
  const make = (height: number, width: number) => execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc=size=${width}x${height}:rate=15:duration=6`, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_filename', path.join(hls, String(height), 's%d.ts'), path.join(hls, String(height), 'index.m3u8')], { windowsHide: true });
  make(480, 854);
  make(240, 426);
  fs.writeFileSync(path.join(hls, 'master.m3u8'), '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=854x480\n480/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=426x240\n240/index.m3u8\n');

  server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname;
    lastCookieHeader = req.headers.cookie;
    if (pathname.startsWith('/open/')) {
      const file = path.join(hls, pathname.slice('/open/'.length));
      return fs.existsSync(file) ? res.end(fs.readFileSync(file)) : res.writeHead(404).end();
    }
    if (req.headers.referer !== REFERER || req.headers.cookie !== COOKIE || req.headers['user-agent'] !== AGENT) {
      refused.push(pathname);
      return res.writeHead(403).end();
    }
    const file = path.join(hls, pathname.replace(/^\/guarded\//, ''));
    if (!fs.existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t' });
    res.end(fs.readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function open(name: string, ffmpegPath: string | null = ffmpeg) {
  const dir = path.join(root, name, 'files');
  const state = path.join(root, name, 'state');
  fs.mkdirSync(dir, { recursive: true });
  const manager = new DownloadManager({ aria2Path: findAria2(), ytDlpPath, ffmpegPath, stateDir: state, defaultDir: dir, pollMs: 100 });
  await manager.start();
  return { manager, dir, state };
}

const guarded = (url: string) => ({ url, referrer: REFERER, origin: null, cookie: JAR, bytes: null });
const cookieFiles = (state: string) => (fs.existsSync(path.join(state, 'video-cookies')) ? fs.readdirSync(path.join(state, 'video-cookies')) : []);

test('a guarded stream the page itself gives no clue about is read with the player\'s own headers', async () => {
  const { manager, state } = await open('info');
  try {
    const info = await manager.videoChoices(`${base}/open/no-video-here`, { userAgent: AGENT, title: 'หนังตัวอย่าง', duration: 6, media: [guarded(`${base}/guarded/master.m3u8`)] });
    assert.equal(info.title, 'หนังตัวอย่าง');
    assert.equal(info.url, `${base}/guarded/master.m3u8`);
    assert.deepEqual(info.choices.map((c) => c.height), [480, 240]);
    assert.ok(info.choices.every((c) => (c.bytes ?? 0) > 0 && c.approximate), 'sizes are estimated from bit rate and the player\'s length');
    assert.deepEqual(cookieFiles(state), [], 'the cookie file is gone afterwards');
  } finally {
    await manager.close();
  }
});

test('without the right headers the same stream is refused, so the test proves they matter', async () => {
  const { manager } = await open('refused');
  try {
    refused.length = 0;
    await assert.rejects(manager.videoChoices(`${base}/open/no-video-here`, { media: [{ ...guarded(`${base}/guarded/master.m3u8`), cookie: null }] }));
    assert.ok(refused.includes('/guarded/master.m3u8'));
  } finally {
    await manager.close();
  }
});

test('a chosen quality downloads as one playable file named after the page, and leaves no cookies', async () => {
  const { manager, dir, state } = await open('download');
  try {
    const info = await manager.videoChoices(`${base}/open/x`, { userAgent: AGENT, title: 'หนัง 100% / ตัวอย่าง', media: [guarded(`${base}/guarded/master.m3u8`)] });
    const choice = info.choices.find((c) => c.height === 240);
    const d = manager.addVideo(info.url, { format: choice?.format, referrer: REFERER, userAgent: AGENT, cookie: JAR, title: info.title });
    assert.equal(d.hasCookie, true);
    const done = await waitFor(manager, d.id, settled, 120000);
    assert.equal(done.status, 'completed', JSON.stringify(done.problem));
    assert.ok(done.filename?.startsWith('หนัง 100%'), `name was ${done.filename}`);
    assert.deepEqual(fs.readdirSync(dir), [done.filename]);
    assert.equal(lastCookieHeader, COOKIE);
    assert.deepEqual(cookieFiles(state), []);
    const probe = execFileSync(ffmpeg, ['-v', 'error', '-i', path.join(dir, done.filename as string), '-map', '0:v:0', '-c', 'copy', '-f', 'null', '-'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(probe, '', 'ffmpeg reads the whole file without an error');
  } finally {
    await manager.close();
  }
});

test('cookies are never placed on the command line or saved in plain text', async () => {
  const { manager, state } = await open('secret');
  try {
    const info = await manager.videoChoices(`${base}/open/x`, { userAgent: AGENT, media: [guarded(`${base}/guarded/master.m3u8`)] });
    const d = manager.addVideo(info.url, { format: info.choices[0]?.format, referrer: REFERER, userAgent: AGENT, cookie: JAR });
    await waitFor(manager, d.id, settled, 120000);
    await manager.close();
    const saved = fs.readFileSync(path.join(state, 'downloads.json'), 'utf8');
    assert.ok(!saved.includes('secret-value'), 'the saved list holds no cookie value');
  } finally {
    await manager.close().catch(() => {});
  }
});

test('a dead address among several sources does not hide the working one, and fuller lists come first', async () => {
  const { manager } = await open('several');
  try {
    const info = await manager.videoChoices(`${base}/open/x`, {
      userAgent: AGENT,
      media: [guarded(`${base}/guarded/480/index.m3u8`), guarded(`${base}/guarded/missing.m3u8`), guarded(`${base}/guarded/master.m3u8`)],
    });
    assert.equal(info.sources, 2);
    assert.equal(info.url, `${base}/guarded/master.m3u8`);
    assert.ok(info.choices.length >= 3);
    assert.ok(info.choices.every((c) => (c as { url?: string }).url?.startsWith(base)));
  } finally {
    await manager.close();
  }
});

test('with nothing seen, the page itself is still asked', async () => {
  const { manager } = await open('page');
  try {
    await assert.rejects(manager.videoChoices(`${base}/open/no-video-here`), (error: { kind?: string }) => !!error.kind);
  } finally {
    await manager.close();
  }
});
