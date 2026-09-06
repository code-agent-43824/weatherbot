@AGENTS.md

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

The first line is an import: it pulls the owner's canonical rules into context at session start.
Nothing from `AGENTS.md` is restated below — this file holds only what is specific to WeatherBot:
commands, the map of the code, settled decisions, and departures.

## Commands

```bash
npm start                      # run the bot (BOT_TOKEN is required, the process exits without it)
npm run check                  # node --check every src/*.js + run the whole test suite
node --test test/non-overlapping-runner.test.js   # run one test file
node --test --test-name-pattern 'unlocks after'   # run one test by name
```

`npm run check` is the full gate: there is no linter, no formatter and no build step, and there
is nothing to install — `package.json` declares zero dependencies, so `node_modules/` never
exists here. Everything runs on Node >= 18 built-ins: global `fetch`, `node:test`,
`node:fs/promises`, `Intl`. Adding a dependency is a stack change (§9).

## Map of the code

A single long-polling Telegram bot process. `main()` in `src/bot.js` loads the JSON store,
registers the bot command list, deletes expired scenarios, starts a 30-second scheduler
interval, then loops on `pollOnce()` forever. Errors in the poll loop are logged and retried
after 3s — the process is meant to stay alive.

**Two concurrent drivers, one shared store.**

1. *Interactive*: `pollOnce` → `handleMessage` → `handleCommand` (slash commands plus the
   Russian reply-keyboard labels mapped in `buttonCommands`) → falling through to
   `handleSetup`, the address/date/time wizard driven by `user.setup.step`.
2. *Scheduled*: `setInterval` → `runScheduledForecasts` → `sendScheduledForecasts`, which walks
   every user's active scenarios and asks `scenarioSendDecision` (`src/schedule.js`) what to do
   with each: `send`, `done`, `wait` or `skip`. The interval fires more often than once a
   minute, so `scenario.lastSentDate` is the dedupe guard, and `createNonOverlappingRunner`
   (`src/non-overlapping-runner.js`) drops a tick while the previous one is still awaiting
   network calls. Both guards are load-bearing; changing the interval or the send condition
   without them reintroduces duplicate messages.

   The decision is "due and not sent today", never "this exact minute". Users and scenarios are
   walked one at a time and each forecast is a round of network calls, so an exact-minute
   comparison lost a whole day's send for everyone the walk reached after the minute rolled
   over — silently, and more often the more users there are. A commute may run up to
   `commuteCatchUpMinutes` late, after which the day is closed with a log line rather than a
   breakfast forecast at lunchtime; a planned trip forecasts a future date, so it catches up
   however late it is.

**Data model.** `store = { users, forecastLogs, addressLogs }`, persisted as one pretty-printed
JSON file (`DATA_FILE`, default `./data/weatherbot.json`). A user owns N `scenarios`, each
`{ id, mode: 'regular' | 'planned', settings, stopped, lastSentDate, createdAt }`. `regular`
scenarios carry `home`/`office` points; `planned` ones carry `base`/`destination`/`tripDate`.

- `saveStore()` rewrites the whole file. Every mutation needs an `await saveStore()` before the
  confirming `sendMessage` — there is no transaction, no dirty flag and no periodic flush. It
  snapshots the store synchronously, then queues the write on `saveChain` and lands it through a
  single `.tmp` file plus `rename`. Both halves are load-bearing: the snapshot keeps a store
  mutated mid-write out of the file, and the one shared `.tmp` path is only safe because the
  chain guarantees one write at a time. Parallelise those writes and they clobber each other.
- `migrateUserState(user)` is the only schema-migration point. It runs on load, inside
  `userState()`, and at the top of each scheduler pass. Older single-scenario users are folded
  into `scenarios[]` there, so a new field gets its default in that function rather than being
  assumed present. The store on the server predates several of these fields.

**Forecast pipeline** (`buildForecast`): `routePoints(from, to)` makes three points (origin,
midpoint, destination) → `collectWeather` queries every configured provider for every point via
`Promise.allSettled`, so a failing provider becomes `{ source: 'error' }` and is skipped, never
fatal → `aggregateWindows` slices morning/day/evening hour windows → `aggregateSourceSummaries`
collapses per-source summaries, drops outliers by a median risk score and derives the
rain-consensus fields (`rainySourceCount`, `rainMajority`, `severeVotes`, `conflict`) →
`templateForecast` renders the Russian message → `polishForecastWithLlm` optionally rewords it →
`buildForecastDetails` (`src/forecast-details.js`) appends the per-source block **after** that
polish → the whole `windows` object and the final text are appended to `store.forecastLogs`.

The order there is load-bearing: the per-source block is made of numbers, units and provider
names, which is exactly what the LLM validator rejects — send it through `polishForecastWithLlm`
and the model's reply would be discarded every time sources disagree.

Not every field the aggregate computes reaches the message; the aggregate is also the log
record. Check `formatWindow`, `templateForecast` and `buildForecastDetails` for what a user
actually sees.

### Adding a weather provider

Three coordinated edits tied together by the source string — two in `src/weather.js`,
one in `src/aggregate.js`:

1. A fetch function returning `{ source: '<Name>', point, data }`, or `null` when its API key is
   unset — `collectWeather` filters nulls, and that is how optional providers stay optional.
   Always go through `fetchCachedWeatherJson`, never bare `fetch`.
2. A `<name>Window(result, date, hours[, timezone])` parser that pushes
   `{ temp, rainProb, rainMm, code }` rows and returns `summarizeValues(values)`. A provider
   with no real probability field synthesizes one (see `metNorwayWindow`: ~55 when the symbol
   says rain, ~15 otherwise) — such a heuristic stays conservative, it feeds a safety verdict.
3. Register the call in `collectWeather` (`src/weather.js`) and add the
   `result.source === '<Name>'` branch in `aggregateWindows` (`src/aggregate.js`).

Provider evaluation notes — free-plan limits, what was rejected and why — live in
`docs/weather-providers.md`; the credential setup steps live in `docs/credentials.md`.

## Project conventions

- **UI strings are Russian** (§10): every user-facing message, keyboard label and command
  description. Code, comments and the documents under `docs/` that describe providers and
  credentials are currently English.
- ES modules, 2-space indent, single quotes, semicolons, trailing commas in multi-line literals,
  `async`/`await` over `.then` chains, early returns over nesting, small pure helpers for
  formatting and aggregation.
- Background failures are caught, logged with a short lowercase prefix
  (`console.error('scheduled forecast failed:', ...)`) and never crash the loop; a failure the
  user is waiting on answers with a Russian apology message instead.
- `src/bot.js` exports nothing: it wires the modules together and owns the store, the command
  handlers and the loops. Logic worth testing is extracted into its own module with a
  `node:test` file under `test/` — `src/non-overlapping-runner.js` is the pattern to follow.
  A module must stay importable without side effects, or it takes the test runner down with it.
- Every environment variable the process reads is listed in `.env.example`; runtime values live
  in the systemd environment file on the server.

## Settled decisions

Deliberate, with reasons; not to be reopened on an agent's initiative (§8).

- **Weather facts and safety verdicts are deterministic; the LLM only polishes wording.**
  `polishForecastWithLlm` sends the finished draft and rejects the reply if it mentions numbers,
  units or provider names, or if it drops `"По нескольким источникам"`, `"Итог:"` or the leading
  emoji — the deterministic draft is sent instead. Reason: a model must never be the source of a
  probability or a ride/don't-ride recommendation. Any change to `templateForecast` keeps that
  validator in sync.
- **The regular commute is asymmetric and must stay that way.** Morning and evening are the
  windows the rider is out on the bike; during the day the bike is parked at the office. So rain
  in the day window never produces a "don't ride" verdict — it produces "keep it under a roof" —
  while the morning and evening windows do (`rideNoGoScore` / `parkedRainScore` in
  `src/aggregate.js`). Reason: this asymmetry is the whole point of the `regular` mode, and
  collapsing the three windows into one maximum has already shipped once and had to be undone —
  it told riders to leave the bike at home on days that were dry for both commutes.
- **The risk score behind the verdict is also what the message text reports.** `formatRainWords`
  and the recommendations both read `riskScoreForAggregate`. Reason: while the prose sentence ran
  off `rainMajority` and the verdict off the score, one message could say the rain was unlikely
  and refuse the ride in the same breath.
- **OpenWeather One Call 3.0 is supported by code but not to be enabled without a daily billing
  limit.** Reason: billing overage risk is not acceptable for this project
  (`docs/credentials.md`, `docs/weather-providers.md`).
- **Weather responses are cached in memory by URL, and `WEATHER_CACHE_TTL_MS` is capped at
  300000 ms in code.** Reason: repeated manual `/forecast` calls must not burn provider quotas,
  and a longer cache would serve stale forecasts. Do not raise the cap.
- **Nominatim is an MVP fallback only, serialized to one call per 1.1s via `lastNominatimCall`
  and always sent with `USER_AGENT`.** Reason: its usage policy. DaData is the primary geocoder;
  `geocodeRussia` swallows DaData failures and falls through to the normalized query variants
  built by `buildNominatimQueries`. A street-level hit is acceptable — `exactHouse: false` only
  adds a note for the user, it is not an error.
- **Geocoding is Russia-only** (`countrycodes=ru`, `country_iso_code: 'RU'`).
- **Private or mobile endpoints of Russian weather sites (RP5, Gismeteo, Meteoinfo) are not
  scraped.** Reason: recorded in `docs/weather-providers.md`; only a product decision changes it.
- **Addresses are stored in clear text** in the JSON store and in `addressLogs`. Reason: product
  decision, recorded in `README.md`.

## Departures from AGENTS.md

- **Project-specific material lives in this file, not below the Appendix in `AGENTS.md`.**
  Reason: `install.sh` overwrites `AGENTS.md` wholesale on every rules update, so anything
  appended there would be lost. `AGENTS.md` is kept byte-identical to the canonical copy.

## Version discipline

The version lives in `package.json` (`0.1.0`). A second version number is embedded in the
default `USER_AGENT` string — in `src/config.js` and again in `.env.example` — and it is sent to
Nominatim and MET Norway, both of which require a descriptive User-Agent. Bumping the package
version means deciding whether those two strings move with it.

## Deployment

**Deployment needs manual work on the server, so only Watson deploys** (§6). Every other agent
stays out of production — no server access, no restarts, no deploy jobs.

A push to `main` is therefore not a release: the trunk running ahead of the server is the normal
state, and nothing reaches users until someone deploys by hand. The service runs on the Oracle
server from `main` (`README.md`), with runtime secrets in the systemd environment file. The exact
commands are not written down anywhere in the repository — whoever deploys next records them in
this section.

## Owner review

The owner checks two things by hand, both of them out of reach of any test here:

- **The bot's message in Telegram** — after a change to the wording, the format, or the logic
  behind the verdict. He runs `/forecast` and reads what comes back.
- **Production after a deploy** — that the service is alive and forecasts are going out.

So an agent **pauses after each closed stage and waits for that check** before opening the next
one (§13). Close the stage in the documents, say plainly what to look at, and stop.
