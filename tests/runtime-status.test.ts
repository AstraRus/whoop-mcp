import { readFileSync } from "node:fs";
import { describe, it, expect, vi, afterEach } from "vitest";
import { createRateLimiter } from "../src/api/rate-limiter.js";
import { createRuntimeStatus, packageVersion, readCommit } from "../src/runtime-status.js";

describe("readCommit", () => {
  it("prefers RAILWAY_GIT_COMMIT_SHA and shortens it to 12 characters", () => {
    expect(
      readCommit({
        RAILWAY_GIT_COMMIT_SHA: "897d74bA1b2c3d4e5f60718293a4b5c6d7e8f901",
        SOURCE_COMMIT: "1234567",
      })
    ).toBe("897d74bA1b2c");
  });

  it("falls back to SOURCE_COMMIT and accepts a 7-character id", () => {
    expect(readCommit({ SOURCE_COMMIT: "897d74b" })).toBe("897d74b");
  });

  it("returns null for missing or malformed ids", () => {
    expect(readCommit({})).toBeNull();
    expect(readCommit({ RAILWAY_GIT_COMMIT_SHA: "main" })).toBeNull();
    expect(readCommit({ SOURCE_COMMIT: "abc12" })).toBeNull();
    expect(readCommit({ SOURCE_COMMIT: "g".repeat(12) })).toBeNull();
    expect(readCommit({ SOURCE_COMMIT: "a".repeat(41) })).toBeNull();
  });
});

describe("packageVersion", () => {
  it("is the package.json version", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as {
      version: string;
    };
    expect(packageVersion()).toBe(pkg.version);
  });
});

describe("createRuntimeStatus", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts with an empty snapshot", () => {
    const status = createRuntimeStatus({
      version: "1.2.3",
      commit: null,
      privacyMode: "standard",
      now: () => Date.parse("2026-09-16T10:00:00Z"),
    });

    expect(status.snapshot()).toEqual({
      version: "1.2.3",
      commit: null,
      started_at: "2026-09-16T10:00:00.000Z",
      privacy_mode: "standard",
      oauth_connector: false,
      webhooks: { enabled: false, last_event_at: null },
      whoop_auth: { access_token_expires_at: null, last_refresh: null },
      whoop_api: {
        requests_last_minute: 0,
        requests_today_utc: 0,
        throttled_waits_total: 0,
        rate_limited_responses_total: 0,
        last_rate_limited_at: null,
      },
    });
  });

  it("records refreshes, token expiry, webhooks, flags and limiter counters", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-09-16T10:00:00Z"));
    const status = createRuntimeStatus({
      version: "1.2.3",
      commit: "897d74b",
      privacyMode: "aggregate",
    });
    const limiter = createRateLimiter({ perMinute: 60 });
    status.attachLimiter(limiter);

    vi.setSystemTime(Date.parse("2026-09-16T10:05:00Z"));
    status.recordRefresh("transient_failure");
    status.recordRefresh("ok");
    status.setAccessTokenExpiry(Date.parse("2026-09-16T11:05:00Z"));
    status.recordWebhook();
    status.setFlags({ oauthConnector: true });
    status.setFlags({ webhooksEnabled: true });
    (await limiter.acquire())();
    limiter.note429(null);

    const snapshot = status.snapshot();
    expect(snapshot).toMatchObject({
      commit: "897d74b",
      started_at: "2026-09-16T10:00:00.000Z",
      privacy_mode: "aggregate",
      oauth_connector: true,
      webhooks: { enabled: true, last_event_at: "2026-09-16T10:05:00.000Z" },
      whoop_auth: {
        access_token_expires_at: "2026-09-16T11:05:00.000Z",
        last_refresh: { at: "2026-09-16T10:05:00.000Z", outcome: "ok" },
      },
      whoop_api: {
        requests_last_minute: 1,
        requests_today_utc: 1,
        rate_limited_responses_total: 1,
        last_rate_limited_at: "2026-09-16T10:05:00.000Z",
      },
    });

    status.setAccessTokenExpiry(null);
    expect(status.snapshot().whoop_auth.access_token_expires_at).toBeNull();
  });
});
