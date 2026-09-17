/**
 * Tool: get_workout_context
 *
 * One workout in context: the local day it counts toward (with that WHOOP
 * cycle's strain and the day's other sessions), the recovery before it (the
 * morning of its cycle), the sleep and recovery after it (the next cycle), and
 * how it compares with earlier sessions of the same sport.
 *
 * Joins use collections only: the workout by id, then cycles, sleeps and
 * recoveries around its day and workouts over the comparison window, all read
 * as cached history within one request budget. The following cycle is found by
 * its exact start (nextCycle), never by position, so a strap-off gap never
 * borrows a later night.
 */

import { z } from "zod";
import {
  ENDPOINT_CYCLE,
  ENDPOINT_RECOVERY,
  ENDPOINT_SLEEP,
  ENDPOINT_WORKOUT,
} from "../api/endpoints.js";
import {
  HISTORY_LIMITATIONS,
  loadConsistentHistory,
  loadHistory,
  type HistorySource,
} from "../api/history.js";
import {
  cycleRecordSchema,
  recoveryRecordSchema,
  sleepRecordSchema,
  workoutRecordSchema,
} from "../api/record-schemas.js";
import type { Cycle, Recovery, Sleep, Workout } from "../api/types.js";
import {
  asleepHours,
  dataQualitySchema,
  DAY_MS,
  DISCLAIMER,
  exclude,
  finishQuality,
  formatLocalTimestamp,
  HOUR_MS,
  localDay,
  localMidnightMs,
  mostRelevantError,
  recoveryZone,
  sourceQuality,
  type SourceQuality,
} from "./analytics-utils.js";
import { resolveUserUtcOffsetInfo, withOffsetNote } from "./collection-utils.js";
import {
  addDays,
  assignWorkouts,
  cycleStrain,
  isOpenCycle,
  nextCycle,
  placeDays,
} from "./day-model.js";
import {
  historyOptions,
  observedSpan,
  plural,
  sportKey,
  sourceUnreadable,
  sourceWarnings,
  truncationNote,
} from "./get-workout-log.js";
import { LONG_CYCLE_MS, STALE_SLEEP_MS } from "./get-today.js";
import { median, percentileRank, roundTo } from "./stats-utils.js";
import { defineTool, type ToolContext } from "./tool-definition.js";
import {
  HR_ZONE_CAVEAT_SPORT,
  MIN_RECORDED_FRACTION,
  normalizeWorkout,
  roundWorkoutSummary,
  workoutSummarySchema,
  type WorkoutSummary,
} from "./workout-utils.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Earlier same-sport sessions a percentile or typical value needs */
export const MIN_PRIOR_SESSIONS = 5;

/** Days searched for earlier sessions without `compare_days` */
export const DEFAULT_COMPARE_DAYS = 90;

/** Shortest GPS session (km) whose pace is compared */
export const PACE_MIN_DISTANCE_KM = 1;

/** Most other sessions listed for the day */
export const MAX_OTHER_WORKOUTS = 20;

/** Local days before the session's day read for cycles, sleeps and recoveries */
export const CONTEXT_DAYS_BEFORE = 3;

/** Time after the session start read for cycles, sleeps and recoveries */
export const CONTEXT_AFTER_MS = 3 * DAY_MS;

/** Time after the session start read for workouts (the rest of its day) */
export const WORKOUTS_AFTER_MS = 2 * DAY_MS;

const METHOD_VERSION = "workout-context-1";

/** Note added when the recovery before the session is available */
export const MORNING_RECOVERY_NOTE = "Morning recovery was scored before this session.";

/** Note while the session's cycle is still open (after.status not_yet) */
export const OPEN_CYCLE_NOTE =
  "The session's WHOOP cycle is still open: WHOOP has not processed a sleep after the session yet, so there is no sleep or recovery after it to show.";

/** Note on every result: one session and one night are a single observation */
export const SINGLE_OBSERVATION_NOTE =
  "One session and the night after it are a single observation: sleep and recovery vary from night to night with many other factors (other activity, timing, meals, alcohol, stress, illness, travel), so this does not show an effect of the session.";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const workoutContextInputSchema = z.object({
  id: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,64}$/)
    .describe("Workout id (UUID) from get_workout_log or get_workout_collection."),
  compare_days: z
    .number()
    .int()
    .min(14)
    .max(365)
    .optional()
    .describe(
      "Days before the session searched for earlier sessions of the same sport (14-365). Default 90."
    ),
});

export type WorkoutContextInput = z.infer<typeof workoutContextInputSchema>;

const recoveryValues = {
  score: z.number().nullable(),
  zone: z.enum(["green", "yellow", "red"]).nullable(),
  hrv_rmssd_milli: z.number().nullable(),
  resting_heart_rate: z.number().nullable(),
  calibrating: z.boolean().nullable(),
};

const partStatusSchema = z.enum(["available", "pending", "missing", "unavailable"]);
type PartStatus = z.infer<typeof partStatusSchema>;

export const workoutContextOutputSchema = z.object({
  workout: workoutSummarySchema,
  day: z.object({
    date: z
      .string()
      .nullable()
      .describe("Local day of the WHOOP cycle containing the session; null when no cycle does"),
    day_strain: z
      .number()
      .nullable()
      .describe("Strain of that WHOOP cycle once it has ended (null while in progress)"),
    in_progress: z.boolean(),
    partial: z.boolean().describe("The first day WHOOP was worn: strain covers part of the day"),
    other_workouts: z.array(
      z.object({
        id: z.string(),
        sport_name: z.string(),
        start_local: z.string(),
        strain: z.number().nullable(),
      })
    ),
  }),
  before: z.object({
    recovery: z
      .object({ status: partStatusSchema, ...recoveryValues })
      .describe("Recovery of the session's cycle, from the sleep before the session"),
  }),
  after: z
    .object({
      status: z.enum(["available", "pending", "missing", "unavailable", "not_yet"]),
      date: z.string().nullable().describe("Local day of the next WHOOP cycle"),
      gap_to_sleep_onset_hours: z
        .number()
        .nullable()
        .describe("Hours from the session end to the next sleep onset"),
      sleep: z
        .object({
          asleep_hours: z.number().nullable(),
          performance_pct: z.number().nullable(),
          efficiency_pct: z.number().nullable(),
          need_from_recent_strain_hours: z.number().nullable(),
        })
        .nullable(),
      recovery: z.object(recoveryValues).nullable(),
    })
    .describe("The main sleep ending the session's cycle and the recovery scored from it"),
  comparison: z.object({
    sport_name: z.string(),
    compare_days: z.number().int(),
    prior_sessions: z
      .number()
      .int()
      .describe("Earlier scored sessions of the same sport_name within compare_days"),
    required_prior_sessions: z.number().int(),
    status: z.enum(["available", "insufficient_data", "unavailable"]),
    percentiles: z
      .object({
        duration: z.number().nullable(),
        strain: z.number().nullable(),
        trimp: z.number().nullable(),
        average_heart_rate: z.number().nullable(),
        pace_faster_than_pct: z
          .number()
          .nullable()
          .describe("Share of earlier GPS sessions (>= 1 km) this session was faster than"),
        beats_per_km: z
          .number()
          .nullable()
          .describe(
            "Mid-rank percentile of beats per km (share of earlier GPS sessions with fewer beats per km): a low percentile means fewer beats per km than most earlier sessions; beats per km also falls with faster pace and varies with terrain and heat"
          ),
      })
      .describe(
        "Mid-rank percentile among earlier sessions (share lower plus half of equal); null below required_prior_sessions"
      ),
    typical: z
      .object({
        duration_minutes: z.number().nullable(),
        strain: z.number().nullable(),
        trimp: z.number().nullable(),
        average_heart_rate: z.number().nullable(),
        pace_sec_per_km: z.number().nullable(),
      })
      .describe("Medians of earlier sessions"),
    sample_sizes: z.object({
      duration: z.number().int(),
      strain: z.number().int(),
      trimp: z.number().int(),
      average_heart_rate: z.number().int(),
      pace: z.number().int(),
      beats_per_km: z.number().int(),
    }),
  }),
  output_capped: z.boolean(),
  truncated: z.boolean(),
  notes: z.array(z.string()),
  warnings: z.array(z.string()),
  disclaimer: z.string(),
  data_quality: dataQualitySchema,
});

export type WorkoutContextOutput = z.infer<typeof workoutContextOutputSchema>;
type RecoveryValues = z.infer<z.ZodObject<typeof recoveryValues>>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NO_RECOVERY_VALUES: RecoveryValues = {
  score: null,
  zone: null,
  hrv_rmssd_milli: null,
  resting_heart_rate: null,
  calibrating: null,
};

function recoveryValuesOf(recovery: Recovery): RecoveryValues {
  const score = recovery.score_state === "SCORED" ? recovery.score : null;
  if (!score) return NO_RECOVERY_VALUES;
  return {
    score: score.recovery_score,
    zone: recoveryZone(score.recovery_score),
    hrv_rmssd_milli: roundTo(score.hrv_rmssd_milli, 1),
    resting_heart_rate: roundTo(score.resting_heart_rate, 0),
    calibrating: score.user_calibrating,
  };
}

function recoveryState(recovery: Recovery | undefined, unavailable: boolean): PartStatus {
  if (unavailable) return "unavailable";
  if (!recovery) return "missing";
  if (recovery.score_state === "PENDING_SCORE") return "pending";
  return recovery.score_state === "SCORED" && recovery.score ? "available" : "missing";
}

function sleepState(sleep: Sleep | undefined, unavailable: boolean): PartStatus {
  if (unavailable) return "unavailable";
  if (!sleep) return "missing";
  if (sleep.score_state === "PENDING_SCORE") return "pending";
  return sleep.score_state === "SCORED" && sleep.score ? "available" : "missing";
}

function byStart(left: Workout, right: Workout): number {
  return (
    Date.parse(left.start) - Date.parse(right.start) ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  );
}

function hrQualifies(summary: WorkoutSummary): boolean {
  return summary.recorded_fraction !== null && summary.recorded_fraction >= MIN_RECORDED_FRACTION;
}

function paceQualifies(summary: WorkoutSummary): boolean {
  return (
    summary.gps !== null &&
    summary.gps.distance_km >= PACE_MIN_DISTANCE_KM &&
    !summary.flags.includes("gps_suspect")
  );
}

/** Unrounded mid-rank percentile; null without a value or below MIN_PRIOR_SESSIONS */
function percentileOf(values: readonly number[], value: number | null): number | null {
  if (value === null || values.length < MIN_PRIOR_SESSIONS) return null;
  return percentileRank(values, value);
}

function typicalOf(values: readonly number[], digits: number): number | null {
  return values.length < MIN_PRIOR_SESSIONS ? null : roundTo(median([...values]), digits);
}

function sourceQualityOfRecord(workout: Workout, nowIso: string): SourceQuality {
  const quality = sourceQuality(1, false);
  quality.fetched_at = nowIso;
  quality.cache_status = "miss";
  quality.records_used = 1;
  quality.source_updated_at = workout.updated_at;
  quality.status =
    workout.score_state === "SCORED" && workout.score
      ? "available"
      : workout.score_state === "PENDING_SCORE"
        ? "pending"
        : "unscored";
  return quality;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Run get_workout_context.
 *
 * @throws the WHOOP error when the workout cannot be read (404 for an unknown id)
 * @throws the most relevant WHOOP error when no history source can be read
 */
export async function getWorkoutContext(
  args: WorkoutContextInput,
  ctx: ToolContext
): Promise<WorkoutContextOutput> {
  const now = ctx.now();
  const nowMs = now.getTime();
  const options = historyOptions(ctx);
  const [raw, offsetInfo] = await Promise.all([
    ctx.client.get<unknown>(`${ENDPOINT_WORKOUT}/${encodeURIComponent(args.id)}`, {
      deadlineMs: options.budget.deadlineMs,
    }),
    resolveUserUtcOffsetInfo(ctx.client),
  ]);
  const workout: Workout = workoutRecordSchema.parse(raw);
  const utcOffset = offsetInfo.offset;
  const today = localDay(now.toISOString(), utcOffset);
  const compareDays = args.compare_days ?? DEFAULT_COMPARE_DAYS;
  const ownOffset = workout.timezone_offset;
  const startMs = Date.parse(workout.start);
  const endMs = Date.parse(workout.end);
  if (!(endMs > startMs)) {
    throw new RangeError("The workout ends at or before its start.");
  }

  // --- Load ------------------------------------------------------------------

  const startDay = localDay(workout.start, ownOffset);
  const contextStartMs = localMidnightMs(addDays(startDay, -CONTEXT_DAYS_BEFORE), ownOffset);
  const contextEndMs = Math.min(startMs + CONTEXT_AFTER_MS, nowMs);
  const workoutsStartMs = startMs - compareDays * DAY_MS;
  const workoutsEndMs = Math.min(startMs + WORKOUTS_AFTER_MS, nowMs);
  const iso = (ms: number): string => new Date(ms).toISOString();
  const contextPeriod = {
    start: iso(contextStartMs),
    end: iso(Math.max(contextEndMs, contextStartMs)),
  };
  const workoutsPeriod = {
    start: iso(workoutsStartMs),
    end: iso(Math.max(workoutsEndMs, workoutsStartMs)),
  };
  const {
    sources: [cycles, sleeps, recoveries, workouts],
    warnings: snapshotWarnings,
  } = await loadConsistentHistory([
    (extra) =>
      loadHistory<Cycle>(ctx.client, ENDPOINT_CYCLE, contextPeriod, cycleRecordSchema, {
        ...options,
        ...extra,
      }),
    (extra) =>
      loadHistory<Sleep>(ctx.client, ENDPOINT_SLEEP, contextPeriod, sleepRecordSchema, {
        ...options,
        ...extra,
      }),
    (extra) =>
      loadHistory<Recovery>(ctx.client, ENDPOINT_RECOVERY, contextPeriod, recoveryRecordSchema, {
        ...options,
        ...extra,
      }),
    (extra) =>
      loadHistory<Workout>(ctx.client, ENDPOINT_WORKOUT, workoutsPeriod, workoutRecordSchema, {
        ...options,
        ...extra,
      }),
  ]);
  const sources: HistorySource<unknown>[] = [cycles, sleeps, recoveries, workouts];
  if (sources.every((source) => source.quality.status === "fetch_failed")) {
    throw mostRelevantError(sources.map((source) => source.error));
  }
  const cyclesUnavailable = sourceUnreadable(cycles);
  const sleepsUnavailable = sourceUnreadable(sleeps);
  const recoveriesUnavailable = sourceUnreadable(recoveries) || cyclesUnavailable;
  const workoutsUnavailable = sourceUnreadable(workouts);

  const notes: string[] = [];
  const warnings: string[] = [
    ...sourceWarnings(
      "Cycle",
      cycles,
      "the session's day, its day strain and the sleep and recoveries around it are unavailable"
    ),
    ...sourceWarnings("Sleep", sleeps, "the sleep after the session is unavailable"),
    ...sourceWarnings(
      "Recovery",
      recoveries,
      "the recoveries before and after the session are unavailable"
    ),
    ...sourceWarnings(
      "Workout",
      workouts,
      "other sessions that day and the comparison with earlier sessions are unavailable"
    ),
    ...snapshotWarnings,
  ];

  // --- Place ----------------------------------------------------------------------

  const placement = placeDays({
    cycles: cycles.records,
    sleeps: sleeps.records,
    recoveries: recoveries.records,
    sleepsAvailable: !sleepsUnavailable,
    today,
    utcOffset,
  });
  const otherRecords = workouts.records.filter((record) => record.id !== workout.id);
  const placements = assignWorkouts([workout, ...otherRecords], placement, cycles.records);
  const ownPlacement = placements.get(workout.id)!;
  const cycle = ownPlacement.fallback ? null : ownPlacement.cycle;
  const rawSummary = normalizeWorkout(workout, ownPlacement, cycle ? isOpenCycle(cycle) : false)!;
  const scored = !rawSummary.flags.includes("not_scored");

  if (!cycle && !cyclesUnavailable) {
    warnings.push(
      "No loaded WHOOP cycle contains this session (for example, the strap was off), so it is placed on its local start day (flag day_by_fallback) and has no day strain, other sessions or recoveries to show."
    );
  }

  // --- Day ------------------------------------------------------------------------

  const workoutQuality = workouts.quality;
  const usedWorkouts = new Map<string, Workout>();
  const others = cycle
    ? otherRecords
        .filter((record) => {
          const other = placements.get(record.id);
          return (
            other !== undefined &&
            !other.fallback &&
            other.day === ownPlacement.day &&
            Date.parse(record.end) > Date.parse(record.start)
          );
        })
        .sort(byStart)
    : [];
  for (const record of others) usedWorkouts.set(record.id, record);
  const listedOthers = others.slice(0, MAX_OTHER_WORKOUTS);
  const otherWorkouts = listedOthers.map((record) => ({
    id: record.id,
    sport_name: record.sport_name,
    start_local: formatLocalTimestamp(Date.parse(record.start), record.timezone_offset),
    strain:
      record.score_state === "SCORED" && record.score ? roundTo(record.score.strain, 2) : null,
  }));
  const partial =
    cycle !== null &&
    placement.partialDays.has(ownPlacement.day) &&
    placement.cycleByDay.get(ownPlacement.day)?.id === cycle.id;
  const inProgress = cycle !== null && isOpenCycle(cycle);
  const dayStrain = cycle && !inProgress ? cycleStrain(cycle) : null;

  if (ownPlacement.after_midnight_in_previous_cycle) {
    notes.push(
      `This session started after local midnight on ${rawSummary.local_date} but counts toward ${ownPlacement.day}: the WHOOP cycle begun at the previous sleep had not ended yet.`
    );
  }
  if (partial) {
    notes.push(
      "The session is on the first day WHOOP was worn: its cycle started at local midnight without a sleep, so there is no recovery before it and the day strain covers only part of the day."
    );
  }
  if (others.length > MAX_OTHER_WORKOUTS) {
    notes.push(
      `The day has ${plural(others.length, "other session")}; the first ${MAX_OTHER_WORKOUTS} by start are listed.`
    );
  }
  if (
    cycle &&
    !workoutsUnavailable &&
    (workouts.complete_since === null ||
      Date.parse(workouts.complete_since) > Date.parse(cycle.start))
  ) {
    notes.push(
      "Workout history for this day was not read completely, so other_workouts may be incomplete."
    );
  }

  // --- Before -------------------------------------------------------------------------

  const beforeRecovery = cycle ? placement.recoveryByCycle.get(cycle.id) : undefined;
  const beforeStatus = recoveryState(beforeRecovery, recoveriesUnavailable);
  const before = {
    recovery: {
      status: beforeStatus,
      ...(beforeRecovery && !recoveriesUnavailable
        ? recoveryValuesOf(beforeRecovery)
        : NO_RECOVERY_VALUES),
    },
  };
  if (beforeStatus === "available" && beforeRecovery) {
    // The recovery always reflects the sleep that started the cycle; WHOOP may
    // only score it after a session that began soon after waking.
    notes.push(
      Date.parse(beforeRecovery.created_at) <= startMs
        ? MORNING_RECOVERY_NOTE
        : "Morning recovery reflects the sleep before this session; WHOOP created the score after the session started."
    );
  }

  // --- After --------------------------------------------------------------------------

  let afterStatus: WorkoutContextOutput["after"]["status"];
  let next: Cycle | undefined;
  let nextSleep: Sleep | undefined;
  let nextRecovery: Recovery | undefined;
  if (cyclesUnavailable) {
    afterStatus = "unavailable";
  } else if (!cycle) {
    afterStatus = "missing";
  } else if (inProgress) {
    afterStatus = "not_yet";
    notes.push(OPEN_CYCLE_NOTE);
    // WHOOP only closes a cycle once it has processed the next sleep, so an open
    // cycle that began long ago may hide a sleep that is not synced yet.
    const cycleSleep = sleepsUnavailable ? undefined : placement.mainSleepByCycle.get(cycle.id);
    const sleepEndMs = cycleSleep ? Date.parse(cycleSleep.end) : undefined;
    const cycleStartMs = Date.parse(cycle.start);
    const stale =
      sleepEndMs !== undefined
        ? nowMs - sleepEndMs > STALE_SLEEP_MS
        : nowMs - cycleStartMs > LONG_CYCLE_MS;
    if (stale) {
      const since =
        cycleSleep && sleepEndMs !== undefined
          ? `This cycle began with the sleep that ended ${formatLocalTimestamp(sleepEndMs, cycleSleep.timezone_offset)}, about ${Math.round((nowMs - sleepEndMs) / HOUR_MS)} hours ago,`
          : `This cycle began ${formatLocalTimestamp(cycleStartMs, cycle.timezone_offset)}, about ${Math.round((nowMs - cycleStartMs) / HOUR_MS)} hours ago,`;
      notes.push(
        `${since} and WHOOP has not processed a newer one. If you have slept since then, WHOOP has not processed that sleep yet (or did not detect it); opening the WHOOP app to sync may help.`
      );
    }
  } else {
    next = nextCycle(cycle, cycles.records);
    const cycleEndMs = Date.parse(cycle.end!);
    if (!next && cycleEndMs >= contextEndMs && contextEndMs < nowMs) {
      afterStatus = "unavailable";
      notes.push(
        "The session's WHOOP cycle ended more than 3 days after the session started, beyond the records read, so the sleep and recovery after it are not shown."
      );
    } else if (!next) {
      afterStatus = "not_yet";
      notes.push(
        "No WHOOP cycle starts where this session's cycle ended (for example, the strap was off afterwards), so there is no following sleep or recovery to show."
      );
    } else {
      nextSleep = placement.mainSleepByCycle.get(next.id);
      nextRecovery = placement.recoveryByCycle.get(next.id);
      const sleepPart = sleepState(nextSleep, sleepsUnavailable);
      let recoveryPart = recoveryState(nextRecovery, recoveriesUnavailable);
      if (recoveryPart === "missing" && !nextRecovery && sleepPart === "pending") {
        recoveryPart = "pending";
      }
      const parts = [sleepPart, recoveryPart];
      afterStatus = parts.every((part) => part === "available")
        ? "available"
        : parts.includes("pending")
          ? "pending"
          : parts.includes("unavailable")
            ? "unavailable"
            : "missing";
    }
  }
  if (sleepsUnavailable) nextSleep = undefined;
  if (recoveriesUnavailable) nextRecovery = undefined;
  const nextSleepScore =
    nextSleep && nextSleep.score_state === "SCORED" && nextSleep.score ? nextSleep.score : null;
  const onsetMs = nextSleep ? Date.parse(nextSleep.start) : next ? Date.parse(next.start) : null;
  const after: WorkoutContextOutput["after"] = {
    status: afterStatus,
    date: next ? (placement.dayOfCycle.get(next.id) ?? null) : null,
    gap_to_sleep_onset_hours: onsetMs === null ? null : roundTo((onsetMs - endMs) / HOUR_MS, 1),
    sleep: nextSleep
      ? {
          asleep_hours: nextSleepScore && nextSleep ? roundTo(asleepHours(nextSleep), 2) : null,
          performance_pct: nextSleepScore?.sleep_performance_percentage ?? null,
          efficiency_pct: nextSleepScore?.sleep_efficiency_percentage ?? null,
          need_from_recent_strain_hours: nextSleepScore
            ? roundTo(nextSleepScore.sleep_needed.need_from_recent_strain_milli / HOUR_MS, 2)
            : null,
        }
      : null,
    recovery: nextRecovery ? recoveryValuesOf(nextRecovery) : null,
  };
  if (before.recovery.calibrating === true || after.recovery?.calibrating === true) {
    notes.push("WHOOP is still calibrating: recoveries marked calibrating are provisional.");
  }

  // --- Comparison ----------------------------------------------------------------------

  const priors: WorkoutSummary[] = [];
  const priorRecords: Workout[] = [];
  let priorUnscored = 0;
  for (const record of otherRecords) {
    const recordStartMs = Date.parse(record.start);
    if (recordStartMs < workoutsStartMs || recordStartMs >= startMs) {
      if (!usedWorkouts.has(record.id)) exclude(workoutQuality, "outside_window");
      continue;
    }
    if (sportKey(record.sport_name) !== sportKey(workout.sport_name)) {
      if (!usedWorkouts.has(record.id)) exclude(workoutQuality, "other_sport");
      continue;
    }
    if (record.score_state !== "SCORED" || !record.score) {
      priorUnscored += 1;
      if (!usedWorkouts.has(record.id)) {
        exclude(workoutQuality, record.score_state === "PENDING_SCORE" ? "pending" : "unscored");
      }
      continue;
    }
    const summary = normalizeWorkout(record, null, false);
    if (!summary) {
      exclude(workoutQuality, "invalid_duration");
      continue;
    }
    priors.push(summary);
    priorRecords.push(record);
    usedWorkouts.set(record.id, record);
  }
  const target = rawSummary;
  const hrPriors = priors.filter(hrQualifies);
  const pacePriors = priors.filter(paceQualifies);
  const values = {
    duration: priors.map((summary) => summary.duration_minutes),
    strain: hrPriors.flatMap((summary) => (summary.strain === null ? [] : [summary.strain])),
    trimp: hrPriors.flatMap((summary) => (summary.trimp === null ? [] : [summary.trimp])),
    average_heart_rate: hrPriors.flatMap((summary) =>
      summary.average_heart_rate === null ? [] : [summary.average_heart_rate]
    ),
    pace: pacePriors.map((summary) => summary.gps!.avg_pace_sec_per_km),
    beats_per_km: pacePriors.flatMap((summary) =>
      summary.gps?.beats_per_km === null || summary.gps?.beats_per_km === undefined
        ? []
        : [summary.gps.beats_per_km]
    ),
  };
  const targetHr = hrQualifies(target);
  const targetPace = paceQualifies(target);
  const targets = {
    duration: target.duration_minutes,
    strain: targetHr ? target.strain : null,
    trimp: targetHr ? target.trimp : null,
    average_heart_rate: targetHr ? target.average_heart_rate : null,
    pace: targetPace ? target.gps!.avg_pace_sec_per_km : null,
    beats_per_km: targetPace ? (target.gps!.beats_per_km ?? null) : null,
  };
  const pacePercentile = percentileOf(values.pace, targets.pace);
  const comparisonStatus = workoutsUnavailable
    ? "unavailable"
    : values.duration.length >= MIN_PRIOR_SESSIONS
      ? "available"
      : "insufficient_data";
  const comparison: WorkoutContextOutput["comparison"] = {
    sport_name: workout.sport_name,
    compare_days: compareDays,
    prior_sessions: priors.length,
    required_prior_sessions: MIN_PRIOR_SESSIONS,
    status: comparisonStatus,
    percentiles: {
      duration: roundTo(percentileOf(values.duration, targets.duration), 1),
      strain: roundTo(percentileOf(values.strain, targets.strain), 1),
      trimp: roundTo(percentileOf(values.trimp, targets.trimp), 1),
      average_heart_rate: roundTo(
        percentileOf(values.average_heart_rate, targets.average_heart_rate),
        1
      ),
      // Faster = lower pace: the share of earlier paces above this one plus half of the equal ones.
      pace_faster_than_pct: pacePercentile === null ? null : roundTo(100 - pacePercentile, 1),
      beats_per_km: roundTo(percentileOf(values.beats_per_km, targets.beats_per_km), 1),
    },
    typical: {
      duration_minutes: typicalOf(values.duration, 1),
      strain: typicalOf(values.strain, 2),
      trimp: typicalOf(values.trimp, 1),
      average_heart_rate: typicalOf(values.average_heart_rate, 0),
      pace_sec_per_km: typicalOf(values.pace, 0),
    },
    sample_sizes: {
      duration: values.duration.length,
      strain: values.strain.length,
      trimp: values.trimp.length,
      average_heart_rate: values.average_heart_rate.length,
      pace: values.pace.length,
      beats_per_km: values.beats_per_km.length,
    },
  };

  notes.push(SINGLE_OBSERVATION_NOTE);
  if (!scored) {
    notes.push(
      "This session is not scored by WHOOP yet (or could not be scored): its score fields are null and only its duration is compared."
    );
  } else if (!targetHr) {
    notes.push(
      `This session recorded heart rate for ${roundTo((target.recorded_fraction ?? 0) * 100, 1)}% of its duration (under 90%): strain, TRIMP, average heart rate and beats per km are left out of the comparison.`
    );
  }
  if (HR_ZONE_CAVEAT_SPORT.test(workout.sport_name)) {
    notes.push(
      `Heart-rate zones, TRIMP and high-intensity minutes follow heart rate, which understates the load of strength sessions (${workout.sport_name}).`
    );
  }
  if (comparisonStatus === "insufficient_data") {
    notes.push(
      `The comparison needs at least ${MIN_PRIOR_SESSIONS} earlier scored ${workout.sport_name} sessions within ${compareDays} days: ${priors.length} of ${MIN_PRIOR_SESSIONS} found, so percentiles and typical values are null.`
    );
  } else if (comparisonStatus === "available") {
    const shortfalls = (
      [
        [
          "strain, TRIMP and average heart rate (sessions recorded at least 90%)",
          targets.trimp,
          values.trimp.length,
        ],
        [
          "pace (GPS sessions of at least 1 km with plausible speed)",
          targets.pace,
          values.pace.length,
        ],
        [
          "beats per km (GPS sessions of at least 1 km recorded at least 90%)",
          targets.beats_per_km,
          values.beats_per_km.length,
        ],
      ] as const
    )
      .filter(([, value, count]) => value !== null && count < MIN_PRIOR_SESSIONS)
      .map(([label, , count]) => `${label} ${count} of ${MIN_PRIOR_SESSIONS}`);
    if (shortfalls.length > 0) {
      notes.push(
        `Some percentiles are null for lack of qualifying earlier sessions: ${shortfalls.join("; ")}.`
      );
    }
  }
  if (priorUnscored > 0) {
    notes.push(
      `${plural(priorUnscored, `earlier unscored ${workout.sport_name} session`)} ${priorUnscored === 1 ? "is" : "are"} not compared.`
    );
  }
  if (targets.pace !== null) {
    notes.push(
      "Pace is elapsed average pace (pauses included); pace_faster_than_pct is the share of earlier qualifying sessions this one was faster than (equal paces count half), and for beats_per_km a lower value means fewer heartbeats per kilometre."
    );
  }
  if (
    !workoutsUnavailable &&
    (workouts.complete_since === null || Date.parse(workouts.complete_since) > workoutsStartMs)
  ) {
    const note = truncationNote(
      "Workout",
      workouts,
      ownOffset,
      "the comparison may leave out earlier sessions"
    );
    if (note) notes.push(note);
  }
  for (const [label, source, consequence] of [
    ["Cycle", cycles, "the session's day and the following cycle may be incomplete"],
    ["Sleep", sleeps, "the sleep after the session may be missing"],
    ["Recovery", recoveries, "the recoveries around the session may be missing"],
  ] as const) {
    const note = truncationNote(label, source, ownOffset, consequence);
    if (note) notes.push(note);
  }

  // --- Data quality ---------------------------------------------------------------------

  // The session itself, when the collection returned it too, counts as used.
  const listedTarget = workouts.records.find((record) => record.id === workout.id);
  if (listedTarget) usedWorkouts.set(listedTarget.id, listedTarget);
  finishQuality(workoutQuality, [...usedWorkouts.values()]);
  const usedCycles = [cycle, next].filter((value): value is Cycle => Boolean(value));
  for (let index = usedCycles.length; index < cycles.records.length; index++) {
    exclude(cycles.quality, "not_joined");
  }
  finishQuality(cycles.quality, usedCycles);
  const usedSleeps = nextSleep ? [nextSleep] : [];
  for (let index = usedSleeps.length; index < sleeps.records.length; index++) {
    exclude(sleeps.quality, "not_joined");
  }
  finishQuality(sleeps.quality, usedSleeps);
  const usedRecoveries = [beforeRecovery, nextRecovery].filter(
    (value): value is Recovery => value !== undefined && !recoveriesUnavailable
  );
  for (let index = usedRecoveries.length; index < recoveries.records.length; index++) {
    exclude(recoveries.quality, "not_joined");
  }
  finishQuality(recoveries.quality, usedRecoveries);

  const spans = [
    { startMs, endMs, offset: ownOffset },
    ...priorRecords.map((record) => ({
      startMs: Date.parse(record.start),
      endMs: Date.parse(record.end),
      offset: record.timezone_offset,
    })),
    ...others.map((record) => ({
      startMs: Date.parse(record.start),
      endMs: Date.parse(record.end),
      offset: record.timezone_offset,
    })),
    ...usedCycles.map((record) => ({
      startMs: Date.parse(record.start),
      endMs: record.end ? Date.parse(record.end) : nowMs,
      offset: record.timezone_offset,
    })),
    ...usedSleeps.map((record) => ({
      startMs: Date.parse(record.start),
      endMs: Date.parse(record.end),
      offset: record.timezone_offset,
    })),
  ];

  return {
    workout: roundWorkoutSummary(rawSummary),
    day: {
      date: cycle ? ownPlacement.day : null,
      day_strain: roundTo(dayStrain, 2),
      in_progress: inProgress,
      partial,
      other_workouts: otherWorkouts,
    },
    before,
    after,
    comparison,
    output_capped: others.length > MAX_OTHER_WORKOUTS,
    truncated: sources.some((source) => source.quality.truncated),
    notes: withOffsetNote(notes, offsetInfo.fallback),
    warnings,
    disclaimer: DISCLAIMER,
    data_quality: {
      evaluated_at: now.toISOString(),
      requested_period: {
        start: formatLocalTimestamp(Math.min(workoutsStartMs, contextStartMs), ownOffset),
        end: formatLocalTimestamp(Math.max(contextEndMs, workoutsEndMs), ownOffset),
      },
      observed_period: observedSpan(spans),
      sources: {
        workout: sourceQualityOfRecord(workout, now.toISOString()),
        workouts: workoutQuality,
        cycles: cycles.quality,
        sleeps: sleeps.quality,
        recoveries: recoveries.quality,
      },
      method_version: METHOD_VERSION,
      limitations: [
        ...HISTORY_LIMITATIONS,
        "Percentiles compare the session only with earlier sessions of the same sport_name (case-insensitive) within compare_days; strain and heart-rate metrics use sessions recorded at least 90%.",
        "The sleep and recovery after a single session are one observation; no effect of the session is estimated.",
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Definition
// ---------------------------------------------------------------------------

export const WORKOUT_CONTEXT_TOOL = defineTool({
  name: "get_workout_context",
  annotations: { readOnlyHint: true },
  standard: {
    title: "Workout context",
    description:
      "One WHOOP workout in context, by id: the local day it counts toward (the WHOOP cycle containing its start, with that cycle's strain once ended and the day's other sessions), the morning recovery before it, the sleep and recovery after it (the next cycle: sleep hours, performance, efficiency, strain-driven sleep need, recovery, HRV, RHR, hours from session end to sleep onset), and percentiles against earlier sessions of the same sport within compare_days (duration, strain, TRIMP, average heart rate, pace, beats per km; at least 5 earlier sessions each; strain and heart-rate metrics only from sessions recorded at least 90%). after.status is not_yet while the cycle is open or when no cycle follows (strap off), pending while WHOOP scores the night, missing or unavailable otherwise. One night after one session is a single observation, not an effect of the session.",
    inputSchema: workoutContextInputSchema,
    outputSchema: workoutContextOutputSchema,
    run: getWorkoutContext,
  },
});
