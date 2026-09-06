import assert from 'node:assert/strict';
import test from 'node:test';

import { splitMessage } from '../src/telegram.js';

const lines = (count, filler = '.') => Array.from(
  { length: count },
  (_, i) => `строка ${i}`.padEnd(30, filler),
).join('\n');

test('leaves a message that fits in one piece', () => {
  const text = lines(3);

  assert.deepEqual(splitMessage(text, 4096), [text]);
});

test('cuts on line boundaries without opening a chunk on a blank line', () => {
  const chunks = splitMessage(lines(3), 40);

  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.doesNotMatch(chunk, /^\n/);
});

test('keeps every chunk within the limit', () => {
  for (const maxLen of [20, 40, 100]) {
    for (const chunk of splitMessage(lines(20), maxLen)) {
      assert.ok(chunk.length <= maxLen, `chunk of ${chunk.length} exceeds ${maxLen}`);
    }
  }
});

test('loses nothing but the newlines it cut on', () => {
  const text = lines(20);

  assert.equal(splitMessage(text, 40).join('\n'), text);
});

test('hard-cuts a single line that cannot fit', () => {
  const text = 'я'.repeat(100);

  assert.equal(splitMessage(text, 10).length, 10);
  assert.equal(splitMessage(text, 10).join(''), text);
});

test('preserves a deliberate blank line inside the text', () => {
  const text = `${'a'.repeat(30)}\n\n${'b'.repeat(30)}`;

  assert.equal(splitMessage(text, 35).join('\n'), text);
});

test('splits a real forecast that outgrew the Telegram limit', () => {
  const block = Array.from({ length: 60 }, (_, i) => `Провайдер ${i}: +12…+18°C, дождь 60%`).join('; ');
  const text = [
    '🏍️ Сценарий #1',
    '📍 Хамовники -> Тверской',
    `🌅 утро: ${block}`,
    `☀️ день: ${block}`,
    `🌆 вечер: ${block}`,
    '✅ Итог: ехать можно',
  ].join('\n');

  const chunks = splitMessage(text);

  assert.ok(text.length > 4096, 'фикстура должна превышать лимит Telegram');
  for (const chunk of chunks) assert.ok(chunk.length <= 4096);
  assert.equal(chunks.join('\n'), text);
});
