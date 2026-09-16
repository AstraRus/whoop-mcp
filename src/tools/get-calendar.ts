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
import { parseUtcOffset } from "./date-utils.js";
import { resolveUserUtcOffsetInfo, withOffsetNote } from "./collection-utils.js";
import { asleepHours, cycleDay, localDay, recoveryZone } from "./analytics-utils.js";
import {
  addDays,
  cycleStrain,
  daysBetween,
  isOpenCycle as isOpen,
  localClock,
  placeDays,
  resolveDayWindow,
} from "./day-model.js";

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

/** The UTC instant of local midnight at the start of `day` */
function localMidnightUtc(day: string, offsetMinutes: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) - offsetMinutes * 60_000).toISOString();
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return round1(values.reduce((a, b) => a + b, 0) / values.length);
}

function isNumber(value: number | null): value is number {
  return value !== null;
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
  const { offset: utcOffset, fallback: offsetFallback } = await resolveUserUtcOffsetInfo(client);
  const offsetMinutes = parseUtcOffset(utcOffset);
  const today = localDay(now.toISOString(), utcOffset);
  const warnings: string[] = [];

  // Grid days are the user's local calendar days.
  const window = resolveDayWindow(params, now, utcOffset, {
    defaultDays: DEFAULT_DAYS,
    maxDays: MAX_DAYS,
  });
  const { firstDay: gridStart, lastDay: gridEnd, ascending } = window;
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

  // --- Place records on local days (shared day model) ---------------------------

  const placement = placeDays({
    cycles: cycles.records,
    sleeps: sleeps.records,
    recoveries: recoveries.records,
    sleepsAvailable: sleeps.available,
    today,
    utcOffset,
  });
  const { byDay, cycleByDay, openCycleDay, partialDays: partialStrainDays } = placement;
  for (const { day, shown, other: cycle } of placement.displaced) {
    if (day < gridStart || day > gridEnd) continue;
    const strain = cycleStrain(cycle);
    const strainText =
      strain === null ? "" : ` (strain ${round1(strain)}${isOpen(cycle) ? " so far" : ""})`;
    warnings.push(
      `Two WHOOP cycles belong to ${day} (for example, a second main sleep ended that day). ` +
        `The row shows the cycle that started ${localClock(shown.start, shown.timezone_offset)}; ` +
        `the cycle that started ${localClock(cycle.start, cycle.timezone_offset)}${strainText} is left out of the grid and its averages.`
    );
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
