/**
 * Tool: get_trend
 *
 * Analyzes a single health metric over the last N local calendar days:
 * chronological values with their local dates, summary statistics, a
 * per-day linear-regression trend, and anomaly detection.
 *
 * Supported metrics: recovery, hrv, rhr, sleep_duration, sleep_performance, strain.
 *
 * Sparse data (a new or still-calibrating WHOOP user) is a normal state, not
 * an error: statistics are null without data points, and the trend,
 * confidence and anomalies are withheld below MIN_TREND_POINTS, with the
 * reason in `notes`.
 */

import type { WhoopClient } from "../api/client.js";
import { fetchAllPages, ABSOLUTE_MAX_RECORDS } from "../api/pagination.js";
import { ENDPOINT_RECOVERY, ENDPOINT_SLEEP, ENDPOINT_CYCLE } from "../api/endpoints.js";
import {
  cycleRecordSchema,
  recoveryRecordSchema,
  sleepRecordSchema,
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
import { parseUtcOffset } from "./date-utils.js";
import {
  mean,
  median,
  standardDeviation,
  linearRegressionXY,
  trendDirection,
  detectAnomalies,
  isConstant,
  MIN_TREND_POINTS,
} from "./stats-utils.js";
import type { TrendDirectionResult } from "./stats-utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Supported metric names */
export type TrendMetric =
  | "recovery"
  | "hrv"
  | "rhr"
  | "sleep_duration"
  | "sleep_performance"
  | "strain";

/** Input parameters for get_trend */
export interface GetTrendParams {
  metric: TrendMetric;
  days?: number;
}

/** Confidence level based on R² and the number of data points */
export type TrendConfidence = "high" | "medium" | "low";

/** Raw numeric direction of a trend, independent of whether it is good or bad */
export type TrendChange = "increasing" | "decreasing" | "stable";

/** Which direction is better for a metric; null when neither is (strain) */
export type BetterWhen = "higher" | "lower" | null;

/** A detected anomaly with its local date */
export interface TrendAnomaly {
  date: string;
  value: number;
  deviation_from_mean: number;
}

/** Output shape for get_trend */
export interface TrendAnalysis {
  metric: string;
  period: { start: string; end: string; days: number };
  status: "available" | "insufficient_data";
  sample_size: number;
  /** Whether any recovery used is still calibrating; null for non-recovery metrics */
  calibrating: boolean | null;
  truncated: boolean;
  /** Oldest first */
  values: number[];
  /** Local calendar day (YYYY-MM-DD) of each value, in lockstep with values */
  dates: string[];
  statistics: {
    mean: number | null;
    median: number | null;
    std_dev: number | null;
    min: number | null;
    max: number | null;
  };
  trend: {
    direction: TrendDirectionResult | null;
    change: TrendChange | null;
    better_when: BetterWhen;
    /** Change per day */
    slope: number | null;
    confidence: TrendConfidence | null;
  };
  anomalies: TrendAnomaly[];
  notes: string[];
}

/** One value placed on the user's local calendar */
interface Observation {
  day: string;
  /** Instant used to order observations chronologically */
  anchor: number;
  value: number;
  calibrating: boolean;
}

interface LoadedObservations {
  observations: Observation[];
  /** Records in the window that had no value for the metric (e.g. a scored night without a performance score) */
  skipped: number;
  truncated: boolean;
  notes: string[];
}

interface TrendWindow {
  firstDay: string;
  lastDay: string;
  /** Query range sent to WHOOP (starts a day early to catch records spanning the edge) */
  query: { start: string; end: string };
  offset: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_DAYS = 30;

/** Fewer points than this cap confidence at "low" */
const LOW_CONFIDENCE_BELOW = 7;

/** Fewer points than this cap confidence at "medium" */
const MEDIUM_CONFIDENCE_BELOW = 14;

const MAX_PAGES = 20;

interface MetricDefinition {
  betterWhen: BetterWhen;
  /** Values come from recoveries, which carry WHOOP's calibration flag */
  recoveryBased: boolean;
  /** Singular and plural name of one source record (e.g. a scored night) */
  unit: [string, string];
  /** Singular and plural name of a record that has a value, when not every record has one */
  valueUnit?: [string, string];
  load: (client: WhoopClient, window: TrendWindow) => Promise<LoadedObservations>;
}

// ---------------------------------------------------------------------------
// Local-day helpers
// ---------------------------------------------------------------------------

function addDays(day: string, count: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + count * DAY_MS).toISOString().slice(0, 10);
}

function localMidnightMs(day: string, offset: string): number {
  return Date.parse(`${day}T00:00:00.000Z`) - parseUtcOffset(offset) * 60_000;
}

/** ISO 8601 timestamp written in the user's offset, so its date part is the local date */
function formatLocal(ms: number, offset: string): string {
  const wallClock = new Date(ms + parseUtcOffset(offset) * 60_000).toISOString().slice(0, 23);
  return `${wallClock}${offset === "Z" ? "Z" : offset}`;
}

function daysBetween(fromDay: string, toDay: string): number {
  return (Date.parse(`${toDay}T00:00:00.000Z`) - Date.parse(`${fromDay}T00:00:00.000Z`)) / DAY_MS;
}

function inWindow(day: string, window: TrendWindow): boolean {
  return day >= window.firstDay && day <= window.lastDay;
}

function plural(count: number, unit: [string, string]): string {
  return `${count} ${count === 1 ? unit[0] : unit[1]}`;
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

async function fetchWindow(
  client: WhoopClient,
  endpoint: string,
  window: TrendWindow
): Promise<{ records: unknown[]; truncated: boolean }> {
  const params = new URLSearchParams();
  params.set("start", window.query.start);
  params.set("end", window.query.end);
  params.set("limit", "25");
  return fetchAllPages<unknown>(client, `${endpoint}?${params.toString()}`, {
    maxRecords: ABSOLUTE_MAX_RECORDS,
    maxPages: MAX_PAGES,
    interPageDelayMs: 0,
  });
}

function invalidNote(count: number, source: string): string[] {
  return count
    ? [`${count} ${source} record(s) did not match the expected WHOOP format and were skipped.`]
    : [];
}

// ---------------------------------------------------------------------------
// Metric loaders
// ---------------------------------------------------------------------------

function recoveryLoader(
  field: "recovery_score" | "hrv_rmssd_milli" | "resting_heart_rate"
): MetricDefinition["load"] {
  return async (client, window) => {
    const page = await fetchWindow(client, ENDPOINT_RECOVERY, window);
    const quality = sourceQuality(page.records.length, page.truncated);
    const scored = parseRecords(page.records, recoveryRecordSchema, quality).filter(
      (record) => record.score_state === "SCORED" && record.score
    );
    const notes = invalidNote(quality.exclusions.invalid ?? 0, "recovery");

    // A recovery belongs to the day of its cycle (joined via cycle_id); its
    // created_at can lag when the strap syncs late.
    const cycleStarts = new Map<number, { day: string; anchor: number }>();
    if (scored.length) {
      try {
        const cyclePage = await fetchWindow(client, ENDPOINT_CYCLE, window);
        for (const cycle of parseRecords(cyclePage.records, cycleRecordSchema, sourceQuality())) {
          cycleStarts.set(cycle.id, { day: cycleDay(cycle), anchor: Date.parse(cycle.start) });
        }
      } catch {
        notes.push(
          "Cycle data could not be loaded, so each recovery is dated by when WHOOP recorded it."
        );
      }
    }

    const observations: Observation[] = [];
    for (const record of scored) {
      const placement = cycleStarts.get(record.cycle_id) ?? {
        day: localDay(record.created_at, window.offset),
        anchor: Date.parse(record.created_at),
      };
      if (!inWindow(placement.day, window)) continue;
      observations.push({
        ...placement,
        value: record.score![field],
        calibrating: record.score!.user_calibrating,
      });
    }
    return { observations, skipped: 0, truncated: page.truncated, notes };
  };
}

function sleepLoader(
  extract: (sleep: Parameters<typeof asleepHours>[0]) => number | null | undefined,
  missingNote: (count: number) => string
): MetricDefinition["load"] {
  return async (client, window) => {
    const page = await fetchWindow(client, ENDPOINT_SLEEP, window);
    const quality = sourceQuality(page.records.length, page.truncated);
    const sleeps = parseRecords(page.records, sleepRecordSchema, quality).filter((sleep) =>
      inWindow(localDay(sleep.end, sleep.timezone_offset), window)
    );
    // Main (non-nap) scored sleeps, one per local wake-up day. Membership was
    // decided by local day above, so the period only has to contain every candidate.
    const nights = mainSleeps(
      sleeps,
      {
        start: new Date(Date.parse(window.query.start) - DAY_MS).toISOString(),
        end: new Date(Date.parse(window.query.end) + DAY_MS).toISOString(),
      },
      quality
    );
    const observations: Observation[] = [];
    let missing = 0;
    for (const night of nights) {
      const value = extract(night);
      if (typeof value !== "number" || !Number.isFinite(value)) {
        missing++;
        continue;
      }
      observations.push({
        day: localDay(night.end, night.timezone_offset),
        anchor: Date.parse(night.end),
        value,
        calibrating: false,
      });
    }
    const notes = invalidNote(quality.exclusions.invalid ?? 0, "sleep");
    if (missing) notes.push(missingNote(missing));
    return { observations, skipped: missing, truncated: page.truncated, notes };
  };
}

async function loadStrain(client: WhoopClient, window: TrendWindow): Promise<LoadedObservations> {
  const page = await fetchWindow(client, ENDPOINT_CYCLE, window);
  const quality = sourceQuality(page.records.length, page.truncated);
  const cycles = parseRecords(page.records, cycleRecordSchema, quality).filter((cycle) =>
    inWindow(cycleDay(cycle), window)
  );
  const notes = invalidNote(quality.exclusions.invalid ?? 0, "cycle");
  if (cycles.some((cycle) => cycle.end == null)) {
    notes.push("Today's strain is still accumulating and is not included.");
  }
  const observations = cycles
    .filter((cycle) => cycle.end != null && cycle.score_state === "SCORED" && cycle.score)
    .map((cycle) => ({
      day: cycleDay(cycle),
      anchor: Date.parse(cycle.start),
      value: cycle.score!.strain,
      calibrating: false,
    }));
  return { observations, skipped: 0, truncated: page.truncated, notes };
}

const METRICS: Record<TrendMetric, MetricDefinition> = {
  recovery: {
    betterWhen: "higher",
    recoveryBased: true,
    unit: ["scored recovery", "scored recoveries"],
    load: recoveryLoader("recovery_score"),
  },
  hrv: {
    betterWhen: "higher",
    recoveryBased: true,
    unit: ["scored recovery", "scored recoveries"],
    load: recoveryLoader("hrv_rmssd_milli"),
  },
  rhr: {
    betterWhen: "lower",
    recoveryBased: true,
    unit: ["scored recovery", "scored recoveries"],
    load: recoveryLoader("resting_heart_rate"),
  },
  sleep_duration: {
    betterWhen: "higher",
    recoveryBased: false,
    unit: ["scored night", "scored nights"],
    load: sleepLoader(asleepHours, (count) => `${count} night(s) had no sleep duration.`),
  },
  sleep_performance: {
    betterWhen: "higher",
    recoveryBased: false,
    unit: ["scored night", "scored nights"],
    valueUnit: ["night with a sleep performance score", "nights with a sleep performance score"],
    load: sleepLoader(
      (sleep) => sleep.score?.sleep_performance_percentage,
      (count) => `${count} scored night(s) had no sleep performance score and were skipped.`
    ),
  },
  strain: {
    betterWhen: null,
    recoveryBased: false,
    unit: ["completed cycle", "completed cycles"],
    load: loadStrain,
  },
};

// ---------------------------------------------------------------------------
// Trend classification
// ---------------------------------------------------------------------------

/**
 * Classify R² into a confidence level, capped by how many points there are.
 * Identical values have no variance for R² to explain (it is reported as 0),
 * yet a flat line fits them exactly, so they are rated on sample size alone.
 */
function trendConfidence(r2: number, sampleSize: number, constant: boolean): TrendConfidence {
  if (sampleSize < LOW_CONFIDENCE_BELOW) return "low";
  const fit = constant ? 1 : r2;
  const fromFit: TrendConfidence = fit > 0.7 ? "high" : fit > 0.4 ? "medium" : "low";
  if (sampleSize < MEDIUM_CONFIDENCE_BELOW && fromFit === "high") return "medium";
  return fromFit;
}

function toChange(direction: TrendDirectionResult): TrendChange {
  if (direction === "improving") return "increasing";
  if (direction === "declining") return "decreasing";
  return "stable";
}

/** Whether a numeric change is an improvement for a metric */
function interpretChange(change: TrendChange, betterWhen: BetterWhen): TrendDirectionResult | null {
  if (betterWhen === null) return null;
  if (change === "stable") return "stable";
  return (change === "increasing") === (betterWhen === "higher") ? "improving" : "declining";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Analyze a health metric trend over the last `days` local calendar days
 * (today included).
 *
 * Values are ordered oldest first before any regression. Never throws for
 * sparse data; WHOOP API failures on the metric's own endpoint still throw.
 */
export async function getTrend(
  client: WhoopClient,
  params: GetTrendParams,
  now: Date = new Date()
): Promise<TrendAnalysis> {
  const days = params.days ?? DEFAULT_DAYS;
  const definition = METRICS[params.metric];
  const { offset, fallback: offsetFallback } = await resolveUserUtcOffsetInfo(client);
  const lastDay = localDay(now.toISOString(), offset);
  const firstDay = addDays(lastDay, -(days - 1));
  const windowStartMs = localMidnightMs(firstDay, offset);
  const window: TrendWindow = {
    firstDay,
    lastDay,
    offset,
    query: { start: new Date(windowStartMs - DAY_MS).toISOString(), end: now.toISOString() },
  };

  const loaded = await definition.load(client, window);
  const observations = [...loaded.observations].sort((left, right) => left.anchor - right.anchor);
  const values = observations.map((observation) => observation.value);
  const dates = observations.map((observation) => observation.day);
  const sampleSize = values.length;
  const notes = [...loaded.notes];

  const calibratingCount = observations.filter((observation) => observation.calibrating).length;

  const statistics: TrendAnalysis["statistics"] = sampleSize
    ? {
        mean: mean(values),
        median: median(values),
        std_dev: sampleSize >= 2 ? standardDeviation(values) : null,
        min: Math.min(...values),
        max: Math.max(...values),
      }
    : { mean: null, median: null, std_dev: null, min: null, max: null };

  let trend: TrendAnalysis["trend"] = {
    direction: null,
    change: null,
    better_when: definition.betterWhen,
    slope: null,
    confidence: null,
  };
  let anomalies: TrendAnomaly[] = [];

  if (sampleSize >= MIN_TREND_POINTS) {
    const xs = dates.map((day) => daysBetween(dates[0]!, day));
    const regression = linearRegressionXY(xs, values);
    const constant = isConstant(values);
    const change = constant ? "stable" : toChange(trendDirection(regression.slope, regression.r2));
    const confidence = trendConfidence(regression.r2, sampleSize, constant);
    trend = {
      direction: interpretChange(change, definition.betterWhen),
      change,
      better_when: definition.betterWhen,
      slope: regression.slope,
      confidence,
    };
    if (constant) {
      notes.push(
        `All ${sampleSize} values were identical (${values[0]}), so the metric was flat over this period.`
      );
    } else if (change === "stable" && confidence === "low") {
      notes.push(
        "No consistent upward or downward direction was found, so the trend is reported as stable; confidence is low because it rates how well a sloped line fits the values."
      );
    }
    anomalies = detectAnomalies(values, 2).map((anomaly) => ({
      date: dates[anomaly.index]!,
      value: anomaly.value,
      deviation_from_mean: anomaly.deviation,
    }));
  } else {
    // "no scored nights" only when there were none; scored nights without a value are counted apart
    const valueUnit = definition.valueUnit ?? definition.unit;
    const found = sampleSize
      ? plural(sampleSize, valueUnit)
      : `no ${(loaded.skipped ? valueUnit : definition.unit)[1]}`;
    notes.unshift(
      `Not enough data yet: ${found} in the last ${days} days; a trend needs at least ${MIN_TREND_POINTS}.`
    );
  }

  if (calibratingCount) {
    notes.push(
      `WHOOP is still calibrating (${calibratingCount} of ${plural(sampleSize, definition.unit)} flagged), so recovery, HRV and resting heart rate may shift.`
    );
  }
  if (definition.betterWhen === null && sampleSize >= MIN_TREND_POINTS) {
    notes.push("Strain is neither better nor worse when higher, so only trend.change is given.");
  }
  if (loaded.truncated) {
    notes.push(
      "WHOOP returned more records than could be fetched; the oldest days of the window are missing."
    );
  }

  return {
    metric: params.metric,
    period: {
      start: formatLocal(windowStartMs, offset),
      end: formatLocal(now.getTime(), offset),
      days,
    },
    status: sampleSize >= MIN_TREND_POINTS ? "available" : "insufficient_data",
    sample_size: sampleSize,
    calibrating: definition.recoveryBased ? calibratingCount > 0 : null,
    truncated: loaded.truncated,
    values,
    dates,
    statistics,
    trend,
    anomalies,
    notes: withOffsetNote(notes, offsetFallback),
  };
}
