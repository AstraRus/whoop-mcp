/**
 * Tests for get_personal_records (package P7, standard mode only).
 *
 * Covers: distance and pace tiers (5.0 / 6.0 / 10.2 km runs, the 5k tier
 * counting only sessions of at least 5 km, a single 10k session), few_sessions,
 * low-recording sessions (left out of heart-rate records, GPS distance kept),
 * implausible GPS speed, ties keeping the earlier session, zero values, the
 * recent_days boundary at local midnight +02:00, running with sport_id 0,
 * unscored sessions, the sport filter, the max heart rate check (true, false,
 * body failure), history completeness (older workouts, truncation, a new
 * account), the live-shaped and mature users, output size on stressUser and a
 * many-sport account, the MCP contract and absence in aggregate mode.
 */

import { describe, expect, it } from "vitest";
import { WhoopApiError } from "../../src/api/client.js";
import { MemoryCache } from "../../src/cache/memory-cache.js";
import type { BodyMeasurement, Cycle, ScoreState, Workout } from "../../src/api/types.js";
import { localMidnightMs } from "../../src/tools/analytics-utils.js";
import { addDays } from "../../src/tools/day-model.js";
import {
  FEW_SESSIONS_NOTE,
  getPersonalRecords,
  MAX_RECORD_SPORTS,
  personalRecordsInputSchema,
  personalRecordsOutputSchema,
  type PersonalRecordsInput,
  type PersonalRecordsOutput,
  type RecordMetric,
} from "../../src/tools/get-personal-records.js";
import { MAX_TOOL_TEXT_CHARS, type ToolContext } from "../../src/tools/tool-definition.js";
import { assertNeutralText, connectServer, listToolNames } from "../helpers/contract.js";
import {
  createWhoopFixtureClient,
  type WhoopFixtureClientOptions,
} from "../helpers/whoop-fixture-client.js";
import { LIVE_SHAPED_IDS, liveShapedUser, matureUser, stressUser } from "../helpers/whoop-users.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const OFFSET = "+02:00";
const TODAY = "2026-09-16";
const BODY: BodyMeasurement = { height_meter: 1.8, weight_kilogram: 75, max_heart_rate: 189 };

const iso = (ms: number): string => new Date(ms).toISOString();

type Options = WhoopFixtureClientOptions & { now: Date };

// ---------------------------------------------------------------------------
// Planned accounts
// ---------------------------------------------------------------------------

interface SessionPlan {
  day: string;
  /** Local start in minutes after midnight */
  minute?: number;
  minutes: number;
  sport?: string;
  sportId?: number | null;
  km?: number | null;
  altitude?: number | null;
  strain?: number;
  hr?: number;
  maxHr?: number;
  kj?: number;
  fraction?: number;
  /** Zone 1-5 minutes; default all recorded minutes in zone 3 */
  zones?: [number, number, number, number, number];
  state?: ScoreState;
}

function localMs(day: string, minute: number): number {
  return localMidnightMs(day, OFFSET) + minute * MINUTE_MS;
}

function workoutOf(plan: SessionPlan, id: string): Workout {
  const startMs = localMs(plan.day, plan.minute ?? 8 * 60);
  const durationMs = Math.round(plan.minutes * MINUTE_MS);
  const fraction = plan.fraction ?? 1;
  const recordedMs = Math.round(durationMs * fraction);
  const zones = (plan.zones ?? [0, 0, plan.minutes * fraction, 0, 0]).map((value) =>
    Math.round(value * MINUTE_MS)
  );
  const state = plan.state ?? "SCORED";
  const sport = plan.sport ?? "running";
  return {
    user_id: 1,
    created_at: iso(startMs + durationMs + MINUTE_MS),
    updated_at: iso(startMs + durationMs + MINUTE_MS),
    score_state: state,
    start: iso(startMs),
    end: iso(startMs + durationMs),
    timezone_offset: OFFSET,
    id,
    sport_name: sport,
    sport_id: plan.sportId === undefined ? (sport === "running" ? 0 : 63) : plan.sportId,
    v1_id: null,
    score:
      state === "SCORED"
        ? {
            strain: plan.strain ?? 10,
            average_heart_rate: plan.hr ?? 150,
            max_heart_rate: plan.maxHr ?? 175,
            kilojoule: plan.kj ?? 1000,
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
            altitude_gain_meter: plan.altitude ?? null,
            altitude_change_meter: null,
          }
        : null,
  };
}

/** One cycle per local day from local midnight to local midnight; the last is open */
function cyclesFor(firstDay: string, lastDay: string): Cycle[] {
  const cycles: Cycle[] = [];
  for (let day = firstDay, index = 0; day <= lastDay; day = addDays(day, 1), index++) {
    const startMs = localMidnightMs(day, OFFSET);
    const last = day === lastDay;
    cycles.push({
      user_id: 1,
      created_at: iso(startMs + 7 * HOUR_MS),
      updated_at: iso(startMs + 24 * HOUR_MS + MINUTE_MS),
      score_state: "SCORED",
      start: iso(startMs),
      end: last ? null : iso(startMs + 24 * HOUR_MS),
      timezone_offset: OFFSET,
      id: 20_000 + index,
      score: { strain: 12, kilojoule: 9000, average_heart_rate: 70, max_heart_rate: 170 },
    });
  }
  return cycles;
}

function planned(
  sessions: readonly SessionPlan[],
  extra: Omit<Partial<WhoopFixtureClientOptions>, "now"> = {}
): Options {
  return {
    cycles: cyclesFor("2026-08-01", TODAY),
    workouts: sessions.map((plan, index) => workoutOf(plan, `s-${index}`)),
    body: BODY,
    now: new Date(localMs(TODAY, 22 * 60)),
    ...extra,
  };
}

function contextFor(options: Options, historyCache?: MemoryCache): ToolContext {
  const client = createWhoopFixtureClient(options);
  return {
    client,
    privacyMode: "standard",
    now: () => options.now,
    startedAtMs: Date.now(),
    ...(historyCache ? { historyCache } : {}),
  };
}

async function run(
  options: Options,
  args: Partial<PersonalRecordsInput> = {},
  historyCache?: MemoryCache
): Promise<PersonalRecordsOutput> {
  const output = await getPersonalRecords(
    personalRecordsInputSchema.parse(args),
    contextFor(options, historyCache)
  );
  personalRecordsOutputSchema.parse(output);
  assertNeutralText([output.notes, output.warnings]);
  if (!output.period.history_complete) {
    expect(output.notes.join(" ")).not.toMatch(/all-time/i);
  }
  return output;
}

function sportOf(
  output: PersonalRecordsOutput,
  name: string
): PersonalRecordsOutput["sports"][number] {
  const entry = output.sports.find((sport) => sport.sport_name === name);
  if (!entry) throw new Error(`no sport ${name}`);
  return entry;
}

function recordOf(
  output: PersonalRecordsOutput,
  name: string,
  metric: RecordMetric
): PersonalRecordsOutput["sports"][number]["records"][number] | undefined {
  return sportOf(output, name).records.find((record) => record.metric === metric);
}

// ---------------------------------------------------------------------------
// Record logic
// ---------------------------------------------------------------------------

describe("distance and pace records", () => {
  // 5.0 km at 300 s/km, 4.9 km at 250 s/km, 6.0 km at 330 s/km, 10.2 km at 285 s/km
  const runs: SessionPlan[] = [
    { day: "2026-09-01", minutes: 25, km: 5.0, altitude: 40 },
    { day: "2026-09-03", minutes: (4.9 * 250) / 60, km: 4.9, altitude: 90 },
    { day: "2026-09-05", minutes: 33, km: 6.0, altitude: 0 },
    { day: "2026-09-10", minutes: 48.45, km: 10.2, altitude: 60 },
  ];

  it("walks sessions chronologically for the farthest distance and the pace tiers", async () => {
    const output = await run(planned(runs));
    const running = sportOf(output, "running");
    expect(running).toMatchObject({ sport_id: 0, sessions_considered: 4, status: "available" });

    expect(recordOf(output, "running", "farthest_distance")).toMatchObject({
      value: 10.2,
      unit: "km",
      workout_id: "s-3",
      date: "2026-09-10",
      start_local: "2026-09-10T08:00:00.000+02:00",
      previous_best: { value: 6, date: "2026-09-05" },
      improvement_pct: 70,
    });
    // Every session of at least 1 km: the 4.9 km session is the fastest.
    expect(recordOf(output, "running", "fastest_pace_1k")).toMatchObject({
      value: 250,
      unit: "sec_per_km",
      workout_id: "s-1",
      previous_best: { value: 300, date: "2026-09-01" },
      improvement_pct: 16.7,
      label: "fastest average pace over a session of at least 1 km",
    });
    // Only sessions of at least 5 km (5.0 counts, 4.9 does not).
    expect(recordOf(output, "running", "fastest_pace_5k")).toMatchObject({
      value: 285,
      workout_id: "s-3",
      previous_best: { value: 300, date: "2026-09-01" },
      improvement_pct: 5,
    });
    // A single 10 km session: no previous best.
    expect(recordOf(output, "running", "fastest_pace_10k")).toMatchObject({
      value: 285,
      workout_id: "s-3",
      previous_best: null,
      improvement_pct: null,
    });
    expect(recordOf(output, "running", "fastest_pace_half_marathon")).toBeUndefined();
    expect(recordOf(output, "running", "fastest_pace_marathon")).toBeUndefined();
    expect(recordOf(output, "running", "most_elevation_gain")).toMatchObject({
      value: 90,
      workout_id: "s-1",
      previous_best: { value: 40 },
    });
    expect(output.notes.join(" ")).toMatch(/not split times/);
  });

  it("lists records without previous bests for a sport with two sessions", async () => {
    const output = await run(planned(runs.slice(2)));
    const running = sportOf(output, "running");
    expect(running.status).toBe("few_sessions");
    expect(running.records.length).toBeGreaterThan(0);
    for (const record of running.records) {
      expect(record.previous_best).toBeNull();
      expect(record.improvement_pct).toBeNull();
    }
    expect(output.notes.join(" ")).toContain(FEW_SESSIONS_NOTE);
  });

  it("leaves a low-recording session out of heart-rate records but keeps its GPS distance", async () => {
    const output = await run(
      planned([
        { day: "2026-09-02", minutes: 30, km: 5, strain: 10, maxHr: 180 },
        { day: "2026-09-04", minutes: 70, km: 12, strain: 15, maxHr: 195, fraction: 0.8 },
        { day: "2026-09-06", minutes: 36, km: 6, strain: 8, maxHr: 170 },
      ])
    );
    expect(recordOf(output, "running", "highest_strain")).toMatchObject({
      value: 10,
      workout_id: "s-0",
    });
    expect(recordOf(output, "running", "longest_duration")).toMatchObject({
      value: 36,
      workout_id: "s-2",
    });
    expect(recordOf(output, "running", "highest_workout_max_hr")).toMatchObject({ value: 180 });
    expect(recordOf(output, "running", "farthest_distance")).toMatchObject({
      value: 12,
      workout_id: "s-1",
      previous_best: { value: 5 },
    });
    expect(sportOf(output, "running").excluded).toEqual({
      not_scored: 0,
      low_recording: 1,
      gps_suspect: 0,
    });
    expect(output.max_hr_check.highest_workout_max_hr).toBe(180);
    expect(output.notes.join(" ")).toMatch(
      /1 scored session recorded heart rate for less than 90%/
    );
  });

  it("excludes and counts a session with an implausible 35 m/s GPS speed", async () => {
    const output = await run(
      planned([
        { day: "2026-09-02", minutes: 30, km: 5 },
        // 10 km in 285 s is about 35 m/s.
        { day: "2026-09-04", minutes: 4.75, km: 10, strain: 14 },
        { day: "2026-09-06", minutes: 36, km: 6 },
      ])
    );
    expect(recordOf(output, "running", "farthest_distance")).toMatchObject({
      value: 6,
      workout_id: "s-2",
    });
    expect(recordOf(output, "running", "fastest_pace_1k")!.workout_id).not.toBe("s-1");
    // Its heart-rate data still counts.
    expect(recordOf(output, "running", "highest_strain")).toMatchObject({ workout_id: "s-1" });
    expect(sportOf(output, "running").excluded.gps_suspect).toBe(1);
    expect(output.notes.join(" ")).toMatch(/implausible GPS speed/);
  });

  it("keeps the earlier session on ties and sets no record from zero values", async () => {
    const output = await run(
      planned([
        { day: "2026-09-02", minutes: 40, maxHr: 185, sport: "walking", km: null },
        { day: "2026-09-04", minutes: 40, maxHr: 185, sport: "walking", km: null },
        { day: "2026-09-06", minutes: 30, maxHr: 170, sport: "walking", km: null },
      ])
    );
    expect(recordOf(output, "walking", "highest_workout_max_hr")).toMatchObject({
      workout_id: "s-0",
      previous_best: null,
    });
    expect(recordOf(output, "walking", "longest_duration")).toMatchObject({ workout_id: "s-0" });
    // All minutes in zone 3: no zone 4-5 minutes, so no high-intensity record; no GPS records.
    expect(recordOf(output, "walking", "most_high_intensity_minutes")).toBeUndefined();
    expect(recordOf(output, "walking", "farthest_distance")).toBeUndefined();
  });

  /** No record value or previous best shows as 0 anywhere in the output */
  function expectNoZeroValues(output: PersonalRecordsOutput): void {
    const all = [...output.sports.flatMap((sport) => sport.records), ...output.recent_records];
    for (const record of all) {
      expect(record.value, record.metric).not.toBe(0);
      expect(record.previous_best?.value, record.metric).not.toBe(0);
    }
  }

  it("sets no high-intensity record from one second in zone 4 (shown as 0.0 minutes)", async () => {
    const output = await run(
      planned([
        {
          day: "2026-09-15",
          minutes: 65,
          sport: "weightlifting_msk",
          km: null,
          zones: [1, 20, 44, 1000 / MINUTE_MS, 0],
        },
      ])
    );
    expect(recordOf(output, "weightlifting_msk", "most_high_intensity_minutes")).toBeUndefined();
    expect(output.recent_records.map((record) => record.metric)).not.toContain(
      "most_high_intensity_minutes"
    );
    expect(recordOf(output, "weightlifting_msk", "longest_duration")).toBeDefined();
    expectNoZeroValues(output);
  });

  it("gives no previous best of 0 when an earlier session rounds to 0 minutes", async () => {
    const zones = (ms: number): [number, number, number, number, number] => [
      0,
      10,
      20,
      ms / MINUTE_MS,
      0,
    ];
    const output = await run(
      planned([
        {
          day: "2026-09-10",
          minutes: 60,
          sport: "weightlifting_msk",
          km: null,
          zones: zones(1000),
        },
        {
          day: "2026-09-12",
          minutes: 60,
          sport: "weightlifting_msk",
          km: null,
          zones: zones(90_000),
        },
        {
          day: "2026-09-14",
          minutes: 60,
          sport: "weightlifting_msk",
          km: null,
          zones: zones(36_000),
        },
      ])
    );
    expect(sportOf(output, "weightlifting_msk").status).toBe("available");
    expect(recordOf(output, "weightlifting_msk", "most_high_intensity_minutes")).toMatchObject({
      workout_id: "s-1",
      value: 1.5,
      previous_best: null,
      improvement_pct: null,
    });
    expectNoZeroValues(output);
  });

  it("sets no elevation record from 0.4 m (shown as 0 m)", async () => {
    const output = await run(
      planned([
        { day: "2026-09-10", minutes: 30, km: 5, altitude: 0.4 },
        { day: "2026-09-12", minutes: 31, km: 5.2, altitude: 0.4 },
        { day: "2026-09-14", minutes: 29, km: 4.9, altitude: 0.4 },
      ])
    );
    expect(recordOf(output, "running", "most_elevation_gain")).toBeUndefined();
    expect(recordOf(output, "running", "farthest_distance")).toBeDefined();
    expectNoZeroValues(output);
  });

  it("computes improvement_pct from the values as shown", async () => {
    // 10.004 then 10.255 km: shown 10 and 10.26, so 2.6 % (the unrounded values give 2.5 %).
    const output = await run(
      planned([
        { day: "2026-09-10", minutes: 60, km: 10.004 },
        { day: "2026-09-12", minutes: 60, km: 9 },
        { day: "2026-09-14", minutes: 60, km: 10.255 },
      ])
    );
    const record = recordOf(output, "running", "farthest_distance")!;
    expect(record).toMatchObject({ value: 10.26, previous_best: { value: 10 } });
    expect(record.improvement_pct).toBe(2.6);
  });

  it("groups running with sport_id 0 and counts unscored sessions", async () => {
    const output = await run(
      planned([
        { day: "2026-09-02", minutes: 30, km: 5 },
        { day: "2026-09-03", minutes: 60, sport: "cycling", sportId: 1, km: 25 },
        { day: "2026-09-04", minutes: 30, km: 5.5 },
        { day: "2026-09-05", minutes: 30, km: 6, state: "PENDING_SCORE" },
        { day: "2026-09-06", minutes: 30, km: 5.2 },
      ])
    );
    expect(output.sports.map((sport) => [sport.sport_name, sport.sport_id])).toEqual([
      ["running", 0],
      ["cycling", 1],
    ]);
    expect(sportOf(output, "running")).toMatchObject({
      sessions_considered: 3,
      status: "available",
      excluded: { not_scored: 1, low_recording: 0, gps_suspect: 0 },
    });
    expect(recordOf(output, "running", "farthest_distance")!.value).toBe(5.5);
    expect(output.notes.join(" ")).toMatch(/1 session is not scored by WHOOP/);
  });

  it("filters by sport case-insensitively and lists the sports present for an unknown one", async () => {
    const sessions: SessionPlan[] = [
      { day: "2026-09-02", minutes: 30, km: 5 },
      { day: "2026-09-03", minutes: 60, sport: "cycling", sportId: 1, km: 25 },
    ];
    const filtered = await run(planned(sessions), { sport: "Cycling" });
    expect(filtered.sports.map((sport) => sport.sport_name)).toEqual(["cycling"]);
    const unknown = await run(planned(sessions), { sport: "rowing" });
    expect(unknown.sports).toEqual([]);
    expect(unknown.notes.join(" ")).toMatch(/"rowing".*cycling, running/);
  });
});

describe("recent records", () => {
  it("marks records from the last recent_days local days, split at local midnight +02:00", async () => {
    const output = await run(
      planned([
        { day: "2026-09-01", minutes: 40, km: 8, strain: 9 },
        // 23:30-23:55 local on 09-09 (21:30Z): outside the last 7 days.
        { day: "2026-09-09", minute: 23 * 60 + 30, minutes: 25, km: 12, strain: 5 },
        // 00:01 local on 09-10 (22:01Z on 09-09, the same UTC date): inside.
        { day: "2026-09-10", minute: 1, minutes: 30, km: 5, strain: 15 },
      ]),
      { recent_days: 7 }
    );
    expect(recordOf(output, "running", "farthest_distance")).toMatchObject({
      workout_id: "s-1",
      date: "2026-09-09",
      set_within_recent_days: false,
    });
    expect(recordOf(output, "running", "highest_strain")).toMatchObject({
      workout_id: "s-2",
      date: "2026-09-10",
      set_within_recent_days: true,
    });
    expect(output.recent_records.every((record) => record.date >= "2026-09-10")).toBe(true);
    expect(output.recent_records.some((record) => record.metric === "highest_strain")).toBe(true);
    expect(output.recent_records.some((record) => record.metric === "farthest_distance")).toBe(
      false
    );
    expect(output.recent_records[0]).toMatchObject({ sport_name: "running" });

    const wider = await run(
      planned([
        { day: "2026-09-01", minutes: 40, km: 8, strain: 9 },
        { day: "2026-09-09", minute: 23 * 60 + 30, minutes: 25, km: 12, strain: 5 },
        { day: "2026-09-10", minute: 1, minutes: 30, km: 5, strain: 15 },
      ]),
      { recent_days: 8 }
    );
    expect(recordOf(wider, "running", "farthest_distance")!.set_within_recent_days).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Max heart rate check
// ---------------------------------------------------------------------------

describe("max_hr_check", () => {
  const sessions: SessionPlan[] = [
    { day: "2026-09-02", minutes: 30, maxHr: 176 },
    { day: "2026-09-04", minutes: 30, maxHr: 192 },
    { day: "2026-09-06", minutes: 30, maxHr: 199, fraction: 0.5 },
  ];

  it("reports a workout max above the body max", async () => {
    const output = await run(planned(sessions));
    expect(output.max_hr_check).toEqual({
      body_max_heart_rate: 189,
      highest_workout_max_hr: 192,
      workout_id: "s-1",
      exceeds_body_max: true,
    });
    expect(output.notes.join(" ")).toMatch(/above the current maximum heart rate/);
    expect(output.notes.join(" ")).toMatch(/body_max_heart_rate is only the current value/);
  });

  it("reports false when the body max is higher", async () => {
    const output = await run(planned(sessions, { body: { ...BODY, max_heart_rate: 200 } }));
    expect(output.max_hr_check.exceeds_body_max).toBe(false);
  });

  it("reports null with a warning when the body measurement fails", async () => {
    const output = await run(
      planned(sessions, {
        failures: [
          { path: /^\/v2\/user\/measurement\/body/, error: new WhoopApiError(500, "x", {}) },
        ],
      })
    );
    expect(output.max_hr_check).toEqual({
      body_max_heart_rate: null,
      highest_workout_max_hr: 192,
      workout_id: "s-1",
      exceeds_body_max: null,
    });
    expect(output.warnings.join(" ")).toMatch(
      /body measurement could not be read \(WHOOP API returned HTTP 500\)/
    );
    expect(output.data_quality.sources.body_measurement!.status).toBe("fetch_failed");
  });
});

// ---------------------------------------------------------------------------
// History completeness
// ---------------------------------------------------------------------------

describe("history completeness", () => {
  it("is complete for a new account and says so", async () => {
    const fixture = liveShapedUser();
    const output = await run({ ...fixture, now: fixture.now }, { days: 1095 });
    expect(output.period).toEqual({
      start_day: "2023-09-18",
      end_day: TODAY,
      days: 1095,
      history_complete: true,
    });
    expect(output.truncated).toBe(false);
    expect(output.notes.join(" ")).toMatch(/all-time/);
    expect(output.data_quality.sources.older_workouts_probe!.status).toBe("missing");
  });

  it("is not complete when WHOOP has older workouts", async () => {
    const output = await run(
      planned(
        [
          { day: addDays(TODAY, -400), minutes: 30, km: 5 },
          { day: "2026-09-02", minutes: 30, km: 6 },
        ],
        { cycles: cyclesFor(addDays(TODAY, -410), TODAY) }
      ),
      { days: 365 }
    );
    expect(output.period.history_complete).toBe(false);
    expect(output.period.start_day).toBe("2025-09-17");
    expect(sportOf(output, "running").sessions_considered).toBe(1);
    expect(output.notes.join(" ")).toMatch(/WHOOP has workouts before 2025-09-17/);
  });

  it("counts a loaded session placed before the period as older history", async () => {
    // 00:30 local on the first day, inside the previous day's cycle (onset 01:00).
    const firstDay = addDays(TODAY, -29);
    const cycles = cyclesFor(addDays(firstDay, -3), TODAY).map((cycle): Cycle => {
      if (cycle.start === iso(localMidnightMs(firstDay, OFFSET))) {
        return { ...cycle, start: iso(localMs(firstDay, 60)) };
      }
      if (cycle.end === iso(localMidnightMs(firstDay, OFFSET))) {
        return { ...cycle, end: iso(localMs(firstDay, 60)) };
      }
      return cycle;
    });
    const output = await run(
      {
        ...planned([
          { day: firstDay, minute: 30, minutes: 20, km: 4 },
          { day: "2026-09-10", minutes: 30, km: 6 },
        ]),
        cycles,
      },
      { days: 30 }
    );
    expect(output.period.start_day).toBe(firstDay);
    expect(sportOf(output, "running").sessions_considered).toBe(1);
    expect(output.period.history_complete).toBe(false);
    expect(output.data_quality.sources.workouts!.exclusions.outside_window).toBe(1);
  });

  it("does not call the records all-time when a loaded session falls after today", async () => {
    // Strap off from 22:00 local; a session recorded in +14:00 starts on 09-17 there.
    const cycles = cyclesFor("2026-08-01", TODAY).map(
      (cycle): Cycle =>
        cycle.end === null ? { ...cycle, end: iso(localMs(TODAY, 22 * 60)) } : cycle
    );
    const travel: Workout = {
      ...workoutOf({ day: "2026-09-12", minutes: 20, km: 3 }, "travel"),
      start: "2026-09-16T21:00:00.000Z",
      end: "2026-09-16T21:20:00.000Z",
      created_at: "2026-09-16T21:21:00.000Z",
      updated_at: "2026-09-16T21:21:00.000Z",
      timezone_offset: "+14:00",
    };
    const options = planned([{ day: "2026-09-10", minutes: 30, km: 5 }], { cycles });
    const output = await run(
      {
        ...options,
        workouts: [travel, ...options.workouts!],
        now: new Date("2026-09-16T21:30:00.000Z"),
      },
      { days: 365 }
    );
    expect(output.data_quality.sources.workouts!.exclusions.outside_window).toBe(1);
    expect(output.period.history_complete).toBe(false);
    expect(output.notes.join(" ")).not.toMatch(/all-time/i);
    expect(output.notes).toContain(
      "Some loaded sessions count toward a day after 2026-09-16, outside this period: the records are the bests among the sessions placed on 2025-09-17 to 2026-09-16."
    );
  });

  it("is not complete when the history was truncated, and a repeat continues from the cache", async () => {
    const fixture = matureUser({ days: 120 });
    const cache = new MemoryCache({ maxEntries: 500 });
    const failing: Options = {
      ...fixture,
      now: fixture.now,
      failures: [
        {
          path: /^\/v2\/activity\/workout\?start=/,
          page: 2,
          times: 1,
          error: new WhoopApiError(500, "x", {}),
        },
      ],
    };
    const first = await run(failing, {}, cache);
    expect(first.truncated).toBe(true);
    expect(first.period.history_complete).toBe(false);
    expect(first.notes.join(" ")).toMatch(/Repeating the request continues loading from the cache/);

    const second = await run({ ...fixture, now: fixture.now }, {}, cache);
    expect(second.truncated).toBe(false);
    expect(second.period.history_complete).toBe(true);
  });

  it("does not claim completeness when the probe fails", async () => {
    const output = await run(
      planned([{ day: "2026-09-02", minutes: 30, km: 5 }], {
        failures: [
          {
            path: /^\/v2\/activity\/workout\?end=/,
            error: new WhoopApiError(503, "x", {}),
          },
        ],
      })
    );
    expect(output.period.history_complete).toBe(false);
    expect(output.warnings.join(" ")).toMatch(/could not be read \(WHOOP API returned HTTP 503\)/);
  });

  it("throws the WHOOP error when the workout history cannot be read", async () => {
    await expect(
      getPersonalRecords(
        {},
        contextFor(
          planned([{ day: "2026-09-02", minutes: 30 }], {
            failures: [
              { path: /^\/v2\/activity\/workout/, error: new WhoopApiError(401, "x", {}) },
            ],
          })
        )
      )
    ).rejects.toMatchObject({ statusCode: 401 });
  });
});

// ---------------------------------------------------------------------------
// Users, size and contract
// ---------------------------------------------------------------------------

describe("fixture users", () => {
  it("lists the live-shaped user's records with few_sessions sports", async () => {
    const fixture = liveShapedUser();
    const output = await run({ ...fixture, now: fixture.now });
    expect(
      output.sports.map((sport) => [sport.sport_name, sport.sessions_considered, sport.status])
    ).toEqual([
      ["walking", 3, "available"],
      ["running", 2, "few_sessions"],
      ["weightlifting_msk", 2, "few_sessions"],
      ["padel", 1, "few_sessions"],
    ]);
    expect(recordOf(output, "running", "farthest_distance")).toMatchObject({
      workout_id: LIVE_SHAPED_IDS.workouts.eveningRun,
      value: 8.1,
      previous_best: null,
    });
    expect(recordOf(output, "running", "fastest_pace_5k")).toBeDefined();
    expect(recordOf(output, "walking", "farthest_distance")).toBeUndefined();
    // Everything happened in the last three days.
    expect(
      output.sports.every((sport) => sport.records.every((r) => r.set_within_recent_days))
    ).toBe(true);
    expect(output.max_hr_check).toMatchObject({
      body_max_heart_rate: 189,
      exceeds_body_max: false,
    });
    expect(output.notes.join(" ")).toMatch(/strength sessions \(weightlifting_msk\)/);
    expect(output.data_quality.method_version).toBe("personal-records-1");
  });

  it("finds improvements in a mature user's history", async () => {
    const fixture = matureUser({ days: 120 });
    const output = await run({ ...fixture, now: fixture.now }, { recent_days: 60 });
    const running = sportOf(output, "running");
    expect(running.status).toBe("available");
    const improved = running.records.filter((record) => record.previous_best !== null);
    expect(improved.length).toBeGreaterThan(0);
    for (const record of improved) {
      expect(record.improvement_pct).not.toBeNull();
      expect(record.improvement_pct!).toBeGreaterThanOrEqual(0);
      expect(record.previous_best!.date <= record.date).toBe(true);
    }
    expect(output.period.history_complete).toBe(true);
  });

  it("stays within MAX_TOOL_TEXT_CHARS at maximum arguments on stressUser", async () => {
    const fixture = stressUser();
    const client = createWhoopFixtureClient({ ...fixture, now: fixture.now });
    const historyCache = new MemoryCache({ maxEntries: 500 });
    const connection = await connectServer(client, { now: () => fixture.now, historyCache });
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await connection.callTool("get_personal_records", {
          days: 1095,
          recent_days: 60,
        });
        expect(result.isError).toBe(false);
        expect(result.text.length).toBeLessThan(MAX_TOOL_TEXT_CHARS);
        const output = personalRecordsOutputSchema.parse(result.structured);
        assertNeutralText([output.notes, output.warnings]);
        if (attempt === 1) expect(output.truncated).toBe(false);
      }
    } finally {
      await connection.close();
    }
  });

  it("caps the sports listed and stays within the size limit with many GPS sports", async () => {
    const sessions: SessionPlan[] = [];
    for (let sport = 0; sport < 20; sport++) {
      for (let index = 0; index < 3; index++) {
        sessions.push({
          day: addDays("2026-09-01", index * 5),
          minute: 6 * 60 + sport * 20,
          minutes: 200 + index * 10 + sport,
          sport: `endurance_sport_with_a_long_name_${sport}`,
          sportId: 500 + sport,
          km: 43 + index + (sport % 5),
          altitude: 100 + index,
          zones: [10, 20, 60, 60, 50],
        });
      }
    }
    const fixture = planned(sessions);
    const client = createWhoopFixtureClient(fixture);
    const connection = await connectServer(client, { now: () => fixture.now });
    try {
      const result = await connection.callTool("get_personal_records", { recent_days: 60 });
      expect(result.isError).toBe(false);
      expect(result.text.length).toBeLessThan(MAX_TOOL_TEXT_CHARS);
      const output = personalRecordsOutputSchema.parse(result.structured);
      expect(output.sports).toHaveLength(MAX_RECORD_SPORTS);
      expect(output.sports[0]!.records).toHaveLength(13);
      expect(output.output_capped).toBe(true);
      expect(output.recent_records.length).toBeLessThanOrEqual(40);
      expect(output.notes.join(" ")).toMatch(/20 sports have sessions/);
    } finally {
      await connection.close();
    }
  });
});

describe("contract", () => {
  it("is listed with its contract in standard mode", async () => {
    const fixture = liveShapedUser();
    const client = createWhoopFixtureClient({ ...fixture, now: fixture.now });
    const connection = await connectServer(client, { now: () => fixture.now });
    try {
      const tool = connection.tools.find((entry) => entry.name === "get_personal_records")!;
      expect(tool.title).toBe("Personal records");
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.description!.length).toBeLessThanOrEqual(1000);
      expect(tool.description).not.toMatch(/all-time/i);
      const result = await connection.callTool("get_personal_records", { sport: "running" });
      expect(result.isError).toBe(false);
      expect(personalRecordsOutputSchema.parse(result.structured).sports).toHaveLength(1);
      expect((await connection.callTool("get_personal_records", { days: 29 })).isError).toBe(true);
      expect((await connection.callTool("get_personal_records", { recent_days: 61 })).isError).toBe(
        true
      );
    } finally {
      await connection.close();
    }
  });

  it("is absent in aggregate mode", async () => {
    expect(await listToolNames("standard")).toContain("get_personal_records");
    expect(await listToolNames("aggregate")).not.toContain("get_personal_records");
  });
});
