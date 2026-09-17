/**
 * Tool: get_day
 *
 * One local day in detail, placed exactly as get_calendar places it (shared
 * day model): the WHOOP cycle shown on that day with its strain, energy and
 * heart rate, the recovery and main sleep joined to it, naps, workouts (on the
 * day of the cycle containing their start) with totals, the previous day's
 * strain and the next morning's recovery.
 *
 * The day is a local date ("today", "yesterday", YYYY-MM-DD or a date-time's
 * local day) or the day a given cycle is placed on. Records are read as
 * history (cached 30-day chunks) over fetchRangeForDays(day, day): two days
 * before (the cycle and sleep starting the evening before) and two days after
 * (workouts after local midnight and the next cycle's start).
 *
 * Unknown values are null, never 0. PENDING_SCORE and UNSCORABLE records keep
 * their identity and state but contribute no values. A failed source nulls its
 * sections with a warning; only when every source fails is the error returned.
 *
 * The loading, placement and data-quality helpers are shared with
 * export_health_data.
 */

import { z } from "zod";
import type { Cycle, Recovery, ScoreState, Sleep, Workout } from "../api/types.js";
import {
  WhoopApiError,
  WhoopAuthError,
  WhoopNetworkError,
  WhoopRateBudgetError,
} from "../api/client.js";
import {
  ENDPOINT_CYCLE,
  ENDPOINT_RECOVERY,
  ENDPOINT_SLEEP,
  ENDPOINT_WORKOUT,
} from "../api/endpoints.js";
import {
  cycleRecordSchema,
  recoveryRecordSchema,
  sleepRecordSchema,
  workoutRecordSchema,
} from "../api/record-schemas.js";
import {
  createHistoryBudget,
  HISTORY_DEADLINE_MS,
  HISTORY_LIMITATIONS,
  loadHistory,
  type HistoryBudget,
  type HistorySource,
} from "../api/history.js";
import {
  cycleDay,
  dataQualitySchema,
  DISCLAIMER,
  exclude,
  finishQuality,
  formatLocalTimestamp,
  HOUR_MS,
  localDay,
  localMidnightMs,
  mostRelevantError,
  recoveryZone,
  type DataQuality,
  type SourceQuality,
} from "./analytics-utils.js";
import { resolveUserUtcOffsetInfo, withOffsetNote } from "./collection-utils.js";
import { InvalidDateExpression, resolveDateExpression } from "./date-utils.js";
import {
  addDays,
  assignWorkouts,
  cycleStrain,
  fetchRangeForDays,
  isOpenCycle,
  localClock,
  nextCycle,
  placeDays,
  type DayPlacement,
  type WorkoutPlacement,
} from "./day-model.js";
import { needBreakdown, stageBreakdown, whoopConsistency } from "./sleep-metrics.js";
import { roundTo } from "./stats-utils.js";
import { defineTool, type ToolContext } from "./tool-definition.js";
import {
  HR_ZONE_CAVEAT_SPORT,
  kjToKcal,
  normalizeWorkout,
  roundWorkoutSummary,
  workoutSummarySchema,
  type WorkoutSummary,
  type ZoneMinutes,
} from "./workout-utils.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Workouts listed for one day; totals always cover every workout. */
export const MAX_DAY_WORKOUTS = 25;

/** Timeline entries listed for one day. */
export const MAX_TIMELINE_ENTRIES = 60;

/** Method version reported in data_quality. */
export const GET_DAY_METHOD_VERSION = "day-1";

/** Limitations every day-placed tool reports besides HISTORY_LIMITATIONS. */
export const DAY_PLACEMENT_LIMITATIONS: readonly string[] = [
  "Records are placed on local days as get_calendar places them: a cycle belongs to the day its main sleep ended, and a workout to the day of the cycle containing its start.",
  "A cycle's energy and heart rate cover sleep onset to the next sleep onset, not a calendar day.",
];

// ---------------------------------------------------------------------------
// Shared source loading (get_day, export_health_data)
// ---------------------------------------------------------------------------

/** The four WHOOP collections a day is built from. */
export type DaySourceName = "cycle" | "sleep" | "recovery" | "workout";

/** The source names in reporting order. */
export const DAY_SOURCE_NAMES: readonly DaySourceName[] = ["cycle", "sleep", "recovery", "workout"];

/** Loaded history per collection; null when the caller did not need it. */
export interface DaySources {
  cycle: HistorySource<Cycle> | null;
  sleep: HistorySource<Sleep> | null;
  recovery: HistorySource<Recovery> | null;
  workout: HistorySource<Workout> | null;
}

/** How each collection is named in warnings. */
export const DAY_SOURCE_LABELS: Record<DaySourceName, string> = {
  cycle: "Cycle",
  sleep: "Sleep",
  recovery: "Recovery",
  workout: "Workout",
};

/**
 * Load the needed collections over `range` as history, sharing one budget.
 *
 * @throws the most relevant WHOOP error when every loaded collection failed
 *   (fetch_failed, or unreadable with at least one fetch failure)
 */
export async function loadDaySources(
  ctx: ToolContext,
  range: { startMs: number; endMs: number },
  budget: HistoryBudget,
  needs: Record<DaySourceName, boolean>
): Promise<DaySources> {
  const period = {
    start: new Date(range.startMs).toISOString(),
    end: new Date(Math.max(range.startMs, range.endMs)).toISOString(),
  };
  const options = {
    ...(ctx.historyCache !== undefined ? { cache: ctx.historyCache } : {}),
    budget,
    now: (): Date => ctx.now(),
  };
  const [cycle, sleep, recovery, workout] = await Promise.all([
    needs.cycle
      ? loadHistory<Cycle>(ctx.client, ENDPOINT_CYCLE, period, cycleRecordSchema, options)
      : null,
    needs.sleep
      ? loadHistory<Sleep>(ctx.client, ENDPOINT_SLEEP, period, sleepRecordSchema, options)
      : null,
    needs.recovery
      ? loadHistory<Recovery>(ctx.client, ENDPOINT_RECOVERY, period, recoveryRecordSchema, options)
      : null,
    needs.workout
      ? loadHistory<Workout>(ctx.client, ENDPOINT_WORKOUT, period, workoutRecordSchema, options)
      : null,
  ]);
  const loaded: HistorySource<unknown>[] = [cycle, sleep, recovery, workout].filter(
    (source): source is NonNullable<typeof source> => source !== null
  );
  const failed = loaded.filter((source) => source.quality.status === "fetch_failed");
  if (
    failed.length > 0 &&
    loaded.every(
      (source) => source.quality.status === "fetch_failed" || source.quality.status === "invalid"
    )
  ) {
    throw mostRelevantError(failed.map((source) => source.error));
  }
  return { cycle, sleep, recovery, workout };
}

/** True when a source was loaded and its records can be used. */
export function isUsableSource(source: HistorySource<unknown> | null): boolean {
  return (
    source !== null &&
    source.quality.status !== "fetch_failed" &&
    source.quality.status !== "invalid"
  );
}

/** True when a failure is this call's own request budget or deadline (no WHOOP error). */
export function isBudgetError(error: unknown): boolean {
  return (
    error instanceof WhoopRateBudgetError ||
    (error instanceof WhoopNetworkError && error.cause instanceof WhoopRateBudgetError)
  );
}

/**
 * True when history was left unread in this call: a usable source was read
 * incompletely (a later page failed, or the budget, deadline or a cap was
 * reached), or a source could not be read at all within the budget.
 */
export function historyTruncated(sources: DaySources): boolean {
  return DAY_SOURCE_NAMES.some((name) => {
    const source = sources[name];
    if (source === null) return false;
    return isUsableSource(source) ? source.quality.truncated : isBudgetError(source.error);
  });
}

/**
 * Usable sources whose records are not complete back to `fromMs` (their
 * complete_since is null or later), in reporting order.
 */
export function incompleteSources(sources: DaySources, fromMs: number): DaySourceName[] {
  return DAY_SOURCE_NAMES.filter((name) => {
    const source = sources[name];
    if (source === null || !isUsableSource(source) || !source.quality.truncated) return false;
    return source.complete_since === null || Date.parse(source.complete_since) > fromMs;
  });
}

/** Describe a failure by error type and HTTP status only (never bodies or URLs). */
export function describeSourceFailure(error: unknown, depth = 0): string {
  if (error instanceof WhoopRateBudgetError) {
    return "the server's WHOOP request budget for this call ran out";
  }
  if (error instanceof WhoopApiError) return `WHOOP API returned HTTP ${error.statusCode}`;
  const isClientError = error instanceof WhoopAuthError || error instanceof WhoopNetworkError;
  const cause = isClientError ? error.cause : undefined;
  if (
    depth < 3 &&
    (cause instanceof WhoopApiError ||
      cause instanceof WhoopAuthError ||
      cause instanceof WhoopNetworkError ||
      cause instanceof WhoopRateBudgetError)
  ) {
    return describeSourceFailure(cause, depth + 1);
  }
  if (error instanceof WhoopAuthError) return "WHOOP authentication failed";
  if (error instanceof WhoopNetworkError) return "network error";
  return "unexpected error";
}

/**
 * Warnings for a source that failed, could not be read, or had records that
 * did not match the WHOOP format. `affected` names what is null as a result.
 */
export function sourceProblemWarnings(
  name: DaySourceName,
  source: HistorySource<unknown> | null,
  affected: string,
  warnings: string[]
): void {
  if (source === null) return;
  const label = DAY_SOURCE_LABELS[name];
  const { status } = source.quality;
  if (status === "fetch_failed") {
    warnings.push(
      `${label} data could not be loaded (${describeSourceFailure(source.error)}), so ${affected}.`
    );
    return;
  }
  if (status === "invalid") {
    warnings.push(`${label} data did not match the expected WHOOP format, so ${affected}.`);
    return;
  }
  const invalid = source.quality.exclusions.invalid ?? 0;
  if (invalid > 0) {
    warnings.push(
      `${invalid} ${label.toLowerCase()} record(s) did not match the expected WHOOP format and were skipped.`
    );
  }
}

/** The records of a usable source, else an empty list. */
function recordsOf<T>(source: HistorySource<T> | null): T[] {
  return source !== null && isUsableSource(source) ? source.records : [];
}

/** Records a day placement is built from, with the placement itself. */
export interface PlacedHistory {
  sources: DaySources;
  cycles: Cycle[];
  sleeps: Sleep[];
  recoveries: Recovery[];
  /** Null when workouts were not requested or could not be read. */
  workouts: Workout[] | null;
  placement: DayPlacement;
  /** Workout id → placement; empty when workouts are null. */
  assignments: Map<string, WorkoutPlacement>;
}

/** Place loaded sources on local days with the shared day model. */
export function placeHistory(sources: DaySources, today: string, utcOffset: string): PlacedHistory {
  const cycles = recordsOf(sources.cycle);
  const sleeps = recordsOf(sources.sleep);
  const recoveries = recordsOf(sources.recovery);
  const workouts = isUsableSource(sources.workout) ? recordsOf(sources.workout) : null;
  const placement = placeDays({
    cycles,
    sleeps,
    recoveries,
    sleepsAvailable: isUsableSource(sources.sleep),
    today,
    utcOffset,
  });
  const assignments =
    workouts === null
      ? new Map<string, WorkoutPlacement>()
      : assignWorkouts(workouts, placement, cycles);
  return { sources, cycles, sleeps, recoveries, workouts, placement, assignments };
}

function byStartThenId<T extends { start: string; id: string }>(left: T, right: T): number {
  return (
    Date.parse(left.start) - Date.parse(right.start) ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  );
}

/** Workouts assigned to `day`, ordered by start then id. */
export function workoutsOnDay(
  history: PlacedHistory,
  day: string
): Array<{ workout: Workout; placement: WorkoutPlacement }> {
  if (history.workouts === null) return [];
  const list: Array<{ workout: Workout; placement: WorkoutPlacement }> = [];
  for (const workout of history.workouts) {
    const placement = history.assignments.get(workout.id);
    if (placement?.day === day) list.push({ workout, placement });
  }
  return list.sort((left, right) => byStartThenId(left.workout, right.workout));
}

/**
 * Naps shown with a day: naps of its placed cycle, or without a cycle the naps
 * ending on that local day whose cycle is not among the loaded cycles.
 * Ordered by start.
 */
export function napsForDay(history: PlacedHistory, day: string, cycle: Cycle | undefined): Sleep[] {
  return history.sleeps
    .filter((sleep) => {
      if (!sleep.nap) return false;
      if (cycle) return sleep.cycle_id === cycle.id;
      return (
        !history.placement.dayOfCycle.has(sleep.cycle_id) &&
        localDay(sleep.end, sleep.timezone_offset) === day
      );
    })
    .sort(byStartThenId);
}

/** A scored score object, or null for PENDING_SCORE / UNSCORABLE / missing scores. */
export function scoredOf<T>(record: { score_state: ScoreState; score?: T | null }): T | null {
  return record.score_state === "SCORED" && record.score ? record.score : null;
}

/**
 * True when a scored recovery is withheld because the main sleep it was scored
 * for is still PENDING_SCORE (the same rule as get_today). An UNSCORABLE sleep
 * will never be scored, so its recovery is shown.
 */
export function isRecoveryHeldBack(recovery: Recovery, linkedSleep: Sleep | undefined): boolean {
  return scoredOf(recovery) !== null && linkedSleep?.score_state === "PENDING_SCORE";
}

/** The exclusion counted for a record that contributes no values. */
export function unscoredReason(state: ScoreState): "pending" | "unscored" | null {
  if (state === "PENDING_SCORE") return "pending";
  if (state === "UNSCORABLE") return "unscored";
  return null;
}

/**
 * A source's data quality for the records actually used: a copy of the
 * loader's quality with `exclusions` added, finished with `used` (records
 * used, latest updated_at and status). Null when the source was not loaded.
 */
export function finishSourceQuality(
  source: HistorySource<unknown> | null,
  used: readonly { updated_at: string }[],
  exclusions: readonly string[]
): SourceQuality | null {
  if (source === null) return null;
  const quality: SourceQuality = {
    ...source.quality,
    exclusions: { ...source.quality.exclusions },
  };
  for (const reason of exclusions) exclude(quality, reason);
  finishQuality(quality, [...used]);
  return quality;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const scoreStateSchema = z.enum(["SCORED", "PENDING_SCORE", "UNSCORABLE"]);
const nullableNumber = z.number().nullable();

export const getDayInputSchema = z.object({
  date: z
    .string()
    .max(40)
    .optional()
    .describe(
      "Local day: YYYY-MM-DD, 'today' or 'yesterday'. Default today. Ranges are rejected; use get_calendar."
    ),
  cycle_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("A WHOOP cycle id; shows the local day that cycle is placed on."),
  include_timeline: z
    .boolean()
    .optional()
    .describe(
      "Add the day's cycle start and end, sleeps and workouts in time order (at most 60 entries). Default false."
    ),
});

export const DAY_STATUSES = [
  "complete",
  "in_progress",
  "no_cycle_yet",
  "records_without_cycle",
  "no_data",
] as const;

const cycleSectionSchema = z.object({
  id: z.number().int(),
  start_local: z.string(),
  end_local: z.string().nullable(),
  cycle_hours: nullableNumber.describe("Cycle length: end (or now) minus start"),
  in_progress: z.boolean(),
  partial_first_day: z.boolean(),
  score_state: scoreStateSchema,
  day_strain: nullableNumber.describe("WHOOP day strain (0-21); strain so far while in progress"),
  kilojoule: nullableNumber.describe("Energy of the whole cycle (sleep onset to next sleep onset)"),
  kcal: nullableNumber,
  average_heart_rate: nullableNumber,
  max_heart_rate: nullableNumber,
});

const recoverySectionSchema = z.object({
  score_state: scoreStateSchema,
  recovery_score: nullableNumber,
  zone: z.enum(["green", "yellow", "red"]).nullable(),
  hrv_rmssd_milli: nullableNumber,
  resting_heart_rate: nullableNumber,
  spo2_pct: nullableNumber,
  skin_temp_celsius: nullableNumber,
  calibrating: z.boolean().nullable(),
  held_back: z
    .boolean()
    .describe("True when a scored recovery is withheld while its sleep is still being scored"),
});

const sleepSectionSchema = z.object({
  id: z.string(),
  start_local: z.string(),
  end_local: z.string(),
  score_state: scoreStateSchema,
  asleep_hours: nullableNumber.describe("Light + slow-wave + REM; naps excluded"),
  in_bed_hours: nullableNumber,
  awake_hours: nullableNumber,
  light_hours: nullableNumber,
  deep_hours: nullableNumber,
  rem_hours: nullableNumber,
  no_data_hours: nullableNumber,
  stage_share_pct: z
    .object({ light: z.number(), deep: z.number(), rem: z.number() })
    .nullable()
    .describe("Shares of time asleep"),
  disturbances: nullableNumber,
  sleep_cycles: nullableNumber,
  efficiency_pct: nullableNumber,
  performance_pct: nullableNumber,
  consistency_pct: nullableNumber,
  consistency_reason: z.enum(["zero_during_calibration", "not_reported"]).nullable(),
  respiratory_rate: nullableNumber,
  need_hours: z
    .object({
      baseline: z.number(),
      from_sleep_debt: z.number(),
      from_recent_strain: z.number(),
      from_recent_nap: z.number().describe("0 or negative: a recent nap lowers the need"),
      total_including_debt: z.number(),
    })
    .nullable(),
  asleep_minus_need_hours: nullableNumber.describe("asleep_hours minus need total_including_debt"),
});

const napSchema = z.object({
  id: z.string(),
  start_local: z.string(),
  end_local: z.string(),
  score_state: scoreStateSchema,
  asleep_hours: nullableNumber,
});

const zoneMinutesSchema = z.object({
  zone_0: z.number(),
  zone_1: z.number(),
  zone_2: z.number(),
  zone_3: z.number(),
  zone_4: z.number(),
  zone_5: z.number(),
});

const workoutTotalsSchema = z.object({
  count: z.number().int().nonnegative(),
  duration_minutes: z.number(),
  recorded_minutes: z.number().describe("Scored workouts only"),
  zone_minutes: zoneMinutesSchema.describe("Scored workouts only"),
  trimp: nullableNumber.describe("Null when any workout has no TRIMP"),
  high_intensity_minutes: z.number().describe("Zone 4 + zone 5, scored workouts only"),
  kilojoule: z.number().describe("Scored workouts only"),
  kcal: z.number(),
  distance_km: nullableNumber.describe("Null when no workout has a GPS distance"),
  workout_kj_share_of_day_pct: nullableNumber.describe(
    "Workout energy as a share of the closed cycle's energy"
  ),
});

const previousDaySchema = z.object({
  date: z.string(),
  day_strain: nullableNumber.describe("Closed, complete, scored cycles only"),
  day_strain_partial: z.boolean(),
  workouts: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .describe("Null when workouts could not be loaded"),
  trimp: nullableNumber,
});

const nextMorningSchema = z.object({
  date: z.string().nullable(),
  status: z.enum(["available", "pending", "not_yet", "missing", "unavailable"]),
  recovery_score: nullableNumber,
  calibrating: z.boolean().nullable(),
  hrv_rmssd_milli: nullableNumber,
  resting_heart_rate: nullableNumber,
});

const timelineEntrySchema = z.object({
  kind: z.enum(["cycle_start", "sleep", "nap", "workout", "cycle_end"]),
  start_local: z.string(),
  end_local: z.string().nullable(),
  label: z.string(),
  id: z.string().nullable(),
});

export const getDayOutputSchema = z.object({
  date: z.string(),
  utc_offset: z.string(),
  status: z.enum(DAY_STATUSES),
  cycle: cycleSectionSchema.nullable(),
  recovery: recoverySectionSchema.nullable(),
  sleep: sleepSectionSchema.nullable(),
  naps: z.array(napSchema),
  workouts: z.array(workoutSummarySchema).max(MAX_DAY_WORKOUTS),
  workout_totals: workoutTotalsSchema
    .nullable()
    .describe("Null when workouts could not be loaded or the day has no WHOOP records"),
  previous_day: previousDaySchema.nullable(),
  next_morning: nextMorningSchema,
  timeline: z.array(timelineEntrySchema).max(MAX_TIMELINE_ENTRIES),
  output_capped: z.boolean(),
  notes: z.array(z.string()),
  warnings: z.array(z.string()),
  truncated: z.boolean(),
  disclaimer: z.string(),
  data_quality: dataQualitySchema,
});

export type GetDayInput = z.infer<typeof getDayInputSchema>;
export type GetDayResult = z.infer<typeof getDayOutputSchema>;
type DayStatus = GetDayResult["status"];
type CycleSection = z.infer<typeof cycleSectionSchema>;
type RecoverySection = z.infer<typeof recoverySectionSchema>;
type SleepSection = z.infer<typeof sleepSectionSchema>;
type WorkoutTotals = z.infer<typeof workoutTotalsSchema>;
type NextMorning = z.infer<typeof nextMorningSchema>;
type TimelineEntry = z.infer<typeof timelineEntrySchema>;

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function localStamp(timestamp: string, offset: string): string {
  return formatLocalTimestamp(Date.parse(timestamp), offset);
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function buildCycleSection(cycle: Cycle, partial: boolean, nowMs: number): CycleSection {
  const startMs = Date.parse(cycle.start);
  const endMs = cycle.end === null || cycle.end === undefined ? null : Date.parse(cycle.end);
  const spanMs = (endMs ?? nowMs) - startMs;
  const score = scoredOf(cycle);
  return {
    id: cycle.id,
    start_local: formatLocalTimestamp(startMs, cycle.timezone_offset),
    end_local: endMs === null ? null : formatLocalTimestamp(endMs, cycle.timezone_offset),
    cycle_hours: spanMs >= 0 ? roundTo(spanMs / HOUR_MS, 1) : null,
    in_progress: endMs === null,
    partial_first_day: partial,
    score_state: cycle.score_state,
    day_strain: roundTo(score?.strain ?? null, 2),
    kilojoule: roundTo(score?.kilojoule ?? null, 0),
    kcal: score ? roundTo(kjToKcal(score.kilojoule), 0) : null,
    average_heart_rate: roundTo(score?.average_heart_rate ?? null, 0),
    max_heart_rate: roundTo(score?.max_heart_rate ?? null, 0),
  };
}

function buildRecoverySection(recovery: Recovery, heldBack: boolean): RecoverySection {
  const score = heldBack ? null : scoredOf(recovery);
  return {
    score_state: recovery.score_state,
    recovery_score: roundTo(score?.recovery_score ?? null, 1),
    zone: score ? recoveryZone(score.recovery_score) : null,
    hrv_rmssd_milli: roundTo(score?.hrv_rmssd_milli ?? null, 1),
    resting_heart_rate: roundTo(score?.resting_heart_rate ?? null, 0),
    spo2_pct: roundTo(score?.spo2_percentage ?? null, 1),
    skin_temp_celsius: roundTo(score?.skin_temp_celsius ?? null, 2),
    calibrating: score ? score.user_calibrating : null,
    held_back: heldBack,
  };
}

function buildSleepSection(sleep: Sleep, recovery: Recovery | null): SleepSection {
  const score = scoredOf(sleep);
  const stages = score ? stageBreakdown(sleep) : null;
  const need = score ? needBreakdown(sleep) : null;
  const consistency = score ? whoopConsistency(sleep, recovery) : null;
  const minutesToHours = (minutes: number | undefined): number | null =>
    minutes === undefined ? null : roundTo(minutes / 60, 2);
  const shares =
    stages &&
    stages.light_pct_of_asleep !== null &&
    stages.sws_pct_of_asleep !== null &&
    stages.rem_pct_of_asleep !== null
      ? {
          light: roundTo(stages.light_pct_of_asleep, 1),
          deep: roundTo(stages.sws_pct_of_asleep, 1),
          rem: roundTo(stages.rem_pct_of_asleep, 1),
        }
      : null;
  return {
    id: sleep.id,
    start_local: localStamp(sleep.start, sleep.timezone_offset),
    end_local: localStamp(sleep.end, sleep.timezone_offset),
    score_state: sleep.score_state,
    asleep_hours: minutesToHours(stages?.asleep_min),
    in_bed_hours: minutesToHours(stages?.in_bed_min),
    awake_hours: minutesToHours(stages?.awake_min),
    light_hours: minutesToHours(stages?.light_min),
    deep_hours: minutesToHours(stages?.sws_min),
    rem_hours: minutesToHours(stages?.rem_min),
    no_data_hours: minutesToHours(stages?.no_data_min),
    stage_share_pct: shares,
    disturbances: stages ? stages.disturbances : null,
    sleep_cycles: stages ? stages.sleep_cycles : null,
    efficiency_pct: roundTo(score?.sleep_efficiency_percentage ?? null, 1),
    performance_pct: roundTo(score?.sleep_performance_percentage ?? null, 1),
    consistency_pct: roundTo(consistency?.value ?? null, 1),
    consistency_reason: consistency?.reason ?? null,
    respiratory_rate: roundTo(score?.respiratory_rate ?? null, 1),
    need_hours: need
      ? {
          baseline: roundTo(need.baseline, 2),
          from_sleep_debt: roundTo(need.debt, 2),
          from_recent_strain: roundTo(need.strain, 2),
          from_recent_nap: roundTo(need.nap, 2),
          total_including_debt: roundTo(need.total_including_debt, 2),
        }
      : null,
    asleep_minus_need_hours:
      stages && need ? roundTo(stages.asleep_min / 60 - need.total_including_debt, 2) : null,
  };
}

/** A day's workouts as unrounded summaries with their placement. */
export interface PlacedSummary {
  workout: Workout;
  summary: WorkoutSummary;
  placement: WorkoutPlacement;
}

/**
 * Normalize a day's workouts; workouts ending at or before their start are
 * counted in `invalid` and left out.
 */
export function summarizeWorkouts(
  items: Array<{ workout: Workout; placement: WorkoutPlacement }>
): {
  summaries: PlacedSummary[];
  invalid: number;
} {
  const summaries: PlacedSummary[] = [];
  let invalid = 0;
  for (const { workout, placement } of items) {
    const summary = normalizeWorkout(
      workout,
      placement,
      placement.cycle !== null && isOpenCycle(placement.cycle)
    );
    if (summary === null) invalid += 1;
    else summaries.push({ workout, summary, placement });
  }
  return { summaries, invalid };
}

/** TRIMP summed over workouts; null when any workout has none. */
export function totalTrimp(summaries: readonly WorkoutSummary[]): number | null {
  let total = 0;
  for (const summary of summaries) {
    if (summary.trimp === null) return null;
    total += summary.trimp;
  }
  return total;
}

/**
 * Totals over a day's workouts (unrounded summaries). Minutes, energy and
 * zones add scored workouts only; TRIMP is null when any workout lacks it.
 * The energy share needs a closed, scored cycle and scored workouts in it.
 */
function buildWorkoutTotals(
  items: readonly PlacedSummary[],
  cycle: Cycle | undefined
): WorkoutTotals {
  let duration = 0;
  let recorded = 0;
  let kilojoule = 0;
  let highIntensity = 0;
  let distance: number | null = null;
  const zones: ZoneMinutes = { zone_0: 0, zone_1: 0, zone_2: 0, zone_3: 0, zone_4: 0, zone_5: 0 };
  for (const { summary } of items) {
    duration += summary.duration_minutes;
    recorded += summary.recorded_minutes ?? 0;
    kilojoule += summary.kilojoule ?? 0;
    highIntensity += summary.high_intensity_minutes ?? 0;
    if (summary.gps) distance = (distance ?? 0) + summary.gps.distance_km;
    if (summary.zone_minutes) {
      for (const key of Object.keys(zones) as Array<keyof ZoneMinutes>) {
        zones[key] += summary.zone_minutes[key];
      }
    }
  }

  let share: number | null = null;
  const cycleScore = cycle ? scoredOf(cycle) : null;
  if (cycle && !isOpenCycle(cycle) && cycleScore && cycleScore.kilojoule > 0) {
    const inCycle = items.filter(({ placement }) => placement.cycle?.id === cycle.id);
    if (inCycle.every(({ summary }) => summary.kilojoule !== null)) {
      const cycleWorkoutKj = inCycle.reduce(
        (sum, { summary }) => sum + (summary.kilojoule ?? 0),
        0
      );
      share = roundTo((100 * cycleWorkoutKj) / cycleScore.kilojoule, 1);
    }
  }

  return {
    count: items.length,
    duration_minutes: roundTo(duration, 1),
    recorded_minutes: roundTo(recorded, 1),
    zone_minutes: {
      zone_0: roundTo(zones.zone_0, 1),
      zone_1: roundTo(zones.zone_1, 1),
      zone_2: roundTo(zones.zone_2, 1),
      zone_3: roundTo(zones.zone_3, 1),
      zone_4: roundTo(zones.zone_4, 1),
      zone_5: roundTo(zones.zone_5, 1),
    },
    trimp: roundTo(totalTrimp(items.map(({ summary }) => summary)), 1),
    high_intensity_minutes: roundTo(highIntensity, 1),
    kilojoule: roundTo(kilojoule, 0),
    kcal: roundTo(kjToKcal(kilojoule), 0),
    distance_km: roundTo(distance, 2),
    workout_kj_share_of_day_pct: share,
  };
}

// ---------------------------------------------------------------------------
// Day resolution
// ---------------------------------------------------------------------------

/**
 * The local day named by `date` (default today). A date-time counts as its
 * local day in `utcOffset`.
 *
 * @throws InvalidDateExpression for an unparseable value, a range of more than
 *   one local day, or a day after today
 */
export function resolveGetDayDate(date: string | undefined, now: Date, utcOffset: string): string {
  const today = localDay(now.toISOString(), utcOffset);
  if (date === undefined) return today;
  const resolved = resolveDateExpression(date, now, utcOffset);
  const first = localDay(resolved.start, utcOffset);
  const last = localDay(resolved.end, utcOffset);
  if (last > first) {
    throw new InvalidDateExpression(
      `"${date}" covers ${first} to ${last}. get_day shows one local day; use get_calendar for ranges.`
    );
  }
  if (first > today) {
    throw new InvalidDateExpression(
      `${first} is after today (${today}); get_day shows days up to today.`
    );
  }
  return first;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/** Load and place history around one local day. */
async function loadDay(
  ctx: ToolContext,
  day: string,
  utcOffset: string,
  today: string,
  nowMs: number,
  budget: HistoryBudget
): Promise<{ history: PlacedHistory; range: { startMs: number; endMs: number } }> {
  const range = fetchRangeForDays(day, day, utcOffset, nowMs);
  const sources = await loadDaySources(ctx, range, budget, {
    cycle: true,
    sleep: true,
    recovery: true,
    workout: true,
  });
  return { history: placeHistory(sources, today, utcOffset), range };
}

/**
 * Show one local day.
 *
 * @throws InvalidDateExpression for invalid input; a WHOOP error when the
 *   cycle lookup fails or every source fails
 */
export async function getDay(args: GetDayInput, ctx: ToolContext): Promise<GetDayResult> {
  if (args.date !== undefined && args.cycle_id !== undefined) {
    throw new InvalidDateExpression(
      "Pass either date or cycle_id, not both: cycle_id already names the day."
    );
  }
  const { offset: utcOffset, fallback: offsetFallback } = await resolveUserUtcOffsetInfo(
    ctx.client
  );
  const now = ctx.now();
  const nowMs = now.getTime();
  const today = localDay(now.toISOString(), utcOffset);
  const budget = createHistoryBudget({ deadlineMs: ctx.startedAtMs + HISTORY_DEADLINE_MS });

  let day: string;
  let loaded: Awaited<ReturnType<typeof loadDay>>;
  const requestedCycleId = args.cycle_id ?? null;
  if (requestedCycleId !== null) {
    // Validated before use; a 404 surfaces the client's own guidance.
    const cycle = cycleRecordSchema.parse(
      await ctx.client.get<unknown>(`${ENDPOINT_CYCLE}/${requestedCycleId}`)
    ) as Cycle;
    const provisional = cycleDay(cycle);
    loaded = await loadDay(ctx, provisional, utcOffset, today, nowMs, budget);
    day = loaded.history.placement.dayOfCycle.get(requestedCycleId) ?? provisional;
    if (day !== provisional) {
      loaded = await loadDay(ctx, day, utcOffset, today, nowMs, budget);
    }
  } else {
    day = resolveGetDayDate(args.date, now, utcOffset);
    loaded = await loadDay(ctx, day, utcOffset, today, nowMs, budget);
  }

  return buildDayResult({
    day,
    today,
    utcOffset,
    offsetFallback,
    nowMs,
    history: loaded.history,
    range: loaded.range,
    requestedCycleId,
    includeTimeline: args.include_timeline === true,
  });
}

interface BuildDayInput {
  day: string;
  today: string;
  utcOffset: string;
  offsetFallback: boolean;
  nowMs: number;
  history: PlacedHistory;
  range: { startMs: number; endMs: number };
  requestedCycleId: number | null;
  includeTimeline: boolean;
}

/**
 * The note for a day after the newest cycle's day while that cycle is still
 * open (get_calendar's wording). `pointer` is appended after the open cycle's
 * description (e.g. which tool call shows it).
 */
export function noCycleYetNote(
  day: string,
  today: string,
  placement: DayPlacement,
  pointer = ""
): string | null {
  if (placement.openCycleDay === undefined) return null;
  const openCycle = placement.cycleByDay.get(placement.openCycleDay);
  if (!openCycle) return null;
  const strain = cycleStrain(openCycle);
  const subject =
    day === today
      ? `Today's (${today}) WHOOP cycle has not started yet`
      : `No WHOOP cycle has started yet for ${day}`;
  return (
    `${subject}: a new cycle begins at your next sleep and appears once that sleep syncs. ` +
    `Until then, strain is still being added to the open cycle that started ${localClock(openCycle.start, openCycle.timezone_offset)}, which belongs to ${placement.openCycleDay}` +
    (strain === null ? "" : ` (strain so far ${roundTo(strain, 1)})`) +
    pointer +
    ". This is not missing data."
  );
}

function buildDayResult(input: BuildDayInput): GetDayResult {
  const { day, today, utcOffset, nowMs, history, range, requestedCycleId } = input;
  const { placement, sources } = history;
  const notes: string[] = [];
  const warnings: string[] = [];
  const cyclesUsable = isUsableSource(sources.cycle);
  const recoveriesUsable = isUsableSource(sources.recovery);
  const workoutsUsable = history.workouts !== null;
  const sleepById = new Map(history.sleeps.map((sleep) => [sleep.id, sleep]));

  // --- Records placed on the day ---------------------------------------------------
  const entry = placement.byDay.get(day) ?? {};
  const { cycle, sleep: mainSleep, recovery } = entry;
  const naps = napsForDay(history, day, cycle);
  const { summaries: dayWorkouts, invalid: invalidDuration } = summarizeWorkouts(
    workoutsOnDay(history, day)
  );

  let status: DayStatus;
  if (cycle) status = isOpenCycle(cycle) ? "in_progress" : "complete";
  else if (mainSleep || recovery || naps.length > 0 || dayWorkouts.length > 0)
    status = "records_without_cycle";
  else if (placement.openCycleDay !== undefined && placement.openCycleDay < day && day <= today)
    status = "no_cycle_yet";
  else status = "no_data";

  // --- Source problems ----------------------------------------------------------------
  sourceProblemWarnings(
    "cycle",
    sources.cycle,
    "the cycle, strain and energy are null and workouts are placed on their local start day",
    warnings
  );
  sourceProblemWarnings(
    "sleep",
    sources.sleep,
    "the sleep is null, naps are empty and partial first days cannot be detected",
    warnings
  );
  sourceProblemWarnings("recovery", sources.recovery, "the recovery values are null", warnings);
  sourceProblemWarnings(
    "workout",
    sources.workout,
    "workouts are empty and workout_totals and previous-day workout counts are null",
    warnings
  );
  const incomplete = incompleteSources(sources, range.startMs);
  if (incomplete.length > 0) {
    warnings.push(
      `Some ${incomplete.join(", ")} history around ${day} could not be read completely in this call (request budget, time limit or a failed page), so records for this day may be missing. Repeating the request continues from the cache.`
    );
  }

  // --- Status notes -------------------------------------------------------------------
  const partlyLoaded = DAY_SOURCE_NAMES.some(
    (name) => sources[name] !== null && !isUsableSource(sources[name])
  );
  if (status === "no_cycle_yet") {
    const note = noCycleYetNote(
      day,
      today,
      placement,
      `; get_day for ${placement.openCycleDay} shows it`
    );
    if (note !== null) notes.push(note);
  } else if (status === "no_data") {
    notes.push(
      `No WHOOP records for this day (${day}).` +
        (partlyLoaded ? " Some data could not be loaded; see warnings." : "")
    );
  } else if (status === "records_without_cycle") {
    notes.push(
      `No WHOOP cycle is available for ${day}` +
        (cyclesUsable ? "" : " (cycle data could not be loaded; see warnings)") +
        ", so the cycle, strain and energy are null; the records shown were placed by their local date."
    );
  }

  for (const displaced of placement.displaced) {
    if (displaced.day !== day) continue;
    const strain = cycleStrain(displaced.other);
    warnings.push(
      `Two WHOOP cycles belong to ${day} (for example, a second main sleep ended that day). ` +
        `This day shows the cycle that started ${localClock(displaced.shown.start, displaced.shown.timezone_offset)}; ` +
        `the cycle that started ${localClock(displaced.other.start, displaced.other.timezone_offset)}` +
        (strain === null ? "" : ` (strain ${roundTo(strain, 1)})`) +
        ` (id ${displaced.other.id}) is not shown, but its workouts are listed on this day.`
    );
  }
  if (requestedCycleId !== null && cycle?.id !== requestedCycleId) {
    warnings.push(
      history.cycles.some((candidate) => candidate.id === requestedCycleId)
        ? `Cycle ${requestedCycleId} belongs to ${day}, but another cycle is shown for that day (see the warning about two cycles).`
        : `Cycle ${requestedCycleId} was not among the loaded cycles, so ${day} is the local day 12 hours after its start and may not match get_calendar.`
    );
  }

  // --- Cycle ------------------------------------------------------------------------
  const partial = cycle !== undefined && placement.partialDays.has(day);
  const cycleSection = cycle ? buildCycleSection(cycle, partial, nowMs) : null;
  if (cycle && cycleSection) {
    if (cycleSection.kilojoule !== null) {
      notes.push(
        "Energy covers the whole WHOOP cycle (sleep onset to next sleep onset), not a calendar day."
      );
    }
    if (cycle.score_state === "PENDING_SCORE") {
      notes.push(`WHOOP is still scoring the cycle for ${day}; its strain and energy are null.`);
    } else if (cycle.score_state === "UNSCORABLE") {
      notes.push(`WHOOP could not score the cycle for ${day}; its strain and energy are null.`);
    }
    if (cycleSection.in_progress && cycleSection.day_strain !== null) {
      notes.push(
        `Strain for ${day} is still accumulating (in_progress: true); day_strain is the strain so far.`
      );
    }
    if (partial) {
      notes.push(
        `Strain for ${day} covers only part of the day (WHOOP was first worn partway through it; partial_first_day: true).`
      );
    }
  }

  // --- Recovery -----------------------------------------------------------------------
  let recoverySection: RecoverySection | null = null;
  let recoveryHeldBack = false;
  if (recovery) {
    recoveryHeldBack = isRecoveryHeldBack(recovery, sleepById.get(recovery.sleep_id));
    recoverySection = buildRecoverySection(recovery, recoveryHeldBack);
    if (recoveryHeldBack) {
      notes.push(
        `Recovery for ${day} is held back (held_back: true) until WHOOP finishes scoring its sleep.`
      );
    } else if (recovery.score_state === "PENDING_SCORE") {
      notes.push(`Recovery for ${day} is still being scored by WHOOP; its values are null.`);
    } else if (recovery.score_state === "UNSCORABLE") {
      notes.push(`WHOOP could not score recovery for ${day}; its values are null.`);
    }
    if (recoverySection.calibrating === true) {
      notes.push(
        `WHOOP is still calibrating: recovery for ${day} is provisional (calibrating: true).`
      );
    }
  }

  // --- Sleep and naps -----------------------------------------------------------------
  const recoveryForSleep =
    mainSleep && recovery && recovery.sleep_id === mainSleep.id ? recovery : null;
  const sleepSection = mainSleep ? buildSleepSection(mainSleep, recoveryForSleep) : null;
  if (mainSleep && sleepSection) {
    if (mainSleep.score_state === "PENDING_SCORE") {
      notes.push(`The sleep for ${day} is still being scored by WHOOP; its values are null.`);
    } else if (mainSleep.score_state === "UNSCORABLE") {
      notes.push(`WHOOP could not score the sleep for ${day}; its values are null.`);
    }
    if (sleepSection.consistency_reason === "zero_during_calibration") {
      notes.push(
        "WHOOP reports sleep consistency as 0 while calibrating, so consistency_pct is null (consistency_reason: zero_during_calibration)."
      );
    }
  }
  const napSections = naps.map((nap) => {
    const stages = scoredOf(nap) ? stageBreakdown(nap) : null;
    return {
      id: nap.id,
      start_local: localStamp(nap.start, nap.timezone_offset),
      end_local: localStamp(nap.end, nap.timezone_offset),
      score_state: nap.score_state,
      asleep_hours: stages ? roundTo(stages.asleep_min / 60, 2) : null,
    };
  });
  if (napSections.length > 0) {
    notes.push(
      `${plural(napSections.length, "nap")} ${napSections.length === 1 ? "is" : "are"} listed separately in naps and not included in the main sleep's asleep_hours.`
    );
  }

  // --- Workouts -----------------------------------------------------------------------
  const listedWorkouts = dayWorkouts
    .slice(0, MAX_DAY_WORKOUTS)
    .map(({ summary }) => roundWorkoutSummary(summary));
  let outputCapped = dayWorkouts.length > MAX_DAY_WORKOUTS;
  if (outputCapped) {
    notes.push(
      `Only the first ${MAX_DAY_WORKOUTS} of ${dayWorkouts.length} workouts are listed (output_capped: true); workout_totals cover all of them.`
    );
  }
  const worn = status !== "no_data" && status !== "no_cycle_yet";
  const workoutTotals = workoutsUsable && worn ? buildWorkoutTotals(dayWorkouts, cycle) : null;
  if (invalidDuration > 0) {
    warnings.push(
      `${plural(invalidDuration, "workout")} on ${day} ${invalidDuration === 1 ? "ends" : "end"} at or before ${invalidDuration === 1 ? "its" : "their"} start and ${invalidDuration === 1 ? "was" : "were"} skipped.`
    );
  }
  const summaries = dayWorkouts.map(({ summary }) => summary);
  if (summaries.length > 0) workoutNotes(day, summaries, notes, warnings);

  // --- Previous day -------------------------------------------------------------------
  const previousDay = buildPreviousDay(history, addDays(day, -1), workoutsUsable);

  // --- Next morning -------------------------------------------------------------------
  const nextMorning = buildNextMorning({
    cycle,
    status,
    history,
    cyclesUsable,
    recoveriesUsable,
    sleepById,
  });

  // --- Timeline -----------------------------------------------------------------------
  let timeline: TimelineEntry[] = [];
  if (input.includeTimeline) {
    const entries = buildTimeline(cycle, mainSleep, sleepSection, naps, napSections, dayWorkouts);
    if (entries.length > MAX_TIMELINE_ENTRIES) {
      outputCapped = true;
      notes.push(
        `The timeline lists the first ${MAX_TIMELINE_ENTRIES} of ${entries.length} entries (output_capped: true).`
      );
    }
    timeline = entries.slice(0, MAX_TIMELINE_ENTRIES);
  }

  // --- Data quality -------------------------------------------------------------------
  const exclusionsOf = (records: readonly { score_state: ScoreState }[]): string[] =>
    records.flatMap((record) => {
      const reason = unscoredReason(record.score_state);
      return reason === null ? [] : [reason];
    });
  const sleepsShown = [...(mainSleep ? [mainSleep] : []), ...naps];
  const recoveryUsed = recovery && !recoveryHeldBack && scoredOf(recovery) ? [recovery] : [];
  const recoveryQuality = finishSourceQuality(
    sources.recovery,
    recoveryUsed,
    recovery ? (recoveryHeldBack ? ["held_back"] : exclusionsOf([recovery])) : []
  );
  if (recoveryQuality && recoveryHeldBack) recoveryQuality.status = "pending";
  if (recoveryQuality && recoverySection?.calibrating === true) {
    recoveryQuality.status = "calibrating";
  }
  const qualities: Record<string, SourceQuality> = {};
  const cycleQuality = finishSourceQuality(
    sources.cycle,
    cycle && scoredOf(cycle) ? [cycle] : [],
    cycle ? exclusionsOf([cycle]) : []
  );
  const sleepQuality = finishSourceQuality(
    sources.sleep,
    sleepsShown.filter((record) => scoredOf(record) !== null),
    exclusionsOf(sleepsShown)
  );
  const workoutQuality = finishSourceQuality(
    sources.workout,
    dayWorkouts.filter(({ workout }) => scoredOf(workout) !== null).map(({ workout }) => workout),
    [
      ...exclusionsOf(dayWorkouts.map(({ workout }) => workout)),
      ...Array.from({ length: invalidDuration }, () => "invalid_duration"),
    ]
  );
  if (cycleQuality) qualities.cycle = cycleQuality;
  if (sleepQuality) qualities.sleep = sleepQuality;
  if (recoveryQuality) qualities.recovery = recoveryQuality;
  if (workoutQuality) qualities.workout = workoutQuality;

  const observed: number[] = [];
  if (cycle)
    observed.push(Date.parse(cycle.start), isOpenCycle(cycle) ? nowMs : Date.parse(cycle.end!));
  for (const record of sleepsShown) observed.push(Date.parse(record.start), Date.parse(record.end));
  for (const { workout } of dayWorkouts) {
    observed.push(Date.parse(workout.start), Date.parse(workout.end));
  }

  return {
    date: day,
    utc_offset: utcOffset,
    status,
    cycle: cycleSection,
    recovery: recoverySection,
    sleep: sleepSection,
    naps: napSections,
    workouts: listedWorkouts,
    workout_totals: workoutTotals,
    previous_day: previousDay,
    next_morning: nextMorning,
    timeline,
    output_capped: outputCapped,
    notes: withOffsetNote(notes, input.offsetFallback),
    warnings,
    truncated: historyTruncated(sources),
    disclaimer: DISCLAIMER,
    data_quality: buildDataQuality({
      firstDay: day,
      lastDay: day,
      utcOffset,
      nowMs,
      observed,
      sources: qualities,
      methodVersion: GET_DAY_METHOD_VERSION,
      limitations: [
        ...DAY_PLACEMENT_LIMITATIONS,
        "Workout totals add minutes, energy and TRIMP; WHOOP strain is non-linear and is never summed.",
        "Heart-rate zones are WHOOP's %max-HR zones.",
      ],
    }),
  };
}

/** Notes and warnings about a day's workouts (flags, placement, caveats). */
function workoutNotes(
  day: string,
  summaries: readonly WorkoutSummary[],
  notes: string[],
  warnings: string[]
): void {
  notes.push("Day strain is WHOOP's non-linear 0-21 score and is not the sum of workout strains.");
  const withFlag = (flag: WorkoutSummary["flags"][number]): number =>
    summaries.filter((summary) => summary.flags.includes(flag)).length;
  const fallback = withFlag("day_by_fallback");
  if (fallback > 0) {
    warnings.push(
      `${plural(fallback, "workout")} on ${day} ${fallback === 1 ? "is" : "are"} not inside a loaded WHOOP cycle and ${fallback === 1 ? "was" : "were"} placed on ${fallback === 1 ? "its" : "their"} local start day (flag day_by_fallback).`
    );
  }
  const afterMidnight = withFlag("after_midnight_in_previous_cycle");
  if (afterMidnight > 0) {
    notes.push(
      `${plural(afterMidnight, "workout")} started after local midnight but before the next sleep, so ${afterMidnight === 1 ? "it counts" : "they count"} toward ${day}, the day of that cycle (flag after_midnight_in_previous_cycle).`
    );
  }
  const unscored = withFlag("not_scored");
  if (unscored > 0) {
    notes.push(
      `${plural(unscored, "workout")} ${unscored === 1 ? "is" : "are"} not scored (pending or unscorable): score values are null and left out of workout_totals, and total TRIMP is null.`
    );
  }
  const lowRecording = withFlag("low_recording");
  if (lowRecording > 0) {
    notes.push(
      `${plural(lowRecording, "workout")} recorded heart rate for less than 90% of ${lowRecording === 1 ? "its" : "their"} duration (flag low_recording); zone minutes and TRIMP cover only the recorded part.`
    );
  }
  const mismatch = withFlag("zone_sum_mismatch");
  if (mismatch > 0) {
    notes.push(
      `${plural(mismatch, "workout")} ${mismatch === 1 ? "has" : "have"} zone minutes that differ from duration × recorded fraction (flag zone_sum_mismatch).`
    );
  }
  const gpsSuspect = withFlag("gps_suspect");
  if (gpsSuspect > 0) {
    notes.push(
      `${plural(gpsSuspect, "workout")} ${gpsSuspect === 1 ? "has" : "have"} an implausible GPS distance for ${gpsSuspect === 1 ? "its" : "their"} duration (flag gps_suspect).`
    );
  }
  const caveatSports = [
    ...new Set(
      summaries
        .filter((summary) => HR_ZONE_CAVEAT_SPORT.test(summary.sport_name))
        .map((summary) => summary.sport_name)
    ),
  ].sort();
  if (caveatSports.length > 0) {
    notes.push(
      `Heart-rate zones, strain and TRIMP come from heart rate only; for ${caveatSports.join(", ")} they can understate the muscular effort of the session.`
    );
  }
}

/** The previous day's strain and workload; null when it has no WHOOP records. */
function buildPreviousDay(
  history: PlacedHistory,
  date: string,
  workoutsUsable: boolean
): GetDayResult["previous_day"] {
  const { placement } = history;
  const entry = placement.byDay.get(date) ?? {};
  const { summaries } = summarizeWorkouts(workoutsOnDay(history, date));
  if (!entry.cycle && !entry.sleep && !entry.recovery && summaries.length === 0) return null;
  const cycle = entry.cycle;
  const partial = cycle !== undefined && placement.partialDays.has(date);
  return {
    date,
    day_strain: cycle && !isOpenCycle(cycle) && !partial ? roundTo(cycleStrain(cycle), 2) : null,
    day_strain_partial: partial,
    workouts: workoutsUsable ? summaries.length : null,
    trimp: workoutsUsable ? roundTo(totalTrimp(summaries.map(({ summary }) => summary)), 1) : null,
  };
}

function buildNextMorning(input: {
  cycle: Cycle | undefined;
  status: DayStatus;
  history: PlacedHistory;
  cyclesUsable: boolean;
  recoveriesUsable: boolean;
  sleepById: Map<string, Sleep>;
}): NextMorning {
  const { cycle, status, history, cyclesUsable, recoveriesUsable, sleepById } = input;
  const empty = {
    recovery_score: null,
    calibrating: null,
    hrv_rmssd_milli: null,
    resting_heart_rate: null,
  };
  if (!cycle) {
    if (!cyclesUsable) return { date: null, status: "unavailable", ...empty };
    return { date: null, status: status === "no_cycle_yet" ? "not_yet" : "missing", ...empty };
  }
  if (isOpenCycle(cycle)) return { date: null, status: "not_yet", ...empty };
  const next = nextCycle(cycle, history.cycles);
  if (!next) {
    // No cycle starts where this one ended. When a later cycle exists, the
    // strap was off in between and no recovery follows this cycle; otherwise
    // the next cycle has not synced yet.
    const startMs = Date.parse(cycle.start);
    const later = history.cycles.some((candidate) => Date.parse(candidate.start) > startMs);
    return { date: null, status: later ? "missing" : "not_yet", ...empty };
  }
  const date = history.placement.dayOfCycle.get(next.id) ?? null;
  if (!recoveriesUsable) return { date, status: "unavailable", ...empty };
  const recovery = history.placement.recoveryByCycle.get(next.id);
  if (!recovery) {
    // A cycle is created when its sleep is processed; the recovery follows it.
    const nextSleep = history.placement.mainSleepByCycle.get(next.id);
    const awaiting =
      isOpenCycle(next) && (nextSleep === undefined || nextSleep.score_state === "PENDING_SCORE");
    return { date, status: awaiting ? "pending" : "missing", ...empty };
  }
  if (recovery.score_state === "PENDING_SCORE") return { date, status: "pending", ...empty };
  const score = scoredOf(recovery);
  if (!score) return { date, status: "missing", ...empty };
  if (isRecoveryHeldBack(recovery, sleepById.get(recovery.sleep_id))) {
    return { date, status: "pending", ...empty };
  }
  return {
    date,
    status: "available",
    recovery_score: roundTo(score.recovery_score, 1),
    calibrating: score.user_calibrating,
    hrv_rmssd_milli: roundTo(score.hrv_rmssd_milli, 1),
    resting_heart_rate: roundTo(score.resting_heart_rate, 0),
  };
}

/** The day's events in time order (all of them; the caller caps the list). */
function buildTimeline(
  cycle: Cycle | undefined,
  mainSleep: Sleep | undefined,
  sleepSection: SleepSection | null,
  naps: readonly Sleep[],
  napSections: ReadonlyArray<{
    start_local: string;
    end_local: string;
    asleep_hours: number | null;
  }>,
  workouts: readonly PlacedSummary[]
): TimelineEntry[] {
  const entries: Array<TimelineEntry & { sortMs: number; order: number }> = [];
  if (cycle) {
    entries.push({
      kind: "cycle_start",
      start_local: localStamp(cycle.start, cycle.timezone_offset),
      end_local: null,
      label: "WHOOP cycle started (sleep onset)",
      id: String(cycle.id),
      sortMs: Date.parse(cycle.start),
      order: 0,
    });
    if (cycle.end !== null && cycle.end !== undefined) {
      entries.push({
        kind: "cycle_end",
        start_local: localStamp(cycle.end, cycle.timezone_offset),
        end_local: null,
        label: "WHOOP cycle ended (next sleep onset)",
        id: String(cycle.id),
        sortMs: Date.parse(cycle.end),
        order: 4,
      });
    }
  }
  if (mainSleep && sleepSection) {
    entries.push({
      kind: "sleep",
      start_local: sleepSection.start_local,
      end_local: sleepSection.end_local,
      label:
        sleepSection.asleep_hours === null
          ? "Main sleep (not scored)"
          : `Main sleep, ${sleepSection.asleep_hours} h asleep`,
      id: mainSleep.id,
      sortMs: Date.parse(mainSleep.start),
      order: 1,
    });
  }
  naps.forEach((nap, index) => {
    const section = napSections[index]!;
    entries.push({
      kind: "nap",
      start_local: section.start_local,
      end_local: section.end_local,
      label:
        section.asleep_hours === null
          ? "Nap (not scored)"
          : `Nap, ${section.asleep_hours} h asleep`,
      id: nap.id,
      sortMs: Date.parse(nap.start),
      order: 2,
    });
  });
  for (const { workout, summary } of workouts) {
    const rounded = roundWorkoutSummary(summary);
    entries.push({
      kind: "workout",
      start_local: rounded.start_local,
      end_local: rounded.end_local,
      label:
        `${rounded.sport_name}, ${rounded.duration_minutes} min` +
        (rounded.strain === null ? "" : `, strain ${rounded.strain}`),
      id: rounded.id,
      sortMs: Date.parse(workout.start),
      order: 3,
    });
  }
  entries.sort(
    (left, right) =>
      left.sortMs - right.sortMs ||
      left.order - right.order ||
      ((left.id ?? "") < (right.id ?? "") ? -1 : (left.id ?? "") > (right.id ?? "") ? 1 : 0)
  );
  return entries.map(({ kind, start_local, end_local, label, id }) => ({
    kind,
    start_local,
    end_local,
    label,
    id,
  }));
}

/** Inputs of {@link buildDataQuality}. */
export interface DayDataQualityInput {
  firstDay: string;
  lastDay: string;
  utcOffset: string;
  nowMs: number;
  /** Instants (ms) of the records used; empty when none */
  observed: readonly number[];
  sources: Record<string, SourceQuality>;
  methodVersion: string;
  /** Tool-specific limitations, after HISTORY_LIMITATIONS */
  limitations: readonly string[];
}

/**
 * data_quality for local days `firstDay`..`lastDay`: the requested period from
 * local midnight of the first day to the end of the last day (or now), the
 * observed period of the records used, both in the user's offset.
 */
export function buildDataQuality(input: DayDataQualityInput): DataQuality {
  const { firstDay, lastDay, utcOffset, nowMs, observed } = input;
  const startMs = localMidnightMs(firstDay, utcOffset);
  const endMs = Math.max(
    startMs,
    Math.min(localMidnightMs(addDays(lastDay, 1), utcOffset) - 1, nowMs)
  );
  let minMs = Infinity;
  let maxMs = -Infinity;
  for (const value of observed) {
    if (!Number.isFinite(value)) continue;
    if (value < minMs) minMs = value;
    if (value > maxMs) maxMs = value;
  }
  return {
    evaluated_at: new Date(nowMs).toISOString(),
    requested_period: {
      start: formatLocalTimestamp(startMs, utcOffset),
      end: formatLocalTimestamp(endMs, utcOffset),
    },
    observed_period:
      minMs <= maxMs
        ? {
            start: formatLocalTimestamp(minMs, utcOffset),
            end: formatLocalTimestamp(maxMs, utcOffset),
          }
        : null,
    sources: input.sources,
    method_version: input.methodVersion,
    limitations: [...HISTORY_LIMITATIONS, ...input.limitations],
  };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const GET_DAY_TOOL = defineTool({
  name: "get_day",
  annotations: { readOnlyHint: true },
  standard: {
    title: "Day details",
    description:
      "One local day in detail, placed as get_calendar places it: the WHOOP cycle (strain, energy, heart rate, cycle_hours), its recovery, main sleep (stages, efficiency, consistency, sleep need), naps, workouts (zones, TRIMP, GPS pace) with totals, the previous day's strain and the next morning's recovery. Pass date (YYYY-MM-DD, 'today', 'yesterday'; default today) or cycle_id. status: complete, in_progress (strain so far), no_cycle_yet (after local midnight before the next sleep syncs; strain still counts toward the previous day), records_without_cycle or no_data. A cycle runs from sleep onset to the next sleep onset, so its energy is not a calendar day's; workouts after midnight before the next sleep count toward the earlier day. Day strain is not the sum of workout strains. Unknown values are null; notes and warnings explain gaps. include_timeline adds the day's events in time order.",
    inputSchema: getDayInputSchema,
    outputSchema: getDayOutputSchema,
    run: getDay,
  },
});
