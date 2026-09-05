import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  rainLevel,
  aggregateSourceSummaries,
  calculateRiskScore,
  riskLevelLabel,
  buildMotoRecommendation,
  buildTripRecommendation,
} from '../src/aggregate.js';

function makeWindow(summaries) {
  return {
    label: 'test',
    summaries,
    aggregate: aggregateSourceSummaries(summaries),
  };
}

// dryLight: rainProb=0, rainMm=0 → rank 0 (сухо)
// rainy50: rainProb=50, rainMm=0.5 → rank 2 (дождь), riskScore=2.0
// severe:  rainProb=80, rainMm=5 → rank 3 (ливень), riskScore=5.0
const dryLight = (source) => ({ source, tempMin: 10, tempMax: 15, rainProb: 0, rainMm: 0, severe: false });
const rainy50 = (source) => ({ source, tempMin: 10, tempMax: 15, rainProb: 50, rainMm: 0.5, severe: false });
const severeSrc = (source) => ({ source, tempMin: 10, tempMax: 15, rainProb: 80, rainMm: 5, severe: true });

describe('rainLevel', () => {
  it('classifies dry conditions', () => {
    assert.deepEqual(rainLevel(10, 0), { rank: 0, label: 'сухо' });
  });

  it('classifies heavy rain', () => {
    assert.equal(rainLevel(80, 5).rank, 3);
  });

  it('classifies extreme rain', () => {
    assert.equal(rainLevel(90, 10).rank, 4);
  });
});

describe('aggregateSourceSummaries', () => {
  it('returns null for empty input', () => {
    assert.equal(aggregateSourceSummaries([]), null);
  });

  it('aggregates a single source correctly', () => {
    const result = aggregateSourceSummaries([dryLight('Open-Meteo')]);
    assert.equal(result.sourceCount, 1);
    assert.equal(result.rainMajority, false);
    assert.equal(result.rainySourceCount, 0);
  });

  it('detects rain majority when all sources report rain', () => {
    const summaries = [
      rainy50('Open-Meteo'),
      rainy50('MET Norway'),
      rainy50('7Timer'),
    ];
    const result = aggregateSourceSummaries(summaries);
    assert.equal(result.rainMajority, true);
    assert.equal(result.rainySourceCount, 3);
    assert.equal(result.sourceCount, 3);
  });

  it('filters out outlier sources with extreme risk scores', () => {
    const summaries = [
      dryLight('Open-Meteo'),
      dryLight('MET Norway'),
      dryLight('7Timer'),
      severeSrc('OpenWeather'),
    ];
    const result = aggregateSourceSummaries(summaries);
    assert.equal(result.excludedOutliers, 1);
    assert.equal(result.sourceCount, 3);
  });

  it('does not detect conflict when sources agree', () => {
    const summaries = [
      dryLight('Open-Meteo'),
      dryLight('MET Norway'),
      dryLight('7Timer'),
    ];
    const result = aggregateSourceSummaries(summaries);
    assert.equal(result.conflict, false);
  });

  it('detects severe weather when all sources are severe', () => {
    const summaries = [
      severeSrc('Open-Meteo'),
      severeSrc('MET Norway'),
      severeSrc('7Timer'),
    ];
    const result = aggregateSourceSummaries(summaries);
    assert.equal(result.severe, true);
    assert.equal(result.severeVotes, 3);
  });
});

describe('calculateRiskScore', () => {
  it('returns 0 for all-dry window', () => {
    const window = makeWindow([dryLight('A'), dryLight('B'), dryLight('C')]);
    assert.equal(calculateRiskScore(window), 0);
  });

  it('returns 0 for empty window', () => {
    const window = { label: 'test', summaries: [], aggregate: null };
    assert.equal(calculateRiskScore(window), 0);
  });

  it('scores high when all sources report rain', () => {
    const window = makeWindow([
      rainy50('Open-Meteo'),
      rainy50('MET Norway'),
      rainy50('7Timer'),
    ]);
    const score = calculateRiskScore(window);
    assert.ok(score > 40, `score ${score} should be > 40`);
  });

  it('scores very high when all sources report severe rain', () => {
    const window = makeWindow([
      severeSrc('Open-Meteo'),
      severeSrc('MET Norway'),
      severeSrc('7Timer'),
    ]);
    const score = calculateRiskScore(window);
    assert.ok(score > 60, `score ${score} should be high risk (>60)`);
  });
});

describe('riskLevelLabel', () => {
  it('labels a score at the parked threshold as negligible', () => {
    assert.equal(riskLevelLabel(0), 'незначительный');
    assert.equal(riskLevelLabel(20), 'незначительный');
  });

  it('labels a score up to the no-go threshold as low', () => {
    assert.equal(riskLevelLabel(21), 'низкий');
    assert.equal(riskLevelLabel(40), 'низкий');
  });

  it('labels a score above the no-go threshold as moderate', () => {
    assert.equal(riskLevelLabel(41), 'умеренный');
    assert.equal(riskLevelLabel(60), 'умеренный');
  });

  it('labels a score above 60 as high', () => {
    assert.equal(riskLevelLabel(61), 'высокий');
  });
});

describe('buildMotoRecommendation', () => {
  const dry = () => makeWindow([dryLight('A'), dryLight('B'), dryLight('C')]);

  it('recommends riding when all windows are dry', () => {
    const rec = buildMotoRecommendation({ morning: dry(), day: dry(), evening: dry() });
    assert.equal(rec, 'Итог: можно ехать на мото, заметного дождевого риска нет.');
  });

  it('keeps the ride when rain falls only while the bike is parked', () => {
    const windows = {
      morning: dry(),
      day: makeWindow([severeSrc('A'), severeSrc('B'), severeSrc('C')]),
      evening: dry(),
    };
    const rec = buildMotoRecommendation(windows);
    assert.equal(rec, 'Итог: ехать можно, но днём держать мото под крышей.');
    assert.doesNotMatch(rec, /не ехать/);
  });

  it('calls off the ride when every source reports rain in the morning', () => {
    const windows = {
      morning: makeWindow([rainy50('A'), rainy50('B'), rainy50('C')]),
      day: dry(),
      evening: dry(),
    };
    assert.equal(buildMotoRecommendation(windows), 'Итог: на мото лучше не ехать: дождь уже утром.');
  });

  it('calls off the ride when the rain waits for the way back', () => {
    const windows = {
      morning: dry(),
      day: dry(),
      evening: makeWindow([severeSrc('A'), severeSrc('B'), severeSrc('C')]),
    };
    const rec = buildMotoRecommendation(windows);
    assert.equal(rec, 'Итог: на мото лучше не ехать: вечером можно промокнуть на обратном пути.');
  });

  it('never blames the commute wording on a trip', () => {
    const windows = {
      morning: makeWindow([rainy50('A'), rainy50('B'), rainy50('C')]),
      day: makeWindow([severeSrc('A'), severeSrc('B'), severeSrc('C')]),
      evening: dry(),
    };
    assert.doesNotMatch(buildMotoRecommendation(windows), /поездка/);
  });
});

describe('buildTripRecommendation', () => {
  it('recommends rescheduling when severe weather in 2+ windows', () => {
    const windows = {
      morning: makeWindow([severeSrc('A'), severeSrc('B'), severeSrc('C')]),
      day: makeWindow([severeSrc('A'), severeSrc('B'), severeSrc('C')]),
      evening: makeWindow([dryLight('A'), dryLight('B'), dryLight('C')]),
    };
    const rec = buildTripRecommendation(windows);
    assert.match(rec, /перенести|не на мото/);
  });

  it('puts a trip in doubt when every source reports rain in one window', () => {
    const windows = {
      morning: makeWindow([rainy50('A'), rainy50('B'), rainy50('C')]),
      day: makeWindow([dryLight('A'), dryLight('B'), dryLight('C')]),
      evening: makeWindow([dryLight('A'), dryLight('B'), dryLight('C')]),
    };
    const rec = buildTripRecommendation(windows);
    assert.equal(rec, 'Итог: поездка под вопросом, дождевик обязателен.');
  });

  it('treats the day as a riding window on a trip, unlike a commute', () => {
    const windows = {
      morning: makeWindow([dryLight('A'), dryLight('B'), dryLight('C')]),
      day: makeWindow([severeSrc('A'), severeSrc('B'), severeSrc('C')]),
      evening: makeWindow([dryLight('A'), dryLight('B'), dryLight('C')]),
    };
    assert.match(buildTripRecommendation(windows), /под вопросом|перенести/);
  });

  it('recommends favorable weather when all windows are dry', () => {
    const windows = {
      morning: makeWindow([dryLight('A'), dryLight('B'), dryLight('C')]),
      day: makeWindow([dryLight('A'), dryLight('B'), dryLight('C')]),
      evening: makeWindow([dryLight('A'), dryLight('B'), dryLight('C')]),
    };
    const rec = buildTripRecommendation(windows);
    assert.match(rec, /благоприятная/);
  });
});
