/**
 * Per-sleep metrics derived from WHOOP's own sleep figures: stage breakdown,
 * sleep-need components, the sleep-consistency value with its calibration
 * rule, and bedtime/wake timing across nights.
 *
 * Values are unrounded (round at output). Sleep hours are light + slow-wave +
 * REM; naps are never added. WHOOP's need_from_recent_nap_milli is 0 or
 * negative (a nap lowers the need), and it is passed through with that sign.
 */

import type { Recovery, Sleep } from "../api/types.js";
import { HOUR_MS, localTime } from "./analytics-utils.js";
import { circularStats } from "./stats-utils.js";

/** A night whose no-data time exceeds this share of time in bed has low data coverage */
export const LOW_DATA_COVERAGE_FRACTION = 0.2;

/** Asleep time below which disturbances per hour are not reported */
export const MIN_ASLEEP_MINUTES_FOR_RATES = 60;

const MINUTE_MS = 60_000;

// ---------------------------------------------------------------------------
// Stage breakdown
// ---------------------------------------------------------------------------

export interface StageBreakdown {
  in_bed_min: number;
  /** Light + slow-wave + REM */
  asleep_min: number;
  awake_min: number;
  no_data_min: number;
  light_min: number;
  sws_min: number;
  rem_min: number;
  /** Shares of time asleep (sum to 100); null when nothing was asleep */
  light_pct_of_asleep: number | null;
  sws_pct_of_asleep: number | null;
  rem_pct_of_asleep: number | null;
  /** Shares of time in bed; null when time in bed is 0 */
  awake_pct_of_in_bed: number | null;
  no_data_pct_of_in_bed: number | null;
  disturbances: number;
  /** Null when asleep for less than MIN_ASLEEP_MINUTES_FOR_RATES */
  disturbances_per_hour_asleep: number | null;
  sleep_cycles: number;
}

/** Stage minutes and shares of a scored sleep; null when the sleep has no score */
export function stageBreakdown(sleep: Sleep): StageBreakdown | null {
  const stages = sleep.score?.stage_summary;
  if (!stages) return null;
  const light = stages.total_light_sleep_time_milli / MINUTE_MS;
  const sws = stages.total_slow_wave_sleep_time_milli / MINUTE_MS;
  const rem = stages.total_rem_sleep_time_milli / MINUTE_MS;
  const inBed = stages.total_in_bed_time_milli / MINUTE_MS;
  const awake = stages.total_awake_time_milli / MINUTE_MS;
  const noData = stages.total_no_data_time_milli / MINUTE_MS;
  const asleep = light + sws + rem;
  const ofAsleep = (value: number): number | null => (asleep > 0 ? (100 * value) / asleep : null);
  const ofInBed = (value: number): number | null => (inBed > 0 ? (100 * value) / inBed : null);
  return {
    in_bed_min: inBed,
    asleep_min: asleep,
    awake_min: awake,
    no_data_min: noData,
    light_min: light,
    sws_min: sws,
    rem_min: rem,
    light_pct_of_asleep: ofAsleep(light),
    sws_pct_of_asleep: ofAsleep(sws),
    rem_pct_of_asleep: ofAsleep(rem),
    awake_pct_of_in_bed: ofInBed(awake),
    no_data_pct_of_in_bed: ofInBed(noData),
    disturbances: stages.disturbance_count,
    disturbances_per_hour_asleep:
      asleep >= MIN_ASLEEP_MINUTES_FOR_RATES ? stages.disturbance_count / (asleep / 60) : null,
    sleep_cycles: stages.sleep_cycle_count,
  };
}

// ---------------------------------------------------------------------------
// Sleep need
// ---------------------------------------------------------------------------

export interface NeedBreakdown {
  baseline: number;
  /** WHOOP need_from_sleep_debt */
  debt: number;
  /** WHOOP need_from_recent_strain */
  strain: number;
  /** WHOOP need_from_recent_nap: 0 or negative */
  nap: number;
  /** baseline + debt + strain + nap */
  total_including_debt: number;
  /** baseline + strain + nap (get_sleep_debt's needed_hours) */
  total_excluding_debt: number;
}

/** WHOOP's sleep-need components of a scored sleep in hours; null without a score */
export function needBreakdown(sleep: Sleep): NeedBreakdown | null {
  const need = sleep.score?.sleep_needed;
  if (!need) return null;
  return {
    baseline: need.baseline_milli / HOUR_MS,
    debt: need.need_from_sleep_debt_milli / HOUR_MS,
    strain: need.need_from_recent_strain_milli / HOUR_MS,
    nap: need.need_from_recent_nap_milli / HOUR_MS,
    total_including_debt:
      (need.baseline_milli +
        need.need_from_sleep_debt_milli +
        need.need_from_recent_strain_milli +
        need.need_from_recent_nap_milli) /
      HOUR_MS,
    total_excluding_debt:
      (need.baseline_milli + need.need_from_recent_strain_milli + need.need_from_recent_nap_milli) /
      HOUR_MS,
  };
}

// ---------------------------------------------------------------------------
// Consistency
// ---------------------------------------------------------------------------

export interface WhoopConsistency {
  value: number | null;
  /** Why value is null: WHOOP reported 0 while calibrating, or reported nothing */
  reason: null | "zero_during_calibration" | "not_reported";
}

/**
 * WHOOP's sleep consistency percentage. While WHOOP calibrates it reports 0,
 * which is not a real value: a 0 whose recovery is calibrating becomes null.
 */
export function whoopConsistency(sleep: Sleep, recovery: Recovery | null): WhoopConsistency {
  const value = sleep.score?.sleep_consistency_percentage;
  if (value === null || value === undefined) return { value: null, reason: "not_reported" };
  if (value === 0 && recovery?.score?.user_calibrating === true)
    return { value: null, reason: "zero_during_calibration" };
  return { value, reason: null };
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

export interface TimingStats {
  nights: number;
  /** Nights waking Monday to Friday (local) */
  weekday_nights: number;
  /** Nights waking Saturday or Sunday (local) */
  weekend_nights: number;
  /** Circular means and SDs of local clock minutes (0-1439) */
  bedtime_mean_minutes: number | null;
  bedtime_sd_minutes: number | null;
  waketime_mean_minutes: number | null;
  waketime_sd_minutes: number | null;
  /** Circular mean sleep midpoints of weekday and weekend nights */
  weekday_midpoint_mean_minutes: number | null;
  weekend_midpoint_mean_minutes: number | null;
  /** Circular distance between the weekday and weekend midpoint means */
  social_jetlag_minutes: number | null;
}

/**
 * Bedtime and wake-time variability (circular SD of local clock minutes) and
 * social jetlag (distance between weekday and weekend sleep midpoints, by wake
 * day), as get_sleep_debt computes them. No minimum is applied here.
 */
export function timingStats(
  nights: readonly Pick<Sleep, "start" | "end" | "timezone_offset">[]
): TimingStats {
  const bedtimes: number[] = [];
  const waketimes: number[] = [];
  const weekdays: number[] = [];
  const weekends: number[] = [];
  for (const night of nights) {
    const bedtime = localTime(night.start, night.timezone_offset);
    const wake = localTime(night.end, night.timezone_offset);
    const bedMinutes =
      bedtime.getUTCHours() * 60 + bedtime.getUTCMinutes() + bedtime.getUTCSeconds() / 60;
    bedtimes.push(bedMinutes);
    waketimes.push(wake.getUTCHours() * 60 + wake.getUTCMinutes() + wake.getUTCSeconds() / 60);
    const midpoint =
      (bedMinutes + (Date.parse(night.end) - Date.parse(night.start)) / 120_000) % 1440;
    (wake.getUTCDay() === 0 || wake.getUTCDay() === 6 ? weekends : weekdays).push(midpoint);
  }
  const weekdayMean = circularStats(weekdays).mean;
  const weekendMean = circularStats(weekends).mean;
  const midpointDistance =
    weekdayMean === null || weekendMean === null ? null : Math.abs(weekdayMean - weekendMean);
  const bed = circularStats(bedtimes);
  const wake = circularStats(waketimes);
  return {
    nights: nights.length,
    weekday_nights: weekdays.length,
    weekend_nights: weekends.length,
    bedtime_mean_minutes: bed.mean,
    bedtime_sd_minutes: bed.sd,
    waketime_mean_minutes: wake.mean,
    waketime_sd_minutes: wake.sd,
    weekday_midpoint_mean_minutes: weekdayMean,
    weekend_midpoint_mean_minutes: weekendMean,
    social_jetlag_minutes:
      midpointDistance === null ? null : Math.min(midpointDistance, 1440 - midpointDistance),
  };
}
