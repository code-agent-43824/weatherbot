import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchJsonWithTimeout } from '../src/http.js';

test('JSON requests are bounded and never disclose URLs, credentials or response text', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const url = 'https://example.test/botFAKE_TOKEN/path?key=FAKE_KEY';
  globalThis.fetch = async () => ({ ok: false, status: 429 });
  await assert.rejects(fetchJsonWithTimeout(url), (error) => {
    assert.equal(error.status, 429);
    assert.doesNotMatch(error.stack, /FAKE|example/);
    return true;
  });
  globalThis.fetch = async () => { throw new Error(url); };
  await assert.rejects(fetchJsonWithTimeout(url), (error) => !error.stack.includes('FAKE'));
  globalThis.fetch = async () => ({ ok: true, json: async () => { throw new Error('FAKE_KEY in body'); } });
  await assert.rejects(fetchJsonWithTimeout(url), (error) => !error.stack.includes('FAKE'));
  globalThis.fetch = async (_url, { signal }) => new Promise((resolve, reject) => {
    if (signal.aborted) reject(new Error(url));
    else signal.addEventListener('abort', () => reject(new Error(url)), { once: true });
  });
  await assert.rejects(fetchJsonWithTimeout(url, {}, 10), /timed out/);
  globalThis.fetch = async (_url, { signal }) => ({ ok: true, json: () => new Promise((resolve, reject) => {
    if (signal.aborted) reject(new Error(url));
    else signal.addEventListener('abort', () => reject(new Error(url)), { once: true });
  }) });
  await assert.rejects(fetchJsonWithTimeout(url, {}, 10), /timed out/);
  const controller = new AbortController();
  const pending = fetchJsonWithTimeout(url, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /aborted/);
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ value: 42 }) });
  assert.deepEqual(await fetchJsonWithTimeout(url), { value: 42 });
});
