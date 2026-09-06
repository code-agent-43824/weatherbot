import assert from 'node:assert/strict';
import test from 'node:test';

import { createTtlLruCache } from '../src/ttl-lru-cache.js';

function clock(start = 0) {
  let value = start;
  return { now: () => value, advance: (ms) => { value += ms; } };
}

test('gives back what was stored', () => {
  const cache = createTtlLruCache({ maxEntries: 4, ttlMs: 1000 });
  cache.set('a', { temp: 12 });

  assert.deepEqual(cache.get('a'), { temp: 12 });
  assert.equal(cache.get('missing'), undefined);
});

test('forgets an entry once its time is up', () => {
  const time = clock();
  const cache = createTtlLruCache({ maxEntries: 4, ttlMs: 1000, now: time.now });
  cache.set('a', 1);

  time.advance(1000);
  assert.equal(cache.get('a'), 1, 'на самой границе запись ещё жива');

  time.advance(1);
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.size, 0, 'протухшая запись не занимает место');
});

test('evicts the least recently used, not the first inserted', () => {
  const cache = createTtlLruCache({ maxEntries: 2, ttlMs: 1000 });
  cache.set('a', 1);
  cache.set('b', 2);

  // Обращение к 'a' делает самым давним 'b', хотя вставлен он позже.
  assert.equal(cache.get('a'), 1);
  cache.set('c', 3);

  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('c'), 3);
});

test('keeps a refreshed key instead of dropping it by age', () => {
  const time = clock();
  const cache = createTtlLruCache({ maxEntries: 2, ttlMs: 1000, now: time.now });
  cache.set('a', 1);
  time.advance(500);
  cache.set('b', 2);
  cache.set('a', 11);

  cache.set('c', 3);

  assert.equal(cache.get('a'), 11);
  assert.equal(cache.get('b'), undefined);
});

test('never grows past the limit', () => {
  const cache = createTtlLruCache({ maxEntries: 3, ttlMs: 1000 });
  for (let i = 0; i < 50; i += 1) cache.set(`key-${i}`, i);

  assert.equal(cache.size, 3);
  assert.equal(cache.get('key-49'), 49);
  assert.equal(cache.get('key-0'), undefined);
});
