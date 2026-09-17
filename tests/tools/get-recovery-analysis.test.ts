/**
 * Tests for get_recovery_analysis (package P8).
 *
 * Covers: the live-shaped calibrating account (zones with calibrating counts,
 * null percentages and deviations, SpO2 and skin temperature n = 2), a 45-day
 * account whose first recoveries are calibrating (when baselines start,
 * respiratory rate keeping calibrating days), ln-scale robust z symmetry and a
 * constant baseline, the 7-day ln(RMSSD) mean and CV, weekday minimums, SpO2
 * not reported, day assignment through cycles, duplicates, pending and
 * unmatched recoveries, concurrent deviations, parity with get_baselines,
 * source failures, output size and requests on stressUser, neutral wording and
 * the MCP contract.
 */

import { describe, expect, it } from "vitest";
import { WhoopApiError, type WhoopClient } from "../../src/api/client.js";
import { DEFAULT_PAGE_BUDGET } from "../../src/api/history.js";
import { MemoryCache } from "../../src/cache/memory-cache.js";
import type { Recovery, Sleep } from "../../src/api/types.js";
import { cycleDay, localDay } from "../../src/tools/analytics-utils.js";
import { addDays } from "../../src/tools/day-model.js";
import { getBaselines } from "../../src/tools/get-baselines.js";
import {
  BASELINE_MIN_SAMPLES,
  deviationFrom,
  getRecoveryAnalysisTool,
  HRV_LN_MIN_VALUES,
  hrvLnWindow,
  RECOVERY_ANALYSIS_MAX_DAY_ROWS,
  recoveryAnalysisOutputSchema,
  runRecoveryAnalysis,
  WEEKDAY_MIN_SAMPLES,
  type RecoveryAnalysisReport,
  type RecoveryDay,
} from "../../src/tools/get-recovery-analysis.js";
import { MAX_TOOL_TEXT_CHARS, type ToolContext } from "../../src/tools/tool-definition.js";
import { assertNeutralText, connectServer, listToolNames } from "../helpers/contract.js";
import {
  createWhoopFixtureClient,
  type WhoopFixtureClient,
  type WhoopFixtureClientOptions,
} from "../helpers/whoop-fixture-client.js";
import {
  liveShapedUser,
  matureUser,
  stressUser,
  type WhoopUserFixture,
} from "../helpers/whoop-users.js";

/** Tests that run stressUser or the MCP server take longer under a loaded full-suite run. */
const HEAVY_TEST_TIMEOUT_MS = 30_000;

type Args = Parameters<typeof runRecoveryAnalysis>[0];
type DayRow = RecoveryAnalysisReport["days"][number];

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
): Promise<RecoveryAnalysisReport> {
  const report = await runRecoveryAnalysis(args, contextFor(client, user.now));
  recoveryAnalysisOutputSchema.parse(report);
  assertNeutralText([report.notes, report.warnings, report.data_quality.limitations]);
  return report;
}

function row(report: RecoveryAnalysisReport, date: string): DayRow {
  const found = report.days.find((day) => day.date === date);
  if (!found) throw new Error(`no row ${date}`);
  return found;
}

/** Scored recoveries of a fixture with their wake day. */
function recoveryDays(
  user: WhoopUserFixture
): Array<{ day: string; recovery: Recovery; sleep: Sleep }> {
  const sleepById = new Map(user.sleeps.map((sleep) => [sleep.id, sleep]));
  return user.recoveries.flatMap((recovery) => {
    const sleep = sleepById.get(recovery.sleep_id);
    if (!sleep || recovery.score_state !== "SCORED" || !recovery.score) return [];
    return [{ day: localDay(sleep.end, sleep.timezone_offset), recovery, sleep }];
  });
}

function sampleSd(values: number[]): number {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)
  );
}

function recoveryDay(day: string, hrv: number, calibrating = false): RecoveryDay {
  return {
    day,
    calibrating,
    recovery: {
      cycle_id: 1,
      sleep_id: "s",
      user_id: 1,
      created_at: `${day}T06:00:00.000Z`,
      updated_at: `${day}T06:00:00.000Z`,
      score_state: "SCORED",
      score: {
        user_calibrating: calibrating,
        recovery_score: 50,
        resting_heart_rate: 55,
        hrv_rmssd_milli: hrv,
      },
    },
    values: { recovery: 50, hrv, rhr: 55, spo2: null, skin_temp: null, respiratory_rate: null },
  };
}

// ---------------------------------------------------------------------------
// Live-shaped account
// ---------------------------------------------------------------------------

describe("live-shaped calibrating account", () => {
  it("counts zones with calibrating recoveries and leaves baselines and percentages null", async () => {
    const user = liveShapedUser();
    const report = await analyse(user, { days: 7 });
    expect(report.status).toBe("insufficient_data");
    expect(report.recoveries_analyzed).toBe(2);
    expect(report.zones).toEqual({
      n: 2,
      counts: { green: 1, yellow: 1, red: 0 },
      pct: { green: null, yellow: null, red: null },
      calibrating_by_zone: { green: 1, yellow: 1, red: 0 },
    });
    expect(report.notes[0]).toContain("WHOOP is still calibrating");
    expect(report.days.map((day) => day.date)).toEqual(["2026-09-16", "2026-09-15"]);
    expect(row(report, "2026-09-15")).toMatchObject({
      recovery_score: 58,
      zone: "yellow",
      calibrating: true,
      hrv_ms: 71.4,
      rhr_bpm: 61,
      spo2_pct: 96.3,
      skin_temp_c: 33.62,
      respiratory_rate: 14.77,
      hrv_ln_7d_mean: null,
      hrv_ln_7d_cv_pct: null,
      unusual_metrics: [],
    });
    for (const day of report.days) {
      expect(Object.values(day.deviations)).toEqual([null, null, null, null, null, null]);
    }
    expect(report.summary.spo2).toMatchObject({ n: 2, mean: null, status: "insufficient_data" });
    expect(report.summary.skin_temp).toMatchObject({ n: 2, status: "insufficient_data" });
    expect(report.hrv_ln_7d).toMatchObject({
      latest_mean: null,
      latest_cv_pct: null,
      median_cv_pct: null,
      n_days: 0,
    });
    expect(report.baseline).toEqual({
      required_samples: BASELINE_MIN_SAMPLES,
      window_days: 28,
      calibrating_excluded: 2,
    });
    expect(
      report.notes.some((note) =>
        note.includes(`0 of ${BASELINE_MIN_SAMPLES}, calibrating excluded`)
      )
    ).toBe(true);
    expect(
      report.by_weekday.every((weekday) => weekday.n === 0 && weekday.recovery_mean === null)
    ).toBe(true);
    expect(report.notes).toContain(
      "Weekday patterns over a few weeks are weak, and there are no non-calibrating values for any weekday here yet; values are null below 4."
    );
    expect(report.notes.join(" ")).not.toContain("at most 0");
    expect(report.concurrent_deviation_days).toEqual([]);
    expect(report.data_quality.method_version).toBe("recovery-analysis-1");
    expect(
      report.data_quality.limitations.some((text) => text.includes("ambient conditions"))
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Baselines and deviations
// ---------------------------------------------------------------------------

describe("baselines over a 45-day account with calibrating first days", () => {
  const user = matureUser({
    days: 45,
    calibratingFirst: 5,
    splitNightDays: [],
    pendingLast: false,
  });

  it("starts deviations once 14 non-calibrating days precede a day, respiratory rate keeping calibrating days", async () => {
    const report = await analyse(user, { days: 40, baseline_days: 28, include_days: true });
    const known = recoveryDays(user);
    expect(known.filter((item) => item.recovery.score!.user_calibrating)).toHaveLength(5);
    const today = localDay(user.now.toISOString(), user.offset);
    const firstDay = addDays(today, -39);

    const inWindow = known
      .filter((item) => item.day >= firstDay)
      .sort((a, b) => (a.day < b.day ? 1 : -1));
    expect(report.recoveries_analyzed).toBe(inWindow.length);
    expect(report.days).toHaveLength(Math.min(RECOVERY_ANALYSIS_MAX_DAY_ROWS, inWindow.length));
    expect(report.days_omitted).toBe(inWindow.length - report.days.length);

    let firstWithDeviation: string | null = null;
    for (const item of [...inWindow].reverse()) {
      const prior = known.filter(
        (other) => other.day >= addDays(item.day, -28) && other.day < item.day
      );
      const nonCalibrating = prior.filter((other) => !other.recovery.score!.user_calibrating);
      const calibrating = item.recovery.score!.user_calibrating;
      const expectHrv = !calibrating && nonCalibrating.length >= BASELINE_MIN_SAMPLES;
      const listed = report.days.find((day) => day.date === item.day);
      if (expectHrv && firstWithDeviation === null) firstWithDeviation = item.day;
      if (!listed) continue;
      if (expectHrv) {
        expect(listed.deviations.hrv).not.toBeNull();
        expect(listed.deviations.hrv!.baseline_n).toBe(nonCalibrating.length);
        expect(listed.deviations.rhr!.baseline_n).toBe(nonCalibrating.length);
      } else {
        expect(listed.deviations.hrv).toBeNull();
      }
      const withRate = prior.filter(
        (other) => typeof other.sleep.score?.respiratory_rate === "number"
      );
      if (withRate.length >= BASELINE_MIN_SAMPLES) {
        expect(listed.deviations.respiratory_rate!.baseline_n).toBe(withRate.length);
      } else {
        expect(listed.deviations.respiratory_rate).toBeNull();
      }
    }
    expect(firstWithDeviation).not.toBeNull();
    expect(report.baseline.calibrating_excluded).toBe(5);
    expect(report.notes.some((note) => note.includes("calibrating excluded"))).toBe(true);
  });

  it("gives calibrating days a respiratory-rate deviation only", async () => {
    const calibrating = matureUser({
      days: 30,
      calibratingFirst: 22,
      splitNightDays: [],
      pendingLast: false,
      gapDays: [],
    });
    const report = await analyse(calibrating, { days: 14, baseline_days: 28 });
    const rows = report.days.filter((day) => day.calibrating);
    expect(rows.length).toBeGreaterThan(0);
    for (const day of rows) {
      expect(day.deviations.hrv).toBeNull();
      expect(day.deviations.rhr).toBeNull();
      expect(day.deviations.recovery).toBeNull();
      expect(day.deviations.respiratory_rate).not.toBeNull();
      expect(day.unusual_metrics.every((flag) => flag.metric === "respiratory_rate")).toBe(true);
    }
    expect(
      report.days.filter((day) => !day.calibrating).every((day) => day.deviations.hrv === null)
    ).toBe(true);
    expect(report.summary.recovery.n).toBe(report.recoveries_analyzed);
    expect(
      report.zones.calibrating_by_zone.green +
        report.zones.calibrating_by_zone.yellow +
        report.zones.calibrating_by_zone.red
    ).toBe(rows.length);
  });

  it("matches the latest day's baseline with get_baselines on an aligned window", async () => {
    // At local noon, get_baselines' baseline_days 27 covers the 28 local days before today.
    const aligned = matureUser({
      days: 60,
      now: "2026-09-16T12:00:00+02:00",
      offsetChange: null,
      splitNightDays: [],
      pendingLast: false,
    });
    const client = clientFor(aligned);
    const report = await analyse(aligned, { days: 7, baseline_days: 28 }, client);
    const baselines = await getBaselines(client, { baseline_days: 27 }, aligned.now);
    const latest = report.days[0]!;
    expect(latest.date).toBe("2026-09-16");
    expect(latest.deviations.hrv!.baseline_n).toBe(baselines.metrics.hrv!.sample_size);
    expect(latest.deviations.hrv!.baseline_median).toBeCloseTo(baselines.metrics.hrv!.p50, 2);
    expect(latest.deviations.rhr!.baseline_n).toBe(baselines.metrics.rhr!.sample_size);
    expect(latest.deviations.rhr!.baseline_median).toBeCloseTo(baselines.metrics.rhr!.p50, 2);
    expect(latest.deviations.recovery!.baseline_n).toBe(
      baselines.metrics.recovery_score!.sample_size
    );
  });
});

describe("robust z and the 7-day ln(RMSSD) window", () => {
  it("is symmetric on the ln scale and null for a constant baseline", () => {
    const reference = Array.from({ length: 15 }, (_, index) => 50 * Math.exp(0.05 * (index - 7)));
    const above = deviationFrom("hrv", 50 * Math.exp(0.6), reference)!;
    const below = deviationFrom("hrv", 50 * Math.exp(-0.6), reference)!;
    // MAD of ln values = 0.2, so z = 0.6 / (1.4826 × 0.2)
    expect(above.robust_z).toBeCloseTo(2.02, 2);
    expect(below.robust_z).toBeCloseTo(-2.02, 2);
    expect(above.direction).toBe("above");
    expect(below.direction).toBe("below");
    expect(above.baseline_median).toBe(50);
    expect(above.baseline_n).toBe(15);
    expect(above.delta_pct).toBeCloseTo(100 * (Math.exp(0.6) - 1), 0);
    expect(deviationFrom("hrv", 50 * Math.exp(0.2), reference)!.direction).toBe("within");

    const constant = deviationFrom(
      "rhr",
      58,
      Array.from({ length: 14 }, () => 55)
    )!;
    expect(constant).toMatchObject({
      delta: 3,
      delta_pct: null,
      robust_z: null,
      direction: null,
      constant_baseline: true,
      baseline_median: 55,
    });
    expect(
      deviationFrom(
        "rhr",
        58,
        Array.from({ length: 13 }, () => 55)
      )
    ).toBeNull();
  });

  it("computes the ln mean and CV by hand and needs 5 non-calibrating values", () => {
    const hrv = [48, 55, 61, 52, 70];
    const days = hrv.map((value, index) => recoveryDay(addDays("2026-09-10", index), value));
    const logs = hrv.map(Math.log);
    const mean = logs.reduce((sum, value) => sum + value, 0) / logs.length;
    const result = hrvLnWindow("2026-09-14", days);
    expect(result.n).toBe(HRV_LN_MIN_VALUES);
    expect(result.mean).toBeCloseTo(mean, 12);
    expect(result.cv_pct).toBeCloseTo((100 * sampleSd(logs)) / mean, 10);

    expect(hrvLnWindow("2026-09-14", days.slice(1))).toEqual({ mean: null, cv_pct: null, n: 4 });
    const withCalibrating = days.map((day, index) =>
      index === 0 ? { ...day, calibrating: true } : day
    );
    expect(hrvLnWindow("2026-09-14", withCalibrating).mean).toBeNull();
    // A value 7 days before the end is outside the window.
    expect(hrvLnWindow("2026-09-17", days).n).toBe(4);
  });

  it("reports the latest ln window of a mature account", async () => {
    const user = matureUser({ days: 40, pendingLast: false, splitNightDays: [] });
    const report = await analyse(user, { days: 30 });
    const today = localDay(user.now.toISOString(), user.offset);
    const known = recoveryDays(user);
    const logs = known
      .filter((item) => item.day > addDays(today, -7) && item.day <= today)
      .map((item) => Math.log(item.recovery.score!.hrv_rmssd_milli));
    const mean = logs.reduce((sum, value) => sum + value, 0) / logs.length;
    expect(logs.length).toBeGreaterThanOrEqual(HRV_LN_MIN_VALUES);
    expect(report.hrv_ln_7d.latest_date).toBe(today);
    expect(report.hrv_ln_7d.latest_mean).toBeCloseTo(mean, 3);
    expect(report.hrv_ln_7d.latest_cv_pct).toBeCloseTo((100 * sampleSd(logs)) / mean, 2);
    expect(row(report, today).hrv_ln_7d_mean).toBe(report.hrv_ln_7d.latest_mean);
    expect(report.hrv_ln_7d.median_cv_pct).not.toBeNull();
  });
});

describe("weekday patterns", () => {
  it("reports values only for weekdays with at least 4 non-calibrating recoveries", async () => {
    const user = matureUser({ days: 60, pendingLast: false, splitNightDays: [], gapDays: [] });
    const short = await analyse(user, { days: 21 });
    expect(short.by_weekday.every((weekday) => weekday.n <= 3)).toBe(true);
    expect(short.by_weekday.every((weekday) => weekday.recovery_mean === null)).toBe(true);
    expect(
      short.notes.some((note) => note.includes("Weekday patterns over a few weeks are weak"))
    ).toBe(true);

    const long = await analyse(user, { days: 35 });
    const today = localDay(user.now.toISOString(), user.offset);
    const known = recoveryDays(user).filter((item) => item.day > addDays(today, -35));
    for (const weekday of long.by_weekday) {
      const index = [
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sunday",
      ].indexOf(weekday.weekday);
      const items = known.filter(
        (item) => (new Date(`${item.day}T00:00:00Z`).getUTCDay() + 6) % 7 === index
      );
      expect(weekday.n).toBe(items.length);
      if (items.length >= WEEKDAY_MIN_SAMPLES) {
        const mean =
          items.reduce((sum, item) => sum + item.recovery.score!.recovery_score, 0) / items.length;
        expect(weekday.recovery_mean).toBeCloseTo(mean, 1);
        expect(weekday.hrv_median).not.toBeNull();
      } else {
        expect(weekday.recovery_mean).toBeNull();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Day assignment and data edge cases
// ---------------------------------------------------------------------------

describe("day assignment and edge cases", () => {
  it("reports SpO2 as not_reported when WHOOP never sends it", async () => {
    const base = matureUser({ days: 20, pendingLast: false });
    const user: WhoopUserFixture = {
      ...base,
      recoveries: base.recoveries.map((recovery) =>
        recovery.score
          ? { ...recovery, score: { ...recovery.score, spo2_percentage: null } }
          : recovery
      ),
    };
    const report = await analyse(user, { days: 14 });
    expect(report.summary.spo2).toEqual({
      n: 0,
      mean: null,
      median: null,
      sd: null,
      unit: "%",
      status: "not_reported",
    });
    expect(report.summary.hrv.status).toBe("available");
    expect(report.days.every((day) => day.spo2_pct === null && day.deviations.spo2 === null)).toBe(
      true
    );
    expect(
      report.notes.some((note) => note.includes("spo2 summary: WHOOP reported no value"))
    ).toBe(true);
  });

  it("places a recovery without its sleep on its cycle's day, keeps the newest duplicate and counts pending and unmatched recoveries", async () => {
    const base = matureUser({ days: 20, splitNightDays: [] });
    const known = recoveryDays(base).sort((a, b) => (a.day < b.day ? 1 : -1));
    const target = known[3]!;
    const duplicateOf = known[5]!;
    const sleeps = base.sleeps.filter((sleep) => sleep.id !== target.sleep.id);
    const later = new Date(Date.parse(duplicateOf.recovery.updated_at) + 3_600_000).toISOString();
    const duplicate: Recovery = {
      ...duplicateOf.recovery,
      cycle_id: 999_999,
      updated_at: later,
      score: { ...duplicateOf.recovery.score!, recovery_score: 12 },
    };
    const orphan: Recovery = {
      ...duplicateOf.recovery,
      cycle_id: 888_888,
      sleep_id: "missing-sleep",
      created_at: base.now.toISOString(),
      updated_at: base.now.toISOString(),
    };
    const user: WhoopUserFixture = {
      ...base,
      sleeps,
      recoveries: [...base.recoveries, duplicate, orphan],
    };
    const report = await analyse(user, { days: 14 });

    const cycle = base.cycles.find((candidate) => candidate.id === target.recovery.cycle_id)!;
    const placed = row(report, cycleDay(cycle));
    expect(cycleDay(cycle)).toBe(target.day);
    expect(placed.recovery_score).toBe(target.recovery.score!.recovery_score);
    expect(placed.respiratory_rate).toBeNull();

    expect(row(report, duplicateOf.day).recovery_score).toBe(12);
    expect(report.excluded).toMatchObject({ duplicate_day: 1, missing_join: 1, pending: 1 });
    expect(
      report.notes.some((note) => note.includes("most recently updated recovery is used"))
    ).toBe(true);
    expect(report.notes.some((note) => note.includes("still being scored"))).toBe(true);
  });

  it("lists a day with two metrics beyond ±2 as a concurrent deviation day", async () => {
    const base = matureUser({ days: 50, splitNightDays: [], pendingLast: false });
    const known = recoveryDays(base).sort((a, b) => (a.day < b.day ? 1 : -1));
    const latest = known[0]!;
    const user: WhoopUserFixture = {
      ...base,
      recoveries: base.recoveries.map((recovery) =>
        recovery === latest.recovery
          ? {
              ...recovery,
              score: { ...recovery.score!, hrv_rmssd_milli: 12, resting_heart_rate: 95 },
            }
          : recovery
      ),
    };
    const report = await analyse(user, { days: 30 });
    const day = row(report, latest.day);
    expect(day.deviations.hrv!.direction).toBe("below");
    expect(day.deviations.rhr!.direction).toBe("above");
    expect(day.unusual_metrics).toEqual(
      expect.arrayContaining([
        { metric: "hrv", direction: "below" },
        { metric: "rhr", direction: "above" },
      ])
    );
    expect(report.concurrent_deviation_days[0]!.date).toBe(latest.day);
    expect(report.concurrent_deviation_days[0]!.metrics).toEqual(
      expect.arrayContaining(["hrv", "rhr"])
    );
    for (const entry of report.concurrent_deviation_days) {
      expect(entry.metrics.length).toBeGreaterThanOrEqual(2);
    }
    expect(report.notes.some((note) => note.includes("about 5% of days"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Failures, size and contract
// ---------------------------------------------------------------------------

describe("failures, size and contract", () => {
  it("throws when recoveries fail and places days by cycle when sleeps fail", async () => {
    const user = matureUser({ days: 20, splitNightDays: [], pendingLast: false });
    const failing = clientFor(user, {
      failures: [
        { path: /^\/v2\/recovery/, error: new WhoopApiError(429, "Too Many Requests", {}) },
      ],
    });
    await expect(runRecoveryAnalysis({}, contextFor(failing, user.now))).rejects.toBeInstanceOf(
      WhoopApiError
    );

    const noSleeps = clientFor(user, {
      failures: [{ path: /^\/v2\/activity\/sleep/, error: new WhoopApiError(500, "Error", {}) }],
    });
    const report = await analyse(user, { days: 14 }, noSleeps);
    const withSleeps = await analyse(user, { days: 14 });
    expect(report.days.map((day) => day.date)).toEqual(withSleeps.days.map((day) => day.date));
    expect(report.days.every((day) => day.respiratory_rate === null)).toBe(true);
    expect(report.warnings[0]).toContain("Sleep data could not be read");
  });

  it(
    "caps rows at 31 on a 90-day stressUser within the budget and the text limit",
    async () => {
      const user = stressUser();
      const client = clientFor(user);
      const report = await analyse(user, { days: 90, baseline_days: 60 }, client);
      expect(report.days).toHaveLength(RECOVERY_ANALYSIS_MAX_DAY_ROWS);
      expect(report.output_capped).toBe(true);
      expect(report.days_omitted).toBe(report.recoveries_analyzed - RECOVERY_ANALYSIS_MAX_DAY_ROWS);
      expect(report.days_omitted).toBeGreaterThan(0);
      expect(JSON.stringify(report).length).toBeLessThanOrEqual(MAX_TOOL_TEXT_CHARS);
      expect(client.calls.length).toBeLessThanOrEqual(DEFAULT_PAGE_BUDGET + 1);
      expect(report.truncated).toBe(false);

      const hidden = await analyse(user, { days: 90, include_days: false });
      expect(hidden.days).toEqual([]);
      expect(hidden.output_capped).toBe(false);
      expect(hidden.days_omitted).toBe(hidden.recoveries_analyzed);
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
      const first = await runRecoveryAnalysis({ days: 90, baseline_days: 60 }, ctx);
      const before = client.calls.length;
      const second = await runRecoveryAnalysis({ days: 90, baseline_days: 60 }, ctx);
      expect(client.calls.slice(before).filter((path) => path.includes("start="))).toEqual([]);
      expect(
        Object.values(second.data_quality.sources).every((source) => source.cache_status === "hit")
      ).toBe(true);
      expect({ ...second, data_quality: null }).toEqual({ ...first, data_quality: null });
    },
    HEAVY_TEST_TIMEOUT_MS
  );

  it(
    "is registered in standard mode only, with a valid contract",
    async () => {
      expect(getRecoveryAnalysisTool.aggregate).toBeUndefined();
      expect(getRecoveryAnalysisTool.standard.title).toBe("Recovery analysis");
      expect(getRecoveryAnalysisTool.annotations).toEqual({ readOnlyHint: true });
      expect(getRecoveryAnalysisTool.standard.description.length).toBeLessThanOrEqual(1000);
      expect(await listToolNames("standard")).toContain("get_recovery_analysis");
      expect(await listToolNames("aggregate")).not.toContain("get_recovery_analysis");

      for (const user of [liveShapedUser(), stressUser()]) {
        const connection = await connectServer(clientFor(user), { now: () => user.now });
        try {
          const result = await connection.callTool("get_recovery_analysis", {
            days: 90,
            baseline_days: 60,
          });
          expect(result.isError).toBe(false);
          expect(result.text).toBe(JSON.stringify(result.structured));
          expect(result.text.length).toBeLessThanOrEqual(MAX_TOOL_TEXT_CHARS);
          assertNeutralText((result.structured as RecoveryAnalysisReport).notes);
          const bad = await connection.callTool("get_recovery_analysis", { days: 3 });
          expect(bad.isError).toBe(true);
        } finally {
          await connection.close();
        }
      }
    },
    HEAVY_TEST_TIMEOUT_MS
  );
});
