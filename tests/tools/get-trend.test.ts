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

import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { WhoopClient } from "../../src/api/client.js";
import { WhoopApiError } from "../../src/api/client.js";
import { createWhoopServer } from "../../src/server.js";
import { getTrend } from "../../src/tools/get-trend.js";
import type { TrendMetric } from "../../src/tools/get-trend.js";

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
}

const NOW = new Date("2026-09-16T12:00:00.000Z"); // 14:00 local (+02:00), a Wednesday
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function shiftDay(day: string, count: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + count * DAY_MS).toISOString().slice(0, 10);
}

function stageSummary(): Record<string, number> {
  return {
    total_in_bed_time_milli: 8 * HOUR_MS,
    total_awake_time_milli: HOUR_MS,
    total_no_data_time_milli: 0,
    total_light_sleep_time_milli: 3.5 * HOUR_MS,
    total_slow_wave_sleep_time_milli: 1.5 * HOUR_MS,
    total_rem_sleep_time_milli: 2 * HOUR_MS, // 7h asleep, 8h in bed
    sleep_cycle_count: 4,
    disturbance_count: 10,
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
        stage_summary: stageSummary(),
        sleep_needed: {
          baseline_milli: 8 * HOUR_MS,
          need_from_sleep_debt_milli: 0,
          need_from_recent_strain_milli: 0,
          need_from_recent_nap_milli: 0,
        },
        respiratory_rate: 15,
        sleep_performance_percentage: spec.performance === undefined ? 80 : spec.performance,
        sleep_consistency_percentage: 0,
        sleep_efficiency_percentage: 88,
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
    expect(result.statistics).toEqual({ mean: 129, median: 129, std_dev: 21, min: 108, max: 150 });
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
    expect(result.notes).toContain("Today's strain is still accumulating and is not included.");
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
    const result = await callTrend(sparse, "recovery", "aggregate");

    expect(result.structuredContent).not.toHaveProperty("values");
    expect(result.structuredContent).not.toHaveProperty("dates");
    expect(result.structuredContent).not.toHaveProperty("anomalies");
    expect(result.structuredContent?.notes).toBeDefined();
    // Two points (95 and 66): statistics would reveal both nights, so they are withheld
    expect(result.structuredContent?.sample_size).toBe(2);
    expect(result.structuredContent?.statistics).toEqual({ mean: null, std_dev: null });
    expect(result.structuredContent?.notes).toContain(
      "Aggregate privacy mode withholds statistics until at least 4 data points exist (2 so far)."
    );
  });

  it("keeps full statistics for the same sparse data in standard mode", async () => {
    const result = await callTrend(sparse, "recovery", "standard");

    expect(result.structuredContent?.statistics).toMatchObject({ min: 66, max: 95 });
  });
});
