import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { harness, MB, randomBody, settled, waitFor } from './helpers.ts';
import type { Harness } from './helpers.ts';

async function withFolders(fn: (h: Harness, folder: (name: string) => string) => Promise<void>) {
  // Only where a video would be saved is checked here, so yt-dlp itself never needs to run.
  const h = await harness({ ytDlpPath: 'no-such-yt-dlp.exe' });
  const folder = (name: string) => path.join(path.dirname(h.dir), name);
  try {
    await h.manager.updateSettings({ categoryDirs: { video: folder('Movies'), audio: folder('Music'), program: folder('Programs'), other: folder('Other'), torrent: folder('Torrents') } });
    await fn(h, folder);
  } finally {
    await h.dispose();
  }
}

test('files go to the folder for their type, and the folder is created when needed', () => withFolders(async (h, folder) => {
  const body = randomBody(MB);
  for (const name of ['clip.mp4', 'song.mp3', 'setup.exe', 'notes.dat']) h.server.routes.set(`/${name}`, { body, etag: '"1"' });
  const want = { 'clip.mp4': 'Movies', 'song.mp3': 'Music', 'setup.exe': 'Programs', 'notes.dat': 'Other' } as const;
  for (const [name, dir] of Object.entries(want)) {
    const d = h.manager.add({ url: `${h.server.base}/${name}` });
    assert.equal(d.dir, h.dir, 'before the server names it, the type is not known');
    const done = await waitFor(h.manager, d.id, settled, 60000);
    assert.equal(done.status, 'completed', JSON.stringify(done.problem));
    assert.equal(done.dir, folder(dir));
    assert.ok(fs.existsSync(path.join(folder(dir), name)), `${name} is in ${dir}`);
  }
}));

test('a type with no folder of its own uses the main folder', () => withFolders(async (h) => {
  h.server.routes.set('/report.pdf', { body: randomBody(MB), etag: '"1"' });
  const d = h.manager.add({ url: `${h.server.base}/report.pdf` });
  const done = await waitFor(h.manager, d.id, settled, 60000);
  assert.equal(done.dir, h.dir);
  assert.ok(fs.existsSync(path.join(h.dir, 'report.pdf')));
}));

test('the name from the server decides the type, not the address', () => withFolders(async (h, folder) => {
  h.server.routes.set('/get', { body: randomBody(MB), etag: '"1"', disposition: 'attachment; filename="album.flac"' });
  const d = h.manager.add({ url: `${h.server.base}/get` });
  const done = await waitFor(h.manager, d.id, settled, 60000);
  assert.equal(done.filename, 'album.flac');
  assert.equal(done.dir, folder('Music'));
}));

test('a name known from the browser picks the folder straight away', () => withFolders(async (h, folder) => {
  await h.manager.pause(h.manager.add({ url: `${h.server.base}/x`, filename: 'movie.mkv' }).id);
  assert.equal(h.manager.list()[0]?.dir, folder('Movies'));
}));

test('an address given with its own folder keeps it', () => withFolders(async (h, folder) => {
  h.server.routes.set('/own.mp4', { body: randomBody(MB), etag: '"1"' });
  const own = folder('Chosen');
  const d = h.manager.add({ url: `${h.server.base}/own.mp4`, dir: own });
  const done = await waitFor(h.manager, d.id, settled, 60000);
  assert.equal(done.dir, own);
}));

test('videos and torrents use their folders, and sound alone goes with audio', () => withFolders(async (h, folder) => {
  assert.equal(h.manager.addVideo('https://example.invalid/watch').dir, folder('Movies'));
  assert.equal(h.manager.addVideo('https://example.invalid/watch', { format: '140', audioOnly: true }).dir, folder('Music'));
  assert.equal(h.manager.add({ url: `magnet:?xt=urn:btih:${'a'.repeat(40)}` }).dir, folder('Torrents'));
  for (const d of h.manager.list()) await h.manager.pause(d.id);
}));

test('changing a folder does not move a download already started, and clearing one returns to the main folder', () => withFolders(async (h, folder) => {
  const body = randomBody(MB);
  h.server.routes.set('/first.mp4', { body, etag: '"1"' });
  const first = h.manager.add({ url: `${h.server.base}/first.mp4` });
  const done = await waitFor(h.manager, first.id, settled, 60000);
  await h.manager.updateSettings({ categoryDirs: { video: folder('Elsewhere') } });
  assert.equal(h.manager.get(first.id)?.dir, done.dir);
  assert.ok(fs.existsSync(path.join(folder('Movies'), 'first.mp4')));
  await h.manager.updateSettings({ categoryDirs: {} });
  h.server.routes.set('/second.mp4', { body, etag: '"1"' });
  const second = await waitFor(h.manager, h.manager.add({ url: `${h.server.base}/second.mp4` }).id, settled, 60000);
  assert.equal(second.dir, h.dir);
}));

test('the folders survive a restart', () => withFolders(async (h, folder) => {
  await h.manager.close();
  await h.open();
  assert.equal(h.manager.state().settings.categoryDirs.video, folder('Movies'));
}));

test('a saved list from before this feature still loads', async () => {
  const h = await harness();
  try {
    await h.manager.close();
    fs.writeFileSync(path.join(h.state, 'downloads.json'), JSON.stringify({ version: 1, settings: { connections: 8 }, cookies: {}, downloads: [] }));
    await h.open();
    assert.deepEqual(h.manager.state().settings.categoryDirs, {});
    assert.equal(h.manager.state().settings.connections, 8);
  } finally {
    await h.dispose();
  }
});

test('folder settings must be real paths for known types', () => withFolders(async (h) => {
  await assert.rejects(h.manager.updateSettings({ categoryDirs: { video: 'relative/folder' } }));
  await assert.rejects(h.manager.updateSettings({ categoryDirs: { nonsense: 'C:\\x' } as never }));
}));
