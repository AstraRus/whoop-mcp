/**
 * Tool: get_weekly_summary
 *
 * Summarizes one Monday-to-Sunday week in the user's local time: recovery,
 * sleep, workouts and daily strain, plus the recovery trend.
 *
 * Records are placed on local days with the shared day model, as get_calendar
 * shows them: each cycle with its main sleep and recovery on one day
 * (placeDays), and each workout on the day of the cycle containing its start
 * (assignWorkouts), so a workout after midnight that still belongs to
 * Sunday's cycle counts in that week. A workout without a containing cycle
 * falls back to its local start day (noted). Records are fetched over
 * fetchRangeForDays(Monday, Sunday): two days either side of the week. The
 * in-progress cycle and a partial first day of wear are left out of strain
 * averages.
 *
 * Sparse data (a new or still-calibrating WHOOP user) is a normal state:
 * values that cannot be computed are null, never 0, with the reason in
 * `notes`. Endpoint calls are serialized; partial failures return partial
 * results with warnings, and the call throws only if ALL 4 endpoints fail.
 * Averages are rounded at output.
 *
 * In aggregate privacy mode only released weeks (two days after they end) are
 * summarized, from the samples every aggregate tool shares (see get-trend.ts).
 */

import type { z } from "zod";
import type { WhoopClient } from "../api/client.js";
import { WhoopApiError, WhoopAuthError, WhoopNetworkError } from "../api/client.js";
import { fetchAllPages } from "../api/pagination.js";
import {
  ENDPOINT_RECOVERY,
  ENDPOINT_SLEEP,
  ENDPOINT_WORKOUT,
  ENDPOINT_CYCLE,
} from "../api/endpoints.js";
import {
  cycleRecordSchema,
  recoveryRecordSchema,
  sleepRecordSchema,
  workoutRecordSchema,
} from "../api/record-schemas.js";
import type { RecoveryScore } from "../api/types.js";
import {
  asleepHours,
  DAY_MS,
  localDay,
  mostRelevantError,
  parseRecords,
  sourceQuality,
} from "./analytics-utils.js";
import { lastReleasedWeeks, roundStep, type LocalWeek } from "./aggregate-window.js";
import { resolveUserUtcOffsetInfo, withOffsetNote } from "./collection-utils.js";
import { parseUtcOffset, resolveDateExpression } from "./date-utils.js";
import { assignWorkouts, fetchRangeForDays, isOpenCycle, placeDays } from "./day-model.js";
import {
  AGGREGATE_METRIC_STEP,
  aggregateMetric,
  isPartialDay,
  loadAggregateData,
  withheldWeekNotes,
  weekDays,
  type AggregateMetricResult,
  type AnalyticsToolOptions,
} from "./get-trend.js";
import {
  mean,
  linearRegressionXY,
  trendDirection,
  MIN_TREND_POINTS,
  roundTo,
} from "./stats-utils.js";
import type { TrendDirectionResult } from "./stats-utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Input parameters for get_weekly_summary */
export interface WeeklySummaryParams {
  /** Any day in the week (date, date-time or expression). Defaults to the current week. */
  week_start?: string;
}

/** Output shape for get_weekly_summary */
export interface WeeklySummary {
  /** Local Monday 00:00, written with the user's UTC offset */
  week_start: string;
  /** Local Sunday 23:59:59.999, written with the user's UTC offset */
  week_end: string;
  recovery: {
    average_score: number | null;
    min_score: number | null;
    max_score: number | null;
    average_hrv: number | null;
    average_rhr: number | null;
    trend: TrendDirectionResult | null;
  };
  sleep: {
    /** Hours asleep (light + slow-wave + REM) per main sleep; time in bed is not counted */
    average_duration_hours: number | null;
    average_performance_pct: number | null;
    average_efficiency_pct: number | null;
  };
  workouts: {
    count: number | null;
    /** Sum of per-workout strain (not comparable to day strain) */
    total_strain: number | null;
    total_calories_kj: number | null;
    sport_breakdown: Record<string, number>;
  };
  strain: {
    average_daily_strain: number | null;
    max_daily_strain: number | null;
  };
  sample_sizes: {
    recovery_days: number;
    sleep_nights: number;
    completed_cycles: number;
  };
  calibrating: boolean;
  truncated: boolean;
  notes: string[];
  warnings?: string[];
}

type FetchOutcome<T> =
  | { ok: true; records: T[]; truncated: boolean; invalid: number }
  | { ok: false; error: unknown };

interface Week extends LocalWeek {
  /** The local day week_start named (today without week_start) */
  requestedDay: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_RECORDS_PER_ENDPOINT = 200;
const MAX_PAGES = 10;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Note for a week that is not released yet in aggregate privacy mode */
export const WEEK_NOT_RELEASED_NOTE =
  "This week is released two days after it completes (Wednesday, local time).";

// ---------------------------------------------------------------------------
// Local-day helpers
// ---------------------------------------------------------------------------

function dayMs(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

function addDays(day: string, count: number): string {
  return new Date(dayMs(day) + count * DAY_MS).toISOString().slice(0, 10);
}

function weekdayName(day: string): string {
  return WEEKDAYS[new Date(dayMs(day)).getUTCDay()]!;
}

/** Monday of the ISO week containing a calendar day */
function mondayOf(day: string): string {
  const weekday = new Date(dayMs(day)).getUTCDay();
  return addDays(day, weekday === 0 ? -6 : 1 - weekday);
}

/** ISO 8601 timestamp written in the user's offset, so its date part is the local date */
function formatLocal(ms: number, offset: string): string {
  const wallClock = new Date(ms + parseUtcOffset(offset) * 60_000).toISOString().slice(0, 23);
  return `${wallClock}${offset === "Z" ? "Z" : offset}`;
}

/** A date-time written as midnight in its own zone (or without a zone), e.g. 2026-09-14T00:00:00Z */
const WRITTEN_MIDNIGHT_REGEX =
  /^(\d{4}-\d{2}-\d{2})T00:00(?::00(?:\.0{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?$/;

/**
 * The local day week_start names. A date-time written as midnight names the
 * date as written: "2026-09-14T00:00:00Z" is Monday 14 September in every
 * timezone, although at a negative offset that instant is still Sunday
 * evening locally. This agrees with snapping the bound to its nearest local
 * midnight (D11) wherever the written zone is within 12 hours of the user's.
 * Any other date-time names the local day it falls on, so a noon or evening
 * timestamp never moves to the next week. Date-only and relative values
 * already sit on a local midnight.
 */
function requestedLocalDay(weekStart: string, now: Date, offset: string): string {
  // Resolve first: it rejects invalid calendar dates such as 2026-02-30T00:00:00Z
  const resolved = resolveDateExpression(weekStart, now, offset);
  const midnight = weekStart.trim().match(WRITTEN_MIDNIGHT_REGEX);
  return midnight ? midnight[1]! : localDay(resolved.start, offset);
}

/**
 * Resolve week_start to the local Monday-to-Sunday week containing it.
 * Without week_start, the week containing today.
 */
function resolveWeek(weekStart: string | undefined, now: Date, offset: string): Week {
  const requestedDay =
    weekStart === undefined
      ? localDay(now.toISOString(), offset)
      : requestedLocalDay(weekStart, now, offset);
  const monday = mondayOf(requestedDay);
  const offsetMs = parseUtcOffset(offset) * 60_000;
  return {
    requestedDay,
    monday,
    sunday: addDays(monday, 6),
    startMs: dayMs(monday) - offsetMs,
    endMs: dayMs(addDays(monday, 7)) - offsetMs,
  };
}

/** Build a query string with start/end params and limit=25 */
function buildWeekQuery(start: string, end: string): string {
  const params = new URLSearchParams();
  params.set("start", start);
  params.set("end", end);
  params.set("limit", "25");
  return `?${params.toString()}`;
}

/** Fetch and validate an endpoint, capturing any failure instead of throwing */
async function safeFetch<T>(
  client: WhoopClient,
  endpoint: string,
  query: string | null,
  schema: z.ZodType<T>
): Promise<FetchOutcome<T>> {
  if (query === null) return { ok: true, records: [], truncated: false, invalid: 0 };
  try {
    const result = await fetchAllPages<unknown>(client, `${endpoint}${query}`, {
      maxRecords: MAX_RECORDS_PER_ENDPOINT,
      maxPages: MAX_PAGES,
      interPageDelayMs: 0, // Delay handled by serialization
    });
    const quality = sourceQuality(result.records.length, result.truncated);
    const records = parseRecords(result.records, schema, quality);
    return {
      ok: true,
      records,
      truncated: result.truncated,
      invalid: quality.exclusions.invalid ?? 0,
    };
  } catch (error: unknown) {
    return { ok: false, error };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function isWhoopError(error: unknown): boolean {
  return (
    error instanceof WhoopApiError ||
    error instanceof WhoopAuthError ||
    error instanceof WhoopNetworkError
  );
}

function recordsOf<T>(outcome: FetchOutcome<T>): T[] {
  return outcome.ok ? outcome.records : [];
}

function averageOrNull(values: number[]): number | null {
  return values.length ? mean(values) : null;
}

function finiteNumbers(values: (number | null | undefined)[]): number[] {
  return values.filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value)
  );
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** Recovery trend from day-ordered scores (at least MIN_TREND_POINTS) */
function recoveryTrendOf(points: { day: string; score: number }[]): TrendDirectionResult | null {
  if (points.length < MIN_TREND_POINTS) return null;
  const firstDay = dayMs(points[0]!.day);
  const xs = points.map((point) => (dayMs(point.day) - firstDay) / DAY_MS);
  const regression = linearRegressionXY(
    xs,
    points.map((point) => point.score)
  );
  return trendDirection(regression.slope, regression.r2);
}

/** 'N workouts had no containing WHOOP cycle and were placed on their local start day.' */
export function fallbackWorkoutsNote(count: number): string {
  return count === 1
    ? "1 workout had no containing WHOOP cycle and was placed on its local start day."
    : `${count} workouts had no containing WHOOP cycle and were placed on their local start day.`;
}

/** Round a value at output; null stays null */
function rounded(value: number | null, digits: number): number | null {
  return value === null ? null : roundTo(value, digits);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Get a summarized health report for the local Monday-to-Sunday week that
 * contains `week_start` (default: the current week).
 *
 * Returns partial results with warnings if 1-3 endpoints fail. If ALL 4 fail,
 * rethrows the first WHOOP API/auth/network error (or a plain Error).
 */
export async function getWeeklySummary(
  client: WhoopClient,
  params: WeeklySummaryParams,
  now: Date = new Date(),
  options: AnalyticsToolOptions = {}
): Promise<WeeklySummary> {
  const { offset, fallback: offsetFallback } = await resolveUserUtcOffsetInfo(client);
  const week = resolveWeek(params.week_start, now, offset);
  if (options.privacyMode === "aggregate") {
    return aggregateWeeklySummary(client, params, week, now, offset, offsetFallback);
  }
  const weekDaysList = weekDays([week.monday]);
  const inWeek = (day: string): boolean => day >= week.monday && day <= week.sunday;
  const notes: string[] = [];

  if (params.week_start !== undefined && week.requestedDay !== week.monday) {
    notes.push(
      `${week.requestedDay} is a ${weekdayName(week.requestedDay)}; summarizing the week from Monday ${week.monday} to Sunday ${week.sunday}.`
    );
  }
  const today = localDay(now.toISOString(), offset);
  if (inWeek(today)) {
    notes.push(`This week is still in progress (data through ${today}).`);
  } else if (week.monday > today) {
    notes.push("This week has not started yet.");
  }

  // Two days either side of the week: the cycle and sleep that begin the
  // evening before Monday, and after-midnight workouts that still belong to
  // Sunday's cycle. Membership is decided per placed day below.
  const range = fetchRangeForDays(week.monday, week.sunday, offset, now.getTime());
  const query =
    range.endMs > range.startMs
      ? buildWeekQuery(new Date(range.startMs).toISOString(), new Date(range.endMs).toISOString())
      : null;

  // Serialize endpoint calls (not parallel) to respect rate limits
  const sources = {
    recovery: await safeFetch(client, ENDPOINT_RECOVERY, query, recoveryRecordSchema),
    sleep: await safeFetch(client, ENDPOINT_SLEEP, query, sleepRecordSchema),
    workout: await safeFetch(client, ENDPOINT_WORKOUT, query, workoutRecordSchema),
    cycle: await safeFetch(client, ENDPOINT_CYCLE, query, cycleRecordSchema),
  };

  const warnings: string[] = [];
  const failures: unknown[] = [];
  let truncated = false;
  for (const [name, outcome] of Object.entries(sources)) {
    if (!outcome.ok) {
      warnings.push(`${name}: ${errorMessage(outcome.error)}`);
      failures.push(outcome.error);
      notes.push(`${name[0]!.toUpperCase()}${name.slice(1)} data could not be loaded from WHOOP.`);
      continue;
    }
    if (outcome.truncated) {
      truncated = true;
      notes.push(
        `WHOOP returned more ${name} records than could be fetched; some records of the week may be missing.`
      );
    }
    if (outcome.invalid) {
      notes.push(
        `${outcome.invalid} ${name} record(s) did not match the expected WHOOP format and were skipped.`
      );
    }
  }

  if (failures.length === 4) {
    const typed = failures.find(isWhoopError);
    if (typed) throw typed;
    throw new Error(`All endpoints failed: ${warnings.join("; ")}`);
  }

  const cycles = recordsOf(sources.cycle);
  const placement = placeDays({
    cycles,
    sleeps: recordsOf(sources.sleep),
    recoveries: recordsOf(sources.recovery),
    sleepsAvailable: sources.sleep.ok,
    today,
    utcOffset: offset,
  });

  // --- Recovery: the recovery placed on each day of the week ---
  const weekRecoveries: { day: string; score: RecoveryScore }[] = [];
  for (const day of weekDaysList) {
    const recovery = placement.byDay.get(day)?.recovery;
    if (recovery?.score_state === "SCORED" && recovery.score)
      weekRecoveries.push({ day, score: recovery.score });
  }
  const recoveryScores = weekRecoveries.map((recovery) => recovery.score.recovery_score);
  const calibratingCount = weekRecoveries.filter((r) => r.score.user_calibrating).length;

  const recovery = {
    average_score: rounded(averageOrNull(recoveryScores), 1),
    min_score: recoveryScores.length ? roundTo(Math.min(...recoveryScores), 1) : null,
    max_score: recoveryScores.length ? roundTo(Math.max(...recoveryScores), 1) : null,
    average_hrv: rounded(averageOrNull(weekRecoveries.map((r) => r.score.hrv_rmssd_milli)), 1),
    average_rhr: rounded(averageOrNull(weekRecoveries.map((r) => r.score.resting_heart_rate)), 1),
    trend: recoveryTrendOf(
      weekRecoveries.map((entry) => ({ day: entry.day, score: entry.score.recovery_score }))
    ),
  };

  if (sources.recovery.ok) {
    if (!recoveryScores.length) {
      notes.push("No scored recovery recorded this week.");
    } else if (recoveryScores.length < MIN_TREND_POINTS) {
      notes.push(
        `Not enough data yet for a recovery trend: ${recoveryScores.length} scored recovery day(s) this week; a trend needs at least ${MIN_TREND_POINTS}.`
      );
    }
  }
  if (calibratingCount) {
    notes.push(
      `WHOOP is still calibrating (${calibratingCount} of ${recoveryScores.length} scored recovery day(s) flagged); recovery, HRV and resting heart rate may shift.`
    );
  }

  // --- Sleep: the main sleep placed on each day, hours asleep ---
  const nights = weekDaysList.flatMap((day) => {
    const sleep = placement.byDay.get(day)?.sleep;
    return sleep &&
      !sleep.nap &&
      Date.parse(sleep.end) > Date.parse(sleep.start) &&
      sleep.score_state === "SCORED" &&
      sleep.score
      ? [sleep]
      : [];
  });
  const sleep = {
    average_duration_hours: rounded(averageOrNull(nights.map(asleepHours)), 2),
    average_performance_pct: rounded(
      averageOrNull(
        finiteNumbers(nights.map((night) => night.score?.sleep_performance_percentage))
      ),
      1
    ),
    average_efficiency_pct: rounded(
      averageOrNull(finiteNumbers(nights.map((night) => night.score?.sleep_efficiency_percentage))),
      1
    ),
  };
  if (sources.sleep.ok && !nights.length) {
    notes.push("No scored main sleep recorded this week.");
  }

  // --- Workouts: on the day of the cycle containing their start ---
  const workoutRecords = recordsOf(sources.workout);
  const workoutPlacement = assignWorkouts(workoutRecords, placement, cycles);
  const weekWorkouts = workoutRecords.filter((workout) => {
    const placed = workoutPlacement.get(workout.id);
    return placed !== undefined && inWeek(placed.day);
  });
  const scoredWorkouts = weekWorkouts.filter(
    (workout) => workout.score_state === "SCORED" && workout.score
  );
  const sportBreakdown: Record<string, number> = {};
  let totalStrain = 0;
  let totalCaloriesKj = 0;
  for (const workout of scoredWorkouts) {
    totalStrain += workout.score!.strain;
    totalCaloriesKj += workout.score!.kilojoule;
    sportBreakdown[workout.sport_name] = (sportBreakdown[workout.sport_name] ?? 0) + 1;
  }
  const fallbackWorkouts = weekWorkouts.filter(
    (workout) => workoutPlacement.get(workout.id)?.fallback === true
  ).length;
  // A worn day always produces a cycle, so a week without any placed cycle,
  // sleep, recovery or workout (or one that has not started) was not recorded:
  // its workout totals are unknown, not 0.
  const weekNotStarted = week.monday > today;
  const noWeekData =
    weekNotStarted ||
    (sources.cycle.ok &&
      weekDaysList.every((day) => !placement.byDay.has(day)) &&
      weekWorkouts.length === 0);
  const unknownWorkouts = {
    count: null,
    total_strain: null,
    total_calories_kj: null,
    sport_breakdown: {},
  };
  let workouts: WeeklySummary["workouts"];
  if (!sources.workout.ok) {
    workouts = unknownWorkouts;
  } else if (noWeekData) {
    workouts = unknownWorkouts;
    if (!weekNotStarted) {
      notes.push(
        "No WHOOP data was recorded this week, so workout count, strain and calories are unknown (null), not 0."
      );
    }
  } else {
    workouts = {
      count: scoredWorkouts.length,
      total_strain: roundTo(totalStrain, 2),
      total_calories_kj: roundTo(totalCaloriesKj, 0),
      sport_breakdown: sportBreakdown,
    };
    if (fallbackWorkouts) notes.push(fallbackWorkoutsNote(fallbackWorkouts));
    const unscored = weekWorkouts.length - scoredWorkouts.length;
    if (unscored)
      notes.push(
        `${plural(unscored, "workout")} without a WHOOP score ${unscored === 1 ? "is" : "are"} not counted.`
      );
  }

  // --- Strain: the completed cycle placed on each day ---
  const strainValues: number[] = [];
  let inProgress = false;
  let partialDays = 0;
  for (const day of weekDaysList) {
    const cycle = placement.cycleByDay.get(day);
    if (!cycle) continue;
    if (isOpenCycle(cycle)) inProgress = true;
    else if (isPartialDay(placement, day, cycle)) partialDays += 1;
    else if (cycle.score_state === "SCORED" && cycle.score) strainValues.push(cycle.score.strain);
  }
  const strain = {
    average_daily_strain: rounded(averageOrNull(strainValues), 2),
    max_daily_strain: strainValues.length ? roundTo(Math.max(...strainValues), 2) : null,
  };
  if (inProgress) {
    notes.push("Today's strain is still accumulating and is not included.");
  }
  if (partialDays) {
    notes.push(
      `${partialDays === 1 ? "1 day" : `${partialDays} days`} WHOOP covered only in part (the strap was put on that day) ${partialDays === 1 ? "is" : "are"} not included in daily strain.`
    );
  }
  if (sources.cycle.ok && !strainValues.length) {
    notes.push("No completed, scored cycle this week, so daily strain is null.");
  }

  const result: WeeklySummary = {
    week_start: formatLocal(week.startMs, offset),
    week_end: formatLocal(week.endMs - 1, offset),
    recovery,
    sleep,
    workouts,
    strain,
    sample_sizes: {
      recovery_days: recoveryScores.length,
      sleep_nights: nights.length,
      completed_cycles: strainValues.length,
    },
    calibrating: calibratingCount > 0,
    truncated,
    notes: withOffsetNote(notes, offsetFallback),
  };

  if (warnings.length > 0) {
    result.warnings = warnings;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Aggregate privacy mode
// ---------------------------------------------------------------------------

/**
 * A released week summarized from the samples every aggregate tool shares:
 * whole weeks only, each metric withheld below AGGREGATE_WEEK_MIN_SAMPLES
 * samples, calibrating recoveries not used, values rounded. A week after the
 * latest released week (the current week, last week before Wednesday, or a
 * future week) returns only nulls and WEEK_NOT_RELEASED_NOTE, without reading
 * WHOOP data.
 */
async function aggregateWeeklySummary(
  client: WhoopClient,
  params: WeeklySummaryParams,
  week: Week,
  now: Date,
  offset: string,
  offsetFallback: boolean
): Promise<WeeklySummary> {
  const notes: string[] = [];
  if (params.week_start !== undefined && week.requestedDay !== week.monday)
    notes.push("week_start was moved to the Monday of its local week.");
  const nullSummary = (): WeeklySummary => ({
    week_start: formatLocal(week.startMs, offset),
    week_end: formatLocal(week.endMs - 1, offset),
    recovery: {
      average_score: null,
      min_score: null,
      max_score: null,
      average_hrv: null,
      average_rhr: null,
      trend: null,
    },
    sleep: {
      average_duration_hours: null,
      average_performance_pct: null,
      average_efficiency_pct: null,
    },
    workouts: { count: null, total_strain: null, total_calories_kj: null, sport_breakdown: {} },
    strain: { average_daily_strain: null, max_daily_strain: null },
    sample_sizes: { recovery_days: 0, sleep_nights: 0, completed_cycles: 0 },
    calibrating: false,
    truncated: false,
    notes: [],
  });

  const latestReleased = lastReleasedWeeks(now, offset, 1)[0]!;
  if (week.monday > latestReleased.monday) {
    notes.push(WEEK_NOT_RELEASED_NOTE);
    return { ...nullSummary(), notes: withOffsetNote(notes, offsetFallback) };
  }

  const data = await loadAggregateData(client, [week], offset, now, { workouts: true });
  const sources = [data.recovery, data.sleep, data.workout!, data.cycle];
  if (sources.every((source) => source.quality.status === "fetch_failed"))
    throw mostRelevantError(sources.map((source) => source.error));
  notes.push(...withheldWeekNotes(data));

  const metric = (
    name: Parameters<typeof aggregateMetric>[1],
    subject: string,
    unitPlural: string,
    exclusionNotes = true
  ): AggregateMetricResult => aggregateMetric(data, name, { subject, unitPlural, exclusionNotes });
  const recoveryResult = metric("recovery", "Recovery", "scored recoveries");
  const hrvResult = metric("hrv", "HRV", "scored recoveries", false);
  const rhrResult = metric("rhr", "Resting heart rate", "scored recoveries", false);
  const durationResult = metric("sleep_duration", "Sleep", "scored nights");
  const performanceResult = metric(
    "sleep_performance",
    "Sleep performance",
    "nights with a sleep performance score"
  );
  const efficiencyResult = metric(
    "sleep_efficiency",
    "Sleep efficiency",
    "nights with a sleep efficiency"
  );
  const strainResult = metric("strain", "Daily strain", "completed cycles");
  for (const result of [
    recoveryResult,
    durationResult,
    performanceResult,
    efficiencyResult,
    strainResult,
  ])
    for (const note of result.notes) if (!notes.includes(note)) notes.push(note);

  const average = (result: AggregateMetricResult): number | null => {
    const values = result.released.map((sample) => sample.value);
    if (!values.length || result.metric === "sleep_deficit") return null;
    return roundStep(mean(values), AGGREGATE_METRIC_STEP[result.metric]);
  };

  const summary = nullSummary();
  summary.recovery = {
    average_score: average(recoveryResult),
    min_score: null,
    max_score: null,
    average_hrv: average(hrvResult),
    average_rhr: average(rhrResult),
    trend: recoveryTrendOf(
      recoveryResult.released.map((sample) => ({ day: sample.day, score: sample.value }))
    ),
  };
  summary.sleep = {
    average_duration_hours: average(durationResult),
    average_performance_pct: average(performanceResult),
    average_efficiency_pct: average(efficiencyResult),
  };
  summary.strain = { average_daily_strain: average(strainResult), max_daily_strain: null };
  summary.sample_sizes = {
    recovery_days: recoveryResult.released.length,
    sleep_nights: durationResult.released.length,
    completed_cycles: strainResult.released.length,
  };
  summary.calibrating = (recoveryResult.exclusions.calibrating ?? 0) > 0;
  summary.truncated = sources.some((source) => source.quality.truncated);

  const final = data.finalMondays.includes(week.monday);
  const placedInWeek = weekDays([week.monday]).some((day) => data.placement.byDay.has(day));
  const weekWorkouts = data.workout!.records.filter((workout) => {
    const placed = data.workoutPlacement.get(workout.id);
    return placed !== undefined && placed.day >= week.monday && placed.day <= week.sunday;
  });
  if (!data.workoutsComplete) {
    notes.push(
      "Workout data for this week could not be read completely from WHOOP, so workout values are unknown (null)."
    );
  } else if (final && data.placementComplete) {
    if (!placedInWeek && weekWorkouts.length === 0) {
      notes.push(
        "No WHOOP data was recorded this week, so workout count, strain and calories are unknown (null), not 0."
      );
    } else {
      const scored = weekWorkouts.filter(
        (workout) => workout.score_state === "SCORED" && workout.score
      );
      summary.workouts = {
        count: scored.length,
        total_strain: roundStep(
          scored.reduce((sum, workout) => sum + workout.score!.strain, 0),
          0.1
        ),
        total_calories_kj: roundStep(
          scored.reduce((sum, workout) => sum + workout.score!.kilojoule, 0),
          1
        ),
        sport_breakdown: {},
      };
      const fallback = weekWorkouts.filter(
        (workout) => data.workoutPlacement.get(workout.id)?.fallback === true
      ).length;
      if (fallback) notes.push(fallbackWorkoutsNote(fallback));
    }
  }
  if (summary.truncated)
    notes.push(
      "WHOOP returned more records than could be fetched for this week, so it is withheld."
    );
  return { ...summary, notes: withOffsetNote(notes, offsetFallback) };
}
