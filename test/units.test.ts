import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filenameFromDisposition, filenameFromUrl, isSafeHeaderValue, sanitizeFilename, uniqueName } from '../src/core/names.ts';
import { compareValidators, probe } from '../src/core/probe.ts';
import { randomBody, TestServer } from './helpers.ts';

test('file names cannot leave the target folder or use reserved names', () => {
  assert.equal(sanitizeFilename('..\\..\\Windows\\evil.exe'), 'evil.exe');
  assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFilename('..'), 'download');
  assert.equal(sanitizeFilename('CON'), '_CON');
  assert.equal(sanitizeFilename('nul.txt'), '_nul.txt');
  assert.equal(sanitizeFilename('a<b>:c|d?.txt'), 'a_b__c_d_.txt');
  assert.equal(sanitizeFilename('name. . '), 'name');
  assert.equal(sanitizeFilename(''), 'download');
  assert.ok(sanitizeFilename(`${'x'.repeat(500)}.zip`).endsWith('.zip'));
  assert.ok(sanitizeFilename(`${'x'.repeat(500)}.zip`).length <= 200);
});

test('names come from headers and URLs', () => {
  assert.equal(filenameFromDisposition(`attachment; filename="a b.zip"`), 'a b.zip');
  assert.equal(filenameFromDisposition(`attachment; filename*=UTF-8''%E0%B8%97%E0%B8%94.zip`), 'ทด.zip');
  assert.equal(filenameFromDisposition(`attachment; filename="../../x.exe"`), 'x.exe');
  assert.equal(filenameFromDisposition(null), null);
  assert.equal(filenameFromUrl('https://a.test/dir/My%20File.zip?x=1'), 'My File.zip');
  assert.equal(filenameFromUrl('https://a.test/'), 'download');
});

test('duplicate names get a number', () => {
  const taken = new Set(['a.zip', 'a (1).zip']);
  assert.equal(uniqueName('a.zip', (n) => taken.has(n)), 'a (2).zip');
  assert.equal(uniqueName('b.zip', (n) => taken.has(n)), 'b.zip');
});

test('header values cannot contain line breaks', () => {
  assert.equal(isSafeHeaderValue('a=b; c=d'), true);
  assert.equal(isSafeHeaderValue('a=b\r\n  dir=C:\\Windows'), false);
});

test('only strong proof counts as unchanged', () => {
  const v = (etag: string | null, lastModified: string | null, size: number | null) => ({ etag, lastModified, size });
  assert.equal(compareValidators(v('"a"', null, 10), v('"a"', null, 10)), 'same');
  assert.equal(compareValidators(v('"a"', null, 10), v('"b"', null, 10)), 'changed');
  assert.equal(compareValidators(v('"a"', null, 10), v('"a"', null, 11)), 'changed');
  assert.equal(compareValidators(v(null, 'd1', 10), v(null, 'd1', 10)), 'same');
  assert.equal(compareValidators(v(null, 'd1', 10), v(null, 'd2', 10)), 'changed');
  assert.equal(compareValidators(v(null, null, 10), v(null, null, 10)), 'unknown');
  assert.equal(compareValidators(v('W/"a"', null, 10), v('W/"a"', null, 10)), 'unknown');
  assert.equal(compareValidators(null, v('"a"', null, 10)), 'unknown');
});

test('probe drops the cookie when a redirect changes origin', async () => {
  const a = new TestServer();
  const b = new TestServer();
  await a.listen();
  await b.listen();
  try {
    b.routes.set('/file', { body: randomBody(1024), etag: '"x"' });
    a.routes.set('/same', { body: Buffer.alloc(0), redirect: '/local' });
    a.routes.set('/local', { body: randomBody(1024), etag: '"y"' });
    a.routes.set('/away', { body: Buffer.alloc(0), redirect: `${b.base}/file` });

    const local = await probe({ url: `${a.base}/same`, cookie: 'session=secret' });
    assert.equal(local.finalUrl, `${a.base}/local`);
    assert.equal(a.hits.find((h) => h.path === '/local')?.cookie, 'session=secret');

    const away = await probe({ url: `${a.base}/away`, cookie: 'session=secret' });
    assert.equal(away.finalUrl, `${b.base}/file`);
    assert.equal(away.validator.size, 1024);
    assert.equal(away.acceptsRanges, true);
    assert.equal(b.hits[0]?.cookie, null);
  } finally {
    await a.close();
    await b.close();
  }
});
