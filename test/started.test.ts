import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startTracker } from '../src/shared/started.ts';

const row = (id: string, status: string) => ({ id, status });

test('what is already running at the first look is not new', () => {
  const started = startTracker();
  assert.deepEqual(started([row('a', 'downloading'), row('b', 'queued')]), []);
  assert.deepEqual(started([row('a', 'downloading'), row('b', 'queued')]), []);
});

test('a file counts when it begins downloading, not while it waits', () => {
  const started = startTracker();
  started([]);
  assert.deepEqual(started([row('a', 'queued')]), []);
  assert.deepEqual(started([row('a', 'probing')]), []);
  assert.deepEqual(started([row('a', 'downloading')]), ['a']);
  assert.deepEqual(started([row('a', 'downloading')]), []);
});

test('several files can begin at once', () => {
  const started = startTracker();
  started([]);
  assert.deepEqual(started([row('a', 'downloading'), row('b', 'downloading')]), ['a', 'b']);
});

test('waiting and trying again, or pausing and resuming, does not count twice', () => {
  const started = startTracker();
  started([]);
  assert.deepEqual(started([row('a', 'downloading')]), ['a']);
  assert.deepEqual(started([row('a', 'queued')]), []);
  assert.deepEqual(started([row('a', 'downloading')]), []);
  assert.deepEqual(started([row('a', 'paused')]), []);
  assert.deepEqual(started([row('a', 'downloading')]), []);
});

test('a finished file that is downloaded again counts again', () => {
  const started = startTracker();
  started([]);
  assert.deepEqual(started([row('a', 'downloading')]), ['a']);
  assert.deepEqual(started([row('a', 'completed')]), []);
  assert.deepEqual(started([row('a', 'downloading')]), ['a']);
});

test('a removed file is forgotten', () => {
  const started = startTracker();
  started([]);
  started([row('a', 'downloading')]);
  started([]);
  assert.deepEqual(started([row('a', 'downloading')]), ['a']);
});
