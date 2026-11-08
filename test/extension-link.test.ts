import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { BrowserBridge, encodeFrame, FrameReader, pipePath } from '../src/core/bridge.ts';
import { removeStaleConfs } from '../src/core/engine.ts';
import { browserOf, linkState, parseLinks, recordLink } from '../src/shared/extension-link.ts';
import type { BrowserName } from '../src/shared/extension-link.ts';
import { sleep } from './helpers.ts';

const EDGE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36 Edg/157.0.4341.42';
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

test('the browser is told apart from its user agent', () => {
  assert.equal(browserOf(EDGE), 'Edge');
  assert.equal(browserOf(CHROME), 'Chrome');
  assert.equal(browserOf(undefined), 'Chrome');
});

test('each browser keeps one entry, and an old or unknown version counts as out of date', () => {
  let links = recordLink([], 'Edge', '1.5.0', 1000);
  links = recordLink(links, 'Chrome', null, 2000);
  links = recordLink(links, 'Edge', '1.5.0', 3000);
  assert.deepEqual(links.map((l) => [l.browser, l.lastSeen]), [['Chrome', 2000], ['Edge', 3000]]);
  assert.equal(linkState(links[1]!, '1.5.0'), 'current');
  assert.equal(linkState(links[0]!, '1.5.0'), 'outdated', 'an extension too old to say its version needs a reload');
  assert.equal(linkState({ browser: 'Edge', lastSeen: 1, version: '1.4.0' }, '1.5.0'), 'outdated');
});

test('a damaged saved list is cleaned rather than trusted', () => {
  assert.deepEqual(parseLinks('nonsense'), []);
  assert.deepEqual(parseLinks([{ browser: 'Firefox', lastSeen: 1 }, { browser: 'Edge', lastSeen: 'x' }, { browser: 'Edge', lastSeen: 5, version: '<script>' }, { browser: 'Edge', lastSeen: 9, version: '1.5.0' }]), [{ browser: 'Edge', lastSeen: 5, version: null }]);
});

test('the bridge reports who connected, once per connection, only after the token is proven', async () => {
  const config = { pipe: `sd-link-test-${process.pid}`, token: 'link-token', origin: 'chrome-extension://abc/' };
  const seen: Array<{ browser: BrowserName; version: string | null }> = [];
  const bridge = new BrowserBridge(config, { decide: async () => ({ accept: false, reason: 'test' }), accepted: () => {}, connected: (link) => seen.push(link) });
  await bridge.listen();
  const connect = async (token: string) => {
    const socket = net.connect(pipePath(config.pipe));
    const reader = new FrameReader();
    socket.on('data', (chunk) => reader.push(chunk as Buffer));
    socket.on('error', () => {});
    await new Promise((resolve) => socket.once('connect', resolve));
    socket.write(encodeFrame({ type: 'hello', token, origin: config.origin }));
    return socket;
  };
  try {
    const stranger = await connect('wrong');
    stranger.write(encodeFrame({ type: 'about', version: '1.5.0', userAgent: EDGE }));
    await sleep(100);
    assert.deepEqual(seen, [], 'a connection without the token tells the app nothing');
    stranger.destroy();

    const current = await connect(config.token);
    current.write(encodeFrame({ type: 'about', version: '1.5.0', userAgent: EDGE }));
    current.write(encodeFrame({ type: 'about', version: '9.9.9', userAgent: CHROME }));
    current.write(encodeFrame({ type: 'download', id: 1, url: 'https://a.test/x.zip', userAgent: EDGE }));
    await sleep(150);
    assert.deepEqual(seen, [{ browser: 'Edge', version: '1.5.0' }]);
    current.destroy();

    const old = await connect(config.token);
    old.write(encodeFrame({ type: 'download', id: 2, url: 'https://a.test/y.zip', userAgent: CHROME }));
    await sleep(150);
    assert.deepEqual(seen.at(-1), { browser: 'Chrome', version: null }, 'an extension from before 1.5.0 is recognised by its first message');
    old.destroy();

    const odd = await connect(config.token);
    odd.write(encodeFrame({ type: 'about', version: '../../evil', userAgent: CHROME }));
    await sleep(100);
    assert.deepEqual(seen.at(-1), { browser: 'Chrome', version: null }, 'a version that is not a version is not stored');
    odd.destroy();
  } finally {
    await bridge.close();
  }
});

test('aria2 configs left by an app that was stopped mid-start are removed, and nothing else', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-conf-'));
  try {
    for (const name of ['aria2-111.conf', 'aria2-222.conf', 'aria2-333.conf', 'downloads.json', 'aria2-notes.conf']) fs.writeFileSync(path.join(dir, name), 'x');
    removeStaleConfs(dir, path.join(dir, 'aria2-333.conf'));
    assert.deepEqual(fs.readdirSync(dir).sort(), ['aria2-333.conf', 'aria2-notes.conf', 'downloads.json']);
    removeStaleConfs(path.join(dir, 'missing'), 'x');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
