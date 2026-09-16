/**
 * Self-tests for the shared test helpers: the fixture WHOOP API, the fixture
 * users and the contract helpers. Other suites (and the goldens) rely on these
 * behaviours, so they are pinned here.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { WhoopApiError, WhoopRateBudgetError } from "../../src/api/client.js";
import { createRateLimiter } from "../../src/api/rate-limiter.js";
import {
  cycleRecordSchema,
  recoveryRecordSchema,
  sleepRecordSchema,
  workoutRecordSchema,
} from "../../src/api/record-schemas.js";
import type { Cycle, PaginatedResponse, Sleep, Workout } from "../../src/api/types.js";
import {
  assertNeutralText,
  callTool,
  connectServer,
  listToolNames,
  NON_NEUTRAL_TEXT,
} from "./contract.js";
import {
  createWhoopFixtureClient,
  decodeFixturePageToken,
  encodeFixturePageToken,
  type WhoopFixtureClient,
} from "./whoop-fixture-client.js";
import {
  LIVE_SHAPED_IDS,
  liveShapedUser,
  matureUser,
  offsetMinutes,
  stressUser,
  type WhoopUserFixture,
} from "./whoop-users.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const LEGACY_STANDARD_TOOLS = [
  "compare_periods",
  "get_baselines",
  "get_body_measurement",
  "get_calendar",
  "get_cycle_by_id",
  "get_cycle_collection",
  "get_profile",
  "get_recovery_collection",
  "get_sleep_by_id",
  "get_sleep_collection",
  "get_sleep_debt",
  "get_today",
  "get_trend",
  "get_weekly_summary",
  "get_workout_by_id",
  "get_workout_collection",
];
const LEGACY_AGGREGATE_TOOLS = [
  "compare_periods",
  "get_baselines",
  "get_sleep_debt",
  "get_trend",
  "get_weekly_summary",
];

function clientFor(fixture: WhoopUserFixture): WhoopFixtureClient {
  return createWhoopFixtureClient({ ...fixture, now: fixture.now });
}

function page<T>(client: WhoopFixtureClient, path: string): Promise<PaginatedResponse<T>> {
  return client.get<PaginatedResponse<T>>(path);
}

async function expectStatus(promise: Promise<unknown>, status: number): Promise<void> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason
  );
  expect(error).toBeInstanceOf(WhoopApiError);
  expect((error as WhoopApiError).statusCode).toBe(status);
}

/** Local wall-clock "YYYY-MM-DDTHH:MM" of an instant in `offset`. */
function localClock(timestamp: string, offset: string): string {
  return new Date(Date.parse(timestamp) + offsetMinutes(offset) * MINUTE)
    .toISOString()
    .slice(0, 16);
}

function stageSum(sleep: Sleep): number {
  const stages = sleep.score!.stage_summary;
  return (
    stages.total_awake_time_milli +
    stages.total_no_data_time_milli +
    stages.total_light_sleep_time_milli +
    stages.total_slow_wave_sleep_time_milli +
    stages.total_rem_sleep_time_milli
  );
}

function zoneSum(workout: Workout): number {
  return Object.values(workout.score!.zone_durations).reduce((sum, value) => sum + value, 0);
}

function chronological<T extends { start: string }>(records: readonly T[]): T[] {
  return [...records].sort((left, right) => Date.parse(left.start) - Date.parse(right.start));
}

function expectValidRecords(fixture: WhoopUserFixture): void {
  for (const cycle of fixture.cycles) expect(cycleRecordSchema.safeParse(cycle).success).toBe(true);
  for (const sleep of fixture.sleeps) expect(sleepRecordSchema.safeParse(sleep).success).toBe(true);
  for (const recovery of fixture.recoveries)
    expect(recoveryRecordSchema.safeParse(recovery).success).toBe(true);
  for (const workout of fixture.workouts)
    expect(workoutRecordSchema.safeParse(workout).success).toBe(true);
}

function expectShapeInvariants(fixture: WhoopUserFixture): void {
  expectValidRecords(fixture);
  const cyclesById = new Map(fixture.cycles.map((cycle) => [cycle.id, cycle]));
  for (const sleep of fixture.sleeps) {
    expect(cyclesById.has(sleep.cycle_id)).toBe(true);
    if (!sleep.nap) expect(sleep.start).toBe(cyclesById.get(sleep.cycle_id)!.start);
    if (sleep.score) {
      const inBed = Date.parse(sleep.end) - Date.parse(sleep.start);
      expect(sleep.score.stage_summary.total_in_bed_time_milli).toBe(inBed);
      expect(stageSum(sleep)).toBe(inBed);
      expect(sleep.score.sleep_needed.need_from_recent_nap_milli).toBeLessThanOrEqual(0);
      expect(sleep.score.stage_summary.total_rem_sleep_time_milli).toBeGreaterThanOrEqual(0);
    }
    expect(sleep.v1_id).toBeNull();
  }
  const sleepsById = new Map(fixture.sleeps.map((sleep) => [sleep.id, sleep]));
  for (const recovery of fixture.recoveries) {
    expect(sleepsById.get(recovery.sleep_id)?.cycle_id).toBe(recovery.cycle_id);
  }
  for (const workout of fixture.workouts) {
    expect(workout.v1_id).toBeNull();
    const score = workout.score!;
    expect(score.percent_recorded).toBeLessThanOrEqual(1);
    const duration = Date.parse(workout.end) - Date.parse(workout.start);
    expect(zoneSum(workout)).toBe(Math.round(duration * score.percent_recorded));
    const gps = workout.sport_name === "running" || workout.sport_name === "cycling";
    for (const field of [
      "distance_meter",
      "altitude_gain_meter",
      "altitude_change_meter",
    ] as const) {
      if (gps) expect(typeof score[field]).toBe("number");
      else expect(score[field]).toBeNull();
    }
    if (workout.sport_name === "running") expect(workout.sport_id).toBe(0);
  }
  // Newest first
  for (const list of [fixture.cycles, fixture.sleeps, fixture.workouts]) {
    const starts = list.map((record) => Date.parse(record.start));
    expect(starts).toEqual([...starts].sort((left, right) => right - left));
  }
  // Nothing is created, updated, started or ended after `now`.
  const nowMs = fixture.now.getTime();
  for (const record of [
    ...fixture.cycles,
    ...fixture.sleeps,
    ...fixture.recoveries,
    ...fixture.workouts,
  ]) {
    for (const field of ["created_at", "updated_at", "start", "end"] as const) {
      const value = (record as Partial<Record<typeof field, string | null>>)[field];
      if (typeof value === "string") expect(Date.parse(value)).toBeLessThanOrEqual(nowMs);
    }
    expect(Date.parse(record.updated_at)).toBeGreaterThanOrEqual(Date.parse(record.created_at));
  }
  const ids = [...fixture.sleeps, ...fixture.workouts].map((record) => record.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(new Set(fixture.cycles.map((cycle) => cycle.id)).size).toBe(fixture.cycles.length);
}

// ---------------------------------------------------------------------------
// createWhoopFixtureClient
// ---------------------------------------------------------------------------

describe("createWhoopFixtureClient", () => {
  const live = liveShapedUser();

  it("includes records ongoing at start and excludes records starting at end", async () => {
    const client = clientFor(live);
    const inside = await page<Cycle>(
      client,
      "/v2/cycle?start=2026-09-15T12:00:00.000Z&end=2026-09-15T21:13:31.460Z&limit=25"
    );
    expect(inside.records.map((cycle) => cycle.id)).toEqual([
      LIVE_SHAPED_IDS.cycles.afterMidnightOnset,
    ]);
    // A cycle ending exactly at start is not ongoing; the open cycle runs to now.
    const atBoundary = await page<Cycle>(client, "/v2/cycle?start=2026-09-15T21:13:31.460Z");
    expect(atBoundary.records.map((cycle) => cycle.id)).toEqual([LIVE_SHAPED_IDS.cycles.open]);
    expect(atBoundary).toHaveProperty("next_token", null);
  });

  it("serves recoveries by their cycle interval", async () => {
    const client = clientFor(live);
    const result = await page<{ cycle_id: number }>(
      client,
      "/v2/recovery?start=2026-09-16T00:00:00.000Z&end=2026-09-16T01:00:00.000Z"
    );
    expect(result.records.map((recovery) => recovery.cycle_id)).toEqual([
      LIVE_SHAPED_IDS.cycles.open,
    ]);
  });

  it("pages newest first with an opaque token and an explicit null on the last page", async () => {
    const fixture = matureUser({ days: 30 });
    const client = clientFor(fixture);
    const first = await page<Cycle>(client, "/v2/cycle");
    expect(first.records).toHaveLength(10);
    expect(typeof first.next_token).toBe("string");
    const seen: number[] = [];
    let current: PaginatedResponse<Cycle> = first;
    let pages = 1;
    for (;;) {
      seen.push(...current.records.map((cycle) => cycle.id));
      if (current.next_token === null) break;
      expect(decodeFixturePageToken(current.next_token!)?.page).toBe(pages + 1);
      current = await page<Cycle>(
        client,
        `/v2/cycle?nextToken=${encodeURIComponent(current.next_token!)}`
      );
      pages += 1;
    }
    expect(current).toHaveProperty("next_token", null);
    expect(seen).toEqual(fixture.cycles.map((cycle) => cycle.id));
    expect(pages).toBe(Math.ceil(fixture.cycles.length / 10));
  });

  it("answers invalid parameters like WHOOP", async () => {
    const client = clientFor(live);
    await expectStatus(client.get("/v2/cycle?limit=26"), 400);
    await expectStatus(client.get("/v2/cycle?limit=0"), 400);
    await expectStatus(client.get("/v2/cycle?limit=abc"), 400);
    await expectStatus(client.get("/v2/cycle?nextToken=not-a-token"), 400);
    await expectStatus(client.get(`/v2/cycle?nextToken=${encodeFixturePageToken(0, 1)}`), 400);
    await expectStatus(client.get("/v2/cycle?start=2026-09-14"), 404);
    await expectStatus(client.get("/v2/cycle?start=yesterday"), 400);
    await expectStatus(client.get("/v2/cycle?start=2026-09-14T00:00:00"), 400);
    await expectStatus(
      client.get("/v2/cycle?start=2026-09-15T00:00:00.000Z&end=2026-09-14T00:00:00.000Z"),
      400
    );
    await expectStatus(client.get("/v2/unknown"), 404);
  });

  it("serves by-id, per-cycle, profile and body paths with 404 for missing records", async () => {
    const client = clientFor(live);
    const { cycles, sleeps, workouts } = LIVE_SHAPED_IDS;
    expect(await client.get<Cycle>(`/v2/cycle/${cycles.open}`)).toMatchObject({
      id: cycles.open,
      end: null,
    });
    expect(await client.get<Sleep>(`/v2/cycle/${cycles.afterMidnightOnset}/sleep`)).toMatchObject({
      id: sleeps.first,
    });
    expect(await client.get(`/v2/cycle/${cycles.open}/recovery`)).toMatchObject({
      sleep_id: sleeps.second,
    });
    expect(await client.get<Sleep>(`/v2/activity/sleep/${sleeps.second}`)).toMatchObject({
      cycle_id: cycles.open,
    });
    expect(await client.get<Workout>(`/v2/activity/workout/${workouts.morningRun}`)).toMatchObject({
      sport_id: 0,
    });
    expect(await client.get("/v2/user/profile/basic")).toEqual(live.profile);
    expect(await client.get("/v2/user/measurement/body")).toEqual(live.body);
    await expectStatus(client.get(`/v2/cycle/${cycles.firstDay}/sleep`), 404);
    await expectStatus(client.get(`/v2/cycle/${cycles.firstDay}/recovery`), 404);
    await expectStatus(client.get("/v2/cycle/999999"), 404);
    await expectStatus(client.get("/v2/cycle/abc"), 400);
    await expectStatus(client.get("/v2/activity/sleep/not-a-uuid"), 404);
    await expectStatus(
      client.get("/v2/activity/workout/00000000-0000-4000-8000-000000000000"),
      404
    );
    const empty = createWhoopFixtureClient();
    await expectStatus(empty.get("/v2/user/profile/basic"), 404);
    await expectStatus(empty.get("/v2/user/measurement/body"), 404);
    expect(await empty.get("/v2/activity/workout")).toEqual({ records: [], next_token: null });
  });

  it("returns deep clones and reads the record arrays live", async () => {
    const fixture = liveShapedUser();
    const client = clientFor(fixture);
    const first = await page<Cycle>(client, "/v2/cycle?limit=1");
    first.records[0]!.score!.strain = 99;
    const again = await page<Cycle>(client, "/v2/cycle?limit=1");
    expect(again.records[0]!.score!.strain).toBe(fixture.cycles[0]!.score!.strain);
    fixture.cycles.unshift({
      ...fixture.cycles[0]!,
      id: 81004,
      start: "2026-09-16T21:20:00.000Z",
      end: null,
    });
    const updated = await page<Cycle>(client, "/v2/cycle?limit=1");
    expect(updated.records[0]!.id).toBe(81004);
  });

  it("injects failures by path, page and count, and rate limits after N calls", async () => {
    const failing = createWhoopFixtureClient({
      ...matureUser({ days: 30 }),
      failures: [
        {
          path: /^\/v2\/cycle\?/,
          page: 2,
          times: 1,
          error: new WhoopApiError(500, "Server Error", null),
        },
        { path: /^\/v2\/recovery/, error: () => new WhoopApiError(503, "Unavailable", null) },
      ],
    });
    const first = await page<Cycle>(failing, "/v2/cycle?limit=5");
    const secondPath = `/v2/cycle?limit=5&nextToken=${encodeURIComponent(first.next_token!)}`;
    await expectStatus(failing.get(secondPath), 500);
    expect((await page<Cycle>(failing, secondPath)).records).toHaveLength(5);
    await expectStatus(failing.get("/v2/recovery"), 503);
    await expectStatus(failing.get("/v2/recovery"), 503);

    const limited = createWhoopFixtureClient({ rateLimitAfter: 2 });
    await limited.get("/v2/cycle");
    await limited.get("/v2/cycle", { cache: true, ttlMs: 1000 });
    await expectStatus(limited.get("/v2/cycle"), 429);
    expect(limited.calls).toEqual(["/v2/cycle", "/v2/cycle", "/v2/cycle"]);
    expect(limited.requests[1]).toEqual({
      path: "/v2/cycle",
      options: { cache: true, ttlMs: 1000 },
    });
  });

  describe("deadlines and rate limiting", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("refuses a request whose deadline has passed without recording it", async () => {
      const client = createWhoopFixtureClient({ cycles: live.cycles });
      await expect(client.get("/v2/cycle", { deadlineMs: Date.now() - 1 })).rejects.toBeInstanceOf(
        WhoopRateBudgetError
      );
      expect(client.calls).toEqual([]);
      const page = await client.get<PaginatedResponse<Cycle>>("/v2/cycle?limit=25", {
        deadlineMs: Date.now() + MINUTE,
      });
      expect(page.records).toHaveLength(live.cycles.length);
      expect(client.requests).toEqual([
        { path: "/v2/cycle?limit=25", options: { deadlineMs: expect.any(Number) } },
      ]);
    });

    it("serves synchronously without a limiter, like before", () => {
      const client = createWhoopFixtureClient({ cycles: live.cycles });
      void client.get("/v2/cycle");
      expect(client.calls).toEqual(["/v2/cycle"]);
    });

    it("paces requests through a rate limiter and refuses waiters past their deadline", async () => {
      vi.useFakeTimers();
      const limiter = createRateLimiter({ perMinute: 60, burst: 2, maxConcurrent: 4 });
      const client = createWhoopFixtureClient({ cycles: live.cycles, rateLimiter: limiter });
      const first = client.get("/v2/cycle?limit=1");
      const second = client.get("/v2/cycle?limit=2");
      const late = client.get("/v2/cycle?limit=3", { deadlineMs: Date.now() + 500 });
      const third = client.get("/v2/cycle?limit=4");
      const lateOutcome = late.then(
        () => "served",
        (error: unknown) => error
      );
      await Promise.all([first, second]);
      expect(client.calls).toEqual(["/v2/cycle?limit=1", "/v2/cycle?limit=2"]);
      await vi.advanceTimersByTimeAsync(600);
      expect(await lateOutcome).toBeInstanceOf(WhoopRateBudgetError);
      await vi.advanceTimersByTimeAsync(1_000);
      await third;
      expect(client.calls).toEqual(["/v2/cycle?limit=1", "/v2/cycle?limit=2", "/v2/cycle?limit=4"]);
      expect(limiter.stats().requests_last_minute).toBe(3);
    });

    it("reports injected 429s to the rate limiter", async () => {
      const limiter = createRateLimiter({ perMinute: 60 });
      const client = createWhoopFixtureClient({ rateLimitAfter: 0, rateLimiter: limiter });
      await expectStatus(client.get("/v2/cycle"), 429);
      expect(limiter.stats().rate_limited_responses_total).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Fixture users
// ---------------------------------------------------------------------------

describe("liveShapedUser", () => {
  const live = liveShapedUser();

  it("is deterministic and honours the live shape invariants", () => {
    expect(liveShapedUser()).toEqual(live);
    expectShapeInvariants(live);
    expect(live.now.toISOString()).toBe("2026-09-16T21:30:00.000Z");
    expect(live.offset).toBe("+02:00");
  });

  it("has the verified cycle pattern: partial first day, 00:39 onset, shared boundaries, open newest", () => {
    const cycles = chronological(live.cycles);
    expect(cycles.map((cycle) => cycle.id)).toEqual([81001, 81002, 81003]);
    expect(localClock(cycles[0]!.start, "+02:00")).toBe("2026-09-14T00:00");
    expect(localClock(cycles[1]!.start, "+02:00")).toBe("2026-09-15T00:39");
    expect(cycles[0]!.end).toBe(cycles[1]!.start);
    expect(cycles[1]!.end).toBe(cycles[2]!.start);
    expect(cycles[2]!.end).toBeNull();
    expect(live.cycles.every((cycle) => cycle.timezone_offset === "+02:00")).toBe(true);
  });

  it("has two scored, calibrating nights with zero consistency and numeric SpO2/skin temperature", () => {
    expect(live.sleeps).toHaveLength(2);
    for (const sleep of live.sleeps) {
      expect(sleep).toMatchObject({ nap: false, score_state: "SCORED" });
      expect(sleep.score!.sleep_consistency_percentage).toBe(0);
      expect(sleep.score!.sleep_needed.need_from_recent_nap_milli).toBe(0);
    }
    expect(live.recoveries).toHaveLength(2);
    for (const recovery of live.recoveries) {
      expect(recovery.score_state).toBe("SCORED");
      expect(recovery.score!.user_calibrating).toBe(true);
      expect(typeof recovery.score!.spo2_percentage).toBe("number");
      expect(typeof recovery.score!.skin_temp_celsius).toBe("number");
    }
  });

  it("has the verified 8-workout mix", () => {
    const workouts = chronological(live.workouts);
    expect(workouts.map((workout) => workout.sport_name)).toEqual([
      "walking",
      "running",
      "walking",
      "weightlifting_msk",
      "padel",
      "walking",
      "weightlifting_msk",
      "running",
    ]);
    expect(workouts.map((workout) => localClock(workout.start, "+02:00").slice(0, 10))).toEqual([
      "2026-09-14",
      "2026-09-15",
      "2026-09-15",
      "2026-09-15",
      "2026-09-15",
      "2026-09-16",
      "2026-09-16",
      "2026-09-16",
    ]);
    expect(localClock(workouts[0]!.start, "+02:00")).toBe("2026-09-14T23:17");
    const runs = workouts.filter((workout) => workout.sport_name === "running");
    expect(runs.map((run) => run.sport_id)).toEqual([0, 0]);
    expect(runs.map((run) => run.score!.percent_recorded)).toEqual([1, 0.99975777]);
    expect(
      workouts
        .filter((workout) => workout.sport_name !== "running")
        .map((w) => w.score!.percent_recorded)
    ).toEqual([1, 1, 1, 1, 1, 1]);
    const manual = workouts.find((workout) => workout.id === LIVE_SHAPED_IDS.workouts.manualWalk)!;
    for (const field of ["start", "end", "created_at", "updated_at"] as const)
      expect(manual[field]).toMatch(/:\d{2}\.000Z$/);
    expect(Date.parse(manual.updated_at) - Date.parse(manual.created_at)).toBeGreaterThan(3 * HOUR);
  });

  it("can be viewed as of an earlier instant", () => {
    const syncRace = liveShapedUser({ now: "2026-09-16T05:01:37.000Z" });
    expectShapeInvariants(syncRace);
    // The open cycle's later strain updates have not happened yet.
    expect(syncRace.cycles[0]!.updated_at).toBe(syncRace.cycles[0]!.created_at);
    expect(syncRace.cycles.map((cycle) => cycle.id)).toEqual([81003, 81002, 81001]);
    expect(syncRace.sleeps.map((sleep) => sleep.id)).toEqual([LIVE_SHAPED_IDS.sleeps.first]);
    expect(syncRace.recoveries).toHaveLength(1);
    expect(syncRace.workouts).toHaveLength(5);

    const midday = liveShapedUser({ now: "2026-09-15T12:00:00.000Z" });
    expectShapeInvariants(midday);
    expect(midday.cycles.map((cycle) => [cycle.id, cycle.end])).toEqual([
      [81002, null],
      [81001, "2026-09-14T22:39:27.317Z"],
    ]);
    expect(midday.workouts).toHaveLength(3);
  });
});

describe("matureUser", () => {
  const mature = matureUser();

  it("is deterministic per seed", () => {
    expect(matureUser()).toEqual(mature);
    expect(matureUser({ seed: 2 }).workouts[0]).not.toEqual(mature.workouts[0]);
  });

  it("covers 120 local days ending today with the live shape invariants", () => {
    expectShapeInvariants(mature);
    const cycles = chronological(mature.cycles);
    const first = cycles[0]!;
    expect(localClock(first.start, first.timezone_offset)).toBe("2026-05-20T00:00");
    const newest = cycles[cycles.length - 1]!;
    expect(newest.end).toBeNull();
    expect(mature.offset).toBe("+01:00");
    expect(newest.timezone_offset).toBe("+01:00");
    expect(first.timezone_offset).toBe("+02:00");
  });

  it("has consecutive cycle boundaries except one strap-off gap, and a split night", () => {
    const cycles = chronological(mature.cycles);
    const breaks = cycles
      .slice(0, -1)
      .filter((cycle, index) => cycle.end !== cycles[index + 1]!.start);
    expect(breaks).toHaveLength(1);
    const main = mature.sleeps.filter((sleep) => !sleep.nap);
    const wakeDays = main.map((sleep) => localClock(sleep.end, sleep.timezone_offset).slice(0, 10));
    expect(wakeDays.length - new Set(wakeDays).size).toBe(1);
  });

  it("has naps with negative nap need next night, low-coverage nights and a pending last night", () => {
    const naps = mature.sleeps.filter((sleep) => sleep.nap);
    expect(naps.length).toBeGreaterThan(10);
    const negativeNapNeed = mature.sleeps.filter(
      (sleep) => (sleep.score?.sleep_needed.need_from_recent_nap_milli ?? 0) < 0
    );
    expect(negativeNapNeed.length).toBeGreaterThan(5);
    const lowCoverage = mature.sleeps.filter(
      (sleep) =>
        sleep.score !== null &&
        sleep.score !== undefined &&
        sleep.score.stage_summary.total_no_data_time_milli >
          0.2 * sleep.score.stage_summary.total_in_bed_time_milli
    );
    expect(lowCoverage.length).toBeGreaterThan(5);
    const newestMain = mature.sleeps.find((sleep) => !sleep.nap)!;
    expect(newestMain.score_state).toBe("PENDING_SCORE");
    expect(newestMain.score).toBeNull();
    expect(mature.recoveries[0]).toMatchObject({
      sleep_id: newestMain.id,
      score_state: "PENDING_SCORE",
    });
  });

  it("books after-midnight workouts inside the previous day's cycle", () => {
    const cycles = chronological(mature.cycles);
    const late = mature.workouts.filter((workout) => {
      const clock = localClock(workout.start, workout.timezone_offset).slice(11);
      const cycle = cycles.find(
        (candidate) =>
          Date.parse(candidate.start) <= Date.parse(workout.start) &&
          (candidate.end === null || Date.parse(workout.start) < Date.parse(candidate.end!))
      );
      return (
        clock < "01:00" &&
        cycle !== undefined &&
        localClock(cycle.start, cycle.timezone_offset).slice(0, 10) <
          localClock(workout.start, workout.timezone_offset).slice(0, 10)
      );
    });
    expect(late.length).toBeGreaterThan(5);
  });

  it("marks the first recoveries calibrating when asked", () => {
    const calibrating = matureUser({ days: 20, calibratingFirst: 5 });
    const scored = [...calibrating.recoveries].reverse().filter((recovery) => recovery.score);
    expect(scored.map((recovery) => recovery.score!.user_calibrating)).toEqual(
      scored.map((_, index) => index < 5)
    );
    const sleepsById = new Map(calibrating.sleeps.map((sleep) => [sleep.id, sleep]));
    for (const recovery of scored.slice(0, 5))
      expect(sleepsById.get(recovery.sleep_id)!.score!.sleep_consistency_percentage).toBe(0);
  });

  it("drifts HRV, recovery and resting heart rate when asked", () => {
    const drifting = matureUser({ days: 90, hrvDriftPerDay: 0.3 });
    const scored = [...drifting.recoveries].reverse().filter((recovery) => recovery.score);
    const mean = (values: number[]): number =>
      values.reduce((sum, value) => sum + value, 0) / values.length;
    const early = scored.slice(0, 20).map((recovery) => recovery.score!);
    const late = scored.slice(-20).map((recovery) => recovery.score!);
    expect(
      mean(late.map((score) => score.hrv_rmssd_milli)) -
        mean(early.map((score) => score.hrv_rmssd_milli))
    ).toBeGreaterThan(15);
    expect(
      mean(late.map((score) => score.recovery_score)) -
        mean(early.map((score) => score.recovery_score))
    ).toBeGreaterThan(15);
    expect(mean(late.map((score) => score.resting_heart_rate))).toBeLessThan(
      mean(early.map((score) => score.resting_heart_rate))
    );
  });

  it("can disable every quirk", () => {
    const plain = matureUser({
      days: 14,
      gapDays: [],
      napEvery: 0,
      pendingLast: false,
      offsetChange: null,
      lowCoverageEvery: 0,
      splitNightDays: [],
      lateWorkoutEvery: 0,
    });
    expectShapeInvariants(plain);
    const cycles = chronological(plain.cycles);
    expect(cycles).toHaveLength(14);
    for (let index = 0; index < cycles.length - 1; index += 1)
      expect(cycles[index]!.end).toBe(cycles[index + 1]!.start);
    expect(plain.sleeps.every((sleep) => !sleep.nap && sleep.score_state === "SCORED")).toBe(true);
    expect(new Set(plain.cycles.map((cycle) => cycle.timezone_offset))).toEqual(
      new Set(["+02:00"])
    );
  });

  it("follows the requested offset and clock", () => {
    const west = matureUser({ days: 10, offset: "-05:00", now: "2026-03-04T08:00:00-05:00" });
    expectShapeInvariants(west);
    const cycles = chronological(west.cycles);
    expect(localClock(cycles[0]!.start, "-05:00")).toBe("2026-02-23T00:00");
    expect(west.offset).toBe("-06:00");
    expect(Date.parse(cycles[cycles.length - 1]!.start)).toBeLessThanOrEqual(west.now.getTime());
  });
});

describe("stressUser", () => {
  it("is a dense year that keeps the invariants", () => {
    const stress = stressUser();
    expectShapeInvariants(stress);
    expect(stress.cycles.length).toBeGreaterThan(360);
    expect(stress.workouts.length).toBeGreaterThan(700);
    expect(stress.sleeps.filter((sleep) => sleep.nap).length).toBeGreaterThan(110);
  });
});

// ---------------------------------------------------------------------------
// Contract helpers
// ---------------------------------------------------------------------------

describe("contract helpers", () => {
  it("lists the legacy tools in both modes", async () => {
    expect(await listToolNames("standard")).toEqual(expect.arrayContaining(LEGACY_STANDARD_TOOLS));
    expect(await listToolNames("aggregate")).toEqual(
      expect.arrayContaining(LEGACY_AGGREGATE_TOOLS)
    );
  });

  it("calls a tool through a connected client", async () => {
    const live = liveShapedUser();
    const outcome = await callTool(clientFor(live), "get_profile");
    expect(outcome.isError).toBe(false);
    expect(outcome.structured).toEqual(live.profile);
    expect(outcome.text).toBe(JSON.stringify(live.profile, null, 2));

    const connection = await connectServer(createWhoopFixtureClient(), {
      privacyMode: "aggregate",
    });
    try {
      expect(connection.tools.map((tool) => tool.name)).not.toContain("get_profile");
      const denied = await connection.callTool("get_profile");
      expect(denied.isError).toBe(true);
      expect(denied.structured).toBeNull();
    } finally {
      await connection.close();
    }
  });

  it("flags advisory and causal wording anywhere in a value", () => {
    expect(() =>
      assertNeutralText({ notes: ["Recovery was 12% higher on nights after training."], n: 3 })
    ).not.toThrow();
    for (const text of [
      "You should rest",
      "Poor sleep causes low recovery",
      "Try to sleep earlier",
      "This was due to travel",
      "We recommend a deload",
      "Late meals lead to lower HRV",
    ]) {
      expect(NON_NEUTRAL_TEXT.test(text)).toBe(true);
      expect(() => assertNeutralText({ nested: [{ text }] })).toThrow(/nested\[0\]\.text/);
    }
  });
});
