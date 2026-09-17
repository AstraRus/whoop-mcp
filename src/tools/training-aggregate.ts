/**
 * Aggregate privacy variants of get_training_load and get_sport_breakdown.
 *
 * Both read only RELEASED local ISO weeks (aggregate-window: a week is
 * released at Wednesday 00:00 local after it ends) and share one release gate
 * per week ({@link trainingWeekGate}): workout values need a final week
 * (weekFinal: no open cycle or pending record) with at least 3 scored
 * sessions, day strain a final week with at least 3 completed cycles.
 * Unreleased values are null; counts stay visible for final weeks.
 *
 * Days are placed with main sleeps (placeDays), exactly as the other aggregate
 * tools place them (get_weekly_summary, get_trend, compare_periods): a weekly
 * total that placed a cycle or workout in a different week than another tool
 * could be differenced against that tool's total to isolate those records. So
 * every week is withheld when the sleeps of the loaded range could not be read
 * completely.
 *
 * get_sport_breakdown works on 4-week blocks aligned to the epoch Monday.
 * Sports with fewer than 3 sessions are pooled as "other" when the pool has at
 * least 3 sessions (otherwise the overall totals are withheld), and overall
 * and "other" totals need differenceSafe over the sessions in weeks the load
 * variant withholds. On top of those rules every released block total is
 * checked against the weekly totals any aggregate tool releases for the same
 * weeks: a total is withheld while some combination of the released sums
 * equals the sum of fewer than 3 sessions ({@link sumsIsolateFewerThanThree}).
 *
 * Rounding: minutes and TRIMP to 10, kJ and kcal to 100, strain to 0.1, whole
 * percentages and heart rate, km to 1, pace to 10 s; the acute:chronic ratio
 * to 0.05. Derived values (week-over-week change, weekly means and ratio) are
 * computed from the released rounded values, so they add no precision. Notes
 * give counts, never dates of withheld weeks or values.
 */

import { z } from "zod";
import { ENDPOINT_SLEEP } from "../api/endpoints.js";
import { loadHistory, type HistorySource } from "../api/history.js";
import { sleepRecordSchema } from "../api/record-schemas.js";
import type { Sleep } from "../api/types.js";
import {
  AGGREGATE_WEEK_MIN_SAMPLES,
  aggregateEvaluatedAt,
  aggregateSourceCounts,
  differenceSafe,
  lastReleasedBlock,
  lastReleasedWeeks,
  roundStep,
  weekFinal,
  type CountedRecord,
} from "./aggregate-window.js";
import { DISCLAIMER, localDay } from "./analytics-utils.js";
import { resolveUserUtcOffsetInfo, withOffsetNote } from "./collection-utils.js";
import { addDays, fetchRangeForDays, placeDays, type DayPlacement } from "./day-model.js";
import {
  compareNames,
  roundZoneShares,
  sessionTotals,
  sportKey,
  SPORT_MIN_SESSIONS,
  weightedHeartRate,
  zoneShares,
} from "./get-sport-breakdown.js";
import {
  buildSessions,
  buildTrainingDays,
  coveredSinceMs,
  LOAD_METRICS,
  LOAD_UNITS,
  loadTrainingSources,
  percentChange,
  plural,
  sourceUnreadable,
  summarizeWeek,
  throwIfAllFailed,
  trainingHistoryOptions,
  WEEK_CHANGE_MIN_WORN_DAYS,
  type LoadMetric,
  type TrainingDay,
  type TrainingSession,
  type TrainingSources,
  type TrainingWeekTotals,
} from "./get-training-load.js";
import { roundTo } from "./stats-utils.js";
import type { ToolContext, ToolVariant } from "./tool-definition.js";
import type { ZoneMinutes } from "./workout-utils.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Weeks listed without `weeks` */
export const AGGREGATE_LOAD_DEFAULT_WEEKS = 8;

/** Fewest weeks `weeks` accepts */
export const AGGREGATE_LOAD_MIN_WEEKS = 4;

/** Most weeks `weeks` accepts */
export const AGGREGATE_LOAD_MAX_WEEKS = 26;

/** Released weeks the weekly acute:chronic ratio needs (the last week and the 4 before it) */
export const AGGREGATE_ACUTE_CHRONIC_WEEKS = 5;

/** Weeks per sport-breakdown block */
export const BREAKDOWN_BLOCK_WEEKS = 4;

/** Largest block_offset */
export const MAX_BLOCK_OFFSET = 26;

/** Most sports listed in the aggregate breakdown */
export const MAX_AGGREGATE_SPORTS = 40;

/** Rounding steps of released aggregate values */
export const AGGREGATE_STEPS = {
  workout_minutes: 10,
  trimp: 10,
  workout_kj: 100,
  kcal: 100,
  day_strain: 0.1,
  distance_km: 1,
  pace_sec_per_km: 10,
  ratio: 0.05,
} as const;

/** Rounding steps of the weekly mean daily loads */
const MEAN_DAILY_STEPS: Record<LoadMetric, number> = {
  trimp: 1,
  workout_minutes: 1,
  workout_kj: 10,
  day_strain: 0.1,
};

const LOAD_METHOD_VERSION = "training-load-1";
const BREAKDOWN_METHOD_VERSION = "sport-breakdown-1";

// ---------------------------------------------------------------------------
// Release gate (shared)
// ---------------------------------------------------------------------------

/** Which values of one week are released */
export interface TrainingWeekGate {
  /** No open cycle or pending record is placed in the week */
  final: boolean;
  /** Workout values (sessions, minutes, TRIMP, kJ): final and at least 3 scored sessions */
  workouts: boolean;
  /** Day strain: final and at least 3 completed cycles */
  strain: boolean;
}

/** The release gate of one week, shared by both aggregate variants */
export function trainingWeekGate(week: TrainingWeekTotals, final: boolean): TrainingWeekGate {
  return {
    final,
    workouts: final && week.sessions !== null && week.sessions >= AGGREGATE_WEEK_MIN_SAMPLES,
    strain:
      final &&
      week.completed_cycles !== null &&
      week.completed_cycles >= AGGREGATE_WEEK_MIN_SAMPLES,
  };
}

/** Whether the gate releases `metric` */
function gateReleases(gate: TrainingWeekGate, metric: LoadMetric): boolean {
  return metric === "day_strain" ? gate.strain : gate.workouts;
}

// ---------------------------------------------------------------------------
// Differencing check
// ---------------------------------------------------------------------------

const LINEAR_TOLERANCE = 1e-9;

/**
 * True when some linear combination of the released sums `rows` (each the set
 * of session indexes it adds up) equals one session or the sum of two, so a
 * value of fewer than AGGREGATE_WEEK_MIN_SAMPLES sessions could be recovered
 * by differencing. Exact up to floating-point tolerance: the row space is
 * reduced to echelon form, and a pivot row whose free part is zero, a unit
 * vector, or the negation of another pivot row's free part isolates one or two
 * sessions.
 */
export function sumsIsolateFewerThanThree(
  rows: readonly (readonly number[])[],
  sessionCount: number
): boolean {
  // Only sessions in some row can be isolated; the others are left out.
  const columnOf = new Map<number, number>();
  for (const row of rows) {
    for (const index of row) {
      if (index < 0 || index >= sessionCount) {
        throw new RangeError("sumsIsolateFewerThanThree: session index out of range.");
      }
      if (!columnOf.has(index)) columnOf.set(index, columnOf.size);
    }
  }
  const columns = columnOf.size;
  const matrix = rows
    .filter((row) => row.length > 0)
    .map((row) => {
      const values = new Array<number>(columns).fill(0);
      for (const index of row) values[columnOf.get(index)!] = 1;
      return values;
    });
  const pivots: { row: number; column: number }[] = [];
  let rank = 0;
  for (let column = 0; column < columns && rank < matrix.length; column++) {
    let best = rank;
    for (let row = rank + 1; row < matrix.length; row++) {
      if (Math.abs(matrix[row]![column]!) > Math.abs(matrix[best]![column]!)) best = row;
    }
    if (Math.abs(matrix[best]![column]!) <= LINEAR_TOLERANCE) continue;
    [matrix[rank], matrix[best]] = [matrix[best]!, matrix[rank]!];
    const pivotRow = matrix[rank]!;
    const pivot = pivotRow[column]!;
    for (let k = 0; k < columns; k++) pivotRow[k] = pivotRow[k]! / pivot;
    for (let row = 0; row < matrix.length; row++) {
      if (row === rank) continue;
      const factor = matrix[row]![column]!;
      if (Math.abs(factor) <= LINEAR_TOLERANCE) continue;
      const target = matrix[row]!;
      for (let k = 0; k < columns; k++) target[k] = target[k]! - factor * pivotRow[k]!;
    }
    pivots.push({ row: rank, column });
    rank += 1;
  }
  const pivotColumns = new Set(pivots.map((pivot) => pivot.column));
  const freeColumns: number[] = [];
  for (let column = 0; column < columns; column++) {
    if (!pivotColumns.has(column)) freeColumns.push(column);
  }
  const keyOf = (values: readonly number[]): string =>
    values.map((value) => (Math.abs(value) <= 1e-7 ? 0 : Math.round(value * 1e6))).join(",");
  const seen = new Set<string>();
  for (const { row } of pivots) {
    const free = freeColumns.map((column) => matrix[row]![column]!);
    const nonZero = free.filter((value) => Math.abs(value) > 1e-7);
    if (nonZero.length === 0) return true;
    if (nonZero.length === 1 && Math.abs(nonZero[0]! - 1) <= 1e-7) return true;
    if (seen.has(keyOf(free.map((value) => -value)))) return true;
    seen.add(keyOf(free));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Loading released weeks (shared)
// ---------------------------------------------------------------------------

interface ReleasedWeek {
  monday: string;
  totals: TrainingWeekTotals;
  gate: TrainingWeekGate;
}

interface ReleasedTraining {
  sources: TrainingSources;
  sleeps: HistorySource<Sleep>;
  /** Every sleep of the loaded range was read, so days are placed as the other aggregate tools place them */
  sleepsComplete: boolean;
  cyclesAvailable: boolean;
  workoutsAvailable: boolean;
  placement: DayPlacement;
  sessions: TrainingSession[];
  days: TrainingDay[];
  weeks: ReleasedWeek[];
  /** Every day of every week was loaded completely from both sources, and every sleep of the range */
  complete: boolean;
  notes: string[];
}

async function loadReleasedTraining(
  ctx: ToolContext,
  utcOffset: string,
  today: string,
  mondays: readonly string[],
  nowMs: number
): Promise<ReleasedTraining> {
  const firstDay = mondays[0]!;
  const lastDay = addDays(mondays[mondays.length - 1]!, 6);
  const range = fetchRangeForDays(firstDay, lastDay, utcOffset, nowMs);
  const options = trainingHistoryOptions(ctx);
  const [sources, sleeps] = await Promise.all([
    loadTrainingSources(ctx, options, range.startMs, range.endMs),
    loadHistory<Sleep>(
      ctx.client,
      ENDPOINT_SLEEP,
      { start: new Date(range.startMs).toISOString(), end: new Date(range.endMs).toISOString() },
      sleepRecordSchema,
      options
    ),
  ]);
  throwIfAllFailed([sources.cycles, sources.workouts]);
  const cyclesAvailable = !sourceUnreadable(sources.cycles);
  // Without cycles, sessions cannot be placed on their cycle days, so none is used.
  const workoutsAvailable = cyclesAvailable && !sourceUnreadable(sources.workouts);
  const sleepsComplete = !sourceUnreadable(sleeps) && !sleeps.quality.truncated;
  // Main sleeps place each cycle on the day its main sleep ended, as every other
  // aggregate tool does; recoveries do not affect placement.
  const placement = placeDays({
    cycles: cyclesAvailable ? sources.cycles.records : [],
    sleeps: sleepsComplete ? sleeps.records : [],
    recoveries: [],
    sleepsAvailable: sleepsComplete,
    today,
    utcOffset,
  });
  const sessions = workoutsAvailable
    ? buildSessions(sources.workouts.records, placement, sources.cycles.records, {
        ...sources.workouts.quality,
        exclusions: {},
      })
    : [];
  const days = buildTrainingDays({
    firstDay,
    lastDay,
    placement,
    sessions,
    cyclesAvailable,
    cyclesCoveredSince: coveredSinceMs(sources.cycles),
    workoutsAvailable,
    workoutsCoveredSince: coveredSinceMs(sources.workouts),
    utcOffset,
  });
  const records = sessions.map((session) => ({
    day: session.summary.day,
    score_state: session.summary.score_state,
  }));
  const weeks = mondays.map((monday) => {
    const totals = summarizeWeek(monday, days);
    return {
      monday,
      totals,
      gate: trainingWeekGate(totals, sleepsComplete && weekFinal(monday, placement, records)),
    };
  });
  const notes: string[] = [];
  if (cyclesAvailable && !sleepsComplete) {
    notes.push(
      "Sleep data could not be read completely, so days cannot be placed as the other aggregate tools place them and every week is withheld; repeating the request continues loading from the cache."
    );
  }
  if (!cyclesAvailable) {
    notes.push(
      "Cycle data could not be loaded, so worn days, day strain and every workout value are withheld."
    );
  } else if (sourceUnreadable(sources.workouts)) {
    notes.push("Workout data could not be loaded, so sessions and workout values are withheld.");
  }
  const daysCovered = days.every((day) => day.worn !== null && day.workoutsKnown);
  const complete = sleepsComplete && daysCovered;
  if (
    cyclesAvailable &&
    !sourceUnreadable(sources.workouts) &&
    (!daysCovered || sources.cycles.quality.truncated || sources.workouts.quality.truncated)
  ) {
    notes.push(
      "Some history could not be read within this call's request budget, so the weeks it did not cover are withheld; repeating the request continues loading from the cache."
    );
  }
  return {
    sources,
    sleeps,
    sleepsComplete,
    cyclesAvailable,
    workoutsAvailable,
    placement,
    sessions,
    days,
    weeks,
    complete,
    notes,
  };
}

/** Source counts limited to records placed in final released weeks */
function aggregateSources(
  data: ReleasedTraining
): z.infer<typeof trainingAggregateQualitySchema>["sources"] {
  const finalMondays = data.weeks.filter((week) => week.gate.final).map((week) => week.monday);
  const cycleRecords: CountedRecord[] = data.cyclesAvailable
    ? data.sources.cycles.records.map((cycle) => {
        const day = data.placement.dayOfCycle.get(cycle.id) ?? null;
        const placed = day !== null && data.placement.cycleByDay.get(day)?.id === cycle.id;
        return { day, exclusion: placed ? null : "displaced" };
      })
    : [];
  const workoutRecords: CountedRecord[] = data.sessions.map((session) => ({
    day: session.summary.day,
    exclusion: session.scored ? null : session.pending ? "pending" : "unscored",
  }));
  // Main sleeps count on the day of their cycle (they place it there); naps place nothing.
  const sleepRecords: CountedRecord[] = data.sleepsComplete
    ? data.sleeps.records.map((sleep) => ({
        day: data.placement.dayOfCycle.get(sleep.cycle_id) ?? null,
        exclusion: sleep.nap ? "nap" : null,
      }))
    : [];
  return {
    cycles: aggregateSourceCounts(data.sources.cycles.quality, cycleRecords, finalMondays),
    sleeps: aggregateSourceCounts(data.sleeps.quality, sleepRecords, finalMondays),
    workouts: aggregateSourceCounts(data.sources.workouts.quality, workoutRecords, finalMondays),
  };
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const nullableNumber = z.number().nullable();
const count = z.number().int().nonnegative();

/** data_quality in aggregate mode: counts from final released weeks only, evaluated_at as a local date */
export const trainingAggregateQualitySchema = z.object({
  evaluated_at: z.string().describe("The user's local date"),
  requested_period: z.object({ start: z.string(), end: z.string() }),
  sources: z.record(
    z.string(),
    z.object({
      status: z.string(),
      records_fetched: count,
      records_used: count,
      exclusions: z.record(z.string(), count),
      truncated: z.boolean(),
    })
  ),
  method_version: z.string(),
});

export const trainingLoadAggregateInputSchema = z.object({
  load_metric: z
    .enum(LOAD_METRICS)
    .optional()
    .describe(
      "Weekly load for the week-over-week change and the weekly acute:chronic ratio. trimp (default), day_strain (mean day strain of completed cycles), workout_minutes or workout_kj."
    ),
  weeks: z
    .number()
    .int()
    .min(AGGREGATE_LOAD_MIN_WEEKS)
    .max(AGGREGATE_LOAD_MAX_WEEKS)
    .optional()
    .describe("Released local ISO weeks to list, ending at the latest released week (default 8)."),
});

export type TrainingLoadAggregateInput = z.infer<typeof trainingLoadAggregateInputSchema>;

const aggregateWeekSchema = z.object({
  week_start: z.string().describe("Monday of the local ISO week"),
  released: z
    .boolean()
    .describe(
      "The week's load_metric value is shown: the week is final and has at least 3 scored sessions (workout metrics) or 3 completed cycles (day_strain)"
    ),
  worn_days: count.nullable(),
  sessions: count.nullable(),
  active_days: count.nullable(),
  workout_minutes: nullableNumber.describe("Rounded to 10"),
  trimp: nullableNumber.describe("Rounded to 10"),
  workout_kj: nullableNumber.describe("Rounded to 100"),
  mean_day_strain: nullableNumber.describe("Rounded to 0.1"),
  completed_cycles: count.nullable(),
  change_vs_previous_pct: nullableNumber.describe(
    "Whole percent change of the released load from the week before (both released, 5 worn days each)"
  ),
});

export const trainingLoadAggregateOutputSchema = z.object({
  period: z.object({ start_week: z.string(), end_week: z.string(), weeks: count }),
  load_metric: z.enum(LOAD_METRICS),
  load_unit: z.enum(["TRIMP (Edwards)", "strain (0-21)", "minutes", "kJ"]),
  weeks: z.array(aggregateWeekSchema),
  acute_chronic_weekly: z.object({
    last_week_mean_daily_load: nullableNumber.describe(
      "The last released week's load per worn day (day_strain: its mean day strain)"
    ),
    prior_4_weeks_mean_daily_load: nullableNumber,
    ratio: nullableNumber.describe("Rounded to 0.05; needs the last 5 weeks released"),
  }),
  notes: z.array(z.string()),
  disclaimer: z.string(),
  data_quality: trainingAggregateQualitySchema,
});

export type TrainingLoadAggregateOutput = z.infer<typeof trainingLoadAggregateOutputSchema>;

export const sportBreakdownAggregateInputSchema = z.object({
  block_offset: z
    .number()
    .int()
    .min(1)
    .max(MAX_BLOCK_OFFSET)
    .optional()
    .describe(
      "Which released 4-week block: 1 (default) is the latest, 2 the one before, and so on. Blocks are aligned to a fixed Monday grid."
    ),
  sport: z
    .string()
    .max(100)
    .optional()
    .describe("Only this sport: exact WHOOP sport_name, case-insensitive."),
});

export type SportBreakdownAggregateInput = z.infer<typeof sportBreakdownAggregateInputSchema>;

const zonesSchema = z.object({
  zone_0: z.number(),
  zone_1: z.number(),
  zone_2: z.number(),
  zone_3: z.number(),
  zone_4: z.number(),
  zone_5: z.number(),
});

const totalsFields = {
  duration_minutes_total: nullableNumber.describe("Rounded to 10"),
  kilojoule_total: nullableNumber.describe("Rounded to 100"),
  kcal_total: nullableNumber.describe("Rounded to 100"),
  trimp_total: nullableNumber.describe("Sessions with 90% recorded heart-rate data, rounded to 10"),
};

const totalsSchema = z.object(totalsFields);

const aggregateSportSchema = z.object({
  sport_name: z.string(),
  sessions: count,
  active_days: count,
  ...totalsFields,
  zone_share_pct: zonesSchema.nullable().describe("Whole percent of recorded zone minutes"),
  strain_mean: nullableNumber.describe("Rounded to 0.1"),
  heart_rate_weighted_average: nullableNumber,
  gps: z
    .object({
      sessions: count,
      distance_km_total: nullableNumber.describe("Rounded to 1"),
      avg_pace_sec_per_km: nullableNumber.describe("Time-weighted, rounded to 10 s"),
    })
    .nullable()
    .describe("Only with at least 3 GPS sessions"),
});

export const sportBreakdownAggregateOutputSchema = z.object({
  block: z.object({
    start_week: z.string(),
    end_week: z.string(),
    weeks: count,
    block_offset: count,
  }),
  sport_filter: z.string().nullable(),
  status: z.enum(["available", "no_workouts", "withheld", "unavailable"]),
  sports: z.array(aggregateSportSchema).describe("Sports with at least 3 sessions"),
  other: totalsSchema
    .extend({ sports: count, sessions: count })
    .nullable()
    .describe("Sports with fewer than 3 sessions, pooled"),
  overall: totalsSchema.extend({ sessions: count.nullable(), active_days: count.nullable() }),
  output_capped: z.boolean(),
  notes: z.array(z.string()),
  disclaimer: z.string(),
  data_quality: trainingAggregateQualitySchema,
});

export type SportBreakdownAggregateOutput = z.infer<typeof sportBreakdownAggregateOutputSchema>;

// ---------------------------------------------------------------------------
// get_training_load (aggregate)
// ---------------------------------------------------------------------------

/**
 * Run the aggregate variant of get_training_load.
 *
 * @throws the most relevant WHOOP error when both cycles and workouts fail to load
 */
export async function getTrainingLoadAggregate(
  args: TrainingLoadAggregateInput,
  ctx: ToolContext
): Promise<TrainingLoadAggregateOutput> {
  const now = ctx.now();
  const nowMs = now.getTime();
  const { offset: utcOffset, fallback: offsetFallback } = await resolveUserUtcOffsetInfo(
    ctx.client
  );
  const today = localDay(now.toISOString(), utcOffset);
  const metric: LoadMetric = args.load_metric ?? "trimp";
  const weekCount = args.weeks ?? AGGREGATE_LOAD_DEFAULT_WEEKS;
  // One extra week before the list: the first listed week's change needs it.
  const mondays = lastReleasedWeeks(now, utcOffset, weekCount + 1).map((week) => week.monday);
  const data = await loadReleasedTraining(ctx, utcOffset, today, mondays, nowMs);
  const notes: string[] = [...data.notes];

  const rounded = (
    week: ReleasedWeek
  ): {
    minutes: number | null;
    trimp: number | null;
    kj: number | null;
    strain: number | null;
  } => ({
    minutes:
      week.gate.workouts && week.totals.workout_minutes !== null
        ? roundStep(week.totals.workout_minutes, AGGREGATE_STEPS.workout_minutes)
        : null,
    trimp:
      week.gate.workouts && week.totals.trimp !== null
        ? roundStep(week.totals.trimp, AGGREGATE_STEPS.trimp)
        : null,
    kj:
      week.gate.workouts && week.totals.workout_kj !== null
        ? roundStep(week.totals.workout_kj, AGGREGATE_STEPS.workout_kj)
        : null,
    strain:
      week.gate.strain && week.totals.mean_day_strain !== null
        ? roundStep(week.totals.mean_day_strain, AGGREGATE_STEPS.day_strain)
        : null,
  });
  const releasedLoad = (week: ReleasedWeek): number | null => {
    const values = rounded(week);
    switch (metric) {
      case "trimp":
        return values.trimp;
      case "day_strain":
        return values.strain;
      case "workout_minutes":
        return values.minutes;
      case "workout_kj":
        return values.kj;
    }
  };
  const released = (week: ReleasedWeek): boolean =>
    gateReleases(week.gate, metric) && releasedLoad(week) !== null;

  const weeks: TrainingLoadAggregateOutput["weeks"] = [];
  for (let index = 1; index < data.weeks.length; index++) {
    const week = data.weeks[index]!;
    const previous = data.weeks[index - 1]!;
    const values = rounded(week);
    const final = week.gate.final;
    const enoughWorn = (candidate: ReleasedWeek): boolean =>
      candidate.totals.worn_days !== null &&
      candidate.totals.worn_days >= WEEK_CHANGE_MIN_WORN_DAYS;
    const change =
      released(week) && released(previous) && enoughWorn(week) && enoughWorn(previous)
        ? percentChange(releasedLoad(week), releasedLoad(previous))
        : null;
    weeks.push({
      week_start: week.monday,
      released: released(week),
      worn_days: final ? week.totals.worn_days : null,
      sessions: final ? week.totals.sessions : null,
      active_days: final ? week.totals.active_days : null,
      workout_minutes: values.minutes,
      trimp: values.trimp,
      workout_kj: values.kj,
      mean_day_strain: values.strain,
      completed_cycles: final ? week.totals.completed_cycles : null,
      change_vs_previous_pct: roundTo(change, 0),
    });
  }

  // --- Weekly acute:chronic ----------------------------------------------------------

  const lastFive = data.weeks.slice(-AGGREGATE_ACUTE_CHRONIC_WEEKS);
  const lastWeek = lastFive[lastFive.length - 1]!;
  const priorWeeks = lastFive.slice(0, -1);
  const meanDaily = (group: readonly ReleasedWeek[]): number | null => {
    if (group.length === 0 || !group.every(released)) return null;
    if (metric === "day_strain") {
      const cycles = group.reduce((sum, week) => sum + (week.totals.completed_cycles ?? 0), 0);
      const strain = group.reduce(
        (sum, week) => sum + (releasedLoad(week) ?? 0) * (week.totals.completed_cycles ?? 0),
        0
      );
      return cycles > 0 ? strain / cycles : null;
    }
    const worn = group.reduce((sum, week) => sum + (week.totals.worn_days ?? 0), 0);
    const load = group.reduce((sum, week) => sum + (releasedLoad(week) ?? 0), 0);
    return worn > 0 ? load / worn : null;
  };
  const lastMean = meanDaily([lastWeek]);
  const priorMean =
    priorWeeks.length === AGGREGATE_ACUTE_CHRONIC_WEEKS - 1 ? meanDaily(priorWeeks) : null;
  const ratio =
    lastMean !== null && priorMean !== null && priorMean > 0
      ? roundStep(lastMean / priorMean, AGGREGATE_STEPS.ratio)
      : null;

  // --- Notes ----------------------------------------------------------------------------

  const listed = data.weeks.slice(1);
  const lastSunday = addDays(listed[listed.length - 1]!.monday, 6);
  notes.push(
    `Aggregate privacy mode uses whole released weeks: ${plural(listed.length, "week")} ending ${lastSunday}; a week is released on the Wednesday after it ends.`
  );
  const notFinal = listed.filter((week) => !week.gate.final).length;
  const fewSessions = listed.filter(
    (week) => week.gate.final && !week.gate.workouts && data.workoutsAvailable && data.complete
  ).length;
  const fewCycles = listed.filter(
    (week) => week.gate.final && !week.gate.strain && data.cyclesAvailable && data.complete
  ).length;
  if (notFinal > 0) {
    notes.push(
      `${plural(notFinal, "week")} ${notFinal === 1 ? "is" : "are"} withheld: a cycle or score placed in ${notFinal === 1 ? "it" : "them"} is not final yet.`
    );
  }
  if (fewSessions > 0) {
    notes.push(
      `Workout values of ${plural(fewSessions, "week")} ${fewSessions === 1 ? "is" : "are"} withheld: fewer than ${AGGREGATE_WEEK_MIN_SAMPLES} scored sessions.`
    );
  }
  if (fewCycles > 0) {
    notes.push(
      `Mean day strain is withheld for ${plural(fewCycles, "week")}: fewer than ${AGGREGATE_WEEK_MIN_SAMPLES} completed cycles.`
    );
  }
  if (ratio === null) {
    notes.push(
      `The weekly acute:chronic ratio needs the last ${AGGREGATE_ACUTE_CHRONIC_WEEKS} weeks released with a load above 0; it is null here.`
    );
  }
  notes.push(
    "Weekly means per worn day, week-over-week changes and the ratio are computed from the rounded released weekly values."
  );
  if (metric === "day_strain") {
    notes.push(
      "Day strain is non-linear (0-21): equal strain differences are not equal load differences."
    );
  }
  if (metric === "trimp") {
    notes.push(
      "TRIMP counts heart-rate zone minutes, so it undercounts strength sessions; a week's TRIMP is null when a session recorded less than 90% heart-rate data."
    );
  }

  return {
    period: {
      start_week: listed[0]!.monday,
      end_week: listed[listed.length - 1]!.monday,
      weeks: listed.length,
    },
    load_metric: metric,
    load_unit: LOAD_UNITS[metric],
    weeks,
    acute_chronic_weekly: {
      last_week_mean_daily_load:
        lastMean === null ? null : roundStep(lastMean, MEAN_DAILY_STEPS[metric]),
      prior_4_weeks_mean_daily_load:
        priorMean === null ? null : roundStep(priorMean, MEAN_DAILY_STEPS[metric]),
      ratio,
    },
    notes: withOffsetNote(notes, offsetFallback),
    disclaimer: DISCLAIMER,
    data_quality: {
      evaluated_at: aggregateEvaluatedAt(now, utcOffset),
      requested_period: { start: mondays[0]!, end: lastSunday },
      sources: aggregateSources(data),
      method_version: LOAD_METHOD_VERSION,
    },
  };
}

// ---------------------------------------------------------------------------
// get_sport_breakdown (aggregate)
// ---------------------------------------------------------------------------

/** A group of values released or withheld together, with the sums it exposes per metric */
export interface ReleaseGroup {
  id: string;
  /** Groups are considered in ascending order (then most sessions, then name) */
  order: number;
  sessions: number;
  name: string;
  rows: Partial<Record<DifferenceMetric, number[]>>;
}

export type DifferenceMetric = "minutes" | "kj" | "trimp" | "strain" | "distance";

const DIFFERENCE_METRICS: readonly DifferenceMetric[] = [
  "minutes",
  "kj",
  "trimp",
  "strain",
  "distance",
];

/**
 * The groups released next to the fixed weekly sums: groups are added in
 * order, and a group is withheld when its sums together with the fixed sums
 * and the groups already added would isolate fewer than 3 sessions in any
 * metric. The released set is therefore free of such combinations.
 */
export function releasableGroups(
  groups: readonly ReleaseGroup[],
  fixedRows: Partial<Record<DifferenceMetric, readonly (readonly number[])[]>>,
  sessionCount: number
): Set<string> {
  const ordered = [...groups].sort(
    (left, right) =>
      left.order - right.order ||
      right.sessions - left.sessions ||
      compareNames(left.name, right.name) ||
      compareNames(left.id, right.id)
  );
  const accepted: ReleaseGroup[] = [];
  const released = new Set<string>();
  for (const group of ordered) {
    const leaks = DIFFERENCE_METRICS.some((metric) => {
      const own = group.rows[metric];
      if (own === undefined) return false;
      const rows = [
        ...(fixedRows[metric] ?? []),
        ...accepted.flatMap((candidate) =>
          candidate.rows[metric] !== undefined ? [candidate.rows[metric]!] : []
        ),
        own,
      ];
      return sumsIsolateFewerThanThree(rows, sessionCount);
    });
    if (leaks) continue;
    accepted.push(group);
    released.add(group.id);
  }
  return released;
}

function emptyTotals(): {
  duration_minutes_total: null;
  kilojoule_total: null;
  kcal_total: null;
  trimp_total: null;
} {
  return {
    duration_minutes_total: null,
    kilojoule_total: null,
    kcal_total: null,
    trimp_total: null,
  };
}

function roundShares(shares: ZoneMinutes | null): ZoneMinutes | null {
  return shares ? roundZoneShares(shares, 0) : null;
}

/**
 * Run the aggregate variant of get_sport_breakdown.
 *
 * @throws the most relevant WHOOP error when both workouts and cycles fail to load
 */
export async function getSportBreakdownAggregate(
  args: SportBreakdownAggregateInput,
  ctx: ToolContext
): Promise<SportBreakdownAggregateOutput> {
  const now = ctx.now();
  const nowMs = now.getTime();
  const { offset: utcOffset, fallback: offsetFallback } = await resolveUserUtcOffsetInfo(
    ctx.client
  );
  const today = localDay(now.toISOString(), utcOffset);
  const blockOffset = args.block_offset ?? 1;
  const block = lastReleasedBlock(now, utcOffset, BREAKDOWN_BLOCK_WEEKS, blockOffset);
  const data = await loadReleasedTraining(ctx, utcOffset, today, block.mondays, nowMs);
  const notes: string[] = [...data.notes];
  const filter = args.sport !== undefined ? sportKey(args.sport) : null;
  notes.push(
    `Aggregate privacy mode uses whole released 4-week blocks on a fixed Monday grid: ${block.start} to ${block.end}.`
  );

  const base = {
    block: {
      start_week: block.start,
      end_week: block.mondays[block.mondays.length - 1]!,
      weeks: block.weeks,
      block_offset: blockOffset,
    },
    sport_filter: args.sport ?? null,
    disclaimer: DISCLAIMER,
    data_quality: {
      evaluated_at: aggregateEvaluatedAt(now, utcOffset),
      requested_period: { start: block.start, end: block.end },
      sources: aggregateSources(data),
      method_version: BREAKDOWN_METHOD_VERSION,
    },
  };
  const withheldOverall: SportBreakdownAggregateOutput["overall"] = {
    sessions: null,
    active_days: null,
    ...emptyTotals(),
  };

  const allFinal = data.weeks.every((week) => week.gate.final);
  if (!data.workoutsAvailable || !data.complete || !allFinal) {
    if (data.workoutsAvailable && data.complete && !allFinal) {
      notes.push("The block is withheld: a cycle or score placed in it is not final yet.");
    }
    return {
      ...base,
      status: data.workoutsAvailable ? "withheld" : "unavailable",
      sports: [],
      other: null,
      overall: withheldOverall,
      output_capped: false,
      notes: withOffsetNote(notes, offsetFallback),
    };
  }

  // --- Sessions and groups ------------------------------------------------------------

  const scored = data.days.flatMap((day) => day.scoredSessions);
  const indexOf = new Map(scored.map((session, index) => [session, index]));
  const indexes = (sessions: readonly TrainingSession[]): number[] =>
    sessions.map((session) => indexOf.get(session)!);
  const hrOnly = (sessions: readonly TrainingSession[]): TrainingSession[] =>
    sessions.filter((session) => session.fullyRecorded);
  const gpsOnly = (sessions: readonly TrainingSession[]): TrainingSession[] =>
    sessions.filter(
      (session) => session.summary.gps !== null && !session.summary.flags.includes("gps_suspect")
    );

  const bySport = new Map<string, TrainingSession[]>();
  for (const session of scored) {
    const list = bySport.get(session.summary.sport_name) ?? [];
    list.push(session);
    bySport.set(session.summary.sport_name, list);
  }
  const sportNames = [...bySport.keys()].sort(compareNames);
  const releasedNames = sportNames.filter(
    (name) => bySport.get(name)!.length >= SPORT_MIN_SESSIONS
  );
  const pooledNames = sportNames.filter((name) => bySport.get(name)!.length < SPORT_MIN_SESSIONS);
  const pool = pooledNames.flatMap((name) => bySport.get(name)!);

  // Sessions in weeks whose workout values the load variant withholds.
  const withheldWeekSessions = data.weeks
    .filter((week) => !week.gate.workouts)
    .reduce((sum, week) => sum + (week.totals.sessions ?? 0), 0);
  const safe = differenceSafe(withheldWeekSessions);
  const otherAllowed = pool.length >= AGGREGATE_WEEK_MIN_SAMPLES && safe;
  const overallAllowed =
    scored.length >= AGGREGATE_WEEK_MIN_SAMPLES &&
    (pool.length === 0 || pool.length >= AGGREGATE_WEEK_MIN_SAMPLES) &&
    safe;

  // Weekly sums any aggregate tool releases for these weeks (minutes, kJ, TRIMP, workout strain).
  const weeklyRows = data.weeks
    .filter((week) => week.gate.workouts)
    .map((week) =>
      indexes(
        data.days
          .filter((day) => day.date >= week.monday && day.date <= addDays(week.monday, 6))
          .flatMap((day) => day.scoredSessions)
      )
    );
  const fixedRows: Partial<Record<DifferenceMetric, number[][]>> = {
    minutes: weeklyRows,
    kj: weeklyRows,
    trimp: weeklyRows,
    strain: weeklyRows,
  };

  const groups: ReleaseGroup[] = [];
  const addTotalsGroups = (
    id: string,
    sessions: readonly TrainingSession[],
    order: number
  ): void => {
    groups.push({
      id: `${id}:volume`,
      order,
      sessions: sessions.length,
      name: id,
      rows: { minutes: indexes(sessions), kj: indexes(sessions) },
    });
    const hr = hrOnly(sessions);
    if (hr.length >= AGGREGATE_WEEK_MIN_SAMPLES) {
      // TRIMP with zone shares also yields the recorded minutes of these sessions.
      groups.push({
        id: `${id}:hr`,
        order: order + 1,
        sessions: hr.length,
        name: id,
        rows: { trimp: indexes(hr), minutes: indexes(hr) },
      });
    }
  };
  if (otherAllowed) addTotalsGroups("other", pool, 3);
  if (overallAllowed) addTotalsGroups("overall", scored, 5);
  for (const name of releasedNames) {
    const sessions = bySport.get(name)!;
    groups.push({
      id: `sport:${name}:volume`,
      order: 0,
      sessions: sessions.length,
      name,
      rows: {
        minutes: indexes(sessions),
        kj: indexes(sessions),
        strain: indexes(sessions.filter((session) => session.summary.strain !== null)),
      },
    });
    const hr = hrOnly(sessions);
    if (hr.length >= AGGREGATE_WEEK_MIN_SAMPLES) {
      groups.push({
        id: `sport:${name}:hr`,
        order: 1,
        sessions: hr.length,
        name,
        rows: { trimp: indexes(hr), minutes: indexes(hr) },
      });
    }
    const gps = gpsOnly(sessions);
    if (gps.length >= AGGREGATE_WEEK_MIN_SAMPLES) {
      // Pace × distance gives the elapsed minutes of these sessions.
      groups.push({
        id: `sport:${name}:gps`,
        order: 2,
        sessions: gps.length,
        name,
        rows: { distance: indexes(gps), minutes: indexes(gps) },
      });
    }
  }
  const releasedGroups = releasableGroups(groups, fixedRows, scored.length);
  const droppedGroups = groups.length - releasedGroups.size;

  // --- Output ---------------------------------------------------------------------------

  const totalsOf = (
    id: string,
    sessions: readonly TrainingSession[]
  ): z.infer<typeof totalsSchema> => {
    const totals = sessionTotals(sessions);
    const volume = releasedGroups.has(`${id}:volume`);
    const hr = releasedGroups.has(`${id}:hr`);
    return {
      duration_minutes_total: volume
        ? roundStep(totals.durationMinutes, AGGREGATE_STEPS.workout_minutes)
        : null,
      kilojoule_total: volume ? roundStep(totals.kilojoule, AGGREGATE_STEPS.workout_kj) : null,
      kcal_total: volume ? roundStep(totals.kcal, AGGREGATE_STEPS.kcal) : null,
      trimp_total: hr ? roundStep(totals.trimp, AGGREGATE_STEPS.trimp) : null,
    };
  };

  const sportsAll: SportBreakdownAggregateOutput["sports"] = releasedNames.map((name) => {
    const sessions = bySport.get(name)!;
    const totals = sessionTotals(sessions);
    const id = `sport:${name}`;
    const volume = releasedGroups.has(`${id}:volume`);
    const hr = releasedGroups.has(`${id}:hr`);
    const gps = releasedGroups.has(`${id}:gps`);
    const weightedHr = weightedHeartRate(totals);
    return {
      sport_name: name,
      sessions: totals.sessions,
      active_days: totals.activeDays,
      ...totalsOf(id, sessions),
      zone_share_pct: hr ? roundShares(zoneShares(totals.zones)) : null,
      strain_mean:
        volume && totals.strains.length > 0
          ? roundStep(
              totals.strains.reduce((sum, value) => sum + value, 0) / totals.strains.length,
              AGGREGATE_STEPS.day_strain
            )
          : null,
      heart_rate_weighted_average: hr && weightedHr !== null ? roundTo(weightedHr, 0) : null,
      gps:
        totals.gps.sessions >= AGGREGATE_WEEK_MIN_SAMPLES
          ? {
              sessions: totals.gps.sessions,
              distance_km_total: gps
                ? roundStep(totals.gps.distanceKm, AGGREGATE_STEPS.distance_km)
                : null,
              avg_pace_sec_per_km:
                gps && totals.gps.distanceKm > 0
                  ? roundStep(
                      totals.gps.elapsedSeconds / totals.gps.distanceKm,
                      AGGREGATE_STEPS.pace_sec_per_km
                    )
                  : null,
            }
          : null,
    };
  });
  const orderedSports = [...sportsAll].sort(
    (left, right) =>
      right.sessions - left.sessions || compareNames(left.sport_name, right.sport_name)
  );

  let sports = orderedSports.slice(0, MAX_AGGREGATE_SPORTS);
  const outputCapped = orderedSports.length > sports.length;
  let other: SportBreakdownAggregateOutput["other"] =
    pool.length > 0
      ? {
          sports: pooledNames.length,
          sessions: pool.length,
          ...(otherAllowed ? totalsOf("other", pool) : emptyTotals()),
        }
      : null;
  let overall: SportBreakdownAggregateOutput["overall"] = {
    sessions: scored.length,
    active_days: new Set(scored.map((session) => session.summary.day)).size,
    ...(overallAllowed ? totalsOf("overall", scored) : emptyTotals()),
  };

  if (filter !== null) {
    const match = sportsAll.find((sport) => sportKey(sport.sport_name) === filter);
    const pooledMatch = pooledNames.find((name) => sportKey(name) === filter);
    sports = match ? [match] : [];
    other = null;
    if (match) {
      overall = {
        sessions: match.sessions,
        active_days: match.active_days,
        duration_minutes_total: match.duration_minutes_total,
        kilojoule_total: match.kilojoule_total,
        kcal_total: match.kcal_total,
        trimp_total: match.trimp_total,
      };
    } else {
      overall = withheldOverall;
      notes.push(
        pooledMatch !== undefined
          ? `"${args.sport}" has fewer than ${SPORT_MIN_SESSIONS} sessions in this block, so it is withheld.`
          : releasedNames.length > 0
            ? `No sport "${args.sport}" with at least ${SPORT_MIN_SESSIONS} sessions in this block; sports shown: ${releasedNames.slice(0, MAX_AGGREGATE_SPORTS).join(", ")}.`
            : `No sport "${args.sport}" with at least ${SPORT_MIN_SESSIONS} sessions in this block.`
      );
    }
  }

  // --- Notes ------------------------------------------------------------------------------

  const status: SportBreakdownAggregateOutput["status"] =
    scored.length === 0 ? "no_workouts" : "available";
  // As in the standard variant: no_workouts without any worn day is an absence
  // of WHOOP data, not a block without training. (Released per-week worn days
  // already show this, so the note adds no disclosure.)
  const wornInBlock = data.days.some(
    (day) => day.date >= block.start && day.date <= block.end && day.worn === true
  );
  if (scored.length === 0 && !wornInBlock) notes.push("No WHOOP data for this block.");
  if (filter === null && pooledNames.length > 0) {
    notes.push(
      pool.length >= AGGREGATE_WEEK_MIN_SAMPLES
        ? `${plural(pooledNames.length, "sport")} with fewer than ${SPORT_MIN_SESSIONS} sessions ${pooledNames.length === 1 ? "is" : "are"} pooled as other.`
        : `${plural(pooledNames.length, "sport")} with fewer than ${SPORT_MIN_SESSIONS} sessions ${pooledNames.length === 1 ? "is" : "are"} withheld and ${pooledNames.length === 1 ? "its" : "their"} pool is too small to show, so overall totals are withheld.`
    );
  }
  if (!safe && scored.length > 0) {
    notes.push(
      "Overall and other totals are withheld: subtracting the released weekly totals from them would isolate fewer than 3 sessions."
    );
  }
  if (droppedGroups > 0) {
    notes.push(
      `${plural(droppedGroups, "group")} of totals ${droppedGroups === 1 ? "is" : "are"} withheld: combined with other released totals ${droppedGroups === 1 ? "it" : "they"} would isolate fewer than 3 sessions.`
    );
  }
  if (outputCapped) {
    notes.push(`sports lists the ${MAX_AGGREGATE_SPORTS} sports with the most sessions.`);
  }
  notes.push(
    "Heart-rate zones are WHOOP %max-HR zones; TRIMP and zone shares use sessions with 90% recorded heart-rate data, and GPS values need 3 GPS sessions."
  );

  return {
    ...base,
    status,
    sports,
    other,
    overall,
    output_capped: outputCapped,
    notes: withOffsetNote(notes, offsetFallback),
  };
}

// ---------------------------------------------------------------------------
// Tool variants
// ---------------------------------------------------------------------------

/** The aggregate-mode variant of get_training_load */
export const TRAINING_LOAD_AGGREGATE: ToolVariant<
  typeof trainingLoadAggregateInputSchema,
  typeof trainingLoadAggregateOutputSchema
> = {
  title: "Training load",
  description:
    "Weekly training load over whole released local ISO weeks (a week is released on the Wednesday after it ends; default the last 8, 4-26): worn days, sessions, workout minutes, TRIMP, kJ and mean day strain, rounded, with the week-over-week change and a weekly acute:chronic ratio (the last week's load per worn day against the 4 weeks before). Aggregate privacy mode: a week's workout values need 3 scored sessions and its day strain 3 completed cycles; weeks with an open cycle or pending score are withheld. No daily values, EWMA or monotony. Descriptive only.",
  inputSchema: trainingLoadAggregateInputSchema,
  outputSchema: trainingLoadAggregateOutputSchema,
  run: getTrainingLoadAggregate,
};

/** The aggregate-mode variant of get_sport_breakdown */
export const SPORT_BREAKDOWN_AGGREGATE: ToolVariant<
  typeof sportBreakdownAggregateInputSchema,
  typeof sportBreakdownAggregateOutputSchema
> = {
  title: "Sport breakdown",
  description:
    "Workouts per sport over a released 4-week block on a fixed Monday grid (block_offset 1 = the latest fully released block): sessions, active days, rounded duration, energy and TRIMP totals, whole-percent zone shares, mean strain, weighted heart rate and GPS distance and pace. Aggregate privacy mode: a sport needs 3 sessions; smaller sports are pooled as other (or overall totals are withheld), and totals that could be subtracted from weekly totals to isolate fewer than 3 sessions are withheld. No per-session extremes, medians, efficiency or time of day.",
  inputSchema: sportBreakdownAggregateInputSchema,
  outputSchema: sportBreakdownAggregateOutputSchema,
  run: getSportBreakdownAggregate,
};
