import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const source = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'background.js'), 'utf8');

/** Runs the real service worker against a stand-in for the browser's extension API. */
function load(saved: Record<string, unknown> = {}) {
  const session = { ...saved };
  const listeners: Record<string, (...args: never[]) => unknown> = {};
  const on = (name: string) => ({ addListener: (fn: (...args: never[]) => unknown) => { listeners[name] = fn; } });
  const portListeners: { message?: (m: unknown) => void; disconnect?: () => void } = {};
  const calls = { tabMessages: [] as unknown[], paused: [] as number[], posted: [] as unknown[], badge: '', alarms: [] as string[], cleared: [] as string[] };
  const chrome = {
    i18n: { getUILanguage: () => 'en' },
    storage: { session: { get: async () => ({ ...session }), set: async (v: object) => { Object.assign(session, v); } } },
    action: { onClicked: on('click'), setBadgeText: ({ text }: { text: string }) => { calls.badge = text; }, setTitle: () => {} },
    alarms: { onAlarm: on('alarm'), create: (name: string) => { calls.alarms.push(name); }, clear: async (name: string) => { calls.cleared.push(name); } },
    webRequest: { onSendHeaders: on('sendHeaders'), onResponseStarted: on('responseStarted'), onBeforeRequest: on('beforeRequest') },
    tabs: { onRemoved: on('tabRemoved'), sendMessage: (_tab: number, m: unknown, _o: unknown, done?: () => void) => { calls.tabMessages.push(m); done?.(); } },
    downloads: { onCreated: on('created'), onDeterminingFilename: on('name'), pause: (id: number, done: () => void) => { calls.paused.push(id); done(); }, resume: () => {}, cancel: () => {}, erase: () => {} },
    cookies: { getAll: async () => [] },
    notifications: { create: () => {} },
    runtime: {
      id: 'self',
      lastError: undefined,
      getManifest: () => ({ version: '9.9.9' }),
      onMessage: on('message'),
      connectNative: () => ({
        onMessage: { addListener: (fn: (m: unknown) => void) => { portListeners.message = fn; } },
        onDisconnect: { addListener: (fn: () => void) => { portListeners.disconnect = fn; } },
        postMessage: (m: unknown) => calls.posted.push(m),
        disconnect: () => {},
      }),
    },
  };
  const timers: NodeJS.Timeout[] = [];
  const context: Record<string, unknown> = { chrome, navigator: { userAgent: 'test' }, console, URL, setTimeout: (fn: () => void, ms: number) => { const t = setTimeout(fn, ms); timers.push(t); return t; }, clearTimeout };
  vm.runInNewContext(source, context);
  const download = (id: number, extra: object = {}) => ({ id, url: `https://example.com/file${id}.zip`, finalUrl: `https://example.com/file${id}.zip`, totalBytes: 10_000_000, mime: 'application/zip', state: 'in_progress', incognito: false, ...extra });
  return { context, calls, listeners, portListeners, download, session, dispose: () => timers.forEach(clearTimeout) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

test('the manifest allows everything the service worker uses', () => {
  const manifest = JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'manifest.json'), 'utf8'));
  assert.ok(manifest.action, 'the toolbar button needs an action');
  const used: Record<string, RegExp> = { webRequest: /chrome\.webRequest/, alarms: /chrome\.alarms/, downloads: /chrome\.downloads/, nativeMessaging: /connectNative/, cookies: /chrome\.cookies/, notifications: /chrome\.notifications/, storage: /chrome\.storage/ };
  for (const [permission, pattern] of Object.entries(used)) {
    assert.ok(pattern.test(source), `${permission} is no longer used`);
    assert.ok(manifest.permissions.includes(permission), `${permission} is missing from the manifest`);
  }
});

test('the video button script is declared and never turns on DRM or runs before a click', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.content_scripts[0].js, ['video-button.js']);
  const script = fs.readFileSync(path.join(root, 'video-button.js'), 'utf8');
  assert.ok(script.includes('video.mediaKeys'), 'videos using DRM get no button');
  assert.equal(script.match(/chrome\.runtime\.sendMessage/g)?.length, 1, 'one path sends anything');
  assert.ok(script.includes("mode: 'closed'"));
});

const videoAsk = (x: ReturnType<typeof load>, message: object, sender: object = { id: 'self', tab: { id: 1 } }) => {
  const answers: unknown[] = [];
  const kept = x.listeners.message!(message as never, sender as never, ((a: unknown) => answers.push(a)) as never);
  return { answers, kept };
};

test('requests are sorted into playable media and pieces', () => {
  const x = load();
  const classify = x.context.classifyMedia as (url: string, type: string | null, bytes: number | null) => string | null;
  assert.equal(classify('https://c.example/a/master.m3u8?token=1', null, null), 'hls');
  assert.equal(classify('https://c.example/stream', 'application/vnd.apple.mpegurl; charset=utf-8', null), 'hls');
  assert.equal(classify('https://c.example/a.mpd', null, null), 'dash');
  assert.equal(classify('https://c.example/stream', 'application/dash+xml', null), 'dash');
  assert.equal(classify('https://c.example/film.mp4', 'video/mp4', 50_000_000), 'file');
  assert.equal(classify('https://c.example/play', 'video/webm', null), 'file');
  for (const [url, type, bytes] of [
    ['https://c.example/seg-1.ts', 'video/mp2t', 900_000],
    ['https://c.example/seg-1.m4s', 'video/iso.segment', 900_000],
    ['https://c.example/teaser.mp4', 'video/mp4', 200_000],
    ['https://c.googlevideo.example/videoplayback?range=0-999', 'video/mp4', 9_000_000],
    ['https://c.example/data.json', 'application/json', 100],
    ['https://c.example/page.html', 'text/html', 100],
    ['not a url', null, null],
  ] as const) assert.equal(classify(url, type, bytes), null, url);
  x.dispose();
});

const seen = (url: string, type: string, extra: object = {}) => ({ requestId: url, tabId: 7, frameId: 2, statusCode: 200, url, initiator: 'https://player.example', responseHeaders: [{ name: 'Content-Type', value: type }], ...extra });

test('a seen playlist is kept with its real headers, and its child lists and pieces are not', async () => {
  const x = load();
  x.listeners.sendHeaders!({ requestId: 'https://c.example/master.m3u8', url: 'https://c.example/master.m3u8', requestHeaders: [{ name: 'Referer', value: 'https://player.example/embed/1' }, { name: 'Origin', value: 'https://player.example' }] } as never);
  x.listeners.responseStarted!(seen('https://c.example/master.m3u8', 'application/vnd.apple.mpegurl') as never);
  x.listeners.responseStarted!(seen('https://c.example/720p.m3u8', 'application/vnd.apple.mpegurl') as never);
  x.listeners.responseStarted!(seen('https://c.example/init.mp4', 'video/mp4') as never);
  await settle();
  const list = (vm.runInContext('mediaByTab', x.context) as Record<number, Array<{ url: string; referrer: string; origin: string }>>)[7];
  assert.equal(list?.length, 1);
  assert.equal(list?.[0]?.url, 'https://c.example/master.m3u8');
  assert.equal(list?.[0]?.referrer, 'https://player.example/embed/1');
  assert.equal(list?.[0]?.origin, 'https://player.example');
  assert.equal(JSON.stringify(x.calls.tabMessages), JSON.stringify([{ type: 'media-seen' }]), 'the page learns only that something was seen');
  x.dispose();
});

test('errors and requests outside a tab are ignored, and a new page clears the list', async () => {
  const x = load();
  x.listeners.responseStarted!(seen('https://c.example/a.m3u8', 'application/x-mpegurl', { statusCode: 403 }) as never);
  x.listeners.responseStarted!(seen('https://c.example/b.m3u8', 'application/x-mpegurl', { tabId: -1 }) as never);
  await settle();
  assert.equal((vm.runInContext('mediaByTab', x.context) as Record<number, unknown>)[7], undefined);
  x.listeners.responseStarted!(seen('https://c.example/c.m3u8', 'application/x-mpegurl') as never);
  await settle();
  assert.ok((vm.runInContext('mediaByTab', x.context) as Record<number, unknown>)[7]);
  x.listeners.beforeRequest!({ tabId: 7 } as never);
  await settle();
  assert.equal((vm.runInContext('mediaByTab', x.context) as Record<number, unknown>)[7], undefined);
  x.dispose();
});

test('a click sends what was seen, with cookies read only then, and in a form yt-dlp reads', async () => {
  const x = load();
  x.listeners.responseStarted!(seen('https://c.example/master.m3u8', 'application/x-mpegurl') as never);
  await settle();
  const before = x.calls.posted.length;
  assert.equal(before, 0, 'nothing leaves the browser before the click');
  videoAsk(x, { type: 'video-info', url: 'https://site.example/watch', title: 'player frame' }, { id: 'self', tab: { id: 7, title: 'A film' } });
  await settle();
  assert.equal(JSON.stringify(x.calls.posted[0]), JSON.stringify({ type: 'about', version: '9.9.9', userAgent: 'test' }), 'the extension says its version first, and nothing else about the user');
  const sent = x.calls.posted[1] as { type: string; title: string; media: Array<{ url: string; cookie: string; referrer: string }> };
  assert.equal(sent.title, 'A film');
  assert.equal(sent.media[0]?.url, 'https://c.example/master.m3u8');
  assert.equal(sent.media[0]?.referrer, 'https://player.example/');
  assert.equal(sent.media[0]?.cookie, null, 'a site with no cookies sends none');
  x.dispose();
});

test('a video question reaches the app and its answer returns to the page', async () => {
  const x = load();
  const { answers, kept } = videoAsk(x, { type: 'video-info', url: 'https://v.example/w', referrer: 'https://r.example/', src: '' });
  assert.equal(kept, true, 'the answer comes later, so the channel stays open');
  await settle();
  const sent = x.calls.posted[1] as { id: number; type: string; url: string };
  assert.equal(sent.type, 'video-info');
  assert.equal(sent.url, 'https://v.example/w');
  x.portListeners.message!({ type: 'video-result', id: sent.id, ok: true, title: 'T', choices: [] });
  assert.equal(JSON.stringify(answers), JSON.stringify([{ ok: true, title: 'T', choices: [] }]));
  x.dispose();
});

test('video messages from anywhere but this extension in a tab are ignored', async () => {
  const x = load();
  await settle();
  assert.equal(videoAsk(x, { type: 'video-info', url: 'https://v.example/' }, { id: 'other', tab: { id: 1 } }).kept, false);
  assert.equal(videoAsk(x, { type: 'video-info', url: 'https://v.example/' }, { id: 'self' }).kept, false);
  assert.equal(videoAsk(x, { type: 'download', url: 'https://v.example/' }).kept, false);
  assert.equal(x.calls.posted.length, 0);
  x.dispose();
});

test('a video question gets an answer when the app goes away', async () => {
  const x = load();
  const { answers } = videoAsk(x, { type: 'video-add', url: 'https://v.example/w', format: '22' });
  await settle();
  x.portListeners.disconnect!();
  assert.equal(JSON.stringify(answers), JSON.stringify([{ ok: false, problem: 'no-app' }]));
  x.dispose();
});

test('without a skip, a download is held and offered to the app', async () => {
  const x = load();
  await x.listeners.created!(x.download(1) as never);
  assert.deepEqual(x.calls.paused, [1]);
  x.dispose();
});

test('the toolbar button lets exactly one download stay in the browser', async () => {
  const x = load();
  await settle();
  await x.listeners.click!();
  assert.equal(x.calls.badge, 'SKIP');
  await x.listeners.created!(x.download(1) as never);
  assert.deepEqual(x.calls.paused, [], 'the skipped download is not touched');
  assert.equal(x.calls.badge, '', 'the badge clears once it is used');
  await x.listeners.created!(x.download(2) as never);
  assert.deepEqual(x.calls.paused, [2], 'the next download goes to the app again');
  x.dispose();
});

test('a file the browser keeps anyway does not use up the skip', async () => {
  const x = load();
  await settle();
  await x.listeners.click!();
  await x.listeners.created!(x.download(1, { totalBytes: 1000 }) as never);
  assert.equal(x.calls.badge, 'SKIP');
  x.dispose();
});

test('a second click cancels the skip', async () => {
  const x = load();
  await settle();
  await x.listeners.click!();
  await x.listeners.click!();
  assert.equal(x.calls.badge, '');
  await x.listeners.created!(x.download(1) as never);
  assert.deepEqual(x.calls.paused, [1]);
  x.dispose();
});

test('the skip survives the service worker being stopped and restarted', async () => {
  const x = load({ skipUntil: Date.now() + 30000 });
  await x.listeners.created!(x.download(1) as never);
  assert.deepEqual(x.calls.paused, []);
  x.dispose();
});

test('an expired skip no longer applies', async () => {
  const x = load({ skipUntil: Date.now() - 1 });
  await x.listeners.created!(x.download(1) as never);
  assert.deepEqual(x.calls.paused, [1]);
  x.dispose();
});

test('the alarm clears the skip when the minute is up', async () => {
  const x = load();
  await settle();
  await x.listeners.click!();
  x.listeners.alarm!({ name: 'skip-expired' } as never);
  assert.equal(x.calls.badge, '');
  x.dispose();
});
