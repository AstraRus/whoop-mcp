/**
 * Tool: get_recovery_analysis
 *
 * Describes recoveries over the last `days` local days: recovery zones,
 * per-metric summaries, the 7-day ln(RMSSD) mean and coefficient of variation,
 * weekday patterns, and per-day deviations from a personal rolling baseline.
 *
 * - A recovery belongs to the local wake day of the sleep it was scored for,
 *   else to its cycle's day (cycleDay, as get_baselines); one per day, the most
 *   recently updated.
 * - Each day's baseline is the `baseline_days` local days strictly before it.
 *   Calibrating recoveries are counted in zones and summaries (and flagged) but
 *   excluded from baselines, deviations, the ln(RMSSD) window and weekday
 *   patterns; respiratory-rate baselines keep them.
 * - Deviations are robust z-scores (median and 1.4826 × MAD), HRV on ln values.
 *   ±2 is a descriptive flag, not a clinical threshold; no cut-offs are applied.
 */

import { z } from "zod";
import { ENDPOINT_CYCLE, ENDPOINT_RECOVERY, ENDPOINT_SLEEP } from "../api/endpoints.js";
import {
  createHistoryBudget,
  HISTORY_DEADLINE_MS,
  HISTORY_LIMITATIONS,
  loadHistory,
} from "../api/history.js";
import {
  cycleRecordSchema,
  recoveryRecordSchema,
  sleepRecordSchema,
} from "../api/record-schemas.js";
import type { Cycle, Recovery, Sleep } from "../api/types.js";
import {
  cycleDay,
  dataQualitySchema,
  DAY_MS,
  DISCLAIMER,
  exclude,
  finishQuality,
  formatLocalTimestamp,
  localDay,
  localMidnightMs,
  mostRelevantError,
  recoveryZone,
  type SourceQuality,
} from "./analytics-utils.js";
import { resolveUserUtcOffsetInfo, withOffsetNote } from "./collection-utils.js";
import { addDays, fetchRangeForDays, isNewer } from "./day-model.js";
import { BASELINE_MIN_SAMPLES } from "./get-baselines.js";
import { historyTruncationNotes, plural } from "./get-sleep-analysis.js";
import {
  mean,
  median,
  medianAbsoluteDeviation,
  robustZ,
  roundTo,
  sampleStandardDeviation,
} from "./stats-utils.js";
import { defineTool, type ToolContext } from "./tool-definition.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Analysis window without `days`. */
export const RECOVERY_ANALYSIS_DEFAULT_DAYS = 30;

/** Baseline window without `baseline_days`. */
export const RECOVERY_ANALYSIS_DEFAULT_BASELINE_DAYS = 28;

/** Most day rows listed (newest first). */
export const RECOVERY_ANALYSIS_MAX_DAY_ROWS = 31;

/** Scored recoveries in the window needed for status "available". */
export const RECOVERY_ANALYSIS_MIN_RECOVERIES = 3;

/** Values a metric summary needs before its statistics are reported. */
export const RECOVERY_SUMMARY_MIN_SAMPLES = 3;

/** Scored recoveries needed before zone percentages are reported. */
export const RECOVERY_ZONE_PCT_MIN_SAMPLES = 3;

/** Local days in the rolling ln(RMSSD) window (ending on the day). */
export const HRV_LN_WINDOW_DAYS = 7;

/** Non-calibrating HRV values the rolling ln(RMSSD) window needs. */
export const HRV_LN_MIN_VALUES = 5;

/** Non-calibrating recoveries a weekday needs before its values are reported. */
export const WEEKDAY_MIN_SAMPLES = 4;

/** |robust z| at or above which a value is flagged above or below its baseline. */
export const DEVIATION_Z_THRESHOLD = 2;

/** Flagged metrics that make a day a concurrent-deviation day. */
export const CONCURRENT_MIN_METRICS = 2;

/** Baseline values a deviation needs (as get_baselines). */
export { BASELINE_MIN_SAMPLES };

export const RECOVERY_METRICS = [
  "recovery",
  "hrv",
  "rhr",
  "spo2",
  "skin_temp",
  "respiratory_rate",
] as const;
export type RecoveryMetric = (typeof RECOVERY_METRICS)[number];

const UNITS: Record<RecoveryMetric, string> = {
  recovery: "%",
  hrv: "ms",
  rhr: "bpm",
  spo2: "%",
  skin_temp: "°C",
  respiratory_rate: "breaths/min",
};

const DIGITS: Record<RecoveryMetric, number> = {
  recovery: 1,
  hrv: 1,
  rhr: 1,
  spo2: 1,
  skin_temp: 2,
  respiratory_rate: 2,
};

export const WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const recoveryAnalysisInputSchema = z.object({
  days: z
    .number()
    .int()
    .min(7)
    .max(90)
    .optional()
    .describe("Local days analysed, ending today (7-90). Default: 30."),
  baseline_days: z
    .number()
    .int()
    .min(14)
    .max(60)
    .optional()
    .describe(
      "Local days before each day that form its personal baseline (14-60). Default: 28. A deviation needs 14 non-calibrating values in it."
    ),
  include_days: z
    .boolean()
    .optional()
    .describe(`List one row per day (newest ${RECOVERY_ANALYSIS_MAX_DAY_ROWS}). Default: true.`),
});

const directionSchema = z.enum(["above", "below", "within"]);

const deviationSchema = z
  .object({
    delta: z.number().describe("Value minus baseline median, in the metric's unit"),
    delta_pct: z.number().nullable().describe("HRV only: delta as a percentage of the median"),
    robust_z: z
      .number()
      .nullable()
      .describe("(value − median) / (1.4826 × MAD); HRV on ln values; null when MAD is 0"),
    baseline_median: z.number(),
    baseline_n: z.number().int(),
    direction: directionSchema
      .nullable()
      .describe("above/below when |robust_z| >= 2, else within; null without robust_z"),
    constant_baseline: z.boolean().describe("The baseline values have no spread (MAD 0)"),
  })
  .nullable();

const deviationsSchema = z.object({
  recovery: deviationSchema,
  hrv: deviationSchema,
  rhr: deviationSchema,
  spo2: deviationSchema,
  skin_temp: deviationSchema,
  respiratory_rate: deviationSchema,
});

const metricEnum = z.enum(RECOVERY_METRICS);

const dayRowSchema = z.object({
  date: z.string(),
  recovery_score: z.number(),
  zone: z.enum(["green", "yellow", "red"]),
  calibrating: z.boolean(),
  hrv_ms: z.number(),
  rhr_bpm: z.number(),
  spo2_pct: z.number().nullable(),
  skin_temp_c: z.number().nullable(),
  respiratory_rate: z.number().nullable().describe("From the sleep the recovery was scored for"),
  hrv_ln_7d_mean: z.number().nullable(),
  hrv_ln_7d_cv_pct: z.number().nullable(),
  deviations: deviationsSchema.describe(
    "Per metric; null below 14 baseline values, on calibrating days, or without a value"
  ),
  unusual_metrics: z.array(z.object({ metric: metricEnum, direction: z.enum(["above", "below"]) })),
});

const metricSummarySchema = z.object({
  n: z.number().int(),
  mean: z.number().nullable(),
  median: z.number().nullable(),
  sd: z.number().nullable().describe("Sample standard deviation"),
  unit: z.string(),
  status: z
    .enum(["available", "insufficient_data", "not_reported"])
    .describe("not_reported: WHOOP reported no value on any scored day"),
});

const zoneCountsSchema = z.object({
  green: z.number().int(),
  yellow: z.number().int(),
  red: z.number().int(),
});
const zonePctSchema = z.object({
  green: z.number().nullable(),
  yellow: z.number().nullable(),
  red: z.number().nullable(),
});

export const recoveryAnalysisOutputSchema = z.object({
  period: z.object({ start: z.string(), end: z.string() }),
  status: z
    .enum(["available", "insufficient_data", "unavailable"])
    .describe(
      "available: at least 3 scored recoveries in the window. insufficient_data: fewer. unavailable: recoveries could not be read."
    ),
  recoveries_analyzed: z
    .number()
    .int()
    .describe("Scored recoveries in the window, calibrating included"),
  baseline: z.object({
    required_samples: z.number().int(),
    window_days: z.number().int(),
    calibrating_excluded: z.number().int(),
  }),
  zones: z
    .object({
      n: z.number().int().describe("Scored recoveries in the window, calibrating included"),
      counts: zoneCountsSchema,
      pct: zonePctSchema.describe("Percent of n; null below 3 scored recoveries"),
      calibrating_by_zone: zoneCountsSchema.describe(
        "Of counts, recoveries WHOOP flagged as calibrating"
      ),
    })
    .describe("WHOOP recovery zones: green 67-100, yellow 34-66, red 0-33"),
  summary: z.object({
    recovery: metricSummarySchema,
    hrv: metricSummarySchema,
    rhr: metricSummarySchema,
    spo2: metricSummarySchema,
    skin_temp: metricSummarySchema,
    respiratory_rate: metricSummarySchema,
  }),
  hrv_ln_7d: z.object({
    window_days: z.number().int(),
    min_values: z.number().int(),
    latest_date: z
      .string()
      .nullable()
      .describe("Newest day in the window whose 7-day window has enough values"),
    latest_mean: z.number().nullable(),
    latest_cv_pct: z.number().nullable(),
    median_cv_pct: z.number().nullable(),
    n_days: z.number().int().describe("Days in the window with a value"),
  }),
  by_weekday: z.array(
    z.object({
      weekday: z.enum(WEEKDAYS),
      n: z.number().int(),
      recovery_mean: z.number().nullable(),
      hrv_median: z.number().nullable(),
      rhr_mean: z.number().nullable(),
    })
  ),
  concurrent_deviation_days: z
    .array(z.object({ date: z.string(), metrics: z.array(metricEnum) }))
    .describe("Days in the whole window with at least 2 metrics at |robust_z| >= 2"),
  days: z.array(dayRowSchema).max(RECOVERY_ANALYSIS_MAX_DAY_ROWS),
  output_capped: z.boolean(),
  days_omitted: z
    .number()
    .int()
    .describe("Days in the window not listed in days (all of them when include_days is false)"),
  excluded: z.object({
    pending: z.number().int(),
    unscorable: z.number().int(),
    missing_join: z.number().int(),
    duplicate_day: z.number().int(),
    invalid: z.number().int(),
  }),
  truncated: z.boolean(),
  notes: z.array(z.string()),
  warnings: z.array(z.string()),
  disclaimer: z.string(),
  data_quality: dataQualitySchema,
});
export type RecoveryAnalysisReport = z.infer<typeof recoveryAnalysisOutputSchema>;
type Deviation = NonNullable<z.infer<typeof deviationSchema>>;
type DayRow = z.infer<typeof dayRowSchema>;

// ---------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------

/** One scored recovery placed on its local day. */
export interface RecoveryDay {
  day: string;
  recovery: Recovery;
  calibrating: boolean;
  values: Record<RecoveryMetric, number | null>;
}

interface Placed {
  recovery: Recovery;
  sleep: Sleep | null;
  cycle: Cycle | null;
}

/** The recovery kept for a day: the most recently updated, then the later cycle. */
function preferRecovery(candidate: Recovery, current: Recovery): boolean {
  if (isNewer(candidate, current)) return true;
  if (isNewer(current, candidate)) return false;
  return candidate.cycle_id > current.cycle_id;
}

function valuesOf(recovery: Recovery, sleep: Sleep | null): Record<RecoveryMetric, number | null> {
  const score = recovery.score!;
  const sleepScored = sleep !== null && sleep.score_state === "SCORED" && Boolean(sleep.score);
  return {
    recovery: score.recovery_score,
    hrv: score.hrv_rmssd_milli,
    rhr: score.resting_heart_rate,
    spo2: score.spo2_percentage ?? null,
    skin_temp: score.skin_temp_celsius ?? null,
    respiratory_rate: sleepScored ? (sleep.score?.respiratory_rate ?? null) : null,
  };
}

/**
 * Values of `metric` from the `baselineDays` local days strictly before `day`:
 * non-calibrating recoveries only, except respiratory rate.
 */
export function baselineValues(
  metric: RecoveryMetric,
  day: string,
  days: readonly RecoveryDay[],
  baselineDays: number
): number[] {
  const from = addDays(day, -baselineDays);
  const values: number[] = [];
  for (const item of days) {
    if (item.day < from || item.day >= day) continue;
    if (item.calibrating && metric !== "respiratory_rate") continue;
    const value = item.values[metric];
    if (value !== null) values.push(value);
  }
  return values;
}

/** The deviation of `value` from its baseline; null below BASELINE_MIN_SAMPLES values. */
export function deviationFrom(
  metric: RecoveryMetric,
  value: number,
  reference: readonly number[]
): Deviation | null {
  if (reference.length < BASELINE_MIN_SAMPLES) return null;
  const baselineMedian = median([...reference]);
  let z: number | null;
  let mad: number | null;
  if (metric === "hrv") {
    const logs = reference.filter((item) => item > 0).map((item) => Math.log(item));
    mad = medianAbsoluteDeviation(logs);
    z = value > 0 && logs.length > 0 ? robustZ(Math.log(value), logs) : null;
  } else {
    mad = medianAbsoluteDeviation(reference);
    z = robustZ(value, reference);
  }
  const delta = value - baselineMedian;
  return {
    delta: roundTo(delta, DIGITS[metric] + 1),
    delta_pct:
      metric === "hrv" && baselineMedian > 0 ? roundTo((100 * delta) / baselineMedian, 1) : null,
    robust_z: roundTo(z, 2),
    baseline_median: roundTo(baselineMedian, DIGITS[metric] + 1),
    baseline_n: reference.length,
    direction:
      z === null
        ? null
        : z >= DEVIATION_Z_THRESHOLD
          ? "above"
          : z <= -DEVIATION_Z_THRESHOLD
            ? "below"
            : "within",
    constant_baseline: mad === 0,
  };
}

/**
 * Mean and coefficient of variation (sample SD / mean × 100) of ln(RMSSD) over
 * the HRV_LN_WINDOW_DAYS local days ending on `day`, from non-calibrating
 * recoveries; null with fewer than HRV_LN_MIN_VALUES values.
 */
export function hrvLnWindow(
  day: string,
  days: readonly RecoveryDay[]
): { mean: number | null; cv_pct: number | null; n: number } {
  const from = addDays(day, -(HRV_LN_WINDOW_DAYS - 1));
  const logs: number[] = [];
  for (const item of days) {
    if (item.day < from || item.day > day || item.calibrating) continue;
    const hrv = item.values.hrv;
    if (hrv !== null && hrv > 0) logs.push(Math.log(hrv));
  }
  if (logs.length < HRV_LN_MIN_VALUES) return { mean: null, cv_pct: null, n: logs.length };
  const average = mean(logs);
  const sd = sampleStandardDeviation(logs);
  return {
    mean: average,
    cv_pct: sd !== null && average > 0 ? (100 * sd) / average : null,
    n: logs.length,
  };
}

function weekdayOf(day: string): (typeof WEEKDAYS)[number] {
  return WEEKDAYS[(new Date(`${day}T00:00:00.000Z`).getUTCDay() + 6) % 7]!;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

function unreadable(quality: SourceQuality): boolean {
  return quality.status === "fetch_failed" || quality.status === "invalid";
}

export async function runRecoveryAnalysis(
  args: z.infer<typeof recoveryAnalysisInputSchema>,
  ctx: ToolContext
): Promise<RecoveryAnalysisReport> {
  const now = ctx.now();
  const nowMs = now.getTime();
  const days = args.days ?? RECOVERY_ANALYSIS_DEFAULT_DAYS;
  const baselineDays = args.baseline_days ?? RECOVERY_ANALYSIS_DEFAULT_BASELINE_DAYS;
  const includeDays = args.include_days ?? true;
  const offsetInfo = await resolveUserUtcOffsetInfo(ctx.client);
  const utcOffset = offsetInfo.offset;
  const today = localDay(now.toISOString(), utcOffset);
  const firstDay = addDays(today, -(days - 1));
  const lastDay = today;
  const loadFirstDay = addDays(firstDay, -baselineDays);
  const range = fetchRangeForDays(loadFirstDay, lastDay, utcOffset, nowMs);
  const period = {
    start: new Date(range.startMs).toISOString(),
    end: new Date(range.endMs).toISOString(),
  };

  const budget = createHistoryBudget({ deadlineMs: ctx.startedAtMs + HISTORY_DEADLINE_MS });
  const options = { budget, now: (): Date => ctx.now(), cache: ctx.historyCache };
  const [recovery, cycle, sleep] = await Promise.all([
    loadHistory(ctx.client, ENDPOINT_RECOVERY, period, recoveryRecordSchema, options),
    loadHistory(ctx.client, ENDPOINT_CYCLE, period, cycleRecordSchema, options),
    loadHistory(ctx.client, ENDPOINT_SLEEP, period, sleepRecordSchema, options),
  ]);
  if (recovery.quality.status === "fetch_failed") {
    throw mostRelevantError(
      [recovery, cycle, sleep]
        .filter((source) => source.quality.status === "fetch_failed")
        .map((source) => source.error)
    );
  }
  const recoveriesReadable = recovery.quality.status !== "invalid";
  const inAnalysis = (day: string): boolean => day >= firstDay && day <= lastDay;
  const inRange = (day: string): boolean => day >= loadFirstDay && day <= lastDay;

  // --- Place recoveries on days ----------------------------------------------------
  const sleepById = new Map<string, Sleep>();
  for (const record of sleep.records) sleepById.set(record.id, record);
  const cycleById = new Map<number, Cycle>();
  for (const record of cycle.records) {
    const current = cycleById.get(record.id);
    if (!current || isNewer(record, current)) cycleById.set(record.id, record);
  }
  const placed = new Map<string, Placed>();
  let missingJoin = 0;
  let duplicateDay = 0;
  for (const record of recovery.records) {
    const joinedSleep = sleepById.get(record.sleep_id) ?? null;
    const joinedCycle = cycleById.get(record.cycle_id) ?? null;
    const day = joinedSleep
      ? localDay(joinedSleep.end, joinedSleep.timezone_offset)
      : joinedCycle
        ? cycleDay(joinedCycle)
        : null;
    if (day === null) {
      if (inAnalysis(localDay(record.created_at, utcOffset))) {
        missingJoin += 1;
        exclude(recovery.quality, "missing_join");
      }
      continue;
    }
    if (!inRange(day)) continue;
    const current = placed.get(day);
    if (current) {
      if (inAnalysis(day)) {
        duplicateDay += 1;
        exclude(recovery.quality, "duplicate_day");
      }
      if (!preferRecovery(record, current.recovery)) continue;
    }
    placed.set(day, {
      recovery: record,
      sleep: joinedSleep,
      cycle: joinedSleep ? null : joinedCycle,
    });
  }

  const allDays: RecoveryDay[] = [];
  let pending = 0;
  let unscorable = 0;
  const usedSleeps: Sleep[] = [];
  const usedCycles: Cycle[] = [];
  for (const [day, item] of [...placed.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    const scored = item.recovery.score_state === "SCORED" && Boolean(item.recovery.score);
    if (!scored) {
      if (inAnalysis(day)) {
        if (item.recovery.score_state === "PENDING_SCORE") {
          pending += 1;
          exclude(recovery.quality, "pending");
        } else {
          unscorable += 1;
          exclude(recovery.quality, "unscored");
        }
      }
      continue;
    }
    if (item.sleep) usedSleeps.push(item.sleep);
    if (item.cycle) usedCycles.push(item.cycle);
    allDays.push({
      day,
      recovery: item.recovery,
      calibrating: item.recovery.score!.user_calibrating,
      values: valuesOf(item.recovery, item.sleep),
    });
  }
  const analysisDays = allDays.filter((item) => inAnalysis(item.day));
  const status = !recoveriesReadable
    ? "unavailable"
    : analysisDays.length >= RECOVERY_ANALYSIS_MIN_RECOVERIES
      ? "available"
      : "insufficient_data";

  // --- Zones ---------------------------------------------------------------------------
  const zoneCounts = {
    green: { count: 0, calibrating: 0 },
    yellow: { count: 0, calibrating: 0 },
    red: { count: 0, calibrating: 0 },
  };
  for (const item of analysisDays) {
    const zone = zoneCounts[recoveryZone(item.values.recovery!)];
    zone.count += 1;
    if (item.calibrating) zone.calibrating += 1;
  }
  const zonePct = (count: number): number | null =>
    analysisDays.length >= RECOVERY_ZONE_PCT_MIN_SAMPLES
      ? roundTo((100 * count) / analysisDays.length, 1)
      : null;
  const zones = {
    n: analysisDays.length,
    counts: {
      green: zoneCounts.green.count,
      yellow: zoneCounts.yellow.count,
      red: zoneCounts.red.count,
    },
    pct: {
      green: zonePct(zoneCounts.green.count),
      yellow: zonePct(zoneCounts.yellow.count),
      red: zonePct(zoneCounts.red.count),
    },
    calibrating_by_zone: {
      green: zoneCounts.green.calibrating,
      yellow: zoneCounts.yellow.calibrating,
      red: zoneCounts.red.calibrating,
    },
  };

  // --- Summaries ---------------------------------------------------------------------
  const summaryOf = (metric: RecoveryMetric): z.infer<typeof metricSummarySchema> => {
    const values = analysisDays.flatMap((item) =>
      item.values[metric] === null ? [] : [item.values[metric]]
    );
    const n = values.length;
    const available = n >= RECOVERY_SUMMARY_MIN_SAMPLES;
    return {
      n,
      mean: available ? roundTo(mean(values), DIGITS[metric]) : null,
      median: available ? roundTo(median(values), DIGITS[metric]) : null,
      sd: available ? roundTo(sampleStandardDeviation(values), DIGITS[metric] + 1) : null,
      unit: UNITS[metric],
      status: available
        ? "available"
        : n === 0 && analysisDays.length > 0
          ? "not_reported"
          : "insufficient_data",
    };
  };
  const summary = {
    recovery: summaryOf("recovery"),
    hrv: summaryOf("hrv"),
    rhr: summaryOf("rhr"),
    spo2: summaryOf("spo2"),
    skin_temp: summaryOf("skin_temp"),
    respiratory_rate: summaryOf("respiratory_rate"),
  };

  // --- Per day: ln(RMSSD) window and deviations ------------------------------------------
  interface Evaluated {
    item: RecoveryDay;
    ln: ReturnType<typeof hrvLnWindow>;
    deviations: Record<RecoveryMetric, Deviation | null>;
    baselineN: Record<RecoveryMetric, number>;
    flagged: Array<{ metric: RecoveryMetric; direction: "above" | "below" }>;
  }
  const evaluated: Evaluated[] = analysisDays.map((item) => {
    const deviations = {} as Record<RecoveryMetric, Deviation | null>;
    const baselineN = {} as Record<RecoveryMetric, number>;
    const flagged: Evaluated["flagged"] = [];
    for (const metric of RECOVERY_METRICS) {
      const reference = baselineValues(metric, item.day, allDays, baselineDays);
      baselineN[metric] = reference.length;
      const value = item.values[metric];
      // Calibrating days get no deviations, except respiratory rate (a sleep metric
      // that WHOOP's recovery calibration does not affect).
      const deviation =
        value === null || (item.calibrating && metric !== "respiratory_rate")
          ? null
          : deviationFrom(metric, value, reference);
      deviations[metric] = deviation;
      if (deviation?.direction === "above" || deviation?.direction === "below")
        flagged.push({ metric, direction: deviation.direction });
    }
    return { item, ln: hrvLnWindow(item.day, allDays), deviations, baselineN, flagged };
  });

  const lnValues = evaluated.filter((entry) => entry.ln.mean !== null);
  const latestLn = lnValues[lnValues.length - 1];
  const cvValues = lnValues.flatMap((entry) => (entry.ln.cv_pct === null ? [] : [entry.ln.cv_pct]));
  const hrvLn7d = {
    window_days: HRV_LN_WINDOW_DAYS,
    min_values: HRV_LN_MIN_VALUES,
    latest_date: latestLn?.item.day ?? null,
    latest_mean: roundTo(latestLn?.ln.mean ?? null, 3),
    latest_cv_pct: roundTo(latestLn?.ln.cv_pct ?? null, 2),
    median_cv_pct: cvValues.length > 0 ? roundTo(median(cvValues), 2) : null,
    n_days: lnValues.length,
  };

  // --- Weekdays ------------------------------------------------------------------------
  const byWeekday = WEEKDAYS.map((weekday) => {
    const items = analysisDays.filter(
      (item) => !item.calibrating && weekdayOf(item.day) === weekday
    );
    const enough = items.length >= WEEKDAY_MIN_SAMPLES;
    return {
      weekday,
      n: items.length,
      recovery_mean: enough ? roundTo(mean(items.map((item) => item.values.recovery!)), 1) : null,
      hrv_median: enough ? roundTo(median(items.map((item) => item.values.hrv!)), 1) : null,
      rhr_mean: enough ? roundTo(mean(items.map((item) => item.values.rhr!)), 1) : null,
    };
  });

  // --- Rows ---------------------------------------------------------------------------
  const newestFirst = [...evaluated].reverse();
  const concurrent = newestFirst
    .filter((entry) => entry.flagged.length >= CONCURRENT_MIN_METRICS)
    .map((entry) => ({ date: entry.item.day, metrics: entry.flagged.map((flag) => flag.metric) }));
  const toRow = (entry: Evaluated): DayRow => {
    const values = entry.item.values;
    return {
      date: entry.item.day,
      recovery_score: values.recovery!,
      zone: recoveryZone(values.recovery!),
      calibrating: entry.item.calibrating,
      hrv_ms: roundTo(values.hrv!, 1),
      rhr_bpm: roundTo(values.rhr!, 1),
      spo2_pct: roundTo(values.spo2, 1),
      skin_temp_c: roundTo(values.skin_temp, 2),
      respiratory_rate: roundTo(values.respiratory_rate, 2),
      hrv_ln_7d_mean: roundTo(entry.ln.mean, 3),
      hrv_ln_7d_cv_pct: roundTo(entry.ln.cv_pct, 2),
      deviations: entry.deviations,
      unusual_metrics: entry.flagged,
    };
  };
  const rows = includeDays ? newestFirst.slice(0, RECOVERY_ANALYSIS_MAX_DAY_ROWS).map(toRow) : [];
  const outputCapped = includeDays && newestFirst.length > RECOVERY_ANALYSIS_MAX_DAY_ROWS;

  // --- Quality ------------------------------------------------------------------------
  const calibratingExcluded = allDays.filter((item) => item.calibrating).length;
  finishQuality(
    recovery.quality,
    analysisDays.map((item) => item.recovery)
  );
  finishQuality(sleep.quality, usedSleeps);
  finishQuality(cycle.quality, usedCycles);
  // Sleeps and cycles only place recoveries on days; loaded but unused is not missing.
  for (const source of [sleep, cycle])
    if (
      source.quality.records_used === 0 &&
      source.records.length > 0 &&
      source.quality.status === "missing"
    )
      source.quality.status = "available";
  const invalid = recovery.quality.exclusions.invalid ?? 0;
  const truncated = [recovery, cycle, sleep].some((source) => source.quality.truncated);

  // --- Notes --------------------------------------------------------------------------
  const notes: string[] = [];
  const warnings: string[] = [];
  const newestScored = allDays[allDays.length - 1];
  if (newestScored?.calibrating)
    notes.push(
      "WHOOP is still calibrating: the newest scored recovery is flagged calibrating, so its scores are provisional. Calibrating recoveries are counted in zones (zones.calibrating_by_zone) and summaries, but not in baselines, deviations (respiratory rate aside), hrv_ln_7d or weekday patterns."
    );
  if (status === "unavailable")
    notes.push(
      "Recovery data could not be read: WHOOP returned data in an unexpected format, so nothing was analysed. This does not mean no recovery was recorded."
    );
  else if (status === "insufficient_data")
    notes.push(
      `Not enough data yet: ${analysisDays.length} of ${RECOVERY_ANALYSIS_MIN_RECOVERIES} required scored recoveries in the last ${days} days.`
    );
  if (analysisDays.length > 0 && analysisDays.length < RECOVERY_ZONE_PCT_MIN_SAMPLES)
    notes.push(
      `Zone percentages need ${RECOVERY_ZONE_PCT_MIN_SAMPLES} scored recoveries (${analysisDays.length} of ${RECOVERY_ZONE_PCT_MIN_SAMPLES}); counts are shown.`
    );
  // One note per sample size, naming every metric summary below the minimum.
  const thinSummaries = new Map<number, RecoveryMetric[]>();
  for (const metric of RECOVERY_METRICS) {
    const item = summary[metric];
    if (item.status === "insufficient_data" && analysisDays.length > 0)
      thinSummaries.set(item.n, [...(thinSummaries.get(item.n) ?? []), metric]);
    else if (item.status === "not_reported")
      notes.push(`${metric} summary: WHOOP reported no value on the scored days (not_reported).`);
  }
  for (const [n, metrics] of thinSummaries)
    notes.push(
      `Summaries of ${metrics.join(", ")}: ${n} of ${RECOVERY_SUMMARY_MIN_SAMPLES} required values, so their statistics are null.`
    );
  const latest = evaluated[evaluated.length - 1];
  const nonCalibrating = evaluated.filter((entry) => !entry.item.calibrating);
  const thinBaseline = nonCalibrating.filter(
    (entry) => entry.baselineN.hrv < BASELINE_MIN_SAMPLES
  ).length;
  if (latest && (thinBaseline > 0 || latest.baselineN.hrv < BASELINE_MIN_SAMPLES)) {
    const thin =
      nonCalibrating.length > 0
        ? ` ${thinBaseline} of ${plural(nonCalibrating.length, "non-calibrating day")} in the window ${thinBaseline === 1 ? "has" : "have"} fewer, so ${thinBaseline === 1 ? "its" : "their"} deviations are null.`
        : "";
    notes.push(
      `Deviations need a baseline of ${BASELINE_MIN_SAMPLES} values from the ${baselineDays} local days before each day (calibrating recoveries excluded, except for respiratory rate).${thin} The latest day has ${latest.baselineN.hrv} of ${BASELINE_MIN_SAMPLES}, calibrating excluded.`
    );
  }
  const calibratingInWindow = evaluated.length - nonCalibrating.length;
  if (calibratingInWindow > 0)
    notes.push(
      `${plural(calibratingInWindow, "calibrating day")} in the window ${calibratingInWindow === 1 ? "has" : "have"} no deviations except respiratory rate; ${plural(calibratingExcluded, "calibrating recovery", "calibrating recoveries")} read (window and baseline days) ${calibratingExcluded === 1 ? "is" : "are"} excluded from baselines.`
    );
  const constant = evaluated.reduce(
    (count, entry) =>
      count +
      RECOVERY_METRICS.filter((metric) => entry.deviations[metric]?.constant_baseline === true)
        .length,
    0
  );
  if (constant > 0)
    notes.push(
      `constant_baseline: for ${plural(constant, "day-metric pair")} the baseline values have no spread (median absolute deviation 0), so robust_z and direction are null.`
    );
  if (evaluated.some((entry) => RECOVERY_METRICS.some((metric) => entry.deviations[metric])))
    notes.push(
      "unusual_metrics and concurrent_deviation_days use |robust_z| >= 2 against the personal baseline; that threshold flags about 5% of days per metric by chance, so a flag describes an unusual value, not what it means."
    );
  notes.push(
    `hrv_ln_7d is the mean and coefficient of variation (sample SD / mean × 100) of ln(RMSSD) over the ${HRV_LN_WINDOW_DAYS} local days ending each day, from at least ${HRV_LN_MIN_VALUES} non-calibrating values; it is descriptive and has no thresholds.`
  );
  const maxWeekdayN = Math.max(...byWeekday.map((item) => item.n));
  notes.push(
    maxWeekdayN === 0
      ? `Weekday patterns over a few weeks are weak, and there are no non-calibrating values for any weekday here yet; values are null below ${WEEKDAY_MIN_SAMPLES}.`
      : `Weekday patterns over a few weeks are weak: each weekday has at most ${plural(maxWeekdayN, "non-calibrating value")} here, and values are null below ${WEEKDAY_MIN_SAMPLES}.`
  );
  if (pending)
    notes.push(
      `${plural(pending, "recovery", "recoveries")} ${pending === 1 ? "is" : "are"} still being scored by WHOOP and not counted yet.`
    );
  if (unscorable)
    notes.push(
      `${plural(unscorable, "recovery", "recoveries")} could not be scored by WHOOP and ${unscorable === 1 ? "is" : "are"} not counted.`
    );
  if (missingJoin)
    notes.push(
      `${plural(missingJoin, "recovery", "recoveries")} could not be matched to a sleep or cycle and ${missingJoin === 1 ? "was" : "were"} not placed on a day.`
    );
  if (duplicateDay)
    notes.push(
      `${plural(duplicateDay, "additional recovery", "additional recoveries")} fell on a day that already had one; the most recently updated recovery is used.`
    );
  if (invalid && recoveriesReadable)
    notes.push(
      `${plural(invalid, "recovery record")} did not match the expected format and ${invalid === 1 ? "was" : "were"} skipped.`
    );
  if (outputCapped)
    notes.push(
      `Only the newest ${RECOVERY_ANALYSIS_MAX_DAY_ROWS} of ${newestFirst.length} days are listed (days_omitted ${newestFirst.length - RECOVERY_ANALYSIS_MAX_DAY_ROWS}); all days count toward zones, summaries and concurrent_deviation_days.`
    );
  const windowStartMs = localMidnightMs(loadFirstDay, utcOffset);
  notes.push(...historyTruncationNotes("recovery", recovery, windowStartMs, utcOffset));
  notes.push(...historyTruncationNotes("sleep", sleep, windowStartMs, utcOffset));
  notes.push(...historyTruncationNotes("cycle", cycle, windowStartMs, utcOffset));
  if (unreadable(sleep.quality))
    warnings.push(
      "Sleep data could not be read, so recoveries are placed on their cycle's day and respiratory rate is null."
    );
  if (unreadable(cycle.quality))
    warnings.push(
      "Cycle data could not be read, so recoveries without a matching sleep could not be placed on a day."
    );

  // --- Output -----------------------------------------------------------------------
  const reportedPeriod = {
    start: formatLocalTimestamp(localMidnightMs(firstDay, utcOffset), utcOffset),
    end: formatLocalTimestamp(nowMs, utcOffset),
  };
  const oldestDay = analysisDays[0]?.day;
  const newestDay = analysisDays[analysisDays.length - 1]?.day;
  return {
    period: reportedPeriod,
    status,
    recoveries_analyzed: analysisDays.length,
    baseline: {
      required_samples: BASELINE_MIN_SAMPLES,
      window_days: baselineDays,
      calibrating_excluded: calibratingExcluded,
    },
    zones,
    summary,
    hrv_ln_7d: hrvLn7d,
    by_weekday: byWeekday,
    concurrent_deviation_days: concurrent,
    days: rows,
    output_capped: outputCapped,
    days_omitted: newestFirst.length - rows.length,
    excluded: {
      pending,
      unscorable,
      missing_join: missingJoin,
      duplicate_day: duplicateDay,
      invalid,
    },
    truncated,
    notes: withOffsetNote(notes, offsetInfo.fallback),
    warnings,
    disclaimer: DISCLAIMER,
    data_quality: {
      evaluated_at: formatLocalTimestamp(nowMs, utcOffset),
      requested_period: reportedPeriod,
      observed_period:
        oldestDay && newestDay
          ? {
              start: formatLocalTimestamp(localMidnightMs(oldestDay, utcOffset), utcOffset),
              end: formatLocalTimestamp(
                Math.min(localMidnightMs(newestDay, utcOffset) + DAY_MS - 1, nowMs),
                utcOffset
              ),
            }
          : null,
      sources: { recovery: recovery.quality, sleep: sleep.quality, cycle: cycle.quality },
      method_version: "recovery-analysis-1",
      limitations: [
        ...HISTORY_LIMITATIONS,
        "Skin temperature depends on ambient conditions (room temperature, bedding), so its deviations can reflect the environment.",
        "A recovery is dated by the wake day of the sleep it was scored for, else by its cycle's day (as get_baselines); one per day, the most recently updated.",
        "Deviations are robust z-scores against the personal baseline (median, 1.4826 × MAD; HRV on ln values); they are descriptive, and no clinical cut-offs are applied to any metric.",
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Definition
// ---------------------------------------------------------------------------

export const getRecoveryAnalysisTool = defineTool({
  name: "get_recovery_analysis",
  annotations: { readOnlyHint: true },
  standard: {
    title: "Recovery analysis",
    description:
      "Describes recoveries over the last `days` local days (default 30): recovery zone counts (calibrating shown per zone), summaries of recovery, HRV, resting heart rate, SpO2, skin temperature and respiratory rate, the 7-day ln(RMSSD) mean and coefficient of variation, weekday patterns, and per-day rows (newest 31) with deviations from a personal baseline of the `baseline_days` before each day (default 28; 14 non-calibrating values needed). Deviations are robust z-scores (HRV on ln values); |z| >= 2 is flagged as unusual, which happens on about 5% of days by chance. Days with at least 2 unusual metrics are listed. Calibrating recoveries are excluded from baselines. Descriptive only; no clinical thresholds.",
    inputSchema: recoveryAnalysisInputSchema,
    outputSchema: recoveryAnalysisOutputSchema,
    run: runRecoveryAnalysis,
  },
});
