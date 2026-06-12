import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const token = process.env.BOT_TOKEN;
const pollTimeoutSeconds = Number(process.env.POLL_TIMEOUT_SECONDS || 30);
const dataFile = process.env.DATA_FILE || './data/weatherbot.json';
const userAgent = process.env.USER_AGENT || 'WeatherBot/0.2 (https://github.com/code-agent-43824/weatherbot)';
const openRouterApiKey = process.env.OPENROUTER_API_KEY || '';
const openRouterModel = process.env.OPENROUTER_MODEL || 'openai/gpt-oss-120b:free';

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

async function loadStore() {
  try {
    store = JSON.parse(await readFile(dataFile, 'utf8'));
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
    mode: null,
    setup: null,
    settings: null,
    stopped: false,
    lastSentDate: null,
    createdAt: new Date().toISOString(),
  };
  return store.users[key];
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

async function sendMessage(chatId, text) {
  await callTelegram('sendMessage', {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
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

async function geocodeRussia(query) {
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
  const data = await fetchJson(`https://api.open-meteo.com/v1/forecast?${params}`);
  return { source: 'Open-Meteo', timezone: data.timezone || 'UTC', point, data };
}

async function metNorway(point) {
  const params = new URLSearchParams({
    lat: String(point.lat.toFixed(4)),
    lon: String(point.lon.toFixed(4)),
  });
  const data = await fetchJson(`https://api.met.no/weatherapi/locationforecast/2.0/compact?${params}`);
  return { source: 'MET Norway', point, data };
}

async function sevenTimer(point) {
  const params = new URLSearchParams({
    lon: String(point.lon.toFixed(4)),
    lat: String(point.lat.toFixed(4)),
    product: 'civil',
    output: 'json',
  });
  const data = await fetchJson(`https://www.7timer.info/bin/api.pl?${params}`);
  return { source: '7Timer', point, data };
}

async function collectWeather(points) {
  const results = [];
  for (const point of points) {
    const calls = [
      openMeteo(point),
      metNorway(point),
      sevenTimer(point),
    ];
    const settled = await Promise.allSettled(calls);
    for (const item of settled) {
      if (item.status === 'fulfilled') results.push(item.value);
      else results.push({ source: 'error', point, error: item.reason.message });
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
    morning: { label: 'утро туда', hours: [7, 8, 9, 10] },
    day: { label: 'день', hours: [12, 13, 14, 15, 16] },
    evening: { label: 'вечер обратно', hours: [17, 18, 19, 20, 21] },
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
      if (summary) summaries.push({ source: result.source, ...summary });
    }
    sourceResults[key] = { label: window.label, summaries, aggregate: aggregateSourceSummaries(summaries) };
  }
  return sourceResults;
}

function aggregateSourceSummaries(summaries) {
  if (!summaries.length) return null;
  const tempMin = summaries.map((s) => s.tempMin).filter(Number.isFinite);
  const tempMax = summaries.map((s) => s.tempMax).filter(Number.isFinite);
  const rainProb = summaries.map((s) => s.rainProb).filter(Number.isFinite);
  const rainMm = summaries.map((s) => s.rainMm).filter(Number.isFinite);
  const severeVotes = summaries.filter((s) => s.severe).length;
  return {
    tempMin: tempMin.length ? Math.min(...tempMin) : null,
    tempMax: tempMax.length ? Math.max(...tempMax) : null,
    rainProb: rainProb.length ? Math.max(...rainProb) : null,
    rainMm: rainMm.length ? Math.max(...rainMm) : null,
    severe: severeVotes >= 1 || (rainProb.length && Math.max(...rainProb) >= 70),
    severeVotes,
    sourceCount: summaries.length,
  };
}

function formatWindow(window) {
  const agg = window.aggregate;
  if (!agg) return `${window.label}: данных пока нет`;
  const rain = agg.rainProb == null ? 'н/д' : `${agg.rainProb}%`;
  const mm = agg.rainMm == null ? 'н/д' : `${agg.rainMm} мм/ч`;
  const temp = agg.tempMin == null || agg.tempMax == null ? 'н/д' : `${agg.tempMin}…${agg.tempMax}°C`;
  const flag = agg.severe ? ' ⚠️ риск сильного дождя' : '';
  return `${window.label}: ${temp}, дождь до ${rain}, осадки до ${mm}, источников ${agg.sourceCount}${flag}`;
}

function templateForecast(user, date, windows, kind) {
  const route = user.settings.home && user.settings.office
    ? `из ${user.settings.home.district} в ${user.settings.office.district}`
    : `из ${user.settings.base.city} в ${user.settings.destination.city}`;
  return [
    `Мотопрогноз ${kind} на ${date}`,
    `Маршрут: ${route}`,
    '',
    formatWindow(windows.morning),
    formatWindow(windows.day),
    formatWindow(windows.evening),
    '',
    Object.values(windows).some((w) => w.aggregate?.severe)
      ? 'Вывод: есть заметный риск дождя, утром лучше перепроверить перед выездом.'
      : 'Вывод: критичного дождевого риска по источникам не видно.',
  ].join('\n');
}

async function aiPolish(text, facts) {
  if (!openRouterApiKey) return text;
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
          { role: 'system', content: 'Ты кратко формулируешь русский мотопрогноз для Telegram. Не используй markdown-таблицы и символы-разделители таблиц. Не выдумывай данные, опирайся только на факты. Главный вопрос: ехать ли утром на мото или лучше машина/транспорт. Формат: 4-7 коротких строк, затем короткий вывод.' },
          { role: 'user', content: JSON.stringify({ draft: text, facts }) },
        ],
        temperature: 0.2,
        max_tokens: 700,
      }),
    });
    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim() || text;
  } catch (error) {
    console.error('OpenRouter failed:', error.message);
    return text;
  }
}

async function buildForecast(user, targetDate = null) {
  const regular = user.mode === 'regular';
  const from = regular ? user.settings.home : user.settings.base;
  const to = regular ? user.settings.office : user.settings.destination;
  const points = routePoints(from, to);
  const weather = await collectWeather(points);
  const timezone = weather.find((item) => item.source === 'Open-Meteo')?.timezone || user.settings.timezone || 'UTC';
  user.settings.timezone = timezone;
  const date = targetDate || dayOffsetDate(0, timezone);
  const windows = aggregateWindows(weather, date, timezone);
  const draft = templateForecast(user, date, windows, regular ? 'дом/офис/дом' : 'плановой поездки');
  const finalText = await aiPolish(draft, { date, timezone, windows, mode: user.mode });

  store.forecastLogs.push({
    tgId: user.tgId,
    mode: user.mode,
    date,
    routeDistricts: regular
      ? { from: user.settings.home.district, to: user.settings.office.district }
      : { from: user.settings.base.district, to: user.settings.destination.district },
    createdAt: new Date().toISOString(),
    windows,
    message: finalText,
  });
  await saveStore();
  return finalText;
}

async function handleCommand(chatId, user, text) {
  if (text === '/start' || text === '/help') {
    await sendMessage(chatId, [
      'Команды:',
      '/regular — настроить ежедневный прогноз дом/офис/дом',
      '/planned — настроить плановую поездку',
      '/forecast — прислать прогноз сейчас',
      '/stop — остановить регулярные отправки',
      '/reset — сбросить настройки',
    ].join('\n'));
    return true;
  }
  if (text === '/regular') {
    user.mode = 'regular';
    user.stopped = false;
    user.setup = { step: 'home' };
    user.settings = {};
    await saveStore();
    await sendMessage(chatId, 'Введите домашний адрес в России.');
    return true;
  }
  if (text === '/planned') {
    user.mode = 'planned';
    user.stopped = false;
    user.setup = { step: 'base' };
    user.settings = {};
    await saveStore();
    await sendMessage(chatId, 'Введите базовый город или адрес отправления в России.');
    return true;
  }
  if (text === '/stop') {
    user.stopped = true;
    await saveStore();
    await sendMessage(chatId, 'Остановил регулярные отправки. Настройки сохранил.');
    return true;
  }
  if (text === '/reset') {
    user.mode = null;
    user.setup = null;
    user.settings = null;
    user.stopped = false;
    user.lastSentDate = null;
    await saveStore();
    await sendMessage(chatId, 'Сбросил настройки. Можно заново выбрать /regular или /planned.');
    return true;
  }
  if (text === '/forecast') {
    if (!user.settings || !user.mode) {
      await sendMessage(chatId, 'Сначала настройте /regular или /planned.');
      return true;
    }
    const date = user.mode === 'planned' ? user.settings.tripDate : null;
    await sendMessage(chatId, await buildForecast(user, date));
    return true;
  }
  return false;
}

async function handleSetup(chatId, user, text) {
  if (!user.setup) return false;
  const step = user.setup.step;

  if (['home', 'office', 'base', 'destination'].includes(step)) {
    const address = await geocodeRussia(text);
    if (!address) {
      await sendMessage(chatId, 'Не нашёл такой адрес в России. Попробуйте уточнить: город, улица, дом.');
      return true;
    }
    user.settings[step] = address;
    store.addressLogs.push({
      tgId: user.tgId,
      input: text,
      label: address.label,
      district: address.district,
      city: address.city,
      exactHouse: address.exactHouse,
      matchedQuery: address.matchedQuery,
      createdAt: new Date().toISOString(),
    });
    const precisionNote = address.exactHouse
      ? ''
      : '\n\nВажно: точный дом no-key геокодер не подтвердил, взял ближайшую улично-районную точку. Для прогноза по району этого достаточно, для строгой проверки дома позже подключим DaData.';
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
    user.settings.tripDate = date;
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
    const point = user.settings.home || user.settings.base;
    const weather = await openMeteo(point);
    user.settings.time = time;
    user.settings.timezone = weather.timezone || 'UTC';
    user.setup = null;
    user.stopped = false;
    await saveStore();
    await sendMessage(chatId, `Готово. Буду присылать в ${time} (${user.settings.timezone}). Можно проверить командой /forecast.`);
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
  if (await handleCommand(chatId, user, text)) return;
  if (await handleSetup(chatId, user, text)) return;
  await sendMessage(chatId, 'Выберите режим: /regular или /planned. Для справки: /help.');
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
    if (!user.settings?.time || user.stopped) continue;
    const timezone = user.settings.timezone || 'UTC';
    const now = new Date();
    const today = isoDateInTimezone(now, timezone);
    if (user.lastSentDate === today || hhmmInTimezone(now, timezone) !== user.settings.time) continue;
    try {
      const date = user.mode === 'planned' ? user.settings.tripDate : null;
      await sendMessage(user.tgId, await buildForecast(user, date));
      user.lastSentDate = today;
      await saveStore();
    } catch (error) {
      console.error('scheduled forecast failed:', user.tgId, error);
    }
  }
}

async function main() {
  await loadStore();
  console.log('WeatherBot started');
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
