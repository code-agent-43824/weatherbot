// Значения по отдельным источникам: их видно, когда источники разошлись между собой
// или когда прогноз дальний и сводке по нему верить рано.

export function formatTempRange(values) {
  if (values.tempMin == null || values.tempMax == null) return 'температура н/д';
  const sign = (value) => (value > 0 ? `+${value}` : String(value));
  return values.tempMin === values.tempMax
    ? `${sign(values.tempMin)}°C`
    : `${sign(values.tempMin)}…${sign(values.tempMax)}°C`;
}

function formatSourceRain(source) {
  const parts = [];
  if (Number.isFinite(source.rainProb)) parts.push(`дождь ${Math.round(source.rainProb)}%`);
  if (Number.isFinite(source.rainMm)) parts.push(`${source.rainMm} мм`);
  return parts.length ? parts.join(', ') : 'осадки н/д';
}

function formatSourceRow(source) {
  return `${source.source}: ${formatTempRange(source)}, ${formatSourceRain(source)}`;
}

function windowNeedsDetails(aggregate, longRange) {
  if (!aggregate || !Array.isArray(aggregate.sources) || aggregate.sources.length < 2) return false;
  return longRange || Boolean(aggregate.conflict);
}

// Блок приклеивается к сообщению уже после LLM-редактуры: он состоит из чисел
// и названий провайдеров, то есть из того, что валидатор редактуры запрещает.
export function buildForecastDetails(windows, options = {}) {
  const longRange = Boolean(options.longRange);
  const rows = [];
  for (const window of Object.values(windows)) {
    if (!windowNeedsDetails(window.aggregate, longRange)) continue;
    rows.push(`${window.label}: ${window.aggregate.sources.map(formatSourceRow).join('; ')}`);
  }
  if (!rows.length) return null;

  const header = longRange
    ? '📊 Прогноз дальний, поэтому источники приведены по отдельности:'
    : '⚠️ Источники заметно расходятся, вывод менее надёжный. Что говорит каждый:';
  return [header, ...rows].join('\n');
}
