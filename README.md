# WeatherBot

Simple Telegram bot for motorcyclist weather notes.

The bot supports multiple scenarios per user:

- `/regular` - add a daily home/office/home commute forecast.
- `/planned` - add a daily forecast for a planned trip date and destination.

It stores user settings, address logs, and forecast messages in a local JSON file.
Addresses are stored in clear text by product decision.

## Run

```bash
BOT_TOKEN=123456:token npm start
```

## Commands

- `/regular` - add a regular commute scenario.
- `/planned` - add a planned trip scenario.
- `/scenarios` - list configured scenarios.
- `/forecast` - send forecasts for all active scenarios immediately.
- `/forecast 2` - send a forecast for scenario 2.
- `/stop` - stop scheduled messages for all scenarios while keeping settings.
- `/stop 2` - stop scheduled messages for scenario 2.
- `/reset` - delete all scenarios and start over.

After a scenario is created, the bot immediately sends a preliminary forecast
and schedules the next refined forecast for the user's configured time on the
following day. Expired planned-trip scenarios are deleted automatically with a
notification.

## Data Sources

The bot can use production credentials when configured:

- DaData for Russian address geocoding (`DADATA_API_KEY`,
  `DADATA_SECRET_KEY`).
- OpenWeather One Call API 3.0 (`OPENWEATHER_API_KEY`).
- WeatherAPI.com forecast API (`WEATHERAPI_KEY`).

The current no-key fallbacks are:

- Nominatim for Russian geocoding with a custom User-Agent. The MVP tries
  normalized Russian address variants and may fall back to a street/district
  point when an exact house is absent from OpenStreetMap data.
- Open-Meteo forecast API.
- MET Norway Locationforecast API.
- 7Timer civil forecast API.

Optional OpenRouter polishing uses `OPENROUTER_API_KEY` and defaults to
`openai/gpt-oss-120b:free`. If OpenRouter is unavailable, deterministic text is
sent instead.

See [docs/credentials.md](docs/credentials.md) for the credential checklist.

## Deploy

The service is deployed on the Oracle server from the `main` branch. Runtime
secrets are stored outside the repository in the systemd environment file.
