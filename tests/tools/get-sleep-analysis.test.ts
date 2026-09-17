/**
 * Tests for get_sleep_analysis (package P8).
 *
 * Covers: the live-shaped calibrating account (2 nights, insufficient data,
 * calibration zeros, the 00:39 onset night), a 14-night mature account (pending
 * night, nap, low-coverage night, split night, offset change), time-weighted
 * stage shares, parity of night dates with get_sleep_debt, negative nap need,
 * truncated history, shuffled pages, source failures, bad input, output size
 * and requests on stressUser, neutral wording and the MCP contract.
 */

import { describe, expect, it } from "vitest";
import { WhoopApiError, type WhoopClient } from "../../src/api/client.js";
import { DEFAULT_PAGE_BUDGET, HISTORY_DEADLINE_MS } from "../../src/api/history.js";
import { MemoryCache } from "../../src/cache/memory-cache.js";
import type { Recovery, Sleep } from "../../src/api/types.js";
import { DAY_MS, localDay } from "../../src/tools/analytics-utils.js";
import { InvalidDateExpression } from "../../src/tools/date-utils.js";
import {
  getSleepAnalysisTool,
  runSleepAnalysis,
  SLEEP_ANALYSIS_MAX_NIGHT_ROWS,
  SLEEP_ANALYSIS_MIN_NIGHTS,
  sleepAnalysisOutputSchema,
  type SleepAnalysisReport,
} from "../../src/tools/get-sleep-analysis.js";
import { getSleepDebt, SLEEP_DEBT_MIN_NIGHTS } from "../../src/tools/get-sleep-debt.js";
import { LOW_DATA_COVERAGE_FRACTION } from "../../src/tools/sleep-metrics.js";
import { MAX_TOOL_TEXT_CHARS, type ToolContext } from "../../src/tools/tool-definition.js";
import { assertNeutralText, connectServer, listToolNames } from "../helpers/contract.js";
import {
  createWhoopFixtureClient,
  type WhoopFixtureClient,
  type WhoopFixtureClientOptions,
} from "../helpers/whoop-fixture-client.js";
import {
  createLcg,
  LIVE_SHAPED_IDS,
  liveShapedUser,
  matureUser,
  stressUser,
  type WhoopUserFixture,
} from "../helpers/whoop-users.js";

/** Tests that run stressUser or the MCP server take longer under a loaded full-suite run. */
const HEAVY_TEST_TIMEOUT_MS = 30_000;

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

type Args = Parameters<typeof runSleepAnalysis>[0];

function clientFor(
  user: WhoopUserFixture,
  extra: Partial<WhoopFixtureClientOptions> = {}
): WhoopFixtureClient {
  return createWhoopFixtureClient({
    cycles: user.cycles,
    sleeps: user.sleeps,
    recoveries: user.recoveries,
    workouts: user.workouts,
    now: user.now,
    ...extra,
  });
}

function contextFor(client: WhoopClient, now: Date): ToolContext {
  return { client, privacyMode: "standard", now: () => now, startedAtMs: Date.now() };
}

async function analyse(
  user: WhoopUserFixture,
  args: Args = {},
  client: WhoopClient = clientFor(user)
): Promise<SleepAnalysisReport> {
  const report = await runSleepAnalysis(args, contextFor(client, user.now));
  sleepAnalysisOutputSchema.parse(report);
  assertNeutralText([report.notes, report.warnings, report.data_quality.limitations]);
  return report;
}

function asleepMs(sleep: Sleep): number {
  const stages = sleep.score!.stage_summary;
  return (
    stages.total_light_sleep_time_milli +
    stages.total_slow_wave_sleep_time_milli +
    stages.total_rem_sleep_time_milli
  );
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Main sleeps ending in [startMs, endMs), one per wake day (scored, then longest). */
function windowNights(sleeps: readonly Sleep[], startMs: number, endMs: number): Sleep[] {
  const byDay = new Map<string, Sleep>();
  for (const sleep of sleeps) {
    const end = Date.parse(sleep.end);
    if (sleep.nap || end < startMs || end >= endMs) continue;
    const day = localDay(sleep.end, sleep.timezone_offset);
    const current = byDay.get(day);
    const length = (s: Sleep): number => Date.parse(s.end) - Date.parse(s.start);
    const scored = (s: Sleep): boolean => s.score_state === "SCORED";
    if (
      !current ||
      (scored(sleep) && !scored(current)) ||
      (scored(sleep) === scored(current) && length(sleep) > length(current))
    )
      byDay.set(day, sleep);
  }
  return [...byDay.values()].sort((a, b) => Date.parse(b.end) - Date.parse(a.end));
}

// ---------------------------------------------------------------------------
// A tiny night builder (explicit stage minutes)
// ---------------------------------------------------------------------------

interface NightSpec {
  wakeDay: string;
  lightMin: number;
  swsMin: number;
  remMin: number;
  awakeMin?: number;
  offset?: string;
}

function builtUser(specs: readonly NightSpec[], now: string): WhoopUserFixture {
  const base = liveShapedUser({ now });
  const sleeps: Sleep[] = [];
  const recoveries: Recovery[] = [];
  specs.forEach((spec, index) => {
    const offset = spec.offset ?? "+02:00";
    const awake = (spec.awakeMin ?? 30) * MINUTE_MS;
    const asleep = (spec.lightMin + spec.swsMin + spec.remMin) * MINUTE_MS;
    const endMs = Date.parse(`${spec.wakeDay}T07:00:00${offset}`);
    const startMs = endMs - asleep - awake;
    const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    sleeps.push({
      user_id: 1,
      created_at: new Date(endMs + 5 * MINUTE_MS).toISOString(),
      updated_at: new Date(endMs + 5 * MINUTE_MS).toISOString(),
      score_state: "SCORED",
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
      timezone_offset: offset,
      id,
      cycle_id: 5000 + index,
      nap: false,
      v1_id: null,
      score: {
        stage_summary: {
          total_in_bed_time_milli: endMs - startMs,
          total_awake_time_milli: awake,
          total_no_data_time_milli: 0,
          total_light_sleep_time_milli: spec.lightMin * MINUTE_MS,
          total_slow_wave_sleep_time_milli: spec.swsMin * MINUTE_MS,
          total_rem_sleep_time_milli: spec.remMin * MINUTE_MS,
          sleep_cycle_count: 4,
          disturbance_count: 10,
        },
        sleep_needed: {
          baseline_milli: 27_000_000,
          need_from_sleep_debt_milli: 0,
          need_from_recent_strain_milli: 0,
          need_from_recent_nap_milli: 0,
        },
        respiratory_rate: 15,
        sleep_performance_percentage: 90,
        sleep_efficiency_percentage: 92,
        sleep_consistency_percentage: 80,
      },
    });
    recoveries.push({
      cycle_id: 5000 + index,
      sleep_id: id,
      user_id: 1,
      created_at: new Date(endMs + 5 * MINUTE_MS).toISOString(),
      updated_at: new Date(endMs + 5 * MINUTE_MS).toISOString(),
      score_state: "SCORED",
      score: {
        user_calibrating: false,
        recovery_score: 60,
        resting_heart_rate: 55,
        hrv_rmssd_milli: 60,
        spo2_percentage: 96,
        skin_temp_celsius: 33.5,
      },
    });
  });
  return { ...base, cycles: [], workouts: [], sleeps, recoveries };
}

// ---------------------------------------------------------------------------
// Live-shaped account
// ---------------------------------------------------------------------------

describe("live-shaped calibrating account", () => {
  it("lists both nights with insufficient data, calibration zeros and no naps", async () => {
    const user = liveShapedUser();
    const report = await analyse(user);
    expect(report.status).toBe("insufficient_data");
    expect(report.nights_required).toBe(SLEEP_ANALYSIS_MIN_NIGHTS);
    expect(SLEEP_ANALYSIS_MIN_NIGHTS).toBe(SLEEP_DEBT_MIN_NIGHTS);
    expect(report.nights_analyzed).toBe(2);
    expect(report.summary).toBeNull();
    expect(report.need).toBeNull();
    expect(report.timing).toBeNull();
    expect(report.nights.map((night) => night.date)).toEqual(["2026-09-16", "2026-09-15"]);
    expect(report.notes[0]).toContain("2 of 3 required scored main sleeps");

    // The 00:39-onset sleep woke on 09-15 and is dated 09-15.
    const first = report.nights[1]!;
    const record = user.sleeps.find((sleep) => sleep.id === LIVE_SHAPED_IDS.sleeps.first)!;
    expect(first).toMatchObject({
      date: "2026-09-15",
      bedtime_local: "00:39",
      waketime_local: "07:21",
      utc_offset: "+02:00",
      asleep_hours: round(asleepMs(record) / HOUR_MS, 2),
      in_bed_hours: round((Date.parse(record.end) - Date.parse(record.start)) / HOUR_MS, 2),
      efficiency_pct: 91.7,
      performance_pct: 71,
      consistency_pct: null,
      consistency_reason: "zero_during_calibration",
      disturbances: 11,
      sleep_cycles: 4,
      respiratory_rate: 14.77,
      recovery_calibrating: true,
      need: { baseline: 7.75, debt: 0, nap: 0, strain: 0.37 },
    });
    expect(first.flags).toEqual(["calibrating"]);
    const shares = (first.light_pct ?? 0) + (first.sws_pct ?? 0) + (first.rem_pct ?? 0);
    expect(shares).toBeCloseTo(100, 0);
    expect(report.nights[0]).toMatchObject({
      date: "2026-09-16",
      bedtime_local: "23:13",
      consistency_pct: null,
      consistency_reason: "zero_during_calibration",
    });

    expect(report.naps).toEqual({
      count: 0,
      days_with_naps: 0,
      total_asleep_hours: 0,
      mean_duration_min: null,
      unscored: 0,
    });
    expect(report.pending_dates).toEqual([]);
    expect(report.excluded).toEqual({
      pending: 0,
      unscorable: 0,
      low_data_coverage: 0,
      duplicate_day: 0,
      invalid: 0,
    });
    expect(report.notes.some((note) => note.includes("zero_during_calibration"))).toBe(true);
    expect(report.truncated).toBe(false);
    expect(report.data_quality.method_version).toBe("sleep-analysis-1");
    expect(
      report.data_quality.limitations.some((text) => text.includes("LOW_DATA_COVERAGE_FRACTION"))
    ).toBe(true);
    expect(report.period.end).toBe("2026-09-16T23:30:00.000+02:00");
  });
});

// ---------------------------------------------------------------------------
// Mature account
// ---------------------------------------------------------------------------

describe("14-night mature account", () => {
  // 15 days: split night on day 4, low coverage on day 10, naps on days 5 and 11,
  // +02:00 → +01:00 from day 10, the last night pending.
  const user = matureUser({ days: 15 });

  it("lists pending, low-coverage and split nights and keeps naps separate", async () => {
    const report = await analyse(user, { days: 14 });
    const startMs = user.now.getTime() - 14 * DAY_MS;
    const expectedNights = windowNights(user.sleeps, startMs, user.now.getTime());
    expect(report.nights.map((night) => night.date)).toEqual(
      expectedNights.map((sleep) => localDay(sleep.end, sleep.timezone_offset))
    );
    expect(report.nights).toHaveLength(14);
    expect(report.status).toBe("available");
    expect(report.nights_analyzed).toBe(13);

    // Pending last night.
    const today = localDay(user.now.toISOString(), user.offset);
    expect(report.pending_dates).toEqual([today]);
    expect(report.nights[0]).toMatchObject({
      date: today,
      score_state: "PENDING_SCORE",
      asleep_hours: null,
      need: null,
      consistency_reason: "not_scored",
    });
    expect(report.nights[0]!.flags).toContain("pending_score");
    expect(report.excluded.pending).toBe(1);

    // Split night: two main sleeps waking the same day.
    expect(report.excluded.duplicate_day).toBe(1);

    // Low coverage: flagged, listed, excluded from stage and duration statistics.
    const lowCoverage = report.nights.filter((night) => night.flags.includes("low_data_coverage"));
    expect(lowCoverage).toHaveLength(1);
    expect(report.excluded.low_data_coverage).toBe(1);
    const covered = expectedNights.filter((sleep) => {
      const stages = sleep.score?.stage_summary;
      return (
        stages !== undefined &&
        stages.total_no_data_time_milli <=
          LOW_DATA_COVERAGE_FRACTION * stages.total_in_bed_time_milli
      );
    });
    expect(covered).toHaveLength(12);
    const sum = (pick: (sleep: Sleep) => number): number =>
      covered.reduce((total, sleep) => total + pick(sleep), 0);
    const asleep = sum(asleepMs);
    const summary = report.summary!;
    expect(summary.stage_share_of_asleep).toEqual({
      n: 12,
      light_pct: round(
        (100 * sum((s) => s.score!.stage_summary.total_light_sleep_time_milli)) / asleep,
        1
      ),
      sws_pct: round(
        (100 * sum((s) => s.score!.stage_summary.total_slow_wave_sleep_time_milli)) / asleep,
        1
      ),
      rem_pct: round(
        (100 * sum((s) => s.score!.stage_summary.total_rem_sleep_time_milli)) / asleep,
        1
      ),
    });
    expect(summary.asleep_hours!.n).toBe(12);
    expect(summary.asleep_hours!.mean).toBeCloseTo(asleep / 12 / HOUR_MS, 2);
    expect(summary.efficiency_pct!.n).toBe(13);
    expect(summary.respiratory_rate!.n).toBe(13);
    expect(summary.consistency_pct!.n).toBe(13);
    expect(summary.awake_share_of_in_bed_pct).toBe(
      round(
        (100 * sum((s) => s.score!.stage_summary.total_awake_time_milli)) /
          sum((s) => s.score!.stage_summary.total_in_bed_time_milli),
        1
      )
    );

    // Naps: counted separately, never part of asleep hours.
    const naps = user.sleeps.filter(
      (sleep) =>
        sleep.nap && Date.parse(sleep.end) >= startMs && Date.parse(sleep.end) < user.now.getTime()
    );
    expect(naps.length).toBeGreaterThan(0);
    expect(report.naps).toMatchObject({
      count: naps.length,
      days_with_naps: naps.length,
      unscored: 0,
      total_asleep_hours: round(naps.reduce((total, nap) => total + asleepMs(nap), 0) / HOUR_MS, 2),
    });

    // Offset change: newer nights in +01:00, older in +02:00, clock times in their own offset.
    const offsets = new Set(report.nights.map((night) => night.utc_offset));
    expect(offsets).toEqual(new Set(["+01:00", "+02:00"]));
    for (const night of report.nights) {
      const record = expectedNights.find(
        (sleep) => localDay(sleep.end, sleep.timezone_offset) === night.date
      )!;
      expect(night.utc_offset).toBe(record.timezone_offset);
      const local = new Date(
        Date.parse(record.end) + (record.timezone_offset === "+01:00" ? 60 : 120) * MINUTE_MS
      );
      expect(night.waketime_local).toBe(local.toISOString().slice(11, 16));
    }

    // Timing uses scored nights; need is a mean of WHOOP's components.
    expect(report.timing!.nights_used).toBe(13);
    expect(report.need!.whoop_total_including_debt_hours.n).toBe(13);
    expect(report.notes.some((note) => note.includes("excludes it"))).toBe(true);
    expect(report.output_capped).toBe(false);
  });

  it("dates nights exactly as get_sleep_debt for the same arguments", async () => {
    const longUser = matureUser({ days: 40 });
    for (const args of [{ days: 14 }, { start: "2026-09-01", days: 10 }, { start: "last week" }]) {
      const client = clientFor(longUser);
      const report = await analyse(longUser, args, client);
      const debt = await getSleepDebt(client, args, longUser.now);
      const scoredDates = report.nights
        .filter((night) => night.score_state === "SCORED")
        .map((night) => night.date);
      expect(scoredDates).toEqual(debt.nights.map((night) => night.date));
      expect(report.nights_analyzed).toBe(debt.nights_analyzed);
      expect(report.period).toEqual(debt.period);
    }
  });

  it("keeps WHOOP's negative nap need with its sign", async () => {
    const report = await analyse(matureUser({ days: 30, napEvery: 2 }), { days: 30 });
    const napped = report.nights.filter((night) => (night.need?.nap ?? 0) < 0);
    expect(napped.length).toBeGreaterThan(0);
    for (const night of napped) {
      const need = night.need!;
      expect(need.total_excluding_debt).toBeCloseTo(need.baseline + need.strain + need.nap, 1);
      expect(need.total_including_debt).toBeCloseTo(
        need.baseline + need.debt + need.strain + need.nap,
        1
      );
    }
    expect(report.need!.nap_hours.mean!).toBeLessThan(0);
  });

  it("gives identical output for newest-first and shuffled pages", async () => {
    const shuffledUser = matureUser({ days: 50, seed: 3 });
    const plain = clientFor(shuffledUser);
    const inner = clientFor(shuffledUser);
    const random = createLcg(42);
    const shuffling: WhoopClient = {
      async get<T>(path: string, options?: Parameters<WhoopClient["get"]>[1]): Promise<T> {
        const page = (await inner.get<unknown>(path, options)) as { records?: unknown[] };
        if (Array.isArray(page.records)) {
          const records = [...page.records];
          for (let i = records.length - 1; i > 0; i--) {
            const j = Math.floor(random() * (i + 1));
            [records[i], records[j]] = [records[j], records[i]];
          }
          return { ...page, records } as T;
        }
        return page as T;
      },
    };
    const strip = (report: SleepAnalysisReport): unknown => ({
      ...report,
      data_quality: {
        ...report.data_quality,
        sources: Object.fromEntries(
          Object.entries(report.data_quality.sources).map(([key, value]) => [
            key,
            { ...value, fetched_at: null },
          ])
        ),
      },
    });
    const a = await analyse(shuffledUser, { days: 45 }, plain);
    const b = await analyse(shuffledUser, { days: 45 }, shuffling);
    expect(strip(b)).toEqual(strip(a));
  });
});

// ---------------------------------------------------------------------------
// Stage shares
// ---------------------------------------------------------------------------

describe("stage shares", () => {
  it("are time-weighted, not the mean of nightly shares", async () => {
    const user = builtUser(
      [
        { wakeDay: "2026-09-14", lightMin: 240, swsMin: 120, remMin: 120 }, // 8 h, REM 25%
        { wakeDay: "2026-09-15", lightMin: 180, swsMin: 36, remMin: 24 }, // 4 h, REM 10%
        { wakeDay: "2026-09-16", lightMin: 216, swsMin: 72, remMin: 72 }, // 6 h, REM 20%
      ],
      "2026-09-16T20:00:00+02:00"
    );
    const report = await analyse(user, { days: 7 });
    expect(report.status).toBe("available");
    // (120 + 24 + 72) / (480 + 240 + 360) = 20% of time asleep
    expect(report.summary!.stage_share_of_asleep).toEqual({
      n: 3,
      light_pct: 58.9,
      sws_pct: 21.1,
      rem_pct: 20,
    });
    const meanOfNightly =
      report.nights.reduce((total, night) => total + night.rem_pct!, 0) / report.nights.length;
    expect(meanOfNightly).toBeCloseTo(18.33, 2);
    expect(report.summary!.asleep_hours).toEqual({
      n: 3,
      mean: 6,
      median: 6,
      p25: 5,
      p75: 7,
      sd: 2,
    });
    expect(report.summary!.consistency_pct!.mean).toBe(80);
    expect(report.notes.some((note) => note.includes("time-weighted"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Failures and limits
// ---------------------------------------------------------------------------

describe("failures, truncation and input", () => {
  it("marks a partially read history as truncated with a note", async () => {
    const user = matureUser({ days: 60 });
    const client = clientFor(user, {
      failures: [
        {
          path: /^\/v2\/activity\/sleep\?/,
          page: 2,
          error: new WhoopApiError(503, "Service Unavailable", {}),
        },
      ],
    });
    const report = await analyse(user, { days: 30 }, client);
    expect(report.truncated).toBe(true);
    expect(report.data_quality.sources.sleep!.truncated).toBe(true);
    expect(report.notes.some((note) => note.startsWith("Partial history: sleep records"))).toBe(
      true
    );
  });

  it("throws the WHOOP error when sleeps cannot be read", async () => {
    const user = liveShapedUser();
    const client = clientFor(user, {
      failures: [
        { path: /^\/v2\/activity\/sleep/, error: new WhoopApiError(401, "Unauthorized", {}) },
      ],
    });
    await expect(runSleepAnalysis({}, contextFor(client, user.now))).rejects.toBeInstanceOf(
      WhoopApiError
    );
  });

  it("keeps sleep statistics when recoveries fail, with calibration unknown", async () => {
    const user = liveShapedUser();
    const client = clientFor(user, {
      failures: [{ path: /^\/v2\/recovery/, error: new WhoopApiError(500, "Server Error", {}) }],
    });
    const report = await analyse(user, {}, client);
    expect(report.nights).toHaveLength(2);
    expect(report.nights[0]).toMatchObject({
      recovery_calibrating: null,
      consistency_pct: null,
      consistency_reason: "calibration_unknown",
    });
    expect(report.warnings[0]).toContain("Recovery data could not be read");
    expect(report.data_quality.sources.recovery!.status).toBe("fetch_failed");
  });

  it("rejects a window starting in the future or an unreadable start", async () => {
    const user = liveShapedUser();
    const ctx = contextFor(clientFor(user), user.now);
    await expect(runSleepAnalysis({ start: "2026-10-01" }, ctx)).rejects.toBeInstanceOf(
      InvalidDateExpression
    );
    await expect(runSleepAnalysis({ start: "not a date" }, ctx)).rejects.toBeInstanceOf(
      InvalidDateExpression
    );
    const january = await runSleepAnalysis({ start: "2026-01" }, ctx);
    expect(january.status).toBe("insufficient_data");
    expect(january.nights).toEqual([]);
  });

  it("omits night rows and naps on request", async () => {
    const report = await analyse(matureUser({ days: 20 }), {
      include_nights: false,
      include_naps: false,
    });
    expect(report.nights).toEqual([]);
    expect(report.output_capped).toBe(false);
    expect(report.naps).toBeNull();
    expect(report.status).toBe("available");
  });
});

// ---------------------------------------------------------------------------
// Size, requests and contract
// ---------------------------------------------------------------------------

describe("size, requests and contract", () => {
  it(
    "caps night rows at 31 on a 90-day stressUser within the request budget",
    async () => {
      const user = stressUser();
      const client = clientFor(user);
      const report = await analyse(user, { days: 90 }, client);
      expect(report.nights).toHaveLength(SLEEP_ANALYSIS_MAX_NIGHT_ROWS);
      expect(report.output_capped).toBe(true);
      expect(report.nights_analyzed).toBeGreaterThan(SLEEP_ANALYSIS_MAX_NIGHT_ROWS);
      expect(report.notes.some((note) => note.includes("Only the newest 31"))).toBe(true);
      expect(JSON.stringify(report).length).toBeLessThanOrEqual(MAX_TOOL_TEXT_CHARS);
      expect(client.calls.length).toBeLessThanOrEqual(DEFAULT_PAGE_BUDGET + 1);
    },
    HEAVY_TEST_TIMEOUT_MS
  );

  it(
    "serves a repeated call from the history cache",
    async () => {
      const user = stressUser();
      const client = clientFor(user);
      const cache = new MemoryCache({ maxEntries: 500 });
      const ctx: ToolContext = { ...contextFor(client, user.now), historyCache: cache };
      const first = await runSleepAnalysis({ days: 90 }, ctx);
      const before = client.calls.length;
      const second = await runSleepAnalysis({ days: 90 }, ctx);
      expect(client.calls.slice(before).filter((path) => path.includes("start="))).toEqual([]);
      expect(
        Object.values(second.data_quality.sources).every((source) => source.cache_status === "hit")
      ).toBe(true);
      expect({ ...second, data_quality: null }).toEqual({ ...first, data_quality: null });
    },
    HEAVY_TEST_TIMEOUT_MS
  );

  it(
    "notes a history cut short by the request budget",
    async () => {
      const user = stressUser();
      const client = clientFor(user);
      const cache = new MemoryCache({ maxEntries: 500 });
      await runSleepAnalysis({ days: 7 }, { ...contextFor(client, user.now), historyCache: cache });
      const late: ToolContext = {
        ...contextFor(client, user.now),
        historyCache: cache,
        startedAtMs: Date.now() - HISTORY_DEADLINE_MS - 1,
      };
      const report = await runSleepAnalysis({ days: 90 }, late);
      expect(report.truncated).toBe(true);
      expect(report.nights.length).toBeGreaterThan(0);
      const note = report.notes.find((text) => text.startsWith("Partial history: sleep records"));
      expect(note).toContain("are complete only from");
      expect(note).toContain("request and time budget");
      assertNeutralText(report.notes);
    },
    HEAVY_TEST_TIMEOUT_MS
  );

  it(
    "is registered in standard mode only, with a valid contract",
    async () => {
      expect(getSleepAnalysisTool.aggregate).toBeUndefined();
      expect(getSleepAnalysisTool.standard.title).toBe("Sleep analysis");
      expect(getSleepAnalysisTool.annotations).toEqual({ readOnlyHint: true });
      expect(getSleepAnalysisTool.standard.description.length).toBeLessThanOrEqual(1000);
      expect(await listToolNames("standard")).toContain("get_sleep_analysis");
      expect(await listToolNames("aggregate")).not.toContain("get_sleep_analysis");

      for (const user of [liveShapedUser(), stressUser()]) {
        const connection = await connectServer(clientFor(user), { now: () => user.now });
        try {
          const result = await connection.callTool("get_sleep_analysis", { days: 90 });
          expect(result.isError).toBe(false);
          expect(result.text).toBe(JSON.stringify(result.structured));
          expect(result.text.length).toBeLessThanOrEqual(MAX_TOOL_TEXT_CHARS);
          assertNeutralText((result.structured as SleepAnalysisReport).notes);

          const bad = await connection.callTool("get_sleep_analysis", { start: "tomorrow" });
          expect(bad.isError).toBe(true);
        } finally {
          await connection.close();
        }
      }
    },
    HEAVY_TEST_TIMEOUT_MS
  );
});
