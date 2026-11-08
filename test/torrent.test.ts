// BitTorrent tests run entirely on loopback: a tiny tracker, one aria2 seeder and the real manager.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { DownloadManager } from '../src/core/manager.ts';
import { findAria2, MB, randomBody, settled, sha, sleep, waitFor } from './helpers.ts';

type Bencodable = string | number | Buffer | Bencodable[] | { [key: string]: Bencodable };

function bencode(value: Bencodable): Buffer {
  if (typeof value === 'number') return Buffer.from(`i${value}e`);
  if (typeof value === 'string') return bencode(Buffer.from(value));
  if (Buffer.isBuffer(value)) return Buffer.concat([Buffer.from(`${value.length}:`), value]);
  if (Array.isArray(value)) return Buffer.concat([Buffer.from('l'), ...value.map(bencode), Buffer.from('e')]);
  const keys = Object.keys(value).sort();
  return Buffer.concat([Buffer.from('d'), ...keys.flatMap((k) => [bencode(k), bencode(value[k] as Bencodable)]), Buffer.from('e')]);
}

const SEEDER_PORT = 47311;
const PIECE = 256 * 1024;
const NAME = 'open-data-sample.bin';
const body = randomBody(8 * MB);
let root: string;
let trackerUrl: string;
let infoHash: string;
let torrentFile: Buffer;
let tracker: http.Server;
let seeder: ReturnType<typeof spawn>;

function makeInfo(): Buffer {
  const pieces: Buffer[] = [];
  for (let off = 0; off < body.length; off += PIECE) pieces.push(crypto.createHash('sha1').update(body.subarray(off, off + PIECE)).digest());
  return bencode({ length: body.length, name: NAME, 'piece length': PIECE, pieces: Buffer.concat(pieces) });
}

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'speed-downloader-bt-'));
  tracker = http.createServer((_req, res) => {
    // A compact peer list naming only the local seeder.
    const peer = Buffer.from([127, 0, 0, 1, SEEDER_PORT >> 8, SEEDER_PORT & 255]);
    res.end(bencode({ interval: 5, 'min interval': 1, peers: peer }));
  });
  await new Promise<void>((resolve) => tracker.listen(0, '127.0.0.1', resolve));
  trackerUrl = `http://127.0.0.1:${(tracker.address() as AddressInfo).port}/announce`;
  const info = makeInfo();
  infoHash = crypto.createHash('sha1').update(info).digest('hex');
  torrentFile = Buffer.concat([Buffer.from('d'), bencode('announce'), bencode(trackerUrl), bencode('info'), info, Buffer.from('e')]);

  const seedDir = path.join(root, 'seed');
  fs.mkdirSync(seedDir);
  fs.writeFileSync(path.join(seedDir, NAME), body);
  const seedTorrent = path.join(root, 'seed.torrent');
  fs.writeFileSync(seedTorrent, torrentFile);
  seeder = spawn(findAria2(), [
    `--dir=${seedDir}`, '--check-integrity=true', '--bt-seed-unverified=true', '--seed-ratio=0', '--seed-time=120',
    `--listen-port=${SEEDER_PORT}`, '--interface=127.0.0.1', '--enable-dht=false', '--enable-dht6=false', '--bt-enable-lpd=false', '--enable-peer-exchange=false',
    '--disable-ipv6=true', '--console-log-level=error', '--summary-interval=0', seedTorrent,
  ], { stdio: 'ignore', windowsHide: true });
  await sleep(1500);
});

after(async () => {
  seeder?.kill();
  tracker?.closeAllConnections();
  await new Promise((resolve) => tracker?.close(resolve));
  await sleep(300);
  fs.rmSync(root, { recursive: true, force: true });
});

async function openManager(name: string) {
  const dir = path.join(root, name, 'files');
  const state = path.join(root, name, 'state');
  fs.mkdirSync(dir, { recursive: true });
  const manager = new DownloadManager({
    aria2Path: findAria2(),
    stateDir: state,
    defaultDir: dir,
    pollMs: 100,
    markDownloads: true,
    // Keeps everything on loopback, so no firewall prompt appears during tests.
    engineConf: { interface: '127.0.0.1', 'enable-dht': 'false', 'enable-dht6': 'false', 'bt-enable-lpd': 'false', 'listen-port': '47400-47450' },
  });
  await manager.start();
  return { manager, dir, state };
}

test('downloads from a .torrent file and verifies every piece', async () => {
  const { manager, dir, state } = await openManager('file');
  try {
    const d = manager.addTorrentFile('sample.torrent', torrentFile);
    assert.equal(d.kind, 'torrent');
    assert.ok(fs.existsSync(path.join(state, 'torrents', `${d.id}.torrent`)));
    const done = await waitFor(manager, d.id, settled, 60000);
    assert.equal(done.status, 'completed', JSON.stringify(done.problem));
    assert.equal(done.filename, NAME);
    assert.equal(done.totalBytes, body.length);
    assert.equal(sha(fs.readFileSync(path.join(dir, NAME))), sha(body));
    if (process.platform === 'win32') assert.match(fs.readFileSync(path.join(dir, `${NAME}:Zone.Identifier`), 'utf8'), /ZoneId=3/, 'a finished torrent is marked as coming from the internet');
    await manager.remove(d.id);
    assert.equal(fs.existsSync(path.join(state, 'torrents', `${d.id}.torrent`)), false);
    assert.ok(fs.existsSync(path.join(dir, NAME)), 'removing from the list keeps the finished file');
  } finally {
    await manager.close();
  }
});

test('downloads from a magnet link and takes the name from the metadata', async () => {
  const { manager, dir } = await openManager('magnet');
  try {
    const link = `magnet:?xt=urn:btih:${infoHash}&tr=${encodeURIComponent(trackerUrl)}`;
    const d = manager.add({ url: link });
    assert.equal(d.kind, 'torrent');
    const done = await waitFor(manager, d.id, settled, 90000);
    assert.equal(done.status, 'completed', JSON.stringify(done.problem));
    assert.equal(done.filename, NAME);
    assert.equal(sha(fs.readFileSync(path.join(dir, NAME))), sha(body));
  } finally {
    await manager.close();
  }
});

test('a torrent can be paused and resumed', async () => {
  const { manager, dir } = await openManager('pause');
  try {
    const d = manager.addTorrentFile('sample.torrent', torrentFile);
    await waitFor(manager, d.id, (x) => settled(x) || x.status === 'downloading', 30000);
    await manager.pause(d.id);
    assert.equal(manager.get(d.id)?.status, 'paused');
    manager.resume(d.id);
    const done = await waitFor(manager, d.id, settled, 60000);
    assert.equal(done.status, 'completed', JSON.stringify(done.problem));
    assert.equal(sha(fs.readFileSync(path.join(dir, NAME))), sha(body));
  } finally {
    await manager.close();
  }
});

test('changing the default folder while a torrent runs leaves it where it started, and later files use the new one', async () => {
  const { manager, dir } = await openManager('moved');
  const other = path.join(path.dirname(dir), 'other');
  fs.mkdirSync(other);
  try {
    const d = manager.addTorrentFile('sample.torrent', torrentFile);
    await waitFor(manager, d.id, (x) => settled(x) || x.status === 'downloading', 30000);
    const t0 = performance.now();
    await manager.updateSettings({ defaultDir: other });
    assert.ok(performance.now() - t0 < 1000, 'the change does not wait on the download');
    assert.equal(manager.get(d.id)?.dir, dir);
    await manager.pause(d.id);
    manager.resume(d.id);
    const done = await waitFor(manager, d.id, settled, 60000);
    assert.equal(done.status, 'completed', JSON.stringify(done.problem));
    assert.equal(sha(fs.readFileSync(path.join(dir, NAME))), sha(body));
    assert.deepEqual(fs.readdirSync(dir), [NAME], 'no stray .torrent or control file is left behind');
    assert.deepEqual(fs.readdirSync(other), []);
    assert.equal(manager.add({ url: 'https://example.invalid/next.zip' }).dir, other);
  } finally {
    await manager.close();
  }
});

test('cancelling a torrent removes its partial files', async () => {
  const { manager, dir } = await openManager('cancel');
  try {
    const d = manager.addTorrentFile('sample.torrent', torrentFile);
    await waitFor(manager, d.id, (x) => settled(x) || (x.status === 'downloading' && !!x.filename), 30000);
    await manager.pause(d.id);
    await manager.remove(d.id);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    await manager.close();
  }
});

test('invalid torrents are refused', async () => {
  const { manager } = await openManager('invalid');
  try {
    assert.throws(() => manager.add({ url: 'magnet:?dn=no-hash' }), /no valid BitTorrent hash/);
    assert.throws(() => manager.add({ url: 'magnet:?xt=urn:btih:zz' }), /no valid BitTorrent hash/);
    assert.throws(() => manager.addTorrentFile('x.torrent', Buffer.from('<html>not a torrent</html>')), /not a valid/);
    assert.throws(() => manager.addTorrentFile('x.torrent', Buffer.alloc(0)), /not a valid/);
    assert.equal(manager.list().length, 0);
  } finally {
    await manager.close();
  }
});

test('a garbage file that looks like a torrent reports a failure instead of hanging', async () => {
  const { manager } = await openManager('garbage');
  try {
    const d = manager.addTorrentFile('bad.torrent', Buffer.from('d4:spam4:eggse'));
    const done = await waitFor(manager, d.id, settled, 20000);
    assert.equal(done.status, 'failed');
  } finally {
    await manager.close();
  }
});
