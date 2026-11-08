import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { emptyStats, parseStats } from '../src/shared/stats.ts';
import { atProgress, harness, MB, randomBody, settled, waitFor } from './helpers.ts';

test('saved numbers are checked, and anything odd starts again from zero', () => {
  const now = 1_000_000;
  assert.deepEqual(parseStats(undefined, now), emptyStats(now));
  assert.deepEqual(parseStats('x', now), emptyStats(now));
  const read = parseStats({ since: 5, completed: 3.7, completedBytes: -4, linksReplaced: 'many', problems: { network: 2, 'not a kind!': 9, disk: -1 }, threats: 1 }, now);
  assert.equal(read.since, 5);
  assert.equal(read.completed, 3);
  assert.equal(read.completedBytes, 0);
  assert.equal(read.linksReplaced, 0);
  assert.deepEqual(read.problems, { network: 2 });
  assert.equal(parseStats({ since: now + 1 }, now).since, now, 'a start date in the future is not trusted');
});

test('a file the app continued after closing is counted, with the part it did not download again', async () => {
  const h = await harness();
  try {
    const body = randomBody(16 * MB);
    h.server.routes.set('/big.bin', { body, etag: '"1"' });
    const { id } = h.manager.add({ url: `${h.server.base}/big.bin` });
    await waitFor(h.manager, id, atProgress(0.3));
    await h.manager.close();
    const held = JSON.parse(fs.readFileSync(path.join(h.state, 'downloads.json'), 'utf8')).downloads[0].completedBytes as number;
    assert.ok(held > 0);
    const reopened = await h.open();
    const done = await waitFor(reopened, id, settled);
    assert.equal(done.status, 'completed');
    const stats = reopened.state().stats;
    assert.equal(stats.completed, 1);
    assert.equal(stats.completedBytes, body.length);
    assert.equal(stats.resumedAfterClose, 1);
    assert.equal(stats.bytesKept, held);
    await reopened.close();
    const saved = fs.readFileSync(path.join(h.state, 'downloads.json'), 'utf8');
    assert.equal(JSON.parse(saved).stats.resumedAfterClose, 1, 'the numbers are kept for the next start');
    assert.ok(!/"stats":\{[^}]*big\.bin/.test(saved), 'the numbers hold no file names');
  } finally {
    await h.dispose();
  }
});

test('a replaced expired link and the problem before it are both counted', async () => {
  const h = await harness();
  try {
    const body = randomBody(16 * MB);
    const route: { body: Buffer; etag: string; deny?: number } = { body, etag: '"1"' };
    h.server.routes.set('/old.bin', route);
    h.server.routes.set('/new.bin', { body, etag: '"1"' });
    const d = h.manager.add({ url: `${h.server.base}/old.bin` });
    await waitFor(h.manager, d.id, atProgress(0.3));
    route.deny = 403;
    h.server.dropConnections();
    await waitFor(h.manager, d.id, settled);
    await h.manager.replaceUrl(d.id, { url: `${h.server.base}/new.bin` });
    await waitFor(h.manager, d.id, settled);
    const stats = h.manager.state().stats;
    assert.equal(stats.linksReplaced, 1);
    assert.equal(stats.problems['link-expired'], 1);
    assert.equal(stats.completed, 1);
    assert.equal(stats.resumedAfterClose, 0, 'a file that never stopped with the app is not a resume after closing');
  } finally {
    await h.dispose();
  }
});
