import { describe, it, expect } from "vitest";
import type { Recovery, Sleep } from "../../src/api/types.js";
import { recoveryZone } from "../../src/tools/analytics-utils.js";
import {
  LOW_DATA_COVERAGE_FRACTION,
  MIN_ASLEEP_MINUTES_FOR_RATES,
  needBreakdown,
  stageBreakdown,
  timingStats,
  whoopConsistency,
} from "../../src/tools/sleep-metrics.js";
import { resolveSleepWindow } from "../../src/tools/sleep-window.js";
import { InvalidDateExpression } from "../../src/tools/date-utils.js";
import { LIVE_SHAPED_IDS, liveShapedUser, matureUser } from "../helpers/whoop-users.js";

const live = liveShapedUser();
const firstSleep = live.sleeps.find((sleep) => sleep.id === LIVE_SHAPED_IDS.sleeps.first)!;
const firstRecovery = live.recoveries.find((r) => r.sleep_id === LIVE_SHAPED_IDS.sleeps.first)!;

function withScore(sleep: Sleep, patch: Partial<NonNullable<Sleep["score"]>>): Sleep {
  return { ...sleep, score: { ...sleep.score!, ...patch } };
}

function nightAt(start: string, end: string, offset = "+02:00"): Sleep {
  return { ...firstSleep, start, end, timezone_offset: offset };
}

describe("stageBreakdown", () => {
  it("reports stage minutes with asleep shares summing to 100", () => {
    for (const sleep of [...live.sleeps, ...matureUser({ days: 30 }).sleeps]) {
      const breakdown = stageBreakdown(sleep);
      if (!breakdown) continue;
      const shares =
        breakdown.light_pct_of_asleep! +
        breakdown.sws_pct_of_asleep! +
        breakdown.rem_pct_of_asleep!;
      expect(Math.abs(shares - 100)).toBeLessThanOrEqual(0.01);
      expect(breakdown.asleep_min).toBeCloseTo(
        breakdown.light_min + breakdown.sws_min + breakdown.rem_min,
        9
      );
    }
    const breakdown = stageBreakdown(firstSleep)!;
    const stages = firstSleep.score!.stage_summary;
    expect(breakdown.in_bed_min).toBe(stages.total_in_bed_time_milli / 60_000);
    expect(breakdown.awake_pct_of_in_bed).toBeCloseTo(
      (100 * stages.total_awake_time_milli) / stages.total_in_bed_time_milli,
      9
    );
    expect(breakdown.disturbances).toBe(11);
    expect(breakdown.sleep_cycles).toBe(4);
    expect(breakdown.disturbances_per_hour_asleep).toBeCloseTo(11 / (breakdown.asleep_min / 60), 9);
  });

  it("withholds rates below an hour asleep and shares without time", () => {
    const short = withScore(firstSleep, {
      stage_summary: {
        total_in_bed_time_milli: 3_000_000,
        total_awake_time_milli: 600_000,
        total_no_data_time_milli: 0,
        total_light_sleep_time_milli: 1_800_000,
        total_slow_wave_sleep_time_milli: 300_000,
        total_rem_sleep_time_milli: 300_000,
        sleep_cycle_count: 1,
        disturbance_count: 3,
      },
    });
    expect(stageBreakdown(short)!.asleep_min).toBeLessThan(MIN_ASLEEP_MINUTES_FOR_RATES);
    expect(stageBreakdown(short)!.disturbances_per_hour_asleep).toBeNull();
    const empty = withScore(firstSleep, {
      stage_summary: {
        total_in_bed_time_milli: 0,
        total_awake_time_milli: 0,
        total_no_data_time_milli: 0,
        total_light_sleep_time_milli: 0,
        total_slow_wave_sleep_time_milli: 0,
        total_rem_sleep_time_milli: 0,
        sleep_cycle_count: 0,
        disturbance_count: 0,
      },
    });
    expect(stageBreakdown(empty)).toMatchObject({
      light_pct_of_asleep: null,
      awake_pct_of_in_bed: null,
      disturbances_per_hour_asleep: null,
    });
  });

  it("is null for an unscored sleep", () => {
    expect(stageBreakdown({ ...firstSleep, score_state: "PENDING_SCORE", score: null })).toBeNull();
  });
});

describe("needBreakdown", () => {
  it("keeps WHOOP's nap need sign (0 or negative) in both totals", () => {
    const sleep = withScore(firstSleep, {
      sleep_needed: {
        baseline_milli: 27_000_000,
        need_from_sleep_debt_milli: 3_600_000,
        need_from_recent_strain_milli: 1_800_000,
        need_from_recent_nap_milli: -2_700_000,
      },
    });
    expect(needBreakdown(sleep)).toEqual({
      baseline: 7.5,
      debt: 1,
      strain: 0.5,
      nap: -0.75,
      total_including_debt: 8.25,
      total_excluding_debt: 7.25,
    });
  });

  it("matches get_sleep_debt's needed hours (baseline + strain + nap)", () => {
    const need = firstSleep.score!.sleep_needed;
    expect(needBreakdown(firstSleep)!.total_excluding_debt).toBe(
      (need.baseline_milli + need.need_from_recent_strain_milli + need.need_from_recent_nap_milli) /
        3_600_000
    );
    expect(needBreakdown({ ...firstSleep, score: null })).toBeNull();
  });
});

describe("whoopConsistency", () => {
  it("turns a zero reported while calibrating into null", () => {
    expect(firstRecovery.score!.user_calibrating).toBe(true);
    expect(whoopConsistency(firstSleep, firstRecovery)).toEqual({
      value: null,
      reason: "zero_during_calibration",
    });
  });

  it("keeps a zero without a calibrating recovery and real values", () => {
    const settled: Recovery = {
      ...firstRecovery,
      score: { ...firstRecovery.score!, user_calibrating: false },
    };
    expect(whoopConsistency(firstSleep, settled)).toEqual({ value: 0, reason: null });
    expect(whoopConsistency(firstSleep, null)).toEqual({ value: 0, reason: null });
    const valued = withScore(firstSleep, { sleep_consistency_percentage: 74 });
    expect(whoopConsistency(valued, firstRecovery)).toEqual({ value: 74, reason: null });
  });

  it("reports a missing value as not_reported", () => {
    expect(
      whoopConsistency(withScore(firstSleep, { sleep_consistency_percentage: null }), null)
    ).toEqual({ value: null, reason: "not_reported" });
    expect(whoopConsistency({ ...firstSleep, score: null }, null)).toEqual({
      value: null,
      reason: "not_reported",
    });
  });
});

describe("recoveryZone", () => {
  it("uses WHOOP's 34 and 67 band edges", () => {
    expect(recoveryZone(0)).toBe("red");
    expect(recoveryZone(33)).toBe("red");
    expect(recoveryZone(33.9)).toBe("red");
    expect(recoveryZone(34)).toBe("yellow");
    expect(recoveryZone(66)).toBe("yellow");
    expect(recoveryZone(67)).toBe("green");
    expect(recoveryZone(100)).toBe("green");
  });
});

describe("timingStats", () => {
  it("averages bedtimes across midnight on the circle", () => {
    // 23:30 and 00:30 local: mean 00:00, SD about 30 minutes
    const stats = timingStats([
      nightAt("2026-09-14T21:30:00Z", "2026-09-15T05:30:00Z"),
      nightAt("2026-09-15T22:30:00Z", "2026-09-16T06:30:00Z"),
    ]);
    const bedMean = stats.bedtime_mean_minutes!;
    expect(Math.min(bedMean, 1440 - bedMean)).toBeCloseTo(0, 6);
    expect(stats.bedtime_sd_minutes).toBeCloseTo(30, 0);
    expect(stats.waketime_mean_minutes).toBeCloseTo(8 * 60, 6);
    expect(stats.nights).toBe(2);
  });

  it("measures social jetlag between weekday and weekend midpoints by wake day", () => {
    // Wake Friday 07:00 (midpoint 03:00) vs wake Saturday 09:00 (midpoint 05:00), +02:00
    const stats = timingStats([
      nightAt("2026-09-17T21:00:00Z", "2026-09-18T05:00:00Z"),
      nightAt("2026-09-18T23:00:00Z", "2026-09-19T07:00:00Z"),
    ]);
    expect(stats.weekday_nights).toBe(1);
    expect(stats.weekend_nights).toBe(1);
    expect(stats.weekday_midpoint_mean_minutes).toBeCloseTo(180, 6);
    expect(stats.weekend_midpoint_mean_minutes).toBeCloseTo(300, 6);
    expect(stats.social_jetlag_minutes).toBeCloseTo(120, 6);
  });

  it("uses each night's own offset and wraps the midpoint distance", () => {
    // Weekday (wake Friday 01:50, -04:00) midpoint 23:50; weekend (wake Sunday 03:20,
    // +02:00) midpoint 00:20 → 30 minutes apart, not 1410
    const stats = timingStats([
      nightAt("2026-09-18T01:50:00Z", "2026-09-18T05:50:00Z", "-04:00"),
      nightAt("2026-09-19T19:20:00Z", "2026-09-20T01:20:00Z", "+02:00"),
    ]);
    expect(stats.weekday_midpoint_mean_minutes).toBeCloseTo(23 * 60 + 50, 6);
    expect(stats.weekend_midpoint_mean_minutes).toBeCloseTo(20, 6);
    expect(stats.social_jetlag_minutes).toBeCloseTo(30, 6);
  });

  it("is null without nights or without both weekday and weekend nights", () => {
    expect(timingStats([])).toMatchObject({
      nights: 0,
      bedtime_sd_minutes: null,
      social_jetlag_minutes: null,
    });
    const weekdaysOnly = timingStats([nightAt("2026-09-14T21:30:00Z", "2026-09-15T05:30:00Z")]);
    expect(weekdaysOnly.social_jetlag_minutes).toBeNull();
    expect(weekdaysOnly.bedtime_sd_minutes).toBeCloseTo(0, 3);
  });
});

describe("resolveSleepWindow", () => {
  const now = new Date("2026-09-16T10:00:00.000Z");

  it("runs back `days` from now without a start", () => {
    expect(resolveSleepWindow(undefined, undefined, 14, now, "+02:00")).toEqual({
      startTime: now.getTime() - 14 * 86_400_000,
      endTime: now.getTime(),
    });
  });

  it("names the calling tool and its maximum in the oversized-window error", () => {
    expect(() =>
      resolveSleepWindow("2026-01-01", undefined, 14, now, "+02:00", {
        toolName: "get_sleep_analysis",
        maxDays: 90,
      })
    ).not.toThrow();
    expect(() =>
      resolveSleepWindow("last month", 90, 90, new Date("2026-12-31T10:00:00Z"), "+02:00", {
        toolName: "get_sleep_analysis",
        maxDays: 30,
      })
    ).toThrow(/get_sleep_analysis covers at most 30 days/);
    expect(() => resolveSleepWindow("last 6 months", undefined, 14, now, "+02:00")).toThrow(
      /get_sleep_debt covers at most 90 days/
    );
    expect(() => resolveSleepWindow("last 6 months", undefined, 14, now, "+02:00")).toThrow(
      InvalidDateExpression
    );
  });

  it("rejects a window starting after now as invalid date input naming the tool", () => {
    expect(() => resolveSleepWindow("2026-09-20", undefined, 14, now, "+02:00")).toThrow(
      InvalidDateExpression
    );
    expect(() =>
      resolveSleepWindow("2026-09-20", undefined, 14, now, "+02:00", {
        toolName: "get_sleep_analysis",
        maxDays: 90,
      })
    ).toThrow(
      'The sleep window "2026-09-20" begins at or after the current time; get_sleep_analysis needs a window that starts in the past.'
    );
  });
});

describe("LOW_DATA_COVERAGE_FRACTION", () => {
  it("is the documented 20% of time in bed", () => {
    expect(LOW_DATA_COVERAGE_FRACTION).toBe(0.2);
  });
});
