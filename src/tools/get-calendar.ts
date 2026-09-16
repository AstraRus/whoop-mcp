/**
 * Tool: get_calendar
 *
 * Returns a day-by-day grid of the user's local days. Each row shows the
 * WHOOP cycle that covers that day: its strain, plus the recovery and main
 * sleep joined to it by cycle_id. A cycle starts at sleep onset (usually the
 * evening before), so the sleep that starts it and the recovery scored on
 * waking belong to the same row as the day's strain. Today's row shows the
 * in-progress cycle. Between local midnight and the next synced sleep no
 * cycle for today exists yet: today's row stays empty and a note says the
 * strain is still being added to the previous day's open cycle.
 *
 * The three streams are fetched in parallel; a stream that fails nulls its
 * columns and adds a warning instead of failing the whole grid. Missing,
 * pending, partial and calibrating data is explained in `notes`.
 */

import type { z } from "zod";
import type { WhoopClient } from "../api/client.js";
import { WhoopApiError, WhoopAuthError, WhoopNetworkError } from "../api/client.js";
import type { Recovery, Sleep, Cycle, ScoreState } from "../api/types.js";
import { ENDPOINT_RECOVERY, ENDPOINT_SLEEP, ENDPOINT_CYCLE } from "../api/endpoints.js";
import { fetchAllPages, type FetchAllPagesResult } from "../api/pagination.js";
import {
  cycleRecordSchema,
  recoveryRecordSchema,
  sleepRecordSchema,
} from "../api/record-schemas.js";
import { parseUtcOffset, resolveDateExpression } from "./date-utils.js";
import { resolveUserUtcOffsetInfo, withOffsetNote } from "./collection-utils.js";
import { asleepHours, cycleDay, DAY_MS, localDay } from "./analytics-utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CalendarDay {
  /** Local calendar day (YYYY-MM-DD) */
  date: string;
  recovery_score: number | null;
  recovery_zone: "green" | "yellow" | "red" | null;
  /** True when WHOOP marked the recovery as calibrating; null without a recovery score */
  recovery_calibrating: boolean | null;
  /** Hours asleep (light + slow-wave + REM) in the day's main sleep; naps excluded */
  sleep_hours: number | null;
  sleep_performance_pct: number | null;
  day_strain: number | null;
  /** True when the day's cycle is still open, so its strain is still accumulating */
  day_strain_in_progress: boolean;
  /**
   * True when the strain covers only part of the day (WHOOP was first worn
   * partway through it); such strain is left out of averages.strain
   */
  day_strain_partial: boolean;
}

export interface CalendarAverages {
  recovery: number | null;
  sleep_hours: number | null;
  strain: number | null;
  /** Number of days each average is based on */
  sample_sizes: { recovery: number; sleep_hours: number; strain: number };
}

export interface CalendarGrid {
  period: { start: string; end: string; days: number; utc_offset: string };
  days: CalendarDay[];
  averages: CalendarAverages;
  /** True when a stream hit its record limit, so the earliest days may be incomplete */
  truncated: boolean;
  /** Explanations of expected gaps: calibration, pending scores, in-progress strain, no data */
  notes: string[];
  /** Data problems: failed streams, truncation, skipped records */
  warnings: string[];
}

export interface CalendarParams {
  days?: number;
  start?: string;
}

/** The records that make up one row of the grid */
interface DayRecords {
  cycle?: Cycle;
  sleep?: Sleep;
  recovery?: Recovery;
}

/** A settled, validated stream */
interface StreamData<T> {
  records: T[];
  available: boolean;
  truncated: boolean;
}

/** How a stream is named in warnings and how its records map to days */
interface StreamSpec<T> {
  name: string;
  columns: string;
  schema: z.ZodType;
  maxRecords: number;
  dayOf: (record: T) => string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_DAYS = 7;

/** Longest grid, matching the `days` input limit */
const MAX_DAYS = 90;

/** Record budget per fetched day: one cycle and one recovery a day, sleeps include naps */
const RECORDS_PER_DAY = { recovery: 2, sleep: 4, cycle: 2 } as const;

/** Below this many days an average is flagged as not yet reliable */
const MIN_RELIABLE_DAYS = 4;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Shift a YYYY-MM-DD day by `count` days */
function addDays(day: string, count: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + count * DAY_MS).toISOString().slice(0, 10);
}

/** The UTC instant of local midnight at the start of `day` */
function localMidnightUtc(day: string, offsetMinutes: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) - offsetMinutes * 60_000).toISOString();
}

function daysBetween(start: string, end: string): number {
  return Math.round((Date.parse(end) - Date.parse(start)) / DAY_MS);
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
function isLocalMidnight(timestamp: string, offset: string): boolean {
  const local = Date.parse(timestamp) + parseUtcOffset(offset) * 60_000;
  return local % DAY_MS === 0;
}

/** "2026-09-15 23:13" in the record's own offset */
function localClock(timestamp: string, offset: string): string {
  return new Date(Date.parse(timestamp) + parseUtcOffset(offset) * 60_000)
    .toISOString()
    .slice(0, 16)
    .replace("T", " ");
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function recoveryZone(score: number): "green" | "yellow" | "red" {
  if (score >= 67) return "green";
  if (score >= 34) return "yellow";
  return "red";
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return round1(values.reduce((a, b) => a + b, 0) / values.length);
}

function isNumber(value: number | null): value is number {
  return value !== null;
}

function duration(record: { start: string; end: string }): number {
  return Date.parse(record.end) - Date.parse(record.start);
}

/** Prefer a scored sleep, then the longer one, then the later one */
function isBetterSleep(candidate: Sleep, current: Sleep): boolean {
  const candidateScored = candidate.score_state === "SCORED" && Boolean(candidate.score);
  const currentScored = current.score_state === "SCORED" && Boolean(current.score);
  if (candidateScored !== currentScored) return candidateScored;
  if (duration(candidate) !== duration(current)) return duration(candidate) > duration(current);
  return Date.parse(candidate.end) > Date.parse(current.end);
}

function isNewer(candidate: { updated_at: string }, current: { updated_at: string }): boolean {
  return Date.parse(candidate.updated_at) > Date.parse(current.updated_at);
}

function cycleStrain(cycle: Cycle): number | null {
  return cycle.score_state === "SCORED" && cycle.score ? cycle.score.strain : null;
}

function isOpen(cycle: Cycle): boolean {
  return (cycle.end ?? null) === null;
}

/** Describe a stream failure by error type and HTTP status only (never bodies or URLs) */
function describeFailure(error: unknown, depth = 0): string {
  if (error instanceof WhoopApiError) return `WHOOP API returned HTTP ${error.statusCode}`;
  const isClientError = error instanceof WhoopAuthError || error instanceof WhoopNetworkError;
  const cause = isClientError ? error.cause : undefined;
  if (
    depth < 3 &&
    (cause instanceof WhoopApiError ||
      cause instanceof WhoopAuthError ||
      cause instanceof WhoopNetworkError)
  ) {
    return describeFailure(cause, depth + 1);
  }
  if (error instanceof WhoopAuthError) return "WHOOP authentication failed";
  if (error instanceof WhoopNetworkError) return "network error";
  return "unexpected error";
}

/**
 * Turn a settled fetch into validated records, adding warnings for a failed
 * stream, records that fail validation, and truncation.
 */
function settleStream<T>(
  outcome: PromiseSettledResult<FetchAllPagesResult<T>>,
  spec: StreamSpec<T>,
  warnings: string[]
): StreamData<T> {
  if (outcome.status === "rejected") {
    warnings.push(
      `${spec.name} data could not be loaded (${describeFailure(outcome.reason)}), so these columns are null for every day: ${spec.columns}.`
    );
    return { records: [], available: false, truncated: false };
  }
  const fetched = Array.isArray(outcome.value.records) ? outcome.value.records : [];
  const records = fetched.filter((record) => spec.schema.safeParse(record).success);
  const invalid = fetched.length - records.length;
  if (invalid > 0) {
    warnings.push(
      `${invalid} ${spec.name.toLowerCase()} record(s) did not match the expected WHOOP format and were skipped.`
    );
  }
  if (outcome.value.truncated) {
    const oldest = records.map(spec.dayOf).sort()[0];
    warnings.push(
      `${spec.name} data hit the ${spec.maxRecords}-record limit. WHOOP returns newest records first, so ` +
        (oldest ? `days before ${oldest}` : "the earliest days") +
        ` may be missing data in: ${spec.columns}. Request fewer days for a complete grid.`
    );
  }
  return { records, available: true, truncated: outcome.value.truncated };
}

/** "2026-09-14" or "2026-09-14, 2026-09-15" */
function listDays(days: string[]): string {
  return [...days].sort().join(", ");
}

/** The grid's local days and any note about how `start` was read */
interface GridWindow {
  gridStart: string;
  gridEnd: string;
  ascending: boolean;
  /** True when `start` was a date-time, snapped to its nearest local midnight */
  fromDateTime: boolean;
  notes: string[];
}

/**
 * Work out the grid's first and last local day.
 * - No `start`: the grid ends today and runs back `days` days.
 * - A range expression ("last 14 days", "this month", "last week", "2026-09"):
 *   the whole range, ending no later than today; with an explicit `days`,
 *   the range's first day plus `days` days.
 * - A single day ("yesterday", "2026-09-14") or a date-time: the grid starts
 *   there (a date-time at its nearest local midnight) and runs forward `days`
 *   days, clamped to today.
 */
function resolveGridWindow(
  params: CalendarParams,
  now: Date,
  utcOffset: string,
  today: string
): GridWindow {
  const numDays = params.days ?? DEFAULT_DAYS;
  const notes: string[] = [];
  if (!params.start) {
    return {
      gridStart: addDays(today, -(numDays - 1)),
      gridEnd: today,
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
        `"${params.start}" covers ${gridStart} to ${clampedRangeEnd}; with days ${numDays} the grid shows only ${gridStart} to ${gridEnd}. Leave out days to show the whole range.`
      );
    }
    return { gridStart, gridEnd, ascending: true, fromDateTime: isInstant, notes };
  }

  // A multi-day range expression without `days`: the range sets both ends.
  if (daysBetween(gridStart, clampedRangeEnd) + 1 > MAX_DAYS) {
    const shortenedStart = addDays(clampedRangeEnd, -(MAX_DAYS - 1));
    notes.push(
      `"${params.start}" covers ${gridStart} to ${clampedRangeEnd}, more than the ${MAX_DAYS}-day maximum; the grid shows its last ${MAX_DAYS} days (${shortenedStart} to ${clampedRangeEnd}).`
    );
    return {
      gridStart: shortenedStart,
      gridEnd: clampedRangeEnd,
      ascending: true,
      fromDateTime: false,
      notes,
    };
  }
  return { gridStart, gridEnd: clampedRangeEnd, ascending: true, fromDateTime: false, notes };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Get a day-by-day calendar grid of recovery, sleep, and strain.
 *
 * @param client - Authenticated WHOOP API client
 * @param params - Optional: days (default 7), start (natural language or ISO)
 * @param now - Evaluation time (defaults to the current time)
 * @returns Calendar grid with per-day data, averages, notes and warnings
 */
export async function getCalendar(
  client: WhoopClient,
  params: CalendarParams,
  now: Date = new Date()
): Promise<CalendarGrid> {
  const { offset: utcOffset, fallback: offsetFallback } = await resolveUserUtcOffsetInfo(client);
  const offsetMinutes = parseUtcOffset(utcOffset);
  const today = localDay(now.toISOString(), utcOffset);
  const warnings: string[] = [];

  // Grid days are the user's local calendar days.
  const window = resolveGridWindow(params, now, utcOffset, today);
  const { gridStart, gridEnd, ascending } = window;
  const notes: string[] = [...window.notes];

  if (gridStart > today) {
    const fromDateTime = window.fromDateTime
      ? " (a date-time start counts from its nearest local midnight)"
      : "";
    return {
      period: { start: gridStart, end: gridStart, days: 0, utc_offset: utcOffset },
      days: [],
      averages: {
        recovery: null,
        sleep_hours: null,
        strain: null,
        sample_sizes: { recovery: 0, sleep_hours: 0, strain: 0 },
      },
      truncated: false,
      notes: [
        `The start date ${gridStart}${fromDateTime} is after today (${today}); there are no days to show.`,
      ],
      warnings,
    };
  }

  const gridLength = daysBetween(gridStart, gridEnd) + 1;

  // The first day's cycle and sleep begin the evening before, so fetch from
  // local midnight a day early up to the local midnight after the last day.
  // Template strings are safe: toISOString only yields URL-safe characters.
  const startISO = localMidnightUtc(addDays(gridStart, -1), offsetMinutes);
  const endISO = localMidnightUtc(addDays(gridEnd, 1), offsetMinutes);
  const query = `start=${startISO}&end=${endISO}&limit=25`;
  const fetchedDays = gridLength + 2;

  // Throttle inter-page requests for large ranges to avoid 429s across
  // three parallel paginated streams.
  const interPageDelayMs = gridLength > 30 ? 100 : 0;

  const recoverySpec: StreamSpec<Recovery> = {
    name: "Recovery",
    columns: "recovery_score, recovery_zone, recovery_calibrating",
    schema: recoveryRecordSchema,
    maxRecords: fetchedDays * RECORDS_PER_DAY.recovery,
    dayOf: (recovery) => localDay(recovery.created_at, utcOffset),
  };
  const sleepSpec: StreamSpec<Sleep> = {
    name: "Sleep",
    columns: "sleep_hours, sleep_performance_pct",
    schema: sleepRecordSchema,
    maxRecords: fetchedDays * RECORDS_PER_DAY.sleep,
    dayOf: (sleep) => localDay(sleep.end, sleep.timezone_offset),
  };
  const cycleSpec: StreamSpec<Cycle> = {
    name: "Cycle",
    columns: "day_strain",
    schema: cycleRecordSchema,
    maxRecords: fetchedDays * RECORDS_PER_DAY.cycle,
    dayOf: (cycle) => cycleDay(cycle),
  };

  const [recoveryOutcome, sleepOutcome, cycleOutcome] = await Promise.allSettled([
    fetchAllPages<Recovery>(client, `${ENDPOINT_RECOVERY}?${query}`, {
      maxRecords: recoverySpec.maxRecords,
      interPageDelayMs,
    }),
    fetchAllPages<Sleep>(client, `${ENDPOINT_SLEEP}?${query}`, {
      maxRecords: sleepSpec.maxRecords,
      interPageDelayMs,
    }),
    fetchAllPages<Cycle>(client, `${ENDPOINT_CYCLE}?${query}`, {
      maxRecords: cycleSpec.maxRecords,
      interPageDelayMs,
    }),
  ]);

  // Every stream failed: nothing to show, surface the error itself.
  if (
    recoveryOutcome.status === "rejected" &&
    sleepOutcome.status === "rejected" &&
    cycleOutcome.status === "rejected"
  ) {
    throw recoveryOutcome.reason;
  }

  const recoveries = settleStream(recoveryOutcome, recoverySpec, warnings);
  const sleeps = settleStream(sleepOutcome, sleepSpec, warnings);
  const cycles = settleStream(cycleOutcome, cycleSpec, warnings);

  if (utcOffset === "Z") {
    const latest = [...cycles.records].sort((a, b) => Date.parse(b.start) - Date.parse(a.start))[0];
    if (latest && parseUtcOffset(latest.timezone_offset) !== 0) {
      warnings.push(
        "Could not read your timezone before building the grid; days are UTC calendar days."
      );
    }
  }

  // --- Joins by cycle_id -----------------------------------------------------

  const mainSleepByCycle = new Map<number, Sleep>();
  for (const sleep of sleeps.records) {
    if (sleep.nap) continue;
    const current = mainSleepByCycle.get(sleep.cycle_id);
    if (!current || isBetterSleep(sleep, current)) mainSleepByCycle.set(sleep.cycle_id, sleep);
  }

  const recoveryByCycle = new Map<number, Recovery>();
  for (const recovery of recoveries.records) {
    const current = recoveryByCycle.get(recovery.cycle_id);
    if (!current || isNewer(recovery, current)) recoveryByCycle.set(recovery.cycle_id, recovery);
  }

  // --- Place each cycle on one local day ---------------------------------------
  // A cycle's main day is the local day its main sleep ended (the morning it
  // covers), or cycleDay() without a sleep. Every cycle is placed on its main
  // day; when two cycles share one, the one with the better main sleep keeps
  // it. The other may move to its start day only when no cycle has that day
  // as its main day (e.g. a partial cycle before the first sleep), so one
  // collision never shifts other days. A cycle that cannot be placed is
  // named in a warning.

  const mainDayOf = (cycle: Cycle): string => {
    const sleep = mainSleepByCycle.get(cycle.id);
    return sleep ? localDay(sleep.end, sleep.timezone_offset) : cycleDay(cycle);
  };
  const mainDays = new Set(cycles.records.map(mainDayOf));
  const orderedCycles = [...cycles.records].sort((a, b) => {
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
  const displaced: Cycle[] = [];
  for (const cycle of orderedCycles) {
    const day = mainDayOf(cycle);
    if (cycleByDay.has(day)) displaced.push(cycle);
    else cycleByDay.set(day, cycle);
  }
  for (const cycle of displaced) {
    const startDay = localDay(cycle.start, cycle.timezone_offset);
    if (!cycleByDay.has(startDay) && !mainDays.has(startDay)) {
      cycleByDay.set(startDay, cycle);
      continue;
    }
    const day = mainDayOf(cycle);
    const shown = cycleByDay.get(day);
    if (day < gridStart || day > gridEnd || !shown) continue;
    const strain = cycleStrain(cycle);
    const strainText =
      strain === null ? "" : ` (strain ${round1(strain)}${isOpen(cycle) ? " so far" : ""})`;
    warnings.push(
      `Two WHOOP cycles belong to ${day} (for example, a second main sleep ended that day). ` +
        `The row shows the cycle that started ${localClock(shown.start, shown.timezone_offset)}; ` +
        `the cycle that started ${localClock(cycle.start, cycle.timezone_offset)}${strainText} is left out of the grid and its averages.`
    );
  }

  // The first cycle WHOOP records starts at local midnight of the day the
  // strap was put on, before any sleep: its strain covers only part of that day.
  const mainSleepStarts = sleeps.records
    .filter((sleep) => !sleep.nap)
    .map((sleep) => Date.parse(sleep.start));
  const firstMainSleepStart = mainSleepStarts.length > 0 ? Math.min(...mainSleepStarts) : Infinity;
  const partialStrainDays = new Set<string>();
  if (sleeps.available) {
    for (const [day, cycle] of cycleByDay) {
      if (
        !mainSleepByCycle.has(cycle.id) &&
        Date.parse(cycle.start) < firstMainSleepStart &&
        isLocalMidnight(cycle.start, cycle.timezone_offset)
      ) {
        partialStrainDays.add(day);
      }
    }
  }

  // The newest cycle still open on an earlier day keeps covering the days
  // after it until the next sleep syncs (e.g. after local midnight), so those
  // days have no cycle of their own yet but are not missing data.
  const newestCycle = [...cycles.records].sort(
    (a, b) => Date.parse(b.start) - Date.parse(a.start)
  )[0];
  let openCycleDay: string | undefined;
  if (newestCycle && isOpen(newestCycle)) {
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

  const sleepById = new Map(sleeps.records.map((sleep) => [sleep.id, sleep]));
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

  // --- Build rows ----------------------------------------------------------------

  const unscoredDays = new Map<string, string[]>();
  const flag = (key: string, day: string): void => {
    const list = unscoredDays.get(key) ?? [];
    list.push(day);
    unscoredDays.set(key, list);
  };
  const flagUnscored = (column: string, state: ScoreState, day: string): void => {
    if (state === "PENDING_SCORE") flag(`pending:${column}`, day);
    else if (state === "UNSCORABLE") flag(`unscorable:${column}`, day);
  };

  const days: CalendarDay[] = [];
  const emptyDays: string[] = [];
  const openCycleDays: string[] = [];
  for (let i = 0; i < gridLength; i++) {
    const date = ascending ? addDays(gridStart, i) : addDays(gridEnd, -i);
    const { cycle, sleep, recovery } = byDay.get(date) ?? {};
    if (!cycle && !sleep && !recovery) {
      if (openCycleDay !== undefined && date > openCycleDay && date <= today) {
        openCycleDays.push(date);
      } else {
        emptyDays.push(date);
      }
    }

    const recoveryScore =
      recovery?.score_state === "SCORED" && recovery.score ? recovery.score : null;
    if (recovery && !recoveryScore) flagUnscored("recovery", recovery.score_state, date);
    if (recoveryScore?.user_calibrating) flag("calibrating", date);

    const sleepScored = sleep?.score_state === "SCORED" && sleep.score ? sleep : null;
    if (sleep && !sleepScored) flagUnscored("sleep", sleep.score_state, date);

    const strain = cycle ? cycleStrain(cycle) : null;
    if (cycle && strain === null) flagUnscored("strain", cycle.score_state, date);
    const inProgress = cycle !== undefined && isOpen(cycle);
    if (inProgress && strain !== null) flag("in_progress", date);
    const partial = cycle !== undefined && partialStrainDays.has(date);
    if (partial && strain !== null) flag("partial", date);

    days.push({
      date,
      recovery_score: recoveryScore?.recovery_score ?? null,
      recovery_zone: recoveryScore ? recoveryZone(recoveryScore.recovery_score) : null,
      recovery_calibrating: recoveryScore ? recoveryScore.user_calibrating : null,
      sleep_hours: sleepScored ? round1(asleepHours(sleepScored)) : null,
      sleep_performance_pct: sleepScored?.score?.sleep_performance_percentage ?? null,
      day_strain: strain,
      day_strain_in_progress: inProgress,
      day_strain_partial: partial,
    });
  }

  // --- Averages over days that have data -------------------------------------------

  const recoveryValues = days.map((d) => d.recovery_score).filter(isNumber);
  const sleepValues = days.map((d) => d.sleep_hours).filter(isNumber);
  const strainValues = days
    .filter((d) => !d.day_strain_in_progress && !d.day_strain_partial)
    .map((d) => d.day_strain)
    .filter(isNumber);

  // --- Notes -----------------------------------------------------------------------

  const flagged = (key: string): string[] => unscoredDays.get(key) ?? [];
  const calibrating = flagged("calibrating");
  if (calibrating.length > 0) {
    notes.push(
      `WHOOP is still calibrating: recovery for ${listDays(calibrating)} is provisional (recovery_calibrating: true) and is included in averages.recovery.`
    );
  }
  for (const [column, label] of [
    ["recovery", "Recovery"],
    ["sleep", "Sleep"],
    ["strain", "Strain"],
  ] as const) {
    const pending = flagged(`pending:${column}`);
    if (pending.length > 0) {
      notes.push(
        `${label} for ${listDays(pending)} is still being scored by WHOOP; shown as null.`
      );
    }
    const unscorable = flagged(`unscorable:${column}`);
    if (unscorable.length > 0) {
      notes.push(`WHOOP could not score ${column} for ${listDays(unscorable)}; shown as null.`);
    }
  }
  const inProgressDays = flagged("in_progress");
  if (inProgressDays.length > 0) {
    notes.push(
      `Strain for ${listDays(inProgressDays)} is still accumulating (day_strain_in_progress: true) and is left out of averages.strain.`
    );
  }
  const partialDays = flagged("partial");
  if (partialDays.length > 0) {
    notes.push(
      `Strain for ${listDays(partialDays)} covers only part of the day (WHOOP was first worn partway through it; day_strain_partial: true) and is left out of averages.strain.`
    );
  }

  if (openCycleDay !== undefined && openCycleDays.length > 0) {
    const openCycle = cycleByDay.get(openCycleDay)!;
    const strain = cycleStrain(openCycle);
    const where =
      openCycleDay >= gridStart && openCycleDay <= gridEnd
        ? `shown on ${openCycleDay} (day_strain_in_progress: true)`
        : `which belongs to ${openCycleDay}, outside this grid` +
          (strain === null ? "" : `; its strain so far is ${round1(strain)}`);
    const subject =
      openCycleDays.length === 1 && openCycleDays[0] === today
        ? `Today's (${today}) WHOOP cycle has not started yet`
        : `No WHOOP cycle has started yet for ${listDays(openCycleDays)}`;
    notes.push(
      `${subject}: a new cycle begins at your next sleep and appears once that sleep syncs. ` +
        `Until then, strain is still being added to the open cycle that started ${localClock(openCycle.start, openCycle.timezone_offset)}, ${where}. ` +
        `${openCycleDays.length === 1 ? "Its row stays" : "Their rows stay"} null until then; this is not missing data.`
    );
  }

  const daysWithData = gridLength - emptyDays.length - openCycleDays.length;
  const partlyLoaded = !recoveries.available || !sleeps.available || !cycles.available;
  const loadedCaveat = partlyLoaded ? " Some data could not be loaded; see warnings." : "";
  if (emptyDays.length > 0 && daysWithData === 0) {
    notes.push(
      (openCycleDays.length === 0
        ? "No WHOOP data for any day in this range; all values are null."
        : `No WHOOP data for ${listDays(emptyDays)}; their values are null.`) + loadedCaveat
    );
  } else if (emptyDays.length > 0) {
    const firstDataDay = days
      .filter((d) => !emptyDays.includes(d.date) && !openCycleDays.includes(d.date))
      .map((d) => d.date)
      .sort()[0];
    const allBefore = firstDataDay !== undefined && emptyDays.every((d) => d < firstDataDay);
    notes.push(
      (allBefore
        ? `No WHOOP data before ${firstDataDay} in this range; the ${emptyDays.length} earlier day(s) are null.`
        : `No WHOOP data for ${emptyDays.length} of ${gridLength} days (e.g. before you started wearing WHOOP or while it was off); their values are null.`) +
        loadedCaveat
    );
  }

  const scorableDays = gridLength - openCycleDays.length;
  const completedStrainDays = days.filter(
    (d) => !d.day_strain_in_progress && !d.day_strain_partial && !openCycleDays.includes(d.date)
  ).length;
  const coverage = [
    { name: "recovery", stream: recoveries, count: recoveryValues.length, of: scorableDays },
    { name: "sleep", stream: sleeps, count: sleepValues.length, of: scorableDays },
    { name: "strain", stream: cycles, count: strainValues.length, of: completedStrainDays },
  ].filter((column) => column.stream.available);
  if (daysWithData > 0 && coverage.some((column) => column.count < column.of)) {
    const fewest = Math.min(...coverage.map((column) => column.count));
    const prefix =
      fewest < MIN_RELIABLE_DAYS
        ? "Not enough data yet for reliable averages"
        : "Averages use only days with data";
    const parts = coverage.map(
      (column) =>
        `${column.name} ${column.count} of ${column.of}${column.name === "strain" && completedStrainDays < scorableDays ? " completed" : ""} days`
    );
    notes.push(`${prefix}: ${parts.join(", ")}. An average is null when no day has data.`);
  }

  return {
    period: { start: gridStart, end: gridEnd, days: gridLength, utc_offset: utcOffset },
    days,
    averages: {
      recovery: average(recoveryValues),
      sleep_hours: average(sleepValues),
      strain: average(strainValues),
      sample_sizes: {
        recovery: recoveryValues.length,
        sleep_hours: sleepValues.length,
        strain: strainValues.length,
      },
    },
    truncated: recoveries.truncated || sleeps.truncated || cycles.truncated,
    notes: withOffsetNote(notes, offsetFallback),
    warnings,
  };
}
