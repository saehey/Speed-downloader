import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { atProgress, fakeSecrets, filesIn, harness, MB, randomBody, settled, sha, sleep, waitFor } from './helpers.ts';
import type { Harness } from './helpers.ts';

async function withHarness(fn: (h: Harness) => Promise<void>, options: Parameters<typeof harness>[0] = {}) {
  const h = await harness(options);
  try {
    await fn(h);
  } finally {
    await h.dispose();
  }
}

const hashOf = (file: string) => sha(fs.readFileSync(file));

test('downloads with several connections and leaves only the finished file', () => withHarness(async (h) => {
  const body = randomBody(16 * MB);
  h.server.routes.set('/a.bin', { body, etag: '"1"' });
  const d = h.manager.add({ url: `${h.server.base}/a.bin` });
  const done = await waitFor(h.manager, d.id, settled);
  assert.equal(done.status, 'completed', done.problem?.message ?? '');
  assert.equal(done.filename, 'a.bin');
  assert.equal(hashOf(path.join(h.dir, 'a.bin')), sha(body));
  assert.deepEqual(filesIn(h.dir), ['a.bin']);
  const ranged = h.server.hits.filter((x) => x.path === '/a.bin' && x.bytes > 1);
  assert.ok(ranged.length >= 4, `expected several connections, saw ${ranged.length}`);
}));

test('works when the server does not support ranges', () => withHarness(async (h) => {
  const body = randomBody(2 * MB);
  h.server.routes.set('/n.bin', { body, ranges: false });
  const d = h.manager.add({ url: `${h.server.base}/n.bin` });
  const done = await waitFor(h.manager, d.id, settled);
  assert.equal(done.status, 'completed', done.problem?.message ?? '');
  assert.equal(done.acceptsRanges, false);
  assert.equal(hashOf(path.join(h.dir, 'n.bin')), sha(body));
}));

test('pause and resume continue without downloading again', () => withHarness(async (h) => {
  const body = randomBody(16 * MB);
  h.server.routes.set('/p.bin', { body, etag: '"1"' });
  const d = h.manager.add({ url: `${h.server.base}/p.bin` });
  await waitFor(h.manager, d.id, atProgress(0.3));
  await h.manager.pause(d.id);
  assert.equal(h.manager.get(d.id)?.status, 'paused');
  await sleep(500);
  assert.equal(h.server.active, 0, 'no connections while paused');
  assert.ok(fs.existsSync(path.join(h.dir, 'p.bin.part')));
  h.manager.resume(d.id);
  const done = await waitFor(h.manager, d.id, settled);
  assert.equal(done.status, 'completed', done.problem?.message ?? '');
  assert.equal(hashOf(path.join(h.dir, 'p.bin')), sha(body));
  assert.ok(h.server.bytes('/p.bin') < body.length * 1.35, `served ${h.server.bytes('/p.bin') / body.length}x`);
}));

test('never resumes onto a file that changed on the server', () => withHarness(async (h) => {
  const first = randomBody(16 * MB);
  const second = randomBody(16 * MB);
  const route = { body: first, etag: '"v1"' };
  h.server.routes.set('/c.bin', route);
  const d = h.manager.add({ url: `${h.server.base}/c.bin` });
  await waitFor(h.manager, d.id, atProgress(0.3));
  await h.manager.pause(d.id);
  route.body = second;
  route.etag = '"v2"';
  h.manager.resume(d.id);
  const stopped = await waitFor(h.manager, d.id, settled);
  assert.equal(stopped.status, 'attention');
  assert.equal(stopped.problem?.kind, 'remote-changed');

  await h.manager.restart(d.id);
  const done = await waitFor(h.manager, d.id, settled);
  assert.equal(done.status, 'completed', done.problem?.message ?? '');
  assert.equal(hashOf(path.join(h.dir, 'c.bin')), sha(second));
}));

test('asks before resuming when nothing can prove the file is unchanged', () => withHarness(async (h) => {
  const body = randomBody(16 * MB);
  h.server.routes.set('/u.bin', { body });
  const d = h.manager.add({ url: `${h.server.base}/u.bin` });
  await waitFor(h.manager, d.id, atProgress(0.3));
  await h.manager.pause(d.id);
  h.manager.resume(d.id);
  const stopped = await waitFor(h.manager, d.id, settled);
  assert.equal(stopped.problem?.kind, 'cannot-verify');
  h.manager.resumeUnverified(d.id);
  const done = await waitFor(h.manager, d.id, settled);
  assert.equal(done.status, 'completed', done.problem?.message ?? '');
  assert.equal(hashOf(path.join(h.dir, 'u.bin')), sha(body));
}));

test('an expired link can be replaced and keeps its progress', () => withHarness(async (h) => {
  const body = randomBody(16 * MB);
  const route: { body: Buffer; etag: string; deny?: number } = { body, etag: '"1"' };
  h.server.routes.set('/old.bin', route);
  h.server.routes.set('/new.bin', { body, etag: '"1"' });
  const d = h.manager.add({ url: `${h.server.base}/old.bin` });
  await waitFor(h.manager, d.id, atProgress(0.3));
  route.deny = 403;
  h.server.dropConnections();
  const stopped = await waitFor(h.manager, d.id, settled);
  assert.equal(stopped.status, 'attention', JSON.stringify(stopped.problem));
  assert.equal(stopped.problem?.kind, 'link-expired');
  await h.manager.replaceUrl(d.id, { url: `${h.server.base}/new.bin` });
  const done = await waitFor(h.manager, d.id, settled);
  assert.equal(done.status, 'completed', done.problem?.message ?? '');
  assert.equal(hashOf(path.join(h.dir, 'old.bin')), sha(body));
  assert.ok(h.server.bytes('/new.bin') < body.length * 0.95, 'continued rather than starting over');
}));

test('sends the cookie and never stores it as plain text', () => withHarness(async (h) => {
  const secret = 'session=VERY_SECRET_VALUE_123';
  const body = randomBody(8 * MB);
  h.server.routes.set('/s.bin', { body, etag: '"1"', cookie: secret });
  const d = h.manager.add({ url: `${h.server.base}/s.bin`, cookie: secret });
  await waitFor(h.manager, d.id, atProgress(0.2));
  await sleep(1300);
  const scan = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? scan(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  for (const file of [...scan(h.state), ...scan(h.dir)]) {
    assert.equal(fs.readFileSync(file).includes('VERY_SECRET_VALUE'), false, `plain cookie in ${file}`);
  }
  const done = await waitFor(h.manager, d.id, settled);
  assert.equal(done.status, 'completed', done.problem?.message ?? '');
  assert.equal(done.hasCookie, false, 'cookie is forgotten when finished');
  assert.equal(hashOf(path.join(h.dir, 's.bin')), sha(body));
}, { secrets: fakeSecrets }));

test('a closed app resumes its queue, including login cookies', () => withHarness(async (h) => {
  const secret = 'session=RESTORE_ME';
  const body = randomBody(16 * MB);
  h.server.routes.set('/r.bin', { body, etag: '"1"', cookie: secret });
  const d = h.manager.add({ url: `${h.server.base}/r.bin`, cookie: secret });
  await waitFor(h.manager, d.id, atProgress(0.3));
  await h.manager.close();
  const reopened = await h.open();
  const done = await waitFor(reopened, d.id, settled);
  assert.equal(done.status, 'completed', done.problem?.message ?? '');
  assert.equal(hashOf(path.join(h.dir, 'r.bin')), sha(body));
  assert.ok(h.server.bytes('/r.bin') < body.length * 1.5, `served ${h.server.bytes('/r.bin') / body.length}x`);
}, { secrets: fakeSecrets }));

test('cookies are not kept when secure storage is unavailable', () => withHarness(async (h) => {
  const body = randomBody(8 * MB);
  h.server.routes.set('/m.bin', { body, etag: '"1"', cookie: 'a=b' });
  const d = h.manager.add({ url: `${h.server.base}/m.bin`, cookie: 'a=b' });
  await waitFor(h.manager, d.id, atProgress(0.2));
  await h.manager.close();
  assert.equal(fs.readFileSync(path.join(h.state, 'downloads.json'), 'utf8').includes('"a=b"'), false);
  const reopened = await h.open();
  const stopped = await waitFor(reopened, d.id, settled);
  assert.equal(stopped.problem?.kind, 'link-expired', 'without the cookie the server refuses, and the user is asked');
}));

test('a file that changes size mid-download is reported, not corrupted', () => withHarness(async (h) => {
  const first = randomBody(16 * MB);
  const route = { body: first, etag: '"v1"' };
  h.server.routes.set('/z.bin', route);
  const d = h.manager.add({ url: `${h.server.base}/z.bin` });
  await waitFor(h.manager, d.id, atProgress(0.3));
  route.body = first.subarray(0, 8 * MB);
  route.etag = '"v2"';
  h.server.dropConnections();
  const stopped = await waitFor(h.manager, d.id, settled);
  assert.equal(stopped.status, 'attention', JSON.stringify(stopped.problem));
  assert.equal(stopped.problem?.kind, 'remote-changed');
  assert.equal(fs.existsSync(path.join(h.dir, 'z.bin')), false, 'no finished file was produced');
}));

test('finishes when the server refuses extra connections with HTTP 429', () => withHarness(async (h) => {
  const body = randomBody(16 * MB);
  h.server.routes.set('/limit.bin', { body, etag: '"1"', maxConnections: 1 });
  const d = h.manager.add({ url: `${h.server.base}/limit.bin` });
  const done = await waitFor(h.manager, d.id, settled, 120000);
  assert.equal(done.status, 'completed', JSON.stringify(done.problem));
  assert.equal(hashOf(path.join(h.dir, 'limit.bin')), sha(body));
  assert.ok(h.server.hits.some((x) => x.refused), 'the server did refuse some connections');
}));

test('waits and retries when the server is busy at the start', () => withHarness(async (h) => {
  const body = randomBody(2 * MB);
  const route: { body: Buffer; etag: string; deny?: number } = { body, etag: '"1"', deny: 429 };
  h.server.routes.set('/busy.bin', route);
  const d = h.manager.add({ url: `${h.server.base}/busy.bin` });
  await sleep(150);
  assert.equal(h.manager.get(d.id)?.status, 'probing', 'not reported as failed while waiting');
  delete route.deny;
  const done = await waitFor(h.manager, d.id, settled);
  assert.equal(done.status, 'completed', JSON.stringify(done.problem));
  assert.equal(hashOf(path.join(h.dir, 'busy.bin')), sha(body));
}, { busyDelayMs: 40 }));

test('gives up with a clear message when the server stays busy', () => withHarness(async (h) => {
  h.server.routes.set('/full.bin', { body: randomBody(1024), deny: 503 });
  const d = h.manager.add({ url: `${h.server.base}/full.bin` });
  const done = await waitFor(h.manager, d.id, settled, 30000);
  assert.equal(done.status, 'failed');
  assert.equal(done.problem?.kind, 'network');
  assert.match(done.problem?.message ?? '', /too busy/);
}, { busyDelayMs: 10 }));

test('a name is free again once its finished file has been deleted', () => withHarness(async (h) => {
  const body = randomBody(1024);
  h.server.routes.set('/again.bin', { body, etag: '"1"' });
  const first = h.manager.add({ url: `${h.server.base}/again.bin` });
  await waitFor(h.manager, first.id, settled);
  fs.rmSync(path.join(h.dir, 'again.bin'));
  const second = h.manager.add({ url: `${h.server.base}/again.bin` });
  const done = await waitFor(h.manager, second.id, settled);
  assert.equal(done.filename, 'again.bin');
}));

test('two running downloads of one name do not share a file', () => withHarness(async (h) => {
  const a = randomBody(4 * MB);
  h.server.routes.set('/same.bin', { body: a, etag: '"1"' });
  const first = h.manager.add({ url: `${h.server.base}/same.bin` });
  const second = h.manager.add({ url: `${h.server.base}/same.bin` });
  const one = await waitFor(h.manager, first.id, settled);
  const two = await waitFor(h.manager, second.id, settled);
  assert.notEqual(one.filename, two.filename);
  assert.equal(hashOf(path.join(h.dir, one.filename as string)), sha(a));
  assert.equal(hashOf(path.join(h.dir, two.filename as string)), sha(a));
}));

test('saved records from before torrents existed still load and work', () => withHarness(async (h) => {
  const body = randomBody(2 * MB);
  h.server.routes.set('/old.bin', { body, etag: '"1"' });
  await h.manager.close();
  fs.writeFileSync(path.join(h.state, 'downloads.json'), JSON.stringify({ version: 1, settings: { connections: 4 }, cookies: {}, downloads: [{ id: 'legacy', url: `${h.server.base}/old.bin`, filename: null, dir: h.dir, status: 'queued', totalBytes: 0, completedBytes: 0, speed: 0, connections: 0, acceptsRanges: null, validator: null, problem: null, referrer: null, userAgent: null, hasCookie: false, createdAt: 1, completedAt: null }] }));
  const reopened = await h.open();
  const done = await waitFor(reopened, 'legacy', settled);
  assert.equal(done.status, 'completed', JSON.stringify(done.problem));
  assert.equal(reopened.state().settings.language, 'th', 'a missing language falls back to the default');
}));

test('a corrupt state file is kept aside and the app still starts', () => withHarness(async (h) => {
  await h.manager.close();
  fs.writeFileSync(path.join(h.state, 'downloads.json'), '{ not json');
  const reopened = await h.open();
  assert.deepEqual(reopened.list(), []);
  assert.ok(fs.readdirSync(h.state).some((f) => f.includes('.corrupt-')));
}));

test('recovers when aria2 crashes', () => withHarness(async (h) => {
  const body = randomBody(16 * MB);
  h.server.routes.set('/k.bin', { body, etag: '"1"' });
  const d = h.manager.add({ url: `${h.server.base}/k.bin` });
  await waitFor(h.manager, d.id, atProgress(0.3));
  await sleep(1200);
  h.manager.killEngineForTest();
  const done = await waitFor(h.manager, d.id, settled);
  assert.equal(done.status, 'completed', done.problem?.message ?? '');
  assert.equal(hashOf(path.join(h.dir, 'k.bin')), sha(body));
}));

test('a dangerous server file name stays inside the folder', () => withHarness(async (h) => {
  const body = randomBody(1024);
  h.server.routes.set('/x', { body, etag: '"1"', disposition: `attachment; filename="..\\..\\evil.exe"` });
  const d = h.manager.add({ url: `${h.server.base}/x` });
  const done = await waitFor(h.manager, d.id, settled);
  assert.equal(done.status, 'completed', done.problem?.message ?? '');
  assert.equal(done.filename, 'evil.exe');
  assert.deepEqual(filesIn(h.dir), ['evil.exe']);
}));

test('never overwrites an existing file', () => withHarness(async (h) => {
  fs.writeFileSync(path.join(h.dir, 'keep.bin'), 'original');
  const body = randomBody(1024);
  h.server.routes.set('/keep.bin', { body, etag: '"1"' });
  const d = h.manager.add({ url: `${h.server.base}/keep.bin` });
  const done = await waitFor(h.manager, d.id, settled);
  assert.equal(done.filename, 'keep (1).bin');
  assert.equal(fs.readFileSync(path.join(h.dir, 'keep.bin'), 'utf8'), 'original');
}));

test('runs only as many downloads as allowed', () => withHarness(async (h) => {
  await h.manager.updateSettings({ maxConcurrent: 1 });
  const body = randomBody(2 * MB);
  h.server.routes.set('/1.bin', { body, etag: '"1"' });
  h.server.routes.set('/2.bin', { body, etag: '"1"' });
  const a = h.manager.add({ url: `${h.server.base}/1.bin` });
  const b = h.manager.add({ url: `${h.server.base}/2.bin` });
  await waitFor(h.manager, a.id, (d) => d.status === 'downloading');
  assert.equal(h.manager.get(b.id)?.status, 'queued');
  assert.equal((await waitFor(h.manager, a.id, settled)).status, 'completed');
  assert.equal((await waitFor(h.manager, b.id, settled)).status, 'completed');
}));

test('pause all and resume all act on every running download', () => withHarness(async (h) => {
  const a = randomBody(8 * MB);
  const b = randomBody(8 * MB);
  h.server.routes.set('/pa.bin', { body: a, etag: '"1"' });
  h.server.routes.set('/pb.bin', { body: b, etag: '"1"' });
  const first = h.manager.add({ url: `${h.server.base}/pa.bin` });
  const second = h.manager.add({ url: `${h.server.base}/pb.bin` });
  await waitFor(h.manager, first.id, atProgress(0.1));
  await waitFor(h.manager, second.id, atProgress(0.1));
  await h.manager.pauseAll();
  assert.equal(h.manager.get(first.id)?.status, 'paused');
  assert.equal(h.manager.get(second.id)?.status, 'paused');
  h.manager.resumeAll();
  assert.equal((await waitFor(h.manager, first.id, settled)).status, 'completed');
  assert.equal((await waitFor(h.manager, second.id, settled)).status, 'completed');
  assert.equal(hashOf(path.join(h.dir, 'pa.bin')), sha(a));
  assert.equal(hashOf(path.join(h.dir, 'pb.bin')), sha(b));
}));

test('reports a missing file and removes partial files', () => withHarness(async (h) => {
  const missing = h.manager.add({ url: `${h.server.base}/none` });
  const failed = await waitFor(h.manager, missing.id, settled);
  assert.equal(failed.problem?.kind, 'not-found');

  const body = randomBody(8 * MB);
  h.server.routes.set('/rm.bin', { body, etag: '"1"' });
  const d = h.manager.add({ url: `${h.server.base}/rm.bin` });
  await waitFor(h.manager, d.id, atProgress(0.2));
  await h.manager.remove(d.id);
  await sleep(300);
  assert.deepEqual(filesIn(h.dir), []);
  assert.equal(h.manager.get(d.id), undefined);
}));

test('rejects unsafe requests', () => withHarness(async (h) => {
  assert.throws(() => h.manager.add({ url: 'file:///C:/Windows/win.ini' }), /Unsupported/);
  assert.throws(() => h.manager.add({ url: 'javascript:alert(1)' }), /Unsupported/);
  assert.throws(() => h.manager.add({ url: 'not a url' }));
  assert.throws(() => h.manager.add({ url: `${h.server.base}/a`, cookie: 'a=b\r\nX: y' }), /line break/);
  await assert.rejects(h.manager.updateSettings({ connections: 99 }));
}));
