/**
 * Tool: get_training_load
 *
 * Daily training load on the user's local days, ending at the last completed
 * WHOOP day, with acute (7-day) and chronic (28-day) means, EWMA fatigue and
 * fitness (ATL/CTL/TSB), Foster monotony, local ISO week totals and the load
 * per sport.
 *
 * - Days come from placeDays over cycles (no sleeps are read to stay within
 *   the request budget: a cycle's day is the local day 12 hours after its
 *   start, which matches get_calendar except for main sleeps that start after
 *   noon and end before midnight) and workouts from assignWorkouts.
 * - A day with a placed cycle is worn: without workouts its workout load is 0.
 *   A day without a cycle, or whose history could not be loaded, is unknown
 *   (null), never 0.
 * - Day strain counts only closed, scored cycles that cover a whole day (not
 *   a partial day: the first day of wear, or a cycle starting at local
 *   midnight without a main sleep, as get_weekly_summary, get_trend and
 *   compare_periods decide it with isPartialDay); the open cycle is reported
 *   separately in today_so_far and never enters a window.
 * - EWMA seeding: when WHOOP history predates the loaded window, ATL and CTL
 *   start at the window's first day from the mean of its first 28 days (window
 *   mean); otherwise they start at 0 on the first worn day and CTL/TSB stay
 *   null for 42 days (warming_up until day 84).
 *
 * Also exports the loading, placement and per-day/per-week helpers that
 * get_sport_breakdown and the aggregate variants share.
 */

import { z } from "zod";
import {
  WhoopApiError,
  WhoopAuthError,
  WhoopNetworkError,
  WhoopRateBudgetError,
} from "../api/client.js";
import { ENDPOINT_CYCLE, ENDPOINT_WORKOUT } from "../api/endpoints.js";
import {
  createHistoryBudget,
  HISTORY_CHUNK_MS,
  HISTORY_DEADLINE_MS,
  HISTORY_LIMITATIONS,
  loadHistory,
  type HistoryBudget,
  type HistorySource,
  type LoadHistoryOptions,
} from "../api/history.js";
import { cycleRecordSchema, workoutRecordSchema } from "../api/record-schemas.js";
import type { Cycle, Workout } from "../api/types.js";
import {
  dataQualitySchema,
  DISCLAIMER,
  exclude,
  finishQuality,
  formatLocalTimestamp,
  localDay,
  localMidnightMs,
  mostRelevantError,
  type DataQuality,
  type SourceQuality,
} from "./analytics-utils.js";
import { resolveUserUtcOffsetInfo, withOffsetNote } from "./collection-utils.js";
import {
  addDays,
  assignWorkouts,
  cycleStrain,
  daysBetween,
  fetchRangeForDays,
  isOpenCycle,
  localClock,
  mondayOf,
  placeDays,
  type DayPlacement,
} from "./day-model.js";
import { isPartialDay } from "./get-trend.js";
import { ewmaSeries, fosterWeek, rollingMean, roundTo } from "./stats-utils.js";
import type { ToolContext, ToolVariant } from "./tool-definition.js";
import {
  HR_ZONE_CAVEAT_SPORT,
  MIN_RECORDED_FRACTION,
  normalizeWorkout,
  type WorkoutSummary,
} from "./workout-utils.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Days in the daily series without `days` */
export const TRAINING_LOAD_DEFAULT_DAYS = 42;

/** Fewest days in the daily series */
export const TRAINING_LOAD_MIN_DAYS = 14;

/** Most days in the daily series */
export const TRAINING_LOAD_MAX_DAYS = 180;

/** Days loaded before the series so the 28-day means and the EWMA have history */
export const LOAD_HISTORY_EXTRA_DAYS = 44;

/** Days in the acute window */
export const ACUTE_WINDOW_DAYS = 7;

/** Known days the acute mean needs */
export const ACUTE_MIN_KNOWN_DAYS = 5;

/** Days in the chronic window */
export const CHRONIC_WINDOW_DAYS = 28;

/** Known days the chronic mean (and the window-mean EWMA seed) needs */
export const CHRONIC_MIN_KNOWN_DAYS = 21;

/** Worn days in the analysed history before the load status is "available" */
export const MIN_WORN_DAYS_FOR_LOAD = 28;

/** EWMA time constant of acute training load (fatigue), days */
export const ATL_TAU_DAYS = 7;

/** EWMA time constant of chronic training load (fitness), days */
export const CTL_TAU_DAYS = 42;

/** With zero seeding, CTL and TSB stay null until this many days after the first worn day */
export const CTL_WARMUP_DAYS = 42;

/** With zero seeding, EWMA values are flagged warming_up until this many days after the first worn day */
export const EWMA_WARMUP_DAYS = 84;

/** Worn days both weeks need before a week-over-week change is reported */
export const WEEK_CHANGE_MIN_WORN_DAYS = 5;

/** Cache lifetime of the older-history probe */
export const OLDER_HISTORY_PROBE_TTL_MS = 10 * 60_000;

/**
 * The probe asks for cycles starting this long before local midnight of the
 * first analysed day: a cycle starting later (the evening before) is placed on
 * that day itself, so it is not older history.
 */
export const OLDER_HISTORY_PROBE_MARGIN_MS = 12 * 3_600_000;

/** Most sports listed in load_by_sport_28d */
export const MAX_LOAD_SPORTS = 40;

/** How far back as_of_day is assumed to lie when history is first loaded */
const PROVISIONAL_AS_OF_LAG_DAYS = 2;

/** Daily load metrics */
export const LOAD_METRICS = ["trimp", "day_strain", "workout_minutes", "workout_kj"] as const;

export type LoadMetric = (typeof LOAD_METRICS)[number];

/** Units of each load metric */
export const LOAD_UNITS = {
  trimp: "TRIMP (Edwards)",
  day_strain: "strain (0-21)",
  workout_minutes: "minutes",
  workout_kj: "kJ",
} as const satisfies Record<LoadMetric, string>;

const LOAD_UNIT_VALUES = ["TRIMP (Edwards)", "strain (0-21)", "minutes", "kJ"] as const;

const METHOD_VERSION = "training-load-1";

const LOAD_LIMITATIONS: readonly string[] = [
  "Days are placed from WHOOP cycles only: a cycle counts toward the local day 12 hours after it starts, and a workout toward the day of the cycle containing its start.",
  "TRIMP is Edwards TRIMP from WHOOP %max-HR zones (zone number × zone minutes); it is not a lab-calibrated load and understates strength work.",
  "Acute:chronic ratios, ATL, CTL, TSB and monotony are descriptive statistics of your own load history, not thresholds or advice.",
];

// ---------------------------------------------------------------------------
// Source loading (shared with get_sport_breakdown and the aggregate variants)
// ---------------------------------------------------------------------------

/** Cycles and workouts loaded as history for one tool call */
export interface TrainingSources {
  cycles: HistorySource<Cycle>;
  workouts: HistorySource<Workout>;
}

/** History options for one tool call: a shared request budget and the call's clock */
export function trainingHistoryOptions(
  ctx: ToolContext
): LoadHistoryOptions & { budget: HistoryBudget } {
  return {
    budget: createHistoryBudget({ deadlineMs: ctx.startedAtMs + HISTORY_DEADLINE_MS }),
    now: ctx.now,
    ...(ctx.historyCache !== undefined ? { cache: ctx.historyCache } : {}),
  };
}

/** Load cycles and workouts over [startMs, endMs) in parallel within one budget */
export async function loadTrainingSources(
  ctx: ToolContext,
  options: LoadHistoryOptions,
  startMs: number,
  endMs: number
): Promise<TrainingSources> {
  const period = { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() };
  const [cycles, workouts] = await Promise.all([
    loadHistory<Cycle>(ctx.client, ENDPOINT_CYCLE, period, cycleRecordSchema, options),
    loadHistory<Workout>(ctx.client, ENDPOINT_WORKOUT, period, workoutRecordSchema, options),
  ]);
  return { cycles, workouts };
}

/** True when a history source could not be read at all */
export function sourceUnreadable(source: { quality: SourceQuality }): boolean {
  return source.quality.status === "fetch_failed" || source.quality.status === "invalid";
}

/**
 * Throw the most relevant WHOOP error when every source failed to load. Sources
 * that only returned malformed data carry no error and are reported as
 * warnings instead.
 */
export function throwIfAllFailed(sources: readonly HistorySource<unknown>[]): void {
  if (!sources.every((source) => source.quality.status === "fetch_failed")) return;
  throw mostRelevantError(sources.map((source) => source.error));
}

/** Why a WHOOP request failed, by error type and HTTP status only (never bodies or URLs) */
export function failureReason(error: unknown, depth = 0): string {
  if (error instanceof WhoopRateBudgetError) return "this call's request budget ran out";
  if (error instanceof WhoopApiError) return `WHOOP API returned HTTP ${error.statusCode}`;
  if ((error instanceof WhoopNetworkError || error instanceof WhoopAuthError) && depth < 3) {
    const cause = error.cause;
    if (
      cause instanceof WhoopApiError ||
      cause instanceof WhoopAuthError ||
      cause instanceof WhoopNetworkError ||
      cause instanceof WhoopRateBudgetError
    ) {
      return failureReason(cause, depth + 1);
    }
  }
  if (error instanceof WhoopAuthError) return "WHOOP authentication failed";
  if (error instanceof WhoopNetworkError) return "network error";
  if (error instanceof z.ZodError) return "unexpected data format";
  return "unexpected error";
}

/** "1 session" / "3 sessions" */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/**
 * Warnings for a source that could not be read at all or whose records partly
 * failed validation. `consequence` completes "…, so <consequence>."
 */
export function sourceWarnings(
  label: string,
  source: HistorySource<unknown>,
  consequence: string
): string[] {
  const warnings: string[] = [];
  if (source.quality.status === "fetch_failed") {
    warnings.push(
      `${label} data could not be loaded (${failureReason(source.error)}), so ${consequence}.`
    );
  } else if (source.quality.status === "invalid") {
    warnings.push(`${label} data from WHOOP did not match the expected format, so ${consequence}.`);
  }
  const invalid = source.quality.exclusions.invalid ?? 0;
  if (invalid > 0 && source.quality.status !== "invalid") {
    warnings.push(
      `${plural(invalid, `${label.toLowerCase()} record`)} did not match the expected WHOOP format and ${invalid === 1 ? "was" : "were"} skipped.`
    );
  }
  return warnings;
}

/**
 * A note for a source read only partly (a later page failed, or the request
 * budget, deadline or a record cap ran out); null when it is complete or
 * unreadable. `consequence` completes "…, so <consequence>."
 */
export function truncationNote(
  label: string,
  source: HistorySource<unknown>,
  utcOffset: string,
  consequence: string
): string | null {
  if (!source.quality.truncated || sourceUnreadable(source)) return null;
  const error = source.partialError;
  const reason = error === undefined ? "a per-call record limit was reached" : failureReason(error);
  const since =
    source.complete_since === null
      ? "even the most recent records may be incomplete"
      : `records starting before ${localClock(source.complete_since, utcOffset)} local time may be missing`;
  return `${label} history could not be read completely (${reason}): ${since}, so ${consequence}. Repeating the request continues loading from the cache.`;
}

/**
 * Epoch ms from which a source's records are complete; +Infinity when the
 * source is unreadable or not even its newest chunk is complete.
 */
export function coveredSinceMs(source: HistorySource<unknown>): number {
  if (sourceUnreadable(source) || source.complete_since === null) return Number.POSITIVE_INFINITY;
  return Date.parse(source.complete_since);
}

/**
 * True when every record that can belong to local `day` was loaded: a record
 * placed on a day starts at the earliest on the previous day, so the whole
 * previous day must lie in the complete range.
 */
export function dayCovered(day: string, coveredSince: number, utcOffset: string): boolean {
  return localMidnightMs(addDays(day, -1), utcOffset) >= coveredSince;
}

/**
 * Merge an older load into a newer one of the same collection. The older
 * load's period ends where the newer load's first chunk starts; records are
 * deduplicated by id keeping the most recently updated version.
 */
export function mergeOlderHistory<T extends { id: string | number; updated_at: string }>(
  newer: HistorySource<T>,
  older: HistorySource<T>,
  olderEndMs: number
): HistorySource<T> {
  if (sourceUnreadable(newer)) return newer;
  const quality: SourceQuality = {
    ...newer.quality,
    exclusions: { ...newer.quality.exclusions },
    truncated: newer.quality.truncated || older.quality.truncated || sourceUnreadable(older),
  };
  if (sourceUnreadable(older)) {
    const partialError = newer.partialError ?? older.error;
    return {
      ...newer,
      quality,
      ...(partialError !== undefined ? { partialError } : {}),
    };
  }
  const byId = new Map<string, T>();
  for (const record of newer.records) byId.set(String(record.id), record);
  let duplicates = 0;
  for (const record of older.records) {
    const key = String(record.id);
    const current = byId.get(key);
    if (current === undefined) byId.set(key, record);
    else {
      duplicates += 1;
      if (Date.parse(record.updated_at) > Date.parse(current.updated_at)) byId.set(key, record);
    }
  }
  quality.records_fetched =
    newer.quality.records_fetched + older.quality.records_fetched - duplicates;
  for (const [reason, count] of Object.entries(older.quality.exclusions)) {
    quality.exclusions[reason] = (quality.exclusions[reason] ?? 0) + count;
  }
  quality.cache_status =
    newer.quality.cache_status === "hit" && older.quality.cache_status === "hit" ? "hit" : "miss";
  const fetched = [newer.quality.fetched_at, older.quality.fetched_at].filter(
    (value): value is string => value !== null
  );
  quality.fetched_at =
    fetched.length > 0
      ? new Date(Math.min(...fetched.map((value) => Date.parse(value)))).toISOString()
      : null;
  const partialError = newer.partialError ?? older.partialError;
  return {
    records: [...byId.values()],
    quality,
    complete_since: older.complete_since ?? new Date(olderEndMs).toISOString(),
    chunks_total: newer.chunks_total + older.chunks_total,
    chunks_from_cache: newer.chunks_from_cache + older.chunks_from_cache,
    ...(partialError !== undefined ? { partialError } : {}),
  };
}

/**
 * Place cycles on local days without sleeps. Partial first days (a cycle
 * starting exactly at local midnight, as WHOOP starts the first cycle of wear)
 * are still detected.
 */
export function placeTrainingDays(
  cycles: readonly Cycle[],
  today: string,
  utcOffset: string
): DayPlacement {
  return placeDays({ cycles, sleeps: [], recoveries: [], sleepsAvailable: true, today, utcOffset });
}

// ---------------------------------------------------------------------------
// Sessions and days (shared)
// ---------------------------------------------------------------------------

/** One workout placed on a local day */
export interface TrainingSession {
  /** Unrounded normalized workout */
  summary: WorkoutSummary;
  startMs: number;
  endMs: number;
  /** Id of the cycle containing the start, or null (placed on its local start day) */
  cycleId: number | null;
  scored: boolean;
  pending: boolean;
  /** Recorded fraction >= MIN_RECORDED_FRACTION (heart-rate derived values usable) */
  fullyRecorded: boolean;
}

/**
 * Normalize and place every workout. Workouts ending at or before their start
 * are counted as invalid_duration in `quality`. Sorted by start, then id.
 */
export function buildSessions(
  workouts: readonly Workout[],
  placement: DayPlacement,
  cycles: readonly Cycle[],
  quality: SourceQuality
): TrainingSession[] {
  const placements = assignWorkouts(workouts, placement, cycles);
  const sessions: TrainingSession[] = [];
  for (const workout of workouts) {
    const workoutPlacement = placements.get(workout.id) ?? null;
    const summary = normalizeWorkout(
      workout,
      workoutPlacement,
      workoutPlacement?.cycle ? isOpenCycle(workoutPlacement.cycle) : false
    );
    if (!summary) {
      exclude(quality, "invalid_duration");
      continue;
    }
    const scored = summary.score_state === "SCORED" && !summary.flags.includes("not_scored");
    sessions.push({
      summary,
      startMs: Date.parse(workout.start),
      endMs: Date.parse(workout.end),
      cycleId: workoutPlacement?.cycle?.id ?? null,
      scored,
      pending: summary.score_state === "PENDING_SCORE",
      fullyRecorded:
        scored &&
        summary.recorded_fraction !== null &&
        summary.recorded_fraction >= MIN_RECORDED_FRACTION,
    });
  }
  return sessions.sort(
    (left, right) =>
      left.startMs - right.startMs ||
      (left.summary.id < right.summary.id ? -1 : left.summary.id > right.summary.id ? 1 : 0)
  );
}

/** Flags on one day of the load series */
export const TRAINING_DAY_FLAGS = [
  "partial_day",
  "cycle_in_progress",
  "strain_not_scored",
  "low_recording",
  "pending_workout",
  "workouts_without_cycle",
  "history_not_loaded",
] as const;

export type TrainingDayFlag = (typeof TRAINING_DAY_FLAGS)[number];

/** One local day with its workout and strain values (unrounded) */
export interface TrainingDay {
  date: string;
  /** A cycle is placed on the day; null when the cycle history for the day was not loaded */
  worn: boolean | null;
  partial: boolean;
  in_progress: boolean;
  /** Closed, scored cycle covering the whole day */
  day_strain: number | null;
  /** Scored sessions on a worn day with loaded workouts, else null */
  sessions: number | null;
  workout_minutes: number | null;
  /** Null also when a session recorded less than MIN_RECORDED_FRACTION */
  trimp: number | null;
  workout_kj: number | null;
  flags: TrainingDayFlag[];
  /** Scored sessions placed on the day, worn or not */
  scoredSessions: TrainingSession[];
  /** A PENDING_SCORE session is placed on the day */
  hasPending: boolean;
  /** A scored session recorded less than MIN_RECORDED_FRACTION */
  lowRecording: boolean;
  /** Workouts were loaded completely for the day */
  workoutsKnown: boolean;
}

/** Inputs of {@link buildTrainingDays} */
export interface TrainingDaysInput {
  firstDay: string;
  lastDay: string;
  placement: DayPlacement;
  sessions: readonly TrainingSession[];
  cyclesAvailable: boolean;
  cyclesCoveredSince: number;
  workoutsAvailable: boolean;
  workoutsCoveredSince: number;
  utcOffset: string;
}

/** Every local day from firstDay to lastDay (inclusive), oldest first */
export function buildTrainingDays(input: TrainingDaysInput): TrainingDay[] {
  const { placement, utcOffset } = input;
  const byDay = new Map<string, TrainingSession[]>();
  for (const session of input.sessions) {
    const list = byDay.get(session.summary.day) ?? [];
    list.push(session);
    byDay.set(session.summary.day, list);
  }
  const days: TrainingDay[] = [];
  for (let day = input.firstDay; day <= input.lastDay; day = addDays(day, 1)) {
    const cycle = placement.cycleByDay.get(day);
    const cyclesKnown =
      input.cyclesAvailable && dayCovered(day, input.cyclesCoveredSince, utcOffset);
    const worn = cycle !== undefined ? true : cyclesKnown ? false : null;
    // The same rule as every other day-strain tool: a partial day does not depend
    // on how far back this call fetched, so weekly means agree across tools.
    const partial = cycle !== undefined && isPartialDay(placement, day, cycle);
    const inProgress = cycle !== undefined && isOpenCycle(cycle);
    const strain = cycle !== undefined ? cycleStrain(cycle) : null;
    const dayStrain = cycle !== undefined && !inProgress && !partial ? strain : null;

    const placed = byDay.get(day) ?? [];
    const scoredSessions = placed.filter((session) => session.scored);
    const hasPending = placed.some((session) => session.pending);
    const lowRecording = scoredSessions.some((session) => !session.fullyRecorded);
    const workoutsKnown =
      input.workoutsAvailable && dayCovered(day, input.workoutsCoveredSince, utcOffset);
    const valuesKnown = worn === true && workoutsKnown;
    const sum = (value: (summary: WorkoutSummary) => number | null): number =>
      scoredSessions.reduce((total, session) => total + (value(session.summary) ?? 0), 0);

    const flags = new Set<TrainingDayFlag>();
    if (partial) flags.add("partial_day");
    if (inProgress) flags.add("cycle_in_progress");
    if (cycle !== undefined && !inProgress && !partial && strain === null) {
      flags.add("strain_not_scored");
    }
    if (lowRecording) flags.add("low_recording");
    if (hasPending) flags.add("pending_workout");
    if (worn === false && scoredSessions.length > 0) flags.add("workouts_without_cycle");
    if (
      (input.cyclesAvailable && !cyclesKnown && cycle === undefined) ||
      (input.workoutsAvailable && !workoutsKnown)
    ) {
      flags.add("history_not_loaded");
    }

    days.push({
      date: day,
      worn,
      partial,
      in_progress: inProgress,
      day_strain: dayStrain,
      sessions: valuesKnown ? scoredSessions.length : null,
      workout_minutes: valuesKnown && !hasPending ? sum((s) => s.duration_minutes) : null,
      trimp: valuesKnown && !hasPending && !lowRecording ? sum((s) => s.trimp) : null,
      workout_kj: valuesKnown && !hasPending ? sum((s) => s.kilojoule) : null,
      flags: TRAINING_DAY_FLAGS.filter((flag) => flags.has(flag)),
      scoredSessions,
      hasPending,
      lowRecording,
      workoutsKnown,
    });
  }
  return days;
}

/** A day's load in `metric` (null when unknown) */
export function dayLoad(day: TrainingDay, metric: LoadMetric): number | null {
  switch (metric) {
    case "trimp":
      return day.trimp;
    case "day_strain":
      return day.day_strain;
    case "workout_minutes":
      return day.workout_minutes;
    case "workout_kj":
      return day.workout_kj;
  }
}

/** Totals of one local ISO week (unrounded) */
export interface TrainingWeekTotals {
  week_start: string;
  /** Days of the week inside the analysed range */
  dayCount: number;
  /** Null when a day's cycle history was not loaded */
  worn_days: number | null;
  /**
   * Scored sessions placed in the week; null when workouts were not loaded for
   * every day, or when the week has neither a worn day nor a session (no data)
   */
  sessions: number | null;
  active_days: number | null;
  /** Null also while a session in the week is not scored yet */
  workout_minutes: number | null;
  /** Null also when a session recorded less than MIN_RECORDED_FRACTION */
  trimp: number | null;
  workout_kj: number | null;
  mean_day_strain: number | null;
  max_day_strain: number | null;
  /** Days with a day strain (closed, scored, whole-day cycles); null when a day's cycles were not loaded */
  completed_cycles: number | null;
}

/** Totals of the week starting `monday` over the given days (those in the week are used) */
export function summarizeWeek(monday: string, days: readonly TrainingDay[]): TrainingWeekTotals {
  const sunday = addDays(monday, 6);
  const inWeek = days.filter((day) => day.date >= monday && day.date <= sunday);
  const wornUnknown = inWeek.some((day) => day.worn === null);
  const scored = inWeek.flatMap((day) => day.scoredSessions);
  // A week without a worn day or a session has no data: unknown, not 0.
  const noData = !wornUnknown && scored.length === 0 && inWeek.every((day) => day.worn === false);
  const workoutsKnown = inWeek.length > 0 && !noData && inWeek.every((day) => day.workoutsKnown);
  const pending = inWeek.some((day) => day.hasPending);
  const lowRecording = inWeek.some((day) => day.lowRecording);
  const strains = inWeek
    .map((day) => day.day_strain)
    .filter((value): value is number => value !== null);
  const sum = (value: (summary: WorkoutSummary) => number | null): number =>
    scored.reduce((total, session) => total + (value(session.summary) ?? 0), 0);
  return {
    week_start: monday,
    dayCount: inWeek.length,
    worn_days: wornUnknown ? null : inWeek.filter((day) => day.worn === true).length,
    sessions: workoutsKnown ? scored.length : null,
    active_days: workoutsKnown
      ? inWeek.filter((day) => day.scoredSessions.length > 0).length
      : null,
    workout_minutes: workoutsKnown && !pending ? sum((s) => s.duration_minutes) : null,
    trimp: workoutsKnown && !pending && !lowRecording ? sum((s) => s.trimp) : null,
    workout_kj: workoutsKnown && !pending ? sum((s) => s.kilojoule) : null,
    mean_day_strain:
      strains.length > 0
        ? strains.reduce((total, value) => total + value, 0) / strains.length
        : null,
    max_day_strain: strains.length > 0 ? Math.max(...strains) : null,
    completed_cycles: wornUnknown ? null : strains.length,
  };
}

/** A week's load in `metric`: the week total, or the mean day strain */
export function weekLoad(week: TrainingWeekTotals, metric: LoadMetric): number | null {
  switch (metric) {
    case "trimp":
      return week.trimp;
    case "day_strain":
      return week.mean_day_strain;
    case "workout_minutes":
      return week.workout_minutes;
    case "workout_kj":
      return week.workout_kj;
  }
}

/** Percent change from `previous` to `current`, or null when previous is not above 0 */
export function percentChange(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || !(previous > 0)) return null;
  return ((current - previous) / previous) * 100;
}

/**
 * Round non-negative parts to `digits` decimals so they still add up to their
 * rounded total (largest remainder method: floor every part, then give the
 * remaining units to the largest remainders, ties to the earlier part).
 * Percentages of one whole therefore sum to exactly 100.
 * @throws RangeError for negative or non-finite parts
 */
export function roundPartsToTotal(parts: readonly number[], digits: number): number[] {
  if (parts.some((part) => !Number.isFinite(part) || part < 0)) {
    throw new RangeError("roundPartsToTotal requires non-negative finite parts.");
  }
  const factor = 10 ** digits;
  const scaled = parts.map((part) => part * factor);
  const target = Math.round(scaled.reduce((sum, part) => sum + part, 0));
  const units = scaled.map((part) => Math.floor(part + 1e-9));
  let remaining = target - units.reduce((sum, unit) => sum + unit, 0);
  const order = scaled
    .map((part, index) => ({ index, remainder: part - Math.floor(part + 1e-9) }))
    .sort((left, right) => right.remainder - left.remainder || left.index - right.index);
  for (const { index } of order) {
    if (remaining <= 0) break;
    units[index] = units[index]! + 1;
    remaining -= 1;
  }
  return units.map((unit) => roundTo(unit / factor, digits));
}

/** The period WHOOP records span, each end in its own offset; null without records */
export function observedSpan(
  items: readonly { startMs: number; endMs: number; offset: string }[]
): { start: string; end: string } | null {
  if (items.length === 0) return null;
  let first = items[0]!;
  let last = items[0]!;
  for (const item of items) {
    if (item.startMs < first.startMs) first = item;
    if (item.endMs > last.endMs) last = item;
  }
  return {
    start: formatLocalTimestamp(first.startMs, first.offset),
    end: formatLocalTimestamp(last.endMs, last.offset),
  };
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const trainingLoadInputSchema = z.object({
  load_metric: z
    .enum(LOAD_METRICS)
    .optional()
    .describe(
      "Daily load for acute/chronic, EWMA and monotony. trimp (default) = zone-weighted workout minutes; day_strain = WHOOP day strain of completed cycles (0-21, non-linear)."
    ),
  days: z
    .number()
    .int()
    .min(TRAINING_LOAD_MIN_DAYS)
    .max(TRAINING_LOAD_MAX_DAYS)
    .optional()
    .describe("Days in the daily series, ending at the last completed WHOOP day (default 42)."),
});

export type TrainingLoadInput = z.infer<typeof trainingLoadInputSchema>;

const nullableNumber = z.number().nullable();

const fosterSchema = z.object({
  monotony: nullableNumber.describe("Mean daily load / sample SD of the 7 daily loads"),
  foster_strain: nullableNumber.describe("Weekly load total × monotony"),
  reason: z
    .enum(["unknown_days", "identical_daily_loads"])
    .nullable()
    .describe("Why monotony is null"),
});

const dayEntrySchema = z.object({
  date: z.string(),
  worn: z
    .boolean()
    .nullable()
    .describe("A WHOOP cycle is placed on the day; null when that history could not be loaded"),
  partial: z
    .boolean()
    .describe(
      "The cycle covers only part of the day: the first day of wear, or a cycle starting at local midnight without a main sleep (strap put back on)"
    ),
  in_progress: z.boolean(),
  sessions: z.number().int().nullable(),
  workout_minutes: nullableNumber.describe("Elapsed minutes of scored sessions"),
  trimp: nullableNumber.describe("Null when a session recorded less than 90% heart-rate data"),
  workout_kj: nullableNumber,
  day_strain: nullableNumber.describe("Closed, scored cycles covering a whole day only"),
  load: nullableNumber.describe("The day's value in load_metric; null when unknown (never 0)"),
  acute_mean: nullableNumber,
  chronic_mean: nullableNumber,
  ratio: nullableNumber.describe("acute_mean / chronic_mean"),
  atl: nullableNumber,
  ctl: nullableNumber,
  tsb: nullableNumber.describe("ctl − atl"),
  flags: z.array(z.enum(TRAINING_DAY_FLAGS)),
});

const weekSchema = z.object({
  week_start: z.string().describe("Monday of the local ISO week"),
  in_progress: z.boolean().describe("The week continues after as_of_day"),
  worn_days: z.number().int().nullable(),
  sessions: z
    .number()
    .int()
    .nullable()
    .describe(
      "Scored sessions placed in the week up to as_of_day; null without any worn day or session, or when workouts were not loaded"
    ),
  active_days: z.number().int().nullable(),
  workout_minutes: nullableNumber.describe("Null also while a session is not scored yet"),
  trimp: nullableNumber.describe("Null also when a session recorded less than 90% heart-rate data"),
  workout_kj: nullableNumber,
  mean_day_strain: nullableNumber,
  max_day_strain: nullableNumber,
  completed_cycles: z
    .number()
    .int()
    .nullable()
    .describe("Days with a day strain (closed, scored, whole-day cycles)"),
  monotony: nullableNumber,
  change_vs_previous_pct: nullableNumber.describe(
    "Change of the week's load (total, or mean day strain) from the week before; needs 5 worn days in both weeks"
  ),
});

const sportLoadSchema = z.object({
  sport_name: z.string(),
  sessions: z.number().int(),
  load: z.number(),
  share_pct: nullableNumber,
  sessions_without_load: z
    .number()
    .int()
    .describe("Sessions left out of load (TRIMP needs 90% recorded heart-rate data)"),
});

export const trainingLoadOutputSchema = z.object({
  status: z.enum(["available", "insufficient_history", "unavailable"]),
  period: z.object({
    start_day: z.string().nullable(),
    end_day: z.string().nullable(),
    days: z.number().int(),
    utc_offset: z.string(),
  }),
  as_of_day: z
    .string()
    .nullable()
    .describe("The last completed WHOOP day (never the open cycle's day)"),
  load_metric: z.enum(LOAD_METRICS),
  load_unit: z.enum(LOAD_UNIT_VALUES),
  acute_chronic: z.object({
    acute_mean: nullableNumber.describe("Mean daily load of the last 7 days (5 known days needed)"),
    chronic_mean: nullableNumber.describe(
      "Mean daily load of the last 28 days (21 known days needed)"
    ),
    ratio: nullableNumber,
    acute_known_days: z.number().int(),
    chronic_known_days: z.number().int(),
    available_from_day: z
      .string()
      .nullable()
      .describe("First worn day + 27: the first day a 28-day window can be complete"),
    reading: z.string().nullable(),
  }),
  ewma_seed: z.enum(["window_mean", "zero_at_first_worn_day"]).nullable(),
  ewma: z.object({
    atl: nullableNumber.describe("Acute training load, EWMA with a 7-day time constant"),
    ctl: nullableNumber.describe("Chronic training load, EWMA with a 42-day time constant"),
    tsb: nullableNumber.describe("ctl − atl"),
    started_on: z.string().nullable(),
    warming_up: z.boolean(),
    unknown_days_counted_as_zero: z.number().int(),
  }),
  monotony: z.object({
    last_7_days: fosterSchema.extend({ start_day: z.string(), end_day: z.string() }).nullable(),
    last_completed_week: fosterSchema.extend({ week_start: z.string() }).nullable(),
  }),
  weeks: z.array(weekSchema),
  load_by_sport_28d: z.array(sportLoadSchema),
  today_so_far: z
    .object({
      date: z.string(),
      day_strain: nullableNumber,
      sessions: z.number().int().nullable(),
      load: nullableNumber,
    })
    .nullable()
    .describe("The open cycle so far; never part of any window"),
  history: z.object({
    analysed_from_day: z.string().nullable(),
    first_worn_day: z.string().nullable(),
    first_worn_day_is_lower_bound: z.boolean(),
    worn_days: z.number().int().describe("Worn days from analysed_from_day to as_of_day"),
    unknown_days: z
      .number()
      .int()
      .describe("Days from analysed_from_day to as_of_day without a known load"),
  }),
  days: z.array(dayEntrySchema),
  output_capped: z.boolean(),
  truncated: z.boolean(),
  notes: z.array(z.string()),
  warnings: z.array(z.string()),
  disclaimer: z.string(),
  data_quality: dataQualitySchema,
});

export type TrainingLoadOutput = z.infer<typeof trainingLoadOutputSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type EwmaSeed = "window_mean" | "zero_at_first_worn_day";

function round1(value: number | null): number | null {
  return roundTo(value, 1);
}

function fosterOutput(loads: readonly (number | null)[]): z.infer<typeof fosterSchema> {
  const result = fosterWeek(loads);
  return {
    monotony: roundTo(result.monotony, 2),
    foster_strain: round1(result.strain),
    reason: result.reason,
  };
}

/** "Acute load (mean of the last 7 days) is 18% above the 28-day mean" */
export function acuteChronicReading(ratio: number): string {
  const pct = roundTo((ratio - 1) * 100, 0);
  if (pct === 0) return "Acute load (mean of the last 7 days) equals the 28-day mean.";
  return `Acute load (mean of the last 7 days) is ${Math.abs(pct)}% ${pct > 0 ? "above" : "below"} the 28-day mean.`;
}

/** Whether cycles exist before `beforeMs`: true/false, or the error when the probe failed */
async function probeOlderHistory(
  ctx: ToolContext,
  beforeMs: number,
  deadlineMs: number
): Promise<{ found: boolean } | { error: unknown }> {
  const query = new URLSearchParams({ end: new Date(beforeMs).toISOString(), limit: "1" });
  try {
    const page = z.object({ records: z.array(z.unknown()) }).parse(
      await ctx.client.get<unknown>(`${ENDPOINT_CYCLE}?${query.toString()}`, {
        cache: true,
        ttlMs: OLDER_HISTORY_PROBE_TTL_MS,
        deadlineMs,
      })
    );
    return { found: page.records.length > 0 };
  } catch (error: unknown) {
    return { error };
  }
}

/** The newest placed day at or before `today` whose cycle is closed */
function lastCompletedDay(placement: DayPlacement, today: string): string | null {
  let best: string | null = null;
  for (const [day, cycle] of placement.cycleByDay) {
    if (day > today || isOpenCycle(cycle)) continue;
    if (best === null || day > best) best = day;
  }
  return best;
}

function emptyOutput(
  metric: LoadMetric,
  utcOffset: string,
  base: Pick<TrainingLoadOutput, "status" | "notes" | "warnings" | "data_quality" | "truncated">
): TrainingLoadOutput {
  return {
    status: base.status,
    period: { start_day: null, end_day: null, days: 0, utc_offset: utcOffset },
    as_of_day: null,
    load_metric: metric,
    load_unit: LOAD_UNITS[metric],
    acute_chronic: {
      acute_mean: null,
      chronic_mean: null,
      ratio: null,
      acute_known_days: 0,
      chronic_known_days: 0,
      available_from_day: null,
      reading: null,
    },
    ewma_seed: null,
    ewma: {
      atl: null,
      ctl: null,
      tsb: null,
      started_on: null,
      warming_up: false,
      unknown_days_counted_as_zero: 0,
    },
    monotony: { last_7_days: null, last_completed_week: null },
    weeks: [],
    load_by_sport_28d: [],
    today_so_far: null,
    history: {
      analysed_from_day: null,
      first_worn_day: null,
      first_worn_day_is_lower_bound: false,
      worn_days: 0,
      unknown_days: 0,
    },
    days: [],
    output_capped: false,
    truncated: base.truncated,
    notes: base.notes,
    warnings: base.warnings,
    disclaimer: DISCLAIMER,
    data_quality: base.data_quality,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Run get_training_load.
 *
 * @throws the most relevant WHOOP error when both cycles and workouts fail to load
 */
export async function getTrainingLoad(
  args: TrainingLoadInput,
  ctx: ToolContext
): Promise<TrainingLoadOutput> {
  const now = ctx.now();
  const nowMs = now.getTime();
  const { offset: utcOffset, fallback: offsetFallback } = await resolveUserUtcOffsetInfo(
    ctx.client
  );
  const today = localDay(now.toISOString(), utcOffset);
  const metric: LoadMetric = args.load_metric ?? "trimp";
  const seriesDays = args.days ?? TRAINING_LOAD_DEFAULT_DAYS;
  const notes: string[] = [];
  const warnings: string[] = [];
  const workoutMetric = metric !== "day_strain";

  // --- Load ------------------------------------------------------------------

  const options = trainingHistoryOptions(ctx);
  const analysedFromFor = (asOfDay: string): string =>
    addDays(asOfDay, -(seriesDays + LOAD_HISTORY_EXTRA_DAYS));
  const provisionalAsOf = addDays(today, -PROVISIONAL_AS_OF_LAG_DAYS);
  const provisionalRange = fetchRangeForDays(
    analysedFromFor(provisionalAsOf),
    today,
    utcOffset,
    nowMs
  );
  let { cycles, workouts } = await loadTrainingSources(
    ctx,
    options,
    provisionalRange.startMs,
    provisionalRange.endMs
  );
  throwIfAllFailed([cycles, workouts]);

  const cyclesAvailable = !sourceUnreadable(cycles);
  const workoutsAvailable = !sourceUnreadable(workouts);
  let placement = placeTrainingDays(cyclesAvailable ? cycles.records : [], today, utcOffset);
  let asOf = cyclesAvailable ? lastCompletedDay(placement, today) : null;

  // The strap was off for days: read the older history the window needs.
  if (asOf !== null) {
    const neededStartMs = fetchRangeForDays(analysedFromFor(asOf), asOf, utcOffset, nowMs).startMs;
    const loadedFromMs = Math.floor(provisionalRange.startMs / HISTORY_CHUNK_MS) * HISTORY_CHUNK_MS;
    const completeBack = (source: HistorySource<unknown>): boolean =>
      source.complete_since !== null &&
      Date.parse(source.complete_since) <= provisionalRange.startMs;
    if (
      neededStartMs < loadedFromMs &&
      completeBack(cycles) &&
      (!workoutsAvailable || completeBack(workouts))
    ) {
      const older = await loadTrainingSources(ctx, options, neededStartMs, loadedFromMs);
      cycles = mergeOlderHistory(cycles, older.cycles, loadedFromMs);
      if (workoutsAvailable) workouts = mergeOlderHistory(workouts, older.workouts, loadedFromMs);
      placement = placeTrainingDays(cycles.records, today, utcOffset);
      asOf = lastCompletedDay(placement, today);
    }
  }

  warnings.push(
    ...sourceWarnings("Cycle", cycles, "worn days, day strain and the load series are unavailable"),
    ...sourceWarnings(
      "Workout",
      workouts,
      metric === "day_strain"
        ? "sessions, workout minutes, TRIMP and kJ are null (the day_strain load is unaffected)"
        : "sessions, workout minutes, TRIMP and kJ are null"
    )
  );

  const cycleQuality = cycles.quality;
  const workoutQuality = workouts.quality;
  const sessions = workoutsAvailable
    ? buildSessions(workouts.records, placement, cycles.records, workoutQuality)
    : [];
  const truncated = cycles.quality.truncated || workouts.quality.truncated;

  // --- Nothing to analyse -----------------------------------------------------------

  const evaluatedAt = formatLocalTimestamp(nowMs, utcOffset);
  const baseQuality = (
    requested: { start: string; end: string },
    observed: DataQuality["observed_period"]
  ): DataQuality => ({
    evaluated_at: evaluatedAt,
    requested_period: requested,
    observed_period: observed,
    sources: { cycles: cycleQuality, workouts: workoutQuality },
    method_version: METHOD_VERSION,
    limitations: [...HISTORY_LIMITATIONS, ...LOAD_LIMITATIONS],
  });
  const dayPeriod = (first: string, last: string): { start: string; end: string } => ({
    start: formatLocalTimestamp(localMidnightMs(first, utcOffset), utcOffset),
    end: formatLocalTimestamp(localMidnightMs(addDays(last, 1), utcOffset) - 1, utcOffset),
  });

  const openCycle =
    cyclesAvailable && placement.newestCycle && isOpenCycle(placement.newestCycle)
      ? placement.newestCycle
      : null;
  const openDay = openCycle ? (placement.dayOfCycle.get(openCycle.id) ?? null) : null;
  const openSessions = openCycle
    ? sessions.filter((session) => session.cycleId === openCycle.id)
    : [];

  const todaySoFar = (): TrainingLoadOutput["today_so_far"] => {
    if (!openCycle || openDay === null) return null;
    const scored = openSessions.filter((session) => session.scored);
    const pending = openSessions.some((session) => session.pending);
    const lowRecording = scored.some((session) => !session.fullyRecorded);
    const sum = (value: (summary: WorkoutSummary) => number | null): number =>
      scored.reduce((total, session) => total + (value(session.summary) ?? 0), 0);
    let load: number | null;
    if (metric === "day_strain") load = cycleStrain(openCycle);
    else if (!workoutsAvailable || pending) load = null;
    else if (metric === "trimp") load = lowRecording ? null : sum((s) => s.trimp);
    else if (metric === "workout_minutes") load = sum((s) => s.duration_minutes);
    else load = sum((s) => s.kilojoule);
    return {
      date: openDay,
      day_strain: round1(cycleStrain(openCycle)),
      sessions: workoutsAvailable ? scored.length : null,
      load: round1(load),
    };
  };

  /**
   * Count the records used (placed on a day from `first` to `last`, or in the
   * open cycle) and the exclusions, finish both source qualities and return
   * the spans of the records used in the range.
   */
  const accountSources = (
    first: string | null,
    last: string | null,
    outsideReason: string
  ): { startMs: number; endMs: number; offset: string }[] => {
    const observed: { startMs: number; endMs: number; offset: string }[] = [];
    const inRange = (day: string): boolean =>
      first !== null && last !== null && day >= first && day <= last;
    const placedIds = new Set<number>();
    for (const [day, cycle] of placement.cycleByDay) {
      if (inRange(day)) placedIds.add(cycle.id);
    }
    const usedCycles: Cycle[] = [];
    for (const cycle of cycles.records) {
      const placed = placedIds.has(cycle.id);
      if (!placed && cycle.id !== openCycle?.id) {
        exclude(cycleQuality, outsideReason);
        continue;
      }
      usedCycles.push(cycle);
      if (placed) {
        observed.push({
          startMs: Date.parse(cycle.start),
          endMs: cycle.end ? Date.parse(cycle.end) : nowMs,
          offset: cycle.timezone_offset,
        });
      }
    }
    const updatedAt = new Map(workouts.records.map((workout) => [workout.id, workout.updated_at]));
    const usedWorkouts: { updated_at: string }[] = [];
    for (const session of sessions) {
      const placedInRange = inRange(session.summary.day);
      const inOpen = openCycle !== null && session.cycleId === openCycle.id;
      if (!session.scored) {
        exclude(workoutQuality, session.pending ? "pending" : "unscored");
      } else if (!placedInRange && !inOpen) {
        exclude(workoutQuality, outsideReason);
      } else {
        usedWorkouts.push({ updated_at: updatedAt.get(session.summary.id) ?? "" });
        if (placedInRange) {
          observed.push({
            startMs: session.startMs,
            endMs: session.endMs,
            offset: session.summary.timezone_offset,
          });
        }
      }
    }
    finishQuality(cycleQuality, usedCycles);
    finishQuality(workoutQuality, usedWorkouts);
    return observed;
  };

  if (!cyclesAvailable) {
    accountSources(null, null, "not_analysed");
    return emptyOutput(metric, utcOffset, {
      status: "unavailable",
      notes: withOffsetNote(notes, offsetFallback),
      warnings,
      truncated,
      data_quality: baseQuality(dayPeriod(addDays(today, -seriesDays), today), null),
    });
  }

  if (asOf === null) {
    const placedDays = [...placement.cycleByDay.keys()].sort();
    const firstWorn = placedDays[0] ?? null;
    notes.push(
      firstWorn === null
        ? "No WHOOP cycles were found yet, so there is no load history."
        : `No WHOOP cycle has completed yet (the first cycle is placed on ${firstWorn}); the load series starts once it closes.`
    );
    accountSources(null, null, "outside_window");
    const output = emptyOutput(metric, utcOffset, {
      status: "insufficient_history",
      notes: withOffsetNote(notes, offsetFallback),
      warnings,
      truncated,
      data_quality: baseQuality(dayPeriod(today, today), null),
    });
    output.today_so_far = todaySoFar();
    output.history.first_worn_day = firstWorn;
    output.acute_chronic.available_from_day =
      firstWorn === null ? null : addDays(firstWorn, CHRONIC_WINDOW_DAYS - 1);
    return output;
  }

  // --- Days --------------------------------------------------------------------------

  const seriesStart = addDays(asOf, -(seriesDays - 1));
  const analysedFrom = analysedFromFor(asOf);
  const cyclesCovered = coveredSinceMs(cycles);
  const workoutsCovered = coveredSinceMs(workouts);
  const days = buildTrainingDays({
    firstDay: analysedFrom,
    lastDay: asOf,
    placement,
    sessions,
    cyclesAvailable,
    cyclesCoveredSince: cyclesCovered,
    workoutsAvailable,
    workoutsCoveredSince: workoutsCovered,
    utcOffset,
  });
  const loads = days.map((day) => dayLoad(day, metric));
  const indexOf = (day: string): number => daysBetween(analysedFrom, day);
  const asOfIndex = days.length - 1;

  const firstWornIndex = days.findIndex((day) => day.worn === true);
  const firstWornDay = firstWornIndex === -1 ? null : days[firstWornIndex]!.date;
  const wornDays = days.filter((day) => day.worn === true).length;
  const unknownDays = loads.filter((load) => load === null).length;

  // --- Older history ------------------------------------------------------------------

  const placedBefore = [...placement.cycleByDay.keys()].some((day) => day < analysedFrom);
  let olderHistory: boolean;
  if (placedBefore) olderHistory = true;
  else {
    // A cycle placed before analysedFrom starts more than 12 hours before its
    // local midnight (placement uses the day 12 hours after the start).
    const probe = await probeOlderHistory(
      ctx,
      localMidnightMs(analysedFrom, utcOffset) - OLDER_HISTORY_PROBE_MARGIN_MS,
      options.budget.deadlineMs
    );
    if ("found" in probe) olderHistory = probe.found;
    else {
      olderHistory = firstWornDay === analysedFrom;
      warnings.push(
        `Whether WHOOP history exists before ${analysedFrom} could not be checked (${failureReason(probe.error)}), so the EWMA seed assumes ${olderHistory ? "it does (the first analysed day is worn)" : "it does not"}.`
      );
    }
  }
  const cyclesCoverStart = dayCovered(analysedFrom, cyclesCovered, utcOffset);
  const firstWornIsLowerBound = olderHistory || !cyclesCoverStart;

  // --- Acute and chronic ---------------------------------------------------------------

  const acuteAt = (index: number): ReturnType<typeof rollingMean> =>
    rollingMean(loads, index, ACUTE_WINDOW_DAYS, ACUTE_MIN_KNOWN_DAYS);
  const chronicAt = (index: number): ReturnType<typeof rollingMean> =>
    rollingMean(loads, index, CHRONIC_WINDOW_DAYS, CHRONIC_MIN_KNOWN_DAYS);
  const ratioOf = (acute: number | null, chronic: number | null): number | null =>
    acute !== null && chronic !== null && chronic > 0 ? acute / chronic : null;

  // --- EWMA ---------------------------------------------------------------------------

  const ewmaSeed: EwmaSeed = olderHistory ? "window_mean" : "zero_at_first_worn_day";
  const atl: (number | null)[] = days.map(() => null);
  const ctl: (number | null)[] = days.map(() => null);
  let ewmaStartIndex: number | null = null;
  let unknownCountedAsZero = 0;
  if (olderHistory) {
    ewmaStartIndex = 0;
    const seedLoads = loads
      .slice(0, CHRONIC_WINDOW_DAYS)
      .filter((load): load is number => load !== null);
    const seedMean =
      seedLoads.length > 0
        ? seedLoads.reduce((total, load) => total + load, 0) / seedLoads.length
        : 0;
    const atlSeries = ewmaSeries(loads, ATL_TAU_DAYS, seedMean);
    unknownCountedAsZero = atlSeries.unknown_counted_as_zero;
    atlSeries.values.forEach((value, index) => (atl[index] = value));
    if (seedLoads.length >= CHRONIC_MIN_KNOWN_DAYS) {
      ewmaSeries(loads, CTL_TAU_DAYS, seedMean).values.forEach(
        (value, index) => (ctl[index] = value)
      );
      notes.push(
        `WHOOP history continues before ${analysedFrom}, so ATL and CTL start there from the mean load of its first ${CHRONIC_WINDOW_DAYS} days (${seedLoads.length} known days) instead of 0.`
      );
    } else {
      notes.push(
        `WHOOP history continues before ${analysedFrom}, but only ${seedLoads.length} of its first ${CHRONIC_WINDOW_DAYS} days have a known load (${CHRONIC_MIN_KNOWN_DAYS} needed to seed CTL), so CTL and TSB are null.`
      );
    }
  } else if (firstWornIndex !== -1) {
    ewmaStartIndex = firstWornIndex;
    const slice = loads.slice(firstWornIndex);
    const atlSeries = ewmaSeries(slice, ATL_TAU_DAYS, 0);
    const ctlSeries = ewmaSeries(slice, CTL_TAU_DAYS, 0);
    unknownCountedAsZero = atlSeries.unknown_counted_as_zero;
    slice.forEach((_, offset) => {
      const index = firstWornIndex + offset;
      atl[index] = atlSeries.values[offset]!;
      if (offset >= CTL_WARMUP_DAYS) ctl[index] = ctlSeries.values[offset]!;
    });
  }
  const tsbAt = (index: number): number | null =>
    ctl[index] !== null && atl[index] !== null ? ctl[index]! - atl[index]! : null;
  const warmingUp =
    !olderHistory && firstWornDay !== null && daysBetween(firstWornDay, asOf) < EWMA_WARMUP_DAYS;

  // --- Series ---------------------------------------------------------------------------

  const seriesStartIndex = indexOf(seriesStart);
  const series: TrainingLoadOutput["days"] = [];
  for (let index = seriesStartIndex; index <= asOfIndex; index++) {
    const day = days[index]!;
    const acute = acuteAt(index).mean;
    const chronic = chronicAt(index).mean;
    series.push({
      date: day.date,
      worn: day.worn,
      partial: day.partial,
      in_progress: day.in_progress,
      sessions: day.sessions,
      workout_minutes: round1(day.workout_minutes),
      trimp: round1(day.trimp),
      workout_kj: round1(day.workout_kj),
      day_strain: round1(day.day_strain),
      load: round1(loads[index]!),
      acute_mean: round1(acute),
      chronic_mean: round1(chronic),
      ratio: roundTo(ratioOf(acute, chronic), 2),
      atl: round1(atl[index]!),
      ctl: round1(ctl[index]!),
      tsb: round1(tsbAt(index)),
      flags: [...day.flags],
    });
  }

  const acuteNow = acuteAt(asOfIndex);
  const chronicNow = chronicAt(asOfIndex);
  const ratioNow = ratioOf(acuteNow.mean, chronicNow.mean);
  const availableFrom =
    firstWornDay === null ? null : addDays(firstWornDay, CHRONIC_WINDOW_DAYS - 1);

  // --- Monotony --------------------------------------------------------------------------

  const loadsFor = (first: string): (number | null)[] =>
    Array.from({ length: 7 }, (_, offset) => {
      const index = indexOf(addDays(first, offset));
      return index >= 0 && index <= asOfIndex ? loads[index]! : null;
    });
  const last7Start = addDays(asOf, -6);
  const lastWeekMonday =
    addDays(asOf, 1) === addDays(mondayOf(asOf), 7) ? mondayOf(asOf) : addDays(mondayOf(asOf), -7);

  // --- Weeks -----------------------------------------------------------------------------

  const weeks: TrainingLoadOutput["weeks"] = [];
  for (let monday = mondayOf(seriesStart); monday <= asOf; monday = addDays(monday, 7)) {
    const totals = summarizeWeek(monday, days);
    const previous = summarizeWeek(addDays(monday, -7), days);
    const inProgress = addDays(monday, 6) > asOf;
    const change =
      !inProgress &&
      totals.worn_days !== null &&
      previous.worn_days !== null &&
      totals.worn_days >= WEEK_CHANGE_MIN_WORN_DAYS &&
      previous.worn_days >= WEEK_CHANGE_MIN_WORN_DAYS
        ? percentChange(weekLoad(totals, metric), weekLoad(previous, metric))
        : null;
    weeks.push({
      week_start: monday,
      in_progress: inProgress,
      worn_days: totals.worn_days,
      sessions: totals.sessions,
      active_days: totals.active_days,
      workout_minutes: round1(totals.workout_minutes),
      trimp: round1(totals.trimp),
      workout_kj: round1(totals.workout_kj),
      mean_day_strain: round1(totals.mean_day_strain),
      max_day_strain: round1(totals.max_day_strain),
      completed_cycles: totals.completed_cycles,
      monotony: inProgress ? null : fosterOutput(loadsFor(monday)).monotony,
      change_vs_previous_pct: roundTo(change, 0),
    });
  }

  // --- Load by sport ------------------------------------------------------------------------

  const sportStart = addDays(asOf, -(CHRONIC_WINDOW_DAYS - 1));
  let loadBySport: TrainingLoadOutput["load_by_sport_28d"] = [];
  let sportsCapped = false;
  if (metric === "day_strain") {
    notes.push(
      "load_by_sport_28d is empty for day_strain: day strain belongs to the whole day, not to a sport."
    );
  } else {
    const window = days.slice(indexOf(sportStart));
    if (window.some((day) => !day.workoutsKnown)) {
      notes.push(
        "load_by_sport_28d is empty: workouts of the last 28 days could not be loaded completely."
      );
    } else {
      const bySport = new Map<string, { sessions: number; load: number; without: number }>();
      for (const session of window.flatMap((day) => day.scoredSessions)) {
        const name = session.summary.sport_name;
        const entry = bySport.get(name) ?? { sessions: 0, load: 0, without: 0 };
        entry.sessions += 1;
        if (metric === "trimp") {
          if (session.fullyRecorded) entry.load += session.summary.trimp ?? 0;
          else entry.without += 1;
        } else if (metric === "workout_minutes") entry.load += session.summary.duration_minutes;
        else entry.load += session.summary.kilojoule ?? 0;
        bySport.set(name, entry);
      }
      const total = [...bySport.values()].reduce((sum, entry) => sum + entry.load, 0);
      const all = [...bySport.entries()].sort(
        ([leftName, left], [rightName, right]) =>
          right.load - left.load ||
          right.sessions - left.sessions ||
          (leftName < rightName ? -1 : leftName > rightName ? 1 : 0)
      );
      sportsCapped = all.length > MAX_LOAD_SPORTS;
      const shares =
        total > 0
          ? roundPartsToTotal(
              all.map(([, entry]) => (100 * entry.load) / total),
              0
            )
          : [];
      loadBySport = all.slice(0, MAX_LOAD_SPORTS).map(([sport_name, entry], index) => ({
        sport_name,
        sessions: entry.sessions,
        load: roundTo(entry.load, 1),
        share_pct: total > 0 ? (shares[index] ?? null) : null,
        sessions_without_load: entry.without,
      }));
      const without = all.reduce((sum, [, entry]) => sum + entry.without, 0);
      if (without > 0) {
        notes.push(
          `${plural(without, "session")} in the last 28 days recorded less than 90% heart-rate data and ${without === 1 ? "is" : "are"} left out of load_by_sport_28d.`
        );
      }
    }
  }

  // --- Status and notes ----------------------------------------------------------------------

  const status: TrainingLoadOutput["status"] =
    workoutMetric && !workoutsAvailable
      ? "unavailable"
      : wornDays < MIN_WORN_DAYS_FOR_LOAD || chronicNow.mean === null
        ? "insufficient_history"
        : "available";
  if (status === "insufficient_history") {
    notes.push(
      `Acute:chronic comparisons need ${MIN_WORN_DAYS_FOR_LOAD} worn days and ${CHRONIC_MIN_KNOWN_DAYS} days with a known load in the 28 days ending ${asOf}; there are ${plural(wornDays, "worn day")} since ${analysedFrom} and ${chronicNow.known} known in that window${availableFrom !== null ? ` (first worn day ${firstWornDay}${firstWornIsLowerBound ? " or earlier" : ""}; available from ${availableFrom})` : ""}. Values that exist are still shown.`
    );
  }
  if (!olderHistory) {
    if (firstWornDay === null) {
      notes.push("No worn day in the analysed range, so ATL, CTL and TSB are null.");
    } else if (warmingUp) {
      notes.push(
        `ATL and CTL start at 0 on the first worn day (${firstWornDay}); CTL and TSB stay null for ${CTL_WARMUP_DAYS} days and all EWMA values are warming up until ${addDays(firstWornDay, EWMA_WARMUP_DAYS)}.`
      );
    } else {
      notes.push(`ATL and CTL start at 0 on the first worn day (${firstWornDay}).`);
    }
  }
  if (unknownCountedAsZero > 0) {
    notes.push(
      `${plural(unknownCountedAsZero, "day")} without a known load ${unknownCountedAsZero === 1 ? "counts" : "count"} as 0 in ATL, CTL and TSB (unworn or not loaded); acute and chronic means skip them.`
    );
  }
  if (metric === "day_strain") {
    notes.push(
      "Day strain is non-linear (0-21): equal strain differences are not equal load differences, and Foster monotony assumes a linear load."
    );
  }
  if (metric === "trimp") {
    const strength = sessions.some(
      (session) =>
        session.scored &&
        session.summary.day >= analysedFrom &&
        session.summary.day <= asOf &&
        HR_ZONE_CAVEAT_SPORT.test(session.summary.sport_name)
    );
    notes.push(
      `TRIMP counts heart-rate zone minutes, so it undercounts strength sessions${strength ? " (weightlifting-type sessions are in this range)" : ""}.`
    );
    const lowDays = days
      .slice(seriesStartIndex)
      .filter((day) => day.worn === true && day.lowRecording).length;
    if (lowDays > 0) {
      notes.push(
        `${plural(lowDays, "day")} in the series ${lowDays === 1 ? "has" : "have"} a session with less than 90% recorded heart-rate data, so TRIMP is null there (flag low_recording).`
      );
    }
  }
  const pendingDays = days.slice(seriesStartIndex).filter((day) => day.hasPending).length;
  if (pendingDays > 0) {
    notes.push(
      `${plural(pendingDays, "day")} in the series ${pendingDays === 1 ? "has" : "have"} a workout WHOOP has not scored yet; its workout values are null until it is scored.`
    );
  }
  const fallbackSessions = sessions.filter(
    (session) =>
      session.scored &&
      session.cycleId === null &&
      session.summary.day >= seriesStart &&
      session.summary.day <= asOf
  ).length;
  if (fallbackSessions > 0) {
    warnings.push(
      `${plural(fallbackSessions, "workout")} had no containing WHOOP cycle and ${fallbackSessions === 1 ? "was" : "were"} placed on ${fallbackSessions === 1 ? "its" : "their"} local start day; ${fallbackSessions === 1 ? "it counts" : "they count"} in weekly totals but not in the daily load of an unworn day.`
    );
  }
  if (ratioNow === null && status === "available") {
    notes.push("The acute:chronic ratio is null: the 28-day mean is 0.");
  }
  if (sportsCapped) {
    notes.push(`load_by_sport_28d lists the ${MAX_LOAD_SPORTS} sports with the highest load.`);
  }
  for (const [label, source] of [
    ["Cycle", cycles],
    ["Workout", workouts],
  ] as const) {
    const note = truncationNote(
      label,
      source,
      utcOffset,
      "days before then are unknown (null) and first_worn_day is a lower bound"
    );
    if (note !== null) notes.push(note);
  }

  // --- Data quality ----------------------------------------------------------------------------

  const observed = accountSources(analysedFrom, asOf, "outside_window");

  return {
    status,
    period: {
      start_day: seriesStart,
      end_day: asOf,
      days: seriesDays,
      utc_offset: utcOffset,
    },
    as_of_day: asOf,
    load_metric: metric,
    load_unit: LOAD_UNITS[metric],
    acute_chronic: {
      acute_mean: round1(acuteNow.mean),
      chronic_mean: round1(chronicNow.mean),
      ratio: roundTo(ratioNow, 2),
      acute_known_days: acuteNow.known,
      chronic_known_days: chronicNow.known,
      available_from_day: availableFrom,
      reading: ratioNow === null ? null : acuteChronicReading(ratioNow),
    },
    ewma_seed: ewmaStartIndex === null ? null : ewmaSeed,
    ewma: {
      atl: round1(atl[asOfIndex]!),
      ctl: round1(ctl[asOfIndex]!),
      tsb: round1(tsbAt(asOfIndex)),
      started_on: ewmaStartIndex === null ? null : days[ewmaStartIndex]!.date,
      warming_up: warmingUp,
      unknown_days_counted_as_zero: unknownCountedAsZero,
    },
    monotony: {
      last_7_days: {
        start_day: last7Start,
        end_day: asOf,
        ...fosterOutput(loadsFor(last7Start)),
      },
      last_completed_week:
        indexOf(lastWeekMonday) >= 0
          ? { week_start: lastWeekMonday, ...fosterOutput(loadsFor(lastWeekMonday)) }
          : null,
    },
    weeks,
    load_by_sport_28d: loadBySport,
    today_so_far: todaySoFar(),
    history: {
      analysed_from_day: analysedFrom,
      first_worn_day: firstWornDay,
      first_worn_day_is_lower_bound: firstWornIsLowerBound,
      worn_days: wornDays,
      unknown_days: unknownDays,
    },
    days: series,
    output_capped: sportsCapped,
    truncated,
    notes: withOffsetNote(notes, offsetFallback),
    warnings,
    disclaimer: DISCLAIMER,
    data_quality: baseQuality(dayPeriod(seriesStart, asOf), observedSpan(observed)),
  };
}

// ---------------------------------------------------------------------------
// Tool variant
// ---------------------------------------------------------------------------

export const TRAINING_LOAD_TOOL_NAME = "get_training_load";

/** The standard-mode variant of get_training_load */
export const TRAINING_LOAD_STANDARD: ToolVariant<
  typeof trainingLoadInputSchema,
  typeof trainingLoadOutputSchema
> = {
  title: "Training load",
  description:
    "Daily training load on your local days, ending at the last completed WHOOP day (never today's open cycle, which is shown in today_so_far): acute (7-day) and chronic (28-day) mean load with their ratio, EWMA ATL/CTL/TSB, Foster monotony, local ISO week totals and load by sport over 28 days. load_metric: trimp (default, Edwards TRIMP from WHOOP heart-rate zones), day_strain, workout_minutes or workout_kj. Worn days without workouts count as 0; unworn days are null. Until 28 worn days exist the status is insufficient_history with available_from_day. Descriptive only: no risk zones or advice.",
  inputSchema: trainingLoadInputSchema,
  outputSchema: trainingLoadOutputSchema,
  run: getTrainingLoad,
};
