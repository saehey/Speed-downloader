import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isValidTime, withinWindow } from '../src/shared/schedule.ts';
import { harness, MB, randomBody, settled, sleep, waitFor } from './helpers.ts';
import type { Harness } from './helpers.ts';

const at = (time: string) => new Date(`2026-11-05T${time}:00`);

test('a daytime window includes its start and excludes its end', () => {
  assert.equal(withinWindow(at('09:00'), '09:00', '17:00'), true);
  assert.equal(withinWindow(at('16:59'), '09:00', '17:00'), true);
  assert.equal(withinWindow(at('17:00'), '09:00', '17:00'), false);
  assert.equal(withinWindow(at('08:59'), '09:00', '17:00'), false);
});

test('a window can cross midnight', () => {
  assert.equal(withinWindow(at('23:30'), '23:00', '06:00'), true);
  assert.equal(withinWindow(at('05:59'), '23:00', '06:00'), true);
  assert.equal(withinWindow(at('06:00'), '23:00', '06:00'), false);
  assert.equal(withinWindow(at('12:00'), '23:00', '06:00'), false);
});

test('only real times are accepted', () => {
  assert.equal(isValidTime('23:59'), true);
  for (const bad of ['24:00', '7:00', '12:60', '', '12:00:00']) assert.equal(isValidTime(bad), false, bad);
});

async function withClock(start: string, fn: (h: Harness, setTime: (time: string) => void) => Promise<void>) {
  let current = at(start);
  const h = await harness({ now: () => current, scheduleCheckMs: 50 });
  try {
    await h.manager.updateSettings({ scheduleEnabled: true, scheduleStart: '01:00', scheduleEnd: '06:00' });
    await fn(h, (time) => { current = at(time); });
  } finally {
    await h.dispose();
  }
}

test('a download waits for the scheduled hours, then runs', () => withClock('12:00', async (h, setTime) => {
  h.server.routes.set('/night.bin', { body: randomBody(MB), etag: '"1"' });
  const d = h.manager.add({ url: `${h.server.base}/night.bin` });
  await sleep(400);
  assert.equal(h.manager.get(d.id)?.status, 'queued');
  assert.equal(h.server.hits.length, 0, 'nothing is requested before the window opens');
  setTime('01:00');
  const done = await waitFor(h.manager, d.id, settled);
  assert.equal(done.status, 'completed', JSON.stringify(done.problem));
}));

test('a running download goes back to the queue when the hours end, and continues the next night', () => withClock('02:00', async (h, setTime) => {
  const body = randomBody(8 * MB);
  h.server.routes.set('/long.bin', { body, etag: '"1"' });
  const d = h.manager.add({ url: `${h.server.base}/long.bin` });
  await waitFor(h.manager, d.id, (now) => now.completedBytes > MB);
  setTime('06:00');
  await waitFor(h.manager, d.id, (now) => now.status === 'queued');
  await sleep(300);
  assert.equal(h.server.active, 0, 'no transfer keeps running after the window closes');
  setTime('01:30');
  const done = await waitFor(h.manager, d.id, settled, 120000);
  assert.equal(done.status, 'completed', JSON.stringify(done.problem));
  assert.equal(done.totalBytes, body.length);
}));

test('start now runs outside the hours and is not stopped by the schedule', () => withClock('12:00', async (h) => {
  h.server.routes.set('/now.bin', { body: randomBody(4 * MB), etag: '"1"' });
  const d = h.manager.add({ url: `${h.server.base}/now.bin` });
  await sleep(200);
  h.manager.startNow(d.id);
  const done = await waitFor(h.manager, d.id, settled, 120000);
  assert.equal(done.status, 'completed', JSON.stringify(done.problem));
}));

test('a paused download stays paused when the hours begin', () => withClock('12:00', async (h, setTime) => {
  h.server.routes.set('/held.bin', { body: randomBody(MB), etag: '"1"' });
  const d = h.manager.add({ url: `${h.server.base}/held.bin` });
  await h.manager.pause(d.id);
  setTime('03:00');
  await sleep(300);
  assert.equal(h.manager.get(d.id)?.status, 'paused');
}));

test('turning the schedule off starts what was waiting', () => withClock('12:00', async (h) => {
  h.server.routes.set('/off.bin', { body: randomBody(MB), etag: '"1"' });
  const d = h.manager.add({ url: `${h.server.base}/off.bin` });
  await sleep(200);
  await h.manager.updateSettings({ scheduleEnabled: false });
  const done = await waitFor(h.manager, d.id, settled);
  assert.equal(done.status, 'completed', JSON.stringify(done.problem));
}));

test('a schedule that starts and ends at the same time is refused', () => withClock('12:00', async (h) => {
  await assert.rejects(h.manager.updateSettings({ scheduleStart: '03:00', scheduleEnd: '03:00' }));
  await assert.rejects(h.manager.updateSettings({ scheduleStart: '25:00' }));
}));
