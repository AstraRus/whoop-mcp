/**
 * Tool: get_trend
 *
 * Analyzes a single health metric over the last N local calendar days:
 * chronological values with their local dates, summary statistics, a
 * per-day linear-regression trend, and anomaly detection.
 *
 * Supported metrics: recovery, hrv, rhr, sleep_duration, sleep_performance,
 * strain, sleep_efficiency, respiratory_rate, rem_share, deep_share,
 * disturbances_per_hour, sleep_consistency, sleep_debt, spo2 and skin_temp.
 *
 * Sparse data (a new or still-calibrating WHOOP user) is a normal state, not
 * an error: statistics are null without data points, and the trend,
 * confidence and anomalies are withheld below MIN_TREND_POINTS, with the
 * reason in `notes`.
 *
 * This module also holds the metric samples every aggregate privacy tool
 * shares (get_trend, get_weekly_summary, compare_periods, get_baselines and
 * get_sleep_debt). In aggregate mode a metric is computed only from whole
 * released local weeks (aggregate-window.ts) placed with the day model: each
 * week final (weekFinal) and holding at least AGGREGATE_WEEK_MIN_SAMPLES
 * samples of that metric. Every tool extracts a metric's per-day samples the
 * same way, so two aggregate outputs of one metric always differ by whole
 * weeks of at least three samples.
 */

import { z } from "zod";
import type { WhoopClient } from "../api/client.js";
import { fetchAllPages, ABSOLUTE_MAX_RECORDS } from "../api/pagination.js";
import {
  ENDPOINT_RECOVERY,
  ENDPOINT_SLEEP,
  ENDPOINT_CYCLE,
  ENDPOINT_WORKOUT,
} from "../api/endpoints.js";
import {
  cycleRecordSchema,
  recoveryRecordSchema,
  sleepRecordSchema,
  workoutRecordSchema,
} from "../api/record-schemas.js";
import type { Cycle, Recovery, RecoveryScore, Sleep, Workout } from "../api/types.js";
import type { PrivacyMode } from "../privacy.js";
import {
  asleepHours,
  cycleDay,
  DAY_MS,
  formatLocalTimestamp,
  HOUR_MS,
  localDay,
  mainSleeps,
  mostRelevantError,
  parseRecords,
  sourceQuality,
  type AnalyticsSource,
} from "./analytics-utils.js";
import {
  AGGREGATE_WEEK_MIN_SAMPLES,
  aggregateSourceCounts,
  gateWeeks,
  lastReleasedWeeks,
  roundStep,
  snapWeeks,
  weekFinal,
  type AggregateSourceCounts,
  type CountedRecord,
  type LocalWeek,
} from "./aggregate-window.js";
import { resolveUserUtcOffsetInfo, withOffsetNote } from "./collection-utils.js";
import { parseUtcOffset } from "./date-utils.js";
import {
  addDays as addLocalDays,
  assignWorkouts,
  fetchRangeForDays,
  isLocalMidnight,
  isOpenCycle,
  mondayOf,
  openCycleStrainNote,
  placeDays,
  type DayPlacement,
  type WorkoutPlacement,
} from "./day-model.js";
import {
  LOW_DATA_COVERAGE_FRACTION,
  MIN_ASLEEP_MINUTES_FOR_RATES,
  stageBreakdown,
  whoopConsistency,
} from "./sleep-metrics.js";
import {
  mean,
  median,
  sampleStandardDeviation,
  linearRegressionXY,
  trendDirection,
  detectAnomalies,
  isConstant,
  MIN_TREND_POINTS,
  trendConfidence,
} from "./stats-utils.js";
import type { TrendConfidence, TrendDirectionResult } from "./stats-utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Supported metric names, in the order the tool lists them */
export const TREND_METRICS = [
  "recovery",
  "hrv",
  "rhr",
  "sleep_duration",
  "sleep_performance",
  "strain",
  "sleep_efficiency",
  "respiratory_rate",
  "rem_share",
  "deep_share",
  "disturbances_per_hour",
  "sleep_consistency",
  "sleep_debt",
  "spo2",
  "skin_temp",
] as const;

/** Supported metric names */
export type TrendMetric = (typeof TREND_METRICS)[number];

/** Input parameters for get_trend */
export interface GetTrendParams {
  metric: TrendMetric;
  days?: number;
}

/** How a legacy analytics tool is evaluated */
export interface AnalyticsToolOptions {
  /** "aggregate" evaluates whole released local weeks only. Default "standard". */
  privacyMode?: PrivacyMode;
}

/** Confidence level based on R² and the number of data points */
export type { TrendConfidence };

/** Raw numeric direction of a trend, independent of whether it is good or bad */
export type TrendChange = "increasing" | "decreasing" | "stable";

/** Which direction is better for a metric; null when neither is (e.g. strain) */
export type BetterWhen = "higher" | "lower" | null;

/** A detected anomaly with its local date */
export interface TrendAnomaly {
  date: string;
  value: number;
  deviation_from_mean: number;
}

/** Output shape for get_trend */
export interface TrendAnalysis {
  metric: string;
  period: { start: string; end: string; days: number };
  status: "available" | "insufficient_data";
  sample_size: number;
  /** Whether any recovery used is still calibrating; null for non-recovery metrics */
  calibrating: boolean | null;
  truncated: boolean;
  /** Oldest first */
  values: number[];
  /** Local calendar day (YYYY-MM-DD) of each value, in lockstep with values */
  dates: string[];
  statistics: {
    mean: number | null;
    median: number | null;
    std_dev: number | null;
    min: number | null;
    max: number | null;
  };
  trend: {
    direction: TrendDirectionResult | null;
    change: TrendChange | null;
    better_when: BetterWhen;
    /** Change per day */
    slope: number | null;
    confidence: TrendConfidence | null;
  };
  anomalies: TrendAnomaly[];
  notes: string[];
}

/** One value placed on the user's local calendar */
interface Observation {
  day: string;
  /** Instant used to order observations chronologically */
  anchor: number;
  value: number;
  calibrating: boolean;
}

interface LoadedObservations {
  observations: Observation[];
  /** Records in the window that had no value for the metric (e.g. a scored night without a performance score) */
  skipped: number;
  truncated: boolean;
  notes: string[];
}

interface TrendWindow {
  firstDay: string;
  lastDay: string;
  /** Query range sent to WHOOP (starts a day early to catch records spanning the edge) */
  query: { start: string; end: string };
  offset: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_DAYS = 30;

const MAX_PAGES = 20;

/** Week counts an aggregate get_trend window snaps to */
export const TREND_AGGREGATE_WEEKS = [1, 2, 4, 8, 13] as const;

/**
 * The sleep metrics that leave out nights with low data coverage (no strap
 * data for more than LOW_DATA_COVERAGE_FRACTION of time in bed). The metrics
 * that existed before (sleep_duration, sleep_performance) keep every night.
 */
export const LOW_COVERAGE_METRICS: ReadonlySet<TrendMetric> = new Set<TrendMetric>([
  "sleep_efficiency",
  "rem_share",
  "deep_share",
  "disturbances_per_hour",
  "sleep_debt",
]);

/** Metrics whose values come from recoveries (WHOOP flags them while calibrating) */
export const RECOVERY_METRICS: ReadonlySet<TrendMetric> = new Set<TrendMetric>([
  "recovery",
  "hrv",
  "rhr",
  "spo2",
  "skin_temp",
]);

/** Wording for a recovery field WHOOP leaves out on devices that do not measure it */
export const NOT_REPORTED_BY_DEVICE = "not reported (WHOOP 4.0 or later)";

const LOW_COVERAGE_PERCENT = Math.round(LOW_DATA_COVERAGE_FRACTION * 100);

interface MetricDefinition {
  betterWhen: BetterWhen;
  /** Values come from recoveries, which carry WHOOP's calibration flag */
  recoveryBased: boolean;
  /** Singular and plural name of one source record (e.g. a scored night) */
  unit: [string, string];
  /** Singular and plural name of a record that has a value, when not every record has one */
  valueUnit?: [string, string];
  /** Sentence subject for notes, e.g. "Respiratory rate" */
  label: string;
  load: (client: WhoopClient, window: TrendWindow) => Promise<LoadedObservations>;
}

// ---------------------------------------------------------------------------
// Local-day helpers
// ---------------------------------------------------------------------------

function addDays(day: string, count: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + count * DAY_MS).toISOString().slice(0, 10);
}

function localMidnightMs(day: string, offset: string): number {
  return Date.parse(`${day}T00:00:00.000Z`) - parseUtcOffset(offset) * 60_000;
}

/** ISO 8601 timestamp written in the user's offset, so its date part is the local date */
function formatLocal(ms: number, offset: string): string {
  const wallClock = new Date(ms + parseUtcOffset(offset) * 60_000).toISOString().slice(0, 23);
  return `${wallClock}${offset === "Z" ? "Z" : offset}`;
}

function daysBetween(fromDay: string, toDay: string): number {
  return (Date.parse(`${toDay}T00:00:00.000Z`) - Date.parse(`${fromDay}T00:00:00.000Z`)) / DAY_MS;
}

function inWindow(day: string, window: TrendWindow): boolean {
  return day >= window.firstDay && day <= window.lastDay;
}

function plural(count: number, unit: [string, string]): string {
  return `${count} ${count === 1 ? unit[0] : unit[1]}`;
}

function wasWere(count: number): string {
  return count === 1 ? "was" : "were";
}

/** Whether a scored sleep has no data for more than LOW_DATA_COVERAGE_FRACTION of its time in bed */
export function hasLowDataCoverage(sleep: Sleep): boolean {
  const stages = sleep.score?.stage_summary;
  if (!stages || stages.total_in_bed_time_milli <= 0) return false;
  return (
    stages.total_no_data_time_milli > LOW_DATA_COVERAGE_FRACTION * stages.total_in_bed_time_milli
  );
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

async function fetchWindow(
  client: WhoopClient,
  endpoint: string,
  window: TrendWindow
): Promise<{ records: unknown[]; truncated: boolean }> {
  const params = new URLSearchParams();
  params.set("start", window.query.start);
  params.set("end", window.query.end);
  params.set("limit", "25");
  return fetchAllPages<unknown>(client, `${endpoint}?${params.toString()}`, {
    maxRecords: ABSOLUTE_MAX_RECORDS,
    maxPages: MAX_PAGES,
    interPageDelayMs: 0,
  });
}

function invalidNote(count: number, source: string): string[] {
  return count
    ? [`${count} ${source} record(s) did not match the expected WHOOP format and were skipped.`]
    : [];
}

// ---------------------------------------------------------------------------
// Metric values
// ---------------------------------------------------------------------------

type RecoveryField =
  | "recovery_score"
  | "hrv_rmssd_milli"
  | "resting_heart_rate"
  | "spo2_percentage"
  | "skin_temp_celsius";

const RECOVERY_FIELD: Record<string, RecoveryField> = {
  recovery: "recovery_score",
  hrv: "hrv_rmssd_milli",
  rhr: "resting_heart_rate",
  spo2: "spo2_percentage",
  skin_temp: "skin_temp_celsius",
};

/** Why a scored record has no value for a metric */
export type ValueSkip =
  | "not_reported"
  | "no_time_asleep"
  | "short_sleep"
  | "zero_during_calibration"
  | "zero_unverified";

type MetricValue = { value: number } | { skip: ValueSkip };

/** The value of a recovery metric for one scored recovery */
function recoveryMetricValue(metric: TrendMetric, score: RecoveryScore): MetricValue {
  const value = score[RECOVERY_FIELD[metric]!];
  return typeof value === "number" && Number.isFinite(value) ? { value } : { skip: "not_reported" };
}

/**
 * The value of a sleep metric for one scored main sleep. `recovery` is the
 * scored recovery WHOOP produced for this sleep (sleep_consistency only):
 * null when none was found or recoveries could not be loaded.
 */
function sleepMetricValue(
  metric: TrendMetric,
  sleep: Sleep,
  recovery: Recovery | null
): MetricValue {
  const score = sleep.score!;
  const finite = (value: number | null | undefined): MetricValue =>
    typeof value === "number" && Number.isFinite(value) ? { value } : { skip: "not_reported" };
  switch (metric) {
    case "sleep_duration":
      return { value: asleepHours(sleep) };
    case "sleep_performance":
      return finite(score.sleep_performance_percentage);
    case "sleep_efficiency":
      return finite(score.sleep_efficiency_percentage);
    case "respiratory_rate":
      return finite(score.respiratory_rate);
    case "rem_share":
    case "deep_share": {
      const stages = stageBreakdown(sleep);
      const share = metric === "rem_share" ? stages?.rem_pct_of_asleep : stages?.sws_pct_of_asleep;
      return typeof share === "number" ? { value: share } : { skip: "no_time_asleep" };
    }
    case "disturbances_per_hour": {
      const perHour = stageBreakdown(sleep)?.disturbances_per_hour_asleep;
      return typeof perHour === "number" ? { value: perHour } : { skip: "short_sleep" };
    }
    case "sleep_consistency": {
      const consistency = whoopConsistency(sleep, recovery);
      if (consistency.value === null)
        return {
          skip:
            consistency.reason === "zero_during_calibration" ? consistency.reason : "not_reported",
        };
      // WHOOP reports 0 while calibrating: without a scored recovery the flag cannot be checked.
      if (consistency.value === 0 && !recovery?.score) return { skip: "zero_unverified" };
      return { value: consistency.value };
    }
    case "sleep_debt":
      return { value: score.sleep_needed.need_from_sleep_debt_milli / HOUR_MS };
    default:
      throw new RangeError(`${metric} is not a sleep metric.`);
  }
}

type SkipCounts = Partial<Record<string, number>>;

/** Notes for scored main sleeps a sleep metric skipped, by reason (counts only, no dates) */
function sleepSkipNotes(metric: TrendMetric, skips: SkipCounts): string[] {
  const notes: string[] = [];
  const count = (reason: string): number => skips[reason] ?? 0;
  const nights = (n: number, singular = "night", pluralForm = "nights"): string =>
    `${n} ${n === 1 ? singular : pluralForm}`;
  const label = METRICS[metric].label.toLowerCase();
  const lowCoverage = count("low_data_coverage");
  if (lowCoverage)
    notes.push(
      `${nights(lowCoverage)} with low data coverage (no strap data for more than ${LOW_COVERAGE_PERCENT}% of time in bed) ${wasWere(lowCoverage)} skipped.`
    );
  const notReported = count("not_reported");
  if (notReported)
    notes.push(
      `${nights(notReported, "scored night", "scored nights")} had no ${label} and ${wasWere(notReported)} skipped.`
    );
  const noTimeAsleep = count("no_time_asleep");
  if (noTimeAsleep)
    notes.push(
      `${nights(noTimeAsleep, "scored night", "scored nights")} had no time asleep, so no stage share, and ${wasWere(noTimeAsleep)} skipped.`
    );
  const short = count("short_sleep");
  if (short)
    notes.push(
      `${nights(short)} with less than ${MIN_ASLEEP_MINUTES_FOR_RATES / 60} hour asleep ${wasWere(short)} skipped: disturbances per hour needs at least ${MIN_ASLEEP_MINUTES_FOR_RATES / 60} hour asleep.`
    );
  const calibrationZero = count("zero_during_calibration");
  if (calibrationZero)
    notes.push(
      `${nights(calibrationZero)} had a sleep consistency of 0 while WHOOP was still calibrating and ${wasWere(calibrationZero)} skipped (WHOOP reports 0 until calibration ends).`
    );
  const unverified = count("zero_unverified");
  if (unverified)
    notes.push(
      `${nights(unverified)} had a sleep consistency of 0 without a scored recovery to check WHOOP's calibration flag and ${wasWere(unverified)} skipped.`
    );
  return notes;
}

/** Note for scored recoveries without a value for SpO2 or skin temperature (counts only) */
function recoveryNotReportedNote(metric: TrendMetric, count: number): string {
  const subject = metric === "spo2" ? "SpO2" : "skin temperature";
  return `${plural(count, RECOVERY_UNIT)} had no ${subject} and ${wasWere(count)} skipped: ${NOT_REPORTED_BY_DEVICE}.`;
}

// ---------------------------------------------------------------------------
// Metric loaders (standard mode)
// ---------------------------------------------------------------------------

function recoveryLoader(metric: TrendMetric, reportMissing: boolean): MetricDefinition["load"] {
  return async (client, window) => {
    const page = await fetchWindow(client, ENDPOINT_RECOVERY, window);
    const quality = sourceQuality(page.records.length, page.truncated);
    const scored = parseRecords(page.records, recoveryRecordSchema, quality).filter(
      (record) => record.score_state === "SCORED" && record.score
    );
    const notes = invalidNote(quality.exclusions.invalid ?? 0, "recovery");

    // A recovery belongs to the day of its cycle (joined via cycle_id); its
    // created_at can lag when the strap syncs late.
    const cycleStarts = new Map<number, { day: string; anchor: number }>();
    if (scored.length) {
      try {
        const cyclePage = await fetchWindow(client, ENDPOINT_CYCLE, window);
        for (const cycle of parseRecords(cyclePage.records, cycleRecordSchema, sourceQuality())) {
          cycleStarts.set(cycle.id, { day: cycleDay(cycle), anchor: Date.parse(cycle.start) });
        }
      } catch {
        notes.push(
          "Cycle data could not be loaded, so each recovery is dated by when WHOOP recorded it."
        );
      }
    }

    const observations: Observation[] = [];
    let missing = 0;
    for (const record of scored) {
      const placement = cycleStarts.get(record.cycle_id) ?? {
        day: localDay(record.created_at, window.offset),
        anchor: Date.parse(record.created_at),
      };
      if (!inWindow(placement.day, window)) continue;
      const result = recoveryMetricValue(metric, record.score!);
      if ("skip" in result) {
        missing++;
        continue;
      }
      observations.push({
        ...placement,
        value: result.value,
        calibrating: record.score!.user_calibrating,
      });
    }
    if (missing && reportMissing) notes.push(recoveryNotReportedNote(metric, missing));
    return { observations, skipped: missing, truncated: page.truncated, notes };
  };
}

function sleepLoader(
  extract: (sleep: Parameters<typeof asleepHours>[0]) => number | null | undefined,
  missingNote: (count: number) => string
): MetricDefinition["load"] {
  return async (client, window) => {
    const page = await fetchWindow(client, ENDPOINT_SLEEP, window);
    const quality = sourceQuality(page.records.length, page.truncated);
    const sleeps = parseRecords(page.records, sleepRecordSchema, quality).filter((sleep) =>
      inWindow(localDay(sleep.end, sleep.timezone_offset), window)
    );
    // Main (non-nap) scored sleeps, one per local wake-up day. Membership was
    // decided by local day above, so the period only has to contain every candidate.
    const nights = mainSleeps(
      sleeps,
      {
        start: new Date(Date.parse(window.query.start) - DAY_MS).toISOString(),
        end: new Date(Date.parse(window.query.end) + DAY_MS).toISOString(),
      },
      quality
    );
    const observations: Observation[] = [];
    let missing = 0;
    for (const night of nights) {
      const value = extract(night);
      if (typeof value !== "number" || !Number.isFinite(value)) {
        missing++;
        continue;
      }
      observations.push({
        day: localDay(night.end, night.timezone_offset),
        anchor: Date.parse(night.end),
        value,
        calibrating: false,
      });
    }
    const notes = invalidNote(quality.exclusions.invalid ?? 0, "sleep");
    if (missing) notes.push(missingNote(missing));
    return { observations, skipped: missing, truncated: page.truncated, notes };
  };
}

/**
 * Loader for the sleep metrics added after sleep_performance: main sleeps
 * as for sleep_duration, nights with low data coverage skipped for
 * LOW_COVERAGE_METRICS, and (sleep_consistency) the recovery WHOOP scored for
 * each sleep, joined by sleep_id, to recognise calibration zeros.
 */
function sleepMetricLoader(metric: TrendMetric): MetricDefinition["load"] {
  return async (client, window) => {
    const page = await fetchWindow(client, ENDPOINT_SLEEP, window);
    const quality = sourceQuality(page.records.length, page.truncated);
    const sleeps = parseRecords(page.records, sleepRecordSchema, quality).filter((sleep) =>
      inWindow(localDay(sleep.end, sleep.timezone_offset), window)
    );
    const nights = mainSleeps(
      sleeps,
      {
        start: new Date(Date.parse(window.query.start) - DAY_MS).toISOString(),
        end: new Date(Date.parse(window.query.end) + DAY_MS).toISOString(),
      },
      quality
    );
    const notes = invalidNote(quality.exclusions.invalid ?? 0, "sleep");

    let recoveriesBySleep: Map<string, Recovery> | null = null;
    if (metric === "sleep_consistency" && nights.length) {
      try {
        const recoveryPage = await fetchWindow(client, ENDPOINT_RECOVERY, window);
        recoveriesBySleep = new Map();
        for (const recovery of parseRecords(
          recoveryPage.records,
          recoveryRecordSchema,
          sourceQuality()
        )) {
          const current = recoveriesBySleep.get(recovery.sleep_id);
          if (!current || Date.parse(recovery.updated_at) > Date.parse(current.updated_at))
            recoveriesBySleep.set(recovery.sleep_id, recovery);
        }
      } catch {
        notes.push(
          "Recovery data could not be loaded, so WHOOP's calibration flag could not be checked for sleep consistency values of 0."
        );
      }
    }

    const observations: Observation[] = [];
    const skips: SkipCounts = {};
    const skip = (reason: string): void => {
      skips[reason] = (skips[reason] ?? 0) + 1;
    };
    for (const night of nights) {
      if (LOW_COVERAGE_METRICS.has(metric) && hasLowDataCoverage(night)) {
        skip("low_data_coverage");
        continue;
      }
      const recovery = recoveriesBySleep?.get(night.id) ?? null;
      const result = sleepMetricValue(
        metric,
        night,
        recovery?.score_state === "SCORED" ? recovery : null
      );
      if ("skip" in result) {
        skip(result.skip);
        continue;
      }
      observations.push({
        day: localDay(night.end, night.timezone_offset),
        anchor: Date.parse(night.end),
        value: result.value,
        calibrating: false,
      });
    }
    notes.push(...sleepSkipNotes(metric, skips));
    const skipped = Object.values(skips).reduce<number>((sum, value) => sum + (value ?? 0), 0);
    return { observations, skipped, truncated: page.truncated, notes };
  };
}

/**
 * Daily strain: the completed, scored cycle of each local day in the window.
 * Days come from the day model (as get_calendar places cycles, using the
 * window's sleeps), the open cycle is left out and named in a note, and so is
 * a day WHOOP covered only in part (the strap was put on that day).
 */
async function loadStrain(client: WhoopClient, window: TrendWindow): Promise<LoadedObservations> {
  const page = await fetchWindow(client, ENDPOINT_CYCLE, window);
  const quality = sourceQuality(page.records.length, page.truncated);
  const allCycles = parseRecords(page.records, cycleRecordSchema, quality);
  const notes = invalidNote(quality.exclusions.invalid ?? 0, "cycle");

  let sleeps: Sleep[] = [];
  let sleepsAvailable = true;
  try {
    const sleepPage = await fetchWindow(client, ENDPOINT_SLEEP, window);
    sleeps = parseRecords(sleepPage.records, sleepRecordSchema, sourceQuality());
  } catch {
    sleepsAvailable = false;
  }
  const placement = placeDays({
    cycles: allCycles,
    sleeps,
    recoveries: [],
    sleepsAvailable,
    today: window.lastDay,
    utcOffset: window.offset,
  });

  const openDays: string[] = [];
  let partialDays = 0;
  const observations: Observation[] = [];
  for (const cycle of allCycles) {
    const day = placement.dayOfCycle.get(cycle.id) ?? cycleDay(cycle);
    if (!inWindow(day, window)) continue;
    if (isOpenCycle(cycle)) {
      openDays.push(day);
      continue;
    }
    if (cycle.score_state !== "SCORED" || !cycle.score) continue;
    if (isPartialDay(placement, day, cycle)) {
      partialDays += 1;
      continue;
    }
    observations.push({
      day,
      anchor: Date.parse(cycle.start),
      value: cycle.score.strain,
      calibrating: false,
    });
  }
  notes.push(...openCycleStrainNote(openDays, window.lastDay));
  if (partialDays > 0) {
    notes.push(
      `${plural(partialDays, ["day", "days"])} WHOOP covered only in part (the strap was put on that day) ${partialDays === 1 ? "is" : "are"} left out of strain.`
    );
  }
  return { observations, skipped: 0, truncated: page.truncated, notes };
}

const RECOVERY_UNIT: [string, string] = ["scored recovery", "scored recoveries"];
const NIGHT_UNIT: [string, string] = ["scored night", "scored nights"];

const METRICS: Record<TrendMetric, MetricDefinition> = {
  recovery: {
    betterWhen: "higher",
    recoveryBased: true,
    unit: RECOVERY_UNIT,
    label: "Recovery",
    load: recoveryLoader("recovery", false),
  },
  hrv: {
    betterWhen: "higher",
    recoveryBased: true,
    unit: RECOVERY_UNIT,
    label: "HRV",
    load: recoveryLoader("hrv", false),
  },
  rhr: {
    betterWhen: "lower",
    recoveryBased: true,
    unit: RECOVERY_UNIT,
    label: "Resting heart rate",
    load: recoveryLoader("rhr", false),
  },
  sleep_duration: {
    betterWhen: "higher",
    recoveryBased: false,
    unit: NIGHT_UNIT,
    label: "Sleep duration",
    load: sleepLoader(asleepHours, (count) => `${count} night(s) had no sleep duration.`),
  },
  sleep_performance: {
    betterWhen: "higher",
    recoveryBased: false,
    unit: NIGHT_UNIT,
    valueUnit: ["night with a sleep performance score", "nights with a sleep performance score"],
    label: "Sleep performance",
    load: sleepLoader(
      (sleep) => sleep.score?.sleep_performance_percentage,
      (count) => `${count} scored night(s) had no sleep performance score and were skipped.`
    ),
  },
  strain: {
    betterWhen: null,
    recoveryBased: false,
    unit: ["completed cycle", "completed cycles"],
    label: "Strain",
    load: loadStrain,
  },
  sleep_efficiency: {
    betterWhen: "higher",
    recoveryBased: false,
    unit: NIGHT_UNIT,
    valueUnit: ["night with a sleep efficiency", "nights with a sleep efficiency"],
    label: "Sleep efficiency",
    load: sleepMetricLoader("sleep_efficiency"),
  },
  respiratory_rate: {
    betterWhen: null,
    recoveryBased: false,
    unit: NIGHT_UNIT,
    valueUnit: ["night with a respiratory rate", "nights with a respiratory rate"],
    label: "Respiratory rate",
    load: sleepMetricLoader("respiratory_rate"),
  },
  rem_share: {
    betterWhen: null,
    recoveryBased: false,
    unit: NIGHT_UNIT,
    valueUnit: ["night with a REM share", "nights with a REM share"],
    label: "REM share",
    load: sleepMetricLoader("rem_share"),
  },
  deep_share: {
    betterWhen: null,
    recoveryBased: false,
    unit: NIGHT_UNIT,
    valueUnit: ["night with a deep sleep share", "nights with a deep sleep share"],
    label: "Deep sleep share",
    load: sleepMetricLoader("deep_share"),
  },
  disturbances_per_hour: {
    betterWhen: null,
    recoveryBased: false,
    unit: NIGHT_UNIT,
    valueUnit: ["night with disturbances per hour", "nights with disturbances per hour"],
    label: "Disturbances per hour",
    load: sleepMetricLoader("disturbances_per_hour"),
  },
  sleep_consistency: {
    betterWhen: "higher",
    recoveryBased: false,
    unit: NIGHT_UNIT,
    valueUnit: ["night with a sleep consistency", "nights with a sleep consistency"],
    label: "Sleep consistency",
    load: sleepMetricLoader("sleep_consistency"),
  },
  sleep_debt: {
    betterWhen: "lower",
    recoveryBased: false,
    unit: NIGHT_UNIT,
    valueUnit: ["night with WHOOP sleep debt", "nights with WHOOP sleep debt"],
    label: "Sleep debt",
    load: sleepMetricLoader("sleep_debt"),
  },
  spo2: {
    betterWhen: null,
    recoveryBased: true,
    unit: RECOVERY_UNIT,
    valueUnit: ["scored recovery with SpO2", "scored recoveries with SpO2"],
    label: "SpO2",
    load: recoveryLoader("spo2", true),
  },
  skin_temp: {
    betterWhen: null,
    recoveryBased: true,
    unit: RECOVERY_UNIT,
    valueUnit: ["scored recovery with skin temperature", "scored recoveries with skin temperature"],
    label: "Skin temperature",
    load: recoveryLoader("skin_temp", true),
  },
};

/** Sentence subject of a metric in notes, e.g. "Respiratory rate" */
export function metricLabel(metric: TrendMetric): string {
  return METRICS[metric].label;
}

// ---------------------------------------------------------------------------
// Trend classification
// ---------------------------------------------------------------------------

function toChange(direction: TrendDirectionResult): TrendChange {
  if (direction === "improving") return "increasing";
  if (direction === "declining") return "decreasing";
  return "stable";
}

/** Whether a numeric change is an improvement for a metric */
function interpretChange(change: TrendChange, betterWhen: BetterWhen): TrendDirectionResult | null {
  if (betterWhen === null) return null;
  if (change === "stable") return "stable";
  return (change === "increasing") === (betterWhen === "higher") ? "improving" : "declining";
}

/** The note for a metric without a better direction (strain keeps its original wording) */
function neutralDirectionNote(metric: TrendMetric): string {
  return `${METRICS[metric].label} is neither better nor worse when higher, so only trend.change is given.`;
}

/** The calibration note (recovery, HRV and resting heart rate keep their original wording) */
function calibratingNote(metric: TrendMetric, flagged: number, sampleSize: number): string {
  if (metric === "spo2" || metric === "skin_temp")
    return `WHOOP is still calibrating (${flagged} of ${plural(sampleSize, METRICS[metric].unit)} flagged); these recoveries are included.`;
  return `WHOOP is still calibrating (${flagged} of ${plural(sampleSize, METRICS[metric].unit)} flagged), so recovery, HRV and resting heart rate may shift.`;
}

interface TrendFit {
  trend: TrendAnalysis["trend"];
  notes: string[];
}

/** Regression, direction and confidence over chronological values (at least MIN_TREND_POINTS) */
function fitTrend(
  metric: TrendMetric,
  values: number[],
  dates: string[],
  options: { nameConstantValue: boolean }
): TrendFit {
  const definition = METRICS[metric];
  const sampleSize = values.length;
  const notes: string[] = [];
  const xs = dates.map((day) => daysBetween(dates[0]!, day));
  const regression = linearRegressionXY(xs, values);
  const constant = isConstant(values);
  const change = constant ? "stable" : toChange(trendDirection(regression.slope, regression.r2));
  const confidence = trendConfidence(regression.r2, sampleSize, constant);
  if (constant) {
    notes.push(
      options.nameConstantValue
        ? `All ${sampleSize} values were identical (${values[0]}), so the metric was flat over this period.`
        : `All ${sampleSize} values were identical, so the metric was flat over this period.`
    );
  } else if (change === "stable" && confidence === "low") {
    notes.push(
      "No consistent upward or downward direction was found, so the trend is reported as stable; confidence is low because it rates how well a sloped line fits the values."
    );
  }
  return {
    trend: {
      direction: interpretChange(change, definition.betterWhen),
      change,
      better_when: definition.betterWhen,
      slope: regression.slope,
      confidence,
    },
    notes,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Analyze a health metric trend over the last `days` local calendar days
 * (today included), or in aggregate privacy mode over whole released local
 * weeks (`days` snapped to 1, 2, 4, 8 or 13 weeks).
 *
 * Values are ordered oldest first before any regression. Never throws for
 * sparse data; WHOOP API failures on the metric's own endpoint still throw.
 */
export async function getTrend(
  client: WhoopClient,
  params: GetTrendParams,
  now: Date = new Date(),
  options: AnalyticsToolOptions = {}
): Promise<TrendAnalysis> {
  const days = params.days ?? DEFAULT_DAYS;
  const definition = METRICS[params.metric];
  const { offset, fallback: offsetFallback } = await resolveUserUtcOffsetInfo(client);
  if (options.privacyMode === "aggregate") {
    return aggregateTrend(client, params.metric, days, now, offset, offsetFallback);
  }
  const lastDay = localDay(now.toISOString(), offset);
  const firstDay = addDays(lastDay, -(days - 1));
  const windowStartMs = localMidnightMs(firstDay, offset);
  const window: TrendWindow = {
    firstDay,
    lastDay,
    offset,
    query: { start: new Date(windowStartMs - DAY_MS).toISOString(), end: now.toISOString() },
  };

  const loaded = await definition.load(client, window);
  const observations = [...loaded.observations].sort((left, right) => left.anchor - right.anchor);
  const values = observations.map((observation) => observation.value);
  const dates = observations.map((observation) => observation.day);
  const sampleSize = values.length;
  const notes = [...loaded.notes];

  const calibratingCount = observations.filter((observation) => observation.calibrating).length;

  const statistics: TrendAnalysis["statistics"] = sampleSize
    ? {
        mean: mean(values),
        median: median(values),
        std_dev: sampleStandardDeviation(values),
        min: Math.min(...values),
        max: Math.max(...values),
      }
    : { mean: null, median: null, std_dev: null, min: null, max: null };

  let trend: TrendAnalysis["trend"] = {
    direction: null,
    change: null,
    better_when: definition.betterWhen,
    slope: null,
    confidence: null,
  };
  let anomalies: TrendAnomaly[] = [];

  if (sampleSize >= MIN_TREND_POINTS) {
    const fit = fitTrend(params.metric, values, dates, { nameConstantValue: true });
    trend = fit.trend;
    notes.push(...fit.notes);
    anomalies = detectAnomalies(values, 2).map((anomaly) => ({
      date: dates[anomaly.index]!,
      value: anomaly.value,
      deviation_from_mean: anomaly.deviation,
    }));
  } else {
    // "no scored nights" only when there were none; scored nights without a value are counted apart
    const valueUnit = definition.valueUnit ?? definition.unit;
    const found = sampleSize
      ? plural(sampleSize, valueUnit)
      : `no ${(loaded.skipped ? valueUnit : definition.unit)[1]}`;
    notes.unshift(
      `Not enough data yet: ${found} in the last ${days} days; a trend needs at least ${MIN_TREND_POINTS}.`
    );
  }

  if (calibratingCount) {
    notes.push(calibratingNote(params.metric, calibratingCount, sampleSize));
  }
  if (definition.betterWhen === null && sampleSize >= MIN_TREND_POINTS) {
    notes.push(neutralDirectionNote(params.metric));
  }
  if (loaded.truncated) {
    notes.push(
      "WHOOP returned more records than could be fetched; the oldest days of the window are missing."
    );
  }

  return {
    metric: params.metric,
    period: {
      start: formatLocal(windowStartMs, offset),
      end: formatLocal(now.getTime(), offset),
      days,
    },
    status: sampleSize >= MIN_TREND_POINTS ? "available" : "insufficient_data",
    sample_size: sampleSize,
    calibrating: definition.recoveryBased ? calibratingCount > 0 : null,
    truncated: loaded.truncated,
    values,
    dates,
    statistics,
    trend,
    anomalies,
    notes: withOffsetNote(notes, offsetFallback),
  };
}

// ===========================================================================
// Aggregate privacy mode: released local weeks shared by the aggregate tools
// ===========================================================================

/** Rounding step of each metric in aggregate outputs (standard deviations use the same step) */
export const AGGREGATE_METRIC_STEP: Record<TrendMetric, number> = {
  recovery: 1,
  hrv: 1,
  rhr: 1,
  spo2: 1,
  skin_temp: 0.1,
  sleep_duration: 0.1,
  sleep_performance: 1,
  sleep_efficiency: 1,
  respiratory_rate: 0.1,
  rem_share: 1,
  deep_share: 1,
  disturbances_per_hour: 0.1,
  sleep_consistency: 1,
  sleep_debt: 0.1,
  strain: 0.1,
};

/** A value rounded to its metric's aggregate step; null stays null */
export function roundAggregate(metric: TrendMetric, value: number | null): number | null {
  return value === null ? null : roundStep(value, AGGREGATE_METRIC_STEP[metric]);
}

/** Record sources placed by the day model */
export type PlacedSource = "recovery" | "sleep" | "cycle";

/** The released weeks and placed records an aggregate tool evaluates */
export interface AggregateData {
  offset: string;
  /** Window weeks, oldest first, every one released */
  weeks: LocalWeek[];
  cycle: AnalyticsSource<Cycle>;
  sleep: AnalyticsSource<Sleep>;
  recovery: AnalyticsSource<Recovery>;
  /** Null unless workouts were requested */
  workout: AnalyticsSource<Workout> | null;
  placement: DayPlacement;
  /** Workout id → placement (empty without workouts) */
  workoutPlacement: Map<string, WorkoutPlacement>;
  /** Cycles, sleeps and recoveries were all read completely: placement is exact */
  placementComplete: boolean;
  /** Workouts were requested and read completely */
  workoutsComplete: boolean;
  /** Mondays of window weeks whose records can no longer change (weekFinal); empty when placement is incomplete */
  finalMondays: string[];
  /** Window weeks withheld because a record placed in them is still open or being scored */
  notFinalWeeks: number;
}

/** Metrics an aggregate tool can extract: the trend metrics plus get_sleep_debt's nightly deficit */
export type SampleMetric = TrendMetric | "sleep_deficit";

/** A metric value placed on a local day of a final released week */
export interface MetricSample {
  day: string;
  monday: string;
  value: number;
  /** Chronological order */
  anchor: number;
  source: PlacedSource;
  /** Record key within its source (see recordKey) */
  key: string;
  /** The main sleep a sleep metric comes from */
  sleep?: Sleep;
}

/** A metric's samples in final weeks, before per-week gating */
export interface MetricExtraction {
  samples: MetricSample[];
  /** Records of the metric's source not used, by reason (final weeks only; counts) */
  exclusions: Record<string, number>;
  /** "<source>:<key>" → why that record gave no sample (final weeks only) */
  recordExclusions: Map<string, string>;
}

/** Samples of weeks holding at least AGGREGATE_WEEK_MIN_SAMPLES of them */
export interface GatedSamples {
  released: MetricSample[];
  /** Mondays whose samples were released */
  releasedMondays: string[];
  /** Final weeks left out with 1 or 2 samples */
  smallWeeks: number;
}

/** A metric's released samples with the notes explaining what was left out */
export interface AggregateMetricResult extends GatedSamples {
  metric: SampleMetric;
  samples: MetricSample[];
  exclusions: Record<string, number>;
  recordExclusions: Map<string, string>;
  notes: string[];
}

/** The key identifying a placed record within its source */
export function recordKey(
  source: PlacedSource,
  record: { id: string | number } | Recovery
): string {
  return source === "recovery"
    ? `recovery:${(record as Recovery).cycle_id}`
    : `${source}:${(record as { id: string | number }).id}`;
}

/**
 * Read a WHOOP collection like loadAnalyticsSource (first-page failure →
 * fetch_failed with the error; later-page failure → records kept, truncated,
 * partialError), without a fixed delay between pages: the client's rate
 * limiter paces requests.
 */
export async function loadAggregateSource<T>(
  client: WhoopClient,
  endpoint: string,
  period: { start: string; end: string },
  schema: z.ZodType<T>
): Promise<AnalyticsSource<T>> {
  const query = new URLSearchParams({ ...period, limit: "25" });
  const pageSchema = z.object({
    records: z.array(z.unknown()),
    next_token: z.string().max(4096).nullish(),
  });
  let pagesRead = 0;
  let partialError: unknown;
  const validatedClient: WhoopClient = {
    get: async <Result>(path: string): Promise<Result> => {
      try {
        const page = pageSchema.parse(await client.get<unknown>(path));
        pagesRead += 1;
        return page as Result;
      } catch (error: unknown) {
        if (pagesRead === 0) throw error;
        partialError = error;
        return { records: [], next_token: null } as Result;
      }
    },
  };
  try {
    const result = await fetchAllPages<unknown>(validatedClient, `${endpoint}?${query}`, {
      maxRecords: ABSOLUTE_MAX_RECORDS,
      maxPages: Math.ceil(ABSOLUTE_MAX_RECORDS / 25),
      interPageDelayMs: 0,
    });
    const partial = partialError !== undefined;
    const quality = sourceQuality(result.records.length, result.truncated || partial);
    const records = parseRecords(result.records, schema, quality);
    return partial ? { records, quality, partialError } : { records, quality };
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      return { records: [], quality: { ...sourceQuality(), status: "invalid" } };
    }
    return { records: [], quality: { ...sourceQuality(), status: "fetch_failed" }, error };
  }
}

/** Whether a source could not be read or was read only in part */
export function sourceIncomplete(source: AnalyticsSource<unknown>): boolean {
  return (
    source.quality.status === "fetch_failed" ||
    source.quality.status === "invalid" ||
    source.quality.truncated
  );
}

function emptySource<T>(): AnalyticsSource<T> {
  return { records: [], quality: sourceQuality() };
}

/**
 * Read and place the records of released weeks: cycles, sleeps and recoveries
 * (and workouts when asked) over fetchRangeForDays(first Monday, last Sunday),
 * placed with placeDays and assignWorkouts, and each week checked with
 * weekFinal. Without recoveries (`recoveries: false`, for tools that use no
 * recovery or sleep consistency) sleeps and cycles are placed exactly as with
 * them. `weeks` must be consecutive released weeks, oldest first. The
 * fetch window ends two days after the last Sunday, which is before `now` for
 * a released week, so it never depends on the time of the call.
 */
export async function loadAggregateData(
  client: WhoopClient,
  weeks: readonly LocalWeek[],
  offset: string,
  now: Date,
  options: { workouts?: boolean; recoveries?: boolean } = {}
): Promise<AggregateData> {
  const first = weeks[0]!;
  const last = weeks[weeks.length - 1]!;
  const range = fetchRangeForDays(first.monday, last.sunday, offset, now.getTime());
  const period = {
    start: new Date(range.startMs).toISOString(),
    end: new Date(range.endMs).toISOString(),
  };
  const fetchable = range.endMs > range.startMs;
  const [recovery, sleep, cycle, workout] = await Promise.all([
    fetchable && options.recoveries !== false
      ? loadAggregateSource(client, ENDPOINT_RECOVERY, period, recoveryRecordSchema)
      : emptySource<Recovery>(),
    fetchable
      ? loadAggregateSource(client, ENDPOINT_SLEEP, period, sleepRecordSchema)
      : emptySource<Sleep>(),
    fetchable
      ? loadAggregateSource(client, ENDPOINT_CYCLE, period, cycleRecordSchema)
      : emptySource<Cycle>(),
    options.workouts
      ? fetchable
        ? loadAggregateSource(client, ENDPOINT_WORKOUT, period, workoutRecordSchema)
        : emptySource<Workout>()
      : Promise.resolve(null),
  ]);
  const placementComplete = [recovery, sleep, cycle].every((source) => !sourceIncomplete(source));
  const placement = placeDays({
    cycles: cycle.records,
    sleeps: sleep.records,
    recoveries: recovery.records,
    sleepsAvailable: sleep.quality.status !== "fetch_failed" && sleep.quality.status !== "invalid",
    today: localDay(now.toISOString(), offset),
    utcOffset: offset,
  });
  const workoutsComplete = workout !== null && !sourceIncomplete(workout);
  const workoutPlacement = workout
    ? assignWorkouts(workout.records, placement, cycle.records)
    : new Map<string, WorkoutPlacement>();
  const placedWorkouts = workoutsComplete
    ? workout.records.flatMap((record) => {
        const placed = workoutPlacement.get(record.id);
        return placed ? [{ day: placed.day, score_state: record.score_state }] : [];
      })
    : [];
  const finalMondays = placementComplete
    ? weeks
        .filter((week) => weekFinal(week.monday, placement, placedWorkouts))
        .map((week) => week.monday)
    : [];
  return {
    offset,
    weeks: [...weeks],
    cycle,
    sleep,
    recovery,
    workout,
    placement,
    workoutPlacement,
    placementComplete,
    workoutsComplete,
    finalMondays,
    notFinalWeeks: placementComplete ? weeks.length - finalMondays.length : 0,
  };
}

/** The local days of the given Mondays' weeks, oldest first */
export function weekDays(mondays: readonly string[]): string[] {
  return [...mondays]
    .sort()
    .flatMap((monday) => Array.from({ length: 7 }, (_, index) => addLocalDays(monday, index)));
}

function scoreExclusion(state: string): string {
  return state === "PENDING_SCORE" ? "pending" : "unscored";
}

/**
 * Whether the cycle placed on a day covers only part of it: the day WHOOP was
 * first worn (placeDays' partial days), or any cycle starting exactly at local
 * midnight without a main sleep (a strap put back on after a gap). The second
 * rule depends only on the cycle itself, so the answer never depends on how
 * far back a tool fetched.
 */
export function isPartialDay(placement: DayPlacement, day: string, cycle: Cycle): boolean {
  return (
    placement.partialDays.has(day) ||
    (!placement.mainSleepByCycle.has(cycle.id) &&
      isLocalMidnight(cycle.start, cycle.timezone_offset))
  );
}

/** The nightly deficit get_sleep_debt reports: WHOOP need without debt minus hours asleep, at least 0 */
export function sleepDeficit(sleep: Sleep): { needed: number; achieved: number; deficit: number } {
  const need = sleep.score!.sleep_needed;
  const needed =
    (need.baseline_milli + need.need_from_recent_strain_milli + need.need_from_recent_nap_milli) /
    HOUR_MS;
  const achieved = asleepHours(sleep);
  return { needed, achieved, deficit: Math.max(0, needed - achieved) };
}

/**
 * The samples of one metric in the final weeks, exactly as every aggregate
 * tool uses them:
 * - recovery metrics: the recovery placed on each day, scored and not
 *   calibrating (calibrating recoveries are never used in aggregate mode),
 *   with a reported value;
 * - sleep metrics (and the sleep deficit): the main sleep placed on each day,
 *   scored, with a value; nights with low data coverage are skipped for
 *   LOW_COVERAGE_METRICS;
 * - strain: the cycle placed on each day, completed, scored and not a partial
 *   day.
 * Records not placed on a day of their own (a displaced cycle and its sleep
 * and recovery) are never used.
 */
export function extractMetricSamples(data: AggregateData, metric: SampleMetric): MetricExtraction {
  const { placement } = data;
  const samples: MetricSample[] = [];
  const exclusions: Record<string, number> = {};
  const recordExclusions = new Map<string, string>();
  const exclude = (key: string, reason: string): void => {
    exclusions[reason] = (exclusions[reason] ?? 0) + 1;
    recordExclusions.set(key, reason);
  };
  for (const day of weekDays(data.finalMondays)) {
    const monday = mondayOf(day);
    const entry = placement.byDay.get(day);
    if (metric === "strain") {
      const cycle = placement.cycleByDay.get(day);
      if (!cycle) continue;
      const key = recordKey("cycle", cycle);
      if (isOpenCycle(cycle)) exclude(key, "in_progress");
      else if (isPartialDay(placement, day, cycle)) exclude(key, "partial_day");
      else if (cycle.score_state !== "SCORED" || !cycle.score)
        exclude(key, scoreExclusion(cycle.score_state));
      else
        samples.push({
          day,
          monday,
          value: cycle.score.strain,
          anchor: Date.parse(cycle.start),
          source: "cycle",
          key,
        });
      continue;
    }
    if (metric !== "sleep_deficit" && RECOVERY_METRICS.has(metric)) {
      const recovery = entry?.recovery;
      if (!recovery) continue;
      const key = recordKey("recovery", recovery);
      if (recovery.score_state !== "SCORED" || !recovery.score) {
        exclude(key, scoreExclusion(recovery.score_state));
        continue;
      }
      if (recovery.score.user_calibrating) {
        exclude(key, "calibrating");
        continue;
      }
      const result = recoveryMetricValue(metric, recovery.score);
      if ("skip" in result) {
        exclude(key, result.skip);
        continue;
      }
      const anchor = entry.cycle ? Date.parse(entry.cycle.start) : Date.parse(recovery.created_at);
      samples.push({ day, monday, value: result.value, anchor, source: "recovery", key });
      continue;
    }
    const sleep = entry?.sleep;
    if (!sleep || sleep.nap) continue;
    const key = recordKey("sleep", sleep);
    if (!(Date.parse(sleep.end) > Date.parse(sleep.start))) {
      exclude(key, "invalid_duration");
      continue;
    }
    if (sleep.score_state !== "SCORED" || !sleep.score) {
      exclude(key, scoreExclusion(sleep.score_state));
      continue;
    }
    if (metric === "sleep_deficit") {
      const { needed, deficit } = sleepDeficit(sleep);
      if (needed < 0) exclude(key, "invalid_need");
      else
        samples.push({
          day,
          monday,
          value: deficit,
          anchor: Date.parse(sleep.end),
          source: "sleep",
          key,
          sleep,
        });
      continue;
    }
    if (LOW_COVERAGE_METRICS.has(metric) && hasLowDataCoverage(sleep)) {
      exclude(key, "low_data_coverage");
      continue;
    }
    const candidate = placement.recoveryByCycle.get(sleep.cycle_id);
    const recovery =
      candidate && candidate.sleep_id === sleep.id && candidate.score_state === "SCORED"
        ? candidate
        : null;
    const result = sleepMetricValue(metric, sleep, recovery);
    if ("skip" in result) {
      exclude(key, result.skip);
      continue;
    }
    samples.push({
      day,
      monday,
      value: result.value,
      anchor: Date.parse(sleep.end),
      source: "sleep",
      key,
      sleep,
    });
  }
  samples.sort((left, right) => left.anchor - right.anchor || (left.day < right.day ? -1 : 1));
  return { samples, exclusions, recordExclusions };
}

/** Per-week gating: a final week contributes only with at least AGGREGATE_WEEK_MIN_SAMPLES samples */
export function gateSamples(
  samples: readonly MetricSample[],
  finalMondays: readonly string[]
): GatedSamples {
  const counts = new Map<string, number>();
  for (const sample of samples) counts.set(sample.monday, (counts.get(sample.monday) ?? 0) + 1);
  const { released, withheld } = gateWeeks(
    finalMondays.map((monday) => ({ monday, samples: counts.get(monday) ?? 0 })),
    AGGREGATE_WEEK_MIN_SAMPLES
  );
  const releasedMondays = released.map((week) => week.monday);
  const keep = new Set(releasedMondays);
  return {
    released: samples.filter((sample) => keep.has(sample.monday)),
    releasedMondays,
    smallWeeks: withheld.filter((week) => week.samples > 0).length,
  };
}

/** "1 week" / "4 weeks" */
export function weeksText(count: number): string {
  return `${count} ${count === 1 ? "week" : "weeks"}`;
}

/**
 * 'Aggregate privacy mode uses whole released weeks: 4 weeks ending
 * 2026-09-13.' (week labels only), optionally naming what the weeks are for.
 */
export function releasedWeeksNote(weeks: readonly LocalWeek[], suffix = ""): string {
  return `Aggregate privacy mode uses whole released weeks: ${weeksText(weeks.length)} ending ${weeks[weeks.length - 1]!.sunday}${suffix}.`;
}

/** Notes shared by the aggregate tools about weeks left out (counts, no dates) */
export function withheldWeekNotes(data: AggregateData): string[] {
  const notes: string[] = [];
  if (!data.placementComplete)
    notes.push(
      "Some WHOOP cycle, sleep or recovery data for these weeks could not be read completely, so no aggregate values are shown for them; repeating the request later may succeed."
    );
  if (data.notFinalWeeks)
    notes.push(
      `${weeksText(data.notFinalWeeks)} ${data.notFinalWeeks === 1 ? "is" : "are"} withheld because a record placed in ${data.notFinalWeeks === 1 ? "it" : "them"} is still open or being scored by WHOOP.`
    );
  return notes;
}

/** Note for final weeks left out of one metric with 1 or 2 samples (counts, no dates) */
export function smallWeeksNote(count: number, unitPlural: string, subject?: string): string | null {
  if (!count) return null;
  return `${subject ? `${subject}: ` : ""}${weeksText(count)} with fewer than ${AGGREGATE_WEEK_MIN_SAMPLES} ${unitPlural} ${count === 1 ? "is" : "are"} left out.`;
}

/** Notes for exclusions of one metric's records in final weeks (counts, no dates) */
export function exclusionNotes(metric: SampleMetric, exclusions: Record<string, number>): string[] {
  const notes: string[] = [];
  const { calibrating = 0, pending = 0, unscored = 0, ...rest } = exclusions;
  if (metric !== "sleep_deficit" && RECOVERY_METRICS.has(metric)) {
    if (calibrating)
      notes.push(
        `${plural(calibrating, ["recovery", "recoveries"])} WHOOP flags as calibrating ${calibrating === 1 ? "is" : "are"} not used in aggregate privacy mode.`
      );
    if (rest.not_reported) notes.push(recoveryNotReportedNote(metric, rest.not_reported));
  } else if (metric === "strain") {
    if (rest.partial_day)
      notes.push(
        `${plural(rest.partial_day, ["day", "days"])} WHOOP covered only in part (the strap was put on that day) ${rest.partial_day === 1 ? "is" : "are"} left out of strain.`
      );
  } else if (metric === "sleep_deficit") {
    if (rest.invalid_need)
      notes.push(
        `${plural(rest.invalid_need, ["sleep", "sleeps"])} with an invalid WHOOP sleep-need value ${wasWere(rest.invalid_need)} skipped.`
      );
  } else {
    notes.push(...sleepSkipNotes(metric, rest));
  }
  if (pending + unscored) {
    const noun: [string, string] =
      metric === "strain"
        ? ["cycle", "cycles"]
        : metric !== "sleep_deficit" && RECOVERY_METRICS.has(metric)
          ? ["recovery", "recoveries"]
          : ["sleep", "sleeps"];
    notes.push(
      `${plural(pending + unscored, noun)} without a WHOOP score ${pending + unscored === 1 ? "is" : "are"} not used.`
    );
  }
  return notes;
}

/** Extract, gate and explain one metric (notes without dates) */
export function aggregateMetric(
  data: AggregateData,
  metric: SampleMetric,
  options: { unitPlural?: string; subject?: string; exclusionNotes?: boolean } = {}
): AggregateMetricResult {
  const extraction = extractMetricSamples(data, metric);
  const gated = gateSamples(extraction.samples, data.finalMondays);
  const unitPlural =
    options.unitPlural ??
    (metric === "sleep_deficit"
      ? "scored nights"
      : (METRICS[metric].valueUnit ?? METRICS[metric].unit)[1]);
  const notes =
    options.exclusionNotes === false ? [] : exclusionNotes(metric, extraction.exclusions);
  const small = smallWeeksNote(gated.smallWeeks, unitPlural);
  if (small) notes.push(small);
  if (options.subject !== undefined)
    for (let index = 0; index < notes.length; index++)
      notes[index] = `${options.subject}: ${notes[index]}`;
  return {
    ...gated,
    metric,
    samples: extraction.samples,
    exclusions: extraction.exclusions,
    recordExclusions: extraction.recordExclusions,
    notes,
  };
}

/**
 * data_quality source counts in aggregate mode: only records placed on days
 * of the window weeks are counted, so records fetched for day placement
 * beyond the window (or added after it) never change them. A record is used
 * when it gave a released sample of one of `results` (a cycle also when the
 * recovery or sleep placed with it did); otherwise its exclusion is the week
 * not being final, the reason extraction gave, `sparse_week` (its week had too
 * few samples) or `not_used`.
 */
export function aggregateQualitySources(
  data: AggregateData,
  results: readonly AggregateMetricResult[],
  sources: readonly PlacedSource[]
): Record<string, AggregateSourceCounts> {
  const windowMondays = data.weeks.map((week) => week.monday);
  const final = new Set(data.finalMondays);
  const used = new Set<string>();
  const sampled = new Set<string>();
  for (const result of results) {
    for (const sample of result.released) used.add(sample.key);
    for (const sample of result.samples) sampled.add(sample.key);
  }
  const reasonOf = (key: string, day: string): string | null => {
    if (used.has(key)) return null;
    if (!final.has(mondayOf(day))) return "week_not_final";
    for (const result of results) {
      const reason = result.recordExclusions.get(key);
      if (reason !== undefined) return reason;
    }
    return sampled.has(key) ? "sparse_week" : "not_used";
  };
  const counted: Record<PlacedSource, CountedRecord[]> = { recovery: [], sleep: [], cycle: [] };
  const seen = new Set<string>();
  const count = (source: PlacedSource, key: string, day: string, reason: string | null): void => {
    if (seen.has(key)) return;
    seen.add(key);
    counted[source].push({ day, exclusion: reason });
  };
  const { placement } = data;
  const windowDays = weekDays(windowMondays);
  for (const day of windowDays) {
    const entry = placement.byDay.get(day);
    if (!entry) continue;
    const recoveryKey = entry.recovery ? recordKey("recovery", entry.recovery) : null;
    const sleepKey = entry.sleep ? recordKey("sleep", entry.sleep) : null;
    if (entry.recovery && recoveryKey)
      count("recovery", recoveryKey, day, reasonOf(recoveryKey, day));
    if (entry.sleep && sleepKey) count("sleep", sleepKey, day, reasonOf(sleepKey, day));
    if (entry.cycle) {
      const key = recordKey("cycle", entry.cycle);
      const context =
        (recoveryKey !== null && used.has(recoveryKey)) ||
        (sleepKey !== null && used.has(sleepKey));
      count("cycle", key, day, context ? null : reasonOf(key, day));
    }
  }
  const inWindow = new Set(windowDays);
  for (const { day, other } of placement.displaced) {
    if (!inWindow.has(day)) continue;
    count("cycle", recordKey("cycle", other), day, "displaced");
    const sleep = placement.mainSleepByCycle.get(other.id);
    if (sleep) count("sleep", recordKey("sleep", sleep), day, "displaced");
    const recovery = placement.recoveryByCycle.get(other.id);
    if (recovery) count("recovery", recordKey("recovery", recovery), day, "displaced");
  }
  for (const sleep of data.sleep.records) {
    if (!sleep.nap) continue;
    const day =
      placement.dayOfCycle.get(sleep.cycle_id) ?? localDay(sleep.end, sleep.timezone_offset);
    if (inWindow.has(day)) count("sleep", recordKey("sleep", sleep), day, "nap");
  }
  const sourceData: Record<PlacedSource, AnalyticsSource<unknown>> = {
    recovery: data.recovery,
    sleep: data.sleep,
    cycle: data.cycle,
  };
  return Object.fromEntries(
    sources.map((source) => [
      source,
      aggregateSourceCounts(sourceData[source].quality, counted[source], windowMondays),
    ])
  );
}

/** Aggregate get_trend: whole released weeks, per-week gating, rounded statistics */
async function aggregateTrend(
  client: WhoopClient,
  metric: TrendMetric,
  days: number,
  now: Date,
  offset: string,
  offsetFallback: boolean
): Promise<TrendAnalysis> {
  const definition = METRICS[metric];
  const weeks = lastReleasedWeeks(now, offset, snapWeeks(days, TREND_AGGREGATE_WEEKS));
  const data = await loadAggregateData(client, weeks, offset, now);
  const sources = [data.recovery, data.sleep, data.cycle];
  if (sources.every((source) => source.quality.status === "fetch_failed"))
    throw mostRelevantError(sources.map((source) => source.error));
  const own = definition.recoveryBased
    ? data.recovery
    : metric === "strain"
      ? data.cycle
      : data.sleep;
  if (own.quality.status === "fetch_failed") throw mostRelevantError([own.error]);

  const notes = [releasedWeeksNote(weeks), ...withheldWeekNotes(data)];
  const result = aggregateMetric(data, metric);
  notes.push(...result.notes);
  const values = result.released.map((sample) => sample.value);
  const dates = result.released.map((sample) => sample.day);
  const sampleSize = values.length;
  const step = AGGREGATE_METRIC_STEP[metric];

  let trend: TrendAnalysis["trend"] = {
    direction: null,
    change: null,
    better_when: definition.betterWhen,
    slope: null,
    confidence: null,
  };
  let statistics: TrendAnalysis["statistics"] = {
    mean: null,
    median: null,
    std_dev: null,
    min: null,
    max: null,
  };
  if (sampleSize >= MIN_TREND_POINTS) {
    const fit = fitTrend(metric, values, dates, { nameConstantValue: false });
    trend = { ...fit.trend, slope: roundStep(fit.trend.slope!, step / 10) };
    notes.push(...fit.notes);
    statistics = {
      mean: roundStep(mean(values), step),
      median: null,
      std_dev: roundStep(sampleStandardDeviation(values)!, step),
      min: null,
      max: null,
    };
    if (definition.betterWhen === null) notes.push(neutralDirectionNote(metric));
  } else {
    const valueUnit = definition.valueUnit ?? definition.unit;
    notes.push(
      `Not enough data yet: ${sampleSize ? plural(sampleSize, valueUnit) : `no ${valueUnit[1]}`} in released weeks with at least ${AGGREGATE_WEEK_MIN_SAMPLES} each; statistics and a trend need at least ${MIN_TREND_POINTS}.`
    );
  }
  if (sources.some((source) => source.quality.truncated))
    notes.push(
      "WHOOP returned more records than could be fetched for these weeks, so they are withheld."
    );

  const last = weeks[weeks.length - 1]!;
  return {
    metric,
    period: {
      start: formatLocalTimestamp(weeks[0]!.startMs, offset),
      end: formatLocalTimestamp(last.endMs - 1, offset),
      days: weeks.length * 7,
    },
    status: sampleSize >= MIN_TREND_POINTS ? "available" : "insufficient_data",
    sample_size: sampleSize,
    calibrating: definition.recoveryBased ? (result.exclusions.calibrating ?? 0) > 0 : null,
    truncated: sources.some((source) => source.quality.truncated),
    values: [],
    dates: [],
    statistics,
    trend,
    anomalies: [],
    notes: withOffsetNote(notes, offsetFallback),
  };
}
