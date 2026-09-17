/**
 * Tests for get_trend tool.
 *
 * Fixtures are live-shaped: WHOOP returns records newest first, a cycle
 * starts at the evening sleep onset, the user is at +02:00, the current cycle
 * has end:null, next_token is null on the last page, and a new user's
 * recoveries are calibrating with only 2-3 days of history.
 *
 * Verifies that get_trend:
 * - Maps metric names to the correct endpoint + field extraction
 * - Orders values oldest first (dates in lockstep) before regression
 * - Labels direction per metric (lower RHR is better; strain has no better direction)
 * - Never throws for sparse data: null statistics/trend with notes instead
 * - Caps confidence by sample size
 * - Places recoveries on their cycle's local day and filters to the window
 * - Surfaces pagination truncation
 */

import { afterEach, describe, it, expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { WhoopClient } from "../../src/api/client.js";
import { WhoopApiError } from "../../src/api/client.js";
import { createWhoopServer } from "../../src/server.js";
import { getTrend, TREND_METRICS } from "../../src/tools/get-trend.js";
import type { TrendMetric } from "../../src/tools/get-trend.js";
import { sampleStandardDeviation } from "../../src/tools/stats-utils.js";
import { MAX_TOOL_TEXT_CHARS } from "../../src/tools/tool-definition.js";
import { assertNeutralText, connectServer } from "../helpers/contract.js";
import { createWhoopFixtureClient } from "../helpers/whoop-fixture-client.js";
import { liveShapedUser, matureUser, stressUser } from "../helpers/whoop-users.js";

// ---------------------------------------------------------------------------
// Live-shaped fake WHOOP API
// ---------------------------------------------------------------------------

type WhoopRecord = Record<string, unknown>;

interface FakeData {
  recovery: WhoopRecord[];
  sleep: WhoopRecord[];
  cycle: WhoopRecord[];
}

interface DaySpec {
  /** Local (+02:00) day the cycle covers / the sleep ends */
  day: string;
  recovery?: number;
  hrv?: number;
  rhr?: number;
  strain?: number;
  performance?: number | null;
  calibrating?: boolean;
  efficiency?: number | null;
  respiratory?: number | null;
  consistency?: number | null;
  /** WHOOP need_from_sleep_debt_milli */
  debtMs?: number;
  /** Stage times; defaults 3.5 h light, 1.5 h slow-wave, 2 h REM, 1 h awake, no no-data time */
  lightMs?: number;
  swsMs?: number;
  remMs?: number;
  noDataMs?: number;
  disturbances?: number;
  spo2?: number | null;
  skinTemp?: number | null;
  /** Recovery score state (default SCORED) */
  recoveryState?: "SCORED" | "PENDING_SCORE";
}

const NOW = new Date("2026-09-16T12:00:00.000Z"); // 14:00 local (+02:00), a Wednesday
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function shiftDay(day: string, count: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + count * DAY_MS).toISOString().slice(0, 10);
}

function stageSummary(spec: Partial<DaySpec> = {}): Record<string, number> {
  const light = spec.lightMs ?? 3.5 * HOUR_MS;
  const sws = spec.swsMs ?? 1.5 * HOUR_MS;
  const rem = spec.remMs ?? 2 * HOUR_MS;
  const noData = spec.noDataMs ?? 0;
  return {
    // Awake time fills the rest of 8 h in bed (7 h asleep and 1 h awake by default)
    total_in_bed_time_milli: Math.max(8 * HOUR_MS, light + sws + rem + noData),
    total_awake_time_milli: Math.max(0, 8 * HOUR_MS - light - sws - rem - noData),
    total_no_data_time_milli: noData,
    total_light_sleep_time_milli: light,
    total_slow_wave_sleep_time_milli: sws,
    total_rem_sleep_time_milli: rem,
    sleep_cycle_count: 4,
    disturbance_count: spec.disturbances ?? 10,
  };
}

/**
 * Build a history, one entry per local day (ascending). Bedtime is 23:00
 * local the evening before, wake-up 07:00 local; the newest cycle is open
 * (end:null). Returned arrays are newest first, like WHOOP.
 */
function history(days: DaySpec[], options: { openLatest?: boolean } = {}): FakeData {
  const openLatest = options.openLatest ?? true;
  const data: FakeData = { recovery: [], sleep: [], cycle: [] };
  days.forEach((spec, index) => {
    const id = index + 1;
    const sleepStart = `${shiftDay(spec.day, -1)}T21:00:00.000Z`;
    const sleepEnd = `${spec.day}T05:00:00.000Z`;
    const next = days[index + 1];
    const cycleEnd = next
      ? `${shiftDay(next.day, -1)}T21:00:00.000Z`
      : openLatest
        ? null
        : `${spec.day}T21:00:00.000Z`;
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
      timezone_offset: "+02:00",
      nap: false,
      score_state: "SCORED",
      score: {
        stage_summary: stageSummary(spec),
        sleep_needed: {
          baseline_milli: 8 * HOUR_MS,
          need_from_sleep_debt_milli: spec.debtMs ?? 0,
          need_from_recent_strain_milli: 0,
          need_from_recent_nap_milli: 0,
        },
        respiratory_rate: spec.respiratory === undefined ? 15 : spec.respiratory,
        sleep_performance_percentage: spec.performance === undefined ? 80 : spec.performance,
        sleep_consistency_percentage: spec.consistency === undefined ? 0 : spec.consistency,
        sleep_efficiency_percentage: spec.efficiency === undefined ? 88 : spec.efficiency,
      },
    });
    data.cycle.push({
      id,
      user_id: 1,
      created_at: sleepStart,
      updated_at: sleepStart,
      start: sleepStart,
      end: cycleEnd,
      timezone_offset: "+02:00",
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
      created_at: `${spec.day}T05:30:00.000Z`,
      updated_at: `${spec.day}T05:30:00.000Z`,
      score_state: spec.recoveryState ?? "SCORED",
      score:
        spec.recoveryState === "PENDING_SCORE"
          ? null
          : {
              user_calibrating: spec.calibrating ?? false,
              recovery_score: spec.recovery ?? 60,
              resting_heart_rate: spec.rhr ?? 55,
              hrv_rmssd_milli: spec.hrv ?? 70,
              spo2_percentage: spec.spo2 === undefined ? 96 : spec.spo2,
              skin_temp_celsius: spec.skinTemp === undefined ? 34 : spec.skinTemp,
            },
    });
  });
  return {
    recovery: data.recovery.reverse(),
    sleep: data.sleep.reverse(),
    cycle: data.cycle.reverse(),
  };
}

/** Ascending local days ending at `lastDay` */
function dayRange(lastDay: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => shiftDay(lastDay, index - count + 1));
}

function bounds(kind: keyof FakeData, record: WhoopRecord, data: FakeData): [number, number] {
  if (kind === "recovery") {
    const cycle = data.cycle.find((c) => c.id === record.cycle_id);
    if (cycle) return bounds("cycle", cycle, data);
    const created = Date.parse(String(record.created_at));
    return [created, created];
  }
  const start = Date.parse(String(record.start));
  return [start, record.end ? Date.parse(String(record.end)) : Number.POSITIVE_INFINITY];
}

interface FakeClient {
  client: WhoopClient;
  paths: string[];
}

/**
 * A fake WHOOP client: filters by overlap with start/end like WHOOP,
 * paginates 25 per page with next_token null on the last page.
 */
function fakeWhoop(
  data: FakeData,
  overrides: { fail?: Partial<Record<keyof FakeData, Error>>; endless?: keyof FakeData } = {}
): FakeClient {
  const paths: string[] = [];
  const get = async <T>(path: string): Promise<T> => {
    paths.push(path);
    const url = new URL(path, "https://whoop.test");
    const kind: keyof FakeData = url.pathname.includes("recovery")
      ? "recovery"
      : url.pathname.includes("sleep")
        ? "sleep"
        : "cycle";
    const failure = overrides.fail?.[kind];
    if (failure && url.searchParams.has("start")) throw failure;
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
    if (overrides.endless === kind && url.searchParams.has("start")) {
      const page = Array.from({ length: limit }, () => records[0]);
      return { records: page, next_token: String(offset + limit) } as T;
    }
    const page = records.slice(offset, offset + limit);
    const nextToken = offset + limit < records.length ? String(offset + limit) : null;
    return { records: page, next_token: nextToken } as T;
  };
  return { client: { get } as WhoopClient, paths };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getTrend — metric mapping and ordering", () => {
  const days = ["2026-09-13", "2026-09-14", "2026-09-15", "2026-09-16"];
  const data = history(
    days.map((day, i) => ({
      day,
      recovery: 50 + i * 10,
      hrv: 90 - i * 10,
      rhr: 52 + i * 2,
      strain: 8 + i,
      performance: 70 + i * 5,
    })),
    { openLatest: false }
  );

  it("returns recovery values oldest first with their local dates, from newest-first data", async () => {
    const { client, paths } = fakeWhoop(data);
    const result = await getTrend(client, { metric: "recovery", days: 7 }, NOW);

    expect(result.values).toEqual([50, 60, 70, 80]);
    expect(result.dates).toEqual(days);
    expect(paths.some((path) => path.startsWith("/v2/recovery?"))).toBe(true);
  });

  it("maps hrv and rhr to their recovery fields", async () => {
    const hrv = await getTrend(fakeWhoop(data).client, { metric: "hrv", days: 7 }, NOW);
    const rhr = await getTrend(fakeWhoop(data).client, { metric: "rhr", days: 7 }, NOW);

    expect(hrv.values).toEqual([90, 80, 70, 60]);
    expect(rhr.values).toEqual([52, 54, 56, 58]);
  });

  it("maps sleep_duration to hours asleep (not time in bed) on the local wake-up day", async () => {
    const { client, paths } = fakeWhoop(data);
    const result = await getTrend(client, { metric: "sleep_duration", days: 7 }, NOW);

    expect(result.values).toEqual([7, 7, 7, 7]);
    expect(result.dates).toEqual(days);
    expect(paths.some((path) => path.startsWith("/v2/activity/sleep?"))).toBe(true);
  });

  it("maps sleep_performance to sleep_performance_percentage", async () => {
    const result = await getTrend(
      fakeWhoop(data).client,
      { metric: "sleep_performance", days: 7 },
      NOW
    );

    expect(result.values).toEqual([70, 75, 80, 85]);
  });

  it("maps strain to cycle strain on the cycle's local day", async () => {
    const { client, paths } = fakeWhoop(data);
    const result = await getTrend(client, { metric: "strain", days: 7 }, NOW);

    expect(result.values).toEqual([8, 9, 10, 11]);
    expect(result.dates).toEqual(days);
    expect(paths.some((path) => path.startsWith("/v2/cycle?start="))).toBe(true);
  });
});

describe("getTrend — direction semantics", () => {
  function series(values: number[], field: "recovery" | "hrv" | "rhr"): FakeData {
    return history(
      dayRange("2026-09-16", values.length).map((day, i) => ({ day, [field]: values[i] })),
      { openLatest: false }
    );
  }

  it("reports a declining HRV when newer values are lower (regression runs oldest first)", async () => {
    const data = series([100, 90, 80, 70, 60, 50, 40], "hrv");
    // Newest first from the API: the newest value is the lowest
    expect((data.recovery[0]!.score as { hrv_rmssd_milli: number }).hrv_rmssd_milli).toBe(40);

    const result = await getTrend(fakeWhoop(data).client, { metric: "hrv", days: 7 }, NOW);

    expect(result.values).toEqual([100, 90, 80, 70, 60, 50, 40]);
    expect(result.trend.change).toBe("decreasing");
    expect(result.trend.direction).toBe("declining");
    expect(result.trend.slope).toBeCloseTo(-10, 6);
    expect(result.trend.better_when).toBe("higher");
  });

  it("reports an improving recovery when values rise over time", async () => {
    const data = series([50, 55, 60, 65, 70, 75, 80], "recovery");
    const result = await getTrend(fakeWhoop(data).client, { metric: "recovery", days: 7 }, NOW);

    expect(result.trend.change).toBe("increasing");
    expect(result.trend.direction).toBe("improving");
    expect(result.trend.slope).toBeCloseTo(5, 6);
  });

  it("labels a rising resting heart rate as declining (lower is better)", async () => {
    const data = series([52, 54, 56, 58, 60, 62, 64], "rhr");
    const result = await getTrend(fakeWhoop(data).client, { metric: "rhr", days: 7 }, NOW);

    expect(result.trend.change).toBe("increasing");
    expect(result.trend.direction).toBe("declining");
    expect(result.trend.better_when).toBe("lower");
  });

  it("labels a falling resting heart rate as improving", async () => {
    const data = series([64, 62, 60, 58, 56, 54, 52], "rhr");
    const result = await getTrend(fakeWhoop(data).client, { metric: "rhr", days: 7 }, NOW);

    expect(result.trend.change).toBe("decreasing");
    expect(result.trend.direction).toBe("improving");
  });

  it("gives strain a change but no better/worse direction", async () => {
    const data = history(
      dayRange("2026-09-16", 7).map((day, i) => ({ day, strain: 6 + i })),
      { openLatest: false }
    );
    const result = await getTrend(fakeWhoop(data).client, { metric: "strain", days: 7 }, NOW);

    expect(result.trend.change).toBe("increasing");
    expect(result.trend.direction).toBeNull();
    expect(result.trend.better_when).toBeNull();
    expect(result.notes.join(" ")).toMatch(/trend\.change/);
  });

  it("returns stable when all values are identical (zero variance)", async () => {
    const data = series([75, 75, 75, 75, 75], "recovery");
    const result = await getTrend(fakeWhoop(data).client, { metric: "recovery", days: 7 }, NOW);

    expect(result.trend.change).toBe("stable");
    expect(result.trend.direction).toBe("stable");
    expect(result.statistics.std_dev).toBe(0);
    // Five points cap confidence at low by sample size, not because of zero variance
    expect(result.trend.confidence).toBe("low");
    expect(result.notes).toContain(
      "All 5 values were identical (75), so the metric was flat over this period."
    );
  });

  it("rates a constant series by sample size, not as a poor fit", async () => {
    const constant = (count: number): FakeData => series(Array(count).fill(60), "recovery");

    const ten = await getTrend(fakeWhoop(constant(10)).client, { metric: "recovery" }, NOW);
    const twentyOne = await getTrend(fakeWhoop(constant(21)).client, { metric: "recovery" }, NOW);

    expect(ten.trend.confidence).toBe("medium");
    expect(twentyOne.trend).toEqual({
      direction: "stable",
      change: "stable",
      better_when: "higher",
      slope: 0,
      confidence: "high",
    });
    expect(twentyOne.anomalies).toEqual([]);
    expect(twentyOne.notes).toEqual([
      "All 21 values were identical (60), so the metric was flat over this period.",
    ]);
  });

  it("keeps identical decimal values exact (no rounding drift in mean or std_dev)", async () => {
    const result = await getTrend(
      fakeWhoop(series(Array(14).fill(70.1), "hrv")).client,
      { metric: "hrv" },
      NOW
    );

    expect(result.statistics).toEqual({
      mean: 70.1,
      median: 70.1,
      std_dev: 0,
      min: 70.1,
      max: 70.1,
    });
    expect(result.trend.change).toBe("stable");
    expect(result.trend.confidence).toBe("high");
  });

  it("explains a stable trend from varying values with low confidence", async () => {
    const values = Array.from({ length: 21 }, (_, i) => (i % 2 ? 61 : 59));
    const result = await getTrend(
      fakeWhoop(series(values, "recovery")).client,
      { metric: "recovery" },
      NOW
    );

    expect(result.trend.change).toBe("stable");
    expect(result.trend.confidence).toBe("low");
    expect(result.notes).toContain(
      "No consistent upward or downward direction was found, so the trend is reported as stable; confidence is low because it rates how well a sloped line fits the values."
    );
  });

  it("uses days, not record positions, as the regression x axis when days are missing", async () => {
    // Days 0, 1, 4, 5 of the window with value = 2 * day
    const all = dayRange("2026-09-16", 6);
    const specs = [0, 1, 4, 5].map((offset) => ({ day: all[offset]!, recovery: 2 * offset + 10 }));
    const result = await getTrend(
      fakeWhoop(history(specs, { openLatest: false })).client,
      { metric: "recovery", days: 7 },
      NOW
    );

    expect(result.values).toEqual([10, 12, 18, 20]);
    expect(result.trend.slope).toBeCloseTo(2, 6);
  });
});

describe("getTrend — sparse data and confidence", () => {
  it("returns data without a trend for a calibrating user with 2 recoveries (no throw)", async () => {
    const data = history([
      { day: "2026-09-15", recovery: 95, hrv: 150, calibrating: true },
      { day: "2026-09-16", recovery: 66, hrv: 108, calibrating: true },
    ]);
    const result = await getTrend(fakeWhoop(data).client, { metric: "hrv" }, NOW);

    expect(result.status).toBe("insufficient_data");
    expect(result.sample_size).toBe(2);
    expect(result.values).toEqual([150, 108]);
    expect(result.dates).toEqual(["2026-09-15", "2026-09-16"]);
    // Sample standard deviation (n - 1): sqrt((21² + 21²) / 1) = 21·√2
    expect(result.statistics).toEqual({
      mean: 129,
      median: 129,
      std_dev: expect.closeTo(21 * Math.SQRT2, 10),
      min: 108,
      max: 150,
    });
    expect(result.trend).toEqual({
      direction: null,
      change: null,
      better_when: "higher",
      slope: null,
      confidence: null,
    });
    expect(result.anomalies).toEqual([]);
    expect(result.calibrating).toBe(true);
    expect(result.notes[0]).toBe(
      "Not enough data yet: 2 scored recoveries in the last 30 days; a trend needs at least 4."
    );
    expect(result.notes.join(" ")).toMatch(/WHOOP is still calibrating \(2 of 2/);
  });

  it("returns null statistics and a note for 0 data points", async () => {
    const result = await getTrend(
      fakeWhoop({ recovery: [], sleep: [], cycle: [] }).client,
      { metric: "recovery" },
      NOW
    );

    expect(result.status).toBe("insufficient_data");
    expect(result.sample_size).toBe(0);
    expect(result.values).toEqual([]);
    expect(result.statistics).toEqual({
      mean: null,
      median: null,
      std_dev: null,
      min: null,
      max: null,
    });
    expect(result.trend.slope).toBeNull();
    expect(result.calibrating).toBe(false);
    expect(result.notes[0]).toBe(
      "Not enough data yet: no scored recoveries in the last 30 days; a trend needs at least 4."
    );
  });

  it("gives mean/min/max but a null std_dev for a single data point", async () => {
    const data = history([{ day: "2026-09-16", recovery: 70 }]);
    const result = await getTrend(fakeWhoop(data).client, { metric: "recovery" }, NOW);

    expect(result.statistics).toEqual({ mean: 70, median: 70, std_dev: null, min: 70, max: 70 });
    expect(result.notes[0]).toMatch(/1 scored recovery in the last 30 days/);
  });

  it("caps confidence at low below 7 points and medium below 14", async () => {
    const perfect = (count: number): FakeData =>
      history(
        dayRange("2026-09-16", count).map((day, i) => ({ day, recovery: 20 + i * 4 })),
        { openLatest: false }
      );

    const four = await getTrend(fakeWhoop(perfect(4)).client, { metric: "recovery" }, NOW);
    const ten = await getTrend(fakeWhoop(perfect(10)).client, { metric: "recovery" }, NOW);
    const fourteen = await getTrend(fakeWhoop(perfect(14)).client, { metric: "recovery" }, NOW);

    expect(four.status).toBe("available");
    expect(four.trend.confidence).toBe("low");
    expect(ten.trend.confidence).toBe("medium");
    expect(fourteen.trend.confidence).toBe("high");
  });

  it("skips nights whose sleep performance is null instead of counting them as 0", async () => {
    const data = history([
      { day: "2026-09-14", performance: 80 },
      { day: "2026-09-15", performance: null },
      { day: "2026-09-16", performance: 90 },
    ]);
    const result = await getTrend(fakeWhoop(data).client, { metric: "sleep_performance" }, NOW);

    expect(result.values).toEqual([80, 90]);
    expect(result.statistics.mean).toBe(85);
    expect(result.calibrating).toBeNull();
    expect(result.notes[0]).toBe(
      "Not enough data yet: 2 nights with a sleep performance score in the last 30 days; a trend needs at least 4."
    );
    expect(result.notes.join(" ")).toMatch(/1 scored night\(s\) had no sleep performance score/);
  });

  it("tells scored nights without a performance score apart from no scored nights", async () => {
    const unscored = history([
      { day: "2026-09-15", performance: null },
      { day: "2026-09-16", performance: null },
    ]);
    const withoutScore = await getTrend(
      fakeWhoop(unscored).client,
      { metric: "sleep_performance", days: 7 },
      NOW
    );
    const noNights = await getTrend(
      fakeWhoop({ recovery: [], sleep: [], cycle: [] }).client,
      { metric: "sleep_performance", days: 7 },
      NOW
    );

    expect(withoutScore.status).toBe("insufficient_data");
    expect(withoutScore.sample_size).toBe(0);
    expect(withoutScore.notes).toEqual([
      "Not enough data yet: no nights with a sleep performance score in the last 7 days; a trend needs at least 4.",
      "2 scored night(s) had no sleep performance score and were skipped.",
    ]);
    expect(noNights.notes).toEqual([
      "Not enough data yet: no scored nights in the last 7 days; a trend needs at least 4.",
    ]);
  });

  it("detects anomalies with the date of the anomalous value", async () => {
    const scores = [70, 72, 68, 71, 69, 73, 70, 71, 20, 70];
    const days = dayRange("2026-09-16", scores.length);
    const data = history(
      days.map((day, i) => ({ day, recovery: scores[i] })),
      { openLatest: false }
    );
    const result = await getTrend(fakeWhoop(data).client, { metric: "recovery" }, NOW);

    expect(result.anomalies).toHaveLength(1);
    expect(result.anomalies[0]!.value).toBe(20);
    expect(result.anomalies[0]!.date).toBe(days[8]);
    expect(result.anomalies[0]!.deviation_from_mean).toBeGreaterThan(2);
  });
});

describe("getTrend — windows, joins and data quality", () => {
  it("covers `days` local days including today, starting at local midnight", async () => {
    const { client, paths } = fakeWhoop({ recovery: [], sleep: [], cycle: [] });
    const result = await getTrend(client, { metric: "recovery", days: 14 }, NOW);

    expect(result.period).toEqual({
      start: "2026-09-03T00:00:00.000Z",
      end: "2026-09-16T12:00:00.000Z",
      days: 14,
    });
    // Offset lookup falls back to UTC without cycles; the query starts a day early
    const query = paths.find((path) => path.startsWith("/v2/recovery?"))!;
    expect(query).toContain("start=2026-09-02T00%3A00%3A00.000Z");
  });

  it("writes the period in the user's offset and defaults to 30 days", async () => {
    const data = history([{ day: "2026-09-16", recovery: 60 }]);
    const result = await getTrend(fakeWhoop(data).client, { metric: "recovery" }, NOW);

    expect(result.period).toEqual({
      start: "2026-08-18T00:00:00.000+02:00",
      end: "2026-09-16T14:00:00.000+02:00",
      days: 30,
    });
  });

  it("excludes records outside the local-day window even if WHOOP returns them", async () => {
    // Window for days=7 is 2026-09-10..2026-09-16; 2026-09-09 is only in the query margin
    const data = history([
      { day: "2026-09-09", recovery: 5, strain: 20 },
      { day: "2026-09-10", recovery: 60, strain: 10 },
      { day: "2026-09-16", recovery: 70, strain: 11 },
    ]);
    const recovery = await getTrend(fakeWhoop(data).client, { metric: "recovery", days: 7 }, NOW);
    const sleep = await getTrend(
      fakeWhoop(data).client,
      { metric: "sleep_duration", days: 7 },
      NOW
    );

    expect(recovery.values).toEqual([60, 70]);
    expect(recovery.dates).toEqual(["2026-09-10", "2026-09-16"]);
    expect(sleep.dates).toEqual(["2026-09-10", "2026-09-16"]);
  });

  it("dates a recovery by its cycle even when it was recorded (synced) a day later", async () => {
    const data = history([
      { day: "2026-09-14", recovery: 50 },
      { day: "2026-09-15", recovery: 60 },
      { day: "2026-09-16", recovery: 70 },
    ]);
    const late = data.recovery.find((r) => r.cycle_id === 2)!;
    late.created_at = "2026-09-16T09:00:00.000Z";

    const result = await getTrend(fakeWhoop(data).client, { metric: "recovery" }, NOW);

    expect(result.values).toEqual([50, 60, 70]);
    expect(result.dates).toEqual(["2026-09-14", "2026-09-15", "2026-09-16"]);
  });

  it("falls back to when a recovery was recorded if cycles cannot be loaded", async () => {
    const data = history([
      { day: "2026-09-15", recovery: 60 },
      { day: "2026-09-16", recovery: 70 },
    ]);
    const { client } = fakeWhoop(data, { fail: { cycle: new WhoopApiError(500, "err", null) } });
    const result = await getTrend(client, { metric: "recovery" }, NOW);

    expect(result.values).toEqual([60, 70]);
    expect(result.dates).toEqual(["2026-09-15", "2026-09-16"]);
    expect(result.notes.join(" ")).toMatch(/Cycle data could not be loaded/);
  });

  it("leaves the in-progress cycle out of strain and says so", async () => {
    const data = history([
      { day: "2026-09-14", strain: 12 },
      { day: "2026-09-15", strain: 14 },
      { day: "2026-09-16", strain: 3 },
    ]);
    expect(data.cycle[0]!.end).toBeNull();

    const result = await getTrend(fakeWhoop(data).client, { metric: "strain" }, NOW);

    expect(result.values).toEqual([12, 14]);
    expect(result.notes).toContain(
      "Today's (2026-09-16) strain is still accumulating and is not included in daily strain."
    );
  });

  /** A history whose first cycle starts at local midnight of 09-13 with no sleep (the strap was put on) */
  function strapOnHistory(): FakeData {
    const data = history([
      { day: "2026-09-13", strain: 4 },
      { day: "2026-09-14", strain: 12 },
      { day: "2026-09-15", strain: 14 },
      { day: "2026-09-16", strain: 3 },
    ]);
    const first = data.cycle.find((cycle) => cycle.id === 1)!;
    first.start = "2026-09-12T22:00:00.000Z"; // 2026-09-13 00:00 local
    data.sleep = data.sleep.filter((sleep) => sleep.cycle_id !== 1);
    data.recovery = data.recovery.filter((recovery) => recovery.cycle_id !== 1);
    return data;
  }

  it("leaves a partial first day of wear out of strain and says so", async () => {
    const result = await getTrend(fakeWhoop(strapOnHistory()).client, { metric: "strain" }, NOW);

    expect(result.values).toEqual([12, 14]);
    expect(result.dates).toEqual(["2026-09-14", "2026-09-15"]);
    expect(result.sample_size).toBe(2);
    expect(result.statistics.mean).toBe(13);
    expect(result.notes).toContain(
      "1 day WHOOP covered only in part (the strap was put on that day) is left out of strain."
    );
  });

  it("still leaves a midnight-start cycle without a main sleep out when sleeps cannot be loaded", async () => {
    const { client, paths } = fakeWhoop(strapOnHistory(), {
      fail: { sleep: new WhoopApiError(500, "err", null) },
    });
    const result = await getTrend(client, { metric: "strain" }, NOW);

    expect(result.values).toEqual([12, 14]);
    expect(result.notes.join(" ")).toMatch(/1 day WHOOP covered only in part/);
    // One cycle request and one sleep request for the window
    const windowed = paths.filter((path) => path.includes("start="));
    expect(windowed.filter((path) => path.includes("cycle"))).toHaveLength(1);
    expect(windowed.filter((path) => path.includes("sleep"))).toHaveLength(1);
  });

  it("filters unscored records", async () => {
    const data = history([
      { day: "2026-09-14", recovery: 70 },
      { day: "2026-09-15", recovery: 50 },
      { day: "2026-09-16", recovery: 80 },
    ]);
    const pending = data.recovery.find((r) => r.cycle_id === 2)!;
    pending.score_state = "PENDING_SCORE";
    pending.score = null;

    const result = await getTrend(fakeWhoop(data).client, { metric: "recovery" }, NOW);

    expect(result.values).toEqual([70, 80]);
  });

  it("skips records that do not match the WHOOP format and notes it", async () => {
    const data = history([
      { day: "2026-09-15", recovery: 60 },
      { day: "2026-09-16", recovery: 70 },
    ]);
    (data.recovery[0]!.score as Record<string, unknown>).recovery_score = "high";

    const result = await getTrend(fakeWhoop(data).client, { metric: "recovery" }, NOW);

    expect(result.values).toEqual([60]);
    expect(result.notes.join(" ")).toMatch(/1 recovery record\(s\) did not match/);
  });

  it("surfaces pagination truncation", async () => {
    const data = history(dayRange("2026-09-16", 5).map((day) => ({ day })));
    const { client } = fakeWhoop(data, { endless: "recovery" });
    const result = await getTrend(client, { metric: "recovery" }, NOW);

    expect(result.truncated).toBe(true);
    expect(result.notes.join(" ")).toMatch(/oldest days of the window are missing/);
  });

  it("rethrows WHOOP API failures of the metric's own endpoint", async () => {
    const data = history([{ day: "2026-09-16" }]);
    const { client } = fakeWhoop(data, { fail: { sleep: new WhoopApiError(503, "down", null) } });

    await expect(getTrend(client, { metric: "sleep_duration" }, NOW)).rejects.toBeInstanceOf(
      WhoopApiError
    );
  });
});

describe("get_trend output contract", () => {
  async function callTrend(
    data: FakeData,
    metric: TrendMetric,
    privacyMode: "standard" | "aggregate"
  ): Promise<{ isError?: boolean; structuredContent?: Record<string, unknown> }> {
    const { server } = createWhoopServer(fakeWhoop(data).client, { privacyMode });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: "test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
    try {
      return (await mcp.callTool({ name: "get_trend", arguments: { metric } })) as {
        isError?: boolean;
        structuredContent?: Record<string, unknown>;
      };
    } finally {
      await mcp.close();
      await server.close();
    }
  }

  const sparse = history([
    { day: "2026-09-15", recovery: 95, performance: null, calibrating: true },
    { day: "2026-09-16", recovery: 66, calibrating: true },
  ]);
  const empty: FakeData = { recovery: [], sleep: [], cycle: [] };

  for (const privacyMode of ["standard", "aggregate"] as const) {
    for (const metric of [
      "recovery",
      "hrv",
      "rhr",
      "sleep_duration",
      "sleep_performance",
      "strain",
    ] as const) {
      it(`passes the ${privacyMode} contract for sparse and empty ${metric} data`, async () => {
        for (const data of [sparse, empty]) {
          const result = await callTrend(data, metric, privacyMode);
          expect(result.isError).toBeFalsy();
          expect(result.structuredContent?.status).toBe("insufficient_data");
        }
      });
    }
  }

  it("omits per-day values and dates in aggregate mode", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    try {
      const result = await callTrend(sparse, "recovery", "aggregate");

      expect(result.structuredContent).not.toHaveProperty("values");
      expect(result.structuredContent).not.toHaveProperty("dates");
      expect(result.structuredContent).not.toHaveProperty("anomalies");
      // Both nights are in the current week, which is not released yet
      expect(result.structuredContent?.sample_size).toBe(0);
      expect(result.structuredContent?.statistics).toEqual({ mean: null, std_dev: null });
      expect(result.structuredContent?.period).toEqual({
        start: "2026-07-20",
        end: "2026-09-13",
        days: 56,
      });
      expect(result.structuredContent?.notes).toContain(
        "Aggregate privacy mode uses whole released weeks: 8 weeks ending 2026-09-13."
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps full statistics for the same sparse data in standard mode", async () => {
    const result = await callTrend(sparse, "recovery", "standard");

    expect(result.structuredContent?.statistics).toMatchObject({ min: 66, max: 95 });
  });
});

// ---------------------------------------------------------------------------
// Metrics added for sleep detail, sleep debt, SpO2 and skin temperature
// ---------------------------------------------------------------------------

describe("getTrend — sleep detail, sleep debt, SpO2 and skin temperature", () => {
  const dayList = ["2026-09-12", "2026-09-13", "2026-09-14", "2026-09-15", "2026-09-16"];

  async function trend(specs: DaySpec[], metric: TrendMetric): ReturnType<typeof getTrend> {
    return getTrend(fakeWhoop(history(specs)).client, { metric, days: 7 }, NOW);
  }

  it("maps sleep_efficiency to WHOOP's percentage, skipping nights without one (null is not 0)", async () => {
    const result = await trend(
      dayList.map((day, index) => ({ day, efficiency: [90, 85, null, 80, 95][index] })),
      "sleep_efficiency"
    );

    expect(result.values).toEqual([90, 85, 80, 95]);
    expect(result.dates).toEqual(["2026-09-12", "2026-09-13", "2026-09-15", "2026-09-16"]);
    expect(result.trend.better_when).toBe("higher");
    expect(result.notes).toContain("1 scored night had no sleep efficiency and was skipped.");
  });

  it("gives respiratory rate a change but no better or worse direction", async () => {
    const result = await trend(
      dayList.map((day, index) => ({ day, respiratory: 14 + index })),
      "respiratory_rate"
    );

    expect(result.values).toEqual([14, 15, 16, 17, 18]);
    expect(result.trend).toMatchObject({
      change: "increasing",
      direction: null,
      better_when: null,
    });
    expect(result.notes).toContain(
      "Respiratory rate is neither better nor worse when higher, so only trend.change is given."
    );
  });

  it("maps rem_share and deep_share to percentages of time asleep", async () => {
    const specs = dayList.map((day, index) => ({
      day,
      lightMs: 4 * HOUR_MS,
      swsMs: (1 + index * 0.25) * HOUR_MS,
      remMs: 1 * HOUR_MS,
    }));
    const rem = await trend(specs, "rem_share");
    const deep = await trend(specs, "deep_share");

    const asleep = (index: number): number => 6 + index * 0.25;
    expect(rem.values.map((value) => Number(value.toFixed(6)))).toEqual(
      dayList.map((_, index) => Number((100 / asleep(index)).toFixed(6)))
    );
    expect(deep.values.map((value) => Number(value.toFixed(6)))).toEqual(
      dayList.map((_, index) => Number(((100 * (1 + index * 0.25)) / asleep(index)).toFixed(6)))
    );
    expect(rem.trend.direction).toBeNull();
    expect(deep.trend.better_when).toBeNull();
  });

  it("maps disturbances_per_hour to disturbances per hour asleep and skips nights under 1 hour asleep", async () => {
    const result = await trend(
      [
        { day: "2026-09-12", disturbances: 14 },
        { day: "2026-09-13", disturbances: 7 },
        { day: "2026-09-14", disturbances: 3, lightMs: 0.5 * HOUR_MS, swsMs: 0, remMs: 0 },
        { day: "2026-09-15", disturbances: 21 },
      ],
      "disturbances_per_hour"
    );

    expect(result.values).toEqual([2, 1, 3]);
    expect(result.notes).toContain(
      "1 night with less than 1 hour asleep was skipped: disturbances per hour needs at least 1 hour asleep."
    );
  });

  it("skips sleep consistency zeros WHOOP reports while calibrating, but keeps a real 0", async () => {
    const { client, paths } = fakeWhoop(
      history([
        { day: "2026-09-12", consistency: 0, calibrating: true },
        { day: "2026-09-13", consistency: 0, calibrating: false },
        { day: "2026-09-14", consistency: 0, recoveryState: "PENDING_SCORE" },
        { day: "2026-09-15", consistency: 70 },
        { day: "2026-09-16", consistency: null },
      ])
    );
    const result = await getTrend(client, { metric: "sleep_consistency", days: 7 }, NOW);

    expect(result.values).toEqual([0, 70]);
    expect(result.dates).toEqual(["2026-09-13", "2026-09-15"]);
    expect(paths.some((path) => path.startsWith("/v2/recovery?"))).toBe(true);
    expect(result.notes).toEqual(
      expect.arrayContaining([
        "1 scored night had no sleep consistency and was skipped.",
        "1 night had a sleep consistency of 0 while WHOOP was still calibrating and was skipped (WHOOP reports 0 until calibration ends).",
        "1 night had a sleep consistency of 0 without a scored recovery to check WHOOP's calibration flag and was skipped.",
      ])
    );
    expect(result.trend.better_when).toBe("higher");
  });

  it("maps sleep_debt to WHOOP's sleep-debt need in hours, lower being better", async () => {
    const result = await trend(
      dayList.map((day, index) => ({ day, debtMs: (2 - index * 0.25) * HOUR_MS })),
      "sleep_debt"
    );

    expect(result.values).toEqual([2, 1.75, 1.5, 1.25, 1]);
    expect(result.trend).toMatchObject({
      change: "decreasing",
      direction: "improving",
      better_when: "lower",
    });
  });

  it("skips nights with low data coverage only for the added sleep metrics", async () => {
    const specs = dayList.map((day, index) => ({
      day,
      // 2 h without strap data out of 8 h in bed on the middle night (25% > 20%)
      noDataMs: index === 2 ? 2 * HOUR_MS : 0,
      lightMs: index === 2 ? 2.5 * HOUR_MS : undefined,
      debtMs: HOUR_MS,
      consistency: 75,
    }));
    const note =
      "1 night with low data coverage (no strap data for more than 20% of time in bed) was skipped.";
    for (const metric of [
      "sleep_efficiency",
      "rem_share",
      "deep_share",
      "disturbances_per_hour",
      "sleep_debt",
    ] as const) {
      const result = await trend(specs, metric);
      expect(result.sample_size, metric).toBe(4);
      expect(result.notes, metric).toContain(note);
    }
    for (const metric of [
      "sleep_duration",
      "sleep_performance",
      "respiratory_rate",
      "sleep_consistency",
    ] as const) {
      const result = await trend(specs, metric);
      expect(result.sample_size, metric).toBe(5);
      expect(result.notes, metric).not.toContain(note);
    }
  });

  it("maps spo2 and skin_temp to recovery fields, skipping nulls with a count note", async () => {
    const specs = dayList.map((day, index) => ({
      day,
      spo2: [96, null, 95.5, null, 97][index],
      skinTemp: [33.1, 33.4, null, 33.9, 34.2][index],
    }));
    const spo2 = await trend(specs, "spo2");
    const skin = await trend(specs, "skin_temp");

    expect(spo2.values).toEqual([96, 95.5, 97]);
    expect(spo2.notes).toContain(
      "2 scored recoveries had no SpO2 and were skipped: not reported (WHOOP 4.0 or later)."
    );
    expect(spo2.trend.better_when).toBeNull();
    expect(skin.values).toEqual([33.1, 33.4, 33.9, 34.2]);
    expect(skin.notes).toContain(
      "1 scored recovery had no skin temperature and was skipped: not reported (WHOOP 4.0 or later)."
    );
    expect(skin.trend).toMatchObject({ change: "increasing", direction: null });
    expect(skin.calibrating).toBe(false);
  });

  it("explains a device that reports no SpO2 at all instead of reporting no recoveries", async () => {
    const result = await trend(
      dayList.map((day) => ({ day, spo2: null })),
      "spo2"
    );

    expect(result.status).toBe("insufficient_data");
    expect(result.statistics.mean).toBeNull();
    expect(result.notes[0]).toBe(
      "Not enough data yet: no scored recoveries with SpO2 in the last 7 days; a trend needs at least 4."
    );
    expect(result.notes).toContain(
      "5 scored recoveries had no SpO2 and were skipped: not reported (WHOOP 4.0 or later)."
    );
  });

  it("flags calibrating recoveries for spo2 without claiming the values shift", async () => {
    const result = await trend(
      dayList.map((day) => ({ day, calibrating: true })),
      "spo2"
    );

    expect(result.calibrating).toBe(true);
    expect(result.notes).toContain(
      "WHOOP is still calibrating (5 of 5 scored recoveries flagged); these recoveries are included."
    );
  });
});

// ---------------------------------------------------------------------------
// Shared fixture users
// ---------------------------------------------------------------------------

interface ToolResult {
  isError: boolean;
  text: string;
  structured: Record<string, unknown> | null;
}

describe("get_trend on the shared fixture users", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  async function callAll(
    data: ReturnType<typeof liveShapedUser>,
    privacyMode: "standard" | "aggregate",
    days: number
  ): Promise<Map<TrendMetric, ToolResult>> {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(data.now);
    const connection = await connectServer(createWhoopFixtureClient(data), {
      privacyMode,
      disableResources: true,
    });
    const results = new Map<TrendMetric, ToolResult>();
    try {
      for (const metric of TREND_METRICS) {
        results.set(metric, await connection.callTool("get_trend", { metric, days }));
      }
    } finally {
      await connection.close();
    }
    return results;
  }

  it("reports every metric as insufficient data for the calibrating live-shaped user", async () => {
    const results = await callAll(liveShapedUser(), "standard", 7);
    for (const [metric, result] of results) {
      expect(result.isError, `${metric}: ${result.text}`).toBe(false);
      expect(result.structured?.status, metric).toBe("insufficient_data");
      expect(result.structured?.trend, metric).toMatchObject({ direction: null, slope: null });
      assertNeutralText(result.structured);
    }
    // The calibration zeros WHOOP reports for sleep consistency are not values.
    expect(results.get("sleep_consistency")?.structured?.sample_size).toBe(0);
    // Both scored recoveries have a numeric SpO2 and skin temperature.
    expect(results.get("spo2")?.structured?.sample_size).toBe(2);
    expect(results.get("skin_temp")?.structured?.calibrating).toBe(true);
  });

  it("computes every metric on 90 days of a mature account", async () => {
    const results = await callAll(matureUser(), "standard", 90);
    for (const [metric, result] of results) {
      expect(result.isError, `${metric}: ${result.text}`).toBe(false);
      expect(result.structured?.status, metric).toBe("available");
      expect(Number(result.structured?.sample_size), metric).toBeGreaterThan(60);
      assertNeutralText(result.structured);
    }
    const efficiency = results.get("sleep_efficiency")!.structured!;
    const duration = results.get("sleep_duration")!.structured!;
    // Every 11th night has low data coverage: only the added sleep metrics leave it out.
    expect(Number(efficiency.sample_size)).toBeLessThan(Number(duration.sample_size));
    expect(efficiency.notes).toEqual(
      expect.arrayContaining([expect.stringMatching(/with low data coverage .* were skipped\.$/)])
    );
  });

  it("stays within the text size limit at 90 days on the stress user", async () => {
    const results = await callAll(stressUser(), "standard", 90);
    for (const [metric, result] of results) {
      expect(result.isError, `${metric}: ${result.text.slice(0, 200)}`).toBe(false);
      expect(result.text.length, metric).toBeLessThan(MAX_TOOL_TEXT_CHARS);
    }
  });

  it("returns rounded statistics over whole released weeks in aggregate mode", async () => {
    const results = await callAll(matureUser(), "aggregate", 30);
    const tenths = new Set<TrendMetric>([
      "skin_temp",
      "sleep_duration",
      "respiratory_rate",
      "disturbances_per_hour",
      "sleep_debt",
      "strain",
    ]);
    for (const [metric, result] of results) {
      expect(result.isError, `${metric}: ${result.text}`).toBe(false);
      const structured = result.structured!;
      expect(structured).not.toHaveProperty("values");
      expect(structured).not.toHaveProperty("anomalies");
      // 30 days snap to 8 released weeks, the latest ending the Sunday before Wednesday 09-16
      expect(structured.period, metric).toEqual({
        start: "2026-07-20",
        end: "2026-09-13",
        days: 56,
      });
      expect(structured.status, metric).toBe("available");
      const { mean, std_dev: sd } = structured.statistics as { mean: number; std_dev: number };
      const step = tenths.has(metric) ? 0.1 : 1;
      for (const value of [mean, sd]) {
        expect(
          Math.abs(value / step - Math.round(value / step)),
          `${metric} ${value}`
        ).toBeLessThan(1e-9);
      }
      assertNeutralText(structured);
    }
  });

  /** Call tools on a standard-mode server at `now` (default: the fixture's own now) */
  async function callAt(
    data: ReturnType<typeof liveShapedUser>,
    calls: Array<[string, Record<string, unknown>]>,
    now: Date = data.now
  ): Promise<Array<Record<string, unknown>>> {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const connection = await connectServer(createWhoopFixtureClient(data), {
      disableResources: true,
    });
    const results: Array<Record<string, unknown>> = [];
    try {
      for (const [name, args] of calls) {
        const result = await connection.callTool(name, args);
        expect(result.isError, `${name}: ${result.text}`).toBe(false);
        results.push(result.structured!);
      }
    } finally {
      await connection.close();
    }
    return results;
  }

  it("leaves the partial first day of the live-shaped user out of strain, as get_calendar does", async () => {
    const [trend, calendar] = (await callAt(liveShapedUser(), [
      ["get_trend", { metric: "strain", days: 7 }],
      ["get_calendar", { days: 7 }],
    ])) as [
      { dates: string[]; sample_size: number; statistics: { mean: number }; notes: string[] },
      { averages: { strain: number; sample_sizes: { strain: number } } },
    ];
    // The first cycle starts 2026-09-14 00:00 local, before the first sleep.
    expect(trend.dates).not.toContain("2026-09-14");
    expect(trend.dates).toEqual(["2026-09-15"]);
    expect(trend.sample_size).toBe(calendar.averages.sample_sizes.strain);
    expect(Math.round(trend.statistics.mean * 10) / 10).toBe(calendar.averages.strain);
    expect(trend.notes).toContain(
      "1 day WHOOP covered only in part (the strap was put on that day) is left out of strain."
    );
  });

  it("names the open cycle's day, not today, when strain is still accumulating after midnight", async () => {
    const [trend] = (await callAt(liveShapedUser({ now: "2026-09-17T01:30:00+02:00" }), [
      ["get_trend", { metric: "strain", days: 7 }],
    ])) as [{ notes: string[] }];
    expect(trend.notes).toContain(
      "Strain for 2026-09-16 is still accumulating (its WHOOP cycle stays open until the next sleep syncs) and is not included in daily strain."
    );
    expect(trend.notes.join(" ")).toMatch(
      /No WHOOP cycle has started yet for 2026-09-17 \(today\)/
    );
    expect(trend.notes.join(" ")).not.toMatch(/Today's/);
  });

  it("names Sunday's open cycle on Monday after midnight", async () => {
    const [trend] = (await callAt(
      matureUser({ now: "2026-09-20T22:00:00+01:00" }),
      [["get_trend", { metric: "strain", days: 7 }]],
      new Date("2026-09-21T00:30:00+01:00")
    )) as [{ dates: string[]; notes: string[] }];
    expect(trend.notes).toContain(
      "Strain for 2026-09-20 is still accumulating (its WHOOP cycle stays open until the next sleep syncs) and is not included in daily strain."
    );
    expect(trend.dates).not.toContain("2026-09-20");
    expect(trend.notes.join(" ")).not.toMatch(/Today's/);
  });

  it("reports the same sample standard deviation as get_sleep_analysis and get_recovery_analysis", async () => {
    type Summary = Record<string, { n: number; mean: number | null; sd: number | null }> | null;
    const pairs = [
      ["sleep_duration", 0, "asleep_hours"],
      ["recovery", 1, "recovery"],
      ["hrv", 1, "hrv"],
      ["rhr", 1, "rhr"],
    ] as const;
    let compared = 0;
    for (const [data, days] of [
      [liveShapedUser(), 7],
      [matureUser(), 7],
      [matureUser(), 30],
    ] as const) {
      const results = await callAt(data, [
        ["get_sleep_analysis", { days }],
        ["get_recovery_analysis", { days }],
        ...pairs.map(([metric]): [string, Record<string, unknown>] => [
          "get_trend",
          { metric, days },
        ]),
      ]);
      vi.useRealTimers();
      pairs.forEach(([metric, source, field], index) => {
        const trend = results[index + 2] as {
          values: number[];
          sample_size: number;
          statistics: { mean: number | null; std_dev: number | null };
        };
        const label = `${metric} over ${days} days`;
        // std_dev is the sample (n - 1) standard deviation of the returned values
        expect(trend.statistics.std_dev, label).toBe(sampleStandardDeviation(trend.values));
        const other = (results[source]!.summary as Summary)?.[field];
        if (!other || other.sd === null || other.mean === null) return;
        if (other.n !== trend.sample_size) return;
        if (Math.abs(other.mean - trend.statistics.mean!) > 0.051) return;
        expect(Math.abs(trend.statistics.std_dev! - other.sd), label).toBeLessThanOrEqual(0.005001);
        compared += 1;
      });
    }
    // Every metric of the 7-day mature window and the recovery metrics of the 30-day one
    expect(compared).toBeGreaterThanOrEqual(7);
  });

  it("snaps 8 to 14 days to the same two released weeks, so one extra day never changes the result", async () => {
    const data = matureUser();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(data.now);
    const connection = await connectServer(createWhoopFixtureClient(data), {
      privacyMode: "aggregate",
      disableResources: true,
    });
    try {
      const outputs: Record<string, unknown>[] = [];
      for (let days = 7; days <= 14; days++) {
        outputs.push((await connection.callTool("get_trend", { metric: "hrv", days })).structured!);
      }
      const [oneWeek, ...twoWeeks] = outputs;
      for (const output of twoWeeks) expect(output).toEqual(twoWeeks[0]);
      // The difference between 7 and 8 days is a whole released week, never a single day.
      const difference = Number(twoWeeks[0]!.sample_size) - Number(oneWeek!.sample_size);
      expect(difference === 0 || difference >= 3).toBe(true);
      expect(oneWeek!.period).toEqual({ start: "2026-09-07", end: "2026-09-13", days: 7 });
    } finally {
      await connection.close();
    }
  });
});
