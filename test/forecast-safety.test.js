import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregateWindows, aggregateSourceSummaries, templateForecast } from '../src/aggregate.js';
import { metNorwayWindow, tomorrowWindow, openWeatherWindow } from '../src/weather.js';
import { validatePolished } from '../src/llm.js';

for (const mode of ['regular', 'planned']) {
  for (const missing of ['all', 'morning', 'day', 'evening']) {
    test(`${mode}: no favorable verdict with ${missing} rain data missing`, () => {
      const windows = aggregateWindows([], '2026-11-10', 'Europe/Moscow');
      const dry = aggregateSourceSummaries([{ source: 'A', rainProb: 0, rainMm: 0 }]);
      for (const [key, window] of Object.entries(windows)) {
        if (missing !== 'all' && missing !== key) window.aggregate = dry;
      }
      const settings = {
        home: { district: 'А' }, office: { district: 'Б' },
        base: { city: 'А' }, destination: { city: 'Б' }, tripDate: '2026-11-10',
      };
      const text = templateForecast({ id: 1, mode, settings }, settings.tripDate, windows);
      assert.match(text, /Итог: данных о погоде недостаточно/);
      assert.doesNotMatch(text, /благоприятная|можно ехать|ехать можно/);
    });
  }
}

test('temperature-only source is not counted as a dry rain vote', () => {
  assert.equal(aggregateSourceSummaries([{ source: 'A', tempMin: 10, tempMax: 15 }]), null);
  const agg = aggregateSourceSummaries([
    { source: 'A', tempMin: 10, tempMax: 15 },
    { source: 'B', rainProb: 80, rainMm: 5 },
  ]);
  assert.equal(agg.sourceCount, 1);
  assert.equal(agg.rainySourceCount, 1);
});

test('null probability stays unknown rather than becoming zero', () => {
  const summary = openWeatherWindow({ data: { hourly: [{ dt: Date.parse('2026-11-10T08:00:00Z') / 1000, temp: 10 }] } }, '2026-11-10', [8], 'UTC');
  assert.equal(summary.rainProb, null);
  assert.equal(aggregateSourceSummaries([{ source: 'A', ...summary }]), null);
});

function metRow(time) {
  return { time, data: {
    instant: { details: { air_temperature: 10 } },
    next_1_hours: { summary: { symbol_code: 'rain' }, details: { precipitation_amount: 1 } },
  } };
}
function tomorrowRow(time) {
  return { time, values: { temperature: 10, precipitationProbability: 80, rainIntensity: 1 } };
}

for (const [name, parse, fixture] of [
  ['MET Norway', metNorwayWindow, (time) => ({ data: { properties: { timeseries: [metRow(time)] } } })],
  ['Tomorrow.io', tomorrowWindow, (time) => ({ data: { timelines: { hourly: [tomorrowRow(time)] } } })],
]) {
  test(`${name}: converts UTC hour and date into scenario timezone`, () => {
    assert.equal(parse(fixture('2026-11-10T05:00:00Z'), '2026-11-10', [8], 'Europe/Moscow').rainMm, 1);
    assert.equal(parse(fixture('2026-11-09T22:00:00Z'), '2026-11-10', [1], 'Europe/Moscow').rainMm, 1);
    assert.equal(parse(fixture('2026-11-10T05:00:00Z'), '2026-11-10', [5], 'Europe/Moscow'), null);
    const windows = aggregateWindows([{ source: name, ...fixture('2026-11-10T05:00:00Z') }], '2026-11-10', 'Europe/Moscow');
    assert.equal(windows.morning.aggregate.sourceCount, 1);
  });
}

const draft = [
  '🏍️ Сценарий #1: регулярный', '📍 А → Б', '📅 Дата: 2026-11-10',
  '🌦️ По нескольким источникам.', '🌅 утро: +10°C, дождь',
  '☀️ день: данных пока нет', '🌆 вечер: сухо', '✅ Итог: на мото лучше не ехать.',
].join('\n');

test('LLM cannot reverse the verdict, change numbers, hide missing data or rewrite route', () => {
  for (const [before, after] of [
    ['на мото лучше не ехать', 'можно ехать на мото'],
    ['+10°C', '+25°C'], ['данных пока нет', 'сухо'], ['утро: +10°C, дождь', 'утро: +10°C, сухо'],
    ['А → Б', 'А → В'], ['2026-11-10', '2026-11-11'],
  ]) assert.equal(validatePolished(draft.replace(before, after), draft), false);
  assert.equal(validatePolished(draft + '\nЕхать можно.', draft), false);
  assert.equal(validatePolished(draft.replace('По нескольким источникам.', 'Сводка: По нескольким источникам.'), draft), true);
});
