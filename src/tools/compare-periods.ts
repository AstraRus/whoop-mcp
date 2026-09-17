/**
 * Tool: compare_periods
 *
 * Compares average recovery, sleep and strain between two non-overlapping
 * periods of the user's local days.
 *
 * - Inputs are resolved with resolveDateExpression in the user's UTC offset:
 *   a date-only start begins at local midnight and a date-only end includes
 *   that whole local day. WHOOP only accepts full timestamps.
 * - WHOOP's start/end filters return every record that overlaps the window,
 *   so records are fetched with a one-day margin and attributed locally to
 *   exactly one period by the local day they belong to: cycles by cycleDay(),
 *   sleeps by the local day they end, recoveries through their cycle. Records
 *   keep their own local day across DST and travel.
 * - A local day (in the user's current offset) belongs to a period when most
 *   of it lies inside the period: each bound is snapped to the nearest local
 *   midnight, except that a bound later today (at or after now) rounds up so
 *   today stays included. Date-only bounds already sit on local midnights.
 *   Snapping is monotone, so two non-overlapping periods never share a day.
 *   Each period reports the first and last local day it counted; a period
 *   that covers most of no local day gets an explicit note.
 * - Sleep hours are time asleep (light + slow-wave + REM) on main sleeps.
 * - Strain uses completed cycles; the cycle still in progress is left out.
 * - A metric with fewer than MIN_SAMPLES_PER_PERIOD samples in either period
 *   keeps the averages that exist but gets change_pct null and direction
 *   "insufficient_data", with a note that says why.
 * - A ±5% change counts as "unchanged".
 * - training compares workout load per worn local day (a day with a WHOOP
 *   cycle placed on it): workouts are placed with assignWorkouts on the day of
 *   the cycle containing their start. Records are fetched over the period's
 *   days plus fetchRangeForDays' two days either side, so after-midnight
 *   workouts of the last day are included. A workout or cycle load failure
 *   nulls only the training block, with a warning.
 * - In aggregate privacy mode each period is snapped inward to whole released
 *   local weeks and uses the samples every aggregate tool shares (see
 *   get-trend.ts); training is not reported.
 */

import type { z } from "zod";
import type { WhoopClient } from "../api/client.js";
import { WhoopApiError, WhoopAuthError, WhoopNetworkError } from "../api/client.js";
import { ABSOLUTE_MAX_RECORDS, fetchAllPages } from "../api/pagination.js";
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
import type { Cycle, Recovery, Sleep, Workout } from "../api/types.js";
import { InvalidDateExpression, parseUtcOffset, resolveDateExpression } from "./date-utils.js";
import { resolveUserUtcOffsetInfo, withOffsetNote } from "./collection-utils.js";
import {
  asleepHours,
  cycleDay,
  DAY_MS,
  localDay,
  localMidnightMs,
  mainSleeps,
  mostRelevantError,
  sourceQuality,
} from "./analytics-utils.js";
import { lastReleasedWeeks, roundStep, type LocalWeek } from "./aggregate-window.js";
import {
  addDays,
  assignWorkouts,
  fetchRangeForDays,
  isOpenCycle,
  mondayOf,
  placeDays,
  type DayPlacement,
} from "./day-model.js";
import {
  AGGREGATE_METRIC_STEP,
  aggregateMetric,
  loadAggregateData,
  releasedWeeksNote,
  withheldWeekNotes,
  type AggregateData,
  type AggregateMetricResult,
  type AnalyticsToolOptions,
  isPartialDay,
} from "./get-trend.js";
import { mean, roundTo } from "./stats-utils.js";
import {
  edwardsTrimp,
  MIN_RECORDED_FRACTION,
  recordedFraction,
  zoneMinutes,
} from "./workout-utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Input parameters for compare_periods */
export interface ComparePeriodsParams {
  period_a_start: string;
  period_a_end: string;
  period_b_start: string;
  period_b_end: string;
}

/** Direction for recovery and sleep (higher = better) */
export type HealthDirection = "improved" | "declined" | "unchanged" | "insufficient_data";

/** Direction for strain (neutral — just tracks change) */
export type StrainDirection = "increased" | "decreased" | "unchanged" | "insufficient_data";

/** A resolved period as reported back to the caller */
export interface PeriodSummary {
  /** Start instant, in the user's UTC offset */
  start: string;
  /**
   * End as resolved, in the user's UTC offset: 23:59:59.999 local for a
   * whole-day end, otherwise the (exclusive) date-time given
   */
  end: string;
  /** Length in days */
  days: number;
  /** First local day (YYYY-MM-DD, user's offset) counted in the period; null when it covers none */
  first_day: string | null;
  /** Last local day (YYYY-MM-DD, user's offset) counted in the period; null when it covers none */
  last_day: string | null;
}

/** Training load of one period */
export interface TrainingPeriodSummary {
  /** Scored workouts placed on worn local days of the period */
  sessions: number;
  /** Counted local days with a WHOOP cycle placed on them */
  worn_days: number;
  /** Sessions per 7 worn days; null unless both periods have MIN_TRAINING_WORN_DAYS worn days */
  sessions_per_week: number | null;
  /** Workout minutes (start to end) per worn day, 0 on a worn day without workouts */
  workout_minutes_per_worn_day: number | null;
  /** Edwards TRIMP per worn day, leaving out days with a low-recorded or unscored workout */
  trimp_per_worn_day: number | null;
}

/** Training load compared between the periods */
export interface TrainingComparison {
  period_a: TrainingPeriodSummary;
  period_b: TrainingPeriodSummary;
  change_pct: {
    sessions_per_week: number | null;
    workout_minutes_per_worn_day: number | null;
    trimp_per_worn_day: number | null;
  };
  /** From trimp_per_worn_day, ±5% counting as unchanged */
  direction: StrainDirection;
}

/** Output shape for compare_periods */
export interface PeriodComparison {
  period_a: PeriodSummary;
  period_b: PeriodSummary;
  recovery: {
    period_a_avg: number | null;
    period_b_avg: number | null;
    period_a_n: number;
    period_b_n: number;
    change_pct: number | null;
    direction: HealthDirection;
    period_a_calibrating_n: number;
    period_b_calibrating_n: number;
  };
  sleep: {
    /** Average time asleep (light + slow-wave + REM) per main sleep, naps excluded */
    period_a_avg_hours: number | null;
    period_b_avg_hours: number | null;
    period_a_n: number;
    period_b_n: number;
    change_pct: number | null;
    direction: HealthDirection;
  };
  strain: {
    period_a_avg: number | null;
    period_b_avg: number | null;
    period_a_n: number;
    period_b_n: number;
    change_pct: number | null;
    direction: StrainDirection;
  };
  /** Null when workouts or cycles could not be loaded (see warnings); omitted in aggregate mode */
  training: TrainingComparison | null;
  /** True when a source hit the record cap, so the oldest records of a period are missing */
  truncated: boolean;
  /** Plain-language explanations for nulls: sparse data, calibration, cycles in progress */
  notes: string[];
  /** Data problems: sources that failed to load, skipped records, truncation */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum allowed period length in days */
const MAX_PERIOD_DAYS = 90;

/** Threshold for "unchanged" determination (±5%) */
const UNCHANGED_THRESHOLD = 5;

/** Minimum samples per period before a change and direction are reported */
export const MIN_SAMPLES_PER_PERIOD = 3;

/** Worn days each period needs before training means are reported */
export const MIN_TRAINING_WORN_DAYS = 7;

/** Extra time fetched on both sides of a period so edge records can be attributed */
const FETCH_MARGIN_MS = DAY_MS;

/** WHOOP page size */
const PAGE_SIZE = 25;

// ---------------------------------------------------------------------------
// Period resolution
// ---------------------------------------------------------------------------

type PeriodKey = "a" | "b";

interface ResolvedPeriod {
  key: PeriodKey;
  label: string;
  startMs: number;
  /** Exclusive end */
  endMs: number;
  /** Local midnight (user's offset) starting the first counted day */
  dayStartMs: number;
  /** Local midnight (user's offset) after the last counted day; equals dayStartMs when none */
  dayEndMs: number;
  /** True when a past bound was moved to a local midnight (not just today's round-up) */
  snapped: boolean;
  /** fetchRangeForDays over the counted days; null when the period counts no day */
  dayRange: { startMs: number; endMs: number } | null;
  summary: PeriodSummary;
}

/** Round to `digits` decimals, normalizing -0 to 0 */
function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  const rounded = Math.round(value * factor) / factor;
  return rounded === 0 ? 0 : rounded;
}

/** Format an instant as ISO 8601 in the given UTC offset ("Z" keeps UTC) */
function formatInstant(ms: number, utcOffset: string): string {
  const wallClock = new Date(ms + parseUtcOffset(utcOffset) * 60_000).toISOString();
  return utcOffset === "Z" ? wallClock : `${wallClock.slice(0, -1)}${utcOffset}`;
}

/**
 * Snap an instant to a local midnight in the user's offset so a period counts
 * the local days most of which it covers. A bound later today (at or after
 * `nowMs`, before the next local midnight) rounds up so today stays included;
 * any other bound goes to the nearest local midnight (exact noon rounds up).
 * The mapping is monotone, so non-overlapping periods never share a day.
 */
function snapToLocalMidnight(ms: number, nowMs: number, utcOffset: string): number {
  const offsetMs = parseUtcOffset(utcOffset) * 60_000;
  const local = ms + offsetMs;
  const floor = Math.floor(local / DAY_MS) * DAY_MS;
  if (local === floor) return ms;
  const nextLocalMidnight = Math.floor((nowMs + offsetMs) / DAY_MS) * DAY_MS + DAY_MS;
  const laterToday = ms >= nowMs && local < nextLocalMidnight;
  const snapped = laterToday || local - floor >= DAY_MS / 2 ? floor + DAY_MS : floor;
  return snapped - offsetMs;
}

/** The local calendar day (YYYY-MM-DD) that starts at a local midnight in the user's offset */
function dayAt(midnightMs: number, utcOffset: string): string {
  return new Date(midnightMs + parseUtcOffset(utcOffset) * 60_000).toISOString().slice(0, 10);
}

/**
 * Resolve one period. A whole-day end (date-only or relative expression)
 * resolves to 23:59:59.999 local, so its exclusive end is the next local
 * midnight; a date-time end is used as the exclusive end directly.
 *
 * @throws InvalidDateExpression for unparseable dates, reversed or oversized periods
 */
function resolvePeriod(
  key: PeriodKey,
  startInput: string,
  endInput: string,
  now: Date,
  utcOffset: string
): ResolvedPeriod {
  const label = `period ${key.toUpperCase()}`;
  const start = resolveDateExpression(startInput, now, utcOffset);
  const end = resolveDateExpression(endInput, now, utcOffset);
  const startMs = Date.parse(start.start);
  const inclusiveEndMs = Date.parse(end.end);
  const endMs = end.start === end.end ? inclusiveEndMs : inclusiveEndMs + 1;

  if (endMs <= startMs) {
    throw new InvalidDateExpression(
      `The end of ${label} must be after its start: period_${key}_end "${endInput}" ` +
        `resolves to ${formatInstant(inclusiveEndMs, utcOffset)}, which is not after ` +
        `period_${key}_start "${startInput}" (${formatInstant(startMs, utcOffset)}).`
    );
  }
  const days = (endMs - startMs) / DAY_MS;
  if (days > MAX_PERIOD_DAYS) {
    throw new InvalidDateExpression(
      `Period ${key.toUpperCase()} spans ${Math.ceil(days)} days; each period can cover at most ` +
        `${MAX_PERIOD_DAYS} days.`
    );
  }
  const nowMs = now.getTime();
  const dayStartMs = snapToLocalMidnight(startMs, nowMs, utcOffset);
  const dayEndMs = snapToLocalMidnight(endMs, nowMs, utcOffset);
  const coversDays = dayEndMs > dayStartMs;
  // An end later today only rounds up to keep today; that is not worth a note
  const endRoundedUpForToday =
    endMs >= nowMs && dayEndMs === snapToLocalMidnight(nowMs, nowMs, utcOffset);
  const firstDay = coversDays ? dayAt(dayStartMs, utcOffset) : null;
  const lastDay = coversDays ? dayAt(dayEndMs - DAY_MS, utcOffset) : null;
  return {
    key,
    label,
    startMs,
    endMs,
    dayStartMs,
    dayEndMs,
    snapped: dayStartMs !== startMs || (dayEndMs !== endMs && !endRoundedUpForToday),
    dayRange:
      firstDay !== null && lastDay !== null
        ? fetchRangeForDays(firstDay, lastDay, utcOffset, nowMs)
        : null,
    summary: {
      start: formatInstant(startMs, utcOffset),
      end: formatInstant(inclusiveEndMs, utcOffset),
      days: round(days, 2),
      first_day: firstDay,
      last_day: lastDay,
    },
  };
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

interface SourceLoad<T> {
  records: T[];
  truncated: boolean;
  invalid: number;
  failed: boolean;
  error: unknown;
}

interface PeriodLoad {
  recovery: SourceLoad<Recovery>;
  sleep: SourceLoad<Sleep>;
  cycle: SourceLoad<Cycle>;
  workout: SourceLoad<Workout>;
}

/**
 * The fetched window: the period and its counted days with a margin on both
 * sides, widened to fetchRangeForDays over the counted days (two days either
 * side) so workouts after midnight of the last day and the cycles that place
 * them are read.
 */
function fetchWindow(period: ResolvedPeriod): { start: string; end: string } {
  const start = Math.min(period.startMs, period.dayStartMs) - FETCH_MARGIN_MS;
  const end = Math.max(period.endMs, period.dayEndMs) + FETCH_MARGIN_MS;
  return {
    start: new Date(Math.min(start, period.dayRange?.startMs ?? start)).toISOString(),
    end: new Date(Math.max(end, period.dayRange?.endMs ?? end)).toISOString(),
  };
}

/**
 * Fetch every record overlapping the period (plus a margin) and keep those
 * matching the record schema. WHOOP API and format errors degrade to an empty
 * source; auth and network errors abort the whole comparison.
 */
async function loadSource<T>(
  client: WhoopClient,
  endpoint: string,
  period: ResolvedPeriod,
  schema: z.ZodType
): Promise<SourceLoad<T>> {
  const query = new URLSearchParams({ ...fetchWindow(period), limit: String(PAGE_SIZE) });
  try {
    const result = await fetchAllPages<unknown>(client, `${endpoint}?${query.toString()}`, {
      maxRecords: ABSOLUTE_MAX_RECORDS,
      maxPages: Math.ceil(ABSOLUTE_MAX_RECORDS / PAGE_SIZE),
      interPageDelayMs: 0,
    });
    const records: T[] = [];
    let invalid = 0;
    for (const record of result.records) {
      if (schema.safeParse(record).success) records.push(record as T);
      else invalid += 1;
    }
    return { records, truncated: result.truncated, invalid, failed: false, error: null };
  } catch (error: unknown) {
    if (error instanceof WhoopAuthError || error instanceof WhoopNetworkError) throw error;
    return { records: [], truncated: false, invalid: 0, failed: true, error };
  }
}

/**
 * Fetch workouts for the training block. Every failure (including
 * authorization, e.g. a token without the workout scope) only nulls training.
 */
async function loadWorkouts(
  client: WhoopClient,
  period: ResolvedPeriod
): Promise<SourceLoad<Workout>> {
  try {
    return await loadSource<Workout>(client, ENDPOINT_WORKOUT, period, workoutRecordSchema);
  } catch (error: unknown) {
    return { records: [], truncated: false, invalid: 0, failed: true, error };
  }
}

/** Fetch recovery, sleep, cycle and workout data for one period (serialized) */
async function loadPeriod(client: WhoopClient, period: ResolvedPeriod): Promise<PeriodLoad> {
  const recovery = await loadSource<Recovery>(
    client,
    ENDPOINT_RECOVERY,
    period,
    recoveryRecordSchema
  );
  const sleep = await loadSource<Sleep>(client, ENDPOINT_SLEEP, period, sleepRecordSchema);
  const cycle = await loadSource<Cycle>(client, ENDPOINT_CYCLE, period, cycleRecordSchema);
  const workout = await loadWorkouts(client, period);
  return { recovery, sleep, cycle, workout };
}

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

interface PeriodSamples {
  recovery: number[];
  calibrating: number;
  sleepHours: number[];
  strain: number[];
  inProgressCycles: number;
  /** Completed cycles on a day WHOOP covered only in part (the strap was put on that day) */
  partialDays: number;
}

/**
 * Whether a local calendar day (taken in the record's own offset) is one of
 * the local days counted in the period (first_day..last_day inclusive).
 */
function containsDay(period: ResolvedPeriod, day: string): boolean {
  const { first_day: first, last_day: last } = period.summary;
  return first !== null && last !== null && day >= first && day <= last;
}

/**
 * The local day a recovery belongs to: its cycle's day, else the day its
 * sleep ended, else the day it was created in the user's offset.
 */
function recoveryDay(
  recovery: Recovery,
  cycles: Map<number, Cycle>,
  sleeps: Map<string, Sleep>,
  utcOffset: string
): string {
  const cycle = cycles.get(recovery.cycle_id);
  if (cycle) return cycleDay(cycle);
  const sleep = sleeps.get(recovery.sleep_id);
  if (sleep) return localDay(sleep.end, sleep.timezone_offset);
  return localDay(recovery.created_at, utcOffset);
}

/**
 * Place one period's fetched cycles, sleeps and recoveries on local days as
 * get_calendar does (shared by the strain samples and the training block).
 */
function placePeriod(load: PeriodLoad, now: Date, utcOffset: string): DayPlacement {
  return placeDays({
    cycles: load.cycle.records,
    sleeps: load.sleep.records,
    recoveries: load.recovery.records,
    sleepsAvailable: !load.sleep.failed,
    today: localDay(now.toISOString(), utcOffset),
    utcOffset,
  });
}

/** Attribute the fetched records to the period and extract metric samples */
function collectSamples(
  period: ResolvedPeriod,
  load: PeriodLoad,
  placement: DayPlacement,
  utcOffset: string
): PeriodSamples {
  const cycles = new Map(load.cycle.records.map((cycle) => [cycle.id, cycle]));
  const sleeps = new Map(load.sleep.records.map((sleep) => [sleep.id, sleep]));

  // Strain: completed, scored cycles on the period's days, placed as
  // get_calendar places them; a day WHOOP covered only in part is left out.
  const strain: number[] = [];
  let inProgressCycles = 0;
  let partialDays = 0;
  for (const cycle of cycles.values()) {
    const day = placement.dayOfCycle.get(cycle.id) ?? cycleDay(cycle);
    if (!containsDay(period, day)) continue;
    if (isOpenCycle(cycle)) {
      inProgressCycles += 1;
      continue;
    }
    if (isPartialDay(placement, day, cycle)) {
      partialDays += 1;
      continue;
    }
    if (cycle.score_state === "SCORED" && cycle.score) strain.push(cycle.score.strain);
  }

  const sleepHours = mainSleeps(load.sleep.records, fetchWindow(period), sourceQuality())
    .filter((sleep) => containsDay(period, localDay(sleep.end, sleep.timezone_offset)))
    .map(asleepHours);

  const recovery: number[] = [];
  let calibrating = 0;
  const seenCycles = new Set<number>();
  for (const record of load.recovery.records) {
    if (record.score_state !== "SCORED" || !record.score) continue;
    const day = recoveryDay(record, cycles, sleeps, utcOffset);
    if (!containsDay(period, day) || seenCycles.has(record.cycle_id)) continue;
    seenCycles.add(record.cycle_id);
    recovery.push(record.score.recovery_score);
    if (record.score.user_calibrating) calibrating += 1;
  }

  return { recovery, calibrating, sleepHours, strain, inProgressCycles, partialDays };
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

type Change = "up" | "down" | "flat" | "insufficient";

interface ComparedSamples {
  avgA: number | null;
  avgB: number | null;
  changePct: number | null;
  change: Change;
}

/** Compare two sample sets; below the minimum sample size no change is reported */
function compareSamples(a: number[], b: number[], digits: number): ComparedSamples {
  const avgA = a.length ? mean(a) : null;
  const avgB = b.length ? mean(b) : null;
  const rounded = {
    avgA: avgA === null ? null : round(avgA, digits),
    avgB: avgB === null ? null : round(avgB, digits),
  };
  if (
    avgA === null ||
    avgB === null ||
    a.length < MIN_SAMPLES_PER_PERIOD ||
    b.length < MIN_SAMPLES_PER_PERIOD
  ) {
    return { ...rounded, changePct: null, change: "insufficient" };
  }
  if (avgA === 0) {
    return avgB === 0
      ? { ...rounded, changePct: 0, change: "flat" }
      : { ...rounded, changePct: null, change: avgB > 0 ? "up" : "down" };
  }
  const changePct = ((avgB - avgA) / Math.abs(avgA)) * 100;
  const change: Change =
    Math.abs(changePct) <= UNCHANGED_THRESHOLD ? "flat" : changePct > 0 ? "up" : "down";
  return { ...rounded, changePct: round(changePct, 1), change };
}

function healthDirection(change: Change): HealthDirection {
  return change === "up"
    ? "improved"
    : change === "down"
      ? "declined"
      : change === "flat"
        ? "unchanged"
        : "insufficient_data";
}

function strainDirection(change: Change): StrainDirection {
  return change === "up"
    ? "increased"
    : change === "down"
      ? "decreased"
      : change === "flat"
        ? "unchanged"
        : "insufficient_data";
}

// ---------------------------------------------------------------------------
// Notes and warnings
// ---------------------------------------------------------------------------

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function describeFailure(error: unknown): string {
  return error instanceof WhoopApiError
    ? `WHOOP API returned ${error.statusCode}`
    : "the response was not in the expected format";
}

/** Warnings about fetch failures, skipped records and truncation for one period */
function loadWarnings(period: ResolvedPeriod, load: PeriodLoad): string[] {
  const warnings: string[] = [];
  const sources: Array<[string, SourceLoad<unknown>]> = [
    ["Recovery", load.recovery],
    ["Sleep", load.sleep],
    ["Cycle (strain)", load.cycle],
  ];
  for (const [name, source] of sources) {
    if (source.failed) {
      warnings.push(
        `${name} data for ${period.label} could not be loaded (${describeFailure(source.error)}), so that period has no ${name.toLowerCase()} samples.`
      );
    }
    if (source.invalid > 0) {
      warnings.push(
        `${plural(source.invalid, "record", "records")} of ${name.toLowerCase()} data for ${period.label} did not match the expected WHOOP format and ${source.invalid === 1 ? "was" : "were"} skipped.`
      );
    }
    if (source.truncated) {
      warnings.push(
        `${name} data for ${period.label} reached the ${ABSOLUTE_MAX_RECORDS}-record limit, so the oldest records of that period are not included.`
      );
    }
  }
  return warnings;
}

function insufficientNote(
  metric: string,
  unit: [string, string],
  aCount: number,
  bCount: number,
  calibrating: boolean,
  emptyPeriods: ResolvedPeriod[]
): string {
  if (emptyPeriods.length > 0) {
    const labels = emptyPeriods.map((period) => period.label).join(" and ");
    return `Cannot compare ${metric}: ${labels} ${emptyPeriods.length === 1 ? "covers" : "cover"} no local day.`;
  }
  const reason =
    aCount === 0 && bCount === 0
      ? `neither period has any ${unit[1]}`
      : `period A has ${plural(aCount, unit[0], unit[1])} and period B has ${bCount}; ` +
        `at least ${MIN_SAMPLES_PER_PERIOD} per period are needed`;
  const suffix = calibrating ? " WHOOP is still calibrating, so data is still building up." : "";
  return `Not enough data yet to compare ${metric}: ${reason}.${suffix}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Compare health metrics between two time periods.
 *
 * Fetches recovery, sleep, and cycle data for both periods, attributes each
 * record to exactly one period by local day, and returns averages, sample
 * counts, percentage changes (period B relative to period A), notes and warnings.
 *
 * @param client - WHOOP API client
 * @param params - The two periods (ISO 8601 dates/date-times or relative expressions)
 * @param now - Reference time for relative expressions (default: now)
 * @throws InvalidDateExpression for invalid, reversed, oversized (> 90 days) or overlapping periods
 */
export async function comparePeriods(
  client: WhoopClient,
  params: ComparePeriodsParams,
  now: Date = new Date(),
  options: AnalyticsToolOptions = {}
): Promise<PeriodComparison> {
  const { offset: utcOffset, fallback: offsetFallback } = await resolveUserUtcOffsetInfo(client);
  const periodA = resolvePeriod("a", params.period_a_start, params.period_a_end, now, utcOffset);
  const periodB = resolvePeriod("b", params.period_b_start, params.period_b_end, now, utcOffset);
  if (options.privacyMode === "aggregate")
    return aggregateComparePeriods(client, periodA, periodB, now, utcOffset, offsetFallback);

  if (periodA.startMs < periodB.endMs && periodB.startMs < periodA.endMs) {
    throw new InvalidDateExpression(
      `Periods overlap: period A (${periodA.summary.start} to ${periodA.summary.end}) and ` +
        `period B (${periodB.summary.start} to ${periodB.summary.end}) share time. Provide two ` +
        "non-overlapping periods; a YYYY-MM-DD end includes that whole local day."
    );
  }

  const loadA = await loadPeriod(client, periodA);
  const loadB = await loadPeriod(client, periodB);

  const sources = [loadA, loadB].flatMap((load) => [load.recovery, load.sleep, load.cycle]);
  const firstFailure = sources.find((source) => source.failed);
  if (firstFailure && sources.every((source) => source.failed)) throw firstFailure.error;
  const placementA = placePeriod(loadA, now, utcOffset);
  const placementB = placePeriod(loadB, now, utcOffset);
  const training = compareTraining(
    { period: periodA, load: loadA, placement: placementA },
    { period: periodB, load: loadB, placement: placementB }
  );

  const samplesA = collectSamples(periodA, loadA, placementA, utcOffset);
  const samplesB = collectSamples(periodB, loadB, placementB, utcOffset);

  const recovery = compareSamples(samplesA.recovery, samplesB.recovery, 1);
  const sleep = compareSamples(samplesA.sleepHours, samplesB.sleepHours, 2);
  const strain = compareSamples(samplesA.strain, samplesB.strain, 1);

  const calibrating = samplesA.calibrating + samplesB.calibrating > 0;
  const warnings = [
    ...loadWarnings(periodA, loadA),
    ...loadWarnings(periodB, loadB),
    ...training.warnings,
  ];
  const notes: string[] = [];
  const emptyPeriods = [periodA, periodB].filter((period) => period.summary.first_day === null);

  for (const period of [periodA, periodB]) {
    const { first_day: first, last_day: last, start, end } = period.summary;
    if (first === null || last === null) {
      notes.push(
        `${capitalize(period.label)} (${start} to ${end}) does not cover most of any local day, so no days were counted in it. A day counts toward a period when most of that day lies inside it; use YYYY-MM-DD dates to compare whole days.`
      );
    } else if (period.snapped) {
      notes.push(
        `${capitalize(period.label)} does not start and end at local midnight, so it counts the local days mostly inside it: ${first === last ? first : `${first} to ${last}`}.`
      );
    }
  }

  if (recovery.change === "insufficient") {
    notes.push(
      insufficientNote(
        "recovery",
        ["scored recovery", "scored recoveries"],
        samplesA.recovery.length,
        samplesB.recovery.length,
        calibrating,
        emptyPeriods
      )
    );
  }
  if (sleep.change === "insufficient") {
    notes.push(
      insufficientNote(
        "sleep",
        ["scored night", "scored nights"],
        samplesA.sleepHours.length,
        samplesB.sleepHours.length,
        calibrating,
        emptyPeriods
      )
    );
  }
  if (strain.change === "insufficient") {
    notes.push(
      insufficientNote(
        "strain",
        ["completed cycle", "completed cycles"],
        samplesA.strain.length,
        samplesB.strain.length,
        calibrating,
        emptyPeriods
      )
    );
  }
  for (const [period, samples] of [
    [periodA, samplesA],
    [periodB, samplesB],
  ] as const) {
    if (samples.calibrating > 0) {
      notes.push(
        `WHOOP was still calibrating for ${samples.calibrating} of ${plural(samples.recovery.length, "recovery", "recoveries")} in ${period.label}; they are included, but calibrating recovery scores are less reliable.`
      );
    }
    if (samples.inProgressCycles > 0) {
      notes.push(
        `The current cycle in ${period.label} is still in progress, so its strain is not included yet.`
      );
    }
    if (samples.partialDays > 0) {
      notes.push(
        `${capitalize(period.label)}: ${plural(samples.partialDays, "day", "days")} WHOOP covered only in part (the strap was put on that day) ${samples.partialDays === 1 ? "is" : "are"} left out of strain.`
      );
    }
  }
  notes.push(...training.notes);

  return {
    period_a: periodA.summary,
    period_b: periodB.summary,
    recovery: {
      period_a_avg: recovery.avgA,
      period_b_avg: recovery.avgB,
      period_a_n: samplesA.recovery.length,
      period_b_n: samplesB.recovery.length,
      change_pct: recovery.changePct,
      direction: healthDirection(recovery.change),
      period_a_calibrating_n: samplesA.calibrating,
      period_b_calibrating_n: samplesB.calibrating,
    },
    sleep: {
      period_a_avg_hours: sleep.avgA,
      period_b_avg_hours: sleep.avgB,
      period_a_n: samplesA.sleepHours.length,
      period_b_n: samplesB.sleepHours.length,
      change_pct: sleep.changePct,
      direction: healthDirection(sleep.change),
    },
    strain: {
      period_a_avg: strain.avgA,
      period_b_avg: strain.avgB,
      period_a_n: samplesA.strain.length,
      period_b_n: samplesB.strain.length,
      change_pct: strain.changePct,
      direction: strainDirection(strain.change),
    },
    training: training.value,
    truncated: [...sources, loadA.workout, loadB.workout].some((source) => source.truncated),
    notes: withOffsetNote(notes, offsetFallback),
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Training
// ---------------------------------------------------------------------------

interface TrainingTotals {
  sessions: number;
  wornDays: number;
  minutes: number;
  /** TRIMP of each worn day whose workouts were all scored and recorded to at least 90% */
  knownTrimpDays: number[];
  /** Worn days left out of the TRIMP mean */
  unknownTrimpDays: number;
  /** Workouts on counted days without a placed cycle (not counted) */
  unwornWorkouts: number;
  /** Workouts on worn days that WHOOP has not scored (not counted) */
  unscoredWorkouts: number;
  /** Counted workouts placed on their local start day without a containing cycle */
  fallbackWorkouts: number;
}

/** One period with its fetched records and their day placement */
interface PlacedPeriod {
  period: ResolvedPeriod;
  load: PeriodLoad;
  placement: DayPlacement;
}

/** Workout load on the worn local days of one period */
function trainingTotals({ period, load, placement }: PlacedPeriod): TrainingTotals {
  const totals: TrainingTotals = {
    sessions: 0,
    wornDays: 0,
    minutes: 0,
    knownTrimpDays: [],
    unknownTrimpDays: 0,
    unwornWorkouts: 0,
    unscoredWorkouts: 0,
    fallbackWorkouts: 0,
  };
  const { first_day: first, last_day: last } = period.summary;
  if (first === null || last === null) return totals;
  const placed = assignWorkouts(load.workout.records, placement, load.cycle.records);
  const byDay = new Map<string, Workout[]>();
  for (const workout of load.workout.records) {
    const day = placed.get(workout.id)?.day;
    if (day === undefined || !containsDay(period, day)) continue;
    const list = byDay.get(day) ?? [];
    list.push(workout);
    byDay.set(day, list);
  }
  for (let day = first; day <= last; day = addDays(day, 1)) {
    const workouts = byDay.get(day) ?? [];
    if (!placement.cycleByDay.has(day)) {
      totals.unwornWorkouts += workouts.length;
      continue;
    }
    totals.wornDays += 1;
    let trimp = 0;
    let trimpKnown = true;
    for (const workout of workouts) {
      if (workout.score_state !== "SCORED" || !workout.score) {
        totals.unscoredWorkouts += 1;
        trimpKnown = false;
        continue;
      }
      totals.sessions += 1;
      if (placed.get(workout.id)?.fallback) totals.fallbackWorkouts += 1;
      totals.minutes += Math.max(0, Date.parse(workout.end) - Date.parse(workout.start)) / 60_000;
      if (recordedFraction(workout.score.percent_recorded) < MIN_RECORDED_FRACTION)
        trimpKnown = false;
      trimp += edwardsTrimp(zoneMinutes(workout.score.zone_durations));
    }
    if (trimpKnown) totals.knownTrimpDays.push(trimp);
    else totals.unknownTrimpDays += 1;
  }
  return totals;
}

function percentChange(a: number | null, b: number | null): number | null {
  if (a === null || b === null || a === 0) return null;
  return roundTo(((b - a) / Math.abs(a)) * 100, 1);
}

/**
 * The training block: sessions, worn days and per-worn-day means per period.
 * Means need MIN_TRAINING_WORN_DAYS worn days in both periods; direction comes
 * from trimp_per_worn_day (±5% unchanged). Null, with a warning, when the
 * workout or cycle stream of either period could not be loaded.
 */
function compareTraining(
  placedA: PlacedPeriod,
  placedB: PlacedPeriod
): { value: TrainingComparison | null; notes: string[]; warnings: string[] } {
  const { period: periodA, load: loadA } = placedA;
  const { period: periodB, load: loadB } = placedB;
  const warnings: string[] = [];
  for (const [period, load] of [
    [periodA, loadA],
    [periodB, loadB],
  ] as const) {
    if (load.workout.failed)
      warnings.push(
        `Workout data for ${period.label} could not be loaded (${describeFailure(load.workout.error)}), so training is not compared.`
      );
    else if (load.cycle.failed)
      warnings.push(
        `Training is not compared: cycle data for ${period.label} could not be loaded, so worn days are unknown.`
      );
    if (load.workout.invalid > 0)
      warnings.push(
        `${plural(load.workout.invalid, "record", "records")} of workout data for ${period.label} did not match the expected WHOOP format and ${load.workout.invalid === 1 ? "was" : "were"} skipped.`
      );
    if (load.workout.truncated)
      warnings.push(
        `Workout data for ${period.label} reached the ${ABSOLUTE_MAX_RECORDS}-record limit, so the oldest workouts of that period are not included.`
      );
  }
  if ([loadA, loadB].some((load) => load.workout.failed || load.cycle.failed))
    return { value: null, notes: [], warnings };

  const totalsA = trainingTotals(placedA);
  const totalsB = trainingTotals(placedB);
  const sufficient =
    totalsA.wornDays >= MIN_TRAINING_WORN_DAYS && totalsB.wornDays >= MIN_TRAINING_WORN_DAYS;
  const summary = (totals: TrainingTotals): TrainingPeriodSummary => ({
    sessions: totals.sessions,
    worn_days: totals.wornDays,
    sessions_per_week: sufficient ? roundTo((totals.sessions / totals.wornDays) * 7, 2) : null,
    workout_minutes_per_worn_day: sufficient ? roundTo(totals.minutes / totals.wornDays, 1) : null,
    trimp_per_worn_day:
      sufficient && totals.knownTrimpDays.length ? roundTo(mean(totals.knownTrimpDays), 1) : null,
  });
  const a = summary(totalsA);
  const b = summary(totalsB);

  // Direction from the unrounded TRIMP means.
  const trimpA = sufficient && totalsA.knownTrimpDays.length ? mean(totalsA.knownTrimpDays) : null;
  const trimpB = sufficient && totalsB.knownTrimpDays.length ? mean(totalsB.knownTrimpDays) : null;
  let change: Change;
  if (trimpA === null || trimpB === null) change = "insufficient";
  else if (trimpA === 0) change = trimpB === 0 ? "flat" : "up";
  else {
    const pct = ((trimpB - trimpA) / Math.abs(trimpA)) * 100;
    change = Math.abs(pct) <= UNCHANGED_THRESHOLD ? "flat" : pct > 0 ? "up" : "down";
  }

  const notes: string[] = [];
  const emptyPeriods = [periodA, periodB].filter((period) => period.summary.first_day === null);
  if (emptyPeriods.length)
    notes.push(insufficientNote("training", ["worn day", "worn days"], 0, 0, false, emptyPeriods));
  else if (!sufficient)
    notes.push(
      `Not enough data yet to compare training: period A has ${plural(totalsA.wornDays, "worn day", "worn days")} and period B has ${totalsB.wornDays}; at least ${MIN_TRAINING_WORN_DAYS} per period are needed.`
    );
  for (const [period, totals] of [
    [periodA, totalsA],
    [periodB, totalsB],
  ] as const) {
    if (totals.unknownTrimpDays)
      notes.push(
        `${capitalize(plural(totals.unknownTrimpDays, "worn day", "worn days"))} in ${period.label} had a workout recorded below ${MIN_RECORDED_FRACTION * 100}% or not scored, so ${totals.unknownTrimpDays === 1 ? "it is" : "they are"} left out of trimp_per_worn_day.`
      );
    if (totals.unscoredWorkouts)
      notes.push(
        `${capitalize(plural(totals.unscoredWorkouts, "workout", "workouts"))} in ${period.label} without a WHOOP score ${totals.unscoredWorkouts === 1 ? "is" : "are"} not counted.`
      );
    if (totals.unwornWorkouts)
      notes.push(
        `${capitalize(plural(totals.unwornWorkouts, "workout", "workouts"))} in ${period.label} fell on days without a WHOOP cycle and ${totals.unwornWorkouts === 1 ? "is" : "are"} not counted.`
      );
    if (totals.fallbackWorkouts)
      notes.push(
        totals.fallbackWorkouts === 1
          ? `1 workout in ${period.label} had no containing WHOOP cycle and was placed on its local start day.`
          : `${totals.fallbackWorkouts} workouts in ${period.label} had no containing WHOOP cycle and were placed on their local start day.`
      );
  }
  return {
    value: {
      period_a: a,
      period_b: b,
      change_pct: {
        sessions_per_week: percentChange(a.sessions_per_week, b.sessions_per_week),
        workout_minutes_per_worn_day: percentChange(
          a.workout_minutes_per_worn_day,
          b.workout_minutes_per_worn_day
        ),
        trimp_per_worn_day:
          trimpA === null || trimpB === null || trimpA === 0
            ? null
            : roundTo(((trimpB - trimpA) / Math.abs(trimpA)) * 100, 1),
      },
      direction: strainDirection(change),
    },
    notes,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Aggregate privacy mode
// ---------------------------------------------------------------------------

/**
 * The whole released local weeks inside a period's counted days, oldest
 * first: every Monday-to-Sunday week between first_day and last_day that ends
 * no later than the latest released week.
 */
function releasedWeeksWithin(
  period: ResolvedPeriod,
  latestReleasedSunday: string,
  utcOffset: string
): LocalWeek[] {
  const { first_day: first, last_day: last } = period.summary;
  if (first === null || last === null) return [];
  const weeks: LocalWeek[] = [];
  let monday = mondayOf(first) === first ? first : addDays(mondayOf(first), 7);
  while (addDays(monday, 6) <= last && addDays(monday, 6) <= latestReleasedSunday) {
    weeks.push({
      monday,
      sunday: addDays(monday, 6),
      startMs: localMidnightMs(monday, utcOffset),
      endMs: localMidnightMs(addDays(monday, 7), utcOffset),
    });
    monday = addDays(monday, 7);
  }
  return weeks;
}

/** A period labelled with its snapped weeks (or no day when it has none) */
function snappedSummary(
  period: ResolvedPeriod,
  weeks: readonly LocalWeek[],
  utcOffset: string
): PeriodSummary {
  if (!weeks.length) return { ...period.summary, days: 0, first_day: null, last_day: null };
  const first = weeks[0]!;
  const last = weeks[weeks.length - 1]!;
  return {
    start: formatInstant(first.startMs, utcOffset),
    end: formatInstant(last.endMs - 1, utcOffset),
    days: weeks.length * 7,
    first_day: first.monday,
    last_day: last.sunday,
  };
}

interface AggregatePeriod {
  period: ResolvedPeriod;
  weeks: LocalWeek[];
  data: AggregateData | null;
  recovery: AggregateMetricResult | null;
  sleep: AggregateMetricResult | null;
  strain: AggregateMetricResult | null;
}

/** Average rounded to the metric's aggregate step, the change in whole percent */
function compareAggregate(
  a: AggregateMetricResult | null,
  b: AggregateMetricResult | null,
  step: number
): ComparedSamples {
  const valuesA = a?.released.map((sample) => sample.value) ?? [];
  const valuesB = b?.released.map((sample) => sample.value) ?? [];
  const compared = compareSamples(valuesA, valuesB, 10);
  const avgA = valuesA.length ? mean(valuesA) : null;
  const avgB = valuesB.length ? mean(valuesB) : null;
  const changePct =
    compared.change === "insufficient" || avgA === null || avgB === null || avgA === 0
      ? null
      : roundStep(((avgB - avgA) / Math.abs(avgA)) * 100, 1);
  return {
    avgA: avgA === null ? null : roundStep(avgA, step),
    avgB: avgB === null ? null : roundStep(avgB, step),
    changePct,
    change: compared.change,
  };
}

/**
 * Aggregate privacy mode: each period is snapped inward to the whole released
 * local weeks between its first and last counted day, and each metric uses
 * only final weeks with at least AGGREGATE_WEEK_MIN_SAMPLES samples (the same
 * samples every aggregate tool uses). Periods overlap only when they share a
 * snapped week. Training is not reported.
 */
async function aggregateComparePeriods(
  client: WhoopClient,
  periodA: ResolvedPeriod,
  periodB: ResolvedPeriod,
  now: Date,
  utcOffset: string,
  offsetFallback: boolean
): Promise<PeriodComparison> {
  const latestReleasedSunday = lastReleasedWeeks(now, utcOffset, 1)[0]!.sunday;
  const weeksA = releasedWeeksWithin(periodA, latestReleasedSunday, utcOffset);
  const weeksB = releasedWeeksWithin(periodB, latestReleasedSunday, utcOffset);
  const mondaysA = new Set(weeksA.map((week) => week.monday));
  const shared = weeksB.filter((week) => mondaysA.has(week.monday));
  if (shared.length) {
    throw new InvalidDateExpression(
      `Periods overlap: in aggregate privacy mode each period is snapped to whole released weeks, and period A and period B share ${shared.length === 1 ? "the week" : "the weeks"} starting ${shared.map((week) => week.monday).join(", ")}. Provide two periods that do not share a Monday-to-Sunday week.`
    );
  }

  const loadPeriodWeeks = async (
    period: ResolvedPeriod,
    weeks: LocalWeek[]
  ): Promise<AggregatePeriod> => {
    if (!weeks.length)
      return { period, weeks, data: null, recovery: null, sleep: null, strain: null };
    const data = await loadAggregateData(client, weeks, utcOffset, now);
    return {
      period,
      weeks,
      data,
      recovery: aggregateMetric(data, "recovery", {
        subject: "Recovery",
        unitPlural: "scored recoveries",
      }),
      sleep: aggregateMetric(data, "sleep_duration", {
        subject: "Sleep",
        unitPlural: "scored nights",
      }),
      strain: aggregateMetric(data, "strain", {
        subject: "Strain",
        unitPlural: "completed cycles",
      }),
    };
  };
  const a = await loadPeriodWeeks(periodA, weeksA);
  const b = await loadPeriodWeeks(periodB, weeksB);

  const loaded = [a.data, b.data].filter((data): data is AggregateData => data !== null);
  const sources = loaded.flatMap((data) => [data.recovery, data.sleep, data.cycle]);
  if (sources.length && sources.every((source) => source.quality.status === "fetch_failed"))
    throw mostRelevantError(sources.map((source) => source.error));

  const recovery = compareAggregate(a.recovery, b.recovery, AGGREGATE_METRIC_STEP.recovery);
  const sleep = compareAggregate(a.sleep, b.sleep, AGGREGATE_METRIC_STEP.sleep_duration);
  const strain = compareAggregate(a.strain, b.strain, AGGREGATE_METRIC_STEP.strain);

  const notes: string[] = [];
  const warnings: string[] = [];
  for (const side of [a, b]) {
    const label = capitalize(side.period.label);
    if (!side.weeks.length) {
      notes.push(
        `${label} contains no whole released week (Monday to Sunday, released two days after it ends), so it has no values in aggregate privacy mode.`
      );
      continue;
    }
    notes.push(releasedWeeksNote(side.weeks, ` for ${side.period.label}`));
    for (const note of withheldWeekNotes(side.data!)) notes.push(`${label}: ${note}`);
    for (const [name, source] of [
      ["Recovery", side.data!.recovery],
      ["Sleep", side.data!.sleep],
      ["Cycle (strain)", side.data!.cycle],
    ] as const) {
      if (source.quality.status === "fetch_failed" || source.quality.status === "invalid")
        warnings.push(`${name} data for ${side.period.label} could not be loaded.`);
      else if (source.quality.truncated)
        warnings.push(`${name} data for ${side.period.label} could not be read completely.`);
    }
    for (const result of [side.recovery, side.sleep, side.strain])
      for (const note of result!.notes) notes.push(`${label}: ${note}`);
  }
  const counts = (result: AggregateMetricResult | null): number => result?.released.length ?? 0;
  const empty = [a, b].filter((side) => !side.weeks.length).map((side) => side.period.label);
  const insufficient = (
    metric: string,
    unit: [string, string],
    aCount: number,
    bCount: number
  ): string =>
    empty.length
      ? `Cannot compare ${metric}: ${empty.join(" and ")} ${empty.length === 1 ? "has" : "have"} no whole released week.`
      : insufficientNote(metric, unit, aCount, bCount, false, []);
  if (recovery.change === "insufficient")
    notes.push(
      insufficient(
        "recovery",
        ["scored recovery", "scored recoveries"],
        counts(a.recovery),
        counts(b.recovery)
      )
    );
  if (sleep.change === "insufficient")
    notes.push(
      insufficient("sleep", ["scored night", "scored nights"], counts(a.sleep), counts(b.sleep))
    );
  if (strain.change === "insufficient")
    notes.push(
      insufficient(
        "strain",
        ["completed cycle", "completed cycles"],
        counts(a.strain),
        counts(b.strain)
      )
    );

  return {
    period_a: snappedSummary(periodA, weeksA, utcOffset),
    period_b: snappedSummary(periodB, weeksB, utcOffset),
    recovery: {
      period_a_avg: recovery.avgA,
      period_b_avg: recovery.avgB,
      period_a_n: counts(a.recovery),
      period_b_n: counts(b.recovery),
      change_pct: recovery.changePct,
      direction: healthDirection(recovery.change),
      period_a_calibrating_n: a.recovery?.exclusions.calibrating ?? 0,
      period_b_calibrating_n: b.recovery?.exclusions.calibrating ?? 0,
    },
    sleep: {
      period_a_avg_hours: sleep.avgA,
      period_b_avg_hours: sleep.avgB,
      period_a_n: counts(a.sleep),
      period_b_n: counts(b.sleep),
      change_pct: sleep.changePct,
      direction: healthDirection(sleep.change),
    },
    strain: {
      period_a_avg: strain.avgA,
      period_b_avg: strain.avgB,
      period_a_n: counts(a.strain),
      period_b_n: counts(b.strain),
      change_pct: strain.changePct,
      direction: strainDirection(strain.change),
    },
    training: null,
    truncated: loaded.some((data) =>
      [data.recovery, data.sleep, data.cycle].some((source) => source.quality.truncated)
    ),
    notes: withOffsetNote(notes, offsetFallback),
    warnings,
  };
}
