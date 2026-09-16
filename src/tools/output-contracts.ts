import { z } from "zod";
import {
  cycleRecordSchema,
  recoveryRecordSchema,
  sleepRecordSchema,
  workoutRecordSchema,
} from "../api/record-schemas.js";
import { dataQualitySchema, periodSchema } from "./analytics-utils.js";
import { baselinesOutputSchema } from "./get-baselines.js";
import { sleepDebtOutputSchema } from "./get-sleep-debt.js";

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
}> => z.object({ records: z.array(record), next_token: z.string().nullish() });
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
    count: nullable,
    total_strain: nullable,
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
const comparison = z.object({
  period_a: period,
  period_b: period,
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
    std_dev: nullable,
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

const aggregateBand = z.object({
  sample_size: number,
  mean: number,
  median: number,
  std_dev: number,
  p10: number,
  p25: number,
  p50: number,
  p75: number,
  p90: number,
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
export const aggregateOutputSchemas: Record<string, z.ZodObject> = {
  get_weekly_summary: weekly
    .omit({ warnings: true })
    .extend({ workouts: weekly.shape.workouts.omit({ sport_breakdown: true }) }),
  compare_periods: comparison,
  get_trend: trend.omit({ values: true, dates: true, anomalies: true }),
  get_baselines: baselinesOutputSchema.extend({
    metrics: z.record(
      z.enum(["hrv", "rhr", "respiratory_rate", "sleep_hours", "recovery_score"]),
      aggregateBand.nullable()
    ),
    data_quality: aggregateQuality,
  }),
  get_sleep_debt: sleepDebtOutputSchema
    .omit({ nights: true, standing_debt_hours: true, standing_debt_date: true, summary: true })
    .extend({ data_quality: aggregateQuality }),
};

export function projectAggregateDates(data: Record<string, unknown>): Record<string, unknown> {
  const projected = { ...data };
  for (const key of ["period", "period_a", "period_b"]) {
    if (projected[key]) {
      const periodValue = periodSchema.passthrough().parse(projected[key]);
      projected[key] = {
        ...periodValue,
        start: periodValue.start.slice(0, 10),
        end: periodValue.end.slice(0, 10),
      };
    }
  }
  for (const key of ["week_start", "week_end"]) {
    if (typeof projected[key] === "string") projected[key] = projected[key].slice(0, 10);
  }
  if (projected.data_quality) {
    const quality = aggregateQuality.parse(projected.data_quality);
    projected.data_quality = {
      ...quality,
      requested_period: {
        start: quality.requested_period.start.slice(0, 10),
        end: quality.requested_period.end.slice(0, 10),
      },
    };
  }
  return projected;
}
