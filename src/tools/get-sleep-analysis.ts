/**
 * Tool: get_sleep_analysis
 *
 * Describes main sleeps over a window: distributions of duration, WHOOP's
 * efficiency, performance and consistency, disturbances, sleep cycles and
 * respiratory rate; time-weighted stage shares; WHOOP's sleep-need components;
 * bed and wake timing; naps (kept separate); and one row per night.
 *
 * - The window is get_sleep_debt's (resolveSleepWindow) and a night is the main
 *   sleep that ended in it, one per wake day (buildNights), so the nights and
 *   their dates match get_sleep_debt for the same arguments.
 * - Only SCORED nights feed statistics. Pending and unscorable nights are
 *   listed and counted. Nights with low data coverage are listed and flagged
 *   but left out of duration, stage and disturbance statistics.
 * - Sleep hours are light + slow-wave + REM; naps are never added.
 * - Values are aggregated unrounded and rounded only at output.
 */

import { z } from "zod";
import { WhoopRateBudgetError } from "../api/client.js";
import { ENDPOINT_RECOVERY, ENDPOINT_SLEEP } from "../api/endpoints.js";
import {
  createHistoryBudget,
  HISTORY_DEADLINE_MS,
  HISTORY_LIMITATIONS,
  loadHistory,
  type HistorySource,
} from "../api/history.js";
import { recoveryRecordSchema, sleepRecordSchema } from "../api/record-schemas.js";
import type { Sleep } from "../api/types.js";
import {
  dataQualitySchema,
  DAY_MS,
  DISCLAIMER,
  exclude,
  finishQuality,
  formatLocalTimestamp,
  localDay,
  mostRelevantError,
} from "./analytics-utils.js";
import { resolveUserUtcOffsetInfo, withOffsetNote } from "./collection-utils.js";
import { InvalidDateExpression } from "./date-utils.js";
import { buildNights, localClock, placeDays, type Night } from "./day-model.js";
import { SLEEP_DEBT_MAX_DAYS, SLEEP_DEBT_MIN_NIGHTS } from "./get-sleep-debt.js";
import {
  LOW_DATA_COVERAGE_FRACTION,
  MIN_ASLEEP_MINUTES_FOR_RATES,
  needBreakdown,
  stageBreakdown,
  timingStats,
  whoopConsistency,
  type NeedBreakdown,
  type StageBreakdown,
} from "./sleep-metrics.js";
import { resolveSleepWindow } from "./sleep-window.js";
import { mean, median, percentile, roundTo, sampleStandardDeviation } from "./stats-utils.js";
import { defineTool, type ToolContext } from "./tool-definition.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Scored main sleeps needed before any statistic is reported (= SLEEP_DEBT_MIN_NIGHTS). */
export const SLEEP_ANALYSIS_MIN_NIGHTS = SLEEP_DEBT_MIN_NIGHTS;

/** Longest window in days (a range expression may add the partial current day). */
export const SLEEP_ANALYSIS_MAX_DAYS = SLEEP_DEBT_MAX_DAYS;

/** Window length without `days`. */
export const SLEEP_ANALYSIS_DEFAULT_DAYS = 14;

/** Most night rows listed (newest first). */
export const SLEEP_ANALYSIS_MAX_NIGHT_ROWS = 31;

/** Weekday and weekend nights each needed for the midpoint means and social jetlag. */
export const TIMING_MIN_NIGHTS_PER_GROUP = 2;

/** Extra days read before the window, so records spanning its start are included. */
const LOAD_MARGIN_MS = 2 * DAY_MS;

const MINUTE_MS = 60_000;

// ---------------------------------------------------------------------------
// Shared helpers (also used by get_recovery_analysis and get_sleep_need)
// ---------------------------------------------------------------------------

/** A distribution summary; statistics are null below the minimum sample size. */
export const distributionSchema = z.object({
  n: z.number().int().describe("Values used"),
  mean: z.number().nullable(),
  median: z.number().nullable(),
  p25: z.number().nullable(),
  p75: z.number().nullable(),
  sd: z.number().nullable().describe("Sample standard deviation"),
});
export type Distribution = z.infer<typeof distributionSchema>;

/**
 * Mean, median, quartiles (linear interpolation) and sample SD of `values`,
 * rounded to `digits`; all null when there are fewer than `min` values.
 */
export function distribution(values: readonly number[], digits: number, min: number): Distribution {
  const n = values.length;
  if (n === 0 || n < min) return { n, mean: null, median: null, p25: null, p75: null, sd: null };
  const list = [...values];
  return {
    n,
    mean: roundTo(mean(list), digits),
    median: roundTo(median(list), digits),
    p25: roundTo(percentile(list, 25), digits),
    p75: roundTo(percentile(list, 75), digits),
    sd: roundTo(sampleStandardDeviation(list), digits),
  };
}

/** "3 nights" / "1 night" */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** Local clock time "HH:MM" of an instant in `offset`. */
export function clockHHMM(timestamp: string, offset: string): string {
  return localClock(timestamp, offset).slice(11, 16);
}

/** "HH:MM" of a minute of the day (wrapped to 0-1439, rounded to the minute). */
export function minutesToHHMM(minutes: number): string {
  const wrapped = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`;
}

/** WHOOP's sleep-need components in hours, rounded for output. */
export const needHoursSchema = z.object({
  baseline: z.number(),
  debt: z.number(),
  strain: z.number(),
  nap: z.number().describe("0 or negative: a nap lowers the need"),
  total_including_debt: z.number(),
  total_excluding_debt: z.number().describe("get_sleep_debt needed_hours"),
});

/** A needBreakdown rounded to 2 decimals. */
export function roundNeed(need: NeedBreakdown): z.infer<typeof needHoursSchema> {
  return {
    baseline: roundTo(need.baseline, 2),
    debt: roundTo(need.debt, 2),
    strain: roundTo(need.strain, 2),
    nap: roundTo(need.nap, 2),
    total_including_debt: roundTo(need.total_including_debt, 2),
    total_excluding_debt: roundTo(need.total_excluding_debt, 2),
  };
}

/**
 * A note when a history source was not read completely (C11): from when its
 * records are complete, or that they are not complete at all, and whether a
 * WHOOP page failed or the request budget ran out. Empty when the source is
 * complete.
 */
export function historyTruncationNotes(
  label: string,
  source: Pick<HistorySource<unknown>, "quality" | "complete_since" | "partialError">,
  windowStartMs: number,
  offset: string
): string[] {
  if (!source.quality.truncated || source.quality.status === "fetch_failed") return [];
  const since = source.complete_since;
  const pageFailed =
    source.partialError !== undefined && !(source.partialError instanceof WhoopRateBudgetError);
  const budget = pageFailed
    ? "(a WHOOP page could not be read); repeating the request may complete it"
    : "within this request's WHOOP request and time budget; repeating the request continues from the cache";
  if (since === null)
    return [
      `Partial history: ${label} records could not be read completely ${budget}, so records in the window may be missing.`,
    ];
  if (Date.parse(since) > windowStartMs)
    return [
      `Partial history: ${label} records are complete only from ${localClock(since, offset)} (local); older records in the window were not read ${budget}.`,
    ];
  return [
    `Partial history: some ${label} records just outside the window could not be read ${budget}; the window itself is complete.`,
  ];
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const sleepAnalysisInputSchema = z.object({
  days: z
    .number()
    .int()
    .min(3)
    .max(SLEEP_ANALYSIS_MAX_DAYS)
    .optional()
    .describe(
      "Window length in days (3-90). Default: 14. Without `start` the window ends now; with `start` it runs forward from it, clamped to now (same as get_sleep_debt)."
    ),
  start: z
    .string()
    .max(100)
    .optional()
    .describe(
      'Window start, as in get_sleep_debt: a day ("yesterday", "2026-09-01") or date-time starts a window of `days`; a range expression ("last 2 weeks", "this month", "2026-08") covers that range unless `days` is given. Default: `days` before now.'
    ),
  include_nights: z
    .boolean()
    .optional()
    .describe(`List one row per night (newest ${SLEEP_ANALYSIS_MAX_NIGHT_ROWS}). Default: true.`),
  include_naps: z.boolean().optional().describe("Summarize naps separately. Default: true."),
});

/**
 * Why a night's consistency_pct is null: WHOOP reported 0 while calibrating;
 * reported nothing; the sleep is not scored; or WHOOP reported 0 and no
 * recovery for the sleep could be read to check the calibration flag.
 */
const CONSISTENCY_REASONS = [
  "zero_during_calibration",
  "not_reported",
  "not_scored",
  "calibration_unknown",
] as const;

const NIGHT_FLAGS = [
  "pending_score",
  "unscorable",
  "low_data_coverage",
  "stage_sum_mismatch",
  "calibrating",
  "invalid_need",
] as const;
type NightFlag = (typeof NIGHT_FLAGS)[number];

const nightRowSchema = z.object({
  date: z.string().describe("Local day the sleep ended (wake day)"),
  score_state: z.enum(["SCORED", "PENDING_SCORE", "UNSCORABLE"]),
  bedtime_local: z.string().describe("HH:MM in utc_offset"),
  waketime_local: z.string().describe("HH:MM in utc_offset"),
  utc_offset: z.string(),
  asleep_hours: z.number().nullable().describe("Light + slow-wave + REM"),
  in_bed_hours: z.number().nullable(),
  light_min: z.number().nullable(),
  sws_min: z.number().nullable(),
  rem_min: z.number().nullable(),
  awake_min: z.number().nullable(),
  no_data_min: z.number().nullable(),
  light_pct: z.number().nullable().describe("Share of time asleep"),
  sws_pct: z.number().nullable().describe("Share of time asleep"),
  rem_pct: z.number().nullable().describe("Share of time asleep"),
  efficiency_pct: z.number().nullable(),
  performance_pct: z.number().nullable(),
  consistency_pct: z.number().nullable(),
  consistency_reason: z.enum(CONSISTENCY_REASONS).nullable(),
  disturbances: z.number().nullable(),
  disturbances_per_hour: z
    .number()
    .nullable()
    .describe(`Per hour asleep; null below ${MIN_ASLEEP_MINUTES_FOR_RATES} minutes asleep`),
  sleep_cycles: z.number().nullable(),
  respiratory_rate: z.number().nullable(),
  need: needHoursSchema.nullable().describe("WHOOP's sleep need for this night, hours"),
  recovery_calibrating: z.boolean().nullable(),
  flags: z.array(z.enum(NIGHT_FLAGS)),
});

const meanNSchema = z.object({ mean: z.number().nullable(), n: z.number().int() });

export const sleepAnalysisOutputSchema = z.object({
  period: z.object({ start: z.string(), end: z.string() }),
  status: z
    .enum(["available", "insufficient_data", "unavailable"])
    .describe(
      "available: at least nights_required scored nights. insufficient_data: fewer (statistics null, nights still listed). unavailable: sleep data could not be read."
    ),
  nights_required: z.number().int(),
  nights_analyzed: z.number().int().describe("Scored nights used for statistics"),
  summary: z
    .object({
      asleep_hours: distributionSchema.nullable(),
      in_bed_hours: distributionSchema.nullable(),
      efficiency_pct: distributionSchema.nullable().describe("WHOOP sleep efficiency"),
      performance_pct: distributionSchema.nullable().describe("WHOOP sleep performance"),
      consistency_pct: distributionSchema
        .nullable()
        .describe("WHOOP sleep consistency; zeros reported while calibrating are excluded"),
      disturbances_per_hour: distributionSchema.nullable(),
      sleep_cycles: distributionSchema.nullable(),
      respiratory_rate: distributionSchema.nullable(),
      stage_share_of_asleep: z
        .object({
          n: z.number().int(),
          light_pct: z.number(),
          sws_pct: z.number(),
          rem_pct: z.number(),
        })
        .nullable()
        .describe(
          "Time-weighted shares of time asleep (total stage time / total time asleep), not of time in bed"
        ),
      awake_share_of_in_bed_pct: z.number().nullable().describe("Total awake / total in bed"),
      no_data_share_of_in_bed_pct: z.number().nullable().describe("Total no-data / total in bed"),
    })
    .nullable(),
  need: z
    .object({
      whoop_total_including_debt_hours: meanNSchema,
      total_excluding_debt_hours: meanNSchema.describe("As get_sleep_debt needed_hours"),
      baseline_hours: meanNSchema,
      debt_hours: meanNSchema,
      strain_hours: meanNSchema,
      nap_hours: meanNSchema.describe("0 or negative"),
    })
    .nullable()
    .describe("Means of WHOOP's per-night sleep need components"),
  timing: z
    .object({
      nights_used: z.number().int(),
      weekday_nights: z.number().int(),
      weekend_nights: z.number().int(),
      bedtime_mean_local: z.string().nullable(),
      bedtime_mean_minutes: z.number().nullable(),
      bedtime_sd_minutes: z.number().nullable(),
      waketime_mean_local: z.string().nullable(),
      waketime_mean_minutes: z.number().nullable(),
      waketime_sd_minutes: z.number().nullable(),
      weekday_midpoint_mean_minutes: z.number().nullable(),
      weekend_midpoint_mean_minutes: z.number().nullable(),
      social_jetlag_minutes: z.number().nullable(),
    })
    .nullable()
    .describe("Circular means and SDs of local clock minutes"),
  naps: z
    .object({
      count: z.number().int(),
      days_with_naps: z.number().int(),
      total_asleep_hours: z.number().nullable(),
      mean_duration_min: z.number().nullable().describe("Mean time from nap start to end"),
      unscored: z.number().int(),
    })
    .nullable(),
  nights: z.array(nightRowSchema).max(SLEEP_ANALYSIS_MAX_NIGHT_ROWS),
  output_capped: z.boolean(),
  pending_dates: z.array(z.string()),
  excluded: z.object({
    pending: z.number().int(),
    unscorable: z.number().int(),
    low_data_coverage: z.number().int(),
    duplicate_day: z.number().int(),
    invalid: z.number().int(),
  }),
  truncated: z.boolean(),
  notes: z.array(z.string()),
  warnings: z.array(z.string()),
  disclaimer: z.string(),
  data_quality: dataQualitySchema,
});
export type SleepAnalysisReport = z.infer<typeof sleepAnalysisOutputSchema>;
type NightRow = z.infer<typeof nightRowSchema>;

// ---------------------------------------------------------------------------
// Night evaluation
// ---------------------------------------------------------------------------

interface EvaluatedNight {
  night: Night;
  scored: boolean;
  pending: boolean;
  stages: StageBreakdown | null;
  need: NeedBreakdown | null;
  validNeed: boolean;
  consistency: { value: number | null; reason: NightRow["consistency_reason"] };
  flags: NightFlag[];
}

function evaluateNight(night: Night): EvaluatedNight {
  const sleep = night.sleep;
  const scored =
    sleep.score_state === "SCORED" && sleep.score !== null && sleep.score !== undefined;
  const pending = sleep.score_state === "PENDING_SCORE";
  const stages = scored ? stageBreakdown(sleep) : null;
  const need = scored ? needBreakdown(sleep) : null;
  const validNeed = need !== null && need.total_excluding_debt >= 0;
  let consistency: EvaluatedNight["consistency"];
  if (!scored) consistency = { value: null, reason: "not_scored" };
  else {
    const whoop = whoopConsistency(sleep, night.recovery);
    // WHOOP reports 0 while calibrating. Without a recovery scored for this sleep the
    // calibration flag is unknown, so a 0 is not taken as a real value either.
    consistency =
      whoop.value === 0 && night.recovery?.score == null
        ? { value: null, reason: "calibration_unknown" }
        : whoop;
  }
  const flags: NightFlag[] = [];
  if (pending) flags.push("pending_score");
  else if (!scored) flags.push("unscorable");
  if (scored && night.flags.low_data_coverage) flags.push("low_data_coverage");
  if (scored && night.flags.stage_sum_mismatch) flags.push("stage_sum_mismatch");
  if (night.calibrating === true) flags.push("calibrating");
  if (need !== null && !validNeed) flags.push("invalid_need");
  return { night, scored, pending, stages, need, validNeed, consistency, flags };
}

function nightRow(evaluated: EvaluatedNight): NightRow {
  const { night, stages, need } = evaluated;
  const sleep = night.sleep;
  const score = evaluated.scored ? sleep.score : null;
  const minutes = (value: number | undefined): number | null =>
    value === undefined ? null : roundTo(value, 1);
  return {
    date: night.wake_day,
    score_state: sleep.score_state,
    bedtime_local: clockHHMM(sleep.start, sleep.timezone_offset),
    waketime_local: clockHHMM(sleep.end, sleep.timezone_offset),
    utc_offset: sleep.timezone_offset,
    asleep_hours: stages ? roundTo(stages.asleep_min / 60, 2) : null,
    in_bed_hours: stages ? roundTo(stages.in_bed_min / 60, 2) : null,
    light_min: minutes(stages?.light_min),
    sws_min: minutes(stages?.sws_min),
    rem_min: minutes(stages?.rem_min),
    awake_min: minutes(stages?.awake_min),
    no_data_min: minutes(stages?.no_data_min),
    light_pct: roundTo(stages?.light_pct_of_asleep ?? null, 1),
    sws_pct: roundTo(stages?.sws_pct_of_asleep ?? null, 1),
    rem_pct: roundTo(stages?.rem_pct_of_asleep ?? null, 1),
    efficiency_pct: roundTo(score?.sleep_efficiency_percentage ?? null, 1),
    performance_pct: roundTo(score?.sleep_performance_percentage ?? null, 1),
    consistency_pct: roundTo(evaluated.consistency.value, 1),
    consistency_reason: evaluated.consistency.reason,
    disturbances: stages?.disturbances ?? null,
    disturbances_per_hour: roundTo(stages?.disturbances_per_hour_asleep ?? null, 2),
    sleep_cycles: stages?.sleep_cycles ?? null,
    respiratory_rate: roundTo(score?.respiratory_rate ?? null, 2),
    need: need ? roundNeed(need) : null,
    recovery_calibrating: night.calibrating,
    flags: evaluated.flags,
  };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

function sharePct(part: number, whole: number): number | null {
  return whole > 0 ? roundTo((100 * part) / whole, 1) : null;
}

function meanN(values: readonly number[], min: number): z.infer<typeof meanNSchema> {
  return {
    mean: values.length >= min && values.length > 0 ? roundTo(mean([...values]), 2) : null,
    n: values.length,
  };
}

export async function runSleepAnalysis(
  args: z.infer<typeof sleepAnalysisInputSchema>,
  ctx: ToolContext
): Promise<SleepAnalysisReport> {
  const now = ctx.now();
  const nowMs = now.getTime();
  const days = args.days ?? SLEEP_ANALYSIS_DEFAULT_DAYS;
  const includeNights = args.include_nights ?? true;
  const includeNaps = args.include_naps ?? true;
  const offsetInfo = await resolveUserUtcOffsetInfo(ctx.client);
  const utcOffset = offsetInfo.offset;

  let window: { startTime: number; endTime: number };
  try {
    window = resolveSleepWindow(args.start, args.days, days, now, utcOffset, {
      toolName: "get_sleep_analysis",
      maxDays: SLEEP_ANALYSIS_MAX_DAYS,
    });
  } catch (error: unknown) {
    if (error instanceof RangeError)
      throw new InvalidDateExpression(
        `The sleep window "${args.start ?? ""}" begins at or after the current time; get_sleep_analysis needs a window that starts in the past.`
      );
    throw error;
  }
  const { startTime, endTime } = window;

  const budget = createHistoryBudget({ deadlineMs: ctx.startedAtMs + HISTORY_DEADLINE_MS });
  const loadPeriod = {
    start: new Date(startTime - LOAD_MARGIN_MS).toISOString(),
    end: new Date(Math.min(endTime + DAY_MS, nowMs)).toISOString(),
  };
  const options = { budget, now: (): Date => ctx.now(), cache: ctx.historyCache };
  const [sleep, recovery] = await Promise.all([
    loadHistory(ctx.client, ENDPOINT_SLEEP, loadPeriod, sleepRecordSchema, options),
    loadHistory(ctx.client, ENDPOINT_RECOVERY, loadPeriod, recoveryRecordSchema, options),
  ]);
  if (sleep.quality.status === "fetch_failed") {
    throw mostRelevantError(
      recovery.quality.status === "fetch_failed" ? [sleep.error, recovery.error] : [sleep.error]
    );
  }
  const sleepReadable = sleep.quality.status !== "invalid";
  const recoveriesReadable =
    recovery.quality.status !== "fetch_failed" && recovery.quality.status !== "invalid";

  const inWindow = (record: Sleep): boolean => {
    const endMs = Date.parse(record.end);
    return endMs >= startTime && endMs < endTime;
  };
  const windowMainSleeps = sleep.records.filter((record) => !record.nap && inWindow(record));
  const windowNaps = sleep.records.filter(
    (record) => record.nap && inWindow(record) && Date.parse(record.end) > Date.parse(record.start)
  );
  const placement = placeDays({
    cycles: [],
    sleeps: windowMainSleeps,
    recoveries: recoveriesReadable ? recovery.records : [],
    sleepsAvailable: sleepReadable,
    today: localDay(now.toISOString(), utcOffset),
    utcOffset,
  });
  const built = buildNights({
    sleeps: windowMainSleeps,
    cycles: [],
    recoveries: recoveriesReadable ? recovery.records : [],
    workouts: null,
    workoutsCompleteSince: null,
    placement,
    nowMs,
  });
  const evaluated = built.nights.map((night) => evaluateNight(night));
  const scored = evaluated.filter((item) => item.scored);
  const pendingNights = evaluated.filter((item) => item.pending);
  const unscorable = evaluated.filter((item) => !item.scored && !item.pending);
  const covered = scored.filter((item) => !item.night.flags.low_data_coverage);
  const lowCoverage = scored.length - covered.length;
  const invalidRecords = (sleep.quality.exclusions.invalid ?? 0) + built.excluded.invalid_duration;

  const excludeTimes = (reason: string, count: number): void => {
    for (let i = 0; i < count; i++) exclude(sleep.quality, reason);
  };
  excludeTimes("pending", pendingNights.length);
  excludeTimes("unscored", unscorable.length);
  excludeTimes("duplicate_day", built.excluded.duplicate_day);
  excludeTimes("invalid_duration", built.excluded.invalid_duration);
  excludeTimes("low_data_coverage_for_stages", lowCoverage);

  const status = !sleepReadable
    ? "unavailable"
    : scored.length >= SLEEP_ANALYSIS_MIN_NIGHTS
      ? "available"
      : "insufficient_data";
  const sufficient = status === "available";
  const min = SLEEP_ANALYSIS_MIN_NIGHTS;

  // --- Summary -----------------------------------------------------------------
  const stagesOf = (items: EvaluatedNight[]): StageBreakdown[] =>
    items.flatMap((item) => (item.stages ? [item.stages] : []));
  const coveredStages = stagesOf(covered);
  const scoreValues = (
    pick: (score: NonNullable<Sleep["score"]>) => number | null | undefined
  ): number[] =>
    scored.flatMap((item) => {
      const value = item.night.sleep.score ? pick(item.night.sleep.score) : null;
      return value === null || value === undefined ? [] : [value];
    });
  const consistencyValues = scored.flatMap((item) =>
    item.consistency.value === null ? [] : [item.consistency.value]
  );
  const calibrationZeros = scored.filter(
    (item) => item.consistency.reason === "zero_during_calibration"
  ).length;
  const calibrationUnknownZeros = scored.filter(
    (item) => item.consistency.reason === "calibration_unknown"
  ).length;

  let summary: SleepAnalysisReport["summary"] = null;
  if (sufficient) {
    const totals = coveredStages.reduce(
      (sum, stage) => ({
        asleep: sum.asleep + stage.asleep_min,
        inBed: sum.inBed + stage.in_bed_min,
        light: sum.light + stage.light_min,
        sws: sum.sws + stage.sws_min,
        rem: sum.rem + stage.rem_min,
        awake: sum.awake + stage.awake_min,
        noData: sum.noData + stage.no_data_min,
      }),
      { asleep: 0, inBed: 0, light: 0, sws: 0, rem: 0, awake: 0, noData: 0 }
    );
    const sharesKnown = coveredStages.length >= min && totals.asleep > 0;
    summary = {
      asleep_hours: distribution(
        coveredStages.map((stage) => stage.asleep_min / 60),
        2,
        min
      ),
      in_bed_hours: distribution(
        coveredStages.map((stage) => stage.in_bed_min / 60),
        2,
        min
      ),
      efficiency_pct: distribution(
        scoreValues((score) => score.sleep_efficiency_percentage),
        1,
        min
      ),
      performance_pct: distribution(
        scoreValues((score) => score.sleep_performance_percentage),
        1,
        min
      ),
      consistency_pct: distribution(consistencyValues, 1, min),
      disturbances_per_hour: distribution(
        coveredStages.flatMap((stage) =>
          stage.disturbances_per_hour_asleep === null ? [] : [stage.disturbances_per_hour_asleep]
        ),
        2,
        min
      ),
      sleep_cycles: distribution(
        coveredStages.map((stage) => stage.sleep_cycles),
        2,
        min
      ),
      respiratory_rate: distribution(
        scoreValues((score) => score.respiratory_rate),
        2,
        min
      ),
      stage_share_of_asleep: sharesKnown
        ? {
            n: coveredStages.length,
            light_pct: roundTo((100 * totals.light) / totals.asleep, 1),
            sws_pct: roundTo((100 * totals.sws) / totals.asleep, 1),
            rem_pct: roundTo((100 * totals.rem) / totals.asleep, 1),
          }
        : null,
      awake_share_of_in_bed_pct:
        coveredStages.length >= min ? sharePct(totals.awake, totals.inBed) : null,
      no_data_share_of_in_bed_pct:
        coveredStages.length >= min ? sharePct(totals.noData, totals.inBed) : null,
    };
  }

  // --- Need -----------------------------------------------------------------------
  const needs = scored.flatMap((item) => (item.need && item.validNeed ? [item.need] : []));
  const need: SleepAnalysisReport["need"] = sufficient
    ? {
        whoop_total_including_debt_hours: meanN(
          needs.map((value) => value.total_including_debt),
          min
        ),
        total_excluding_debt_hours: meanN(
          needs.map((value) => value.total_excluding_debt),
          min
        ),
        baseline_hours: meanN(
          needs.map((value) => value.baseline),
          min
        ),
        debt_hours: meanN(
          needs.map((value) => value.debt),
          min
        ),
        strain_hours: meanN(
          needs.map((value) => value.strain),
          min
        ),
        nap_hours: meanN(
          needs.map((value) => value.nap),
          min
        ),
      }
    : null;

  // --- Timing -----------------------------------------------------------------------
  let timing: SleepAnalysisReport["timing"] = null;
  if (sufficient) {
    const stats = timingStats(scored.map((item) => item.night.sleep));
    const weekdayOk = stats.weekday_nights >= TIMING_MIN_NIGHTS_PER_GROUP;
    const weekendOk = stats.weekend_nights >= TIMING_MIN_NIGHTS_PER_GROUP;
    timing = {
      nights_used: stats.nights,
      weekday_nights: stats.weekday_nights,
      weekend_nights: stats.weekend_nights,
      bedtime_mean_local:
        stats.bedtime_mean_minutes === null ? null : minutesToHHMM(stats.bedtime_mean_minutes),
      bedtime_mean_minutes: roundTo(stats.bedtime_mean_minutes, 1),
      bedtime_sd_minutes: roundTo(stats.bedtime_sd_minutes, 1),
      waketime_mean_local:
        stats.waketime_mean_minutes === null ? null : minutesToHHMM(stats.waketime_mean_minutes),
      waketime_mean_minutes: roundTo(stats.waketime_mean_minutes, 1),
      waketime_sd_minutes: roundTo(stats.waketime_sd_minutes, 1),
      weekday_midpoint_mean_minutes: weekdayOk
        ? roundTo(stats.weekday_midpoint_mean_minutes, 1)
        : null,
      weekend_midpoint_mean_minutes: weekendOk
        ? roundTo(stats.weekend_midpoint_mean_minutes, 1)
        : null,
      social_jetlag_minutes:
        weekdayOk && weekendOk ? roundTo(stats.social_jetlag_minutes, 1) : null,
    };
  }

  // --- Naps -------------------------------------------------------------------------
  let naps: SleepAnalysisReport["naps"] = null;
  if (includeNaps) {
    const scoredNaps = windowNaps.filter(
      (nap) => nap.score_state === "SCORED" && nap.score !== null && nap.score !== undefined
    );
    const napAsleepHours = scoredNaps.map((nap) => (stageBreakdown(nap)?.asleep_min ?? 0) / 60);
    naps = {
      count: windowNaps.length,
      days_with_naps: new Set(windowNaps.map((nap) => localDay(nap.end, nap.timezone_offset))).size,
      total_asleep_hours:
        windowNaps.length === 0
          ? 0
          : scoredNaps.length === 0
            ? null
            : roundTo(
                napAsleepHours.reduce((sum, value) => sum + value, 0),
                2
              ),
      mean_duration_min:
        windowNaps.length === 0
          ? null
          : roundTo(
              mean(
                windowNaps.map((nap) => (Date.parse(nap.end) - Date.parse(nap.start)) / MINUTE_MS)
              ),
              1
            ),
      unscored: windowNaps.length - scoredNaps.length,
    };
  }

  // --- Rows ---------------------------------------------------------------------------
  const rows = includeNights
    ? evaluated.slice(0, SLEEP_ANALYSIS_MAX_NIGHT_ROWS).map((item) => nightRow(item))
    : [];
  const outputCapped = includeNights && evaluated.length > SLEEP_ANALYSIS_MAX_NIGHT_ROWS;

  // --- Quality ------------------------------------------------------------------------
  finishQuality(
    sleep.quality,
    scored.map((item) => item.night.sleep)
  );
  const usedRecoveries = scored.flatMap((item) =>
    item.night.recovery ? [item.night.recovery] : []
  );
  finishQuality(recovery.quality, usedRecoveries);
  const truncated = sleep.quality.truncated || recovery.quality.truncated;

  // --- Notes --------------------------------------------------------------------------
  const notes: string[] = [];
  const warnings: string[] = [];
  if (status === "unavailable")
    notes.push(
      "Sleep data could not be read: WHOOP returned data in an unexpected format, so no statistics were calculated. This does not mean no sleep was recorded."
    );
  else if (status === "insufficient_data")
    notes.push(
      `Not enough data yet: ${scored.length} of ${SLEEP_ANALYSIS_MIN_NIGHTS} required scored main sleeps in this window, so summary, need and timing statistics are null; the nights that exist are still listed.`
    );
  if (pendingNights.length)
    notes.push(
      `${plural(pendingNights.length, "night")} (pending_dates) ${pendingNights.length === 1 ? "is" : "are"} still being scored by WHOOP and not counted yet.`
    );
  if (unscorable.length)
    notes.push(
      `${plural(unscorable.length, "night")} could not be scored by WHOOP; ${unscorable.length === 1 ? "it is" : "they are"} listed but not counted.`
    );
  if (lowCoverage)
    notes.push(
      `${plural(lowCoverage, "scored night")} ${lowCoverage === 1 ? "has" : "have"} no-data time above ${Math.round(LOW_DATA_COVERAGE_FRACTION * 100)}% of time in bed (flag low_data_coverage): listed and counted for efficiency, performance, consistency, respiratory rate, need and timing, but not for duration, stage, disturbance or sleep-cycle statistics.`
    );
  if (calibrationZeros)
    notes.push(
      `WHOOP reported a sleep consistency of 0 for ${plural(calibrationZeros, "night")} while it was still calibrating; those zeros are not real values, so they are null and excluded from consistency_pct (consistency_reason zero_during_calibration).`
    );
  if (calibrationUnknownZeros)
    notes.push(
      `WHOOP reported a sleep consistency of 0 for ${plural(calibrationUnknownZeros, "night")} without a readable recovery for that sleep, so WHOOP's calibration flag could not be checked; those zeros are null and excluded from consistency_pct (consistency_reason calibration_unknown).`
    );
  if (built.excluded.duplicate_day)
    notes.push(
      `${plural(built.excluded.duplicate_day, "additional main sleep")} ended on a wake day that already had a scored or longer main sleep and ${built.excluded.duplicate_day === 1 ? "was" : "were"} not counted separately.`
    );
  if (invalidRecords)
    notes.push(
      `${plural(invalidRecords, "sleep record")} read from WHOOP did not match the expected format or had no duration and ${invalidRecords === 1 ? "was" : "were"} skipped.`
    );
  if (summary) {
    const nullable: Array<[string, Distribution | null]> = [
      ["efficiency_pct", summary.efficiency_pct],
      ["performance_pct", summary.performance_pct],
      ["consistency_pct", summary.consistency_pct],
      ["respiratory_rate", summary.respiratory_rate],
      ["asleep_hours", summary.asleep_hours],
      ["disturbances_per_hour", summary.disturbances_per_hour],
    ];
    for (const [name, value] of nullable)
      if (value && value.n < min)
        notes.push(
          `${name}: ${value.n} of ${min} required nights with a value, so its statistics are null.`
        );
    notes.push(
      "Stage shares are time-weighted (total stage time / total time asleep over the nights) and are shares of time asleep, not of time in bed; they differ from an average of nightly shares."
    );
  }
  if (need)
    notes.push(
      "need averages WHOOP's own nightly sleep-need components; whoop_total_including_debt_hours includes the sleep-debt component, while get_sleep_debt's needed_hours (total_excluding_debt_hours here) excludes it."
    );
  if (
    timing &&
    (timing.weekday_midpoint_mean_minutes === null || timing.social_jetlag_minutes === null)
  )
    notes.push(
      `Weekday and weekend midpoints need ${TIMING_MIN_NIGHTS_PER_GROUP} nights each (weekday ${timing.weekday_nights}, weekend ${timing.weekend_nights}); social jetlag is null until both have them.`
    );
  if (naps)
    notes.push(
      "Naps are summarized separately and never added to asleep hours; WHOOP's nap need is 0 or negative (a nap lowers the need)."
    );
  if (outputCapped)
    notes.push(
      `Only the newest ${SLEEP_ANALYSIS_MAX_NIGHT_ROWS} of ${evaluated.length} nights are listed in nights; statistics use all of them.`
    );
  notes.push(...historyTruncationNotes("sleep", sleep, startTime, utcOffset));
  notes.push(...historyTruncationNotes("recovery", recovery, startTime, utcOffset));
  if (!recoveriesReadable)
    warnings.push(
      `Recovery data could not be read (${recovery.quality.status === "fetch_failed" ? "the WHOOP request failed" : "unexpected format"}), so recovery_calibrating is null and consistency zeros cannot be checked against calibration.`
    );

  // --- Output -----------------------------------------------------------------------
  const reportedPeriod = {
    start: formatLocalTimestamp(startTime, utcOffset),
    end: formatLocalTimestamp(endTime < nowMs ? endTime - 1 : endTime, utcOffset),
  };
  const newest = scored[0]?.night.sleep;
  const oldest = scored[scored.length - 1]?.night.sleep;
  return {
    period: reportedPeriod,
    status,
    nights_required: SLEEP_ANALYSIS_MIN_NIGHTS,
    nights_analyzed: scored.length,
    summary,
    need,
    timing,
    naps,
    nights: rows,
    output_capped: outputCapped,
    pending_dates: pendingNights.map((item) => item.night.wake_day),
    excluded: {
      pending: pendingNights.length,
      unscorable: unscorable.length,
      low_data_coverage: lowCoverage,
      duplicate_day: built.excluded.duplicate_day,
      invalid: invalidRecords,
    },
    truncated,
    notes: withOffsetNote(notes, offsetInfo.fallback),
    warnings,
    disclaimer: DISCLAIMER,
    data_quality: {
      evaluated_at: formatLocalTimestamp(nowMs, utcOffset),
      requested_period: reportedPeriod,
      observed_period:
        newest && oldest
          ? {
              start: formatLocalTimestamp(Date.parse(oldest.start), oldest.timezone_offset),
              end: formatLocalTimestamp(Date.parse(newest.end), newest.timezone_offset),
            }
          : null,
      sources: { sleep: sleep.quality, recovery: recovery.quality },
      method_version: "sleep-analysis-1",
      limitations: [
        ...HISTORY_LIMITATIONS,
        `Nights whose no-data time exceeds LOW_DATA_COVERAGE_FRACTION (${LOW_DATA_COVERAGE_FRACTION}) of time in bed are excluded from duration, stage, disturbance and sleep-cycle statistics.`,
        "A night is the main sleep that ended in the window, one per local wake day (as get_sleep_debt); efficiency, performance, consistency and sleep need are WHOOP's own figures.",
        "Distributions use linear-interpolation quartiles and the sample standard deviation; timing uses circular statistics of local clock minutes, with one recorded offset per sleep.",
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Definition
// ---------------------------------------------------------------------------

export const getSleepAnalysisTool = defineTool({
  name: "get_sleep_analysis",
  annotations: { readOnlyHint: true },
  standard: {
    title: "Sleep analysis",
    description:
      "Describes main sleeps over a window (default 14 days, as get_sleep_debt): distributions (n, mean, median, quartiles, SD) of hours asleep and in bed, WHOOP efficiency, performance and consistency, disturbances per hour, sleep cycles and respiratory rate; time-weighted stage shares of time asleep; means of WHOOP's sleep-need components; bedtime and wake-time consistency; naps kept separate; and one row per night (newest 31). Only scored nights count; pending nights are listed with their dates. Nights with low data coverage are flagged and left out of duration and stage statistics. With fewer than 3 scored nights, status is insufficient_data and statistics are null. Descriptive only.",
    inputSchema: sleepAnalysisInputSchema,
    outputSchema: sleepAnalysisOutputSchema,
    run: runSleepAnalysis,
  },
});
