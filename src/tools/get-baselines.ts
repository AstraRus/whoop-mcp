import { z } from "zod";
import type { WhoopClient } from "../api/client.js";
import { ENDPOINT_CYCLE, ENDPOINT_RECOVERY, ENDPOINT_SLEEP } from "../api/endpoints.js";
import {
  cycleRecordSchema,
  recoveryRecordSchema,
  sleepRecordSchema,
} from "../api/record-schemas.js";
import type { Cycle } from "../api/types.js";
import {
  cycleDay,
  dataQualitySchema,
  DAY_MS,
  DISCLAIMER,
  exclude,
  finishQuality,
  formatLocalTimestamp,
  localMidnightMs,
  loadAnalyticsSource,
  mostRelevantError,
  localDay,
  mainSleeps,
  periodSchema,
  asleepHours,
  type SourceQuality,
} from "./analytics-utils.js";
import {
  aggregateEvaluatedAt,
  lastReleasedWeeks,
  roundStep,
  snapWeeks,
} from "./aggregate-window.js";
import { resolveUserUtcOffsetInfo, withOffsetNote } from "./collection-utils.js";
import {
  AGGREGATE_METRIC_STEP,
  aggregateMetric,
  aggregateQualitySources,
  hasLowDataCoverage,
  loadAggregateData,
  NOT_REPORTED_BY_DEVICE,
  releasedWeeksNote,
  withheldWeekNotes,
  type AggregateMetricResult,
  type AnalyticsToolOptions,
  type TrendMetric,
} from "./get-trend.js";
import { LOW_DATA_COVERAGE_FRACTION, stageBreakdown } from "./sleep-metrics.js";
import {
  isConstant,
  mean,
  median,
  percentile,
  percentileRank,
  sampleStandardDeviation,
} from "./stats-utils.js";

/** Earlier observations (besides the most recent one and today) a baseline needs. */
export const BASELINE_MIN_SAMPLES = 14;

/**
 * Days read beyond `baseline_days`: the most recent observation and the current
 * local day are never part of a baseline, so the window reaches back two more
 * days and `baseline_days` earlier days fit in it.
 */
export const BASELINE_EXTRA_DAYS = 2;

/** Week counts an aggregate get_baselines window snaps to */
export const BASELINE_AGGREGATE_WEEKS = [2, 4, 8, 13, 26] as const;

export const baselinesInputSchema = z.object({
  baseline_days: z
    .number()
    .int()
    .min(14)
    .max(180)
    .optional()
    .describe(
      "Earlier days to build baselines from (14-180). Default: 30. The most recent observation and today are not part of a baseline, so the window read reaches 2 days further back (baseline_days + 2 days, ending now). Each baseline needs at least 14 earlier days with data; until then its metric_status explains why (e.g. 'calibrating')."
    ),
});

/** Every baseline metric, in output order */
export const BASELINE_METRICS = [
  "hrv",
  "rhr",
  "respiratory_rate",
  "sleep_hours",
  "recovery_score",
  "spo2",
  "skin_temp",
  "sleep_efficiency",
  "disturbances_per_hour",
  "rem_share",
  "deep_share",
] as const;

export const baselineMetricNameSchema = z.enum(BASELINE_METRICS);
const bandSchema = z.object({
  sample_size: z.number().int(),
  mean: z.number(),
  median: z.number(),
  std_dev: z.number().describe("Sample standard deviation (n-1)"),
  p10: z.number(),
  p25: z.number(),
  p50: z.number(),
  p75: z.number(),
  p90: z.number(),
  latest: z.number().nullable(),
  latest_percentile: z.number().nullable(),
  constant_baseline: z.boolean(),
});
const metricStatusSchema = z.object({
  /**
   * available: band computed. calibrating: WHOOP still flags recoveries as
   * calibrating. insufficient_data: readable, but too few data points.
   * unavailable: a source could not be read. not_reported: WHOOP reported no
   * value on any scored record (e.g. SpO2 and skin temperature need WHOOP 4.0
   * or later).
   */
  status: z.enum(["available", "insufficient_data", "calibrating", "unavailable", "not_reported"]),
  sample_size: z.number().int(),
  required_sample_size: z.number().int(),
  unit: z.string(),
  reason: z.string().nullable(),
});
export const baselinesOutputSchema = z.object({
  period: periodSchema.nullable(),
  metrics: z.record(baselineMetricNameSchema, bandSchema.nullable()),
  metric_status: z.record(baselineMetricNameSchema, metricStatusSchema),
  notes: z.array(z.string()),
  data_quality: dataQualitySchema,
  truncated: z.boolean(),
  disclaimer: z.string(),
});
export type BaselineReport = z.infer<typeof baselinesOutputSchema>;
export type BaselineMetric = z.infer<typeof baselineMetricNameSchema>;
type MetricStatus = z.infer<typeof metricStatusSchema>;
type Observation = { value: number; timestamp: string; offset: string; day: string };

/** A band as aggregate privacy mode reports it: no latest observation, no p10 or p90 */
export interface AggregateBand {
  sample_size: number;
  mean: number;
  median: number;
  std_dev: number;
  p25: number;
  p50: number;
  p75: number;
  constant_baseline: boolean;
}

/** get_baselines in aggregate privacy mode (before projection) */
export interface AggregateBaselineReport extends Omit<BaselineReport, "metrics" | "data_quality"> {
  metrics: Record<BaselineMetric, AggregateBand | null>;
  data_quality: {
    evaluated_at: string;
    requested_period: { start: string; end: string };
    sources: Record<string, unknown>;
    method_version: string;
  };
}

const RECOVERY_METRICS = ["hrv", "rhr", "recovery_score", "spo2", "skin_temp"] as const;

/** The sleep metrics that leave out nights with low data coverage */
const LOW_COVERAGE_BASELINES: readonly BaselineMetric[] = [
  "sleep_efficiency",
  "disturbances_per_hour",
  "rem_share",
  "deep_share",
];

/** Metric order in notes: recovery metrics first, then sleep metrics */
const NOTE_ORDER: readonly BaselineMetric[] = [
  "hrv",
  "rhr",
  "recovery_score",
  "spo2",
  "skin_temp",
  "sleep_hours",
  "respiratory_rate",
  "sleep_efficiency",
  "disturbances_per_hour",
  "rem_share",
  "deep_share",
];

const UNITS: Record<BaselineMetric, string> = {
  hrv: "ms",
  rhr: "bpm",
  recovery_score: "%",
  respiratory_rate: "breaths/min",
  sleep_hours: "hours",
  spo2: "%",
  skin_temp: "°C",
  sleep_efficiency: "%",
  disturbances_per_hour: "per hour asleep",
  rem_share: "% of time asleep",
  deep_share: "% of time asleep",
};

const LABELS: Record<BaselineMetric, string> = {
  hrv: "HRV",
  rhr: "resting heart rate",
  recovery_score: "recovery score",
  respiratory_rate: "respiratory rate",
  sleep_hours: "sleep hours",
  spo2: "SpO2",
  skin_temp: "skin temperature",
  sleep_efficiency: "sleep efficiency",
  disturbances_per_hour: "disturbances per hour",
  rem_share: "REM share",
  deep_share: "deep sleep share",
};

/** The trend metric whose samples an aggregate baseline uses */
const AGGREGATE_METRIC: Record<BaselineMetric, TrendMetric> = {
  hrv: "hrv",
  rhr: "rhr",
  recovery_score: "recovery",
  respiratory_rate: "respiratory_rate",
  sleep_hours: "sleep_duration",
  spo2: "spo2",
  skin_temp: "skin_temp",
  sleep_efficiency: "sleep_efficiency",
  disturbances_per_hour: "disturbances_per_hour",
  rem_share: "rem_share",
  deep_share: "deep_share",
};

function isRecoveryMetric(metric: BaselineMetric): boolean {
  return (RECOVERY_METRICS as readonly BaselineMetric[]).includes(metric);
}

function unreadable(quality: SourceQuality): boolean {
  return quality.status === "invalid" || quality.status === "fetch_failed";
}

function unreadableReason(label: string, quality: SourceQuality): string {
  return `${label} data could not be read (${
    quality.status === "fetch_failed"
      ? "the WHOOP request failed"
      : "WHOOP returned data in an unexpected format"
  }).`;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "a", "a and b", "a, b and c" */
function listText(items: readonly string[]): string {
  return items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * One note per distinct reason, naming every metric that shares it:
 * "Sleep efficiency and REM share: <reason>".
 */
function groupedReasonNotes(
  metrics: readonly BaselineMetric[],
  reasons: Record<BaselineMetric, string | null>
): string[] {
  const groups = new Map<string, BaselineMetric[]>();
  for (const metric of metrics) {
    const reason = reasons[metric];
    if (reason === null) continue;
    const group = groups.get(reason) ?? [];
    group.push(metric);
    groups.set(reason, group);
  }
  return [...groups].map(
    ([reason, group]) => `${capitalize(listText(group.map((metric) => LABELS[metric])))}: ${reason}`
  );
}

/**
 * The local days the baselines were built from: local midnight of the earliest
 * day to the last millisecond of the latest day, each in its record's offset.
 */
function observedDays(observations: Observation[]): { start: string; end: string } | null {
  if (!observations.length) return null;
  const byDay = [...observations].sort((left, right) => left.day.localeCompare(right.day));
  const first = byDay[0]!;
  const last = byDay[byDay.length - 1]!;
  return {
    start: formatLocalTimestamp(localMidnightMs(first.day, first.offset), first.offset),
    end: formatLocalTimestamp(localMidnightMs(last.day, last.offset) + DAY_MS - 1, last.offset),
  };
}

/** Explanatory notes for records a source skipped (safe for aggregate mode: counts only). */
function sourceNotes(
  label: string,
  noun: [singular: string, plural: string],
  quality: SourceQuality
): string[] {
  const notes: string[] = [];
  const invalid = quality.exclusions.invalid ?? 0;
  if (invalid && !unreadable(quality))
    notes.push(
      `${plural(invalid, `${label} record`)} did not match the expected format and ${invalid === 1 ? "was" : "were"} skipped.`
    );
  const pending = quality.exclusions.pending ?? 0;
  if (pending)
    notes.push(
      `${plural(pending, ...noun)} ${pending === 1 ? "is" : "are"} still being scored by WHOOP and not counted yet.`
    );
  const unmatched = quality.exclusions.missing_join ?? 0;
  if (unmatched)
    notes.push(
      `${plural(unmatched, ...noun)} could not be matched to a WHOOP cycle and ${unmatched === 1 ? "was" : "were"} not used.`
    );
  return notes;
}

const LOW_COVERAGE_PERCENT = Math.round(LOW_DATA_COVERAGE_FRACTION * 100);

/**
 * Personal rolling distributions per metric. In aggregate privacy mode
 * (`options.privacyMode`), the baseline covers whole released local weeks
 * instead (see aggregateBaselines).
 */
export async function getBaselines(
  client: WhoopClient,
  params?: z.infer<typeof baselinesInputSchema>,
  now?: Date
): Promise<BaselineReport>;
export async function getBaselines(
  client: WhoopClient,
  params: z.infer<typeof baselinesInputSchema> | undefined,
  now: Date | undefined,
  options: AnalyticsToolOptions
): Promise<BaselineReport | AggregateBaselineReport>;
export async function getBaselines(
  client: WhoopClient,
  params: z.infer<typeof baselinesInputSchema> = {},
  now: Date = new Date(),
  options: AnalyticsToolOptions = {}
): Promise<BaselineReport | AggregateBaselineReport> {
  const { baseline_days = 30 } = baselinesInputSchema.parse(params);
  if (options.privacyMode === "aggregate") return aggregateBaselines(client, baseline_days, now);
  const windowStartMs = now.getTime() - (baseline_days + BASELINE_EXTRA_DAYS) * DAY_MS;
  const period = { start: new Date(windowStartMs).toISOString(), end: now.toISOString() };
  const [recovery, sleep, cycle, offsetInfo] = await Promise.all([
    loadAnalyticsSource(client, ENDPOINT_RECOVERY, period, recoveryRecordSchema),
    loadAnalyticsSource(client, ENDPOINT_SLEEP, period, sleepRecordSchema),
    loadAnalyticsSource(client, ENDPOINT_CYCLE, period, cycleRecordSchema),
    resolveUserUtcOffsetInfo(client),
  ]);
  const utcOffset = offsetInfo.offset;
  if ([recovery, sleep, cycle].every((source) => source.quality.status === "fetch_failed"))
    throw mostRelevantError([recovery.error, sleep.error, cycle.error]);
  const observations = Object.fromEntries(
    BASELINE_METRICS.map((metric) => [metric, [] as Observation[]])
  ) as Record<BaselineMetric, Observation[]>;
  const cycles = new Map(cycle.records.map((record) => [`${record.user_id}:${record.id}`, record]));
  const usedRecoveries: typeof recovery.records = [];
  const seenCycles = new Set<string>();
  // Cycles that placed a scored recovery in the window on its day (calibrating ones included).
  const contextCycles = new Map<string, Cycle>();
  let scoredRecoveries = 0;
  const reportedRecoveryValues = { spo2: 0, skin_temp: 0 };
  // WHOOP's calibration flag on the most recent scored recovery tells whether it is still calibrating.
  let newestScored: { created: number; calibrating: boolean } | null = null;
  for (const record of recovery.records) {
    if (record.score_state !== "SCORED" || !record.score) {
      exclude(recovery.quality, record.score_state === "PENDING_SCORE" ? "pending" : "unscored");
      continue;
    }
    scoredRecoveries += 1;
    if (typeof record.score.spo2_percentage === "number") reportedRecoveryValues.spo2 += 1;
    if (typeof record.score.skin_temp_celsius === "number") reportedRecoveryValues.skin_temp += 1;
    const created = Date.parse(record.created_at);
    if (!newestScored || created > newestScored.created)
      newestScored = { created, calibrating: record.score.user_calibrating };
    const key = `${record.user_id}:${record.cycle_id}`;
    const context = cycles.get(key);
    const contextInWindow =
      context !== undefined &&
      Date.parse(context.start) >= Date.parse(period.start) &&
      Date.parse(context.start) < now.getTime();
    if (context && contextInWindow) contextCycles.set(key, context);
    if (record.score.user_calibrating) {
      exclude(recovery.quality, "calibrating");
      continue;
    }
    if (!context) {
      exclude(recovery.quality, "missing_join");
      continue;
    }
    if (!contextInWindow) {
      exclude(recovery.quality, "outside_window");
      continue;
    }
    if (seenCycles.has(key)) {
      exclude(recovery.quality, "duplicate_cycle");
      continue;
    }
    seenCycles.add(key);
    usedRecoveries.push(record);
    const at = {
      timestamp: context.start,
      offset: context.timezone_offset,
      // A cycle starts at the previous evening's sleep onset; count it toward the day it covers.
      day: cycleDay(context),
    };
    for (const [metric, value] of [
      ["hrv", record.score.hrv_rmssd_milli],
      ["rhr", record.score.resting_heart_rate],
      ["recovery_score", record.score.recovery_score],
      ["spo2", record.score.spo2_percentage],
      ["skin_temp", record.score.skin_temp_celsius],
    ] as const) {
      if (typeof value === "number" && Number.isFinite(value))
        observations[metric].push({ value, ...at });
    }
  }
  const nights = mainSleeps(sleep.records, period, sleep.quality);
  let nightsWithoutRespiratoryRate = 0;
  let nightsWithoutEfficiency = 0;
  let lowCoverageNights = 0;
  let nightsWithoutTimeAsleep = 0;
  let shortNights = 0;
  for (const night of nights) {
    const at = {
      timestamp: night.end,
      offset: night.timezone_offset,
      day: localDay(night.end, night.timezone_offset),
    };
    observations.sleep_hours.push({ value: asleepHours(night), ...at });
    if (typeof night.score?.respiratory_rate === "number")
      observations.respiratory_rate.push({ value: night.score.respiratory_rate, ...at });
    else nightsWithoutRespiratoryRate += 1;
    const efficiency = night.score?.sleep_efficiency_percentage;
    if (typeof efficiency !== "number") nightsWithoutEfficiency += 1;
    if (hasLowDataCoverage(night)) {
      lowCoverageNights += 1;
      continue;
    }
    if (typeof efficiency === "number")
      observations.sleep_efficiency.push({ value: efficiency, ...at });
    const stages = stageBreakdown(night);
    if (stages?.rem_pct_of_asleep != null && stages.sws_pct_of_asleep != null) {
      observations.rem_share.push({ value: stages.rem_pct_of_asleep, ...at });
      observations.deep_share.push({ value: stages.sws_pct_of_asleep, ...at });
    } else nightsWithoutTimeAsleep += 1;
    if (stages?.disturbances_per_hour_asleep != null)
      observations.disturbances_per_hour.push({
        value: stages.disturbances_per_hour_asleep,
        ...at,
      });
    else shortNights += 1;
  }
  const metrics = {} as BaselineReport["metrics"];
  const metricStatus = {} as BaselineReport["metric_status"];
  const usedDays: Observation[] = [];
  const calibrating =
    (recovery.quality.exclusions.calibrating ?? 0) > 0 && !!newestScored?.calibrating;
  const statusFor = (
    metric: BaselineMetric,
    count: number
  ): Omit<MetricStatus, "sample_size" | "unit"> => {
    const required = BASELINE_MIN_SAMPLES;
    const base = { required_sample_size: required };
    if (count >= required) return { ...base, status: "available", reason: null };
    if (isRecoveryMetric(metric)) {
      if (unreadable(recovery.quality))
        return {
          ...base,
          status: "unavailable",
          reason: unreadableReason("Recovery", recovery.quality),
        };
      if (unreadable(cycle.quality))
        return {
          ...base,
          status: "unavailable",
          reason: `${unreadableReason("Cycle", cycle.quality)} Recoveries cannot be matched to their day without it.`,
        };
      if ((metric === "spo2" || metric === "skin_temp") && scoredRecoveries > 0) {
        if (reportedRecoveryValues[metric] === 0)
          return {
            ...base,
            status: "not_reported",
            reason: `WHOOP reported no ${LABELS[metric]} on any of the ${plural(scoredRecoveries, "scored recovery", "scored recoveries")} in this window: ${NOT_REPORTED_BY_DEVICE}.`,
          };
      }
      const calibratingCount = recovery.quality.exclusions.calibrating ?? 0;
      if (calibrating)
        return {
          ...base,
          status: "calibrating",
          reason: `WHOOP is still calibrating, so ${calibratingCount} of ${plural(scoredRecoveries, "scored recovery", "scored recoveries")} so far ${calibratingCount === 1 ? "is" : "are"} not used. Not enough data yet (${count} of ${required} earlier non-calibrating days needed; the most recent day and today are not counted).`,
        };
      const skipped = calibratingCount
        ? ` ${plural(calibratingCount, "earlier calibrating recovery", "earlier calibrating recoveries")} not used.`
        : "";
      return {
        ...base,
        status: "insufficient_data",
        reason: `Not enough data yet (${count} of ${required} earlier scored days needed; the most recent day and today are not counted).${skipped}`,
      };
    }
    if (unreadable(sleep.quality))
      return { ...base, status: "unavailable", reason: unreadableReason("Sleep", sleep.quality) };
    const notReported =
      metric === "respiratory_rate"
        ? nightsWithoutRespiratoryRate
        : metric === "sleep_efficiency"
          ? nightsWithoutEfficiency
          : null;
    if (notReported !== null && nights.length > 0 && notReported === nights.length)
      return {
        ...base,
        status: "not_reported",
        reason: `WHOOP reported no ${LABELS[metric]} on any of the ${plural(nights.length, "scored main sleep")} in this window.`,
      };
    const details: string[] = [];
    if (metric === "respiratory_rate" && nightsWithoutRespiratoryRate)
      details.push(
        ` WHOOP reported no respiratory rate for ${nightsWithoutRespiratoryRate} of ${plural(nights.length, "scored main sleep")}.`
      );
    if (LOW_COVERAGE_BASELINES.includes(metric)) {
      if (lowCoverageNights)
        details.push(
          ` ${plural(lowCoverageNights, "night")} with low data coverage (no strap data for more than ${LOW_COVERAGE_PERCENT}% of time in bed) ${lowCoverageNights === 1 ? "is" : "are"} not used.`
        );
      if (metric === "sleep_efficiency" && nightsWithoutEfficiency)
        details.push(
          ` WHOOP reported no sleep efficiency for ${nightsWithoutEfficiency} of ${plural(nights.length, "scored main sleep")}.`
        );
      if ((metric === "rem_share" || metric === "deep_share") && nightsWithoutTimeAsleep)
        details.push(` ${plural(nightsWithoutTimeAsleep, "night")} had no time asleep.`);
      if (metric === "disturbances_per_hour" && shortNights)
        details.push(
          ` ${plural(shortNights, "night")} with less than 1 hour asleep ${shortNights === 1 ? "has" : "have"} no disturbances per hour.`
        );
    }
    return {
      ...base,
      status: "insufficient_data",
      reason: `Not enough data yet (${plural(nights.length, "scored main sleep")} in this window; ${count} of ${required} earlier ones needed, the most recent night and today are not counted).${details.join("")}`,
    };
  };
  for (const metric of BASELINE_METRICS) {
    const sorted = observations[metric].sort(
      (left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp)
    );
    const latest = sorted[0];
    const historical = sorted
      .slice(1)
      .filter((item) => item.day !== localDay(now.toISOString(), item.offset));
    const values = historical.map((item) => item.value);
    usedDays.push(...historical);
    metricStatus[metric] = {
      ...statusFor(metric, values.length),
      sample_size: values.length,
      unit: UNITS[metric],
    };
    metrics[metric] =
      values.length < BASELINE_MIN_SAMPLES
        ? null
        : {
            sample_size: values.length,
            mean: mean(values),
            median: median(values),
            std_dev: sampleStandardDeviation(values)!,
            p10: percentile(values, 10),
            p25: percentile(values, 25),
            p50: percentile(values, 50),
            p75: percentile(values, 75),
            p90: percentile(values, 90),
            latest: latest?.value ?? null,
            latest_percentile: latest ? percentileRank(values, latest.value) : null,
            constant_baseline: isConstant(values),
          };
  }
  finishQuality(recovery.quality, usedRecoveries);
  finishQuality(sleep.quality, nights);
  // Cycles place recoveries on their days: the source is available when any
  // scored recovery in the window was placed through its cycle.
  finishQuality(cycle.quality, [...contextCycles.values()]);
  const observed = observedDays(usedDays);
  const truncated = [recovery, sleep, cycle].some((source) => source.quality.truncated);
  const partialSources = (
    [
      ["recovery", recovery],
      ["sleep", sleep],
      ["cycle", cycle],
    ] as const
  )
    .filter(([, source]) => source.partialError !== undefined)
    .map(([label]) => label);
  const reasons = Object.fromEntries(
    BASELINE_METRICS.map((metric) => [metric, metricStatus[metric].reason])
  ) as Record<BaselineMetric, string | null>;
  const notes = groupedReasonNotes(NOTE_ORDER, reasons);
  notes.push(
    ...sourceNotes("recovery", ["recovery", "recoveries"], recovery.quality),
    ...sourceNotes("sleep", ["sleep", "sleeps"], sleep.quality),
    ...sourceNotes("cycle", ["cycle", "cycles"], cycle.quality)
  );
  if (partialSources.length)
    notes.push(
      `Partial history: a later page of ${partialSources.join(", ")} data could not be read from WHOOP, so older records in the window were not included. Retry for a complete result.`
    );
  const limitReached = [recovery, sleep, cycle].some(
    (source) => source.quality.truncated && source.partialError === undefined
  );
  if (limitReached)
    notes.push(
      "Partial history: the WHOOP pagination limit was reached, so the oldest records in the window were not read."
    );
  return {
    period: observed,
    metrics,
    metric_status: metricStatus,
    notes: withOffsetNote(notes, offsetInfo.fallback),
    truncated,
    disclaimer: DISCLAIMER,
    data_quality: {
      evaluated_at: now.toISOString(),
      requested_period: {
        start: formatLocalTimestamp(windowStartMs, utcOffset),
        end: formatLocalTimestamp(now.getTime(), utcOffset),
      },
      observed_period: observed,
      sources: { recovery: recovery.quality, sleep: sleep.quality, cycle: cycle.quality },
      method_version: "baselines-3",
      limitations: [
        "Descriptive personal distributions, not population norms or diagnosis.",
        "Latest observation and current local day are excluded from each baseline.",
        "Recoveries WHOOP flags as calibrating are not used for baselines.",
        `Nights with low data coverage (no strap data for more than ${LOW_COVERAGE_PERCENT}% of time in bed) are not used for sleep efficiency, disturbances per hour, REM share or deep sleep share.`,
        ...(truncated ? ["Partial history: not every page in the window was read."] : []),
      ],
    },
  };
}

/**
 * Aggregate privacy mode: baselines over whole released local weeks
 * (baseline_days snapped to 2, 4, 8, 13 or 26 weeks ending at the latest
 * released week). Each metric uses only final weeks with at least
 * AGGREGATE_WEEK_MIN_SAMPLES samples, the same samples every aggregate tool
 * uses; there is no latest observation, and p10 and p90 are left out.
 */
async function aggregateBaselines(
  client: WhoopClient,
  baselineDays: number,
  now: Date
): Promise<AggregateBaselineReport> {
  const { offset, fallback } = await resolveUserUtcOffsetInfo(client);
  const weeks = lastReleasedWeeks(now, offset, snapWeeks(baselineDays, BASELINE_AGGREGATE_WEEKS));
  const data = await loadAggregateData(client, weeks, offset, now);
  const sources = [data.recovery, data.sleep, data.cycle];
  if (sources.every((source) => source.quality.status === "fetch_failed"))
    throw mostRelevantError(sources.map((source) => source.error));

  const results = Object.fromEntries(
    BASELINE_METRICS.map((metric) => [
      metric,
      aggregateMetric(data, AGGREGATE_METRIC[metric], {
        subject: capitalize(LABELS[metric]),
        exclusionNotes: false,
      }),
    ])
  ) as Record<BaselineMetric, AggregateMetricResult>;

  const metrics = {} as Record<BaselineMetric, AggregateBand | null>;
  const metricStatus = {} as BaselineReport["metric_status"];
  const unreadableSource = (
    [
      ["Recovery", data.recovery],
      ["Sleep", data.sleep],
      ["Cycle", data.cycle],
    ] as const
  ).find(([, source]) => unreadable(source.quality));
  for (const metric of BASELINE_METRICS) {
    const result = results[metric];
    const values = result.released.map((sample) => sample.value);
    const step = AGGREGATE_METRIC_STEP[AGGREGATE_METRIC[metric]];
    const round = (value: number): number => roundStep(value, step);
    const count = values.length;
    const required = BASELINE_MIN_SAMPLES;
    let status: MetricStatus["status"];
    let reason: string | null = null;
    if (count >= required) status = "available";
    else if (unreadableSource) {
      status = "unavailable";
      reason = unreadableReason(unreadableSource[0], unreadableSource[1].quality);
    } else if (!data.placementComplete) {
      status = "unavailable";
      reason = "Some WHOOP data for these weeks could not be read completely.";
    } else if (
      (result.exclusions.not_reported ?? 0) > 0 &&
      result.samples.length === 0 &&
      (metric === "spo2" ||
        metric === "skin_temp" ||
        metric === "respiratory_rate" ||
        metric === "sleep_efficiency")
    ) {
      status = "not_reported";
      reason = `WHOOP reported no ${LABELS[metric]} in these weeks${isRecoveryMetric(metric) ? `: ${NOT_REPORTED_BY_DEVICE}` : ""}.`;
    } else if (isRecoveryMetric(metric) && (result.exclusions.calibrating ?? 0) > 0) {
      status = "calibrating";
      reason = `WHOOP flags ${plural(result.exclusions.calibrating ?? 0, "recovery", "recoveries")} in these weeks as calibrating, and calibrating recoveries are not used. Not enough data yet (${count} of ${required} samples in released weeks with at least 3 each).`;
    } else {
      status = "insufficient_data";
      reason = `Not enough data yet (${count} of ${required} samples in released weeks with at least 3 each).`;
    }
    metricStatus[metric] = {
      status,
      sample_size: count,
      required_sample_size: required,
      unit: UNITS[metric],
      reason,
    };
    metrics[metric] =
      count < required
        ? null
        : {
            sample_size: count,
            mean: round(mean(values)),
            median: round(median(values)),
            std_dev: round(sampleStandardDeviation(values)!),
            p25: round(percentile(values, 25)),
            p50: round(percentile(values, 50)),
            p75: round(percentile(values, 75)),
            constant_baseline: isConstant(values),
          };
  }

  const notes: string[] = [releasedWeeksNote(weeks), ...withheldWeekNotes(data)];
  const recoveryExclusions = results.hrv.exclusions;
  if (recoveryExclusions.calibrating)
    notes.push(
      `${plural(recoveryExclusions.calibrating, "recovery", "recoveries")} WHOOP flags as calibrating ${recoveryExclusions.calibrating === 1 ? "is" : "are"} not used in aggregate privacy mode.`
    );
  if ((recoveryExclusions.pending ?? 0) + (recoveryExclusions.unscored ?? 0))
    notes.push(
      `${plural((recoveryExclusions.pending ?? 0) + (recoveryExclusions.unscored ?? 0), "recovery", "recoveries")} without a WHOOP score ${(recoveryExclusions.pending ?? 0) + (recoveryExclusions.unscored ?? 0) === 1 ? "is" : "are"} not used.`
    );
  const reasons = Object.fromEntries(
    BASELINE_METRICS.map((metric) => [metric, metricStatus[metric].reason])
  ) as Record<BaselineMetric, string | null>;
  notes.push(...groupedReasonNotes(NOTE_ORDER, reasons));
  const lowCoverage = results.sleep_efficiency.exclusions.low_data_coverage ?? 0;
  if (lowCoverage)
    notes.push(
      `${plural(lowCoverage, "night")} with low data coverage (no strap data for more than ${LOW_COVERAGE_PERCENT}% of time in bed) ${lowCoverage === 1 ? "is" : "are"} not used for sleep efficiency, disturbances per hour, REM share or deep sleep share.`
    );
  for (const metric of BASELINE_METRICS)
    notes.push(...results[metric].notes.filter((note) => !notes.includes(note)));
  const truncated = sources.some((source) => source.quality.truncated);
  if (truncated)
    notes.push(
      "WHOOP returned more records than could be fetched for these weeks, so they are withheld."
    );

  const period = {
    start: formatLocalTimestamp(weeks[0]!.startMs, offset),
    end: formatLocalTimestamp(weeks[weeks.length - 1]!.endMs - 1, offset),
  };
  return {
    period,
    metrics,
    metric_status: metricStatus,
    notes: withOffsetNote(notes, fallback),
    truncated,
    disclaimer: DISCLAIMER,
    data_quality: {
      evaluated_at: aggregateEvaluatedAt(now, offset),
      requested_period: period,
      sources: aggregateQualitySources(data, Object.values(results), [
        "recovery",
        "sleep",
        "cycle",
      ]),
      method_version: "baselines-3-released-weeks",
    },
  };
}
