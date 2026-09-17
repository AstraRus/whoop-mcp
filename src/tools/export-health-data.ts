/**
 * Tool: export_health_data
 *
 * Exports up to 180 local days as CSV text or JSON rows, in three datasets:
 * - daily: one row per local day, placed exactly as get_calendar and get_day
 *   place records (cycle and strain, recovery, main sleep, nap and workout
 *   counts); a day without WHOOP records has only date and utc_offset.
 * - workouts: one row per workout on the day of the cycle containing its start.
 * - sleeps: one row per main sleep (and nap, with include_naps) by wake day.
 *
 * Records are read as history over fetchRangeForDays(first, last), so the
 * first day's cycle (starting the evening before) and workouts after local
 * midnight of the last day are included. A failed stream leaves its columns
 * empty with a warning. The datasets are capped at EXPORT_MAX_CHARS characters
 * of JSON: the newest days are kept, the oldest days are dropped together with
 * their workouts and sleeps, and a note gives the range still to export.
 *
 * CSV follows RFC 4180 with a formula guard (see csv.ts). Unknown values are
 * empty cells (null in JSON), never 0.
 */

import { z } from "zod";
import type { Recovery, Sleep } from "../api/types.js";
import { createHistoryBudget, HISTORY_DEADLINE_MS } from "../api/history.js";
import {
  DISCLAIMER,
  dataQualitySchema,
  formatLocalTimestamp,
  HOUR_MS,
  localDay,
} from "./analytics-utils.js";
import { resolveUserUtcOffsetInfo, withOffsetNote } from "./collection-utils.js";
import { toCsv, type CsvCell } from "./csv.js";
import { InvalidDateExpression, resolveDateExpression } from "./date-utils.js";
import {
  addDays,
  cycleStrain,
  daysBetween,
  fetchRangeForDays,
  isOpenCycle,
  localClock,
  resolveDayWindow,
} from "./day-model.js";
import {
  buildDataQuality,
  DAY_PLACEMENT_LIMITATIONS,
  DAY_SOURCE_LABELS,
  DAY_SOURCE_NAMES,
  finishSourceQuality,
  historyTruncated,
  isRecoveryHeldBack,
  isUsableSource,
  loadDaySources,
  napsForDay,
  noCycleYetNote,
  placeHistory,
  scoredOf,
  sourceProblemWarnings,
  summarizeWorkouts,
  unscoredReason,
  workoutsOnDay,
  type DaySourceName,
  type PlacedHistory,
  type PlacedSummary,
} from "./get-day.js";
import { needBreakdown, stageBreakdown, whoopConsistency } from "./sleep-metrics.js";
import { roundTo } from "./stats-utils.js";
import { defineTool, type ToolContext } from "./tool-definition.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Largest JSON.stringify(datasets) length an export returns. */
export const EXPORT_MAX_CHARS = 60_000;

/** Most local days one export covers. */
export const EXPORT_MAX_DAYS = 180;

/** Days exported without start (ending today). */
export const EXPORT_DEFAULT_DAYS = 30;

/** Method version reported in data_quality. */
export const EXPORT_METHOD_VERSION = "export-1";

/** The datasets an export can contain, in output order. */
export const EXPORT_DATASETS = ["daily", "workouts", "sleeps"] as const;

/** An export dataset name. */
export type ExportDatasetName = (typeof EXPORT_DATASETS)[number];

/** Datasets exported without `datasets`. */
export const EXPORT_DEFAULT_DATASETS: readonly ExportDatasetName[] = ["daily", "workouts"];

/** Columns of the daily dataset. */
export const DAILY_COLUMNS = [
  "date",
  "utc_offset",
  "cycle_id",
  "cycle_start_local",
  "cycle_end_local",
  "cycle_hours",
  "day_strain",
  "day_strain_in_progress",
  "day_strain_partial",
  "energy_kj",
  "avg_hr_bpm",
  "max_hr_bpm",
  "recovery_score",
  "recovery_calibrating",
  "hrv_rmssd_ms",
  "resting_hr_bpm",
  "spo2_pct",
  "skin_temp_c",
  "sleep_id",
  "sleep_start_local",
  "sleep_end_local",
  "sleep_score_state",
  "time_in_bed_h",
  "asleep_h",
  "awake_h",
  "light_h",
  "slow_wave_h",
  "rem_h",
  "disturbances",
  "sleep_cycles",
  "respiratory_rate",
  "sleep_performance_pct",
  "sleep_efficiency_pct",
  "sleep_consistency_pct",
  "sleep_need_total_h",
  "nap_count",
  "workout_count",
] as const;

/** Columns of the workouts dataset. */
export const WORKOUT_COLUMNS = [
  "workout_id",
  "day",
  "start_local",
  "end_local",
  "duration_min",
  "sport_name",
  "sport_id",
  "score_state",
  "strain",
  "avg_hr_bpm",
  "max_hr_bpm",
  "energy_kj",
  "recorded_pct",
  "distance_km",
  "altitude_gain_m",
  "altitude_change_m",
  "zone0_min",
  "zone1_min",
  "zone2_min",
  "zone3_min",
  "zone4_min",
  "zone5_min",
  "trimp",
] as const;

/** Columns of the sleeps dataset. */
export const SLEEP_COLUMNS = [
  "sleep_id",
  "wake_day",
  "nap",
  "start_local",
  "end_local",
  "score_state",
  "in_bed_min",
  "asleep_min",
  "awake_min",
  "light_min",
  "slow_wave_min",
  "rem_min",
  "no_data_min",
  "disturbances",
  "sleep_cycles",
  "efficiency_pct",
  "performance_pct",
  "consistency_pct",
  "respiratory_rate",
  "need_baseline_h",
  "need_from_sleep_debt_h",
  "need_from_recent_strain_h",
  "need_from_recent_nap_h",
  "need_total_h",
] as const;

type DailyRow = Record<(typeof DAILY_COLUMNS)[number], CsvCell>;
type WorkoutRow = Record<(typeof WORKOUT_COLUMNS)[number], CsvCell>;
type SleepRow = Record<(typeof SLEEP_COLUMNS)[number], CsvCell>;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const exportHealthDataInputSchema = z.object({
  start: z
    .string()
    .max(100)
    .optional()
    .describe(
      "Range start or range expression; default the last 30 local days including today. A day (YYYY-MM-DD, 'yesterday') or date-time exports from that day through end (default today); a range expression ('last week', 'this month', '2026-08', 'last 60 days') covers that range."
    ),
  end: z
    .string()
    .max(100)
    .optional()
    .describe(
      "Last local day to export (YYYY-MM-DD, 'yesterday', or a range expression's last day); later days are clamped to today."
    ),
  datasets: z
    .array(z.enum(EXPORT_DATASETS))
    .min(1)
    .max(3)
    .optional()
    .describe("Datasets to export: daily, workouts, sleeps. Default daily and workouts."),
  format: z
    .enum(["csv", "json"])
    .optional()
    .describe("csv (default): one CSV text per dataset. json: rows as objects."),
  include_naps: z
    .boolean()
    .optional()
    .describe("Add naps as rows of the sleeps dataset (nap true). Default false."),
});

const cellSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const datasetSchema = z.object({
  columns: z.array(z.string()),
  row_count: z.number().int().nonnegative(),
  csv: z.string().optional().describe("RFC 4180 CSV text with a header row (format csv)"),
  rows: z.array(z.record(z.string(), cellSchema)).optional().describe("Rows (format json)"),
});

export const exportHealthDataOutputSchema = z.object({
  period: z.object({
    start: z.string(),
    end: z.string(),
    utc_offset: z.string(),
    days: z.number().int().nonnegative(),
  }),
  format: z.enum(["csv", "json"]),
  datasets: z.object({
    daily: datasetSchema.optional(),
    workouts: datasetSchema.optional(),
    sleeps: datasetSchema.optional(),
  }),
  first_included_day: z
    .string()
    .nullable()
    .describe("Oldest day in the datasets; later than period.start when output_capped"),
  output_capped: z.boolean(),
  truncated: z.boolean(),
  notes: z.array(z.string()),
  warnings: z.array(z.string()),
  data_quality: dataQualitySchema,
  disclaimer: z.string(),
});

export type ExportHealthDataInput = z.infer<typeof exportHealthDataInputSchema>;
export type ExportHealthDataResult = z.infer<typeof exportHealthDataOutputSchema>;
type Dataset = z.infer<typeof datasetSchema>;

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

/** The local days an export covers. */
export interface ExportWindow {
  firstDay: string;
  lastDay: string;
  days: number;
  notes: string[];
}

/**
 * The export's first and last local day.
 * - No start: the EXPORT_DEFAULT_DAYS days ending at end (default today).
 * - start a range expression: that range; a day or date-time (at its nearest
 *   local midnight, as get_calendar reads it): from that day.
 * - end: the last day of its expression; without end, a range expression's
 *   last day, else today. The last day is clamped to today.
 *
 * @throws InvalidDateExpression for unparseable values, a start after today,
 *   an end before the start, or more than EXPORT_MAX_DAYS days
 */
export function resolveExportWindow(
  params: { start?: string; end?: string },
  now: Date,
  utcOffset: string
): ExportWindow {
  const today = localDay(now.toISOString(), utcOffset);
  const notes: string[] = [];

  let endDay: string | undefined;
  if (params.end !== undefined) {
    const resolved = resolveDateExpression(params.end, now, utcOffset);
    endDay = localDay(resolved.end, utcOffset);
    if (endDay > today) {
      notes.push(`The end ${endDay} is after today, so the export ends today (${today}).`);
      endDay = today;
    }
  }

  let firstDay: string;
  let lastDay: string;
  if (params.start === undefined) {
    lastDay = endDay ?? today;
    firstDay = addDays(lastDay, -(EXPORT_DEFAULT_DAYS - 1));
  } else {
    const window = resolveDayWindow({ start: params.start }, now, utcOffset, {
      defaultDays: 1,
      maxDays: Number.MAX_SAFE_INTEGER,
      noun: "export",
    });
    firstDay = window.firstDay;
    if (window.fromDateTime) {
      notes.push(`The start date-time counts from its nearest local midnight (${firstDay}).`);
    }
    if (firstDay > today) {
      throw new InvalidDateExpression(
        `The start ${firstDay} is after today (${today}); there are no days to export.`
      );
    }
    lastDay = endDay ?? (window.lastDay > firstDay ? window.lastDay : today);
  }

  if (lastDay < firstDay) {
    throw new InvalidDateExpression(
      `The end (${lastDay}) is before the start (${firstDay}). Swap them or widen the range.`
    );
  }
  const days = daysBetween(firstDay, lastDay) + 1;
  if (days > EXPORT_MAX_DAYS) {
    throw new InvalidDateExpression(
      `${firstDay} to ${lastDay} covers ${days} days; export_health_data exports at most ${EXPORT_MAX_DAYS} days per call. Split the range into parts of up to ${EXPORT_MAX_DAYS} days, e.g. start ${firstDay} with end ${addDays(firstDay, EXPORT_MAX_DAYS - 1)}, then start ${addDays(firstDay, EXPORT_MAX_DAYS)}.`
    );
  }
  return { firstDay, lastDay, days, notes };
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function stamp(timestamp: string, offset: string): string {
  return formatLocalTimestamp(Date.parse(timestamp), offset);
}

/** Records used and left out for data_quality, keyed by record identity. */
interface QualityCollector {
  used: Map<string, { updated_at: string }>;
  exclusions: Map<string, string>;
}

function newCollectors(): Record<DaySourceName, QualityCollector> {
  const collector = (): QualityCollector => ({ used: new Map(), exclusions: new Map() });
  return {
    cycle: collector(),
    sleep: collector(),
    recovery: collector(),
    workout: collector(),
  };
}

/** Everything one local day contributes to the export. */
interface DayBundle {
  day: string;
  daily: DailyRow | null;
  workouts: WorkoutRow[];
  sleeps: SleepRow[];
  /** Record identity → record / exclusion reason, per source */
  quality: Record<DaySourceName, QualityCollector>;
  observed: number[];
  flags: {
    empty: boolean;
    noCycleYet: boolean;
    calibrating: boolean;
    heldBack: boolean;
    inProgress: boolean;
    partial: boolean;
    consistencyZeroCalibrating: boolean;
    pending: Array<"recovery" | "sleep" | "strain">;
    unscorable: Array<"recovery" | "sleep" | "strain">;
    fallbackWorkouts: number;
    afterMidnightWorkouts: number;
    invalidWorkouts: number;
    unscoredWorkouts: number;
    lowRecordingWorkouts: number;
    unscoredSleepRows: number;
  };
}

interface RowContext {
  history: PlacedHistory;
  utcOffset: string;
  today: string;
  nowMs: number;
  datasets: ReadonlySet<ExportDatasetName>;
  /** Main sleeps (and naps with include_naps) by local wake day, ordered by start */
  sleepsByWakeDay: Map<string, Sleep[]>;
  sleepById: Map<string, Sleep>;
}

function noteUsed(
  collector: QualityCollector,
  key: string,
  record: { updated_at: string; score_state: Sleep["score_state"] },
  scored: boolean
): void {
  if (scored) {
    collector.used.set(key, record);
    collector.exclusions.delete(key);
    return;
  }
  if (collector.used.has(key)) return;
  const reason = unscoredReason(record.score_state);
  if (reason !== null) collector.exclusions.set(key, reason);
}

function dailyRow(
  context: RowContext,
  day: string,
  bundle: DayBundle,
  summaries: readonly PlacedSummary[]
): DailyRow {
  const { history, utcOffset, nowMs } = context;
  const { placement } = history;
  const { cycle, sleep, recovery } = placement.byDay.get(day) ?? {};
  const sleepsUsable = isUsableSource(history.sources.sleep);
  const naps = sleepsUsable ? napsForDay(history, day, cycle) : [];
  const worn =
    cycle !== undefined ||
    sleep !== undefined ||
    recovery !== undefined ||
    naps.length > 0 ||
    summaries.length > 0 ||
    bundle.flags.invalidWorkouts > 0;
  const flags = bundle.flags;
  flags.empty = !worn;
  flags.noCycleYet =
    !worn &&
    placement.openCycleDay !== undefined &&
    placement.openCycleDay < day &&
    day <= context.today;

  // Cycle
  const cycleScore = cycle ? scoredOf(cycle) : null;
  if (cycle) {
    noteUsed(bundle.quality.cycle, String(cycle.id), cycle, cycleScore !== null);
    bundle.observed.push(
      Date.parse(cycle.start),
      isOpenCycle(cycle) ? nowMs : Date.parse(cycle.end!)
    );
    if (!cycleScore) {
      if (cycle.score_state === "PENDING_SCORE") flags.pending.push("strain");
      else if (cycle.score_state === "UNSCORABLE") flags.unscorable.push("strain");
    }
    flags.inProgress = isOpenCycle(cycle) && cycleScore !== null;
    flags.partial = placement.partialDays.has(day) && cycleScore !== null;
  }
  const cycleEndMs = cycle?.end ? Date.parse(cycle.end) : null;

  // Recovery (held back while its sleep is still being scored, as in get_day)
  let recoveryScore = recovery ? scoredOf(recovery) : null;
  if (recovery) {
    const heldBack = isRecoveryHeldBack(recovery, context.sleepById.get(recovery.sleep_id));
    if (heldBack) {
      recoveryScore = null;
      flags.heldBack = true;
      bundle.quality.recovery.exclusions.set(`${recovery.cycle_id}`, "held_back");
    } else {
      noteUsed(bundle.quality.recovery, `${recovery.cycle_id}`, recovery, recoveryScore !== null);
      if (!recoveryScore) {
        if (recovery.score_state === "PENDING_SCORE") flags.pending.push("recovery");
        else if (recovery.score_state === "UNSCORABLE") flags.unscorable.push("recovery");
      }
    }
    if (recoveryScore?.user_calibrating === true) flags.calibrating = true;
  }

  // Main sleep
  const sleepScore = sleep ? scoredOf(sleep) : null;
  const stages = sleep && sleepScore ? stageBreakdown(sleep) : null;
  const need = sleep && sleepScore ? needBreakdown(sleep) : null;
  let consistency: number | null = null;
  if (sleep) {
    noteUsed(bundle.quality.sleep, sleep.id, sleep, sleepScore !== null);
    bundle.observed.push(Date.parse(sleep.start), Date.parse(sleep.end));
    if (!sleepScore) {
      if (sleep.score_state === "PENDING_SCORE") flags.pending.push("sleep");
      else if (sleep.score_state === "UNSCORABLE") flags.unscorable.push("sleep");
    } else {
      const linked = recovery && recovery.sleep_id === sleep.id ? recovery : null;
      const result = whoopConsistency(sleep, linked);
      consistency = result.value;
      if (result.reason === "zero_during_calibration") flags.consistencyZeroCalibrating = true;
    }
  }
  for (const nap of naps) {
    noteUsed(bundle.quality.sleep, nap.id, nap, scoredOf(nap) !== null);
    bundle.observed.push(Date.parse(nap.start), Date.parse(nap.end));
  }

  const hours = (minutes: number | undefined): number | null =>
    minutes === undefined ? null : roundTo(minutes / 60, 2);
  const workoutsUsable = history.workouts !== null;
  return {
    date: day,
    utc_offset: cycle?.timezone_offset ?? sleep?.timezone_offset ?? utcOffset,
    cycle_id: cycle?.id ?? null,
    cycle_start_local: cycle ? stamp(cycle.start, cycle.timezone_offset) : null,
    cycle_end_local: cycle?.end ? stamp(cycle.end, cycle.timezone_offset) : null,
    cycle_hours: cycle
      ? roundTo(Math.max(0, (cycleEndMs ?? nowMs) - Date.parse(cycle.start)) / HOUR_MS, 2)
      : null,
    day_strain: cycle ? roundTo(cycleStrain(cycle), 2) : null,
    day_strain_in_progress: cycle ? isOpenCycle(cycle) : null,
    day_strain_partial: cycle ? placement.partialDays.has(day) : null,
    energy_kj: roundTo(cycleScore?.kilojoule ?? null, 0),
    avg_hr_bpm: roundTo(cycleScore?.average_heart_rate ?? null, 0),
    max_hr_bpm: roundTo(cycleScore?.max_heart_rate ?? null, 0),
    recovery_score: roundTo(recoveryScore?.recovery_score ?? null, 1),
    recovery_calibrating: recoveryScore ? recoveryScore.user_calibrating : null,
    hrv_rmssd_ms: roundTo(recoveryScore?.hrv_rmssd_milli ?? null, 1),
    resting_hr_bpm: roundTo(recoveryScore?.resting_heart_rate ?? null, 0),
    spo2_pct: roundTo(recoveryScore?.spo2_percentage ?? null, 1),
    skin_temp_c: roundTo(recoveryScore?.skin_temp_celsius ?? null, 2),
    sleep_id: sleep?.id ?? null,
    sleep_start_local: sleep ? stamp(sleep.start, sleep.timezone_offset) : null,
    sleep_end_local: sleep ? stamp(sleep.end, sleep.timezone_offset) : null,
    sleep_score_state: sleep?.score_state ?? null,
    time_in_bed_h: hours(stages?.in_bed_min),
    asleep_h: hours(stages?.asleep_min),
    awake_h: hours(stages?.awake_min),
    light_h: hours(stages?.light_min),
    slow_wave_h: hours(stages?.sws_min),
    rem_h: hours(stages?.rem_min),
    disturbances: stages ? stages.disturbances : null,
    sleep_cycles: stages ? stages.sleep_cycles : null,
    respiratory_rate: roundTo(sleepScore?.respiratory_rate ?? null, 1),
    sleep_performance_pct: roundTo(sleepScore?.sleep_performance_percentage ?? null, 1),
    sleep_efficiency_pct: roundTo(sleepScore?.sleep_efficiency_percentage ?? null, 1),
    sleep_consistency_pct: roundTo(consistency, 1),
    sleep_need_total_h: roundTo(need?.total_including_debt ?? null, 2),
    nap_count: sleepsUsable && worn ? naps.length : null,
    workout_count: workoutsUsable && worn ? summaries.length : null,
  };
}

function workoutRow({ summary, placement }: PlacedSummary): WorkoutRow {
  const zones = summary.zone_minutes;
  const minutes = (value: number | undefined): number | null =>
    value === undefined ? null : roundTo(value, 1);
  return {
    workout_id: summary.id,
    day: placement.day,
    start_local: summary.start_local,
    end_local: summary.end_local,
    duration_min: roundTo(summary.duration_minutes, 1),
    sport_name: summary.sport_name,
    sport_id: summary.sport_id,
    score_state: summary.score_state,
    strain: roundTo(summary.strain, 2),
    avg_hr_bpm: roundTo(summary.average_heart_rate, 0),
    max_hr_bpm: roundTo(summary.max_heart_rate, 0),
    energy_kj: roundTo(summary.kilojoule, 0),
    recorded_pct:
      summary.recorded_fraction === null ? null : roundTo(summary.recorded_fraction * 100, 1),
    distance_km: roundTo(summary.gps?.distance_km ?? null, 2),
    altitude_gain_m: roundTo(summary.gps?.altitude_gain_m ?? null, 0),
    altitude_change_m: roundTo(summary.gps?.altitude_change_m ?? null, 0),
    zone0_min: minutes(zones?.zone_0),
    zone1_min: minutes(zones?.zone_1),
    zone2_min: minutes(zones?.zone_2),
    zone3_min: minutes(zones?.zone_3),
    zone4_min: minutes(zones?.zone_4),
    zone5_min: minutes(zones?.zone_5),
    trimp: roundTo(summary.trimp, 1),
  };
}

function sleepRow(sleep: Sleep, day: string, recovery: Recovery | null): SleepRow {
  const score = scoredOf(sleep);
  const stages = score ? stageBreakdown(sleep) : null;
  const need = score ? needBreakdown(sleep) : null;
  const consistency = score ? whoopConsistency(sleep, recovery).value : null;
  const minutes = (value: number | undefined): number | null =>
    value === undefined ? null : roundTo(value, 1);
  return {
    sleep_id: sleep.id,
    wake_day: day,
    nap: sleep.nap,
    start_local: stamp(sleep.start, sleep.timezone_offset),
    end_local: stamp(sleep.end, sleep.timezone_offset),
    score_state: sleep.score_state,
    in_bed_min: minutes(stages?.in_bed_min),
    asleep_min: minutes(stages?.asleep_min),
    awake_min: minutes(stages?.awake_min),
    light_min: minutes(stages?.light_min),
    slow_wave_min: minutes(stages?.sws_min),
    rem_min: minutes(stages?.rem_min),
    no_data_min: minutes(stages?.no_data_min),
    disturbances: stages ? stages.disturbances : null,
    sleep_cycles: stages ? stages.sleep_cycles : null,
    efficiency_pct: roundTo(score?.sleep_efficiency_percentage ?? null, 1),
    performance_pct: roundTo(score?.sleep_performance_percentage ?? null, 1),
    consistency_pct: roundTo(consistency, 1),
    respiratory_rate: roundTo(score?.respiratory_rate ?? null, 1),
    need_baseline_h: roundTo(need?.baseline ?? null, 2),
    need_from_sleep_debt_h: roundTo(need?.debt ?? null, 2),
    need_from_recent_strain_h: roundTo(need?.strain ?? null, 2),
    need_from_recent_nap_h: roundTo(need?.nap ?? null, 2),
    need_total_h: roundTo(need?.total_including_debt ?? null, 2),
  };
}

function buildBundle(context: RowContext, day: string): DayBundle {
  const { history, datasets } = context;
  const bundle: DayBundle = {
    day,
    daily: null,
    workouts: [],
    sleeps: [],
    quality: newCollectors(),
    observed: [],
    flags: {
      empty: false,
      noCycleYet: false,
      calibrating: false,
      heldBack: false,
      inProgress: false,
      partial: false,
      consistencyZeroCalibrating: false,
      pending: [],
      unscorable: [],
      fallbackWorkouts: 0,
      afterMidnightWorkouts: 0,
      invalidWorkouts: 0,
      unscoredWorkouts: 0,
      lowRecordingWorkouts: 0,
      unscoredSleepRows: 0,
    },
  };

  const items = workoutsOnDay(history, day);
  const { summaries, invalid } = summarizeWorkouts(items);
  if (datasets.has("daily") || datasets.has("workouts")) {
    bundle.flags.invalidWorkouts = invalid;
    const validIds = new Set(summaries.map(({ workout }) => workout.id));
    for (const { workout } of items) {
      if (!validIds.has(workout.id)) {
        bundle.quality.workout.exclusions.set(workout.id, "invalid_duration");
      }
    }
    for (const { workout, summary } of summaries) {
      noteUsed(bundle.quality.workout, workout.id, workout, summary.strain !== null);
      bundle.observed.push(Date.parse(workout.start), Date.parse(workout.end));
      if (summary.flags.includes("day_by_fallback")) bundle.flags.fallbackWorkouts += 1;
      if (summary.flags.includes("after_midnight_in_previous_cycle")) {
        bundle.flags.afterMidnightWorkouts += 1;
      }
      if (summary.flags.includes("not_scored")) bundle.flags.unscoredWorkouts += 1;
      if (summary.flags.includes("low_recording")) bundle.flags.lowRecordingWorkouts += 1;
    }
  }
  if (datasets.has("daily")) bundle.daily = dailyRow(context, day, bundle, summaries);
  if (datasets.has("workouts")) bundle.workouts = summaries.map(workoutRow);
  if (datasets.has("sleeps")) {
    for (const sleep of context.sleepsByWakeDay.get(day) ?? []) {
      const candidate = history.placement.recoveryByCycle.get(sleep.cycle_id);
      const recovery = candidate && candidate.sleep_id === sleep.id ? candidate : null;
      const row = sleepRow(sleep, day, recovery);
      if (
        scoredOf(sleep) !== null &&
        whoopConsistency(sleep, recovery).reason === "zero_during_calibration"
      ) {
        bundle.flags.consistencyZeroCalibrating = true;
      }
      bundle.sleeps.push(row);
      if (scoredOf(sleep) === null) bundle.flags.unscoredSleepRows += 1;
      noteUsed(bundle.quality.sleep, sleep.id, sleep, scoredOf(sleep) !== null);
      bundle.observed.push(Date.parse(sleep.start), Date.parse(sleep.end));
    }
  }
  return bundle;
}

// ---------------------------------------------------------------------------
// Rendering and cap
// ---------------------------------------------------------------------------

function renderDataset<C extends string>(
  columns: readonly C[],
  rows: ReadonlyArray<Record<C, CsvCell>>,
  format: "csv" | "json"
): Dataset {
  if (format === "csv") {
    return {
      columns: [...columns],
      row_count: rows.length,
      csv: toCsv(
        columns,
        rows.map((row) => columns.map((column) => row[column]))
      ),
    };
  }
  return { columns: [...columns], row_count: rows.length, rows: [...rows] };
}

function renderDatasets(
  bundles: readonly DayBundle[],
  datasets: ReadonlySet<ExportDatasetName>,
  format: "csv" | "json"
): ExportHealthDataResult["datasets"] {
  const result: ExportHealthDataResult["datasets"] = {};
  if (datasets.has("daily")) {
    const rows = bundles.flatMap((bundle) => (bundle.daily ? [bundle.daily] : []));
    result.daily = renderDataset(DAILY_COLUMNS, rows, format);
  }
  if (datasets.has("workouts")) {
    result.workouts = renderDataset(
      WORKOUT_COLUMNS,
      bundles.flatMap((bundle) => bundle.workouts),
      format
    );
  }
  if (datasets.has("sleeps")) {
    result.sleeps = renderDataset(
      SLEEP_COLUMNS,
      bundles.flatMap((bundle) => bundle.sleeps),
      format
    );
  }
  return result;
}

/**
 * The newest days whose datasets fit within `maxChars` of JSON: the number of
 * days kept (from the end of `bundles`) and their rendered datasets.
 */
export function capBundles(
  bundleCount: number,
  render: (keep: number) => ExportHealthDataResult["datasets"],
  maxChars: number
): { keep: number; datasets: ExportHealthDataResult["datasets"] } {
  const fits = (keep: number): ExportHealthDataResult["datasets"] | null => {
    const datasets = render(keep);
    return JSON.stringify(datasets).length <= maxChars ? datasets : null;
  };
  const all = fits(bundleCount);
  if (all !== null) return { keep: bundleCount, datasets: all };
  let low = 0;
  let high = bundleCount - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle) !== null) low = middle;
    else high = middle - 1;
  }
  return { keep: low, datasets: render(low) };
}

/** "2026-09-14, 2026-09-15" for up to 6 days, else "12 days from 2026-08-01 to 2026-09-15". */
function describeDays(days: readonly string[]): string {
  const sorted = [...days].sort();
  if (sorted.length <= 6) return sorted.join(", ");
  return `${sorted.length} days from ${sorted[0]} to ${sorted[sorted.length - 1]}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Export local days as CSV or JSON datasets.
 *
 * @throws InvalidDateExpression for invalid input; the most relevant WHOOP
 *   error when every source fails
 */
export async function exportHealthData(
  args: ExportHealthDataInput,
  ctx: ToolContext
): Promise<ExportHealthDataResult> {
  const { offset: utcOffset, fallback: offsetFallback } = await resolveUserUtcOffsetInfo(
    ctx.client
  );
  const now = ctx.now();
  const nowMs = now.getTime();
  const today = localDay(now.toISOString(), utcOffset);
  const window = resolveExportWindow({ start: args.start, end: args.end }, now, utcOffset);
  const { firstDay, lastDay } = window;
  const format = args.format ?? "csv";
  const datasets = new Set<ExportDatasetName>(args.datasets ?? EXPORT_DEFAULT_DATASETS);
  const includeNaps = args.include_naps === true;

  const range = fetchRangeForDays(firstDay, lastDay, utcOffset, nowMs);
  const budget = createHistoryBudget({ deadlineMs: ctx.startedAtMs + HISTORY_DEADLINE_MS });
  const needsDaily = datasets.has("daily");
  const sources = await loadDaySources(ctx, range, budget, {
    cycle: true,
    sleep: true,
    recovery: needsDaily || datasets.has("sleeps"),
    workout: needsDaily || datasets.has("workouts"),
  });
  const history = placeHistory(sources, today, utcOffset);

  const sleepsByWakeDay = new Map<string, Sleep[]>();
  let invalidSleeps = 0;
  for (const sleep of history.sleeps) {
    if (sleep.nap && !includeNaps) continue;
    if (!(Date.parse(sleep.end) > Date.parse(sleep.start))) {
      const wake = localDay(sleep.end, sleep.timezone_offset);
      if (datasets.has("sleeps") && wake >= firstDay && wake <= lastDay) invalidSleeps += 1;
      continue;
    }
    const wake = localDay(sleep.end, sleep.timezone_offset);
    const list = sleepsByWakeDay.get(wake) ?? [];
    list.push(sleep);
    sleepsByWakeDay.set(wake, list);
  }
  for (const list of sleepsByWakeDay.values()) {
    list.sort(
      (left, right) =>
        Date.parse(left.start) - Date.parse(right.start) ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    );
  }

  const context: RowContext = {
    history,
    utcOffset,
    today,
    nowMs,
    datasets,
    sleepsByWakeDay,
    sleepById: new Map(history.sleeps.map((sleep) => [sleep.id, sleep])),
  };
  const bundles: DayBundle[] = [];
  for (let index = 0; index < window.days; index++) {
    bundles.push(buildBundle(context, addDays(firstDay, index)));
  }

  // --- Cap: keep the newest days that fit ----------------------------------------
  const { keep, datasets: rendered } = capBundles(
    bundles.length,
    (count) => renderDatasets(bundles.slice(bundles.length - count), datasets, format),
    EXPORT_MAX_CHARS
  );
  const included = bundles.slice(bundles.length - keep);
  const firstIncludedDay = included[0]?.day ?? null;
  const outputCapped = keep < bundles.length;

  // --- Notes and warnings (included days) -------------------------------------------
  const notes: string[] = [...window.notes];
  const warnings: string[] = [];

  if (outputCapped) {
    notes.push(
      firstIncludedDay === null
        ? `Not even the last day fits within the ${EXPORT_MAX_CHARS}-character export limit (output_capped: true); request fewer datasets.`
        : `The export reached its ${EXPORT_MAX_CHARS}-character limit, so it covers ${firstIncludedDay} to ${lastDay} (first_included_day; ${keep} of ${bundles.length} days, output_capped: true). ` +
            `For the ${bundles.length - keep} earlier days, request start ${firstDay} with end ${addDays(firstIncludedDay, -1)}.` +
            (format === "json" && datasets.size > 1
              ? " Format csv and fewer datasets fit more days per call."
              : format === "json"
                ? " Format csv fits more days per call."
                : datasets.size > 1
                  ? " Fewer datasets fit more days per call."
                  : "")
    );
  }
  if (datasets.has("daily")) {
    const firstWornDay = included.some((bundle) => bundle.daily?.day_strain_partial === true);
    notes.push(
      "energy_kj, avg_hr_bpm and max_hr_bpm cover the whole WHOOP cycle (sleep onset to next sleep onset" +
        (firstWornDay
          ? "; on the first day of wear, day_strain_partial true, from local midnight to the next sleep onset"
          : "") +
        "), not a calendar day; asleep_h is light + slow-wave + REM of the main sleep, without naps."
    );
  }
  notes.push(
    "Local timestamps (*_local) are wall-clock times in each record's own UTC offset. Empty cells (null in JSON) are unknown or not applicable, never 0."
  );
  if (
    included.some((bundle) => bundle.workouts.length > 0) ||
    included.some((bundle) => (bundle.daily?.workout_count ?? 0) !== 0)
  ) {
    notes.push(
      "Day strain is WHOOP's non-linear 0-21 score and is not the sum of workout strains; each workout counts toward the day of the WHOOP cycle containing its start."
    );
  }
  if (datasets.has("sleeps")) {
    notes.push(
      "In the sleeps dataset need_from_recent_nap_h is 0 or negative (a recent nap lowers the need), and need_total_h includes the sleep-debt component." +
        (includeNaps ? " Naps are separate rows (nap true)." : "")
    );
  }

  const daysWhere = (predicate: (bundle: DayBundle) => boolean): string[] =>
    included.filter(predicate).map((bundle) => bundle.day);
  const calibrating = daysWhere((bundle) => bundle.flags.calibrating);
  if (calibrating.length > 0) {
    notes.push(
      `WHOOP is still calibrating: recovery for ${describeDays(calibrating)} is provisional (recovery_calibrating: true).`
    );
  }
  const heldBack = daysWhere((bundle) => bundle.flags.heldBack);
  if (heldBack.length > 0) {
    notes.push(
      `Recovery for ${describeDays(heldBack)} is held back until WHOOP finishes scoring the sleep; its cells are empty.`
    );
  }
  for (const [column, label] of [
    ["recovery", "Recovery"],
    ["sleep", "Sleep"],
    ["strain", "Strain"],
  ] as const) {
    const pending = daysWhere((bundle) => bundle.flags.pending.includes(column));
    if (pending.length > 0) {
      notes.push(
        `${label} for ${describeDays(pending)} is still being scored by WHOOP; its cells are empty.`
      );
    }
    const unscorable = daysWhere((bundle) => bundle.flags.unscorable.includes(column));
    if (unscorable.length > 0) {
      notes.push(
        `WHOOP could not score ${column} for ${describeDays(unscorable)}; its cells are empty.`
      );
    }
  }
  const consistencyZero = daysWhere((bundle) => bundle.flags.consistencyZeroCalibrating);
  if (consistencyZero.length > 0) {
    notes.push(
      `WHOOP reports sleep consistency as 0 while calibrating, so the consistency cells are empty for ${describeDays(consistencyZero)}.`
    );
  }
  const inProgress = daysWhere((bundle) => bundle.flags.inProgress);
  if (inProgress.length > 0) {
    notes.push(
      `Strain for ${describeDays(inProgress)} is still accumulating (day_strain_in_progress: true).`
    );
  }
  const partial = daysWhere((bundle) => bundle.flags.partial);
  if (partial.length > 0) {
    notes.push(
      `Strain for ${describeDays(partial)} covers only part of the day (WHOOP was first worn partway through it; day_strain_partial: true).`
    );
  }
  const afterMidnight = included.reduce(
    (sum, bundle) => sum + bundle.flags.afterMidnightWorkouts,
    0
  );
  if (afterMidnight > 0) {
    notes.push(
      `${afterMidnight} workout(s) started after local midnight but before the next sleep, so they count toward the previous day (the day column), as in get_day and get_calendar.`
    );
  }
  const total = (count: (bundle: DayBundle) => number): number =>
    included.reduce((sum, bundle) => sum + count(bundle), 0);
  const unscoredWorkouts = total((bundle) => bundle.flags.unscoredWorkouts);
  if (unscoredWorkouts > 0) {
    notes.push(
      `${unscoredWorkouts} workout(s) are not scored yet or could not be scored (score_state); their score cells are empty.`
    );
  }
  const lowRecording = total((bundle) => bundle.flags.lowRecordingWorkouts);
  if (lowRecording > 0) {
    notes.push(
      `${lowRecording} workout(s) recorded heart rate for less than 90% of their duration (recorded_pct); their zone minutes and TRIMP cover only the recorded part.`
    );
  }
  const unscoredSleepRows = total((bundle) => bundle.flags.unscoredSleepRows);
  if (unscoredSleepRows > 0) {
    notes.push(
      `${unscoredSleepRows} row(s) of the sleeps dataset are not scored yet or could not be scored (score_state); their stage and need cells are empty.`
    );
  }
  if (datasets.has("daily")) {
    const noCycleYet = daysWhere((bundle) => bundle.flags.noCycleYet);
    const empty = daysWhere((bundle) => bundle.flags.empty && !bundle.flags.noCycleYet);
    if (noCycleYet.length > 0) {
      const note = noCycleYetNote(
        noCycleYet.length === 1 ? noCycleYet[0]! : describeDays(noCycleYet),
        noCycleYet.length === 1 ? today : "",
        history.placement
      );
      if (note !== null) notes.push(note);
    }
    if (empty.length > 0) {
      const partlyLoaded = DAY_SOURCE_NAMES.some(
        (name) => sources[name] !== null && !isUsableSource(sources[name])
      );
      notes.push(
        `No WHOOP records for ${describeDays(empty)}; those rows have only date and utc_offset.` +
          (partlyLoaded ? " Some data could not be loaded; see warnings." : "")
      );
    }
  }

  // Source problems
  const daily = datasets.has("daily");
  const listParts = (parts: Array<string | false>): string =>
    parts.filter((part): part is string => part !== false).join(", ");
  sourceProblemWarnings(
    "cycle",
    sources.cycle,
    listParts([
      daily && "the cycle and strain columns are empty",
      "workouts are placed on their local start day",
    ]),
    warnings
  );
  sourceProblemWarnings(
    "sleep",
    sources.sleep,
    listParts([
      daily && "the sleep columns and nap_count are empty",
      datasets.has("sleeps") && "the sleeps dataset has no rows",
      "cycles are placed on the local day 12 hours after their start",
    ]),
    warnings
  );
  sourceProblemWarnings("recovery", sources.recovery, "the recovery columns are empty", warnings);
  sourceProblemWarnings(
    "workout",
    sources.workout,
    listParts([
      daily && "workout_count is empty",
      datasets.has("workouts") && "the workouts dataset has no rows",
    ]),
    warnings
  );
  for (const name of DAY_SOURCE_NAMES) {
    const source = sources[name];
    if (source === null || !isUsableSource(source) || !source.quality.truncated) continue;
    const since = source.complete_since;
    const firstReliable = since === null ? null : addDays(localDay(since, utcOffset), 1);
    if (
      firstReliable !== null &&
      (firstIncludedDay === null || firstReliable <= firstIncludedDay)
    ) {
      continue;
    }
    const label = DAY_SOURCE_LABELS[name];
    warnings.push(
      firstReliable === null
        ? `${label} history for this period could not be read completely in this call (request budget, time limit or a failed page), so any row may lack ${label.toLowerCase()} records. Repeating the request continues from the cache.`
        : `${label} history before ${firstReliable} could not be read completely in this call (request budget, time limit or a failed page), so rows before ${firstReliable} may lack ${label.toLowerCase()} records. Repeating the request continues from the cache.`
    );
  }
  warnings.push(...sources.warnings);
  for (const displaced of history.placement.displaced) {
    if (firstIncludedDay === null || displaced.day < firstIncludedDay || displaced.day > lastDay) {
      continue;
    }
    const strain = cycleStrain(displaced.other);
    warnings.push(
      `Two WHOOP cycles belong to ${displaced.day} (for example, a second main sleep ended that day). ` +
        `The daily row shows the cycle that started ${localClock(displaced.shown.start, displaced.shown.timezone_offset)}; ` +
        `the cycle that started ${localClock(displaced.other.start, displaced.other.timezone_offset)}` +
        (strain === null ? "" : ` (strain ${roundTo(strain, 1)})`) +
        " is not in the daily rows, and its workouts count toward that day."
    );
  }
  const fallback = included.reduce((sum, bundle) => sum + bundle.flags.fallbackWorkouts, 0);
  if (fallback > 0) {
    warnings.push(
      `${fallback} workout(s) are not inside a loaded WHOOP cycle and were placed on their local start day.`
    );
  }
  const invalidWorkouts = included.reduce((sum, bundle) => sum + bundle.flags.invalidWorkouts, 0);
  if (invalidWorkouts > 0) {
    warnings.push(`${invalidWorkouts} workout(s) end at or before their start and were skipped.`);
  }
  if (invalidSleeps > 0) {
    warnings.push(`${invalidSleeps} sleep(s) end at or before their start and were skipped.`);
  }

  // --- Data quality (included days) ------------------------------------------------
  const qualities: ExportHealthDataResult["data_quality"]["sources"] = {};
  for (const name of DAY_SOURCE_NAMES) {
    const used = new Map<string, { updated_at: string }>();
    const exclusions = new Map<string, string>();
    for (const bundle of included) {
      for (const [key, record] of bundle.quality[name].used) used.set(key, record);
      for (const [key, reason] of bundle.quality[name].exclusions) {
        if (!used.has(key)) exclusions.set(key, reason);
      }
    }
    for (const key of used.keys()) exclusions.delete(key);
    const quality = finishSourceQuality(
      sources[name],
      [...used.values()],
      [...exclusions.values()]
    );
    if (quality !== null) qualities[name] = quality;
  }
  const usedRecoveries = included.flatMap((bundle) => [
    ...(bundle.quality.recovery.used.values() as IterableIterator<Recovery>),
  ]);
  if (
    qualities.recovery?.status === "available" &&
    usedRecoveries.length > 0 &&
    usedRecoveries.every((recovery) => recovery.score?.user_calibrating === true)
  ) {
    qualities.recovery.status = "calibrating";
  }

  return {
    period: { start: firstDay, end: lastDay, utc_offset: utcOffset, days: window.days },
    format,
    datasets: rendered,
    first_included_day: firstIncludedDay,
    output_capped: outputCapped,
    truncated: historyTruncated(sources),
    notes: withOffsetNote(notes, offsetFallback),
    warnings,
    data_quality: buildDataQuality({
      firstDay,
      lastDay,
      utcOffset,
      nowMs,
      observed: included.flatMap((bundle) => bundle.observed),
      sources: qualities,
      methodVersion: EXPORT_METHOD_VERSION,
      limitations: [
        ...DAY_PLACEMENT_LIMITATIONS,
        `Exports cover at most ${EXPORT_MAX_DAYS} days and ${EXPORT_MAX_CHARS} characters of datasets per call; the oldest days are left out first.`,
        "CSV text cells starting with =, +, -, @, tab or carriage return get a leading apostrophe (UTC offsets such as +02:00 excepted) so spreadsheet programs do not evaluate them.",
      ],
    }),
    disclaimer: DISCLAIMER,
  };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const EXPORT_HEALTH_DATA_TOOL = defineTool({
  name: "export_health_data",
  annotations: { readOnlyHint: true },
  standard: {
    title: "Export health data",
    description:
      "Export up to 180 local days of WHOOP data as CSV (default) or JSON rows. Datasets: daily (one row per local day, placed as get_calendar and get_day place them: cycle, strain, energy, recovery, HRV, resting HR, SpO2, skin temperature, main sleep stages, performance, efficiency, consistency, sleep need, nap and workout counts), workouts (one row per workout on the day of the WHOOP cycle containing its start: duration, sport, strain, heart rate, energy, recorded %, GPS distance and altitude, zone minutes, TRIMP) and sleeps (main sleeps by wake day, optionally naps). Default: daily and workouts for the last 30 days. start takes a day, a date-time or a range expression; end clamps to today. Energy covers whole WHOOP cycles (sleep onset to sleep onset). Unknown values are empty cells. Output is capped at 60,000 characters: the newest days are kept, first_included_day and a note give the range still to export.",
    inputSchema: exportHealthDataInputSchema,
    outputSchema: exportHealthDataOutputSchema,
    run: exportHealthData,
  },
});
