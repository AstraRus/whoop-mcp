/**
 * The shared day model: how WHOOP cycles, sleeps, recoveries and workouts map
 * onto the user's local calendar days.
 *
 * A WHOOP cycle runs from one sleep onset to the next, so it usually starts
 * the evening before the day it covers. Every day-based tool places records
 * with {@link placeDays} (extracted verbatim from get_calendar) and workouts
 * with {@link assignWorkouts}, so all tools agree on which day a record
 * belongs to. Fetch windows for a range of local days come from
 * {@link fetchRangeForDays}.
 *
 * Deterministic tie-breaks: {@link isBetterSleep} prefers a scored sleep, then
 * the longer one, then the later end, then the smaller id (as `mainSleeps`
 * does), so the same records in any order give the same placement.
 */

import type { Cycle, Recovery, Sleep, Workout } from "../api/types.js";
import { parseUtcOffset, resolveDateExpression } from "./date-utils.js";
import { cycleDay, DAY_MS, HOUR_MS, localDay, localMidnightMs } from "./analytics-utils.js";
import { LOW_DATA_COVERAGE_FRACTION } from "./sleep-metrics.js";

export { LOW_DATA_COVERAGE_FRACTION };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Largest gap between one cycle's end and the next cycle's start still treated as consecutive */
export const CYCLE_BOUNDARY_TOLERANCE_MS = 60_000;

/** Largest gap between a cycle's end and a sleep start for the fallback prior-cycle match */
export const PRIOR_CYCLE_FALLBACK_TOLERANCE_MS = 5 * 60_000;

/** A closed prior cycle shorter than this is flagged `short` */
export const SHORT_CYCLE_MS = 12 * HOUR_MS;

/** A closed prior cycle longer than this is flagged `long` */
export const LONG_CYCLE_MS = 36 * HOUR_MS;

/** Largest difference between a sleep start and its cycle start before `cycle_mismatch` */
export const CYCLE_SLEEP_START_TOLERANCE_MS = 60_000;

/** Largest difference between the stage sum and time in bed before `stage_sum_mismatch` */
export const STAGE_SUM_TOLERANCE_MS = 60_000;

// ---------------------------------------------------------------------------
// Day and record helpers
// ---------------------------------------------------------------------------

/** Shift a YYYY-MM-DD day by `count` days */
export function addDays(day: string, count: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + count * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `start` to `end` (YYYY-MM-DD or instants), rounded */
export function daysBetween(start: string, end: string): number {
  return Math.round((Date.parse(end) - Date.parse(start)) / DAY_MS);
}

/** Monday of the ISO week containing a YYYY-MM-DD calendar day */
export function mondayOf(day: string): string {
  const weekday = new Date(Date.parse(`${day}T00:00:00.000Z`)).getUTCDay();
  return addDays(day, weekday === 0 ? -6 : 1 - weekday);
}

/**
 * The local day a date-time bound starts: a local day counts when most of it
 * lies inside, so the bound snaps to the nearest local midnight.
 */
function nearestLocalDay(timestamp: string, offsetMinutes: number): string {
  const local = Date.parse(timestamp) + offsetMinutes * 60_000;
  const floor = Math.floor(local / DAY_MS) * DAY_MS;
  const snapped = local - floor >= DAY_MS / 2 ? floor + DAY_MS : floor;
  return new Date(snapped).toISOString().slice(0, 10);
}

/** True when `timestamp` is exactly local midnight in `offset` */
export function isLocalMidnight(timestamp: string, offset: string): boolean {
  const local = Date.parse(timestamp) + parseUtcOffset(offset) * 60_000;
  return local % DAY_MS === 0;
}

/** "2026-09-15 23:13" in the record's own offset */
export function localClock(timestamp: string, offset: string): string {
  return new Date(Date.parse(timestamp) + parseUtcOffset(offset) * 60_000)
    .toISOString()
    .slice(0, 16)
    .replace("T", " ");
}

function duration(record: { start: string; end: string }): number {
  return Date.parse(record.end) - Date.parse(record.start);
}

/**
 * Prefer a scored sleep, then the longer one, then the later one; an exact tie
 * goes to the smaller id (matching `mainSleeps`), so input order never matters.
 */
export function isBetterSleep(candidate: Sleep, current: Sleep): boolean {
  const candidateScored = candidate.score_state === "SCORED" && Boolean(candidate.score);
  const currentScored = current.score_state === "SCORED" && Boolean(current.score);
  if (candidateScored !== currentScored) return candidateScored;
  if (duration(candidate) !== duration(current)) return duration(candidate) > duration(current);
  if (Date.parse(candidate.end) !== Date.parse(current.end))
    return Date.parse(candidate.end) > Date.parse(current.end);
  return candidate.id < current.id;
}

/** True when `candidate` was updated strictly later than `current` */
export function isNewer(
  candidate: { updated_at: string },
  current: { updated_at: string }
): boolean {
  return Date.parse(candidate.updated_at) > Date.parse(current.updated_at);
}

/** The cycle's day strain, or null when the cycle is not scored */
export function cycleStrain(cycle: Cycle): number | null {
  return cycle.score_state === "SCORED" && cycle.score ? cycle.score.strain : null;
}

/** True while a cycle has no end (it is still accumulating strain) */
export function isOpenCycle(cycle: Cycle): boolean {
  return (cycle.end ?? null) === null;
}

/**
 * A cycle's main day: the local day its main sleep ended (the morning it
 * covers), or cycleDay() when it has no main sleep.
 */
export function mainDayOf(cycle: Cycle, mainSleepByCycle: ReadonlyMap<number, Sleep>): string {
  const sleep = mainSleepByCycle.get(cycle.id);
  return sleep ? localDay(sleep.end, sleep.timezone_offset) : cycleDay(cycle);
}

// ---------------------------------------------------------------------------
// placeDays
// ---------------------------------------------------------------------------

/** The records shown for one local day */
export interface DayRecords {
  cycle?: Cycle;
  sleep?: Sleep;
  recovery?: Recovery;
}

/** A cycle that could not be placed because another cycle kept its main day */
export interface DisplacedCycle {
  /** The main day both cycles belong to */
  day: string;
  /** The cycle placed on `day` */
  shown: Cycle;
  /** The cycle left out */
  other: Cycle;
}

export interface PlaceDaysInput {
  cycles: readonly Cycle[];
  sleeps: readonly Sleep[];
  recoveries: readonly Recovery[];
  /** False when the sleep stream failed: partial first days cannot be detected then */
  sleepsAvailable: boolean;
  /** The user's current local day (YYYY-MM-DD) */
  today: string;
  /** The user's UTC offset, used to date recoveries without a sleep or cycle */
  utcOffset: string;
}

export interface DayPlacement {
  /** Records per local day: the placed cycle with its main sleep and recovery, or orphans */
  byDay: Map<string, DayRecords>;
  /** The cycle placed on each local day */
  cycleByDay: Map<string, Cycle>;
  /** Every input cycle's day; a displaced cycle maps to its main day */
  dayOfCycle: Map<number, string>;
  /** Cycles left out because another cycle kept their main day, in placement order */
  displaced: DisplacedCycle[];
  /** Days whose placed cycle covers only part of the day (the strap was first worn that day) */
  partialDays: Set<string>;
  /**
   * The day of the newest cycle while it is still open and placed before
   * `today`: the days after it have no cycle yet (not missing data).
   */
  openCycleDay?: string;
  /** The cycle with the latest start */
  newestCycle?: Cycle;
  /** The best main sleep (isBetterSleep) per cycle id */
  mainSleepByCycle: Map<number, Sleep>;
  /** The most recently updated recovery per cycle id */
  recoveryByCycle: Map<number, Recovery>;
}

/**
 * Place cycles, main sleeps and recoveries on local days, exactly as
 * get_calendar shows them.
 *
 * Every cycle is placed on its main day (see {@link mainDayOf}); when two
 * cycles share one, the one with the better main sleep keeps it. The other
 * may move to its start day only when no cycle has that day as its main day
 * (e.g. a partial cycle before the first sleep), so one collision never shifts
 * other days; otherwise it is listed in `displaced`. Sleeps and recoveries
 * whose cycle is unavailable are placed by date instead.
 */
export function placeDays(input: PlaceDaysInput): DayPlacement {
  const { cycles, sleeps, recoveries, sleepsAvailable, today, utcOffset } = input;

  // --- Joins by cycle_id -----------------------------------------------------

  const mainSleepByCycle = new Map<number, Sleep>();
  for (const sleep of sleeps) {
    if (sleep.nap) continue;
    const current = mainSleepByCycle.get(sleep.cycle_id);
    if (!current || isBetterSleep(sleep, current)) mainSleepByCycle.set(sleep.cycle_id, sleep);
  }

  const recoveryByCycle = new Map<number, Recovery>();
  for (const recovery of recoveries) {
    const current = recoveryByCycle.get(recovery.cycle_id);
    if (!current || isNewer(recovery, current)) recoveryByCycle.set(recovery.cycle_id, recovery);
  }

  // --- Place each cycle on one local day ---------------------------------------

  const mainDays = new Set(cycles.map((cycle) => mainDayOf(cycle, mainSleepByCycle)));
  const orderedCycles = [...cycles].sort((a, b) => {
    const aSleep = mainSleepByCycle.get(a.id);
    const bSleep = mainSleepByCycle.get(b.id);
    if (aSleep && bSleep) {
      if (isBetterSleep(aSleep, bSleep)) return -1;
      if (isBetterSleep(bSleep, aSleep)) return 1;
    } else if (aSleep || bSleep) {
      return aSleep ? -1 : 1;
    }
    return Date.parse(b.start) - Date.parse(a.start);
  });

  const cycleByDay = new Map<string, Cycle>();
  const dayOfCycle = new Map<number, string>();
  const setDayOfCycle = (cycle: Cycle, day: string): void => {
    if (!dayOfCycle.has(cycle.id)) dayOfCycle.set(cycle.id, day);
  };
  const displacedCycles: Cycle[] = [];
  for (const cycle of orderedCycles) {
    const day = mainDayOf(cycle, mainSleepByCycle);
    if (cycleByDay.has(day)) displacedCycles.push(cycle);
    else {
      cycleByDay.set(day, cycle);
      setDayOfCycle(cycle, day);
    }
  }
  const displaced: DisplacedCycle[] = [];
  for (const cycle of displacedCycles) {
    const startDay = localDay(cycle.start, cycle.timezone_offset);
    if (!cycleByDay.has(startDay) && !mainDays.has(startDay)) {
      cycleByDay.set(startDay, cycle);
      setDayOfCycle(cycle, startDay);
      continue;
    }
    const day = mainDayOf(cycle, mainSleepByCycle);
    setDayOfCycle(cycle, day);
    const shown = cycleByDay.get(day);
    if (shown) displaced.push({ day, shown, other: cycle });
  }

  // The first cycle WHOOP records starts at local midnight of the day the
  // strap was put on, before any sleep: its strain covers only part of that day.
  const mainSleepStarts = sleeps
    .filter((sleep) => !sleep.nap)
    .map((sleep) => Date.parse(sleep.start));
  const firstMainSleepStart = mainSleepStarts.length > 0 ? Math.min(...mainSleepStarts) : Infinity;
  const partialDays = new Set<string>();
  if (sleepsAvailable) {
    for (const [day, cycle] of cycleByDay) {
      if (
        !mainSleepByCycle.has(cycle.id) &&
        Date.parse(cycle.start) < firstMainSleepStart &&
        isLocalMidnight(cycle.start, cycle.timezone_offset)
      ) {
        partialDays.add(day);
      }
    }
  }

  // The newest cycle still open on an earlier day keeps covering the days
  // after it until the next sleep syncs (e.g. after local midnight), so those
  // days have no cycle of their own yet but are not missing data.
  const newestCycle = [...cycles].sort((a, b) => Date.parse(b.start) - Date.parse(a.start))[0];
  let openCycleDay: string | undefined;
  if (newestCycle && isOpenCycle(newestCycle)) {
    for (const [day, cycle] of cycleByDay) {
      if (cycle.id === newestCycle.id && day < today) openCycleDay = day;
    }
  }

  const byDay = new Map<string, DayRecords>();
  const entryFor = (day: string): DayRecords => {
    let entry = byDay.get(day);
    if (!entry) {
      entry = {};
      byDay.set(day, entry);
    }
    return entry;
  };

  const placedCycleIds = new Set<number>();
  for (const [day, cycle] of cycleByDay) {
    placedCycleIds.add(cycle.id);
    const entry = entryFor(day);
    entry.cycle = cycle;
    entry.sleep = mainSleepByCycle.get(cycle.id);
    entry.recovery = recoveryByCycle.get(cycle.id);
  }

  // Sleeps and recoveries whose cycle is unavailable (cycle stream failed,
  // truncated or invalid) are placed by date instead.
  const orphanSleepByDay = new Map<string, Sleep>();
  for (const [cycleId, sleep] of mainSleepByCycle) {
    if (placedCycleIds.has(cycleId)) continue;
    const day = localDay(sleep.end, sleep.timezone_offset);
    const current = orphanSleepByDay.get(day);
    if (!current || isBetterSleep(sleep, current)) orphanSleepByDay.set(day, sleep);
  }
  for (const [day, sleep] of orphanSleepByDay) {
    const entry = entryFor(day);
    entry.sleep ??= sleep;
  }

  const sleepById = new Map(sleeps.map((sleep) => [sleep.id, sleep]));
  const orphanRecoveryByDay = new Map<string, Recovery>();
  for (const [cycleId, recovery] of recoveryByCycle) {
    if (placedCycleIds.has(cycleId)) continue;
    const sleep = sleepById.get(recovery.sleep_id);
    const day = sleep
      ? localDay(sleep.end, sleep.timezone_offset)
      : localDay(recovery.created_at, utcOffset);
    const current = orphanRecoveryByDay.get(day);
    if (!current || isNewer(recovery, current)) orphanRecoveryByDay.set(day, recovery);
  }
  for (const [day, recovery] of orphanRecoveryByDay) {
    const entry = entryFor(day);
    entry.recovery ??= recovery;
  }

  const placement: DayPlacement = {
    byDay,
    cycleByDay,
    dayOfCycle,
    displaced,
    partialDays,
    mainSleepByCycle,
    recoveryByCycle,
  };
  if (openCycleDay !== undefined) placement.openCycleDay = openCycleDay;
  if (newestCycle) placement.newestCycle = newestCycle;
  return placement;
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

/**
 * The fetch window for local days `firstDay`..`lastDay` in `offset`:
 * [local midnight of firstDay − 2, min(local midnight of lastDay + 2, now)).
 *
 * The two extra days before cover the cycle and main sleep that start the
 * evening before the first day (collections include records still ongoing at
 * `start`). The two days after cover workouts after local midnight that still
 * belong to the last day's cycle and the next cycle's start, which decides
 * where the last day's cycle ends, even when the end falls on a chunk
 * boundary. Callers still place records by day and drop the extra days.
 */
export function fetchRangeForDays(
  firstDay: string,
  lastDay: string,
  offset: string,
  nowMs: number
): { startMs: number; endMs: number } {
  return {
    startMs: localMidnightMs(addDays(firstDay, -2), offset),
    endMs: Math.min(localMidnightMs(addDays(lastDay, 2), offset), nowMs),
  };
}

/** A resolved range of local days and any note about how `start` was read */
export interface DayWindow {
  firstDay: string;
  lastDay: string;
  /** False only for the default window ending today, which is listed newest first */
  ascending: boolean;
  /** True when `start` was a date-time, snapped to its nearest local midnight */
  fromDateTime: boolean;
  notes: string[];
}

export interface DayWindowOptions {
  /** Days without `days` (get_calendar: 7) */
  defaultDays: number;
  /** Longest range a range expression may cover (get_calendar: 90) */
  maxDays: number;
  /** What the window is called in notes. Default "grid" (get_calendar's wording). */
  noun?: string;
}

/**
 * Work out a window's first and last local day (get_calendar semantics).
 * - No `start`: the window ends today and runs back `days` days.
 * - A range expression ("last 14 days", "this month", "last week", "2026-09"):
 *   the whole range, ending no later than today; with an explicit `days`,
 *   the range's first day plus `days` days.
 * - A single day ("yesterday", "2026-09-14") or a date-time: the window starts
 *   there (a date-time at its nearest local midnight) and runs forward `days`
 *   days, clamped to today.
 * The first day may be after today; callers decide how to report that.
 *
 * @throws InvalidDateExpression for an unparseable `start`
 */
export function resolveDayWindow(
  params: { days?: number; start?: string },
  now: Date,
  utcOffset: string,
  options: DayWindowOptions
): DayWindow {
  const { defaultDays, maxDays, noun = "grid" } = options;
  const today = localDay(now.toISOString(), utcOffset);
  const numDays = params.days ?? defaultDays;
  const notes: string[] = [];
  if (!params.start) {
    return {
      firstDay: addDays(today, -(numDays - 1)),
      lastDay: today,
      ascending: false,
      fromDateTime: false,
      notes,
    };
  }

  const resolved = resolveDateExpression(params.start, now, utcOffset);
  const isInstant = resolved.start === resolved.end;
  const gridStart = isInstant
    ? nearestLocalDay(resolved.start, parseUtcOffset(utcOffset))
    : localDay(resolved.start, utcOffset);
  const rangeEnd = localDay(resolved.end, utcOffset);
  const clampedRangeEnd = rangeEnd > today ? today : rangeEnd;

  if (isInstant || rangeEnd <= gridStart || params.days !== undefined) {
    const tentativeEnd = addDays(gridStart, numDays - 1);
    const gridEnd = tentativeEnd > today ? today : tentativeEnd;
    if (!isInstant && rangeEnd > gridStart && gridEnd < clampedRangeEnd) {
      notes.push(
        `"${params.start}" covers ${gridStart} to ${clampedRangeEnd}; with days ${numDays} the ${noun} shows only ${gridStart} to ${gridEnd}. Leave out days to show the whole range.`
      );
    }
    return {
      firstDay: gridStart,
      lastDay: gridEnd,
      ascending: true,
      fromDateTime: isInstant,
      notes,
    };
  }

  // A multi-day range expression without `days`: the range sets both ends.
  if (daysBetween(gridStart, clampedRangeEnd) + 1 > maxDays) {
    const shortenedStart = addDays(clampedRangeEnd, -(maxDays - 1));
    notes.push(
      `"${params.start}" covers ${gridStart} to ${clampedRangeEnd}, more than the ${maxDays}-day maximum; the ${noun} shows its last ${maxDays} days (${shortenedStart} to ${clampedRangeEnd}).`
    );
    return {
      firstDay: shortenedStart,
      lastDay: clampedRangeEnd,
      ascending: true,
      fromDateTime: false,
      notes,
    };
  }
  return {
    firstDay: gridStart,
    lastDay: clampedRangeEnd,
    ascending: true,
    fromDateTime: false,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Consecutive cycles
// ---------------------------------------------------------------------------

function byStartThenId(left: Cycle, right: Cycle): number {
  return Date.parse(left.start) - Date.parse(right.start) || left.id - right.id;
}

/**
 * The cycle that follows `cycle`: the one starting exactly at its end, else
 * the earliest start within {@link CYCLE_BOUNDARY_TOLERANCE_MS} after it.
 * Undefined while `cycle` is open or after a strap-off gap (never by index).
 */
export function nextCycle(cycle: Cycle, cycles: readonly Cycle[]): Cycle | undefined {
  if (cycle.end === null || cycle.end === undefined) return undefined;
  const endMs = Date.parse(cycle.end);
  let exact: Cycle | undefined;
  let near: Cycle | undefined;
  for (const candidate of cycles) {
    if (candidate.id === cycle.id) continue;
    const startMs = Date.parse(candidate.start);
    if (startMs === endMs) {
      if (!exact || candidate.id < exact.id) exact = candidate;
    } else if (startMs > endMs && startMs - endMs <= CYCLE_BOUNDARY_TOLERANCE_MS) {
      if (!near || byStartThenId(candidate, near) < 0) near = candidate;
    }
  }
  return exact ?? near;
}

/**
 * The cycle before `cycle`: the closed one ending exactly at its start, else
 * the latest end within {@link CYCLE_BOUNDARY_TOLERANCE_MS} before it.
 * Undefined after a strap-off gap (never by index).
 */
export function previousCycle(cycle: Cycle, cycles: readonly Cycle[]): Cycle | undefined {
  const startMs = Date.parse(cycle.start);
  let exact: Cycle | undefined;
  let near: Cycle | undefined;
  let nearEndMs = -Infinity;
  for (const candidate of cycles) {
    if (candidate.id === cycle.id) continue;
    if (candidate.end === null || candidate.end === undefined) continue;
    const endMs = Date.parse(candidate.end);
    if (endMs === startMs) {
      if (!exact || candidate.id < exact.id) exact = candidate;
    } else if (endMs < startMs && startMs - endMs <= CYCLE_BOUNDARY_TOLERANCE_MS) {
      if (!near || endMs > nearEndMs || (endMs === nearEndMs && candidate.id < near.id)) {
        near = candidate;
        nearEndMs = endMs;
      }
    }
  }
  return exact ?? near;
}

// ---------------------------------------------------------------------------
// assignWorkouts
// ---------------------------------------------------------------------------

/** Where a workout is counted */
export interface WorkoutPlacement {
  /** The placed day of the cycle containing the workout start, else its local start day */
  day: string;
  /** The cycle containing the workout start, or null */
  cycle: Cycle | null;
  /** True when no cycle contains the start and `day` is the local start day */
  fallback: boolean;
  /** True when the workout ends after its cycle ended */
  spans_cycle_boundary: boolean;
  /** True when the workout started on a later local day than the day it counts toward */
  after_midnight_in_previous_cycle: boolean;
}

/**
 * Assign each workout to a local day: the placed day of the cycle containing
 * its start (start <= workout start < end). An open cycle extends to +infinity
 * only when it is the newest cycle; any other open cycle ends where the next
 * cycle starts. Without a containing cycle the workout falls back to its local
 * start day (`fallback: true`). Keyed by workout id.
 */
export function assignWorkouts(
  workouts: readonly Workout[],
  placement: DayPlacement,
  cycles: readonly Cycle[]
): Map<string, WorkoutPlacement> {
  const sorted = [...cycles].sort(byStartThenId);
  const starts = sorted.map((cycle) => Date.parse(cycle.start));
  const ends = sorted.map((cycle, index) => {
    if (cycle.end !== null && cycle.end !== undefined) return Date.parse(cycle.end);
    if (placement.newestCycle?.id === cycle.id) return Infinity;
    const startMs = starts[index]!;
    const next = starts.slice(index + 1).find((value) => value > startMs);
    return next ?? startMs;
  });

  const containing = (startMs: number): Cycle | null => {
    // The last cycle starting at or before the workout, scanning back for overlaps.
    let low = 0;
    let high = sorted.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (starts[middle]! <= startMs) low = middle + 1;
      else high = middle;
    }
    for (let index = low - 1; index >= 0; index--) {
      if (startMs < ends[index]!) return sorted[index]!;
    }
    return null;
  };

  const result = new Map<string, WorkoutPlacement>();
  for (const workout of workouts) {
    const startMs = Date.parse(workout.start);
    const startDay = localDay(workout.start, workout.timezone_offset);
    const cycle = containing(startMs);
    if (!cycle) {
      result.set(workout.id, {
        day: startDay,
        cycle: null,
        fallback: true,
        spans_cycle_boundary: false,
        after_midnight_in_previous_cycle: false,
      });
      continue;
    }
    const day = placement.dayOfCycle.get(cycle.id) ?? mainDayOf(cycle, placement.mainSleepByCycle);
    result.set(workout.id, {
      day,
      cycle,
      fallback: false,
      spans_cycle_boundary:
        cycle.end !== null &&
        cycle.end !== undefined &&
        Date.parse(workout.end) > Date.parse(cycle.end),
      after_midnight_in_previous_cycle: startDay > day,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// buildNights
// ---------------------------------------------------------------------------

export interface NightPriorFlags {
  /** The prior cycle is the partial first day of wear */
  partial_first_day: boolean;
  /** The prior cycle has no end */
  open: boolean;
  /** The prior cycle lasted less than 12 hours */
  short: boolean;
  /** The prior cycle lasted more than 36 hours */
  long: boolean;
  /** The prior cycle has no strain score */
  strain_unscored: boolean;
}

export interface NightFlags {
  /** The sleep starts more than 60 s away from the start of its cycle */
  cycle_mismatch: boolean;
  /** Light + slow-wave + REM + awake + no-data differs from time in bed by more than 60 s */
  stage_sum_mismatch: boolean;
  /** No-data time exceeds LOW_DATA_COVERAGE_FRACTION of time in bed */
  low_data_coverage: boolean;
}

/** One main sleep with the cycles and records around it */
export interface Night {
  sleep: Sleep;
  /** Local day the sleep ended, in its own offset */
  wake_day: string;
  /** The cycle this sleep starts (cycle id === sleep.cycle_id), or null */
  cycle_after: Cycle | null;
  /** The cycle that ended at this sleep's onset, or null */
  prior_cycle: Cycle | null;
  prior_flags: NightPriorFlags | null;
  /** Placed day of the prior cycle, or null */
  prior_day: string | null;
  /** The recovery of cycle_after, only when it was scored for this sleep */
  recovery: Recovery | null;
  /** Naps belonging to the prior cycle, oldest first; null without a prior cycle */
  naps_in_prior_cycle: Sleep[] | null;
  /**
   * Workouts starting within the prior cycle, oldest first; null when workouts
   * are unavailable, there is no prior cycle, or the workout history is not
   * complete back to the prior cycle's start
   */
  workouts_in_prior_cycle: Workout[] | null;
  /** WHOOP's calibration flag on the recovery; null without a scored recovery */
  calibrating: boolean | null;
  flags: NightFlags;
}

export interface BuildNightsInput {
  sleeps: readonly Sleep[];
  cycles: readonly Cycle[];
  /** The recovery stream placement was built from; recoveries join through placement.recoveryByCycle */
  recoveries: readonly Recovery[];
  /** Null when the workout stream is unavailable */
  workouts: readonly Workout[] | null;
  /**
   * Instant (ISO 8601) from which the workout stream is complete (e.g. a
   * history source's complete_since); null when completeness is unknown
   */
  workoutsCompleteSince: string | null;
  placement: DayPlacement;
  nowMs: number;
}

export interface NightsResult {
  /** Newest first by sleep end */
  nights: Night[];
  /** Sleep records that did not become a night */
  excluded: {
    /** Every nap (naps are joined to nights through naps_in_prior_cycle) */
    nap: number;
    /** Main sleeps ending at or before their start */
    invalid_duration: number;
    /** Main sleeps ending after now */
    not_ended: number;
    /** Main sleeps that lost their wake day to a better sleep (isBetterSleep) */
    duplicate_day: number;
  };
}

function nightFlags(sleep: Sleep, cycleAfter: Cycle | null): NightFlags {
  const stages = sleep.score?.stage_summary;
  const inBed = stages?.total_in_bed_time_milli ?? 0;
  const stageSum = stages
    ? stages.total_light_sleep_time_milli +
      stages.total_slow_wave_sleep_time_milli +
      stages.total_rem_sleep_time_milli +
      stages.total_awake_time_milli +
      stages.total_no_data_time_milli
    : 0;
  return {
    cycle_mismatch:
      cycleAfter !== null &&
      Math.abs(Date.parse(cycleAfter.start) - Date.parse(sleep.start)) >
        CYCLE_SLEEP_START_TOLERANCE_MS,
    stage_sum_mismatch: stages !== undefined && Math.abs(stageSum - inBed) > STAGE_SUM_TOLERANCE_MS,
    low_data_coverage:
      stages !== undefined &&
      inBed > 0 &&
      stages.total_no_data_time_milli > LOW_DATA_COVERAGE_FRACTION * inBed,
  };
}

/**
 * Main sleeps (not naps, ended by now) one per wake day, chosen with
 * {@link isBetterSleep} (losers counted as duplicate_day), each joined to the
 * cycle it starts, the cycle before it, that cycle's naps and workouts, and
 * the recovery scored for it. Pending and unscorable sleeps are included.
 */
export function buildNights(input: BuildNightsInput): NightsResult {
  const { sleeps, cycles, workouts, workoutsCompleteSince, placement, nowMs } = input;
  const excluded = { nap: 0, invalid_duration: 0, not_ended: 0, duplicate_day: 0 };

  const napsByCycle = new Map<number, Sleep[]>();
  const byWakeDay = new Map<string, Sleep>();
  for (const sleep of sleeps) {
    const startMs = Date.parse(sleep.start);
    const endMs = Date.parse(sleep.end);
    const valid = endMs > startMs && endMs <= nowMs;
    if (sleep.nap) {
      excluded.nap++;
      if (valid) {
        const list = napsByCycle.get(sleep.cycle_id) ?? [];
        list.push(sleep);
        napsByCycle.set(sleep.cycle_id, list);
      }
      continue;
    }
    if (!(endMs > startMs)) {
      excluded.invalid_duration++;
      continue;
    }
    if (endMs > nowMs) {
      excluded.not_ended++;
      continue;
    }
    const day = localDay(sleep.end, sleep.timezone_offset);
    const current = byWakeDay.get(day);
    if (current) {
      excluded.duplicate_day++;
      if (!isBetterSleep(sleep, current)) continue;
    }
    byWakeDay.set(day, sleep);
  }
  const byStart = <T extends { start: string; id: string }>(left: T, right: T): number =>
    Date.parse(left.start) - Date.parse(right.start) ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

  const cycleById = new Map<number, Cycle>();
  for (const cycle of cycles) {
    const current = cycleById.get(cycle.id);
    if (!current || isNewer(cycle, current)) cycleById.set(cycle.id, cycle);
  }
  const completeSinceMs = workoutsCompleteSince === null ? NaN : Date.parse(workoutsCompleteSince);

  const nights: Night[] = [];
  for (const [wakeDay, sleep] of byWakeDay) {
    const sleepStartMs = Date.parse(sleep.start);
    const cycleAfter = cycleById.get(sleep.cycle_id) ?? null;

    let prior = cycleAfter ? previousCycle(cycleAfter, cycles) : undefined;
    if (!prior) {
      let bestStartMs = -Infinity;
      for (const candidate of cycles) {
        if (candidate.id === sleep.cycle_id) continue;
        if (candidate.end === null || candidate.end === undefined) continue;
        const startMs = Date.parse(candidate.start);
        if (startMs >= sleepStartMs) continue;
        if (Math.abs(Date.parse(candidate.end) - sleepStartMs) > PRIOR_CYCLE_FALLBACK_TOLERANCE_MS)
          continue;
        if (
          !prior ||
          startMs > bestStartMs ||
          (startMs === bestStartMs && candidate.id < prior.id)
        ) {
          prior = candidate;
          bestStartMs = startMs;
        }
      }
    }
    const priorCycle = prior ?? null;

    let priorFlags: NightPriorFlags | null = null;
    let priorDay: string | null = null;
    let naps: Sleep[] | null = null;
    let priorWorkouts: Workout[] | null = null;
    if (priorCycle) {
      priorDay =
        placement.dayOfCycle.get(priorCycle.id) ??
        mainDayOf(priorCycle, placement.mainSleepByCycle);
      const priorStartMs = Date.parse(priorCycle.start);
      const priorEndMs =
        priorCycle.end === null || priorCycle.end === undefined ? null : Date.parse(priorCycle.end);
      const lengthMs = priorEndMs === null ? null : priorEndMs - priorStartMs;
      priorFlags = {
        partial_first_day:
          placement.partialDays.has(priorDay) &&
          placement.cycleByDay.get(priorDay)?.id === priorCycle.id,
        open: priorEndMs === null,
        short: lengthMs !== null && lengthMs < SHORT_CYCLE_MS,
        long: lengthMs !== null && lengthMs > LONG_CYCLE_MS,
        strain_unscored: cycleStrain(priorCycle) === null,
      };
      naps = [...(napsByCycle.get(priorCycle.id) ?? [])].sort(byStart);
      if (
        workouts !== null &&
        Number.isFinite(completeSinceMs) &&
        priorStartMs >= completeSinceMs
      ) {
        const untilMs = priorEndMs ?? sleepStartMs;
        priorWorkouts = workouts
          .filter((workout) => {
            const startMs = Date.parse(workout.start);
            return startMs >= priorStartMs && startMs < untilMs;
          })
          .sort(byStart);
      }
    }

    const candidate = placement.recoveryByCycle.get(sleep.cycle_id);
    const recovery = candidate && candidate.sleep_id === sleep.id ? candidate : null;

    nights.push({
      sleep,
      wake_day: wakeDay,
      cycle_after: cycleAfter,
      prior_cycle: priorCycle,
      prior_flags: priorFlags,
      prior_day: priorDay,
      recovery,
      naps_in_prior_cycle: naps,
      workouts_in_prior_cycle: priorWorkouts,
      calibrating: recovery?.score?.user_calibrating ?? null,
      flags: nightFlags(sleep, cycleAfter),
    });
  }
  nights.sort(
    (left, right) =>
      Date.parse(right.sleep.end) - Date.parse(left.sleep.end) ||
      (left.sleep.id < right.sleep.id ? -1 : left.sleep.id > right.sleep.id ? 1 : 0)
  );
  return { nights, excluded };
}
