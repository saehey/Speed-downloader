import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BrowserBridge, encodeFrame, FrameReader, parseDownloadMessage, pipePath } from '../src/core/bridge.ts';
import type { BridgeConfig } from '../src/core/bridge.ts';
import { decideCapture, matchesCaptureRules } from '../src/core/capture.ts';
import type { BrowserDownload } from '../src/core/capture.ts';
import { probe } from '../src/core/probe.ts';
import { categoryOf, parseExtensions } from '../src/shared/categories.ts';
import type { ProbeResult } from '../src/core/probe.ts';
import { randomBody, sleep, TestServer } from './helpers.ts';

const big = 10 * 1024 * 1024;
const download = (over: Partial<BrowserDownload> = {}): BrowserDownload => ({ id: 1, url: 'https://a.test/file.zip', totalBytes: big, mime: 'application/zip', ...over });
const found = (over: Partial<ProbeResult> = {}): ProbeResult => ({ status: 206, finalUrl: 'https://a.test/file.zip', acceptsRanges: true, validator: { etag: '"1"', lastModified: null, size: big }, filename: null, contentType: 'application/zip', retryAfterSeconds: null, ...over });

test('video questions need the same proof as downloads, and problems come back as a kind only', async () => {
  const config = { pipe: `sd-video-test-${process.pid}`, token: 'secret-token', origin: 'chrome-extension://abc/' };
  const added: string[] = [];
  const bridge = new BrowserBridge(config, {
    decide: async () => ({ accept: false, reason: 'unused' }),
    accepted: () => {},
    videoInfo: async (request) => {
      if (request.url.includes('bad')) throw Object.assign(new Error('secret detail C:\\Users\\name'), { kind: 'video-drm' });
      return { title: 'Clip', url: request.url, choices: [{ format: '18' }] };
    },
    videoAdd: (request) => { added.push(`${request.url}|${request.format}`); },
  });
  await bridge.listen();
  const connect = async (token: string) => {
    const socket = net.connect(pipePath(config.pipe));
    const reader = new FrameReader();
    const inbox: Array<Record<string, unknown>> = [];
    socket.on('data', (chunk) => inbox.push(...((reader.push(chunk as Buffer) ?? []) as Array<Record<string, unknown>>)));
    socket.on('error', () => {});
    await new Promise((resolve) => socket.once('connect', resolve));
    socket.write(encodeFrame({ type: 'hello', token, origin: config.origin }));
    return { socket, inbox };
  };
  try {
    const stranger = await connect('wrong-token');
    stranger.socket.write(encodeFrame({ type: 'video-add', id: 1, url: 'https://evil.test/', format: '18' }));
    await sleep(150);
    assert.deepEqual(added, []);
    stranger.socket.destroy();

    const { socket, inbox } = await connect(config.token);
    socket.write(encodeFrame({ type: 'video-info', id: 2, url: 'https://a.test/w' }));
    socket.write(encodeFrame({ type: 'video-info', id: 3, url: 'https://a.test/bad' }));
    socket.write(encodeFrame({ type: 'video-add', id: 4, url: 'https://a.test/w', format: '18' }));
    await sleep(150);
    const of = (id: number) => inbox.find((m) => m.type === 'video-result' && m.id === id);
    assert.equal(of(2)?.title, 'Clip');
    assert.deepEqual(of(3), { type: 'video-result', id: 3, ok: false, problem: 'video-drm' });
    assert.equal(of(4)?.ok, true);
    assert.deepEqual(added, ['https://a.test/w|18']);
    socket.destroy();
  } finally {
    await bridge.close();
  }
});

test('capture rules take large files and leave pages and small files to the browser', () => {
  assert.equal(matchesCaptureRules(download()).match, true);
  assert.equal(matchesCaptureRules(download({ url: 'https://a.test/x', mime: 'video/mp4' })).match, true);
  assert.equal(matchesCaptureRules(download({ url: 'https://a.test/x', mime: 'application/octet-stream', totalBytes: -1 })).match, true);
  assert.equal(matchesCaptureRules(download({ url: 'https://a.test/page.html', mime: 'text/html' })).match, false);
  assert.equal(matchesCaptureRules(download({ totalBytes: 1000 })).reason, 'too-small');
  assert.equal(matchesCaptureRules(download({ url: 'blob:https://a.test/1' })).reason, 'unsupported-scheme');
  assert.equal(matchesCaptureRules(download({ url: 'https://a.test/x', filename: 'movie.mkv', mime: null })).reason, 'extension');
});

test('an unknown size is not treated as a small file', async () => {
  for (const totalBytes of [0, -1, null]) {
    assert.equal(matchesCaptureRules(download({ totalBytes })).match, true, String(totalBytes));
    const large = await decideCapture(download({ totalBytes }), true, async () => found());
    assert.equal(large.accept, true, String(totalBytes));
    const small = await decideCapture(download({ totalBytes }), true, async () => found({ validator: { etag: '"1"', lastModified: null, size: 10860 } }));
    assert.equal(small.reason, 'too-small', String(totalBytes));
  }
});

test('many file types are captured and sorted, and the user can add more', () => {
  for (const name of ['movie.mkv', 'clip.webm', 'song.flac', 'book.epub', 'slides.pptx', 'setup.msi', 'disk.iso', 'data.7z', 'image.vmdk']) {
    assert.equal(matchesCaptureRules(download({ url: `https://a.test/${name}`, mime: null })).match, true, name);
  }
  assert.equal(categoryOf('movie.MKV'), 'video');
  assert.equal(categoryOf('song.flac'), 'audio');
  assert.equal(categoryOf('book.epub'), 'document');
  assert.equal(categoryOf('setup.msi'), 'program');
  assert.equal(categoryOf('data.7z'), 'archive');
  assert.equal(categoryOf('notes.unknown'), 'other');
  assert.equal(categoryOf(null), 'other');
  const custom = download({ url: 'https://a.test/game.nds', mime: null });
  assert.equal(matchesCaptureRules(custom).match, false);
  assert.equal(matchesCaptureRules(custom, ['nds']).reason, 'extra-extension');
  assert.equal(matchesCaptureRules(download({ url: 'https://a.test/notes.txt', mime: null }), ['txt']).match, true);
  assert.deepEqual(parseExtensions('.DAT, nds; bad!value  iso .dat'), ['dat', 'nds', 'iso']);
});

test('text and image names stay in the browser whatever type is reported', () => {
  for (const mime of ['text/plain', 'application/octet-stream', '', null]) {
    assert.equal(matchesCaptureRules(download({ url: 'https://a.test/notes.txt', mime })).reason, 'browser-file-type', String(mime));
  }
  assert.equal(matchesCaptureRules(download({ url: 'https://a.test/x', filename: 'photo.JPG', mime: 'application/octet-stream' })).match, false);
  assert.equal(matchesCaptureRules(download({ url: 'https://a.test/data.dat', mime: 'application/octet-stream' })).match, true);
});

test('stays in the browser whenever the app cannot fetch the same file', async () => {
  const decide = (over: Partial<ProbeResult>, d = download()) => decideCapture(d, true, async () => found(over));
  assert.equal((await decide({})).accept, true);
  assert.equal((await decide({ status: 200, acceptsRanges: false })).accept, true);
  assert.equal((await decide({ status: 403 })).reason, 'probe-status-403');
  assert.equal((await decide({ status: 405 })).reason, 'probe-status-405');
  assert.equal((await decide({ validator: { etag: null, lastModified: null, size: 5 } })).reason, 'size-differs');
  assert.equal((await decide({ contentType: 'text/html' })).reason, 'got-html-instead');
  assert.equal((await decideCapture(download(), false, async () => found())).reason, 'capture-off');
  assert.equal((await decideCapture(download(), true, async () => { throw new Error('down'); })).reason, 'probe-failed');
});

test('uses the address found by the check', async () => {
  const d = await decideCapture(download(), true, async () => found({ finalUrl: 'https://b.test/real.zip' }));
  assert.equal(d.url, 'https://b.test/real.zip');
});

test('a single-use link stays in the browser (real HTTP)', async () => {
  const server = new TestServer();
  await server.listen();
  try {
    server.routes.set('/once.zip', { body: randomBody(1024), deny: 403 });
    const d = await decideCapture(download({ url: `${server.base}/once.zip`, totalBytes: 1024 * 1024 }), true, probe);
    assert.equal(d.accept, false);
    assert.equal(d.reason, 'probe-status-403');
  } finally {
    await server.close();
  }
});

test('frames survive being split and reject oversized input', () => {
  const reader = new FrameReader();
  const frame = encodeFrame({ a: 'ทดสอบ' });
  assert.deepEqual(reader.push(frame.subarray(0, 3)), []);
  assert.deepEqual(reader.push(frame.subarray(3, 9)), []);
  assert.deepEqual(reader.push(Buffer.concat([frame.subarray(9), encodeFrame({ b: 2 })])), [{ a: 'ทดสอบ' }, { b: 2 }]);
  const huge = Buffer.alloc(4);
  huge.writeUInt32LE(5 * 1024 * 1024);
  assert.equal(new FrameReader().push(huge), null);
  const bad = Buffer.alloc(6);
  bad.writeUInt32LE(2);
  assert.equal(new FrameReader().push(bad), null);
});

test('malformed download messages are ignored', () => {
  assert.equal(parseDownloadMessage({ id: 'x', url: 'https://a' }), null);
  assert.equal(parseDownloadMessage({ id: 1 }), null);
  assert.equal(parseDownloadMessage({ id: 1, url: 'x'.repeat(70000) }), null);
  assert.equal(parseDownloadMessage({ id: 1, url: 'https://a', cookie: 5 })?.cookie, null);
});

function testConfig(): BridgeConfig {
  return { pipe: `downloader-test-${crypto.randomBytes(6).toString('hex')}`, token: crypto.randomBytes(16).toString('hex'), origin: 'chrome-extension://abc/' };
}

function connect(config: BridgeConfig): Promise<{ socket: net.Socket; next: () => Promise<unknown>; closed: Promise<void> }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipePath(config.pipe));
    const reader = new FrameReader();
    const queue: unknown[] = [];
    const waiters: Array<(m: unknown) => void> = [];
    socket.on('data', (chunk) => {
      for (const m of reader.push(chunk as Buffer) ?? []) {
        const w = waiters.shift();
        if (w) w(m); else queue.push(m);
      }
    });
    socket.once('error', reject);
    const closed = new Promise<void>((r) => socket.once('close', () => r()));
    socket.once('connect', () => resolve({ socket, closed, next: () => new Promise((r) => { const m = queue.shift(); if (m) r(m); else waiters.push(r); }) }));
  });
}

test('the bridge refuses a wrong token or origin and answers a valid client', async () => {
  const config = testConfig();
  const accepted: string[] = [];
  const bridge = new BrowserBridge(config, {
    decide: async (d) => (d.url.includes('good') ? { accept: true, reason: 'ok', url: d.url } : { accept: false, reason: 'nope' }),
    accepted: (d) => accepted.push(d.url),
  });
  await bridge.listen();
  try {
    const wrongToken = await connect(config);
    wrongToken.socket.write(encodeFrame({ type: 'hello', token: 'wrong', origin: config.origin }));
    await wrongToken.closed;

    const wrongOrigin = await connect(config);
    wrongOrigin.socket.write(encodeFrame({ type: 'hello', token: config.token, origin: 'chrome-extension://evil/' }));
    await wrongOrigin.closed;

    const noHello = await connect(config);
    noHello.socket.write(encodeFrame({ type: 'download', id: 1, url: 'https://good.test/a.zip' }));
    await noHello.closed;
    assert.deepEqual(accepted, [], 'nothing was accepted before authentication');

    const good = await connect(config);
    good.socket.write(encodeFrame({ type: 'hello', token: config.token, origin: config.origin }));
    assert.deepEqual(await good.next(), { type: 'ready' });
    good.socket.write(encodeFrame({ type: 'download', id: 7, url: 'https://good.test/a.zip' }));
    assert.deepEqual(await good.next(), { type: 'decision', id: 7, decision: 'accept', reason: 'ok' });
    good.socket.write(encodeFrame({ type: 'download', id: 8, url: 'https://bad.test/a.zip' }));
    assert.deepEqual(await good.next(), { type: 'decision', id: 8, decision: 'reject', reason: 'nope' });
    assert.deepEqual(accepted, ['https://good.test/a.zip']);
    good.socket.destroy();
  } finally {
    await bridge.close();
  }
});

test('the real native host relays messages and exits when the browser closes it', async (t) => {
  const built = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'native-host', 'build', 'downloader-host.exe');
  if (!fs.existsSync(built)) return t.skip('Run npm run setup-browser first.');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'downloader-host-'));
  const exe = path.join(dir, 'downloader-host.exe');
  fs.copyFileSync(built, exe);
  const config = testConfig();
  fs.writeFileSync(path.join(dir, 'host-config.txt'), [config.pipe, config.token, '', ''].join('\r\n'));
  const bridge = new BrowserBridge(config, {
    decide: async () => ({ accept: true, reason: 'ok', url: 'https://a.test/' }),
    accepted: () => {},
  });
  await bridge.listen();
  const child = spawn(exe, [config.origin, '--parent-window=0'], { stdio: 'pipe', windowsHide: true });
  try {
    const reader = new FrameReader();
    const messages: unknown[] = [];
    child.stdout.on('data', (chunk: Buffer) => messages.push(...(reader.push(chunk) ?? [])));
    child.stdin.write(encodeFrame({ type: 'download', id: 42, url: 'https://a.test/file.zip', cookie: 'a=ทดสอบ' }));
    const limit = Date.now() + 10000;
    while (messages.length < 2 && Date.now() < limit) await sleep(25);
    assert.deepEqual(messages, [{ type: 'ready' }, { type: 'decision', id: 42, decision: 'accept', reason: 'ok' }]);
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.stdin.end();
    assert.equal(await Promise.race([exited, sleep(5000).then(() => 'still running')]), 0);
  } finally {
    child.kill();
    await bridge.close();
    await sleep(100);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the native host exits without an app, so the browser can carry on', async (t) => {
  const built = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'native-host', 'build', 'downloader-host.exe');
  if (!fs.existsSync(built)) return t.skip('Run npm run setup-browser first.');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'downloader-host-'));
  const exe = path.join(dir, 'downloader-host.exe');
  fs.copyFileSync(built, exe);
  const config = testConfig();
  fs.writeFileSync(path.join(dir, 'host-config.txt'), [config.pipe, config.token, 'C:\\does-not-exist.exe', ''].join('\r\n'));
  const child = spawn(exe, [config.origin], { stdio: 'pipe', windowsHide: true });
  const code = await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(15000).then(() => 'still running')]);
  child.kill();
  await sleep(100);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(code, 3);
});
