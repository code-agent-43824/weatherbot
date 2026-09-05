import assert from 'node:assert/strict';
import test from 'node:test';

import { validatePolished } from '../src/llm.js';
import { aggregateSourceSummaries, templateForecast } from '../src/aggregate.js';

const source = (name, rainProb, rainMm, severe = false) => ({
  source: name, tempMin: 12, tempMax: 18, rainProb, rainMm, severe,
});
const window = (label, rows) => ({ label, summaries: rows, aggregate: aggregateSourceSummaries(rows) });
const dry = (name) => source(name, 0, 0);
const rainy = (name) => source(name, 80, 5, true);
const three = (make) => [make('Open-Meteo'), make('MET Norway'), make('7Timer')];

const scenario = {
  id: 1,
  mode: 'regular',
  settings: { home: { district: 'Хамовники' }, office: { district: 'Тверской' } },
};

// Сухое утро и дождливый вечер в одном сообщении — самый обычный день.
const mixedDraft = templateForecast(scenario, '2026-09-05', {
  morning: window('утро', three(dry)),
  day: window('день', three(dry)),
  evening: window('вечер', three(rainy)),
});

test('accepts the draft it validates against on a mixed day', () => {
  assert.equal(validatePolished(mixedDraft, mixedDraft), true);
});

test('accepts a polish that keeps every window as it was', () => {
  const polished = mixedDraft.replace('Итог: на мото', 'Итог: сегодня на мото');

  assert.equal(validatePolished(polished, mixedDraft), true);
});

test('rejects a polish that turns a dry window into a rainy one', () => {
  const polished = mixedDraft
    .split('\n')
    .map((line) => (line.startsWith('🌅') ? '🌅 утро: +12…+18°C, ожидается дождь' : line))
    .join('\n');

  assert.equal(validatePolished(polished, mixedDraft), false);
});

test('keeps a dry window that the model rephrased without rain', () => {
  const polished = mixedDraft
    .split('\n')
    .map((line) => (line.startsWith('🌅') ? '🌅 утро: +12…+18°C, без осадков' : line))
    .join('\n');

  assert.equal(validatePolished(polished, mixedDraft), true);
});

test('rejects a polish that drops a window line', () => {
  const polished = mixedDraft.split('\n').filter((line) => !line.startsWith('🌅')).join('\n');

  assert.equal(validatePolished(polished, mixedDraft), false);
});

test('rejects provider names, units and a missing verdict', () => {
  assert.equal(validatePolished(mixedDraft.replace('Итог:', 'Вывод:'), mixedDraft), false);
  assert.equal(validatePolished(`${mixedDraft}\nOpen-Meteo обещает то же`, mixedDraft), false);
  assert.equal(validatePolished(`${mixedDraft} 5 мм`, mixedDraft), false);
  assert.equal(validatePolished('', mixedDraft), false);
});
