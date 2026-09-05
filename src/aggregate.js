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
      return closeToMedian < 2 || Math.abs(score - medianScore) < 3;
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

export function windowHasRainRisk(window) {
  const agg = window.aggregate;
  if (!agg) return false;
  return Boolean(agg.rainMajority);
}

export function windowHasAnyRain(window) {
  const agg = window.aggregate;
  if (!agg) return false;
  return Boolean(agg.rainySourceCount > 0);
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
  const probability = agg.rainMajority ? 'Вероятность дождя большая.' : 'Вероятность дождя небольшая.';
  return `${agg.rainySourceCount} из ${agg.sourceCount} источников обещают дождь: ${strength}. ${probability}`;
}

export function formatWindow(window) {
  const agg = window.aggregate;
  if (!agg) return `${window.label}: данных пока нет`;
  const outlierNote = agg.excludedOutliers ? ', один выброс отброшен' : '';
  return `${window.label}: ${formatTempRange(agg)}, ${formatRainWords(agg)}${outlierNote}`;
}

export function buildMotoRecommendation(windows) {
  const morningRisk = windowHasRainRisk(windows.morning);
  const dayRisk = windowHasAnyRain(windows.day);
  const eveningRisk = windowHasRainRisk(windows.evening);

  if (morningRisk) {
    return 'Итог: на мото лучше не ехать: дождь уже утром.';
  }
  if (eveningRisk) {
    return 'Итог: на мото лучше не ехать: вечером можно промокнуть на обратном пути.';
  }
  if (dayRisk) {
    return 'Итог: ехать можно, но днём держать мото под крышей.';
  }
  return 'Итог: можно ехать на мото, заметного дождевого риска нет.';
}

export function buildTripRecommendation(windows) {
  const riskyWindows = Object.values(windows).filter(windowHasRainRisk);
  const rainyWindows = Object.values(windows).filter(windowHasAnyRain);
  const severeWindows = Object.values(windows).filter((window) => window.aggregate?.severe);

  if (severeWindows.length >= 2 || riskyWindows.length >= 3) {
    return 'Итог: поездку лучше перенести или ехать не на мото.';
  }
  if (severeWindows.length || riskyWindows.length >= 2) {
    return 'Итог: поездка под вопросом, дождевик обязателен.';
  }
  if (rainyWindows.length) {
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
