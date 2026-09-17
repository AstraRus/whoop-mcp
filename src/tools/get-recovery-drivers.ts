/**
 * get_recovery_drivers: observational patterns between what happened on the
 * previous day and evening (sleep timing, strain, training, late workouts,
 * naps, sleep debt, user tags) and the next morning's recovery values or the
 * night's own sleep.
 *
 * - A pair is a night (main sleep, one per wake day, from buildNights) with a
 *   scored sleep whose previous WHOOP day (prior cycle) is closed, scored, not
 *   the partial first day of wear, 12-36 hours long and inside the complete
 *   part of the history read. Recovery outcomes also need a scored recovery for
 *   that sleep (calibrating ones only with include_calibrating).
 * - Continuous behaviours are tested with Spearman's rho, binary ones with
 *   Mann-Whitney and Cliff's delta. Consecutive days are autocorrelated, so the
 *   intervals and p-values use an effective sample size from the lag-1 rank
 *   autocorrelation of both series over consecutive wake days, and q-values
 *   (Benjamini-Hochberg over every test in the call) control false discoveries.
 * - A failed cycle or sleep stream, or a failed recovery stream when only
 *   recovery outcomes are requested, makes the result unavailable (every
 *   stream failing throws). With sleep outcomes also requested, a failed
 *   recovery stream leaves recovery outcomes data_unavailable; a failed workout
 *   stream leaves workout behaviours data_unavailable (never "no workout").
 * - Generated text is observational (no advice, no causal wording).
 *
 * Standard privacy mode only: tags and pair-level associations can isolate
 * single nights, so there is no aggregate variant.
 */

import { z } from "zod";
import {
  createHistoryBudget,
  HISTORY_DEADLINE_MS,
  HISTORY_LIMITATIONS,
  loadHistory,
  type HistorySource,
} from "../api/history.js";
import {
  cycleRecordSchema,
  recoveryRecordSchema,
  sleepRecordSchema,
  workoutRecordSchema,
} from "../api/record-schemas.js";
import type { Cycle, Recovery, Sleep, Workout } from "../api/types.js";
import {
  dataQualitySchema,
  DAY_MS,
  DISCLAIMER,
  exclude,
  finishQuality,
  formatLocalTimestamp,
  HOUR_MS,
  localDay,
  localMidnightMs,
  localTime,
  mostRelevantError,
  recoveryZone,
  type RecoveryZone,
  type SourceQuality,
} from "./analytics-utils.js";
import { resolveUserUtcOffsetInfo, withOffsetNote } from "./collection-utils.js";
import { InvalidDateExpression } from "./date-utils.js";
import {
  addDays,
  buildNights,
  cycleStrain,
  fetchRangeForDays,
  placeDays,
  type Night,
} from "./day-model.js";
import { needBreakdown, stageBreakdown } from "./sleep-metrics.js";
import {
  benjaminiHochberg,
  circularSignedDeltaMinutes,
  circularStats,
  cliffsDelta,
  correlationInterval,
  effectiveSampleSize,
  lag1RankAutocorrelation,
  mannWhitney,
  median,
  quantileCuts,
  roundTo,
  spearman,
} from "./stats-utils.js";
import { defineTool, type ToolContext } from "./tool-definition.js";
import {
  edwardsTrimp,
  MIN_RECORDED_FRACTION,
  recordedFraction,
  zoneMinutes,
} from "./workout-utils.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const RECOVERY_DRIVERS_TOOL_NAME = "get_recovery_drivers";

/** Days analysed without `days` */
export const DRIVERS_DEFAULT_DAYS = 90;
export const DRIVERS_MIN_DAYS = 30;
export const DRIVERS_MAX_DAYS = 180;

/** Pairs (nights) a behaviour-outcome test, focus buckets and status "available" need */
export const DRIVERS_MIN_PAIRS = 14;

/** Distinct behaviour values a continuous test needs */
export const DRIVERS_MIN_DISTINCT_VALUES = 5;

/** Effective sample size a test needs after the autocorrelation correction */
export const DRIVERS_MIN_EFFECTIVE_SAMPLE = 10;

/** Nights each group of a binary behaviour needs */
export const DRIVERS_MIN_GROUP_SIZE = 5;

/** Largest q-value (false discovery rate) of a consistent finding */
export const DRIVERS_CONSISTENT_MAX_Q = 0.1;

/** Largest p-value of a consistent binary finding */
export const DRIVERS_CONSISTENT_MAX_P = 0.05;

/** A workout ending at most this many hours before sleep onset is a late workout */
export const LATE_WORKOUT_HOURS = 3;

/** Nights a focus bucket needs before its outcome statistics are shown */
export const DRIVERS_MIN_BUCKET_SIZE = 3;

/** Days a recovery zone needs before same_day strain statistics are shown */
export const SAME_DAY_MIN_PER_ZONE = 3;

/** Nights each evening_training group needs before means are shown */
export const EVENING_TRAINING_MIN_GROUP = 5;

/** Longest findings and not_tested lists */
export const DRIVERS_LIST_CAP = 40;

/**
 * Smallest p- or q-value reported: the normal approximations behind them are
 * not accurate below this, so smaller values are reported as this floor
 */
export const DRIVERS_MIN_REPORTED_P = 1e-6;

/** Upper bounds of the strength labels for |rho| or |Cliff's delta| */
export const STRENGTH_NEGLIGIBLE_BELOW = 0.1;
export const STRENGTH_SMALL_BELOW = 0.3;
export const STRENGTH_MODERATE_BELOW = 0.5;

/** WHOOP's strain bands (the last band includes 21) */
export const WHOOP_STRAIN_BANDS = [
  { label: "Light", low: 0, high: 10 },
  { label: "Moderate", low: 10, high: 14 },
  { label: "High", low: 14, high: 18 },
  { label: "All out", low: 18, high: 21 },
] as const;

export const DRIVER_OUTCOMES = [
  "recovery",
  "hrv",
  "rhr",
  "sleep_performance",
  "asleep_hours",
] as const;
export type DriverOutcome = (typeof DRIVER_OUTCOMES)[number];

const DEFAULT_OUTCOMES: readonly DriverOutcome[] = ["recovery", "hrv", "rhr"];

export const DRIVER_BEHAVIOURS = [
  "asleep_hours",
  "bedtime_min",
  "bedtime_deviation_min",
  "prior_day_strain",
  "prior_day_trimp",
  "prior_day_workout_minutes",
  "hard_zone_minutes",
  "late_workout",
  "last_workout_to_bed_min",
  "nap_before",
  "debt_entering_hours",
  "efficiency_pct",
  "disturbances_per_hour",
] as const;
export type DriverBehaviour = (typeof DRIVER_BEHAVIOURS)[number];

export const EXCLUSION_REASONS = [
  "calibrating",
  "pending",
  "unscored",
  "no_prior_cycle",
  "partial_or_in_progress",
  "short_or_long_cycle",
  "truncated_history",
] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

export const NOT_TESTED_REASONS = [
  "too_few_pairs",
  "too_few_distinct_values",
  "group_too_small",
  "data_unavailable",
  "tautological",
  "low_effective_sample",
] as const;
export type NotTestedReason = (typeof NOT_TESTED_REASONS)[number];

const RECOVERY_OUTCOMES: ReadonlySet<DriverOutcome> = new Set(["recovery", "hrv", "rhr"]);

/** Behaviours taking the values 0 (no) and 1 (yes); tags are binary too */
const BINARY_BEHAVIOURS: ReadonlySet<string> = new Set(["late_workout", "nap_before"]);

/** Behaviours read from the workout stream */
const WORKOUT_BEHAVIOURS: ReadonlySet<string> = new Set([
  "prior_day_trimp",
  "prior_day_workout_minutes",
  "hard_zone_minutes",
  "late_workout",
  "last_workout_to_bed_min",
]);

/** Behaviour-outcome combinations where the behaviour is part of the outcome: never tested */
const TAUTOLOGICAL: Readonly<Record<string, readonly DriverOutcome[]>> = {
  asleep_hours: ["asleep_hours", "sleep_performance"],
  efficiency_pct: ["sleep_performance", "asleep_hours"],
  disturbances_per_hour: ["sleep_performance"],
  debt_entering_hours: ["sleep_performance"],
};

/** Sleep behaviours WHOOP's recovery values are partly built from */
const BY_CONSTRUCTION: ReadonlySet<string> = new Set([
  "asleep_hours",
  "efficiency_pct",
  "debt_entering_hours",
  "disturbances_per_hour",
]);

/**
 * Whether a tested combination is partly by construction: a sleep behaviour
 * WHOOP builds recovery values from, with a recovery outcome; or disturbances
 * per hour asleep with hours asleep (its denominator).
 */
function partlyByConstruction(behaviour: string, outcome: DriverOutcome): boolean {
  return (
    (BY_CONSTRUCTION.has(behaviour) && RECOVERY_OUTCOMES.has(outcome)) ||
    (behaviour === "disturbances_per_hour" && outcome === "asleep_hours")
  );
}

const TAG_PREFIX = "tag:";
const TAG_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MINUTE_MS = 60_000;

interface OutcomeMeta {
  label: string;
  /** How the outcome is written in text: next morning or the night itself */
  phrase: string;
  unit: string;
  digits: number;
}

const OUTCOME_META: Readonly<Record<DriverOutcome, OutcomeMeta>> = {
  recovery: {
    label: "recovery score",
    phrase: "next-morning recovery score",
    unit: "%",
    digits: 1,
  },
  hrv: { label: "HRV", phrase: "next-morning HRV", unit: "ms", digits: 1 },
  rhr: {
    label: "resting heart rate",
    phrase: "next-morning resting heart rate",
    unit: "bpm",
    digits: 1,
  },
  sleep_performance: {
    label: "sleep performance",
    phrase: "sleep performance that night",
    unit: "%",
    digits: 1,
  },
  asleep_hours: { label: "hours asleep", phrase: "hours asleep that night", unit: "h", digits: 2 },
};

interface BehaviourMeta {
  /** Completes "On nights ..." for the higher value (continuous) or the yes group (binary) */
  description: string;
  unit: string;
  digits: number;
}

const BEHAVIOUR_META: Readonly<Record<DriverBehaviour, BehaviourMeta>> = {
  asleep_hours: { description: "with more time asleep", unit: "h", digits: 2 },
  bedtime_min: {
    description: "with a later bedtime",
    unit: "minutes after local midnight",
    digits: 0,
  },
  bedtime_deviation_min: {
    description: "with a bedtime further from the usual bedtime",
    unit: "min",
    digits: 0,
  },
  prior_day_strain: { description: "after a higher day strain", unit: "strain", digits: 2 },
  prior_day_trimp: {
    description: "after a higher training load (Edwards TRIMP)",
    unit: "TRIMP",
    digits: 1,
  },
  prior_day_workout_minutes: {
    description: "after more workout minutes",
    unit: "min",
    digits: 1,
  },
  hard_zone_minutes: {
    description: "after more minutes in heart-rate zones 4-5",
    unit: "min",
    digits: 1,
  },
  late_workout: {
    description: `after a workout that ended within ${LATE_WORKOUT_HOURS} hours of sleep onset`,
    unit: "yes/no",
    digits: 0,
  },
  last_workout_to_bed_min: {
    description: "with more time between the last workout and sleep onset",
    unit: "min",
    digits: 0,
  },
  nap_before: { description: "after a nap earlier in the day", unit: "yes/no", digits: 0 },
  debt_entering_hours: {
    description: "entering with more sleep debt",
    unit: "h",
    digits: 2,
  },
  efficiency_pct: { description: "with higher sleep efficiency", unit: "%", digits: 1 },
  disturbances_per_hour: {
    description: "with more disturbances per hour asleep",
    unit: "per hour",
    digits: 2,
  },
};

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const outcomeSchema = z.enum(DRIVER_OUTCOMES);
const behaviourSchema = z.enum(DRIVER_BEHAVIOURS);

export const recoveryDriversInputSchema = z.object({
  days: z
    .number()
    .int()
    .min(DRIVERS_MIN_DAYS)
    .max(DRIVERS_MAX_DAYS)
    .optional()
    .describe(
      "Local wake days to analyse, ending today (30-180). Default 90. History for 2 more days is read so the first nights have their previous day."
    ),
  outcomes: z
    .array(outcomeSchema)
    .min(1)
    .max(5)
    .optional()
    .describe(
      "What behaviours are related to: next-morning recovery, hrv or rhr, or the night's own sleep_performance or asleep_hours. Default recovery, hrv, rhr. The first one is used for evening_training."
    ),
  include_calibrating: z
    .boolean()
    .optional()
    .describe("Include recoveries WHOOP flags as calibrating. Default false."),
  focus: behaviourSchema.optional().describe("Adds bucket means for one behaviour"),
  custom_tags: z
    .array(
      z.object({
        name: z.string().regex(TAG_NAME_PATTERN),
        dates: z.array(z.string().regex(DATE_PATTERN)).max(180),
      })
    )
    .max(3)
    .optional()
    .describe(
      "Behaviours the API cannot see (e.g. alcohol). A date D means the day/evening D before the sleep that ends on D+1; untagged days are assumed not to include it."
    ),
});
export type RecoveryDriversInput = z.infer<typeof recoveryDriversInputSchema>;

const count = z.number().int().nonnegative();
const finite = z.number().finite();
const nullableNumber = finite.nullable();

const excludedPairsSchema = z.object({
  calibrating: count,
  pending: count,
  unscored: count,
  no_prior_cycle: count,
  partial_or_in_progress: count,
  short_or_long_cycle: count,
  truncated_history: count,
});

const notTestedSummarySchema = z.object({
  too_few_pairs: count,
  too_few_distinct_values: count,
  group_too_small: count,
  data_unavailable: count,
  tautological: count,
  low_effective_sample: count,
});

const findingSchema = z.object({
  behaviour: z.string().describe("A behaviour name, or tag:<name> for a custom tag"),
  outcome: outcomeSchema,
  kind: z.enum(["continuous", "binary"]),
  n: count.describe("Nights with both values"),
  n_eff: count.describe("Effective sample size after the autocorrelation correction"),
  effect: z.object({
    spearman_rho: nullableNumber,
    cliffs_delta: nullableNumber.describe("Binary: nights with the behaviour versus without"),
    median_difference: nullableNumber.describe(
      "Binary: median outcome with the behaviour minus without, in `unit`"
    ),
    unit: z.string().describe("Unit of the outcome"),
  }),
  ci95: z.object({ low: finite, high: finite }).nullable().describe("95% CI of rho"),
  p: nullableNumber.describe(
    "Two-sided p-value corrected for autocorrelation; values below 0.000001 are reported as 0.000001"
  ),
  q: nullableNumber.describe(
    "Benjamini-Hochberg q-value over every test in this call; values below 0.000001 are reported as 0.000001"
  ),
  strength: z.enum(["negligible", "small", "moderate", "large"]),
  consistent: z.boolean(),
  partly_by_construction: z
    .boolean()
    .describe("The behaviour is part of how WHOOP measures or scores the outcome"),
  text: z.string(),
});

const bucketsSchema = z.object({
  behaviour: behaviourSchema,
  basis: z.enum(["whoop_strain_bands", "tertiles", "binary_groups"]),
  unit: z.string(),
  cut_points: z.array(finite).nullable(),
  pairs: count,
  groups: z.array(
    z.object({
      label: z.string(),
      low: nullableNumber,
      high: nullableNumber,
      n: count,
      outcomes: z.array(
        z.object({
          outcome: outcomeSchema,
          n: count,
          mean: nullableNumber,
          median: nullableNumber,
        })
      ),
    })
  ),
});

const zoneStatsSchema = z.object({
  days: count,
  strain_mean: nullableNumber,
  strain_median: nullableNumber,
});

const sameDaySchema = z.object({
  definition: z.string(),
  min_days_per_zone: count,
  zones: z.object({ green: zoneStatsSchema, yellow: zoneStatsSchema, red: zoneStatsSchema }),
});

const eveningTrainingSchema = z.object({
  definition: z.string(),
  outcome: outcomeSchema,
  late_days: count,
  other_days: count,
  late_outcome_mean: nullableNumber,
  other_outcome_mean: nullableNumber,
  difference: nullableNumber,
});

const tagSummarySchema = z.object({
  name: z.string(),
  dates_matched: count.describe("Tag dates whose following night is an analysed pair"),
  dates_outside_window: z.array(z.string()),
  dates_without_pair: z
    .array(z.string())
    .describe("Tag dates inside the window whose following night was not analysed"),
});

export const recoveryDriversOutputSchema = z.object({
  period: z.object({
    start: z.string(),
    end: z.string(),
    days: count,
    first_day: z.string().describe("First local wake day analysed"),
    last_day: z.string().describe("Last local wake day analysed (today)"),
  }),
  status: z.enum(["available", "insufficient_data", "calibrating", "unavailable"]),
  pairs_analyzed: count,
  pairs_required: count,
  excluded_pairs: excludedPairsSchema,
  findings: z.array(findingSchema),
  not_tested_summary: notTestedSummarySchema,
  not_tested: z.array(
    z.object({
      behaviour: z.string(),
      outcome: outcomeSchema,
      reason: z.enum(NOT_TESTED_REASONS),
      n: count,
    })
  ),
  buckets: bucketsSchema.nullable(),
  same_day: sameDaySchema.nullable(),
  evening_training: eveningTrainingSchema,
  tags: z.array(tagSummarySchema),
  output_capped: z.boolean(),
  truncated: z.boolean(),
  notes: z.array(z.string()),
  warnings: z.array(z.string()),
  disclaimer: z.string(),
  data_quality: dataQualitySchema,
});
export type RecoveryDriversReport = z.infer<typeof recoveryDriversOutputSchema>;
type Finding = z.infer<typeof findingSchema>;
type NotTested = RecoveryDriversReport["not_tested"][number];
type Buckets = z.infer<typeof bucketsSchema>;
type SameDay = z.infer<typeof sameDaySchema>;
type EveningTraining = z.infer<typeof eveningTrainingSchema>;
type TagSummary = z.infer<typeof tagSummarySchema>;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function plural(value: number, singular: string, pluralForm = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : pluralForm}`;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function isCalendarDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

function unreadable(quality: SourceQuality): boolean {
  return quality.status === "fetch_failed" || quality.status === "invalid";
}

function average(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** p- and q-values to 3 significant digits, never below DRIVERS_MIN_REPORTED_P */
function reportedP(value: number): number {
  return Number(Math.max(value, DRIVERS_MIN_REPORTED_P).toPrecision(3));
}

/** A fixed-decimal number for text */
function fixed(value: number, digits: number): string {
  return roundTo(value, digits).toFixed(digits);
}

/** Local clock minutes (0-1440) of an instant in the record's own offset */
function clockMinutes(timestamp: string, offset: string): number {
  const local = localTime(timestamp, offset);
  return (
    local.getUTCHours() * 60 +
    local.getUTCMinutes() +
    local.getUTCSeconds() / 60 +
    local.getUTCMilliseconds() / MINUTE_MS
  );
}

/** Clock minutes in 0-1439.x for a value unwrapped around a circular mean */
function wrapClock(minutes: number): number {
  return ((minutes % 1440) + 1440) % 1440;
}

function dayIndex(day: string): number {
  return Math.round(Date.parse(`${day}T00:00:00.000Z`) / DAY_MS);
}

/** The WHOOP strain band of a day strain (Light below 10, Moderate below 14, High below 18, else All out) */
export function strainBand(strain: number): (typeof WHOOP_STRAIN_BANDS)[number]["label"] {
  if (strain < 10) return "Light";
  if (strain < 14) return "Moderate";
  if (strain < 18) return "High";
  return "All out";
}

/** Strength label of |rho| or |Cliff's delta| */
export function strengthOf(effect: number): Finding["strength"] {
  const size = Math.abs(effect);
  if (size < STRENGTH_NEGLIGIBLE_BELOW) return "negligible";
  if (size < STRENGTH_SMALL_BELOW) return "small";
  if (size < STRENGTH_MODERATE_BELOW) return "moderate";
  return "large";
}

// ---------------------------------------------------------------------------
// Behaviours of one night
// ---------------------------------------------------------------------------

/** Behaviour values of one night before window-level processing (bedtime unwrapping, tags) */
export interface NightBehaviours {
  asleep_hours: number | null;
  /** Local clock minutes of sleep onset, 0-1440 (unwrapped later around the window's mean) */
  bedtime_clock_min: number | null;
  prior_day_strain: number | null;
  prior_day_trimp: number | null;
  prior_day_workout_minutes: number | null;
  hard_zone_minutes: number | null;
  late_workout: number | null;
  last_workout_to_bed_min: number | null;
  nap_before: number | null;
  debt_entering_hours: number | null;
  efficiency_pct: number | null;
  disturbances_per_hour: number | null;
  /** Workouts in the prior cycle that are not scored (their load values are unknown) */
  unscored_workouts: number;
  /** Scored workouts in the prior cycle recorded below MIN_RECORDED_FRACTION (load unknown) */
  low_recorded_workouts: number;
}

/**
 * Behaviour values of a night from its sleep, prior cycle, the prior cycle's
 * naps and workouts. Unknown is null, never 0:
 * - Workout values are null when workouts_in_prior_cycle is null (stream
 *   unavailable or history incomplete); a known day without workouts is 0
 *   (last_workout_to_bed_min is null then: it exists only on workout days).
 * - Timing values (minutes, late_workout, last workout to bed) use every
 *   workout with a positive duration. Load values (TRIMP, zone 4-5 minutes) are
 *   null when any workout is not scored or recorded less than 90% of its time.
 * - nap_before is null when any nap in the prior cycle is not scored.
 */
export function nightBehaviours(night: Night): NightBehaviours {
  const sleep = night.sleep;
  const sleepStartMs = Date.parse(sleep.start);
  const stages = stageBreakdown(sleep);
  const need = needBreakdown(sleep);
  const prior = night.prior_cycle;

  let minutes: number | null = null;
  let trimp: number | null = null;
  let hard: number | null = null;
  let late: number | null = null;
  let lastToBed: number | null = null;
  let unscoredWorkouts = 0;
  let lowRecordedWorkouts = 0;
  const workouts = night.workouts_in_prior_cycle;
  if (workouts !== null) {
    const valid = workouts.filter((workout) => Date.parse(workout.end) > Date.parse(workout.start));
    minutes = valid.reduce(
      (sum, workout) => sum + (Date.parse(workout.end) - Date.parse(workout.start)) / MINUTE_MS,
      0
    );
    for (const workout of valid) {
      if (workout.score_state !== "SCORED" || !workout.score) unscoredWorkouts += 1;
      else if (recordedFraction(workout.score.percent_recorded) < MIN_RECORDED_FRACTION)
        lowRecordedWorkouts += 1;
    }
    if (unscoredWorkouts === 0 && lowRecordedWorkouts === 0) {
      trimp = 0;
      hard = 0;
      for (const workout of valid) {
        const zones = zoneMinutes(workout.score!.zone_durations);
        trimp += edwardsTrimp(zones);
        hard += zones.zone_4 + zones.zone_5;
      }
    }
    const lastEndMs = valid.reduce(
      (latest, workout) => Math.max(latest, Date.parse(workout.end)),
      Number.NEGATIVE_INFINITY
    );
    late = valid.some(
      (workout) => sleepStartMs - Date.parse(workout.end) <= LATE_WORKOUT_HOURS * HOUR_MS
    )
      ? 1
      : 0;
    lastToBed = valid.length > 0 ? Math.max(0, (sleepStartMs - lastEndMs) / MINUTE_MS) : null;
  }

  const naps = night.naps_in_prior_cycle;
  const napBefore =
    naps === null || naps.some((nap) => nap.score_state !== "SCORED" || !nap.score)
      ? null
      : naps.length > 0
        ? 1
        : 0;

  return {
    asleep_hours: stages ? stages.asleep_min / 60 : null,
    bedtime_clock_min: clockMinutes(sleep.start, sleep.timezone_offset),
    prior_day_strain: prior ? cycleStrain(prior) : null,
    prior_day_trimp: trimp,
    prior_day_workout_minutes: minutes,
    hard_zone_minutes: hard,
    late_workout: late,
    last_workout_to_bed_min: lastToBed,
    nap_before: napBefore,
    debt_entering_hours: need ? need.debt : null,
    efficiency_pct: sleep.score?.sleep_efficiency_percentage ?? null,
    disturbances_per_hour: stages ? stages.disturbances_per_hour_asleep : null,
    unscored_workouts: unscoredWorkouts,
    low_recorded_workouts: lowRecordedWorkouts,
  };
}

// ---------------------------------------------------------------------------
// Pairs
// ---------------------------------------------------------------------------

interface Options {
  days: number;
  outcomes: DriverOutcome[];
  includeCalibrating: boolean;
  focus: DriverBehaviour | null;
  tags: { name: string; dates: string[] }[];
}

interface Pair {
  night: Night;
  dayIndex: number;
  values: Map<string, number | null>;
  outcomes: Record<DriverOutcome, number | null>;
  /** The recovery whose values are used, when a recovery outcome is */
  recoveryUsed: Recovery | null;
  unscoredWorkouts: number;
  lowRecordedWorkouts: number;
}

/** Which instants the loaded history is complete from */
interface Completeness {
  periodStartMs: number;
  /** max(cycles, sleeps) complete_since; null when either is null */
  nightsSinceMs: number | null;
  recoveriesSinceMs: number | null;
}

function sinceMs(source: HistorySource<unknown>): number | null {
  return source.complete_since === null ? null : Date.parse(source.complete_since);
}

/** True when `ms` lies before the complete part of the history (never for the requested start) */
function beforeComplete(ms: number, since: number | null, periodStartMs: number): boolean {
  return since === null || (since > periodStartMs && ms < since);
}

/** Why a night's own sleep cannot be used; null when it is scored */
function sleepExclusion(night: Night): ExclusionReason | null {
  if (night.sleep.score_state === "PENDING_SCORE") return "pending";
  if (night.sleep.score_state !== "SCORED" || !night.sleep.score) return "unscored";
  return null;
}

/**
 * Why a night's previous WHOOP day (prior cycle) cannot be used: missing, not
 * read completely, open or the partial first day, not scored, or shorter than
 * 12 / longer than 36 hours. Null when it can.
 */
function priorCycleExclusion(night: Night, completeness: Completeness): ExclusionReason | null {
  const { sleep, prior_cycle: prior, prior_flags: flags } = night;
  const { nightsSinceMs, periodStartMs } = completeness;
  if (!prior || !flags) {
    // Without a prior cycle in the complete part of the history, it may simply not have been read.
    if (
      nightsSinceMs === null ||
      (nightsSinceMs > periodStartMs && Date.parse(sleep.start) <= nightsSinceMs)
    )
      return "truncated_history";
    return "no_prior_cycle";
  }
  if (beforeComplete(Date.parse(prior.start), nightsSinceMs, periodStartMs))
    return "truncated_history";
  if (flags.open || flags.partial_first_day) return "partial_or_in_progress";
  if (prior.score_state === "PENDING_SCORE") return "pending";
  if (cycleStrain(prior) === null) return "unscored";
  if (flags.short || flags.long) return "short_or_long_cycle";
  return null;
}

/** Why a night's recovery cannot be used; null when it can */
function recoveryExclusion(
  night: Night,
  completeness: Completeness,
  includeCalibrating: boolean
): ExclusionReason | null {
  const recovery = night.recovery;
  if (!recovery) {
    return beforeComplete(
      Date.parse(night.sleep.start),
      completeness.recoveriesSinceMs,
      completeness.periodStartMs
    )
      ? "truncated_history"
      : "unscored";
  }
  if (recovery.score_state === "PENDING_SCORE") return "pending";
  if (recovery.score_state !== "SCORED" || !recovery.score) return "unscored";
  if (recovery.score.user_calibrating && !includeCalibrating) return "calibrating";
  return null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

interface TestedCombination {
  behaviour: string;
  outcome: DriverOutcome;
  kind: "continuous" | "binary";
  n: number;
  nEff: number;
  rho: number | null;
  delta: number | null;
  medianDifference: number | null;
  interval: { low: number; high: number } | null;
  p: number;
}

type Evaluation =
  | { tested: TestedCombination }
  | { notTested: { reason: NotTestedReason; n: number } };

function isTautological(behaviour: string, outcome: DriverOutcome): boolean {
  return TAUTOLOGICAL[behaviour]?.includes(outcome) ?? false;
}

function isBinary(behaviour: string): boolean {
  return BINARY_BEHAVIOURS.has(behaviour) || behaviour.startsWith(TAG_PREFIX);
}

/**
 * Test one behaviour-outcome combination, or say why it is not tested:
 * tautological, data_unavailable (its source could not be read, or no pair
 * has a value although enough pairs have the outcome), too_few_pairs,
 * group_too_small (binary), too_few_distinct_values or low_effective_sample.
 */
function evaluateCombination(
  behaviour: string,
  outcome: DriverOutcome,
  pairs: readonly Pair[],
  sources: { workoutsUnavailable: boolean; outcomeUnavailable: boolean }
): Evaluation {
  const withOutcome = pairs.filter((pair) => pair.outcomes[outcome] !== null);
  const both = withOutcome.filter(
    (pair) => pair.values.get(behaviour) !== null && pair.values.get(behaviour) !== undefined
  );
  const n = both.length;
  if (isTautological(behaviour, outcome)) return { notTested: { reason: "tautological", n } };
  if (
    sources.outcomeUnavailable ||
    (sources.workoutsUnavailable && WORKOUT_BEHAVIOURS.has(behaviour))
  )
    return { notTested: { reason: "data_unavailable", n } };
  if (n < DRIVERS_MIN_PAIRS) {
    const unavailable = withOutcome.length >= DRIVERS_MIN_PAIRS && n === 0;
    return { notTested: { reason: unavailable ? "data_unavailable" : "too_few_pairs", n } };
  }
  const xs = both.map((pair) => pair.values.get(behaviour) as number);
  const ys = both.map((pair) => pair.outcomes[outcome] as number);
  const r1x = lag1RankAutocorrelation(
    both.map((pair, index) => ({ index: pair.dayIndex, value: xs[index]! }))
  ).r1;
  const r1y = lag1RankAutocorrelation(
    both.map((pair, index) => ({ index: pair.dayIndex, value: ys[index]! }))
  ).r1;
  const nEff = effectiveSampleSize(n, r1x, r1y);

  if (isBinary(behaviour)) {
    const yes = ys.filter((_, index) => xs[index] === 1);
    const no = ys.filter((_, index) => xs[index] !== 1);
    if (yes.length < DRIVERS_MIN_GROUP_SIZE || no.length < DRIVERS_MIN_GROUP_SIZE)
      return { notTested: { reason: "group_too_small", n } };
    if (nEff < DRIVERS_MIN_EFFECTIVE_SAMPLE)
      return { notTested: { reason: "low_effective_sample", n } };
    const test = mannWhitney(yes, no, nEff / n);
    const delta = cliffsDelta(yes, no);
    if (test === null || delta === null)
      return { notTested: { reason: "too_few_distinct_values", n } };
    return {
      tested: {
        behaviour,
        outcome,
        kind: "binary",
        n,
        nEff,
        rho: null,
        delta,
        medianDifference: median(yes) - median(no),
        interval: null,
        p: test.p,
      },
    };
  }

  if (new Set(xs).size < DRIVERS_MIN_DISTINCT_VALUES)
    return { notTested: { reason: "too_few_distinct_values", n } };
  const rho = spearman(xs, ys);
  // A constant outcome has no ranks to correlate.
  if (rho === null) return { notTested: { reason: "too_few_distinct_values", n } };
  if (nEff < DRIVERS_MIN_EFFECTIVE_SAMPLE)
    return { notTested: { reason: "low_effective_sample", n } };
  const interval = correlationInterval(rho, nEff);
  if (interval === null) return { notTested: { reason: "low_effective_sample", n } };
  return {
    tested: {
      behaviour,
      outcome,
      kind: "continuous",
      n,
      nEff,
      rho,
      delta: null,
      medianDifference: null,
      interval: { low: interval.low, high: interval.high },
      p: interval.p,
    },
  };
}

function behaviourDescription(behaviour: string): string {
  if (behaviour.startsWith(TAG_PREFIX))
    return `after days tagged "${behaviour.slice(TAG_PREFIX.length)}"`;
  return BEHAVIOUR_META[behaviour as DriverBehaviour].description;
}

function findingText(test: TestedCombination, consistent: boolean): string {
  if (!consistent) return `No consistent association found (n=${test.n}).`;
  const outcome = OUTCOME_META[test.outcome];
  const effect = test.rho ?? test.delta ?? 0;
  const direction = effect > 0 ? "higher" : "lower";
  // Resting heart rate states the direction only (no strength label).
  const strength = test.outcome === "rhr" ? "" : `${strengthOf(effect)} association: `;
  const statistics =
    test.kind === "continuous" && test.interval
      ? `rho ${fixed(test.rho ?? 0, 2)}, 95% CI ${fixed(test.interval.low, 2)} to ${fixed(test.interval.high, 2)}`
      : `Cliff's delta ${fixed(test.delta ?? 0, 2)}, median difference ${fixed(test.medianDifference ?? 0, outcome.digits)}${outcome.unit === "%" ? "" : " "}${outcome.unit}`;
  return `On nights ${behaviourDescription(test.behaviour)}, ${outcome.phrase} tended to be ${direction} (${strength}${statistics}, n=${test.n}).`;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function outcomeStats(
  pairs: readonly Pair[],
  outcomes: readonly DriverOutcome[]
): Buckets["groups"][number]["outcomes"] {
  return outcomes.map((outcome) => {
    const values = pairs
      .map((pair) => pair.outcomes[outcome])
      .filter((value): value is number => value !== null);
    const digits = OUTCOME_META[outcome].digits;
    const shown = values.length >= DRIVERS_MIN_BUCKET_SIZE;
    return {
      outcome,
      n: values.length,
      mean: shown ? roundTo(average(values), digits) : null,
      median: shown ? roundTo(median(values), digits) : null,
    };
  });
}

function buildBuckets(
  focus: DriverBehaviour,
  pairs: readonly Pair[],
  outcomes: readonly DriverOutcome[]
): Buckets | null {
  const withValue = pairs.filter(
    (pair) => pair.values.get(focus) !== null && pair.values.get(focus) !== undefined
  );
  if (withValue.length < DRIVERS_MIN_PAIRS) return null;
  const valueOf = (pair: Pair): number => pair.values.get(focus) as number;
  const meta = BEHAVIOUR_META[focus];
  const display = (value: number): number =>
    roundTo(focus === "bedtime_min" ? wrapClock(value) : value, 2);

  if (focus === "prior_day_strain") {
    return {
      behaviour: focus,
      basis: "whoop_strain_bands",
      unit: meta.unit,
      cut_points: [10, 14, 18],
      pairs: withValue.length,
      groups: WHOOP_STRAIN_BANDS.map((band) => {
        const members = withValue.filter((pair) => strainBand(valueOf(pair)) === band.label);
        return {
          label: band.label,
          low: band.low,
          high: band.high,
          n: members.length,
          outcomes: outcomeStats(members, outcomes),
        };
      }),
    };
  }

  if (BINARY_BEHAVIOURS.has(focus)) {
    return {
      behaviour: focus,
      basis: "binary_groups",
      unit: meta.unit,
      cut_points: null,
      pairs: withValue.length,
      groups: [0, 1].map((flag) => {
        const members = withValue.filter((pair) => valueOf(pair) === flag);
        return {
          label: flag === 1 ? "yes" : "no",
          low: null,
          high: null,
          n: members.length,
          outcomes: outcomeStats(members, outcomes),
        };
      }),
    };
  }

  const cuts = quantileCuts(withValue.map(valueOf), 3)!;
  const [lowerCut, upperCut] = [cuts[0]!, cuts[1]!];
  const groups = [
    { label: "lower third", test: (value: number) => value <= lowerCut, low: null, high: lowerCut },
    {
      label: "middle third",
      test: (value: number) => value > lowerCut && value <= upperCut,
      low: lowerCut,
      high: upperCut,
    },
    { label: "upper third", test: (value: number) => value > upperCut, low: upperCut, high: null },
  ];
  return {
    behaviour: focus,
    basis: "tertiles",
    unit: meta.unit,
    cut_points: cuts.map(display),
    pairs: withValue.length,
    groups: groups.map((group) => {
      const members = withValue.filter((pair) => group.test(valueOf(pair)));
      return {
        label: group.label,
        low: group.low === null ? null : display(group.low),
        high: group.high === null ? null : display(group.high),
        n: members.length,
        outcomes: outcomeStats(members, outcomes),
      };
    }),
  };
}

/**
 * Day strain of each previous WHOOP day of a night in the window that passes
 * the pair criteria for a previous day (the prior_day_strain basis), grouped
 * by that day's own morning recovery zone (the recovery scored for the main
 * sleep that started the day). Also returns the cycles and recoveries used.
 */
function buildSameDay(
  nights: readonly Night[],
  windowNights: readonly Night[],
  completeness: Completeness,
  includeCalibrating: boolean
): { section: SameDay; cycles: Cycle[]; recoveries: Recovery[] } {
  // The night whose sleep started a cycle carries that cycle's morning recovery.
  const nightByCycle = new Map<number, Night>();
  for (const night of nights) nightByCycle.set(night.sleep.cycle_id, night);
  const strains: Record<RecoveryZone, number[]> = { green: [], yellow: [], red: [] };
  const seen = new Set<number>();
  const usedCycles: Cycle[] = [];
  const usedRecoveries: Recovery[] = [];
  for (const night of windowNights) {
    const prior = night.prior_cycle;
    if (!prior || seen.has(prior.id)) continue;
    // The same criteria as a pair's previous day.
    if (priorCycleExclusion(night, completeness) !== null) continue;
    const morning = nightByCycle.get(prior.id);
    const recovery = morning?.recovery;
    if (!recovery || recovery.score_state !== "SCORED" || !recovery.score) continue;
    if (recovery.score.user_calibrating && !includeCalibrating) continue;
    const strain = cycleStrain(prior);
    if (strain === null) continue;
    seen.add(prior.id);
    usedCycles.push(prior);
    usedRecoveries.push(recovery);
    strains[recoveryZone(recovery.score.recovery_score)].push(strain);
  }
  const stats = (values: number[]): SameDay["zones"]["green"] => {
    const shown = values.length >= SAME_DAY_MIN_PER_ZONE;
    return {
      days: values.length,
      strain_mean: shown ? roundTo(average(values), 2) : null,
      strain_median: shown ? roundTo(median(values), 2) : null,
    };
  };
  return {
    section: {
      definition: `Day strain of each complete, scored WHOOP day before a night in the window (the prior_day_strain days), grouped by that day's own morning recovery zone (green 67-100, yellow 34-66, red 0-33${includeCalibrating ? "" : "; calibrating recoveries excluded"}). Mean and median need ${SAME_DAY_MIN_PER_ZONE} days per zone.`,
      min_days_per_zone: SAME_DAY_MIN_PER_ZONE,
      zones: {
        green: stats(strains.green),
        yellow: stats(strains.yellow),
        red: stats(strains.red),
      },
    },
    cycles: usedCycles,
    recoveries: usedRecoveries,
  };
}

function buildEveningTraining(pairs: readonly Pair[], outcome: DriverOutcome): EveningTraining {
  const late: number[] = [];
  const other: number[] = [];
  for (const pair of pairs) {
    const value = pair.outcomes[outcome];
    const flag = pair.values.get("late_workout");
    if (value === null || flag === null || flag === undefined) continue;
    (flag === 1 ? late : other).push(value);
  }
  const digits = OUTCOME_META[outcome].digits;
  const enough =
    late.length >= EVENING_TRAINING_MIN_GROUP && other.length >= EVENING_TRAINING_MIN_GROUP;
  const lateMean = enough ? average(late) : null;
  const otherMean = enough ? average(other) : null;
  return {
    definition: `Mean ${OUTCOME_META[outcome].phrase} after days with a workout that ended within ${LATE_WORKOUT_HOURS} hours before sleep onset (late) and after other days with known workouts (including days without workouts); means need ${EVENING_TRAINING_MIN_GROUP} nights in each group.`,
    outcome,
    late_days: late.length,
    other_days: other.length,
    late_outcome_mean: roundTo(lateMean, digits),
    other_outcome_mean: roundTo(otherMean, digits),
    difference:
      lateMean === null || otherMean === null ? null : roundTo(lateMean - otherMean, digits),
  };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

function normalizeOptions(args: RecoveryDriversInput): Options {
  const tags: Options["tags"] = [];
  const names = new Set<string>();
  for (const tag of args.custom_tags ?? []) {
    const key = tag.name.trim().toLowerCase();
    if (names.has(key)) {
      throw new InvalidDateExpression(
        `custom_tags uses the name "${tag.name}" more than once; give each tag a different name.`
      );
    }
    names.add(key);
    for (const date of tag.dates) {
      if (!isCalendarDate(date)) {
        throw new InvalidDateExpression(
          `Invalid calendar date "${date}" in custom tag "${tag.name}".`
        );
      }
    }
    tags.push({ name: tag.name, dates: [...new Set(tag.dates)].sort() });
  }
  return {
    days: args.days ?? DRIVERS_DEFAULT_DAYS,
    outcomes: [...new Set(args.outcomes ?? DEFAULT_OUTCOMES)],
    includeCalibrating: args.include_calibrating ?? false,
    focus: args.focus ?? null,
    tags,
  };
}

const SOURCE_LABELS = {
  cycle: "Cycle",
  sleep: "Sleep",
  recovery: "Recovery",
  workout: "Workout",
} as const;

const EXCLUSION_PHRASES: Readonly<Record<ExclusionReason, [string, string]>> = {
  calibrating: ["with a calibrating recovery", "with calibrating recoveries"],
  pending: ["still being scored by WHOOP", "still being scored by WHOOP"],
  unscored: ["without a score", "without a score"],
  no_prior_cycle: [
    "without a previous WHOOP day (for example after the strap was off)",
    "without a previous WHOOP day (for example after the strap was off)",
  ],
  partial_or_in_progress: [
    "after the partial first day of wear or a day still in progress",
    "after the partial first day of wear or a day still in progress",
  ],
  short_or_long_cycle: [
    "after a WHOOP day shorter than 12 or longer than 36 hours",
    "after a WHOOP day shorter than 12 or longer than 36 hours",
  ],
  truncated_history: [
    "before the part of the history that could be read completely",
    "before the part of the history that could be read completely",
  ],
};

async function runRecoveryDrivers(
  args: RecoveryDriversInput,
  ctx: ToolContext
): Promise<RecoveryDriversReport> {
  const options = normalizeOptions(args);
  const now = ctx.now();
  const nowMs = now.getTime();
  const offsetInfo = await resolveUserUtcOffsetInfo(ctx.client);
  const offset = offsetInfo.offset;
  const lastDay = localDay(now.toISOString(), offset);
  const firstDay = addDays(lastDay, -(options.days - 1));
  const range = fetchRangeForDays(firstDay, lastDay, offset, nowMs);
  const period = { start: iso(range.startMs), end: iso(Math.max(range.startMs, range.endMs)) };
  const budget = createHistoryBudget({ deadlineMs: ctx.startedAtMs + HISTORY_DEADLINE_MS });
  const historyOptions = {
    budget,
    now: () => now,
    ...(ctx.historyCache !== undefined ? { cache: ctx.historyCache } : {}),
  };
  const [cycles, sleeps, recoveries, workouts] = await Promise.all([
    loadHistory<Cycle>(ctx.client, "/v2/cycle", period, cycleRecordSchema, historyOptions),
    loadHistory<Sleep>(ctx.client, "/v2/activity/sleep", period, sleepRecordSchema, historyOptions),
    loadHistory<Recovery>(ctx.client, "/v2/recovery", period, recoveryRecordSchema, historyOptions),
    loadHistory<Workout>(
      ctx.client,
      "/v2/activity/workout",
      period,
      workoutRecordSchema,
      historyOptions
    ),
  ]);
  const sources = { cycle: cycles, sleep: sleeps, recovery: recoveries, workout: workouts };
  if (Object.values(sources).every((source) => source.quality.status === "fetch_failed")) {
    throw mostRelevantError(Object.values(sources).map((source) => source.error));
  }

  const warnings: string[] = [];
  const notes: string[] = [];
  const failed = (Object.keys(sources) as (keyof typeof sources)[]).filter((key) =>
    unreadable(sources[key].quality)
  );
  const recoveryUnreadable = failed.includes("recovery");
  const requestedRecovery = options.outcomes.filter((outcome) => RECOVERY_OUTCOMES.has(outcome));
  const onlyRecoveryOutcomes = requestedRecovery.length === options.outcomes.length;
  // Recovery outcomes are analysed only when the recovery stream could be read;
  // with sleep outcomes also requested, a failed stream leaves those analysable.
  const wantsRecovery = requestedRecovery.length > 0 && !recoveryUnreadable;
  const unavailableOutcomes: ReadonlySet<DriverOutcome> = new Set(
    recoveryUnreadable ? requestedRecovery : []
  );
  const consequences: Record<keyof typeof sources, string> = {
    cycle: "nights cannot be paired with their previous day without it",
    sleep: "nights cannot be identified without it",
    recovery:
      requestedRecovery.length === 0
        ? "same_day is unavailable"
        : onlyRecoveryOutcomes
          ? "recovery, HRV and resting heart rate outcomes and same_day are unavailable"
          : "recovery, HRV and resting heart rate outcomes are not tested (data_unavailable) and same_day is unavailable",
    workout:
      "workout behaviours are not tested (data_unavailable) and evening_training has no nights",
  };
  for (const key of failed) {
    const quality = sources[key].quality;
    warnings.push(
      `${SOURCE_LABELS[key]} data could not be read from WHOOP (${
        quality.status === "fetch_failed"
          ? "the request failed"
          : "WHOOP returned data in an unexpected format"
      }); ${consequences[key]}.`
    );
  }
  const requiredFailed = failed.filter(
    (key) =>
      key === "cycle" ||
      key === "sleep" ||
      (key === "recovery" && requestedRecovery.length > 0 && onlyRecoveryOutcomes)
  );
  const workoutsUnavailable = failed.includes("workout");

  // --- Nights and pairs ------------------------------------------------------------

  const placement = placeDays({
    cycles: cycles.records,
    sleeps: sleeps.records,
    recoveries: recoveries.records,
    sleepsAvailable: !unreadable(sleeps.quality),
    today: lastDay,
    utcOffset: offset,
  });
  const { nights } = buildNights({
    sleeps: sleeps.records,
    cycles: cycles.records,
    recoveries: recoveries.records,
    workouts: workoutsUnavailable ? null : workouts.records,
    workoutsCompleteSince: workouts.complete_since,
    placement,
    nowMs,
  });
  const windowNights = nights
    .filter((night) => night.wake_day >= firstDay && night.wake_day <= lastDay)
    .reverse();
  const cyclesSince = sinceMs(cycles);
  const sleepsSince = sinceMs(sleeps);
  const completeness: Completeness = {
    periodStartMs: range.startMs,
    nightsSinceMs:
      cyclesSince === null || sleepsSince === null ? null : Math.max(cyclesSince, sleepsSince),
    recoveriesSinceMs: sinceMs(recoveries),
  };

  const excluded: Record<ExclusionReason, number> = {
    calibrating: 0,
    pending: 0,
    unscored: 0,
    no_prior_cycle: 0,
    partial_or_in_progress: 0,
    short_or_long_cycle: 0,
    truncated_history: 0,
  };
  const pairs: Pair[] = [];
  // Nights used for sleep outcomes only, by why their recovery could not be used.
  const recoveryOnly: Record<ExclusionReason, number> = {
    calibrating: 0,
    pending: 0,
    unscored: 0,
    no_prior_cycle: 0,
    partial_or_in_progress: 0,
    short_or_long_cycle: 0,
    truncated_history: 0,
  };
  if (requiredFailed.length === 0) {
    for (const night of windowNights) {
      const sleepReason = sleepExclusion(night);
      if (sleepReason !== null) {
        excluded[sleepReason] += 1;
        exclude(sleeps.quality, sleepReason);
        continue;
      }
      const priorReason = priorCycleExclusion(night, completeness);
      if (priorReason !== null) {
        excluded[priorReason] += 1;
        exclude(cycles.quality, priorReason);
        continue;
      }
      const recoveryReason = wantsRecovery
        ? recoveryExclusion(night, completeness, options.includeCalibrating)
        : null;
      const recoveryUsed = wantsRecovery && recoveryReason === null ? night.recovery : null;
      const recoveryScore = recoveryUsed?.score ?? null;
      const stages = stageBreakdown(night.sleep);
      const outcomes: Record<DriverOutcome, number | null> = {
        recovery: recoveryScore ? recoveryScore.recovery_score : null,
        hrv: recoveryScore ? recoveryScore.hrv_rmssd_milli : null,
        rhr: recoveryScore ? recoveryScore.resting_heart_rate : null,
        sleep_performance: night.sleep.score?.sleep_performance_percentage ?? null,
        asleep_hours: stages ? stages.asleep_min / 60 : null,
      };
      const usable = options.outcomes.some((outcome) => outcomes[outcome] !== null);
      if (!usable) {
        const reason = recoveryReason ?? "unscored";
        excluded[reason] += 1;
        exclude(recoveryReason !== null ? recoveries.quality : sleeps.quality, reason);
        continue;
      }
      if (recoveryReason !== null) {
        recoveryOnly[recoveryReason] += 1;
        exclude(recoveries.quality, recoveryReason);
      }
      const behaviours = nightBehaviours(night);
      const values = new Map<string, number | null>([
        ["asleep_hours", behaviours.asleep_hours],
        ["bedtime_min", behaviours.bedtime_clock_min],
        ["bedtime_deviation_min", null],
        ["prior_day_strain", behaviours.prior_day_strain],
        ["prior_day_trimp", behaviours.prior_day_trimp],
        ["prior_day_workout_minutes", behaviours.prior_day_workout_minutes],
        ["hard_zone_minutes", behaviours.hard_zone_minutes],
        ["late_workout", behaviours.late_workout],
        ["last_workout_to_bed_min", behaviours.last_workout_to_bed_min],
        ["nap_before", behaviours.nap_before],
        ["debt_entering_hours", behaviours.debt_entering_hours],
        ["efficiency_pct", behaviours.efficiency_pct],
        ["disturbances_per_hour", behaviours.disturbances_per_hour],
      ]);
      pairs.push({
        night,
        dayIndex: dayIndex(night.wake_day),
        values,
        outcomes,
        recoveryUsed,
        unscoredWorkouts: behaviours.unscored_workouts,
        lowRecordedWorkouts: behaviours.low_recorded_workouts,
      });
    }
  }

  // Bedtimes unwrapped around the window's circular mean, so 23:30 sorts before 00:30.
  const bedtimeMean = circularStats(
    pairs
      .map((pair) => pair.values.get("bedtime_min"))
      .filter((value): value is number => value !== null && value !== undefined)
  ).mean;
  for (const pair of pairs) {
    const clock = pair.values.get("bedtime_min");
    if (clock === null || clock === undefined) continue;
    if (bedtimeMean === null) {
      pair.values.set("bedtime_deviation_min", null);
      continue;
    }
    const delta = circularSignedDeltaMinutes(clock, bedtimeMean);
    pair.values.set("bedtime_min", bedtimeMean + delta);
    pair.values.set("bedtime_deviation_min", Math.abs(delta));
  }

  // Custom tags: prior day === tag date; untagged days count as without the tag.
  const tagSummaries: TagSummary[] = [];
  const earliestTagDay = addDays(firstDay, -1);
  const latestTagDay = addDays(lastDay, -1);
  for (const tag of options.tags) {
    const dates = new Set(tag.dates);
    const key = `${TAG_PREFIX}${tag.name}`;
    const matched = new Set<string>();
    for (const pair of pairs) {
      const day = pair.night.prior_day;
      const tagged = day !== null && dates.has(day);
      if (tagged) matched.add(day);
      pair.values.set(key, tagged ? 1 : 0);
    }
    tagSummaries.push({
      name: tag.name,
      dates_matched: matched.size,
      dates_outside_window: tag.dates.filter(
        (date) => date < earliestTagDay || date > latestTagDay
      ),
      dates_without_pair: tag.dates.filter(
        (date) => date >= earliestTagDay && date <= latestTagDay && !matched.has(date)
      ),
    });
  }

  // --- Tests -------------------------------------------------------------------------

  const behaviourKeys = [
    ...DRIVER_BEHAVIOURS,
    ...options.tags.map((tag) => `${TAG_PREFIX}${tag.name}`),
  ];
  const tested: TestedCombination[] = [];
  const notTested: NotTested[] = [];
  for (const behaviour of behaviourKeys) {
    for (const outcome of options.outcomes) {
      if (requiredFailed.length > 0) {
        notTested.push({
          behaviour,
          outcome,
          reason: isTautological(behaviour, outcome) ? "tautological" : "data_unavailable",
          n: 0,
        });
        continue;
      }
      const evaluation = evaluateCombination(behaviour, outcome, pairs, {
        workoutsUnavailable,
        outcomeUnavailable: unavailableOutcomes.has(outcome),
      });
      if ("tested" in evaluation) tested.push(evaluation.tested);
      else notTested.push({ behaviour, outcome, ...evaluation.notTested });
    }
  }
  const qValues = benjaminiHochberg(tested.map((test) => test.p));
  const ranked = tested.map((test, index) => {
    const q = qValues[index]!;
    const effect = test.rho ?? test.delta ?? 0;
    const consistent =
      effect !== 0 &&
      q <= DRIVERS_CONSISTENT_MAX_Q &&
      (test.kind === "continuous"
        ? test.interval !== null && (test.interval.low > 0 || test.interval.high < 0)
        : test.p <= DRIVERS_CONSISTENT_MAX_P);
    const unit = OUTCOME_META[test.outcome].unit;
    const finding: Finding = {
      behaviour: test.behaviour,
      outcome: test.outcome,
      kind: test.kind,
      n: test.n,
      n_eff: test.nEff,
      effect: {
        spearman_rho: roundTo(test.rho, 3),
        cliffs_delta: roundTo(test.delta, 3),
        median_difference: roundTo(test.medianDifference, OUTCOME_META[test.outcome].digits),
        unit,
      },
      ci95: test.interval
        ? { low: roundTo(test.interval.low, 3), high: roundTo(test.interval.high, 3) }
        : null,
      p: reportedP(test.p),
      q: reportedP(q),
      strength: strengthOf(effect),
      consistent,
      partly_by_construction: partlyByConstruction(test.behaviour, test.outcome),
      text: findingText(test, consistent),
    };
    return { finding, size: Math.abs(effect), index };
  });
  // Consistent first, then by |rho| or |delta| (unrounded); ties keep behaviour and outcome order.
  ranked.sort(
    (left, right) =>
      Number(right.finding.consistent) - Number(left.finding.consistent) ||
      right.size - left.size ||
      left.index - right.index
  );
  const allFindings = ranked.map((entry) => entry.finding);
  const findings = allFindings.slice(0, DRIVERS_LIST_CAP);
  const summary: Record<NotTestedReason, number> = {
    too_few_pairs: 0,
    too_few_distinct_values: 0,
    group_too_small: 0,
    data_unavailable: 0,
    tautological: 0,
    low_effective_sample: 0,
  };
  for (const entry of notTested) summary[entry.reason] += 1;
  const outputCapped = allFindings.length > DRIVERS_LIST_CAP || notTested.length > DRIVERS_LIST_CAP;

  // --- Sections ----------------------------------------------------------------------

  let buckets: Buckets | null = null;
  if (options.focus !== null && requiredFailed.length === 0) {
    buckets = buildBuckets(options.focus, pairs, options.outcomes);
  }
  const sameDayResult =
    unreadable(cycles.quality) || unreadable(sleeps.quality) || recoveryUnreadable
      ? null
      : buildSameDay(nights, windowNights, completeness, options.includeCalibrating);
  const eveningTraining = buildEveningTraining(pairs, options.outcomes[0]!);

  // --- Status and notes --------------------------------------------------------------

  const pairsAnalyzed = pairs.length;
  const calibratingNights = excluded.calibrating + recoveryOnly.calibrating;
  const status: RecoveryDriversReport["status"] =
    requiredFailed.length > 0
      ? "unavailable"
      : pairsAnalyzed < DRIVERS_MIN_PAIRS
        ? calibratingNights > 0
          ? "calibrating"
          : "insufficient_data"
        : "available";
  const consistentCount = allFindings.filter((finding) => finding.consistent).length;
  const pairDefinition = `a night with a scored main sleep after a complete, scored previous WHOOP day${
    wantsRecovery ? " (recovery outcomes also need a scored next-morning recovery)" : ""
  }`;
  if (status === "unavailable") {
    notes.push(
      `No patterns were tested: required WHOOP data could not be read (${requiredFailed
        .map((key) => SOURCE_LABELS[key].toLowerCase())
        .join(", ")}).`
    );
  } else if (status === "calibrating") {
    notes.push(
      `WHOOP is still calibrating: ${plural(calibratingNights, "night")} with a calibrating recovery ${
        calibratingNights === 1 ? "is" : "are"
      } left out of recovery outcomes by default (include_calibrating: true includes them). ${pairsAnalyzed} of ${DRIVERS_MIN_PAIRS} pairs required so far; a pair is ${pairDefinition}.`
    );
  } else if (status === "insufficient_data") {
    notes.push(
      `Not enough nights yet: ${pairsAnalyzed} of ${DRIVERS_MIN_PAIRS} pairs required; a pair is ${pairDefinition}.`
    );
  } else {
    notes.push(
      `${plural(pairsAnalyzed, "pair")} analysed; ${plural(tested.length, "behaviour-outcome combination")} tested, ${consistentCount} consistent.`
    );
  }
  const exclusionParts = EXCLUSION_REASONS.filter((reason) => excluded[reason] > 0).map(
    (reason) => `${excluded[reason]} ${EXCLUSION_PHRASES[reason][excluded[reason] === 1 ? 0 : 1]}`
  );
  if (exclusionParts.length > 0) notes.push(`Nights not used: ${exclusionParts.join("; ")}.`);
  const recoveryOnlyParts = EXCLUSION_REASONS.filter((reason) => recoveryOnly[reason] > 0).map(
    (reason) =>
      `${recoveryOnly[reason]} ${EXCLUSION_PHRASES[reason][recoveryOnly[reason] === 1 ? 0 : 1]}`
  );
  if (recoveryOnlyParts.length > 0) {
    notes.push(
      `Nights used for sleep outcomes only, without a usable recovery: ${recoveryOnlyParts.join("; ")}.`
    );
  }
  notes.push(
    "These are observational associations in your own data: they show which values tended to move together, not what produced a change.",
    "Other factors (sleep, illness, alcohol, travel, WHOOP calibration) can move both a behaviour and the next morning's values.",
    `Consecutive days are not independent: the effective sample size (n_eff) corrects for part of that day-to-day autocorrelation, and q-values control the false discovery rate across all tests in this call. A finding is consistent when its 95% CI excludes 0 (binary behaviours: p <= ${DRIVERS_CONSISTENT_MAX_P}) and q <= ${DRIVERS_CONSISTENT_MAX_Q}.`
  );
  if (wantsRecovery) {
    notes.push(
      "WHOOP measures HRV and resting heart rate during sleep and builds recovery from sleep, so associations of hours asleep, sleep efficiency, sleep debt and disturbances with recovery values are partly by construction (partly_by_construction)."
    );
  }
  if (options.outcomes.includes("asleep_hours") && requiredFailed.length === 0) {
    notes.push(
      "Disturbances per hour are counted per hour asleep, so their association with hours asleep is partly by construction (partly_by_construction)."
    );
  }
  if (summary.tautological > 0) {
    notes.push(
      "Combinations where the behaviour is part of the outcome itself (for example hours asleep and sleep performance) are not tested (tautological)."
    );
  }
  if (options.focus === "prior_day_strain" || buckets?.basis === "whoop_strain_bands") {
    notes.push("Strain bands are WHOOP's: Light 0-10, Moderate 10-14, High 14-18, All out 18-21.");
  }
  if (options.focus !== null && buckets === null && requiredFailed.length === 0) {
    const withValue = pairs.filter(
      (pair) =>
        pair.values.get(options.focus!) !== null && pair.values.get(options.focus!) !== undefined
    ).length;
    notes.push(
      `Buckets for ${options.focus} need ${DRIVERS_MIN_PAIRS} pairs with a value (${withValue} of ${DRIVERS_MIN_PAIRS} so far).`
    );
  }
  if (options.tags.length > 0) {
    notes.push(
      "Custom tags: a tag date D refers to the day and evening before the sleep ending on D+1; days not listed for a tag are assumed to be without it."
    );
  }
  const unscoredWorkouts = pairs.reduce((sum, pair) => sum + pair.unscoredWorkouts, 0);
  const lowRecordedWorkouts = pairs.reduce((sum, pair) => sum + pair.lowRecordedWorkouts, 0);
  if (unscoredWorkouts + lowRecordedWorkouts > 0) {
    const parts = [
      ...(unscoredWorkouts > 0
        ? [`${plural(unscoredWorkouts, "workout")} not scored by WHOOP`]
        : []),
      ...(lowRecordedWorkouts > 0
        ? [
            `${plural(lowRecordedWorkouts, "workout")} with heart rate recorded for less than ${
              MIN_RECORDED_FRACTION * 100
            }% of the session`,
          ]
        : []),
    ];
    notes.push(
      `Before analysed nights there ${
        unscoredWorkouts + lowRecordedWorkouts === 1 ? "is" : "are"
      } ${parts.join(" and ")}; prior_day_trimp and hard_zone_minutes of those days are unknown (null), while workout minutes and late_workout still use them.`
    );
  }
  const truncated = Object.values(sources).some((source) => source.quality.truncated);
  const truncatedSources = (Object.keys(sources) as (keyof typeof sources)[]).filter(
    (key) => sources[key].quality.truncated && !failed.includes(key)
  );
  if (truncatedSources.length > 0) {
    const parts = truncatedSources.map((key) => {
      const since = sources[key].complete_since;
      return `${SOURCE_LABELS[key].toLowerCase()} ${
        since === null
          ? "not complete even for the most recent days"
          : `complete from ${formatLocalTimestamp(Date.parse(since), offset).slice(0, 10)}`
      }`;
    });
    notes.push(
      `Only part of the history could be read within this call's request and time budget (${parts.join(
        "; "
      )}). Nights whose previous day or recovery lies before the complete part are not used (truncated_history), and workout values before the complete part of the workout history are unknown. Repeating the request continues from the cache.`
    );
  }
  if (outputCapped) {
    notes.push(
      `findings and not_tested are each limited to ${DRIVERS_LIST_CAP} entries (output_capped); not_tested_summary counts every combination.`
    );
  }

  // --- Data quality ------------------------------------------------------------------

  // Records used: pairs' sleeps, previous days, their workouts and naps, the
  // recoveries of recovery outcomes, and the days and recoveries of same_day.
  const usedCycles = new Map<number, Cycle>();
  const usedSleeps = new Map<string, Sleep>();
  const usedRecoveries = new Map<number, Recovery>();
  const usedWorkouts = new Map<string, Workout>();
  for (const pair of pairs) {
    const prior = pair.night.prior_cycle;
    if (prior) usedCycles.set(prior.id, prior);
    usedSleeps.set(pair.night.sleep.id, pair.night.sleep);
    for (const nap of pair.night.naps_in_prior_cycle ?? []) usedSleeps.set(nap.id, nap);
    if (pair.recoveryUsed) usedRecoveries.set(pair.recoveryUsed.cycle_id, pair.recoveryUsed);
    for (const workout of pair.night.workouts_in_prior_cycle ?? [])
      usedWorkouts.set(workout.id, workout);
  }
  for (const cycle of sameDayResult?.cycles ?? []) usedCycles.set(cycle.id, cycle);
  for (const recovery of sameDayResult?.recoveries ?? [])
    usedRecoveries.set(recovery.cycle_id, recovery);
  finishQuality(cycles.quality, [...usedCycles.values()]);
  finishQuality(sleeps.quality, [...usedSleeps.values()]);
  finishQuality(recoveries.quality, [...usedRecoveries.values()]);
  finishQuality(workouts.quality, [...usedWorkouts.values()]);

  let observed: { start: string; end: string } | null = null;
  if (pairs.length > 0) {
    let first = pairs[0]!;
    let last = pairs[0]!;
    for (const pair of pairs) {
      if (Date.parse(pair.night.prior_cycle!.start) < Date.parse(first.night.prior_cycle!.start))
        first = pair;
      if (Date.parse(pair.night.sleep.end) > Date.parse(last.night.sleep.end)) last = pair;
    }
    const prior = first.night.prior_cycle!;
    observed = {
      start: formatLocalTimestamp(Date.parse(prior.start), prior.timezone_offset),
      end: formatLocalTimestamp(Date.parse(last.night.sleep.end), last.night.sleep.timezone_offset),
    };
  }

  const periodStart = formatLocalTimestamp(localMidnightMs(firstDay, offset), offset);
  const periodEnd = formatLocalTimestamp(nowMs, offset);
  return {
    period: {
      start: periodStart,
      end: periodEnd,
      days: options.days,
      first_day: firstDay,
      last_day: lastDay,
    },
    status,
    pairs_analyzed: pairsAnalyzed,
    pairs_required: DRIVERS_MIN_PAIRS,
    excluded_pairs: excluded,
    findings,
    not_tested_summary: summary,
    not_tested: notTested.slice(0, DRIVERS_LIST_CAP),
    buckets,
    same_day: sameDayResult?.section ?? null,
    evening_training: eveningTraining,
    tags: tagSummaries,
    output_capped: outputCapped,
    truncated,
    notes: withOffsetNote(notes, offsetInfo.fallback),
    warnings,
    disclaimer: DISCLAIMER,
    data_quality: {
      evaluated_at: formatLocalTimestamp(nowMs, offset),
      requested_period: { start: periodStart, end: periodEnd },
      observed_period: observed,
      sources: {
        cycle: cycles.quality,
        sleep: sleeps.quality,
        recovery: recoveries.quality,
        workout: workouts.quality,
      },
      method_version: "recovery-drivers-1",
      limitations: [
        "Observational associations within one person's data; they are not evidence of an effect and not medical advice.",
        "Behaviours the WHOOP API does not expose (alcohol, caffeine, stress, steps, journal entries) are only included through custom tags.",
        "Late workouts, workout minutes and training load come from WHOOP workouts only; strength exercises and heart-rate time series are not available.",
        ...HISTORY_LIMITATIONS,
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const RECOVERY_DRIVERS_TOOL = defineTool({
  name: RECOVERY_DRIVERS_TOOL_NAME,
  annotations: { readOnlyHint: true },
  standard: {
    title: "Recovery patterns",
    description:
      "Observational patterns between the previous day and evening (bedtime, hours asleep, day strain, training load, late workouts, naps, sleep debt, efficiency, disturbances, custom tags) and next-morning recovery, HRV, resting heart rate or the night's own sleep, over `days` (30-180, default 90). Each test needs 14 pairs of nights; status is calibrating or insufficient_data until then, with counts in excluded_pairs and notes. Spearman or Mann-Whitney tests use an effective sample size for day-to-day autocorrelation and Benjamini-Hochberg q-values; `consistent` needs a 95% CI excluding 0 (binary: p <= 0.05) and q <= 0.10. not_tested explains untested combinations. `focus` adds bucket means (WHOOP strain bands or tertiles); same_day groups day strain by that morning's recovery zone; evening_training compares nights after a workout ending within 3 hours of sleep onset; custom_tags adds behaviours the API cannot see. Associations only, not medical advice.",
    inputSchema: recoveryDriversInputSchema,
    outputSchema: recoveryDriversOutputSchema,
    run: runRecoveryDrivers,
  },
});
