/**
 * Tool: get_calendar
 *
 * Returns a day-by-day grid of the user's local days. Each row shows the
 * WHOOP cycle that covers that day: its strain, plus the recovery and main
 * sleep joined to it by cycle_id. A cycle starts at sleep onset (usually the
 * evening before), so the sleep that starts it and the recovery scored on
 * waking belong to the same row as the day's strain. Today's row shows the
 * in-progress cycle.
 *
 * The three streams are fetched in parallel; a stream that fails nulls its
 * columns and adds a warning instead of failing the whole grid. Missing,
 * pending and calibrating data is explained in `notes`.
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
import { resolveUserUtcOffset } from "./collection-utils.js";
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
  const numDays = params.days ?? DEFAULT_DAYS;
  const utcOffset = await resolveUserUtcOffset(client);
  const offsetMinutes = parseUtcOffset(utcOffset);
  const today = localDay(now.toISOString(), utcOffset);
  const notes: string[] = [];
  const warnings: string[] = [];

  // Grid days are the user's local calendar days.
  // - With `start`: grid begins at `start`, iterates forward, clamped to today (no future days).
  // - Without `start`: grid ends today and extends backward `numDays`.
  let gridStart: string;
  let gridEnd: string;
  let ascending: boolean;
  if (params.start) {
    const resolved = resolveDateExpression(params.start, now, utcOffset);
    gridStart = localDay(resolved.start, utcOffset);
    const tentativeEnd = addDays(gridStart, numDays - 1);
    gridEnd = tentativeEnd > today ? today : tentativeEnd;
    ascending = true;
  } else {
    gridEnd = today;
    gridStart = addDays(today, -(numDays - 1));
    ascending = false;
  }

  if (gridStart > today) {
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
      notes: [`The start date ${gridStart} is after today (${today}); there are no days to show.`],
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
  const interPageDelayMs = numDays > 30 ? 100 : 0;

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
  // A cycle's day is the local day its main sleep ended (the morning it covers),
  // or cycleDay() without a sleep. Cycles with a sleep are placed first; a cycle
  // whose day is already taken (e.g. a partial first cycle) falls back to its
  // start day, so no cycle silently overwrites another.

  const cycleByDay = new Map<string, Cycle>();
  const unplaced: Cycle[] = [];
  const orderedCycles = [...cycles.records].sort((a, b) => {
    const aJoined = mainSleepByCycle.has(a.id) ? 1 : 0;
    const bJoined = mainSleepByCycle.has(b.id) ? 1 : 0;
    return bJoined - aJoined || Date.parse(b.start) - Date.parse(a.start);
  });
  for (const cycle of orderedCycles) {
    const sleep = mainSleepByCycle.get(cycle.id);
    const candidates = [
      sleep ? localDay(sleep.end, sleep.timezone_offset) : cycleDay(cycle),
      cycleDay(cycle),
      localDay(cycle.start, cycle.timezone_offset),
    ];
    const day = candidates.find((candidate) => !cycleByDay.has(candidate));
    if (day === undefined) {
      if (candidates.some((candidate) => candidate >= gridStart && candidate <= gridEnd)) {
        unplaced.push(cycle);
      }
      continue;
    }
    cycleByDay.set(day, cycle);
  }
  if (unplaced.length > 0) {
    warnings.push(
      `${unplaced.length} cycle(s) overlapped another cycle's day and were left out of the grid.`
    );
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
  for (let i = 0; i < gridLength; i++) {
    const date = ascending ? addDays(gridStart, i) : addDays(gridEnd, -i);
    const { cycle, sleep, recovery } = byDay.get(date) ?? {};
    if (!cycle && !sleep && !recovery) emptyDays.push(date);

    const recoveryScore =
      recovery?.score_state === "SCORED" && recovery.score ? recovery.score : null;
    if (recovery && !recoveryScore) flagUnscored("recovery", recovery.score_state, date);
    if (recoveryScore?.user_calibrating) flag("calibrating", date);

    const sleepScored = sleep?.score_state === "SCORED" && sleep.score ? sleep : null;
    if (sleep && !sleepScored) flagUnscored("sleep", sleep.score_state, date);

    const strain = cycle?.score_state === "SCORED" && cycle.score ? cycle.score.strain : null;
    if (cycle && strain === null) flagUnscored("strain", cycle.score_state, date);
    const inProgress = cycle !== undefined && (cycle.end ?? null) === null;
    if (inProgress && strain !== null) flag("in_progress", date);

    days.push({
      date,
      recovery_score: recoveryScore?.recovery_score ?? null,
      recovery_zone: recoveryScore ? recoveryZone(recoveryScore.recovery_score) : null,
      recovery_calibrating: recoveryScore ? recoveryScore.user_calibrating : null,
      sleep_hours: sleepScored ? round1(asleepHours(sleepScored)) : null,
      sleep_performance_pct: sleepScored?.score?.sleep_performance_percentage ?? null,
      day_strain: strain,
      day_strain_in_progress: inProgress,
    });
  }

  // --- Averages over days that have data -------------------------------------------

  const recoveryValues = days.map((d) => d.recovery_score).filter(isNumber);
  const sleepValues = days.map((d) => d.sleep_hours).filter(isNumber);
  const strainValues = days
    .filter((d) => !d.day_strain_in_progress)
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

  const partlyLoaded = !recoveries.available || !sleeps.available || !cycles.available;
  const loadedCaveat = partlyLoaded ? " Some data could not be loaded; see warnings." : "";
  if (emptyDays.length === gridLength) {
    notes.push(`No WHOOP data for any day in this range; all values are null.${loadedCaveat}`);
  } else if (emptyDays.length > 0) {
    const firstDataDay = days
      .filter((d) => !emptyDays.includes(d.date))
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

  const completedStrainDays = days.filter((d) => !d.day_strain_in_progress).length;
  const coverage = [
    { name: "recovery", stream: recoveries, count: recoveryValues.length, of: gridLength },
    { name: "sleep", stream: sleeps, count: sleepValues.length, of: gridLength },
    { name: "strain", stream: cycles, count: strainValues.length, of: completedStrainDays },
  ].filter((column) => column.stream.available);
  if (emptyDays.length < gridLength && coverage.some((column) => column.count < column.of)) {
    const fewest = Math.min(...coverage.map((column) => column.count));
    const prefix =
      fewest < MIN_RELIABLE_DAYS
        ? "Not enough data yet for reliable averages"
        : "Averages use only days with data";
    const parts = coverage.map(
      (column) =>
        `${column.name} ${column.count} of ${column.of}${column.name === "strain" && completedStrainDays < gridLength ? " completed" : ""} days`
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
    notes,
    warnings,
  };
}
