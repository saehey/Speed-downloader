// Charters from exploratory QA: actions in awkward orders and environments, kept as regression tests.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { atProgress, filesIn, harness, MB, randomBody, settled, sha, sleep, waitFor } from './helpers.ts';
import type { Harness } from './helpers.ts';

async function withHarness(fn: (h: Harness) => Promise<void>) {
  const h = await harness();
  try {
    await fn(h);
  } finally {
    await h.dispose();
  }
}

const hashOf = (file: string) => sha(fs.readFileSync(file));

test('pausing during the server check does not leave a download running', () => withHarness(async (h) => {
  h.server.routes.set('/race.bin', { body: randomBody(4 * MB), etag: '"1"' });
  const d = h.manager.add({ url: `${h.server.base}/race.bin` });
  await h.manager.pause(d.id);
  await sleep(1500);
  assert.equal(h.manager.get(d.id)?.status, 'paused');
  assert.equal(h.server.active, 0, 'nothing is transferring while paused');
}));

test('removing during the server check leaves nothing behind', () => withHarness(async (h) => {
  h.server.routes.set('/gone.bin', { body: randomBody(4 * MB), etag: '"1"' });
  const d = h.manager.add({ url: `${h.server.base}/gone.bin` });
  await h.manager.remove(d.id);
  await sleep(1500);
  assert.equal(h.manager.get(d.id), undefined);
  assert.equal(h.server.active, 0);
  assert.deepEqual(filesIn(h.dir), []);
}));

test('rapid repeated clicks end in one consistent download', () => withHarness(async (h) => {
  const body = randomBody(8 * MB);
  h.server.routes.set('/click.bin', { body, etag: '"1"' });
  const d = h.manager.add({ url: `${h.server.base}/click.bin` });
  await waitFor(h.manager, d.id, atProgress(0.1));
  await Promise.all([h.manager.pause(d.id), h.manager.pause(d.id), h.manager.pause(d.id)]);
  h.manager.resume(d.id);
  h.manager.resume(d.id);
  await h.manager.pause(d.id);
  h.manager.resume(d.id);
  const done = await waitFor(h.manager, d.id, settled);
  assert.equal(done.status, 'completed', JSON.stringify(done.problem));
  assert.equal(hashOf(path.join(h.dir, 'click.bin')), sha(body));
}));

test('restarting while downloading gives a correct file', () => withHarness(async (h) => {
  const body = randomBody(8 * MB);
  h.server.routes.set('/again.bin', { body, etag: '"1"' });
  const d = h.manager.add({ url: `${h.server.base}/again.bin` });
  await waitFor(h.manager, d.id, atProgress(0.2));
  await h.manager.restart(d.id);
  const done = await waitFor(h.manager, d.id, settled);
  assert.equal(done.status, 'completed', JSON.stringify(done.problem));
  assert.equal(hashOf(path.join(h.dir, 'again.bin')), sha(body));
}));

test('actions on an unknown download fail cleanly', () => withHarness(async (h) => {
  await assert.rejects(h.manager.pause('nope'), /not found/);
  assert.throws(() => h.manager.resume('nope'), /not found/);
  await assert.rejects(h.manager.remove('nope'), /not found/);
}));

test('a folder that cannot be created is reported, and the queue carries on', () => withHarness(async (h) => {
  const body = randomBody(1024);
  h.server.routes.set('/x.bin', { body, etag: '"1"' });
  // A path under a file can never be created.
  const blocker = path.join(h.dir, 'not-a-folder');
  fs.writeFileSync(blocker, 'x');
  const bad = h.manager.add({ url: `${h.server.base}/x.bin`, dir: path.join(blocker, 'sub') });
  const failed = await waitFor(h.manager, bad.id, settled, 30000);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.problem?.kind, 'disk');
  const good = h.manager.add({ url: `${h.server.base}/x.bin` });
  assert.equal((await waitFor(h.manager, good.id, settled)).status, 'completed');
}));

test('a server that drops every connection ends in a clear failure, not a hang', () => withHarness(async (h) => {
  const body = randomBody(8 * MB);
  const route = { body, etag: '"1"' };
  h.server.routes.set('/drop.bin', route);
  const d = h.manager.add({ url: `${h.server.base}/drop.bin` });
  await waitFor(h.manager, d.id, atProgress(0.1));
  await h.server.close();
  const done = await waitFor(h.manager, d.id, settled, 120000);
  assert.equal(done.status, 'failed');
  assert.equal(done.problem?.kind, 'network', JSON.stringify(done.problem));
  // dispose() closes the server again, which must stay harmless.
  await h.server.listen();
}));

test('an unusual but valid file name survives the whole trip', () => withHarness(async (h) => {
  const body = randomBody(2048);
  const name = 'ทดสอบ 100% (final) #2 & more.pdf';
  h.server.routes.set('/n', { body, etag: '"1"', disposition: `attachment; filename*=UTF-8''${encodeURIComponent(name)}` });
  const d = h.manager.add({ url: `${h.server.base}/n` });
  const done = await waitFor(h.manager, d.id, settled);
  assert.equal(done.status, 'completed', JSON.stringify(done.problem));
  assert.equal(done.filename, name);
  assert.equal(hashOf(path.join(h.dir, name)), sha(body));
}));

test('an empty file completes', () => withHarness(async (h) => {
  h.server.routes.set('/empty.txt', { body: Buffer.alloc(0), etag: '"1"' });
  const d = h.manager.add({ url: `${h.server.base}/empty.txt` });
  const done = await waitFor(h.manager, d.id, settled, 30000);
  assert.equal(done.status, 'completed', JSON.stringify(done.problem));
  assert.equal(fs.statSync(path.join(h.dir, 'empty.txt')).size, 0);
}));

test('state stays valid under many queued downloads', () => withHarness(async (h) => {
  const body = randomBody(64 * 1024);
  h.server.routes.set('/many.bin', { body, etag: '"1"' });
  const ids = Array.from({ length: 25 }, () => h.manager.add({ url: `${h.server.base}/many.bin` }).id);
  for (const id of ids) assert.equal((await waitFor(h.manager, id, settled, 120000)).status, 'completed');
  const names = ids.map((id) => h.manager.get(id)?.filename);
  assert.equal(new Set(names).size, 25, 'every file has its own name');
  await h.manager.close();
  const saved = JSON.parse(fs.readFileSync(path.join(h.state, 'downloads.json'), 'utf8'));
  assert.equal(saved.downloads.length, 25);
  await h.open();
}));
