/**
 * Cross-tool history snapshots around a WHOOP wake-up sync (G5).
 *
 * One process-wide history cache is shared by every tool, as src/index.ts wires
 * it. A tool that reads only some collections (get_sync_status: cycles;
 * get_training_load and get_sleep_analysis: some of cycles, sleeps, recoveries,
 * workouts) caches them just before WHOOP syncs the night; a later get_day or
 * export_health_data must not combine those cached chunks with collections
 * read after the sync (for example a closed cycle from before next to a sleep
 * and recovery that already point at the new cycle).
 *
 * - Scenario "07:28 → 07:29:30": liveShapedUser as of 2026-09-17T07:28+02:00,
 *   then the night is synced in place (cycle 81003 closes at 21:40Z, cycle
 *   81004 opens, sleep …4b03 and its recovery belong to 81004).
 * - Scenario "05:00:30Z → 05:02:00Z": the fixture's own as-of views across its
 *   05:01:34Z (cycle) / 05:01:40Z (sleep, recovery) creation times.
 * - A cache that is already consistent makes no extra WHOOP requests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WhoopApiError, type WhoopClient, type WhoopGetOptions } from "../src/api/client.js";
import { HISTORY_MIXED_SNAPSHOT_WARNING } from "../src/api/history.js";
import type { Cycle, Recovery, Sleep } from "../src/api/types.js";
import { MemoryCache } from "../src/cache/memory-cache.js";
import { exportHealthData } from "../src/tools/export-health-data.js";
import {
  daySourcesOutOfStep,
  getDay,
  getDayOutputSchema,
  type GetDayResult,
} from "../src/tools/get-day.js";
import { runSleepAnalysis } from "../src/tools/get-sleep-analysis.js";
import { getSyncStatus } from "../src/tools/get-sync-status.js";
import { getTrainingLoad } from "../src/tools/get-training-load.js";
import type { ToolContext } from "../src/tools/tool-definition.js";
import { assertNeutralText } from "./helpers/contract.js";
import {
  createWhoopFixtureClient,
  type WhoopFixtureClient,
} from "./helpers/whoop-fixture-client.js";
import { liveShapedUser, type WhoopUserFixture } from "./helpers/whoop-users.js";

const PRE_SYNC = "2026-09-17T07:28:00+02:00";
const POST_SYNC = "2026-09-17T07:29:30+02:00";
const NEW_SLEEP_ID = "6f1d2c3b-4a59-4e68-9b7c-0d1e2f3a4b03";

/** A mutable WHOOP account whose clock can be moved. */
interface World {
  user: WhoopUserFixture;
  client: WhoopFixtureClient;
  setNow(value: string): void;
}

function world(asOf: string | Date, clock: string | Date = asOf): World {
  const user = structuredClone(liveShapedUser({ now: asOf }));
  let now = new Date(clock);
  const client = createWhoopFixtureClient({
    cycles: user.cycles,
    sleeps: user.sleeps,
    recoveries: user.recoveries,
    workouts: user.workouts,
    profile: user.profile,
    body: user.body,
    now: () => now,
  });
  return {
    user,
    client,
    setNow(value: string): void {
      now = new Date(value);
      vi.setSystemTime(now);
    },
  };
}

/** WHOOP processes the night 23:40 → 07:10 local: closes 81003, opens 81004 with its sleep and recovery. */
function applyNightSync(user: WhoopUserFixture): void {
  const closed = user.cycles.find((cycle) => cycle.id === 81003)!;
  closed.end = "2026-09-16T21:40:00.000Z";
  closed.updated_at = "2026-09-17T05:29:00.000Z";
  const opened: Cycle = {
    ...structuredClone(closed),
    id: 81004,
    start: "2026-09-16T21:40:00.000Z",
    end: null,
    created_at: "2026-09-17T05:29:00.000Z",
    updated_at: "2026-09-17T05:29:00.000Z",
    score: { strain: 0.3, kilojoule: 600, average_heart_rate: 55, max_heart_rate: 70 },
  } as Cycle;
  user.cycles.unshift(opened);
  const sleep: Sleep = {
    ...structuredClone(user.sleeps[0]!),
    id: NEW_SLEEP_ID,
    cycle_id: 81004,
    start: "2026-09-16T21:40:00.000Z",
    end: "2026-09-17T05:10:00.000Z",
    created_at: "2026-09-17T05:29:05.000Z",
    updated_at: "2026-09-17T05:29:05.000Z",
  } as Sleep;
  user.sleeps.unshift(sleep);
  const recovery: Recovery = {
    ...structuredClone(user.recoveries[0]!),
    cycle_id: 81004,
    sleep_id: NEW_SLEEP_ID,
    created_at: "2026-09-17T05:29:05.000Z",
    updated_at: "2026-09-17T05:29:05.000Z",
  } as Recovery;
  user.recoveries.unshift(recovery);
}

function ctx(w: World, now: string | Date, cache?: MemoryCache): ToolContext {
  return {
    client: w.client,
    privacyMode: "standard",
    now: () => new Date(now),
    startedAtMs: Date.now(),
    ...(cache !== undefined ? { historyCache: cache } : {}),
  };
}

async function day(
  w: World,
  date: string,
  now: string | Date,
  cache?: MemoryCache
): Promise<GetDayResult> {
  return getDayOutputSchema.parse(await getDay({ date }, ctx(w, now, cache)));
}

function textOf(result: GetDayResult): string[] {
  return [...result.notes, ...result.warnings];
}

/** A get_day result without per-source cache facts (fetched_at, cache_status). */
function stableDay(result: GetDayResult): unknown {
  const sources = Object.fromEntries(
    Object.entries(result.data_quality.sources).map(([name, source]) => [
      name,
      { ...source, fetched_at: null, cache_status: null },
    ])
  );
  return { ...result, data_quality: { ...result.data_quality, sources } };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// 07:28 → sync → 07:29:30
// ---------------------------------------------------------------------------

describe("get_day and export_health_data after a sync, with collections cached before it", () => {
  const primers: Array<[string, (w: World, cache: MemoryCache) => Promise<unknown>]> = [
    ["get_sync_status", (w, cache) => getSyncStatus(ctx(w, PRE_SYNC, cache))],
    ["get_training_load", (w, cache) => getTrainingLoad({}, ctx(w, PRE_SYNC, cache))],
    ["get_sleep_analysis", (w, cache) => runSleepAnalysis({}, ctx(w, PRE_SYNC, cache))],
  ];

  for (const [name, prime] of primers) {
    it(`${name} before the sync, then get_day today and yesterday and the export`, async () => {
      const w = world(PRE_SYNC);
      w.setNow(PRE_SYNC);
      const cache = new MemoryCache();
      await prime(w, cache);

      applyNightSync(w.user);
      w.setNow(POST_SYNC);

      const today = await day(w, "today", POST_SYNC, cache);
      expect(today.date).toBe("2026-09-17");
      expect(today.status).toBe("in_progress");
      expect(today.cycle?.id).toBe(81004);
      expect(today.sleep?.id).toBe(NEW_SLEEP_ID);
      expect(today.recovery).not.toBeNull();
      assertNeutralText(textOf(today));

      const yesterday = await day(w, "yesterday", POST_SYNC, cache);
      expect(yesterday.date).toBe("2026-09-16");
      expect(yesterday.status).toBe("complete");
      expect(yesterday.cycle?.id).toBe(81003);
      expect(yesterday.next_morning.status).toBe("available");

      const exported = (await exportHealthData(
        { start: "2026-09-16", end: "today", format: "json", datasets: ["daily"] },
        ctx(w, POST_SYNC, cache)
      )) as { datasets: { daily?: { rows?: Array<Record<string, unknown>> } } };
      const rows = exported.datasets.daily?.rows ?? [];
      expect(rows.find((row) => row.date === "2026-09-17")?.cycle_id).toBe(81004);
      expect(rows.find((row) => row.date === "2026-09-16")?.cycle_id).toBe(81003);

      // Same answers as a server without any cache.
      const fresh = await day(w, "today", POST_SYNC);
      expect(fresh.cycle?.id).toBe(today.cycle?.id);
      expect(fresh.sleep?.id).toBe(today.sleep?.id);
      expect(fresh.status).toBe(today.status);
    });
  }
});

// ---------------------------------------------------------------------------
// The fixture's own as-of views: 05:00:30Z → 05:02:00Z
// ---------------------------------------------------------------------------

describe("get_day across the live-shaped 05:01 sync (fixture as-of views)", () => {
  const before = "2026-09-16T05:00:30Z";
  const after = "2026-09-16T05:02:00Z";

  /** One cache, first a call on the pre-sync account, then get_day on the synced one. */
  async function across(
    prime: (w: World, cache: MemoryCache) => Promise<unknown>
  ): Promise<GetDayResult> {
    const cache = new MemoryCache();
    const pre = world(before);
    pre.setNow(before);
    await prime(pre, cache);
    const post = world(after);
    post.setNow(after);
    return day(post, "today", after, cache);
  }

  it("get_sync_status, then get_day: today is in progress on cycle 81003", async () => {
    const result = await across((w, cache) => getSyncStatus(ctx(w, before, cache)));
    expect(result.status).toBe("in_progress");
    expect(result.cycle?.id).toBe(81003);
    expect(result.sleep).not.toBeNull();
    expect(result.recovery).not.toBeNull();
  });

  it("get_sleep_analysis, then get_day: the sleep and recovery are present", async () => {
    const result = await across((w, cache) => runSleepAnalysis({}, ctx(w, before, cache)));
    expect(result.cycle?.id).toBe(81003);
    expect(result.sleep).not.toBeNull();
    expect(result.recovery).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Request volume
// ---------------------------------------------------------------------------

describe("consistent caches", () => {
  it("make no extra WHOOP requests", async () => {
    const w = world(POST_SYNC);
    w.setNow(POST_SYNC);
    const cache = new MemoryCache();
    const first = await day(w, "today", POST_SYNC, cache);
    const firstCalls = w.client.calls.length;
    expect(firstCalls).toBeGreaterThan(0);

    // Everything is cached from one snapshot: a second get_day reads nothing.
    const again = await day(w, "today", POST_SYNC, cache);
    expect(w.client.calls.length).toBe(firstCalls);
    expect(stableDay(again)).toEqual(stableDay(first));

    // Without a cache, one get_day reads each collection once (no re-read).
    const uncached = world(POST_SYNC);
    uncached.setNow(POST_SYNC);
    await day(uncached, "today", POST_SYNC);
    const historyReads = uncached.client.calls.filter((path) => path.includes("start="));
    expect(historyReads.map((path) => path.split("?")[0]).sort()).toEqual([
      "/v2/activity/sleep",
      "/v2/activity/workout",
      "/v2/cycle",
      "/v2/recovery",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Data-level defense: WHOOP syncs between the cycle and sleep reads of one call
// ---------------------------------------------------------------------------

/**
 * A client on `w` that applies the night sync right after the first cycle
 * history page was served and before any sleep or recovery page is read (WHOOP
 * creating a night's cycle seconds before its sleep and recovery). Cycle
 * history reads after the first fail with HTTP 500 when `failCycleReload`.
 */
function syncBetweenReads(
  w: World,
  options: { failCycleReload?: boolean } = {}
): WhoopClient & { calls: string[] } {
  const calls: string[] = [];
  let cycleReads = 0;
  let markServed: () => void = () => undefined;
  const cycleServed = new Promise<void>((resolve) => {
    markServed = resolve;
  });
  return {
    calls,
    async get<T>(path: string, getOptions?: WhoopGetOptions): Promise<T> {
      calls.push(path);
      const history = path.includes("start=");
      if (history && path.startsWith("/v2/cycle?")) {
        cycleReads += 1;
        if (cycleReads > 1 && options.failCycleReload === true) {
          throw new WhoopApiError(500, "Internal Server Error", null);
        }
        const page = await w.client.get<T>(path, getOptions);
        if (cycleReads === 1) {
          applyNightSync(w.user);
          // The sleep and recovery reads follow within the snapshot tolerance.
          vi.setSystemTime(Date.now() + 500);
          markServed();
        }
        return page;
      }
      if (history && (path.startsWith("/v2/activity/sleep?") || path.startsWith("/v2/recovery?"))) {
        await cycleServed;
      }
      return w.client.get<T>(path, getOptions);
    },
  };
}

describe("get_day when WHOOP syncs between its own reads", () => {
  it("re-reads cycles, sleeps and recoveries once and shows the synced night", async () => {
    const w = world(PRE_SYNC, POST_SYNC);
    w.setNow(POST_SYNC);
    const client = syncBetweenReads(w);
    const result = getDayOutputSchema.parse(
      await getDay({ date: "today" }, { ...ctx(w, POST_SYNC, new MemoryCache()), client })
    );
    expect(result.status).toBe("in_progress");
    expect(result.cycle?.id).toBe(81004);
    expect(result.sleep?.id).toBe(NEW_SLEEP_ID);
    expect(result.recovery).not.toBeNull();
    expect(result.warnings).toEqual([]);
    // One re-read of cycles, sleeps and recoveries; workouts are read once.
    const historyReads = client.calls
      .filter((path) => path.includes("start="))
      .map((path) => path.split("?")[0])
      .sort();
    expect(historyReads).toEqual([
      "/v2/activity/sleep",
      "/v2/activity/sleep",
      "/v2/activity/workout",
      "/v2/cycle",
      "/v2/cycle",
      "/v2/recovery",
      "/v2/recovery",
    ]);
  });

  it("keeps the first read with a warning when the re-read fails", async () => {
    const w = world(PRE_SYNC, POST_SYNC);
    w.setNow(POST_SYNC);
    const client = syncBetweenReads(w, { failCycleReload: true });
    const result = getDayOutputSchema.parse(
      await getDay({ date: "yesterday" }, { ...ctx(w, POST_SYNC, new MemoryCache()), client })
    );
    expect(result.warnings).toContain(HISTORY_MIXED_SNAPSHOT_WARNING);
    expect(result.data_quality.sources.cycle?.status).not.toBe("fetch_failed");
    assertNeutralText(textOf(result));
  });

  it("export_health_data uses the re-read too", async () => {
    const w = world(PRE_SYNC, POST_SYNC);
    w.setNow(POST_SYNC);
    const client = syncBetweenReads(w);
    const exported = (await exportHealthData(
      { start: "2026-09-16", end: "today", format: "json", datasets: ["daily"] },
      { ...ctx(w, POST_SYNC, new MemoryCache()), client }
    )) as { warnings: string[]; datasets: { daily?: { rows?: Array<Record<string, unknown>> } } };
    const rows = exported.datasets.daily?.rows ?? [];
    expect(rows.find((row) => row.date === "2026-09-17")?.cycle_id).toBe(81004);
    expect(rows.find((row) => row.date === "2026-09-16")?.cycle_id).toBe(81003);
    expect(exported.warnings).toEqual([]);
  });
});

describe("daySourcesOutOfStep", () => {
  const synced = (): WhoopUserFixture => {
    const user = structuredClone(liveShapedUser({ now: PRE_SYNC }));
    applyNightSync(user);
    return user;
  };

  it("is false for one consistent snapshot, before or after the sync", () => {
    const before = liveShapedUser({ now: PRE_SYNC });
    expect(daySourcesOutOfStep(before.cycles, before.sleeps, before.recoveries)).toBe(false);
    const after = synced();
    expect(daySourcesOutOfStep(after.cycles, after.sleeps, after.recoveries)).toBe(false);
    expect(daySourcesOutOfStep([], after.sleeps, after.recoveries)).toBe(false);
  });

  it("is true when sleeps or recoveries point at a newer cycle than the loaded ones", () => {
    const before = liveShapedUser({ now: PRE_SYNC });
    const after = synced();
    expect(daySourcesOutOfStep(before.cycles, after.sleeps, before.recoveries)).toBe(true);
    expect(daySourcesOutOfStep(before.cycles, before.sleeps, after.recoveries)).toBe(true);
  });

  it("is true when a newer main sleep ended after the open cycle's own sleep", () => {
    const user = liveShapedUser({ now: PRE_SYNC });
    // The newer sleep is attributed to a known cycle, but ends after the open cycle's sleep.
    const newer: Sleep = {
      ...structuredClone(user.sleeps[0]!),
      id: NEW_SLEEP_ID,
      cycle_id: 81002,
      start: "2026-09-16T21:40:00.000Z",
      end: "2026-09-17T05:10:00.000Z",
    };
    expect(daySourcesOutOfStep(user.cycles, [newer, ...user.sleeps], user.recoveries)).toBe(true);
  });

  it("ignores sleeps and recoveries of older cycles outside the loaded range", () => {
    const user = liveShapedUser({ now: PRE_SYNC });
    const newestOnly = user.cycles.filter((cycle) => cycle.id === 81003);
    expect(daySourcesOutOfStep(newestOnly, user.sleeps, user.recoveries)).toBe(false);
  });
});
