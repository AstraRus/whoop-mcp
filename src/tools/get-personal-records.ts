/**
 * Tool: get_personal_records
 *
 * Per-sport bests over a period of local days (default the last 365): longest,
 * most energy, highest strain and TRIMP, most high-intensity minutes, highest
 * workout max heart rate, farthest distance, most elevation gain, and the
 * fastest average pace over sessions of at least 1 km, 5 km, 10 km, a half
 * marathon and a marathon. Each record names the best before it and the
 * improvement, and whether it was set within the last `recent_days`.
 *
 * Workouts and cycles are read as cached history over fetchRangeForDays, and
 * each session counts on the local day of the WHOOP cycle containing its start
 * (assignWorkouts). A probe for workouts before the period decides whether the
 * bests cover the account's whole history (history_complete); notes never call
 * them all-time otherwise.
 *
 * Only scored sessions count. Duration, energy, strain, TRIMP, high-intensity
 * minutes and max heart rate need at least 90% of the session recorded; GPS
 * records need a plausible speed (not gps_suspect). The pace records use each
 * session's elapsed average pace (pauses included), not splits.
 */

import { z } from "zod";
import { ENDPOINT_BODY_MEASUREMENT, ENDPOINT_CYCLE, ENDPOINT_WORKOUT } from "../api/endpoints.js";
import { HISTORY_LIMITATIONS, loadHistory } from "../api/history.js";
import { cycleRecordSchema, workoutRecordSchema } from "../api/record-schemas.js";
import type { Cycle, Workout } from "../api/types.js";
import { PROFILE_TTL_MS } from "../resources/index.js";
import {
  dataQualitySchema,
  DISCLAIMER,
  exclude,
  finishQuality,
  formatLocalTimestamp,
  localDay,
  localMidnightMs,
  mostRelevantError,
  sourceQuality,
  type SourceQuality,
} from "./analytics-utils.js";
import { resolveUserUtcOffsetInfo, withOffsetNote } from "./collection-utils.js";
import { addDays, assignWorkouts, fetchRangeForDays, isOpenCycle, placeDays } from "./day-model.js";
import {
  failureReason,
  historyOptions,
  observedSpan,
  plural,
  sourceUnreadable,
  sourceWarnings,
  sportKey,
  truncationNote,
} from "./get-workout-log.js";
import { roundTo } from "./stats-utils.js";
import { defineTool, type ToolContext } from "./tool-definition.js";
import {
  HR_ZONE_CAVEAT_SPORT,
  MIN_RECORDED_FRACTION,
  normalizeWorkout,
  type WorkoutSummary,
} from "./workout-utils.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Local days searched without `days` */
export const PERSONAL_RECORDS_DEFAULT_DAYS = 365;

/** Shortest period in local days */
export const PERSONAL_RECORDS_MIN_DAYS = 30;

/** Longest period in local days */
export const PERSONAL_RECORDS_MAX_DAYS = 1095;

/** Local days (ending today) whose records count as recent without `recent_days` */
export const DEFAULT_RECENT_DAYS = 7;

/** Longest `recent_days` */
export const MAX_RECENT_DAYS = 60;

/** Sessions of a sport below which every session is a best (status few_sessions) */
export const MIN_RECORD_SESSIONS = 3;

/** Cache lifetime of the probe for workouts before the period */
export const OLDER_WORKOUTS_PROBE_TTL_MS = 10 * 60_000;

/** Most sports listed (those with the most sessions) */
export const MAX_RECORD_SPORTS = 12;

/** Most entries in recent_records (newest first) */
export const MAX_RECENT_RECORDS = 40;

/** Most sport names listed in a note */
const MAX_NAMED_SPORTS = 40;

/** Record metrics in output order */
export const RECORD_METRICS = [
  "longest_duration",
  "most_kilojoule",
  "highest_strain",
  "highest_trimp",
  "most_high_intensity_minutes",
  "highest_workout_max_hr",
  "farthest_distance",
  "most_elevation_gain",
  "fastest_pace_1k",
  "fastest_pace_5k",
  "fastest_pace_10k",
  "fastest_pace_half_marathon",
  "fastest_pace_marathon",
] as const;

export type RecordMetric = (typeof RECORD_METRICS)[number];

export const RECORD_UNITS = [
  "minutes",
  "kJ",
  "strain",
  "TRIMP",
  "bpm",
  "km",
  "m",
  "sec_per_km",
] as const;

type RecordUnit = (typeof RECORD_UNITS)[number];

interface MetricDefinition {
  metric: RecordMetric;
  label: string;
  unit: RecordUnit;
  /** Which value wins */
  better: "higher" | "lower";
  /** Output decimals */
  digits: number;
  /** "heart_rate": needs MIN_RECORDED_FRACTION; "gps": needs plausible GPS */
  basis: "heart_rate" | "gps";
  /** The session's value, or null when it has none */
  value(summary: WorkoutSummary): number | null;
}

/** Shortest session distance (km) per pace record */
export const PACE_TIERS_KM: Readonly<Record<string, number>> = {
  fastest_pace_1k: 1,
  fastest_pace_5k: 5,
  fastest_pace_10k: 10,
  fastest_pace_half_marathon: 21.0975,
  fastest_pace_marathon: 42.195,
};

function paceMetric(metric: RecordMetric, tierLabel: string): MetricDefinition {
  const minKm = PACE_TIERS_KM[metric]!;
  return {
    metric,
    label: `fastest average pace over a session of at least ${tierLabel}`,
    unit: "sec_per_km",
    better: "lower",
    digits: 0,
    basis: "gps",
    value: (summary) =>
      summary.gps !== null && summary.gps.distance_km >= minKm
        ? summary.gps.avg_pace_sec_per_km
        : null,
  };
}

const METRICS: readonly MetricDefinition[] = [
  {
    metric: "longest_duration",
    label: "longest session",
    unit: "minutes",
    better: "higher",
    digits: 1,
    basis: "heart_rate",
    value: (summary) => summary.duration_minutes,
  },
  {
    metric: "most_kilojoule",
    label: "most energy",
    unit: "kJ",
    better: "higher",
    digits: 0,
    basis: "heart_rate",
    value: (summary) => summary.kilojoule,
  },
  {
    metric: "highest_strain",
    label: "highest strain",
    unit: "strain",
    better: "higher",
    digits: 2,
    basis: "heart_rate",
    value: (summary) => summary.strain,
  },
  {
    metric: "highest_trimp",
    label: "highest TRIMP (Edwards)",
    unit: "TRIMP",
    better: "higher",
    digits: 1,
    basis: "heart_rate",
    value: (summary) => summary.trimp,
  },
  {
    metric: "most_high_intensity_minutes",
    label: "most minutes in heart-rate zones 4 and 5",
    unit: "minutes",
    better: "higher",
    digits: 1,
    basis: "heart_rate",
    value: (summary) => summary.high_intensity_minutes,
  },
  {
    metric: "highest_workout_max_hr",
    label: "highest workout max heart rate",
    unit: "bpm",
    better: "higher",
    digits: 0,
    basis: "heart_rate",
    value: (summary) => summary.max_heart_rate,
  },
  {
    metric: "farthest_distance",
    label: "farthest GPS distance",
    unit: "km",
    better: "higher",
    digits: 2,
    basis: "gps",
    value: (summary) => summary.gps?.distance_km ?? null,
  },
  {
    metric: "most_elevation_gain",
    label: "most GPS elevation gain",
    unit: "m",
    better: "higher",
    digits: 0,
    basis: "gps",
    value: (summary) => summary.gps?.altitude_gain_m ?? null,
  },
  paceMetric("fastest_pace_1k", "1 km"),
  paceMetric("fastest_pace_5k", "5 km"),
  paceMetric("fastest_pace_10k", "10 km"),
  paceMetric("fastest_pace_half_marathon", "21.0975 km (half marathon)"),
  paceMetric("fastest_pace_marathon", "42.195 km (marathon)"),
];

const METHOD_VERSION = "personal-records-1";

/** The note every sport with too few sessions gets (spec wording) */
export const FEW_SESSIONS_NOTE = "with fewer than 3 sessions every session is a best";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const personalRecordsInputSchema = z.object({
  sport: z
    .string()
    .max(100)
    .optional()
    .describe(
      'Only this sport: exact WHOOP sport_name, case-insensitive (e.g. "running"). Default: every sport.'
    ),
  days: z
    .number()
    .int()
    .min(PERSONAL_RECORDS_MIN_DAYS)
    .max(PERSONAL_RECORDS_MAX_DAYS)
    .optional()
    .describe("Local days searched, ending today (30-1095). Default 365."),
  recent_days: z
    .number()
    .int()
    .min(1)
    .max(MAX_RECENT_DAYS)
    .optional()
    .describe(
      "Records set on the last this many local days (today included) are recent (1-60). Default 7."
    ),
});

export type PersonalRecordsInput = z.infer<typeof personalRecordsInputSchema>;

const previousBestSchema = z.object({ value: z.number(), date: z.string() });

const recordSchema = z.object({
  metric: z.enum(RECORD_METRICS),
  label: z.string(),
  value: z.number(),
  unit: z.enum(RECORD_UNITS),
  workout_id: z.string(),
  date: z.string().describe("Local day the session counts toward (its WHOOP cycle's day)"),
  start_local: z.string(),
  previous_best: previousBestSchema
    .nullable()
    .describe(
      "The best among earlier sessions when this record was set; null without one or with fewer than 3 sessions"
    ),
  improvement_pct: z
    .number()
    .nullable()
    .describe("Improvement over previous_best in percent (for pace: how much faster)"),
  set_within_recent_days: z.boolean(),
});

export const personalRecordsOutputSchema = z.object({
  period: z.object({
    start_day: z.string(),
    end_day: z.string(),
    days: z.number().int(),
    history_complete: z
      .boolean()
      .describe(
        "True only when WHOOP has no workouts before start_day and the whole period was read: the records then cover every recorded workout"
      ),
  }),
  sports: z.array(
    z.object({
      sport_name: z.string(),
      sport_id: z.number().int().nullable().describe("Deprecated WHOOP sport id; 0 is running"),
      sessions_considered: z.number().int().describe("Scored sessions of this sport in the period"),
      status: z.enum(["available", "few_sessions"]),
      records: z.array(recordSchema),
      excluded: z
        .object({
          not_scored: z.number().int(),
          low_recording: z
            .number()
            .int()
            .describe("Scored sessions recorded under 90%: left out of the heart-rate records"),
          gps_suspect: z
            .number()
            .int()
            .describe("Sessions with implausible GPS speed: left out of the GPS records"),
        })
        .describe("Sessions left out of some or all records"),
    })
  ),
  recent_records: z.array(recordSchema.extend({ sport_name: z.string() })),
  max_hr_check: z.object({
    body_max_heart_rate: z
      .number()
      .nullable()
      .describe("Current maximum heart rate from the WHOOP body measurement"),
    highest_workout_max_hr: z.number().nullable(),
    workout_id: z.string().nullable(),
    exceeds_body_max: z.boolean().nullable(),
  }),
  output_capped: z.boolean(),
  truncated: z.boolean(),
  notes: z.array(z.string()),
  warnings: z.array(z.string()),
  disclaimer: z.string(),
  data_quality: dataQualitySchema,
});

export type PersonalRecordsOutput = z.infer<typeof personalRecordsOutputSchema>;
type RecordEntry = z.infer<typeof recordSchema>;
type SportEntry = PersonalRecordsOutput["sports"][number];

const probePageSchema = z.object({ records: z.array(z.unknown()) });
const bodySchema = z.object({ max_heart_rate: z.number().finite().positive() }).passthrough();

// ---------------------------------------------------------------------------
// Record computation
// ---------------------------------------------------------------------------

/** A scored session with the values records are computed from */
export interface RecordSession {
  summary: WorkoutSummary;
  startMs: number;
}

interface Candidate {
  session: RecordSession;
  value: number;
}

function isBetter(value: number, best: number, better: "higher" | "lower"): boolean {
  return better === "higher" ? value > best : value < best;
}

/** Whether a session may set `definition`'s record */
function eligibleValue(definition: MetricDefinition, summary: WorkoutSummary): number | null {
  if (definition.basis === "heart_rate") {
    if (summary.recorded_fraction === null || summary.recorded_fraction < MIN_RECORDED_FRACTION) {
      return null;
    }
  } else if (summary.gps === null || summary.flags.includes("gps_suspect")) {
    return null;
  }
  const value = definition.value(summary);
  // A best of 0 (no zone 4-5 minutes, no elevation) is not a record.
  return value !== null && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * The records of one sport's scored sessions. Sessions are walked in start
 * order; a later session sets a new record only when strictly better, so ties
 * keep the earlier session. previous_best is the best before the record
 * session; with `fewSessions` it and the improvement are null.
 */
export function computeRecords(
  sessions: readonly RecordSession[],
  options: { fewSessions: boolean; recentFromDay: string }
): RecordEntry[] {
  const ordered = [...sessions].sort(
    (left, right) =>
      left.startMs - right.startMs ||
      (left.summary.id < right.summary.id ? -1 : left.summary.id > right.summary.id ? 1 : 0)
  );
  const records: RecordEntry[] = [];
  for (const definition of METRICS) {
    let best: Candidate | null = null;
    let previous: Candidate | null = null;
    for (const session of ordered) {
      const value = eligibleValue(definition, session.summary);
      if (value === null) continue;
      if (best === null) {
        best = { session, value };
      } else if (isBetter(value, best.value, definition.better)) {
        previous = best;
        best = { session, value };
      }
    }
    if (best === null) continue;
    const summary = best.session.summary;
    const prior = options.fewSessions ? null : previous;
    const improvement =
      prior === null || prior.value <= 0
        ? null
        : roundTo(
            ((definition.better === "higher"
              ? best.value - prior.value
              : prior.value - best.value) /
              prior.value) *
              100,
            1
          );
    records.push({
      metric: definition.metric,
      label: definition.label,
      value: roundTo(best.value, definition.digits),
      unit: definition.unit,
      workout_id: summary.id,
      date: summary.day,
      start_local: summary.start_local,
      previous_best:
        prior === null
          ? null
          : {
              value: roundTo(prior.value, definition.digits),
              date: prior.session.summary.day,
            },
      improvement_pct: improvement,
      set_within_recent_days: summary.day >= options.recentFromDay,
    });
  }
  return records;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

async function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await promise };
  } catch (error: unknown) {
    return { ok: false, error };
  }
}

function namesOf(names: readonly string[]): string {
  const unique = [...new Set(names)].sort();
  const shown = unique.slice(0, MAX_NAMED_SPORTS);
  const more = unique.length - shown.length;
  return `${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
}

function singleSourceQuality(
  status: SourceQuality["status"],
  fetchedAt: string | null
): SourceQuality {
  const quality = sourceQuality(status === "available" ? 1 : 0, false);
  quality.status = status;
  quality.fetched_at = fetchedAt;
  quality.cache_status = "unknown";
  quality.records_used = status === "available" ? 1 : 0;
  return quality;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Run get_personal_records.
 *
 * @throws the most relevant WHOOP error when the workout history cannot be read
 */
export async function getPersonalRecords(
  args: PersonalRecordsInput,
  ctx: ToolContext
): Promise<PersonalRecordsOutput> {
  const now = ctx.now();
  const nowMs = now.getTime();
  const { offset: utcOffset, fallback: offsetFallback } = await resolveUserUtcOffsetInfo(
    ctx.client
  );
  const today = localDay(now.toISOString(), utcOffset);
  const days = args.days ?? PERSONAL_RECORDS_DEFAULT_DAYS;
  const recentDays = args.recent_days ?? DEFAULT_RECENT_DAYS;
  const startDay = addDays(today, -(days - 1));
  const recentFromDay = addDays(today, -(recentDays - 1));
  const windowStartMs = localMidnightMs(startDay, utcOffset);
  const notes: string[] = [];
  const warnings: string[] = [];

  // --- Load ------------------------------------------------------------------

  const options = historyOptions(ctx);
  const range = fetchRangeForDays(startDay, today, utcOffset, nowMs);
  const period = {
    start: new Date(range.startMs).toISOString(),
    end: new Date(range.endMs).toISOString(),
  };
  const probeQuery = new URLSearchParams({
    end: new Date(windowStartMs).toISOString(),
    limit: "1",
  });
  const probePromise = settle(
    ctx.client
      .get<unknown>(`${ENDPOINT_WORKOUT}?${probeQuery.toString()}`, {
        cache: true,
        ttlMs: OLDER_WORKOUTS_PROBE_TTL_MS,
        deadlineMs: options.budget.deadlineMs,
      })
      .then((page) => probePageSchema.parse(page).records.length > 0)
  );
  const bodyPromise = settle(
    ctx.client
      .get<unknown>(ENDPOINT_BODY_MEASUREMENT, {
        cache: true,
        ttlMs: PROFILE_TTL_MS,
        deadlineMs: options.budget.deadlineMs,
      })
      .then((raw) => bodySchema.parse(raw).max_heart_rate)
  );
  const workouts = await loadHistory<Workout>(
    ctx.client,
    ENDPOINT_WORKOUT,
    period,
    workoutRecordSchema,
    options
  );
  if (workouts.quality.status === "fetch_failed") {
    const probeResult = await probePromise;
    await bodyPromise;
    throw mostRelevantError(
      [workouts.error, probeResult.ok ? undefined : probeResult.error].filter(
        (error) => error !== undefined
      )
    );
  }
  // Cycles only date the loaded workouts, so they are read from two local days
  // before the earliest one: a sparse or new account then spends its request
  // budget on the workout history instead of empty cycle chunks.
  const earliestStartMs = workouts.records.reduce(
    (earliest, workout) => Math.min(earliest, Date.parse(workout.start)),
    Infinity
  );
  const cyclesStartMs = !Number.isFinite(earliestStartMs)
    ? range.endMs
    : Math.max(
        range.startMs,
        localMidnightMs(
          addDays(localDay(new Date(earliestStartMs).toISOString(), utcOffset), -2),
          utcOffset
        )
      );
  const [cycles, probe, body] = await Promise.all([
    loadHistory<Cycle>(
      ctx.client,
      ENDPOINT_CYCLE,
      { start: new Date(Math.min(cyclesStartMs, range.endMs)).toISOString(), end: period.end },
      cycleRecordSchema,
      options
    ),
    probePromise,
    bodyPromise,
  ]);
  warnings.push(
    ...sourceWarnings("Workout", workouts, "no records can be listed"),
    ...sourceWarnings("Cycle", cycles, "sessions are dated by their local start day")
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
  const sportFilter = args.sport !== undefined ? sportKey(args.sport) : null;

  interface SportGroup {
    sport_name: string;
    sport_id: number | null;
    latestStartMs: number;
    sessions: RecordSession[];
    records: Workout[];
    notScored: number;
    lowRecording: number;
    gpsSuspect: number;
  }
  const groups = new Map<string, SportGroup>();
  const allSports = new Map<string, number>();
  let olderLoaded = false;
  let fallbackCount = 0;
  let notScoredTotal = 0;
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
    if (summary.day < startDay) {
      olderLoaded = true;
      exclude(workoutQuality, "outside_window");
      continue;
    }
    if (summary.day > today) {
      exclude(workoutQuality, "outside_window");
      continue;
    }
    allSports.set(summary.sport_name, (allSports.get(summary.sport_name) ?? 0) + 1);
    if (sportFilter !== null && sportKey(summary.sport_name) !== sportFilter) {
      exclude(workoutQuality, "other_sport");
      continue;
    }
    const startMs = Date.parse(workout.start);
    const key = summary.sport_name;
    let group = groups.get(key);
    if (!group) {
      group = {
        sport_name: summary.sport_name,
        sport_id: summary.sport_id,
        latestStartMs: startMs,
        sessions: [],
        records: [],
        notScored: 0,
        lowRecording: 0,
        gpsSuspect: 0,
      };
      groups.set(key, group);
    }
    if (startMs > group.latestStartMs) {
      group.latestStartMs = startMs;
      group.sport_id = summary.sport_id;
    }
    if (summary.flags.includes("day_by_fallback")) fallbackCount += 1;
    if (summary.flags.includes("not_scored")) {
      group.notScored += 1;
      notScoredTotal += 1;
      exclude(workoutQuality, workout.score_state === "PENDING_SCORE" ? "pending" : "unscored");
      continue;
    }
    if (summary.flags.includes("low_recording")) group.lowRecording += 1;
    if (summary.flags.includes("gps_suspect")) group.gpsSuspect += 1;
    group.sessions.push({ summary, startMs });
    group.records.push(workout);
  }

  // --- Records per sport -------------------------------------------------------------

  const orderedGroups = [...groups.values()].sort(
    (left, right) =>
      right.sessions.length - left.sessions.length ||
      (left.sport_name < right.sport_name ? -1 : left.sport_name > right.sport_name ? 1 : 0)
  );
  const listedGroups = orderedGroups.slice(0, MAX_RECORD_SPORTS);
  const sportsCapped = orderedGroups.length > listedGroups.length;
  const sports: SportEntry[] = listedGroups.map((group) => {
    const fewSessions = group.sessions.length < MIN_RECORD_SESSIONS;
    return {
      sport_name: group.sport_name,
      sport_id: group.sport_id,
      sessions_considered: group.sessions.length,
      status: fewSessions ? "few_sessions" : "available",
      records: computeRecords(group.sessions, { fewSessions, recentFromDay }),
      excluded: {
        not_scored: group.notScored,
        low_recording: group.lowRecording,
        gps_suspect: group.gpsSuspect,
      },
    };
  });
  const usedRecords = listedGroups.flatMap((group) => group.records);
  for (const group of orderedGroups.slice(MAX_RECORD_SPORTS)) {
    for (let index = 0; index < group.records.length; index++) {
      exclude(workoutQuality, "sport_not_listed");
    }
  }

  const allRecent = sports
    .flatMap((sport) =>
      sport.records
        .filter((record) => record.set_within_recent_days)
        .map((record) => ({ ...record, sport_name: sport.sport_name }))
    )
    .sort(
      (left, right) =>
        (left.date < right.date ? 1 : left.date > right.date ? -1 : 0) ||
        (left.sport_name < right.sport_name ? -1 : left.sport_name > right.sport_name ? 1 : 0) ||
        RECORD_METRICS.indexOf(left.metric) - RECORD_METRICS.indexOf(right.metric)
    );
  const recentRecords = allRecent.slice(0, MAX_RECENT_RECORDS);
  const recentCapped = allRecent.length > recentRecords.length;

  // --- Max heart rate check -------------------------------------------------------------

  // The same qualifying sessions as highest_workout_max_hr; a tie keeps the earlier session.
  let highestHr: { value: number; id: string; startMs: number } | null = null;
  for (const group of listedGroups) {
    for (const session of group.sessions) {
      const summary = session.summary;
      if (
        summary.max_heart_rate === null ||
        summary.recorded_fraction === null ||
        summary.recorded_fraction < MIN_RECORDED_FRACTION
      ) {
        continue;
      }
      if (
        highestHr === null ||
        summary.max_heart_rate > highestHr.value ||
        (summary.max_heart_rate === highestHr.value && session.startMs < highestHr.startMs)
      ) {
        highestHr = { value: summary.max_heart_rate, id: summary.id, startMs: session.startMs };
      }
    }
  }
  const bodyMax = body.ok ? body.value : null;
  if (!body.ok) {
    warnings.push(
      `The WHOOP body measurement could not be read (${failureReason(body.error)}), so body_max_heart_rate and exceeds_body_max are null.`
    );
  }
  const maxHrCheck: PersonalRecordsOutput["max_hr_check"] = {
    body_max_heart_rate: bodyMax === null ? null : roundTo(bodyMax, 0),
    highest_workout_max_hr: highestHr === null ? null : roundTo(highestHr.value, 0),
    workout_id: highestHr?.id ?? null,
    exceeds_body_max: bodyMax === null || highestHr === null ? null : highestHr.value > bodyMax,
  };
  notes.push(
    "Heart-rate zones follow the maximum heart rate set in WHOOP; body_max_heart_rate is only the current value, and earlier settings are not available."
  );
  if (maxHrCheck.exceeds_body_max === true) {
    notes.push(
      "The highest workout max heart rate in this period is above the current maximum heart rate in the WHOOP body measurement."
    );
  }

  // --- History completeness ------------------------------------------------------------

  const probeFound = probe.ok ? probe.value : null;
  const historyComplete =
    probeFound === false &&
    !olderLoaded &&
    !workouts.quality.truncated &&
    !sourceUnreadable(workouts);
  const scope = `${startDay} to ${today}`;
  if (historyComplete) {
    notes.push(
      `WHOOP has no workouts before ${startDay} and the whole period was read: these records cover every workout on this account (all-time).`
    );
  } else if (probeFound === true || olderLoaded) {
    notes.push(
      `WHOOP has workouts before ${startDay}, outside this period: the records are the bests from ${scope} only.`
    );
  } else if (!probe.ok) {
    warnings.push(
      `Whether WHOOP has workouts before ${startDay} could not be read (${failureReason(probe.error)}).`
    );
    notes.push(`The records are the bests from ${scope} only; older workouts were not checked.`);
  } else {
    notes.push(
      `Not every part of ${scope} was read: the records are the bests among the sessions loaded.`
    );
  }
  const workoutTruncation = truncationNote(
    "Workout",
    workouts,
    utcOffset,
    "records from that part of the period may be missing"
  );
  if (workoutTruncation) notes.push(workoutTruncation);
  const cycleTruncation = truncationNote(
    "Cycle",
    cycles,
    utcOffset,
    "sessions from that part of the period may be dated by their local start day"
  );
  if (cycleTruncation) notes.push(cycleTruncation);

  // --- Notes --------------------------------------------------------------------------

  if (sportFilter !== null && groups.size === 0) {
    notes.push(
      allSports.size > 0
        ? `No session in ${scope} has the sport "${args.sport}"; the sports present are ${namesOf([...allSports.keys()])}.`
        : `No WHOOP workouts are placed on ${scope}.`
    );
  } else if (groups.size === 0 && !sourceUnreadable(workouts)) {
    notes.push(`No WHOOP workouts are placed on ${scope}.`);
  }
  const fewSports = sports.filter((sport) => sport.status === "few_sessions");
  if (fewSports.length > 0) {
    notes.push(
      `${namesOf(fewSports.map((sport) => sport.sport_name))}: ${FEW_SESSIONS_NOTE}, so previous_best and improvement_pct are null.`
    );
  }
  if (sports.some((sport) => sport.records.some((record) => record.unit === "sec_per_km"))) {
    notes.push(
      "The fastest_pace records are each session's average pace over its whole elapsed time (pauses included), over sessions of at least the named distance; they are not split times within a longer session."
    );
  }
  const lowRecording = sports.reduce((sum, sport) => sum + sport.excluded.low_recording, 0);
  if (lowRecording > 0) {
    notes.push(
      `${plural(lowRecording, "scored session")} recorded heart rate for less than 90% of ${lowRecording === 1 ? "its" : "their"} duration: ${lowRecording === 1 ? "it is" : "they are"} left out of the duration, energy, strain, TRIMP, high-intensity and max heart rate records, while GPS distance, elevation and pace still count.`
    );
  }
  const gpsSuspect = sports.reduce((sum, sport) => sum + sport.excluded.gps_suspect, 0);
  if (gpsSuspect > 0) {
    notes.push(
      `${plural(gpsSuspect, "session")} ${gpsSuspect === 1 ? "has" : "have"} an implausible GPS speed (over 25 m/s) or lasted under a minute: left out of the distance, elevation and pace records.`
    );
  }
  if (notScoredTotal > 0) {
    notes.push(
      `${plural(notScoredTotal, "session")} ${notScoredTotal === 1 ? "is" : "are"} not scored by WHOOP (pending or unscorable) and ${notScoredTotal === 1 ? "sets" : "set"} no records.`
    );
  }
  const strengthSports = sports
    .filter((sport) => HR_ZONE_CAVEAT_SPORT.test(sport.sport_name) && sport.records.length > 0)
    .map((sport) => sport.sport_name);
  if (strengthSports.length > 0) {
    notes.push(
      `Strain, TRIMP, high-intensity minutes and heart rate follow heart rate, which understates the load of strength sessions (${namesOf(strengthSports)}).`
    );
  }
  if (sportsCapped) {
    notes.push(
      `${orderedGroups.length} sports have sessions; the ${MAX_RECORD_SPORTS} with the most scored sessions are listed. The sport filter shows any other.`
    );
  }
  if (recentCapped) {
    notes.push(
      `${allRecent.length} records were set within the last ${recentDays} days; recent_records lists the ${MAX_RECENT_RECORDS} newest, and every one is marked in sports.`
    );
  }
  if (fallbackCount > 0 && !sourceUnreadable(cycles)) {
    warnings.push(
      `${plural(fallbackCount, "session")} ${fallbackCount === 1 ? "is" : "are"} not inside any loaded WHOOP cycle and ${fallbackCount === 1 ? "is" : "are"} dated by ${fallbackCount === 1 ? "its" : "their"} local start day.`
    );
  }

  // --- Data quality ---------------------------------------------------------------------

  finishQuality(workoutQuality, usedRecords);
  const cycleQuality = cycles.quality;
  const usedCycles: Cycle[] = [];
  for (const cycle of cycles.records) {
    const day = placement.dayOfCycle.get(cycle.id);
    if (day !== undefined && day >= startDay && day <= today) usedCycles.push(cycle);
    else exclude(cycleQuality, "outside_window");
  }
  finishQuality(cycleQuality, usedCycles);
  const bodyQuality = singleSourceQuality(body.ok ? "available" : "fetch_failed", null);
  const probeQuality = singleSourceQuality(probe.ok ? "available" : "fetch_failed", null);
  if (probe.ok) {
    probeQuality.records_fetched = probe.value ? 1 : 0;
    probeQuality.records_used = probeQuality.records_fetched;
    if (!probe.value) probeQuality.status = "missing";
  }

  return {
    period: { start_day: startDay, end_day: today, days, history_complete: historyComplete },
    sports,
    recent_records: recentRecords,
    max_hr_check: maxHrCheck,
    output_capped: sportsCapped || recentCapped,
    truncated: workouts.quality.truncated || cycles.quality.truncated,
    notes: withOffsetNote(notes, offsetFallback),
    warnings,
    disclaimer: DISCLAIMER,
    data_quality: {
      evaluated_at: now.toISOString(),
      requested_period: {
        start: formatLocalTimestamp(windowStartMs, utcOffset),
        end: formatLocalTimestamp(nowMs, utcOffset),
      },
      observed_period: observedSpan(
        listedGroups.flatMap((group) =>
          group.records.map((record) => ({
            startMs: Date.parse(record.start),
            endMs: Date.parse(record.end),
            offset: record.timezone_offset,
          }))
        )
      ),
      sources: {
        workouts: workoutQuality,
        cycles: cycleQuality,
        older_workouts_probe: probeQuality,
        body_measurement: bodyQuality,
      },
      method_version: METHOD_VERSION,
      limitations: [
        ...HISTORY_LIMITATIONS,
        "Records are per WHOOP sport_name over scored sessions; duration, energy, strain, TRIMP, high-intensity minutes and max heart rate need at least 90% of the session recorded, and GPS records need a plausible speed.",
        "Pace records use each session's elapsed average pace (pauses included); WHOOP provides no splits, so a fast stretch inside a longer session is not a record.",
        "A session counts toward the local day of the WHOOP cycle containing its start.",
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Definition
// ---------------------------------------------------------------------------

export const PERSONAL_RECORDS_TOOL = defineTool({
  name: "get_personal_records",
  annotations: { readOnlyHint: true },
  standard: {
    title: "Personal records",
    description:
      "Per-sport bests from WHOOP workouts over the last `days` local days (default 365, up to 1095): longest session, most kJ, highest strain, highest TRIMP, most zone 4-5 minutes, highest workout max heart rate (these need >= 90% recorded), farthest GPS distance, most elevation gain, and the fastest average pace over sessions of at least 1 km, 5 km, 10 km, half marathon and marathon (whole-session elapsed pace, not splits; implausible GPS excluded). Each record gives its session id and local day, the previous best and improvement_pct, and set_within_recent_days (default 7); recent_records collects those. Sports with fewer than 3 scored sessions are few_sessions. max_hr_check compares the highest workout max HR with the WHOOP body max HR. history_complete is true only when WHOOP has no older workouts and the whole period was read. Optional sport filter (exact sport_name, case-insensitive).",
    inputSchema: personalRecordsInputSchema,
    outputSchema: personalRecordsOutputSchema,
    run: getPersonalRecords,
  },
});
