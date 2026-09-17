/**
 * Aggregate privacy mode must not reveal individual records.
 *
 * A live-shaped +02:00 user with at most 3 records per metric is served
 * through createWhoopServer in aggregate mode. No numeric output other than
 * counts may equal any single input value (or a per-record value derived from
 * one, such as a night's hours asleep), and the only dates are period labels.
 *
 * Aggregate outputs use only whole released local weeks (released two days
 * after they end), each week final and holding at least 3 samples of a
 * metric. The tests reproduce the single-day differencing attack, brute-force
 * the argument grid of every aggregate tool on a 120-day account, move the
 * clock through a whole release week, and check week gating and source counts.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { WhoopClient } from "../src/api/client.js";
import type { Cycle, Sleep, Workout } from "../src/api/types.js";
import { createWhoopServer } from "../src/server.js";
import {
  AGGREGATE_WEEK_MIN_SAMPLES,
  AGGREGATE_WORKOUT_KJ_STEP,
  AGGREGATE_WORKOUT_STRAIN_STEP,
  roundStep,
} from "../src/tools/aggregate-window.js";
import { addDays, assignWorkouts, placeDays } from "../src/tools/day-model.js";
import { WEEK_NOT_RELEASED_NOTE } from "../src/tools/get-weekly-summary.js";
import {
  AGGREGATE_MIN_SAMPLES,
  AGGREGATE_MIN_TREND_POINTS,
  aggregateOutputSchemas,
  projectAggregate,
} from "../src/tools/output-contracts.js";
import { assertNeutralText, connectServer, type ContractConnection } from "./helpers/contract.js";
import { createWhoopFixtureClient } from "./helpers/whoop-fixture-client.js";
import { matureUser, type WhoopUserFixture } from "./helpers/whoop-users.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date("2026-09-16T10:00:00.000Z"); // 12:00 local at +02:00
const iso = (ms: number): string => new Date(ms).toISOString();

interface Fixture {
  cycles: Array<Record<string, unknown>>;
  sleeps: Array<Record<string, unknown>>;
  recoveries: Array<Record<string, unknown>>;
  workouts: Array<Record<string, unknown>>;
}

interface NightSpec {
  day: string;
  cycleStrain: number;
  cycleKj: number;
  avgHr: number;
  maxHr: number;
  light: number;
  slowWave: number;
  rem: number;
  awake: number;
  strainNeed: number;
  debtNeed: number;
  respiratory: number;
  performance: number;
  efficiency: number;
  recovery: number;
  rhr: number;
  hrv: number;
  spo2: number;
  skinTemp: number;
  calibrating: boolean;
}

// Three wake-up days; the last cycle is still open, so only two cycles are complete. Values are
// chosen so that rounded averages of the three nights never equal a single night's value.
const NIGHTS: NightSpec[] = [
  {
    day: "2026-09-14",
    cycleStrain: 9.6,
    cycleKj: 8123,
    avgHr: 68,
    maxHr: 152,
    light: 11_700_000,
    slowWave: 5_400_000,
    rem: 6_300_000,
    awake: 1_800_000,
    strainNeed: 900_000,
    debtNeed: 1_800_000,
    respiratory: 15.1,
    performance: 80,
    efficiency: 94,
    recovery: 44,
    rhr: 64,
    hrv: 38.9,
    spo2: 95.2,
    skinTemp: 33.4,
    calibrating: true,
  },
  {
    day: "2026-09-15",
    cycleStrain: 15.4,
    cycleKj: 11234,
    avgHr: 75,
    maxHr: 171,
    light: 13_000_000,
    slowWave: 6_100_000,
    rem: 7_000_000,
    awake: 1_500_000,
    strainNeed: 1_260_000,
    debtNeed: 2_700_000,
    respiratory: 14.6,
    performance: 74,
    efficiency: 86,
    recovery: 71,
    rhr: 57,
    hrv: 61.3,
    spo2: 96.1,
    skinTemp: 33.9,
    calibrating: true,
  },
  {
    day: "2026-09-16",
    cycleStrain: 4.3,
    cycleKj: 3100,
    avgHr: 62,
    maxHr: 118,
    light: 12_480_000,
    slowWave: 5_700_000,
    rem: 6_300_000,
    awake: 2_100_000,
    strainNeed: 540_000,
    debtNeed: 1_500_000,
    respiratory: 15.8,
    performance: 93,
    efficiency: 81,
    recovery: 61,
    rhr: 63,
    hrv: 52.1,
    spo2: 94.8,
    skinTemp: 33.1,
    calibrating: false,
  },
];
const BASELINE_NEED = 28_800_000;

/** Onset 23:00 local the evening before `day`, at the given offset. */
function onsetMs(day: string, offsetHours: number): number {
  return Date.parse(`${day}T00:00:00.000Z`) - offsetHours * HOUR - HOUR;
}

function shiftDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + days * DAY).toISOString().slice(0, 10);
}

/**
 * The three nights of NIGHTS, optionally moved by `shiftDays` (e.g. -7 into the
 * released week of 2026-09-07) with the last cycle closed.
 */
function buildFixture(
  offset = "+02:00",
  offsetHours = 2,
  options: { shiftDays?: number; closeLast?: boolean } = {}
): Fixture {
  const fixture: Fixture = { cycles: [], sleeps: [], recoveries: [], workouts: [] };
  const shift = options.shiftDays ?? 0;
  NIGHTS.map((night) => ({ ...night, day: shiftDay(night.day, shift) })).forEach((night, index) => {
    const onset = onsetMs(night.day, offsetHours);
    const isLast = index === NIGHTS.length - 1 && !options.closeLast;
    const cycleId = 900 + index;
    const sleepId = `sleep-${night.day}`;
    const asleep = night.light + night.slowWave + night.rem;
    const wake = onset + asleep + night.awake;
    fixture.cycles.push({
      id: cycleId,
      user_id: 7,
      created_at: iso(onset),
      updated_at: iso(isLast ? Math.min(NOW.getTime(), onset + DAY) : onset + DAY),
      start: iso(onset),
      end: isLast ? null : iso(onset + DAY),
      timezone_offset: offset,
      score_state: "SCORED",
      score: {
        strain: night.cycleStrain,
        kilojoule: night.cycleKj,
        average_heart_rate: night.avgHr,
        max_heart_rate: night.maxHr,
      },
    });
    fixture.sleeps.push({
      id: sleepId,
      cycle_id: cycleId,
      v1_id: null,
      user_id: 7,
      created_at: iso(wake),
      updated_at: iso(wake),
      start: iso(onset),
      end: iso(wake),
      timezone_offset: offset,
      nap: false,
      score_state: "SCORED",
      score: {
        stage_summary: {
          total_in_bed_time_milli: asleep + night.awake,
          total_awake_time_milli: night.awake,
          total_no_data_time_milli: 0,
          total_light_sleep_time_milli: night.light,
          total_slow_wave_sleep_time_milli: night.slowWave,
          total_rem_sleep_time_milli: night.rem,
          sleep_cycle_count: 4 + index,
          disturbance_count: 7 + index,
        },
        sleep_needed: {
          baseline_milli: BASELINE_NEED,
          need_from_sleep_debt_milli: night.debtNeed,
          need_from_recent_strain_milli: night.strainNeed,
          need_from_recent_nap_milli: 0,
        },
        respiratory_rate: night.respiratory,
        sleep_performance_percentage: night.performance,
        sleep_consistency_percentage: null,
        sleep_efficiency_percentage: night.efficiency,
      },
    });
    fixture.recoveries.push({
      cycle_id: cycleId,
      sleep_id: sleepId,
      user_id: 7,
      created_at: iso(wake + 600_000),
      updated_at: iso(wake + 600_000),
      score_state: "SCORED",
      score: {
        user_calibrating: night.calibrating,
        recovery_score: night.recovery,
        resting_heart_rate: night.rhr,
        hrv_rmssd_milli: night.hrv,
        spo2_percentage: night.spo2,
        skin_temp_celsius: night.skinTemp,
      },
    });
  });
  const workout = (
    id: string,
    startMs: number,
    sport: string,
    score: Record<string, unknown>
  ): Record<string, unknown> => ({
    id,
    sport_name: sport,
    sport_id: 1,
    v1_id: null,
    user_id: 7,
    created_at: iso(startMs + 50 * 60_000),
    updated_at: iso(startMs + 50 * 60_000),
    start: iso(startMs),
    end: iso(startMs + 45 * 60_000),
    timezone_offset: offset,
    score_state: "SCORED",
    score,
  });
  fixture.workouts.push(
    workout("w-2", Date.parse("2026-09-15T15:00:00.000Z") + shift * DAY, "cycling", {
      strain: 7.8,
      average_heart_rate: 133,
      max_heart_rate: 158,
      kilojoule: 1320,
      percent_recorded: 0.98,
      zone_durations: {
        zone_zero_milli: 120_000,
        zone_one_milli: 480_000,
        zone_two_milli: 900_000,
        zone_three_milli: 720_000,
        zone_four_milli: 300_000,
        zone_five_milli: 180_000,
      },
      distance_meter: 18_450.5,
      altitude_gain_meter: 210.4,
      altitude_change_meter: 12.2,
    }),
    workout("w-1", Date.parse("2026-09-14T14:00:00.000Z") + shift * DAY, "running", {
      strain: 9.4,
      average_heart_rate: 141,
      max_heart_rate: 172,
      kilojoule: 1500,
      percent_recorded: 1,
      zone_durations: {
        zone_zero_milli: 60_000,
        zone_one_milli: 240_000,
        zone_two_milli: 840_000,
        zone_three_milli: 960_000,
        zone_four_milli: 420_000,
        zone_five_milli: 150_000,
      },
      distance_meter: 5012.3,
      altitude_gain_meter: null,
      altitude_change_meter: null,
    })
  );
  // Newest first, as WHOOP returns them
  for (const list of [fixture.cycles, fixture.sleeps, fixture.recoveries]) list.reverse();
  return fixture;
}

/** A WHOOP client serving the fixture like the live API (start/end filters, pagination). */
function fakeWhoop(fixture: Fixture): WhoopClient {
  const lists: Record<string, Array<Record<string, unknown>>> = {
    "/v2/cycle": fixture.cycles,
    "/v2/activity/sleep": fixture.sleeps,
    "/v2/recovery": fixture.recoveries,
    "/v2/activity/workout": fixture.workouts,
  };
  return {
    get: vi.fn(async (path: string) => {
      const [base, query] = path.split("?");
      const list = lists[base!];
      if (!list) throw new Error(`unexpected path ${path}`);
      const params = new URLSearchParams(query ?? "");
      const start = params.get("start") ? Date.parse(params.get("start")!) : -Infinity;
      const end = params.get("end") ? Date.parse(params.get("end")!) : Infinity;
      const matching = list.filter((record) => {
        const from = Date.parse(String(record.start ?? record.created_at));
        const to =
          record.start === undefined
            ? from
            : record.end === null
              ? Infinity
              : Date.parse(String(record.end));
        return to >= start && from < end;
      });
      const limit = Number(params.get("limit") ?? 10);
      const offset = Number(params.get("nextToken") ?? 0);
      return {
        records: matching.slice(offset, offset + limit),
        next_token: offset + limit < matching.length ? String(offset + limit) : null,
      };
    }),
  } as unknown as WhoopClient;
}

interface CallResult {
  isError?: boolean;
  structuredContent: Record<string, unknown>;
  text: string;
}

async function callAggregate(
  whoop: WhoopClient,
  name: string,
  args: Record<string, unknown>,
  now: Date = NOW,
  privacyMode: "standard" | "aggregate" = "aggregate"
): Promise<CallResult> {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  const { server } = createWhoopServer(whoop, { privacyMode, disableResources: true });
  const client = new Client({ name: "aggregate-privacy-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name, arguments: args });
    return {
      isError: result.isError as boolean | undefined,
      structuredContent: (result.structuredContent ?? {}) as Record<string, unknown>,
      text: (result.content as Array<{ text: string }>)[0]!.text,
    };
  } finally {
    await client.close();
    await server.close();
  }
}

afterEach(() => {
  vi.useRealTimers();
});

/** Every number in the fixture, plus per-record values derived from one record. */
function inputValues(fixture: Fixture): number[] {
  const values: number[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === "number") values.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") Object.values(value).forEach(collect);
  };
  collect([fixture.cycles, fixture.sleeps, fixture.recoveries, fixture.workouts]);
  for (const night of NIGHTS) {
    const asleepHours = (night.light + night.slowWave + night.rem) / HOUR;
    const neededHours = (BASELINE_NEED + night.strainNeed) / HOUR;
    values.push(
      asleepHours,
      (night.light + night.slowWave + night.rem + night.awake) / HOUR,
      night.debtNeed / HOUR,
      neededHours,
      neededHours - asleepHours
    );
  }
  // 0 and 1 carry no record information (empty zones, a fully recorded workout)
  return values.filter((value) => value !== 0 && value !== 1);
}

const COUNT_PATH =
  /(^|\.)(sample_size|required_sample_size|nights_analyzed|nights_required|records_fetched|records_used|count|days|period_[ab]_n|period_[ab]_calibrating_n)$|(^|\.)(sample_sizes|exclusions)\./;

function numericLeaves(
  value: unknown,
  path = "",
  out: Array<[string, number]> = []
): Array<[string, number]> {
  if (typeof value === "number") out.push([path, value]);
  else if (Array.isArray(value))
    value.forEach((item, index) => numericLeaves(item, `${path}[${index}]`, out));
  else if (value && typeof value === "object")
    for (const [key, item] of Object.entries(value))
      numericLeaves(item, path ? `${path}.${key}` : key, out);
  return out;
}

/** Local-day labels an aggregate result is allowed to carry. */
function periodLabels(data: Record<string, unknown>): Set<string> {
  const labels = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value === "string") labels.add(value);
  };
  for (const key of ["period", "period_a", "period_b"]) {
    const period = data[key] as Record<string, unknown> | null | undefined;
    if (period) for (const field of ["start", "end", "first_day", "last_day"]) add(period[field]);
  }
  add(data.week_start);
  add(data.week_end);
  const quality = data.data_quality as { requested_period?: Record<string, unknown> } | undefined;
  add(quality?.requested_period?.start);
  add(quality?.requested_period?.end);
  return labels;
}

const AGGREGATE_CALLS: Array<[string, Record<string, unknown>]> = [
  ...["recovery", "hrv", "rhr", "sleep_duration", "sleep_performance", "strain"].map(
    (metric): [string, Record<string, unknown>] => ["get_trend", { metric, days: 7 }]
  ),
  ["get_weekly_summary", {}],
  ["get_weekly_summary", { week_start: "last week" }],
  [
    "compare_periods",
    {
      period_a_start: "2026-09-14",
      period_a_end: "2026-09-14",
      period_b_start: "2026-09-15",
      period_b_end: "2026-09-15",
    },
  ],
  [
    "compare_periods",
    {
      period_a_start: "2026-09-13",
      period_a_end: "2026-09-14",
      period_b_start: "2026-09-15",
      period_b_end: "2026-09-16",
    },
  ],
  [
    "compare_periods",
    {
      period_a_start: "2026-09-01",
      period_a_end: "2026-09-07",
      period_b_start: "2026-09-13",
      period_b_end: "2026-09-16",
    },
  ],
  ["get_sleep_debt", {}],
  ["get_sleep_debt", { start: "2026-09-15", days: 3 }],
  ["get_baselines", {}],
];

/** Weekly and compare calls over the released week of 2026-09-07 holding the three nights. */
const RELEASED_CALLS: Array<[string, Record<string, unknown>]> = [
  ...["recovery", "hrv", "sleep_duration", "sleep_efficiency", "strain", "spo2"].map(
    (metric): [string, Record<string, unknown>] => ["get_trend", { metric, days: 7 }]
  ),
  ["get_weekly_summary", { week_start: "2026-09-07" }],
  [
    "compare_periods",
    {
      period_a_start: "2026-08-31",
      period_a_end: "2026-09-06",
      period_b_start: "2026-09-07",
      period_b_end: "2026-09-13",
    },
  ],
  ["get_sleep_debt", { days: 7 }],
  ["get_baselines", { baseline_days: 14 }],
];

/** Call an aggregate tool and scan its output for single input values and unlabelled dates. */
async function expectNoLeaks(
  fixture: Fixture,
  name: string,
  args: Record<string, unknown>
): Promise<void> {
  const secrets = inputValues(fixture);
  const result = await callAggregate(fakeWhoop(fixture), name, args);

  expect(result.isError, result.text).toBeFalsy();
  expect(JSON.parse(result.text)).toEqual(result.structuredContent);

  const leaks = numericLeaves(result.structuredContent)
    .filter(([path]) => !COUNT_PATH.test(path))
    .filter(([, value]) => secrets.some((secret) => Math.abs(secret - value) < 1e-9))
    .map(([path, value]) => `${path}=${value}`);
  expect(leaks).toEqual([]);

  const { data_quality: quality, ...rest } = result.structuredContent as {
    data_quality?: Record<string, unknown>;
  };
  const scanned = JSON.stringify({
    ...rest,
    ...(quality ? { data_quality: { ...quality, evaluated_at: null } } : {}),
  });
  expect(scanned).not.toMatch(/T\d{2}:\d{2}/);
  const labels = periodLabels(result.structuredContent);
  // The evaluation day may appear (e.g. "data through <today>"); it is not record data.
  labels.add("2026-09-16");
  const unlabelled = (scanned.match(/\d{4}-\d{2}-\d{2}/g) ?? []).filter((day) => !labels.has(day));
  expect(unlabelled).toEqual([]);
  assertNeutralText(result.structuredContent);
}

describe("aggregate privacy: no individual records at small sample sizes", () => {
  it("covers every aggregate tool", () => {
    expect(new Set(AGGREGATE_CALLS.map(([name]) => name))).toEqual(
      new Set(Object.keys(aggregateOutputSchemas))
    );
    expect(new Set(RELEASED_CALLS.map(([name]) => name))).toEqual(
      new Set(Object.keys(aggregateOutputSchemas))
    );
  });

  it.each(AGGREGATE_CALLS)(
    "%s %j returns no single input value and no dates beyond period labels",
    async (name, args) => {
      await expectNoLeaks(buildFixture(), name, args);
    }
  );

  it.each(RELEASED_CALLS)(
    "%s %j over a released week of 3 nights returns no single input value",
    async (name, args) => {
      await expectNoLeaks(
        buildFixture("+02:00", 2, { shiftDays: -7, closeLast: true }),
        name,
        args
      );
    }
  );

  it("still shows averages built from at least 3 samples of a released week", async () => {
    const released = (): Fixture => buildFixture("+02:00", 2, { shiftDays: -7, closeLast: true });
    const weekly = await callAggregate(fakeWhoop(released()), "get_weekly_summary", {
      week_start: "2026-09-07",
    });
    expect(weekly.isError, weekly.text).toBeFalsy();
    const data = weekly.structuredContent;
    // Two of the three recoveries are calibrating: 1 sample is below the week minimum.
    expect(data.recovery).toEqual({
      average_score: null,
      average_hrv: null,
      average_rhr: null,
      trend: null,
    });
    // (6.5 + 7.25 + 6.8) / 3 = 6.85 hours asleep, shown rounded to 0.1
    expect(data.sleep).toMatchObject({ average_duration_hours: 6.9 });
    // (9.6 + 15.4 + 4.3) / 3 = 9.77
    expect(data.strain).toEqual({ average_daily_strain: 9.8 });
    expect(data.sample_sizes).toEqual({ recovery_days: 0, sleep_nights: 3, completed_cycles: 3 });
    expect(data.workouts).toEqual({ count: 2, total_strain: null, total_calories_kj: null });
    expect(data.notes).toContain(
      "Aggregate privacy mode withholds averages and totals based on fewer than 3 data points: workout totals (2 workouts)."
    );

    const compare = await callAggregate(fakeWhoop(released()), "compare_periods", {
      period_a_start: "2026-08-31",
      period_a_end: "2026-09-06",
      period_b_start: "2026-09-07",
      period_b_end: "2026-09-13",
    });
    expect(compare.structuredContent.sleep).toMatchObject({
      period_a_n: 0,
      period_b_n: 3,
      period_b_avg_hours: 6.9,
    });
    expect(compare.structuredContent.recovery).toMatchObject({
      period_b_n: 0,
      period_b_avg: null,
      period_b_calibrating_n: 2,
    });
  });

  it("leaves standard mode unchanged", async () => {
    const trend = await callAggregate(
      fakeWhoop(buildFixture()),
      "get_trend",
      { metric: "recovery", days: 7 },
      NOW,
      "standard"
    );
    expect(trend.structuredContent.statistics).toMatchObject({ median: 61, min: 44, max: 71 });
    const weekly = await callAggregate(
      fakeWhoop(buildFixture()),
      "get_weekly_summary",
      {},
      NOW,
      "standard"
    );
    expect(weekly.structuredContent.workouts).toMatchObject({ count: 2, total_strain: 17.2 });
    expect(weekly.structuredContent.week_start).toBe("2026-09-14T00:00:00.000+02:00");
  });
});

describe("aggregate privacy: released-week period labels", () => {
  it.each([
    // Wednesday 12:00 at +02:00: the latest released week is 09-07..09-13
    [{ start: "2026-09-14", days: 3 }, NOW, "+02:00", { start: "2026-08-31", end: "2026-09-13" }],
    [{ start: "yesterday", days: 30 }, NOW, "+02:00", { start: "2026-07-20", end: "2026-09-13" }],
    // 00:30 local on Thursday 09-17
    [
      {},
      new Date("2026-09-16T22:30:00.000Z"),
      "+02:00",
      { start: "2026-08-31", end: "2026-09-13" },
    ],
    // -05:00 at 20:30 local on Wednesday 09-16
    [
      {},
      new Date("2026-09-17T01:30:00.000Z"),
      "-05:00",
      { start: "2026-08-31", end: "2026-09-13" },
    ],
    // -05:00 at 20:30 local on Tuesday 09-15: the week of 09-07 is not released yet
    [
      {},
      new Date("2026-09-16T01:30:00.000Z"),
      "-05:00",
      { start: "2026-08-24", end: "2026-09-06" },
    ],
  ])("labels get_sleep_debt %j at %s (%s)", async (args, now, offset, expected) => {
    const hours = offset === "+02:00" ? 2 : -5;
    const result = await callAggregate(
      fakeWhoop(buildFixture(offset, hours)),
      "get_sleep_debt",
      args,
      now
    );
    expect(result.isError, result.text).toBeFalsy();
    expect(result.structuredContent.period).toEqual(expected);
    expect(
      (result.structuredContent.data_quality as { requested_period: unknown }).requested_period
    ).toEqual(expected);
  });

  it.each([
    [new Date("2026-09-16T22:30:00.000Z"), "+02:00", { start: "2026-07-20", end: "2026-09-13" }],
    [new Date("2026-09-17T01:30:00.000Z"), "-05:00", { start: "2026-07-20", end: "2026-09-13" }],
  ])("labels the get_baselines weeks at %s (%s)", async (now, offset, expected) => {
    const hours = offset === "+02:00" ? 2 : -5;
    const result = await callAggregate(
      fakeWhoop(buildFixture(offset, hours)),
      "get_baselines",
      {},
      now
    );
    expect(result.isError, result.text).toBeFalsy();
    expect(result.structuredContent.period).toEqual(expected);
    expect(result.structuredContent.data_quality).toMatchObject({
      evaluated_at:
        now.getTime() === Date.parse("2026-09-16T22:30:00.000Z") ? "2026-09-17" : "2026-09-16",
      requested_period: expected,
    });
  });

  it("labels trend and weekly windows with local days just after local midnight", async () => {
    const lateNow = new Date("2026-09-13T22:30:00.000Z"); // Monday 00:30 local
    const trend = await callAggregate(
      fakeWhoop(buildFixture()),
      "get_trend",
      { metric: "recovery", days: 7 },
      lateNow
    );
    // Monday: the week of 09-07 ended yesterday and is released on Wednesday.
    expect(trend.structuredContent.period).toEqual({
      start: "2026-08-31",
      end: "2026-09-06",
      days: 7,
    });
    const weekly = await callAggregate(
      fakeWhoop(buildFixture()),
      "get_weekly_summary",
      {},
      lateNow
    );
    expect(weekly.structuredContent).toMatchObject({
      week_start: "2026-09-14",
      week_end: "2026-09-20",
      notes: [WEEK_NOT_RELEASED_NOTE],
    });
  });

  it("labels compare_periods with the released weeks used", async () => {
    const result = await callAggregate(fakeWhoop(buildFixture()), "compare_periods", {
      period_a_start: "2026-08-20",
      period_a_end: "2026-09-02",
      period_b_start: "2026-09-03",
      period_b_end: "2026-09-16",
    });
    expect(result.structuredContent.period_a).toEqual({
      start: "2026-08-24",
      end: "2026-08-30",
      days: 7,
      first_day: "2026-08-24",
      last_day: "2026-08-30",
    });
    expect(result.structuredContent.period_b).toEqual({
      start: "2026-09-07",
      end: "2026-09-13",
      days: 7,
      first_day: "2026-09-07",
      last_day: "2026-09-13",
    });
  });
});

// ---------------------------------------------------------------------------
// Released weeks against differencing
// ---------------------------------------------------------------------------

/** A connection to a fixture account in aggregate mode at the fixture's (or a given) time. */
async function aggregateConnection(
  data: WhoopUserFixture,
  at: Date = data.now
): Promise<ContractConnection> {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at);
  return connectServer(createWhoopFixtureClient(data), {
    privacyMode: "aggregate",
    disableResources: true,
  });
}

async function structured(
  connection: ContractConnection,
  name: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const result = await connection.callTool(name, args);
  expect(result.isError, `${name} ${JSON.stringify(args)}: ${result.text}`).toBe(false);
  assertNeutralText(result.structured);
  return result.structured!;
}

describe("aggregate privacy: differencing (diag/design/agg-differencing.mts)", () => {
  it("no longer recovers one day's HRV from get_trend over 7 and 8 days", async () => {
    // The original attack: 20 nights at +02:00, one recovery a day, synthetic HRV per day.
    const now = new Date("2026-09-16T12:00:00.000Z");
    const synthetic = (i: number): number => 50 + ((i * 37) % 23);
    const cycles: unknown[] = [];
    const recoveries: unknown[] = [];
    for (let i = 0; i < 20; i++) {
      const localMidnightUtc =
        Math.floor((now.getTime() + 2 * HOUR) / DAY) * DAY - 2 * HOUR - i * DAY;
      const start = iso(localMidnightUtc - HOUR);
      const end = i === 0 ? null : iso(localMidnightUtc + 23 * HOUR);
      cycles.push({
        id: 1000 - i,
        user_id: 1,
        created_at: start,
        updated_at: start,
        start,
        end,
        timezone_offset: "+02:00",
        score_state: "SCORED",
        score: { strain: 10, kilojoule: 8000, average_heart_rate: 70, max_heart_rate: 150 },
      });
      recoveries.push({
        cycle_id: 1000 - i,
        sleep_id: `s${i}`,
        user_id: 1,
        created_at: iso(localMidnightUtc + 7 * HOUR),
        updated_at: start,
        score_state: "SCORED",
        score: {
          user_calibrating: false,
          recovery_score: 60,
          resting_heart_rate: 55,
          hrv_rmssd_milli: synthetic(i),
          spo2_percentage: null,
          skin_temp_celsius: null,
        },
      });
    }
    const client = {
      get: async <T>(path: string): Promise<T> => {
        const base = path.split("?")[0];
        if (base === "/v2/cycle") return { records: cycles, next_token: null } as T;
        if (base === "/v2/recovery") return { records: recoveries, next_token: null } as T;
        return { records: [], next_token: null } as T;
      },
    } as unknown as WhoopClient;

    const outputs: Record<string, unknown>[] = [];
    for (let days = 7; days <= 14; days++) {
      const result = await callAggregate(client, "get_trend", { metric: "hrv", days }, now);
      outputs.push(result.structuredContent);
    }
    type Trend = { sample_size: number; statistics: { mean: number | null } };
    const [seven, eight, ...rest] = outputs as unknown as Trend[];
    // 8 to 14 days all snap to the same two released weeks: identical outputs.
    for (const output of rest) expect(output).toEqual(eight);
    // 7 and 8 days differ by one whole released week of 7 recoveries, never by one day.
    expect(seven!.sample_size).toBe(7);
    expect(eight!.sample_size).toBe(14);
    const recovered =
      eight!.statistics.mean! * eight!.sample_size - seven!.statistics.mean! * seven!.sample_size;
    for (let i = 0; i < 20; i++) expect(Math.abs(recovered - synthetic(i))).toBeGreaterThan(1e-9);
  });
});

/** Mondays from `start` to `end` (inclusive labels of whole weeks) */
function mondaysBetween(start: string | null, end: string | null): string[] {
  if (start === null || end === null) return [];
  const mondays: string[] = [];
  for (
    let ms = Date.parse(`${start}T00:00:00Z`);
    ms <= Date.parse(`${end}T00:00:00Z`);
    ms += 7 * DAY
  )
    mondays.push(new Date(ms).toISOString().slice(0, 10));
  return mondays;
}

type Family = "recovery" | "sleep" | "strain";

interface Observation {
  source: string;
  family: Family;
  n: number;
  weeks: string[];
}

describe("aggregate privacy: brute force over the aggregate argument grid", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("never isolates fewer than 3 samples between two outputs of the same metric on a 120-day account", async () => {
    const data = matureUser();
    const connection = await aggregateConnection(data);
    try {
      // Per-week released sample counts, as get_weekly_summary reports them.
      const latest = "2026-09-07";
      const weeks = Array.from({ length: 26 }, (_, index) => shiftDay(latest, -7 * index));
      const counts: Record<Family, Map<string, number>> = {
        recovery: new Map(),
        sleep: new Map(),
        strain: new Map(),
      };
      for (const monday of weeks) {
        const weekly = await structured(connection, "get_weekly_summary", { week_start: monday });
        const sizes = weekly.sample_sizes as Record<string, number>;
        counts.recovery.set(monday, sizes.recovery_days!);
        counts.sleep.set(monday, sizes.sleep_nights!);
        counts.strain.set(monday, sizes.completed_cycles!);
      }
      for (const family of Object.keys(counts) as Family[])
        for (const [monday, count] of counts[family])
          expect(count === 0 || count >= AGGREGATE_WEEK_MIN_SAMPLES, `${family} ${monday}`).toBe(
            true
          );
      expect(counts.recovery.get(latest)).toBe(7);

      const observations: Observation[] = [];
      const observe = (source: string, family: Family, n: number, weekList: string[]): void => {
        observations.push({ source, family, n, weeks: weekList });
      };
      for (const [monday] of counts.recovery) {
        observe(`weekly ${monday}`, "recovery", counts.recovery.get(monday)!, [monday]);
        observe(`weekly ${monday}`, "sleep", counts.sleep.get(monday)!, [monday]);
        observe(`weekly ${monday}`, "strain", counts.strain.get(monday)!, [monday]);
      }

      const trendFamilies: Array<[string, Family]> = [
        ["recovery", "recovery"],
        ["hrv", "recovery"],
        ["rhr", "recovery"],
        ["sleep_duration", "sleep"],
        ["strain", "strain"],
      ];
      for (const days of [7, 8, 14, 15, 28, 29, 56, 57, 90]) {
        for (const [metric, family] of trendFamilies) {
          const trend = await structured(connection, "get_trend", { metric, days });
          const period = trend.period as { start: string; end: string };
          observe(
            `trend ${metric} ${days}`,
            family,
            trend.sample_size as number,
            mondaysBetween(period.start, shiftDay(period.end, -6))
          );
        }
      }
      for (const baselineDays of [14, 15, 28, 29, 56, 57, 91, 92, 180]) {
        const report = await structured(connection, "get_baselines", {
          baseline_days: baselineDays,
        });
        const period = report.period as { start: string; end: string };
        const weekList = mondaysBetween(period.start, shiftDay(period.end, -6));
        const status = report.metric_status as Record<string, { sample_size: number }>;
        for (const [metric, family] of [
          ["hrv", "recovery"],
          ["rhr", "recovery"],
          ["recovery_score", "recovery"],
          ["sleep_hours", "sleep"],
        ] as const)
          observe(
            `baselines ${metric} ${baselineDays}`,
            family,
            status[metric]!.sample_size,
            weekList
          );
      }
      for (const days of [3, 14, 15, 28, 29, 56, 57, 90]) {
        const debt = await structured(connection, "get_sleep_debt", { days });
        const period = debt.period as { start: string; end: string };
        observe(
          `sleep debt ${days}`,
          "sleep",
          debt.nights_analyzed as number,
          mondaysBetween(period.start, shiftDay(period.end, -6))
        );
      }
      // compare_periods on released-week-aligned bounds, raw bounds up to 90 days
      const index = (i: number): string => weeks[i]!;
      for (const [aLength, bLength, gap, bEnd] of [
        [1, 1, 0, 0],
        [1, 4, 1, 0],
        [2, 2, 0, 3],
        [4, 1, 2, 5],
        [4, 12, 0, 0],
        [12, 4, 3, 1],
        [2, 12, 0, 4],
      ] as const) {
        const bLast = bEnd;
        const bFirst = bLast + bLength - 1;
        const aLast = bFirst + 1 + gap;
        const aFirst = aLast + aLength - 1;
        const compare = await structured(connection, "compare_periods", {
          period_a_start: index(aFirst),
          period_a_end: shiftDay(index(aLast), 6),
          period_b_start: index(bFirst),
          period_b_end: shiftDay(index(bLast), 6),
        });
        for (const side of ["a", "b"] as const) {
          const period = compare[`period_${side}`] as {
            first_day: string | null;
            last_day: string | null;
          };
          const weekList =
            period.first_day === null
              ? []
              : mondaysBetween(period.first_day, shiftDay(period.last_day!, -6));
          const recovery = compare.recovery as Record<string, number>;
          const sleep = compare.sleep as Record<string, number>;
          const strain = compare.strain as Record<string, number>;
          const label = `compare ${aLength}/${bLength}/${gap}/${bEnd} ${side}`;
          observe(label, "recovery", recovery[`period_${side}_n`]!, weekList);
          observe(label, "sleep", sleep[`period_${side}_n`]!, weekList);
          observe(label, "strain", strain[`period_${side}_n`]!, weekList);
        }
      }

      // Every output of a metric is the sum of whole released weeks' samples.
      for (const observation of observations) {
        const expected = observation.weeks.reduce(
          (sum, monday) => sum + (counts[observation.family].get(monday) ?? 0),
          0
        );
        expect(observation.n, `${observation.source} (${observation.family})`).toBe(expected);
      }
      // So any two outputs of one metric differ by whole weeks of at least 3 samples.
      let pairs = 0;
      for (const family of ["recovery", "sleep", "strain"] as const) {
        const list = observations.filter((observation) => observation.family === family);
        for (let i = 0; i < list.length; i++) {
          for (let j = i + 1; j < list.length; j++) {
            const left = new Set(list[i]!.weeks);
            const right = new Set(list[j]!.weeks);
            const differing = [
              ...list[i]!.weeks.filter((week) => !right.has(week)),
              ...list[j]!.weeks.filter((week) => !left.has(week)),
            ];
            const isolated = differing.reduce(
              (sum, monday) => sum + (counts[family].get(monday) ?? 0),
              0
            );
            expect(
              isolated === 0 || isolated >= AGGREGATE_WEEK_MIN_SAMPLES,
              `${list[i]!.source} vs ${list[j]!.source}`
            ).toBe(true);
            pairs++;
          }
        }
      }
      expect(pairs).toBeGreaterThan(1000);
    } finally {
      await connection.close();
    }
  }, 120_000);
});

/**
 * The fixture as seen at `nowMs`, as whoop-users.ts views it: records created
 * later are dropped, a cycle ending later is open, and later updates have not
 * happened yet.
 */
function asOf(fixture: WhoopUserFixture, nowMs: number): WhoopUserFixture {
  const created = (record: { created_at: string }): boolean =>
    Date.parse(record.created_at) <= nowMs;
  const ended = (record: { end: string }): boolean => Date.parse(record.end) <= nowMs;
  const notUpdatedLater = <T extends { created_at: string; updated_at: string }>(record: T): T =>
    Date.parse(record.updated_at) > nowMs ? { ...record, updated_at: record.created_at } : record;
  return {
    ...fixture,
    now: new Date(nowMs),
    cycles: fixture.cycles
      .filter((cycle) => created(cycle) && Date.parse(cycle.start) <= nowMs)
      .map(
        (cycle): Cycle =>
          cycle.end !== null && cycle.end !== undefined && Date.parse(cycle.end) > nowMs
            ? { ...cycle, end: null }
            : cycle
      )
      .map(notUpdatedLater),
    sleeps: fixture.sleeps.filter((sleep) => created(sleep) && ended(sleep)).map(notUpdatedLater),
    recoveries: fixture.recoveries.filter(created).map(notUpdatedLater),
    workouts: fixture.workouts
      .filter((workout) => created(workout) && ended(workout))
      .map(notUpdatedLater),
  };
}

/** The cycle whose main sleep ends on a local (+02:00) day */
function cycleWakingOn(data: WhoopUserFixture, day: string): Cycle {
  const sleep = data.sleeps.find(
    (candidate) =>
      !candidate.nap &&
      new Date(Date.parse(candidate.end) + 2 * HOUR).toISOString().slice(0, 10) === day
  )!;
  return data.cycles.find((cycle) => cycle.id === sleep.cycle_id)!;
}

function withoutEvaluatedAt(value: Record<string, unknown>): Record<string, unknown> {
  const quality = value.data_quality as Record<string, unknown> | undefined;
  return quality ? { ...value, data_quality: { ...quality, evaluated_at: null } } : value;
}

describe("aggregate privacy: invariance through a release week", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives byte-identical outputs from Wednesday 00:00 to the next Tuesday 23:59 local", async () => {
    // 62 days ending Tuesday 2026-09-15 at +02:00: Monday 09-07 has a sleep onset after
    // 00:55 and a walk just after midnight that belongs to Sunday 09-06's cycle.
    const base = matureUser({
      days: 62,
      now: "2026-09-15T23:59:00+02:00",
      offsetChange: null,
    });
    const lateWalk = base.workouts.find((workout) => {
      const local = new Date(Date.parse(workout.start) + 2 * HOUR).toISOString();
      return local.startsWith("2026-09-07T00:");
    });
    expect(lateWalk).toBeDefined();
    const mondayCycle = base.cycles.find((cycle) => {
      const local = new Date(Date.parse(cycle.start) + 2 * HOUR).toISOString();
      return local.startsWith("2026-09-07T00:") || local.startsWith("2026-09-07T01:");
    });
    expect(mondayCycle).toBeDefined();
    expect(Date.parse(lateWalk!.start)).toBeLessThan(Date.parse(mondayCycle!.start));

    const calls: Array<[string, Record<string, unknown>]> = [
      ...["recovery", "sleep_duration", "strain", "sleep_efficiency"].flatMap(
        (metric): Array<[string, Record<string, unknown>]> => [
          ["get_trend", { metric, days: 7 }],
          ["get_trend", { metric, days: 14 }],
        ]
      ),
      ["get_weekly_summary", { week_start: "2026-08-31" }],
      ["get_weekly_summary", { week_start: "2026-08-24" }],
      [
        "compare_periods",
        {
          period_a_start: "2026-08-17",
          period_a_end: "2026-08-30",
          period_b_start: "2026-08-31",
          period_b_end: "2026-09-06",
        },
      ],
      ["get_baselines", { baseline_days: 14 }],
      ["get_sleep_debt", { days: 14 }],
    ];
    const instants = [
      "2026-09-09T00:00:00+02:00",
      "2026-09-09T00:30:00+02:00",
      "2026-09-09T01:30:00+02:00",
      "2026-09-10T12:00:00+02:00",
      "2026-09-13T23:30:00+02:00",
      "2026-09-14T00:10:00+02:00",
      "2026-09-14T00:59:00+02:00",
      "2026-09-14T07:00:00+02:00",
      "2026-09-15T23:59:59+02:00",
    ];
    let reference: string[] | null = null;
    for (const instant of instants) {
      const at = new Date(instant);
      const connection = await aggregateConnection(asOf(base, at.getTime()), at);
      const outputs: string[] = [];
      try {
        for (const [name, args] of calls) {
          outputs.push(
            JSON.stringify(withoutEvaluatedAt(await structured(connection, name, args)))
          );
        }
      } finally {
        await connection.close();
        vi.useRealTimers();
      }
      if (reference === null) reference = outputs;
      else expect(outputs, instant).toEqual(reference);
    }
    // The week of 08-31 is summarized, with the Sunday-night walk in it.
    const weekly = JSON.parse(
      reference![calls.findIndex(([, args]) => args.week_start === "2026-08-31")]!
    );
    expect(weekly.sample_sizes.recovery_days).toBeGreaterThanOrEqual(3);
    expect(weekly.workouts.count).toBeGreaterThan(0);
  }, 120_000);
});

describe("aggregate privacy: week gating and withholding", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("excludes a week with 2 samples of a metric from every window", async () => {
    const data = matureUser({ offsetChange: null });
    const local = (timestamp: string): string =>
      new Date(Date.parse(timestamp) + 2 * HOUR).toISOString().slice(0, 10);
    let kept = 0;
    const recoveries = data.recoveries.filter((recovery) => {
      const day = local(recovery.created_at);
      if (day < "2026-08-24" || day > "2026-08-30") return true;
      kept += 1;
      return kept <= 2;
    });
    const connection = await aggregateConnection({ ...data, recoveries });
    try {
      const sizes = async (monday: string): Promise<Record<string, number>> =>
        (await structured(connection, "get_weekly_summary", { week_start: monday }))
          .sample_sizes as Record<string, number>;
      const gated = await structured(connection, "get_weekly_summary", {
        week_start: "2026-08-24",
      });
      expect(gated.sample_sizes).toMatchObject({ recovery_days: 0, sleep_nights: 7 });
      expect(gated.notes).toContain(
        "Recovery: 1 week with fewer than 3 scored recoveries is left out."
      );

      const others =
        (await sizes("2026-08-17")).recovery_days! +
        (await sizes("2026-08-31")).recovery_days! +
        (await sizes("2026-09-07")).recovery_days!;
      const trend = await structured(connection, "get_trend", { metric: "hrv", days: 28 });
      expect(trend.period).toEqual({ start: "2026-08-17", end: "2026-09-13", days: 28 });
      expect(trend.sample_size).toBe(others);
      expect(trend.notes).toContain("1 week with fewer than 3 scored recoveries is left out.");
      const sleep = await structured(connection, "get_trend", {
        metric: "sleep_duration",
        days: 28,
      });
      expect(sleep.sample_size).toBe(28);

      const baselines = await structured(connection, "get_baselines", { baseline_days: 28 });
      const status = baselines.metric_status as Record<string, { sample_size: number }>;
      expect(status.hrv!.sample_size).toBe(others);
      expect(status.sleep_hours!.sample_size).toBe(28);

      const compare = await structured(connection, "compare_periods", {
        period_a_start: "2026-08-24",
        period_a_end: "2026-08-30",
        period_b_start: "2026-08-31",
        period_b_end: "2026-09-06",
      });
      expect(compare.recovery).toMatchObject({ period_a_n: 0, period_a_avg: null });
      expect(compare.sleep).toMatchObject({ period_a_n: 7 });
    } finally {
      await connection.close();
    }
  });

  it("withholds a released week whose Sunday cycle is still open", async () => {
    const data = matureUser({ offsetChange: null });
    // The strap came off on Sunday 09-13 evening: no later records, the Sunday cycle stays open.
    const sunday = cycleWakingOn(data, "2026-09-13");
    const cutoff = Date.parse(sunday.end!);
    const cycles = data.cycles
      .filter((cycle) => Date.parse(cycle.start) < cutoff)
      .map((cycle): Cycle => (cycle.id === sunday.id ? { ...cycle, end: null } : cycle));
    const cycleIds = new Set(cycles.map((cycle) => cycle.id));
    const open: WhoopUserFixture = {
      ...data,
      cycles,
      sleeps: data.sleeps.filter((sleep) => Date.parse(sleep.start) < cutoff),
      recoveries: data.recoveries.filter((recovery) => cycleIds.has(recovery.cycle_id)),
      workouts: data.workouts.filter((workout) => Date.parse(workout.start) < cutoff),
    };
    const connection = await aggregateConnection(open);
    try {
      const weekly = await structured(connection, "get_weekly_summary", {
        week_start: "2026-09-07",
      });
      expect(weekly.sample_sizes).toEqual({
        recovery_days: 0,
        sleep_nights: 0,
        completed_cycles: 0,
      });
      expect(weekly.notes).toContain(
        "1 week is withheld because a record placed in it is still open or being scored by WHOOP."
      );
      const oneWeek = await structured(connection, "get_trend", { metric: "recovery", days: 7 });
      expect(oneWeek.sample_size).toBe(0);
      const previous = await structured(connection, "get_weekly_summary", {
        week_start: "2026-08-31",
      });
      const twoWeeks = await structured(connection, "get_trend", { metric: "recovery", days: 14 });
      expect(twoWeeks.sample_size).toBe(
        (previous.sample_sizes as Record<string, number>).recovery_days
      );
    } finally {
      await connection.close();
    }
  });

  it("withholds the current week and last week before Wednesday", async () => {
    const tuesday = matureUser({ offsetChange: null, now: "2026-09-15T23:59:00+02:00" });
    const connection = await aggregateConnection(tuesday);
    try {
      for (const args of [{}, { week_start: "last week" }, { week_start: "2026-09-07" }]) {
        const weekly = await structured(connection, "get_weekly_summary", args);
        expect(weekly.notes, JSON.stringify(args)).toEqual([WEEK_NOT_RELEASED_NOTE]);
        expect(weekly.workouts).toEqual({
          count: null,
          total_strain: null,
          total_calories_kj: null,
        });
        expect(weekly.recovery).toMatchObject({ average_score: null, average_hrv: null });
      }
      const released = await structured(connection, "get_weekly_summary", {
        week_start: "2026-08-31",
      });
      expect((released.sample_sizes as Record<string, number>).recovery_days).toBe(7);
    } finally {
      await connection.close();
    }
  });
});

describe("aggregate privacy: edits to a released week", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const WEEK = "2026-08-31";

  /** Scored workouts the day model places in WEEK, and their exact totals */
  function weekWorkouts(data: WhoopUserFixture): { scored: Workout[]; kj: number; strain: number } {
    const placement = placeDays({
      cycles: data.cycles,
      sleeps: data.sleeps,
      recoveries: data.recoveries,
      sleepsAvailable: true,
      today: "2026-09-16",
      utcOffset: data.offset,
    });
    const placed = assignWorkouts(data.workouts, placement, data.cycles);
    const scored = data.workouts.filter((workout) => {
      const day = placed.get(workout.id)?.day;
      return (
        day !== undefined &&
        day >= WEEK &&
        day <= addDays(WEEK, 6) &&
        workout.score_state === "SCORED" &&
        workout.score !== null &&
        workout.score !== undefined
      );
    });
    return {
      scored,
      kj: scored.reduce((sum, workout) => sum + workout.score!.kilojoule, 0),
      strain: scored.reduce((sum, workout) => sum + workout.score!.strain, 0),
    };
  }

  async function weeklyWorkouts(
    data: WhoopUserFixture
  ): Promise<{ count: number; total_strain: number; total_calories_kj: number }> {
    const connection = await aggregateConnection(data);
    try {
      const weekly = await structured(connection, "get_weekly_summary", { week_start: WEEK });
      return weekly.workouts as { count: number; total_strain: number; total_calories_kj: number };
    } finally {
      await connection.close();
      vi.useRealTimers();
    }
  }

  /** a - b is a whole multiple of step */
  function isMultiple(difference: number, step: number): boolean {
    return Math.abs(difference / step - Math.round(difference / step)) < 1e-9;
  }

  it("changes workout totals only in steps of 100 kJ and 1 strain when a workout is removed or added", async () => {
    const base = matureUser();
    const reference = weekWorkouts(base);
    expect(reference.scored.length).toBeGreaterThanOrEqual(AGGREGATE_WEEK_MIN_SAMPLES + 1);
    const before = await weeklyWorkouts(base);

    const removed = matureUser();
    const victim = reference.scored[Math.floor(reference.scored.length / 2)]!;
    removed.workouts = removed.workouts.filter((workout) => workout.id !== victim.id);

    const added = matureUser();
    const extra = structuredClone(victim);
    extra.id = "00000000-0000-4000-8000-00000000abcd";
    extra.start = new Date(Date.parse(victim.start) + 3 * HOUR).toISOString();
    extra.end = new Date(Date.parse(victim.end) + 3 * HOUR).toISOString();
    extra.score!.strain = 9.87;
    extra.score!.kilojoule = 432.1;
    added.workouts = [...added.workouts, extra].sort(
      (left, right) => Date.parse(right.start) - Date.parse(left.start)
    );

    for (const [label, data, countChange] of [
      ["base", base, 0],
      ["removed", removed, -1],
      ["added", added, 1],
    ] as const) {
      const expected = weekWorkouts(data);
      const released = label === "base" ? before : await weeklyWorkouts(data);
      expect(released.count, label).toBe(reference.scored.length + countChange);
      expect(released.count, label).toBe(expected.scored.length);
      expect(released.total_calories_kj, label).toBe(
        roundStep(expected.kj, AGGREGATE_WORKOUT_KJ_STEP)
      );
      expect(released.total_strain, label).toBe(
        roundStep(expected.strain, AGGREGATE_WORKOUT_STRAIN_STEP)
      );
      expect(isMultiple(released.total_calories_kj - before.total_calories_kj, 100), label).toBe(
        true
      );
      expect(isMultiple(released.total_strain - before.total_strain, 1), label).toBe(true);
    }
  });
});

describe("aggregate privacy: source counts", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not change data_quality source counts when records are added after the released weeks", async () => {
    const data = matureUser({ offsetChange: null });
    const read = async (fixture: WhoopUserFixture): Promise<unknown[]> => {
      const connection = await aggregateConnection(fixture);
      try {
        const baselines = await structured(connection, "get_baselines", { baseline_days: 14 });
        const debt = await structured(connection, "get_sleep_debt", { days: 14 });
        const trend = await structured(connection, "get_trend", {
          metric: "sleep_duration",
          days: 14,
        });
        return [
          (baselines.data_quality as Record<string, unknown>).sources,
          (debt.data_quality as Record<string, unknown>).sources,
          trend,
        ];
      } finally {
        await connection.close();
        vi.useRealTimers();
      }
    };
    const before = await read(data);

    // Monday 09-14 (after the released weeks, inside the fetch window): a nap and a workout.
    const mondayCycle = cycleWakingOn(data, "2026-09-14");
    const template = data.sleeps.find((sleep) => sleep.nap)!;
    const nap: Sleep = {
      ...template,
      id: "added-nap",
      cycle_id: mondayCycle.id,
      start: "2026-09-14T11:00:00.000Z",
      end: "2026-09-14T11:30:00.000Z",
      created_at: "2026-09-14T11:35:00.000Z",
      updated_at: "2026-09-14T11:35:00.000Z",
    };
    const workoutTemplate = data.workouts[0]!;
    const workout: Workout = {
      ...workoutTemplate,
      id: "added-workout",
      start: "2026-09-14T16:00:00.000Z",
      end: "2026-09-14T16:45:00.000Z",
      created_at: "2026-09-14T16:50:00.000Z",
      updated_at: "2026-09-14T16:50:00.000Z",
    };
    const after = await read({
      ...data,
      sleeps: [nap, ...data.sleeps],
      workouts: [workout, ...data.workouts],
    });

    expect(after).toEqual(before);
    const sources = before[0] as Record<string, { records_fetched: number; records_used: number }>;
    expect(sources.recovery).toMatchObject({ records_fetched: 14, records_used: 14 });
  });

  it("projects evaluated_at to the local date", async () => {
    const data = matureUser({ offsetChange: null });
    const connection = await aggregateConnection(data);
    try {
      const report = await structured(connection, "get_baselines", {});
      expect((report.data_quality as Record<string, unknown>).evaluated_at).toBe("2026-09-16");
    } finally {
      await connection.close();
    }
  });
});

describe("projectAggregate", () => {
  const metric = (
    aN: number,
    bN: number,
    aAvg: number | null,
    bAvg: number | null
  ): Record<string, unknown> => ({
    period_a_avg: aAvg,
    period_b_avg: bAvg,
    period_a_n: aN,
    period_b_n: bN,
    change_pct: null,
    direction: "insufficient_data",
  });
  const comparison = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    period_a: {
      start: "2026-09-01T00:00:00.000+02:00",
      end: "2026-09-07T23:59:59.999+02:00",
      days: 7,
      first_day: "2026-09-01",
      last_day: "2026-09-07",
    },
    period_b: {
      start: "2026-09-08T03:00:00.000+02:00",
      end: "2026-09-08T09:00:00.000+02:00",
      days: 0.25,
      first_day: null,
      last_day: null,
    },
    recovery: { ...metric(3, 0, 60, null), period_a_calibrating_n: 0, period_b_calibrating_n: 0 },
    sleep: {
      period_a_avg_hours: 7.1,
      period_b_avg_hours: 6.9,
      period_a_n: 2,
      period_b_n: 1,
      change_pct: null,
      direction: "insufficient_data",
    },
    strain: metric(3, 3, 10, 12),
    truncated: false,
    notes: [],
    warnings: [],
    ...overrides,
  });

  it("uses the thresholds of compare_periods and trends", () => {
    expect(AGGREGATE_MIN_SAMPLES).toBe(3);
    expect(AGGREGATE_MIN_TREND_POINTS).toBe(4);
  });

  it("withholds compare averages per period and labels a period without local days as null", () => {
    const projected = projectAggregate("compare_periods", comparison()) as ReturnType<
      typeof comparison
    > & {
      sleep: Record<string, unknown>;
      recovery: Record<string, unknown>;
      strain: Record<string, unknown>;
      notes: string[];
    };
    expect(projected.recovery).toMatchObject({ period_a_avg: 60, period_b_avg: null });
    expect(projected.sleep).toMatchObject({ period_a_avg_hours: null, period_b_avg_hours: null });
    expect(projected.strain).toMatchObject({ period_a_avg: 10, period_b_avg: 12 });
    expect(projected.period_a).toMatchObject({ start: "2026-09-01", end: "2026-09-07", days: 7 });
    expect(projected.period_b).toMatchObject({ start: null, end: null, days: 0 });
    expect(projected.notes).toEqual([
      "Aggregate privacy mode withholds period averages based on fewer than 3 samples: sleep in period A (2 nights), sleep in period B (1 night).",
    ]);
    expect(aggregateOutputSchemas.compare_periods!.safeParse(projected).success).toBe(true);
  });

  it("keeps trend mean and spread from 4 points and never returns extremes", () => {
    const trend = (sampleSize: number): Record<string, unknown> => ({
      metric: "hrv",
      period: {
        start: "2026-09-10T00:00:00.000+02:00",
        end: "2026-09-16T12:00:00.000+02:00",
        days: 7,
      },
      status: sampleSize >= 4 ? "available" : "insufficient_data",
      sample_size: sampleSize,
      calibrating: false,
      truncated: false,
      values: [1, 2, 3, 4].slice(0, sampleSize),
      dates: [],
      statistics: { mean: 2.5, median: 2.5, std_dev: 1.3, min: 1, max: 4 },
      trend: {
        direction: null,
        change: null,
        better_when: "higher",
        slope: null,
        confidence: null,
      },
      anomalies: [],
      notes: [],
    });
    const parse = (data: Record<string, unknown>): Record<string, unknown> =>
      aggregateOutputSchemas.get_trend!.parse(data) as Record<string, unknown>;
    expect(projectAggregate("get_trend", parse(trend(4))).statistics).toEqual({
      mean: 2.5,
      std_dev: 1.3,
    });
    const three = projectAggregate("get_trend", parse(trend(3)));
    expect(three.statistics).toEqual({ mean: null, std_dev: null });
    expect(three.period).toEqual({ start: "2026-09-10", end: "2026-09-16", days: 7 });
  });

  it("keeps zero workout totals for a worn week without workouts", () => {
    const weekly = {
      week_start: "2026-09-14T00:00:00.000+02:00",
      week_end: "2026-09-20T23:59:59.999+02:00",
      recovery: { average_score: 60, average_hrv: 50, average_rhr: 55, trend: null },
      sleep: { average_duration_hours: 7, average_performance_pct: 80, average_efficiency_pct: 90 },
      workouts: { count: 0, total_strain: 0, total_calories_kj: 0 },
      strain: { average_daily_strain: 10 },
      sample_sizes: { recovery_days: 3, sleep_nights: 3, completed_cycles: 3 },
      calibrating: false,
      truncated: false,
      notes: [],
    };
    expect(projectAggregate("get_weekly_summary", weekly)).toEqual({
      ...weekly,
      week_start: "2026-09-14",
      week_end: "2026-09-20",
    });
  });
});
