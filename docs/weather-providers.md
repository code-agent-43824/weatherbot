# Weather Provider Notes

Current production-safe sources:

- Open-Meteo: no key, no card, broad model coverage.
- MET Norway Locationforecast: no key, requires a descriptive User-Agent.
- 7Timer: no key, coarse but useful as an independent signal.
- WeatherAPI.com: key is configured and verified on production.
- Tomorrow.io: supported by code, enable with `TOMORROW_API_KEY` after account
  registration.
- Meteosource: supported by code, enable with `METEOSOURCE_API_KEY`.

OpenWeather One Call 3.0 is supported by code but disabled in production:

- It requires a separate One Call subscription and billing setup.
- OpenWeather's account form can be inconvenient outside the United States.
- Billing overage risk is not acceptable for the MVP.

Additional candidates:

- Visual Crossing: official free-plan docs say each account gets 1,000 free
  weather records per day.
- Tomorrow.io: has an API-only free plan with documented request limits. The
  key is in the app dashboard under Development -> API Keys:
  https://app.tomorrow.io/development/keys
- Meteosource: has a free plan with 400 calls per day and email signup. The
  code uses the documented free `/api/v1/free/point` endpoint with hourly data.

Aggregation rule:

- Query all configured/available providers in parallel.
- If rain probability and precipitation are close, average them.
- If providers strongly disagree, show a warning and per-provider values.
- For planned trips more than 7 days away, do not warn about disagreement; show
  provider values separately because long-range forecasts are inherently weak.
- Cache weather provider responses for at most 5 minutes to keep repeated
  manual forecasts from burning provider quotas without making the data stale.
