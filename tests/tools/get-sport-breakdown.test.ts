/**
 * Tests for get_sport_breakdown (package P6, standard mode).
 *
 * Covers: the live-shaped 8-workout mix (few_sessions, weighted heart rate,
 * shares, time of day, the late-night walk on its cycle day, sessions per week
 * on a 3-day history), time-weighted pace, pending and low-recording sessions,
 * sport filters, the beats-per-km efficiency trend thresholds, time-of-day
 * boundaries, the absence of any intensity-model label, an after-midnight
 * session at a 30-day chunk boundary, truncation and no-data notes, source
 * failures, output size on stressUser and the MCP contract. Regression tests:
 * a day sleeper's session of the open cycle counts today (with and without
 * sleeps), split nights and daytime main sleeps placed like get_calendar, and
 * a long window reading sleeps only around the cycles whose day depends on
 * them with the same placement.
 */

import { describe, expect, it } from "vitest";
import { WhoopApiError } from "../../src/api/client.js";
import { HISTORY_CHUNK_MS } from "../../src/api/history.js";
import type { Cycle, ScoreState, Sleep, Workout } from "../../src/api/types.js";
import { localMidnightMs } from "../../src/tools/analytics-utils.js";
import { addDays } from "../../src/tools/day-model.js";
import {
  getSportBreakdown,
  sportBreakdownOutputSchema,
  timeOfDayBucket,
  type SportBreakdownInput,
  type SportBreakdownOutput,
} from "../../src/tools/get-sport-breakdown.js";
import {
  SLEEP_PLACEMENT_WARNING,
  TARGETED_SLEEPS_NOTE,
} from "../../src/tools/get-training-load.js";
import { MAX_TOOL_TEXT_CHARS, type ToolContext } from "../../src/tools/tool-definition.js";
import { assertNeutralText, connectServer } from "../helpers/contract.js";
import {
  createWhoopFixtureClient,
  type WhoopFixtureClient,
  type WhoopFixtureClientOptions,
} from "../helpers/whoop-fixture-client.js";
import { LIVE_SHAPED_IDS, liveShapedUser, matureUser, stressUser } from "../helpers/whoop-users.js";

const MINUTE_MS = 60_000;
const OFFSET = "+02:00";
const TODAY = "2026-09-16";

// ---------------------------------------------------------------------------
// Planned accounts
// ---------------------------------------------------------------------------

interface SessionPlan {
  day: string;
  /** Local start in minutes after midnight (may exceed 1440 for the next morning) */
  minute: number;
  minutes: number;
  sport: string;
  sportId?: number | null;
  hr?: number;
  maxHr?: number;
  strain?: number;
  kj?: number;
  fraction?: number;
  /** Zone 1-5 minutes; default all recorded minutes in zone 2 */
  zones?: [number, number, number, number, number];
  state?: ScoreState;
  km?: number | null;
  altitude?: number | null;
}

interface Account {
  cycles: Cycle[];
  workouts: Workout[];
  now: Date;
}

function localMs(day: string, minute: number, offset = OFFSET): number {
  return localMidnightMs(day, offset) + minute * MINUTE_MS;
}

const iso = (ms: number): string => new Date(ms).toISOString();

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
    sport_name: plan.sport,
    sport_id: plan.sportId === undefined ? 0 : plan.sportId,
    v1_id: null,
    score:
      state === "SCORED"
        ? {
            strain: plan.strain ?? 8,
            average_heart_rate: plan.hr ?? 130,
            max_heart_rate: plan.maxHr ?? 160,
            kilojoule: plan.kj ?? 800,
            percent_recorded: fraction,
            zone_durations: {
              zone_zero_milli: Math.max(
                0,
                recordedMs - zones.reduce((sum, value) => sum + value, 0)
              ),
              zone_one_milli: zones[0]!,
              zone_two_milli: zones[1]!,
              zone_three_milli: zones[2]!,
              zone_four_milli: zones[3]!,
              zone_five_milli: zones[4]!,
            },
            distance_meter: plan.km === undefined || plan.km === null ? null : plan.km * 1000,
            altitude_gain_meter: plan.altitude ?? null,
            altitude_change_meter: null,
          }
        : null,
  };
}

/** One cycle per day from firstDay (partial, starting at midnight) to lastDay (open) */
function account(options: {
  firstDay: string;
  lastDay: string;
  sessions: readonly SessionPlan[];
  offset?: string;
  now?: Date;
}): Account {
  const offset = options.offset ?? OFFSET;
  const cycles: Cycle[] = [];
  const days: string[] = [];
  for (let day = options.firstDay; day <= options.lastDay; day = addDays(day, 1)) days.push(day);
  const startOf = (index: number): number =>
    index === 0
      ? localMs(days[0]!, 0, offset)
      : localMs(addDays(days[index]!, -1), 23 * 60, offset);
  days.forEach((_, index) => {
    const startMs = startOf(index);
    const endMs = index === days.length - 1 ? null : startOf(index + 1);
    cycles.push({
      user_id: 1,
      created_at: iso(startMs + 8 * 3_600_000),
      updated_at: iso((endMs ?? startMs) + MINUTE_MS),
      score_state: "SCORED",
      start: iso(startMs),
      end: endMs === null ? null : iso(endMs),
      timezone_offset: offset,
      id: 5000 + index,
      score: { strain: 10, kilojoule: 8000, average_heart_rate: 70, max_heart_rate: 160 },
    });
  });
  return {
    cycles,
    workouts: options.sessions.map((plan, index) => workoutOf(plan, `s-${index}`, offset)),
    now: options.now ?? new Date(localMs(options.lastDay, 23 * 60, offset)),
  };
}

function contextFor(client: WhoopFixtureClient, now: Date): ToolContext {
  return { client, privacyMode: "standard", now: () => now, startedAtMs: Date.now() };
}

async function run(
  data: Account,
  args: SportBreakdownInput = {},
  extra: Partial<WhoopFixtureClientOptions> = {}
): Promise<SportBreakdownOutput> {
  const client = createWhoopFixtureClient({
    cycles: data.cycles,
    workouts: data.workouts,
    now: data.now,
    ...extra,
  });
  const output = await getSportBreakdown(args, contextFor(client, data.now));
  sportBreakdownOutputSchema.parse(output);
  assertNeutralText([output.notes, output.warnings]);
  return output;
}

function sport(output: SportBreakdownOutput, name: string): SportBreakdownOutput["sports"][number] {
  const entry = output.sports.find((candidate) => candidate.sport_name === name);
  if (!entry) throw new Error(`no sport ${name}`);
  return entry;
}

// ---------------------------------------------------------------------------
// Live-shaped account
// ---------------------------------------------------------------------------

describe("liveShapedUser", () => {
  const fixture = liveShapedUser();
  const data: Account = { cycles: fixture.cycles, workouts: fixture.workouts, now: fixture.now };

  it("groups the verified 8-workout mix and marks sports under 3 sessions", async () => {
    const output = await run(data);
    expect(output.status).toBe("available");
    expect(output.period).toMatchObject({ start_day: "2026-08-18", end_day: TODAY, days: 30 });
    const counts = Object.fromEntries(
      output.sports.map((entry) => [entry.sport_name, entry.sessions])
    );
    expect(counts).toEqual({ walking: 3, running: 2, weightlifting_msk: 2, padel: 1 });
    expect(sport(output, "walking").status).toBe("available");
    for (const name of ["running", "weightlifting_msk", "padel"]) {
      const entry = sport(output, name);
      expect(entry.status).toBe("few_sessions");
      expect(entry.duration_minutes.mean).toBeNull();
      expect(entry.duration_minutes.median).toBeNull();
      expect(entry.strain).toEqual({ mean: null, median: null, max: null });
      expect(entry.heart_rate.weighted_average).toBeNull();
      expect(entry.heart_rate.peak).toBeNull();
    }
    // sport_id 0 (running) survives.
    expect(sport(output, "running").sport_id).toBe(0);
    expect(sport(output, "walking").sport_id).toBe(63);

    // Heart rate weighted by recorded minutes.
    const walks = fixture.workouts.filter((workout) => workout.sport_name === "walking");
    const recorded = (workout: Workout): number => {
      const zones = workout.score!.zone_durations;
      return (
        zones.zone_zero_milli +
        zones.zone_one_milli +
        zones.zone_two_milli +
        zones.zone_three_milli +
        zones.zone_four_milli +
        zones.zone_five_milli
      );
    };
    const weighted =
      walks.reduce(
        (sum, workout) => sum + workout.score!.average_heart_rate * recorded(workout),
        0
      ) / walks.reduce((sum, workout) => sum + recorded(workout), 0);
    expect(sport(output, "walking").heart_rate.weighted_average).toBe(Math.round(weighted));
    expect(sport(output, "walking").heart_rate.peak).toBe(
      Math.max(...walks.map((workout) => workout.score!.max_heart_rate))
    );

    // Shares sum to 100.
    const sum = (key: "sessions_pct" | "minutes_pct" | "trimp_pct"): number =>
      output.overall.share_by_sport.reduce((total, entry) => total + (entry[key] ?? 0), 0);
    for (const key of ["sessions_pct", "minutes_pct", "trimp_pct"] as const) {
      expect(Math.abs(sum(key) - 100)).toBeLessThanOrEqual(0.1);
    }
    for (const entry of output.sports) {
      if (!entry.zone_share_pct) continue;
      const zones = Object.values(entry.zone_share_pct).reduce((total, value) => total + value, 0);
      expect(Math.abs(zones - 100)).toBeLessThanOrEqual(0.1);
    }
    const intensity = output.overall.intensity_distribution;
    expect(
      Math.abs(
        (intensity.low_pct ?? 0) + (intensity.moderate_pct ?? 0) + (intensity.high_pct ?? 0) - 100
      )
    ).toBeLessThanOrEqual(0.1);
    expect(intensity.basis).toBe("recorded minutes in WHOOP %max-HR zones 1-5 (zone 0 excluded)");

    expect(output.overall).toMatchObject({ sessions: 8, active_days: 3, worn_days: 3 });
    expect(output.overall.time_of_day).toEqual({ morning: 2, afternoon: 1, evening: 4, night: 1 });
    expect(output.notes.some((note) => note.includes("Weightlifting-type sessions make up"))).toBe(
      true
    );
  });

  it("places the late-night walk on its cycle day and has no sessions per week on 3 days", async () => {
    const output = await run(data);
    const walking = sport(output, "walking");
    expect(walking.first_day).toBe("2026-09-14");
    expect(walking.active_days).toBe(3);
    for (const entry of output.sports) expect(entry.sessions_per_week).toBeNull();
    expect(output.notes.some((note) => note.startsWith("sessions_per_week is null"))).toBe(true);
    const late = fixture.workouts.find(
      (workout) => workout.id === LIVE_SHAPED_IDS.workouts.lateWalk
    )!;
    expect(late.start.startsWith("2026-09-14T21:17")).toBe(true);
  });

  it("matches a sport filter case-insensitively and lists sports for an unknown one", async () => {
    const running = await run(data, { sport: "RUNNING" });
    expect(running.sports.map((entry) => entry.sport_name)).toEqual(["running"]);
    expect(running.overall.sessions).toBe(2);
    expect(running.filters).toEqual({ sport: "RUNNING", min_recorded_fraction: 0 });
    const rowing = await run(data, { sport: "rowing" });
    expect(rowing.status).toBe("no_workouts");
    expect(rowing.sports).toEqual([]);
    expect(rowing.notes).toContain(
      'No session of "rowing" in this window; sports present: padel, running, walking, weightlifting_msk.'
    );
  });

  it("validates through the MCP server in standard mode", async () => {
    const client = createWhoopFixtureClient({ ...fixture, now: fixture.now });
    const connection = await connectServer(client, {
      privacyMode: "standard",
      now: () => fixture.now,
    });
    try {
      const tool = connection.tools.find((entry) => entry.name === "get_sport_breakdown");
      expect(tool?.title).toBe("Sport breakdown");
      expect(tool?.annotations?.readOnlyHint).toBe(true);
      expect(tool?.description?.length ?? 0).toBeLessThanOrEqual(1000);
      const result = await connection.callTool("get_sport_breakdown", { days: 14 });
      expect(result.isError).toBe(false);
      expect(JSON.parse(result.text)).toEqual(result.structured);
      expect(result.text).not.toMatch(/polariz|pyramid|"pattern"/i);
      const invalid = await connection.callTool("get_sport_breakdown", { days: 6 });
      expect(invalid.isError).toBe(true);
    } finally {
      await connection.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

describe("per-sport statistics", () => {
  it("uses time-weighted pace, not the mean of session paces", async () => {
    const data = account({
      firstDay: "2026-08-20",
      lastDay: TODAY,
      sessions: [
        { day: "2026-09-01", minute: 420, minutes: 25, sport: "running", km: 5, altitude: 30 },
        { day: "2026-09-05", minute: 420, minutes: 60, sport: "running", km: 10, altitude: 50 },
        { day: "2026-09-09", minute: 420, minutes: 14, sport: "running", km: 2, altitude: null },
      ],
    });
    const output = await run(data);
    const gps = sport(output, "running").gps!;
    const meanOfPaces = (300 + 360 + 420) / 3;
    const timeWeighted = ((25 + 60 + 14) * 60) / 17;
    expect(gps.avg_pace_sec_per_km).toBe(Math.round(timeWeighted));
    expect(gps.avg_pace_sec_per_km).not.toBe(Math.round(meanOfPaces));
    expect(gps).toMatchObject({
      sessions: 3,
      suspect_sessions: 0,
      distance_km_total: 17,
      fastest_session_pace_sec_per_km: 300,
      altitude_gain_m_total: 80,
    });
    expect(gps.distance_km_mean).toBeCloseTo(17 / 3, 2);
    // 3 sessions over the 28 days from the first worn day: 0.75 per week, rounded half up.
    expect(sport(output, "running").sessions_per_week).toBe(0.8);
  });

  it("excludes pending sessions and keeps low-recording sessions out of heart-rate values only", async () => {
    const sessions: SessionPlan[] = [
      { day: "2026-09-02", minute: 600, minutes: 40, sport: "cycling", hr: 140, kj: 900 },
      { day: "2026-09-04", minute: 600, minutes: 50, sport: "cycling", hr: 150, kj: 1100 },
      {
        day: "2026-09-06",
        minute: 600,
        minutes: 60,
        sport: "cycling",
        hr: 120,
        kj: 700,
        fraction: 0.8,
      },
      { day: "2026-09-08", minute: 600, minutes: 45, sport: "cycling", state: "PENDING_SCORE" },
    ];
    const data = account({ firstDay: "2026-08-01", lastDay: TODAY, sessions });
    const output = await run(data);
    const cycling = sport(output, "cycling");
    expect(cycling.sessions).toBe(3);
    expect(cycling.duration_minutes.total).toBe(150);
    expect(cycling.kilojoule.total).toBe(2700);
    expect(cycling.excluded).toEqual({ not_scored: 1, low_recording: 0 });
    expect(cycling.low_recording_sessions).toBe(1);
    expect(cycling.heart_rate.sessions_used).toBe(2);
    expect(cycling.heart_rate.weighted_average).toBeNull();
    expect(cycling.trimp.sessions_used).toBe(2);
    // Zone 2 minutes of the two fully recorded sessions only.
    expect(cycling.trimp.total).toBe(2 * (40 + 50));
    expect(cycling.zone_minutes?.zone_2).toBe(90);
    expect(output.data_quality.sources.workouts!.exclusions.pending).toBe(1);
    expect(
      output.notes.some((note) => note.includes("recorded less than 90% heart-rate data"))
    ).toBe(true);

    const filtered = await run(data, { min_recorded_fraction: 0.85 });
    const strict = sport(filtered, "cycling");
    expect(strict.sessions).toBe(2);
    expect(strict.excluded).toEqual({ not_scored: 1, low_recording: 1 });
    expect(strict.low_recording_sessions).toBe(0);
  });

  it("reports the efficiency trend from 6 qualifying sessions over 14 days", async () => {
    // beats per km = HR × 30 minutes / 5 km = 6 × HR, falling 6 per session every 4 days.
    const runs = (count: number): SessionPlan[] =>
      Array.from({ length: count }, (_, index) => ({
        day: addDays("2026-08-15", index * 4),
        minute: 450,
        minutes: 30,
        sport: "running",
        hr: 150 - index,
        km: 5,
      }));
    const five = sport(
      await run(account({ firstDay: "2026-08-01", lastDay: TODAY, sessions: runs(5) }), {
        days: 60,
      }),
      "running"
    );
    expect(five.gps!.efficiency).toMatchObject({
      metric: "beats_per_km",
      better_when: "lower",
      qualifying_sessions: 5,
      latest: 6 * 146,
      median: 6 * 148,
      trend: { status: "insufficient_data", slope_per_week: null, change: null, confidence: null },
    });
    const eight = sport(
      await run(account({ firstDay: "2026-08-01", lastDay: TODAY, sessions: runs(8) }), {
        days: 60,
      }),
      "running"
    );
    expect(eight.gps!.efficiency.qualifying_sessions).toBe(8);
    expect(eight.gps!.efficiency.trend).toEqual({
      status: "available",
      slope_per_week: -10.5,
      change: "improving",
      confidence: "medium",
    });
    expect(eight.gps!.efficiency.latest).toBe(6 * 143);
  });

  it("buckets start hours at 05, 12, 17 and 22 local", async () => {
    expect([0, 4, 5, 11, 12, 16, 17, 21, 22, 23].map(timeOfDayBucket)).toEqual([
      "night",
      "night",
      "morning",
      "morning",
      "afternoon",
      "afternoon",
      "evening",
      "evening",
      "night",
      "night",
    ]);
    const minutes = [
      4 * 60 + 59,
      5 * 60,
      11 * 60 + 59,
      12 * 60,
      16 * 60 + 59,
      17 * 60,
      21 * 60 + 59,
    ];
    const data = account({
      firstDay: "2026-08-01",
      lastDay: TODAY,
      sessions: minutes.map((minute, index) => ({
        day: addDays("2026-09-01", index),
        minute,
        minutes: 20,
        sport: "walking",
      })),
    });
    const output = await run(data);
    expect(output.overall.time_of_day).toEqual({ morning: 2, afternoon: 2, evening: 2, night: 1 });
  });

  it("has no intensity-model label in the contract", () => {
    const intensity = sportBreakdownOutputSchema.shape.overall.shape.intensity_distribution;
    expect(Object.keys(intensity.shape).sort()).toEqual(
      ["basis", "high_pct", "low_pct", "minutes", "moderate_pct"].sort()
    );
    expect(JSON.stringify(sportBreakdownOutputSchema.shape)).not.toMatch(
      /pattern|polariz|pyramid/i
    );
  });
});

// ---------------------------------------------------------------------------
// Windows, failures and size
// ---------------------------------------------------------------------------

describe("windows and sources", () => {
  it("loads an after-midnight session of the last day across a 30-day chunk boundary", async () => {
    // UTC user: local midnight of the boundary day is a history chunk boundary.
    const boundaryMs =
      Math.floor(Date.parse("2026-08-20T00:00:00Z") / HISTORY_CHUNK_MS) * HISTORY_CHUNK_MS;
    const boundaryDay = new Date(boundaryMs).toISOString().slice(0, 10);
    const lastDay = addDays(boundaryDay, -1);
    const firstDay = addDays(lastDay, -6);
    const cycles: Cycle[] = [];
    let start = localMidnightMs(addDays(firstDay, -3), "Z") + 23 * 3_600_000;
    for (let index = 0; index < 12; index++) {
      const day = addDays(firstDay, index - 2);
      // The cycle after the last day starts at 01:30 (late sleep onset).
      const next =
        day === lastDay
          ? localMidnightMs(boundaryDay, "Z") + 90 * MINUTE_MS
          : localMidnightMs(day, "Z") + 23 * 3_600_000;
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
      { day: boundaryDay, minute: 30, minutes: 40, sport: "running", km: 7 },
      "after-midnight",
      "Z"
    );
    const now = new Date(localMidnightMs(addDays(boundaryDay, 3), "Z"));
    const output = await run({ cycles, workouts: [late], now }, { start: firstDay, days: 7 });
    expect(output.period).toMatchObject({ start_day: firstDay, end_day: lastDay });
    expect(sport(output, "running")).toMatchObject({ sessions: 1, first_day: lastDay });
    expect(output.overall.time_of_day.night).toBe(1);
  });

  it("notes a window without WHOOP data and one without workouts", async () => {
    const empty = await run({
      cycles: [],
      workouts: [],
      now: new Date("2026-09-16T20:00:00+02:00"),
    });
    expect(empty.status).toBe("no_workouts");
    expect(empty.overall).toMatchObject({ sessions: 0, worn_days: 0, trimp_total: 0 });
    expect(empty.notes).toContain("No WHOOP data for this window.");

    const worn = await run(account({ firstDay: "2026-09-01", lastDay: TODAY, sessions: [] }));
    expect(worn.status).toBe("no_workouts");
    expect(worn.overall.worn_days).toBe(16);
    expect(worn.notes).not.toContain("No WHOOP data for this window.");
  });

  it("notes truncated workout history", async () => {
    const sessions: SessionPlan[] = Array.from({ length: 120 }, (_, index) => ({
      day: addDays("2026-06-01", Math.floor(index / 1.2)),
      minute: 600,
      minutes: 30,
      sport: index % 2 === 0 ? "running" : "walking",
    }));
    const data = account({ firstDay: "2026-05-20", lastDay: TODAY, sessions });
    const output = await run(
      data,
      { days: 120 },
      {
        failures: [
          {
            path: /^\/v2\/activity\/workout\?start=2026-0[5-6]/,
            page: 2,
            error: new WhoopApiError(503, "Service Unavailable", {}),
          },
        ],
      }
    );
    expect(output.truncated).toBe(true);
    expect(
      output.notes.some((note) => note.startsWith("Workout history could not be read completely"))
    ).toBe(true);
  });

  it("reports unavailable when workouts fail and throws when both sources fail", async () => {
    const data = account({
      firstDay: "2026-09-01",
      lastDay: TODAY,
      sessions: [{ day: "2026-09-05", minute: 600, minutes: 30, sport: "running" }],
    });
    const workoutFailure = {
      path: /^\/v2\/activity\/workout/,
      error: new WhoopApiError(500, "Internal Server Error", {}),
    };
    const output = await run(data, {}, { failures: [workoutFailure] });
    expect(output.status).toBe("unavailable");
    expect(
      output.warnings.some((warning) => warning.startsWith("Workout data could not be loaded"))
    ).toBe(true);
    const noCycles = await run(
      data,
      {},
      {
        failures: [{ path: /^\/v2\/cycle\?start=/, error: new WhoopApiError(500, "Error", {}) }],
      }
    );
    expect(noCycles.status).toBe("available");
    expect(noCycles.overall.worn_days).toBeNull();
    const client = createWhoopFixtureClient({
      cycles: data.cycles,
      workouts: data.workouts,
      now: data.now,
      failures: [
        workoutFailure,
        { path: /^\/v2\/cycle\?start=/, error: new WhoopApiError(429, "Too Many Requests", {}) },
      ],
    });
    await expect(getSportBreakdown({}, contextFor(client, data.now))).rejects.toMatchObject({
      statusCode: 429,
    });
  });

  it("handles a start after today and a range expression", async () => {
    const data = account({ firstDay: "2026-09-01", lastDay: TODAY, sessions: [] });
    const future = await run(data, { start: "2026-09-20" });
    expect(future.status).toBe("no_workouts");
    expect(future.notes.some((note) => note.includes("is after today"))).toBe(true);
    const month = await run(data, { start: "2026-09" });
    expect(month.period).toMatchObject({ start_day: "2026-09-01", end_day: TODAY, days: 16 });
  });

  it("stays within the output limit on stressUser over 365 days", async () => {
    const fixture = stressUser();
    const client = createWhoopFixtureClient({ ...fixture, now: fixture.now });
    const connection = await connectServer(client, {
      privacyMode: "standard",
      now: () => fixture.now,
    });
    try {
      const result = await connection.callTool("get_sport_breakdown", { days: 365 });
      expect(result.isError).toBe(false);
      expect(result.text.length).toBeLessThanOrEqual(MAX_TOOL_TEXT_CHARS);
      const structured = result.structured as SportBreakdownOutput;
      expect(structured.sports.length).toBeGreaterThan(0);
      assertNeutralText([structured.notes, structured.warnings]);
    } finally {
      await connection.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Day placement like get_calendar (regression)
// ---------------------------------------------------------------------------

describe("day placement like get_calendar", () => {
  /** A scored main sleep of `cycleId` over [startMs, endMs) */
  function mainSleep(cycleId: number, startMs: number, endMs: number): Sleep {
    const inBed = endMs - startMs;
    const awake = Math.round(inBed * 0.1);
    const light = Math.round(inBed * 0.45);
    const deep = Math.round(inBed * 0.2);
    return {
      id: `00000000-0000-4000-8000-${String(cycleId).padStart(12, "0")}`,
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
          total_awake_time_milli: awake,
          total_no_data_time_milli: 0,
          total_light_sleep_time_milli: light,
          total_slow_wave_sleep_time_milli: deep,
          total_rem_sleep_time_milli: inBed - awake - light - deep,
          sleep_cycle_count: 4,
          disturbance_count: 8,
        },
        sleep_needed: {
          baseline_milli: 28_000_000,
          need_from_sleep_debt_milli: 0,
          need_from_recent_strain_milli: 0,
          need_from_recent_nap_milli: 0,
        },
        respiratory_rate: 15,
        sleep_performance_percentage: 80,
        sleep_consistency_percentage: 70,
        sleep_efficiency_percentage: 90,
      },
    };
  }

  /**
   * A day sleeper (+02:00): main sleeps 12:30-19:30 every day, so each cycle
   * starts 12:30 and belongs to the day its sleep ended; `dayCount` days up to
   * 09-17; running sessions on 09-15 22:00 and 09-17 21:00; now 09-17 23:30
   * local.
   */
  function daySleeper(dayCount = 6): Account & { sleeps: Sleep[] } {
    const days = Array.from({ length: dayCount }, (_, index) =>
      addDays("2026-09-17", index - (dayCount - 1))
    );
    const cycles: Cycle[] = [];
    const sleeps: Sleep[] = [];
    days.forEach((day, index) => {
      const startMs = localMs(day, 12 * 60 + 30);
      const endMs = index + 1 < days.length ? localMs(days[index + 1]!, 12 * 60 + 30) : null;
      const sleepEndMs = localMs(day, 19 * 60 + 30);
      cycles.push({
        id: 7000 + index,
        user_id: 1,
        created_at: iso(sleepEndMs + 10 * MINUTE_MS),
        updated_at: iso((endMs ?? sleepEndMs) + 10 * MINUTE_MS),
        start: iso(startMs),
        end: endMs === null ? null : iso(endMs),
        timezone_offset: OFFSET,
        score_state: "SCORED",
        score: { strain: 10, kilojoule: 8000, average_heart_rate: 70, max_heart_rate: 150 },
      });
      sleeps.push(mainSleep(7000 + index, startMs, sleepEndMs));
    });
    const workouts = [
      workoutOf({ day: "2026-09-15", minute: 22 * 60, minutes: 60, sport: "running" }, "w-0915"),
      workoutOf({ day: "2026-09-17", minute: 21 * 60, minutes: 60, sport: "running" }, "w-0917"),
    ];
    return { cycles, sleeps, workouts, now: new Date(localMs("2026-09-17", 23 * 60 + 30)) };
  }

  it("dates a day sleeper's sessions by the main sleep and counts today's open-cycle session", async () => {
    const data = daySleeper();
    const output = await getSportBreakdown(
      { days: 7 },
      contextFor(createWhoopFixtureClient({ ...data }), data.now)
    );
    sportBreakdownOutputSchema.parse(output);
    expect(output.period.end_day).toBe("2026-09-17");
    const running = sport(output, "running");
    expect(running.sessions).toBe(2);
    // get_calendar places the cycle that started 09-15 12:30 on 09-15 (its sleep ended 19:30).
    expect(running.first_day).toBe("2026-09-15");
    expect(running.last_day).toBe("2026-09-17");
    expect(output.warnings).not.toContain(SLEEP_PLACEMENT_WARNING);
    expect(output.data_quality.sources.sleeps!.status).toBe("available");
    expect(output.data_quality.limitations.join(" ")).toContain("as get_calendar places them");
    assertNeutralText([output.notes, output.warnings]);
  });

  it("still counts today's session on today, with a warning, when sleeps cannot be read", async () => {
    const data = daySleeper();
    const failing = createWhoopFixtureClient({
      ...data,
      failures: [
        {
          path: /^\/v2\/activity\/sleep/,
          error: new WhoopApiError(503, "Service Unavailable", {}),
        },
      ],
    });
    const output = await getSportBreakdown({ days: 7 }, contextFor(failing, data.now));
    sportBreakdownOutputSchema.parse(output);
    const running = sport(output, "running");
    // Without sleeps the open cycle counts toward 12 hours after its start
    // (tomorrow), but a session that started today is never placed after today.
    expect(running.sessions).toBe(2);
    expect(running.last_day).toBe("2026-09-17");
    expect(output.warnings).toContain(SLEEP_PLACEMENT_WARNING);
    expect(output.data_quality.sources.sleeps!.status).toBe("fetch_failed");
    assertNeutralText([output.notes, output.warnings]);
  });

  it("gives the same result when a long window reads sleeps only around the cycles whose day depends on them", async () => {
    // 120 days of history: 365 and 200 days both cover all of it, but only the
    // 365-day window is too long to read every sleep within the request budget.
    const fixture = matureUser({ days: 120, splitNightDays: [10, 40, 80, 100] });
    const runDays = async (days: number): Promise<SportBreakdownOutput> => {
      const client = createWhoopFixtureClient({ ...fixture, now: fixture.now });
      const output = await getSportBreakdown({ days }, contextFor(client, fixture.now));
      sportBreakdownOutputSchema.parse(output);
      return output;
    };
    const targeted = await runDays(365);
    const full = await runDays(200);
    expect(targeted.notes).toContain(TARGETED_SLEEPS_NOTE);
    expect(full.notes).not.toContain(TARGETED_SLEEPS_NOTE);
    expect(targeted.truncated).toBe(false);
    expect(targeted.data_quality.sources.sleeps!.status).toBe("available");
    expect(targeted.data_quality.sources.sleeps!.records_fetched).toBeLessThan(
      full.data_quality.sources.sleeps!.records_fetched
    );
    expect(targeted.sports).toEqual(full.sports);
    expect(targeted.overall).toEqual(full.overall);
    expect(targeted.warnings).toEqual(full.warnings);
    assertNeutralText([targeted.notes, targeted.warnings]);

    // A day sleeper whose every cycle depends on its main sleep: 120 days with
    // an evening session every 10 days, dated by the sleep in both windows.
    const sleeper = daySleeper(120);
    for (let index = 0; index < 110; index += 10) {
      const day = addDays("2026-09-17", index - 119);
      sleeper.workouts.push(
        workoutOf({ day, minute: 22 * 60, minutes: 45, sport: "cycling" }, `c-${day}`)
      );
    }
    const runSleeper = async (days: number): Promise<SportBreakdownOutput> => {
      const client = createWhoopFixtureClient({ ...sleeper });
      const output = await getSportBreakdown({ days }, contextFor(client, sleeper.now));
      sportBreakdownOutputSchema.parse(output);
      return output;
    };
    const sleeperTargeted = await runSleeper(365);
    const sleeperFull = await runSleeper(200);
    expect(sleeperTargeted.notes).toContain(TARGETED_SLEEPS_NOTE);
    expect(sport(sleeperFull, "cycling")).toMatchObject({
      sessions: 11,
      active_days: 11,
      first_day: addDays("2026-09-17", -119),
      last_day: addDays("2026-09-17", -19),
    });
    expect(sleeperTargeted.sports).toEqual(sleeperFull.sports);
    expect(sleeperTargeted.overall).toEqual(sleeperFull.overall);
  });
});
