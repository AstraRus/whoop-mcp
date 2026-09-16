/**
 * Tool: get_weekly_summary
 *
 * Summarizes one Monday-to-Sunday week in the user's local time: recovery,
 * sleep, workouts and daily strain, plus the recovery trend.
 *
 * Each record is counted in exactly one week, by its own local day: cycles by
 * cycleDay(), recoveries through their cycle (cycle_id), sleeps by the local
 * day they end, workouts by the local day they start. The in-progress cycle
 * is left out of strain averages.
 *
 * Sparse data (a new or still-calibrating WHOOP user) is a normal state:
 * values that cannot be computed are null, never 0, with the reason in
 * `notes`. Endpoint calls are serialized to respect rate limits; partial
 * failures return partial results with warnings, and the call throws only if
 * ALL 4 endpoints fail.
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
import {
  asleepHours,
  cycleDay,
  DAY_MS,
  localDay,
  mainSleeps,
  parseRecords,
  sourceQuality,
} from "./analytics-utils.js";
import { resolveUserUtcOffsetInfo, withOffsetNote } from "./collection-utils.js";
import { parseUtcOffset, resolveDateExpression } from "./date-utils.js";
import { mean, linearRegressionXY, trendDirection, MIN_TREND_POINTS } from "./stats-utils.js";
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

interface Week {
  monday: string;
  sunday: string;
  /** Local Monday 00:00 as epoch ms */
  startMs: number;
  /** Following local Monday 00:00 as epoch ms (exclusive) */
  endMs: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_RECORDS_PER_ENDPOINT = 200;
const MAX_PAGES = 10;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

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
function resolveWeek(
  weekStart: string | undefined,
  now: Date,
  offset: string
): Week & { requestedDay: string } {
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
  query: string,
  schema: z.ZodType<T>
): Promise<FetchOutcome<T>> {
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
  now: Date = new Date()
): Promise<WeeklySummary> {
  const { offset, fallback: offsetFallback } = await resolveUserUtcOffsetInfo(client);
  const week = resolveWeek(params.week_start, now, offset);
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

  // Start a day early so records spanning Monday 00:00 (e.g. Sunday-night
  // sleep) are returned; membership is decided per record below.
  const queryStart = new Date(week.startMs - DAY_MS).toISOString();
  const queryEnd = new Date(week.endMs).toISOString();
  const query = buildWeekQuery(queryStart, queryEnd);

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
  const sleeps = recordsOf(sources.sleep);

  // --- Recovery: joined to its cycle; oldest first for the trend ---
  const cyclesById = new Map(cycles.map((cycle) => [cycle.id, cycle]));
  const sleepsById = new Map(sleeps.map((sleep) => [sleep.id, sleep]));
  const weekRecoveries = recordsOf(sources.recovery)
    .filter((record) => record.score_state === "SCORED" && record.score)
    .map((record) => {
      const cycle = cyclesById.get(record.cycle_id);
      const sleep = sleepsById.get(record.sleep_id);
      const placement = cycle
        ? { day: cycleDay(cycle), anchor: Date.parse(cycle.start) }
        : sleep
          ? { day: localDay(sleep.end, sleep.timezone_offset), anchor: Date.parse(sleep.start) }
          : { day: localDay(record.created_at, offset), anchor: Date.parse(record.created_at) };
      return { ...placement, score: record.score! };
    })
    .filter((recovery) => inWeek(recovery.day))
    .sort((left, right) => left.anchor - right.anchor);

  const recoveryScores = weekRecoveries.map((recovery) => recovery.score.recovery_score);
  const calibratingCount = weekRecoveries.filter((r) => r.score.user_calibrating).length;

  let recoveryTrend: TrendDirectionResult | null = null;
  if (recoveryScores.length >= MIN_TREND_POINTS) {
    const firstDay = dayMs(weekRecoveries[0]!.day);
    const xs = weekRecoveries.map((recovery) => (dayMs(recovery.day) - firstDay) / DAY_MS);
    const regression = linearRegressionXY(xs, recoveryScores);
    recoveryTrend = trendDirection(regression.slope, regression.r2);
  }

  const recovery = {
    average_score: averageOrNull(recoveryScores),
    min_score: recoveryScores.length ? Math.min(...recoveryScores) : null,
    max_score: recoveryScores.length ? Math.max(...recoveryScores) : null,
    average_hrv: averageOrNull(weekRecoveries.map((r) => r.score.hrv_rmssd_milli)),
    average_rhr: averageOrNull(weekRecoveries.map((r) => r.score.resting_heart_rate)),
    trend: recoveryTrend,
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

  // --- Sleep: main sleeps only, by the local day they end, hours asleep ---
  const sleepQuality = sourceQuality();
  const nights = mainSleeps(
    sleeps.filter((sleep) => inWeek(localDay(sleep.end, sleep.timezone_offset))),
    // Membership was decided by local day; the period only has to contain every candidate
    {
      start: new Date(Date.parse(queryStart) - DAY_MS).toISOString(),
      end: new Date(Date.parse(queryEnd) + DAY_MS).toISOString(),
    },
    sleepQuality
  );
  const sleep = {
    average_duration_hours: averageOrNull(nights.map(asleepHours)),
    average_performance_pct: averageOrNull(
      finiteNumbers(nights.map((night) => night.score?.sleep_performance_percentage))
    ),
    average_efficiency_pct: averageOrNull(
      finiteNumbers(nights.map((night) => night.score?.sleep_efficiency_percentage))
    ),
  };
  if (sources.sleep.ok && !nights.length) {
    notes.push("No scored main sleep recorded this week.");
  }

  // --- Workouts: by the local day they start ---
  const scoredWorkouts = recordsOf(sources.workout).filter(
    (workout) =>
      workout.score_state === "SCORED" &&
      workout.score &&
      inWeek(localDay(workout.start, workout.timezone_offset))
  );
  const sportBreakdown: Record<string, number> = {};
  let totalStrain = 0;
  let totalCaloriesKj = 0;
  for (const workout of scoredWorkouts) {
    totalStrain += workout.score!.strain;
    totalCaloriesKj += workout.score!.kilojoule;
    sportBreakdown[workout.sport_name] = (sportBreakdown[workout.sport_name] ?? 0) + 1;
  }
  // A worn day always produces a cycle, so a week without any cycle, sleep,
  // recovery or workout record (or one that has not started) was not recorded:
  // its workout totals are unknown, not 0.
  const weekCycles = cycles.filter((cycle) => inWeek(cycleDay(cycle)));
  const weekNotStarted = week.monday > today;
  const noWeekData =
    weekNotStarted ||
    (sources.cycle.ok &&
      weekCycles.length === 0 &&
      weekRecoveries.length === 0 &&
      !sleeps.some((record) => inWeek(localDay(record.end, record.timezone_offset))) &&
      !recordsOf(sources.workout).some((record) =>
        inWeek(localDay(record.start, record.timezone_offset))
      ));
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
      total_strain: totalStrain,
      total_calories_kj: totalCaloriesKj,
      sport_breakdown: sportBreakdown,
    };
  }

  // --- Strain: completed cycles by cycleDay ---
  const strainValues = weekCycles
    .filter((cycle) => cycle.end != null && cycle.score_state === "SCORED" && cycle.score)
    .map((cycle) => cycle.score!.strain);
  const strain = {
    average_daily_strain: averageOrNull(strainValues),
    max_daily_strain: strainValues.length ? Math.max(...strainValues) : null,
  };
  if (weekCycles.some((cycle) => cycle.end == null)) {
    notes.push("Today's strain is still accumulating and is not included.");
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
