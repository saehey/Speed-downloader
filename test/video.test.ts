import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { classifyVideoError, errorLines, isSafeFormat, parseProgress, pickVideoChoices, videoArgs } from '../src/core/video.ts';
import { filesIn, harness, MB, randomBody, settled, sha, sleep, waitFor } from './helpers.ts';
import type { Harness } from './helpers.ts';

const ytDlpPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'yt-dlp', 'yt-dlp.exe');
const base = { ytDlpPath, url: 'https://example.com/watch', dir: 'D', tempDir: 'T' };

async function withVideo(fn: (h: Harness) => Promise<void>) {
  const h = await harness({ ytDlpPath, ffmpegPath: null });
  try {
    await fn(h);
  } finally {
    await h.dispose();
  }
}

test('the address can never be read as an option, and DRM stays refused', () => {
  const args = videoArgs({ ...base, url: '--exec=calc' });
  assert.deepEqual(args.slice(-2), ['--', '--exec=calc']);
  assert.ok(args.includes('--ignore-config'));
  assert.ok(!args.includes('--allow-unplayable-formats'));
});

test('ffmpeg decides whether separate picture and sound can be combined', () => {
  const withFfmpeg = videoArgs({ ...base, ffmpegPath: 'ffmpeg.exe' });
  assert.equal(withFfmpeg[withFfmpeg.indexOf('--format') + 1], 'bv*+ba/b');
  const without = videoArgs(base);
  assert.equal(without[without.indexOf('--format') + 1], 'b');
});

test('the speed limit is passed on only when one is set', () => {
  assert.ok(videoArgs({ ...base, rateLimit: '5M' }).includes('--limit-rate'));
  assert.ok(!videoArgs({ ...base, rateLimit: '0' }).includes('--limit-rate'));
});

test('progress lines are read, with estimates and missing values', () => {
  assert.deepEqual(parseProgress('SDPROGRESS 100 400 NA 50.5 C:\\a b\\clip.mp4.part'), { downloaded: 100, total: 400, speed: 50.5, filename: 'C:\\a b\\clip.mp4.part' });
  assert.deepEqual(parseProgress('SDPROGRESS 100 NA 900.0 NA x.part'), { downloaded: 100, total: 900, speed: 0, filename: 'x.part' });
  assert.equal(parseProgress('[download] something else'), null);
});

test('errors become problems the window can explain', () => {
  assert.equal(classifyVideoError('ERROR: [x] abc: This video is DRM protected'), 'video-drm');
  assert.equal(classifyVideoError('ERROR: Unsupported URL: https://a.example'), 'video-unsupported');
  assert.equal(classifyVideoError('ERROR: Sign in to confirm your age'), 'video-login');
  assert.equal(classifyVideoError('ERROR: unable to download video data: HTTP Error 503'), 'network');
  assert.equal(classifyVideoError('ERROR: something strange'), 'server');
  assert.equal(classifyVideoError('ERROR: [youtube] abc: This video is unavailable'), 'video-unsupported');
});

const FORMATS = [
  { format_id: 'sb0', ext: 'mhtml', vcodec: 'none', acodec: 'none' },
  { format_id: '140', ext: 'm4a', vcodec: 'none', acodec: 'mp4a', abr: 128, filesize: 3_000_000 },
  { format_id: '251', ext: 'webm', vcodec: 'none', acodec: 'opus', abr: 160, filesize: 3_500_000 },
  { format_id: '18', ext: 'mp4', vcodec: 'avc1', acodec: 'mp4a', height: 360, tbr: 500, filesize: 20_000_000 },
  { format_id: '137', ext: 'mp4', vcodec: 'avc1', acodec: 'none', height: 1080, fps: 60, tbr: 4000, filesize_approx: 90_000_000 },
  { format_id: '248', ext: 'webm', vcodec: 'vp9', acodec: 'none', height: 1080, fps: 60, tbr: 5000, filesize: 95_000_000 },
  { format_id: '136', ext: 'mp4', vcodec: 'avc1', acodec: 'none', height: 720, tbr: 2000 },
  { format_id: 'drm1', ext: 'mp4', vcodec: 'avc1', acodec: 'none', height: 2160, tbr: 9000, filesize: 1, has_drm: true },
];

test('the menu offers one choice per height, biggest first, with picture and sound added up', () => {
  const choices = pickVideoChoices(FORMATS, true);
  assert.deepEqual(choices.map((c) => c.format), ['137+140', '136+140', '18', '140']);
  assert.equal(choices[0]?.bytes, 93_000_000);
  assert.equal(choices[0]?.approximate, true);
  assert.equal(choices[0]?.ext, 'mp4');
  assert.equal(choices[1]?.bytes, null, 'a missing size is shown as unknown, not as a wrong number');
  assert.equal(choices[2]?.approximate, false);
  assert.equal(choices[3]?.audioOnly, true);
});

test('a stream that states no size gets an estimate from its bit rate and the video length', () => {
  const [hls, combined, audio] = pickVideoChoices([
    { format_id: '230', ext: 'mp4', vcodec: 'avc1', acodec: 'none', height: 240, tbr: 295 },
    { format_id: '18', ext: 'mp4', vcodec: 'avc1', acodec: 'mp4a', height: 144, tbr: 266 },
    { format_id: '140-drc', ext: 'm4a', vcodec: 'none', acodec: 'mp4a', abr: 130, filesize: 400 },
    { format_id: '140', ext: 'm4a', vcodec: 'none', acodec: 'mp4a', abr: 129, filesize: 300 },
  ], true, 100);
  assert.equal(hls?.format, '230+140', 'the plain sound is taken, not the compressed-loudness copy');
  assert.equal(hls?.bytes, 3_687_500 + 300);
  assert.equal(hls?.approximate, true);
  assert.equal(combined?.bytes, 3_325_000);
  assert.equal(audio?.approximate, false);
  assert.equal(pickVideoChoices([{ format_id: 'a', ext: 'mp4', vcodec: 'avc1', acodec: 'mp4a', height: 240 }], true, 100)[0]?.bytes, null, 'no bit rate means no estimate');
});

test('DRM formats are never offered', () => {
  assert.ok(!pickVideoChoices(FORMATS, true).some((c) => c.format.includes('drm')));
  assert.deepEqual(pickVideoChoices([{ format_id: 'x', ext: 'mp4', vcodec: 'avc1', acodec: 'mp4a', has_drm: true }], true), []);
});

test('without ffmpeg only formats holding both picture and sound are offered as video', () => {
  assert.deepEqual(pickVideoChoices(FORMATS, false).map((c) => c.format), ['18', '140']);
});

test('a plain file with no details still gets a choice', () => {
  const [choice] = pickVideoChoices([{ format_id: 'best', ext: 'mp4' }], false);
  assert.equal(choice?.format, 'best');
  assert.equal(choice?.height, null);
  assert.equal(choice?.audioOnly, false);
});

test('a format can only be plain IDs, so it cannot act as an option', () => {
  for (const good of ['18', '137+140', 'hls-1080', 'http_mp4.1']) assert.equal(isSafeFormat(good), true, good);
  for (const bad of ['--exec=calc', '137+--exec', 'a b', 'a+b+c', '', 'a;calc', '../x']) assert.equal(isSafeFormat(bad), false, bad);
});

test('an unsafe format is refused before anything starts', () => withVideo(async (h) => {
  assert.throws(() => h.manager.addVideo('https://example.com/w', { format: '--exec=calc' }));
}));

test('a page lists its qualities, and the chosen one downloads', () => withVideo(async (h) => {
  const body = randomBody(2 * MB);
  h.server.routes.set('/film.mp4', { body, contentType: 'video/mp4' });
  h.server.routes.set('/film', { body: Buffer.from(`<html><head><title>Film</title></head><body><video src="${h.server.base}/film.mp4"></video></body></html>`), contentType: 'text/html' });
  const info = await h.manager.videoChoices(`${h.server.base}/film`);
  assert.ok(info.title.startsWith('Film'), info.title);
  assert.ok(info.choices.length >= 1);
  const d = h.manager.addVideo(info.url, { format: info.choices[0]?.format });
  assert.equal(d.videoFormat, info.choices[0]?.format);
  const done = await waitFor(h.manager, d.id, settled, 120000);
  assert.equal(done.status, 'completed', JSON.stringify(done.problem));
  assert.equal(sha(fs.readFileSync(path.join(h.dir, done.filename as string))), sha(body));
}));

test('a page with no video falls back to the file its player was showing', () => withVideo(async (h) => {
  const body = randomBody(MB);
  h.server.routes.set('/direct.mp4', { body, contentType: 'video/mp4' });
  h.server.routes.set('/app', { body: Buffer.from('<html><body>script player</body></html>'), contentType: 'text/html' });
  const info = await h.manager.videoChoices(`${h.server.base}/app`, { fallback: `${h.server.base}/direct.mp4` });
  assert.equal(info.url, `${h.server.base}/direct.mp4`);
  assert.ok(info.choices.length >= 1);
  await assert.rejects(h.manager.videoChoices(`${h.server.base}/app`), (error: { kind?: string }) => error.kind === 'video-unsupported');
}));

test('warnings do not hide or decide the real error', () => {
  const output = 'WARNING: [youtube] No supported JavaScript runtime could be found. See cookies help\nERROR: [youtube] abc: This video is unavailable\n';
  assert.equal(errorLines(output), 'ERROR: [youtube] abc: This video is unavailable');
  assert.equal(classifyVideoError(errorLines(output)), 'video-unsupported');
  assert.equal(errorLines('plain failure'), 'plain failure');
});

test('a video is not accepted without yt-dlp', async () => {
  const h = await harness({ ytDlpPath: null });
  try {
    assert.throws(() => h.manager.addVideo('https://example.com/watch'));
  } finally {
    await h.dispose();
  }
});

test('only web addresses are accepted as video pages', () => withVideo(async (h) => {
  assert.throws(() => h.manager.addVideo('file:///C:/Windows/win.ini'));
  assert.throws(() => h.manager.addVideo('--exec=calc'));
}));

test('finds a video on a page, downloads it intact and leaves no temporary files', () => withVideo(async (h) => {
  const body = randomBody(2 * MB);
  h.server.routes.set('/clip.mp4', { body, contentType: 'video/mp4' });
  h.server.routes.set('/page', { body: Buffer.from(`<html><head><title>คลิปทดสอบ</title></head><body><video src="${h.server.base}/clip.mp4"></video></body></html>`), contentType: 'text/html; charset=utf-8' });
  const d = h.manager.addVideo(`${h.server.base}/page`);
  assert.equal(d.kind, 'video');
  const done = await waitFor(h.manager, d.id, settled, 120000);
  assert.equal(done.status, 'completed', JSON.stringify(done.problem));
  assert.ok(done.filename?.startsWith('คลิปทดสอบ'), `name was ${done.filename}`);
  assert.equal(done.totalBytes, body.length);
  assert.equal(sha(fs.readFileSync(path.join(h.dir, done.filename as string))), sha(body));
  assert.deepEqual(filesIn(h.dir), [done.filename]);
}));

test('a page with no video reports that clearly', () => withVideo(async (h) => {
  h.server.routes.set('/plain', { body: Buffer.from('<html><body>Nothing to see</body></html>'), contentType: 'text/html' });
  const d = h.manager.addVideo(`${h.server.base}/plain`);
  const done = await waitFor(h.manager, d.id, settled, 120000);
  assert.equal(done.status, 'failed');
  assert.equal(done.problem?.kind, 'video-unsupported');
  assert.deepEqual(filesIn(h.dir), [], 'a failed attempt with nothing downloaded leaves nothing behind');
}));

test('pause stops yt-dlp, resume finishes the same file, and cancel removes temporary files', () => withVideo(async (h) => {
  const body = randomBody(12 * MB);
  h.server.routes.set('/slow.mp4', { body, etag: '"1"', contentType: 'video/mp4' });
  const d = h.manager.addVideo(`${h.server.base}/slow.mp4`);
  await waitFor(h.manager, d.id, (now) => now.completedBytes > MB || settled(now), 60000);
  await h.manager.pause(d.id);
  assert.equal(h.manager.get(d.id)?.status, 'paused');
  await sleep(300);
  assert.equal(h.server.active, 0, 'pausing leaves no transfer running');
  h.manager.resume(d.id);
  const done = await waitFor(h.manager, d.id, settled, 120000);
  assert.equal(done.status, 'completed', JSON.stringify(done.problem));
  assert.equal(sha(fs.readFileSync(path.join(h.dir, done.filename as string))), sha(body));

  const other = h.manager.addVideo(`${h.server.base}/slow.mp4?again`);
  await waitFor(h.manager, other.id, (now) => now.completedBytes > 0 || settled(now), 60000);
  await h.manager.remove(other.id);
  assert.deepEqual(filesIn(h.dir), [done.filename], 'cancelling leaves only the finished file');
}));

test('closing the app ends yt-dlp and the video continues on the next start', () => withVideo(async (h) => {
  const body = randomBody(12 * MB);
  h.server.routes.set('/restart.mp4', { body, etag: '"1"', contentType: 'video/mp4' });
  const d = h.manager.addVideo(`${h.server.base}/restart.mp4`);
  await waitFor(h.manager, d.id, (now) => now.completedBytes > MB || settled(now), 60000);
  await h.manager.close();
  await sleep(300);
  assert.equal(h.server.active, 0, 'closing leaves no transfer running');
  await h.open({ ytDlpPath, ffmpegPath: null });
  const done = await waitFor(h.manager, d.id, settled, 120000);
  assert.equal(done.status, 'completed', JSON.stringify(done.problem));
  assert.equal(sha(fs.readFileSync(path.join(h.dir, done.filename as string))), sha(body));
}));
