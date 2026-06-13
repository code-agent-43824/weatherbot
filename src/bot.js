import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const token = process.env.BOT_TOKEN;
const pollTimeoutSeconds = Number(process.env.POLL_TIMEOUT_SECONDS || 30);
const dataFile = process.env.DATA_FILE || './data/weatherbot.json';
const userAgent = process.env.USER_AGENT || 'WeatherBot/0.2 (https://github.com/code-agent-43824/weatherbot)';
const openRouterApiKey = process.env.OPENROUTER_API_KEY || '';
const openRouterModel = process.env.OPENROUTER_MODEL || 'openai/gpt-oss-120b:free';
const dadataApiKey = process.env.DADATA_API_KEY || '';
const dadataSecretKey = process.env.DADATA_SECRET_KEY || '';
const openWeatherApiKey = process.env.OPENWEATHER_API_KEY || '';
const weatherApiKey = process.env.WEATHERAPI_KEY || '';
const tomorrowApiKey = process.env.TOMORROW_API_KEY || '';
const meteosourceApiKey = process.env.METEOSOURCE_API_KEY || '';
const weatherCacheTtlMs = Math.min(
  Math.max(Number(process.env.WEATHER_CACHE_TTL_MS || 300_000), 0),
  300_000,
);

if (!token) {
  console.error('BOT_TOKEN is required');
  process.exit(1);
}

const apiBase = `https://api.telegram.org/bot${token}`;
let offset = 0;
let store = {
  users: {},
  forecastLogs: [],
  addressLogs: [],
};
let lastNominatimCall = 0;
const weatherCache = new Map();

async function loadStore() {
  try {
    store = JSON.parse(await readFile(dataFile, 'utf8'));
    for (const user of Object.values(store.users || {})) migrateUserState(user);
    await saveStore();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await saveStore();
  }
}

async function saveStore() {
  await mkdir(dirname(dataFile), { recursive: true });
  await writeFile(dataFile, JSON.stringify(store, null, 2));
}

function userState(tgId) {
  const key = String(tgId);
  store.users[key] ||= {
    tgId: key,
    setup: null,
    scenarios: [],
    nextScenarioId: 1,
    createdAt: new Date().toISOString(),
  };
  migrateUserState(store.users[key]);
  return store.users[key];
}

function migrateUserState(user) {
  if (!Array.isArray(user.scenarios)) user.scenarios = [];
  if (!Number.isInteger(user.nextScenarioId) || user.nextScenarioId < 1) {
    user.nextScenarioId = user.scenarios.reduce((max, scenario) => Math.max(max, Number(scenario.id) || 0), 0) + 1;
  }
  if (user.setup && !user.setup.settings) {
    user.setup = {
      mode: user.mode || 'regular',
      step: user.setup.step,
      settings: user.settings || {},
    };
  }
  if (user.mode && user.settings && !user.scenarios.length) {
    user.scenarios.push({
      id: user.nextScenarioId,
      mode: user.mode,
      settings: user.settings,
      stopped: Boolean(user.stopped),
      lastSentDate: user.lastSentDate || null,
      createdAt: user.createdAt || new Date().toISOString(),
    });
    user.nextScenarioId += 1;
  }
  delete user.mode;
  delete user.settings;
  delete user.stopped;
  delete user.lastSentDate;
}

function startScenarioSetup(user, mode) {
  user.setup = {
    mode,
    step: mode === 'regular' ? 'home' : 'base',
    settings: {},
  };
}

function finishScenarioSetup(user) {
  const scenario = {
    id: user.nextScenarioId,
    mode: user.setup.mode,
    settings: user.setup.settings,
    stopped: false,
    lastSentDate: null,
    createdAt: new Date().toISOString(),
  };
  user.nextScenarioId += 1;
  user.scenarios.push(scenario);
  user.setup = null;
  return scenario;
}

function activeScenarios(user) {
  return user.scenarios.filter((scenario) => !scenario.stopped);
}

function scenarioById(user, rawId) {
  const id = Number(rawId);
  if (!Number.isInteger(id)) return null;
  return user.scenarios.find((scenario) => scenario.id === id) || null;
}

function scenarioRouteLabel(scenario) {
  if (scenario.mode === 'regular') {
    return `${scenario.settings.home.district} -> ${scenario.settings.office.district}`;
  }
  return `${scenario.settings.base.city} -> ${scenario.settings.destination.city}, ${scenario.settings.tripDate}`;
}

function formatScenarioList(user) {
  if (!user.scenarios.length) return 'Сценариев пока нет. Нажмите Регулярный или Поездка.';
  return [
    'Сценарии:',
    ...user.scenarios.map((scenario) => {
      const mode = scenario.mode === 'regular' ? 'регулярный' : 'плановый';
      const status = scenario.stopped ? 'остановлен' : `активен, ${scenario.settings.time}`;
      return `${scenario.id}. ${mode}: ${scenarioRouteLabel(scenario)} — ${status}`;
    }),
  ].join('\n');
}

function scenarioDateIsExpired(scenario, now = new Date()) {
  if (scenario.mode !== 'planned' || !scenario.settings?.tripDate) return false;
  const timezone = scenario.settings.timezone || 'Europe/Moscow';
  return scenario.settings.tripDate < isoDateInTimezone(now, timezone);
}

async function cleanupExpiredScenarios(user, notify = false) {
  const expired = user.scenarios.filter((scenario) => scenarioDateIsExpired(scenario));
  if (!expired.length) return [];

  const expiredIds = new Set(expired.map((scenario) => scenario.id));
  user.scenarios = user.scenarios.filter((scenario) => !expiredIds.has(scenario.id));
  await saveStore();

  if (notify) {
    for (const scenario of expired) {
      try {
        await sendMessage(
          user.tgId,
          `Плановая поездка ${scenario.id} на ${scenario.settings.tripDate} уже прошла, я удалил этот сценарий. Для новой поездки нажмите Поездка.`,
        );
      } catch (error) {
        console.error('expired notification failed:', user.tgId, scenario.id, error);
      }
    }
  }
  return expired;
}

async function callTelegram(method, payload) {
  const response = await fetch(`${apiBase}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!data.ok) throw new Error(`${method} failed: ${data.description || response.statusText}`);
  return data.result;
}

function mainKeyboard() {
  return {
    keyboard: [
      [{ text: 'Прогноз' }, { text: 'Сценарии' }],
      [{ text: 'Регулярный' }, { text: 'Поездка' }],
      [{ text: 'Сброс' }, { text: 'Помощь' }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

async function sendMessage(chatId, text, options = {}) {
  await callTelegram('sendMessage', {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    reply_markup: options.reply_markup || mainKeyboard(),
  });
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'user-agent': userAgent,
      accept: 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

async function fetchCachedWeatherJson(url, options = {}) {
  if (weatherCacheTtlMs <= 0) return fetchJson(url, options);

  const now = Date.now();
  const cached = weatherCache.get(url);
  if (cached && now - cached.createdAt <= weatherCacheTtlMs) return cached.data;

  const data = await fetchJson(url, options);
  weatherCache.set(url, { createdAt: now, data });
  return data;
}

function buildNominatimQueries(query) {
  const trimmed = query.trim().replace(/\s+/g, ' ');
  const normalized = trimmed
    .replace(/(^|\s)(город|г[.]?)(?=\s)/giu, ' ')
    .replace(/(^|\s)(улица|ул[.]?)(?=\s)/giu, ' ')
    .replace(/(^|\s)(дом|д[.]?)(?=\s)/giu, ' ')
    .replace(/(^|\s)(корпус|корп[.]?)(?=\s)/giu, ' к ')
    .replace(/\s+/g, ' ')
    .trim();
  const cityMatch = trimmed.match(/\b(?:город\s+|г[.]?\s*)?([А-ЯЁ][а-яё-]+)\b/u);
  const streetMatch = trimmed.match(/(?:улица|ул[.]?)\s+([А-ЯЁA-Z0-9][\p{L}0-9 .-]*)/iu)
    || trimmed.match(/([А-ЯЁA-Z0-9][\p{L}0-9 .-]+?)\s+(?:улица|ул[.]?)/iu);
  const city = trimmed.toLowerCase().includes('москва') ? 'Москва' : cityMatch?.[1];
  const street = streetMatch?.[1]
    ?.replace(/\s+(?:дом|д[.]?|корпус|корп[.]?)\s+.*$/iu, '')
    .trim();

  return [...new Set([
    trimmed,
    normalized,
    city && street ? `${street} улица, ${city}` : null,
    city && street ? `${city}, ${street} улица` : null,
  ].filter(Boolean))];
}

async function fetchNominatim(query) {
  const waitMs = 1100 - (Date.now() - lastNominatimCall);
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  lastNominatimCall = Date.now();

  const params = new URLSearchParams({
    format: 'jsonv2',
    q: query,
    countrycodes: 'ru',
    addressdetails: '1',
    limit: '1',
  });
  return fetchJson(`https://nominatim.openstreetmap.org/search?${params}`);
}

function dadataAddressToPoint(input, suggestion, provider) {
  const data = suggestion?.data || suggestion;
  if (!data) return null;
  const lat = Number(data.geo_lat);
  const lon = Number(data.geo_lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const district = data.city_district_with_type
    || data.settlement_with_type
    || data.area_with_type
    || data.city_with_type
    || data.region_with_type
    || 'район не определён';
  const city = data.city_with_type || data.settlement_with_type || data.region_with_type || 'город не определён';
  const exactHouse = Boolean(data.house) && (data.qc_geo == null || Number(data.qc_geo) <= 1);
  return {
    input,
    label: suggestion.value || suggestion.result || input,
    lat,
    lon,
    district,
    city,
    exactHouse,
    matchedQuery: input,
    provider,
    raw: suggestion,
  };
}

async function fetchDaData(url, payload, useSecret = false) {
  const headers = {
    authorization: `Token ${dadataApiKey}`,
    'content-type': 'application/json',
    accept: 'application/json',
  };
  if (useSecret) headers['x-secret'] = dadataSecretKey;
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`DaData returned ${response.status}`);
  return response.json();
}

async function geocodeDaData(query) {
  if (!dadataApiKey) return null;

  const suggested = await fetchDaData('https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/address', {
    query,
    count: 5,
    locations: [{ country_iso_code: 'RU' }],
  });
  for (const suggestion of suggested.suggestions || []) {
    const point = dadataAddressToPoint(query, suggestion, 'DaData Suggest');
    if (point) return point;
  }

  if (!dadataSecretKey) return null;
  const cleaned = await fetchDaData('https://cleaner.dadata.ru/api/v1/clean/address', [query], true);
  return dadataAddressToPoint(query, cleaned?.[0], 'DaData Clean');
}

async function geocodeRussia(query) {
  try {
    const dadataResult = await geocodeDaData(query);
    if (dadataResult) return dadataResult;
  } catch (error) {
    console.error('DaData failed:', error.message);
  }

  let item = null;
  let matchedQuery = query;
  for (const candidate of buildNominatimQueries(query)) {
    const results = await fetchNominatim(candidate);
    if (results[0]) {
      item = results[0];
      matchedQuery = candidate;
      break;
    }
  }
  if (!item) return null;

  const address = item.address || {};
  const exactHouse = Boolean(address.house_number);
  const district = address.city_district || address.suburb || address.borough || address.county || address.city || address.town || address.village || 'район не определён';
  return {
    input: query,
    label: item.display_name,
    lat: Number(item.lat),
    lon: Number(item.lon),
    district,
    city: address.city || address.town || address.village || address.municipality || address.state || 'город не определён',
    exactHouse,
    matchedQuery,
    provider: 'Nominatim',
    raw: item,
  };
}

function routePoints(from, to) {
  return [
    from,
    {
      label: 'промежуточная точка маршрута',
      lat: (from.lat + to.lat) / 2,
      lon: (from.lon + to.lon) / 2,
      district: `${from.district} / ${to.district}`,
      city: from.city,
    },
    to,
  ];
}

function isoDateInTimezone(date, timezone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function hhmmInTimezone(date, timezone) {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function dayOffsetDate(offsetDays, timezone) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return isoDateInTimezone(date, timezone);
}

function daysUntil(date, timezone) {
  const today = new Date(`${isoDateInTimezone(new Date(), timezone)}T00:00:00Z`);
  const target = new Date(`${date}T00:00:00Z`);
  return Math.round((target - today) / 86_400_000);
}

function parseTime(text) {
  const match = text.trim().match(/^([01]?\d|2[0-3])[:.]([0-5]\d)$/);
  if (!match) return null;
  return `${match[1].padStart(2, '0')}:${match[2]}`;
}

function parseDate(text) {
  const trimmed = text.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const match = trimmed.match(/^(\d{1,2})[.](\d{1,2})[.](\d{4})$/);
  if (!match) return null;
  return `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
}

async function openMeteo(point) {
  const params = new URLSearchParams({
    latitude: String(point.lat),
    longitude: String(point.lon),
    hourly: 'temperature_2m,precipitation_probability,rain,showers,weather_code',
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max,rain_sum,showers_sum,weather_code',
    forecast_days: '9',
    timezone: 'auto',
  });
  const data = await fetchCachedWeatherJson(`https://api.open-meteo.com/v1/forecast?${params}`);
  return { source: 'Open-Meteo', timezone: data.timezone || 'UTC', point, data };
}

async function metNorway(point) {
  const params = new URLSearchParams({
    lat: String(point.lat.toFixed(4)),
    lon: String(point.lon.toFixed(4)),
  });
  const data = await fetchCachedWeatherJson(`https://api.met.no/weatherapi/locationforecast/2.0/compact?${params}`);
  return { source: 'MET Norway', point, data };
}

async function sevenTimer(point) {
  const params = new URLSearchParams({
    lon: String(point.lon.toFixed(4)),
    lat: String(point.lat.toFixed(4)),
    product: 'civil',
    output: 'json',
  });
  const data = await fetchCachedWeatherJson(`https://www.7timer.info/bin/api.pl?${params}`);
  return { source: '7Timer', point, data };
}

async function openWeather(point) {
  if (!openWeatherApiKey) return null;
  const params = new URLSearchParams({
    lat: String(point.lat),
    lon: String(point.lon),
    exclude: 'current,minutely',
    units: 'metric',
    lang: 'ru',
    appid: openWeatherApiKey,
  });
  const data = await fetchCachedWeatherJson(`https://api.openweathermap.org/data/3.0/onecall?${params}`);
  return { source: 'OpenWeather', point, data };
}

async function weatherApi(point) {
  if (!weatherApiKey) return null;
  const params = new URLSearchParams({
    key: weatherApiKey,
    q: `${point.lat},${point.lon}`,
    days: '10',
    aqi: 'no',
    alerts: 'yes',
    lang: 'ru',
  });
  const data = await fetchCachedWeatherJson(`https://api.weatherapi.com/v1/forecast.json?${params}`);
  return { source: 'WeatherAPI', point, data };
}

async function tomorrow(point) {
  if (!tomorrowApiKey) return null;
  const params = new URLSearchParams({
    location: `${point.lat},${point.lon}`,
    timesteps: '1h',
    units: 'metric',
    apikey: tomorrowApiKey,
  });
  const data = await fetchCachedWeatherJson(`https://api.tomorrow.io/v4/weather/forecast?${params}`);
  return { source: 'Tomorrow.io', point, data };
}

async function meteosource(point) {
  if (!meteosourceApiKey) return null;
  const params = new URLSearchParams({
    lat: String(point.lat),
    lon: String(point.lon),
    sections: 'hourly',
    timezone: 'auto',
    language: 'en',
    units: 'metric',
    key: meteosourceApiKey,
  });
  const data = await fetchCachedWeatherJson(`https://www.meteosource.com/api/v1/free/point?${params}`);
  return { source: 'Meteosource', point, data };
}

async function collectWeather(points) {
  const results = [];
  for (const point of points) {
    const calls = [
      openMeteo(point),
      metNorway(point),
      sevenTimer(point),
      openWeather(point),
      weatherApi(point),
      tomorrow(point),
      meteosource(point),
    ].filter(Boolean);
    const settled = await Promise.allSettled(calls);
    for (const item of settled) {
      if (item.status === 'fulfilled' && item.value) results.push(item.value);
      else if (item.status === 'rejected') results.push({ source: 'error', point, error: item.reason.message });
    }
  }
  return results;
}

function openMeteoWindow(result, date, hours) {
  const hourly = result.data.hourly || {};
  const values = [];
  for (let i = 0; i < (hourly.time || []).length; i += 1) {
    const time = hourly.time[i];
    const hour = Number(time.slice(11, 13));
    if (!time.startsWith(date) || !hours.includes(hour)) continue;
    values.push({
      temp: hourly.temperature_2m?.[i],
      rainProb: hourly.precipitation_probability?.[i],
      rainMm: Number(hourly.rain?.[i] || 0) + Number(hourly.showers?.[i] || 0),
      code: hourly.weather_code?.[i],
    });
  }
  return summarizeValues(values);
}

function metNorwayWindow(result, date, hours) {
  const values = [];
  for (const row of result.data.properties?.timeseries || []) {
    if (!row.time.startsWith(date)) continue;
    const hour = Number(row.time.slice(11, 13));
    if (!hours.includes(hour)) continue;
    const instant = row.data?.instant?.details || {};
    const nextHour = row.data?.next_1_hours || row.data?.next_6_hours || {};
    const symbol = nextHour.summary?.symbol_code || '';
    values.push({
      temp: instant.air_temperature,
      rainProb: symbol.includes('rain') || symbol.includes('thunder') ? 55 : 15,
      rainMm: nextHour.details?.precipitation_amount || 0,
      code: symbol,
    });
  }
  return summarizeValues(values);
}

function sevenTimerWindow(result, date, hours, timezone) {
  const init = result.data.init;
  if (!init) return null;
  const start = new Date(`${init.slice(0, 4)}-${init.slice(4, 6)}-${init.slice(6, 8)}T${init.slice(8, 10)}:00:00Z`);
  const values = [];
  for (const row of result.data.dataseries || []) {
    const time = new Date(start.getTime() + row.timepoint * 60 * 60 * 1000);
    const localDate = isoDateInTimezone(time, timezone);
    const hour = Number(hhmmInTimezone(time, timezone).slice(0, 2));
    if (localDate !== date || !hours.includes(hour)) continue;
    const weather = String(row.weather || '');
    values.push({
      temp: row.temp2m,
      rainProb: weather.includes('rain') || weather.includes('shower') ? 50 : 15,
      rainMm: weather.includes('rain') ? 2 : 0,
      code: weather,
    });
  }
  return summarizeValues(values);
}

function openWeatherWindow(result, date, hours, timezone) {
  const values = [];
  for (const row of result.data.hourly || []) {
    const time = new Date(row.dt * 1000);
    const localDate = isoDateInTimezone(time, timezone);
    const hour = Number(hhmmInTimezone(time, timezone).slice(0, 2));
    if (localDate !== date || !hours.includes(hour)) continue;
    const rainMm = Number(row.rain?.['1h'] || 0);
    const weatherCodes = (row.weather || []).map((item) => Number(item.id)).filter(Number.isFinite);
    values.push({
      temp: row.temp,
      rainProb: row.pop == null ? null : Math.round(Number(row.pop) * 100),
      rainMm,
      code: weatherCodes.join(','),
    });
  }
  return summarizeValues(values);
}

function weatherApiWindow(result, date, hours) {
  const values = [];
  for (const day of result.data.forecast?.forecastday || []) {
    if (day.date !== date) continue;
    for (const row of day.hour || []) {
      const hour = Number(String(row.time || '').slice(11, 13));
      if (!hours.includes(hour)) continue;
      values.push({
        temp: row.temp_c,
        rainProb: row.chance_of_rain,
        rainMm: row.precip_mm,
        code: row.condition?.text || row.condition?.code,
      });
    }
  }
  return summarizeValues(values);
}

function tomorrowWindow(result, date, hours) {
  const values = [];
  const hourly = result.data.timelines?.hourly || [];
  for (const row of hourly) {
    const time = String(row.time || '');
    const hour = Number(time.slice(11, 13));
    if (!time.startsWith(date) || !hours.includes(hour)) continue;
    const data = row.values || {};
    const rainMm = Math.max(
      Number(data.rainIntensity || 0),
      Number(data.precipitationIntensity || 0),
    );
    values.push({
      temp: data.temperature,
      rainProb: data.precipitationProbability,
      rainMm,
      code: data.weatherCode,
    });
  }
  return summarizeValues(values);
}

function meteosourceWindow(result, date, hours) {
  const values = [];
  for (const row of result.data.hourly?.data || []) {
    const time = String(row.date || '');
    const hour = Number(time.slice(11, 13));
    if (!time.startsWith(date) || !hours.includes(hour)) continue;
    const precipitation = row.precipitation || {};
    const probability = row.probability || {};
    const weather = String(row.weather || '');
    const rainMm = Number(precipitation.total || 0);
    const rainProb = probability.precipitation == null
      ? (weather.includes('rain') || rainMm > 0 ? 50 : 15)
      : probability.precipitation;
    values.push({
      temp: row.temperature,
      rainProb,
      rainMm,
      code: weather || row.icon,
    });
  }
  return summarizeValues(values);
}

function summarizeValues(values) {
  if (!values.length) return null;
  const temps = values.map((v) => Number(v.temp)).filter(Number.isFinite);
  const probs = values.map((v) => Number(v.rainProb)).filter(Number.isFinite);
  const rain = values.map((v) => Number(v.rainMm)).filter(Number.isFinite);
  return {
    tempMin: temps.length ? Math.round(Math.min(...temps)) : null,
    tempMax: temps.length ? Math.round(Math.max(...temps)) : null,
    rainProb: probs.length ? Math.round(Math.max(...probs)) : null,
    rainMm: rain.length ? Number(Math.max(...rain).toFixed(1)) : null,
    severe: (probs.length && Math.max(...probs) >= 70) || (rain.length && Math.max(...rain) >= 2),
  };
}

function aggregateWindows(weather, date, timezone) {
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

function aggregateSourceSummaries(summaries) {
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

function windowHasRainRisk(window) {
  const agg = window.aggregate;
  if (!agg) return false;
  return Boolean(agg.rainMajority);
}

function windowHasAnyRain(window) {
  const agg = window.aggregate;
  if (!agg) return false;
  return Boolean(agg.rainySourceCount > 0);
}

function rainLevel(prob, mm) {
  const rainProb = Number(prob || 0);
  const rainMm = Number(mm || 0);
  if (rainProb < 30 && rainMm <= 0.1) return { rank: 0, label: 'сухо' };
  if (rainProb < 50 && rainMm <= 0.8) return { rank: 1, label: 'лёгкий дождь' };
  if (rainProb < 70 && rainMm <= 2) return { rank: 2, label: 'дождь' };
  if (rainProb < 85 && rainMm <= 6) return { rank: 3, label: 'ливень' };
  return { rank: 4, label: 'ураганный ливень' };
}

function formatTempRange(agg) {
  if (agg.tempMin == null || agg.tempMax == null) return 'температура н/д';
  const sign = (value) => (value > 0 ? `+${value}` : String(value));
  return agg.tempMin === agg.tempMax
    ? `${sign(agg.tempMin)}°C`
    : `${sign(agg.tempMin)}…${sign(agg.tempMax)}°C`;
}

function formatRainWords(agg) {
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

function formatWindow(window) {
  const agg = window.aggregate;
  if (!agg) return `${window.label}: данных пока нет`;
  const outlierNote = agg.excludedOutliers ? ', один выброс отброшен' : '';
  return `${window.label}: ${formatTempRange(agg)}, ${formatRainWords(agg)}${outlierNote}`;
}

function buildMotoRecommendation(windows) {
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

function buildTripRecommendation(windows) {
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

function recommendationForScenario(scenario, windows) {
  return scenario.mode === 'regular'
    ? buildMotoRecommendation(windows)
    : buildTripRecommendation(windows);
}

function scenarioForecastIntro(scenario, date) {
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

function templateForecast(scenario, date, windows) {
  return [
    ...scenarioForecastIntro(scenario, date),
    '🌦️ По нескольким источникам.',
    `🌅 ${formatWindow(windows.morning)}`,
    `☀️ ${formatWindow(windows.day)}`,
    `🌆 ${formatWindow(windows.evening)}`,
    `✅ ${recommendationForScenario(scenario, windows)}`,
  ].join('\n');
}

async function polishForecastWithLlm(draft) {
  if (!openRouterApiKey) return draft;
  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${openRouterApiKey}`,
        'content-type': 'application/json',
        'http-referer': 'https://github.com/code-agent-43824/weatherbot',
        'x-title': 'WeatherBot',
      },
      body: JSON.stringify({
        model: openRouterModel,
        messages: [
          {
            role: 'system',
            content: [
              'Ты редактор короткого Telegram-прогноза для мотоциклиста.',
              'Используй только готовый черновик; не добавляй погодные факты, числа, проценты, миллиметры или названия провайдеров.',
              'Обязательно сохрани смысл каждой строки по окнам дня.',
              'Если строка содержит "X из Y источников", сохрани X, Y, силу дождя и фразу про большую/небольшую вероятность.',
              'Если строка содержит "сухо", не превращай её в дождь.',
              'Обязательно оставь фразу "По нескольким источникам.".',
              'Сохрани короткую преамбулу со сценарием, маршрутом и датой.',
              'Сохрани эмодзи в начале строк.',
              'Не рассуждай про машины и транспорт.',
              'Формат: 7-8 коротких строк, последняя строка содержит "Итог:".',
            ].join(' '),
          },
          { role: 'user', content: draft },
        ],
        temperature: 0.1,
        max_tokens: 350,
      }),
    });
    const data = await response.json();
    const text = String(data.choices?.[0]?.message?.content || '').trim();
    const banned = /(мм|%|Open-Meteo|MET Norway|7Timer|WeatherAPI|Tomorrow|Meteosource|DaData|машин|транспорт)/i;
    if (!text || banned.test(text) || !text.includes('По нескольким источникам') || !text.includes('Итог:') || !/[🏍️📍📅🌦️🌅☀️🌆✅]/u.test(text)) {
      return draft;
    }
    return text;
  } catch (error) {
    console.error('OpenRouter failed:', error.message);
    return draft;
  }
}

async function buildForecast(user, scenario, targetDate = null) {
  const regular = scenario.mode === 'regular';
  const from = regular ? scenario.settings.home : scenario.settings.base;
  const to = regular ? scenario.settings.office : scenario.settings.destination;
  const points = routePoints(from, to);
  const weather = await collectWeather(points);
  const timezone = weather.find((item) => item.source === 'Open-Meteo')?.timezone || scenario.settings.timezone || 'UTC';
  scenario.settings.timezone = timezone;
  const date = targetDate || dayOffsetDate(0, timezone);
  const windows = aggregateWindows(weather, date, timezone);
  const draftText = templateForecast(scenario, date, windows);
  const finalText = await polishForecastWithLlm(draftText);

  store.forecastLogs.push({
    tgId: user.tgId,
    scenarioId: scenario.id,
    mode: scenario.mode,
    date,
    routeDistricts: regular
      ? { from: scenario.settings.home.district, to: scenario.settings.office.district }
      : { from: scenario.settings.base.district, to: scenario.settings.destination.district },
    createdAt: new Date().toISOString(),
    windows,
    message: finalText,
  });
  await saveStore();
  return finalText;
}

async function handleCommand(chatId, user, text) {
  const buttonCommands = {
    'Прогноз': '/forecast',
    'Сценарии': '/scenarios',
    'Регулярный': '/regular',
    'Поездка': '/planned',
    'Сброс': '/reset',
    'Помощь': '/help',
  };
  text = buttonCommands[text] || text;
  const [command, arg] = text.split(/\s+/, 2);
  if (text === '/start' || text === '/help') {
    await sendMessage(chatId, [
      'Команды:',
      'Регулярный — добавить прогноз дом/офис/дом',
      'Поездка — добавить плановую поездку',
      'Сценарии — список сценариев',
      'Прогноз — прислать прогноз по активным сценариям',
      'Сброс — удалить все сценарии',
      '',
      'Также работают slash-команды:',
      '/regular, /planned, /scenarios, /forecast, /reset',
      '/forecast 2 — прогноз по сценарию 2',
      '/stop — остановить отправки по всем сценариям',
      '/stop 2 — остановить сценарий 2',
    ].join('\n'));
    return true;
  }
  if (text === '/regular') {
    startScenarioSetup(user, 'regular');
    await saveStore();
    await sendMessage(chatId, 'Введите домашний адрес в России.');
    return true;
  }
  if (text === '/planned') {
    startScenarioSetup(user, 'planned');
    await saveStore();
    await sendMessage(chatId, 'Введите базовый город или адрес отправления в России.');
    return true;
  }
  if (text === '/scenarios') {
    await sendMessage(chatId, formatScenarioList(user));
    return true;
  }
  if (command === '/stop') {
    if (arg) {
      const scenario = scenarioById(user, arg);
      if (!scenario) {
        await sendMessage(chatId, 'Не нашёл сценарий с таким номером. Проверьте /scenarios.');
        return true;
      }
      scenario.stopped = true;
      await saveStore();
      await sendMessage(chatId, `Остановил сценарий ${scenario.id}. Настройки сохранил.`);
      return true;
    }
    for (const scenario of user.scenarios) scenario.stopped = true;
    await saveStore();
    await sendMessage(chatId, 'Остановил отправки по всем сценариям. Настройки сохранил.');
    return true;
  }
  if (text === '/reset') {
    user.setup = null;
    user.scenarios = [];
    user.nextScenarioId = 1;
    await saveStore();
    await sendMessage(chatId, 'Сбросил все сценарии. Можно заново добавить Регулярный или Поездка.');
    return true;
  }
  if (command === '/forecast') {
    const scenarios = arg ? [scenarioById(user, arg)].filter(Boolean) : activeScenarios(user);
    if (arg && !scenarios.length) {
      await sendMessage(chatId, 'Не нашёл сценарий с таким номером. Проверьте /scenarios.');
      return true;
    }
    if (!scenarios.length) {
      await sendMessage(chatId, 'Сначала настройте Регулярный или Поездка.');
      return true;
    }
    if (scenarios.length > 1) await sendMessage(chatId, `Сейчас пришлю ${scenarios.length} прогноз(а) по активным сценариям.`);
    for (const scenario of scenarios) {
      const date = scenario.mode === 'planned' ? scenario.settings.tripDate : null;
      await sendMessage(chatId, await buildForecast(user, scenario, date));
    }
    return true;
  }
  return false;
}

async function handleSetup(chatId, user, text) {
  if (!user.setup) return false;
  const step = user.setup.step;
  const settings = user.setup.settings;

  if (['home', 'office', 'base', 'destination'].includes(step)) {
    const address = await geocodeRussia(text);
    if (!address) {
      await sendMessage(chatId, 'Не нашёл такой адрес в России. Попробуйте уточнить: город, улица, дом.');
      return true;
    }
    settings[step] = address;
    store.addressLogs.push({
      tgId: user.tgId,
      input: text,
      label: address.label,
      district: address.district,
      city: address.city,
      exactHouse: address.exactHouse,
      matchedQuery: address.matchedQuery,
      provider: address.provider,
      createdAt: new Date().toISOString(),
    });
    const precisionNote = address.exactHouse
      ? ''
      : '\n\nВажно: точный дом геокодер не подтвердил, взял ближайшую улично-районную точку. Для прогноза по району этого достаточно.';
    if (step === 'home') {
      user.setup.step = 'office';
      await saveStore();
      await sendMessage(chatId, `Дом: ${address.label}${precisionNote}\nТеперь введите адрес офиса.`);
      return true;
    }
    if (step === 'office') {
      user.setup.step = 'time';
      await saveStore();
      await sendMessage(chatId, `Офис: ${address.label}${precisionNote}\nВо сколько ежедневно присылать прогноз? Формат 08:30.`);
      return true;
    }
    if (step === 'base') {
      user.setup.step = 'tripDate';
      await saveStore();
      await sendMessage(chatId, `База: ${address.label}${precisionNote}\nВведите дату поездки: YYYY-MM-DD или ДД.ММ.ГГГГ.`);
      return true;
    }
    if (step === 'destination') {
      user.setup.step = 'time';
      await saveStore();
      await sendMessage(chatId, `Пункт назначения: ${address.label}${precisionNote}\nВо сколько ежедневно присылать сводку по поездке? Формат 08:30.`);
      return true;
    }
  }

  if (step === 'tripDate') {
    const date = parseDate(text);
    if (!date) {
      await sendMessage(chatId, 'Не понял дату. Введите YYYY-MM-DD или ДД.ММ.ГГГГ.');
      return true;
    }
    if (date < dayOffsetDate(0, settings.timezone || 'Europe/Moscow')) {
      await sendMessage(chatId, 'Эта дата уже прошла. Введите будущую дату поездки: YYYY-MM-DD или ДД.ММ.ГГГГ.');
      return true;
    }
    settings.tripDate = date;
    user.setup.step = 'destination';
    await saveStore();
    await sendMessage(chatId, 'Введите город или адрес назначения в России.');
    return true;
  }

  if (step === 'time') {
    const time = parseTime(text);
    if (!time) {
      await sendMessage(chatId, 'Не понял время. Формат: 08:30.');
      return true;
    }
    const point = settings.home || settings.base;
    const weather = await openMeteo(point);
    settings.time = time;
    settings.timezone = weather.timezone || 'UTC';
    const scenario = finishScenarioSetup(user);
    await saveStore();
    await sendMessage(chatId, `Готово. Сценарий ${scenario.id}, отправка в ${time} (${settings.timezone}). Сейчас пришлю прогноз.`);
    try {
      await sendMessage(chatId, await buildForecast(user, scenario, scenario.mode === 'planned' ? scenario.settings.tripDate : null));
      scenario.lastSentDate = isoDateInTimezone(new Date(), scenario.settings.timezone || 'UTC');
      await saveStore();
    } catch (error) {
      console.error('initial forecast failed:', user.tgId, scenario.id, error);
      await sendMessage(chatId, 'Сценарий сохранён, но предварительный прогноз сейчас не собрался. Я попробую снова по расписанию.');
    }
    return true;
  }

  return false;
}

async function handleMessage(update) {
  const message = update.message;
  const chatId = message?.chat?.id;
  const tgId = message?.from?.id;
  const text = message?.text?.trim();
  if (!chatId || !tgId || !text) return;

  const user = userState(tgId);
  await cleanupExpiredScenarios(user, true);
  if (await handleCommand(chatId, user, text)) return;
  if (await handleSetup(chatId, user, text)) return;
  await sendMessage(chatId, 'Выберите режим: Регулярный или Поездка. Для справки: Помощь.');
}

async function pollOnce() {
  const updates = await callTelegram('getUpdates', {
    offset,
    timeout: pollTimeoutSeconds,
    allowed_updates: ['message'],
  });

  for (const update of updates) {
    offset = update.update_id + 1;
    try {
      await handleMessage(update);
    } catch (error) {
      console.error('message failed:', error);
      const chatId = update.message?.chat?.id;
      if (chatId) await sendMessage(chatId, 'Не смог обработать запрос. Попробуйте ещё раз чуть позже.');
    }
  }
}

async function sendScheduledForecasts() {
  for (const user of Object.values(store.users)) {
    migrateUserState(user);
    try {
      await cleanupExpiredScenarios(user, true);
    } catch (error) {
      console.error('expired cleanup failed:', user.tgId, error);
    }
    for (const scenario of activeScenarios(user)) {
      if (!scenario.settings?.time) continue;
      const timezone = scenario.settings.timezone || 'UTC';
      const now = new Date();
      const today = isoDateInTimezone(now, timezone);
      if (scenario.lastSentDate === today || hhmmInTimezone(now, timezone) !== scenario.settings.time) continue;
      try {
        const date = scenario.mode === 'planned' ? scenario.settings.tripDate : null;
        await sendMessage(user.tgId, await buildForecast(user, scenario, date));
        scenario.lastSentDate = today;
        await saveStore();
      } catch (error) {
        console.error('scheduled forecast failed:', user.tgId, scenario.id, error);
      }
    }
  }
}

async function cleanupAllExpiredScenarios() {
  for (const user of Object.values(store.users)) {
    migrateUserState(user);
    try {
      await cleanupExpiredScenarios(user, true);
    } catch (error) {
      console.error('startup expired cleanup failed:', user.tgId, error);
    }
  }
}

async function main() {
  await loadStore();
  console.log('WeatherBot started');
  await cleanupAllExpiredScenarios();
  setInterval(() => sendScheduledForecasts().catch((error) => console.error(error)), 30_000);
  while (true) {
    try {
      await pollOnce();
    } catch (error) {
      console.error(error);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

main();
