import { userAgent } from './config.js';

const dadataApiKey = process.env.DADATA_API_KEY || '';
const dadataSecretKey = process.env.DADATA_SECRET_KEY || '';

let lastNominatimCall = 0;

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

export async function geocodeRussia(query) {
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
