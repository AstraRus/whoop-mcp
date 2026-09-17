import { z } from "zod";
import {
  cycleRecordSchema,
  recoveryRecordSchema,
  sleepRecordSchema,
  workoutRecordSchema,
} from "../api/record-schemas.js";
import { dataQualitySchema, periodSchema } from "./analytics-utils.js";
import { MIN_SAMPLES_PER_PERIOD } from "./compare-periods.js";
import { baselineMetricNameSchema, baselinesOutputSchema } from "./get-baselines.js";
import { sleepDebtOutputSchema } from "./get-sleep-debt.js";
import { MIN_TREND_POINTS } from "./stats-utils.js";

export { privacyModeSchema, type PrivacyMode } from "../privacy.js";
const number = z.number().finite();
const nullable = number.nullable();
const period = periodSchema.extend({ days: number });
const direction = z.enum(["improving", "declining", "stable"]);
const collection = <Schema extends z.ZodType>(
  record: Schema
): z.ZodObject<{
  records: z.ZodArray<Schema>;
  next_token: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  notes: z.ZodOptional<z.ZodArray<z.ZodString>>;
}> =>
  z.object({
    records: z.array(record),
    next_token: z.string().nullish(),
    notes: z
      .array(z.string())
      .optional()
      .describe(
        "Present only when a date in start or end was read in UTC because the user's time zone could not be read from WHOOP"
      ),
  });
const weekly = z.object({
  week_start: z.string(),
  week_end: z.string(),
  recovery: z.object({
    average_score: nullable,
    min_score: nullable,
    max_score: nullable,
    average_hrv: nullable,
    average_rhr: nullable,
    trend: direction.nullable(),
  }),
  sleep: z.object({
    average_duration_hours: nullable.describe(
      "Average hours asleep (light + slow-wave + REM) per main sleep; naps and time awake in bed excluded"
    ),
    average_performance_pct: nullable,
    average_efficiency_pct: nullable,
  }),
  workouts: z.object({
    count: nullable.describe(
      "Scored workouts in the week; null when workouts could not be loaded or the week has no WHOOP data at all (0 means a worn week without workouts)"
    ),
    total_strain: nullable.describe(
      "Sum of per-workout strain. Strain is non-linear (0-21), so this sum is not comparable to day strain."
    ),
    total_calories_kj: nullable,
    sport_breakdown: z.record(z.string(), number),
  }),
  strain: z.object({ average_daily_strain: nullable, max_daily_strain: nullable }),
  sample_sizes: z.object({
    recovery_days: z.number().int().nonnegative(),
    sleep_nights: z.number().int().nonnegative(),
    completed_cycles: z.number().int().nonnegative(),
  }),
  calibrating: z.boolean(),
  truncated: z.boolean(),
  notes: z.array(z.string()),
  warnings: z.array(z.string()).optional(),
});
const comparisonCount = z.number().int().nonnegative();
const comparisonDirection = z.enum(["improved", "declined", "unchanged", "insufficient_data"]);
const comparisonMetric = z.object({
  period_a_avg: nullable,
  period_b_avg: nullable,
  period_a_n: comparisonCount,
  period_b_n: comparisonCount,
  change_pct: nullable,
  direction: comparisonDirection,
});
const comparisonDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullable()
  .describe("Local day (YYYY-MM-DD) counted in the period; null when it covers no local day");
const comparisonPeriod = period.extend({ first_day: comparisonDay, last_day: comparisonDay });
const trainingPeriod = z.object({
  sessions: comparisonCount.describe("Scored workouts placed on worn local days of the period"),
  worn_days: comparisonCount.describe(
    "Counted local days with a WHOOP cycle placed on them (the strap was worn)"
  ),
  sessions_per_week: nullable.describe(
    "Sessions per 7 worn days; null unless both periods have at least 7 worn days"
  ),
  workout_minutes_per_worn_day: nullable.describe(
    "Workout minutes (start to end) per worn day, 0 on worn days without workouts; null unless both periods have at least 7 worn days"
  ),
  trimp_per_worn_day: nullable.describe(
    "Edwards TRIMP (WHOOP heart-rate zone 1-5 minutes weighted 1-5) per worn day; days with a workout recorded below 90% or not scored are left out; null unless both periods have at least 7 worn days"
  ),
});
const training = z
  .object({
    period_a: trainingPeriod,
    period_b: trainingPeriod,
    change_pct: z.object({
      sessions_per_week: nullable,
      workout_minutes_per_worn_day: nullable,
      trimp_per_worn_day: nullable,
    }),
    direction: z
      .enum(["increased", "decreased", "unchanged", "insufficient_data"])
      .describe("From trimp_per_worn_day; a change within ±5% is unchanged"),
  })
  .nullable()
  .describe("Workout load per period; null when workouts or cycles could not be loaded");
const comparison = z.object({
  period_a: comparisonPeriod,
  period_b: comparisonPeriod,
  recovery: comparisonMetric.extend({
    period_a_calibrating_n: comparisonCount,
    period_b_calibrating_n: comparisonCount,
  }),
  sleep: z.object({
    period_a_avg_hours: nullable.describe("Average time asleep per main sleep (naps excluded)"),
    period_b_avg_hours: nullable.describe("Average time asleep per main sleep (naps excluded)"),
    period_a_n: comparisonCount,
    period_b_n: comparisonCount,
    change_pct: nullable,
    direction: comparisonDirection,
  }),
  strain: comparisonMetric.extend({
    direction: z.enum(["increased", "decreased", "unchanged", "insufficient_data"]),
  }),
  training,
  truncated: z.boolean(),
  notes: z.array(z.string()),
  warnings: z.array(z.string()),
});
const trend = z.object({
  metric: z.string(),
  period,
  status: z.enum(["available", "insufficient_data"]),
  sample_size: z.number().int().nonnegative(),
  calibrating: z.boolean().nullable(),
  truncated: z.boolean(),
  values: z.array(number),
  dates: z.array(z.string()),
  statistics: z.object({
    mean: nullable,
    median: nullable,
    std_dev: nullable.describe("Sample standard deviation (n-1)"),
    min: nullable,
    max: nullable,
  }),
  trend: z.object({
    direction: direction.nullable(),
    change: z.enum(["increasing", "decreasing", "stable"]).nullable(),
    better_when: z.enum(["higher", "lower"]).nullable(),
    slope: nullable,
    confidence: z.enum(["high", "medium", "low"]).nullable(),
  }),
  anomalies: z.array(z.object({ date: z.string(), value: number, deviation_from_mean: number })),
  notes: z.array(z.string()),
});
const today = z.object({
  timestamp: z.string(),
  recovery: z
    .object({
      score: number,
      hrv_rmssd_milli: number,
      resting_heart_rate: number,
      spo2_pct: nullable,
      skin_temp_celsius: nullable,
      user_calibrating: z.boolean(),
      zone: z
        .enum(["green", "yellow", "red"])
        .describe("WHOOP recovery band: green 67-100, yellow 34-66, red 0-33"),
    })
    .nullable(),
  sleep: z
    .object({
      total_hours: number,
      time_in_bed_hours: number,
      asleep_hours: number,
      rem_hours: number,
      deep_hours: number,
      light_hours: number,
      awake_hours: number,
      performance_pct: nullable,
      efficiency_pct: nullable,
      respiratory_rate: nullable,
      disturbances: z.number().int().nonnegative(),
      sleep_cycles: z.number().int().nonnegative(),
      no_data_hours: number.describe("Time in bed without strap data"),
      consistency_pct: nullable.describe(
        "WHOOP sleep consistency; null when WHOOP reports none or reports 0 while still calibrating"
      ),
      need_hours_including_debt: number.describe(
        "WHOOP sleep need: baseline + sleep debt + recent strain + recent naps (a nap lowers it)"
      ),
    })
    .nullable(),
  strain: z
    .object({
      day_strain: number,
      energy_burned_kj: number,
      last_workout: z
        .object({
          sport_name: z.string(),
          strain: number,
          occurred_at: z.string(),
          percent_recorded: number,
        })
        .nullable(),
    })
    .nullable(),
  summary: z.string(),
  notes: z.array(z.string()),
  data_quality: dataQualitySchema,
});
const calendarCount = z.number().int().nonnegative();
const calendar = z.object({
  period: period.extend({ utc_offset: z.string() }),
  days: z.array(
    z.object({
      date: z.string(),
      recovery_score: nullable,
      recovery_zone: z.enum(["green", "yellow", "red"]).nullable(),
      recovery_calibrating: z.boolean().nullable(),
      sleep_hours: nullable,
      sleep_performance_pct: nullable,
      day_strain: nullable,
      day_strain_in_progress: z.boolean(),
      day_strain_partial: z.boolean(),
    })
  ),
  averages: z.object({
    recovery: nullable,
    sleep_hours: nullable,
    strain: nullable,
    sample_sizes: z.object({
      recovery: calendarCount,
      sleep_hours: calendarCount,
      strain: calendarCount,
    }),
  }),
  truncated: z.boolean(),
  notes: z.array(z.string()),
  warnings: z.array(z.string()),
});

export const outputSchemas: Record<string, z.ZodObject> = {
  get_profile: z
    .object({ user_id: number, email: z.string(), first_name: z.string(), last_name: z.string() })
    .passthrough(),
  get_body_measurement: z
    .object({ height_meter: number, weight_kilogram: number, max_heart_rate: number })
    .passthrough(),
  get_recovery_collection: collection(recoveryRecordSchema),
  get_sleep_collection: collection(sleepRecordSchema),
  get_workout_collection: collection(workoutRecordSchema),
  get_cycle_collection: collection(cycleRecordSchema),
  get_sleep_by_id: sleepRecordSchema,
  get_workout_by_id: workoutRecordSchema,
  get_cycle_by_id: cycleRecordSchema,
  get_weekly_summary: weekly,
  compare_periods: comparison,
  get_trend: trend,
  get_today: today,
  get_calendar: calendar,
  get_baselines: baselinesOutputSchema,
  get_sleep_debt: sleepDebtOutputSchema,
};

// Aggregate bands drop the latest observation and the outer percentiles (p10, p90).
const aggregateBand = z.object({
  sample_size: number,
  mean: number,
  median: number,
  std_dev: number.describe("Sample standard deviation (n-1)"),
  p25: number,
  p50: number,
  p75: number,
  constant_baseline: z.boolean(),
});
const aggregateQuality = dataQualitySchema
  .omit({ sources: true, limitations: true, observed_period: true })
  .extend({
    sources: z.record(
      z.string(),
      z.object({
        status: z.string(),
        records_fetched: number,
        records_used: number,
        exclusions: z.record(z.string(), number),
        truncated: z.boolean(),
      })
    ),
  });
/**
 * Samples (days, nights, cycles, workouts) an average or total needs before
 * aggregate privacy mode shows it; below this it would be (close to) a single
 * record's value. Same as compare_periods' per-period minimum.
 */
export const AGGREGATE_MIN_SAMPLES = MIN_SAMPLES_PER_PERIOD;
/** Data points aggregate trend statistics need (same as a trend itself). */
export const AGGREGATE_MIN_TREND_POINTS = MIN_TREND_POINTS;

// Aggregate mode drops extremes (always one record's value) and labels
// compare_periods periods with the local days actually counted.
const aggregateWeekly = weekly.omit({ warnings: true }).extend({
  recovery: weekly.shape.recovery.omit({ min_score: true, max_score: true }),
  workouts: weekly.shape.workouts.omit({ sport_breakdown: true }),
  strain: weekly.shape.strain.omit({ max_daily_strain: true }),
});
const aggregateComparisonPeriod = comparisonPeriod.extend({
  start: z
    .string()
    .nullable()
    .describe("First local day counted (YYYY-MM-DD); null when the period covers no local day"),
  end: z
    .string()
    .nullable()
    .describe("Last local day counted (YYYY-MM-DD, inclusive); null when it covers no local day"),
  days: number.describe("Local days counted, start to end inclusive"),
});
const aggregateComparison = comparison.omit({ training: true }).extend({
  period_a: aggregateComparisonPeriod,
  period_b: aggregateComparisonPeriod,
});
const aggregateTrend = trend.omit({ values: true, dates: true, anomalies: true }).extend({
  statistics: trend.shape.statistics.pick({ mean: true, std_dev: true }),
});
export const aggregateOutputSchemas: Record<string, z.ZodObject> = {
  get_weekly_summary: aggregateWeekly,
  compare_periods: aggregateComparison,
  get_trend: aggregateTrend,
  get_baselines: baselinesOutputSchema.extend({
    metrics: z.record(baselineMetricNameSchema, aggregateBand.nullable()),
    data_quality: aggregateQuality,
  }),
  get_sleep_debt: sleepDebtOutputSchema
    .omit({ nights: true, standing_debt_hours: true, standing_debt_date: true, summary: true })
    .extend({ data_quality: aggregateQuality }),
};

const DAY_MS = 86_400_000;

function addDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
}

/**
 * Local day of a window start written in the user's offset: the nearest local
 * midnight (a start at or after noon mostly covers the next day).
 */
function startDay(timestamp: string): string {
  const day = timestamp.slice(0, 10);
  const hour = /^\d{4}-\d{2}-\d{2}T(\d{2})/.exec(timestamp)?.[1];
  return hour !== undefined && Number(hour) >= 12 ? addDay(day) : day;
}

/**
 * Local-day labels for a window whose bounds are written in the user's offset.
 * Ends are the last included instant or now, so their date is the last day.
 */
function dayLabels(start: string, end: string): { start: string; end: string } {
  const endDay = end.slice(0, 10);
  const snapped = startDay(start);
  return { start: snapped <= endDay ? snapped : start.slice(0, 10), end: endDay };
}

function comparisonDayLabels(value: z.infer<typeof comparisonPeriod>): {
  start: string | null;
  end: string | null;
  days: number;
} {
  const { first_day: first, last_day: last } = value;
  if (first === null || last === null) return { start: null, end: null, days: 0 };
  return {
    start: first,
    end: last,
    days:
      Math.round((Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / DAY_MS) + 1,
  };
}

/**
 * Aggregate-mode date labels: every period, week and requested window becomes
 * the user's local YYYY-MM-DD days. compare_periods periods use the local days
 * actually counted (first_day..last_day), with `days` counting them.
 */
export function projectAggregateDates(data: Record<string, unknown>): Record<string, unknown> {
  const projected = { ...data };
  for (const key of ["period", "period_a", "period_b"]) {
    if (!projected[key]) continue;
    const counted = comparisonPeriod.safeParse(projected[key]);
    if (counted.success) {
      projected[key] = { ...counted.data, ...comparisonDayLabels(counted.data) };
      continue;
    }
    const periodValue = periodSchema.passthrough().parse(projected[key]);
    projected[key] = { ...periodValue, ...dayLabels(periodValue.start, periodValue.end) };
  }
  for (const key of ["week_start", "week_end"]) {
    if (typeof projected[key] === "string") projected[key] = projected[key].slice(0, 10);
  }
  if (projected.data_quality) {
    const quality = aggregateQuality.parse(projected.data_quality);
    projected.data_quality = {
      ...quality,
      requested_period: dayLabels(quality.requested_period.start, quality.requested_period.end),
    };
  }
  return projected;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function withholdWeekly(data: z.infer<typeof aggregateWeekly>): z.infer<typeof aggregateWeekly> {
  const {
    recovery_days: recoveryDays,
    sleep_nights: nights,
    completed_cycles: cycles,
  } = data.sample_sizes;
  const withheld: string[] = [];
  const recovery = { ...data.recovery };
  const sleep = { ...data.sleep };
  const workouts = { ...data.workouts };
  const strain = { ...data.strain };
  const shown = (...values: Array<number | null>): boolean => values.some((v) => v !== null);
  if (
    recoveryDays < AGGREGATE_MIN_SAMPLES &&
    shown(recovery.average_score, recovery.average_hrv, recovery.average_rhr)
  ) {
    Object.assign(recovery, { average_score: null, average_hrv: null, average_rhr: null });
    withheld.push(`recovery (${plural(recoveryDays, "day")})`);
  }
  if (
    nights < AGGREGATE_MIN_SAMPLES &&
    shown(sleep.average_duration_hours, sleep.average_performance_pct, sleep.average_efficiency_pct)
  ) {
    Object.assign(sleep, {
      average_duration_hours: null,
      average_performance_pct: null,
      average_efficiency_pct: null,
    });
    withheld.push(`sleep (${plural(nights, "night")})`);
  }
  if (cycles < AGGREGATE_MIN_SAMPLES && shown(strain.average_daily_strain)) {
    strain.average_daily_strain = null;
    withheld.push(`daily strain (${plural(cycles, "completed cycle")})`);
  }
  const workoutCount = workouts.count;
  if (
    workoutCount !== null &&
    workoutCount > 0 &&
    workoutCount < AGGREGATE_MIN_SAMPLES &&
    shown(workouts.total_strain, workouts.total_calories_kj)
  ) {
    Object.assign(workouts, { total_strain: null, total_calories_kj: null });
    withheld.push(`workout totals (${plural(workoutCount, "workout")})`);
  }
  if (!withheld.length) return data;
  return {
    ...data,
    recovery,
    sleep,
    workouts,
    strain,
    notes: [
      ...data.notes,
      `Aggregate privacy mode withholds averages and totals based on fewer than ${AGGREGATE_MIN_SAMPLES} data points: ${withheld.join(", ")}.`,
    ],
  };
}

function withholdComparison(
  data: z.infer<typeof aggregateComparison>
): z.infer<typeof aggregateComparison> {
  const withheld: string[] = [];
  const hide = (
    metric: string,
    period: "A" | "B",
    count: number,
    value: number | null,
    unit: [string, string]
  ): boolean => {
    if (value === null || count >= AGGREGATE_MIN_SAMPLES) return false;
    withheld.push(`${metric} in period ${period} (${plural(count, ...unit)})`);
    return true;
  };
  const recovery = { ...data.recovery };
  const sleep = { ...data.sleep };
  const strain = { ...data.strain };
  const recoveryUnit: [string, string] = ["scored recovery", "scored recoveries"];
  const sleepUnit: [string, string] = ["night", "nights"];
  const strainUnit: [string, string] = ["completed cycle", "completed cycles"];
  if (hide("recovery", "A", recovery.period_a_n, recovery.period_a_avg, recoveryUnit))
    recovery.period_a_avg = null;
  if (hide("recovery", "B", recovery.period_b_n, recovery.period_b_avg, recoveryUnit))
    recovery.period_b_avg = null;
  if (hide("sleep", "A", sleep.period_a_n, sleep.period_a_avg_hours, sleepUnit))
    sleep.period_a_avg_hours = null;
  if (hide("sleep", "B", sleep.period_b_n, sleep.period_b_avg_hours, sleepUnit))
    sleep.period_b_avg_hours = null;
  if (hide("strain", "A", strain.period_a_n, strain.period_a_avg, strainUnit))
    strain.period_a_avg = null;
  if (hide("strain", "B", strain.period_b_n, strain.period_b_avg, strainUnit))
    strain.period_b_avg = null;
  if (!withheld.length) return data;
  return {
    ...data,
    recovery,
    sleep,
    strain,
    notes: [
      ...data.notes,
      `Aggregate privacy mode withholds period averages based on fewer than ${AGGREGATE_MIN_SAMPLES} samples: ${withheld.join(", ")}.`,
    ],
  };
}

function withholdTrend(data: z.infer<typeof aggregateTrend>): z.infer<typeof aggregateTrend> {
  const { mean, std_dev: stdDev } = data.statistics;
  if (data.sample_size >= AGGREGATE_MIN_TREND_POINTS || (mean === null && stdDev === null))
    return data;
  return {
    ...data,
    statistics: { mean: null, std_dev: null },
    notes: [
      ...data.notes,
      `Aggregate privacy mode withholds statistics until at least ${AGGREGATE_MIN_TREND_POINTS} data points exist (${data.sample_size} so far).`,
    ],
  };
}

/**
 * Withhold aggregate values that would reconstruct individual records: averages
 * and totals below AGGREGATE_MIN_SAMPLES (compare_periods, get_weekly_summary)
 * and trend statistics below AGGREGATE_MIN_TREND_POINTS. Extremes are already
 * dropped by the aggregate schemas. `data` must match aggregateOutputSchemas[name].
 */
export function projectAggregateSamples(
  name: string,
  data: Record<string, unknown>
): Record<string, unknown> {
  switch (name) {
    case "get_weekly_summary":
      return withholdWeekly(aggregateWeekly.parse(data));
    case "compare_periods":
      return withholdComparison(aggregateComparison.parse(data));
    case "get_trend":
      return withholdTrend(aggregateTrend.parse(data));
    default:
      return data;
  }
}

/** The full aggregate privacy projection applied to a validated tool result. */
export function projectAggregate(
  name: string,
  data: Record<string, unknown>
): Record<string, unknown> {
  return projectAggregateDates(projectAggregateSamples(name, data));
}
