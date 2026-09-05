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
  it('labels score 0 as no risk', () => {
    assert.equal(riskLevelLabel(0), 'нет риска');
  });

  it('labels score 30 as low risk', () => {
    assert.equal(riskLevelLabel(30), 'низкий риск');
  });

  it('labels score 50 as moderate risk', () => {
    assert.equal(riskLevelLabel(50), 'умеренный риск');
  });

  it('labels score 80 as high risk', () => {
    assert.equal(riskLevelLabel(80), 'высокий риск');
  });
});

describe('buildMotoRecommendation', () => {
  it('recommends riding when all windows are dry', () => {
    const windows = {
      morning: makeWindow([dryLight('A'), dryLight('B'), dryLight('C')]),
      day: makeWindow([dryLight('A'), dryLight('B'), dryLight('C')]),
      evening: makeWindow([dryLight('A'), dryLight('B'), dryLight('C')]),
    };
    const rec = buildMotoRecommendation(windows);
    assert.match(rec, /можно ехать/);
  });

  it('recommends not riding with severe rain across windows', () => {
    const windows = {
      morning: makeWindow([severeSrc('A'), severeSrc('B'), severeSrc('C')]),
      day: makeWindow([severeSrc('A'), severeSrc('B'), severeSrc('C')]),
      evening: makeWindow([dryLight('A'), dryLight('B'), dryLight('C')]),
    };
    const rec = buildMotoRecommendation(windows);
    assert.match(rec, /не ехать/);
  });

  it('recommends caution with moderate rain', () => {
    const windows = {
      morning: makeWindow([rainy50('A'), rainy50('B'), rainy50('C')]),
      day: makeWindow([dryLight('A'), dryLight('B'), dryLight('C')]),
      evening: makeWindow([dryLight('A'), dryLight('B'), dryLight('C')]),
    };
    const rec = buildMotoRecommendation(windows);
    assert.match(rec, /под вопросом|не ехать|крышей/);
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

  it('recommends rain gear when rain detected in any window', () => {
    const windows = {
      morning: makeWindow([rainy50('A'), rainy50('B'), rainy50('C')]),
      day: makeWindow([dryLight('A'), dryLight('B'), dryLight('C')]),
      evening: makeWindow([dryLight('A'), dryLight('B'), dryLight('C')]),
    };
    const rec = buildTripRecommendation(windows);
    assert.match(rec, /дождевик|под вопросом|перенести/);
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
