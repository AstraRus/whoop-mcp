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
 *   sleeps by the local day they end, recoveries through their cycle. A day
 *   belongs to a period when the period contains that day's midnight in the
 *   user's current offset, so records keep their own local day across DST and
 *   travel.
 * - Sleep hours are time asleep (light + slow-wave + REM) on main sleeps.
 * - Strain uses completed cycles; the cycle still in progress is left out.
 * - A metric with fewer than MIN_SAMPLES_PER_PERIOD samples in either period
 *   keeps the averages that exist but gets change_pct null and direction
 *   "insufficient_data", with a note that says why.
 * - A ±5% change counts as "unchanged".
 */

import type { z } from "zod";
import type { WhoopClient } from "../api/client.js";
import { WhoopApiError, WhoopAuthError, WhoopNetworkError } from "../api/client.js";
import { ABSOLUTE_MAX_RECORDS, fetchAllPages } from "../api/pagination.js";
import { ENDPOINT_CYCLE, ENDPOINT_RECOVERY, ENDPOINT_SLEEP } from "../api/endpoints.js";
import {
  cycleRecordSchema,
  recoveryRecordSchema,
  sleepRecordSchema,
} from "../api/record-schemas.js";
import type { Cycle, Recovery, Sleep } from "../api/types.js";
import { InvalidDateExpression, parseUtcOffset, resolveDateExpression } from "./date-utils.js";
import { resolveUserUtcOffset } from "./collection-utils.js";
import {
  asleepHours,
  cycleDay,
  DAY_MS,
  localDay,
  mainSleeps,
  sourceQuality,
} from "./analytics-utils.js";
import { mean } from "./stats-utils.js";

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
  return {
    key,
    label,
    startMs,
    endMs,
    summary: {
      start: formatInstant(startMs, utcOffset),
      end: formatInstant(inclusiveEndMs, utcOffset),
      days: round(days, 2),
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
  const query = new URLSearchParams({
    start: new Date(period.startMs - FETCH_MARGIN_MS).toISOString(),
    end: new Date(period.endMs + FETCH_MARGIN_MS).toISOString(),
    limit: String(PAGE_SIZE),
  });
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

/** Fetch recovery, sleep and cycle data for one period (serialized) */
async function loadPeriod(client: WhoopClient, period: ResolvedPeriod): Promise<PeriodLoad> {
  const recovery = await loadSource<Recovery>(
    client,
    ENDPOINT_RECOVERY,
    period,
    recoveryRecordSchema
  );
  const sleep = await loadSource<Sleep>(client, ENDPOINT_SLEEP, period, sleepRecordSchema);
  const cycle = await loadSource<Cycle>(client, ENDPOINT_CYCLE, period, cycleRecordSchema);
  return { recovery, sleep, cycle };
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
}

/**
 * Whether a local calendar day (taken in the record's own offset) belongs to
 * the period: the period contains that day's midnight in the user's offset,
 * the offset the period was resolved in.
 */
function containsDay(period: ResolvedPeriod, day: string, utcOffset: string): boolean {
  const midnight = Date.parse(`${day}T00:00:00.000Z`) - parseUtcOffset(utcOffset) * 60_000;
  return midnight >= period.startMs && midnight < period.endMs;
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

/** Attribute the fetched records to the period and extract metric samples */
function collectSamples(
  period: ResolvedPeriod,
  load: PeriodLoad,
  utcOffset: string
): PeriodSamples {
  const cycles = new Map(load.cycle.records.map((cycle) => [cycle.id, cycle]));
  const sleeps = new Map(load.sleep.records.map((sleep) => [sleep.id, sleep]));

  const strain: number[] = [];
  let inProgressCycles = 0;
  for (const cycle of cycles.values()) {
    if (!containsDay(period, cycleDay(cycle), utcOffset)) continue;
    if (cycle.end === null || cycle.end === undefined) {
      inProgressCycles += 1;
      continue;
    }
    if (cycle.score_state === "SCORED" && cycle.score) strain.push(cycle.score.strain);
  }

  const fetchWindow = {
    start: new Date(period.startMs - FETCH_MARGIN_MS).toISOString(),
    end: new Date(period.endMs + FETCH_MARGIN_MS).toISOString(),
  };
  const sleepHours = mainSleeps(load.sleep.records, fetchWindow, sourceQuality())
    .filter((sleep) => containsDay(period, localDay(sleep.end, sleep.timezone_offset), utcOffset))
    .map(asleepHours);

  const recovery: number[] = [];
  let calibrating = 0;
  const seenCycles = new Set<number>();
  for (const record of load.recovery.records) {
    if (record.score_state !== "SCORED" || !record.score) continue;
    const day = recoveryDay(record, cycles, sleeps, utcOffset);
    if (!containsDay(period, day, utcOffset) || seenCycles.has(record.cycle_id)) continue;
    seenCycles.add(record.cycle_id);
    recovery.push(record.score.recovery_score);
    if (record.score.user_calibrating) calibrating += 1;
  }

  return { recovery, calibrating, sleepHours, strain, inProgressCycles };
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
  calibrating: boolean
): string {
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
  now: Date = new Date()
): Promise<PeriodComparison> {
  const utcOffset = await resolveUserUtcOffset(client);
  const periodA = resolvePeriod("a", params.period_a_start, params.period_a_end, now, utcOffset);
  const periodB = resolvePeriod("b", params.period_b_start, params.period_b_end, now, utcOffset);

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

  const samplesA = collectSamples(periodA, loadA, utcOffset);
  const samplesB = collectSamples(periodB, loadB, utcOffset);

  const recovery = compareSamples(samplesA.recovery, samplesB.recovery, 1);
  const sleep = compareSamples(samplesA.sleepHours, samplesB.sleepHours, 2);
  const strain = compareSamples(samplesA.strain, samplesB.strain, 1);

  const calibrating = samplesA.calibrating + samplesB.calibrating > 0;
  const warnings = [...loadWarnings(periodA, loadA), ...loadWarnings(periodB, loadB)];
  const notes: string[] = [];

  if (recovery.change === "insufficient") {
    notes.push(
      insufficientNote(
        "recovery",
        ["scored recovery", "scored recoveries"],
        samplesA.recovery.length,
        samplesB.recovery.length,
        calibrating
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
        calibrating
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
        calibrating
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
  }

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
    truncated: sources.some((source) => source.truncated),
    notes,
    warnings,
  };
}
