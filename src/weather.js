import { isoDateInTimezone, hhmmInTimezone } from './datetime.js';
import { userAgent } from './config.js';

const openWeatherApiKey = process.env.OPENWEATHER_API_KEY || '';
const weatherApiKey = process.env.WEATHERAPI_KEY || '';
const tomorrowApiKey = process.env.TOMORROW_API_KEY || '';
const meteosourceApiKey = process.env.METEOSOURCE_API_KEY || '';
const weatherCacheTtlMs = Math.min(
  Math.max(Number(process.env.WEATHER_CACHE_TTL_MS || 300_000), 0),
  300_000,
);

const maxCacheEntries = 100;
const weatherCache = new Map();

async function fetchJson(url, options = {}) {
  const maxRetries = 2;
  const timeoutMs = 10_000;
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          'user-agent': userAgent,
          accept: 'application/json',
          ...(options.headers || {}),
        },
      });
      if (!response.ok) {
        const error = new Error(`${url} returned ${response.status}`);
        error.status = response.status;
        throw error;
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      // Повтор лечит обрыв и 5xx, но не 4xx: ключ от повтора не станет валидным,
      // а 429 от повторов только хуже — квоты провайдеров здесь на счету.
      if (error.status >= 400 && error.status < 500) break;
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

async function fetchCachedWeatherJson(url, options = {}) {
  if (weatherCacheTtlMs <= 0) return fetchJson(url, options);

  const now = Date.now();
  const cached = weatherCache.get(url);
  if (cached && now - cached.createdAt <= weatherCacheTtlMs) return cached.data;

  const data = await fetchJson(url, options);

  if (weatherCache.size >= maxCacheEntries) {
    const oldestKey = weatherCache.keys().next().value;
    weatherCache.delete(oldestKey);
  }
  weatherCache.set(url, { createdAt: now, data });
  return data;
}

export async function openMeteo(point) {
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

export async function collectWeather(points) {
  const results = [];
  for (const point of points) {
    const taggedCalls = [
      { source: 'Open-Meteo', fn: openMeteo },
      { source: 'MET Norway', fn: metNorway },
      { source: '7Timer', fn: sevenTimer },
      { source: 'OpenWeather', fn: openWeather },
      { source: 'WeatherAPI', fn: weatherApi },
      { source: 'Tomorrow.io', fn: tomorrow },
      { source: 'Meteosource', fn: meteosource },
    ];
    const calls = taggedCalls.map(({ fn }) => fn(point));
    const settled = await Promise.allSettled(calls);
    for (let i = 0; i < settled.length; i += 1) {
      const item = settled[i];
      if (item.status === 'fulfilled' && item.value) {
        results.push(item.value);
      } else if (item.status === 'rejected') {
        console.error(`Weather provider ${taggedCalls[i].source} failed:`, item.reason.message);
        results.push({ source: 'error', point, error: item.reason.message });
      }
    }
  }
  return results;
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

export function openMeteoWindow(result, date, hours) {
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

export function metNorwayWindow(result, date, hours) {
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

export function sevenTimerWindow(result, date, hours, timezone) {
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

export function openWeatherWindow(result, date, hours, timezone) {
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

export function weatherApiWindow(result, date, hours) {
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

export function tomorrowWindow(result, date, hours) {
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

export function meteosourceWindow(result, date, hours) {
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
