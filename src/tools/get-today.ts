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
 *
 * A cycle has no maximum length: until WHOOP processes a new sleep (the wake-up
 * is not synced yet, or no sleep was detected) the previous cycle stays open.
 * It is still shown, but sleep and recovery from a morning older than
 * STALE_SLEEP_MS are marked "stale" and dated in a note, and a cycle WHOOP has
 * not updated for MAX_SYNC_GAP_MS is flagged as possibly not synced.
 *
 * Caching: the four lists share the cycle resources' TTL (CYCLE_TTL_MS), so
 * their cache entries normally expire together. They can still get out of step
 * (LRU eviction, joining an in-flight fetch, a webhook invalidating only some
 * prefixes, an earlier partial failure), leaving a new cycle next to sleep and
 * recovery lists read before WHOOP created it. When the client reports fetch
 * metadata, a current cycle without a linked main sleep (or without a
 * recovery) whose sleep (or recovery) list is a cache hit stored before the
 * cycle list was read makes get_today re-read, once, those of the sleep and
 * recovery lists that were served from entries older than the cycle list
 * (replacing the entries), and select again.
 */

import type { z } from "zod";
import type { WhoopClient, WhoopGetOptions } from "../api/client.js";
import {
  ENDPOINT_RECOVERY,
  ENDPOINT_SLEEP,
  ENDPOINT_WORKOUT,
  ENDPOINT_CYCLE,
} from "../api/endpoints.js";
import { CYCLE_TTL_MS } from "../resources/index.js";
import {
  cycleRecordSchema,
  recoveryRecordSchema,
  sleepRecordSchema,
  workoutRecordSchema,
} from "../api/record-schemas.js";
import {
  asleepHours,
  DAY_MS,
  formatLocalTimestamp,
  HOUR_MS,
  localDay,
  localTime,
  mostRelevantError,
  parseRecords,
  recoveryZone,
  sourceQuality,
  type DataQuality,
  type RecoveryZone,
  type SourceQuality,
} from "./analytics-utils.js";
import { resolveDateExpression } from "./date-utils.js";
import { needBreakdown, whoopConsistency } from "./sleep-metrics.js";
import { roundTo } from "./stats-utils.js";
import { recordedPercent } from "./workout-utils.js";

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
  /** WHOOP's recovery colour band: green 67-100, yellow 34-66, red 0-33 */
  zone: RecoveryZone;
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
  /** Times WHOOP detected the sleep being disturbed */
  disturbances: number;
  /** Sleep cycles WHOOP counted */
  sleep_cycles: number;
  /** Time in bed without strap data */
  no_data_hours: number;
  /** WHOOP's sleep consistency; null when not reported or a 0 reported while calibrating */
  consistency_pct: number | null;
  /** WHOOP's sleep need for the night: baseline + debt + recent strain + recent naps (0 or negative) */
  need_hours_including_debt: number;
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

/**
 * The linked sleep ended longer ago than this: no newer sleep has been processed, so
 * the sleep and recovery shown are from an earlier morning, not last night. Long
 * enough not to flag an evening or just-after-midnight query on a normal day.
 */
export const STALE_SLEEP_MS = 20 * HOUR_MS;

/** An open cycle older than this gets a note that its strain spans more than a day. */
export const LONG_CYCLE_MS = 30 * HOUR_MS;

/** WHOOP has not updated the open cycle for this long: the strap may not have synced. */
export const MAX_SYNC_GAP_MS = DAY_MS;

/** Records read per list (WHOOP's page maximum). */
export const TODAY_FETCH_LIMIT = 25;

const FETCH_LIMIT = TODAY_FETCH_LIMIT;
const MILLI_PER_HOUR = 1000 * 60 * 60;

type SourceName = "recovery" | "sleep" | "cycle" | "workout";
type SourceStatus = SourceQuality["status"];

/** The list request of each source; the cache keys are shared with the workout resource. */
export const TODAY_LIST_PATHS: Readonly<Record<SourceName, string>> = {
  recovery: `${ENDPOINT_RECOVERY}?limit=${FETCH_LIMIT}`,
  sleep: `${ENDPOINT_SLEEP}?limit=${FETCH_LIMIT}`,
  cycle: `${ENDPOINT_CYCLE}?limit=${FETCH_LIMIT}`,
  workout: `${ENDPOINT_WORKOUT}?limit=${FETCH_LIMIT}`,
};

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

const BASE_LIMITATIONS: readonly string[] = [
  "Today is the current WHOOP cycle: it starts at last night's sleep onset and stays open until WHOOP processes the next sleep, however long that takes; a closed newest cycle is never shown as today (cycle status stale, strain null).",
  "When the linked sleep ended more than 20 hours ago, no newer sleep has been processed yet: that sleep and recovery are still shown, with status stale and a note giving their date. A cycle WHOOP has not updated for 24 hours is shown with status stale and a note that the strap may not have synced.",
  "Sleep and recovery are joined to the current cycle by cycle_id and sleep_id; without a current cycle, the latest main sleep that ended on today's local date is used.",
  "Sleep hours are time asleep (light + slow-wave + REM); time_in_bed_hours includes awake time.",
  "The latest workout may be from before the current cycle.",
  "requested_period is local time in the current cycle's UTC offset (without a current cycle: the latest sleep's or cycle's), observed_period in each shown record's own offset; timestamp and evaluated_at are UTC.",
];

/** Limitation when the client reports fetch metadata. */
const CACHE_LIMITATION =
  "WHOOP lists may come from the server cache for up to 2 minutes (fetched_at and cache_status per source); when the current cycle has no linked main sleep or recovery and that list was cached before the cycle list was read, the cached sleep and recovery lists older than the cycle list are read again once.";

/** Limitation when the client cannot report fetch metadata (e.g. a test double). */
const NO_FETCH_METADATA_LIMITATION =
  "Fetch time and cache status are not available from the client.";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildSummary(
  snapshot: {
    recovery: TodayRecovery | null;
    sleep: TodaySleep | null;
    strain: TodayStrain | null;
  },
  sources: Record<SourceName, SourceQuality>,
  qualifier?: string
): string {
  const parts: string[] = [];

  if (snapshot.recovery) {
    const calibrating = snapshot.recovery.user_calibrating ? ", calibrating" : "";
    parts.push(`Recovery ${snapshot.recovery.score}% (${snapshot.recovery.zone}${calibrating})`);
  }

  if (snapshot.sleep) {
    parts.push(`${snapshot.sleep.asleep_hours}h sleep`);
  }

  if (snapshot.strain) {
    parts.push(`strain ${Math.round(snapshot.strain.day_strain * 10) / 10}`);
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
  const withStatuses = unavailable.length ? `${summary}. ${unavailable.join(", ")}` : summary;
  return qualifier ? `${withStatuses}. ${qualifier}` : withStatuses;
}

/** Whole hours from one instant to a later one, for plain-language notes */
function hoursBetween(fromMs: number, toMs: number): number {
  return Math.round((toMs - fromMs) / HOUR_MS);
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

/** One list read: settled like Promise.allSettled, plus fetch metadata when the client has it. */
type ListRead =
  | { status: "fulfilled"; value: unknown; fetchedAt?: number; cacheStatus?: "hit" | "miss" }
  | { status: "rejected"; reason: unknown };

async function readList(
  client: WhoopClient,
  source: SourceName,
  refresh: boolean
): Promise<ListRead> {
  const options: WhoopGetOptions = {
    cache: true,
    ttlMs: CYCLE_TTL_MS,
    ...(refresh ? { refresh: true } : {}),
  };
  try {
    if (client.getWithMeta !== undefined) {
      const result = await client.getWithMeta<unknown>(TODAY_LIST_PATHS[source], options);
      return {
        status: "fulfilled",
        value: result.data,
        fetchedAt: result.fetchedAt,
        cacheStatus: result.cacheStatus,
      };
    }
    return {
      status: "fulfilled",
      value: await client.get<unknown>(TODAY_LIST_PATHS[source], options),
    };
  } catch (reason: unknown) {
    return { status: "rejected", reason };
  }
}

/** The records of a fulfilled list read, or [] (a failed or malformed read has none). */
function listRecords(read: ListRead): unknown[] {
  return read.status === "fulfilled" && isRecord(read.value) && Array.isArray(read.value.records)
    ? read.value.records.slice(0, FETCH_LIMIT)
    : [];
}

const cycleIdentitySchema = cycleRecordSchema.omit({ score: true });
const sleepIdentitySchema = sleepRecordSchema.omit({ score: true });
const recoveryIdentitySchema = recoveryRecordSchema.omit({ score: true });
const workoutIdentitySchema = workoutRecordSchema.omit({ score: true });

type CycleIdentity = z.infer<typeof cycleIdentitySchema>;
type SleepIdentity = z.infer<typeof sleepIdentitySchema>;

/** Cycles that started by now, newest first, and the current (open) cycle among them. */
function selectCycles(
  records: unknown[],
  quality: SourceQuality,
  nowMs: number
): { latestCycle: CycleIdentity | undefined; cycleCandidate: CycleIdentity | undefined } {
  const cycles = parseRecords(records, cycleIdentitySchema, quality)
    .filter((record) => Date.parse(record.start) <= nowMs)
    .sort((left, right) => Date.parse(right.start) - Date.parse(left.start));
  const latestCycle = cycles[0];
  const cycleCandidate =
    latestCycle && (latestCycle.end == null || Date.parse(latestCycle.end) > nowMs)
      ? latestCycle
      : undefined;
  return { latestCycle, cycleCandidate };
}

/** Main (non-nap) sleeps that ended by now, newest end first. */
function selectMainSleeps(
  records: unknown[],
  quality: SourceQuality,
  nowMs: number
): SleepIdentity[] {
  return parseRecords(records, sleepIdentitySchema, quality)
    .filter(
      (record) =>
        !record.nap &&
        Date.parse(record.end) <= nowMs &&
        Date.parse(record.end) > Date.parse(record.start)
    )
    .sort((left, right) => Date.parse(right.end) - Date.parse(left.end));
}

/** The main sleep joined to a cycle by cycle_id (and user). */
function linkedMainSleep(
  mainSleeps: readonly SleepIdentity[],
  cycle: CycleIdentity
): SleepIdentity | undefined {
  return mainSleeps.find(
    (record) => record.cycle_id === cycle.id && record.user_id === cycle.user_id
  );
}

/** A fulfilled list read served from a cache entry stored before the cycle list was read. */
function cachedBefore(read: ListRead, cycleRead: ListRead): boolean {
  return (
    read.status === "fulfilled" &&
    cycleRead.status === "fulfilled" &&
    read.cacheStatus === "hit" &&
    read.fetchedAt !== undefined &&
    cycleRead.fetchedAt !== undefined &&
    read.fetchedAt < cycleRead.fetchedAt
  );
}

/**
 * Whether the sleep and recovery lists must be read again: there is a current
 * cycle, and the sleep list has no main sleep linked to it (or the recovery
 * list no recovery for it) while that list is a cache hit stored before the
 * cycle list was read, so it may predate the cycle.
 */
function listsOutOfStep(
  cycleRead: ListRead,
  sleepRead: ListRead,
  recoveryRead: ListRead,
  nowMs: number
): boolean {
  const sleepStale = cachedBefore(sleepRead, cycleRead);
  const recoveryStale = cachedBefore(recoveryRead, cycleRead);
  if (!sleepStale && !recoveryStale) return false;
  const { cycleCandidate } = selectCycles(listRecords(cycleRead), sourceQuality(), nowMs);
  if (!cycleCandidate) return false;
  if (sleepStale) {
    const mainSleeps = selectMainSleeps(listRecords(sleepRead), sourceQuality(), nowMs);
    if (linkedMainSleep(mainSleeps, cycleCandidate) === undefined) return true;
  }
  if (recoveryStale) {
    const recoveries = parseRecords(
      listRecords(recoveryRead),
      recoveryIdentitySchema,
      sourceQuality()
    );
    if (
      !recoveries.some(
        (record) =>
          record.cycle_id === cycleCandidate.id && record.user_id === cycleCandidate.user_id
      )
    ) {
      return true;
    }
  }
  return false;
}

/** The earliest and latest of the shown records' instants, each written in its own offset. */
function localObservedPeriod(
  points: readonly { ms: number; offset: string }[]
): { start: string; end: string } | null {
  let first: { ms: number; offset: string } | undefined;
  let last: { ms: number; offset: string } | undefined;
  for (const point of points) {
    if (!Number.isFinite(point.ms)) continue;
    if (first === undefined || point.ms < first.ms) first = point;
    if (last === undefined || point.ms > last.ms) last = point;
  }
  return first && last
    ? {
        start: formatLocalTimestamp(first.ms, first.offset),
        end: formatLocalTimestamp(last.ms, last.offset),
      }
    : null;
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
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const hasFetchMetadata = client.getWithMeta !== undefined;

  const [firstRecoveryRead, firstSleepRead, cycleRead, workoutRead] = await Promise.all([
    readList(client, "recovery", false),
    readList(client, "sleep", false),
    readList(client, "cycle", false),
    readList(client, "workout", false),
  ]);

  let recoveryRead = firstRecoveryRead;
  let sleepRead = firstSleepRead;

  // Throw only if ALL primary endpoints failed (workout failure alone doesn't count)
  const primaryReads = [recoveryRead, sleepRead, cycleRead];
  if (
    primaryReads.every(
      (read): read is { status: "rejected"; reason: unknown } => read.status === "rejected"
    )
  ) {
    throw mostRelevantError(primaryReads.map((read) => read.reason));
  }

  // A new cycle next to sleep and recovery lists cached before it: read again, once,
  // those of the two lists that came from a cache entry older than the cycle list.
  let refetchFailed = false;
  if (hasFetchMetadata && listsOutOfStep(cycleRead, sleepRead, recoveryRead, nowMs)) {
    const refreshRecovery = cachedBefore(recoveryRead, cycleRead);
    const refreshSleep = cachedBefore(sleepRead, cycleRead);
    const [freshRecovery, freshSleep] = await Promise.all([
      refreshRecovery ? readList(client, "recovery", true) : undefined,
      refreshSleep ? readList(client, "sleep", true) : undefined,
    ]);
    if (freshRecovery?.status === "fulfilled") recoveryRead = freshRecovery;
    else if (freshRecovery) refetchFailed = true;
    if (freshSleep?.status === "fulfilled") sleepRead = freshSleep;
    else if (freshSleep) refetchFailed = true;
  }

  function unpack(read: ListRead): { records: unknown[]; quality: SourceQuality } {
    let unpacked: { records: unknown[]; quality: SourceQuality };
    if (read.status === "rejected") {
      unpacked = { records: [], quality: { ...sourceQuality(), status: "fetch_failed" } };
    } else if (!isRecord(read.value) || !Array.isArray(read.value.records)) {
      unpacked = { records: [], quality: { ...sourceQuality(), status: "invalid" } };
    } else {
      const records = read.value.records;
      unpacked = {
        records: records.slice(0, FETCH_LIMIT),
        quality: sourceQuality(
          records.length,
          Boolean(read.value.next_token) || records.length > FETCH_LIMIT
        ),
      };
    }
    if (hasFetchMetadata) {
      if (read.status === "fulfilled" && read.fetchedAt !== undefined) {
        unpacked.quality.fetched_at = new Date(read.fetchedAt).toISOString();
        unpacked.quality.cache_status = read.cacheStatus ?? "unknown";
      } else if (read.status === "rejected") {
        unpacked.quality.cache_status = "miss";
      }
    }
    return unpacked;
  }
  const recoveryData = unpack(recoveryRead);
  const sleepData = unpack(sleepRead);
  const cycleData = unpack(cycleRead);
  const workoutData = unpack(workoutRead);
  const ended = (record: { start: string; end: string }): boolean =>
    Date.parse(record.end) <= nowMs && Date.parse(record.end) > Date.parse(record.start);

  // Cycle: the newest cycle, if it is still open. A cycle only ends at the next detected
  // sleep, so an open cycle is today's however long it has run. A closed newest cycle is
  // never promoted to "today" (that would show a finished day's strain).
  const { latestCycle, cycleCandidate } = selectCycles(cycleData.records, cycleData.quality, nowMs);
  const cycle = cycleCandidate
    ? parseRecords([cycleCandidate], cycleRecordSchema, cycleData.quality)[0]
    : undefined;
  if (latestCycle && !cycleCandidate) cycleData.quality.status = "stale";

  // Sleep: the main sleep joined to the current cycle. Naps carry their cycle's id
  // too, so they must be filtered out before the join. Without a current cycle,
  // fall back to the newest main sleep if it ended on today's local date.
  const mainSleeps = selectMainSleeps(sleepData.records, sleepData.quality, nowMs);
  const latestSleep = mainSleeps[0];
  const sleepCandidate = cycleCandidate
    ? linkedMainSleep(mainSleeps, cycleCandidate)
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
    recoveryIdentitySchema,
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
    workoutIdentitySchema,
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

  // A recovery is held back while its sleep is still being scored. An UNSCORABLE sleep
  // will never be scored, so the recovery WHOOP scored for it is shown.
  const sleepStatus = sleepData.quality.status;
  const recoveryHeldBack =
    recoveryScored && currentSleep !== undefined && sleepStatus === "pending";
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
      zone: recoveryZone(recoveryRecord.score.recovery_score),
    };
    if (recovery.user_calibrating) recoveryData.quality.status = "calibrating";
  }

  let sleep: TodaySleep | null = null;
  const need = currentSleep ? needBreakdown(currentSleep) : null;
  if (sleepAvailable && currentSleep?.score && need) {
    const stages = currentSleep.score.stage_summary;
    const asleep = Math.round(asleepHours(currentSleep) * 10) / 10;
    // A 0 consistency while WHOOP calibrates is not a value. The linked recovery says
    // whether WHOOP is calibrating; without its score, the newest scored recovery does.
    const calibrationReference = recoveryRecord?.score
      ? recoveryRecord
      : recoveryCandidates
          .filter((record) => record.score_state === "SCORED")
          .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))
          .map((record) => recoveryRecordSchema.safeParse(record))
          .find((parsed) => parsed.success && parsed.data.score)?.data;
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
      disturbances: Math.round(stages.disturbance_count),
      sleep_cycles: Math.round(stages.sleep_cycle_count),
      no_data_hours: milliToHours(stages.total_no_data_time_milli),
      consistency_pct: whoopConsistency(currentSleep, calibrationReference ?? null).value,
      need_hours_including_debt: roundTo(need.total_including_debt, 1),
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

  // Until WHOOP processes the next sleep, the previous morning's sleep and recovery stay
  // linked to the open cycle. A linked sleep that ended long ago means they are from an
  // earlier morning, not last night. Without the sleep record, the cycle's own age (it
  // started at that sleep's onset) stands in.
  const morningEndMs = sleepCandidate ? Date.parse(sleepCandidate.end) : undefined;
  const cycleStartMs = cycleCandidate ? Date.parse(cycleCandidate.start) : undefined;
  const morningOutdated =
    cycleStartMs !== undefined &&
    (morningEndMs !== undefined
      ? nowMs - morningEndMs > STALE_SLEEP_MS
      : nowMs - cycleStartMs > LONG_CYCLE_MS);
  if (morningOutdated) {
    if (recovery) recoveryData.quality.status = "stale";
    if (sleep) sleepData.quality.status = "stale";
  }
  const cycleUpdatedMs = strain && cycle ? Date.parse(cycle.updated_at) : undefined;
  const cycleSyncGap = cycleUpdatedMs !== undefined && nowMs - cycleUpdatedMs > MAX_SYNC_GAP_MS;
  if (cycleSyncGap) cycleData.quality.status = "stale";
  const labels: Record<SourceName, string> = morningOutdated
    ? { ...SECTION_LABELS, recovery: "The latest recovery", sleep: "The latest sleep" }
    : SECTION_LABELS;

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
  if (refetchFailed) {
    notes.push(
      "WHOOP has a newer cycle than the cached sleep and recovery lists, and they could not be read again right now, so the sleep and recovery shown may not include the latest ones yet."
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
      notes.push(
        `${labels.recovery} is held back until ${morningOutdated ? "the latest" : "last night's"} sleep is scored.`
      );
    } else if (!cycleCandidate && !sleepCandidate && recoveryData.quality.status === "missing") {
      notes.push(
        `${labels.recovery} is not available: there is no current cycle or sleep to link it to.`
      );
    } else {
      const reason = UNAVAILABLE_REASONS[recoveryData.quality.status];
      if (reason) notes.push(`${labels.recovery} ${reason}.`);
    }
  }
  if (!sleep) {
    if (sleepData.quality.status === "stale" && latestSleep) {
      notes.push(
        `${labels.sleep} is not available: the latest main sleep ended ${localStamp(latestSleep.end, latestSleep.timezone_offset)}.`
      );
    } else if (sleepData.quality.status === "missing" && cycleCandidate) {
      notes.push("No main sleep is linked to the current cycle yet.");
    } else if (sleepData.quality.status === "unscored" && recovery) {
      notes.push(
        `${labels.sleep} could not be scored by WHOOP, but WHOOP did score the recovery that follows it, so that recovery is shown.`
      );
    } else {
      const reason = UNAVAILABLE_REASONS[sleepData.quality.status];
      if (reason) notes.push(`${labels.sleep} ${reason}.`);
    }
  }
  if (morningOutdated && cycleCandidate && (sleepCandidate || recoveryCandidate)) {
    const since =
      sleepCandidate && morningEndMs !== undefined
        ? `the sleep that ended ${localStamp(sleepCandidate.end, sleepCandidate.timezone_offset)}, about ${hoursBetween(morningEndMs, nowMs)} hours ago`
        : `the sleep that began ${localStamp(cycleCandidate.start, cycleCandidate.timezone_offset)}`;
    const shown =
      recovery && sleep
        ? "the sleep and recovery shown are"
        : recovery
          ? "the recovery shown is"
          : sleep
            ? "the sleep shown is"
            : "the sleep and recovery linked to the current cycle are";
    notes.push(
      `No newer sleep has been processed since ${since}, so ${shown} from that morning, not from last night. If you have slept since then, WHOOP has not processed that sleep yet (or did not detect it); opening the WHOOP app to sync may help.`
    );
  }
  if (cycleCandidate && cycleStartMs !== undefined && nowMs - cycleStartMs > LONG_CYCLE_MS) {
    notes.push(
      `The current WHOOP cycle started ${localStamp(cycleCandidate.start, cycleCandidate.timezone_offset)}, about ${hoursBetween(cycleStartMs, nowMs)} hours ago. A cycle only ends when WHOOP detects the next sleep, so ${strain ? "the strain shown covers" : "its strain accumulates over"} that whole period.`
    );
  }
  if (cycleSyncGap && cycle && cycleUpdatedMs !== undefined) {
    notes.push(
      `WHOOP has not updated the current cycle since ${localStamp(cycle.updated_at, cycle.timezone_offset)}, about ${hoursBetween(cycleUpdatedMs, nowMs)} hours ago; the strap may not have synced recently, so the strain shown may be incomplete.`
    );
  }
  if (!strain) {
    if (cycleData.quality.status === "stale" && latestCycle) {
      const lastCycle =
        latestCycle.end != null
          ? `ended ${localStamp(latestCycle.end, latestCycle.timezone_offset)}, when WHOOP detected a new sleep`
          : `started ${localStamp(latestCycle.start, latestCycle.timezone_offset)}`;
      notes.push(
        `${labels.cycle} is not available: the latest WHOOP cycle ${lastCycle}, and the next cycle has not synced yet (WHOOP creates it once that sleep is processed).`
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

  let summaryQualifier: string | undefined;
  if (morningOutdated && (recovery || sleep)) {
    const shown =
      recovery && sleep ? "sleep and recovery are" : recovery ? "recovery is" : "sleep is";
    summaryQualifier = sleepCandidate
      ? `No newer sleep processed since ${localStamp(sleepCandidate.end, sleepCandidate.timezone_offset)}, so ${shown} from that morning`
      : `No newer sleep processed since the current cycle began, so ${shown} from an earlier morning`;
  }

  // Periods in local time: the current cycle's offset, else the latest sleep's or cycle's.
  const periodOffset =
    cycleCandidate?.timezone_offset ??
    latestSleep?.timezone_offset ??
    latestCycle?.timezone_offset ??
    "Z";
  const requestedStartMs = cycleCandidate
    ? Date.parse(cycleCandidate.start)
    : Date.parse(resolveDateExpression("today", now, periodOffset).start);
  const shownInstants: { ms: number; offset: string }[] = [];
  if (sleep && currentSleep) {
    shownInstants.push(
      { ms: Date.parse(currentSleep.start), offset: currentSleep.timezone_offset },
      { ms: Date.parse(currentSleep.end), offset: currentSleep.timezone_offset }
    );
  }
  if (strain && cycle) {
    shownInstants.push({ ms: Date.parse(cycle.start), offset: cycle.timezone_offset });
    if (cycle.end) shownInstants.push({ ms: Date.parse(cycle.end), offset: cycle.timezone_offset });
  }
  if (strain?.last_workout && latestWorkout) {
    shownInstants.push(
      { ms: Date.parse(latestWorkout.start), offset: latestWorkout.timezone_offset },
      { ms: Date.parse(latestWorkout.end), offset: latestWorkout.timezone_offset }
    );
  }

  const snapshot: TodaySnapshot = {
    timestamp: nowIso,
    recovery,
    sleep,
    strain,
    summary: buildSummary({ recovery, sleep, strain }, sources, summaryQualifier),
    notes,
    data_quality: {
      evaluated_at: nowIso,
      requested_period: {
        start: formatLocalTimestamp(requestedStartMs, periodOffset),
        end: formatLocalTimestamp(nowMs, periodOffset),
      },
      observed_period: localObservedPeriod(shownInstants),
      sources,
      method_version: "today-5",
      limitations: [
        ...BASE_LIMITATIONS,
        hasFetchMetadata ? CACHE_LIMITATION : NO_FETCH_METADATA_LIMITATION,
      ],
    },
  };

  return snapshot;
}
