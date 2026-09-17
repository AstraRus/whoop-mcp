/**
 * Released local ISO weeks for aggregate privacy mode.
 *
 * Aggregate outputs are built only from whole local Monday-to-Sunday weeks
 * that are "released": a week is released two days after it ends (at
 * Wednesday 00:00 local), so records that sync late (a Sunday cycle still
 * open after midnight, a late bedtime, a pending score) cannot change a
 * released value between calls. A released week is still withheld while it
 * is not final (an open cycle or a pending score placed in it), and a week
 * with fewer than AGGREGATE_WEEK_MIN_SAMPLES samples is gated out per metric.
 *
 * The release lag covers late syncs only. Aggregate sources are fetched
 * uncached, so an edit in WHOOP to a record of an already released week (a
 * workout added, deleted or rescored) changes that week's released values on
 * the next call, and comparing the values before and after the edit reveals
 * that record's contribution to within the rounding step. The workout totals
 * therefore use coarse steps (AGGREGATE_WORKOUT_KJ_STEP,
 * AGGREGATE_WORKOUT_STRAIN_STEP).
 *
 * Longer windows use 4- or 13-week blocks aligned to the epoch Monday
 * (1970-01-05), so the same block has the same bounds in every call.
 *
 * Week membership is decided by placed local day (YYYY-MM-DD strings from the
 * day model); the millisecond bounds use one offset and only size fetches.
 */

import type { ScoreState } from "../api/types.js";
import { localDay, localMidnightMs, type SourceQuality } from "./analytics-utils.js";
import { addDays, daysBetween, isOpenCycle, mondayOf, type DayPlacement } from "./day-model.js";
import { roundTo } from "./stats-utils.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Samples a released week needs before it contributes to an aggregate metric */
export const AGGREGATE_WEEK_MIN_SAMPLES = 3;

/** Days after a week ends before it is released (the released week changes at Wednesday 00:00 local) */
export const AGGREGATE_RELEASE_LAG_DAYS = 2;

/** Rounding step of a released week's total workout energy (kJ), as training-aggregate uses */
export const AGGREGATE_WORKOUT_KJ_STEP = 100;

/** Rounding step of a released week's summed workout strain */
export const AGGREGATE_WORKOUT_STRAIN_STEP = 1;

/** The Monday every aggregate block is aligned to */
export const EPOCH_MONDAY = "1970-01-05";

/** Block lengths in weeks */
export type BlockWeeks = 4 | 13;

// ---------------------------------------------------------------------------
// Weeks
// ---------------------------------------------------------------------------

/** A local ISO week */
export interface LocalWeek {
  /** Monday (YYYY-MM-DD) */
  monday: string;
  /** Sunday (YYYY-MM-DD) */
  sunday: string;
  /** Local midnight starting Monday, in the given offset */
  startMs: number;
  /** Local midnight after Sunday (exclusive), in the given offset */
  endMs: number;
}

function localWeek(monday: string, offset: string): LocalWeek {
  return {
    monday,
    sunday: addDays(monday, 6),
    startMs: localMidnightMs(monday, offset),
    endMs: localMidnightMs(addDays(monday, 7), offset),
  };
}

/** Monday of the local ISO week containing `now` */
export function currentWeekMonday(now: Date, offset: string): string {
  return mondayOf(localDay(now.toISOString(), offset));
}

/** Monday of the latest released week */
function latestReleasedMonday(now: Date, offset: string): string {
  const lagged = addDays(localDay(now.toISOString(), offset), -AGGREGATE_RELEASE_LAG_DAYS);
  return addDays(mondayOf(lagged), -7);
}

/**
 * The last millisecond of the latest released week: local midnight of the
 * Monday of the ISO week containing (today − 2 days), minus 1 ms.
 */
export function releasedWeeksEnd(now: Date, offset: string): number {
  const lagged = addDays(localDay(now.toISOString(), offset), -AGGREGATE_RELEASE_LAG_DAYS);
  return localMidnightMs(mondayOf(lagged), offset) - 1;
}

/**
 * The `count` latest released weeks, oldest first; the last one ends at
 * {@link releasedWeeksEnd} (its endMs is one millisecond later).
 * @throws RangeError for a count below 1
 */
export function lastReleasedWeeks(now: Date, offset: string, count: number): LocalWeek[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError("lastReleasedWeeks requires a count of at least 1.");
  }
  const latest = latestReleasedMonday(now, offset);
  const weeks: LocalWeek[] = [];
  for (let back = count - 1; back >= 0; back--) {
    weeks.push(localWeek(addDays(latest, -7 * back), offset));
  }
  return weeks;
}

/**
 * Whether a week's values can no longer change: false when a cycle placed in
 * the week is still open (e.g. the Sunday cycle before the Monday sleep syncs)
 * or any record placed in it is PENDING_SCORE. Checks the placed cycles, main
 * sleeps and recoveries (displaced cycles included) plus `records`, which
 * carry their own placed day (e.g. workouts from assignWorkouts).
 */
export function weekFinal(
  monday: string,
  placement: DayPlacement,
  records: readonly { day: string; score_state: ScoreState }[] = []
): boolean {
  const sunday = addDays(monday, 6);
  const inWeek = (day: string): boolean => day >= monday && day <= sunday;
  const pending = (record: { score_state: ScoreState } | undefined): boolean =>
    record?.score_state === "PENDING_SCORE";
  for (let offset = 0; offset < 7; offset++) {
    const entry = placement.byDay.get(addDays(monday, offset));
    if (!entry) continue;
    if (entry.cycle && isOpenCycle(entry.cycle)) return false;
    if (pending(entry.cycle) || pending(entry.sleep) || pending(entry.recovery)) return false;
  }
  for (const { day, other } of placement.displaced) {
    if (!inWeek(day)) continue;
    if (isOpenCycle(other) || pending(other)) return false;
    if (pending(placement.mainSleepByCycle.get(other.id))) return false;
    if (pending(placement.recoveryByCycle.get(other.id))) return false;
  }
  return !records.some((record) => inWeek(record.day) && pending(record));
}

/**
 * The smallest allowed week count covering `days` (ceil(days / 7)), or the
 * largest allowed count when none does.
 * @throws RangeError for non-positive days or an empty or invalid allowed list
 */
export function snapWeeks(days: number, allowed: readonly number[]): number {
  if (!Number.isFinite(days) || days <= 0) throw new RangeError("snapWeeks requires days > 0.");
  if (allowed.length === 0 || allowed.some((weeks) => !Number.isInteger(weeks) || weeks < 1)) {
    throw new RangeError("snapWeeks requires positive whole week counts.");
  }
  const needed = Math.ceil(days / 7);
  const sorted = [...allowed].sort((left, right) => left - right);
  return sorted.find((weeks) => weeks >= needed) ?? sorted[sorted.length - 1]!;
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/** A run of consecutive weeks aligned to {@link EPOCH_MONDAY} */
export interface WeekBlock {
  /** Block number since the epoch Monday */
  index: number;
  weeks: BlockWeeks;
  /** First Monday */
  start: string;
  /** Last Sunday */
  end: string;
  /** Every Monday in the block, oldest first */
  mondays: string[];
}

function blockAt(index: number, weeks: BlockWeeks): WeekBlock {
  const start = addDays(EPOCH_MONDAY, index * weeks * 7);
  return {
    index,
    weeks,
    start,
    end: addDays(start, weeks * 7 - 1),
    mondays: Array.from({ length: weeks }, (_, week) => addDays(start, week * 7)),
  };
}

/**
 * The epoch-aligned block of `weeks` weeks containing a Monday.
 * @throws RangeError when `monday` is not a Monday
 */
export function blockOf(monday: string, weeks: BlockWeeks): WeekBlock {
  const days = daysBetween(EPOCH_MONDAY, monday);
  if (mondayOf(monday) !== monday || days % 7 !== 0) {
    throw new RangeError(`blockOf requires a Monday, got ${monday}.`);
  }
  return blockAt(Math.floor(days / 7 / weeks), weeks);
}

/**
 * The latest block whose weeks are all released (offsetBlocks 1), or the
 * block `offsetBlocks − 1` before it.
 * @throws RangeError for offsetBlocks below 1
 */
export function lastReleasedBlock(
  now: Date,
  offset: string,
  weeks: BlockWeeks,
  offsetBlocks = 1
): WeekBlock {
  if (!Number.isInteger(offsetBlocks) || offsetBlocks < 1) {
    throw new RangeError("lastReleasedBlock requires offsetBlocks of at least 1.");
  }
  const latest = latestReleasedMonday(now, offset);
  const containing = blockOf(latest, weeks);
  const complete = containing.mondays[containing.mondays.length - 1] === latest;
  const latestComplete = complete ? containing.index : containing.index - 1;
  return blockAt(latestComplete - (offsetBlocks - 1), weeks);
}

// ---------------------------------------------------------------------------
// Gating and rounding
// ---------------------------------------------------------------------------

/**
 * Split weeks into those with at least `min` samples (released) and the rest
 * (withheld), keeping their order.
 */
export function gateWeeks<T extends { monday: string; samples: number }>(
  weeks: readonly T[],
  min: number = AGGREGATE_WEEK_MIN_SAMPLES
): { released: T[]; withheld: T[] } {
  const released: T[] = [];
  const withheld: T[] = [];
  for (const week of weeks) (week.samples >= min ? released : withheld).push(week);
  return { released, withheld };
}

/**
 * Whether a total over released and withheld weeks can be shown next to the
 * released weeks without isolating withheld samples: the withheld weeks hold
 * no samples or at least AGGREGATE_WEEK_MIN_SAMPLES of them.
 */
export function differenceSafe(withheldSamples: number): boolean {
  return withheldSamples === 0 || withheldSamples >= AGGREGATE_WEEK_MIN_SAMPLES;
}

function stepDecimals(step: number): number {
  const text = String(step);
  const exponent = /e-(\d+)$/.exec(text);
  if (exponent)
    return Math.min(10, Number(exponent[1]) + (text.split("e")[0]!.split(".")[1]?.length ?? 0));
  return Math.min(10, text.split(".")[1]?.length ?? 0);
}

/**
 * Round to the nearest multiple of `step` (half away from zero), e.g. step 10
 * for minutes or 0.05 for a ratio, without floating-point residue.
 * @throws RangeError for a non-finite value or a non-positive step
 */
export function roundStep(value: number, step: number): number {
  if (!Number.isFinite(value)) throw new RangeError("roundStep requires a finite value.");
  if (!Number.isFinite(step) || step <= 0) throw new RangeError("roundStep requires a step > 0.");
  const multiples = roundTo(value / step, 0);
  return roundTo(multiples * step, stepDecimals(step));
}

// ---------------------------------------------------------------------------
// Data quality in aggregate mode
// ---------------------------------------------------------------------------

/** One fetched record as aggregate source counts see it */
export interface CountedRecord {
  /** Placed local day (YYYY-MM-DD), or null when the record could not be placed */
  day: string | null;
  /** Why the record was not used, or null when it contributed a value */
  exclusion: string | null;
}

/** The source fields aggregate data_quality keeps */
export interface AggregateSourceCounts {
  status: SourceQuality["status"];
  records_fetched: number;
  records_used: number;
  exclusions: Record<string, number>;
  truncated: boolean;
}

/**
 * Source counts limited to records placed in released weeks, so records
 * fetched beyond the window (the 2-day placement margin, the current week)
 * never change aggregate output. Unplaced records are not counted. The status
 * is recomputed from these counts (as finishQuality does), except that a
 * failed or unreadable source keeps its status.
 */
export function aggregateSourceCounts(
  quality: Pick<SourceQuality, "status" | "truncated">,
  records: readonly CountedRecord[],
  releasedMondays: Iterable<string>
): AggregateSourceCounts {
  const mondays = new Set(releasedMondays);
  let fetched = 0;
  let used = 0;
  const exclusions: Record<string, number> = {};
  for (const record of records) {
    if (record.day === null || !mondays.has(mondayOf(record.day))) continue;
    fetched++;
    if (record.exclusion === null) used++;
    else exclusions[record.exclusion] = (exclusions[record.exclusion] ?? 0) + 1;
  }
  let status: SourceQuality["status"];
  if (quality.status === "fetch_failed" || quality.status === "invalid") status = quality.status;
  else if (used > 0) status = "available";
  else if (exclusions.pending) status = "pending";
  else if (exclusions.calibrating) status = "calibrating";
  else if (exclusions.unscored) status = "unscored";
  else status = "missing";
  return {
    status,
    records_fetched: fetched,
    records_used: used,
    exclusions,
    truncated: quality.truncated,
  };
}

/** Aggregate evaluated_at: the user's local date of `now` (YYYY-MM-DD), never the exact time */
export function aggregateEvaluatedAt(now: Date, offset: string): string {
  return localDay(now.toISOString(), offset);
}
