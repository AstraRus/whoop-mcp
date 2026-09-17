# Project: whoop-mcp

An MCP (Model Context Protocol) server that wraps the WHOOP REST API (v2), enabling AI assistants to query one person's health and fitness data through natural conversation. Published on npm as `whoop-ai-mcp` and on the MCP Registry as `io.github.shashankswe2020-ux/whoop`.

## Tech Stack

- **Language:** TypeScript ~5.8 (strict, `noUncheckedIndexedAccess`, no `any`)
- **Runtime:** Node.js >= 20 (native `fetch`)
- **MCP SDK:** `@modelcontextprotocol/sdk` 1.30
- **Validation:** Zod 4 (tool input and output schemas)
- **Test Framework:** Vitest
- **Lint / format:** ESLint + `@typescript-eslint`, Prettier
- **Build:** `tsc` (no bundler)
- **Package Manager:** npm
- **Runtime dependencies:** only `@modelcontextprotocol/sdk` and `zod`. Keep it that way.

## Commands

```bash
npm install          # Install dependencies
npm run build        # Build TypeScript
npm run dev          # Run in development (tsx)
npm test             # Run tests
npm test -- --coverage  # Tests with coverage
npm run lint         # Lint
npm run lint:fix     # Lint + fix
npm run format       # Format with Prettier
npm run typecheck    # Type check (no emit; tests are not in tsconfig)
node dist/index.js   # Run MCP server (production)
node dist/index.js doctor --json        # Local diagnostics
node dist/index.js revoke --yes         # Human-only: revoke WHOOP access
npx tsx scripts/print-tools.mts --markdown   # What a client sees, per privacy mode
UPDATE_GOLDENS=prompts/<name> npx vitest run tests/golden tests/prompts   # Regenerate owned goldens only
```

## Status

- **Version 0.8.0** (2026-09-17). See `CHANGELOG.md`.
- **Inventory** (pinned by `tests/inventory.test.ts`):
  - standard mode: 28 tools, 6 resources, 13 prompts;
  - aggregate mode (`WHOOP_MCP_PRIVACY_MODE=aggregate`): 8 tools (`compare_periods`, `get_baselines`, `get_sleep_debt`, `get_trend`, `get_weekly_summary`, `get_training_load`, `get_sport_breakdown`, `get_sync_status`), the guide resource, the `aggregate_overview` prompt.
- Deployed on Railway (see `docs/deploy-railway.md`); the post-deploy checks are authenticated `/health` (version, commit, `whoopRate`) and `get_sync_status`.
- Known Windows-only difference: 3 POSIX permission tests in `tests/auth/token-store.test.ts` are skipped on win32 and run on Linux CI.

## Project Structure

```
src/
├── index.ts                  # Entry: env parsing, runtime status, rate limiter, auth with degraded startup, client, transports, CLI dispatch (setup, doctor, revoke)
├── server.ts                 # createWhoopServer: 16 legacy tools (registerTool), registry tools (ADDITIONAL_TOOLS), resources, prompts, guide resource
├── guide.ts                  # MCP instructions (<= 1800 chars) and whoop://server/guide markdown, per privacy mode
├── runtime-status.ts         # Version, commit, auth state, webhooks, WHOOP request counters (no tokens, ids or health data)
├── privacy.ts                # PrivacyMode schema
├── api/
│   ├── client.ts             # WHOOP client: retries, shared token refresh, cache opt-in, limiter, describeWhoopError
│   ├── rate-limiter.ts       # Process-wide token bucket (WHOOP_RATE_LIMIT_PER_MINUTE), 429 pause, deadlines
│   ├── history.ts            # loadHistory: cached 30-day chunks within a per-call page/time budget
│   ├── pagination.ts, record-schemas.ts, types.ts, endpoints.ts
├── auth/                     # oauth.ts, callback-server.ts, token-store.ts (WHOOP_MCP_TOKEN_DIR), token-refresh-error.ts
├── cache/memory-cache.ts     # LRU + TTL, in-flight dedupe, deleteWhere
├── cli/                      # setup.ts, doctor.ts, revoke.ts, config-generators.ts
├── logging/                  # logger.ts (JSON lines to stderr), tool-events.ts (classified tool outcomes)
├── transport/                # stdio.ts, http.ts (auth, queue, /health), oauth-connector.ts (+ helpers, jwt), webhooks.ts, port-config.ts
├── resources/index.ts        # recovery/sleep/cycle/workout latest, profile
├── prompts/                  # index.ts (guidance, registration), training.ts, sleep-recovery.ts, platform.ts
└── tools/
    ├── registry/             # index.ts (LEGACY_TOOL_NAMES, ADDITIONAL_TOOLS, validation) + one list per package
    ├── tool-definition.ts    # defineTool, ToolContext, MAX_TOOL_TEXT_CHARS (100,000)
    ├── day-model.ts          # placeDays, assignWorkouts, buildNights, fetchRangeForDays, resolveDayWindow
    ├── aggregate-window.ts   # Released weeks (2-day lag), blocks, weekFinal, gating
    ├── workout-utils.ts, sleep-metrics.ts, sleep-window.ts, stats-utils.ts, analytics-utils.ts, collection-utils.ts, date-utils.ts, csv.ts
    ├── output-contracts.ts   # Legacy tool output schemas and aggregate projections
    └── get-*.ts, compare-periods.ts, export-health-data.ts, training-aggregate.ts   # One file per tool

tests/                        # Mirrors src/, plus:
├── helpers/                  # whoop-fixture-client.ts, whoop-users.ts (liveShapedUser, matureUser, stressUser), contract.ts
├── golden/                   # Golden JSON of every legacy tool, resource and prompt (prettier-ignored)
├── inventory.test.ts, guide.test.ts, docs.test.ts, size-guard.test.ts, aggregate-cross-tool.test.ts, aggregate-privacy.test.ts
docker/entrypoint.sh          # Token-folder preparation, switch to the node user
docs/deploy-railway.md        # Railway runbook
scripts/print-tools.mts       # tools/list, resources, prompts, instructions per mode
```

## Code Conventions

### Naming

- **Files:** `kebab-case.ts`
- **Types/Interfaces:** `PascalCase`
- **Functions:** `camelCase`
- **Constants:** `SCREAMING_SNAKE_CASE`
- **MCP tool names:** `snake_case`

### Patterns

- Explicit return types on exported functions; named exports only; functional style.
- Zod for every tool input and output. New tools are declared with `defineTool` in their own `src/tools/<tool>.ts` and listed in a `src/tools/registry/*.ts` module: a short title, a description of at most 1000 characters, `readOnlyHint: true`, an output schema, compact JSON text, results within `MAX_TOOL_TEXT_CHARS`. An aggregate-mode variant is registered only through `ToolDefinition.aggregate`.
- Analytics outputs carry `notes`, `warnings`, `truncated`, `disclaimer` and `data_quality` (local-time periods, per-source quality, `method_version`, limitations).
- **Local days** come only from `placeDays`/`assignWorkouts`; day-windowed fetches use `fetchRangeForDays` (two days either side). A workout belongs to the day of the cycle containing its start.
- **Unknown is null, never 0.** Unscored records never contribute values; calibrating recoveries are flagged and, by default, excluded from baselines and associations; minimum sample sizes are named constants with `n of required` notes.
- **Sleep hours are time asleep** (light + slow-wave + REM) on main sleeps; naps are separate; WHOOP's nap need is 0 or negative.
- Aggregate on unrounded values; round only at output.
- Generated analysis text is observational: no advice or causal wording (`assertNeutralText` in tests).
- All sources failed: throw the most relevant WHOOP error; partial failure: warnings and nulls; history budget or deadline: `truncated` plus a note.
- Errors shown to clients depend on error type and HTTP status only (`describeWhoopError`); logs never contain argument values, record values, tokens or response bodies.
- Prompt arguments are interpolated only after allowlist, pattern or clamp checks.

## Testing

- **TDD:** write tests before code (Prove-It pattern for bugs).
- **Never hit the real WHOOP API in tests.** Use `createWhoopFixtureClient` with `liveShapedUser` (live-verified shapes, calibrating, partial first day), `matureUser` (120 days with gaps, naps, offset change, pending last night) and `stressUser` (365 days, size limits); pin the clock with `vi.setSystemTime`.
- Contract tests go through `connectServer` (a real MCP client) in both privacy modes.
- Goldens under `tests/golden` belong to the package that owns the tool, resource or prompt; regenerate only your own with `UPDATE_GOLDENS=<paths>` and review every diff.
- `tests/aggregate-cross-tool.test.ts` must stay green for any change to an aggregate tool; it reconstructs every released value and checks that no single record can be recovered across tools.
- Run `npm test`, `npm run typecheck` and `npm run lint` before every commit. The typecheck excludes tests; typecheck changed test files too.

## WHOOP API Reference

- **Base URL:** `https://api.prod.whoop.com/developer`
- **OAuth Auth URL:** `https://api.prod.whoop.com/oauth/oauth2/auth`
- **OAuth Token URL:** `https://api.prod.whoop.com/oauth/oauth2/token`
- **Scopes:** `offline read:recovery read:cycles read:workout read:sleep read:profile read:body_measurement`
- **App limits:** 100 requests per minute, 10,000 per day (the server paces itself at 60 per minute by default).
- **Verified live behaviour:** collections are newest first with explicit nulls and `next_token: null` on the last page; `limit` is at most 25; `start` includes records still ongoing, `end` is exclusive on record start; a cycle starts at sleep onset, consecutive cycles share exact boundaries and the open cycle has `end: null`; `percent_recorded` is a 0-1 fraction and zone durations sum to duration × fraction; running has `sport_id` 0.
- **Not available from the API:** Strength Trainer sets and weights, journal, stress, steps, VO2 max, continuous HR/HRV, body measurement history.

| Endpoint                                                | Used by                                                        |
| ------------------------------------------------------- | -------------------------------------------------------------- |
| `GET /v2/user/profile/basic`                            | `get_profile`, profile resource, authenticated `/health` probe |
| `GET /v2/user/measurement/body`                         | `get_body_measurement`, `get_personal_records`                 |
| `GET /v2/recovery`                                      | recovery collection and analysis tools                         |
| `GET /v2/activity/sleep`, `/v2/activity/sleep/{id}`     | sleep collection, by-id and analysis tools                     |
| `GET /v2/activity/workout`, `/v2/activity/workout/{id}` | workout collection, by-id and training tools                   |
| `GET /v2/cycle`, `/v2/cycle/{id}`                       | cycle collection, by-id, day placement in every day-based tool |
| `DELETE /v2/user/access`                                | `revoke` CLI only (never an MCP tool)                          |

## Boundaries

### Always

- Run `npm test` before every commit
- Validate all tool input and output with Zod schemas
- Store tokens with `0600` permissions in a `0700` folder (`WHOOP_MCP_TOKEN_DIR`, else `~/.whoop-mcp`)
- Return helpful error messages (Claude needs to understand failures)
- Keep aggregate mode free of per-day values, single records and exact activity times
- Build in small, verifiable increments: implement → test → verify → commit

### Ask First

- Adding any runtime dependency beyond `@modelcontextprotocol/sdk` and `zod`
- Changing the token storage location or format
- Adding WHOOP API endpoints beyond the table above (0.8.0 added `DELETE /v2/user/access` for the human-only `revoke` CLI with owner sign-off)
- Changing the OAuth flow, the connector's token or registration model, or startup authentication (0.8.0's degraded startup was signed off by the owner)
- Skipping tests on a platform (0.8.0's win32 skips were signed off by the owner)
- Persisting health data, tags or webhook events anywhere (today only `tokens.json` is stored)
- Database schema changes

### Never

- Commit `WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET`, `MCP_AUTH_TOKEN`, `MCP_JWT_SECRET` or tokens
- Store tokens in a world-readable location
- Make real WHOOP API calls in automated tests
- Run two server instances with the same `tokens.json` (WHOOP rotates refresh tokens)
- Expose a mutating WHOOP call (such as revoking access) as an MCP tool
- Use `any` — strict TypeScript throughout
- Remove or skip failing tests without discussion
- Mix formatting changes with behavior changes
