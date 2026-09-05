import { formatTempRange } from './forecast-details.js';
import {
  openMeteoWindow,
  metNorwayWindow,
  sevenTimerWindow,
  openWeatherWindow,
  weatherApiWindow,
  tomorrowWindow,
  meteosourceWindow,
} from './weather.js';

export function rainLevel(prob, mm) {
  const rainProb = Number(prob || 0);
  const rainMm = Number(mm || 0);
  if (rainProb < 30 && rainMm <= 0.1) return { rank: 0, label: 'сухо' };
  if (rainProb < 50 && rainMm <= 0.8) return { rank: 1, label: 'лёгкий дождь' };
  if (rainProb < 70 && rainMm <= 2) return { rank: 2, label: 'дождь' };
  if (rainProb < 85 && rainMm <= 6) return { rank: 3, label: 'ливень' };
  return { rank: 4, label: 'ураганный ливень' };
}

export function aggregateSourceSummaries(summaries) {
  if (!summaries.length) return null;
  const bySource = new Map();
  for (const summary of summaries) {
    if (!bySource.has(summary.source)) bySource.set(summary.source, []);
    bySource.get(summary.source).push(summary);
  }

  const sourceSummaries = [...bySource.entries()].map(([source, rows]) => {
    const tempMin = rows.map((s) => s.tempMin).filter(Number.isFinite);
    const tempMax = rows.map((s) => s.tempMax).filter(Number.isFinite);
    const rainProb = rows.map((s) => s.rainProb).filter(Number.isFinite);
    const rainMm = rows.map((s) => s.rainMm).filter(Number.isFinite);
    return {
      source,
      tempMin: tempMin.length ? Math.min(...tempMin) : null,
      tempMax: tempMax.length ? Math.max(...tempMax) : null,
      rainProb: rainProb.length ? Math.max(...rainProb) : null,
      rainMm: rainMm.length ? Math.max(...rainMm) : null,
      severe: rows.some((s) => s.severe),
    };
  });

  const riskScore = (summary) => Math.max(
    Number(summary.rainProb || 0) / 25,
    Number(summary.rainMm || 0),
  );
  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };
  const scores = sourceSummaries.map(riskScore);
  const medianScore = median(scores);
  const filtered = sourceSummaries.length >= 3
    ? sourceSummaries.filter((summary) => {
      const score = riskScore(summary);
      const closeToMedian = sourceSummaries.filter((other) => Math.abs(riskScore(other) - medianScore) <= 1.8).length;
      return closeToMedian < 2 || Math.abs(score - medianScore) < 2;
    })
    : sourceSummaries;
  const kept = filtered.length ? filtered : sourceSummaries;

  const sourceRainLevel = (summary) => rainLevel(summary.rainProb, summary.rainMm);
  const rainySources = kept.filter((summary) => sourceRainLevel(summary).rank > 0);
  const rainLevels = rainySources.map(sourceRainLevel);
  const maxRainRank = rainLevels.length ? Math.max(...rainLevels.map((level) => level.rank)) : 0;
  const minRainRank = rainLevels.length ? Math.min(...rainLevels.map((level) => level.rank)) : 0;
  const levelLabel = (rank) => ['сухо', 'лёгкий дождь', 'дождь', 'ливень', 'ураганный ливень'][rank] || 'дождь';

  const tempMin = kept.map((s) => s.tempMin).filter(Number.isFinite);
  const tempMax = kept.map((s) => s.tempMax).filter(Number.isFinite);
  const rainProb = kept.map((s) => s.rainProb).filter(Number.isFinite);
  const rainMm = kept.map((s) => s.rainMm).filter(Number.isFinite);
  const severeSources = new Set(kept.filter((s) => s.severe).map((s) => s.source));
  const rainProbSpread = rainProb.length > 1 ? Math.max(...rainProb) - Math.min(...rainProb) : 0;
  const rainMmSpread = rainMm.length > 1 ? Math.max(...rainMm) - Math.min(...rainMm) : 0;
  const avg = (values) => Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
  const avgMm = (values) => Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1));
  return {
    tempMin: tempMin.length ? Math.min(...tempMin) : null,
    tempMax: tempMax.length ? Math.max(...tempMax) : null,
    rainProb: rainProb.length ? avg(rainProb) : null,
    rainProbMin: rainProb.length ? Math.min(...rainProb) : null,
    rainProbMax: rainProb.length ? Math.max(...rainProb) : null,
    rainMm: rainMm.length ? avgMm(rainMm) : null,
    rainMmMin: rainMm.length ? Math.min(...rainMm) : null,
    rainMmMax: rainMm.length ? Math.max(...rainMm) : null,
    severe: severeSources.size >= 1 || (rainProb.length && Math.max(...rainProb) >= 70) || (rainMm.length && Math.max(...rainMm) >= 2),
    severeVotes: severeSources.size,
    sources: kept,
    sourceCount: kept.length,
    rainySourceCount: rainySources.length,
    rainMajority: rainySources.length > kept.length / 2,
    rainMinRank: minRainRank,
    rainMaxRank: maxRainRank,
    rainMinLabel: levelLabel(minRainRank),
    rainMaxLabel: levelLabel(maxRainRank),
    originalSourceCount: sourceSummaries.length,
    excludedOutliers: sourceSummaries.length - kept.length,
    conflict: rainProbSpread >= 35 || rainMmSpread >= 2,
    rainProbSpread,
    rainMmSpread,
  };
}

export function aggregateWindows(weather, date, timezone) {
  const windows = {
    morning: { label: 'утро', hours: [7, 8, 9, 10] },
    day: { label: 'день', hours: [12, 13, 14, 15, 16] },
    evening: { label: 'вечер', hours: [17, 18, 19, 20, 21] },
  };
  const sourceResults = {};
  for (const [key, window] of Object.entries(windows)) {
    const summaries = [];
    for (const result of weather) {
      if (result.error) continue;
      let summary = null;
      if (result.source === 'Open-Meteo') summary = openMeteoWindow(result, date, window.hours);
      if (result.source === 'MET Norway') summary = metNorwayWindow(result, date, window.hours);
      if (result.source === '7Timer') summary = sevenTimerWindow(result, date, window.hours, timezone);
      if (result.source === 'OpenWeather') summary = openWeatherWindow(result, date, window.hours, timezone);
      if (result.source === 'WeatherAPI') summary = weatherApiWindow(result, date, window.hours);
      if (result.source === 'Tomorrow.io') summary = tomorrowWindow(result, date, window.hours);
      if (result.source === 'Meteosource') summary = meteosourceWindow(result, date, window.hours);
      if (summary) summaries.push({ source: result.source, ...summary });
    }
    sourceResults[key] = { label: window.label, summaries, aggregate: aggregateSourceSummaries(summaries) };
  }
  return sourceResults;
}

// Порог для окна, в котором едут: выше — ехать не стоит. Воспроизводит прежнее
// правило «дождь у большинства источников», но по баллу, а не по голосованию.
const rideNoGoScore = 40;
// Порог для окна, в котором мотоцикл стоит: выше — держать его под крышей.
const parkedRainScore = 20;

/**
 * Multi-factor rain risk score (0–100).
 *
 * Factor 1 — consensus (0–40): what fraction of sources report rain.
 * Factor 2 — intensity (0–30): the strongest rain level among sources.
 * Factor 3 — probability (0–20): average rain probability across sources.
 * Factor 4 — conflict (0–10): penalty when sources disagree strongly.
 */
function riskScoreForAggregate(agg) {
  if (!agg || !agg.sourceCount) return 0;

  const rainFraction = agg.rainySourceCount / agg.sourceCount;
  const consensusScore = Math.round(rainFraction * 40);

  const maxRank = agg.rainMaxRank || 0;
  const intensityScore = [0, 10, 20, 25, 30][maxRank] || 0;

  const avgProb = agg.rainProb || 0;
  const probScore = Math.round((avgProb / 100) * 20);

  const conflictScore = agg.conflict ? 10 : 0;

  return Math.min(100, consensusScore + intensityScore + probScore + conflictScore);
}

export function calculateRiskScore(window) {
  return riskScoreForAggregate(window?.aggregate);
}

/**
 * Returns risk level label based on risk score.
 */
export function riskLevelLabel(score) {
  if (score <= parkedRainScore) return 'незначительный';
  if (score <= rideNoGoScore) return 'низкий';
  if (score <= 60) return 'умеренный';
  return 'высокий';
}

export function formatRainWords(agg) {
  if (!agg.sourceCount) return 'осадки н/д';
  if (!agg.rainySourceCount) return 'сухо';
  const genitive = {
    'лёгкий дождь': 'лёгкого дождя',
    'дождь': 'дождя',
    'ливень': 'ливня',
    'ураганный ливень': 'ураганного ливня',
  };
  const strength = agg.rainMinLabel === agg.rainMaxLabel
    ? agg.rainMaxLabel
    : `от ${genitive[agg.rainMinLabel] || agg.rainMinLabel} до ${genitive[agg.rainMaxLabel] || agg.rainMaxLabel}`;
  // Риск берём тем же баллом, что и вердикт: иначе строка про окно и «Итог»
  // расходятся — два источника с ливнем из пяти давали «вероятность небольшая»
  // рядом с «на мото лучше не ехать».
  const risk = `Дождевой риск ${riskLevelLabel(riskScoreForAggregate(agg))}.`;
  return `${agg.rainySourceCount} из ${agg.sourceCount} источников обещают дождь: ${strength}. ${risk}`;
}

export function formatWindow(window) {
  const agg = window.aggregate;
  if (!agg) return `${window.label}: данных пока нет`;
  const outlierNote = agg.excludedOutliers ? ', один выброс отброшен' : '';
  return `${window.label}: ${formatTempRange(agg)}, ${formatRainWords(agg)}${outlierNote}`;
}

// Регулярный маршрут асимметричен: утро и вечер человек едет, днём мотоцикл стоит
// у офиса. Дневной дождь поэтому не запрещает поездку, а требует крыши над стоянкой.
export function buildMotoRecommendation(windows) {
  const morningScore = calculateRiskScore(windows.morning);
  const dayScore = calculateRiskScore(windows.day);
  const eveningScore = calculateRiskScore(windows.evening);

  if (morningScore > rideNoGoScore) {
    return 'Итог: на мото лучше не ехать: дождь уже утром.';
  }
  if (eveningScore > rideNoGoScore) {
    return 'Итог: на мото лучше не ехать: вечером можно промокнуть на обратном пути.';
  }
  if (dayScore > parkedRainScore) {
    return 'Итог: ехать можно, но днём держать мото под крышей.';
  }
  return 'Итог: можно ехать на мото, заметного дождевого риска нет.';
}

export function buildTripRecommendation(windows) {
  const scores = Object.values(windows).map(calculateRiskScore);
  const maxScore = Math.max(...scores);
  const highRiskWindows = scores.filter((s) => s > 60).length;
  const moderateRiskWindows = scores.filter((s) => s > 40).length;

  if (highRiskWindows >= 2 || maxScore > 80) {
    return 'Итог: поездку лучше перенести или ехать не на мото.';
  }
  if (moderateRiskWindows >= 2 || maxScore > 60) {
    return 'Итог: поездка под вопросом, дождевик обязателен.';
  }
  if (maxScore > 20) {
    return 'Итог: ехать можно, но взять дождевик.';
  }
  return 'Итог: погода для поездки благоприятная.';
}

export function recommendationForScenario(scenario, windows) {
  return scenario.mode === 'regular'
    ? buildMotoRecommendation(windows)
    : buildTripRecommendation(windows);
}

export function scenarioForecastIntro(scenario, date) {
  if (scenario.mode === 'regular') {
    const route = `${scenario.settings.home.district} -> ${scenario.settings.office.district} -> ${scenario.settings.home.district}`;
    return [
      `🏍️ Сценарий #${scenario.id}: регулярный`,
      `📍 ${route}`,
      `📅 Дата: ${date}`,
    ];
  }

  const route = `${scenario.settings.base.city} -> ${scenario.settings.destination.city}`;
  return [
    `🏍️ Сценарий #${scenario.id}: поездка`,
    `📍 ${route}`,
    `📅 Дата поездки: ${scenario.settings.tripDate}`,
  ];
}

export function templateForecast(scenario, date, windows) {
  return [
    ...scenarioForecastIntro(scenario, date),
    '🌦️ По нескольким источникам.',
    `🌅 ${formatWindow(windows.morning)}`,
    `☀️ ${formatWindow(windows.day)}`,
    `🌆 ${formatWindow(windows.evening)}`,
    `✅ ${recommendationForScenario(scenario, windows)}`,
  ].join('\n');
}
