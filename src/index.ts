#!/usr/bin/env node

/**
 * WHOOP MCP Server entry point.
 *
 * Reads OAuth credentials and transport configuration from environment
 * variables, authenticates with WHOOP, creates the API client (with
 * automatic token refresh), builds the MCP server, and connects it to
 * the configured transport(s).
 *
 * Supported transports (via `MCP_TRANSPORT`):
 *   stdio  — local Claude Desktop / Claude Code (default)
 *   http   — remote HTTP transport (claude.ai, Cursor, custom integrations)
 *   both   — stdio AND HTTP simultaneously
 *
 * All logging goes to stderr — stdout is reserved for the MCP stdio channel.
 */

import { authenticate, refreshAccessToken, toOAuthTokens } from "./auth/oauth.js";
import type { OAuthConfig } from "./auth/oauth.js";
import { loadTokens, saveTokens, type OAuthTokens } from "./auth/token-store.js";
import { createWhoopClient } from "./api/client.js";
import { TokenRefreshError } from "./auth/token-refresh-error.js";
import { MemoryCache } from "./cache/memory-cache.js";
import { createWhoopServer } from "./server.js";
import { connectStdioTransport } from "./transport/stdio.js";
import { createHttpServer, type HttpServerResult } from "./transport/http.js";
import { createLogger, type LogLevel, type Logger } from "./logging/logger.js";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { privacyModeSchema } from "./privacy.js";
import {
  createRateLimiter,
  DEFAULT_RATE_LIMIT_PER_MINUTE,
  MAX_RATE_LIMIT_PER_MINUTE,
  MIN_RATE_LIMIT_PER_MINUTE,
} from "./api/rate-limiter.js";
import { HISTORY_CACHE_PREFIX } from "./api/history.js";
import { createRuntimeStatus, packageVersion, readCommit } from "./runtime-status.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TransportMode = "stdio" | "http" | "both";

// ---------------------------------------------------------------------------
// Env parsing helpers
// ---------------------------------------------------------------------------

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}.\n` +
        `Set it in your Claude Desktop config or shell environment.\n` +
        `See: https://github.com/shashankswe2020-ux/whoop-mcp#configuration`
    );
  }
  return value;
}

function parseTransport(): TransportMode {
  const raw = (process.env.MCP_TRANSPORT ?? "stdio").toLowerCase().trim();
  if (raw === "stdio" || raw === "http" || raw === "both") {
    return raw;
  }
  throw new Error(
    `Invalid MCP_TRANSPORT: "${process.env.MCP_TRANSPORT}". ` + `Must be one of: stdio, http, both.`
  );
}

function parsePort(): number {
  const raw = process.env.MCP_PORT ?? "3000";
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0 || n > 65535) {
    throw new Error(`Invalid MCP_PORT: "${raw}". Must be an integer 0-65535.`);
  }
  return n;
}

function parseLogLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase().trim();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  throw new Error(
    `Invalid LOG_LEVEL: "${process.env.LOG_LEVEL}". ` + `Must be one of: debug, info, warn, error.`
  );
}

function parseLogFormat(): "json" | "pretty" {
  const raw = (process.env.LOG_FORMAT ?? "json").toLowerCase().trim();
  if (raw === "json" || raw === "pretty") return raw;
  throw new Error(`Invalid LOG_FORMAT: "${process.env.LOG_FORMAT}". Must be one of: json, pretty.`);
}

/**
 * WHOOP_RATE_LIMIT_PER_MINUTE: WHOOP requests per minute the server allows
 * itself (an integer 10-95; default 60, below WHOOP's limit of 100).
 */
export function parseRateLimitPerMinute(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_RATE_LIMIT_PER_MINUTE;
  const value = raw.trim();
  const n = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(n) || n < MIN_RATE_LIMIT_PER_MINUTE || n > MAX_RATE_LIMIT_PER_MINUTE) {
    throw new Error(
      `Invalid WHOOP_RATE_LIMIT_PER_MINUTE: "${raw}". Must be an integer ${MIN_RATE_LIMIT_PER_MINUTE}-${MAX_RATE_LIMIT_PER_MINUTE}.`
    );
  }
  return n;
}

/** Entries kept in the shared cache (API responses and history chunks). */
const CACHE_MAX_ENTRIES = 500;

function parseAllowedOrigins(): string[] {
  const raw = process.env.MCP_ALLOWED_ORIGINS;
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** The `code` of a failed file operation, for logging without paths or token values */
function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "string") return code;
  }
  return error instanceof Error ? error.name : "unknown";
}

/**
 * The token set to refresh from: the one on disk, unless the one kept in
 * memory is newer (its save failed, so disk still holds a refresh token WHOOP
 * already rotated). Tokens written by another process (e.g. setup --verify)
 * are newer than the in-memory ones and win.
 */
export function newestTokens(
  stored: OAuthTokens | null,
  inMemory: OAuthTokens | null
): OAuthTokens | null {
  if (stored === null) return inMemory;
  if (inMemory === null) return stored;
  return inMemory.expires_at > stored.expires_at ? inMemory : stored;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const privacyMode = privacyModeSchema.parse(process.env.WHOOP_MCP_PRIVACY_MODE ?? "standard");
  // Process-wide status (build, auth state, WHOOP request counters); never holds tokens.
  const runtime = createRuntimeStatus({
    version: packageVersion(),
    commit: readCommit(process.env),
    privacyMode,
  });
  // 1. Parse transport + logging configuration
  const transportMode = parseTransport();
  const logger: Logger = createLogger({
    level: parseLogLevel(),
    format: parseLogFormat(),
  });
  // Every WHOOP request of this process shares one limiter.
  const rateLimiter = createRateLimiter({
    perMinute: parseRateLimitPerMinute(process.env.WHOOP_RATE_LIMIT_PER_MINUTE),
    logger,
  });
  runtime.attachLimiter(rateLimiter);

  // 2. Read WHOOP OAuth credentials (always required)
  const clientId = getRequiredEnv("WHOOP_CLIENT_ID");
  const clientSecret = getRequiredEnv("WHOOP_CLIENT_SECRET");
  const oauthConfig: OAuthConfig = { clientId, clientSecret };

  // 3. Authenticate with WHOOP — uses cached tokens, refreshes, or runs full flow
  console.error("Authenticating with WHOOP...");
  /**
   * Newest tokens WHOOP issued to this process. WHOOP rotates refresh tokens,
   * so these must survive a failed save to disk.
   */
  let latestTokens: OAuthTokens | null = null;
  const accessToken = await authenticate(oauthConfig, {
    onTokens: (tokens) => {
      latestTokens = tokens;
      runtime.setAccessTokenExpiry(tokens.expires_at);
    },
  });
  console.error("Authentication successful.");
  logger.info("whoop authentication complete");

  // 4. Create the WHOOP API client with automatic token refresh.
  // A single process-wide cache is shared by the client (opt-in per request),
  // the MCP resources and the history loader. A token refresh removes every
  // entry except history chunks: it cannot change the WHOOP user (that takes a
  // restart), and access tokens are refreshed about hourly.
  const cache = new MemoryCache({ maxEntries: CACHE_MAX_ENTRIES });

  /**
   * WHOOP rejected `rejected`: make the stored tokens look expired so the next
   * start refreshes instead of reusing the cached access token, and so signs in
   * again (OAuth flow) when WHOOP still rejects the refresh. Tokens another
   * process saved in the meantime are left alone.
   */
  const markStoredTokensRejected = async (rejected: OAuthTokens): Promise<void> => {
    if (latestTokens?.refresh_token === rejected.refresh_token) {
      latestTokens = null;
    }
    try {
      const stored = await loadTokens();
      if (
        stored !== null &&
        stored.expires_at > 0 &&
        (stored.refresh_token === rejected.refresh_token ||
          stored.expires_at <= rejected.expires_at)
      ) {
        await saveTokens({ ...stored, expires_at: 0 });
      }
    } catch (error: unknown) {
      logger.error("whoop token store update failed", { code: errorCode(error) });
    }
  };

  const onTokenRefresh = async (): Promise<string> => {
    const tokens = newestTokens(await loadTokens(), latestTokens);
    if (!tokens) {
      throw new Error(
        "Token refresh failed: no stored tokens found. Re-authentication may be required."
      );
    }

    let refreshed: Awaited<ReturnType<typeof refreshAccessToken>>;
    try {
      refreshed = await refreshAccessToken(tokens.refresh_token, oauthConfig);
    } catch (error: unknown) {
      // Only a refusal of the refresh token itself means signing in again; a
      // network error or a transient 429/5xx leaves every token usable (and
      // the in-memory ones may be the only copy of a rotated refresh token).
      const rejected = error instanceof TokenRefreshError && error.rejected;
      runtime.recordRefresh(rejected ? "rejected" : "transient_failure");
      if (rejected) {
        await markStoredTokensRejected(tokens);
      }
      throw error;
    }
    const newTokens = toOAuthTokens(refreshed, tokens.refresh_token);
    // WHOOP has now invalidated the old refresh token: keep the new tokens in
    // memory first, so a failed save cannot lose them.
    latestTokens = newTokens;
    runtime.setAccessTokenExpiry(newTokens.expires_at);
    runtime.recordRefresh("ok");
    try {
      await saveTokens(newTokens);
    } catch (error: unknown) {
      logger.error("whoop token save failed", { code: errorCode(error) });
    }

    cache.deleteWhere((key) => !key.startsWith(HISTORY_CACHE_PREFIX));
    logger.info("whoop token refreshed");

    return newTokens.access_token;
  };

  const client = createWhoopClient({ accessToken, onTokenRefresh, logger, cache, rateLimiter });

  // 5. Create the MCP server with all WHOOP tools and resources
  const disableResources = process.env.WHOOP_MCP_DISABLE_RESOURCES === "1";
  const serverOptions = {
    disableResources,
    privacyMode,
    historyCache: cache,
    runtimeStatus: runtime,
    logger,
  };
  const { server } = createWhoopServer(client, serverOptions);

  // 6. Connect transports based on MCP_TRANSPORT mode
  const httpResults: HttpServerResult[] = [];
  let oauthCloseFn: (() => void) | null = null;

  if (transportMode === "stdio" || transportMode === "both") {
    await connectStdioTransport(server);
  }

  if (transportMode === "http" || transportMode === "both") {
    const authToken = getRequiredEnv("MCP_AUTH_TOKEN");
    const port = parsePort();
    const host = process.env.MCP_HOST ?? "0.0.0.0";
    const allowedOrigins = parseAllowedOrigins();
    const trustProxy = process.env.MCP_TRUST_PROXY === "1";

    // Lightweight upstream WHOOP health probe used by GET /health (authed).
    const healthCheck = async (): Promise<boolean> => {
      try {
        await client.get("/v2/user/profile/basic");
        return true;
      } catch {
        return false;
      }
    };

    // Optional OAuth 2.1 connector — mounted on the same HTTP port if all
    // required env vars are set. Letting any required var be missing simply
    // disables the connector (keeps stdio/http parity for local dev).
    let oauthHandler:
      | ((
          req: import("node:http").IncomingMessage,
          res: import("node:http").ServerResponse
        ) => void)
      | undefined;
    const connectorPassword = process.env.MCP_CONNECTOR_PASSWORD;
    const publicUrl = process.env.PUBLIC_URL;
    const allowedRedirectUris = process.env.ALLOWED_REDIRECT_URIS;

    if (connectorPassword && publicUrl && allowedRedirectUris) {
      const { createOAuthApp } = await import("./transport/oauth-connector.js");
      const { deriveJwtSecret, parseAllowedRedirectUris } =
        await import("./transport/oauth-helpers.js");
      const jwtSecretEnv = process.env.MCP_JWT_SECRET;
      const jwtSecret = jwtSecretEnv
        ? Buffer.from(jwtSecretEnv, "utf-8")
        : await deriveJwtSecret(authToken);
      const oauthApp = createOAuthApp({
        connectorPassword,
        publicUrl,
        allowedRedirectUris: parseAllowedRedirectUris(allowedRedirectUris),
        jwtSecret,
        scopes: ["mcp"],
        client: {
          clientId: process.env.MCP_OAUTH_CLIENT_ID ?? "whoop-mcp-connector",
          clientName: "WHOOP MCP Connector",
          redirectUris: parseAllowedRedirectUris(allowedRedirectUris),
        },
        trustProxy: trustProxy ? 1 : false,
      });
      oauthHandler = oauthApp.app as unknown as (
        req: import("node:http").IncomingMessage,
        res: import("node:http").ServerResponse
      ) => void;
      oauthCloseFn = oauthApp.close;
      logger.info("oauth connector mounted", { publicUrl });
    }

    const httpResult = await createHttpServer({
      authToken,
      port,
      host,
      allowedOrigins,
      trustProxy,
      healthCheck,
      oauthHandler,
      // A fresh server per request — a single shared server/transport can only
      // ever be initialized once, which locks out every reconnecting client.
      createMcpServer: () => createWhoopServer(client, serverOptions).server,
    });
    httpResults.push(httpResult);

    logger.info("http transport listening", {
      port,
      host,
      allowedOriginsCount: allowedOrigins.length,
      oauthMounted: oauthHandler !== undefined,
    });
  }

  // 7. Graceful shutdown — close HTTP servers on SIGTERM/SIGINT
  if (httpResults.length > 0) {
    const shutdown = async (): Promise<void> => {
      logger.info("shutting down");
      if (oauthCloseFn) {
        try {
          oauthCloseFn();
        } catch {
          /* ignore */
        }
      }
      for (const r of httpResults) {
        try {
          await r.close();
        } catch (err) {
          logger.error("error closing http server", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      process.exit(0);
    };
    process.once("SIGTERM", () => void shutdown());
    process.once("SIGINT", () => void shutdown());
  }

  // Existing tests assert this exact log line — keep it unchanged for compat
  console.error("WHOOP MCP server started on stdio.");
  logger.info("whoop mcp server started", { transport: transportMode });
}

// ---------------------------------------------------------------------------
// Auto-execute when run directly (not when imported in tests)
// ---------------------------------------------------------------------------

/**
 * Determine if this file is the Node.js entry point.
 *
 * Uses `realpathSync` to resolve symlinks — critical for `npx`, `npm link`,
 * and Claude Desktop's `{ "command": "npx" }` config, which all invoke the
 * binary through a symlink.
 */
function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const subcommand = process.argv[2];

  if (subcommand === "doctor") {
    void import("./cli/doctor.js")
      .then(async ({ runDoctor }) => {
        process.exitCode = await runDoctor(process.argv.slice(3));
      })
      .catch(() => {
        console.error("Local diagnostics failed.");
        process.exitCode = 1;
      });
  } else if (subcommand === "setup") {
    // Lazy-load so the setup CLI's deps aren't pulled into the hot stdio path.
    void (async (): Promise<void> => {
      try {
        const { runSetup, parseSetupArgs } = await import("./cli/setup.js");
        const opts = parseSetupArgs(process.argv.slice(3));
        await runSetup(opts);
      } catch (error: unknown) {
        console.error(`Setup failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      }
    })();
  } else {
    main().catch((error: unknown) => {
      console.error("Fatal error:", error);
      process.exit(1);
    });
  }
}
