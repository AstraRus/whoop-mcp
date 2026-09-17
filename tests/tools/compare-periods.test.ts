/**
 * Tests for compare_periods tool.
 *
 * Fixtures are live-shaped: a user at +02:00 whose cycles start at sleep
 * onset the evening before the day they cover, recoveries/sleeps linked to
 * the cycle of their morning, the current cycle with end:null, newest-first
 * pagination with next_token null on the last page, and WHOOP's overlap
 * semantics for start/end (plus 404 for date-only values, 400 for reversed).
 *
 * Verifies that compare_periods:
 * - Resolves date-only and relative inputs to full UTC timestamps in the user's offset
 * - Returns null averages, null change_pct and "insufficient_data" for sparse periods
 * - Attributes each record to exactly one period (cycles by cycleDay, sleeps by end day)
 * - Uses asleep time from main sleeps and leaves the in-progress cycle out of strain
 * - Flags calibrating recoveries, truncation and failed sources
 * - Rejects reversed, oversized (> 90 days) and overlapping periods locally
 * - Matches the standard and aggregate output contracts
 */

import { afterEach, describe, it, expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { WhoopClient } from "../../src/api/client.js";
import { WhoopApiError, WhoopAuthError } from "../../src/api/client.js";
import {
  comparePeriods,
  MIN_SAMPLES_PER_PERIOD,
  type ComparePeriodsParams,
} from "../../src/tools/compare-periods.js";
import { InvalidDateExpression } from "../../src/tools/date-utils.js";
import {
  aggregateOutputSchemas,
  outputSchemas,
  projectAggregateDates,
} from "../../src/tools/output-contracts.js";
import { createWhoopServer } from "../../src/server.js";
import type { Cycle, Recovery, Sleep, Workout } from "../../src/api/types.js";
import { assignWorkouts, placeDays } from "../../src/tools/day-model.js";
import { MAX_TOOL_TEXT_CHARS } from "../../src/tools/tool-definition.js";
import { assertNeutralText, connectServer } from "../helpers/contract.js";
import { createWhoopFixtureClient, type FixtureFailure } from "../helpers/whoop-fixture-client.js";
import {
  liveShapedUser,
  matureUser,
  stressUser,
  type WhoopUserFixture,
} from "../helpers/whoop-users.js";

// ---------------------------------------------------------------------------
// Live-shaped fixtures
// ---------------------------------------------------------------------------

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const OFFSET = "+02:00";
/** 14:00 local on Wednesday 2026-09-16 */
const NOW = new Date("2026-09-16T12:00:00.000Z");

interface History {
  cycles: Cycle[];
  sleeps: Sleep[];
  recoveries: Recovery[];
  workouts?: Workout[];
}

interface DaySpec {
  /** Local day the cycle covers (the morning the sleep ends) */
  day: string;
  recovery?: number;
  calibrating?: boolean;
  strain?: number;
  asleepHours?: number;
  /** The record's own UTC offset (default +02:00) */
  offset?: string;
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** Minutes east of UTC for "+02:00" / "-05:00" */
function offsetMinutes(offset: string): number {
  const sign = offset.startsWith("-") ? -1 : 1;
  return sign * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6)));
}

/**
 * Build consecutive days: sleep onset 23:00 local the evening before `day`,
 * wake 07:00 local, cycle from onset to the next onset. The last cycle is
 * still open (end null) when `openLast` is set.
 */
function buildHistory(specs: DaySpec[], openLast = true): History {
  const history: History = { cycles: [], sleeps: [], recoveries: [] };
  specs.forEach((spec, index) => {
    const offset = spec.offset ?? OFFSET;
    // 23:00 local the evening before (21:00Z at +02:00)
    const onsetMs =
      Date.parse(`${spec.day}T00:00:00.000Z`) - offsetMinutes(offset) * 60_000 - HOUR_MS;
    const wakeMs = onsetMs + 8 * HOUR_MS;
    const nextOnsetMs = onsetMs + DAY_MS;
    const isLast = index === specs.length - 1;
    const cycleId = Number(spec.day.replaceAll("-", ""));
    const sleepId = `sleep-${spec.day}`;
    const asleep = spec.asleepHours ?? 7;
    history.cycles.push({
      id: cycleId,
      user_id: 100,
      created_at: iso(onsetMs),
      updated_at: iso(isLast && openLast ? NOW.getTime() : nextOnsetMs),
      start: iso(onsetMs),
      end: isLast && openLast ? null : iso(nextOnsetMs),
      timezone_offset: offset,
      score_state: "SCORED",
      score: {
        strain: spec.strain ?? 10,
        kilojoule: 8000,
        average_heart_rate: 70,
        max_heart_rate: 160,
      },
    });
    history.sleeps.push({
      id: sleepId,
      cycle_id: cycleId,
      v1_id: null,
      user_id: 100,
      created_at: iso(wakeMs),
      updated_at: iso(wakeMs),
      start: iso(onsetMs),
      end: iso(wakeMs),
      timezone_offset: offset,
      nap: false,
      score_state: "SCORED",
      score: {
        stage_summary: {
          total_in_bed_time_milli: 8 * HOUR_MS,
          total_awake_time_milli: (8 - asleep) * HOUR_MS,
          total_no_data_time_milli: 0,
          total_light_sleep_time_milli: asleep * 0.5 * HOUR_MS,
          total_slow_wave_sleep_time_milli: asleep * 0.25 * HOUR_MS,
          total_rem_sleep_time_milli: asleep * 0.25 * HOUR_MS,
          sleep_cycle_count: 4,
          disturbance_count: 2,
        },
        sleep_needed: {
          baseline_milli: 8 * HOUR_MS,
          need_from_sleep_debt_milli: 0,
          need_from_recent_strain_milli: 0,
          need_from_recent_nap_milli: 0,
        },
        respiratory_rate: 15,
        sleep_performance_percentage: 80,
        sleep_consistency_percentage: spec.calibrating ? 0 : 75,
        sleep_efficiency_percentage: 90,
      },
    });
    history.recoveries.push({
      cycle_id: cycleId,
      sleep_id: sleepId,
      user_id: 100,
      created_at: iso(wakeMs + 10 * 60_000),
      updated_at: iso(wakeMs + 10 * 60_000),
      score_state: "SCORED",
      score: {
        user_calibrating: spec.calibrating ?? false,
        recovery_score: spec.recovery ?? 60,
        resting_heart_rate: 55,
        hrv_rmssd_milli: 60,
        spo2_percentage: null,
        skin_temp_celsius: null,
      },
    });
  });
  return history;
}

/** Days from `from` to `to` inclusive */
function dayRange(from: string, to: string): string[] {
  const days: string[] = [];
  for (let ms = Date.parse(`${from}T00:00:00Z`); ms <= Date.parse(`${to}T00:00:00Z`); ms += DAY_MS)
    days.push(iso(ms).slice(0, 10));
  return days;
}

/** The calibrating user: started wearing Monday 2026-09-14 evening, two cycles, the last one open */
function calibratingUser(): History {
  const history = buildHistory([
    { day: "2026-09-15", recovery: 61, calibrating: true, strain: 8.2, asleepHours: 6.5 },
    { day: "2026-09-16", recovery: 70, calibrating: true, strain: 5.1, asleepHours: 7.5 },
  ]);
  // An afternoon nap on 2026-09-15 belongs to the first cycle and must not count
  const nap = structuredClone(history.sleeps[0]!);
  nap.id = "nap-2026-09-15";
  nap.nap = true;
  nap.start = "2026-09-15T12:00:00.000Z";
  nap.end = "2026-09-15T13:30:00.000Z";
  history.sleeps.push(nap);
  return history;
}

// ---------------------------------------------------------------------------
// Fake WHOOP API
// ---------------------------------------------------------------------------

const ZONED_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

interface FakeOptions {
  /** Return an error for a request instead of data */
  fail?: (path: string) => Error | undefined;
  /** Append records to an endpoint's filtered results */
  extra?: Partial<Record<"cycle" | "sleep" | "recovery", unknown[]>>;
}

interface FakeWhoop {
  client: WhoopClient;
  paths: string[];
}

function fakeWhoop(history: History, options: FakeOptions = {}): FakeWhoop {
  const paths: string[] = [];
  const sleepsById = new Map(history.sleeps.map((sleep) => [sleep.id, sleep]));
  const overlaps = (startIso: string, endIso: string | null, params: URLSearchParams): boolean => {
    const start = params.get("start");
    const end = params.get("end");
    const recordEnd = endIso === null ? NOW.getTime() : Date.parse(endIso);
    if (end !== null && Date.parse(startIso) >= Date.parse(end)) return false;
    return start === null || recordEnd >= Date.parse(start);
  };
  const client: WhoopClient = {
    get: async <T>(path: string): Promise<T> => {
      paths.push(path);
      const failure = options.fail?.(path);
      if (failure) throw failure;
      const [base = "", queryString = ""] = path.split("?");
      const params = new URLSearchParams(queryString);
      for (const key of ["start", "end"]) {
        const value = params.get(key);
        if (value !== null && !ZONED_TIMESTAMP.test(value)) throw new WhoopApiError(404, "", null);
      }
      const start = params.get("start");
      const end = params.get("end");
      if (start !== null && end !== null && Date.parse(end) <= Date.parse(start))
        throw new WhoopApiError(400, "", null);

      let records: unknown[];
      if (base === "/v2/cycle") {
        records = history.cycles
          .filter((cycle) => overlaps(cycle.start, cycle.end ?? null, params))
          .sort((left, right) => Date.parse(right.start) - Date.parse(left.start));
      } else if (base === "/v2/activity/sleep") {
        records = history.sleeps
          .filter((sleep) => overlaps(sleep.start, sleep.end, params))
          .sort((left, right) => Date.parse(right.start) - Date.parse(left.start));
      } else if (base === "/v2/recovery") {
        records = history.recoveries
          .filter((recovery) => {
            const sleep = sleepsById.get(recovery.sleep_id);
            return sleep !== undefined && overlaps(sleep.start, sleep.end, params);
          })
          .sort(
            (left, right) =>
              Date.parse(sleepsById.get(right.sleep_id)!.start) -
              Date.parse(sleepsById.get(left.sleep_id)!.start)
          );
      } else if (base === "/v2/activity/workout") {
        records = (history.workouts ?? [])
          .filter((workout) => overlaps(workout.start, workout.end, params))
          .sort((left, right) => Date.parse(right.start) - Date.parse(left.start));
      } else {
        throw new WhoopApiError(404, "", null);
      }
      const kind = base === "/v2/cycle" ? "cycle" : base === "/v2/recovery" ? "recovery" : "sleep";
      if (options.extra?.[kind] && params.get("start") !== null) {
        records = [...records, ...options.extra[kind]!];
      }
      const limit = Number(params.get("limit") ?? 10);
      const offset = Number(params.get("nextToken") ?? 0);
      const page = records.slice(offset, offset + limit);
      const next = offset + limit < records.length ? String(offset + limit) : null;
      return { records: page, next_token: next } as T;
    },
  };
  return { client, paths };
}

const SPARSE_PERIODS: ComparePeriodsParams = {
  // The week before the user started wearing WHOOP vs. the days since
  period_a_start: "2026-09-07",
  period_a_end: "2026-09-13",
  period_b_start: "2026-09-14",
  period_b_end: "2026-09-16",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("comparePeriods — calibrating user with sparse data", () => {
  it("returns null averages and insufficient_data instead of '+100% improved' against an empty period", async () => {
    const { client } = fakeWhoop(calibratingUser());

    const result = await comparePeriods(client, SPARSE_PERIODS, NOW);

    expect(result.recovery).toEqual({
      period_a_avg: null,
      period_b_avg: 65.5,
      period_a_n: 0,
      period_b_n: 2,
      change_pct: null,
      direction: "insufficient_data",
      period_a_calibrating_n: 0,
      period_b_calibrating_n: 2,
    });
    expect(result.sleep.period_a_avg_hours).toBeNull();
    expect(result.sleep.period_b_n).toBe(2);
    expect(result.sleep.change_pct).toBeNull();
    expect(result.sleep.direction).toBe("insufficient_data");
    // The open cycle is left out of strain, so only the completed one counts
    expect(result.strain).toEqual({
      period_a_avg: null,
      period_b_avg: 8.2,
      period_a_n: 0,
      period_b_n: 1,
      change_pct: null,
      direction: "insufficient_data",
    });
    expect(result.truncated).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(result.notes).toContain(
      "Not enough data yet to compare recovery: period A has 0 scored recoveries and period B has 2; at least 3 per period are needed. WHOOP is still calibrating, so data is still building up."
    );
    expect(
      result.notes.some((note) => note.startsWith("Not enough data yet to compare sleep"))
    ).toBe(true);
    expect(
      result.notes.some((note) => note.includes("still calibrating for 2 of 2 recoveries"))
    ).toBe(true);
    expect(result.notes.some((note) => note.includes("still in progress"))).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/"improved"|"increased"/);
  });

  it("sends only full UTC timestamps to WHOOP for date-only inputs (no 404)", async () => {
    const { client, paths } = fakeWhoop(calibratingUser());

    const result = await comparePeriods(client, SPARSE_PERIODS, NOW);

    const dataPaths = paths.filter((path) => path.includes("start="));
    // Recovery, sleep, cycle and workouts for each period
    expect(dataPaths).toHaveLength(8);
    for (const path of dataPaths) {
      const params = new URLSearchParams(path.split("?")[1]);
      expect(params.get("start")).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(params.get("end")).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
    // Local days in the user's offset, reported in that offset
    expect(result.period_a).toEqual({
      start: "2026-09-07T00:00:00.000+02:00",
      end: "2026-09-13T23:59:59.999+02:00",
      days: 7,
      first_day: "2026-09-07",
      last_day: "2026-09-13",
    });
    expect(result.period_b).toEqual({
      start: "2026-09-14T00:00:00.000+02:00",
      end: "2026-09-16T23:59:59.999+02:00",
      days: 3,
      first_day: "2026-09-14",
      last_day: "2026-09-16",
    });
  });

  it("matches the standard and aggregate output contracts", async () => {
    const { client } = fakeWhoop(calibratingUser());

    const result = await comparePeriods(client, SPARSE_PERIODS, NOW);

    expect(outputSchemas.compare_periods!.safeParse(result).success).toBe(true);
    const aggregate = aggregateOutputSchemas.compare_periods!.safeParse(result);
    expect(aggregate.success).toBe(true);
    const projected = projectAggregateDates(aggregate.data as Record<string, unknown>);
    expect(projected.period_a).toMatchObject({
      start: "2026-09-07",
      end: "2026-09-13",
      days: 7,
      first_day: "2026-09-07",
      last_day: "2026-09-13",
    });
    expect(projected.period_b).toMatchObject({
      start: "2026-09-14",
      end: "2026-09-16",
      days: 3,
      first_day: "2026-09-14",
      last_day: "2026-09-16",
    });
  });

  it("matches the contracts when both periods are empty", async () => {
    const { client } = fakeWhoop({ cycles: [], sleeps: [], recoveries: [] });

    const result = await comparePeriods(client, SPARSE_PERIODS, NOW);

    expect(result.recovery.period_a_avg).toBeNull();
    expect(result.recovery.period_b_avg).toBeNull();
    expect(result.recovery.direction).toBe("insufficient_data");
    expect(result.notes).toContain(
      "Not enough data yet to compare strain: neither period has any completed cycles."
    );
    expect(outputSchemas.compare_periods!.safeParse(result).success).toBe(true);
    expect(aggregateOutputSchemas.compare_periods!.safeParse(result).success).toBe(true);
  });

  it("averages time asleep on main sleeps only (not time in bed, not naps)", async () => {
    const { client } = fakeWhoop(calibratingUser());

    const result = await comparePeriods(client, SPARSE_PERIODS, NOW);

    // Two main sleeps of 6.5h and 7.5h asleep (8h in bed each); the nap is ignored
    expect(result.sleep.period_b_avg_hours).toBe(7);
    expect(result.sleep.period_b_n).toBe(2);
  });
});

describe("comparePeriods — attribution to exactly one period", () => {
  const days = dayRange("2026-09-01", "2026-09-16");
  const history = buildHistory(
    days.map((day, index) => ({
      day,
      recovery: 40 + index * 2,
      strain: 5 + index,
      asleepHours: 5 + index * 0.1,
    }))
  );
  const valueFor = (day: string): number => days.indexOf(day);

  it("splits adjacent date-only periods by local day with no record counted twice", async () => {
    const { client } = fakeWhoop(history);

    const result = await comparePeriods(
      client,
      {
        period_a_start: "2026-09-05",
        period_a_end: "2026-09-08",
        period_b_start: "2026-09-09",
        period_b_end: "2026-09-12",
      },
      NOW
    );

    const aDays = dayRange("2026-09-05", "2026-09-08").map(valueFor);
    const bDays = dayRange("2026-09-09", "2026-09-12").map(valueFor);
    const avg = (values: number[]): number =>
      values.reduce((sum, value) => sum + value, 0) / values.length;
    expect(result.strain.period_a_n).toBe(4);
    expect(result.strain.period_b_n).toBe(4);
    expect(result.strain.period_a_avg).toBeCloseTo(5 + avg(aDays), 5);
    expect(result.strain.period_b_avg).toBeCloseTo(5 + avg(bDays), 5);
    expect(result.recovery.period_a_avg).toBeCloseTo(40 + 2 * avg(aDays), 5);
    expect(result.recovery.period_b_avg).toBeCloseTo(40 + 2 * avg(bDays), 5);
    expect(result.sleep.period_a_avg_hours).toBeCloseTo(5 + 0.1 * avg(aDays), 2);
    expect(result.sleep.period_b_n).toBe(4);
    expect(result.strain.direction).toBe("increased");
    expect(result.recovery.direction).toBe("improved");
  });

  it("counts the cycle that crosses a shared UTC-midnight boundary in only one period", async () => {
    const { client } = fakeWhoop(history);

    // Finding 30 live repro: A ends exactly where B starts
    const result = await comparePeriods(
      client,
      {
        period_a_start: "2026-09-07T00:00:00Z",
        period_a_end: "2026-09-14T00:00:00Z",
        period_b_start: "2026-09-14T00:00:00Z",
        period_b_end: "2026-09-16T12:00:00Z",
      },
      NOW
    );

    // 00:00Z is 02:00 local: A counts the local days mostly inside it, 09-07..09-13;
    // B counts 09-14..09-16 (its end is after now, so today stays in; 09-16 is open)
    expect(result.period_a).toMatchObject({ first_day: "2026-09-07", last_day: "2026-09-13" });
    expect(result.period_b).toMatchObject({ first_day: "2026-09-14", last_day: "2026-09-16" });
    expect(result.strain.period_a_n).toBe(7);
    expect(result.strain.period_b_n).toBe(2);
    expect(result.recovery.period_a_n).toBe(7);
    expect(result.recovery.period_b_n).toBe(3);
    expect(result.sleep.period_a_n + result.sleep.period_b_n).toBe(10);
    expect(result.strain.period_b_avg).toBe(
      5 + (valueFor("2026-09-14") + valueFor("2026-09-15")) / 2
    );
    expect(result.notes).toContain(
      "Period A does not start and end at local midnight, so it counts the local days mostly inside it: 2026-09-07 to 2026-09-13."
    );
  });

  it("leaves the in-progress cycle out of strain but keeps today's recovery and sleep", async () => {
    const { client } = fakeWhoop(history);

    const result = await comparePeriods(
      client,
      {
        period_a_start: "2026-09-10",
        period_a_end: "2026-09-12",
        period_b_start: "2026-09-13",
        period_b_end: "2026-09-16",
      },
      NOW
    );

    expect(result.strain.period_b_n).toBe(3);
    expect(result.recovery.period_b_n).toBe(4);
    expect(result.sleep.period_b_n).toBe(4);
    expect(result.notes).toContain(
      "The current cycle in period B is still in progress, so its strain is not included yet."
    );
    expect(result.strain.direction).not.toBe("insufficient_data");
  });

  it("attributes recoveries through their sleep when the cycle source fails", async () => {
    const sixDays = buildHistory(
      dayRange("2026-09-08", "2026-09-13").map((day) => ({ day, recovery: 50 })),
      false
    );
    const { client } = fakeWhoop(sixDays, {
      fail: (path) =>
        path.startsWith("/v2/cycle") && path.includes("start=")
          ? new WhoopApiError(502, "", null)
          : undefined,
    });

    const result = await comparePeriods(
      client,
      {
        period_a_start: "2026-09-08",
        period_a_end: "2026-09-10",
        period_b_start: "2026-09-11",
        period_b_end: "2026-09-13",
      },
      NOW
    );

    expect(result.recovery.period_a_n).toBe(3);
    expect(result.recovery.period_b_n).toBe(3);
    expect(result.strain.direction).toBe("insufficient_data");
    // Worn days are unknown without cycles, so training is not compared.
    expect(result.training).toBeNull();
    expect(result.warnings).toEqual([
      "Cycle (strain) data for period A could not be loaded (WHOOP API returned 502), so that period has no cycle (strain) samples.",
      "Cycle (strain) data for period B could not be loaded (WHOOP API returned 502), so that period has no cycle (strain) samples.",
      "Training is not compared: cycle data for period A could not be loaded, so worn days are unknown.",
      "Training is not compared: cycle data for period B could not be loaded, so worn days are unknown.",
    ]);
  });

  it("keeps each record's own local day when its offset differs from the user's current one", async () => {
    // Summer records at +02:00, compared after the user's offset changed to +01:00
    const summer = buildHistory(
      dayRange("2026-07-01", "2026-07-08").map((day, index) => ({ day, strain: 1 + index })),
      false
    );
    const winter = buildHistory([{ day: "2026-09-15", offset: "+01:00" }]);
    const { client } = fakeWhoop({
      cycles: [...summer.cycles, ...winter.cycles],
      sleeps: [...summer.sleeps, ...winter.sleeps],
      recoveries: [...summer.recoveries, ...winter.recoveries],
    });

    const result = await comparePeriods(
      client,
      {
        period_a_start: "2026-07-01",
        period_a_end: "2026-07-03",
        period_b_start: "2026-07-04",
        period_b_end: "2026-07-06",
      },
      NOW
    );

    expect(result.period_a.start).toBe("2026-07-01T00:00:00.000+01:00");
    // 07-01..07-03 have strain 1, 2, 3; 07-04..07-06 have 4, 5, 6
    expect(result.strain).toMatchObject({ period_a_avg: 2, period_b_avg: 5 });
    expect(result.strain.period_a_n).toBe(3);
    expect(result.recovery.period_a_n).toBe(3);
    expect(result.sleep.period_b_n).toBe(3);
  });
});

describe("comparePeriods — local days counted for date-time bounds", () => {
  /** Days 09-01..09-16 whose recovery and strain equal the day of the month */
  function dayOfMonthHistory(offset: string): History {
    return buildHistory(
      dayRange("2026-09-01", "2026-09-16").map((day) => ({
        day,
        offset,
        recovery: Number(day.slice(8)),
        strain: Number(day.slice(8)),
      }))
    );
  }
  const zMidnightWeeks: ComparePeriodsParams = {
    period_a_start: "2026-09-01T00:00:00Z",
    period_a_end: "2026-09-08T00:00:00Z",
    period_b_start: "2026-09-08T00:00:00Z",
    period_b_end: "2026-09-15T00:00:00Z",
  };

  it.each(["+02:00", "-05:00"])(
    "compares local 09-01..09-07 with 09-08..09-14 for UTC-midnight weeks at %s",
    async (offset) => {
      const { client } = fakeWhoop(dayOfMonthHistory(offset));

      const result = await comparePeriods(client, zMidnightWeeks, NOW);

      expect(result.period_a).toMatchObject({ first_day: "2026-09-01", last_day: "2026-09-07" });
      expect(result.period_b).toMatchObject({ first_day: "2026-09-08", last_day: "2026-09-14" });
      expect(result.recovery).toMatchObject({ period_a_avg: 4, period_b_avg: 11, change_pct: 175 });
      expect(result.strain).toMatchObject({ period_a_avg: 4, period_b_avg: 11 });
      expect(result.sleep.period_a_n).toBe(7);
      expect(result.sleep.period_b_n).toBe(7);
    }
  );

  it("keeps date-only and local-midnight bounds on the same days without a snapping note", async () => {
    const { client } = fakeWhoop(dayOfMonthHistory(OFFSET));

    const dateOnly = await comparePeriods(
      client,
      {
        period_a_start: "2026-09-01",
        period_a_end: "2026-09-07",
        period_b_start: "2026-09-08",
        period_b_end: "2026-09-14",
      },
      NOW
    );
    const localMidnights = await comparePeriods(
      client,
      {
        period_a_start: "2026-09-01T00:00:00+02:00",
        period_a_end: "2026-09-08T00:00:00+02:00",
        period_b_start: "2026-09-08T00:00:00+02:00",
        period_b_end: "2026-09-15T00:00:00+02:00",
      },
      NOW
    );

    for (const result of [dateOnly, localMidnights]) {
      expect(result.recovery).toMatchObject({ period_a_avg: 4, period_b_avg: 11 });
      expect(result.period_a).toMatchObject({ first_day: "2026-09-01", last_day: "2026-09-07" });
      expect(result.notes).toEqual([]);
    }
  });

  it("does not credit a UTC-midnight day with the next local morning's records (live calibrating user)", async () => {
    const { client } = fakeWhoop(calibratingUser());

    const result = await comparePeriods(
      client,
      {
        period_a_start: "2026-09-14T00:00:00Z",
        period_a_end: "2026-09-15T00:00:00Z",
        period_b_start: "2026-09-15T00:00:00Z",
        period_b_end: "2026-09-16T00:00:00Z",
      },
      NOW
    );

    // The 09-15 recovery was created at 05:10Z on 09-15, after period A ended
    expect(result.period_a).toMatchObject({ first_day: "2026-09-14", last_day: "2026-09-14" });
    expect(result.recovery.period_a_n).toBe(0);
    expect(result.sleep.period_a_n).toBe(0);
    expect(result.strain.period_a_n).toBe(0);
    expect(result.period_b).toMatchObject({ first_day: "2026-09-15", last_day: "2026-09-15" });
    expect(result.recovery).toMatchObject({ period_b_avg: 61, period_b_n: 1 });
    expect(result.strain).toMatchObject({ period_b_avg: 8.2, period_b_n: 1 });
    expect(result.notes).not.toContain(
      "The current cycle in period B is still in progress, so its strain is not included yet."
    );
  });

  it("counts the local day most of an intra-day period covers", async () => {
    const { client } = fakeWhoop(dayOfMonthHistory(OFFSET));

    const result = await comparePeriods(
      client,
      {
        period_a_start: "2026-09-06T06:00:00+02:00",
        period_a_end: "2026-09-06T22:00:00+02:00",
        period_b_start: "2026-09-10",
        period_b_end: "2026-09-12",
      },
      NOW
    );

    expect(result.period_a).toMatchObject({ first_day: "2026-09-06", last_day: "2026-09-06" });
    expect(result.recovery).toMatchObject({ period_a_avg: 6, period_a_n: 1, period_b_avg: 11 });
    expect(result.notes).toContain(
      "Period A does not start and end at local midnight, so it counts the local days mostly inside it: 2026-09-06."
    );
  });

  it("explains a period that covers most of no local day instead of 'not enough data yet'", async () => {
    const { client } = fakeWhoop(dayOfMonthHistory(OFFSET));

    const result = await comparePeriods(
      client,
      {
        period_a_start: "2026-09-06T13:00:00+02:00",
        period_a_end: "2026-09-06T20:00:00+02:00",
        period_b_start: "2026-09-10",
        period_b_end: "2026-09-12",
      },
      NOW
    );

    expect(result.period_a).toMatchObject({ days: 0.29, first_day: null, last_day: null });
    expect(result.recovery).toMatchObject({ period_a_avg: null, period_a_n: 0, period_b_n: 3 });
    expect(result.notes).toEqual([
      "Period A (2026-09-06T13:00:00.000+02:00 to 2026-09-06T20:00:00.000+02:00) does not cover most of any local day, so no days were counted in it. A day counts toward a period when most of that day lies inside it; use YYYY-MM-DD dates to compare whole days.",
      "Cannot compare recovery: period A covers no local day.",
      "Cannot compare sleep: period A covers no local day.",
      "Cannot compare strain: period A covers no local day.",
      "Cannot compare training: period A covers no local day.",
    ]);
    expect(outputSchemas.compare_periods!.safeParse(result).success).toBe(true);
    const aggregate = aggregateOutputSchemas.compare_periods!.safeParse(result);
    expect(aggregate.success).toBe(true);
  });

  it("keeps today when a period ends at now before local noon", async () => {
    // 08:00 local: today's recovery (07:10 local) already exists
    const morning = new Date("2026-09-16T06:00:00.000Z");
    const { client } = fakeWhoop(calibratingUser());

    const result = await comparePeriods(
      client,
      {
        period_a_start: "2026-09-14",
        period_a_end: "2026-09-14",
        period_b_start: "2026-09-15T00:00:00+02:00",
        period_b_end: "2026-09-16T06:00:00Z",
      },
      morning
    );

    expect(result.period_b).toMatchObject({ first_day: "2026-09-15", last_day: "2026-09-16" });
    expect(result.recovery.period_b_n).toBe(2);
    expect(result.sleep.period_b_n).toBe(2);
    expect(result.notes.some((note) => note.includes("does not start and end"))).toBe(false);
  });

  it("never counts today in both periods when they meet later today", async () => {
    const { client } = fakeWhoop(dayOfMonthHistory(OFFSET));

    // 15:00 local, after NOW (14:00 local)
    const result = await comparePeriods(
      client,
      {
        period_a_start: "2026-09-10",
        period_a_end: "2026-09-16T13:00:00Z",
        period_b_start: "2026-09-16T13:00:00Z",
        period_b_end: "2026-09-20T00:00:00+02:00",
      },
      NOW
    );

    expect(result.period_a).toMatchObject({ first_day: "2026-09-10", last_day: "2026-09-16" });
    expect(result.period_b).toMatchObject({ first_day: "2026-09-17", last_day: "2026-09-19" });
    expect(result.recovery.period_a_n).toBe(7);
    expect(result.recovery.period_b_n).toBe(0);
  });

  it("snaps a future end on a later day to the nearest local midnight", async () => {
    const { client } = fakeWhoop(dayOfMonthHistory(OFFSET));

    const result = await comparePeriods(
      client,
      {
        period_a_start: "2026-09-07T00:00:00Z",
        period_a_end: "2026-09-14T00:00:00Z",
        period_b_start: "2026-09-14T00:00:00Z",
        period_b_end: "2026-09-21T00:00:00Z",
      },
      NOW
    );

    expect(result.period_b).toMatchObject({ first_day: "2026-09-14", last_day: "2026-09-20" });
    expect(result.recovery.period_b_n).toBe(3);
  });
});

describe("comparePeriods — comparison math", () => {
  function twoPeriods(
    a: Partial<DaySpec>,
    b: Partial<DaySpec>,
    count = MIN_SAMPLES_PER_PERIOD
  ): History {
    const aDays = dayRange("2026-09-01", "2026-09-10").slice(0, count);
    const bDays = dayRange("2026-09-11", "2026-09-20").slice(0, count);
    return buildHistory(
      [...aDays.map((day) => ({ ...a, day })), ...bDays.map((day) => ({ ...b, day }))],
      false
    );
  }
  const periods: ComparePeriodsParams = {
    period_a_start: "2026-09-01",
    period_a_end: "2026-09-10",
    period_b_start: "2026-09-11",
    period_b_end: "2026-09-20",
  };

  it("computes percentage change and 'improved' with enough samples", async () => {
    const { client } = fakeWhoop(twoPeriods({ recovery: 60 }, { recovery: 80 }));

    const result = await comparePeriods(client, periods, NOW);

    expect(result.recovery.period_a_avg).toBe(60);
    expect(result.recovery.period_b_avg).toBe(80);
    expect(result.recovery.change_pct).toBe(33.3);
    expect(result.recovery.direction).toBe("improved");
    expect(result.notes).toEqual([
      "Not enough data yet to compare training: period A has 3 worn days and period B has 3; at least 7 per period are needed.",
    ]);
  });

  it("identifies 'declined'", async () => {
    const { client } = fakeWhoop(twoPeriods({ recovery: 80 }, { recovery: 60 }));

    const result = await comparePeriods(client, periods, NOW);

    expect(result.recovery.change_pct).toBe(-25);
    expect(result.recovery.direction).toBe("declined");
  });

  it("uses a ±5% threshold for 'unchanged'", async () => {
    const { client } = fakeWhoop(twoPeriods({ recovery: 80 }, { recovery: 82 }));

    const result = await comparePeriods(client, periods, NOW);

    expect(result.recovery.change_pct).toBe(2.5);
    expect(result.recovery.direction).toBe("unchanged");
  });

  it("computes strain direction as increased/decreased", async () => {
    const up = await comparePeriods(
      fakeWhoop(twoPeriods({ strain: 10 }, { strain: 15 })).client,
      periods,
      NOW
    );
    const down = await comparePeriods(
      fakeWhoop(twoPeriods({ strain: 15 }, { strain: 10 })).client,
      periods,
      NOW
    );

    expect(up.strain).toMatchObject({ period_a_avg: 10, period_b_avg: 15, change_pct: 50 });
    expect(up.strain.direction).toBe("increased");
    expect(down.strain.direction).toBe("decreased");
  });

  it("compares sleep hours with different period lengths", async () => {
    const history = buildHistory(
      [
        ...dayRange("2026-09-01", "2026-09-07").map((day) => ({ day, asleepHours: 8 })),
        ...dayRange("2026-09-08", "2026-09-21").map((day) => ({ day, asleepHours: 7 })),
      ],
      false
    );
    const { client } = fakeWhoop(history);

    const result = await comparePeriods(
      client,
      {
        period_a_start: "2026-09-01",
        period_a_end: "2026-09-07",
        period_b_start: "2026-09-08",
        period_b_end: "2026-09-21",
      },
      NOW
    );

    expect(result.sleep).toEqual({
      period_a_avg_hours: 8,
      period_b_avg_hours: 7,
      period_a_n: 7,
      period_b_n: 14,
      change_pct: -12.5,
      direction: "declined",
    });
  });

  it("keeps averages but reports no change below the minimum sample size", async () => {
    const { client } = fakeWhoop(twoPeriods({ recovery: 50 }, { recovery: 90 }, 2));

    const result = await comparePeriods(client, periods, NOW);

    expect(result.recovery).toMatchObject({
      period_a_avg: 50,
      period_b_avg: 90,
      period_a_n: 2,
      period_b_n: 2,
      change_pct: null,
      direction: "insufficient_data",
    });
    expect(result.notes).toContain(
      "Not enough data yet to compare recovery: period A has 2 scored recoveries and period B has 2; at least 3 per period are needed."
    );
  });

  it("ignores unscored and pending recoveries", async () => {
    const history = twoPeriods({ recovery: 80 }, { recovery: 80 }, 4);
    history.recoveries[0] = {
      ...history.recoveries[0]!,
      score_state: "PENDING_SCORE",
      score: null,
    };
    const { client } = fakeWhoop(history);

    const result = await comparePeriods(client, periods, NOW);

    expect(result.recovery.period_a_n).toBe(3);
    expect(result.recovery.period_b_n).toBe(4);
    expect(result.recovery.period_a_avg).toBe(80);
  });

  it("includes calibrating recoveries and counts them", async () => {
    const history = twoPeriods({ recovery: 60 }, { recovery: 60, calibrating: true });
    const { client } = fakeWhoop(history);

    const result = await comparePeriods(client, periods, NOW);

    expect(result.recovery.period_b_n).toBe(3);
    expect(result.recovery.period_b_calibrating_n).toBe(3);
    expect(result.recovery.direction).toBe("unchanged");
    expect(result.notes).toContain(
      "WHOOP was still calibrating for 3 of 3 recoveries in period B; they are included, but calibrating recovery scores are less reliable."
    );
  });
});

describe("comparePeriods — date validation", () => {
  const empty = (): WhoopClient => fakeWhoop({ cycles: [], sleeps: [], recoveries: [] }).client;

  it("rejects a reversed period locally without calling WHOOP for data", async () => {
    const { client, paths } = fakeWhoop(calibratingUser());

    const promise = comparePeriods(
      client,
      { ...SPARSE_PERIODS, period_b_start: "2026-09-16", period_b_end: "2026-09-14" },
      NOW
    );

    await expect(promise).rejects.toBeInstanceOf(InvalidDateExpression);
    await expect(promise).rejects.toThrow(/end of period B must be after its start/);
    expect(paths.filter((path) => path.includes("start="))).toHaveLength(0);
  });

  it("rejects a date-time period whose end equals its start", async () => {
    await expect(
      comparePeriods(
        empty(),
        {
          ...SPARSE_PERIODS,
          period_a_start: "2026-09-07T10:00:00Z",
          period_a_end: "2026-09-07T10:00:00Z",
        },
        NOW
      )
    ).rejects.toThrow(/period_a_end "2026-09-07T10:00:00Z"/);
  });

  it("accepts a single local day given as the same start and end date", async () => {
    const result = await comparePeriods(
      empty(),
      { ...SPARSE_PERIODS, period_b_start: "2026-09-15", period_b_end: "2026-09-15" },
      NOW
    );

    expect(result.period_b.days).toBe(1);
  });

  it("allows 90 whole days of date-only input and rejects 91", async () => {
    const ninety = await comparePeriods(
      empty(),
      { ...SPARSE_PERIODS, period_a_start: "2026-06-01", period_a_end: "2026-08-29" },
      NOW
    );
    expect(ninety.period_a.days).toBe(90);

    await expect(
      comparePeriods(
        empty(),
        { ...SPARSE_PERIODS, period_a_start: "2026-06-01", period_a_end: "2026-08-30" },
        NOW
      )
    ).rejects.toThrow("Period A spans 91 days; each period can cover at most 90 days.");
  });

  it("rejects periods longer than 90 days given as date-times", async () => {
    await expect(
      comparePeriods(
        empty(),
        {
          period_a_start: "2026-01-01T00:00:00.000Z",
          period_a_end: "2026-05-01T00:00:00.000Z",
          period_b_start: "2026-05-02T00:00:00.000Z",
          period_b_end: "2026-05-08T00:00:00.000Z",
        },
        NOW
      )
    ).rejects.toThrow("90 days");
  });

  it("rejects overlapping periods, including date-only periods that share a day", async () => {
    await expect(
      comparePeriods(
        empty(),
        {
          period_a_start: "2026-05-01T00:00:00.000Z",
          period_a_end: "2026-05-10T23:59:59.999Z",
          period_b_start: "2026-05-08T00:00:00.000Z",
          period_b_end: "2026-05-14T23:59:59.999Z",
        },
        NOW
      )
    ).rejects.toThrow("overlap");
    await expect(
      comparePeriods(empty(), { ...SPARSE_PERIODS, period_a_end: "2026-09-14" }, NOW)
    ).rejects.toBeInstanceOf(InvalidDateExpression);
  });

  it("rejects impossible calendar dates", async () => {
    await expect(
      comparePeriods(empty(), { ...SPARSE_PERIODS, period_a_start: "2026-02-30" }, NOW)
    ).rejects.toBeInstanceOf(InvalidDateExpression);
  });

  it("resolves relative expressions in the user's offset", async () => {
    const result = await comparePeriods(
      fakeWhoop(calibratingUser()).client,
      {
        period_a_start: "last week",
        period_a_end: "last week",
        period_b_start: "this week",
        period_b_end: "today",
      },
      NOW
    );

    expect(result.period_a).toEqual({
      start: "2026-09-07T00:00:00.000+02:00",
      end: "2026-09-13T23:59:59.999+02:00",
      days: 7,
      first_day: "2026-09-07",
      last_day: "2026-09-13",
    });
    expect(result.period_b.start).toBe("2026-09-14T00:00:00.000+02:00");
    expect(result.period_b.end).toBe("2026-09-16T23:59:59.999+02:00");
  });

  it("uses the user's offset from the latest cycle and falls back to UTC days", async () => {
    const offline = fakeWhoop(
      { cycles: [], sleeps: [], recoveries: [] },
      { fail: (path) => (path.endsWith("limit=1") ? new WhoopApiError(500, "", null) : undefined) }
    ).client;

    const result = await comparePeriods(offline, SPARSE_PERIODS, NOW);

    expect(result.period_a.start).toBe("2026-09-07T00:00:00.000Z");
    expect(result.period_a.end).toBe("2026-09-13T23:59:59.999Z");
  });
});

describe("comparePeriods — fetching", () => {
  it("fetches recovery, sleep and cycle for each period after one offset lookup", async () => {
    const { client, paths } = fakeWhoop(calibratingUser());

    await comparePeriods(client, SPARSE_PERIODS, NOW);

    expect(paths.map((path) => path.split("?")[0])).toEqual([
      "/v2/cycle",
      "/v2/recovery",
      "/v2/activity/sleep",
      "/v2/cycle",
      "/v2/activity/workout",
      "/v2/recovery",
      "/v2/activity/sleep",
      "/v2/cycle",
      "/v2/activity/workout",
    ]);
  });

  it("surfaces truncation when a source hits the record cap", async () => {
    let served = 0;
    const endless: WhoopClient = {
      get: async <T>(path: string): Promise<T> => {
        if (!path.startsWith("/v2/recovery") || !path.includes("start=")) {
          return { records: [], next_token: null } as T;
        }
        const records = Array.from({ length: 25 }, () => {
          served += 1;
          return {
            cycle_id: served,
            sleep_id: `sleep-${served}`,
            user_id: 100,
            created_at: "2026-09-10T05:10:00.000Z",
            updated_at: "2026-09-10T05:10:00.000Z",
            score_state: "SCORED",
            score: {
              user_calibrating: false,
              recovery_score: 50,
              resting_heart_rate: 55,
              hrv_rmssd_milli: 60,
            },
          };
        });
        return { records, next_token: "more" } as T;
      },
    };

    const result = await comparePeriods(endless, SPARSE_PERIODS, NOW);

    expect(result.truncated).toBe(true);
    expect(result.warnings).toContain(
      "Recovery data for period A reached the 500-record limit, so the oldest records of that period are not included."
    );
    expect(outputSchemas.compare_periods!.safeParse(result).success).toBe(true);
  });

  it("degrades to a warning when one source fails", async () => {
    const history = buildHistory(dayRange("2026-09-01", "2026-09-16").map((day) => ({ day })));
    let sleepCalls = 0;
    const { client } = fakeWhoop(history, {
      fail: (path) => {
        if (!path.startsWith("/v2/activity/sleep")) return undefined;
        sleepCalls += 1;
        return sleepCalls === 2 ? new WhoopApiError(429, "Too Many Requests", null) : undefined;
      },
    });

    const result = await comparePeriods(
      client,
      {
        period_a_start: "2026-09-01",
        period_a_end: "2026-09-07",
        period_b_start: "2026-09-08",
        period_b_end: "2026-09-14",
      },
      NOW
    );

    expect(result.warnings).toEqual([
      "Sleep data for period B could not be loaded (WHOOP API returned 429), so that period has no sleep samples.",
    ]);
    expect(result.sleep.period_b_avg_hours).toBeNull();
    expect(result.sleep.direction).toBe("insufficient_data");
    expect(result.recovery.direction).toBe("unchanged");
    expect(result.strain.period_b_n).toBe(7);
  });

  it("rethrows the WHOOP error when every source fails", async () => {
    const { client } = fakeWhoop(calibratingUser(), {
      fail: (path) => (path.includes("start=") ? new WhoopApiError(503, "", null) : undefined),
    });

    await expect(comparePeriods(client, SPARSE_PERIODS, NOW)).rejects.toBeInstanceOf(WhoopApiError);
  });

  it("rethrows authentication errors immediately", async () => {
    const { client, paths } = fakeWhoop(calibratingUser(), {
      fail: (path) => (path.includes("start=") ? new WhoopAuthError(new Error("x")) : undefined),
    });

    await expect(comparePeriods(client, SPARSE_PERIODS, NOW)).rejects.toBeInstanceOf(
      WhoopAuthError
    );
    expect(paths.filter((path) => path.includes("start="))).toHaveLength(1);
  });

  it("skips records that do not match the WHOOP format with a warning", async () => {
    const { client } = fakeWhoop(calibratingUser(), {
      extra: { cycle: [{ id: "not-a-cycle" }] },
    });

    const result = await comparePeriods(client, SPARSE_PERIODS, NOW);

    expect(result.warnings).toContain(
      "1 record of cycle (strain) data for period A did not match the expected WHOOP format and was skipped."
    );
    expect(result.strain.period_b_avg).toBe(8.2);
  });
});

describe("compare_periods over MCP", () => {
  async function callTool(
    privacyMode: "standard" | "aggregate",
    args: ComparePeriodsParams
  ): Promise<Awaited<ReturnType<Client["callTool"]>>> {
    const { server } = createWhoopServer(fakeWhoop(calibratingUser()).client, { privacyMode });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "compare-test", version: "1.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      return await client.callTool({ name: "compare_periods", arguments: { ...args } });
    } finally {
      await client.close();
      await server.close();
    }
  }

  it.each(["standard", "aggregate"] as const)(
    "returns a contract-valid result for date-only input in %s mode",
    async (privacyMode) => {
      const result = await callTool(privacyMode, SPARSE_PERIODS);

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as {
        recovery: { direction: string; period_a_avg: number | null };
        notes: string[];
      };
      expect(structured.recovery.direction).toBe("insufficient_data");
      expect(structured.recovery.period_a_avg).toBeNull();
      expect(structured.notes.length).toBeGreaterThan(0);
    }
  );

  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives single days no values in aggregate mode (no whole released week) but not in standard mode", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const oneDayEach = {
      period_a_start: "2026-09-15",
      period_a_end: "2026-09-15",
      period_b_start: "2026-09-16",
      period_b_end: "2026-09-16",
    };
    type Result = {
      period_a: Record<string, unknown>;
      recovery: { period_a_avg: number | null; period_b_avg: number | null; period_a_n: number };
      sleep: { period_a_avg_hours: number | null; period_b_avg_hours: number | null };
      strain: { period_a_avg: number | null };
      notes: string[];
    };

    const aggregate = (await callTool("aggregate", oneDayEach)).structuredContent as Result;
    expect(aggregate.recovery).toMatchObject({ period_a_avg: null, period_b_avg: null });
    expect(aggregate.recovery.period_a_n).toBe(0);
    expect(aggregate.sleep).toMatchObject({ period_a_avg_hours: null, period_b_avg_hours: null });
    expect(aggregate.strain.period_a_avg).toBeNull();
    expect(aggregate.period_a).toMatchObject({ start: null, end: null, days: 0 });
    expect(aggregate.notes).toContain(
      "Period A contains no whole released week (Monday to Sunday, released two days after it ends), so it has no values in aggregate privacy mode."
    );
    expect(aggregate.notes).toContain(
      "Cannot compare recovery: period A and period B have no whole released week."
    );
    expect(aggregate).not.toHaveProperty("training");

    const standard = (await callTool("standard", oneDayEach)).structuredContent as Result;
    expect(standard.recovery).toMatchObject({ period_a_avg: 61, period_b_avg: 70 });
  });

  it("labels aggregate periods with the whole released weeks inside them, not the raw bounds", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const result = await callTool("aggregate", {
      period_a_start: "2026-08-19",
      period_a_end: "2026-09-02",
      // Counted days 09-04..09-15: only the week 09-07..09-13 is whole and released
      period_b_start: "2026-09-03T12:00:00+02:00",
      period_b_end: "2026-09-16",
    });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      period_a: Record<string, unknown>;
      period_b: Record<string, unknown>;
      notes: string[];
    };
    expect(structured.period_a).toEqual({
      start: "2026-08-24",
      end: "2026-08-30",
      days: 7,
      first_day: "2026-08-24",
      last_day: "2026-08-30",
    });
    expect(structured.period_b).toEqual({
      start: "2026-09-07",
      end: "2026-09-13",
      days: 7,
      first_day: "2026-09-07",
      last_day: "2026-09-13",
    });
    expect(structured.notes).toEqual(
      expect.arrayContaining([
        "Aggregate privacy mode uses whole released weeks: 1 week ending 2026-08-30 for period A.",
        "Aggregate privacy mode uses whole released weeks: 1 week ending 2026-09-13 for period B.",
      ])
    );
  });

  it("checks overlap after snapping to released weeks in aggregate mode", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    // The raw periods share 08-24..08-26, but their whole weeks do not overlap.
    const apart = await callTool("aggregate", {
      period_a_start: "2026-08-10",
      period_a_end: "2026-08-26",
      period_b_start: "2026-08-24",
      period_b_end: "2026-09-06",
    });
    expect(apart.isError).toBeFalsy();
    expect(
      (apart.structuredContent as { period_b: { first_day: string } }).period_b.first_day
    ).toBe("2026-08-24");

    const shared = await callTool("aggregate", {
      period_a_start: "2026-08-10",
      period_a_end: "2026-08-30",
      period_b_start: "2026-08-24",
      period_b_end: "2026-09-06",
    });
    expect(shared.isError).toBe(true);
    const content = shared.content as Array<{ type: string; text: string }>;
    expect(content[0]!.text).toMatch(/share the week starting 2026-08-24/);
  });

  it("returns the local validation message for a reversed period", async () => {
    const result = await callTool("standard", {
      ...SPARSE_PERIODS,
      period_a_start: "2026-09-13",
      period_a_end: "2026-09-07",
    });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]!.text).toMatch(/end of period A must be after its start/);
  });
});

// ---------------------------------------------------------------------------
// Training block
// ---------------------------------------------------------------------------

interface ExpectedTraining {
  sessions: number;
  worn_days: number;
  minutes: number;
  trimpDays: number[];
  afterMidnight: number;
}

/**
 * Training totals computed independently from the whole fixture: workouts on
 * the placed day of their cycle, TRIMP as zone minutes weighted 1-5, days with
 * a workout recorded below 90% or not scored left out of the TRIMP mean.
 */
function expectedTraining(data: WhoopUserFixture, first: string, last: string): ExpectedTraining {
  const today = new Date(data.now.getTime() + 60 * 60_000).toISOString().slice(0, 10);
  const placement = placeDays({
    cycles: data.cycles,
    sleeps: data.sleeps,
    recoveries: data.recoveries,
    sleepsAvailable: true,
    today,
    utcOffset: data.offset,
  });
  const placed = assignWorkouts(data.workouts, placement, data.cycles);
  const result: ExpectedTraining = {
    sessions: 0,
    worn_days: 0,
    minutes: 0,
    trimpDays: [],
    afterMidnight: 0,
  };
  for (
    let ms = Date.parse(`${first}T00:00:00Z`);
    ms <= Date.parse(`${last}T00:00:00Z`);
    ms += DAY_MS
  ) {
    const day = new Date(ms).toISOString().slice(0, 10);
    if (!placement.cycleByDay.has(day)) continue;
    result.worn_days += 1;
    let trimp = 0;
    let known = true;
    for (const workout of data.workouts) {
      const placement = placed.get(workout.id)!;
      if (placement.day !== day) continue;
      if (workout.score_state !== "SCORED" || !workout.score) {
        known = false;
        continue;
      }
      result.sessions += 1;
      if (placement.after_midnight_in_previous_cycle) result.afterMidnight += 1;
      result.minutes += (Date.parse(workout.end) - Date.parse(workout.start)) / 60_000;
      const zones = workout.score.zone_durations;
      trimp +=
        (zones.zone_one_milli +
          2 * zones.zone_two_milli +
          3 * zones.zone_three_milli +
          4 * zones.zone_four_milli +
          5 * zones.zone_five_milli) /
        60_000;
      if (workout.score.percent_recorded < 0.9) known = false;
    }
    if (known) result.trimpDays.push(trimp);
  }
  return result;
}

const round = (value: number, digits: number): number =>
  Math.round(value * 10 ** digits) / 10 ** digits;

describe("comparePeriods — training", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const A = { first: "2026-08-17", last: "2026-08-30" };
  const B = { first: "2026-08-31", last: "2026-09-13" };

  async function compare(
    data: WhoopUserFixture,
    periods: ComparePeriodsParams,
    failures: FixtureFailure[] = []
  ): Promise<Awaited<ReturnType<typeof comparePeriods>>> {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(data.now);
    return comparePeriods(createWhoopFixtureClient({ ...data, failures }), periods, data.now);
  }

  it("compares sessions, minutes and TRIMP per worn day for two 14-day periods of a mature account", async () => {
    const data = matureUser();
    const result = await compare(data, {
      period_a_start: A.first,
      period_a_end: A.last,
      period_b_start: B.first,
      period_b_end: B.last,
    });

    const a = expectedTraining(data, A.first, A.last);
    const b = expectedTraining(data, B.first, B.last);
    const mean = (values: number[]): number =>
      values.reduce((sum, value) => sum + value, 0) / values.length;
    expect(a.worn_days).toBe(14);
    expect(result.training).toEqual({
      period_a: {
        sessions: a.sessions,
        worn_days: a.worn_days,
        sessions_per_week: round((a.sessions / a.worn_days) * 7, 2),
        workout_minutes_per_worn_day: round(a.minutes / a.worn_days, 1),
        trimp_per_worn_day: round(mean(a.trimpDays), 1),
      },
      period_b: {
        sessions: b.sessions,
        worn_days: b.worn_days,
        sessions_per_week: round((b.sessions / b.worn_days) * 7, 2),
        workout_minutes_per_worn_day: round(b.minutes / b.worn_days, 1),
        trimp_per_worn_day: round(mean(b.trimpDays), 1),
      },
      change_pct: {
        sessions_per_week: expect.any(Number),
        workout_minutes_per_worn_day: expect.any(Number),
        trimp_per_worn_day: round(
          ((mean(b.trimpDays) - mean(a.trimpDays)) / mean(a.trimpDays)) * 100,
          1
        ),
      },
      direction: expect.stringMatching(/^(increased|decreased|unchanged)$/),
    });
    const change = ((mean(b.trimpDays) - mean(a.trimpDays)) / mean(a.trimpDays)) * 100;
    expect(result.training!.direction).toBe(
      Math.abs(change) <= 5 ? "unchanged" : change > 0 ? "increased" : "decreased"
    );
    // Days with a workout recorded below 90% are counted in a note, never as 0.
    const leftOut = a.worn_days - a.trimpDays.length;
    if (leftOut)
      expect(result.notes).toContainEqual(
        expect.stringMatching(/in period A had a workout recorded below 90% or not scored/)
      );
    assertNeutralText(result);
  });

  it("counts an after-midnight workout on the last day of a period through the extended fetch window", async () => {
    const data = matureUser();
    const today = "2026-09-16";
    const placement = placeDays({
      cycles: data.cycles,
      sleeps: data.sleeps,
      recoveries: data.recoveries,
      sleepsAvailable: true,
      today,
      utcOffset: data.offset,
    });
    const placed = assignWorkouts(data.workouts, placement, data.cycles);
    const late = data.workouts
      .map((workout) => placed.get(workout.id)!)
      .filter((entry) => entry.after_midnight_in_previous_cycle && entry.day < "2026-09-10")
      .sort((left, right) => (left.day < right.day ? 1 : -1))[0]!;
    const first = new Date(Date.parse(`${late.day}T00:00:00Z`) - 13 * DAY_MS)
      .toISOString()
      .slice(0, 10);
    const result = await compare(data, {
      period_a_start: "2026-06-01",
      period_a_end: "2026-06-14",
      period_b_start: first,
      period_b_end: late.day,
    });

    const expected = expectedTraining(data, first, late.day);
    expect(expected.afterMidnight).toBeGreaterThan(0);
    expect(result.training?.period_b.sessions).toBe(expected.sessions);
  });

  it("reports insufficient data below 7 worn days in either period", async () => {
    const data = matureUser();
    const result = await compare(data, {
      period_a_start: "2026-08-17",
      period_a_end: "2026-08-21",
      period_b_start: "2026-08-31",
      period_b_end: "2026-09-13",
    });

    expect(result.training).toMatchObject({
      period_a: {
        worn_days: 5,
        sessions_per_week: null,
        workout_minutes_per_worn_day: null,
        trimp_per_worn_day: null,
      },
      period_b: { worn_days: 14, sessions_per_week: null, trimp_per_worn_day: null },
      change_pct: {
        sessions_per_week: null,
        workout_minutes_per_worn_day: null,
        trimp_per_worn_day: null,
      },
      direction: "insufficient_data",
    });
    expect(result.notes).toContain(
      "Not enough data yet to compare training: period A has 5 worn days and period B has 14; at least 7 per period are needed."
    );
  });

  it("nulls only the training block, with a warning, when workouts cannot be loaded", async () => {
    const data = matureUser();
    const periods = {
      period_a_start: A.first,
      period_a_end: A.last,
      period_b_start: B.first,
      period_b_end: B.last,
    };
    const healthy = await compare(data, periods);
    const failed = await compare(data, periods, [
      { path: /^\/v2\/activity\/workout/, error: new WhoopApiError(503, "Unavailable", null) },
    ]);

    expect(failed.training).toBeNull();
    expect(failed.warnings).toEqual([
      "Workout data for period A could not be loaded (WHOOP API returned 503), so training is not compared.",
      "Workout data for period B could not be loaded (WHOOP API returned 503), so training is not compared.",
    ]);
    expect(failed.recovery).toEqual(healthy.recovery);
    expect(failed.sleep).toEqual(healthy.sleep);
    expect(failed.strain).toEqual(healthy.strain);
  });

  it("does not throw when the workout scope is missing (authorization error on workouts only)", async () => {
    const data = matureUser();
    const result = await compare(
      data,
      {
        period_a_start: A.first,
        period_a_end: A.last,
        period_b_start: B.first,
        period_b_end: B.last,
      },
      [{ path: /^\/v2\/activity\/workout/, error: new WhoopAuthError(new Error("scope")) }]
    );

    expect(result.training).toBeNull();
    expect(result.recovery.period_a_n).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Shared fixture users, both privacy modes
// ---------------------------------------------------------------------------

describe("compare_periods on the shared fixture users", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  async function call(
    data: WhoopUserFixture,
    privacyMode: "standard" | "aggregate",
    args: ComparePeriodsParams
  ): Promise<{ isError: boolean; text: string; structured: Record<string, unknown> | null }> {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(data.now);
    const connection = await connectServer(createWhoopFixtureClient(data), {
      privacyMode,
      disableResources: true,
    });
    try {
      return await connection.callTool("compare_periods", { ...args });
    } finally {
      await connection.close();
    }
  }

  it("reports the live-shaped user's first days with a training block and neutral notes", async () => {
    const result = await call(liveShapedUser(), "standard", SPARSE_PERIODS);
    expect(result.isError, result.text).toBe(false);
    expect(result.structured?.training).toMatchObject({
      period_a: { sessions: 0, worn_days: 0 },
      period_b: { sessions: 8, worn_days: 3 },
      direction: "insufficient_data",
    });
    assertNeutralText(result.structured);
  });

  it("snaps a mature account's months to released weeks with rounded averages in aggregate mode", async () => {
    const result = await call(matureUser(), "aggregate", {
      period_a_start: "2026-07-01",
      period_a_end: "2026-07-31",
      period_b_start: "2026-08-15",
      period_b_end: "2026-09-16",
    });
    expect(result.isError, result.text).toBe(false);
    const structured = result.structured as {
      period_a: Record<string, unknown>;
      period_b: Record<string, unknown>;
      recovery: Record<string, number | null>;
      sleep: Record<string, number | null>;
      strain: Record<string, number | null>;
    };
    expect(structured.period_a).toMatchObject({ first_day: "2026-07-06", last_day: "2026-07-26" });
    // 09-14..09-16 are not released yet, so period B ends with the week of 09-07.
    expect(structured.period_b).toMatchObject({ first_day: "2026-08-17", last_day: "2026-09-13" });
    expect(structured).not.toHaveProperty("training");
    expect(Number.isInteger(structured.recovery.period_a_avg)).toBe(true);
    expect(Number.isInteger(structured.recovery.change_pct)).toBe(true);
    expect(round(structured.sleep.period_b_avg_hours!, 1)).toBe(
      structured.sleep.period_b_avg_hours
    );
    // Whole weeks only: every count is a sum of weeks with at least 3 samples.
    expect(Number(structured.recovery.period_b_n)).toBe(28);
    expect(result.text).not.toMatch(/T\d{2}:\d{2}/);
    assertNeutralText(result.structured);
  });

  it("stays within the text size limit for two 90-day periods on the stress user in both modes", async () => {
    for (const mode of ["standard", "aggregate"] as const) {
      const result = await call(stressUser(), mode, {
        period_a_start: "2026-03-20",
        period_a_end: "2026-06-17",
        period_b_start: "2026-06-18",
        period_b_end: "2026-09-15",
      });
      expect(result.isError, result.text.slice(0, 300)).toBe(false);
      expect(result.text.length).toBeLessThan(MAX_TOOL_TEXT_CHARS);
    }
  });
});
