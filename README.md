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

## Data Sources

The current no-key MVP uses:

- Nominatim for Russian geocoding with a custom User-Agent. The MVP tries
  normalized Russian address variants and may fall back to a street/district
  point when an exact house is absent from OpenStreetMap data.
- Open-Meteo forecast API.
- MET Norway Locationforecast API.
- 7Timer civil forecast API.

Optional OpenRouter polishing uses `OPENROUTER_API_KEY` and defaults to
`openai/gpt-oss-120b:free`. If OpenRouter is unavailable, deterministic text is
sent instead.

## Deploy

The service is deployed on the Oracle server from the `main` branch. Runtime
secrets are stored outside the repository in the systemd environment file.
