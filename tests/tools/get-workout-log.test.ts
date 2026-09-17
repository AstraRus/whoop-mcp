/**
 * Tests for get_workout_log (package P7, standard mode only).
 *
 * Covers: the live-shaped 8-workout mix (placement, sport_id 0, notes), sport
 * and distance filters with available_sports before the filter, pace sorting
 * (fastest first, non-GPS and implausible GPS dropped with notes), nulls last
 * and ties newest first, limit and totals over every match, unscored sessions
 * hidden or listed with null fields, a late-night session counted on the
 * previous day, an after-midnight session after the last window day at a
 * 30-day chunk boundary, source failures and truncation, future starts, output
 * size on stressUser, the MCP contract and absence in aggregate mode.
 */

import { describe, expect, it } from "vitest";
import { WhoopApiError } from "../../src/api/client.js";
import { HISTORY_CHUNK_MS } from "../../src/api/history.js";
import { MemoryCache } from "../../src/cache/memory-cache.js";
import type { Cycle, Recovery, ScoreState, Sleep, Workout } from "../../src/api/types.js";
import { localMidnightMs } from "../../src/tools/analytics-utils.js";
import { addDays } from "../../src/tools/day-model.js";
import {
  compareLogItems,
  getWorkoutLog,
  WORKOUT_LOG_MAX_LIMIT,
  workoutLogInputSchema,
  workoutLogOutputSchema,
  type WorkoutLogInput,
  type WorkoutLogOutput,
} from "../../src/tools/get-workout-log.js";
import { MAX_TOOL_TEXT_CHARS, type ToolContext } from "../../src/tools/tool-definition.js";
import { normalizeWorkout } from "../../src/tools/workout-utils.js";
import { assertNeutralText, connectServer, listToolNames } from "../helpers/contract.js";
import {
  createWhoopFixtureClient,
  type WhoopFixtureClientOptions,
} from "../helpers/whoop-fixture-client.js";
import {
  LIVE_SHAPED_IDS,
  liveShapedUser,
  matureUser,
  stressUser,
  type WhoopUserFixture,
} from "../helpers/whoop-users.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const OFFSET = "+02:00";
const TODAY = "2026-09-16";
const IDS = LIVE_SHAPED_IDS.workouts;

const iso = (ms: number): string => new Date(ms).toISOString();

// ---------------------------------------------------------------------------
// Planned accounts
// ---------------------------------------------------------------------------

interface SessionPlan {
  day: string;
  /** Local start in minutes after midnight (may exceed 1440 for the next morning) */
  minute: number;
  minutes: number;
  sport?: string;
  sportId?: number | null;
  strain?: number;
  kj?: number;
  hr?: number;
  maxHr?: number;
  fraction?: number;
  /** Zone 1-5 minutes; default all recorded minutes in zone 2 */
  zones?: [number, number, number, number, number];
  state?: ScoreState;
  km?: number | null;
}

function localMs(day: string, minute: number, offset = OFFSET): number {
  return localMidnightMs(day, offset) + minute * MINUTE_MS;
}

function workoutOf(plan: SessionPlan, id: string, offset = OFFSET): Workout {
  const startMs = localMs(plan.day, plan.minute, offset);
  const durationMs = Math.round(plan.minutes * MINUTE_MS);
  const fraction = plan.fraction ?? 1;
  const recordedMs = Math.round(durationMs * fraction);
  const zones = (plan.zones ?? [0, plan.minutes * fraction, 0, 0, 0]).map((value) =>
    Math.round(value * MINUTE_MS)
  );
  const state = plan.state ?? "SCORED";
  return {
    user_id: 1,
    created_at: iso(startMs + durationMs + MINUTE_MS),
    updated_at: iso(startMs + durationMs + MINUTE_MS),
    score_state: state,
    start: iso(startMs),
    end: iso(startMs + durationMs),
    timezone_offset: offset,
    id,
    sport_name: plan.sport ?? "running",
    sport_id: plan.sportId === undefined ? 0 : plan.sportId,
    v1_id: null,
    score:
      state === "SCORED"
        ? {
            strain: plan.strain ?? 8,
            average_heart_rate: plan.hr ?? 140,
            max_heart_rate: plan.maxHr ?? 170,
            kilojoule: plan.kj ?? 800,
            percent_recorded: fraction,
            zone_durations: {
              zone_zero_milli: Math.max(0, recordedMs - zones.reduce((sum, v) => sum + v, 0)),
              zone_one_milli: zones[0]!,
              zone_two_milli: zones[1]!,
              zone_three_milli: zones[2]!,
              zone_four_milli: zones[3]!,
              zone_five_milli: zones[4]!,
            },
            distance_meter: plan.km === undefined || plan.km === null ? null : plan.km * 1000,
            altitude_gain_meter: null,
            altitude_change_meter: null,
          }
        : null,
  };
}

/** One cycle per local day, starting 23:00 the evening before (the first at local midnight); the last is open */
function cyclesFor(firstDay: string, lastDay: string, offset = OFFSET): Cycle[] {
  const days: string[] = [];
  for (let day = firstDay; day <= lastDay; day = addDays(day, 1)) days.push(day);
  const startOf = (index: number): number =>
    index === 0
      ? localMs(days[0]!, 0, offset)
      : localMs(addDays(days[index]!, -1), 23 * 60, offset);
  return days.map((_, index) => {
    const startMs = startOf(index);
    const endMs = index === days.length - 1 ? null : startOf(index + 1);
    return {
      user_id: 1,
      created_at: iso(startMs + 8 * HOUR_MS),
      updated_at: iso((endMs ?? startMs) + MINUTE_MS),
      score_state: "SCORED",
      start: iso(startMs),
      end: endMs === null ? null : iso(endMs),
      timezone_offset: offset,
      id: 5000 + index,
      score: { strain: 10, kilojoule: 8000, average_heart_rate: 70, max_heart_rate: 160 },
    };
  });
}

function contextFor(options: WhoopFixtureClientOptions & { now: Date }): ToolContext {
  const client = createWhoopFixtureClient(options);
  return { client, privacyMode: "standard", now: () => options.now, startedAtMs: Date.now() };
}

async function run(
  options: WhoopFixtureClientOptions & { now: Date },
  args: Partial<WorkoutLogInput> = {}
): Promise<WorkoutLogOutput> {
  const output = await getWorkoutLog(workoutLogInputSchema.parse(args), contextFor(options));
  workoutLogOutputSchema.parse(output);
  assertNeutralText([output.notes, output.warnings]);
  return output;
}

function live(extra: Partial<WhoopUserFixture> = {}): WhoopFixtureClientOptions & { now: Date } {
  const fixture = liveShapedUser();
  return { ...fixture, ...extra, now: fixture.now };
}

function ids(output: WorkoutLogOutput): string[] {
  return output.workouts.map((workout) => workout.id);
}

const planNow = new Date(localMs(TODAY, 23 * 60));

function planned(
  sessions: readonly SessionPlan[],
  extra: Omit<Partial<WhoopFixtureClientOptions>, "now"> = {}
): WhoopFixtureClientOptions & { now: Date } {
  return {
    cycles: cyclesFor("2026-09-01", TODAY),
    workouts: sessions.map((plan, index) => workoutOf(plan, `w-${index}`)),
    now: planNow,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Live-shaped account
// ---------------------------------------------------------------------------

describe("liveShapedUser", () => {
  it("lists the verified 8-workout mix newest first on cycle days", async () => {
    const output = await run(live());
    expect(output.period).toEqual({
      start_day: "2026-09-03",
      end_day: TODAY,
      days: 14,
      utc_offset: OFFSET,
    });
    expect(output.total_matching).toBe(8);
    expect(output.returned).toBe(8);
    expect(output.output_capped).toBe(false);
    expect(ids(output)).toEqual([
      IDS.eveningRun,
      IDS.weightliftingDay3,
      IDS.manualWalk,
      IDS.padel,
      IDS.weightliftingDay2,
      IDS.middayWalk,
      IDS.morningRun,
      IDS.lateWalk,
    ]);
    const byId = new Map(output.workouts.map((workout) => [workout.id, workout]));
    // The 23:17 walk before the 00:39 onset stays on 09-14 (its cycle's day).
    expect(byId.get(IDS.lateWalk)).toMatchObject({ day: "2026-09-14", local_date: "2026-09-14" });
    expect(byId.get(IDS.morningRun)).toMatchObject({ sport_id: 0, day: "2026-09-15" });
    expect(byId.get(IDS.eveningRun)!.flags).toContain("cycle_in_progress");
    expect(byId.get(IDS.eveningRun)!.gps).not.toBeNull();
    expect(byId.get(IDS.padel)!.gps).toBeNull();
    expect(output.available_sports).toEqual([
      { sport_name: "walking", sessions: 3 },
      { sport_name: "running", sessions: 2 },
      { sport_name: "weightlifting_msk", sessions: 2 },
      { sport_name: "padel", sessions: 1 },
    ]);
    expect(output.truncated).toBe(false);
    expect(output.warnings).toEqual([]);
    expect(output.notes.join(" ")).toMatch(/elapsed time \(pauses included\)/);
    expect(output.notes.join(" ")).toMatch(/strength sessions \(weightlifting_msk\)/);
    expect(output.data_quality.method_version).toBe("workout-log-1");
    expect(output.data_quality.sources.workouts).toMatchObject({
      status: "available",
      records_used: 8,
    });
    expect(output.data_quality.limitations.length).toBeGreaterThan(2);
  });

  it("totals every matching session from unrounded values", async () => {
    const fixture = liveShapedUser();
    const output = await run(live());
    const summaries = fixture.workouts.map((workout) => normalizeWorkout(workout, null, false)!);
    const sum = (pick: (value: (typeof summaries)[number]) => number): number =>
      summaries.reduce((total, summary) => total + pick(summary), 0);
    expect(output.totals.sessions).toBe(8);
    expect(output.totals.duration_minutes).toBeCloseTo(
      sum((s) => s.duration_minutes),
      1
    );
    expect(output.totals.trimp).toBeCloseTo(
      sum((s) => s.trimp!),
      1
    );
    expect(output.totals.kilojoule).toBe(Math.round(sum((s) => s.kilojoule!)));
    expect(output.totals.distance_km).toBeCloseTo(8.1034 + 7.4126, 2);
    expect(output.totals.gps_sessions).toBe(2);
    expect(output.totals.zone_minutes).not.toBeNull();
  });

  it("filters by sport (case-insensitive) and minimum distance while available_sports ignores the filter", async () => {
    const output = await run(live(), { sport: ["RUNNING"], min_distance_km: 7.5 });
    expect(ids(output)).toEqual([IDS.eveningRun]);
    expect(output.total_matching).toBe(1);
    expect(output.filters).toMatchObject({ sport: ["RUNNING"], min_distance_km: 7.5 });
    expect(output.available_sports.map((sport) => sport.sport_name)).toEqual([
      "walking",
      "running",
      "weightlifting_msk",
      "padel",
    ]);
    expect(output.data_quality.sources.workouts!.exclusions.filtered_out).toBe(7);
  });

  it("names a sport filter that matches nothing", async () => {
    const output = await run(live(), { sport: ["rowing"] });
    expect(output.total_matching).toBe(0);
    expect(output.notes.join(" ")).toMatch(/"rowing"/);
    expect(output.totals).toMatchObject({ sessions: 0, duration_minutes: 0, distance_km: null });
  });

  it("caps the list at limit while totals cover every match", async () => {
    const output = await run(live(), { limit: 3, sort: "duration" });
    expect(output.returned).toBe(3);
    expect(output.total_matching).toBe(8);
    expect(output.output_capped).toBe(true);
    expect(output.totals.sessions).toBe(8);
    expect(output.workouts[0]!.id).toBe(IDS.padel);
    expect(output.notes.join(" ")).toMatch(/8 sessions match; the first 3/);
  });

  it("hides unscored sessions by default and lists them with null fields on request", async () => {
    const fixture = liveShapedUser();
    const pending: Workout = {
      ...fixture.workouts.find((workout) => workout.id === IDS.middayWalk)!,
      id: "pending-walk",
      score_state: "PENDING_SCORE",
      score: null,
      start: "2026-09-16T12:00:00.000Z",
      end: "2026-09-16T12:30:00.000Z",
      created_at: "2026-09-16T12:31:00.000Z",
      updated_at: "2026-09-16T12:31:00.000Z",
    };
    const options = live({ workouts: [...fixture.workouts, pending] });

    const hidden = await run(options);
    expect(hidden.total_matching).toBe(8);
    expect(ids(hidden)).not.toContain("pending-walk");
    expect(hidden.notes.join(" ")).toMatch(
      /1 session in this window is not scored.*include_unscored/
    );
    expect(hidden.available_sports[0]).toEqual({ sport_name: "walking", sessions: 4 });
    expect(hidden.data_quality.sources.workouts!.exclusions.pending).toBe(1);

    const shown = await run(options, { include_unscored: true, sort: "strain" });
    expect(shown.total_matching).toBe(9);
    const last = shown.workouts[shown.workouts.length - 1]!;
    expect(last.id).toBe("pending-walk");
    expect(last).toMatchObject({
      strain: null,
      kilojoule: null,
      trimp: null,
      zone_minutes: null,
      gps: null,
      recorded_fraction: null,
    });
    expect(last.flags).toContain("not_scored");
    expect(shown.totals).toMatchObject({
      sessions: 9,
      trimp: null,
      kilojoule: null,
      kcal: null,
      recorded_minutes: null,
      zone_minutes: null,
      distance_km: null,
    });
    expect(shown.totals.duration_minutes).toBeGreaterThan(hidden.totals.duration_minutes);

    const scoreFiltered = await run(options, { include_unscored: true, min_strain: 1 });
    expect(scoreFiltered.total_matching).toBe(8);
    expect(scoreFiltered.notes.join(" ")).toMatch(
      /min_strain, has_gps and min_distance_km need a WHOOP score/
    );
  });

  it("counts a session after local midnight but before sleep onset toward the previous day", async () => {
    const fixture = liveShapedUser();
    // 00:20 local on 09-15, before the 00:39 sleep onset: cycle 81001 (09-14) is still running.
    const lateNight: Workout = {
      ...fixture.workouts.find((workout) => workout.id === IDS.lateWalk)!,
      id: "after-midnight-walk",
      start: "2026-09-14T22:20:00.000Z",
      end: "2026-09-14T22:32:00.000Z",
      created_at: "2026-09-14T22:33:00.000Z",
      updated_at: "2026-09-14T22:33:00.000Z",
      score: {
        ...fixture.workouts.find((workout) => workout.id === IDS.lateWalk)!.score!,
        zone_durations: {
          zone_zero_milli: 600_000,
          zone_one_milli: 120_000,
          zone_two_milli: 0,
          zone_three_milli: 0,
          zone_four_milli: 0,
          zone_five_milli: 0,
        },
      },
    };
    const output = await run(live({ workouts: [...fixture.workouts, lateNight] }), {
      start: "2026-09-14",
      days: 1,
    });
    expect(output.period).toMatchObject({ start_day: "2026-09-14", end_day: "2026-09-14" });
    const entry = output.workouts.find((workout) => workout.id === "after-midnight-walk")!;
    expect(entry.day).toBe("2026-09-14");
    expect(entry.local_date).toBe("2026-09-15");
    expect(entry.day).not.toBe(entry.local_date);
    expect(entry.flags).toContain("after_midnight_in_previous_cycle");
    expect(ids(output).sort()).toEqual(["after-midnight-walk", IDS.lateWalk].sort());
    expect(output.notes.join(" ")).toMatch(/after local midnight/);
  });
});

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

describe("sorting", () => {
  const sessions: SessionPlan[] = [
    { day: "2026-09-10", minute: 8 * 60, minutes: 25, km: 5, strain: 9 },
    { day: "2026-09-11", minute: 8 * 60, minutes: 55, km: 10, strain: 12 },
    { day: "2026-09-12", minute: 8 * 60, minutes: 40, sport: "walking", sportId: 63, strain: 4 },
    {
      day: "2026-09-13",
      minute: 8 * 60,
      minutes: 40,
      sport: "cycling",
      sportId: 1,
      km: 20,
      strain: 12,
    },
    // 10 km in 4:46 → 35 m/s: implausible GPS
    { day: "2026-09-14", minute: 8 * 60, minutes: 286 / 60, km: 10, strain: 3 },
  ];

  it("sorts by pace fastest first over plausible GPS sessions and notes the dropped and mixed sports", async () => {
    const output = await run(planned(sessions), { sort: "pace" });
    expect(ids(output)).toEqual(["w-3", "w-0", "w-1"]);
    expect(output.workouts.map((workout) => workout.gps!.avg_pace_sec_per_km)).toEqual([
      120, 300, 330,
    ]);
    expect(output.total_matching).toBe(3);
    expect(output.totals.sessions).toBe(3);
    const text = output.notes.join(" ");
    expect(text).toMatch(/2 matching sessions without them are left out/);
    expect(text).toMatch(/different sports \(cycling, running\); the sport filter/);
    expect(output.data_quality.sources.workouts!.exclusions.no_pace).toBe(2);
  });

  it("ranks one sport by pace without the mixed-sport note", async () => {
    const output = await run(planned(sessions), { sort: "pace", sport: ["running"] });
    expect(ids(output)).toEqual(["w-0", "w-1"]);
    expect(output.notes.join(" ")).not.toMatch(/different sports/);
    expect(output.notes.join(" ")).toMatch(/1 matching session without them is left out/);
  });

  it("puts missing values last and breaks ties newest first", async () => {
    const byDistance = await run(planned(sessions), { sort: "distance" });
    expect(ids(byDistance)).toEqual(["w-3", "w-4", "w-1", "w-0", "w-2"]);
    const byStrain = await run(planned(sessions), { sort: "strain" });
    // w-1 and w-3 tie at strain 12: the later start (w-3) first.
    expect(ids(byStrain)).toEqual(["w-3", "w-1", "w-0", "w-2", "w-4"]);
    const oldest = await run(planned(sessions), { sort: "oldest" });
    expect(ids(oldest)).toEqual(["w-0", "w-1", "w-2", "w-3", "w-4"]);
    const suspect = byDistance.workouts.find((workout) => workout.id === "w-4")!;
    expect(suspect.flags).toContain("gps_suspect");
  });

  it("sorts by TRIMP and high-intensity minutes highest first", async () => {
    const zoned: SessionPlan[] = [
      { day: "2026-09-10", minute: 600, minutes: 30, zones: [0, 0, 10, 10, 10] },
      { day: "2026-09-11", minute: 600, minutes: 60, zones: [60, 0, 0, 0, 0] },
      { day: "2026-09-12", minute: 600, minutes: 30, zones: [0, 0, 0, 0, 20] },
    ];
    const trimp = await run(planned(zoned), { sort: "trimp" });
    expect(ids(trimp)).toEqual(["w-0", "w-2", "w-1"]);
    expect(trimp.workouts.map((workout) => workout.trimp)).toEqual([120, 100, 60]);
    const intense = await run(planned(zoned), { sort: "high_intensity" });
    expect(ids(intense)).toEqual(["w-2", "w-0", "w-1"]);
  });

  it("compareLogItems keeps nulls last for every sort", () => {
    const base = workoutOf({ day: "2026-09-10", minute: 600, minutes: 30, km: 5 }, "a");
    const scored = normalizeWorkout(base, null, false)!;
    const unscored = normalizeWorkout(
      { ...base, id: "b", score_state: "PENDING_SCORE", score: null },
      null,
      false
    )!;
    const left = { summary: unscored, startMs: Date.parse(base.start) + 1, endMs: 0 };
    const right = { summary: scored, startMs: Date.parse(base.start), endMs: 0 };
    for (const sort of ["strain", "trimp", "pace", "distance", "high_intensity"] as const) {
      expect(compareLogItems(left, right, sort)).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Filters and windows
// ---------------------------------------------------------------------------

describe("filters and windows", () => {
  it("applies min_duration_minutes, min_strain and has_gps", async () => {
    const sessions: SessionPlan[] = [
      { day: "2026-09-10", minute: 600, minutes: 20, km: 4, strain: 6 },
      { day: "2026-09-11", minute: 600, minutes: 60, strain: 14, sport: "padel", sportId: 249 },
      { day: "2026-09-12", minute: 600, minutes: 45, km: 9, strain: 11 },
    ];
    expect(ids(await run(planned(sessions), { min_duration_minutes: 45 }))).toEqual(["w-2", "w-1"]);
    expect(ids(await run(planned(sessions), { min_strain: 11 }))).toEqual(["w-2", "w-1"]);
    expect(ids(await run(planned(sessions), { has_gps: true }))).toEqual(["w-2", "w-0"]);
    expect(ids(await run(planned(sessions), { has_gps: false }))).toEqual(["w-1"]);
  });

  it("returns no days for a start after today", async () => {
    const output = await run(live(), { start: "2026-09-20" });
    expect(output.period.days).toBe(0);
    expect(output.workouts).toEqual([]);
    expect(output.notes.join(" ")).toMatch(/after today/);
  });

  it("rejects an unparseable start", async () => {
    await expect(getWorkoutLog({ start: "sometime soon" }, contextFor(live()))).rejects.toThrow();
  });

  it("places a 00:30 session after the last window day on it when the fetch end is a chunk boundary", async () => {
    // UTC user: local midnight after the last day is a 30-day history chunk boundary.
    const boundaryMs =
      Math.floor(Date.parse("2026-08-20T00:00:00Z") / HISTORY_CHUNK_MS) * HISTORY_CHUNK_MS;
    const boundaryDay = iso(boundaryMs).slice(0, 10);
    const lastDay = addDays(boundaryDay, -1);
    const firstDay = addDays(lastDay, -6);
    const cycles: Cycle[] = [];
    let start = localMidnightMs(addDays(firstDay, -3), "Z") + 23 * HOUR_MS;
    for (let index = 0; index < 12; index++) {
      const day = addDays(firstDay, index - 2);
      // The cycle after the last day starts at 01:30 (late sleep onset).
      const next =
        day === lastDay
          ? localMidnightMs(boundaryDay, "Z") + 90 * MINUTE_MS
          : localMidnightMs(day, "Z") + 23 * HOUR_MS;
      cycles.push({
        user_id: 1,
        created_at: iso(next),
        updated_at: iso(next),
        score_state: "SCORED",
        start: iso(start),
        end: index === 11 ? null : iso(next),
        timezone_offset: "Z",
        id: 7000 + index,
        score: { strain: 9, kilojoule: 8000, average_heart_rate: 70, max_heart_rate: 150 },
      });
      start = next;
    }
    const late = workoutOf(
      { day: boundaryDay, minute: 30, minutes: 40, km: 7 },
      "after-midnight",
      "Z"
    );
    const nextDay = workoutOf({ day: boundaryDay, minute: 9 * 60, minutes: 40 }, "next-day", "Z");
    const now = new Date(localMidnightMs(addDays(boundaryDay, 5), "Z") + 12 * HOUR_MS);
    const output = await run(
      { cycles, workouts: [late, nextDay], now },
      { start: firstDay, days: 7 }
    );
    expect(output.period).toMatchObject({ start_day: firstDay, end_day: lastDay });
    expect(ids(output)).toEqual(["after-midnight"]);
    expect(output.workouts[0]).toMatchObject({ day: lastDay, local_date: boundaryDay });
    expect(output.workouts[0]!.flags).toContain("after_midnight_in_previous_cycle");
  });
});

// ---------------------------------------------------------------------------
// Failures and truncation
// ---------------------------------------------------------------------------

describe("failures", () => {
  it("throws the WHOOP error when the workout history cannot be read", async () => {
    const options = live({});
    await expect(
      getWorkoutLog(
        {},
        contextFor({
          ...options,
          failures: [{ path: /\/v2\/activity\/workout/, error: new WhoopApiError(503, "x", {}) }],
        })
      )
    ).rejects.toBeInstanceOf(WhoopApiError);
  });

  it("places every session on its local start day with a warning when cycles fail", async () => {
    const options = live({});
    const output = await run({
      ...options,
      failures: [{ path: /^\/v2\/cycle\?start=/, error: new WhoopApiError(500, "x", {}) }],
    });
    expect(output.total_matching).toBe(8);
    expect(output.workouts.every((workout) => workout.flags.includes("day_by_fallback"))).toBe(
      true
    );
    expect(output.warnings.join(" ")).toMatch(
      /Cycle data could not be loaded \(WHOOP API returned HTTP 500\)/
    );
    expect(output.data_quality.sources.cycles!.status).toBe("fetch_failed");
  });

  it("marks a partly read history truncated with a note", async () => {
    const fixture = matureUser({ days: 120 });
    const output = await run(
      {
        ...fixture,
        now: fixture.now,
        failures: [
          {
            path: /^\/v2\/activity\/workout\?start=/,
            page: 2,
            error: new WhoopApiError(500, "x", {}),
          },
        ],
      },
      { days: 90, limit: 5 }
    );
    expect(output.truncated).toBe(true);
    expect(output.notes.join(" ")).toMatch(
      /Workout history could not be read completely \(WHOOP API returned HTTP 500\).*Repeating the request continues loading from the cache\./
    );
  });
});

// ---------------------------------------------------------------------------
// Mature data, size and contract
// ---------------------------------------------------------------------------

describe("mature and stress users", () => {
  it("lists a mature user's quarter with consistent totals and flags", async () => {
    const fixture = matureUser({ days: 120 });
    const output = await run(
      { ...fixture, now: fixture.now },
      { days: 90, limit: WORKOUT_LOG_MAX_LIMIT }
    );
    expect(output.total_matching).toBeGreaterThan(50);
    expect(output.returned).toBe(50);
    expect(output.output_capped).toBe(true);
    expect(output.truncated).toBe(false);
    // Every listed session lies inside the window, newest first.
    for (const workout of output.workouts) {
      expect(workout.day >= output.period.start_day && workout.day <= output.period.end_day).toBe(
        true
      );
    }
    const starts = output.workouts.map((workout) => Date.parse(workout.start_local));
    expect([...starts].sort((a, b) => b - a)).toEqual(starts);
    const afterMidnight = output.workouts.filter((workout) =>
      workout.flags.includes("after_midnight_in_previous_cycle")
    );
    for (const workout of afterMidnight) expect(workout.local_date > workout.day).toBe(true);
    expect(output.totals.sessions).toBe(output.total_matching);
  });

  it("stays within MAX_TOOL_TEXT_CHARS at limit 50 over 365 days on stressUser", async () => {
    const fixture = stressUser();
    const client = createWhoopFixtureClient({ ...fixture, now: fixture.now });
    const historyCache = new MemoryCache({ maxEntries: 500 });
    const connection = await connectServer(client, { now: () => fixture.now, historyCache });
    try {
      // A year of two sessions a day needs more pages than one call's budget:
      // the first call is truncated, and repeating it completes from the cache.
      const results: WorkoutLogOutput[] = [];
      for (const args of [
        { days: 365, limit: 50, include_unscored: true },
        { days: 365, limit: 50, include_unscored: true },
        { days: 365, limit: 50, sort: "pace" },
        { days: 365, limit: 50, sort: "oldest", sport: ["running", "cycling"] },
      ]) {
        const result = await connection.callTool("get_workout_log", args);
        expect(result.isError).toBe(false);
        expect(result.text.length).toBeLessThan(MAX_TOOL_TEXT_CHARS);
        const output = workoutLogOutputSchema.parse(result.structured);
        expect(output.returned).toBe(50);
        assertNeutralText([output.notes, output.warnings]);
        results.push(output);
      }
      expect(results[0]!.truncated).toBe(true);
      expect(results[0]!.notes.join(" ")).toMatch(
        /Repeating the request continues loading from the cache/
      );
      expect(results.slice(1).every((output) => !output.truncated)).toBe(true);
      expect(results[1]!.total_matching).toBeGreaterThan(700);
    } finally {
      await connection.close();
    }
  });
});

describe("contract", () => {
  it("is listed with its contract in standard mode and returns compact JSON", async () => {
    const client = createWhoopFixtureClient({ ...liveShapedUser(), now: liveShapedUser().now });
    const now = liveShapedUser().now;
    const connection = await connectServer(client, { now: () => now });
    try {
      const tool = connection.tools.find((entry) => entry.name === "get_workout_log")!;
      expect(tool.title).toBe("Workout log");
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.description!.length).toBeLessThanOrEqual(1000);
      expect(tool.outputSchema).toBeDefined();
      const result = await connection.callTool("get_workout_log", { sport: ["walking"] });
      expect(result.isError).toBe(false);
      expect(result.text).not.toContain("\n");
      expect(workoutLogOutputSchema.parse(result.structured).total_matching).toBe(3);
      const invalid = await connection.callTool("get_workout_log", { limit: 51 });
      expect(invalid.isError).toBe(true);
      const unknownDate = await connection.callTool("get_workout_log", { start: "whenever" });
      expect(unknownDate.isError).toBe(true);
    } finally {
      await connection.close();
    }
  });

  it("is absent in aggregate mode", async () => {
    expect(await listToolNames("standard")).toContain("get_workout_log");
    expect(await listToolNames("aggregate")).not.toContain("get_workout_log");
  });
});

// ---------------------------------------------------------------------------
// Day parity with get_day: cycles are placed by their main sleep
// ---------------------------------------------------------------------------

describe("day parity with get_day and get_workout_context", () => {
  /** A local instant in +02:00 */
  const at = (day: string, hhmm: string): number => Date.parse(`${day}T${hhmm}:00.000+02:00`);

  interface Scenario {
    now: Date;
    cycles: Cycle[];
    sleeps: Sleep[];
    recoveries: Recovery[];
    workouts: Workout[];
  }

  function scenario(now: number): Scenario & {
    night: (id: string, startMs: number, endMs: number, cycleEndMs: number | null) => void;
    session: (id: string, startMs: number, endMs: number) => void;
  } {
    const built: Scenario = {
      now: new Date(now),
      cycles: [],
      sleeps: [],
      recoveries: [],
      workouts: [],
    };
    return {
      ...built,
      night(id, startMs, endMs, cycleEndMs) {
        const cycleId = 7000 + built.cycles.length;
        built.cycles.push({
          id: cycleId,
          user_id: 1,
          created_at: iso(endMs + 5 * MINUTE_MS),
          updated_at: iso((cycleEndMs ?? endMs) + 5 * MINUTE_MS),
          start: iso(startMs),
          end: cycleEndMs === null ? null : iso(cycleEndMs),
          timezone_offset: OFFSET,
          score_state: "SCORED",
          score: { strain: 10, kilojoule: 8000, average_heart_rate: 70, max_heart_rate: 150 },
        });
        const inBed = endMs - startMs;
        const asleep = Math.round(inBed * 0.9);
        const light = Math.round(asleep * 0.5);
        const deep = Math.round(asleep * 0.2);
        built.sleeps.push({
          id,
          cycle_id: cycleId,
          v1_id: null,
          user_id: 1,
          created_at: iso(endMs + 5 * MINUTE_MS),
          updated_at: iso(endMs + 5 * MINUTE_MS),
          start: iso(startMs),
          end: iso(endMs),
          timezone_offset: OFFSET,
          nap: false,
          score_state: "SCORED",
          score: {
            stage_summary: {
              total_in_bed_time_milli: inBed,
              total_awake_time_milli: inBed - asleep,
              total_no_data_time_milli: 0,
              total_light_sleep_time_milli: light,
              total_slow_wave_sleep_time_milli: deep,
              total_rem_sleep_time_milli: asleep - light - deep,
              sleep_cycle_count: 4,
              disturbance_count: 8,
            },
            sleep_needed: {
              baseline_milli: 28_000_000,
              need_from_sleep_debt_milli: 1_000_000,
              need_from_recent_strain_milli: 500_000,
              need_from_recent_nap_milli: 0,
            },
            respiratory_rate: 15,
            sleep_performance_percentage: 80,
            sleep_consistency_percentage: 70,
            sleep_efficiency_percentage: 90,
          },
        });
        built.recoveries.push({
          cycle_id: cycleId,
          sleep_id: id,
          user_id: 1,
          created_at: iso(endMs + 10 * MINUTE_MS),
          updated_at: iso(endMs + 10 * MINUTE_MS),
          score_state: "SCORED",
          score: {
            user_calibrating: true,
            recovery_score: 60,
            resting_heart_rate: 55,
            hrv_rmssd_milli: 80,
            spo2_percentage: 96,
            skin_temp_celsius: 33.4,
          },
        });
      },
      session(id, startMs, endMs) {
        const minutes = (endMs - startMs) / MINUTE_MS;
        const workout = workoutOf({ day: "2026-09-01", minute: 0, minutes, km: 8 }, id);
        built.workouts.push({
          ...workout,
          start: iso(startMs),
          end: iso(endMs),
          created_at: iso(endMs + MINUTE_MS),
          updated_at: iso(endMs + MINUTE_MS),
        });
      },
    };
  }

  /** A: main sleeps 12:30-19:30 every day; now 23:30 on 09-17 */
  function daySleeper(): Scenario {
    const built = scenario(at("2026-09-17", "23:30"));
    const days = [
      "2026-09-12",
      "2026-09-13",
      "2026-09-14",
      "2026-09-15",
      "2026-09-16",
      "2026-09-17",
    ];
    days.forEach((day, index) =>
      built.night(
        `s-${day}`,
        at(day, "12:30"),
        at(day, "19:30"),
        index + 1 < days.length ? at(days[index + 1]!, "12:30") : null
      )
    );
    built.session("w-0915-2200", at("2026-09-15", "22:00"), at("2026-09-15", "23:00"));
    built.session("w-0917-2100", at("2026-09-17", "21:00"), at("2026-09-17", "22:00"));
    return built;
  }

  /** B: owner-like nights, awake through 09-16/17, main sleep 09-17 13:00-20:00; now 23:00 */
  function disruptedNight(): Scenario {
    const built = scenario(at("2026-09-17", "23:00"));
    built.night(
      "s-a",
      at("2026-09-13", "23:13"),
      at("2026-09-14", "07:00"),
      at("2026-09-14", "23:13")
    );
    built.night(
      "s-b",
      at("2026-09-14", "23:13"),
      at("2026-09-15", "07:00"),
      at("2026-09-15", "23:13")
    );
    built.night(
      "s-c",
      at("2026-09-15", "23:13"),
      at("2026-09-16", "07:00"),
      at("2026-09-17", "13:00")
    );
    built.night("s-d", at("2026-09-17", "13:00"), at("2026-09-17", "20:00"), null);
    built.session("w-0916-1800", at("2026-09-16", "18:00"), at("2026-09-16", "19:00"));
    built.session("w-0917-2115", at("2026-09-17", "21:15"), at("2026-09-17", "22:00"));
    return built;
  }

  /** C (control): bed 23:13 / 00:39, evening sessions; now 23:00 on 09-17, not asleep yet */
  function control(): Scenario {
    const built = scenario(at("2026-09-17", "23:00"));
    built.night(
      "s-a",
      at("2026-09-14", "23:13"),
      at("2026-09-15", "07:10"),
      at("2026-09-16", "00:39")
    );
    built.night(
      "s-b",
      at("2026-09-16", "00:39"),
      at("2026-09-16", "07:30"),
      at("2026-09-16", "23:13")
    );
    built.night("s-c", at("2026-09-16", "23:13"), at("2026-09-17", "07:05"), null);
    built.session("w-0916-2130", at("2026-09-16", "21:30"), at("2026-09-16", "22:15"));
    built.session("w-0917-2100", at("2026-09-17", "21:00"), at("2026-09-17", "21:50"));
    return built;
  }

  interface DayOutput {
    workouts: { id: string; day: string }[];
  }

  async function checkParity(
    data: Scenario,
    expected: Record<string, string>,
    extra: Pick<WhoopFixtureClientOptions, "failures"> = {}
  ): Promise<{ log: WorkoutLogOutput; records: Record<string, unknown> }> {
    const fixture = createWhoopFixtureClient({ ...data, now: () => data.now, ...extra });
    const connection = await connectServer(fixture, { now: () => data.now });
    try {
      const logResult = await connection.callTool("get_workout_log", {});
      expect(logResult.isError).toBe(false);
      const log = workoutLogOutputSchema.parse(logResult.structured);
      assertNeutralText([log.notes, log.warnings]);
      expect(Object.fromEntries(log.workouts.map((workout) => [workout.id, workout.day]))).toEqual(
        expected
      );
      expect(log.data_quality.sources.workouts!.exclusions.outside_window ?? 0).toBe(0);

      const records = (await connection.callTool("get_personal_records", {})).structured!;
      const sports = records.sports as {
        sport_name: string;
        sessions_considered: number;
        records: { workout_id: string; date: string }[];
      }[];
      const running = sports.find((sport) => sport.sport_name === "running")!;
      expect(running.sessions_considered).toBe(Object.keys(expected).length);
      for (const record of running.records) {
        expect(record.date).toBe(expected[record.workout_id]);
      }

      if (extra.failures === undefined) {
        for (const [id, day] of Object.entries(expected)) {
          const context = (await connection.callTool("get_workout_context", { id })).structured as {
            day: { date: string };
            notes: string[];
          };
          expect(context.day.date).toBe(day);
          const dayResult = (await connection.callTool("get_day", { date: day }))
            .structured as unknown as DayOutput;
          expect(dayResult.workouts.map((workout) => [workout.id, workout.day])).toContainEqual([
            id,
            day,
          ]);
        }
      }
      return { log, records };
    } finally {
      await connection.close();
    }
  }

  it("A: a day sleeper's sessions are on get_day's days, and today's session is listed", async () => {
    const { log } = await checkParity(daySleeper(), {
      "w-0917-2100": "2026-09-17",
      "w-0915-2200": "2026-09-15",
    });
    expect(log.period.end_day).toBe("2026-09-17");
    expect(log.warnings).toEqual([]);
    expect(log.data_quality.sources.sleeps!.status).toBe("available");
  });

  it("B: a disrupted night places the long cycle and today's afternoon cycle as get_day does", async () => {
    await checkParity(disruptedNight(), {
      "w-0917-2115": "2026-09-17",
      "w-0916-1800": "2026-09-16",
    });
  });

  it("C: an owner-like account keeps its days (control)", async () => {
    await checkParity(control(), {
      "w-0917-2100": "2026-09-17",
      "w-0916-2130": "2026-09-16",
    });
  });

  it("warns when sleeps cannot be read and still lists today's session on today", async () => {
    const { log, records } = await checkParity(
      daySleeper(),
      // Without sleeps the 09-15 session falls back to the cycle-start estimate (the warning's case).
      { "w-0917-2100": "2026-09-17", "w-0915-2200": "2026-09-16" },
      { failures: [{ path: /^\/v2\/activity\/sleep/, error: new WhoopApiError(503, "x", {}) }] }
    );
    expect(log.warnings).toContain(
      "Sleep data could not be loaded (WHOOP API returned HTTP 503), so sessions after a daytime main sleep may be dated one day later than get_day shows."
    );
    expect(log.notes).toContain(
      "1 session in the WHOOP cycle still open would be dated after today because that cycle's main sleep was not loaded, so it counts toward today (2026-09-17)."
    );
    expect(log.workouts[0]!.flags).not.toContain("after_midnight_in_previous_cycle");
    expect(records.warnings as string[]).toContain(
      "Sleep data could not be loaded (WHOOP API returned HTTP 503), so sessions after a daytime main sleep may be dated one day later than get_day shows."
    );
  });
});
