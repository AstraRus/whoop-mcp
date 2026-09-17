/**
 * Tests for get_sync_status (package P3).
 *
 * Standard mode: one fixture per assessment including the 20-hour sleep and
 * 24-hour sync boundaries, a brand-new account, exact first dates under 90
 * days, a non-empty older-history probe, truncated history, auth failures,
 * the runtime server block, a key allowlist without health values, request
 * accounting on stressUser and the MCP contract.
 *
 * Aggregate mode: released weeks only, output invariant from Wednesday 00:00
 * to the next Tuesday 23:59 while sleeps, workouts and webhooks happen, no
 * dates or times beyond latest_week_start, and the MCP contract.
 */

import { describe, it, expect } from "vitest";
import { WhoopApiError, WhoopAuthError } from "../../src/api/client.js";
import { DEFAULT_PAGE_BUDGET, HISTORY_DEADLINE_MS } from "../../src/api/history.js";
import { createRateLimiter, DEFAULT_RATE_LIMIT_PER_MINUTE } from "../../src/api/rate-limiter.js";
import type { Cycle, Recovery, Sleep, Workout } from "../../src/api/types.js";
import { MemoryCache } from "../../src/cache/memory-cache.js";
import { createRuntimeStatus, packageVersion } from "../../src/runtime-status.js";
import { cycleDay, HOUR_MS } from "../../src/tools/analytics-utils.js";
import {
  getAggregateSyncStatus,
  getSyncStatus,
  OLDER_HISTORY_PROBE_GRID_MS,
  SYNC_STATUS_TOOL,
  type AggregateSyncStatus,
  type SyncStatus,
} from "../../src/tools/get-sync-status.js";
import { MAX_SYNC_GAP_MS, STALE_SLEEP_MS, LONG_CYCLE_MS } from "../../src/tools/get-today.js";
import { ADDITIONAL_TOOLS } from "../../src/tools/registry/index.js";
import { MAX_TOOL_TEXT_CHARS, type ToolContext } from "../../src/tools/tool-definition.js";
import type { PrivacyMode } from "../../src/privacy.js";
import { assertNeutralText, connectServer } from "../helpers/contract.js";
import {
  createWhoopFixtureClient,
  type FixtureFailure,
  type WhoopFixtureClient,
} from "../helpers/whoop-fixture-client.js";
import {
  LIVE_SHAPED_IDS,
  liveShapedUser,
  matureUser,
  stressUser,
  type WhoopUserFixture,
} from "../helpers/whoop-users.js";

const DAY_MS = 86_400_000;
const TOOL = "get_sync_status";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clientFor(
  data: WhoopUserFixture,
  failures: FixtureFailure[] = [],
  nowMs: number = data.now.getTime()
): WhoopFixtureClient {
  return createWhoopFixtureClient({ ...data, failures, now: nowMs });
}

function contextFor(
  client: WhoopFixtureClient,
  now: Date,
  options: Partial<Pick<ToolContext, "historyCache" | "runtime" | "privacyMode">> = {}
): ToolContext {
  return {
    client,
    privacyMode: options.privacyMode ?? "standard",
    ...(options.historyCache !== undefined ? { historyCache: options.historyCache } : {}),
    ...(options.runtime !== undefined ? { runtime: options.runtime } : {}),
    now: () => now,
    startedAtMs: Date.now(),
  };
}

async function standardAt(
  data: WhoopUserFixture,
  nowMs: number = data.now.getTime(),
  failures: FixtureFailure[] = []
): Promise<SyncStatus> {
  const client = clientFor(asOf(data, nowMs), failures, nowMs);
  const result = await getSyncStatus(contextFor(client, new Date(nowMs)));
  expectStandardContract(result);
  return result;
}

function expectStandardContract(result: SyncStatus): void {
  const parsed = SYNC_STATUS_TOOL.standard.outputSchema.safeParse(result);
  expect(parsed.success).toBe(true);
  expect(parsed.data).toEqual(result);
  assertNeutralText(result.notes);
}

function expectAggregateContract(result: AggregateSyncStatus): void {
  const parsed = SYNC_STATUS_TOOL.aggregate!.outputSchema.safeParse(result);
  expect(parsed.success).toBe(true);
  expect(parsed.data).toEqual(result);
  assertNeutralText(result.notes);
}

/**
 * The account as WHOOP would have served it at `nowMs`: records created later
 * are absent, cycles ending later are open, sleeps and workouts not ended yet
 * are absent, and updates after `nowMs` have not happened.
 */
function asOf(data: WhoopUserFixture, nowMs: number): WhoopUserFixture {
  const created = (record: { created_at: string }): boolean =>
    Date.parse(record.created_at) <= nowMs;
  const notUpdatedLater = <T extends { created_at: string; updated_at: string }>(record: T): T =>
    Date.parse(record.updated_at) > nowMs ? { ...record, updated_at: record.created_at } : record;
  return {
    ...data,
    now: new Date(nowMs),
    cycles: data.cycles
      .filter((cycle) => created(cycle) && Date.parse(cycle.start) <= nowMs)
      .map(
        (cycle): Cycle =>
          cycle.end !== null && cycle.end !== undefined && Date.parse(cycle.end) > nowMs
            ? { ...cycle, end: null }
            : cycle
      )
      .map(notUpdatedLater),
    sleeps: data.sleeps
      .filter((sleep: Sleep) => created(sleep) && Date.parse(sleep.end) <= nowMs)
      .map(notUpdatedLater),
    recoveries: data.recoveries
      .filter((recovery: Recovery) => created(recovery))
      .map(notUpdatedLater),
    workouts: data.workouts
      .filter((workout: Workout) => created(workout) && Date.parse(workout.end) <= nowMs)
      .map(notUpdatedLater),
  };
}

/** Every object key in a value, recursively. */
function keysOf(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((item) => keysOf(item, out));
  else if (value !== null && typeof value === "object")
    for (const [key, item] of Object.entries(value)) {
      out.add(key);
      keysOf(item, out);
    }
  return out;
}

/** Every string in a value with its path. */
function stringsOf(
  value: unknown,
  path = "",
  out: Array<[string, string]> = []
): Array<[string, string]> {
  if (typeof value === "string") out.push([path, value]);
  else if (Array.isArray(value)) value.forEach((item, i) => stringsOf(item, `${path}[${i}]`, out));
  else if (value !== null && typeof value === "object")
    for (const [key, item] of Object.entries(value))
      stringsOf(item, path ? `${path}.${key}` : key, out);
  return out;
}

const live = (): WhoopUserFixture => liveShapedUser();
const LIVE = live();
const openCycle = LIVE.cycles.find((cycle) => cycle.id === LIVE_SHAPED_IDS.cycles.open)!;
const lastNight = LIVE.sleeps.find((sleep) => sleep.id === LIVE_SHAPED_IDS.sleeps.second)!;

// ---------------------------------------------------------------------------
// Standard mode
// ---------------------------------------------------------------------------

describe("get_sync_status (standard)", () => {
  it("reports the live-shaped calibrating account as up to date with its exact first day", async () => {
    const result = await standardAt(LIVE);

    expect(result.assessment).toBe("up_to_date");
    expect(result.evaluated_at).toBe("2026-09-16T23:30:00.000+02:00");
    expect(result.utc_offset).toEqual({ offset: "+02:00", fallback: false });
    expect(result.history).toEqual({
      first_cycle_date: "2026-09-14",
      days_with_cycles: 3,
      more_than_90_days: false,
    });
    expect(result.latest).toEqual({
      cycle: {
        state: "open",
        started: "2026-09-15T23:13:31.460+02:00",
        last_updated: "2026-09-16T20:16:02.337+02:00",
        hours_since_update: 3.2,
      },
      sleep: {
        state: "scored",
        ended: "2026-09-16T06:58:12.066+02:00",
        hours_since_end: 16.5,
        linked_to_current_cycle: true,
        only_naps_recent: false,
      },
      recovery: { state: "scored", calibrating: true, linked_to_current_cycle: true },
      workout: { state: "scored", started: "2026-09-16T19:26:03.118+02:00" },
    });
    expect(result.notes).toEqual([expect.stringContaining("still calibrating recovery")]);
    expect(JSON.stringify(result.notes)).not.toMatch(/\d+ (days|nights) to calibrate/);
  });

  it("reports server fields as null without runtime status", async () => {
    const result = await standardAt(LIVE);

    expect(result.server).toEqual({
      version: packageVersion(),
      commit: null,
      privacy_mode: "standard",
      oauth_connector: null,
      webhooks: { enabled: null, last_event_at: null },
      whoop_auth: { access_token_expires_in_minutes: null, last_refresh_outcome: null },
      whoop_api: { requests_last_minute: null, rate_limited_responses_total: null },
    });
  });

  it("reports the runtime snapshot subset with local times", async () => {
    const nowMs = LIVE.now.getTime();
    let clock = nowMs - 10 * 60_000;
    const runtime = createRuntimeStatus({
      version: "9.9.9",
      commit: "0123456789ab",
      privacyMode: "standard",
      now: () => clock,
    });
    runtime.setFlags({ oauthConnector: true, webhooksEnabled: true });
    runtime.recordWebhook();
    clock = nowMs;
    runtime.recordRefresh("ok");
    runtime.setAccessTokenExpiry(nowMs + 45 * 60_000);
    runtime.attachLimiter({
      stats: () => ({
        requests_last_minute: 7,
        requests_today_utc: 300,
        throttled_waits_total: 2,
        rate_limited_responses_total: 1,
        last_rate_limited_at: null,
      }),
    });

    const client = clientFor(LIVE);
    const result = await getSyncStatus(contextFor(client, LIVE.now, { runtime }));

    expectStandardContract(result);
    expect(result.server).toEqual({
      version: "9.9.9",
      commit: "0123456789ab",
      privacy_mode: "standard",
      oauth_connector: true,
      webhooks: { enabled: true, last_event_at: "2026-09-16T23:20:00.000+02:00" },
      whoop_auth: { access_token_expires_in_minutes: 45, last_refresh_outcome: "ok" },
      whoop_api: { requests_last_minute: 7, rate_limited_responses_total: 1 },
    });
  });

  describe("assessments and boundaries", () => {
    const sleepEndMs = Date.parse(lastNight.end);
    const cycleUpdatedMs = Date.parse(openCycle.updated_at);

    it("keeps up_to_date until the latest main sleep ended exactly STALE_SLEEP_MS (20 h) ago", async () => {
      expect(STALE_SLEEP_MS).toBe(20 * HOUR_MS);
      const atBoundary = await standardAt(LIVE, sleepEndMs + STALE_SLEEP_MS);
      expect(atBoundary.assessment).toBe("up_to_date");
      expect(atBoundary.latest.sleep.hours_since_end).toBe(20);
    });

    it("reports sleep_not_processed_yet once the latest main sleep ended more than 20 h ago", async () => {
      const result = await standardAt(LIVE, sleepEndMs + STALE_SLEEP_MS + 1);

      expect(result.assessment).toBe("sleep_not_processed_yet");
      expect(result.latest.cycle.state).toBe("open");
      expect(result.notes[0]).toContain(
        "The latest main sleep ended 2026-09-16T06:58:12.066+02:00, about 20 hours ago"
      );
      expect(result.notes[0]).toContain("opening the WHOOP app to sync may help");
    });

    it("keeps sleep_not_processed_yet until WHOOP has not updated the cycle for exactly 24 h", async () => {
      expect(MAX_SYNC_GAP_MS).toBe(24 * HOUR_MS);
      const atBoundary = await standardAt(LIVE, cycleUpdatedMs + MAX_SYNC_GAP_MS);
      expect(atBoundary.assessment).toBe("sleep_not_processed_yet");
      expect(atBoundary.latest.cycle.hours_since_update).toBe(24);
    });

    it("reports strap_not_synced once WHOOP has not updated the newest cycle for more than 24 h", async () => {
      const result = await standardAt(LIVE, cycleUpdatedMs + MAX_SYNC_GAP_MS + 1);

      expect(result.assessment).toBe("strap_not_synced");
      expect(result.notes[0]).toBe(
        "WHOOP has not updated the latest cycle since 2026-09-16T20:16:02.337+02:00, about 24 hours ago; the strap may not have synced with the WHOOP app since then."
      );
    });

    it("reports sleep_not_processed_yet when the newest cycle has ended and no newer cycle synced", async () => {
      const endedAt = "2026-09-16T21:05:00.000Z";
      const data: WhoopUserFixture = {
        ...LIVE,
        cycles: LIVE.cycles.map((cycle) =>
          cycle.id === openCycle.id ? { ...cycle, end: endedAt, updated_at: endedAt } : cycle
        ),
      };
      const result = await standardAt(data);

      expect(result.assessment).toBe("sleep_not_processed_yet");
      expect(result.latest.cycle.state).toBe("closed");
      expect(result.notes[0]).toContain(
        "The latest WHOOP cycle ended 2026-09-16T23:05:00.000+02:00"
      );
    });

    it("dates an open cycle without a main sleep by its start (LONG_CYCLE_MS) and flags only naps", async () => {
      const nap: Sleep = { ...lastNight, id: "nap-only", nap: true };
      const data: WhoopUserFixture = { ...LIVE, sleeps: [nap] };
      const cycleStartMs = Date.parse(openCycle.start);

      const before = await standardAt(data, cycleStartMs + LONG_CYCLE_MS);
      expect(before.assessment).toBe("up_to_date");
      expect(before.latest.sleep).toEqual({
        state: "none",
        ended: null,
        hours_since_end: null,
        linked_to_current_cycle: null,
        only_naps_recent: true,
      });

      const after = await standardAt(data, cycleStartMs + LONG_CYCLE_MS + 1);
      expect(after.assessment).toBe("sleep_not_processed_yet");
      expect(after.notes[0]).toContain(
        "The current WHOOP cycle started 2026-09-15T23:13:31.460+02:00"
      );
      expect(after.notes.join(" ")).toContain("Only naps were found");
    });

    it("reports no_data_yet for an account without cycles", async () => {
      const empty: WhoopUserFixture = {
        ...LIVE,
        cycles: [],
        sleeps: [],
        recoveries: [],
        workouts: [],
      };
      const result = await standardAt(empty);

      expect(result.assessment).toBe("no_data_yet");
      expect(result.history).toEqual({
        first_cycle_date: null,
        days_with_cycles: 0,
        more_than_90_days: false,
      });
      expect(result.latest.cycle.state).toBe("none");
      expect(result.latest.sleep.state).toBe("none");
      expect(result.latest.recovery).toEqual({
        state: "none",
        calibrating: null,
        linked_to_current_cycle: null,
      });
      expect(result.latest.workout).toEqual({ state: "none", started: null });
      // No cycle to read an offset from is not a fallback.
      expect(result.utc_offset).toEqual({ offset: "Z", fallback: false });
    });

    it("reports unavailable with the WHOOP sign-in explanation when the token cannot be refreshed", async () => {
      const result = await standardAt(LIVE, undefined, [
        { path: /^\/v2\//, error: new WhoopAuthError(new Error("invalid_grant SECRET")) },
      ]);

      expect(result.assessment).toBe("unavailable");
      expect(result.notes[0]).toMatch(/^WHOOP sign-in failed, so no WHOOP data could be read: /);
      expect(result.notes[0]).toContain("setup --verify");
      expect(JSON.stringify(result)).not.toContain("SECRET");
      expect(result.latest.cycle.state).toBe("unavailable");
      expect(result.latest.sleep.state).toBe("unavailable");
      expect(result.history).toEqual({
        first_cycle_date: null,
        days_with_cycles: null,
        more_than_90_days: null,
      });
      // One explanation, not one per source; the UTC fallback note comes last.
      expect(result.notes).toHaveLength(2);
      expect(result.utc_offset.fallback).toBe(true);
      expect(result.notes[1]).toContain("time zone could not be read");
    });

    it("reports unavailable when WHOOP rejects the authorization of the cycle request", async () => {
      const result = await standardAt(LIVE, undefined, [
        { path: /^\/v2\/cycle\?limit=1$/, error: new WhoopApiError(401, "Unauthorized", {}) },
      ]);

      expect(result.assessment).toBe("unavailable");
      expect(result.notes[0]).toContain("HTTP 401");
    });

    it("keeps the assessment and explains a single failed source", async () => {
      const result = await standardAt(LIVE, undefined, [
        {
          path: /^\/v2\/activity\/sleep\?limit=5$/,
          error: new WhoopApiError(503, "Unavailable", {}),
        },
      ]);

      expect(result.assessment).toBe("up_to_date");
      expect(result.latest.sleep).toEqual({
        state: "unavailable",
        ended: null,
        hours_since_end: null,
        linked_to_current_cycle: null,
        only_naps_recent: false,
      });
      expect(result.notes).toContain(
        "The latest sleep could not be read: WHOOP API is temporarily unavailable (HTTP 503). Retry later."
      );
    });

    it("reports sleep_not_processed_yet during the morning sync race, with sleep and recovery linked to the earlier cycle", async () => {
      // 07:01 local: today's cycle has synced, last night's sleep and recovery have not.
      const data = liveShapedUser({ now: "2026-09-16T07:01:37+02:00" });
      const result = await standardAt(data);

      expect(result.latest.cycle.state).toBe("open");
      expect(result.latest.sleep).toMatchObject({
        state: "scored",
        ended: "2026-09-15T07:21:48.905+02:00",
        linked_to_current_cycle: false,
      });
      expect(result.latest.recovery.linked_to_current_cycle).toBe(false);
      // The previous morning's sleep ended almost 24 hours ago.
      expect(result.assessment).toBe("sleep_not_processed_yet");
    });
  });

  describe("history", () => {
    it("gives the exact first date and day count for an account under 90 days", async () => {
      const data = matureUser({ days: 60 });
      const result = await standardAt(data);

      const days = new Set(data.cycles.map((cycle) => cycleDay(cycle)));
      expect(result.history).toEqual({
        first_cycle_date: "2026-07-19",
        days_with_cycles: days.size,
        more_than_90_days: false,
      });
      expect([...days].sort()[0]).toBe("2026-07-19");
    });

    it("does not report a first date when the older-history probe finds cycles", async () => {
      const data = matureUser({ days: 120 });
      const client = clientFor(data);
      const result = await getSyncStatus(contextFor(client, data.now));

      expectStandardContract(result);
      expect(result.history).toEqual({
        first_cycle_date: null,
        days_with_cycles: null,
        more_than_90_days: true,
      });
      expect(result.notes).toContain(
        "WHOOP has cycles from more than 90 days ago, so first_cycle_date and days_with_cycles are not reported."
      );
      // The probe boundary is on an hourly grid (a repeatable cache key) and matches the history start.
      const probe = client.calls.find((path) => path.startsWith("/v2/cycle?end="))!;
      const end = Date.parse(new URLSearchParams(probe.split("?")[1]).get("end")!);
      expect(end % OLDER_HISTORY_PROBE_GRID_MS).toBe(0);
      expect(data.now.getTime() - end).toBeGreaterThanOrEqual(90 * DAY_MS);
      expect(data.now.getTime() - end).toBeLessThan(90 * DAY_MS + OLDER_HISTORY_PROBE_GRID_MS);
    });

    it("reports null days when the history load is truncated", async () => {
      const data = matureUser({ days: 60 });
      const result = await standardAt(data, undefined, [
        {
          path: /^\/v2\/cycle\?start=/,
          page: 2,
          error: new WhoopApiError(503, "Unavailable", {}),
        },
      ]);

      expect(result.history).toEqual({
        first_cycle_date: null,
        days_with_cycles: null,
        more_than_90_days: false,
      });
      expect(result.notes.join(" ")).toContain("could not be read in full");
    });

    it("reports null history when the probe fails", async () => {
      const result = await standardAt(LIVE, undefined, [
        { path: /^\/v2\/cycle\?end=/, error: new WhoopApiError(503, "Unavailable", {}) },
      ]);

      expect(result.assessment).toBe("up_to_date");
      expect(result.history).toEqual({
        first_cycle_date: null,
        days_with_cycles: null,
        more_than_90_days: null,
      });
      expect(result.notes.join(" ")).toContain("could not be read, so first_cycle_date");
    });
  });

  it("returns only status keys: no scores, HRV, heart rate, strain or energy", async () => {
    const allowed = new Set([
      "evaluated_at",
      "utc_offset",
      "offset",
      "fallback",
      "assessment",
      "history",
      "first_cycle_date",
      "days_with_cycles",
      "more_than_90_days",
      "latest",
      "cycle",
      "state",
      "started",
      "last_updated",
      "hours_since_update",
      "sleep",
      "ended",
      "hours_since_end",
      "linked_to_current_cycle",
      "only_naps_recent",
      "recovery",
      "calibrating",
      "workout",
      "server",
      "version",
      "commit",
      "privacy_mode",
      "oauth_connector",
      "webhooks",
      "enabled",
      "last_event_at",
      "whoop_auth",
      "access_token_expires_in_minutes",
      "last_refresh_outcome",
      "whoop_api",
      "requests_last_minute",
      "rate_limited_responses_total",
      "notes",
    ]);
    for (const data of [LIVE, matureUser({ days: 60 })]) {
      const keys = keysOf(await standardAt(data));
      expect([...keys].filter((key) => !allowed.has(key))).toEqual([]);
      expect(
        [...keys].filter((key) => /score|hrv|strain|heart|kilojoule|spo2|skin/i.test(key))
      ).toEqual([]);
    }
    const advertised = keysOf(SYNC_STATUS_TOOL.standard.outputSchema.toJSONSchema());
    expect([...advertised].filter((key) => /score|hrv|strain|heart|kilojoule/i.test(key))).toEqual(
      []
    );
  });

  it("stays within the page budget on stressUser, continues from the cache and fits the size limit", async () => {
    const data = stressUser();
    const cache = new MemoryCache({ maxEntries: 500 });
    const client = createWhoopFixtureClient({
      ...data,
      now: data.now.getTime(),
      rateLimiter: createRateLimiter({ perMinute: DEFAULT_RATE_LIMIT_PER_MINUTE }),
    });

    const startedAt = Date.now();
    const first = await getSyncStatus(contextFor(client, data.now, { historyCache: cache }));
    expect(Date.now() - startedAt).toBeLessThan(HISTORY_DEADLINE_MS);
    expectStandardContract(first);
    // 5 latest reads, the offset lookup, the probe and the history pages.
    expect(client.calls.length).toBeLessThanOrEqual(DEFAULT_PAGE_BUDGET + 7);
    const historyCalls = client.calls.filter((path) => path.includes("start=")).length;
    expect(historyCalls).toBeGreaterThan(0);

    const before = client.calls.length;
    await getSyncStatus(contextFor(client, data.now, { historyCache: cache }));
    const repeatHistory = client.calls.slice(before).filter((path) => path.includes("start="));
    // Only the open chunk is read again.
    expect(repeatHistory.every((path) => !path.includes("end="))).toBe(true);
    expect(JSON.stringify(first).length).toBeLessThan(MAX_TOOL_TEXT_CHARS);
    expect(first.history.more_than_90_days).toBe(true);

    // Aggregate mode on the same account: the 13 released weeks within the budget.
    const aggregateClient = clientFor(data);
    const aggregate = await getAggregateSyncStatus(
      contextFor(aggregateClient, data.now, { privacyMode: "aggregate" })
    );
    expectAggregateContract(aggregate);
    expect(aggregateClient.calls.length).toBeLessThanOrEqual(DEFAULT_PAGE_BUDGET + 2);
    expect(aggregate.released_weeks.weeks_with_data_last_13).toBe(13);
    expect(JSON.stringify(aggregate).length).toBeLessThan(MAX_TOOL_TEXT_CHARS);
  });

  it("is registered with its contract and returns compact JSON through the MCP server", async () => {
    expect(ADDITIONAL_TOOLS.map((tool) => tool.name)).toContain(TOOL);
    const connection = await connectServer(clientFor(LIVE), {
      privacyMode: "standard",
      now: () => LIVE.now,
    });
    try {
      const listed = connection.tools.find((tool) => tool.name === TOOL);
      expect(listed?.title).toBe("Sync status");
      expect(listed?.annotations?.readOnlyHint).toBe(true);
      expect(listed?.description?.length ?? 0).toBeLessThanOrEqual(1000);
      const outcome = await connection.callTool(TOOL, {});
      expect(outcome.isError).toBe(false);
      expect(outcome.text).toBe(JSON.stringify(outcome.structured));
      expect(outcome.structured).toMatchObject({ assessment: "up_to_date" });
    } finally {
      await connection.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Aggregate mode
// ---------------------------------------------------------------------------

/** 2026-09-09 (Wednesday) 00:00 at +01:00: the week of 2026-08-31 is released. */
const RELEASE_WEDNESDAY_MS = Date.parse("2026-09-09T00:00:00.000+01:00");

function weekUser(): WhoopUserFixture {
  // A mature account viewed up to the Tuesday before the next release; quirks
  // (gaps, naps, split nights, a pending last night) stay on.
  return matureUser({
    days: 120,
    now: "2026-09-15T23:59:00+01:00",
    offset: "+01:00",
    offsetChange: null,
  });
}

async function aggregateAt(
  data: WhoopUserFixture,
  nowMs: number,
  options: { failures?: FixtureFailure[]; runtime?: ToolContext["runtime"] } = {}
): Promise<AggregateSyncStatus> {
  const client = clientFor(asOf(data, nowMs), options.failures ?? [], nowMs);
  const result = await getAggregateSyncStatus(
    contextFor(client, new Date(nowMs), {
      privacyMode: "aggregate" as PrivacyMode,
      ...(options.runtime !== undefined ? { runtime: options.runtime } : {}),
    })
  );
  expectAggregateContract(result);
  return result;
}

function withoutEvaluatedOn(
  result: AggregateSyncStatus
): Omit<AggregateSyncStatus, "evaluated_on"> {
  const rest: Partial<AggregateSyncStatus> = { ...result };
  delete rest.evaluated_on;
  return rest as Omit<AggregateSyncStatus, "evaluated_on">;
}

describe("get_sync_status (aggregate)", () => {
  it("reports a brand-new account as no_data_yet until its first week is released", async () => {
    const result = await aggregateAt(LIVE, LIVE.now.getTime());

    expect(result).toEqual({
      evaluated_on: "2026-09-16",
      assessment: "no_data_yet",
      released_weeks: { latest_week_start: "2026-09-07", weeks_with_data_last_13: 0 },
      history: { more_than_90_days: false },
      server: {
        version: packageVersion(),
        commit: null,
        privacy_mode: "aggregate",
        oauth_connector: null,
        webhooks_enabled: null,
        whoop_auth_last_refresh_outcome: null,
      },
      notes: [
        expect.stringContaining("Aggregate mode reports only whole local weeks"),
        expect.stringContaining("No released week contains WHOOP cycles"),
      ],
    });

    // The week of 2026-09-14 (the first strap day) is released on Wednesday 2026-09-23.
    const later = liveShapedUser({ now: "2026-09-16T23:30:00+02:00" });
    const beforeRelease = await aggregateAt(later, Date.parse("2026-09-22T23:59:00+02:00"));
    expect(beforeRelease.assessment).toBe("no_data_yet");
    const released = await aggregateAt(later, Date.parse("2026-09-23T00:00:00+02:00"));
    expect(released).toMatchObject({
      assessment: "connected",
      released_weeks: { latest_week_start: "2026-09-14", weeks_with_data_last_13: 1 },
    });
  });

  it("counts released weeks with cycles and older history on a mature account", async () => {
    const data = matureUser({ days: 120 });
    const result = await aggregateAt(data, data.now.getTime());

    expect(result.assessment).toBe("connected");
    expect(result.released_weeks).toEqual({
      latest_week_start: "2026-09-07",
      weeks_with_data_last_13: 13,
    });
    expect(result.history.more_than_90_days).toBe(true);
  });

  it("returns identical output from Wednesday 00:00 to the next Tuesday 23:59 while sleeps, workouts and webhooks happen", async () => {
    const data = weekUser();
    const runtime = createRuntimeStatus({
      version: "1.0.0",
      commit: null,
      privacyMode: "aggregate",
    });
    runtime.setFlags({ webhooksEnabled: true });
    const instants = [
      RELEASE_WEDNESDAY_MS,
      RELEASE_WEDNESDAY_MS + 7 * HOUR_MS + 30 * 60_000, // Wednesday 07:30, after the morning sync
      RELEASE_WEDNESDAY_MS + 2 * DAY_MS + 19 * HOUR_MS, // Friday evening, after a workout
      RELEASE_WEDNESDAY_MS + 5 * DAY_MS + 30 * 60_000, // Monday 00:30, Sunday's cycle still open
      RELEASE_WEDNESDAY_MS + 6 * DAY_MS + 23 * HOUR_MS + 59 * 60_000, // Tuesday 23:59
    ];
    const results: AggregateSyncStatus[] = [];
    for (const instant of instants) {
      runtime.recordWebhook();
      results.push(await aggregateAt(data, instant, { runtime }));
    }

    // Records appeared between the calls.
    const counts = instants.map((instant) => {
      const view = asOf(data, instant);
      return view.sleeps.length + view.workouts.length + view.cycles.length;
    });
    expect(new Set(counts).size).toBe(instants.length);

    expect(results[0]!.released_weeks.latest_week_start).toBe("2026-08-31");
    expect(results[0]!.released_weeks.weeks_with_data_last_13).toBe(13);
    for (const result of results.slice(1)) {
      expect(withoutEvaluatedOn(result)).toEqual(withoutEvaluatedOn(results[0]!));
    }
    expect(results.map((result) => result.evaluated_on)).toEqual([
      "2026-09-09",
      "2026-09-09",
      "2026-09-11",
      "2026-09-14",
      "2026-09-15",
    ]);

    // One minute earlier the previous week is still the latest released one.
    const tuesdayBefore = await aggregateAt(data, RELEASE_WEDNESDAY_MS - 60_000);
    expect(tuesdayBefore.released_weeks.latest_week_start).toBe("2026-08-24");
  });

  it("never exposes a date or time other than latest_week_start, in any outcome", async () => {
    const data = weekUser();
    const nowMs = RELEASE_WEDNESDAY_MS + 3 * DAY_MS;
    const outcomes = [
      await aggregateAt(data, nowMs),
      await aggregateAt(data, nowMs, {
        failures: [{ path: /^\/v2\//, error: new WhoopAuthError(new Error("invalid_grant")) }],
      }),
      await aggregateAt(data, nowMs, {
        failures: [
          {
            path: /^\/v2\/cycle\?start=/,
            page: 2,
            error: new WhoopApiError(503, "Unavailable", {}),
          },
          { path: /^\/v2\/cycle\?end=/, error: new WhoopApiError(503, "Unavailable", {}) },
        ],
      }),
      await aggregateAt(
        { ...LIVE, cycles: [], sleeps: [], recoveries: [], workouts: [] },
        LIVE.now.getTime()
      ),
    ];
    const dateOrTime = /\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}|T\d{2}/;
    for (const outcome of outcomes) {
      const leaks = stringsOf(outcome).filter(
        ([path, text]) =>
          path !== "evaluated_on" &&
          path !== "released_weeks.latest_week_start" &&
          dateOrTime.test(text)
      );
      expect(leaks).toEqual([]);
      const keys = [...keysOf(outcome)];
      for (const forbidden of [
        "latest",
        "last_event_at",
        "requests_last_minute",
        "hours_since_update",
        "started",
        "ended",
      ]) {
        expect(keys).not.toContain(forbidden);
      }
    }
    expect(outcomes.map((outcome) => outcome.assessment)).toEqual([
      "connected",
      "unavailable",
      "connected",
      "no_data_yet",
    ]);
    expect(outcomes[1]!.notes[0]).toMatch(
      /^WHOOP data could not be read: WHOOP authentication failed/
    );
    expect(outcomes[2]).toMatchObject({
      released_weeks: { weeks_with_data_last_13: null },
      history: { more_than_90_days: null },
    });
  });

  it("is registered in aggregate mode with a contract that has no latest or timing fields", async () => {
    const data = weekUser();
    const nowMs = RELEASE_WEDNESDAY_MS + DAY_MS;
    const connection = await connectServer(clientFor(asOf(data, nowMs), [], nowMs), {
      privacyMode: "aggregate",
      now: () => new Date(nowMs),
    });
    try {
      const listed = connection.tools.find((tool) => tool.name === TOOL);
      expect(listed).toBeDefined();
      const schema = JSON.stringify(listed?.outputSchema);
      for (const field of [
        'latest"',
        "last_event_at",
        "requests_last_minute",
        "hours_since",
        "calibrating",
      ]) {
        expect(schema).not.toContain(field);
      }
      const outcome = await connection.callTool(TOOL, {});
      expect(outcome.isError).toBe(false);
      expect(outcome.structured).toMatchObject({
        assessment: "connected",
        released_weeks: { latest_week_start: "2026-08-31" },
      });
      expect(outcome.text).toBe(JSON.stringify(outcome.structured));
    } finally {
      await connection.close();
    }
  });
});
