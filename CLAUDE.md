# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start                      # run the bot (BOT_TOKEN is required, process exits without it)
npm run check                  # syntax check src/bot.js + run the whole test suite
node --test test/non-overlapping-runner.test.js   # run one test file
node --test --test-name-pattern 'unlocks after'   # run one test by name
```

There is no build step, no linter, and no dependency install: `package.json` has zero
dependencies and `node_modules/` never exists here. Everything runs on Node >= 18 built-ins
(global `fetch`, `node:test`, `node:fs/promises`, `Intl`).

## Architecture

A single long-polling Telegram bot process. `main()` in `src/bot.js` loads the JSON store,
registers the bot command list, deletes expired scenarios, starts a 30-second scheduler
interval, then loops on `pollOnce()` forever. Errors in the poll loop are logged and retried
after 3s — the process is meant to stay alive.

**Two concurrent drivers, one shared store.**

1. *Interactive*: `pollOnce` → `handleMessage` → `handleCommand` (slash commands and the
   Russian reply-keyboard labels mapped in `buttonCommands`) → falling through to
   `handleSetup` (the address/date/time wizard driven by `user.setup.step`).
2. *Scheduled*: `setInterval` → `runScheduledForecasts` → `sendScheduledForecasts`, which
   walks every user's active scenarios and sends when `hhmmInTimezone(now, tz) ===
   scenario.settings.time`. The interval fires more often than once a minute, so
   `scenario.lastSentDate` is the dedupe guard, and `createNonOverlappingRunner`
   (`src/non-overlapping-runner.js`) drops a tick if the previous one is still awaiting
   network calls. Keep both guards intact when touching the scheduler.

**Data model.** `store = { users, forecastLogs, addressLogs }` persisted as one pretty-printed
JSON file (`DATA_FILE`, default `./data/weatherbot.json`). A user owns N `scenarios`, each
`{ id, mode: 'regular' | 'planned', settings, stopped, lastSentDate, createdAt }`. `regular`
scenarios carry `home`/`office` points; `planned` ones carry `base`/`destination`/`tripDate`.

- `saveStore()` rewrites the whole file. Every mutation must be followed by an `await
  saveStore()` before the confirming `sendMessage` — there is no transaction or dirty flag.
- `migrateUserState(user)` is the only schema-migration point. It runs on load, in
  `userState()`, and at the top of each scheduler pass. Older single-scenario users are folded
  into `scenarios[]` there, so add new fields with a default in that function rather than
  assuming they exist.

**Forecast pipeline** (`buildForecast`): `routePoints(from, to)` makes three points (origin,
midpoint, destination) → `collectWeather` queries every configured provider for every point via
`Promise.allSettled` (a rejected provider becomes `{ source: 'error' }` and is skipped, never
fatal) → `aggregateWindows` slices morning/day/evening hour windows → `aggregateSourceSummaries`
collapses per-source summaries, drops outliers by a median risk score, and derives the
rain-consensus fields (`rainySourceCount`, `rainMajority`, `severeVotes`, `conflict`) →
`templateForecast` renders the Russian message → `polishForecastWithLlm` optionally rewords it →
the result is appended to `store.forecastLogs`.

### Adding a weather provider

Three coordinated edits, all in `src/bot.js`:

1. A fetch function returning `{ source: '<Name>', point, data }`, or `null` when its API key is
   unset — `collectWeather` filters nulls, that is how optional providers stay optional. Always
   go through `fetchCachedWeatherJson`.
2. A `<name>Window(result, date, hours[, timezone])` parser that pushes
   `{ temp, rainProb, rainMm, code }` rows and returns `summarizeValues(values)`. Providers
   without a real probability field synthesize one (see `metNorwayWindow`: ~55 when the symbol
   says rain, ~15 otherwise) — keep such heuristics conservative.
3. Register the call in `collectWeather` and the `result.source === '<Name>'` branch in
   `aggregateWindows`. The source string ties all three together.

## Rules that are load-bearing here

- **Weather facts and safety verdicts are deterministic.** The LLM step is text polish only:
  `polishForecastWithLlm` sends the finished draft, then rejects the reply if it mentions
  numbers/units/provider names, or drops `"По нескольким источникам"`, `"Итог:"`, or the leading
  emoji — falling back to the deterministic draft. Never let the model produce a fact, a
  probability, or a recommendation, and keep the validator in sync with any template change.
- **Respect third-party rate limits and quotas.** Nominatim calls are serialized at 1.1s apart
  via `lastNominatimCall` and always carry the `USER_AGENT`; weather responses are cached in
  memory by URL with `WEATHER_CACHE_TTL_MS` hard-capped at 300000 ms so manual `/forecast` spam
  cannot burn provider quotas or serve stale data. Do not raise the cap or remove the throttle.
- **Geocoding is Russia-only, DaData first, Nominatim as fallback.** `geocodeRussia` swallows
  DaData failures and falls through to `buildNominatimQueries`, which tries progressively
  normalized Russian address variants. A street-level hit is acceptable — `exactHouse: false`
  only adds a note to the user, it is not an error.
- **OpenWeather stays disabled in production** (`OPENWEATHER_API_KEY` empty) because of billing
  overage risk; the code path exists but must not be enabled without a daily billing limit. See
  `docs/credentials.md` and `docs/weather-providers.md` before adding or enabling a provider.
- **Addresses are stored in clear text by product decision**; secrets come from the environment
  only (systemd environment file on the server, never the repo).
- **Language split**: every user-facing string, keyboard label, and command description is
  Russian; code, comments, docs, and commit messages are English. Commits follow Conventional
  Commits (`feat:`, `fix:`, `chore:`, `docs:`) with a single short subject line.
- **Style**: ES modules, 2-space indent, single quotes, semicolons, trailing commas in
  multi-line literals, `async`/`await` (no `.then` chains), early returns over nesting, small
  pure helpers for formatting/aggregation. Background failures are caught and logged with a
  short lowercase prefix (`console.error('scheduled forecast failed:', ...)`) and never crash
  the loop; user-visible failures answer with a Russian apology message instead.
- **Testing**: only genuinely pure/extractable logic gets its own module plus a `node:test` file
  under `test/` (the non-overlapping runner is the current example). `src/bot.js` exports
  nothing and is covered by `node --check` only, so prefer extracting a helper over adding
  untestable branches to it.

## Deploy

`main` is deployed to the Oracle server; runtime secrets live in the systemd environment file
outside the repository. `.env.example` documents every variable the process reads.
