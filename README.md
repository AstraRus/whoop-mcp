# whoop-ai-mcp

[![npm version](https://img.shields.io/npm/v/whoop-ai-mcp.svg)](https://www.npmjs.com/package/whoop-ai-mcp)
[![npm downloads](https://img.shields.io/npm/dw/whoop-ai-mcp.svg)](https://www.npmjs.com/package/whoop-ai-mcp)
[![GitHub stars](https://img.shields.io/github/stars/shashankswe2020-ux/whoop-mcp.svg)](https://github.com/shashankswe2020-ux/whoop-mcp/stargazers)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-compatible-purple.svg)](https://modelcontextprotocol.io/)

[![MCP Registry](https://img.shields.io/badge/MCP_Registry-published-green.svg)](https://registry.modelcontextprotocol.io/)

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that connects AI assistants like Claude to your [WHOOP](https://www.whoop.com/) health and fitness data. Ask questions about your recovery, sleep, workouts, and more — all through natural conversation.

> 📦 **Published on the [MCP Registry](https://registry.modelcontextprotocol.io/)** as `io.github.shashankswe2020-ux/whoop` — discoverable by any MCP-compatible client.

## Features

> **0.8.0 — Training, sleep and recovery analysis on local days:** 12 new tools
> (day detail, export, workout log and context, personal records, training load,
> sport breakdown, sleep analysis, recovery analysis, sleep need estimate,
> recovery patterns, sync status), a server guide, 8 new prompts, a process-wide
> WHOOP rate limiter with progressive history loading, webhooks, a hardened
> claude.ai connector and a non-root container. See the
> [changelog](CHANGELOG.md#080---2026-09-17) for behaviour changes since 0.7.0.

- **28 read-only tools** in standard privacy mode: today's snapshot, one local day in detail, day-by-day calendar, weekly summaries, period comparisons, trends, baselines, sleep debt and sleep analysis, sleep need estimate, recovery analysis and recovery patterns, training load, sport breakdown, workout log, workout context, personal records, CSV/JSON export, sync status, raw collections and record lookups
- **Local days done right** — every day-based tool places WHOOP cycles, sleeps, recoveries and workouts on the same local days (a workout after midnight before the next sleep counts toward the previous WHOOP day)
- **Honest about missing data** — unknown values are `null`, never 0; calibrating recoveries are flagged; minimum sample sizes are enforced with notes that say `n of required`
- **6 MCP resources** — latest recovery, sleep, cycle, workout and profile, plus a markdown server guide
- **13 MCP prompts** — morning and evening briefings, day review, session debrief, training load check, recovery patterns, data export, sync check and the original five
- **Aggregate privacy mode** — **8 tools** that release only whole released weeks with at least 3 samples per week, checked by a cross-tool linear-algebra test
- **Rate-limit aware** — one process-wide limiter keeps the server under WHOOP's 100 requests per minute; long histories load in cached 30-day chunks across calls
- **Remote hosting** — Streamable HTTP with a static bearer token or an OAuth 2.1 connector for claude.ai (stateless dynamic client registration), optional WHOOP webhooks, authenticated `/health` with version, commit and request counters
- **Resilient auth** — shared token refresh, degraded startup through WHOOP token-endpoint outages, human-only `revoke` command
- **Structured results** — every tool advertises an output schema and returns validated `structuredContent`
- 📦 **Lightweight** — two runtime dependencies (`@modelcontextprotocol/sdk` + `zod`)

## SOTA scan (WHOOP MCP packages on npm)

_Registry snapshot collected 2026-08-30. Versions and publish dates can change;
this is an ecosystem comparison, not a source-code security audit._

| Package                      |    Latest | Published (UTC) | MCP Registry identity                        | Runtime deps | Notable signals                                                                |
| ---------------------------- | --------: | --------------- | -------------------------------------------- | -----------: | ------------------------------------------------------------------------------ |
| **whoop-ai-mcp (this repo)** | **0.6.1** | 2026-08-07      | **✅ `io.github.shashankswe2020-ux/whoop`**  |        **2** | 14 tools, 4 resources, 5 prompts, analytics, HTTP + stdio, OAuth 2.1 connector |
| whoop-mcp-unofficial         |     0.6.5 | 2026-08-29      | ✅ `io.github.davidmosiah/whoop-mcp`         |            6 | 20+ tools, SQLite cache, privacy modes                                         |
| mcp-server-whoop             |     0.2.2 | 2026-07-17      | ✅ `io.github.Yadheedhya06/mcp-server-whoop` |            2 | Read-only/local-first, npm provenance, SBOM and security checks                |
| @souravpn/whoop-mcp          |     1.0.2 | 2026-05-27      | ✅ `io.github.souravpn/whoop-mcp`            |            1 | Simple standalone server with OAuth setup                                      |
| @nchemb/whoop-mcp            |     0.2.0 | 2026-04-27      | —                                            |            4 | Shared OAuth relay and local SQLite cache                                      |
| whoop-mcp-server             |     0.0.5 | 2026-03-13      | —                                            |            2 | WHOOP Developer Platform API server                                            |
| whoop-mcp                    |     0.1.2 | 2026-03-11      | —                                            |            1 | Server built with the `xmcp` framework                                         |
| @roebot0/whoop-mcp           |     1.0.0 | 2026-04-06      | —                                            |            3 | Axios-based server and separate auth command                                   |
| @alacore/whoop-mcp-server    |     1.0.1 | 2025-10-09      | —                                            |            2 | API v2 integration; requires pnpm                                              |

**Findings**

- MCP Registry discoverability is now table stakes: at least three alternatives also
  publish `mcpName` identities.
- The leading portability trade-off remains local-first/no-infrastructure
  operation versus richer remote hosting, caching, or relay features.
- Current best practice is to document security controls, test/verification
  commands, provenance or SBOM metadata, and the exact transport/auth model.
  This project provides the first two and supports both local stdio and
  authenticated Streamable HTTP; it does not claim to be a security audit.

The table above is the historical August 30 snapshot, so its 14-tool count is intentional.
Version 0.7.0 added two tools and 0.8.0 adds twelve more (28 in total); the
September scope is in the [September feature scan](docs/ideas/sota-feature-scan-2026-09-10.md).

**Evidence and reproducibility:** package names, versions, publish dates,
dependency counts, descriptions, and `mcpName` values come from the npm Registry
search and package manifests. Feature notes were checked against each package's
published metadata/README where available. Re-run the scan with:

```bash
curl -s 'https://registry.npmjs.org/-/v1/search?text=whoop%20mcp&size=20'
```

## 🎥 Video Walkthrough

Watch a detailed walkthrough of setting up and using whoop-ai-mcp with Claude Desktop:

[![Watch the video](https://img.youtube.com/vi/2vwxEjctcWs/maxresdefault.jpg)](https://youtu.be/2vwxEjctcWs?si=ncIr0fmXT0MUarYL)

> Covers: creating a WHOOP Developer App, configuring Claude Desktop, OAuth authentication, and querying your health data through natural conversation.

## Prerequisites

1. A [WHOOP](https://www.whoop.com/) account with an active membership
2. A WHOOP Developer App — create one at [developer.whoop.com](https://developer.whoop.com)
   - Set the redirect URI to `http://localhost:3000/callback`
3. [Node.js](https://nodejs.org/) >= 20

## Get a WHOOP

Don't have a WHOOP yet? Here's how to get started:

- 🛒 **Buy a WHOOP on Amazon** — [WHOOP peak on Amazon](https://amzn.to/4st9B2r)
- 🔗 **Join WHOOP directly** — [whoop.com/membership](https://join.whoop.com/63E6C805)

## Quickstart (MCP Registry)

This server is published on the official [MCP Registry](https://registry.modelcontextprotocol.io/). MCP clients that support the registry can discover and install it automatically:

```
Server name: io.github.shashankswe2020-ux/whoop
```

You can also browse it via the registry API:

```bash
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.shashankswe2020-ux/whoop"
```

## Quickstart (Claude Desktop)

Add this to your Claude Desktop configuration file:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "whoop": {
      "command": "npx",
      "args": ["whoop-ai-mcp"],
      "env": {
        "WHOOP_CLIENT_ID": "your_client_id",
        "WHOOP_CLIENT_SECRET": "your_client_secret"
      }
    }
  }
}
```

Replace `your_client_id` and `your_client_secret` with the credentials from your [WHOOP Developer App](https://developer.whoop.com).

On first launch, a browser window will open for you to authorize access to your WHOOP data. After authorizing, tokens are cached locally and refresh automatically.

Then ask Claude something like:

> _"How am I doing today?"_
>
> _"What happened yesterday: sleep, strain and workouts?"_
>
> _"How is my training load compared with the last four weeks?"_
>
> _"Debrief my last run."_
>
> _"How did I sleep over the last two weeks compared with what WHOOP says I needed?"_
>
> _"Why is today's data missing?"_

**whoop-mcp connected in Claude Desktop:**

![whoop-mcp connected in Claude Desktop](images/whoop-mcp-connected.png)

**Chatting with WHOOP data through Claude:**

![Claude chat with whoop-mcp integrated](images/Claude-chat-with-whoop-mcp-integrated.png)

**Weekly Health Report demo (Claude Desktop):**

![Weekly health report — asking Claude](images/Screenshot%202026-05-30%20at%201.36.39%E2%80%AFPM.png)

![Recommendations and breakdowns](images/Screenshot%202026-05-30%20at%201.37.06%E2%80%AFPM.png)

![summary and connector view](images/Screenshot%202026-05-30%20at%201.37.39%E2%80%AFPM.png)

## Installation

### Via npx (recommended)

No installation needed — Claude Desktop runs it automatically with the config above.

### Global install

```bash
npm install -g whoop-ai-mcp
```

### From source

```bash
git clone https://github.com/shashankswe2020-ux/whoop-mcp.git
cd whoop-mcp
npm install
npm run build
```

### Setup wizard (`whoop-ai-mcp setup`)

For a guided installation that writes the Claude Desktop config (or prints the
registration command for Claude Code, Codex, or GitHub Copilot) and verifies
your WHOOP credentials in one go:

```bash
npx whoop-ai-mcp setup
```

Flags:

- `--client=claude-desktop` (default) writes/merges `claude_desktop_config.json`
  with an automatic `.bak` backup.
- `--client=claude-code` prints the equivalent `claude mcp add` command.
- `--client=codex` prints the equivalent `codex mcp add` command (registers the
  server in `~/.codex/config.toml`).
- `--client=copilot` prints the equivalent `code --add-mcp` command for GitHub
  Copilot in VS Code.
- `--verify` runs the OAuth flow end-to-end and fetches your profile to confirm
  everything is wired correctly before exiting.
- `--client-id` / `--client-secret` skip the interactive prompts (useful for
  scripts; secrets entered interactively are masked).

If `WHOOP_CLIENT_ID` and `WHOOP_CLIENT_SECRET` are already exported in your
shell, the wizard uses them automatically — no prompts. Combine with
`--verify` to do a one-shot config-correctness check:

```bash
WHOOP_CLIENT_ID=... WHOOP_CLIENT_SECRET=... npx whoop-ai-mcp setup --verify
```

If the Claude Desktop config file already contains a `whoop` MCP entry from
a previous setup, the wizard short-circuits — it reads the existing
credentials, prints `Existing whoop entry found in <path>`, and either
verifies them (with `--verify`) or exits without rewriting the file. To
overwrite an existing entry, pass explicit `--client-id` / `--client-secret`
flags.

Precedence: `--client-id` / `--client-secret` flags > existing claude-desktop
config > `WHOOP_CLIENT_ID` / `WHOOP_CLIENT_SECRET` env vars > interactive
prompts.

Example session:

```text
% npx whoop-ai-mcp setup --client=claude-desktop
WHOOP MCP — Setup Wizard
------------------------

WHOOP Client ID (from https://developer.whoop.com): xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
WHOOP Client Secret (input hidden): ****************************************************************

Claude Desktop config written: ~/Library/Application Support/Claude/claude_desktop_config.json
Previous config backed up to: ~/Library/Application Support/Claude/claude_desktop_config.json.bak
Restart Claude Desktop to load the new server.
```

## Configuration

### Environment variables

Every variable the server, its CLI commands and the container entrypoint read.
Only `WHOOP_CLIENT_ID` and `WHOOP_CLIENT_SECRET` are needed for local use;
`MCP_AUTH_TOKEN` is required for the HTTP transport. Invalid values of the
validated variables stop the server at startup with a message naming the
variable.

| Variable                       | Default                                                                                                                                                            | Description                                                                                                                                                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WHOOP_CLIENT_ID`              | required                                                                                                                                                           | WHOOP Developer App client id. Also read by `setup`, `doctor` and `revoke`.                                                                                                                                                                       |
| `WHOOP_CLIENT_SECRET`          | required                                                                                                                                                           | WHOOP Developer App client secret. With webhooks enabled it also verifies webhook signatures.                                                                                                                                                     |
| `WHOOP_CLIENT_SECRET_PREVIOUS` | unset                                                                                                                                                              | The previous client secret while it is being rotated: webhook deliveries signed with it are still accepted.                                                                                                                                       |
| `WHOOP_REDIRECT_URI`           | `http://localhost:3000/callback`                                                                                                                                   | OAuth redirect URI for the WHOOP sign-in; must be registered in the WHOOP app. A hosted first sign-in uses `https://<domain>/callback` ([runbook](docs/deploy-railway.md#4-first-whoop-sign-in-on-the-hosted-server)).                            |
| `CALLBACK_HOST`                | `127.0.0.1`                                                                                                                                                        | Interface the temporary sign-in callback server (port 3000) listens on.                                                                                                                                                                           |
| `CALLBACK_TIMEOUT_MS`          | `120000`                                                                                                                                                           | How long the sign-in waits for WHOOP's redirect.                                                                                                                                                                                                  |
| `WHOOP_MCP_TOKEN_DIR`          | `~/.whoop-mcp`; container started as root: `$HOME/.whoop-mcp` (e.g. `/root/.whoop-mcp`, or `/home/node/.whoop-mcp` with `HOME=/home/node`), exported to the server | Absolute path of the folder holding `tokens.json` (0700 folder, 0600 file). A relative path is a startup error. In a container it must be the volume's mount path.                                                                                |
| `HOME`                         | set by the container (`/root` for root)                                                                                                                            | Container entrypoint only: when `WHOOP_MCP_TOKEN_DIR` is unset the token folder is `$HOME/.whoop-mcp` (e.g. `/home/node/.whoop-mcp` on Railway with `HOME=/home/node`), exported to the server, which then runs as `node` with `HOME=/home/node`. |
| `WHOOP_MCP_RUN_AS_ROOT`        | unset                                                                                                                                                              | Container only: `1` makes [docker/entrypoint.sh](docker/entrypoint.sh) keep running as root instead of switching to the `node` user.                                                                                                              |
| `WHOOP_MCP_PRIVACY_MODE`       | `standard`                                                                                                                                                         | `standard` or `aggregate` (see [Privacy modes](#privacy-modes)). Tool arguments cannot change it.                                                                                                                                                 |
| `WHOOP_MCP_DISABLE_RESOURCES`  | unset                                                                                                                                                              | `1` registers no resources (including the guide).                                                                                                                                                                                                 |
| `WHOOP_RATE_LIMIT_PER_MINUTE`  | `60`                                                                                                                                                               | WHOOP requests per minute the whole process allows itself, integer 10-95 (WHOOP's app limit is 100).                                                                                                                                              |
| `WHOOP_WEBHOOKS`               | unset                                                                                                                                                              | `1` enables `POST /webhooks/whoop` on the HTTP transport (needs `WHOOP_CLIENT_SECRET`).                                                                                                                                                           |
| `MCP_TRANSPORT`                | `stdio` (container: `http`)                                                                                                                                        | `stdio`, `http` or `both`.                                                                                                                                                                                                                        |
| `MCP_AUTH_TOKEN`               | required for HTTP                                                                                                                                                  | Static bearer token for `/mcp` and authenticated `/health`. Without `MCP_JWT_SECRET` it also derives the connector signing key.                                                                                                                   |
| `MCP_PORT`                     | `3000`                                                                                                                                                             | HTTP port, integer 0-65535. Takes precedence over `PORT`.                                                                                                                                                                                         |
| `PORT`                         | unset                                                                                                                                                              | HTTP port set by hosts such as Railway, used when `MCP_PORT` is unset.                                                                                                                                                                            |
| `MCP_HOST`                     | `0.0.0.0`                                                                                                                                                          | HTTP listen interface.                                                                                                                                                                                                                            |
| `MCP_ALLOWED_ORIGINS`          | unset                                                                                                                                                              | Comma-separated CORS allowlist.                                                                                                                                                                                                                   |
| `MCP_TRUST_PROXY`              | unset                                                                                                                                                              | `1` trusts one proxy hop: the client IP for rate limits, the auth-failure throttle and logs is the rightmost `X-Forwarded-For` entry. Set it behind Railway, Fly and similar proxies.                                                             |
| `MCP_MAX_CONNECTIONS`          | `16`                                                                                                                                                               | MCP requests handled at once, integer 1-100; up to 32 more wait up to 5 s, then 503.                                                                                                                                                              |
| `LOG_LEVEL`                    | `info`                                                                                                                                                             | `debug`, `info`, `warn` or `error`.                                                                                                                                                                                                               |
| `LOG_FORMAT`                   | `json`                                                                                                                                                             | `json` (one object per line on stderr) or `pretty`.                                                                                                                                                                                               |
| `MCP_CONNECTOR_PASSWORD`       | unset                                                                                                                                                              | At least 12 characters. With `PUBLIC_URL` and `ALLOWED_REDIRECT_URIS` it mounts the OAuth 2.1 connector for claude.ai; it is the password typed on the authorize page.                                                                            |
| `PUBLIC_URL`                   | unset                                                                                                                                                              | The server's public `https://` origin: OAuth issuer and the resource `<PUBLIC_URL>/mcp`.                                                                                                                                                          |
| `ALLOWED_REDIRECT_URIS`        | unset                                                                                                                                                              | Comma-separated exact-match OAuth redirect URIs, e.g. `https://claude.ai/api/mcp/auth_callback`.                                                                                                                                                  |
| `MCP_JWT_SECRET`               | derived from `MCP_AUTH_TOKEN` (HKDF)                                                                                                                               | Connector signing key for access and refresh tokens and for registered client ids and secrets. Set it so rotating `MCP_AUTH_TOKEN` keeps claude.ai connected.                                                                                     |
| `MCP_OAUTH_CLIENT_ID`          | `whoop-mcp-connector`                                                                                                                                              | Id of the connector's static public client (dynamic registration also works).                                                                                                                                                                     |
| `RAILWAY_GIT_COMMIT_SHA`       | set by Railway                                                                                                                                                     | Deployed commit; its first 12 characters appear as `commit` in authenticated `/health` and `get_sync_status`.                                                                                                                                     |
| `SOURCE_COMMIT`                | unset                                                                                                                                                              | The same, for other hosts (used when `RAILWAY_GIT_COMMIT_SHA` is unset).                                                                                                                                                                          |
| `APPDATA`                      | set by Windows                                                                                                                                                     | `setup` finds the Claude Desktop config under it on Windows.                                                                                                                                                                                      |

### Creating a WHOOP Developer App

1. Go to [developer.whoop.com](https://developer.whoop.com)
2. Create a new application
3. Set the **Redirect URI** to `http://localhost:3000/callback` (add `https://<your-domain>/callback` for a hosted server)
4. Set the **Privacy Policy URL** (required by WHOOP) — you can use `https://github.com/shashankswe2020-ux/whoop-mcp` or your own URL
5. Enable the following scopes:
   - `read:profile`
   - `read:recovery`
   - `read:sleep`
   - `read:workout`
   - `read:cycles`
   - `read:body_measurement`
6. Copy the **Client ID** and **Client Secret**

## How the data is read

The same rules hold for every tool; the server also serves them as the
`whoop://server/guide` resource and summarizes them in the MCP `instructions`
sent on connect.

**Local days and cycles.** A WHOOP cycle runs from one sleep onset to the next,
so it usually starts the evening before the day it covers, and the newest cycle
stays open until WHOOP processes the next sleep. Days are the user's local days,
in the UTC offset WHOOP records carry. A cycle is placed on the local day its
main sleep ended; its recovery and main sleep belong to that morning. A workout
counts toward the day of the cycle containing its start: after local midnight
and before the next sleep syncs, strain and workouts still count toward the
previous day, and today has no cycle yet. Today's strain is still accumulating
and the first day of wear is partial; both are flagged and left out of averages.
Day strain is WHOOP's non-linear 0-21 score and is never the sum of workout
strains; cycle energy covers sleep onset to sleep onset.

**Sleep hours** are time asleep (light + slow-wave + REM) on main sleeps. Naps
and time in bed are separate figures.

**Missing and calibrating data.** Unknown values are `null`, never 0. A worn day
without workouts has 0 for workout totals; a day without WHOOP data is null.
Records WHOOP has not scored contribute no values and are counted. Recoveries
WHOOP flags as calibrating (the first weeks of wear) are shown with the flag and
left out of baselines, deviations and associations by default. Below a minimum
sample size a value stays null with a status such as `insufficient_data`,
`insufficient_history` or `calibrating` and a note with the count. Analysis
tools return `notes`, `warnings`, `truncated`, `data_quality` (per-source
status, fetch time and cache status, periods in local time) and a disclaimer.

**Date expressions.** Collection tools, `get_calendar`, `get_sleep_debt`,
`get_sleep_analysis`, `get_workout_log`, `get_sport_breakdown` and
`export_health_data` accept these (case-insensitive), resolved at local
midnight in the user's offset:

| Expression                          | Meaning                                             |
| ----------------------------------- | --------------------------------------------------- |
| `"today"`, `"yesterday"`            | That local day                                      |
| `"last N days"` (1–365)             | Today plus the N previous days                      |
| `"last N weeks"` (1–52)             | Today plus the previous N × 7 days                  |
| `"last N months"` (1–12)            | From the same date N calendar months ago to today   |
| `"this week"` / `"last week"`       | Monday to today / the previous Monday to Sunday     |
| `"this month"` / `"last month"`     | The 1st to today / the whole previous month         |
| `"this quarter"` / `"last quarter"` | Quarter start to today / the whole previous quarter |
| `"last year"`                       | 1 January to 31 December of the previous year       |
| `"YYYY-MM"`                         | That calendar month                                 |
| `YYYY-MM-DD`                        | That local day                                      |
| ISO 8601 date-time                  | That instant (an offset may be included)            |

## Tools

The reference below was checked against `tools/list` of a real server
(`npx tsx scripts/print-tools.mts --markdown` prints it for both privacy modes).
Every tool is read-only, advertises an output schema and returns the same JSON
as text and as `structuredContent`. The 16 original tools return pretty JSON;
the 12 tools added in 0.8.0 return compact JSON and keep every result within
100,000 characters (a larger result is an error that asks for fewer days, a
lower limit or fewer datasets). "WHOOP calls" lists the endpoints a tool reads;
tools that read history load it in cached 30-day chunks within a per-call budget
of 60 pages and 20 seconds (see [Rate limits](#rate-limits-and-history-loading)).

**Today and single days:** `get_today`, `get_day`, `get_calendar`, `get_sync_status`
· **Weeks and periods:** `get_weekly_summary`, `compare_periods`, `get_trend`, `get_baselines`
· **Training:** `get_training_load`, `get_sport_breakdown`, `get_workout_log`, `get_workout_context`, `get_personal_records`
· **Sleep and recovery:** `get_sleep_analysis`, `get_sleep_debt`, `get_sleep_need`, `get_recovery_analysis`, `get_recovery_drivers`
· **Export:** `export_health_data`
· **Raw records:** `get_recovery_collection`, `get_sleep_collection`, `get_workout_collection`, `get_cycle_collection`, `get_sleep_by_id`, `get_workout_by_id`, `get_cycle_by_id`, `get_profile`, `get_body_measurement`

---

### `get_today`

**Answers:** How am I doing today? One call for today's recovery, last night's sleep, strain so far and the latest workout.

**Inputs:** none.

**Returns:** `recovery` (score, `zone` green/yellow/red, HRV, resting heart rate, SpO2, skin temperature, `user_calibrating`), `sleep` (`asleep_hours`, `time_in_bed_hours`, stages, performance, efficiency, `disturbances`, `sleep_cycles`, `no_data_hours`, `consistency_pct`, `need_hours_including_debt`), `strain` (day strain so far, energy, heart rate, `last_workout` with `percent_recorded`), a plain-language `summary`, `notes` and `data_quality` with local-time periods, per-source status, fetch time and cache status.

**Missing data:** today is the open WHOOP cycle; sleep and recovery are the ones linked to it. If no newer sleep has been processed, the latest sleep and recovery are still returned with source status `stale` and a note giving their date. A section is null when its data is not available yet or could not be fetched. `consistency_pct` is null while WHOOP is calibrating and reports 0; a calibrating recovery is provisional. `sleep.total_hours` keeps its 0.7.0 meaning (time in bed).

**WHOOP calls:** the latest page of `/v2/cycle`, `/v2/recovery`, `/v2/activity/sleep` and `/v2/activity/workout`, cached together for 2 minutes (refetched once when a new cycle has no synced sleep in the cached list).

---

### `get_day`

**Answers:** What happened on one local day?

**Inputs:** `date` (`YYYY-MM-DD`, `"today"` or `"yesterday"`; default today; ranges are rejected) or `cycle_id` (the day that cycle is placed on); `include_timeline` (boolean, default false).

**Returns:** `status` (`complete`, `in_progress`, `no_cycle_yet`, `records_without_cycle`, `no_data`), `cycle` (start/end, `cycle_hours`, day strain, energy, heart rate, `partial_first_day`), `recovery` (score, zone, HRV, RHR, SpO2, skin temperature, `calibrating`, `held_back`), `sleep` (stages, shares, efficiency, performance, consistency, WHOOP sleep need components, `asleep_minus_need_hours`), `naps`, `workouts` (zones, TRIMP, GPS pace; at most 25) with `workout_totals`, `previous_day`, `next_morning` recovery and an optional `timeline` (at most 60 events).

**Missing data:** after local midnight and before the next sleep syncs, today is `no_cycle_yet` and its strain still counts toward the previous day. A recovery is held back while its sleep is still being scored. Workouts after midnight before the next sleep appear on the earlier day. On the first day of wear WHOOP starts the first cycle at local midnight, and the timeline labels that start as such instead of as sleep onset. `next_morning.status` is `available`, `pending`, `not_yet`, `missing` or `unavailable`. Energy covers the whole cycle.

**WHOOP calls:** cycles, sleeps, recoveries and workouts from two days before to two days after the day (history loader); `/v2/cycle/{id}` with `cycle_id`.

---

### `get_calendar`

**Answers:** How did recovery, sleep and strain look day by day?

**Inputs:** `days` (1-90, default 7); `start` (a range expression shows that range, at most its last 90 days; a single day or date-time starts the grid and it runs forward `days` days, clamped to today).

**Returns:** `days` rows (recovery score and zone, `recovery_calibrating`, `sleep_hours` asleep, sleep performance, day strain with `day_strain_in_progress` and `day_strain_partial`), `averages` with `sample_sizes`, `period`, `notes`, `warnings`, `truncated`.

**Missing data:** missing or unscored values are null; today's in-progress strain and a partial first day are left out of `averages.strain`. When two cycles belong to one day the row keeps the better main sleep and a warning names the other. A stream that fails to load degrades its column only.

**WHOOP calls:** `/v2/recovery`, `/v2/activity/sleep` and `/v2/cycle` over the grid plus one day on each side (paginated).

---

### `get_sync_status`

**Answers:** Is my WHOOP data up to date, and why is today's data missing?

**Inputs:** none.

**Returns:** `assessment` (`up_to_date`, `sleep_not_processed_yet`, `strap_not_synced`, `no_data_yet`, `unavailable`), `latest` (state and local times of the newest cycle, main sleep, recovery and workout, hours since update or end, whether sleep and recovery link to the newest cycle), `history` (`first_cycle_date` and `days_with_cycles` for accounts under 90 days, `more_than_90_days`), `server` (version, commit, privacy mode, connector and webhook state, token expiry, last refresh outcome, WHOOP requests in the last minute and rate-limited responses), `notes`. No health values.

**Aggregate mode:** only `evaluated_on`, `assessment` (`connected`, `no_data_yet`, `unavailable`), `released_weeks` (`latest_week_start`, `weeks_with_data_last_13`), `history.more_than_90_days` and a server block without timestamps or request counts.

**WHOOP calls:** the latest page of cycles, sleeps, recoveries and workouts (cached 2 minutes), 90 days of cycles (history loader) and one older-cycle probe (cached 10 minutes).

---

### `get_weekly_summary`

**Answers:** How did one Monday-to-Sunday week go?

**Inputs:** `week_start` (any day in the week, snapped to its local Monday; `YYYY-MM-DD`, a date-time, `"today"`, `"yesterday"`, `"this week"`, `"last week"`; default the current week).

**Returns:** `recovery` (average, min and max score, average HRV and RHR, trend), `sleep` (average hours asleep on main sleeps, performance, efficiency), `workouts` (count, `total_strain` as the sum of workout strain, `total_calories_kj`, sport breakdown), `strain` (average and max daily strain), `sample_sizes`, `calibrating`, `notes`, `warnings`. Averages are rounded (scores, HRV and RHR 1 dp, hours 2 dp, percentages 1 dp, strain 2 dp, kJ 0 dp).

**Missing data:** values that cannot be computed are null with the reason in notes; workout totals are null for a week without any WHOOP data and 0 for a worn week without workouts. The recovery trend needs 4 scored days. Calibrating recoveries are included and flagged. A workout counts on the day of the cycle containing its start (after-midnight workouts count toward Sunday of the earlier week); without a containing cycle it uses its local start day, noted.

**Aggregate mode:** only released weeks (two days after they end), each average from at least 3 samples, calibrating recoveries not used, no min/max, rounded (workout `total_strain` to 1 and `total_calories_kj` to 100).

**WHOOP calls:** cycles, sleeps, recoveries and workouts from two days before Monday to two days after Sunday.

---

### `compare_periods`

**Answers:** How does one period compare with another?

**Inputs:** `period_a_start`, `period_a_end`, `period_b_start`, `period_b_end` (ISO dates or date-times; periods of up to 90 days that must not overlap).

**Returns:** `period_a`/`period_b` with the local days counted, `recovery`, `sleep` (hours asleep) and `strain` (completed cycles, without the partial first day of wear) averages with counts, `change_pct` and `direction`, and `training` (sessions, sessions per week, workout minutes and Edwards TRIMP per worn day, with direction from TRIMP).

**Missing data:** with fewer than 3 scored days in either period, `change_pct` is null and `direction` is `insufficient_data`. Training means need 7 worn days in both periods; `training` is null when workouts could not be loaded. A local day counts in the period holding most of it.

**Aggregate mode:** each period snaps inward to whole released weeks; no `training` block; changes in whole percent.

**WHOOP calls:** recoveries, sleeps and cycles for each period; workouts for the training block.

---

### `get_trend`

**Answers:** Is one metric going up or down?

**Inputs:** `metric` (`recovery`, `hrv`, `rhr`, `sleep_duration`, `sleep_performance`, `strain`, `sleep_efficiency`, `respiratory_rate`, `rem_share`, `deep_share`, `disturbances_per_hour`, `sleep_consistency`, `sleep_debt`, `spo2`, `skin_temp`); `days` (7-90, default 30, today included).

**Returns:** values oldest first with local dates, `statistics`, `trend` (`slope` per day, `change`, `direction` improving/declining when the metric has a better direction, `confidence` from R² capped by sample size), `anomalies`, `notes`.

**Missing data:** fewer than 4 points gives `insufficient_data` with null trend fields. `sleep_efficiency`, `rem_share`, `deep_share`, `disturbances_per_hour` and `sleep_debt` skip low-data-coverage nights; `sleep_consistency` skips WHOOP's 0 while calibrating; `spo2` and `skin_temp` need WHOOP 4.0 or later. `strain` leaves out the open cycle and the partial first day of wear. `statistics.std_dev` is the sample standard deviation (n-1).

**Aggregate mode:** `days` rounds up to 1, 2, 4, 8 or 13 released weeks; only sample size, mean, standard deviation and the trend.

**WHOOP calls:** the metric's source over the window: recoveries, sleeps (with recoveries for consistency) or cycles.

---

### `get_baselines`

**Answers:** What is normal for me?

**Inputs:** `baseline_days` (14-180, default 30).

**Returns:** per metric (HRV, RHR, respiratory rate, hours asleep, recovery, SpO2, skin temperature, sleep efficiency, disturbances per hour, REM share, deep share) a band with sample size, mean, median, sample standard deviation (n-1), percentiles and the latest observation's percentile; `metric_status` per metric; `period`.

**Missing data:** the latest observation and today are excluded, so `baseline_days + 2` days are read. Each band needs 14 earlier values; until then `metric_status` is `calibrating`, `insufficient_data`, `not_reported` or `unavailable` with counts. Calibrating recoveries are not used.

**Aggregate mode:** 2, 4, 8, 13 or 26 released weeks; no latest observation, p10 or p90.

**WHOOP calls:** recoveries, sleeps and cycles over the window.

---

### `get_sleep_debt`

**Answers:** How far did nightly sleep fall short of WHOOP's need, and how regular were bedtimes?

**Inputs:** `days` (3-90, default 14); `start` (a day or range expression).

**Returns:** `nights` (asleep hours against need excluding debt, deficit), `total_debt_hours` (sum of deficits, not outstanding debt), `avg_nightly_debt_hours`, `standing_debt_hours` with its date, `consistency` (bedtime and wake-time spread, social jetlag), `status`, `period`, `notes`.

**Missing data:** totals and consistency need 3 scored main sleeps; `consistency.social_jetlag_minutes` also needs 2 weekday and 2 weekend nights (3 and 3 in aggregate mode), otherwise it is null with a note. `status` `unavailable` means sleeps could not be read. At most 30 nights are listed (`output_capped`).

**Aggregate mode:** 2, 4, 8 or 12 released weeks; no nights, standing debt or summary.

**WHOOP calls:** sleeps over the window.

---

### `get_training_load`

**Answers:** How is my training load changing?

**Inputs:** `load_metric` (`trimp` default, `day_strain`, `workout_minutes`, `workout_kj`); `days` (14-180, default 42).

**Returns:** `days` series ending at the last completed WHOOP day (worn, partial, in progress, sessions, minutes, TRIMP, kJ, day strain, load), `acute_chronic` (7-day and 28-day means, ratio, `available_from_day`), `ewma` (ATL, CTL, TSB) seeded from the mean of the first 28 known daily loads (`ewma_seed`), Foster `monotony`, local ISO `weeks` with week-over-week change, `load_by_sport_28d`, `today_so_far`, `history`, `status`.

**Missing data:** days are placed as in `get_calendar`, including nights split across two cycles. Worn days without workouts count as 0 and unworn days as null. Until 28 worn days exist the status is `insufficient_history` with `available_from_day`. TRIMP is null for a day with a session below 90% recorded. Descriptive only: no risk zones or advice.

**Aggregate mode:** `weeks` (4-26, default 8) of released weeks with rounded weekly sessions, minutes, TRIMP, kJ and mean day strain, week-over-week change and a weekly acute:chronic ratio; a week's workout values need 3 scored sessions and its day strain 3 completed cycles.

**WHOOP calls:** cycles, sleeps (to place days) and workouts from `days + 44` days before the last completed day, plus one older-cycle probe.

---

### `get_sport_breakdown`

**Answers:** How much of what did I train?

**Inputs:** `days` (7-365, default 30); `start`; `sport` (exact WHOOP sport name, case-insensitive); `min_recorded_fraction` (0-1).

**Returns:** per sport: sessions, sessions per week, duration, strain, energy, weighted heart rate, WHOOP %max-HR zone minutes and shares, Edwards TRIMP, GPS distance, time-weighted pace and a beats-per-km efficiency trend; `overall` with shares by sport, the zone 1-5 intensity distribution and time of day sessions start.

**Missing data:** means, medians and maxima need 3 sessions (`few_sessions`); sessions below 90% recorded are left out of heart-rate values; unscored sessions are excluded and counted. An unknown sport lists the available ones.

**Aggregate mode:** `block_offset` (1-26) selects a released 4-week block; sports with fewer than 3 sessions are pooled as `other` (a `sport` filter answers a pooled sport exactly like one that does not exist); totals that could isolate fewer than 3 sessions by subtraction are withheld; no extremes, medians, efficiency or time of day.

**WHOOP calls:** workouts, cycles and sleeps (to place sessions on days, as `get_calendar` does) over the window; for windows too long to read every sleep within the request budget (about 300 days and more), sleeps only around the cycles whose day depends on them, with a note.

---

### `get_workout_log`

**Answers:** Which workouts did I do, filtered and sorted?

**Inputs:** `days` (1-365, default 14); `start`; `sport` (list of names); `min_strain`; `min_duration_minutes`; `has_gps`; `min_distance_km`; `sort` (`newest`, `oldest`, `strain`, `duration`, `trimp`, `distance`, `pace`, `high_intensity`); `include_unscored`; `limit` (1-50, default 25).

**Returns:** `workouts` (day vs `local_date`, duration, recorded fraction, strain, kJ/kcal, heart rate, zone minutes, TRIMP, GPS distance and elapsed pace, flags), `totals` over every match, `total_matching`, `returned`, `available_sports`.

**Missing data:** unscored sessions are hidden unless `include_unscored` (then with null score fields). `pace` sorting lists only plausible GPS sessions. Missing values sort last. Sessions are placed on days with cycles and sleeps, as in `get_calendar`.

**WHOOP calls:** `/v2/activity/workout`, `/v2/cycle` and `/v2/activity/sleep` over the window.

---

### `get_workout_context`

**Answers:** How did one session fit into my day and what followed it?

**Inputs:** `id` (workout id); `compare_days` (14-365, default 90).

**Returns:** `workout`, `day` (the WHOOP day it counts toward, day strain once the cycle ended, other sessions), `before` (that morning's recovery), `after` (the next night's sleep hours, performance, efficiency and strain-driven need, the next recovery, hours from session end to sleep onset), `comparison` (percentiles against earlier sessions of the same sport and typical values).

**Missing data:** `after.status` is `not_yet` while the cycle is open or no cycle follows, `pending` while WHOOP scores the night, `missing` or `unavailable` otherwise. Each percentile needs 5 earlier sessions; heart-rate metrics use sessions recorded at least 90%. One night after one session is a single observation.

**WHOOP calls:** `/v2/activity/workout/{id}`, then cycles, sleeps and recoveries around the session and workouts over `compare_days`.

---

### `get_personal_records`

**Answers:** What are my bests per sport?

**Inputs:** `sport`; `days` (30-1095, default 365); `recent_days` (1-60, default 7).

**Returns:** per sport: longest session, most kJ, highest strain, highest TRIMP, most zone 4-5 minutes, highest max heart rate, farthest distance, most elevation gain and fastest average pace over sessions of at least 1 km, 5 km, 10 km, a half marathon and a marathon; each with session id, local day, previous best and improvement; `recent_records`; `max_hr_check` against WHOOP's body max heart rate; `period.history_complete`.

**Missing data:** sports with fewer than 3 scored sessions are `few_sessions` (no previous best). Pace is whole-session elapsed pace, not splits; implausible GPS is excluded. Records are never called all-time unless `history_complete` is true.

**WHOOP calls:** `/v2/activity/workout`, `/v2/cycle` and `/v2/activity/sleep` (to place sessions on days) over the window, one older-workout probe and `/v2/user/measurement/body` (cached 1 hour).

---

### `get_sleep_analysis`

**Answers:** What do my nights look like?

**Inputs:** `days` (3-90, default 14); `start`; `include_nights` (default true); `include_naps` (default true).

**Returns:** distributions (n, mean, median, quartiles, SD) of hours asleep and in bed, efficiency, performance, consistency, disturbances per hour, sleep cycles and respiratory rate; time-weighted stage shares of time asleep; means of WHOOP's sleep-need components; bedtime and wake-time consistency; naps separately; one row per night (newest 31); `pending_dates` and `excluded` counts.

**Missing data:** only scored nights count; with fewer than 3 the status is `insufficient_data` and statistics are null. Low-data-coverage nights are flagged and left out of duration and stage statistics. `naps.total_asleep_hours` is null when any nap in the window is unscored.

**WHOOP calls:** sleeps and recoveries over the window.

---

### `get_sleep_need`

**Answers:** About how much sleep will WHOOP say I need next?

**Inputs:** `history_days` (21-120, default 60); `wake_time` (`HH:MM`, 24-hour local).

**Returns:** `label` (a statistical estimate, not WHOOP Sleep Planner, not a recommendation), `last_night` WHOOP need, `today_so_far` strain, `components` (baseline, debt as a fitted carry fraction, strain from the nearest past strains, naps as 0 or negative), `estimate` with range, selected model and backtest errors; with `wake_time`, `in_bed_arithmetic` (hours in bed at the typical efficiency, latest in-bed start that arithmetic gives, hours until the wake time).

**Missing data:** `estimated` needs 7 pairs of consecutive scored nights for debt, 10 for strain and every component known, and is used only when it beats repeating last night's need; otherwise `insufficient_history` or the persistence model. `no_current_cycle` and `last_night_unavailable` when WHOOP has not processed the cycle or sleep yet.

**WHOOP calls:** sleeps, cycles and recoveries over `history_days`.

---

### `get_recovery_analysis`

**Answers:** How are my recoveries distributed, and which days were unusual for me?

**Inputs:** `days` (7-90, default 30); `baseline_days` (14-60, default 28); `include_days` (default true).

**Returns:** zone counts (calibrating shown per zone), summaries of recovery, HRV, resting heart rate, SpO2, skin temperature and respiratory rate, the 7-day ln(RMSSD) mean and coefficient of variation, weekday patterns, per-day rows (newest 31) with robust z-score deviations from a personal baseline, and days with at least 2 unusual metrics.

**Missing data:** a deviation needs 14 non-calibrating values in the baseline window; |z| ≥ 2 is flagged, which happens on about 5% of days by chance. Weekday values need 4 days each. No clinical thresholds.

**WHOOP calls:** recoveries, cycles and sleeps over `days + baseline_days + 2` days.

---

### `get_recovery_drivers`

**Answers:** Which behaviours go along with better or worse next-morning recovery?

**Inputs:** `days` (30-180, default 90); `outcomes` (`recovery`, `hrv`, `rhr`, `sleep_performance`, `asleep_hours`); `include_calibrating`; `focus` (one behaviour for bucket means); `custom_tags` (up to 3 behaviours the API cannot see, each with up to 180 dates).

**Returns:** `findings` (Spearman or Mann-Whitney tests with effective sample size, 95% CI, p, Benjamini-Hochberg q, strength, `consistent`, `partly_by_construction`, a past-tense sentence), `not_tested_summary` and `not_tested`, `buckets`, `same_day` (day strain by morning recovery zone), `evening_training`, `tags`, `excluded_pairs`, `status`.

**Missing data:** each test needs 14 pairs of nights; the status is `calibrating` or `insufficient_data` until then. `consistent` needs a CI excluding 0 (binary: p ≤ 0.05) and q ≤ 0.10. `partly_by_construction` marks pairs WHOOP derives from shared inputs, including `prior_day_strain` and `nap_before` with `sleep_performance` (sleep performance is measured against a need that strain raises and naps lower). `last_workout_to_bed_min` exists only on days with a workout: with too few such nights it is `too_few_pairs`, not `data_unavailable`. Associations only, not causes and not medical advice.

**WHOOP calls:** cycles, sleeps, recoveries and workouts over `days + 2` days.

---

### `export_health_data`

**Answers:** Give me my data as CSV or JSON.

**Inputs:** `start` (default the last 30 local days); `end` (clamped to today); `datasets` (`daily`, `workouts`, `sleeps`; default daily and workouts); `format` (`csv` default or `json`); `include_naps`.

**Returns:** per dataset `columns`, `row_count` and `csv` text or `rows`; daily rows placed like `get_calendar` (cycle, strain, energy, recovery, HRV, RHR, SpO2, skin temperature, sleep stages, performance, efficiency, consistency, sleep need, nap and workout counts), workout rows on their cycle day, sleep rows by wake day; `first_included_day` and `output_capped`.

**Missing data:** unknown values are empty cells. Output is capped at 60,000 characters keeping the newest days; `first_included_day` and a note give the start for the next export. At most 180 days per call. Cells starting with `=`, `+`, `-`, `@`, tab or CR get a leading apostrophe, except cells that are exactly a UTC offset such as `+02:00`.

**WHOOP calls:** cycles, sleeps, recoveries and workouts over the range plus two days on each side.

---

### `get_recovery_collection`

**Answers:** The raw WHOOP recovery records for a date range.

**Inputs:** `start`, `end` (date expressions), `limit` (1-25, default 10), `nextToken`.

**Returns:** `records` newest first (score, HRV, RHR, SpO2, skin temperature, `user_calibrating`, `cycle_id`, `sleep_id`), `next_token`, optional `notes`.

**Missing data:** records can include neighbouring days (a recovery belongs to the morning of its cycle, and cycles begin the previous evening); use `get_calendar` for one value per local day. `next_token` null means no more pages.

**WHOOP calls:** one page of `/v2/recovery` (plus the latest cycle for the UTC offset when a date depends on it, cached 1 hour).

---

### `get_sleep_collection`

**Answers:** The raw WHOOP sleep records for a date range.

**Inputs:** `start`, `end`, `limit` (1-25, default 10), `nextToken`.

**Returns:** `records` newest first (stage summary, sleep need, respiratory rate, performance, consistency, efficiency, `nap`), `next_token`, optional `notes`.

**Missing data:** includes sleeps still ongoing at the window start; naps are separate records. Time asleep is light + slow-wave + REM.

**WHOOP calls:** one page of `/v2/activity/sleep`.

---

### `get_workout_collection`

**Answers:** The raw WHOOP workout records for a date range.

**Inputs:** `start`, `end`, `limit` (1-25, default 10), `nextToken`.

**Returns:** `records` newest first (sport, strain, heart rate, kilojoule, `percent_recorded` as a 0-1 fraction, zone durations, distance and altitude or null), `next_token`, optional `notes`.

**Missing data:** GPS fields are null for workouts without GPS; unscored workouts have no score.

**WHOOP calls:** one page of `/v2/activity/workout`.

---

### `get_cycle_collection`

**Answers:** The raw WHOOP physiological cycles for a date range.

**Inputs:** `start`, `end`, `limit` (1-25, default 10), `nextToken`.

**Returns:** `records` newest first (start, end or null while open, strain, kilojoule, heart rate), `next_token`, optional `notes`.

**Missing data:** `start` and `end` `"yesterday"` return yesterday's cycle plus today's in-progress cycle, which comes first; check start and end rather than taking the first record.

**WHOOP calls:** one page of `/v2/cycle`.

---

### `get_sleep_by_id`

**Answers:** One sleep record.

**Inputs:** `id` (letters, digits, `-` and `_`).

**Returns:** the WHOOP sleep record. **Missing data:** an unknown id returns WHOOP's 404 as a plain message. **WHOOP calls:** `/v2/activity/sleep/{id}`.

---

### `get_workout_by_id`

**Answers:** One workout record.

**Inputs:** `id` (letters, digits, `-` and `_`).

**Returns:** the WHOOP workout record (`percent_recorded` is a 0-1 fraction). **Missing data:** an unknown id returns WHOOP's 404 as a plain message. **WHOOP calls:** `/v2/activity/workout/{id}`.

---

### `get_cycle_by_id`

**Answers:** One physiological cycle.

**Inputs:** `id` (positive integer).

**Returns:** the WHOOP cycle record. **Missing data:** `end` is null while the cycle is open. **WHOOP calls:** `/v2/cycle/{id}`.

---

### `get_profile`

**Answers:** Whose WHOOP account is connected?

**Inputs:** none. **Returns:** `user_id`, `email`, `first_name`, `last_name`. **WHOOP calls:** `/v2/user/profile/basic`.

---

### `get_body_measurement`

**Answers:** Current height, weight and max heart rate.

**Inputs:** none. **Returns:** `height_meter`, `weight_kilogram`, `max_heart_rate`. **Missing data:** WHOOP keeps only the current values, no history. **WHOOP calls:** `/v2/user/measurement/body`.

---

## Resources

Resources give ambient context without a tool call. They are standard-mode only,
except the guide, which exists in both modes. `WHOOP_MCP_DISABLE_RESOURCES=1`
removes all of them.

| Resource URI                      | Description                                                                                                                                                 | Cache |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `whoop://v2/user/recovery/latest` | Most recent recovery; notes say when it belongs to an earlier cycle, is not scored yet or WHOOP is calibrating                                              | 2 min |
| `whoop://v2/user/sleep/latest`    | Most recent main sleep; notes say when it belongs to an earlier cycle                                                                                       | 2 min |
| `whoop://v2/user/cycle/latest`    | Current or most recent cycle (end null while in progress)                                                                                                   | 2 min |
| `whoop://v2/user/workout/latest`  | Most recent finished workout as a normalized summary placed on its day (the wake day of its cycle's main sleep; may read the cached sleep list), with notes | 2 min |
| `whoop://v2/user/profile`         | Profile (name, email)                                                                                                                                       | 1 hr  |
| `whoop://server/guide`            | Markdown guide: which tool for which question, days and cycles, data quality, privacy modes, rate limits, what the API does not provide                     | —     |

## Prompts

| Prompt                 | Arguments                                                      | What it does                                                                                                               |
| ---------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `morning_briefing`     | —                                                              | `get_today`, the past 7 days of `get_recovery_analysis`, and `get_day`/`get_sync_status` only when needed                  |
| `evening_briefing`     | `wake_time` (`HH:MM`)                                          | `get_today`, `get_day` today and `get_sleep_need` (with the wake time when valid)                                          |
| `day_review`           | `date` (`YYYY-MM-DD`, `today`, `yesterday`; default yesterday) | `get_day` with the surrounding 7 days from `get_calendar`                                                                  |
| `weekly_health_review` | `days` (1-90, default 7)                                       | Calendar, weekly summary, baselines and sport breakdown for the period, reported as observations, not recommendations      |
| `sleep_analysis`       | —                                                              | `get_sleep_analysis` and `get_sleep_debt` over 14 days and two sleep trends, against WHOOP's own nightly need              |
| `recovery_trend`       | —                                                              | `get_recovery_analysis` over 30 days, baselines and recovery, HRV and RHR trends                                           |
| `recovery_drivers`     | `outcome`, `focus` (allowlisted)                               | `get_recovery_drivers`, reporting status and counts first and only consistent findings with n and CI                       |
| `workout_recap`        | —                                                              | Sport breakdown over 14 days, training load over 28 days and the workout log                                               |
| `session_debrief`      | `workout_id`                                                   | `get_workout_context` for the id, or for the newest workout from `get_workout_log`                                         |
| `training_load_check`  | —                                                              | `get_training_load` and 28 days of `get_sport_breakdown`, described neutrally                                              |
| `health_check`         | —                                                              | The latest recovery, sleep and cycle resources with `get_today` as fallback, reported as observations, not recommendations |
| `data_status_check`    | —                                                              | `get_sync_status` and a plain explanation                                                                                  |
| `export_my_data`       | `days` (1-180, default 30), `format` (`csv`/`json`)            | `export_health_data`, stating period, row counts, cap and truncation                                                       |
| `aggregate_overview`   | `weeks` (2-13, default 4)                                      | Aggregate mode only: the latest released week, trends, the last two released weeks compared and weekly training load       |

Prompt arguments are free text in MCP; the server writes them into a prompt
only after an allowlist, pattern or clamp check (anything else falls back to the
default or is left out). Every prompt carries guidance on reading the data
(nulls, calibrating recoveries, local days); the training and day prompts add
guidance on strain, TRIMP, load ratios, associations and truncated history.

## Privacy modes

`WHOOP_MCP_PRIVACY_MODE` is a process setting (tool arguments cannot change it).

- **standard** (default): every tool, resource and prompt below.
- **aggregate**: only weekly aggregates. Windows snap to whole released local
  weeks: a Monday-to-Sunday week is released two days after it ends
  (Wednesday 00:00 local), so the current week and last week before Wednesday
  are never shown. A week with a cycle still open or a record still being
  scored is withheld. A week counts toward a value only with at least 3 samples
  (recoveries, nights, completed cycles or sessions), calibrating recoveries are
  not used, and values are rounded. Per-day values, individual records, latest
  observations, exact activity times, record resources and record prompts are
  not available. `get_sync_status` is reduced to released-week facts.
  `data_quality` counts only records placed in released weeks.

Aggregate mode minimizes disclosure; it is not anonymization and still sends
health aggregates to the assistant provider.

Released values are recomputed from WHOOP on every call. An edit in WHOOP to a
record in an already released week (a deleted workout, a changed sleep)
changes that week's released values on the next call, and comparing outputs
from before and after the edit reveals that record's contribution to within the
rounding step. The 2-day release lag covers late syncs only, not later edits.

| Name                                                                                                                                                                                                                                                   | Kind     | standard | aggregate                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | -------- | --------------------------------------------------------- |
| `get_today`                                                                                                                                                                                                                                            | tool     | yes      | —                                                         |
| `get_day`                                                                                                                                                                                                                                              | tool     | yes      | —                                                         |
| `get_calendar`                                                                                                                                                                                                                                         | tool     | yes      | —                                                         |
| `get_sync_status`                                                                                                                                                                                                                                      | tool     | yes      | minimal: released weeks, no timestamps or request counts  |
| `get_weekly_summary`                                                                                                                                                                                                                                   | tool     | yes      | released weeks only                                       |
| `compare_periods`                                                                                                                                                                                                                                      | tool     | yes      | periods snapped to released weeks, no training block      |
| `get_trend`                                                                                                                                                                                                                                            | tool     | yes      | 1-13 released weeks, statistics and trend only            |
| `get_baselines`                                                                                                                                                                                                                                        | tool     | yes      | 2-26 released weeks, no latest observation, p10 or p90    |
| `get_sleep_debt`                                                                                                                                                                                                                                       | tool     | yes      | 2-12 released weeks, no nights or standing debt           |
| `get_training_load`                                                                                                                                                                                                                                    | tool     | yes      | released weekly totals, no daily values, EWMA or monotony |
| `get_sport_breakdown`                                                                                                                                                                                                                                  | tool     | yes      | released 4-week blocks, small sports pooled, no extremes  |
| `get_workout_log`                                                                                                                                                                                                                                      | tool     | yes      | —                                                         |
| `get_workout_context`                                                                                                                                                                                                                                  | tool     | yes      | —                                                         |
| `get_personal_records`                                                                                                                                                                                                                                 | tool     | yes      | —                                                         |
| `get_sleep_analysis`                                                                                                                                                                                                                                   | tool     | yes      | —                                                         |
| `get_sleep_need`                                                                                                                                                                                                                                       | tool     | yes      | —                                                         |
| `get_recovery_analysis`                                                                                                                                                                                                                                | tool     | yes      | —                                                         |
| `get_recovery_drivers`                                                                                                                                                                                                                                 | tool     | yes      | —                                                         |
| `export_health_data`                                                                                                                                                                                                                                   | tool     | yes      | —                                                         |
| `get_recovery_collection`                                                                                                                                                                                                                              | tool     | yes      | —                                                         |
| `get_sleep_collection`                                                                                                                                                                                                                                 | tool     | yes      | —                                                         |
| `get_workout_collection`                                                                                                                                                                                                                               | tool     | yes      | —                                                         |
| `get_cycle_collection`                                                                                                                                                                                                                                 | tool     | yes      | —                                                         |
| `get_sleep_by_id`                                                                                                                                                                                                                                      | tool     | yes      | —                                                         |
| `get_workout_by_id`                                                                                                                                                                                                                                    | tool     | yes      | —                                                         |
| `get_cycle_by_id`                                                                                                                                                                                                                                      | tool     | yes      | —                                                         |
| `get_profile`                                                                                                                                                                                                                                          | tool     | yes      | —                                                         |
| `get_body_measurement`                                                                                                                                                                                                                                 | tool     | yes      | —                                                         |
| `whoop://v2/user/recovery/latest`                                                                                                                                                                                                                      | resource | yes      | —                                                         |
| `whoop://v2/user/sleep/latest`                                                                                                                                                                                                                         | resource | yes      | —                                                         |
| `whoop://v2/user/cycle/latest`                                                                                                                                                                                                                         | resource | yes      | —                                                         |
| `whoop://v2/user/workout/latest`                                                                                                                                                                                                                       | resource | yes      | —                                                         |
| `whoop://v2/user/profile`                                                                                                                                                                                                                              | resource | yes      | —                                                         |
| `whoop://server/guide`                                                                                                                                                                                                                                 | resource | yes      | yes (aggregate edition)                                   |
| `morning_briefing`, `evening_briefing`, `day_review`, `weekly_health_review`, `sleep_analysis`, `recovery_trend`, `recovery_drivers`, `workout_recap`, `session_debrief`, `training_load_check`, `health_check`, `data_status_check`, `export_my_data` | prompts  | yes      | —                                                         |
| `aggregate_overview`                                                                                                                                                                                                                                   | prompt   | —        | yes                                                       |

`tests/aggregate-cross-tool.test.ts` collects every released linear value of all
8 aggregate tools over their argument grids on three 120-day accounts, confirms
each against a reconstruction from the records, and checks by Gaussian
elimination that no single record, no sum of two records and no rounded
combination can be recovered. Not covered by that linear check: standard
deviations, baseline medians and quartiles (order statistics of at least 14
samples), change percentages, zone shares, weighted heart rate and circular
bedtime statistics.

## Rate limits and history loading

- WHOOP limits an app to **100 requests per minute** and **10,000 per day**.
- The server paces **every WHOOP request of the process** with one limiter:
  60 per minute by default (`WHOOP_RATE_LIMIT_PER_MINUTE`, 10-95), bursts of
  20, at most 4 at a time. A 429 pauses all requests for WHOOP's `Retry-After`
  (2 s without one, at most 60 s) and the request is retried up to 3 times.
  When WHOOP reports 2 or fewer remaining requests, the limiter waits for the
  reset. Daily requests are counted (`whoopRate.requestsTodayUtc` in
  authenticated `/health`) but not capped.
- Tools that read history load it in **30-day chunks** into an in-memory cache
  (500 entries): 2 minutes for chunks within the last 3 days, 60 minutes for
  older chunks, 6 hours for chunks older than 30 days. One tool call reads at
  most 60 pages within 20 seconds. When it stops early the result has
  `truncated: true` and a note; **repeating the call continues from the
  cache**, so a year of history fills in over a few calls without exceeding
  WHOOP's limit.
- When the limiter cannot give a request a slot before the call's deadline,
  the tool says: "The server paused WHOOP requests to stay within WHOOP's
  per-minute request limit; retry in a minute or request a shorter period."
- A WHOOP token refresh keeps the history chunks (the user cannot change
  without a restart) and clears everything else.

## Caching and webhooks

The shared cache serves `get_today`, the resources and history chunks. Cache
keys are request paths with sorted query parameters (never tokens); identical
concurrent requests share one fetch. Date-range collection tools are not cached.

Records from the last 3 days, including today's, may come from a cache entry up
to 2 minutes old. When one tool call reads several data types and they were
read at different times around a WHOOP sync (for example a cycle cached before
waking next to a fresh sleep), the older ones are re-read once; if that does not
fit the call's budget, a warning says so.

WHOOP webhooks (opt-in, HTTP transport) make edits appear before the cache
expires:

1. Set `WHOOP_WEBHOOKS=1` (and `WHOOP_CLIENT_SECRET`).
2. In the WHOOP developer dashboard set the webhook URL to
   `https://<your-domain>/webhooks/whoop` (model version v2).

Deliveries are verified with HMAC-SHA256 over the timestamp and raw body
using `WHOOP_CLIENT_SECRET` (or `WHOOP_CLIENT_SECRET_PREVIOUS` during a
rotation), must be at most 2 hours old or 5 minutes ahead and at most 16 KB,
and are limited to 120 per minute per IP. A valid event **only clears cache
entries**: workout events clear workouts and cycles, sleep events clear sleeps,
cycles and recoveries, recovery events clear recoveries. WHOOP sends no cycle
events. Nothing is stored and no MCP client is notified. Responses: 204 (also
for a duplicate `trace_id` within 2 hours), 401 invalid signature or timestamp,
400 invalid payload, 413 too large, 404 when webhooks are disabled.

## Write operations

The server is read-only: WHOOP exposes no public write endpoints for health
data, and no MCP tool writes or deletes anything. `src/tools/write-safety.ts`
keeps a two-phase preview/confirm pattern (`withPreview`) with idempotency keys
for any future write tool. Revoking the app's access is the human-only `revoke`
command below.

## Logging

Logs are JSON lines on stderr (`LOG_FORMAT=pretty` for local reading) with
`ts`, `level` and `msg`; keys named like tokens, secrets, passwords or
authorization are redacted. Tool and request logs never contain argument values,
record values, health data, WHOOP response bodies or tokens.

| Message                                                                                       | Level                                                                                                                                           | Fields                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mcp request`                                                                                 | info                                                                                                                                            | `requestId`, `rpcMethod`, `tool`, `batchSize`, `status`, `durationMs`, `auth` (`static`/`oauth`), `clientId`, `aborted`                                                                                                                                                                                         |
| `tool call ok`                                                                                | debug                                                                                                                                           | `tool`, `durationMs`, `requestId`, `argKeys`, `privacyMode`                                                                                                                                                                                                                                                     |
| `tool call failed`                                                                            | info (invalid input, WHOOP 400/404), warn (WHOOP 401/403/429/5xx, network, rate budget, output too large), error (contract violation, internal) | `tool`, `durationMs`, `requestId`, `outcome` (`invalid_input`, `upstream_error`, `contract_violation`, `output_too_large`, `internal_error`), `errorClass`, `httpStatus`, `refreshStatus`, `causeChain`, `contractIssues` (field paths and codes), `chars`, `stackFrames` (file:line), `argKeys`, `privacyMode` |
| `whoop api request`                                                                           | debug                                                                                                                                           | `endpoint` (route template such as `/v2/activity/workout/:id`, no ids or query), `status`, `durationMs`                                                                                                                                                                                                         |
| `whoop api rate limited`                                                                      | warn                                                                                                                                            | `endpoint`, `attempt`, `retryAfterMs`                                                                                                                                                                                                                                                                           |
| `whoop api timeout`, `whoop api network error`                                                | error                                                                                                                                           | `endpoint`, `durationMs`, `errorClass`                                                                                                                                                                                                                                                                          |
| `whoop rate limiter paused`                                                                   | warn (at most once a minute)                                                                                                                    | `waitMs`, `queued`                                                                                                                                                                                                                                                                                              |
| `whoop token refreshed`                                                                       | info                                                                                                                                            | —                                                                                                                                                                                                                                                                                                               |
| `whoop token refresh failed`                                                                  | warn                                                                                                                                            | `status` or `errorClass`, `outcome`                                                                                                                                                                                                                                                                             |
| `whoop token refresh failed at startup; retrying`                                             | warn                                                                                                                                            | `status` or `errorClass`, `attempt`, `delayMs`                                                                                                                                                                                                                                                                  |
| `whoop token refresh unavailable at startup; serving with stored tokens`                      | error                                                                                                                                           | `status` or `errorClass`, `outcome`                                                                                                                                                                                                                                                                             |
| `whoop token save failed`, `whoop token store update failed`, `whoop token store read failed` | error                                                                                                                                           | `code`                                                                                                                                                                                                                                                                                                          |
| `resource read failed`                                                                        | warn                                                                                                                                            | `uri`, `errorClass`, `httpStatus`                                                                                                                                                                                                                                                                               |
| `whoop webhook` / `whoop webhook rejected`                                                    | info / warn                                                                                                                                     | `type`, `duplicate`, `invalidated`, `requestId` / `reason`, `requestId`                                                                                                                                                                                                                                         |
| `mcp request failed`, `http request failed`                                                   | error                                                                                                                                           | `requestId`, `errorClass`, `stackFrames`                                                                                                                                                                                                                                                                        |
| `http transport listening`                                                                    | info                                                                                                                                            | `port`, `host`, `maxConnections`, `allowedOriginsCount`, `oauthMounted`, `webhooksEnabled`                                                                                                                                                                                                                      |
| `oauth connector mounted`                                                                     | info                                                                                                                                            | `publicUrl`                                                                                                                                                                                                                                                                                                     |
| `unhandled promise rejection`                                                                 | error                                                                                                                                           | `errorClass`                                                                                                                                                                                                                                                                                                    |

WHOOP request lines name the endpoint as a route template (for example
`/v2/activity/workout/:id`), never record ids, dates or query parameters.
`tool call failed` uses `invalid_input` only for a date expression that cannot
be parsed; any other `RangeError` or `ZodError` inside a tool is an
`internal_error` logged at level error with `stackFrames`. Every `/mcp` response carries an
`X-Request-Id` header matching `requestId`. The container entrypoint writes its
own `entrypoint: ...` lines in the same format.

## Local diagnostics and account commands

```sh
whoop-ai-mcp doctor          # or: node dist/index.js doctor --json
```

Checks runtime, configuration presence, privacy and transport settings and
token-file metadata (in `WHOOP_MCP_TOKEN_DIR` when set) without reading token
contents, calling WHOOP, launching OAuth or writing files. Exit codes: 0 =
locally ready, 1 = remediation needed, 2 = invalid arguments. POSIX private
permissions are checked; Windows ACL privacy is not verified.

```sh
whoop-ai-mcp revoke --yes [--keep-tokens]
```

Revokes this app's access to the WHOOP account (`DELETE /v2/user/access`) and
deletes `tokens.json` unless `--keep-tokens`. Without `--yes` it only explains
what it would do and sends nothing. It is a human-only command and never an MCP
tool. Stop the running service first: a refresh here rotates the refresh token
the service uses.

## Authentication

`whoop-ai-mcp` uses the OAuth 2.0 Authorization Code flow with PKCE:

1. **First run:** a browser window opens to authorize with WHOOP (the URL is
   also printed to stderr).
2. **Token storage:** access and refresh tokens are saved atomically to
   `tokens.json` in `WHOOP_MCP_TOKEN_DIR`, else `~/.whoop-mcp` (folder 0700,
   file 0600).
3. **Refresh:** an expired access token is refreshed automatically; concurrent
   401s share one refresh, because WHOOP rotates refresh tokens.
4. **Re-authentication:** only when WHOOP refuses the refresh token itself. A
   WHOOP outage, a 429 or rejected app credentials (`invalid_client`) keep the
   tokens: each token-endpoint request times out after 30 seconds, and at
   startup the server retries after 5, 15 and 45 seconds within a 120-second
   budget and then starts with the stored tokens (degraded startup), so
   startup takes at most about 2.5 minutes. A `tokens.json` that exists but
   cannot be read stops startup with an error instead of starting a new
   sign-in.

## Deployment (Docker + Cloud Hosting)

The HTTP transport (`MCP_TRANSPORT=http`) serves MCP over Streamable HTTP so
web and mobile clients (claude.ai connectors) can reach your WHOOP data. Each
`POST /mcp` request gets a fresh stateless server; `GET` and `DELETE /mcp`
return 405.

> **Security warning.** You are exposing your WHOOP data behind a bearer token
> or the connector password. Use a strong random `MCP_AUTH_TOKEN`
> (`openssl rand -hex 32`), deploy only behind TLS, restrict
> `MCP_ALLOWED_ORIGINS`, and treat the host as a single-owner deployment.

Built-in limits: `/mcp` allows 100 requests per minute per client IP (then 429
with `Retry-After`), request bodies up to 1 MB, `MCP_MAX_CONNECTIONS` requests
at once with a short queue (then 503), and, with the connector mounted, 20
failed token verifications per minute per IP (then 429 for further invalid
tokens; a valid token is never refused). Set `MCP_TRUST_PROXY=1` behind a proxy
so these limits see real client IPs (the rightmost `X-Forwarded-For` hop).

**Railway:** follow [docs/deploy-railway.md](docs/deploy-railway.md) — volume,
variables, the first WHOOP sign-in on the hosted server, verification, secret
rotation, degraded startup and rollback.

### Image and container user

- Multi-stage build on `node:22-alpine`; only production dependencies and
  `dist/` in the runtime image; `tini` as PID 1; a health check on `/health`
  with Node's `fetch`; no secrets baked into layers.
- **Container user.** The image has no `USER` line: it starts as root so
  [docker/entrypoint.sh](docker/entrypoint.sh) can prepare the token folder
  (`WHOOP_MCP_TOKEN_DIR`, default and exported `$HOME/.whoop-mcp`) for the
  built-in `node` user (UID 1000). It hands the folder, `tokens.json` and stale
  temp files to `node` (never recursively, 0700/0600), checks that `node` can
  create, rename and delete files there, and runs the server as `node`. If any
  step fails (a read-only volume, storage that refuses `chown`) it logs
  `entrypoint: running as root (<reason>); the server still works, see
docs/deploy-railway.md` and runs as root with the same token folder, like
  images before 0.8.0. `WHOOP_MCP_RUN_AS_ROOT=1` skips the switch. Started with `--user`
  (e.g. `docker run --user 1000`), the entrypoint changes nothing and the
  server uses `$HOME/.whoop-mcp` unless `WHOOP_MCP_TOKEN_DIR` is set.
- **Token volume.** Mount the volume at the token folder. A volume at
  `$HOME/.whoop-mcp` (for example `/home/node/.whoop-mcp` with
  `HOME=/home/node`, the folder 0.7.x used) needs no variable; with any other
  mount path set `WHOOP_MCP_TOKEN_DIR` to exactly that path. A token folder
  without a volume starts a WHOOP sign-in and loses its tokens on every deploy.
- The `Docker smoke` workflow checks these layouts, including Railway's
  (`HOME=/home/node`, volume at `/home/node/.whoop-mcp`), on every change to
  the image.

### Build & run locally

```bash
docker build -t whoop-mcp .

# Run the HTTP server with tokens on a volume
docker run --rm -p 3000:3000 \
  -e MCP_AUTH_TOKEN="$(openssl rand -hex 32)" \
  -e WHOOP_CLIENT_ID="your-client-id" \
  -e WHOOP_CLIENT_SECRET="your-client-secret" \
  -e MCP_ALLOWED_ORIGINS="https://claude.ai" \
  -v whoop-tokens:/data -e WHOOP_MCP_TOKEN_DIR=/data \
  whoop-mcp

# Public health check (never calls WHOOP)
curl http://localhost:3000/health
```

### Fly.io

```bash
fly launch --no-deploy --copy-config --name whoop-mcp-<your-suffix>
fly volumes create whoop_tokens --size 1
fly secrets set \
  MCP_AUTH_TOKEN="$(openssl rand -hex 32)" \
  WHOOP_CLIENT_ID="..." \
  WHOOP_CLIENT_SECRET="..." \
  WHOOP_MCP_TOKEN_DIR=/data \
  MCP_TRUST_PROXY=1
fly deploy
```

Mount the volume at `/data` in `fly.toml`, point the HTTP service at port 3000
and set `force_https = true`. Keep one machine: two instances must never share
a `tokens.json`.

### Other platforms

The image runs anywhere Docker does. Behind a TLS-terminating proxy set
`MCP_TRUST_PROXY=1`; give the token folder a persistent volume; run a single
instance.

### Connect claude.ai (OAuth 2.1 connector)

Claude Desktop and Claude Code can send the static `MCP_AUTH_TOKEN` as a bearer
header. claude.ai (web and mobile) signs in with OAuth instead. Set:

```bash
MCP_CONNECTOR_PASSWORD="$(openssl rand -base64 24)"   # at least 12 characters
PUBLIC_URL="https://<your-domain>"                     # https origin, no path
ALLOWED_REDIRECT_URIS="https://claude.ai/api/mcp/auth_callback"
MCP_JWT_SECRET="$(openssl rand -hex 32)"               # recommended
MCP_TRUST_PROXY=1                                      # behind Railway/Fly
```

Then in claude.ai → Settings → Connectors → **Add custom connector**, enter
`https://<your-domain>/mcp`:

- **Sign in (recommended):** leave the OAuth client fields empty. claude.ai
  discovers the server through `/.well-known/oauth-protected-resource/mcp` (also
  served at `/.well-known/oauth-protected-resource`) and registers itself
  (dynamic client registration). Registration accepts `none` (public client)
  and `client_secret_post` (a secret is returned); `client_secret_basic` is
  rejected. Registered client ids are signed and stateless, so they survive
  redeploys. Every registration gets its own client id and secret (a random
  nonce is signed into the id), so a secret cannot be recomputed from the
  registration metadata, and every redirect URI must be in `ALLOWED_REDIRECT_URIS`. Then
  the authorize page asks for `MCP_CONNECTOR_PASSWORD`.
- **Client id:** alternatively enter `MCP_OAUTH_CLIENT_ID` (default
  `whoop-mcp-connector`, a public client without a secret) in the advanced
  settings.

Access tokens are JWTs for the scope `mcp` (whatever scope a client requests)
that last 24 hours; refresh tokens last 30 days. The static bearer token keeps
working next to the connector. Rotating `MCP_AUTH_TOKEN` without a fixed
`MCP_JWT_SECRET` signs out every connector session and invalidates registered
clients.

### Verify a deploy

```bash
curl -s -H "Authorization: Bearer $MCP_AUTH_TOKEN" https://<your-domain>/health
```

With a valid token (static or connector) `/health` adds `uptime`, `version`,
`commit`, `whoopApi` (one WHOOP profile request), `privacyMode`,
`oauthConnector`, `webhooks` (`enabled`, `lastEventAt`), `whoopAuth`
(`accessTokenExpiresInS`, `lastRefresh`) and `whoopRate`
(`requestsLastMinute`, `requestsTodayUtc`, `rateLimitedResponsesTotal`). Check
that `version` and `commit` match what you deployed, `whoopApi` is `ok` and
`whoopRate` counters move when you use a tool. Without a token it returns only
`{"status":"ok"}`.

## Troubleshooting

### "Missing required environment variable: WHOOP_CLIENT_ID"

Your WHOOP credentials aren't set. Add them to your Claude Desktop config or the
host's variables. See [Configuration](#configuration).

### claude.ai gets 401 from `/mcp`

With the connector mounted, a 401 carries `WWW-Authenticate: Bearer
realm="whoop-mcp", error="invalid_token",
resource_metadata="<PUBLIC_URL>/.well-known/oauth-protected-resource/mcp"`, and
claude.ai signs in again. Repeated 401s mean the token is expired, signed with
an old key (`MCP_AUTH_TOKEN` or `MCP_JWT_SECRET` rotated), issued for a
different resource (check `PUBLIC_URL`) or lacks the `mcp` scope. Remove and
re-add the connector. After 20 failed verifications per minute from one IP,
further invalid tokens from it get 429; a valid token is never refused. With
`MCP_TRUST_PROXY=1` the IP is the rightmost `X-Forwarded-For` hop. Without a connector the 401 body is `{"error":"Unauthorized"}`
with no header: check the bearer token.

### 503 "Maximum connections reached"

More than `MCP_MAX_CONNECTIONS` (default 16) MCP requests ran at once and the
queue of 32 was full or a request waited 5 seconds. The response has
`Retry-After: 1`; raise `MCP_MAX_CONNECTIONS` (up to 100) if this is normal
load.

### Token folder: `EACCES` or `entrypoint: running as root`

`Cannot read the WHOOP token file <path> (<code>). It exists, but this process
cannot read it, so no new WHOOP sign-in was started.` means `tokens.json` is
there but not readable for the server's user, and startup stops instead of
replacing a sign-in that may still be valid. The usual cause is a container
started with `--user` (or a custom start command) against a root-owned volume.
Give that user ownership (for example `chown 1000:1000` and `chmod 600` when it
runs as `node` or `--user 1000`), set `WHOOP_MCP_TOKEN_DIR` to a folder that
user owns, or start the container as root so the entrypoint prepares the
folder.

`whoop token save failed` with `code: EACCES` means the server cannot write the
token folder, usually because `WHOOP_MCP_TOKEN_DIR` points somewhere the
entrypoint did not prepare (or the container runs with `--user` and a
root-owned folder). Point it at the mounted volume. The entrypoint warning
`running as root (<reason>); the server still works, see docs/deploy-railway.md`
names why it could not switch to `node`; the server keeps the same token folder.
`WHOOP_MCP_TOKEN_DIR must be an absolute path` means a relative path was set.

On an existing deployment, a log with `No cached tokens found, starting OAuth
flow` means the token folder is not the volume: `WHOOP_MCP_TOKEN_DIR` must be
unset (volume at `$HOME/.whoop-mcp`) or equal to the volume's mount path. Do
not sign in there; fix the variable or mount and redeploy.

### The server started although WHOOP's token endpoint was down

That is degraded startup: token requests time out after 30 seconds, startup
retries stop after about 2 minutes, then `whoop token refresh unavailable at
startup; serving with stored tokens` is logged, authenticated `/health` shows
`whoopAuth.lastRefresh.outcome` as `transient_failure` (or `client_rejected`
when WHOOP refused `WHOOP_CLIENT_ID`/`WHOOP_CLIENT_SECRET`), and tools refresh
on demand once WHOOP is back. Fix the credentials for `client_rejected`; the
WHOOP sign-in itself is still valid.

### "The server paused WHOOP requests to stay within WHOOP's per-minute request limit"

The process-wide limiter had no free slot before the call's 20-second deadline,
typically when several long-window tools run at once. Retry in a minute or ask
for fewer days. `whoop rate limiter paused` in the logs shows the waits;
`WHOOP_RATE_LIMIT_PER_MINUTE` can be raised up to 95.

### "WHOOP API returned 429" or "rate-limited the token refresh"

WHOOP's own limit was hit (for example by another app using the same WHOOP
developer app). The server paused and retried 3 times; retry in a minute.

### Results are truncated or today's data looks old

`truncated: true` with a note means the call's history budget ran out: repeat
the same call and it continues from the cache. If today's recovery or sleep is
missing or a note says the data is stale, call `get_sync_status`:
`sleep_not_processed_yet` means WHOOP has not processed the last sleep yet;
`strap_not_synced` means WHOOP has not updated the newest cycle for 24 hours
(sync the strap in the WHOOP app). Cached data can lag WHOOP edits by up to
2 minutes for recent data (longer for older days) unless webhooks are enabled.

### "WHOOP authentication failed: the access token could not be refreshed"

WHOOP refused the refresh token. Restart the server to sign in again (locally
`whoop-ai-mcp setup --verify` also works). If it starts without asking, delete
`tokens.json` from the token folder (`WHOOP_MCP_TOKEN_DIR` when set, else
`~/.whoop-mcp`; on a hosted server, its volume) and restart. Never run two
servers with the same `tokens.json`: WHOOP rotates refresh tokens, and the
second refresh revokes the first.

### "Network error: Unable to reach the WHOOP API"

Check the internet connection; the WHOOP API must be reachable at
`https://api.prod.whoop.com`.

### Browser doesn't open during authentication

Open the authorization URL printed to stderr (`If the browser didn't open,
visit:`).

## What the WHOOP API cannot provide

The WHOOP developer API (v2) does not expose Strength Trainer exercises, sets,
repetitions or weights; journal entries; stress; steps; VO2 max; continuous
heart rate or HRV time series; body measurement history (only the current
height, weight and max heart rate); or WHOOP Sleep Planner and coaching. No
tool returns these or estimates them from other data. `get_sleep_need` is a
statistical estimate from past WHOOP sleep-need records and is labelled as not
being Sleep Planner. The server has no write access to WHOOP.

## Testing with MCP Inspector

You can interactively test the server using the [MCP Inspector](https://github.com/modelcontextprotocol/inspector) — a browser-based tool for exploring and invoking MCP tools.

```bash
WHOOP_CLIENT_ID=your_client_id \
WHOOP_CLIENT_SECRET=your_client_secret \
WHOOP_REDIRECT_URI=http://localhost:3000/callback \
npx @modelcontextprotocol/inspector node dist/index.js
```

Then open `http://localhost:6274` in your browser. The Inspector connects to the server, lists all available tools, and lets you invoke them with custom parameters.

**OAuth grant access screen (first-run authorization):**

![WHOOP OAuth grant access](images/Screenshot%202026-04-12%20at%202.40.55%E2%80%AFAM.png)

**Testing `get_profile` tool in MCP Inspector:**

![MCP Inspector — get_profile tool result](images/Screenshot%202026-04-12%20at%202.43.02%E2%80%AFAM.png)

## Development

### Setup

```bash
git clone https://github.com/shashankswe2020-ux/whoop-mcp.git
cd whoop-mcp
npm install
```

### Commands

| Command                                                              | Description                                                        |
| -------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `npm run build`                                                      | Build TypeScript                                                   |
| `npm test`                                                           | Run tests (Vitest)                                                 |
| `npm run typecheck`                                                  | Type check (`tsc --noEmit`)                                        |
| `npm run lint`                                                       | Lint (ESLint)                                                      |
| `npm run lint:fix`                                                   | Lint + auto-fix                                                    |
| `npm run format`                                                     | Format (Prettier)                                                  |
| `npm run dev`                                                        | Run in dev mode (tsx)                                              |
| `npx tsx scripts/print-tools.mts [--markdown] [standard\|aggregate]` | Print the tools, resources, prompts and instructions a client sees |

Tests use synthetic WHOOP accounts (`tests/helpers/whoop-users.ts`) served by
a fixture client, golden files in `tests/golden`, and never call the real API.

### Project Structure

```
src/
├── index.ts                  # Entry point: config, auth (degraded startup), client, transports, CLI dispatch
├── server.ts                 # createWhoopServer: legacy tools, registry tools, resources, prompts, guide
├── guide.ts                  # MCP instructions and the whoop://server/guide markdown
├── runtime-status.ts         # Version, commit, auth state, webhook and WHOOP request counters
├── privacy.ts                # Privacy mode schema
├── api/                      # WHOOP client (retry, refresh), rate limiter, history loader, pagination, types
├── auth/                     # OAuth flow, callback server, token store, refresh errors
├── cache/memory-cache.ts     # LRU + TTL cache with in-flight dedupe
├── cli/                      # setup, doctor, revoke, config generators
├── logging/                  # JSON logger, tool call events
├── transport/                # stdio, HTTP (auth, queue, health), OAuth connector, webhooks, port config
├── resources/index.ts        # 5 WHOOP resources
├── prompts/                  # index (shared guidance, registration), training, sleep-recovery, platform
└── tools/
    ├── registry/             # Registry tool lists per package, validated at import
    ├── tool-definition.ts    # defineTool, ToolContext, MAX_TOOL_TEXT_CHARS
    ├── day-model.ts          # placeDays, assignWorkouts, buildNights, fetch windows
    ├── aggregate-window.ts   # Released weeks, blocks and gating
    ├── workout-utils.ts, sleep-metrics.ts, stats-utils.ts, analytics-utils.ts, date-utils.ts, ...
    └── get-*.ts, compare-periods.ts, export-health-data.ts   # One file per tool
scripts/print-tools.mts       # Prints what a client sees per privacy mode
docker/entrypoint.sh          # Container token-folder preparation and user switch
docs/deploy-railway.md        # Railway runbook
```

## Releases & npm Package

This project is published on npm as [`whoop-ai-mcp`](https://www.npmjs.com/package/whoop-ai-mcp).

```bash
npm install -g whoop-ai-mcp
```

Or run directly with `npx`:

```bash
npx whoop-ai-mcp
```

### Release Process

1. Update the version in `package.json` and `server.json` and add a new entry in `CHANGELOG.md`
2. Commit the changes: `git commit -am "Release vX.Y.Z"`
3. Tag the release: `git tag vX.Y.Z`
4. Push the commit and tag: `git push origin main vX.Y.Z`
5. The [Release workflow](.github/workflows/release.yml) automatically creates a GitHub Release with notes extracted from the changelog
6. The [npm publish workflow](.github/workflows/npm-publish.yml) automatically publishes the new version to npm

### Changelog

See [CHANGELOG.md](CHANGELOG.md) for a full list of changes in each release.

## Privacy notes for analytical tools

The analytical tools return statistical summaries derived from your WHOOP
records; they expose no data beyond what the record tools already return, but
in a more concentrated form. `get_trend` anomalies, `get_recovery_analysis`
deviations and `get_recovery_drivers` findings flag days and patterns that
differ from your own baseline; such days may coincide with illness, injury,
travel or lifestyle changes, and associations are not causes.

If you connect this MCP server to a remote AI assistant, tool results are sent
to that assistant like any other tool result. Data flows only between the WHOOP
API, this server and the assistant you invoke; there is no third-party
telemetry, and the server stores nothing except `tokens.json` (health data is
cached in memory only).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development workflow, coding conventions, and the project's Copilot agent/skill configuration.

## License

[MIT](LICENSE)
