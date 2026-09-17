/**
 * Tool: get_workout_log
 *
 * A filterable, sortable list of WHOOP workouts on the user's local days.
 * Each session counts toward the local day of the WHOOP cycle containing its
 * start (assignWorkouts), so a session after local midnight but before the
 * next sleep belongs to the previous day. Workouts and cycles are read as
 * cached history over fetchRangeForDays (two extra days on each side), so an
 * after-midnight session on the last day is always loaded.
 *
 * Filters apply to scored sessions; unscored sessions are listed only with
 * include_unscored (every score field null). Totals cover every match, not only
 * the returned page. Also exports the small helpers the other workout tools
 * share (failure reasons, truncation notes, sport matching).
 */

import { z } from "zod";
import {
  WhoopApiError,
  WhoopAuthError,
  WhoopNetworkError,
  WhoopRateBudgetError,
} from "../api/client.js";
import { ENDPOINT_CYCLE, ENDPOINT_WORKOUT } from "../api/endpoints.js";
import {
  createHistoryBudget,
  HISTORY_DEADLINE_MS,
  HISTORY_LIMITATIONS,
  loadHistory,
  type HistoryBudget,
  type HistorySource,
  type LoadHistoryOptions,
} from "../api/history.js";
import { cycleRecordSchema, workoutRecordSchema } from "../api/record-schemas.js";
import type { Cycle, Workout } from "../api/types.js";
import {
  dataQualitySchema,
  DISCLAIMER,
  exclude,
  finishQuality,
  formatLocalTimestamp,
  localDay,
  localMidnightMs,
  mostRelevantError,
  type DataQuality,
  type SourceQuality,
} from "./analytics-utils.js";
import { resolveUserUtcOffsetInfo, withOffsetNote } from "./collection-utils.js";
import {
  addDays,
  assignWorkouts,
  daysBetween,
  fetchRangeForDays,
  isOpenCycle,
  localClock,
  placeDays,
  resolveDayWindow,
} from "./day-model.js";
import { roundTo } from "./stats-utils.js";
import { defineTool, type ToolContext } from "./tool-definition.js";
import {
  HR_ZONE_CAVEAT_SPORT,
  normalizeWorkout,
  roundWorkoutSummary,
  workoutSummarySchema,
  type WorkoutSummary,
  type ZoneMinutes,
} from "./workout-utils.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Days listed without `days` */
export const WORKOUT_LOG_DEFAULT_DAYS = 14;

/** Longest window in local days */
export const WORKOUT_LOG_MAX_DAYS = 365;

/** Sessions returned without `limit` */
export const WORKOUT_LOG_DEFAULT_LIMIT = 25;

/** Most sessions one call returns (output size) */
export const WORKOUT_LOG_MAX_LIMIT = 50;

/** Most entries in available_sports */
export const WORKOUT_LOG_MAX_SPORTS = 40;

/** Sort orders of the log */
export const WORKOUT_LOG_SORTS = [
  "newest",
  "oldest",
  "strain",
  "duration",
  "trimp",
  "distance",
  "pace",
  "high_intensity",
] as const;

export type WorkoutLogSort = (typeof WORKOUT_LOG_SORTS)[number];

// ---------------------------------------------------------------------------
// Shared helpers (also used by get_workout_context and get_personal_records)
// ---------------------------------------------------------------------------

/** Case-insensitive sport matching key */
export function sportKey(name: string): string {
  return name.trim().toLowerCase();
}

/** "1 session" / "3 sessions" */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** Why a WHOOP request failed, by error type and HTTP status only (never bodies or URLs) */
export function failureReason(error: unknown, depth = 0): string {
  if (error instanceof WhoopRateBudgetError) return "this call's request budget ran out";
  if (error instanceof WhoopApiError) return `WHOOP API returned HTTP ${error.statusCode}`;
  if ((error instanceof WhoopNetworkError || error instanceof WhoopAuthError) && depth < 3) {
    const cause = error.cause;
    if (
      cause instanceof WhoopApiError ||
      cause instanceof WhoopAuthError ||
      cause instanceof WhoopNetworkError ||
      cause instanceof WhoopRateBudgetError
    ) {
      return failureReason(cause, depth + 1);
    }
  }
  if (error instanceof WhoopAuthError) return "WHOOP authentication failed";
  if (error instanceof WhoopNetworkError) return "network error";
  if (error instanceof z.ZodError) return "unexpected data format";
  return "unexpected error";
}

/** True when a history source could not be read at all */
export function sourceUnreadable(source: { quality: SourceQuality }): boolean {
  return source.quality.status === "fetch_failed" || source.quality.status === "invalid";
}

/**
 * A warning for a history source that could not be read at all, or whose
 * records partly failed validation; null when there is nothing to report.
 * `consequence` completes "…, so <consequence>."
 */
export function sourceWarnings(
  label: string,
  source: HistorySource<unknown>,
  consequence: string
): string[] {
  const warnings: string[] = [];
  if (source.quality.status === "fetch_failed") {
    warnings.push(
      `${label} data could not be loaded (${failureReason(source.error)}), so ${consequence}.`
    );
  } else if (source.quality.status === "invalid") {
    warnings.push(`${label} data from WHOOP did not match the expected format, so ${consequence}.`);
  }
  const invalid = source.quality.exclusions.invalid ?? 0;
  if (invalid > 0 && source.quality.status !== "invalid") {
    warnings.push(
      `${plural(invalid, `${label.toLowerCase()} record`)} did not match the expected WHOOP format and ${invalid === 1 ? "was" : "were"} skipped.`
    );
  }
  return warnings;
}

/**
 * A note for a history source that was read only partly (a later page failed,
 * the request budget or deadline ran out, or a record cap was reached); null
 * when the source is complete or could not be read at all.
 */
export function truncationNote(
  label: string,
  source: HistorySource<unknown>,
  utcOffset: string,
  consequence: string
): string | null {
  if (!source.quality.truncated || sourceUnreadable(source)) return null;
  const error = source.partialError;
  const reason =
    error === undefined
      ? "the per-call record limit was reached"
      : error instanceof WhoopRateBudgetError
        ? "this call's request budget ran out"
        : failureReason(error);
  const since =
    source.complete_since === null
      ? "even the most recent records may be missing"
      : `records starting before ${localClock(source.complete_since, utcOffset)} local time may be missing`;
  return `${label} history could not be read completely (${reason}): ${since}, so ${consequence}. Repeating the request continues loading from the cache.`;
}

/** Options for loadHistory within one tool call */
export function historyOptions(ctx: ToolContext): LoadHistoryOptions & { budget: HistoryBudget } {
  return {
    budget: createHistoryBudget({ deadlineMs: ctx.startedAtMs + HISTORY_DEADLINE_MS }),
    now: ctx.now,
    ...(ctx.historyCache !== undefined ? { cache: ctx.historyCache } : {}),
  };
}

/**
 * The period WHOOP records actually span, each end written in its record's
 * own offset; null without records.
 */
export function observedSpan(
  records: readonly { startMs: number; endMs: number; offset: string }[]
): { start: string; end: string } | null {
  if (records.length === 0) return null;
  let first = records[0]!;
  let last = records[0]!;
  for (const record of records) {
    if (record.startMs < first.startMs) first = record;
    if (record.endMs > last.endMs) last = record;
  }
  return {
    start: formatLocalTimestamp(first.startMs, first.offset),
    end: formatLocalTimestamp(last.endMs, last.offset),
  };
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const workoutLogInputSchema = z.object({
  days: z
    .number()
    .int()
    .min(1)
    .max(WORKOUT_LOG_MAX_DAYS)
    .optional()
    .describe(
      "Number of local days (1-365). Default 14. Without start the window ends today; with a single-day start it runs forward from it."
    ),
  start: z
    .string()
    .max(100)
    .optional()
    .describe(
      'Where the window starts, as in get_calendar: a range expression ("last 30 days", "this month", "last week", "YYYY-MM") covers that range up to today (at most 365 days) unless days is also given; a single day (YYYY-MM-DD, "yesterday") or a date-time starts the window and it runs forward days days, clamped to today.'
    ),
  sport: z
    .array(z.string().max(100))
    .max(10)
    .optional()
    .describe(
      'Only these sports: exact WHOOP sport_name, case-insensitive (e.g. ["running", "cycling"]). available_sports lists the sports present in the window.'
    ),
  min_strain: z.number().min(0).max(21).optional().describe("Only sessions with strain >= this."),
  min_duration_minutes: z
    .number()
    .min(0)
    .max(1440)
    .optional()
    .describe("Only sessions lasting at least this many elapsed minutes."),
  has_gps: z
    .boolean()
    .optional()
    .describe("true: only sessions with GPS distance; false: only sessions without."),
  min_distance_km: z
    .number()
    .min(0)
    .max(1000)
    .optional()
    .describe("Only sessions with a GPS distance of at least this many km."),
  sort: z
    .enum(WORKOUT_LOG_SORTS)
    .optional()
    .describe(
      "newest (default) or oldest by start; strain, duration, trimp, distance and high_intensity (zone 4+5 minutes) highest first; pace fastest first, listing only GPS sessions with plausible speed. Missing values sort last; ties newest first."
    ),
  include_unscored: z
    .boolean()
    .optional()
    .describe(
      "List sessions WHOOP has not scored (pending or unscorable) with null score fields. Default false."
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(WORKOUT_LOG_MAX_LIMIT)
    .optional()
    .describe("Sessions to return (1-50). Default 25; totals still cover every match."),
});

export type WorkoutLogInput = z.infer<typeof workoutLogInputSchema>;

const zoneMinutesSchema = z.object({
  zone_0: z.number(),
  zone_1: z.number(),
  zone_2: z.number(),
  zone_3: z.number(),
  zone_4: z.number(),
  zone_5: z.number(),
});

export const workoutLogOutputSchema = z.object({
  period: z.object({
    start_day: z.string(),
    end_day: z.string(),
    days: z.number().int(),
    utc_offset: z.string(),
  }),
  filters: z.object({
    sport: z.array(z.string()).nullable(),
    min_strain: z.number().nullable(),
    min_duration_minutes: z.number().nullable(),
    has_gps: z.boolean().nullable(),
    min_distance_km: z.number().nullable(),
    sort: z.enum(WORKOUT_LOG_SORTS),
    include_unscored: z.boolean(),
    limit: z.number().int(),
  }),
  total_matching: z.number().int().describe("Sessions matching the filters (the whole window)"),
  returned: z.number().int(),
  output_capped: z
    .boolean()
    .describe("True when more sessions matched than returned, or available_sports was cut"),
  workouts: z.array(workoutSummarySchema),
  totals: z
    .object({
      sessions: z.number().int(),
      duration_minutes: z.number(),
      recorded_minutes: z.number().nullable(),
      trimp: z.number().nullable(),
      kilojoule: z.number().nullable(),
      kcal: z.number().nullable(),
      distance_km: z
        .number()
        .nullable()
        .describe(
          "Sum over sessions with GPS distance; null without any, or when a matching session is not scored"
        ),
      gps_sessions: z.number().int().describe("Matching sessions with GPS distance"),
      zone_minutes: zoneMinutesSchema.nullable(),
    })
    .describe(
      "Over every matching session, not only the returned ones. Score-based sums (recorded minutes, TRIMP, kJ, kcal, zone minutes, distance) are null when a matching session is not scored: its values are unknown."
    ),
  available_sports: z.array(z.object({ sport_name: z.string(), sessions: z.number().int() })),
  truncated: z.boolean(),
  notes: z.array(z.string()),
  warnings: z.array(z.string()),
  disclaimer: z.string(),
  data_quality: dataQualitySchema,
});

export type WorkoutLogOutput = z.infer<typeof workoutLogOutputSchema>;

// ---------------------------------------------------------------------------
// Sorting and totals
// ---------------------------------------------------------------------------

interface LogItem {
  summary: WorkoutSummary;
  startMs: number;
  endMs: number;
}

/** A descending (or, for pace, ascending) key; null sorts last */
function sortKeyOf(item: LogItem, sort: WorkoutLogSort): number | null {
  const summary = item.summary;
  switch (sort) {
    case "newest":
    case "oldest":
      return item.startMs;
    case "strain":
      return summary.strain;
    case "duration":
      return summary.duration_minutes;
    case "trimp":
      return summary.trimp;
    case "distance":
      return summary.gps?.distance_km ?? null;
    case "pace":
      return summary.gps?.avg_pace_sec_per_km ?? null;
    case "high_intensity":
      return summary.high_intensity_minutes;
  }
}

/** Compare two items for `sort`: nulls last, ties newest first, then by id */
export function compareLogItems(left: LogItem, right: LogItem, sort: WorkoutLogSort): number {
  const a = sortKeyOf(left, sort);
  const b = sortKeyOf(right, sort);
  if (a === null && b !== null) return 1;
  if (a !== null && b === null) return -1;
  if (a !== null && b !== null && a !== b) {
    return sort === "oldest" || sort === "pace" ? a - b : b - a;
  }
  if (left.startMs !== right.startMs) return right.startMs - left.startMs;
  return left.summary.id < right.summary.id ? -1 : left.summary.id > right.summary.id ? 1 : 0;
}

function sumZones(items: readonly LogItem[]): ZoneMinutes {
  const total: ZoneMinutes = { zone_0: 0, zone_1: 0, zone_2: 0, zone_3: 0, zone_4: 0, zone_5: 0 };
  for (const { summary } of items) {
    const zones = summary.zone_minutes;
    if (!zones) continue;
    total.zone_0 += zones.zone_0;
    total.zone_1 += zones.zone_1;
    total.zone_2 += zones.zone_2;
    total.zone_3 += zones.zone_3;
    total.zone_4 += zones.zone_4;
    total.zone_5 += zones.zone_5;
  }
  return total;
}

function sumOf(
  items: readonly LogItem[],
  value: (summary: WorkoutSummary) => number | null
): number {
  return items.reduce((sum, item) => sum + (value(item.summary) ?? 0), 0);
}

function isScored(summary: WorkoutSummary): boolean {
  return !summary.flags.includes("not_scored");
}

function totalsOf(items: readonly LogItem[]): WorkoutLogOutput["totals"] {
  const anyUnscored = items.some((item) => !isScored(item.summary));
  const gpsItems = items.filter((item) => item.summary.gps !== null);
  const zones = sumZones(items);
  const scoreSum = (
    value: (summary: WorkoutSummary) => number | null,
    digits: number
  ): number | null => (anyUnscored ? null : roundTo(sumOf(items, value), digits));
  return {
    sessions: items.length,
    duration_minutes: roundTo(
      sumOf(items, (summary) => summary.duration_minutes),
      1
    ),
    recorded_minutes: scoreSum((summary) => summary.recorded_minutes, 1),
    trimp: scoreSum((summary) => summary.trimp, 1),
    kilojoule: scoreSum((summary) => summary.kilojoule, 0),
    kcal: scoreSum((summary) => summary.kcal, 0),
    distance_km:
      gpsItems.length === 0 || anyUnscored
        ? null
        : roundTo(
            sumOf(gpsItems, (summary) => summary.gps?.distance_km ?? null),
            2
          ),
    gps_sessions: gpsItems.length,
    zone_minutes: anyUnscored
      ? null
      : {
          zone_0: roundTo(zones.zone_0, 1),
          zone_1: roundTo(zones.zone_1, 1),
          zone_2: roundTo(zones.zone_2, 1),
          zone_3: roundTo(zones.zone_3, 1),
          zone_4: roundTo(zones.zone_4, 1),
          zone_5: roundTo(zones.zone_5, 1),
        },
  };
}

function listNames(names: readonly string[]): string {
  return [...new Set(names)].sort().join(", ");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const METHOD_VERSION = "workout-log-1";

const LOG_LIMITATIONS: readonly string[] = [
  "A session counts toward the local day of the WHOOP cycle containing its start; a session after local midnight but before the next sleep belongs to the previous day.",
  "Pace and speed use elapsed time over the whole session (pauses included), not moving time or splits.",
  "Heart-rate zones are WHOOP %max-HR zones; TRIMP is Edwards TRIMP (zone number × zone minutes).",
];

/**
 * Run get_workout_log.
 *
 * @throws InvalidDateExpression for an unparseable start
 * @throws the most relevant WHOOP error when the workout history cannot be read
 */
export async function getWorkoutLog(
  args: WorkoutLogInput,
  ctx: ToolContext
): Promise<WorkoutLogOutput> {
  const now = ctx.now();
  const nowMs = now.getTime();
  const { offset: utcOffset, fallback: offsetFallback } = await resolveUserUtcOffsetInfo(
    ctx.client
  );
  const today = localDay(now.toISOString(), utcOffset);
  const sort = args.sort ?? "newest";
  const limit = args.limit ?? WORKOUT_LOG_DEFAULT_LIMIT;
  const includeUnscored = args.include_unscored ?? false;
  const filters: WorkoutLogOutput["filters"] = {
    sport: args.sport ? [...args.sport] : null,
    min_strain: args.min_strain ?? null,
    min_duration_minutes: args.min_duration_minutes ?? null,
    has_gps: args.has_gps ?? null,
    min_distance_km: args.min_distance_km ?? null,
    sort,
    include_unscored: includeUnscored,
    limit,
  };

  const window = resolveDayWindow(
    {
      ...(args.days !== undefined ? { days: args.days } : {}),
      ...(args.start !== undefined ? { start: args.start } : {}),
    },
    now,
    utcOffset,
    { defaultDays: WORKOUT_LOG_DEFAULT_DAYS, maxDays: WORKOUT_LOG_MAX_DAYS, noun: "log" }
  );
  const { firstDay, lastDay } = window;
  const notes: string[] = [...window.notes];
  const warnings: string[] = [];
  const requestedPeriod = {
    start: formatLocalTimestamp(localMidnightMs(firstDay, utcOffset), utcOffset),
    end: formatLocalTimestamp(localMidnightMs(addDays(lastDay, 1), utcOffset) - 1, utcOffset),
  };
  const emptyTotals = totalsOf([]);

  if (firstDay > today) {
    const fromDateTime = window.fromDateTime
      ? " (a date-time start counts from its nearest local midnight)"
      : "";
    return {
      period: { start_day: firstDay, end_day: firstDay, days: 0, utc_offset: utcOffset },
      filters,
      total_matching: 0,
      returned: 0,
      output_capped: false,
      workouts: [],
      totals: emptyTotals,
      available_sports: [],
      truncated: false,
      notes: withOffsetNote(
        [
          ...notes,
          `The start date ${firstDay}${fromDateTime} is after today (${today}); there are no days to list.`,
        ],
        offsetFallback
      ),
      warnings,
      disclaimer: DISCLAIMER,
      data_quality: {
        evaluated_at: now.toISOString(),
        requested_period: requestedPeriod,
        observed_period: null,
        sources: {},
        method_version: METHOD_VERSION,
        limitations: [...HISTORY_LIMITATIONS, ...LOG_LIMITATIONS],
      },
    };
  }

  // --- Load ------------------------------------------------------------------

  const range = fetchRangeForDays(firstDay, lastDay, utcOffset, nowMs);
  const period = {
    start: new Date(range.startMs).toISOString(),
    end: new Date(range.endMs).toISOString(),
  };
  const options = historyOptions(ctx);
  const [workouts, cycles] = await Promise.all([
    loadHistory<Workout>(ctx.client, ENDPOINT_WORKOUT, period, workoutRecordSchema, options),
    loadHistory<Cycle>(ctx.client, ENDPOINT_CYCLE, period, cycleRecordSchema, options),
  ]);
  if (workouts.quality.status === "fetch_failed") {
    throw mostRelevantError(
      [workouts.error, cycles.quality.status === "fetch_failed" ? cycles.error : undefined].filter(
        (error) => error !== undefined
      )
    );
  }
  warnings.push(
    ...sourceWarnings("Workout", workouts, "no sessions can be listed"),
    ...sourceWarnings(
      "Cycle",
      cycles,
      "every session is placed on its local start day (flag day_by_fallback)"
    )
  );

  // --- Place and normalize --------------------------------------------------------

  const placement = placeDays({
    cycles: cycles.records,
    sleeps: [],
    recoveries: [],
    sleepsAvailable: false,
    today,
    utcOffset,
  });
  const placements = assignWorkouts(workouts.records, placement, cycles.records);
  const workoutQuality = workouts.quality;
  const inWindow: LogItem[] = [];
  const recordsById = new Map<string, Workout>();
  for (const workout of workouts.records) {
    const workoutPlacement = placements.get(workout.id) ?? null;
    const summary = normalizeWorkout(
      workout,
      workoutPlacement,
      workoutPlacement?.cycle ? isOpenCycle(workoutPlacement.cycle) : false
    );
    if (!summary) {
      exclude(workoutQuality, "invalid_duration");
      continue;
    }
    if (summary.day < firstDay || summary.day > lastDay) {
      exclude(workoutQuality, "outside_window");
      continue;
    }
    recordsById.set(workout.id, workout);
    inWindow.push({
      summary,
      startMs: Date.parse(workout.start),
      endMs: Date.parse(workout.end),
    });
  }

  // --- Filter ---------------------------------------------------------------------

  const sportFilter = args.sport ? new Set(args.sport.map(sportKey)) : null;
  const scoreFilter =
    args.min_strain !== undefined ||
    args.has_gps !== undefined ||
    args.min_distance_km !== undefined;
  let matches: LogItem[] = [];
  let hiddenUnscored = 0;
  let unscoredByScoreFilter = 0;
  for (const item of inWindow) {
    const summary = item.summary;
    if (sportFilter && !sportFilter.has(sportKey(summary.sport_name))) {
      exclude(workoutQuality, "filtered_out");
      continue;
    }
    if (!isScored(summary)) {
      if (!includeUnscored) {
        hiddenUnscored += 1;
        exclude(workoutQuality, summary.score_state === "PENDING_SCORE" ? "pending" : "unscored");
        continue;
      }
      if (scoreFilter) {
        unscoredByScoreFilter += 1;
        exclude(workoutQuality, "filtered_out");
        continue;
      }
    }
    const passes =
      (args.min_duration_minutes === undefined ||
        summary.duration_minutes >= args.min_duration_minutes) &&
      (args.min_strain === undefined ||
        (summary.strain !== null && summary.strain >= args.min_strain)) &&
      (args.has_gps === undefined || (summary.gps !== null) === args.has_gps) &&
      (args.min_distance_km === undefined ||
        (summary.gps !== null && summary.gps.distance_km >= args.min_distance_km));
    if (!passes) {
      exclude(workoutQuality, "filtered_out");
      continue;
    }
    matches.push(item);
  }

  if (sort === "pace") {
    const eligible = matches.filter(
      (item) => item.summary.gps !== null && !item.summary.flags.includes("gps_suspect")
    );
    const dropped = matches.length - eligible.length;
    for (let index = 0; index < dropped; index++) exclude(workoutQuality, "no_pace");
    const paceSports = new Set(eligible.map((item) => item.summary.sport_name));
    if (dropped > 0) {
      notes.push(
        `Sorting by pace lists only sessions with GPS distance and a plausible speed: ${plural(dropped, "matching session")} without them ${dropped === 1 ? "is" : "are"} left out of the list and the totals.`
      );
    }
    if (paceSports.size > 1) {
      notes.push(
        `Pace here compares different sports (${listNames([...paceSports])}); the sport filter narrows the ranking to one sport.`
      );
    }
    matches = eligible;
  }

  matches.sort((left, right) => compareLogItems(left, right, sort));

  // --- Sports --------------------------------------------------------------------

  const sportCounts = new Map<string, number>();
  for (const { summary } of inWindow) {
    sportCounts.set(summary.sport_name, (sportCounts.get(summary.sport_name) ?? 0) + 1);
  }
  const allSports = [...sportCounts.entries()]
    .map(([sport_name, sessions]) => ({ sport_name, sessions }))
    .sort(
      (left, right) =>
        right.sessions - left.sessions ||
        (left.sport_name < right.sport_name ? -1 : left.sport_name > right.sport_name ? 1 : 0)
    );
  const availableSports = allSports.slice(0, WORKOUT_LOG_MAX_SPORTS);
  const sportsCapped = allSports.length > availableSports.length;

  // --- Notes ---------------------------------------------------------------------

  const windowDays = daysBetween(firstDay, lastDay) + 1;
  if (inWindow.length === 0 && !sourceUnreadable(workouts)) {
    notes.push(`No WHOOP workouts are placed on ${firstDay} to ${lastDay}.`);
  } else if (matches.length === 0 && inWindow.length > 0) {
    notes.push(
      `None of the ${plural(inWindow.length, "session")} in this window ${inWindow.length === 1 ? "matches" : "match"} the filters.`
    );
  }
  if (sportFilter) {
    const present = new Set(inWindow.map((item) => sportKey(item.summary.sport_name)));
    const unknown = (args.sport ?? []).filter((sport) => !present.has(sportKey(sport)));
    if (unknown.length > 0) {
      notes.push(
        `No session in this window has the sport ${unknown.map((sport) => `"${sport}"`).join(", ")}; available_sports lists the sports present.`
      );
    }
  }
  if (hiddenUnscored > 0) {
    notes.push(
      `${plural(hiddenUnscored, "session")} in this window ${hiddenUnscored === 1 ? "is" : "are"} not scored by WHOOP yet (or could not be scored) and ${hiddenUnscored === 1 ? "is" : "are"} not listed; include_unscored lists them with null score fields.`
    );
  }
  if (unscoredByScoreFilter > 0) {
    notes.push(
      `${plural(unscoredByScoreFilter, "unscored session")} ${unscoredByScoreFilter === 1 ? "is" : "are"} left out: min_strain, has_gps and min_distance_km need a WHOOP score.`
    );
  }
  const unscoredMatches = matches.filter((item) => !isScored(item.summary)).length;
  if (unscoredMatches > 0) {
    notes.push(
      `${plural(unscoredMatches, "matching session")} ${unscoredMatches === 1 ? "is" : "are"} not scored (score_state PENDING_SCORE or UNSCORABLE): score fields are null, and so are the score-based totals (recorded minutes, zone minutes, TRIMP, kilojoule, kcal, distance).`
    );
  }
  const flagged = (flag: WorkoutSummary["flags"][number]): LogItem[] =>
    matches.filter((item) => item.summary.flags.includes(flag));
  if (matches.some((item) => item.summary.gps !== null)) {
    notes.push(
      "avg_pace_sec_per_km and avg_speed_kmh use elapsed time (pauses included), so they read slower than moving pace for sessions with stops."
    );
  }
  const lowRecording = flagged("low_recording").length;
  if (lowRecording > 0) {
    notes.push(
      `${plural(lowRecording, "matching session")} recorded heart rate for less than 90% of ${lowRecording === 1 ? "its" : "their"} duration (flag low_recording): zone minutes and TRIMP cover only the recorded part, and beats_per_km is null.`
    );
  }
  const suspect = flagged("gps_suspect").length;
  if (suspect > 0) {
    notes.push(
      `${plural(suspect, "matching session")} ${suspect === 1 ? "has" : "have"} an implausible GPS speed (over 25 m/s) or lasted under a minute (flag gps_suspect); pace sorting leaves ${suspect === 1 ? "it" : "them"} out.`
    );
  }
  const afterMidnight = flagged("after_midnight_in_previous_cycle").length;
  if (afterMidnight > 0) {
    notes.push(
      `${plural(afterMidnight, "matching session")} started after local midnight but ${afterMidnight === 1 ? "counts" : "count"} toward the previous day (flag after_midnight_in_previous_cycle): the WHOOP cycle begun at the previous sleep had not ended yet, so day differs from local_date.`
    );
  }
  const strengthSports = matches
    .map((item) => item.summary.sport_name)
    .filter((sport) => HR_ZONE_CAVEAT_SPORT.test(sport));
  if (strengthSports.length > 0) {
    notes.push(
      `Heart-rate zones, TRIMP and high-intensity minutes follow heart rate, which understates the load of strength sessions (${listNames(strengthSports)}).`
    );
  }
  const workoutTruncation = truncationNote(
    "Workout",
    workouts,
    utcOffset,
    "sessions in that part of the window may be missing from the list and totals"
  );
  if (workoutTruncation) notes.push(workoutTruncation);
  const cycleTruncation = truncationNote(
    "Cycle",
    cycles,
    utcOffset,
    "sessions in that part of the window may be placed on their local start day (flag day_by_fallback)"
  );
  if (cycleTruncation) notes.push(cycleTruncation);
  if (sportsCapped) {
    notes.push(
      `available_sports shows the ${WORKOUT_LOG_MAX_SPORTS} sports with the most sessions of ${allSports.length}.`
    );
  }
  if (matches.length > limit) {
    notes.push(
      `${plural(matches.length, "session")} ${matches.length === 1 ? "matches" : "match"}; the first ${limit} in this sort order are listed (limit ${limit}), and totals cover all of them.`
    );
  }

  const fallbackCount = inWindow.filter((item) =>
    item.summary.flags.includes("day_by_fallback")
  ).length;
  if (fallbackCount > 0 && !sourceUnreadable(cycles)) {
    warnings.push(
      `${plural(fallbackCount, "session")} ${fallbackCount === 1 ? "is" : "are"} not inside any loaded WHOOP cycle and ${fallbackCount === 1 ? "is" : "are"} placed on ${fallbackCount === 1 ? "its" : "their"} local start day (flag day_by_fallback).`
    );
  }
  const mismatch = flagged("zone_sum_mismatch").length;
  if (mismatch > 0) {
    warnings.push(
      `${plural(mismatch, "matching session")} ${mismatch === 1 ? "has" : "have"} zone minutes that do not add up to duration × recorded fraction (flag zone_sum_mismatch).`
    );
  }

  // --- Data quality ------------------------------------------------------------------

  finishQuality(
    workoutQuality,
    matches.map((item) => recordsById.get(item.summary.id)!)
  );
  const cycleQuality = cycles.quality;
  const usedCycles: Cycle[] = [];
  for (const cycle of cycles.records) {
    const day = placement.dayOfCycle.get(cycle.id);
    if (day !== undefined && day >= firstDay && day <= lastDay) usedCycles.push(cycle);
    else exclude(cycleQuality, "outside_window");
  }
  finishQuality(cycleQuality, usedCycles);

  const dataQuality: DataQuality = {
    evaluated_at: now.toISOString(),
    requested_period: requestedPeriod,
    observed_period: observedSpan(
      matches.map((item) => ({
        startMs: item.startMs,
        endMs: item.endMs,
        offset: item.summary.timezone_offset,
      }))
    ),
    sources: { workouts: workoutQuality, cycles: cycleQuality },
    method_version: METHOD_VERSION,
    limitations: [...HISTORY_LIMITATIONS, ...LOG_LIMITATIONS],
  };

  return {
    period: { start_day: firstDay, end_day: lastDay, days: windowDays, utc_offset: utcOffset },
    filters,
    total_matching: matches.length,
    returned: Math.min(limit, matches.length),
    output_capped: matches.length > limit || sportsCapped,
    workouts: matches.slice(0, limit).map((item) => roundWorkoutSummary(item.summary)),
    totals: totalsOf(matches),
    available_sports: availableSports,
    truncated: workouts.quality.truncated || cycles.quality.truncated,
    notes: withOffsetNote(notes, offsetFallback),
    warnings,
    disclaimer: DISCLAIMER,
    data_quality: dataQuality,
  };
}

// ---------------------------------------------------------------------------
// Definition
// ---------------------------------------------------------------------------

export const WORKOUT_LOG_TOOL = defineTool({
  name: "get_workout_log",
  annotations: { readOnlyHint: true },
  standard: {
    title: "Workout log",
    description:
      "List WHOOP workouts on the user's local days with filters (sport, min_strain, min_duration_minutes, has_gps, min_distance_km) and sorting (newest, oldest, strain, duration, trimp, distance, pace fastest first over GPS sessions, high_intensity = zone 4+5 minutes). A session counts toward the local day of the WHOOP cycle containing its start, so one after local midnight but before the next sleep belongs to the previous day (day vs local_date). Each entry has duration, recorded fraction, strain, kJ/kcal, heart rate, zone minutes, Edwards TRIMP and GPS distance/pace (elapsed, pauses included) with quality flags. totals cover every match, not only the returned page; available_sports lists the window's sports before the sport filter. Unscored sessions are hidden unless include_unscored. Default: the last 14 days; start accepts get_calendar expressions.",
    inputSchema: workoutLogInputSchema,
    outputSchema: workoutLogOutputSchema,
    run: getWorkoutLog,
  },
});
