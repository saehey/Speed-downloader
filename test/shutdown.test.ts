// None of these can turn the computer off: the manager only announces, and the countdown gets a fake.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runShutdownCountdown, SHUTDOWN_ARGS } from '../src/main/shutdown.ts';
import { harness, MB, randomBody, settled, sleep, waitFor } from './helpers.ts';
import type { Harness } from './helpers.ts';

async function watch(fn: (h: Harness, fired: Array<{ failed: number }>) => Promise<void>) {
  const h = await harness();
  const fired: Array<{ failed: number }> = [];
  h.manager.on('queue-finished', (event: { failed: number }) => fired.push(event));
  try {
    await fn(h, fired);
  } finally {
    await h.dispose();
  }
}

test('it announces once, only after every file has finished, and then turns itself off', () => watch(async (h, fired) => {
  h.server.routes.set('/a.bin', { body: randomBody(MB), etag: '"1"' });
  h.server.routes.set('/b.bin', { body: randomBody(3 * MB), etag: '"1"' });
  await h.manager.updateSettings({ shutdownWhenDone: true });
  const a = h.manager.add({ url: `${h.server.base}/a.bin` });
  const b = h.manager.add({ url: `${h.server.base}/b.bin` });
  await waitFor(h.manager, a.id, settled, 60000);
  assert.equal(h.manager.get(b.id)?.status === 'completed' || fired.length === 0, true, 'not while another file runs');
  await waitFor(h.manager, b.id, settled, 60000);
  await sleep(400);
  assert.deepEqual(fired, [{ failed: 0 }]);
  assert.equal(h.manager.state().settings.shutdownWhenDone, false);
  h.server.routes.set('/c.bin', { body: randomBody(MB), etag: '"1"' });
  await waitFor(h.manager, h.manager.add({ url: `${h.server.base}/c.bin` }).id, settled, 60000);
  await sleep(300);
  assert.equal(fired.length, 1, 'a later file does not fire it again');
}));

test('with it off, nothing is announced', () => watch(async (h, fired) => {
  h.server.routes.set('/a.bin', { body: randomBody(MB), etag: '"1"' });
  await waitFor(h.manager, h.manager.add({ url: `${h.server.base}/a.bin` }).id, settled, 60000);
  await sleep(300);
  assert.deepEqual(fired, []);
}));

test('turning it on after everything finished does not fire on old results', () => watch(async (h, fired) => {
  h.server.routes.set('/a.bin', { body: randomBody(MB), etag: '"1"' });
  await waitFor(h.manager, h.manager.add({ url: `${h.server.base}/a.bin` }).id, settled, 60000);
  await h.manager.updateSettings({ shutdownWhenDone: true });
  await sleep(400);
  assert.deepEqual(fired, []);
  assert.equal(h.manager.state().settings.shutdownWhenDone, true, 'it waits for the next file');
}));

test('a queue that only failed never turns the computer off', () => watch(async (h, fired) => {
  h.server.routes.set('/gone.bin', { body: Buffer.alloc(1), deny: 404 });
  await h.manager.updateSettings({ shutdownWhenDone: true });
  await waitFor(h.manager, h.manager.add({ url: `${h.server.base}/gone.bin` }).id, settled, 60000);
  await sleep(400);
  assert.deepEqual(fired, []);
}));

test('a failed file is counted, and a paused one is not waited for', () => watch(async (h, fired) => {
  h.server.routes.set('/ok.bin', { body: randomBody(MB), etag: '"1"' });
  h.server.routes.set('/gone.bin', { body: Buffer.alloc(1), deny: 404 });
  h.server.routes.set('/held.bin', { body: randomBody(MB), etag: '"1"' });
  await h.manager.updateSettings({ shutdownWhenDone: true });
  await h.manager.pause(h.manager.add({ url: `${h.server.base}/held.bin` }).id);
  await waitFor(h.manager, h.manager.add({ url: `${h.server.base}/gone.bin` }).id, settled, 60000);
  await waitFor(h.manager, h.manager.add({ url: `${h.server.base}/ok.bin` }).id, settled, 60000);
  await sleep(400);
  assert.deepEqual(fired, [{ failed: 1 }]);
}));

test('files waiting for scheduled hours still count as work', () => watch(async (h, fired) => {
  h.server.routes.set('/ok.bin', { body: randomBody(MB), etag: '"1"' });
  h.server.routes.set('/later.bin', { body: randomBody(MB), etag: '"1"' });
  const ok = h.manager.add({ url: `${h.server.base}/ok.bin` });
  await h.manager.updateSettings({ shutdownWhenDone: true, maxConcurrent: 1 });
  await waitFor(h.manager, ok.id, (d) => d.status === 'downloading' || settled(d), 30000);
  const now = new Date();
  const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  await waitFor(h.manager, ok.id, settled, 60000);
  await sleep(200);
  fired.length = 0;
  // A window that closed an hour ago holds the next file in the queue.
  await h.manager.updateSettings({ shutdownWhenDone: true, scheduleEnabled: true, scheduleStart: hhmm(new Date(now.getTime() + 2 * 3600000)), scheduleEnd: hhmm(new Date(now.getTime() + 3 * 3600000)) });
  const later = h.manager.add({ url: `${h.server.base}/later.bin` });
  h.manager.startNow(h.manager.add({ url: `${h.server.base}/ok.bin?again` }).id);
  await sleep(2500);
  assert.equal(h.manager.get(later.id)?.status, 'queued');
  assert.deepEqual(fired, []);
}));

test('the setting does not survive a restart', () => watch(async (h) => {
  await h.manager.updateSettings({ shutdownWhenDone: true });
  await h.manager.close();
  await h.open();
  assert.equal(h.manager.state().settings.shutdownWhenDone, false);
}));

test('the command never forces other programs closed', () => {
  assert.ok(!SHUTDOWN_ARGS.includes('/f'));
  assert.deepEqual(SHUTDOWN_ARGS, ['/s', '/t', '0']);
});

const never = () => new Promise<'cancel' | 'now'>(() => {});

test('with no answer the computer turns off after the countdown', async () => {
  let shut = 0;
  void runShutdownCountdown({ ask: never, shutDown: () => { shut++; }, delayMs: 30 });
  assert.equal(shut, 0, 'not before the time is up');
  await sleep(80);
  assert.equal(shut, 1);
});

test('cancelling stops it, even if the time would run out later', async () => {
  let shut = 0;
  assert.equal(await runShutdownCountdown({ ask: async () => 'cancel', shutDown: () => { shut++; }, delayMs: 30 }), 'cancelled');
  await sleep(80);
  assert.equal(shut, 0);
});

test('"now" turns it off at once, and only once', async () => {
  let shut = 0;
  assert.equal(await runShutdownCountdown({ ask: async () => 'now', shutDown: () => { shut++; }, delayMs: 30 }), 'shut-down');
  await sleep(80);
  assert.equal(shut, 1);
});

test('an answer after the time ran out changes nothing', async () => {
  let shut = 0;
  const late = runShutdownCountdown({ ask: async () => { await sleep(60); return 'cancel'; }, shutDown: () => { shut++; }, delayMs: 20 });
  assert.equal(await late, 'shut-down');
  assert.equal(shut, 1);
});
