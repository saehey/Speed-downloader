import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MenuItem, MenuItemConstructorOptions } from 'electron';
import { linkFromClipboard, trayMenu, trayState } from '../src/main/tray-menu.ts';
import type { TrayActions } from '../src/main/tray-menu.ts';
import { MESSAGES } from '../src/shared/i18n.ts';
import { emptyStats } from '../src/shared/stats.ts';
import { MARK, markCoverage } from '../src/shared/mark.ts';

import type { ApiState, Download, DownloadStatus } from '../src/shared/types.ts';

const m = MESSAGES.en;
const row = (id: string, status: DownloadStatus, extra: Partial<Download> = {}): Download => ({ id, url: 'https://a.example/f.zip', filename: `${id}.zip`, dir: 'D', status, totalBytes: 0, completedBytes: 0, speed: 0, connections: 0, acceptsRanges: true, validator: null, problem: null, referrer: null, userAgent: null, hasCookie: false, createdAt: 1, completedAt: status === 'completed' ? 1 : null, ...extra });
const state = (downloads: Download[], settings: Partial<ApiState['settings']> = {}): ApiState => ({ downloads, engineReady: true, stats: emptyStats(0), settings: { defaultDir: 'D', categoryDirs: {}, maxConcurrent: 3, connections: 16, minSplitSize: '4M', speedLimit: '0', shutdownWhenDone: false, scheduleEnabled: false, scheduleStart: '01:00', scheduleEnd: '06:00', browserCapture: true, extraExtensions: '', language: 'en', ...settings } });

function fakeActions() {
  const calls: unknown[][] = [];
  const record = (name: string) => (...args: unknown[]) => { calls.push([name, ...args]); };
  const actions = Object.fromEntries(['open', 'openProblems', 'openSettings', 'addLink', 'pauseAll', 'resumeAll', 'showFile', 'openFolder', 'setCapture', 'setSchedule', 'setShutdown', 'quit'].map((n) => [n, record(n)])) as unknown as TrayActions;
  return { calls, actions };
}
const find = (menu: MenuItemConstructorOptions[], label: string) => {
  const item = menu.find((i) => i.label === label);
  assert.ok(item, `no menu item ${label}`);
  return item;
};
const press = (item: MenuItemConstructorOptions, checked?: boolean) => (item.click as unknown as (i: Partial<MenuItem>) => void)({ checked });

test('an idle menu offers only what can be done', () => {
  const { actions } = fakeActions();
  const menu = trayMenu(state([]), m, actions, null, '');
  assert.equal(menu[0]?.label, m.trayIdle);
  assert.equal(find(menu, m.trayPauseAll).enabled, false);
  assert.equal(find(menu, m.trayResumeAll).enabled, false);
  assert.equal(find(menu, m.trayRecent).enabled, false);
  assert.equal(find(menu, m.trayAddLinkNone).enabled, false);
});

test('the menu shows live speed and each item does its job', () => {
  const { actions, calls } = fakeActions();
  const menu = trayMenu(state([row('a', 'downloading'), row('b', 'paused'), row('c', 'completed')]), m, actions, { url: 'https://x.example/f', label: 'x.example' }, '3.0 MB/s');
  assert.equal(menu[0]?.label, m.trayActive(1, '3.0 MB/s'));
  press(find(menu, m.trayOpen));
  press(find(menu, m.trayAddLink('x.example')));
  press(find(menu, m.trayPauseAll));
  press(find(menu, m.trayResumeAll));
  press((find(menu, m.trayRecent).submenu as MenuItemConstructorOptions[])[0] as MenuItemConstructorOptions);
  press(find(menu, m.trayOpenFolder));
  press(find(menu, m.capture), false);
  press(find(menu, m.scheduleEnabled), true);
  press(find(menu, m.settings));
  press(find(menu, m.trayQuit));
  assert.deepEqual(calls, [['open'], ['addLink', 'https://x.example/f'], ['pauseAll'], ['resumeAll'], ['showFile', 'c'], ['openFolder'], ['setCapture', false], ['setSchedule', true], ['openSettings'], ['quit']]);
});

test('problems and the schedule are shown at the top', () => {
  const { actions, calls } = fakeActions();
  const menu = trayMenu(state([row('a', 'failed'), row('b', 'attention')], { scheduleEnabled: true }), m, actions, null, '', new Date('2026-11-05T12:00:00'));
  assert.equal(menu[1]?.label, m.waitingSchedule('01:00'));
  press(find(menu, m.trayProblems(2)));
  assert.deepEqual(calls, [['openProblems']]);
});

test('recent files are the newest five, with safe labels', () => {
  const { actions } = fakeActions();
  const files = Array.from({ length: 7 }, (_, i) => row(`f${i}`, 'completed', { completedAt: i, filename: i === 6 ? `R&D ${'x'.repeat(80)}.zip` : `f${i}.zip` }));
  const recent = find(trayMenu(state(files), m, actions, null, ''), m.trayRecent).submenu as MenuItemConstructorOptions[];
  assert.equal(recent.length, 5);
  assert.ok(recent[0]?.label?.startsWith('R&&D'));
  assert.ok(recent[0]?.label?.endsWith('.zip'));
  assert.ok([...(recent[0]?.label ?? '')].length < 50);
});

test('the tray icon state puts problems first', () => {
  assert.equal(trayState(state([])), 'idle');
  assert.equal(trayState(state([row('a', 'completed')])), 'idle');
  assert.equal(trayState(state([{ ...row('a', 'completed'), scan: 'threat' }])), 'problem', 'a file Defender flagged shows the red dot');
  assert.equal(trayState(state([row('a', 'paused')])), 'paused');
  assert.equal(trayState(state([row('a', 'paused'), row('b', 'downloading')])), 'active');
  assert.equal(trayState(state([row('a', 'downloading'), row('b', 'failed')])), 'problem');
});

test('only one web address or magnet is taken from the clipboard', () => {
  assert.deepEqual(linkFromClipboard(' https://a.example/f?token=secret '), { url: 'https://a.example/f?token=secret', label: 'a.example' });
  assert.equal(linkFromClipboard('magnet:?xt=urn:btih:abc')?.label, 'magnet');
  for (const bad of ['', 'hello world', 'file:///C:/x', 'javascript:alert(1)', 'https://a.example/x https://b.example/y', 'not a link']) {
    assert.equal(linkFromClipboard(bad), null, bad);
  }
});

test('the mark draws every dot, at each tray size', () => {
  for (const [size, padding] of [[16, 1], [24, 1.5], [32, 2], [512, 87]] as const) {
    const coverage = markCoverage(size, padding);
    assert.equal(coverage.length, size * size);
    const cell = (size - padding * 2) / MARK.length;
    MARK.forEach((row, y) => [...row].forEach((value, x) => {
      const centre = Math.floor(padding + (y + 0.5) * cell) * size + Math.floor(padding + (x + 0.5) * cell);
      if (value === '#') assert.ok((coverage[centre] ?? 0) > 0.7, `size ${size}: dot ${x},${y} is faint`);
      else assert.equal(coverage[centre], 0, `size ${size}: stray ink at ${x},${y}`);
    }));
  }
});
