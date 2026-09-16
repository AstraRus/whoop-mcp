/**
 * Aggregate privacy mode must not reveal individual records.
 *
 * A live-shaped +02:00 user with at most 3 records per metric is served
 * through createWhoopServer in aggregate mode. No numeric output other than
 * counts may equal any single input value (or a per-record value derived from
 * one, such as a night's hours asleep), and the only dates are period labels.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { WhoopClient } from "../src/api/client.js";
import { createWhoopServer } from "../src/server.js";
import {
  AGGREGATE_MIN_SAMPLES,
  AGGREGATE_MIN_TREND_POINTS,
  aggregateOutputSchemas,
  projectAggregate,
} from "../src/tools/output-contracts.js";

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

// Three wake-up days; the last cycle is still open, so only two cycles are complete.
const NIGHTS: NightSpec[] = [
  {
    day: "2026-09-14",
    cycleStrain: 9.9,
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
    strainNeed: 720_000,
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

function buildFixture(offset = "+02:00", offsetHours = 2): Fixture {
  const fixture: Fixture = { cycles: [], sleeps: [], recoveries: [], workouts: [] };
  NIGHTS.forEach((night, index) => {
    const onset = onsetMs(night.day, offsetHours);
    const isLast = index === NIGHTS.length - 1;
    const cycleId = 900 + index;
    const sleepId = `sleep-${night.day}`;
    const asleep = night.light + night.slowWave + night.rem;
    const wake = onset + asleep + night.awake;
    fixture.cycles.push({
      id: cycleId,
      user_id: 7,
      created_at: iso(onset),
      updated_at: iso(isLast ? NOW.getTime() : onset + DAY),
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
    workout("w-2", Date.parse("2026-09-15T15:00:00.000Z"), "cycling", {
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
    workout("w-1", Date.parse("2026-09-14T14:00:00.000Z"), "running", {
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

describe("aggregate privacy: no individual records at small sample sizes", () => {
  it("covers every aggregate tool", () => {
    expect(new Set(AGGREGATE_CALLS.map(([name]) => name))).toEqual(
      new Set(Object.keys(aggregateOutputSchemas))
    );
  });

  it.each(AGGREGATE_CALLS)(
    "%s %j returns no single input value and no dates beyond period labels",
    async (name, args) => {
      const fixture = buildFixture();
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
      const unlabelled = (scanned.match(/\d{4}-\d{2}-\d{2}/g) ?? []).filter(
        (day) => !labels.has(day)
      );
      expect(unlabelled).toEqual([]);
    }
  );

  it("still shows averages built from at least 3 samples", async () => {
    const fixture = buildFixture();
    const compare = await callAggregate(fakeWhoop(fixture), "compare_periods", {
      period_a_start: "2026-09-01",
      period_a_end: "2026-09-07",
      period_b_start: "2026-09-13",
      period_b_end: "2026-09-16",
    });
    expect(compare.structuredContent.recovery).toMatchObject({ period_b_n: 3, period_b_avg: 58.7 });
    expect(compare.structuredContent.strain).toMatchObject({ period_b_n: 2, period_b_avg: null });

    const weekly = await callAggregate(fakeWhoop(buildFixture()), "get_weekly_summary", {});
    const recovery = weekly.structuredContent.recovery as Record<string, unknown>;
    expect(recovery.average_score).toBeCloseTo(176 / 3, 9);
    expect(recovery).not.toHaveProperty("min_score");
    expect(recovery).not.toHaveProperty("max_score");
    expect(weekly.structuredContent.strain).toEqual({ average_daily_strain: null });
    expect(weekly.structuredContent.workouts).toEqual({
      count: 2,
      total_strain: null,
      total_calories_kj: null,
    });
    expect(weekly.structuredContent.notes).toContain(
      "Aggregate privacy mode withholds averages and totals based on fewer than 3 data points: daily strain (2 completed cycles), workout totals (2 workouts)."
    );
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

describe("aggregate privacy: local-day period labels", () => {
  it.each([
    // +02:00: date-only and relative starts sit on local midnight
    [{ start: "2026-09-14", days: 3 }, NOW, "+02:00", { start: "2026-09-14", end: "2026-09-16" }],
    [{ start: "yesterday", days: 3 }, NOW, "+02:00", { start: "2026-09-15", end: "2026-09-16" }],
    // 00:30 local on 09-17: today is 09-17
    [
      {},
      new Date("2026-09-16T22:30:00.000Z"),
      "+02:00",
      { start: "2026-09-03", end: "2026-09-17" },
    ],
    // -05:00 at 20:30 local on 09-16: the window starts 20:30 on 09-02, mostly 09-03
    [
      {},
      new Date("2026-09-17T01:30:00.000Z"),
      "-05:00",
      { start: "2026-09-03", end: "2026-09-16" },
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
    [new Date("2026-09-16T22:30:00.000Z"), "+02:00", { start: "2026-08-16", end: "2026-09-17" }],
    [new Date("2026-09-17T01:30:00.000Z"), "-05:00", { start: "2026-08-16", end: "2026-09-16" }],
  ])("labels the get_baselines window read at %s (%s)", async (now, offset, expected) => {
    const hours = offset === "+02:00" ? 2 : -5;
    const result = await callAggregate(
      fakeWhoop(buildFixture(offset, hours)),
      "get_baselines",
      {},
      now
    );
    expect(result.isError, result.text).toBeFalsy();
    expect(
      (result.structuredContent.data_quality as { requested_period: unknown }).requested_period
    ).toEqual(expected);
  });

  it("labels trend and weekly windows with local days just after local midnight", async () => {
    const lateNow = new Date("2026-09-13T22:30:00.000Z"); // Monday 00:30 local
    const trend = await callAggregate(
      fakeWhoop(buildFixture()),
      "get_trend",
      { metric: "recovery", days: 7 },
      lateNow
    );
    expect(trend.structuredContent.period).toEqual({
      start: "2026-09-08",
      end: "2026-09-14",
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
    });
  });

  it("labels compare_periods with the local days counted", async () => {
    const result = await callAggregate(fakeWhoop(buildFixture()), "compare_periods", {
      period_a_start: "2026-09-01",
      period_a_end: "2026-09-07",
      period_b_start: "2026-09-08",
      period_b_end: "2026-09-10T00:00:00+02:00",
    });
    expect(result.structuredContent.period_b).toEqual({
      start: "2026-09-08",
      end: "2026-09-09",
      days: 2,
      first_day: "2026-09-08",
      last_day: "2026-09-09",
    });
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
