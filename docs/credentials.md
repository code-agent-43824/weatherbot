# Credential Checklist

WeatherBot can run with no-key fallbacks, but production-quality address and
weather decisions need a few external credentials. The code currently supports
DaData, WeatherAPI.com, Tomorrow.io, Meteosource, OpenWeather, and OpenRouter
environment variables.

## Required For Production

### DaData

Purpose: precise Russian address parsing, house-level geocoding, FIAS/KLADR
metadata, and fewer false matches than Nominatim.

Actions:

1. Register at https://dadata.ru/.
2. Confirm the account email.
3. Open the profile/API section and copy the API key and secret key.
4. Put them into the server environment as:

```bash
DADATA_API_KEY=...
DADATA_SECRET_KEY=...
```

Use DaData Suggest Address for user input and Clean Address when a strict
normalized address/geopoint is needed.

### Stable Weather Provider

Purpose: independent precipitation probability, alerts, and more stable
forecast coverage than no-key fallbacks.

Supported but disabled in production: OpenWeather One Call API 3.0.

Do not enable this provider unless a daily billing limit is set and the billing
country/card constraints are acceptable. WeatherBot currently keeps
`OPENWEATHER_API_KEY` empty on production to avoid accidental overage.

Actions:

1. Register at https://openweathermap.org/.
2. Create an API key in the OpenWeather account dashboard.
3. Enable/subscribe to One Call API 3.0.
4. Wait for key activation if the dashboard says it is pending.
5. Put it into the server environment as:

```bash
OPENWEATHER_API_KEY=...
```

Alternative: WeatherAPI.com forecast API.

Actions:

1. Register at https://www.weatherapi.com/.
2. Copy the API key from the account dashboard.
3. Put it into the server environment as:

```bash
WEATHERAPI_KEY=...
```

Alternative: Tomorrow.io forecast API.

Actions:

1. Register or sign in at https://app.tomorrow.io/.
2. Open Development -> API Keys: https://app.tomorrow.io/development/keys.
3. Copy the API key from that page.
4. Put it into the server environment as:

```bash
TOMORROW_API_KEY=...
```

Alternative: Meteosource forecast API.

Actions:

1. Register at https://www.meteosource.com/.
2. Copy the API key from the account dashboard.
3. Put it into the server environment as:

```bash
METEOSOURCE_API_KEY=...
```

Additional candidates to evaluate before adding another paid/billing-sensitive
provider:

- Visual Crossing: 1,000 free records/day according to their free-plan docs.
Weather provider HTTP responses may be cached in memory with
`WEATHER_CACHE_TTL_MS`, but the application caps the value at 300000 ms
(5 minutes) to avoid stale forecasts.

Russian-market alternative: Yandex Weather API.

Actions:

1. Buy or enable a Yandex Weather API subscription in Yandex Cloud Marketplace.
2. Link the subscription to Yandex Weather.
3. Copy the shown API key.
4. Put it into the server environment as:

```bash
YANDEX_WEATHER_API_KEY=...
```

## Optional

### OpenRouter

Purpose: polish deterministic forecast facts into short Russian Telegram text.
The bot must still keep deterministic safety recommendations outside the model.

Actions:

1. Sign in at https://openrouter.ai/.
2. Create an API key.
3. Set a credit limit for the key.
4. Put it into the server environment as:

```bash
OPENROUTER_API_KEY=...
OPENROUTER_MODEL=openai/gpt-oss-120b:free
```

## No Key Needed

- Open-Meteo
- MET Norway Locationforecast
- 7Timer
- Nominatim, as MVP fallback only, with a valid User-Agent and strict rate
  discipline
