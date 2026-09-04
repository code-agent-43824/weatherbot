import assert from 'node:assert/strict';
import test from 'node:test';

import { buildForecastDetails, formatTempRange } from '../src/forecast-details.js';

function window(label, sources, conflict = false) {
  return { label, summaries: [], aggregate: sources ? { conflict, sources } : null };
}

const twoSources = [
  { source: 'Open-Meteo', tempMin: 12, tempMax: 18, rainProb: 20, rainMm: 0 },
  { source: 'WeatherAPI', tempMin: 11, tempMax: 17, rainProb: 80, rainMm: 3.4 },
];

test('says nothing while the sources agree', () => {
  const windows = {
    morning: window('утро', twoSources),
    day: window('день', twoSources),
    evening: window('вечер', twoSources),
  };

  assert.equal(buildForecastDetails(windows), null);
});

test('warns and lists every source for the window that disagrees', () => {
  const windows = {
    morning: window('утро', twoSources, true),
    day: window('день', twoSources),
    evening: window('вечер', null),
  };

  const details = buildForecastDetails(windows);

  assert.match(details, /расходятся/);
  assert.equal(details.split('\n').length, 2);
  assert.match(details, /утро: Open-Meteo: \+12…\+18°C, дождь 20%, 0 мм; WeatherAPI: \+11…\+17°C, дождь 80%, 3.4 мм/);
  assert.doesNotMatch(details, /день/);
});

test('drops the warning but keeps the sources for a long-range trip', () => {
  const windows = {
    morning: window('утро', twoSources),
    day: window('день', twoSources),
    evening: window('вечер', twoSources),
  };

  const details = buildForecastDetails(windows, { longRange: true });

  assert.doesNotMatch(details, /расходятся/);
  assert.match(details, /Прогноз дальний/);
  assert.equal(details.split('\n').length, 4);
});

test('skips a window that has a single source left', () => {
  const windows = {
    morning: window('утро', [twoSources[0]], true),
    day: window('день', twoSources, true),
  };

  const details = buildForecastDetails(windows, { longRange: true });

  assert.doesNotMatch(details, /утро/);
  assert.match(details, /день/);
});

test('falls back where a source reports no numbers', () => {
  const windows = {
    morning: window('утро', [
      { source: '7Timer', tempMin: null, tempMax: null, rainProb: null, rainMm: null },
      { source: 'MET Norway', tempMin: -3, tempMax: -3, rainProb: 55, rainMm: 0.2 },
    ], true),
  };

  const details = buildForecastDetails(windows);

  assert.match(details, /7Timer: температура н\/д, осадки н\/д/);
  assert.match(details, /MET Norway: -3°C, дождь 55%, 0.2 мм/);
});

test('formats a temperature range', () => {
  assert.equal(formatTempRange({ tempMin: 0, tempMax: 5 }), '0…+5°C');
  assert.equal(formatTempRange({ tempMin: 7, tempMax: 7 }), '+7°C');
  assert.equal(formatTempRange({ tempMin: null, tempMax: 5 }), 'температура н/д');
});
