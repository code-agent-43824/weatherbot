import assert from 'node:assert/strict';
import test from 'node:test';

import { createNonOverlappingRunner } from '../src/non-overlapping-runner.js';

test('skips a tick while the previous tick is still running', async () => {
  let release;
  let calls = 0;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const run = createNonOverlappingRunner(async () => {
    calls += 1;
    await blocked;
  });

  const first = run();
  assert.equal(await run(), false);
  assert.equal(calls, 1);

  release();
  assert.equal(await first, true);
});

test('unlocks after a failed tick', async () => {
  let calls = 0;
  const run = createNonOverlappingRunner(async () => {
    calls += 1;
    if (calls === 1) throw new Error('temporary failure');
  });

  await assert.rejects(run(), /temporary failure/);
  assert.equal(await run(), true);
  assert.equal(calls, 2);
});
