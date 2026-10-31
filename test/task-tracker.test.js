import assert from 'node:assert/strict';
import test from 'node:test';
import { createTaskTracker } from '../src/task-tracker.js';

test('shutdown drains active send and state commit before closing; no new tasks', async () => {
  const tracker = createTaskTracker();
  const events = [];
  let finishSend;
  const send = new Promise((resolve) => { finishSend = resolve; });
  const work = tracker.run(async () => { await send; events.push('sent', 'saved'); });
  const closing = tracker.close().then(() => events.push('closed'));
  await tracker.run(() => events.push('unexpected'));
  assert.deepEqual(events, []);
  finishSend();
  await Promise.all([work, closing]);
  assert.deepEqual(events, ['sent', 'saved', 'closed']);
});

test('failed work does not prevent draining other tasks', async () => {
  const tracker = createTaskTracker();
  const failed = tracker.run(() => { throw new Error('test failure'); });
  const checked = assert.rejects(failed, /test failure/);
  await tracker.close();
  await checked;
});
