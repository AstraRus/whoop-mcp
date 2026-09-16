/**
 * Process-wide runtime status: build identity, WHOOP authentication state,
 * webhook activity and WHOOP request counters, for authenticated health
 * checks and the sync-status tool.
 *
 * Never holds token values, WHOOP ids, URLs or health data.
 */

import { readFileSync } from "node:fs";
import type { RateLimiter, RateLimiterStats } from "./api/rate-limiter.js";
import type { PrivacyMode } from "./privacy.js";

// ---------------------------------------------------------------------------
// Package version
// ---------------------------------------------------------------------------

function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as {
      version?: unknown;
    };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Read once at module load. */
const PACKAGE_VERSION = readPackageVersion();

/** The package.json version ("0.0.0" when it cannot be read), read once at startup. */
export function packageVersion(): string {
  return PACKAGE_VERSION;
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/i;

/** Length of the commit id reported in status output. */
export const COMMIT_ID_LENGTH = 12;

/**
 * The deployed git commit: RAILWAY_GIT_COMMIT_SHA, else SOURCE_COMMIT, when it
 * is a 7-40 character hex id; its first 12 characters, or null.
 */
export function readCommit(env: Record<string, string | undefined>): string | null {
  const raw = env.RAILWAY_GIT_COMMIT_SHA ?? env.SOURCE_COMMIT;
  if (raw === undefined) return null;
  const value = raw.trim();
  return COMMIT_PATTERN.test(value) ? value.slice(0, COMMIT_ID_LENGTH) : null;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Outcome of a WHOOP token refresh. */
export type RefreshOutcome = "ok" | "transient_failure" | "rejected" | "client_rejected";

/** A point-in-time copy of the runtime status. Timestamps are ISO 8601 UTC. */
export interface RuntimeSnapshot {
  version: string;
  commit: string | null;
  started_at: string;
  privacy_mode: PrivacyMode;
  oauth_connector: boolean;
  webhooks: { enabled: boolean; last_event_at: string | null };
  whoop_auth: {
    access_token_expires_at: string | null;
    last_refresh: { at: string; outcome: RefreshOutcome } | null;
  };
  whoop_api: RateLimiterStats;
}

/** Mutable process-wide runtime status. */
export interface RuntimeStatus {
  snapshot(): RuntimeSnapshot;
  recordRefresh(outcome: RefreshOutcome): void;
  /** Expiry of the access token in use (epoch ms), or null when unknown. */
  setAccessTokenExpiry(expiresAtMs: number | null): void;
  /** A verified webhook event arrived. */
  recordWebhook(): void;
  setFlags(flags: { oauthConnector?: boolean; webhooksEnabled?: boolean }): void;
  /** Report this limiter's counters under whoop_api. */
  attachLimiter(limiter: Pick<RateLimiter, "stats">): void;
}

/** Options for {@link createRuntimeStatus}. */
export interface RuntimeStatusOptions {
  version: string;
  commit: string | null;
  privacyMode: PrivacyMode;
  /** Clock in epoch ms. Default Date.now (read at call time). */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const EMPTY_API_STATS: RateLimiterStats = {
  requests_last_minute: 0,
  requests_today_utc: 0,
  throttled_waits_total: 0,
  rate_limited_responses_total: 0,
  last_rate_limited_at: null,
};

function isoOrNull(ms: number | null): string | null {
  return ms === null || !Number.isFinite(ms) ? null : new Date(ms).toISOString();
}

/** Create the runtime status for this process. */
export function createRuntimeStatus(options: RuntimeStatusOptions): RuntimeStatus {
  const now = options.now ?? ((): number => Date.now());
  const startedAt = now();
  let oauthConnector = false;
  let webhooksEnabled = false;
  let lastWebhookAt: number | null = null;
  let accessTokenExpiresAt: number | null = null;
  let lastRefresh: { at: number; outcome: RefreshOutcome } | null = null;
  let limiter: Pick<RateLimiter, "stats"> | null = null;

  return {
    snapshot(): RuntimeSnapshot {
      return {
        version: options.version,
        commit: options.commit,
        started_at: new Date(startedAt).toISOString(),
        privacy_mode: options.privacyMode,
        oauth_connector: oauthConnector,
        webhooks: { enabled: webhooksEnabled, last_event_at: isoOrNull(lastWebhookAt) },
        whoop_auth: {
          access_token_expires_at: isoOrNull(accessTokenExpiresAt),
          last_refresh:
            lastRefresh === null
              ? null
              : { at: new Date(lastRefresh.at).toISOString(), outcome: lastRefresh.outcome },
        },
        whoop_api: limiter === null ? { ...EMPTY_API_STATS } : limiter.stats(),
      };
    },
    recordRefresh(outcome: RefreshOutcome): void {
      lastRefresh = { at: now(), outcome };
    },
    setAccessTokenExpiry(expiresAtMs: number | null): void {
      accessTokenExpiresAt = expiresAtMs;
    },
    recordWebhook(): void {
      lastWebhookAt = now();
    },
    setFlags(flags: { oauthConnector?: boolean; webhooksEnabled?: boolean }): void {
      if (flags.oauthConnector !== undefined) oauthConnector = flags.oauthConnector;
      if (flags.webhooksEnabled !== undefined) webhooksEnabled = flags.webhooksEnabled;
    },
    attachLimiter(attached: Pick<RateLimiter, "stats">): void {
      limiter = attached;
    },
  };
}
