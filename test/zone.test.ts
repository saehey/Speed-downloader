import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { addressForZone, markFromInternet, policyKeepsZone, zoneText } from '../src/core/zone.ts';
import { harness, MB, randomBody, settled, sha, waitFor } from './helpers.ts';

const readZone = (file: string): string | null => {
  try {
    return fs.readFileSync(`${file}:Zone.Identifier`, 'utf8');
  } catch {
    return null;
  }
};

test('the mark keeps where a file came from, but never tokens or passwords', () => {
  assert.equal(addressForZone('https://user:secret@files.example.com/a/report.pdf?token=abc&sig=1#part'), 'https://files.example.com/a/report.pdf');
  assert.equal(addressForZone('http://127.0.0.1:8080/x.exe'), 'http://127.0.0.1:8080/x.exe');
  assert.equal(addressForZone('magnet:?xt=urn:btih:abc'), null);
  assert.equal(addressForZone('not a link'), null);
  assert.equal(addressForZone(null), null);
  const text = zoneText('https://cdn.example.com/setup.exe?expires=1', 'https://example.com/download?id=7');
  assert.equal(text, '[ZoneTransfer]\r\nZoneId=3\r\nReferrerUrl=https://example.com/download\r\nHostUrl=https://cdn.example.com/setup.exe\r\n');
  assert.equal(zoneText('magnet:?xt=urn:btih:abc', null), '[ZoneTransfer]\r\nZoneId=3\r\n');
});

test('the Windows policy that turns marks off is followed', () => {
  assert.equal(policyKeepsZone(['', '']), true, 'no policy means marks are kept');
  assert.equal(policyKeepsZone(['\r\nHKEY_CURRENT_USER\\...\\Attachments\r\n    SaveZoneInformation    REG_DWORD    0x2\r\n']), true);
  assert.equal(policyKeepsZone(['', '\r\n    SaveZoneInformation    REG_DWORD    0x1\r\n']), false);
});

test('every file inside a folder is marked, and links are left alone', { skip: process.platform !== 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'downloader-zone-'));
  try {
    const top = path.join(root, 'Album');
    fs.mkdirSync(path.join(top, 'disc 2'), { recursive: true });
    fs.writeFileSync(path.join(top, 'one.flac'), 'a');
    fs.writeFileSync(path.join(top, 'disc 2', 'two.flac'), 'b');
    const outside = path.join(root, 'outside.txt');
    fs.writeFileSync(outside, 'c');
    let linked = false;
    try {
      fs.symlinkSync(outside, path.join(top, 'link.txt'), 'file');
      linked = true;
    } catch {
      // Creating links needs Developer Mode or admin rights on Windows.
    }
    assert.equal(markFromInternet(top, null, null), 2);
    assert.match(readZone(path.join(top, 'one.flac')) ?? '', /ZoneId=3/);
    assert.match(readZone(path.join(top, 'disc 2', 'two.flac')) ?? '', /ZoneId=3/);
    if (linked) assert.equal(readZone(outside), null, 'a link must not mark a file outside the download');
    assert.equal(fs.readFileSync(path.join(top, 'one.flac'), 'utf8'), 'a', 'the file itself is unchanged');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a finished download is marked as coming from the internet', { skip: process.platform !== 'win32' }, async () => {
  const h = await harness({ markDownloads: true });
  try {
    const body = randomBody(MB);
    h.server.routes.set('/setup.exe', { body, etag: '"1"' });
    const { id } = h.manager.add({ url: `${h.server.base}/setup.exe?token=secret-value`, referrer: 'https://example.com/get?session=abc' });
    const done = await waitFor(h.manager, id, settled, 60000);
    assert.equal(done.status, 'completed', JSON.stringify(done.problem));
    const file = path.join(done.dir, done.filename as string);
    const zone = readZone(file) ?? '';
    assert.match(zone, /^\[ZoneTransfer\]\r\nZoneId=3\r\n/);
    assert.ok(zone.includes(`HostUrl=${h.server.base}/setup.exe\r\n`), zone);
    assert.ok(zone.includes('ReferrerUrl=https://example.com/get\r\n'), zone);
    assert.ok(!zone.includes('secret-value') && !zone.includes('session'), 'tokens are not written to disk');
    assert.equal(sha(fs.readFileSync(file)), sha(body), 'the content is untouched');
  } finally {
    await h.dispose();
  }
});

test('nothing is marked when marking is off', { skip: process.platform !== 'win32' }, async () => {
  const h = await harness();
  try {
    h.server.routes.set('/plain.bin', { body: randomBody(MB), etag: '"1"' });
    const { id } = h.manager.add({ url: `${h.server.base}/plain.bin` });
    const done = await waitFor(h.manager, id, settled, 60000);
    assert.equal(done.status, 'completed');
    assert.equal(readZone(path.join(done.dir, done.filename as string)), null);
  } finally {
    await h.dispose();
  }
});

const ytDlpPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'yt-dlp', 'yt-dlp.exe');

test('a finished video is marked with its page address', { skip: process.platform !== 'win32' || !fs.existsSync(ytDlpPath) }, async () => {
  const h = await harness({ ytDlpPath, ffmpegPath: null, markDownloads: true });
  try {
    h.server.routes.set('/clip.mp4', { body: randomBody(MB), contentType: 'video/mp4' });
    h.server.routes.set('/page', { body: Buffer.from(`<html><head><title>clip</title></head><body><video src="${h.server.base}/clip.mp4"></video></body></html>`), contentType: 'text/html' });
    const d = h.manager.addVideo(`${h.server.base}/page?v=private`);
    const done = await waitFor(h.manager, d.id, settled, 120000);
    assert.equal(done.status, 'completed', JSON.stringify(done.problem));
    const zone = readZone(path.join(h.dir, done.filename as string)) ?? '';
    assert.ok(zone.includes(`HostUrl=${h.server.base}/page\r\n`), zone);
  } finally {
    await h.dispose();
  }
});
