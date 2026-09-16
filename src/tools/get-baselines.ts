import { z } from "zod";
import type { WhoopClient } from "../api/client.js";
import { ENDPOINT_CYCLE, ENDPOINT_RECOVERY, ENDPOINT_SLEEP } from "../api/endpoints.js";
import {
  cycleRecordSchema,
  recoveryRecordSchema,
  sleepRecordSchema,
} from "../api/record-schemas.js";
import {
  cycleDay,
  dataQualitySchema,
  DAY_MS,
  DISCLAIMER,
  exclude,
  finishQuality,
  loadAnalyticsSource,
  mostRelevantError,
  localDay,
  mainSleeps,
  observedPeriod,
  periodSchema,
  asleepHours,
  type SourceQuality,
} from "./analytics-utils.js";
import { mean, median, percentile, standardDeviation } from "./stats-utils.js";

/** Earlier observations (besides the most recent one and today) a baseline needs. */
export const BASELINE_MIN_SAMPLES = 14;

export const baselinesInputSchema = z.object({
  baseline_days: z
    .number()
    .int()
    .min(14)
    .max(180)
    .optional()
    .describe(
      "Days of history to build baselines from, ending now (14-180). Default: 30. Each baseline needs at least 14 earlier days with data; until then its metric_status explains why (e.g. 'calibrating')."
    ),
});
const metricNameSchema = z.enum([
  "hrv",
  "rhr",
  "respiratory_rate",
  "sleep_hours",
  "recovery_score",
]);
const bandSchema = z.object({
  sample_size: z.number().int(),
  mean: z.number(),
  median: z.number(),
  std_dev: z.number(),
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
   * unavailable: a source could not be read.
   */
  status: z.enum(["available", "insufficient_data", "calibrating", "unavailable"]),
  sample_size: z.number().int(),
  required_sample_size: z.number().int(),
  unit: z.string(),
  reason: z.string().nullable(),
});
export const baselinesOutputSchema = z.object({
  period: periodSchema.nullable(),
  metrics: z.record(metricNameSchema, bandSchema.nullable()),
  metric_status: z.record(metricNameSchema, metricStatusSchema),
  notes: z.array(z.string()),
  data_quality: dataQualitySchema,
  truncated: z.boolean(),
  disclaimer: z.string(),
});
export type BaselineReport = z.infer<typeof baselinesOutputSchema>;
type Metric = z.infer<typeof metricNameSchema>;
type MetricStatus = z.infer<typeof metricStatusSchema>;
type Observation = { value: number; timestamp: string; offset: string; day: string };

const RECOVERY_METRICS = ["hrv", "rhr", "recovery_score"] as const;

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

export async function getBaselines(
  client: WhoopClient,
  params: z.infer<typeof baselinesInputSchema> = {},
  now: Date = new Date()
): Promise<BaselineReport> {
  const { baseline_days = 30 } = baselinesInputSchema.parse(params);
  const period = {
    start: new Date(now.getTime() - baseline_days * DAY_MS).toISOString(),
    end: now.toISOString(),
  };
  const [recovery, sleep, cycle] = await Promise.all([
    loadAnalyticsSource(client, ENDPOINT_RECOVERY, period, recoveryRecordSchema),
    loadAnalyticsSource(client, ENDPOINT_SLEEP, period, sleepRecordSchema),
    loadAnalyticsSource(client, ENDPOINT_CYCLE, period, cycleRecordSchema),
  ]);
  if ([recovery, sleep, cycle].every((source) => source.quality.status === "fetch_failed"))
    throw mostRelevantError([recovery.error, sleep.error, cycle.error]);
  const observations: Record<Metric, Observation[]> = {
    hrv: [],
    rhr: [],
    respiratory_rate: [],
    sleep_hours: [],
    recovery_score: [],
  };
  const cycles = new Map(cycle.records.map((record) => [`${record.user_id}:${record.id}`, record]));
  const usedRecoveries: typeof recovery.records = [];
  const usedCycles: typeof cycle.records = [];
  const seenCycles = new Set<string>();
  let scoredRecoveries = 0;
  // WHOOP's calibration flag on the most recent scored recovery tells whether it is still calibrating.
  let newestScored: { created: number; calibrating: boolean } | null = null;
  for (const record of recovery.records) {
    if (record.score_state !== "SCORED" || !record.score) {
      exclude(recovery.quality, record.score_state === "PENDING_SCORE" ? "pending" : "unscored");
      continue;
    }
    scoredRecoveries += 1;
    const created = Date.parse(record.created_at);
    if (!newestScored || created > newestScored.created)
      newestScored = { created, calibrating: record.score.user_calibrating };
    if (record.score.user_calibrating) {
      exclude(recovery.quality, "calibrating");
      continue;
    }
    const key = `${record.user_id}:${record.cycle_id}`;
    const context = cycles.get(key);
    if (!context) {
      exclude(recovery.quality, "missing_join");
      continue;
    }
    if (
      Date.parse(context.start) < Date.parse(period.start) ||
      Date.parse(context.start) >= now.getTime()
    ) {
      exclude(recovery.quality, "outside_window");
      continue;
    }
    if (seenCycles.has(key)) {
      exclude(recovery.quality, "duplicate_cycle");
      continue;
    }
    seenCycles.add(key);
    usedRecoveries.push(record);
    usedCycles.push(context);
    for (const [metric, value] of [
      ["hrv", record.score.hrv_rmssd_milli],
      ["rhr", record.score.resting_heart_rate],
      ["recovery_score", record.score.recovery_score],
    ] as const) {
      observations[metric].push({
        value,
        timestamp: context.start,
        offset: context.timezone_offset,
        // A cycle starts at the previous evening's sleep onset; count it toward the day it covers.
        day: cycleDay(context),
      });
    }
  }
  const nights = mainSleeps(sleep.records, period, sleep.quality);
  let nightsWithoutRespiratoryRate = 0;
  for (const night of nights) {
    const day = localDay(night.end, night.timezone_offset);
    observations.sleep_hours.push({
      value: asleepHours(night),
      timestamp: night.end,
      offset: night.timezone_offset,
      day,
    });
    if (typeof night.score?.respiratory_rate === "number")
      observations.respiratory_rate.push({
        value: night.score.respiratory_rate,
        timestamp: night.end,
        offset: night.timezone_offset,
        day,
      });
    else nightsWithoutRespiratoryRate += 1;
  }
  const metrics = {} as BaselineReport["metrics"];
  const metricStatus = {} as BaselineReport["metric_status"];
  const usedTimestamps: string[] = [];
  const units: Record<Metric, string> = {
    hrv: "ms",
    rhr: "bpm",
    recovery_score: "%",
    respiratory_rate: "breaths/min",
    sleep_hours: "hours",
  };
  const calibrating =
    (recovery.quality.exclusions.calibrating ?? 0) > 0 && !!newestScored?.calibrating;
  const statusFor = (metric: Metric, count: number): Omit<MetricStatus, "sample_size" | "unit"> => {
    const required = BASELINE_MIN_SAMPLES;
    const base = { required_sample_size: required };
    if (count >= required) return { ...base, status: "available", reason: null };
    const isRecovery = (RECOVERY_METRICS as readonly Metric[]).includes(metric);
    if (isRecovery) {
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
    const missingRate =
      metric === "respiratory_rate" && nightsWithoutRespiratoryRate
        ? ` WHOOP reported no respiratory rate for ${nightsWithoutRespiratoryRate} of ${plural(nights.length, "scored main sleep")}.`
        : "";
    return {
      ...base,
      status: "insufficient_data",
      reason: `Not enough data yet (${plural(nights.length, "scored main sleep")} in this window; ${count} of ${required} earlier ones needed, the most recent night and today are not counted).${missingRate}`,
    };
  };
  for (const metric of metricNameSchema.options) {
    const sorted = observations[metric].sort(
      (left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp)
    );
    const latest = sorted[0];
    const historical = sorted
      .slice(1)
      .filter((item) => item.day !== localDay(now.toISOString(), item.offset));
    const values = historical.map((item) => item.value);
    usedTimestamps.push(...historical.map((item) => item.timestamp));
    metricStatus[metric] = {
      ...statusFor(metric, values.length),
      sample_size: values.length,
      unit: units[metric],
    };
    metrics[metric] =
      values.length < BASELINE_MIN_SAMPLES
        ? null
        : {
            sample_size: values.length,
            mean: mean(values),
            median: median(values),
            std_dev: standardDeviation(values),
            p10: percentile(values, 10),
            p25: percentile(values, 25),
            p50: percentile(values, 50),
            p75: percentile(values, 75),
            p90: percentile(values, 90),
            latest: latest?.value ?? null,
            latest_percentile: latest
              ? (100 *
                  (values.filter((value) => value < latest.value).length +
                    0.5 * values.filter((value) => value === latest.value).length)) /
                values.length
              : null,
            constant_baseline: standardDeviation(values) === 0,
          };
  }
  finishQuality(recovery.quality, usedRecoveries);
  finishQuality(sleep.quality, nights);
  finishQuality(cycle.quality, usedCycles);
  // Cycles only serve as context for recoveries: when none could be joined because the
  // recoveries are calibrating/pending/unscored, say so instead of "missing".
  if (
    !usedCycles.length &&
    cycle.records.length &&
    cycle.quality.status === "missing" &&
    ["calibrating", "pending", "unscored"].includes(recovery.quality.status)
  )
    cycle.quality.status = recovery.quality.status;
  const observed = observedPeriod(usedTimestamps);
  const truncated = [recovery, sleep, cycle].some((source) => source.quality.truncated);
  const notes: string[] = [];
  const recoveryReason = metricStatus.hrv.reason;
  if (recoveryReason) notes.push(`HRV, resting heart rate and recovery score: ${recoveryReason}`);
  const sleepReason = metricStatus.sleep_hours.reason;
  const respiratoryReason = metricStatus.respiratory_rate.reason;
  if (sleepReason && sleepReason === respiratoryReason)
    notes.push(`Sleep hours and respiratory rate: ${sleepReason}`);
  else {
    if (sleepReason) notes.push(`Sleep hours: ${sleepReason}`);
    if (respiratoryReason) notes.push(`Respiratory rate: ${respiratoryReason}`);
  }
  notes.push(
    ...sourceNotes("recovery", ["recovery", "recoveries"], recovery.quality),
    ...sourceNotes("sleep", ["sleep", "sleeps"], sleep.quality),
    ...sourceNotes("cycle", ["cycle", "cycles"], cycle.quality)
  );
  if (truncated)
    notes.push(
      "Partial history: the WHOOP pagination limit was reached, so the oldest records in the window were not read."
    );
  return {
    period: observed,
    metrics,
    metric_status: metricStatus,
    notes,
    truncated,
    disclaimer: DISCLAIMER,
    data_quality: {
      evaluated_at: now.toISOString(),
      requested_period: period,
      observed_period: observed,
      sources: { recovery: recovery.quality, sleep: sleep.quality, cycle: cycle.quality },
      method_version: "baselines-2",
      limitations: [
        "Descriptive personal distributions, not population norms or diagnosis.",
        "Latest observation and current local day are excluded from each baseline.",
        "Recoveries WHOOP flags as calibrating are not used for baselines.",
        ...(truncated ? ["Partial history: upstream pagination limit reached."] : []),
      ],
    },
  };
}
