# Deploying whoop-ai-mcp on Railway

A runbook for one person's WHOOP MCP server on [Railway](https://railway.app),
reachable from claude.ai (web and mobile), Claude Desktop and Claude Code over
HTTPS. It covers the first deploy, the first WHOOP sign-in on the hosted
server, verifying a deploy, secret rotation, degraded startup and rollback.

The server is single-owner: one WHOOP account, one `tokens.json`, one running
instance.

> **Never run two instances with the same `tokens.json`.** WHOOP rotates the
> refresh token on every refresh. When two processes (two replicas, a local copy
> of the production file, a staging service sharing the volume) refresh with the
> same token, the second refresh is rejected and the grant can be revoked, so
> every instance has to sign in again. Keep the Railway service at one replica
> and never copy the production `tokens.json` anywhere else.

## 1. Before you start

- A WHOOP Developer App from [developer.whoop.com](https://developer.whoop.com)
  with the scopes `read:recovery`, `read:cycles`, `read:workout`, `read:sleep`,
  `read:profile` and `read:body_measurement`. Keep its Client ID and Client
  Secret at hand.
- A Railway project connected to your fork of this repository. Railway builds
  the [Dockerfile](../Dockerfile) automatically.
- Secrets generated locally:

  ```bash
  openssl rand -hex 32      # MCP_AUTH_TOKEN
  openssl rand -hex 32      # MCP_JWT_SECRET
  openssl rand -base64 24   # MCP_CONNECTOR_PASSWORD (at least 12 characters)
  ```

## 2. Service settings

1. **Networking:** generate a public domain. Railway terminates TLS. The image
   sets `MCP_PORT=3000`, which takes precedence over Railway's `PORT`, so point
   the domain at port **3000**. (Without `MCP_PORT` the server would listen on
   `PORT`; both are validated as integers 0-65535.)
2. **Replicas:** 1.
3. **Health check path:** `/health`. Without a bearer token it answers
   `{"status":"ok"}` and never calls WHOOP. `/health` is served once startup
   authentication is done. With a stored `tokens.json` that is bounded to about
   2.5 minutes even while WHOOP's token endpoint is unreachable (each token
   request times out after 30 seconds, and startup retries stop after a
   120-second budget; see section 8), so keep Railway's health check timeout
   (300 seconds by default) above 180 seconds. A first sign-in (section 4)
   waits longer.
4. **Volume:** one volume holding `tokens.json`, mounted at the token folder
   (see below). A new deployment can mount it at **`/data`**; an existing one
   keeps its mount.

### Token folder

The token folder is **`WHOOP_MCP_TOKEN_DIR` when it is set, else
`$HOME/.whoop-mcp`** (`/root/.whoop-mcp` when `HOME` is not set). That is the
same folder 0.7.x used (`~/.whoop-mcp` through `os.homedir()`, running as
root). [docker/entrypoint.sh](../docker/entrypoint.sh) resolves it once and
exports it as `WHOOP_MCP_TOKEN_DIR`, because the server then runs with
`HOME=/home/node` and would otherwise look somewhere else.

The container starts as root only long enough for the entrypoint to prepare
that folder: it hands the folder and `tokens.json` to the built-in `node` user
(never recursively, with 0700/0600 permissions), checks that `node` can create,
rename and delete files there, and then runs the server as `node`. If that is
not possible (a read-only volume, storage that refuses `chown`) it logs one
warning, `entrypoint: running as root (<reason>); the server still works, see
docs/deploy-railway.md`, and keeps running as root with the same folder, as
earlier images did. `WHOOP_MCP_RUN_AS_ROOT=1` skips the switch on purpose.

> **`WHOOP_MCP_TOKEN_DIR` must always equal the volume's mount path.** A path
> without a volume behind it holds no `tokens.json`: the server starts the WHOOP
> sign-in (section 4) instead of serving, and whatever it saves there is lost on
> the next deploy. Leave the variable unset, or set it to exactly the mount path.

**Existing deployment (`HOME=/home/node`, volume at `/home/node/.whoop-mcp`):
change nothing.** Do not add `WHOOP_MCP_TOKEN_DIR` pointing anywhere else and do
not move the volume. With `WHOOP_MCP_TOKEN_DIR` unset the entrypoint uses and
exports `$HOME/.whoop-mcp`, which is `/home/node/.whoop-mcp`, the folder that
already holds `tokens.json`. The same applies to a volume at `/root/.whoop-mcp`
without `HOME` set. Setting `WHOOP_MCP_TOKEN_DIR=/home/node/.whoop-mcp`
explicitly is optional and changes nothing.

**New deployments only:** mount the volume at `/data` and set
`WHOOP_MCP_TOKEN_DIR=/data`. Never switch an existing deployment to `/data` by
changing the variable alone. To move one, mount a new volume at `/data`, set
`WHOOP_MCP_TOKEN_DIR=/data` in the same deploy and sign in once (section 4); do
not copy the old `tokens.json` while the old service can still refresh it.

### Upgrading an existing deployment to 0.8.0 (checklist)

1. Confirm the volume's mount path in Railway (for example
   `/home/node/.whoop-mcp` with `HOME=/home/node`) and that
   `WHOOP_MCP_TOKEN_DIR` is unset or equal to that path.
2. Optionally set `WHOOP_MCP_TOKEN_DIR` to the mount path (for example
   `/home/node/.whoop-mcp`) before pushing. 0.7.x ignores the variable, so it
   is safe to add while the old release still runs.
3. In the service settings, enable **Wait for CI** so a push to `main` deploys
   only after the CI checks pass, and set the health check path to `/health`
   (section 2).
4. After the deploy, the logs show `entrypoint: running as node` (or the root
   warning), `Using cached WHOOP tokens` and `http transport listening`, and
   never `starting OAuth flow`. Then verify as in section 5.

## 3. Variables

Required:

| Variable              | Value                                                                               |
| --------------------- | ----------------------------------------------------------------------------------- |
| `WHOOP_CLIENT_ID`     | WHOOP app Client ID                                                                 |
| `WHOOP_CLIENT_SECRET` | WHOOP app Client Secret (also verifies webhooks)                                    |
| `MCP_TRANSPORT`       | `http` (the image default)                                                          |
| `MCP_AUTH_TOKEN`      | the static bearer token (32+ random bytes)                                          |
| `MCP_TRUST_PROXY`     | `1` (Railway's proxy sets `X-Forwarded-For`; per-IP limits need the real client IP) |

Token folder (section 2):

| Variable              | Value                                                                                                                                                                |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WHOOP_MCP_TOKEN_DIR` | New deployments (volume at `/data`): `/data`. Existing deployments: unset, or exactly the volume's mount path (e.g. `/home/node/.whoop-mcp` with `HOME=/home/node`). |

For claude.ai (the OAuth connector, mounted only when all three are set):

| Variable                 | Value                                                                                                                                           |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `MCP_CONNECTOR_PASSWORD` | the password you type when claude.ai connects (at least 12 characters)                                                                          |
| `PUBLIC_URL`             | `https://<your-domain>` (https only, no path)                                                                                                   |
| `ALLOWED_REDIRECT_URIS`  | `https://claude.ai/api/mcp/auth_callback` (comma-separated, exact match; add `https://claude.com/api/mcp/auth_callback` if your client uses it) |
| `MCP_JWT_SECRET`         | recommended: a fixed signing key, so rotating `MCP_AUTH_TOKEN` does not sign out claude.ai                                                      |

Optional: `WHOOP_WEBHOOKS=1` (section 6), `WHOOP_RATE_LIMIT_PER_MINUTE`
(10-95, default 60), `MCP_MAX_CONNECTIONS` (1-100, default 16),
`WHOOP_MCP_PRIVACY_MODE=aggregate`, `MCP_ALLOWED_ORIGINS`, `LOG_LEVEL`,
`LOG_FORMAT`. Railway sets `RAILWAY_GIT_COMMIT_SHA` itself; the server reports
its first 12 characters as `commit`. The full list is in the
[README](../README.md#environment-variables).

## 4. First WHOOP sign-in on the hosted server

The server needs a `tokens.json` before it serves anything. When the token
folder is empty it runs WHOOP's authorization-code sign-in: it starts a
temporary callback server on port 3000, prints the authorization URL to the
logs and waits for WHOOP to redirect back to `/callback`. On Railway that
callback has to be reachable through the public domain.

1. In the WHOOP developer dashboard, add the redirect URI
   `https://<your-domain>/callback` to the app (keep
   `http://localhost:3000/callback` for local use).
2. Add these variables for the first deploy:

   | Variable              | Value                                                           |
   | --------------------- | --------------------------------------------------------------- |
   | `WHOOP_REDIRECT_URI`  | `https://<your-domain>/callback`                                |
   | `CALLBACK_HOST`       | `0.0.0.0` (the callback server listens on 127.0.0.1 by default) |
   | `CALLBACK_TIMEOUT_MS` | `600000` (10 minutes to finish signing in; default 120000)      |

3. Deploy and open the deploy logs. Copy the URL after
   `If the browser didn't open, visit:` and open it in your browser.
4. Sign in to WHOOP and approve the scopes. The browser shows a success page,
   the server saves `tokens.json` in the token folder and continues starting. The log
   shows `whoop authentication complete` and `http transport listening`.
5. Remove `CALLBACK_HOST` again. The callback server only runs while a sign-in
   is waiting, but there is no reason to leave it on a public interface.

While the server waits for the sign-in, the callback server holds port 3000 and
`/health` answers 404, so a Railway health check can fail the deploy if the
sign-in takes longer than its timeout. Finish the sign-in promptly, or leave the
health check path empty for this one deploy. If `CALLBACK_TIMEOUT_MS` passes
without a sign-in, the process exits.

An **existing** deployment should never show the authorization URL. If it does,
the token folder does not match the volume (section 2): do not sign in (the new
tokens would land outside the volume), fix `WHOOP_MCP_TOKEN_DIR` or the mount
and redeploy.

## 5. Verify a deploy

```bash
curl -s -H "Authorization: Bearer $MCP_AUTH_TOKEN" https://<your-domain>/health
```

An authenticated `/health` (the static token or a connector access token)
returns the runtime status. It makes one WHOOP request (the profile) for
`whoopApi`.

```json
{
  "status": "ok",
  "uptime": 512,
  "version": "0.8.0",
  "commit": "0123456789ab",
  "whoopApi": "ok",
  "privacyMode": "standard",
  "oauthConnector": true,
  "webhooks": { "enabled": false, "lastEventAt": null },
  "whoopAuth": { "accessTokenExpiresInS": 3120, "lastRefresh": { "at": "…", "outcome": "ok" } },
  "whoopRate": { "requestsLastMinute": 1, "requestsTodayUtc": 42, "rateLimitedResponsesTotal": 0 }
}
```

Check:

- `version` is the release you deployed and `commit` matches the deployed
  commit (the first 12 characters of `RAILWAY_GIT_COMMIT_SHA`);
- `whoopApi` is `ok` and `whoopAuth.lastRefresh.outcome` is `ok` (or `null`
  right after a start with unexpired tokens);
- `oauthConnector` is `true` when the claude.ai variables are set;
- `whoopRate.requestsLastMinute` moves when you call a tool, and
  `rateLimitedResponsesTotal` stays at 0.

Then call `get_sync_status` from your MCP client: `assessment` should be
`up_to_date` (or explain why data is missing), and `server.version` and
`server.commit` repeat the values above.

## 6. Webhooks (optional)

Webhooks only make cached WHOOP data expire sooner; without them, recent
edits appear once the cache entries expire (2 minutes for the newest data, up
to 60 minutes for older days and 6 hours for data older than 30 days).

1. Set `WHOOP_WEBHOOKS=1` and redeploy.
2. In the WHOOP developer dashboard, set the app's webhook URL to
   `https://<your-domain>/webhooks/whoop` (webhook model version v2).
3. After the next sleep or workout syncs, authenticated `/health` shows
   `webhooks.lastEventAt`.

WHOOP sends `recovery.*`, `sleep.*` and `workout.*` updated and deleted
events; there are no cycle events. Each delivery is verified with
`WHOOP_CLIENT_SECRET` (HMAC-SHA256 over the timestamp and the raw body; the
timestamp must be within the last 2 hours or at most 5 minutes ahead) and
then clears the matching cached collections: a workout clears workouts and
cycles, a sleep clears sleeps, cycles and recoveries, a recovery clears
recoveries. Nothing is stored and no client is notified. Replayed deliveries
(same `trace_id` within 2 hours) are acknowledged without clearing again.

## 7. Rotating secrets

| Secret                   | Effect                                                                                                                                                                                                                                                                                                                                        | Steps                                                                                                                                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MCP_AUTH_TOKEN`         | Static-bearer clients (Claude Desktop, Claude Code) need the new token. **Without `MCP_JWT_SECRET`, the connector signing key is derived from `MCP_AUTH_TOKEN`: every claude.ai session (access and refresh tokens) and every dynamically registered client id and secret stop working**, so the connector has to be removed and added again. | Set `MCP_JWT_SECRET` first (this alone also invalidates connector sessions once), then rotate `MCP_AUTH_TOKEN` freely.                                                                                      |
| `MCP_JWT_SECRET`         | Every claude.ai session and registered client stops working; static bearer tokens are unaffected.                                                                                                                                                                                                                                             | Rotate, redeploy, reconnect claude.ai.                                                                                                                                                                      |
| `MCP_CONNECTOR_PASSWORD` | Only new sign-ins need the new password; connected sessions keep working (access tokens last 24 hours and are renewed with 30-day refresh tokens).                                                                                                                                                                                            | Rotate, redeploy. Rotate `MCP_JWT_SECRET` too to sign everyone out.                                                                                                                                         |
| `ALLOWED_REDIRECT_URIS`  | Registered clients are re-checked against the current list: removing a redirect URI disables the clients registered with it.                                                                                                                                                                                                                  | Change, redeploy, reconnect affected clients.                                                                                                                                                               |
| `WHOOP_CLIENT_SECRET`    | Token refreshes need the new secret; webhooks are signed with it.                                                                                                                                                                                                                                                                             | Rotate in the WHOOP dashboard, set the new value, set `WHOOP_CLIENT_SECRET_PREVIOUS` to the old one while deliveries signed with it can still arrive, redeploy, then remove `WHOOP_CLIENT_SECRET_PREVIOUS`. |

Refresh-token reuse detection for the connector is kept in memory, so a
restart forgets which connector refresh tokens were already used; they still
expire after 30 days.

## 8. Degraded startup

A WHOOP token-endpoint outage must not turn into a crash loop. At startup, when
the stored access token has expired and WHOOP cannot refresh it right now (a
network error, HTTP 429 or 5xx, or `invalid_client` for the app credentials),
the server:

1. logs `whoop token refresh failed at startup; retrying` and retries after 5,
   15 and 45 seconds, as long as the next attempt starts within 120 seconds of
   the first (each token request times out after 30 seconds, so startup takes
   at most about 2.5 minutes);
2. if the refresh still fails and `tokens.json` exists, starts anyway with the
   stored tokens and logs `whoop token refresh unavailable at startup; serving
with stored tokens` with the HTTP status or error class;
3. refreshes on demand: the first tool call gets a 401 from WHOOP, the client
   refreshes, and a tool that still cannot reach WHOOP returns a plain
   explanation ("WHOOP's sign-in service is temporarily unavailable. Your
   sign-in is still valid; retry shortly.").

Authenticated `/health` shows `whoopAuth.lastRefresh.outcome` as
`transient_failure` or `client_rejected` until a refresh succeeds.
`client_rejected` means WHOOP refused `WHOOP_CLIENT_ID`/`WHOOP_CLIENT_SECRET`:
fix the variables; the WHOOP sign-in itself is still valid.

Only a refused refresh token (HTTP 400 or 401 other than `invalid_client`,
for example `invalid_grant`) starts the sign-in flow of section 4 again. A
failure while no `tokens.json` exists yet (during a first sign-in) exits the
process with the error.

## 9. Rollback

Railway → the service → **Deployments** → the previous successful deployment →
**Redeploy**. The volume and `tokens.json` are unaffected, and 0.8.0 did not
change the token file format.

- Rolling back to **0.8.x**: nothing else to do.
- Rolling back to **0.7.x or earlier**: those images run as root, use
  `$HOME/.whoop-mcp` (`os.homedir()`, so `/home/node/.whoop-mcp` with
  `HOME=/home/node`) and ignore `WHOOP_MCP_TOKEN_DIR`. If the volume is already
  mounted at `$HOME/.whoop-mcp`, change nothing: root can read and write the
  files the entrypoint handed to `node`. Only a volume that was moved to `/data`
  must be mounted back at `$HOME/.whoop-mcp` for the rollback; otherwise the
  old release finds no tokens and starts the sign-in flow. Aggregate-mode
  clients also get the older, looser aggregate outputs back.

## 10. Troubleshooting on Railway

| Symptom                                                                                                                | Cause and fix                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Deploy log: `Invalid MCP_PORT`, `Invalid PORT`, `Invalid MCP_MAX_CONNECTIONS` or `Invalid WHOOP_RATE_LIMIT_PER_MINUTE` | The value is outside its range; the message names the variable and the allowed range.                                                                                                                                                                                          |
| Deploy log: `WHOOP_MCP_TOKEN_DIR must be an absolute path`                                                             | Use the volume's absolute mount path (e.g. `/home/node/.whoop-mcp` or `/data`), or unset the variable.                                                                                                                                                                         |
| Deploy log of an existing deployment: `No cached tokens found, starting OAuth flow` and an authorization URL           | The token folder is not the volume: `WHOOP_MCP_TOKEN_DIR` points elsewhere, or the volume moved. Do not sign in; make the variable equal the mount path (or unset it when the volume is at `$HOME/.whoop-mcp`) and redeploy.                                                   |
| Log: `entrypoint: running as root (...)`                                                                               | The volume could not be handed to `node`; the reason is in the line. The server still works, with the same token folder.                                                                                                                                                       |
| Log: `Cannot read the WHOOP token file <path> (<code>)`                                                                | `tokens.json` exists but this process cannot read it, so no new sign-in was started. Usually the container runs with `--user` (or a custom start command) against a root-owned volume: start it as root so the entrypoint prepares the folder, or `chown 1000:1000` the files. |
| Log: `whoop token save failed` with `EACCES`                                                                           | The server runs as `node` but cannot write the token folder, usually because `WHOOP_MCP_TOKEN_DIR` points outside the prepared volume. Fix the path and redeploy; the rotated tokens are kept in memory until then.                                                            |
| claude.ai: "couldn't connect" or repeated sign-in                                                                      | `PUBLIC_URL` must be the exact https origin; `ALLOWED_REDIRECT_URIS` must contain claude.ai's callback exactly; `MCP_TRUST_PROXY=1`. A 401 from `/mcp` carries `WWW-Authenticate: Bearer ... resource_metadata="https://<domain>/.well-known/oauth-protected-resource/mcp"`.   |
| 503 `Maximum connections reached` with `Retry-After: 1`                                                                | More than `MCP_MAX_CONNECTIONS` requests ran at once and 32 more waited over 5 seconds. Raise `MCP_MAX_CONNECTIONS` or let the client retry.                                                                                                                                   |
| Tools say the server paused WHOOP requests                                                                             | The process-wide limiter (60 requests per minute by default) ran out within the call's 20-second budget; retry in a minute.                                                                                                                                                    |
