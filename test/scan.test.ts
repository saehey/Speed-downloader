import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { defenderScanner, findDefender, parseDefenderOutput } from '../src/core/scan.ts';
import type { Scanner, ScanVerdict } from '../src/core/scan.ts';
import type { Download } from '../src/shared/types.ts';
import { harness, MB, randomBody, settled, sleep, waitFor } from './helpers.ts';

// Real MpCmdRun output from this project's machine, Defender 4.18.26100.4.
const CLEAN = 'Scan starting...\r\nScan finished.\r\nScanning C:\\Users\\x\\file.bin found no threats.\r\n';
const FAILED = 'CmdTool: Failed with hr = 0x80070002. Check C:\\Users\\x\\AppData\\Local\\Temp\\MpCmdRun.log for more information\r\n';
// The detection report as Defender documents it. A real threat was not used, to keep the test machine clean.
const THREAT = [
  'Scan starting...', 'Scan finished.', 'Scanning C:\\Downloads\\setup.exe found 1 threats.', '',
  '<===========================LIST OF DETECTED THREATS==========================>',
  '----------------------------- Threat information ------------------------------',
  'Threat                  : Trojan:Win32/Example.A', 'Resources               : 1 total', '    file                : C:\\Downloads\\setup.exe',
].join('\r\n');

test('Defender\'s answer is read from its words, because its exit code is the same for a threat and a failure', () => {
  assert.deepEqual(parseDefenderOutput(CLEAN), { result: 'clean' });
  assert.deepEqual(parseDefenderOutput(THREAT), { result: 'threat', name: 'Trojan:Win32/Example.A' });
  assert.deepEqual(parseDefenderOutput(FAILED), { result: 'unavailable' });
  assert.deepEqual(parseDefenderOutput(''), { result: 'unavailable' });
  assert.deepEqual(parseDefenderOutput('Scanning x found 2 threats.'), { result: 'threat', name: null });
});

/** Stands in for Defender, so a threat can be tested without a harmful file. */
function fakeScanner(verdict: (target: string) => ScanVerdict, delayMs = 50) {
  const calls: string[] = [];
  let running = 0;
  let mostAtOnce = 0;
  const scanner: Scanner = {
    scan: async (target) => {
      calls.push(target);
      running += 1;
      mostAtOnce = Math.max(mostAtOnce, running);
      await sleep(delayMs);
      running -= 1;
      return verdict(target);
    },
  };
  return { scanner, calls, mostAtOnce: () => mostAtOnce };
}

const scanned = (d: { scan?: string }) => d.scan !== undefined && d.scan !== 'pending';

test('each finished file is checked once, one at a time, and the result is kept', async () => {
  const fake = fakeScanner((target) => (target.endsWith('bad.exe') ? { result: 'threat', name: 'Trojan:Win32/Example.A' } : { result: 'clean' }));
  const h = await harness({ scanner: fake.scanner });
  try {
    for (const name of ['good.zip', 'bad.exe', 'other.zip']) h.server.routes.set(`/${name}`, { body: randomBody(MB), etag: '"1"' });
    const ids = ['good.zip', 'bad.exe', 'other.zip'].map((name) => h.manager.add({ url: `${h.server.base}/${name}` }).id);
    for (const id of ids) await waitFor(h.manager, id, (d) => settled(d) && scanned(d), 60000);
    const [good, bad, other] = ids.map((id) => h.manager.get(id)!) as [Download, Download, Download];
    assert.equal(good.scan, 'clean');
    assert.equal(other.scan, 'clean');
    assert.equal(bad.scan, 'threat');
    assert.equal(bad.threatName, 'Trojan:Win32/Example.A');
    assert.ok(fs.existsSync(path.join(bad.dir, bad.filename!)), 'a flagged file is reported, not deleted by the app');
    assert.equal(fake.calls.length, 3);
    assert.equal(fake.mostAtOnce(), 1, 'scans never overlap');
  } finally {
    await h.dispose();
  }
});

test('downloading again clears the old result and checks the new file', async () => {
  let answer: ScanVerdict = { result: 'threat', name: 'Old' };
  const fake = fakeScanner(() => answer);
  const h = await harness({ scanner: fake.scanner });
  try {
    h.server.routes.set('/again.bin', { body: randomBody(MB), etag: '"1"' });
    const { id } = h.manager.add({ url: `${h.server.base}/again.bin` });
    await waitFor(h.manager, id, (d) => settled(d) && scanned(d));
    assert.equal(h.manager.get(id)?.scan, 'threat');
    answer = { result: 'clean' };
    await h.manager.restart(id);
    assert.equal(h.manager.get(id)?.scan, undefined, 'the old verdict does not stick to a new download');
    assert.equal(h.manager.get(id)?.threatName, undefined);
    await sleep(50);
    await waitFor(h.manager, id, (d) => settled(d) && scanned(d));
    assert.equal(h.manager.get(id)?.scan, 'clean');
  } finally {
    await h.dispose();
  }
});

test('a check cut short by closing the app runs when it opens again', async () => {
  const slow = fakeScanner(() => ({ result: 'clean' }), 60000);
  const h = await harness({ scanner: slow.scanner });
  try {
    h.server.routes.set('/later.bin', { body: randomBody(MB), etag: '"1"' });
    const { id } = h.manager.add({ url: `${h.server.base}/later.bin` });
    await waitFor(h.manager, id, (d) => settled(d) && d.scan === 'pending');
    await h.manager.close();
    const quick = fakeScanner(() => ({ result: 'clean' }));
    const reopened = await h.open({ scanner: quick.scanner });
    await waitFor(reopened, id, scanned, 10000);
    assert.equal(reopened.get(id)?.scan, 'clean');
    assert.equal(quick.calls.length, 1);
  } finally {
    await h.dispose();
  }
});

test('without Defender nothing is marked, and a file removed mid-check is left alone', async () => {
  const none = await harness();
  try {
    none.server.routes.set('/plain.bin', { body: randomBody(MB), etag: '"1"' });
    const { id } = none.manager.add({ url: `${none.server.base}/plain.bin` });
    await waitFor(none.manager, id, settled);
    assert.equal(none.manager.get(id)?.scan, undefined);
  } finally {
    await none.dispose();
  }
  const slow = fakeScanner(() => ({ result: 'threat', name: 'X' }), 400);
  const h = await harness({ scanner: slow.scanner });
  try {
    h.server.routes.set('/gone.bin', { body: randomBody(MB), etag: '"1"' });
    const { id } = h.manager.add({ url: `${h.server.base}/gone.bin` });
    await waitFor(h.manager, id, (d) => settled(d) && d.scan === 'pending');
    await h.manager.remove(id);
    await sleep(600);
    assert.equal(h.manager.get(id), undefined, 'a late answer does not bring a removed row back');
  } finally {
    await h.dispose();
  }
});

const defender = process.platform === 'win32' ? findDefender() : null;

test('the real Defender checks a clean file and a folder', { skip: !defender && 'Microsoft Defender is not installed' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-defender-'));
  try {
    const file = path.join(dir, 'ไฟล์ ทดสอบ.bin');
    fs.writeFileSync(file, randomBody(MB));
    fs.mkdirSync(path.join(dir, 'album'));
    fs.writeFileSync(path.join(dir, 'album', 'a.bin'), randomBody(1024));
    const scanner = defenderScanner(defender as string);
    const one = await scanner.scan(file);
    // Another antivirus can be in charge, and then Defender cannot scan.
    assert.ok(one.result === 'clean' || one.result === 'unavailable', JSON.stringify(one));
    if (one.result === 'clean') assert.deepEqual(await scanner.scan(path.join(dir, 'album')), { result: 'clean' });
    assert.deepEqual(await scanner.scan(path.join(dir, 'missing.bin')), { result: 'unavailable' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
