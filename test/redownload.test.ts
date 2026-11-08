import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { harness, MB, randomBody, settled, sha, sleep, waitFor } from './helpers.ts';

test('a finished file that went missing can be downloaded again', async () => {
  const h = await harness();
  try {
    const body = randomBody(MB);
    h.server.routes.set('/gone.bin', { body, etag: '"1"' });
    const { id } = h.manager.add({ url: `${h.server.base}/gone.bin` });
    await waitFor(h.manager, id, settled, 60000);
    const first = h.manager.get(id);
    assert.equal(first?.status, 'completed');
    const file = path.join(first!.dir, first!.filename as string);
    fs.rmSync(file);
    await h.manager.restart(id);
    assert.equal(h.manager.get(id)?.completedAt, null, 'it no longer counts as finished');
    await sleep(50);
    await waitFor(h.manager, id, settled, 60000);
    const again = h.manager.get(id);
    assert.equal(again?.status, 'completed');
    assert.equal(sha(fs.readFileSync(path.join(again!.dir, again!.filename as string))), sha(body));
  } finally {
    await h.dispose();
  }
});
