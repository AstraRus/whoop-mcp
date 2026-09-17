# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.8.0] - 2026-09-17

**Training, sleep and recovery analysis on local days**

This release also contains the unreleased fixes made after 0.7.0 (stateless HTTP,
explicit WHOOP nulls, local-day dates, and two review rounds). Read
**Compatibility** before upgrading: several outputs changed meaning or
precision, and aggregate privacy mode now releases only whole released weeks.

### Added

- **12 new tools** (28 in standard mode). Each has a title, an output schema,
  compact JSON text and a 100,000-character result limit:
  - `get_day`: one local day in detail (cycle, recovery, main sleep, naps,
    workouts with totals, the previous day and the next morning, optional
    timeline), by date or `cycle_id`, with `no_cycle_yet` after local midnight.
  - `export_health_data`: daily, workout and sleep rows as CSV or JSON for up to
    180 days, capped at 60,000 characters with `first_included_day`, and a CSV
    formula guard.
  - `get_workout_log`: filtered and sorted workouts with totals over every
    match; `get_workout_context`: one session with its day, the recovery before
    it, the night after it and percentiles against earlier sessions of the
    sport; `get_personal_records`: per-sport bests with previous best and
    improvement, `history_complete` and a max heart rate check.
  - `get_training_load`: acute and chronic load and their ratio, EWMA ATL, CTL
    and TSB (seeded from the mean of the first 28 known daily loads), Foster
    monotony, ISO week totals and load by sport, ending at the last completed
    WHOOP day; `get_sport_breakdown`: sessions, time, energy, zones, TRIMP, GPS
    pace, efficiency trend, intensity distribution and time of day per sport.
    Both also have aggregate-mode variants.
  - `get_sleep_analysis`: sleep distributions, time-weighted stage shares,
    sleep-need components, timing and naps; `get_recovery_analysis`: zones,
    robust deviations from a personal baseline, the 7-day ln(RMSSD) mean and
    coefficient of variation and weekday patterns; `get_sleep_need`: a
    backtested statistical estimate of the next WHOOP sleep need, labelled as
    not Sleep Planner, with neutral in-bed arithmetic for a wake time.
  - `get_recovery_drivers`: observational tests between behaviours (bedtime,
    time asleep, strain, training load, late workouts, naps, debt, custom tags)
    and next-morning recovery, HRV, resting heart rate or sleep, with effective
    sample sizes, confidence intervals and Benjamini-Hochberg q-values.
  - `get_sync_status`: whether WHOOP data is up to date and why today's data may
    be missing, with server status; a minimal released-week variant in
    aggregate mode.
- `get_trend` metrics `sleep_efficiency`, `respiratory_rate`, `rem_share`,
  `deep_share`, `disturbances_per_hour`, `sleep_consistency`, `sleep_debt`,
  `spo2` and `skin_temp`; `get_baselines` metrics `spo2`, `skin_temp`,
  `sleep_efficiency`, `disturbances_per_hour`, `rem_share` and `deep_share` and
  the status `not_reported`.
- `compare_periods` `training` block: sessions, sessions per week, workout
  minutes and Edwards TRIMP per worn day.
- `get_today` fields `sleep.disturbances`, `sleep.sleep_cycles`,
  `sleep.no_data_hours`, `sleep.consistency_pct`,
  `sleep.need_hours_including_debt` and `recovery.zone`, plus fetch time and
  cache status per source.
- Resources `whoop://v2/user/workout/latest` (the latest finished workout as a
  normalized summary) and `whoop://server/guide` (markdown guide, both privacy
  modes), and MCP `instructions` on connect describing which tool answers which
  question, local days and cycles, nulls and calibration.
- 8 new prompts: `morning_briefing`, `evening_briefing`, `day_review`,
  `session_debrief`, `training_load_check`, `recovery_drivers`,
  `export_my_data`, `data_status_check`; and `aggregate_overview`, the first
  aggregate-mode prompt. Prompt arguments pass allowlist, pattern or clamp
  checks before they reach a message.
- A process-wide WHOOP rate limiter (`WHOOP_RATE_LIMIT_PER_MINUTE`, 10-95,
  default 60; burst 20; 4 concurrent), a 429 pause shared by all requests, and
  request counters in authenticated `/health`.
- Progressive history loading: 30-day chunks cached in memory (2 minutes,
  60 minutes, or 6 hours for chunks older than 30 days) within a per-call budget
  of 60 pages and 20 seconds; `truncated` results continue from the cache when
  repeated. Token refreshes keep the history cache.
- Optional WHOOP webhooks (`WHOOP_WEBHOOKS=1`, `POST /webhooks/whoop`) that
  clear affected cache entries, with `WHOOP_CLIENT_SECRET_PREVIOUS` for secret
  rotation.
- OAuth connector: connector access tokens accepted on `/mcp`, protected
  resource metadata at `/.well-known/oauth-protected-resource/mcp` (and the root
  alias), stateless dynamic client registration for public (`none`) and
  confidential (`client_secret_post`) clients; every registration gets its own
  client id and secret.
- Authenticated `/health` fields `version`, `commit`
  (`RAILWAY_GIT_COMMIT_SHA`/`SOURCE_COMMIT`), `privacyMode`, `oauthConnector`,
  `webhooks`, `whoopAuth` and `whoopRate`; `X-Request-Id` on every `/mcp`
  response; one structured `mcp request` log line per request and one
  classified `tool call failed` line per failed tool call.
- `PORT` support (used when `MCP_PORT` is unset) and `MCP_MAX_CONNECTIONS`
  (1-100, default 16) with a 32-request queue that waits up to 5 seconds.
- `WHOOP_MCP_TOKEN_DIR` for the token folder, a container entrypoint that runs
  the server as the `node` user when it can (token folder `$HOME/.whoop-mcp`
  unless `WHOOP_MCP_TOKEN_DIR` is set), a Docker smoke workflow that includes
  Railway's layout (`HOME=/home/node`, volume at `/home/node/.whoop-mcp`) and
  a Docker-free entrypoint test in the normal test run.
- Degraded startup: when WHOOP cannot refresh the stored tokens at startup
  (network, 429, 5xx, `invalid_client`), the server retries after 5, 15 and 45
  seconds within a 120-second budget and then starts with the stored tokens
  instead of exiting. Token-endpoint requests time out after 30 seconds, so
  startup with stored tokens takes at most about 2.5 minutes.
- `whoop-ai-mcp revoke --yes [--keep-tokens]`: a human-only command that revokes
  the app's WHOOP access.
- Docs: a complete tool reference, privacy matrix, environment variable table,
  logging reference, troubleshooting, [Railway runbook](docs/deploy-railway.md)
  and `scripts/print-tools.mts`.

### Changed

- **Day placement:** every day-based tool places cycles, sleeps and recoveries
  on the local day the main sleep ended and workouts on the day of the cycle
  containing their start, as `get_calendar` does. A workout after local
  midnight before the next sleep counts toward the previous day.
- **`get_weekly_summary`:** workouts count on their cycle day (previously their
  start time decided the week); records are read from two days before Monday to
  two days after Sunday; averages are rounded (scores, HRV and RHR 1 dp, hours
  2 dp, percentages 1 dp, strain 2 dp, kJ 0 dp); `total_strain` is described as
  the sum of workout strain, not comparable to day strain.
- **Sleep hours are time asleep** (light + slow-wave + REM) on main sleeps in
  every tool, resource and prompt; naps and time in bed are separate figures.
- **Dates:** `YYYY-MM-DD` and relative expressions resolve at local midnight in
  the user's UTC offset (read from the latest cycle); "last N days" is today
  plus the N previous days; `compare_periods` counts each local day in the period
  holding most of it.
- `get_today` reports `data_quality` periods as local times with the offset
  (instants unchanged; `method_version` `today-5`), refetches sleep and
  recovery once when a new cycle has no synced sleep in the cached list, and
  reports `last_workout.percent_recorded` from WHOOP's 0-1 fraction.
- `get_baselines` reports the cycle source as `available` when cycles were used
  instead of mirroring the recovery status.
- Collection tools add `notes` when UTC days had to be used because the user's
  offset could not be read.
- Prompts: `sleep_analysis` compares time asleep with WHOOP's own nightly need
  (the population "7-9 hours" line is gone) and uses `get_sleep_analysis`;
  `recovery_trend` uses `get_recovery_analysis`; `workout_recap` uses the sport
  breakdown, training load and workout log; `weekly_health_review` reads
  workouts from `get_sport_breakdown`.
- The HTTP transport serves each `POST /mcp` with a fresh stateless server
  (`GET`/`DELETE /mcp` return 405), so reconnecting clients no longer get
  "Server already initialized".
- A `tool output too large`, contract violation or WHOOP failure is logged as
  one `tool call failed` line with its outcome, error class and HTTP status.
- Resource read failures are logged through the structured logger instead of
  `console.error`.
- WHOOP request log lines (`whoop api request`, `whoop api rate limited`,
  `whoop api timeout`, `whoop api network error`) log `endpoint`, a route
  template such as `/v2/activity/workout/:id` without ids or query, and
  `errorClass`, instead of `url` and `error`. `whoop token refreshed` is logged
  once per refresh.
- `tool call failed`: a `RangeError` or `ZodError` inside a tool is logged as
  `internal_error` at level error with `stackFrames`; only a date expression
  that cannot be parsed (`InvalidDateExpression`) is `invalid_input`.
- Records from the last 3 days may come from a cache entry up to 2 minutes old;
  when a tool call's data types were read at different times around a WHOOP
  sync, the older ones are re-read once.
- `get_workout_log`, `get_personal_records`, `get_training_load` and
  `get_sport_breakdown` also read sleeps to place sessions on days, as
  `get_calendar` does (split nights included). The
  `whoop://v2/user/workout/latest` resource places the workout on the wake day
  of its cycle's main sleep and may read the cached sleep list.
- `get_training_load` seeds its EWMA from the mean of the first 28 known daily
  loads.
- `get_trend` and `get_baselines` report `std_dev` as the sample standard
  deviation (n-1).
- Aggregate `get_weekly_summary` rounds workout `total_strain` to 1 and
  `total_calories_kj` to 100.
- Prompts `health_check` and `weekly_health_review` ask for observations
  instead of recommendations.
- The container entrypoint's root warning reads `entrypoint: running as root
(<reason>); the server still works, see docs/deploy-railway.md` (it no longer
  suggests `/data`, which would point an existing deployment at an empty
  folder).

### Fixed

- WHOOP's explicit nulls are accepted: collection pages with `next_token: null`,
  non-GPS workouts and nullable score fields no longer fail their output
  contract, and `get_baselines`/`get_sleep_debt` no longer drop every record.
- Bare dates and zone-less date-times no longer reach WHOOP (which answered 404);
  impossible dates are rejected.
- `get_today`: today is the open cycle containing now; sleep and recovery join
  it by id; an older morning's data is flagged as stale instead of shown as last
  night's; there is no 48-hour limit on an open cycle.
- `get_calendar`: rows join recovery, sleep and strain to the cycle covering
  each local day (strain was one row early); a failing stream degrades its
  column only; range-expression starts cover the whole range.
- `get_trend` and `get_weekly_summary`: regressions run oldest first (directions
  were inverted); metric polarity is respected; no trend below 4 points; null
  instead of 0 for weeks without data; negative-offset week starts.
- `compare_periods`: date-only and relative inputs no longer 404; reversed and
  oversized ranges are rejected locally; an empty period gives null averages and
  `insufficient_data` instead of "+100% improved".
- `get_sleep_debt` honours a range expression's end; `get_baselines` can build
  baselines at its minimum window; calibrating recoveries are reported as
  `calibrating`; real WHOOP errors are no longer replaced by a generic network
  error.
- Auth: concurrent 401s share one token refresh (WHOOP rotates refresh tokens);
  `tokens.json` is written atomically, with an in-place fallback, and rotated
  tokens are kept in memory when a save fails; only a 400/401 refusal of the
  refresh token asks for a new sign-in; `invalid_client` keeps the tokens and
  explains that the app credentials were rejected; 429 and 5xx at startup no
  longer start the browser sign-in.
- Cache readers' TTLs are honoured, and the time-zone lookup no longer makes the
  latest-cycle resource serve hour-old strain.
- Connector access tokens were rejected on `/mcp`; they are now verified there.
- Container token folder: the entrypoint defaulted to `/root/.whoop-mcp`
  whatever `HOME` was. On a deployment with `HOME=/home/node` and its volume
  at `/home/node/.whoop-mcp` (the folder 0.7.x used), the server found no
  tokens, started a WHOOP sign-in, never served `/health` and exited after
  `CALLBACK_TIMEOUT_MS`. The default is now `$HOME/.whoop-mcp`
  (`/root/.whoop-mcp` without `HOME`), exported to the server.
- A `tokens.json` that exists but cannot be read (for example `EACCES` with
  `--user` on a root-owned volume) fails fast with `Cannot read the WHOOP token
file <path> (<code>)` and ownership guidance instead of starting a new WHOOP
  sign-in over a possibly valid one.
- Token-endpoint requests time out after 30 seconds, and startup retries are
  bounded (about 2 minutes) before degraded serving, so a hanging WHOOP token
  endpoint no longer blocks startup and the deploy health check.
- The failed-verification throttle never refuses a valid connector token (a
  shared proxy address could lock out a signed-in client); only further
  invalid tokens get 429.
- `get_sleep_debt`: `social_jetlag_minutes` needs 2 weekday and 2 weekend
  nights (3 and 3 in aggregate mode), otherwise it is null with a note.
- `get_sleep_analysis`: `naps.total_asleep_hours` is null when any nap is
  unscored.
- `get_recovery_drivers`: `partly_by_construction` also covers
  `prior_day_strain` and `nap_before` with `sleep_performance`;
  `last_workout_to_bed_min` with too few workout days is `too_few_pairs`
  instead of `data_unavailable`.
- `export_health_data`: the CSV formula guard no longer prefixes UTC offsets
  such as `+02:00`.
- `get_day`: on the first day of wear the timeline labels the cycle start as
  local midnight instead of sleep onset.
- `get_training_load` and `get_sport_breakdown` place split nights like
  `get_calendar`.
- `get_trend` (strain) and `compare_periods` leave out the partial first day of
  wear; strain notes name the open cycle's day instead of "Today's".

### Security

- **Aggregate privacy mode** releases only whole released local weeks (see
  Compatibility), withholds weeks with an open cycle or a record being scored,
  gates each metric per week at 3 samples, does not use calibrating recoveries,
  counts only records in released weeks in `data_quality` and projects
  `evaluated_at` to a date. The aggregate sport breakdown pools small sports and
  withholds totals that linear combinations of released sums could reduce to
  fewer than 3 sessions. A cross-tool test checks by Gaussian elimination that
  no single record, sum of two records or rounded combination is recoverable
  from all released values of the 8 aggregate tools.
- Aggregate `get_sync_status` shows no latest records, sync times, webhook
  times, token expiry or request counts.
- OAuth connector: resource indicators must be the server's `/mcp` URL or
  origin; issued tokens always carry only the scope `mcp`; registered client ids
  are HMAC-signed and re-checked against `ALLOWED_REDIRECT_URIS`;
  `client_secret_basic` is rejected; registration is limited to 10 per minute
  per IP and 2 KB; 20 failed token verifications per minute per IP return 429;
  a 401 carries `WWW-Authenticate` with `resource_metadata`; the authorize page
  CSP allows form posts only to its own origin and the allowlisted redirect
  origins.
- Webhooks are verified with HMAC-SHA256 over timestamp and raw body (timestamp
  within 2 hours in the past or 5 minutes ahead), limited to 16 KB and 120
  requests per minute per IP, and deduplicated by `trace_id`.
- Logs never contain error messages from WHOOP, argument values, record values,
  tokens or response bodies; 500 responses carry only a request id.
- The container runs the server as the unprivileged `node` user whenever the
  token folder can be prepared for it (earlier images ran as root).
- Revoking WHOOP access (`DELETE /v2/user/access`) is a human-only CLI command
  and never an MCP tool.
- Every new tool result is limited to 100,000 characters.
- Dynamic client registration signs a random nonce into every client id, so
  two registrations with the same metadata never share a client id or secret
  and a secret cannot be recomputed from the metadata.
- With `MCP_TRUST_PROXY=1` the client IP for rate limits, the auth-failure
  throttle and logs is the rightmost `X-Forwarded-For` hop (the one the proxy
  appended), so a client cannot choose its own rate-limit key.
- WHOOP request logs no longer contain record ids, dates or query parameters.
- Aggregate `get_sport_breakdown`: a `sport` filter for a sport pooled as `other`
  gets the same answer as a sport that does not exist, so it no longer reveals
  which sports had only 1 or 2 sessions in a block.
- Aggregate mode (documented): an edit in WHOOP to a record in an already
  released week changes released values on the next call, and comparing
  outputs from before and after the edit reveals that record's contribution
  to within the rounding step; the 2-day lag covers late syncs only.

### Compatibility

- **Breaking for aggregate privacy mode:** windows snap to whole released local
  Monday-to-Sunday weeks, released two days after they end (Wednesday 00:00
  local). The current week, and last week before Wednesday, return nulls with a
  note. `get_trend` rounds `days` up to 1, 2, 4, 8 or 13 weeks, `get_baselines`
  to 2, 4, 8, 13 or 26, `get_sleep_debt` to 2, 4, 8 or 12 (and ignores `start`),
  and `compare_periods` snaps each period inward to released weeks (no
  `training` block). Values are rounded more coarsely (recovery, HRV, RHR, SpO2 and
  percentages to whole numbers; hours, strain, respiratory rate, skin
  temperature and disturbances per hour to 0.1).
  Aggregate mode now also lists `get_training_load`, `get_sport_breakdown`,
  `get_sync_status`, the `whoop://server/guide` resource and the
  `aggregate_overview` prompt.
- **Standard mode:** `get_calendar` and `get_weekly_summary` group by local days
  (0.7.0 still grouped them by UTC), workouts move to their cycle day, and
  weekly averages are rounded. Existing fields keep their names;
  `get_today.sleep.total_hours` is still time in bed. New output fields are
  additive, and the 16 original tools keep pretty JSON text while the new tools
  return compact JSON.
- HTTP: `/mcp` is stateless; the default concurrency is 16 requests with a
  queue instead of 5 with an immediate 503; 500 bodies no longer include a
  message.
- Docker: the image still defaults to the folder earlier images used,
  `$HOME/.whoop-mcp` (`/root/.whoop-mcp` unless HOME is set), so existing
  volumes keep working (for example `/home/node/.whoop-mcp` on Railway with
  `HOME=/home/node`: change nothing). It now switches to the `node` user after
  preparing the folder. `WHOOP_MCP_TOKEN_DIR` must equal the volume's mount
  path when set; images before 0.8.0 ignore it.
- No new runtime dependencies and no new OAuth scopes; the token file format is
  unchanged. The only new WHOOP endpoint, `DELETE /v2/user/access`, is used by
  the `revoke` command alone.
- Three POSIX file-permission tests in `tests/auth/token-store.test.ts` are
  skipped on Windows; they still run on Linux CI.

### Verification

- About 2,400 tests in 81 files (797 in 0.7.0), with typecheck and lint clean.
  Golden files pin every original tool, resource and prompt; changed goldens
  are limited to the intended changes listed above.
- Contract tests run every tool in both privacy modes on a live-shaped
  calibrating account, 120-day accounts and a 365-day stress account. New:
  an exact inventory test per privacy mode, a result-size test of every new tool
  at maximum arguments, the cross-tool aggregate differencing test, guide and
  prompt tests, and a documentation test that keeps the README tool reference,
  privacy matrix and environment table in step with the code.

## [0.7.0] - 2026-09-10

**Trustworthy Personal Analytics**

### Added

- `get_baselines`: personal percentile bands with baseline self-exclusion, calibration filtering, minimum sample counts and explicit truncation.
- `get_sleep_debt`: observed nightly deficits, separate WHOOP standing debt, circular local-clock consistency and bounded nightly output.
- Output schemas and equivalent structured/JSON-text results for all 16 tools.
- Process-level aggregate privacy mode with a five-tool allowlist, explicit projections and no raw resources or incompatible prompts.
- Local-only `doctor` command with JSON output and stable exit codes.
- Site release overview covering personal analytics, current-day safeguards,
  aggregate privacy and diagnostics, with installation instructions for 0.7.0.

### Fixed

- `get_today` now matches recovery to the current cycle and primary sleep, checks score states, skips naps, and does not substitute older data for pending or invalid current sleep.
- Accept nullable provider score objects and open-cycle end timestamps.
- Tool/resource errors no longer expose provider bodies or arbitrary internal messages.
- Targeted compatible dependency refresh clears runtime and high/critical audit findings. Three moderate development-only Vitest findings remain; a major test-runner migration is deferred.

### Compatibility

- `get_today.sleep.total_hours` retains time-in-bed semantics; new `time_in_bed_hours` and `asleep_hours` are explicit. Summaries use asleep time; missing optional sleep percentages now return null instead of zero.
- New current-day/analytics metadata labels data quality and recorded-offset day attribution. Calendar/weekly-summary UTC grouping remains unchanged.
- Aggregate mode intentionally reduces capabilities and output detail. Standard remains the default. No new runtime dependency, OAuth scope, WHOOP endpoint or health-data storage was added.

### Verification

- 750 → **797 tests** across 43 files, including real stdio subprocess and authenticated HTTP tests with synthetic WHOOP data.
- Line coverage: **95.61% overall**, **98.84% API**, **99.18% auth**. Lint, typecheck, build and source/test formatting pass.
- Runtime dependency audit: zero findings. Three moderate development-only Vitest entries remain; no major-version migration or risk suppression was applied.
- Manual desktop-client smoke test confirmed passed by the release owner on 2026-09-10; publication authorized. Automated transport tests do not replace client UI verification.

## [0.6.1] - 2026-08-08

### Fixed

- **Token refresh path recovered for non-JSON 401 responses** (#219) — `parseErrorBody()` now reads the response body once and parses JSON from the captured text, preventing undici's `Body is unusable: Body has already been read` failure that previously blocked 401 refresh handling.
- **Refreshed access token now persists across subsequent client calls** (#219) — after a successful 401 refresh, the client stores the new token for future requests to avoid repeated `401 -> refresh -> retry` cycles.

### Test count

- 748 → **750** (+2 regression tests for #219). Full suite, lint, typecheck, and build pass.

## [0.6.0] - 2026-06-13

### Added

- **Setup wizard supports Codex & GitHub Copilot** — `whoop-ai-mcp setup --client=codex` prints a `codex mcp add` command (registers the server in `~/.codex/config.toml`) and `--client=copilot` prints a `code --add-mcp` command for GitHub Copilot in VS Code. Both reuse the same shell-quoting as the Claude Code path; the interactive prompt now offers all four targets.
- **Shared in-memory cache (`MemoryCache`)** — generic LRU + TTL cache (`src/cache/memory-cache.ts`) backing both MCP resources and read tools. Opt-in per request via `client.get(path, { cache: true, ttlMs })`. TTLs: profile 1 hr, recovery/sleep 5 min, cycle 2 min; date-range collections stay uncached. Cache keys are normalized by path with alphabetically-sorted query params (no tokens in keys), concurrent identical requests are de-duplicated (stampede prevention), and the whole cache is cleared on token refresh. `get_today` now serves from the same cache, so a warm cache makes zero API calls.
- **Write-safety preview pattern (`withPreview`)** — future-ready two-phase preview/confirm utility (`src/tools/write-safety.ts`) with `WritePreview<P>`, `WriteReceipt<R>`, and `WriteResult<P, R>` types. `confirm: false` returns a preview with a generated UUID v4 `idempotency_key`; `confirm: true` executes the write and echoes the same key for safe retries. No write tools are registered (WHOOP exposes no public write endpoints yet).

### Changed

- **Removed legacy `ResourceCache`** — resources now delegate caching to the shared `MemoryCache` via the API client. `registerResources` and `createWhoopServer` no longer return a cache handle.

### Test count

- 716 → **748** (+32). MemoryCache 97.75% / write-safety 100% line coverage. Lint, typecheck, build clean.

## [0.5.2] - 2026-06-03

### Security

- **OAuth `openBrowser` URL scheme validation** (#151) — reject non-HTTP(S) URL schemes (`javascript:`, `file:`, `vbscript:`, malformed URLs) BEFORE spawning the child process. Defense-in-depth; the URL is constructed from constants today.
- **OAuth callback `Referrer-Policy: no-referrer`** (#110) — added to all callback HTML responses so the auth code in the callback URL cannot leak via Referer. All four HTML response paths now flow through a single `HTML_RESPONSE_HEADERS` constant.
- **Token refresh error differentiation** (#111) — `refreshAccessToken` now wraps fetch in try/catch and raises `WhoopNetworkError` on transport failures; `authenticate`'s refresh catch block rethrows network errors so callers can retry instead of forcing the user through a full re-auth on transient DNS/connection issues.
- **Windows `cmd /c start` title guard** (#109) — verified the empty `""` title placeholder is in place; added a platform=win32 unit test to lock it in.

### Changed

- **BREAKING: `get_calendar` removes `workout_count` field** (#156) — the field was hard-coded to `0` (no implementation path that wouldn't add a workout API fetch). Removed from `CalendarDay` for honesty over backwards compatibility. No in-repo callers consumed it.
- **`get_calendar.start` is now the grid origin** (#154) — when provided, the grid iterates FORWARD from `start` for `days` days, clamped to today (no future days). Previously `start` only filtered the API query while the displayed grid stayed anchored at today. `period.start` in the response now equals the provided `start`.
- **YYYY-MM date inputs reject years outside 2010–2099** (#158) — typos like `0226-05` previously parsed as year 226 and returned empty WHOOP data. Now throws `InvalidDateExpression` with a clear message.
- **`get_calendar` throttles inter-page delay for large ranges** (#152) — `numDays > 30` now uses `interPageDelayMs=100` across all three paginated streams (recovery/sleep/cycle); `numDays ≤ 30` retains `0` (unchanged hot path). Mitigates 429 risk on 90-day requests.
- **`compare_periods` schema-level ISO 8601 validation** (#153) — all four date params now use a shared `isoDateString` schema with a clear error message instead of bare `z.string()`. Centralized `ISO_8601_REGEX` export from `src/tools/date-utils.ts`.

### Added

- **End-to-end MCP integration test over HTTP transport** (#161) — new `tests/transport/http.integration.test.ts` exercises `initialize` → `tools/list` → `tools/call get_profile` through the real SDK `StreamableHTTPClientTransport` ↔ `StreamableHTTPServerTransport` pair, with WHOOP API mocked at `globalThis.fetch`.
- **HTTP transport regression test** (#159) — verifies `activeConnections` counter cannot drift negative under repeated malformed JSON bodies; the malformed-JSON catch block now has an inline comment locking in the `res.on('close')` ownership invariant.
- **README privacy notes for analytical tools** (#99) — documents that `get_weekly_summary`, `get_trend`, and `compare_periods` return concentrated summaries derived from underlying records, with the `anomalies` array flagging deviations from your personal baseline. No new data exposure vs the per-record collection tools.
- **V3 platform spec audit pass** — `docs/specs/v3-platform-enhancements.md` revised with revision log, WHOOP API rate-limit assumptions section (#149), and tradeoffs / open decisions section (TD-1 webhook vs read-only #128, TD-2 self-issued JWT vs SDK ProxyOAuthServerProvider #150). 24 other spec-review issues verified already encoded.

### Test count

- 691 → **716** (+25 across 35 test files). Lint, typecheck, build clean.

## [0.5.1] - 2026-06-03

### Added

- **Setup wizard credential precedence** — `npx whoop-ai-mcp setup` now resolves WHOOP credentials from (1) `--client-id` / `--client-secret` flags, then (2) an existing `whoop` entry in the target Claude Desktop config (no rewrite, no `.bak`), then (3) `WHOOP_CLIENT_ID` / `WHOOP_CLIENT_SECRET` env vars, then (4) interactive prompts. With `--verify` and an existing config the wizard runs OAuth + profile fetch against the stored creds and prints `Existing config verified — no changes made` without touching the file.

## [0.5.0] - 2026-06-03

### Added

- **HTTP transport** — new `MCP_TRANSPORT=http` (or `both`) mode powered by the SDK's `StreamableHTTPServerTransport`. Bearer-auth via `MCP_AUTH_TOKEN`, `/health` endpoint with optional upstream WHOOP API status (`whoopApi: "ok"|"error"|"unknown"`), CORS via `MCP_ALLOWED_ORIGINS`, per-IP `/mcp` rate limit (default 100 req/60 s), SSE periodic re-validation (default 5 min), `MCP_TRUST_PROXY=1` for `X-Forwarded-For` parsing behind reverse proxies, and graceful SIGTERM/SIGINT shutdown.
- **OAuth 2.1 connector** — claude.ai web/mobile can now connect via PKCE S256. Set `MCP_CONNECTOR_PASSWORD` (≥12 chars) + `PUBLIC_URL` + `ALLOWED_REDIRECT_URIS` and the connector mounts on the same HTTP port. JWT signing key derived via HKDF from `MCP_AUTH_TOKEN` (or override with `MCP_JWT_SECRET`).
- **Docker image** — multi-stage `node:22-alpine` Dockerfile, runs as non-root, tini PID 1, native-fetch healthcheck. **58 MB compressed** (registry pull). Fly.io and Railway deployment guides in README.
- **CLI setup wizard** — `npx whoop-ai-mcp setup` walks through credential entry, writes/merges Claude Desktop config (with atomic `.bak` backup), or prints the equivalent `claude mcp add` command for Claude Code. Optional `--verify` flag runs OAuth + profile fetch end-to-end. Zero new runtime deps.
- **Structured logging** — JSON-lines logger to stderr with `LOG_LEVEL` (`debug`/`info`/`warn`/`error`) and `LOG_FORMAT` (`json`/`pretty`). Request correlation IDs flow through the WHOOP API client; 429s log at `warn` with `retryAfterMs`, timeouts at `error`, token refreshes at `info`, successes at `debug` with `durationMs`.
- **Hardening** — OAuth callback responses now include `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`. `openBrowser` uses `spawn` with arg arrays (no shell injection) and handles async error events gracefully in headless containers.

### Changed

- Test count: 502 → **687** (34 test files; coverage on new code: `src/cli` 90.93%, `src/logging` 100%, `src/transport` 94.63%).
- Node engine bumped to **>=20.0.0** (was >=18) — required for `AbortSignal.timeout` and modern `fetch` semantics.
- `src/index.ts` refactored to dispatch on `MCP_TRANSPORT` (`stdio` | `http` | `both`); the legacy stdio-only path is preserved as the default for backward compatibility.

## [0.4.0] - 2026-05-31

### Added

- **`get_today` composite tool** — single call returns today's recovery, last night's sleep, current strain, and last workout with a human-readable summary. Uses `Promise.allSettled` for parallel-with-partial-failure.
- **`get_calendar` grid tool** — day-by-day view of recovery scores, sleep hours, and strain for 1–90 day ranges. Includes recovery zones (green/yellow/red), averages, and sleep alignment to wake-up day.
- **6 new date expressions** — `"last N weeks"` (1–52), `"last N months"` (1–12), `"this quarter"`, `"last quarter"`, `"last year"`, and `"YYYY-MM"` month literals. All case-insensitive with proper edge case handling (Feb overflow, year wrap).

### Changed

- Tool count: 12 → 14
- Test count: 466 → 502
- All collection tools now accept the extended date expressions

## [0.3.1] - 2026-05-30

### Fixed

- Hardened OAuth callback responses with security headers (`Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`).
- Hardened Windows browser launch by adding the `start "" <url>` title guard in `openBrowser()`.

## [0.3.0] - 2026-05-29

### Added

- **3 Analytical Tools** — `get_weekly_summary`, `compare_periods`, `get_trend` for pre-computed health insights
- **3 Individual Record Lookup Tools** — `get_sleep_by_id`, `get_workout_by_id`, `get_cycle_by_id`
- **4 MCP Resources** — ambient health context (`whoop://v2/user/recovery/latest`, sleep, cycle, profile) with in-memory cache and TTL
- **5 MCP Prompts** — guided conversation starters (`weekly_health_review`, `sleep_analysis`, `recovery_trend`, `workout_recap`, `health_check`)
- **Auto-pagination utility** — `fetchAllPages` with safety caps (500 records, 20 pages max, inter-page delay)
- **Enhanced date handling** — all collection tools accept relative expressions ("today", "last 7 days", "this week", "last month")
- **Statistics utility** — mean, median, std deviation, linear regression, anomaly detection (pure TypeScript, no deps)

### Changed

- Collection tool descriptions updated to document relative date expression support
- Tool count: 6 → 12
- Resource count: 0 → 4
- Prompt count: 0 → 5
- Test count: 217 → 430+

## [0.2.0] - 2026-04-14

### Fixed

- **OAuth refresh tokens now work** — added `offline` scope to OAuth authorization request, enabling persistent refresh tokens across sessions (thanks [@efdavis](https://github.com/efdavis) — PR #34)
- **Tokens persist across Claude Desktop restarts** — fixed token storage so cached tokens survive server restarts without re-authentication
- **Hardened token validation** — improved shape validation for stored tokens and redacted file paths in log messages to avoid leaking usernames
- **Dropped Node 18.x from CI** — Node 18 reached EOL; CI now tests on Node 20 and 22
- **Fixed IPv6 test failures** — callback server tests now work correctly in IPv6 environments

### Changed

- Formatted all source and test files with Prettier (style-only, no behavior changes)
- 217 tests passing (up from 212)

### Added

- Security audit report #2 (`docs/security-audits/security-audit-2.md`)
- "Get a WHOOP" section in README with referral links

## [0.1.2] - 2026-04-12

### Added

- `SECURITY.md` — vulnerability reporting process, OAuth/token/API security design, known limitations
- `CODE_OF_CONDUCT.md` — Contributor Covenant v2.1
- `.github/workflows/ci.yml` — GitHub Actions CI pipeline (typecheck, lint, test, coverage, build) on Node 18/20/22

## [0.1.1] - 2026-04-12

### Changed

- Added Claude Desktop integration screenshots to README (server connected + live chat)
- Added MCP Inspector testing screenshots to README (OAuth grant flow + `get_profile` result)

## [0.1.0] - 2026-04-12

### Added

- **MCP server** with stdio transport for Claude Desktop and other MCP-compatible clients
- **OAuth2 Authorization Code flow** — browser-based authentication with automatic token refresh
- **Secure token storage** at `~/.whoop-mcp/tokens.json` with `0600` file permissions
- **6 MCP tools** for querying WHOOP health and fitness data:
  - `get_profile` — user's basic profile (name, email)
  - `get_body_measurement` — height, weight, max heart rate
  - `get_recovery_collection` — HRV, resting heart rate, SpO2, skin temp
  - `get_sleep_collection` — sleep stages, duration, respiratory rate
  - `get_workout_collection` — strain, heart rate zones, calories, sport type
  - `get_cycle_collection` — physiological cycles with strain and calorie data
- **Resilient error handling:**
  - Automatic retry with exponential backoff for rate limits (429)
  - Automatic token refresh on auth failures (401)
  - Clear, user-friendly messages for network errors
  - MCP-formatted error responses (tools never crash the server)
- **CLI entry point** — `npx whoop-mcp` with environment variable configuration
- **202 tests** with full coverage of auth, API client, tools, and error handling

[Unreleased]: https://github.com/shashankswe2020-ux/whoop-mcp/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/shashankswe2020-ux/whoop-mcp/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/shashankswe2020-ux/whoop-mcp/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/shashankswe2020-ux/whoop-mcp/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/shashankswe2020-ux/whoop-mcp/compare/v0.5.2...v0.6.0
[0.2.0]: https://github.com/shashankswe2020-ux/whoop-mcp/compare/v0.1.1...v0.2.0
[0.1.2]: https://github.com/shashankswe2020-ux/whoop-mcp/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/shashankswe2020-ux/whoop-mcp/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/shashankswe2020-ux/whoop-mcp/releases/tag/v0.1.0
