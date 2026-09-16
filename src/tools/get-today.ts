/**
 * Tool: get_today
 *
 * Composite tool that fetches today's recovery, last night's sleep,
 * current cycle strain, and most recent workout in parallel.
 * Returns a unified snapshot with a human-readable summary and notes.
 *
 * "Today" is the current WHOOP cycle: the open cycle that contains now. A cycle
 * starts at sleep onset (usually the previous local evening) and stays open
 * until the next sleep, so it is selected by containment rather than by the
 * calendar date of its start. Last night's main sleep and this morning's
 * recovery are joined to it by cycle_id / sleep_id.
 */

import type { WhoopClient } from "../api/client.js";
import type {
  RecoveryCollection,
  SleepCollection,
  CycleCollection,
  WorkoutCollection,
} from "../api/types.js";
import {
  ENDPOINT_RECOVERY,
  ENDPOINT_SLEEP,
  ENDPOINT_WORKOUT,
  ENDPOINT_CYCLE,
} from "../api/endpoints.js";
import { DYNAMIC_TTL_MS, CYCLE_TTL_MS } from "../resources/index.js";
import {
  cycleRecordSchema,
  recoveryRecordSchema,
  sleepRecordSchema,
  workoutRecordSchema,
} from "../api/record-schemas.js";
import {
  asleepHours,
  DAY_MS,
  localDay,
  localTime,
  mostRelevantError,
  observedPeriod,
  parseRecords,
  sourceQuality,
  type DataQuality,
  type SourceQuality,
} from "./analytics-utils.js";
import { resolveDateExpression } from "./date-utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TodayRecovery {
  score: number;
  hrv_rmssd_milli: number;
  resting_heart_rate: number;
  spo2_pct: number | null;
  skin_temp_celsius: number | null;
  /** WHOOP is still learning the user's baselines; the score is provisional */
  user_calibrating: boolean;
}

export interface TodaySleep {
  /** Time asleep (light + slow-wave + REM); same value as asleep_hours */
  total_hours: number;
  /** Time in bed, including awake time */
  time_in_bed_hours: number;
  asleep_hours: number;
  rem_hours: number;
  deep_hours: number;
  light_hours: number;
  awake_hours: number;
  performance_pct: number | null;
  efficiency_pct: number | null;
  respiratory_rate: number | null;
}

export interface TodayLastWorkout {
  sport_name: string;
  strain: number;
  occurred_at: string;
  percent_recorded: number;
}

export interface TodayStrain {
  day_strain: number;
  energy_burned_kj: number;
  last_workout: TodayLastWorkout | null;
}

export interface TodaySnapshot {
  timestamp: string;
  recovery: TodayRecovery | null;
  sleep: TodaySleep | null;
  strain: TodayStrain | null;
  summary: string;
  /** Plain-language explanations of calibrating, missing or unavailable sections */
  notes: string[];
  data_quality: DataQuality;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** An open cycle that started longer ago than this is stale (strap off or not synced). */
export const MAX_OPEN_CYCLE_MS = 2 * DAY_MS;

const FETCH_LIMIT = 25;
const MILLI_PER_HOUR = 1000 * 60 * 60;

type SourceName = "recovery" | "sleep" | "cycle" | "workout";
type SourceStatus = SourceQuality["status"];

const SECTION_LABELS: Record<SourceName, string> = {
  recovery: "Today's recovery",
  sleep: "Last night's sleep",
  cycle: "Today's strain",
  workout: "The latest workout",
};

const UNAVAILABLE_REASONS: Partial<Record<SourceStatus, string>> = {
  pending: "is still being scored by WHOOP",
  missing: "has not been recorded yet",
  unscored: "could not be scored by WHOOP",
  invalid: "could not be read because WHOOP returned unexpected values",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function milliToHours(ms: number): number {
  return Math.round((ms / MILLI_PER_HOUR) * 10) / 10;
}

/** Local wall-clock time of a record, e.g. "2026-09-15 23:13 (UTC+02:00)" */
function localStamp(timestamp: string, offset: string): string {
  const local = localTime(timestamp, offset).toISOString().slice(0, 16).replace("T", " ");
  return `${local} (UTC${offset === "Z" ? "" : offset})`;
}

/** WHOOP returns workout percent_recorded as a 0-1 fraction (the spec says 0-100) */
function recordedPercent(value: number): number {
  return value <= 1 ? Math.round(value * 1000) / 10 : value;
}

function buildSummary(
  snapshot: {
    recovery: TodayRecovery | null;
    sleep: TodaySleep | null;
    strain: TodayStrain | null;
  },
  sources: Record<SourceName, SourceQuality>
): string {
  const parts: string[] = [];

  if (snapshot.recovery) {
    const score = snapshot.recovery.score;
    const zone = score >= 67 ? "green" : score >= 34 ? "yellow" : "red";
    const calibrating = snapshot.recovery.user_calibrating ? ", calibrating" : "";
    parts.push(`Recovery ${score}% (${zone}${calibrating})`);
  }

  if (snapshot.sleep) {
    parts.push(`${snapshot.sleep.asleep_hours}h sleep`);
  }

  if (snapshot.strain) {
    parts.push(`strain ${snapshot.strain.day_strain}`);
  }

  const statuses = Object.entries(sources);
  let summary = parts.join(", ");
  if (parts.length === 0) {
    summary = statuses.some(([, quality]) => quality.status === "fetch_failed")
      ? "No data could be loaded from WHOOP right now"
      : "No data available yet today";
  }

  const unavailable = statuses
    .filter(([, quality]) => quality.status !== "available" && quality.status !== "calibrating")
    .map(([name, quality]) => `${name}: ${quality.status}`);
  return unavailable.length ? `${summary}. ${unavailable.join(", ")}` : summary;
}

/** Classify a selected record's scoring state into its source quality. */
function mark(
  record: { score_state: string; score?: unknown; updated_at: string } | undefined,
  quality: SourceQuality
): boolean {
  if (!record) return false;
  quality.source_updated_at = record.updated_at;
  quality.status =
    record.score_state === "PENDING_SCORE"
      ? "pending"
      : record.score_state !== "SCORED"
        ? "unscored"
        : record.score
          ? "available"
          : "invalid";
  quality.records_used = quality.status === "available" ? 1 : 0;
  return quality.status === "available";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Get today's complete health snapshot.
 *
 * Fetches recovery, sleep, cycle, and workout data in parallel.
 * If individual endpoints fail, returns null for those sections and explains
 * why in `notes`. Only throws if the recovery, sleep and cycle requests all
 * fail, rethrowing the most relevant underlying error.
 *
 * @param client - Authenticated WHOOP API client
 * @param now - Evaluation time (defaults to the current time)
 * @returns Today's snapshot with recovery, sleep, strain, summary and notes
 * @throws The most relevant upstream error if all primary API calls fail
 */
export async function getToday(
  client: WhoopClient,
  now: Date = new Date()
): Promise<TodaySnapshot> {
  const [recoveryResult, sleepResult, cycleResult, workoutResult] = await Promise.allSettled([
    client.get<RecoveryCollection>(`${ENDPOINT_RECOVERY}?limit=${FETCH_LIMIT}`, {
      cache: true,
      ttlMs: DYNAMIC_TTL_MS,
    }),
    client.get<SleepCollection>(`${ENDPOINT_SLEEP}?limit=${FETCH_LIMIT}`, {
      cache: true,
      ttlMs: DYNAMIC_TTL_MS,
    }),
    client.get<CycleCollection>(`${ENDPOINT_CYCLE}?limit=${FETCH_LIMIT}`, {
      cache: true,
      ttlMs: CYCLE_TTL_MS,
    }),
    client.get<WorkoutCollection>(`${ENDPOINT_WORKOUT}?limit=${FETCH_LIMIT}`, {
      cache: true,
      ttlMs: DYNAMIC_TTL_MS,
    }),
  ]);

  // Throw only if ALL primary endpoints failed (workout failure alone doesn't count)
  const primaryResults = [recoveryResult, sleepResult, cycleResult];
  if (
    primaryResults.every((result): result is PromiseRejectedResult => result.status === "rejected")
  ) {
    throw mostRelevantError(primaryResults.map((result) => result.reason));
  }

  function unpack<T>(result: PromiseSettledResult<{ records: T[]; next_token?: string | null }>): {
    records: T[];
    quality: SourceQuality;
  } {
    if (result.status === "rejected")
      return { records: [], quality: { ...sourceQuality(), status: "fetch_failed" } };
    if (!Array.isArray(result.value?.records))
      return { records: [], quality: { ...sourceQuality(), status: "invalid" } };
    return {
      records: result.value.records.slice(0, FETCH_LIMIT),
      quality: sourceQuality(
        result.value.records.length,
        Boolean(result.value.next_token) || result.value.records.length > FETCH_LIMIT
      ),
    };
  }
  const recoveryData = unpack(recoveryResult);
  const sleepData = unpack(sleepResult);
  const cycleData = unpack(cycleResult);
  const workoutData = unpack(workoutResult);
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const ended = (record: { start: string; end: string }): boolean =>
    Date.parse(record.end) <= nowMs && Date.parse(record.end) > Date.parse(record.start);

  // Cycle: the newest cycle, if it contains now and is not implausibly old. A closed
  // newest cycle is never promoted to "today" (that would show a finished day's strain).
  const cycles = parseRecords(
    cycleData.records,
    cycleRecordSchema.omit({ score: true }),
    cycleData.quality
  )
    .filter((record) => Date.parse(record.start) <= nowMs)
    .sort((left, right) => Date.parse(right.start) - Date.parse(left.start));
  const latestCycle = cycles[0];
  const cycleCandidate =
    latestCycle &&
    (latestCycle.end == null || Date.parse(latestCycle.end) > nowMs) &&
    nowMs - Date.parse(latestCycle.start) <= MAX_OPEN_CYCLE_MS
      ? latestCycle
      : undefined;
  const cycle = cycleCandidate
    ? parseRecords([cycleCandidate], cycleRecordSchema, cycleData.quality)[0]
    : undefined;
  if (latestCycle && !cycleCandidate) cycleData.quality.status = "stale";

  // Sleep: the main sleep joined to the current cycle. Naps carry their cycle's id
  // too, so they must be filtered out before the join. Without a current cycle,
  // fall back to the newest main sleep if it ended on today's local date.
  const mainSleeps = parseRecords(
    sleepData.records,
    sleepRecordSchema.omit({ score: true }),
    sleepData.quality
  )
    .filter((record) => !record.nap && ended(record))
    .sort((left, right) => Date.parse(right.end) - Date.parse(left.end));
  const latestSleep = mainSleeps[0];
  const sleepCandidate = cycleCandidate
    ? mainSleeps.find(
        (record) =>
          record.cycle_id === cycleCandidate.id && record.user_id === cycleCandidate.user_id
      )
    : latestSleep &&
        localDay(latestSleep.end, latestSleep.timezone_offset) ===
          localDay(nowIso, latestSleep.timezone_offset)
      ? latestSleep
      : undefined;
  const currentSleep = sleepCandidate
    ? parseRecords([sleepCandidate], sleepRecordSchema, sleepData.quality)[0]
    : undefined;
  if (latestSleep && !sleepCandidate && !cycleCandidate) sleepData.quality.status = "stale";

  // Recovery: belongs to the current cycle (and to its sleep when that is known);
  // without a current cycle it is joined through the fallback sleep.
  const recoveryCandidates = parseRecords(
    recoveryData.records,
    recoveryRecordSchema.omit({ score: true }),
    recoveryData.quality
  );
  const recoveryCandidate = recoveryCandidates.find((record) =>
    cycleCandidate
      ? record.cycle_id === cycleCandidate.id &&
        record.user_id === cycleCandidate.user_id &&
        (!sleepCandidate || record.sleep_id === sleepCandidate.id)
      : sleepCandidate !== undefined &&
        record.sleep_id === sleepCandidate.id &&
        record.cycle_id === sleepCandidate.cycle_id &&
        record.user_id === sleepCandidate.user_id
  );
  const recoveryRecord = recoveryCandidate
    ? parseRecords([recoveryCandidate], recoveryRecordSchema, recoveryData.quality)[0]
    : undefined;

  // Workout: the newest finished workout. An unreadable newest workout is reported,
  // not silently replaced by an older one.
  const workoutCandidates = parseRecords(
    workoutData.records,
    workoutRecordSchema.omit({ score: true }),
    workoutData.quality
  )
    .filter(ended)
    .sort((left, right) => Date.parse(right.start) - Date.parse(left.start));
  const latestWorkout = workoutCandidates[0]
    ? parseRecords([workoutCandidates[0]], workoutRecordSchema, workoutData.quality)[0]
    : undefined;

  const sleepAvailable = mark(currentSleep, sleepData.quality);
  const cycleAvailable = mark(cycle, cycleData.quality);
  const recoveryScored = mark(recoveryRecord, recoveryData.quality);
  const workoutAvailable = mark(latestWorkout, workoutData.quality);

  // A recovery is provisional while its sleep is still pending or unscorable.
  const sleepStatus = sleepData.quality.status;
  const recoveryHeldBack =
    recoveryScored &&
    currentSleep !== undefined &&
    (sleepStatus === "pending" || sleepStatus === "unscored");
  if (recoveryHeldBack) {
    recoveryData.quality.status = sleepStatus;
    recoveryData.quality.records_used = 0;
  }

  let recovery: TodayRecovery | null = null;
  if (recoveryScored && !recoveryHeldBack && recoveryRecord?.score) {
    recovery = {
      score: recoveryRecord.score.recovery_score,
      hrv_rmssd_milli: recoveryRecord.score.hrv_rmssd_milli,
      resting_heart_rate: recoveryRecord.score.resting_heart_rate,
      spo2_pct: recoveryRecord.score.spo2_percentage ?? null,
      skin_temp_celsius: recoveryRecord.score.skin_temp_celsius ?? null,
      user_calibrating: recoveryRecord.score.user_calibrating,
    };
    if (recovery.user_calibrating) recoveryData.quality.status = "calibrating";
  }

  let sleep: TodaySleep | null = null;
  if (sleepAvailable && currentSleep?.score) {
    const stages = currentSleep.score.stage_summary;
    const asleep = Math.round(asleepHours(currentSleep) * 10) / 10;
    sleep = {
      total_hours: asleep,
      time_in_bed_hours: milliToHours(stages.total_in_bed_time_milli),
      asleep_hours: asleep,
      rem_hours: milliToHours(stages.total_rem_sleep_time_milli),
      deep_hours: milliToHours(stages.total_slow_wave_sleep_time_milli),
      light_hours: milliToHours(stages.total_light_sleep_time_milli),
      awake_hours: milliToHours(stages.total_awake_time_milli),
      performance_pct: currentSleep.score.sleep_performance_percentage ?? null,
      efficiency_pct: currentSleep.score.sleep_efficiency_percentage ?? null,
      respiratory_rate: currentSleep.score.respiratory_rate ?? null,
    };
  }

  let strain: TodayStrain | null = null;
  if (cycleAvailable && cycle?.score) {
    const lastWorkout: TodayLastWorkout | null =
      workoutAvailable && latestWorkout?.score
        ? {
            sport_name: latestWorkout.sport_name,
            strain: latestWorkout.score.strain,
            occurred_at: latestWorkout.start,
            percent_recorded: recordedPercent(latestWorkout.score.percent_recorded),
          }
        : null;
    strain = {
      day_strain: cycle.score.strain,
      energy_burned_kj: cycle.score.kilojoule,
      last_workout: lastWorkout,
    };
  }

  const sources: Record<SourceName, SourceQuality> = {
    recovery: recoveryData.quality,
    sleep: sleepData.quality,
    cycle: cycleData.quality,
    workout: workoutData.quality,
  };

  // Notes: say plainly why a section is empty or provisional.
  const notes: string[] = [];
  const failed = (Object.keys(sources) as SourceName[]).filter(
    (name) => sources[name].status === "fetch_failed"
  );
  if (failed.length) {
    notes.push(
      `Could not fetch ${failed.join(", ")} data from WHOOP (authorization, rate limit or network problem); those sections are unavailable, not empty.`
    );
  }
  if (recovery?.user_calibrating) {
    const scoredNights = recoveryCandidates.filter(
      (record) => record.score_state === "SCORED"
    ).length;
    const count = recoveryData.quality.truncated
      ? ""
      : ` (${scoredNights} scored ${scoredNights === 1 ? "night" : "nights"} so far)`;
    notes.push(
      `Recovery is still calibrating${count}: WHOOP needs more nights to learn your baselines, so treat this score as provisional.`
    );
  }
  if (!recovery) {
    if (recoveryHeldBack) {
      notes.push(`${SECTION_LABELS.recovery} is held back until last night's sleep is scored.`);
    } else if (!cycleCandidate && !sleepCandidate && recoveryData.quality.status === "missing") {
      notes.push(
        `${SECTION_LABELS.recovery} is not available: there is no current cycle or sleep to link it to.`
      );
    } else {
      const reason = UNAVAILABLE_REASONS[recoveryData.quality.status];
      if (reason) notes.push(`${SECTION_LABELS.recovery} ${reason}.`);
    }
  }
  if (!sleep) {
    if (sleepData.quality.status === "stale" && latestSleep) {
      notes.push(
        `${SECTION_LABELS.sleep} is not available: the latest main sleep ended ${localStamp(latestSleep.end, latestSleep.timezone_offset)}.`
      );
    } else if (sleepData.quality.status === "missing" && cycleCandidate) {
      notes.push("No main sleep is linked to the current cycle yet.");
    } else {
      const reason = UNAVAILABLE_REASONS[sleepData.quality.status];
      if (reason) notes.push(`${SECTION_LABELS.sleep} ${reason}.`);
    }
  }
  if (!strain) {
    if (cycleData.quality.status === "stale" && latestCycle) {
      notes.push(
        `${SECTION_LABELS.cycle} is not available: no open WHOOP cycle covers the current time (the latest cycle started ${localStamp(latestCycle.start, latestCycle.timezone_offset)}); the strap may not have synced recently.`
      );
    } else {
      const reason = UNAVAILABLE_REASONS[cycleData.quality.status];
      if (reason) notes.push(`${SECTION_LABELS.cycle} ${reason}.`);
    }
  } else if (!strain.last_workout) {
    const reason = UNAVAILABLE_REASONS[workoutData.quality.status];
    if (workoutData.quality.status === "missing") notes.push("No workouts have been recorded yet.");
    else if (reason) notes.push(`${SECTION_LABELS.workout} ${reason}.`);
  } else if (latestWorkout && cycle && Date.parse(latestWorkout.start) < Date.parse(cycle.start)) {
    notes.push(
      `The latest workout started ${localStamp(latestWorkout.start, latestWorkout.timezone_offset)}, before the current cycle began, so it is not part of today's strain.`
    );
  }

  const fallbackOffset = latestSleep?.timezone_offset ?? latestCycle?.timezone_offset ?? "Z";
  const snapshot: TodaySnapshot = {
    timestamp: nowIso,
    recovery,
    sleep,
    strain,
    summary: buildSummary({ recovery, sleep, strain }, sources),
    notes,
    data_quality: {
      evaluated_at: nowIso,
      requested_period: {
        start: cycleCandidate?.start ?? resolveDateExpression("today", now, fallbackOffset).start,
        end: nowIso,
      },
      observed_period: observedPeriod([
        ...(sleep && currentSleep ? [currentSleep.start, currentSleep.end] : []),
        ...(strain && cycle ? [cycle.start, ...(cycle.end ? [cycle.end] : [])] : []),
        ...(strain?.last_workout && latestWorkout ? [latestWorkout.start, latestWorkout.end] : []),
      ]),
      sources,
      method_version: "today-3",
      limitations: [
        "Today is the current WHOOP cycle: it starts at last night's sleep onset and stays open until the next sleep; an open cycle older than 48 hours is treated as stale.",
        "Sleep and recovery are joined to the current cycle by cycle_id and sleep_id; without a current cycle, the latest main sleep that ended on today's local date is used.",
        "Sleep hours are time asleep (light + slow-wave + REM); time_in_bed_hours includes awake time.",
        "The latest workout may be from before the current cycle.",
        "Fetch time and cache status are not available from the client.",
      ],
    },
  };

  return snapshot;
}
