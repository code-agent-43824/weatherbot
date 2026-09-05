import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  rainLevel,
  aggregateSourceSummaries,
  windowHasRainRisk,
  windowHasAnyRain,
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

// riskScore = max(rainProb/25, rainMm)
// dryLight: riskScore = max(20/25, 0) = 0.8
// rainy50:  riskScore = max(50/25, 0.5) = 2.0
// rainy60:  riskScore = max(60/25, 1) = 2.4
// severe:   riskScore = max(80/25, 5) = 5.0
const dryLight = (source) => ({ source, tempMin: 10, tempMax: 15, rainProb: 20, rainMm: 0, severe: false });
const rainy50 = (source) => ({ source, tempMin: 10, tempMax: 15, rainProb: 50, rainMm: 0.5, severe: false });
const rainy60 = (source) => ({ source, tempMin: 10, tempMax: 15, rainProb: 60, rainMm: 1, severe: false });
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

  it('detects rain majority when more than half of sources report rain', () => {
    const summaries = [
      rainy50('Open-Meteo'),
      rainy50('MET Norway'),
      dryLight('7Timer'),
    ];
    const result = aggregateSourceSummaries(summaries);
    assert.equal(result.rainMajority, true);
    assert.equal(result.rainySourceCount, 2);
    assert.equal(result.sourceCount, 3);
  });

  it('does not detect rain majority when less than half report rain', () => {
    const summaries = [
      rainy50('Open-Meteo'),
      dryLight('MET Norway'),
      dryLight('7Timer'),
      dryLight('OpenWeather'),
      dryLight('WeatherAPI'),
    ];
    const result = aggregateSourceSummaries(summaries);
    assert.equal(result.rainMajority, false);
    assert.equal(result.rainySourceCount, 1);
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

  it('detects conflict when rain probability spread is high', () => {
    const summaries = [
      rainy60('Open-Meteo'),
      dryLight('MET Norway'),
      dryLight('7Timer'),
    ];
    const result = aggregateSourceSummaries(summaries);
    assert.equal(result.conflict, true);
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

  it('detects severe weather when at least one source is severe', () => {
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

describe('windowHasRainRisk', () => {
  it('returns true when rain majority is detected', () => {
    const window = makeWindow([
      rainy50('Open-Meteo'),
      rainy50('MET Norway'),
      dryLight('7Timer'),
    ]);
    assert.equal(windowHasRainRisk(window), true);
  });

  it('returns false when no rain majority', () => {
    const window = makeWindow([
      dryLight('Open-Meteo'),
      dryLight('MET Norway'),
      dryLight('7Timer'),
    ]);
    assert.equal(windowHasRainRisk(window), false);
  });

  it('returns false when aggregate is null', () => {
    const window = { label: 'test', summaries: [], aggregate: null };
    assert.equal(windowHasRainRisk(window), false);
  });
});

describe('windowHasAnyRain', () => {
  it('returns true when at least one source reports rain', () => {
    const window = makeWindow([
      rainy50('Open-Meteo'),
      dryLight('MET Norway'),
      dryLight('7Timer'),
    ]);
    assert.equal(windowHasAnyRain(window), true);
  });

  it('returns false when no sources report rain', () => {
    const window = makeWindow([
      dryLight('Open-Meteo'),
      dryLight('MET Norway'),
      dryLight('7Timer'),
    ]);
    assert.equal(windowHasAnyRain(window), false);
  });
});

describe('buildMotoRecommendation', () => {
  it('recommends not riding when morning has rain risk', () => {
    const windows = {
      morning: makeWindow([rainy50('A'), rainy50('B'), dryLight('C')]),
      day: makeWindow([dryLight('A'), dryLight('B'), dryLight('C')]),
      evening: makeWindow([dryLight('A'), dryLight('B'), dryLight('C')]),
    };
    const rec = buildMotoRecommendation(windows);
    assert.match(rec, /не ехать/);
  });

  it('recommends not riding when evening has rain risk', () => {
    const windows = {
      morning: makeWindow([dryLight('A'), dryLight('B'), dryLight('C')]),
      day: makeWindow([dryLight('A'), dryLight('B'), dryLight('C')]),
      evening: makeWindow([rainy50('A'), rainy50('B'), dryLight('C')]),
    };
    const rec = buildMotoRecommendation(windows);
    assert.match(rec, /не ехать/);
  });

  it('recommends riding when no rain risk in any window', () => {
    const windows = {
      morning: makeWindow([dryLight('A'), dryLight('B'), dryLight('C')]),
      day: makeWindow([dryLight('A'), dryLight('B'), dryLight('C')]),
      evening: makeWindow([dryLight('A'), dryLight('B'), dryLight('C')]),
    };
    const rec = buildMotoRecommendation(windows);
    assert.match(rec, /можно ехать/);
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
      morning: makeWindow([rainy50('A'), dryLight('B'), dryLight('C')]),
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
