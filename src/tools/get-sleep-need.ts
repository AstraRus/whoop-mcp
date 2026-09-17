/**
 * Tool: get_sleep_need
 *
 * A statistical estimate of the WHOOP sleep need for tonight's sleep, built
 * only from the user's past WHOOP sleep-need records. It is not WHOOP's Sleep
 * Planner and not a recommendation.
 *
 * WHOOP reports each scored sleep's need as baseline + debt + recent strain +
 * recent nap. The nap part (need_from_recent_nap) is 0 or negative: a nap
 * lowers the need. That sign is kept everywhere here: the nap component and
 * the nap ratio are 0 or negative, and they are added.
 *
 * The models learn from pairs (P, N) of consecutive SCORED main sleeps, where
 * N starts when the cycle P started ends (within 60 s). Tonight's sleep is the
 * N of the pair whose P is last night (the main sleep of the open cycle).
 * - baseline: last night's WHOOP baseline.
 * - debt: carry fraction k × last night's shortfall, k by least squares through
 *   the origin on N's debt component. Variant A: shortfall = max(0, baseline +
 *   strain need + nap need − asleep) of P; variant B: A + P's debt component.
 *   The variant with the lower leave-one-out error is used (a tie keeps A).
 * - strain: median strain component of the k nearest cycle strains (k =
 *   min(5, pairs − 1)), evaluated at today's strain so far; null above the
 *   observed maximum + 0.5.
 * - nap: without naps today 0, provided every nap-free pair has a 0 nap
 *   component; with naps today the median ratio nap component / nap time
 *   asleep (0 or negative) × today's nap time asleep.
 * The component sum is backtested (leave-one-out) against persistence (P's own
 * total). The component model is used when every component is known, there are
 * enough pairs, and its error is not larger than persistence; otherwise
 * persistence is used when the component model was evaluated and lost, else
 * there is no estimate.
 */

import { z } from "zod";
import { ENDPOINT_CYCLE, ENDPOINT_RECOVERY, ENDPOINT_SLEEP } from "../api/endpoints.js";
import {
  createHistoryBudget,
  HISTORY_DEADLINE_MS,
  HISTORY_LIMITATIONS,
  loadHistory,
} from "../api/history.js";
import {
  cycleRecordSchema,
  recoveryRecordSchema,
  sleepRecordSchema,
} from "../api/record-schemas.js";
import type { Cycle, Recovery, Sleep } from "../api/types.js";
import {
  dataQualitySchema,
  DAY_MS,
  DISCLAIMER,
  finishQuality,
  formatLocalTimestamp,
  HOUR_MS,
  localDay,
  localMidnightMs,
  mostRelevantError,
  type SourceQuality,
} from "./analytics-utils.js";
import { resolveUserUtcOffsetInfo, withOffsetNote } from "./collection-utils.js";
import { parseUtcOffset } from "./date-utils.js";
import {
  addDays,
  CYCLE_BOUNDARY_TOLERANCE_MS,
  cycleStrain,
  fetchRangeForDays,
  isBetterSleep,
  isNewer,
  localClock,
  LONG_CYCLE_MS,
  SHORT_CYCLE_MS,
} from "./day-model.js";
import {
  historyTruncationNotes,
  minutesToHHMM,
  needHoursSchema,
  plural,
  roundNeed,
} from "./get-sleep-analysis.js";
import { STALE_SLEEP_MS } from "./get-today.js";
import { needBreakdown, stageBreakdown, type NeedBreakdown } from "./sleep-metrics.js";
import { kNearestMedian, mean, median, percentile, roundTo } from "./stats-utils.js";
import { defineTool, type ToolContext } from "./tool-definition.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Label carried by every get_sleep_need result. */
export const SLEEP_NEED_LABEL =
  "Statistical estimate from your past WHOOP sleep-need records; not WHOOP Sleep Planner, not a recommendation.";

/** Local days of history without `history_days`. */
export const SLEEP_NEED_DEFAULT_HISTORY_DAYS = 60;

/** Pairs the debt model needs. */
export const DEBT_MODEL_MIN_PAIRS = 7;

/** Pairs the strain model needs. */
export const STRAIN_MODEL_MIN_PAIRS = 10;

/** Pairs with naps the nap ratio needs. */
export const NAP_MODEL_MIN_PAIRS = 3;

/** Largest neighbour count of the strain model (k = min(this, pairs − 1)). */
export const STRAIN_MAX_NEIGHBOURS = 5;

/** Strain so far may exceed the highest observed cycle strain by this much. */
export const STRAIN_RANGE_MARGIN = 0.5;

/** A debt prediction within this many seconds of WHOOP's value is an exact match. */
export const EXACT_MATCH_TOLERANCE_SECONDS = 60;

/** Largest gap between a cycle's end and the next main sleep's start in a pair. */
export const PAIR_BOUNDARY_TOLERANCE_MS = CYCLE_BOUNDARY_TOLERANCE_MS;

/** Newest scored nights the typical WHOOP efficiency is taken from. */
export const EFFICIENCY_RECENT_NIGHTS = 14;

/** Efficiency values the typical efficiency needs. */
export const EFFICIENCY_MIN_NIGHTS = 3;

/** Percentile of absolute backtest errors used for the estimate range. */
export const ESTIMATE_RANGE_PERCENTILE = 80;

/** Backtest pairs needed before a model is selected (= DEBT_MODEL_MIN_PAIRS). */
export const ESTIMATE_MIN_BACKTEST_PAIRS = DEBT_MODEL_MIN_PAIRS;

/** 24-hour "HH:MM". */
export const WAKE_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

const MINUTE_MS = 60_000;
const EXACT_MATCH_TOLERANCE_HOURS = EXACT_MATCH_TOLERANCE_SECONDS / 3600;
/** Floating-point slack when comparing hour values against the exact-match tolerance. */
const HOURS_EPSILON = 1e-9;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const sleepNeedInputSchema = z.object({
  history_days: z
    .number()
    .int()
    .min(21)
    .max(120)
    .optional()
    .describe(
      "Local days of past WHOOP sleep-need records the models learn from, ending today (21-120). Default: 60."
    ),
  wake_time: z
    .string()
    .regex(WAKE_TIME_PATTERN)
    .optional()
    .describe(
      'A wake time "HH:MM" (24-hour, local). Adds in_bed_arithmetic: the hours in bed the estimate corresponds to at the typical WHOOP efficiency, the latest in-bed start that arithmetic gives, and the hours until that wake time.'
    ),
});
export type SleepNeedInput = z.infer<typeof sleepNeedInputSchema>;

const int = z.number().int();

const lastNightSchema = z
  .object({
    date: z.string().describe("Local wake day of the main sleep that started the current cycle"),
    whoop_need: needHoursSchema.describe("WHOOP's sleep need for last night, hours"),
    asleep_hours: z.number().describe("Light + slow-wave + REM"),
    performance_pct: z.number().nullable(),
    calibrating: z.boolean().nullable().describe("WHOOP's calibration flag on its recovery"),
  })
  .nullable();

const todaySoFarSchema = z
  .object({
    cycle_started_local: z.string(),
    strain_so_far: z.number().nullable().describe("WHOOP strain of the open cycle so far"),
    strain_in_progress: z.literal(true),
    naps: z.object({
      count: int,
      asleep_hours: z
        .number()
        .nullable()
        .describe("Time asleep in naps of the current cycle; null when a nap is not scored"),
      unscored: int,
    }),
  })
  .nullable();

const componentsSchema = z.object({
  baseline: z.object({
    hours: z.number().nullable(),
    method: z.literal("latest_whoop_baseline"),
    source_date: z.string().nullable(),
  }),
  debt: z.object({
    hours: z.number().nullable(),
    method: z.literal("carry_fraction"),
    variant: z
      .enum(["A", "B"])
      .nullable()
      .describe(
        "A: shortfall = max(0, baseline + strain need + nap need − asleep) of the previous night; B: A + its debt component"
      ),
    carry_fraction: z.number().nullable().describe("Least-squares k through the origin"),
    pairs: int,
    required: int,
    loo_mae_min: z.number().nullable().describe("Leave-one-out mean absolute error, minutes"),
    exact_match_rate: z
      .number()
      .nullable()
      .describe(
        `Share of pairs whose leave-one-out prediction is within ${EXACT_MATCH_TOLERANCE_SECONDS} s of WHOOP's debt component`
      ),
  }),
  strain: z.object({
    hours: z.number().nullable(),
    method: z.literal("k_nearest_median"),
    k: int.nullable(),
    pairs: int,
    required: int,
    loo_mae_min: z.number().nullable(),
    observed_max_strain: z.number().nullable(),
    in_observed_range: z
      .boolean()
      .nullable()
      .describe(`False when strain so far exceeds the observed maximum + ${STRAIN_RANGE_MARGIN}`),
    basis: z.literal("strain_so_far"),
  }),
  nap: z.object({
    hours: z.number().nullable().describe("0 or negative: a nap lowers the need"),
    method: z.enum(["none_today", "ratio_of_nap_asleep"]),
    ratio: z.number().nullable().describe("0 or negative: nap component per hour of nap asleep"),
    pairs: int.describe("Pairs with scored naps in the cycle between the two sleeps"),
    required: int,
    nap_free_nonzero_count: int.describe("Pairs without naps whose WHOOP nap component was not 0"),
  }),
});

const estimateSchema = z.object({
  hours: z.number().nullable(),
  range_hours: z
    .object({ low: z.number(), high: z.number() })
    .nullable()
    .describe(
      `Estimate ± the ${ESTIMATE_RANGE_PERCENTILE}th percentile of the selected model's absolute backtest errors`
    ),
  selected_model: z.enum(["component", "persistence"]).nullable(),
  backtest: z.object({
    pairs: int,
    component_mae_min: z.number().nullable(),
    persistence_mae_min: z
      .number()
      .nullable()
      .describe("Error of using the previous night's WHOOP total as the next night's"),
    p80_abs_error_min: z.number().nullable(),
  }),
});

const inBedArithmeticSchema = z
  .object({
    wake_time_local: z.string(),
    utc_offset: z.string(),
    typical_efficiency_pct: z.number().nullable(),
    efficiency_nights: int,
    in_bed_hours_for_estimate: z
      .number()
      .nullable()
      .describe("Estimate ÷ typical WHOOP efficiency; ignores time to fall asleep"),
    latest_in_bed_start_local_for_estimate: z
      .string()
      .nullable()
      .describe("wake_time − in_bed_hours_for_estimate, HH:MM in utc_offset"),
    hours_until_wake_time: z.number().describe("From now to the next occurrence of wake_time"),
    label: z.string(),
  })
  .nullable();

export const sleepNeedOutputSchema = z.object({
  evaluated_at_local: z.string(),
  status: z
    .enum([
      "estimated",
      "insufficient_history",
      "no_current_cycle",
      "last_night_unavailable",
      "unavailable",
    ])
    .describe(
      "estimated: estimate.hours is set (selected_model says which model). insufficient_history: too few pairs, or a component is unknown. no_current_cycle: the newest WHOOP cycle is closed. last_night_unavailable: the current cycle's main sleep is not scored. unavailable: data could not be read."
    ),
  label: z.string(),
  last_night: lastNightSchema,
  today_so_far: todaySoFarSchema,
  components: componentsSchema,
  estimate: estimateSchema,
  in_bed_arithmetic: inBedArithmeticSchema,
  history: z.object({
    days: int,
    first_day: z.string(),
    pairs: int,
    calibrating_pairs: int.describe("Pairs with a recovery WHOOP flagged as calibrating (kept)"),
    excluded: z.object({
      unscored_sleep: int,
      short_or_long_cycle: int,
      strain_unscored: int,
      unscored_naps: int,
    }),
  }),
  truncated: z.boolean(),
  notes: z.array(z.string()),
  warnings: z.array(z.string()),
  disclaimer: z.string(),
  data_quality: dataQualitySchema,
});
export type SleepNeedReport = z.infer<typeof sleepNeedOutputSchema>;

// ---------------------------------------------------------------------------
// Records and pairs
// ---------------------------------------------------------------------------

/** A scored main sleep with its WHOOP need (hours) and time asleep (hours). */
export interface ScoredNight {
  sleep: Sleep;
  need: NeedBreakdown;
  asleepHours: number;
}

/** Two consecutive scored main sleeps and the cycle between them. */
export interface SleepNeedPair {
  previous: ScoredNight;
  next: ScoredNight;
  /** Started by previous; ends where next starts. */
  cycle: Cycle;
  strain: number;
  /** Naps in the cycle (all scored). */
  naps: number;
  napAsleepHours: number;
  /** Either night's recovery is flagged calibrating. */
  calibrating: boolean;
}

export interface PairExclusions {
  unscored_sleep: number;
  short_or_long_cycle: number;
  strain_unscored: number;
  unscored_naps: number;
}

/** Loaded records, deduplicated and indexed. */
export interface SleepNeedIndex {
  /** Newest version per id, oldest start first. */
  cycles: Cycle[];
  /** The best main sleep (isBetterSleep) per cycle id; ended by now. */
  mainSleepByCycle: Map<number, Sleep>;
  /** Naps per cycle id, ended by now, oldest first. */
  napsByCycle: Map<number, Sleep[]>;
  /** The most recently updated recovery per cycle id. */
  recoveryByCycle: Map<number, Recovery>;
}

function byStartThenId<T extends { start: string; id: string | number }>(
  left: T,
  right: T
): number {
  return (
    Date.parse(left.start) - Date.parse(right.start) ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  );
}

/** Index loaded records: newest cycle versions, best main sleep per cycle, naps and recoveries. */
export function indexSleepNeedRecords(
  cycles: readonly Cycle[],
  sleeps: readonly Sleep[],
  recoveries: readonly Recovery[],
  nowMs: number
): SleepNeedIndex {
  const cycleById = new Map<number, Cycle>();
  for (const cycle of cycles) {
    const current = cycleById.get(cycle.id);
    if (!current || isNewer(cycle, current)) cycleById.set(cycle.id, cycle);
  }
  const mainSleepByCycle = new Map<number, Sleep>();
  const napsByCycle = new Map<number, Sleep[]>();
  for (const sleep of sleeps) {
    const startMs = Date.parse(sleep.start);
    const endMs = Date.parse(sleep.end);
    if (!(endMs > startMs) || endMs > nowMs) continue;
    if (sleep.nap) {
      const list = napsByCycle.get(sleep.cycle_id) ?? [];
      list.push(sleep);
      napsByCycle.set(sleep.cycle_id, list);
      continue;
    }
    const current = mainSleepByCycle.get(sleep.cycle_id);
    if (!current || isBetterSleep(sleep, current)) mainSleepByCycle.set(sleep.cycle_id, sleep);
  }
  for (const list of napsByCycle.values()) list.sort(byStartThenId);
  const recoveryByCycle = new Map<number, Recovery>();
  for (const recovery of recoveries) {
    const current = recoveryByCycle.get(recovery.cycle_id);
    if (!current || isNewer(recovery, current)) recoveryByCycle.set(recovery.cycle_id, recovery);
  }
  return {
    cycles: [...cycleById.values()].sort(byStartThenId),
    mainSleepByCycle,
    napsByCycle,
    recoveryByCycle,
  };
}

function isScored(record: { score_state: string; score?: unknown }): boolean {
  return record.score_state === "SCORED" && record.score !== null && record.score !== undefined;
}

/** A scored main sleep's need and time asleep; null when it is not scored. */
export function scoredNight(sleep: Sleep): ScoredNight | null {
  if (sleep.nap || !isScored(sleep)) return null;
  const need = needBreakdown(sleep);
  const stages = stageBreakdown(sleep);
  if (!need || !stages) return null;
  return { sleep, need, asleepHours: stages.asleep_min / 60 };
}

/** The recovery WHOOP scored for `sleep`, or null. */
function recoveryFor(index: SleepNeedIndex, sleep: Sleep): Recovery | null {
  const recovery = index.recoveryByCycle.get(sleep.cycle_id);
  return recovery && recovery.sleep_id === sleep.id ? recovery : null;
}

/** Naps of a cycle: count, unscored count, and time asleep of the scored ones (hours). */
function napsOf(
  index: SleepNeedIndex,
  cycleId: number
): { count: number; unscored: number; asleepHours: number } {
  const naps = index.napsByCycle.get(cycleId) ?? [];
  let unscored = 0;
  let asleepMinutes = 0;
  for (const nap of naps) {
    const stages = isScored(nap) ? stageBreakdown(nap) : null;
    if (stages) asleepMinutes += stages.asleep_min;
    else unscored += 1;
  }
  return { count: naps.length, unscored, asleepHours: asleepMinutes / 60 };
}

/** The closed cycle ending within the tolerance of `startMs` (nearest, then smallest id). */
function cycleEndingAt(index: SleepNeedIndex, startMs: number, exceptId: number): Cycle | null {
  let best: Cycle | null = null;
  let bestGap = Infinity;
  for (const cycle of index.cycles) {
    if (cycle.id === exceptId || cycle.end === null || cycle.end === undefined) continue;
    const gap = Math.abs(Date.parse(cycle.end) - startMs);
    if (gap > PAIR_BOUNDARY_TOLERANCE_MS) continue;
    if (gap < bestGap || (gap === bestGap && best !== null && cycle.id < best.id)) {
      best = cycle;
      bestGap = gap;
    }
  }
  return best;
}

/**
 * Pairs (P, N) of consecutive main sleeps whose N woke on or after `firstDay`:
 * N starts within 60 s of the end of the cycle P started. Pairs with an
 * unscored sleep, a cycle shorter than 12 or longer than 36 hours, an unscored
 * cycle strain or an unscored nap in the cycle are excluded and counted.
 * Oldest first.
 */
export function buildSleepNeedPairs(
  index: SleepNeedIndex,
  firstDay: string
): { pairs: SleepNeedPair[]; excluded: PairExclusions } {
  const excluded: PairExclusions = {
    unscored_sleep: 0,
    short_or_long_cycle: 0,
    strain_unscored: 0,
    unscored_naps: 0,
  };
  const pairs: SleepNeedPair[] = [];
  const mains = [...index.mainSleepByCycle.values()].sort(byStartThenId);
  for (const nextSleep of mains) {
    if (localDay(nextSleep.end, nextSleep.timezone_offset) < firstDay) continue;
    const cycle = cycleEndingAt(index, Date.parse(nextSleep.start), nextSleep.cycle_id);
    if (!cycle) continue;
    const previousSleep = index.mainSleepByCycle.get(cycle.id);
    if (!previousSleep) continue;
    const previous = scoredNight(previousSleep);
    const next = scoredNight(nextSleep);
    if (!previous || !next) {
      excluded.unscored_sleep += 1;
      continue;
    }
    const lengthMs = Date.parse(cycle.end!) - Date.parse(cycle.start);
    if (lengthMs < SHORT_CYCLE_MS || lengthMs > LONG_CYCLE_MS) {
      excluded.short_or_long_cycle += 1;
      continue;
    }
    const strain = cycleStrain(cycle);
    if (strain === null) {
      excluded.strain_unscored += 1;
      continue;
    }
    const naps = napsOf(index, cycle.id);
    if (naps.unscored > 0) {
      excluded.unscored_naps += 1;
      continue;
    }
    const calibrating = [previousSleep, nextSleep].some(
      (sleep) => recoveryFor(index, sleep)?.score?.user_calibrating === true
    );
    pairs.push({
      previous,
      next,
      cycle,
      strain,
      naps: naps.count,
      napAsleepHours: naps.asleepHours,
      calibrating,
    });
  }
  pairs.sort(
    (left, right) =>
      Date.parse(left.next.sleep.end) - Date.parse(right.next.sleep.end) ||
      (left.next.sleep.id < right.next.sleep.id ? -1 : 1)
  );
  return { pairs, excluded };
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export type DebtVariant = "A" | "B";

/** A night's shortfall in hours: variant A against baseline + strain + nap need; B adds its debt. */
export function debtShortfallHours(night: ScoredNight, variant: DebtVariant): number {
  const shortfall = Math.max(
    0,
    night.need.baseline + night.need.strain + night.need.nap - night.asleepHours
  );
  return variant === "A" ? shortfall : shortfall + night.need.debt;
}

export interface DebtFit {
  variant: DebtVariant;
  /** Least-squares carry fraction through the origin; null when every shortfall is 0. */
  k: number | null;
  /** Leave-one-out predictions (hours) per pair; null below the minimum or when a fold is undefined. */
  loo: number[] | null;
  maeMin: number | null;
  exactMatchRate: number | null;
}

/** Fit N's debt component = k × P's shortfall (variant) through the origin, with leave-one-out errors. */
export function fitDebtModel(pairs: readonly SleepNeedPair[], variant: DebtVariant): DebtFit {
  const empty: DebtFit = { variant, k: null, loo: null, maeMin: null, exactMatchRate: null };
  if (pairs.length < DEBT_MODEL_MIN_PAIRS) return empty;
  const xs = pairs.map((pair) => debtShortfallHours(pair.previous, variant));
  const ys = pairs.map((pair) => pair.next.need.debt);
  const fit = (skip: number): number | null => {
    let sxx = 0;
    let sxy = 0;
    for (let j = 0; j < xs.length; j++) {
      if (j === skip) continue;
      sxx += xs[j]! * xs[j]!;
      sxy += xs[j]! * ys[j]!;
    }
    return sxx > 0 ? sxy / sxx : null;
  };
  const k = fit(-1);
  const loo: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i]!;
    if (x === 0) {
      loo.push(0);
      continue;
    }
    const kWithout = fit(i);
    if (kWithout === null) return { ...empty, k };
    loo.push(kWithout * x);
  }
  const errors = loo.map((prediction, i) => Math.abs(prediction - ys[i]!));
  return {
    variant,
    k,
    loo,
    maeMin: mean(errors) * 60,
    exactMatchRate:
      errors.filter((error) => error <= EXACT_MATCH_TOLERANCE_HOURS + HOURS_EPSILON).length /
      errors.length,
  };
}

/** The variant with the lower leave-one-out error (a tie keeps A); null when neither can be fitted. */
export function selectDebtModel(fitA: DebtFit, fitB: DebtFit): DebtFit | null {
  if (fitA.maeMin === null) return fitB.maeMin === null ? null : fitB;
  return fitB.maeMin !== null && fitB.maeMin < fitA.maeMin ? fitB : fitA;
}

export interface StrainFit {
  k: number | null;
  loo: number[] | null;
  maeMin: number | null;
  observedMax: number | null;
  points: { x: number; y: number }[];
}

/** N's strain component from the k nearest cycle strains, with leave-one-out errors. */
export function fitStrainModel(pairs: readonly SleepNeedPair[]): StrainFit {
  const points = pairs.map((pair) => ({ x: pair.strain, y: pair.next.need.strain }));
  if (pairs.length < STRAIN_MODEL_MIN_PAIRS)
    return { k: null, loo: null, maeMin: null, observedMax: null, points };
  const k = Math.min(STRAIN_MAX_NEIGHBOURS, pairs.length - 1);
  const loo = points.map(
    (point, i) =>
      kNearestMedian(
        points.filter((_, j) => j !== i),
        point.x,
        k
      )!
  );
  return {
    k,
    loo,
    maeMin: mean(loo.map((prediction, i) => Math.abs(prediction - points[i]!.y))) * 60,
    observedMax: Math.max(...points.map((point) => point.x)),
    points,
  };
}

/** Median nap component per hour of nap asleep (0 or negative) over pairs with naps; null below the minimum. */
export function napRatio(pairs: readonly SleepNeedPair[]): number | null {
  const ratios = pairs
    .filter((pair) => pair.naps > 0 && pair.napAsleepHours > 0)
    .map((pair) => pair.next.need.nap / pair.napAsleepHours);
  // WHOOP's nap component is 0 or negative, so the ratio is too.
  return ratios.length >= NAP_MODEL_MIN_PAIRS ? Math.min(0, median(ratios)) : null;
}

/** Pairs without naps whose WHOOP nap component is not 0. */
export function napFreeNonzeroCount(pairs: readonly SleepNeedPair[]): number {
  return pairs.filter((pair) => pair.naps === 0 && pair.next.need.nap !== 0).length;
}

/**
 * The nap component (0 or negative) for a cycle with `naps` naps and
 * `napAsleepHours` asleep in them: 0 without naps when no nap-free pair has a
 * nonzero component, else ratio × nap asleep; null when unknown.
 */
export function napComponent(
  pairs: readonly SleepNeedPair[],
  naps: number,
  napAsleepHours: number | null
): number | null {
  if (naps === 0) return napFreeNonzeroCount(pairs) === 0 ? 0 : null;
  if (napAsleepHours === null) return null;
  const ratio = napRatio(pairs);
  return ratio === null ? null : ratio * napAsleepHours;
}

export interface Backtest {
  pairs: number;
  componentMaeMin: number | null;
  persistenceMaeMin: number | null;
  componentErrors: number[];
  persistenceErrors: number[];
}

/**
 * Leave-one-out backtest over the pairs: baseline of P + debt + strain + nap
 * versus N's WHOOP total including debt, and persistence (P's own total).
 * Pairs with an unknown component prediction are left out.
 */
export function backtestSleepNeed(
  pairs: readonly SleepNeedPair[],
  debt: DebtFit | null,
  strain: StrainFit
): Backtest {
  const componentErrors: number[] = [];
  const persistenceErrors: number[] = [];
  pairs.forEach((pair, i) => {
    const debtHours = debt?.loo?.[i] ?? null;
    const strainHours = strain.loo?.[i] ?? null;
    const others = pairs.filter((_, j) => j !== i);
    const napHours = napComponent(others, pair.naps, pair.napAsleepHours);
    if (debtHours === null || strainHours === null || napHours === null) return;
    const actual = pair.next.need.total_including_debt;
    const predicted = pair.previous.need.baseline + debtHours + strainHours + napHours;
    componentErrors.push(Math.abs(predicted - actual));
    persistenceErrors.push(Math.abs(pair.previous.need.total_including_debt - actual));
  });
  const enough = componentErrors.length >= ESTIMATE_MIN_BACKTEST_PAIRS;
  return {
    pairs: componentErrors.length,
    componentMaeMin: enough ? mean(componentErrors) * 60 : null,
    persistenceMaeMin: enough ? mean(persistenceErrors) * 60 : null,
    componentErrors,
    persistenceErrors,
  };
}

// ---------------------------------------------------------------------------
// In-bed arithmetic
// ---------------------------------------------------------------------------

export interface InBedArithmetic {
  wake_time_local: string;
  utc_offset: string;
  typical_efficiency_pct: number | null;
  efficiency_nights: number;
  in_bed_hours_for_estimate: number | null;
  latest_in_bed_start_local_for_estimate: string | null;
  hours_until_wake_time: number;
  label: string;
}

export const IN_BED_ARITHMETIC_LABEL =
  "Arithmetic only: the estimate divided by the typical WHOOP sleep efficiency, counted back from wake_time. It ignores the time taken to fall asleep.";

/**
 * Hours in bed that `estimateHours` corresponds to at `efficiencyPct`, the
 * wall-clock time that many hours before `wakeTime` in `offset` (crossing
 * midnight backward), and the hours from now to the next `wakeTime`.
 */
export function inBedArithmetic(input: {
  estimateHours: number | null;
  efficiencyPct: number | null;
  efficiencyNights: number;
  wakeTime: string;
  nowMs: number;
  offset: string;
}): InBedArithmetic {
  const [hours, minutes] = input.wakeTime.split(":").map(Number) as [number, number];
  const wakeMinutes = hours * 60 + minutes;
  const localNowMinutes =
    ((((input.nowMs + parseUtcOffset(input.offset) * MINUTE_MS) % DAY_MS) + DAY_MS) % DAY_MS) /
    MINUTE_MS;
  const untilMinutes = (((wakeMinutes - localNowMinutes) % 1440) + 1440) % 1440;
  const inBed =
    input.estimateHours !== null && input.efficiencyPct !== null && input.efficiencyPct > 0
      ? input.estimateHours / (input.efficiencyPct / 100)
      : null;
  return {
    wake_time_local: input.wakeTime,
    utc_offset: input.offset,
    typical_efficiency_pct: roundTo(input.efficiencyPct, 1),
    efficiency_nights: input.efficiencyNights,
    in_bed_hours_for_estimate: roundTo(inBed, 2),
    latest_in_bed_start_local_for_estimate:
      inBed === null ? null : minutesToHHMM(wakeMinutes - inBed * 60),
    hours_until_wake_time: roundTo(untilMinutes / 60, 2),
    label: IN_BED_ARITHMETIC_LABEL,
  };
}

/** Median WHOOP efficiency over the newest EFFICIENCY_RECENT_NIGHTS scored main sleeps. */
function typicalEfficiency(index: SleepNeedIndex): { pct: number | null; nights: number } {
  const values = [...index.mainSleepByCycle.values()]
    .filter((sleep) => isScored(sleep))
    .sort(
      (left, right) => Date.parse(right.end) - Date.parse(left.end) || (left.id < right.id ? -1 : 1)
    )
    .slice(0, EFFICIENCY_RECENT_NIGHTS)
    .flatMap((sleep) => {
      const value = sleep.score?.sleep_efficiency_percentage;
      return typeof value === "number" ? [value] : [];
    });
  return {
    pct: values.length >= EFFICIENCY_MIN_NIGHTS ? median(values) : null,
    nights: values.length,
  };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

function unreadable(quality: SourceQuality): boolean {
  return quality.status === "fetch_failed" || quality.status === "invalid";
}

/** "2026-09-16 23:13 (UTC+02:00)" */
function localStamp(timestamp: string, offset: string): string {
  return `${localClock(timestamp, offset)} (UTC${offset === "Z" ? "" : offset})`;
}

const minutes = (hours: number | null): number | null => roundTo(hours, 1);

export async function runSleepNeed(
  args: SleepNeedInput,
  ctx: ToolContext
): Promise<SleepNeedReport> {
  const now = ctx.now();
  const nowMs = now.getTime();
  const historyDays = args.history_days ?? SLEEP_NEED_DEFAULT_HISTORY_DAYS;
  const offsetInfo = await resolveUserUtcOffsetInfo(ctx.client);
  const userOffset = offsetInfo.offset;
  const today = localDay(now.toISOString(), userOffset);
  const firstDay = addDays(today, -(historyDays - 1));
  const range = fetchRangeForDays(firstDay, today, userOffset, nowMs);
  const period = {
    start: new Date(range.startMs).toISOString(),
    end: new Date(Math.max(range.startMs, range.endMs)).toISOString(),
  };
  const budget = createHistoryBudget({ deadlineMs: ctx.startedAtMs + HISTORY_DEADLINE_MS });
  const options = {
    budget,
    now: (): Date => now,
    ...(ctx.historyCache !== undefined ? { cache: ctx.historyCache } : {}),
  };
  const [cycle, sleep, recovery] = await Promise.all([
    loadHistory(ctx.client, ENDPOINT_CYCLE, period, cycleRecordSchema, options),
    loadHistory(ctx.client, ENDPOINT_SLEEP, period, sleepRecordSchema, options),
    loadHistory(ctx.client, ENDPOINT_RECOVERY, period, recoveryRecordSchema, options),
  ]);
  // Cycles and sleeps are both needed for anything here.
  const failed = [cycle, sleep].filter((source) => source.quality.status === "fetch_failed");
  if (failed.length > 0) {
    throw mostRelevantError(
      [cycle, sleep, recovery]
        .filter((source) => source.quality.status === "fetch_failed")
        .map((source) => source.error)
    );
  }
  const readable = !unreadable(cycle.quality) && !unreadable(sleep.quality);
  const recoveriesReadable = !unreadable(recovery.quality);

  const index = indexSleepNeedRecords(
    cycle.records,
    sleep.records,
    recoveriesReadable ? recovery.records : [],
    nowMs
  );
  const { pairs, excluded } = buildSleepNeedPairs(index, firstDay);
  const calibratingPairs = pairs.filter((pair) => pair.calibrating).length;

  // --- Current cycle, last night and today so far ------------------------------------
  const newestCycle = index.cycles[index.cycles.length - 1];
  const openCycle =
    newestCycle && (newestCycle.end === null || newestCycle.end === undefined) ? newestCycle : null;
  const offset = openCycle?.timezone_offset ?? userOffset;
  const lastNightSleep = openCycle ? (index.mainSleepByCycle.get(openCycle.id) ?? null) : null;
  const lastNight = lastNightSleep ? scoredNight(lastNightSleep) : null;
  const lastNightRecovery = lastNightSleep ? recoveryFor(index, lastNightSleep) : null;
  const todayNaps = openCycle ? napsOf(index, openCycle.id) : null;
  const strainSoFar = openCycle ? cycleStrain(openCycle) : null;

  // --- Models ------------------------------------------------------------------------
  const debtFit = selectDebtModel(fitDebtModel(pairs, "A"), fitDebtModel(pairs, "B"));
  const strainFit = fitStrainModel(pairs);
  const napFreeNonzero = napFreeNonzeroCount(pairs);
  const napPairs = pairs.filter((pair) => pair.naps > 0 && pair.napAsleepHours > 0).length;
  const ratio = napRatio(pairs);

  let baselineHours: number | null = null;
  let debtHours: number | null = null;
  let strainHours: number | null = null;
  let napHours: number | null = null;
  let inObservedRange: boolean | null = null;
  if (lastNight) {
    baselineHours = lastNight.need.baseline;
    if (debtFit) {
      const shortfall = debtShortfallHours(lastNight, debtFit.variant);
      debtHours = debtFit.k !== null ? debtFit.k * shortfall : shortfall === 0 ? 0 : null;
    }
    if (strainFit.k !== null && strainSoFar !== null && strainFit.observedMax !== null) {
      inObservedRange = strainSoFar <= strainFit.observedMax + STRAIN_RANGE_MARGIN;
      strainHours = inObservedRange
        ? kNearestMedian(strainFit.points, strainSoFar, strainFit.k)
        : null;
    }
    if (todayNaps)
      napHours = napComponent(
        pairs,
        todayNaps.count,
        todayNaps.unscored > 0 ? null : todayNaps.asleepHours
      );
  }
  const backtest = backtestSleepNeed(pairs, debtFit, strainFit);

  // --- Status and estimate -------------------------------------------------------------
  let status: SleepNeedReport["status"];
  let selected: "component" | "persistence" | null = null;
  const componentsKnown =
    baselineHours !== null && debtHours !== null && strainHours !== null && napHours !== null;
  if (!readable) status = "unavailable";
  else if (!openCycle) status = "no_current_cycle";
  else if (!lastNight) status = "last_night_unavailable";
  else if (
    pairs.length < DEBT_MODEL_MIN_PAIRS ||
    !componentsKnown ||
    backtest.componentMaeMin === null ||
    backtest.persistenceMaeMin === null
  )
    status = "insufficient_history";
  else {
    status = "estimated";
    selected = backtest.componentMaeMin <= backtest.persistenceMaeMin ? "component" : "persistence";
  }
  let estimateHours: number | null = null;
  let errors: number[] = [];
  if (selected === "component") {
    estimateHours = baselineHours! + debtHours! + strainHours! + napHours!;
    errors = backtest.componentErrors;
  } else if (selected === "persistence") {
    estimateHours = lastNight!.need.total_including_debt;
    errors = backtest.persistenceErrors;
  }
  const p80 = errors.length > 0 ? percentile(errors, ESTIMATE_RANGE_PERCENTILE) : null;
  const efficiency = typicalEfficiency(index);

  // --- Notes ----------------------------------------------------------------------------
  const notes: string[] = [];
  const warnings: string[] = [];
  if (status === "unavailable") {
    notes.push(
      "WHOOP cycle or sleep data could not be read (WHOOP returned data in an unexpected format), so there is no estimate. This does not mean nothing was recorded."
    );
  } else if (status === "no_current_cycle") {
    notes.push(
      newestCycle
        ? `There is no current WHOOP cycle: the latest cycle ended ${localStamp(newestCycle.end!, newestCycle.timezone_offset)}, when WHOOP detected a new sleep, and the next cycle has not synced yet (WHOOP creates it once that sleep is processed). There is no estimate until then.`
        : `No WHOOP cycles were found in the last ${plural(historyDays, "day")}, so there is no current cycle and no estimate.`
    );
  } else if (status === "last_night_unavailable") {
    notes.push(
      !lastNightSleep
        ? "No main sleep is linked to the current cycle yet, so last night's WHOOP sleep need, and an estimate for the next sleep, are not available."
        : lastNightSleep.score_state === "PENDING_SCORE"
          ? "Last night's sleep is still being scored by WHOOP, so its sleep need, and an estimate for the next sleep, are not available yet."
          : "Last night's sleep could not be scored by WHOOP, so its sleep need, and an estimate for the next sleep, are not available."
    );
  } else if (status === "insufficient_history") {
    const reasons: string[] = [];
    if (pairs.length < STRAIN_MODEL_MIN_PAIRS)
      reasons.push(
        `${plural(pairs.length, "usable pair")} of consecutive scored nights (the debt component needs ${DEBT_MODEL_MIN_PAIRS}, the strain component ${STRAIN_MODEL_MIN_PAIRS})`
      );
    else if (debtHours === null) reasons.push("the debt component could not be fitted");
    if (strainSoFar === null && strainFit.k !== null)
      reasons.push("today's cycle has no WHOOP strain yet");
    if (inObservedRange === false)
      reasons.push(
        `today's strain so far (${roundTo(strainSoFar!, 1)}) is above the highest cycle strain in the pairs (${roundTo(strainFit.observedMax!, 1)}) by more than ${STRAIN_RANGE_MARGIN}`
      );
    if (napHours === null && todayNaps) {
      if (todayNaps.count === 0)
        reasons.push(
          `${plural(napFreeNonzero, "nap-free pair")} had a nonzero WHOOP nap component, so a nap component of 0 cannot be assumed`
        );
      else if (todayNaps.unscored > 0) reasons.push("a nap today is not scored yet");
      else
        reasons.push(
          `today has a nap, and the nap ratio needs ${NAP_MODEL_MIN_PAIRS} pairs with naps (${napPairs} of ${NAP_MODEL_MIN_PAIRS})`
        );
    }
    if (componentsKnown && backtest.componentMaeMin === null)
      reasons.push(
        `the backtest has ${backtest.pairs} of ${ESTIMATE_MIN_BACKTEST_PAIRS} pairs with every component known`
      );
    notes.push(
      `Not enough history for an estimate: ${reasons.length > 0 ? reasons.join("; ") : "a component is unknown"}. last_night and today_so_far show WHOOP's own figures.`
    );
  } else if (selected === "component") {
    notes.push(
      `The component model's backtest error (${roundTo(backtest.componentMaeMin!, 1)} min mean absolute error over ${plural(backtest.pairs, "pair")}) is not larger than repeating the previous night's WHOOP need (${roundTo(backtest.persistenceMaeMin!, 1)} min), so the estimate is the sum of the components.`
    );
  } else {
    notes.push(
      `The component model's backtest error (${roundTo(backtest.componentMaeMin!, 1)} min mean absolute error over ${plural(backtest.pairs, "pair")}) is larger than repeating the previous night's WHOOP need (${roundTo(backtest.persistenceMaeMin!, 1)} min), so the estimate is last night's WHOOP need including debt (selected_model persistence).`
    );
  }
  if (openCycle && lastNight) {
    // get_today's and get_sync_status's rule: a linked sleep that ended more than
    // STALE_SLEEP_MS ago means no newer sleep has been processed (the morning
    // sync race), so "last night" is the night before.
    const sinceEndMs = nowMs - Date.parse(lastNight.sleep.end);
    if (sinceEndMs > STALE_SLEEP_MS)
      notes.push(
        `last_night is the main sleep that ended ${localStamp(lastNight.sleep.end, lastNight.sleep.timezone_offset)}, about ${Math.round(sinceEndMs / HOUR_MS)} hours ago, and WHOOP has not processed a newer one. A sleep since then is either not processed yet or was not detected, so last_night, today_so_far and any estimate refer to that earlier night and the cycle still open since then.`
      );
    notes.push(
      "The strain component uses the current cycle's strain so far; strain added later in the cycle is not included, and WHOOP sets its own need only when the next sleep is scored."
    );
  }
  notes.push(
    "WHOOP's nap component is 0 or negative (a nap lowers the need); the nap component and nap ratio here keep that sign."
  );
  if (debtFit && debtFit.k !== null)
    notes.push(
      `Debt component: carry fraction ${roundTo(debtFit.k, 4)} × the previous night's shortfall (variant ${debtFit.variant}), fitted on ${plural(pairs.length, "pair")}.`
    );
  if (calibratingPairs > 0)
    notes.push(
      `${calibratingPairs} of ${plural(pairs.length, "pair")} ${calibratingPairs === 1 ? "has" : "have"} a recovery WHOOP flagged as calibrating; calibrating pairs are kept.`
    );
  const excludedTotal = Object.values(excluded).reduce((sum, count) => sum + count, 0);
  if (excludedTotal > 0)
    notes.push(
      `${plural(excludedTotal, "pair")} of consecutive nights ${excludedTotal === 1 ? "was" : "were"} not used (history.excluded): an unscored sleep, a cycle shorter than 12 or longer than 36 hours, an unscored cycle strain, or an unscored nap between them.`
    );
  const windowStartMs = localMidnightMs(firstDay, userOffset);
  notes.push(...historyTruncationNotes("cycle", cycle, windowStartMs, userOffset));
  notes.push(...historyTruncationNotes("sleep", sleep, windowStartMs, userOffset));
  notes.push(...historyTruncationNotes("recovery", recovery, windowStartMs, userOffset));
  if (args.wake_time !== undefined)
    notes.push(
      efficiency.pct === null
        ? `in_bed_arithmetic needs WHOOP efficiency on ${EFFICIENCY_MIN_NIGHTS} of the newest ${EFFICIENCY_RECENT_NIGHTS} scored nights (${efficiency.nights} found).`
        : "in_bed_arithmetic is arithmetic on the estimate and the typical WHOOP efficiency; it ignores the time taken to fall asleep."
    );
  if (!recoveriesReadable)
    warnings.push(
      `Recovery data could not be read (${recovery.quality.status === "fetch_failed" ? "the WHOOP request failed" : "unexpected format"}), so calibration flags are unknown: last_night.calibrating is null and calibrating_pairs counts none.`
    );

  // --- Quality ------------------------------------------------------------------------
  const usedSleeps = new Map<string, Sleep>();
  const usedCycles = new Map<number, Cycle>();
  const usedRecoveries = new Map<number, Recovery>();
  for (const pair of pairs) {
    usedSleeps.set(pair.previous.sleep.id, pair.previous.sleep);
    usedSleeps.set(pair.next.sleep.id, pair.next.sleep);
    usedCycles.set(pair.cycle.id, pair.cycle);
    for (const night of [pair.previous, pair.next]) {
      const joined = recoveryFor(index, night.sleep);
      if (joined) usedRecoveries.set(joined.cycle_id, joined);
    }
  }
  if (lastNight) usedSleeps.set(lastNight.sleep.id, lastNight.sleep);
  if (openCycle) usedCycles.set(openCycle.id, openCycle);
  if (lastNightRecovery) usedRecoveries.set(lastNightRecovery.cycle_id, lastNightRecovery);
  finishQuality(sleep.quality, [...usedSleeps.values()]);
  finishQuality(cycle.quality, [...usedCycles.values()]);
  finishQuality(recovery.quality, [...usedRecoveries.values()]);
  const truncated = [cycle, sleep, recovery].some((source) => source.quality.truncated);
  const oldestPair = pairs[0];
  const observedEnd = lastNight?.sleep ?? pairs[pairs.length - 1]?.next.sleep;

  const debtOut = debtFit ?? fitDebtModel([], "A");
  return {
    evaluated_at_local: formatLocalTimestamp(nowMs, offset),
    status,
    label: SLEEP_NEED_LABEL,
    last_night: lastNight
      ? {
          date: localDay(lastNight.sleep.end, lastNight.sleep.timezone_offset),
          whoop_need: roundNeed(lastNight.need),
          asleep_hours: roundTo(lastNight.asleepHours, 2),
          performance_pct: roundTo(lastNight.sleep.score?.sleep_performance_percentage ?? null, 1),
          calibrating: lastNightRecovery?.score?.user_calibrating ?? null,
        }
      : null,
    today_so_far:
      openCycle && todayNaps
        ? {
            cycle_started_local: formatLocalTimestamp(
              Date.parse(openCycle.start),
              openCycle.timezone_offset
            ),
            strain_so_far: roundTo(strainSoFar, 2),
            strain_in_progress: true,
            naps: {
              count: todayNaps.count,
              asleep_hours: todayNaps.unscored > 0 ? null : roundTo(todayNaps.asleepHours, 2),
              unscored: todayNaps.unscored,
            },
          }
        : null,
    components: {
      baseline: {
        hours: roundTo(baselineHours, 2),
        method: "latest_whoop_baseline",
        source_date: lastNight
          ? localDay(lastNight.sleep.end, lastNight.sleep.timezone_offset)
          : null,
      },
      debt: {
        hours: roundTo(debtHours, 2),
        method: "carry_fraction",
        variant: debtFit?.variant ?? null,
        carry_fraction: roundTo(debtOut.k, 4),
        pairs: pairs.length,
        required: DEBT_MODEL_MIN_PAIRS,
        loo_mae_min: minutes(debtOut.maeMin),
        exact_match_rate: roundTo(debtOut.exactMatchRate, 3),
      },
      strain: {
        hours: roundTo(strainHours, 2),
        method: "k_nearest_median",
        k: strainFit.k,
        pairs: pairs.length,
        required: STRAIN_MODEL_MIN_PAIRS,
        loo_mae_min: minutes(strainFit.maeMin),
        observed_max_strain: roundTo(strainFit.observedMax, 2),
        in_observed_range: inObservedRange,
        basis: "strain_so_far",
      },
      nap: {
        hours: roundTo(napHours, 2),
        method: todayNaps && todayNaps.count > 0 ? "ratio_of_nap_asleep" : "none_today",
        ratio: roundTo(ratio, 3),
        pairs: napPairs,
        required: NAP_MODEL_MIN_PAIRS,
        nap_free_nonzero_count: napFreeNonzero,
      },
    },
    estimate: {
      hours: roundTo(estimateHours, 2),
      range_hours:
        estimateHours !== null && p80 !== null
          ? {
              low: roundTo(Math.max(0, estimateHours - p80), 2),
              high: roundTo(estimateHours + p80, 2),
            }
          : null,
      selected_model: selected,
      backtest: {
        pairs: backtest.pairs,
        component_mae_min: minutes(backtest.componentMaeMin),
        persistence_mae_min: minutes(backtest.persistenceMaeMin),
        p80_abs_error_min: p80 === null ? null : roundTo(p80 * 60, 1),
      },
    },
    in_bed_arithmetic:
      args.wake_time === undefined
        ? null
        : inBedArithmetic({
            estimateHours,
            efficiencyPct: efficiency.pct,
            efficiencyNights: efficiency.nights,
            wakeTime: args.wake_time,
            nowMs,
            offset,
          }),
    history: {
      days: historyDays,
      first_day: firstDay,
      pairs: pairs.length,
      calibrating_pairs: calibratingPairs,
      excluded,
    },
    truncated,
    notes: withOffsetNote(notes, offsetInfo.fallback),
    warnings,
    disclaimer: DISCLAIMER,
    data_quality: {
      evaluated_at: formatLocalTimestamp(nowMs, offset),
      requested_period: {
        start: formatLocalTimestamp(windowStartMs, userOffset),
        end: formatLocalTimestamp(nowMs, userOffset),
      },
      observed_period:
        oldestPair && observedEnd
          ? {
              start: formatLocalTimestamp(
                Date.parse(oldestPair.previous.sleep.start),
                oldestPair.previous.sleep.timezone_offset
              ),
              end: formatLocalTimestamp(Date.parse(observedEnd.end), observedEnd.timezone_offset),
            }
          : lastNight
            ? {
                start: formatLocalTimestamp(
                  Date.parse(lastNight.sleep.start),
                  lastNight.sleep.timezone_offset
                ),
                end: formatLocalTimestamp(
                  Date.parse(lastNight.sleep.end),
                  lastNight.sleep.timezone_offset
                ),
              }
            : null,
      sources: { cycle: cycle.quality, sleep: sleep.quality, recovery: recovery.quality },
      method_version: "sleep-need-1",
      limitations: [
        ...HISTORY_LIMITATIONS,
        "WHOOP's sleep-need algorithm is proprietary: each component is a statistical fit to past WHOOP records (pairs of consecutive scored main sleeps), checked by leave-one-out backtests against repeating the previous night's WHOOP need.",
        `Pairs need both sleeps scored, a cycle of 12-36 hours between them with a WHOOP strain, and scored naps; the debt component needs ${DEBT_MODEL_MIN_PAIRS} pairs, the strain component ${STRAIN_MODEL_MIN_PAIRS} and the nap ratio ${NAP_MODEL_MIN_PAIRS} pairs with naps.`,
        "The strain component is evaluated at the current cycle's strain so far, which can still rise before the next sleep.",
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Definition
// ---------------------------------------------------------------------------

export const getSleepNeedTool = defineTool({
  name: "get_sleep_need",
  annotations: { readOnlyHint: true },
  standard: {
    title: "Sleep need estimate",
    description:
      "A statistical estimate of the WHOOP sleep need for the next sleep, from your past WHOOP sleep-need records only (not WHOOP Sleep Planner, not a recommendation). Components: last night's WHOOP baseline; debt as a fitted carry fraction of last night's shortfall; strain from the nearest past cycle strains to today's strain so far; naps (0 or negative). The component sum is backtested against repeating last night's WHOOP need; status is estimated only with enough pairs of consecutive scored nights (7 for debt, 10 for strain) and every component known, and the more accurate model is used, with a range from its backtest errors. Also returns last night's WHOOP need and today's strain so far. With wake_time, in_bed_arithmetic divides the estimate by the typical WHOOP efficiency (ignores time to fall asleep). Status no_current_cycle or last_night_unavailable when WHOOP has not processed the cycle or sleep yet.",
    inputSchema: sleepNeedInputSchema,
    outputSchema: sleepNeedOutputSchema,
    run: runSleepNeed,
  },
});
