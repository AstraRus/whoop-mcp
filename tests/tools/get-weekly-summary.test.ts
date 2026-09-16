/**
 * Tests for get_weekly_summary tool.
 *
 * Fixtures are live-shaped: WHOOP returns records newest first, a cycle
 * starts at the evening sleep onset, the user is at +02:00, the current cycle
 * has end:null, next_token is null on the last page, and a new user's
 * recoveries are calibrating with only 2-3 days of history.
 *
 * Verifies that the weekly summary:
 * - Covers the local Monday-to-Sunday week containing week_start (snapped)
 * - Accepts date-only, date-time and relative week_start values
 * - Counts each record in exactly one week by its local day
 * - Returns null (never 0) for averages it cannot compute, with notes, and
 *   null workout totals for a week with no WHOOP data at all
 * - Uses hours asleep for sleep and skips null percentages
 * - Excludes the in-progress cycle from strain
 * - Computes the recovery trend oldest first, only from 4+ points
 * - Flags calibrating recoveries and pagination truncation
 * - Handles partial failures; rethrows WHOOP errors when all 4 endpoints fail
 */

import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { WhoopClient } from "../../src/api/client.js";
import { WhoopApiError } from "../../src/api/client.js";
import { createWhoopServer } from "../../src/server.js";
import { getWeeklySummary } from "../../src/tools/get-weekly-summary.js";

// ---------------------------------------------------------------------------
// Live-shaped fake WHOOP API
// ---------------------------------------------------------------------------

type WhoopRecord = Record<string, unknown>;
type Kind = "recovery" | "sleep" | "workout" | "cycle";
type FakeData = Record<Kind, WhoopRecord[]>;

interface DaySpec {
  /** Local (+02:00) day the cycle covers / the sleep ends */
  day: string;
  recovery?: number;
  hrv?: number;
  rhr?: number;
  strain?: number;
  performance?: number | null;
  efficiency?: number | null;
  calibrating?: boolean;
}

const NOW = new Date("2026-09-16T12:00:00.000Z"); // Wednesday 14:00 local (+02:00)
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function shiftDay(day: string, count: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + count * DAY_MS).toISOString().slice(0, 10);
}

/** A local wall-clock time (e.g. "23:00") on a day, as a UTC timestamp for a ±HH:MM offset */
function utcAt(day: string, time: string, offset: string): string {
  const sign = offset.startsWith("-") ? -1 : 1;
  const minutes = sign * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6)));
  return new Date(Date.parse(`${day}T${time}:00.000Z`) - minutes * 60_000).toISOString();
}

/**
 * One entry per local day (ascending). Bedtime is 23:00 local the evening
 * before, wake-up 07:00 local (8h in bed, 7h asleep); the newest cycle is open
 * unless openLatest is false. Local times use `offset` (default +02:00).
 * Returned arrays are newest first, like WHOOP.
 */
function history(
  days: DaySpec[],
  options: { openLatest?: boolean; offset?: string } = {}
): FakeData {
  const openLatest = options.openLatest ?? true;
  const offset = options.offset ?? "+02:00";
  const data: FakeData = { recovery: [], sleep: [], workout: [], cycle: [] };
  days.forEach((spec, index) => {
    const id = index + 1;
    const sleepStart = utcAt(shiftDay(spec.day, -1), "23:00", offset);
    const sleepEnd = utcAt(spec.day, "07:00", offset);
    const next = days[index + 1];
    const cycleEnd = next
      ? utcAt(shiftDay(next.day, -1), "23:00", offset)
      : openLatest
        ? null
        : utcAt(spec.day, "23:00", offset);
    const sleepId = `sleep-${spec.day}`;
    data.sleep.push({
      id: sleepId,
      cycle_id: id,
      v1_id: null,
      user_id: 1,
      created_at: sleepEnd,
      updated_at: sleepEnd,
      start: sleepStart,
      end: sleepEnd,
      timezone_offset: offset,
      nap: false,
      score_state: "SCORED",
      score: {
        stage_summary: {
          total_in_bed_time_milli: 8 * HOUR_MS,
          total_awake_time_milli: HOUR_MS,
          total_no_data_time_milli: 0,
          total_light_sleep_time_milli: 3.5 * HOUR_MS,
          total_slow_wave_sleep_time_milli: 1.5 * HOUR_MS,
          total_rem_sleep_time_milli: 2 * HOUR_MS,
          sleep_cycle_count: 4,
          disturbance_count: 10,
        },
        sleep_needed: {
          baseline_milli: 8 * HOUR_MS,
          need_from_sleep_debt_milli: 0,
          need_from_recent_strain_milli: 0,
          need_from_recent_nap_milli: 0,
        },
        respiratory_rate: 15,
        sleep_performance_percentage: spec.performance === undefined ? 80 : spec.performance,
        sleep_consistency_percentage: 0,
        sleep_efficiency_percentage: spec.efficiency === undefined ? 90 : spec.efficiency,
      },
    });
    data.cycle.push({
      id,
      user_id: 1,
      created_at: sleepStart,
      updated_at: sleepStart,
      start: sleepStart,
      end: cycleEnd,
      timezone_offset: offset,
      score_state: "SCORED",
      score: {
        strain: spec.strain ?? 10,
        kilojoule: 8000,
        average_heart_rate: 70,
        max_heart_rate: 150,
      },
    });
    data.recovery.push({
      cycle_id: id,
      sleep_id: sleepId,
      user_id: 1,
      created_at: utcAt(spec.day, "07:30", offset),
      updated_at: utcAt(spec.day, "07:30", offset),
      score_state: "SCORED",
      score: {
        user_calibrating: spec.calibrating ?? false,
        recovery_score: spec.recovery ?? 60,
        resting_heart_rate: spec.rhr ?? 55,
        hrv_rmssd_milli: spec.hrv ?? 70,
        spo2_percentage: 96,
        skin_temp_celsius: 34,
      },
    });
  });
  return {
    recovery: data.recovery.reverse(),
    sleep: data.sleep.reverse(),
    workout: [],
    cycle: data.cycle.reverse(),
  };
}

function workout(
  id: string,
  start: string,
  sport: string,
  strain: number,
  kj: number
): WhoopRecord {
  return {
    id,
    v1_id: null,
    user_id: 1,
    created_at: start,
    updated_at: start,
    start,
    end: new Date(Date.parse(start) + HOUR_MS).toISOString(),
    timezone_offset: "+02:00",
    sport_name: sport,
    sport_id: 63,
    score_state: "SCORED",
    score: {
      strain,
      average_heart_rate: 120,
      max_heart_rate: 160,
      kilojoule: kj,
      percent_recorded: 100,
      distance_meter: null,
      altitude_gain_meter: null,
      altitude_change_meter: null,
      zone_durations: {
        zone_zero_milli: 0,
        zone_one_milli: 0,
        zone_two_milli: 0,
        zone_three_milli: 0,
        zone_four_milli: 0,
        zone_five_milli: 0,
      },
    },
  };
}

function bounds(kind: Kind, record: WhoopRecord, data: FakeData): [number, number] {
  if (kind === "recovery") {
    const cycle = data.cycle.find((c) => c.id === record.cycle_id);
    if (cycle) return bounds("cycle", cycle, data);
    const created = Date.parse(String(record.created_at));
    return [created, created];
  }
  const start = Date.parse(String(record.start));
  return [start, record.end ? Date.parse(String(record.end)) : Number.POSITIVE_INFINITY];
}

function kindOf(pathname: string): Kind {
  if (pathname.includes("recovery")) return "recovery";
  if (pathname.includes("sleep")) return "sleep";
  if (pathname.includes("workout")) return "workout";
  return "cycle";
}

/**
 * A fake WHOOP client: filters by overlap with start/end like WHOOP,
 * paginates with next_token null on the last page, records every path.
 */
function fakeWhoop(
  data: FakeData,
  overrides: { fail?: Partial<Record<Kind, Error>>; endless?: Kind } = {}
): { client: WhoopClient; paths: string[] } {
  const paths: string[] = [];
  const get = async <T>(path: string): Promise<T> => {
    paths.push(path);
    const url = new URL(path, "https://whoop.test");
    const kind = kindOf(url.pathname);
    const windowed = url.searchParams.has("start");
    const failure = overrides.fail?.[kind];
    if (failure && windowed) throw failure;
    const start = url.searchParams.get("start");
    const end = url.searchParams.get("end");
    const records = data[kind].filter((record) => {
      const [recordStart, recordEnd] = bounds(kind, record, data);
      return (
        (start === null || recordEnd >= Date.parse(start)) &&
        (end === null || recordStart < Date.parse(end))
      );
    });
    const limit = Number(url.searchParams.get("limit") ?? 10);
    const offset = Number(url.searchParams.get("nextToken") ?? 0);
    if (overrides.endless === kind && windowed) {
      return {
        records: Array.from({ length: limit }, () => records[0]),
        next_token: String(offset + limit),
      } as T;
    }
    const nextToken = offset + limit < records.length ? String(offset + limit) : null;
    return { records: records.slice(offset, offset + limit), next_token: nextToken } as T;
  };
  return { client: { get } as WhoopClient, paths };
}

/** The live user: started Monday evening, two calibrating nights, open current cycle */
function calibratingUser(): FakeData {
  const data = history([
    { day: "2026-09-15", recovery: 95, hrv: 150, rhr: 52, strain: 18, calibrating: true },
    { day: "2026-09-16", recovery: 66, hrv: 108, rhr: 56, strain: 6, calibrating: true },
  ]);
  data.workout = [
    workout("w1", "2026-09-14T16:00:00.000Z", "walking", 8, 1000),
    workout("w2", "2026-09-15T15:00:00.000Z", "walking", 6, 800),
    workout("w3", "2026-09-15T17:00:00.000Z", "running", 12, 2000),
  ];
  return data;
}

const EMPTY: FakeData = { recovery: [], sleep: [], workout: [], cycle: [] };

function queryOf(paths: string[], prefix: string): URLSearchParams {
  const path = paths.find((p) => p.startsWith(`${prefix}?start=`));
  if (!path) throw new Error(`no request for ${prefix}`);
  return new URL(path, "https://whoop.test").searchParams;
}

// ---------------------------------------------------------------------------
// Week resolution
// ---------------------------------------------------------------------------

describe("getWeeklySummary — week resolution", () => {
  it("defaults to the current local Monday-to-Sunday week, written in the user's offset", async () => {
    const { client, paths } = fakeWhoop(calibratingUser());
    const result = await getWeeklySummary(client, {}, NOW);

    expect(result.week_start).toBe("2026-09-14T00:00:00.000+02:00");
    expect(result.week_end).toBe("2026-09-20T23:59:59.999+02:00");
    // WHOOP gets full UTC timestamps; the query starts a day early to catch edge records
    const query = queryOf(paths, "/v2/recovery");
    expect(query.get("start")).toBe("2026-09-12T22:00:00.000Z");
    expect(query.get("end")).toBe("2026-09-20T22:00:00.000Z");
    expect(result.notes).toContain("This week is still in progress (data through 2026-09-16).");
  });

  it("uses UTC days when the user's offset cannot be determined", async () => {
    const { client, paths } = fakeWhoop(EMPTY);
    const result = await getWeeklySummary(client, {}, NOW);

    expect(result.week_start).toBe("2026-09-14T00:00:00.000Z");
    expect(result.week_end).toBe("2026-09-20T23:59:59.999Z");
    expect(queryOf(paths, "/v2/cycle").get("start")).toBe("2026-09-13T00:00:00.000Z");
  });

  it("accepts a date-only week_start and never sends a date-only value to WHOOP", async () => {
    const { client, paths } = fakeWhoop(calibratingUser());
    const result = await getWeeklySummary(client, { week_start: "2026-09-14" }, NOW);

    expect(result.week_start).toBe("2026-09-14T00:00:00.000+02:00");
    for (const path of paths.filter((p) => p.includes("start="))) {
      const query = new URL(path, "https://whoop.test").searchParams;
      expect(query.get("start")).toMatch(/T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(query.get("end")).toMatch(/T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
    expect(result.notes.join(" ")).not.toMatch(/is a Monday/);
  });

  it("snaps a mid-week date to that week's Monday and says so", async () => {
    const { client } = fakeWhoop(calibratingUser());
    const result = await getWeeklySummary(client, { week_start: "2026-09-16" }, NOW);

    expect(result.week_start).toBe("2026-09-14T00:00:00.000+02:00");
    expect(result.notes).toContain(
      "2026-09-16 is a Wednesday; summarizing the week from Monday 2026-09-14 to Sunday 2026-09-20."
    );
  });

  it("snaps relative expressions and date-times in the user's local day", async () => {
    for (const weekStart of ["today", "yesterday", "this week", "2026-09-16T01:30:00+02:00"]) {
      const { client } = fakeWhoop(calibratingUser());
      const result = await getWeeklySummary(client, { week_start: weekStart }, NOW);
      expect(result.week_start).toBe("2026-09-14T00:00:00.000+02:00");
    }
    // 2026-09-13T23:30Z is already Monday 01:30 at +02:00
    const { client } = fakeWhoop(calibratingUser());
    const result = await getWeeklySummary(client, { week_start: "2026-09-13T23:30:00Z" }, NOW);
    expect(result.week_start).toBe("2026-09-14T00:00:00.000+02:00");
  });

  it("reads a UTC-midnight date-time as the date written, even at a negative offset", async () => {
    // Each day's recovery score is its day of the month, so the average reveals the week used
    const days = Array.from({ length: 16 }, (_, i) => shiftDay("2026-09-01", i));
    const minusFive = (): FakeData =>
      history(
        days.map((day) => ({ day, recovery: Number(day.slice(8)) })),
        { offset: "-05:00" }
      );
    // 2026-09-14T00:00Z is still Sunday 13 September 19:00 at -05:00
    for (const weekStart of [
      "2026-09-14T00:00:00Z",
      "2026-09-14T00:00:00.000Z",
      "2026-09-14T00:00Z",
      "2026-09-14T00:00:00+02:00",
      "2026-09-14",
    ]) {
      const result = await getWeeklySummary(
        fakeWhoop(minusFive()).client,
        { week_start: weekStart },
        NOW
      );
      expect(result.week_start, weekStart).toBe("2026-09-14T00:00:00.000-05:00");
      expect(result.week_end, weekStart).toBe("2026-09-20T23:59:59.999-05:00");
      expect(result.recovery.average_score, weekStart).toBe(15);
      expect(result.notes.join(" "), weekStart).not.toMatch(/is a Sunday/);
    }
  });

  it("keeps a non-midnight date-time in the local day it falls on", async () => {
    // Sunday 13 September 14:00 local at +02:00 stays in the week of 7 September
    const noon = await getWeeklySummary(
      fakeWhoop(calibratingUser()).client,
      { week_start: "2026-09-13T12:00:00Z" },
      NOW
    );
    expect(noon.week_start).toBe("2026-09-07T00:00:00.000+02:00");
    expect(noon.notes).toContain(
      "2026-09-13 is a Sunday; summarizing the week from Monday 2026-09-07 to Sunday 2026-09-13."
    );
    // Sunday 20 September 23:00Z is already Monday 21 September 01:00 at +02:00
    const late = await getWeeklySummary(
      fakeWhoop(calibratingUser()).client,
      { week_start: "2026-09-20T23:00:00Z" },
      NOW
    );
    expect(late.week_start).toBe("2026-09-21T00:00:00.000+02:00");
  });

  it("still rejects an invalid calendar date written as midnight", async () => {
    await expect(
      getWeeklySummary(
        fakeWhoop(calibratingUser()).client,
        { week_start: "2026-02-30T00:00:00Z" },
        NOW
      )
    ).rejects.toThrow(/Invalid calendar date/);
  });

  it("resolves 'last week' to the previous local week", async () => {
    const { client } = fakeWhoop(calibratingUser());
    const result = await getWeeklySummary(client, { week_start: "last week" }, NOW);

    expect(result.week_start).toBe("2026-09-07T00:00:00.000+02:00");
    expect(result.week_end).toBe("2026-09-13T23:59:59.999+02:00");
    expect(result.notes.join(" ")).not.toMatch(/still in progress/);
  });
});

// ---------------------------------------------------------------------------
// Sparse and missing data
// ---------------------------------------------------------------------------

describe("getWeeklySummary — sparse and missing data", () => {
  it("summarizes a calibrating user's first days without zeros or a trend", async () => {
    const { client } = fakeWhoop(calibratingUser());
    const result = await getWeeklySummary(client, {}, NOW);

    expect(result.recovery).toEqual({
      average_score: 80.5,
      min_score: 66,
      max_score: 95,
      average_hrv: 129,
      average_rhr: 54,
      trend: null,
    });
    expect(result.calibrating).toBe(true);
    expect(result.sample_sizes).toEqual({ recovery_days: 2, sleep_nights: 2, completed_cycles: 1 });
    expect(result.notes).toContain(
      "Not enough data yet for a recovery trend: 2 scored recovery day(s) this week; a trend needs at least 4."
    );
    expect(result.notes.join(" ")).toMatch(/WHOOP is still calibrating \(2 of 2/);
    expect(result.truncated).toBe(false);
    expect(result.warnings).toBeUndefined();
  });

  it("reports hours asleep (not time in bed) for sleep", async () => {
    const { client } = fakeWhoop(calibratingUser());
    const result = await getWeeklySummary(client, {}, NOW);

    expect(result.sleep).toEqual({
      average_duration_hours: 7,
      average_performance_pct: 80,
      average_efficiency_pct: 90,
    });
  });

  it("leaves the in-progress cycle out of strain and says so", async () => {
    const { client } = fakeWhoop(calibratingUser());
    const result = await getWeeklySummary(client, {}, NOW);

    expect(result.strain).toEqual({ average_daily_strain: 18, max_daily_strain: 18 });
    expect(result.notes).toContain("Today's strain is still accumulating and is not included.");
  });

  it("returns nulls with notes, not zeros, for a week without data", async () => {
    const { client } = fakeWhoop(calibratingUser());
    const result = await getWeeklySummary(client, { week_start: "last week" }, NOW);

    expect(result.recovery).toEqual({
      average_score: null,
      min_score: null,
      max_score: null,
      average_hrv: null,
      average_rhr: null,
      trend: null,
    });
    expect(result.sleep).toEqual({
      average_duration_hours: null,
      average_performance_pct: null,
      average_efficiency_pct: null,
    });
    expect(result.strain).toEqual({ average_daily_strain: null, max_daily_strain: null });
    // The strap was not worn yet: workout totals are unknown, not 0
    expect(result.workouts).toEqual({
      count: null,
      total_strain: null,
      total_calories_kj: null,
      sport_breakdown: {},
    });
    expect(result.sample_sizes).toEqual({ recovery_days: 0, sleep_nights: 0, completed_cycles: 0 });
    expect(result.calibrating).toBe(false);
    expect(result.notes).toEqual(
      expect.arrayContaining([
        "No scored recovery recorded this week.",
        "No scored main sleep recorded this week.",
        "No WHOOP data was recorded this week, so workout count, strain and calories are unknown (null), not 0.",
        "No completed, scored cycle this week, so daily strain is null.",
      ])
    );
  });

  it("returns null workout totals for a week that has not started", async () => {
    const { client } = fakeWhoop(calibratingUser());
    const result = await getWeeklySummary(client, { week_start: "2026-09-23" }, NOW);

    expect(result.workouts).toEqual({
      count: null,
      total_strain: null,
      total_calories_kj: null,
      sport_breakdown: {},
    });
    expect(result.notes).toContain("This week has not started yet.");
    expect(result.notes.join(" ")).not.toMatch(/No WHOOP data was recorded/);
  });

  it("reports 0 workouts for a worn week without workouts", async () => {
    const data = history([{ day: "2026-09-08" }, { day: "2026-09-09" }], { openLatest: false });
    const { client } = fakeWhoop(data);
    const result = await getWeeklySummary(client, { week_start: "last week" }, NOW);

    expect(result.workouts).toEqual({
      count: 0,
      total_strain: 0,
      total_calories_kj: 0,
      sport_breakdown: {},
    });
    expect(result.notes.join(" ")).not.toMatch(/No WHOOP data was recorded/);
  });

  it("does not claim a week had no data when cycles could not be loaded", async () => {
    const { client } = fakeWhoop(calibratingUser(), { fail: { cycle: new Error("down") } });
    const result = await getWeeklySummary(client, { week_start: "last week" }, NOW);

    expect(result.workouts.count).toBe(0);
    expect(result.notes.join(" ")).not.toMatch(/No WHOOP data was recorded/);
  });

  it("averages sleep percentages over nights that have them (null is not 0)", async () => {
    const data = history(
      [
        { day: "2026-09-08", performance: 80, efficiency: null },
        { day: "2026-09-09", performance: null, efficiency: 90 },
      ],
      { openLatest: false }
    );
    const { client } = fakeWhoop(data);
    const result = await getWeeklySummary(client, { week_start: "last week" }, NOW);

    expect(result.sleep.average_performance_pct).toBe(80);
    expect(result.sleep.average_efficiency_pct).toBe(90);
    expect(result.sample_sizes.sleep_nights).toBe(2);
  });

  it("filters out unscored records (PENDING_SCORE, UNSCORABLE)", async () => {
    const data = calibratingUser();
    data.recovery[0]!.score_state = "PENDING_SCORE";
    data.recovery[0]!.score = null;
    data.sleep[0]!.score_state = "UNSCORABLE";
    data.sleep[0]!.score = null;

    const { client } = fakeWhoop(data);
    const result = await getWeeklySummary(client, {}, NOW);

    expect(result.recovery.average_score).toBe(95);
    expect(result.sample_sizes.recovery_days).toBe(1);
    expect(result.sample_sizes.sleep_nights).toBe(1);
  });

  it("excludes naps from sleep", async () => {
    const data = calibratingUser();
    data.sleep.unshift({
      ...data.sleep[0]!,
      id: "nap-1",
      nap: true,
      start: "2026-09-16T11:00:00.000Z",
      end: "2026-09-16T11:30:00.000Z",
    });
    const { client } = fakeWhoop(data);
    const result = await getWeeklySummary(client, {}, NOW);

    expect(result.sample_sizes.sleep_nights).toBe(2);
    expect(result.sleep.average_duration_hours).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Week membership and trend
// ---------------------------------------------------------------------------

describe("getWeeklySummary — membership and trend", () => {
  const spanning = (): FakeData => {
    // Sunday 2026-09-13's cycle starts Saturday evening; Monday 2026-09-14's
    // cycle and sleep start Sunday 23:00 local, before the week begins.
    const data = history(
      [
        { day: "2026-09-12", recovery: 40, strain: 5 },
        { day: "2026-09-13", recovery: 50, strain: 7 },
        { day: "2026-09-14", recovery: 60, strain: 9 },
        { day: "2026-09-15", recovery: 70, strain: 11 },
        { day: "2026-09-16", recovery: 80, strain: 13 },
      ],
      { openLatest: true }
    );
    data.workout = [
      workout("sun-late", "2026-09-13T21:30:00.000Z", "walking", 5, 500), // Sunday 23:30 local
      workout("mon-early", "2026-09-13T22:30:00.000Z", "running", 9, 900), // Monday 00:30 local
    ];
    return data;
  };

  it("counts records spanning the week edge in exactly one week", async () => {
    const thisWeek = await getWeeklySummary(fakeWhoop(spanning()).client, {}, NOW);
    const lastWeek = await getWeeklySummary(
      fakeWhoop(spanning()).client,
      { week_start: "last week" },
      NOW
    );

    // This week: Monday 14, Tuesday 15, Wednesday 16 (open cycle excluded from strain)
    expect(thisWeek.sample_sizes).toEqual({
      recovery_days: 3,
      sleep_nights: 3,
      completed_cycles: 2,
    });
    expect(thisWeek.recovery.min_score).toBe(60);
    expect(thisWeek.strain).toEqual({ average_daily_strain: 10, max_daily_strain: 11 });
    expect(thisWeek.workouts.sport_breakdown).toEqual({ running: 1 });

    // Last week: only Saturday 12 and Sunday 13
    expect(lastWeek.sample_sizes).toEqual({
      recovery_days: 2,
      sleep_nights: 2,
      completed_cycles: 2,
    });
    expect(lastWeek.recovery.max_score).toBe(50);
    expect(lastWeek.strain).toEqual({ average_daily_strain: 6, max_daily_strain: 7 });
    expect(lastWeek.workouts.sport_breakdown).toEqual({ walking: 1 });
  });

  it("places a late-synced recovery in its cycle's week", async () => {
    const data = spanning();
    const sunday = data.recovery.find((r) => r.sleep_id === "sleep-2026-09-13")!;
    sunday.created_at = "2026-09-14T09:00:00.000Z";

    const thisWeek = await getWeeklySummary(fakeWhoop(data).client, {}, NOW);

    expect(thisWeek.sample_sizes.recovery_days).toBe(3);
    expect(thisWeek.recovery.min_score).toBe(60);
  });

  it("computes the recovery trend oldest first from newest-first data", async () => {
    const days = ["2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11"];
    const declining = history(
      days.map((day, i) => ({ day, recovery: 90 - i * 10 })),
      { openLatest: false }
    );
    const improving = history(
      days.map((day, i) => ({ day, recovery: 40 + i * 10 })),
      { openLatest: false }
    );
    // Newest first, as WHOOP returns it
    expect((declining.recovery[0]!.score as { recovery_score: number }).recovery_score).toBe(50);

    const down = await getWeeklySummary(
      fakeWhoop(declining).client,
      { week_start: "2026-09-07" },
      NOW
    );
    const up = await getWeeklySummary(
      fakeWhoop(improving).client,
      { week_start: "2026-09-07" },
      NOW
    );

    expect(down.recovery.trend).toBe("declining");
    expect(up.recovery.trend).toBe("improving");
    expect(down.notes.join(" ")).not.toMatch(/Not enough data/);
  });

  it("computes workout stats with sport breakdown", async () => {
    const { client } = fakeWhoop(calibratingUser());
    const result = await getWeeklySummary(client, {}, NOW);

    expect(result.workouts).toEqual({
      count: 3,
      total_strain: 26,
      total_calories_kj: 3800,
      sport_breakdown: { walking: 2, running: 1 },
    });
  });
});

// ---------------------------------------------------------------------------
// Failures and data quality
// ---------------------------------------------------------------------------

describe("getWeeklySummary — failures and data quality", () => {
  it("makes one offset lookup, then serialized recovery, sleep, workout and cycle calls", async () => {
    const { client, paths } = fakeWhoop(EMPTY);
    await getWeeklySummary(client, {}, NOW);

    expect(paths.map((path) => path.split("?")[0])).toEqual([
      "/v2/cycle",
      "/v2/recovery",
      "/v2/activity/sleep",
      "/v2/activity/workout",
      "/v2/cycle",
    ]);
  });

  it("returns partial results with warnings when some endpoints fail", async () => {
    const { client } = fakeWhoop(calibratingUser(), {
      fail: { sleep: new Error("Sleep endpoint unavailable"), workout: new Error("down") },
    });
    const result = await getWeeklySummary(client, {}, NOW);

    expect(result.recovery.average_score).toBe(80.5);
    expect(result.warnings).toEqual(["sleep: Sleep endpoint unavailable", "workout: down"]);
    expect(result.sleep.average_duration_hours).toBeNull();
    expect(result.workouts).toEqual({
      count: null,
      total_strain: null,
      total_calories_kj: null,
      sport_breakdown: {},
    });
    expect(result.notes).toEqual(
      expect.arrayContaining([
        "Sleep data could not be loaded from WHOOP.",
        "Workout data could not be loaded from WHOOP.",
      ])
    );
    expect(result.notes.join(" ")).not.toMatch(/No scored main sleep/);
  });

  it("dates recoveries through their sleep when cycles fail", async () => {
    const { client } = fakeWhoop(calibratingUser(), { fail: { cycle: new Error("down") } });
    const result = await getWeeklySummary(client, {}, NOW);

    expect(result.sample_sizes.recovery_days).toBe(2);
    expect(result.strain).toEqual({ average_daily_strain: null, max_daily_strain: null });
  });

  it("rethrows the WHOOP API error when ALL 4 endpoints fail", async () => {
    const error = new WhoopApiError(404, "Not Found", null);
    const { client } = fakeWhoop(EMPTY, {
      fail: { recovery: error, sleep: error, workout: error, cycle: error },
    });

    await expect(getWeeklySummary(client, {}, NOW)).rejects.toBe(error);
  });

  it("throws a combined error when ALL 4 endpoints fail with unknown errors", async () => {
    const { client } = fakeWhoop(EMPTY, {
      fail: {
        recovery: new Error("Recovery down"),
        sleep: new Error("Sleep down"),
        workout: new Error("Workout down"),
        cycle: new Error("Cycle down"),
      },
    });

    await expect(getWeeklySummary(client, {}, NOW)).rejects.toThrow("All endpoints failed");
  });

  it("surfaces pagination truncation", async () => {
    const { client } = fakeWhoop(calibratingUser(), { endless: "workout" });
    const result = await getWeeklySummary(client, {}, NOW);

    expect(result.truncated).toBe(true);
    expect(result.notes.join(" ")).toMatch(/more workout records than could be fetched/);
  });

  it("skips records that do not match the WHOOP format and notes it", async () => {
    const data = calibratingUser();
    (data.recovery[0]!.score as Record<string, unknown>).hrv_rmssd_milli = null;
    const { client } = fakeWhoop(data);
    const result = await getWeeklySummary(client, {}, NOW);

    expect(result.sample_sizes.recovery_days).toBe(1);
    expect(result.notes).toContain(
      "1 recovery record(s) did not match the expected WHOOP format and were skipped."
    );
  });
});

// ---------------------------------------------------------------------------
// Output contract (standard and aggregate privacy modes)
// ---------------------------------------------------------------------------

describe("get_weekly_summary output contract", () => {
  async function callWeekly(
    client: WhoopClient,
    privacyMode: "standard" | "aggregate",
    args: Record<string, string> = {}
  ): Promise<{
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
    content?: unknown;
  }> {
    const { server } = createWhoopServer(client, { privacyMode });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: "test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
    try {
      return (await mcp.callTool({ name: "get_weekly_summary", arguments: args })) as {
        isError?: boolean;
        structuredContent?: Record<string, unknown>;
      };
    } finally {
      await mcp.close();
      await server.close();
    }
  }

  for (const privacyMode of ["standard", "aggregate"] as const) {
    it(`passes the ${privacyMode} contract for sparse, empty and partially failed weeks`, async () => {
      const cases: [WhoopClient, Record<string, string>][] = [
        [fakeWhoop(calibratingUser()).client, {}],
        [fakeWhoop(calibratingUser()).client, { week_start: "last week" }],
        [fakeWhoop(calibratingUser()).client, { week_start: "2026-09-14" }],
        [fakeWhoop(calibratingUser(), { fail: { workout: new Error("down") } }).client, {}],
      ];
      for (const [client, args] of cases) {
        const result = await callWeekly(client, privacyMode, args);
        expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
        expect(result.structuredContent).toHaveProperty("notes");
        expect(result.structuredContent).toHaveProperty("sample_sizes");
      }
    });
  }

  it("projects week_start to the user's local date in aggregate mode", async () => {
    const { client } = fakeWhoop(calibratingUser());
    const result = await callWeekly(client, "aggregate", { week_start: "2026-09-16" });

    expect(result.structuredContent?.week_start).toBe("2026-09-14");
    expect(result.structuredContent?.week_end).toBe("2026-09-20");
    expect(result.structuredContent).not.toHaveProperty("warnings");
  });

  it("withholds extremes and averages from fewer than 3 data points in aggregate mode", async () => {
    const { client } = fakeWhoop(calibratingUser());
    const aggregate = (await callWeekly(client, "aggregate")).structuredContent!;

    expect(aggregate.recovery).toEqual({
      average_score: null,
      average_hrv: null,
      average_rhr: null,
      trend: null,
    });
    expect(aggregate.sleep).toEqual({
      average_duration_hours: null,
      average_performance_pct: null,
      average_efficiency_pct: null,
    });
    expect(aggregate.strain).toEqual({ average_daily_strain: null });
    expect(aggregate.sample_sizes).toMatchObject({ recovery_days: 2, sleep_nights: 2 });
    expect(aggregate.notes).toContainEqual(
      expect.stringMatching(
        /^Aggregate privacy mode withholds averages and totals based on fewer than 3 data points: recovery \(2 days\), sleep \(2 nights\), daily strain \(1 completed cycle\)/
      )
    );

    const standard = (await callWeekly(fakeWhoop(calibratingUser()).client, "standard"))
      .structuredContent!;
    expect(standard.recovery).toMatchObject({ min_score: 66, max_score: 95 });
  });
});
