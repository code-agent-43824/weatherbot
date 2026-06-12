# Credential Checklist

WeatherBot can run with no-key fallbacks, but production-quality address and
weather decisions need a few external credentials. The code currently supports
DaData, OpenWeather, WeatherAPI.com, and OpenRouter environment variables.

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

Recommended first choice: OpenWeather One Call API 3.0.

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
