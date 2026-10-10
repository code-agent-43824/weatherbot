# AGENTS.md — weatherbot

Canonical development rules: [coding-rules](https://scm.aktivco.ru/prototypes/coding-rules)
(raw: https://scm.aktivco.ru/prototypes/coding-rules/-/raw/main/AGENTS.md).
This file does NOT duplicate the canon (goose injects every subdirectory's
AGENTS.md into each session's context) — project-specific material only.
The map of the code lives in `CLAUDE.md`.

## What this is

Simple Telegram bot for motorcyclist weather notes (`/regular` daily
home/office commute forecast, `/planned` trip forecast). Stores user
settings, address logs and forecast messages in a local JSON file.
Deployed on an Oracle cloud instance (see `docs/` for the deployment
history and owner-review notes).

## Structure

- `src/` — bot code; `test/` — tests; `assets/` — images.
- Project documents: `README.md`, `HANDOFF.md`, `docs/`.

## Git

Remote: GitHub `code-agent-43824/weatherbot`. Push directly to `main`.
