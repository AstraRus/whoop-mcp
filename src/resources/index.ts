/**
 * MCP Resources — ambient health context backed by the shared API client cache.
 *
 * Exposes 5 resources:
 * - whoop://v2/user/recovery/latest — most recent recovery score
 * - whoop://v2/user/sleep/latest — most recent main (non-nap) sleep
 * - whoop://v2/user/cycle/latest — current or most recent cycle
 * - whoop://v2/user/workout/latest — most recent finished workout, normalized
 * - whoop://v2/user/profile — user profile (cached 1hr)
 *
 * Records are passed through as WHOOP returns them (the workout resource
 * returns the shared workout summary instead). When a record needs
 * context to be read correctly (not scored yet, WHOOP still calibrating, a
 * cycle still in progress, only naps found, or a recovery/sleep that belongs to
 * an earlier cycle than the latest one) a `notes` array is added next to the
 * record's own fields.
 *
 * Caching, in-flight deduplication, and invalidation are handled by the
 * `MemoryCache` injected into the WHOOP client (opt-in per request via the
 * `cache` option). Resources and tools share that one cache keyed by request
 * path.
 */

import type { WhoopClient } from "../api/client.js";
import { describeWhoopError, WhoopApiError } from "../api/client.js";
import {
  cycleRecordSchema,
  sleepRecordSchema,
  workoutRecordSchema,
} from "../api/record-schemas.js";
import type { Sleep } from "../api/types.js";
import { localDay } from "../tools/analytics-utils.js";
import { parseUtcOffset } from "../tools/date-utils.js";
import { isBetterSleep, mainDayOf, type WorkoutPlacement } from "../tools/day-model.js";
import {
  HR_ZONE_CAVEAT_SPORT,
  MIN_RECORDED_FRACTION,
  normalizeWorkout,
  roundWorkoutSummary,
} from "../tools/workout-utils.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Logger } from "../logging/logger.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * TTL for slower-changing cached lists — 5 minutes. No longer used by get_today
 * (its four lists share CYCLE_TTL_MS so they expire together); kept for
 * compatibility.
 */
export const DYNAMIC_TTL_MS = 5 * 60 * 1000;

/**
 * TTL for the cycle, recovery, sleep and workout resources and get_today's lists —
 * 2 minutes (strain updates frequently). They share it so their cache entries
 * expire together with the cycle they are compared against.
 */
export const CYCLE_TTL_MS = 2 * 60 * 1000;

/** TTL for the profile resource — 1 hour */
export const PROFILE_TTL_MS = 60 * 60 * 1000;

/** Sleep records fetched so the latest main sleep can be found behind recent naps */
export const SLEEP_LOOKBACK_LIMIT = 5;

// ---------------------------------------------------------------------------
// Resource definitions
// ---------------------------------------------------------------------------

export interface ResourceDefinition {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  ttlMs: number;
  fetch: (client: WhoopClient) => Promise<unknown>;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The records of a collection page; a missing, null or malformed `records` counts as empty. */
function pageRecords(page: unknown): JsonRecord[] {
  if (!isRecord(page) || !Array.isArray(page.records)) {
    return [];
  }
  return page.records.filter(isRecord);
}

/** Notes explaining a record that WHOOP has not (or could not) score. */
function scoreStateNotes(record: JsonRecord, label: string): string[] {
  if (record.score_state === "PENDING_SCORE") {
    return [
      `WHOOP has not scored this ${label} yet (PENDING_SCORE); score values are missing until it does.`,
    ];
  }
  if (record.score_state === "UNSCORABLE") {
    return [`WHOOP could not score this ${label} (UNSCORABLE), so it has no score values.`];
  }
  return [];
}

/** Return the record unchanged, or a copy with `notes` when there is something to explain. */
function withNotes(record: JsonRecord, notes: string[]): JsonRecord {
  return notes.length > 0 ? { ...record, notes } : record;
}

/** Workouts read for the latest finished one: the same request (and cache key) as get_today's. */
export const WORKOUT_LIST_PATH = "/v2/activity/workout?limit=25";

const RECOVERY_PATH = "/v2/recovery?limit=1";
const SLEEP_PATH = `/v2/activity/sleep?limit=${SLEEP_LOOKBACK_LIMIT}`;
const CYCLE_PATH = "/v2/cycle?limit=1";

/**
 * GET a collection page. Normally served from the shared cache with the cycle
 * resource's TTL, so the recovery, sleep and cycle entries expire together;
 * `fresh` bypasses the cache (used to settle a cycle_id mismatch).
 */
function getPage(client: WhoopClient, path: string, fresh: boolean): Promise<unknown> {
  return fresh
    ? client.get<unknown>(path)
    : client.get<unknown>(path, { cache: true, ttlMs: CYCLE_TTL_MS });
}

/** A record's timestamp shown in its own UTC offset (e.g. 2026-09-15T23:13+02:00). */
function localTimestamp(value: unknown, offset: unknown): string | undefined {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    return undefined;
  }
  if (typeof offset !== "string") {
    return value;
  }
  try {
    const minutes = parseUtcOffset(offset);
    const local = new Date(Date.parse(value) + minutes * 60_000).toISOString().slice(0, 16);
    return `${local}${minutes === 0 ? "Z" : offset}`;
  } catch {
    return value;
  }
}

/** Latest record from the recovery/sleep page plus the latest cycle it is compared with. */
interface CycleLinkedRead<T> {
  value: T;
  cycle: JsonRecord | undefined;
  /** False when the mismatch could not be re-checked against fresh data. */
  confirmed: boolean;
}

/** The latest cycle, or undefined when it cannot be read (the resource then adds no cycle note). */
async function latestCycle(client: WhoopClient, fresh: boolean): Promise<JsonRecord | undefined> {
  try {
    return pageRecords(await getPage(client, CYCLE_PATH, fresh))[0];
  } catch {
    return undefined;
  }
}

/** Whether a record's cycle_id names a different cycle than `cycle` (WHOOP cycle ids are integers). */
function linksToOtherCycle(cycleId: unknown, cycle: JsonRecord | undefined): boolean {
  return (
    cycle !== undefined &&
    typeof cycle.id === "number" &&
    typeof cycleId === "number" &&
    cycleId !== cycle.id
  );
}

/**
 * Read a recovery/sleep page together with the latest cycle. The two are cached
 * separately, so a cycle_id mismatch may only mean the cache entries are out of
 * step (e.g. one was cached before the morning sync); both are then re-read once
 * without the cache. A mismatch that survives the fresh read is real: the latest
 * record belongs to an earlier cycle.
 */
async function readWithLatestCycle<T>(
  client: WhoopClient,
  read: (fresh: boolean) => Promise<T>,
  cycleIdOf: (value: T) => unknown
): Promise<CycleLinkedRead<T>> {
  const [value, cycle] = await Promise.all([read(false), latestCycle(client, false)]);
  if (!linksToOtherCycle(cycleIdOf(value), cycle)) {
    return { value, cycle, confirmed: true };
  }
  try {
    const [freshValue, freshCycle] = await Promise.all([read(true), latestCycle(client, true)]);
    if (freshCycle !== undefined) {
      return { value: freshValue, cycle: freshCycle, confirmed: true };
    }
  } catch {
    // Keep the cached pair and say the link could not be confirmed.
  }
  return { value, cycle, confirmed: false };
}

/**
 * A note when the record is not linked to the latest cycle, so an older night's
 * recovery or sleep is not presented as today's.
 */
function earlierCycleNote(
  record: JsonRecord,
  link: CycleLinkedRead<unknown>,
  label: "recovery" | "sleep",
  missing: string
): string | undefined {
  const { cycle } = link;
  if (cycle === undefined || !linksToOtherCycle(record.cycle_id, cycle)) {
    return undefined;
  }
  const open = cycle.end === null || cycle.end === undefined;
  const started = localTimestamp(cycle.start, cycle.timezone_offset);
  const which = `${open ? "the current cycle" : "the latest cycle"} (id ${String(cycle.id)}${started ? `, started ${started}` : ""})`;
  const target = open ? `today's ${label}` : `the ${label} of that cycle`;
  if (!link.confirmed) {
    return `This ${label} is linked to cycle_id ${String(record.cycle_id)}, not ${which}, and this could not be re-checked; it may be from an earlier cycle. Use get_today before presenting it as ${target}.`;
  }
  return `This ${label} belongs to an earlier cycle (cycle_id ${String(record.cycle_id)}), not ${which}. ${missing} Don't present it as ${target}.`;
}

/** The latest main sleep (or only-naps fallback) in a sleep page, with its notes. */
function latestSleepView(
  records: JsonRecord[]
): { record: JsonRecord; notes: string[] } | undefined {
  if (records.length === 0) {
    return undefined;
  }
  const mainSleep = records.find((record) => record.nap !== true);
  if (mainSleep === undefined) {
    return {
      record: records[0]!,
      notes: [
        `Only naps were found among the latest ${records.length} sleep records; this is the most recent nap, not a main sleep.`,
        ...scoreStateNotes(records[0]!, "nap"),
      ],
    };
  }
  const notes = scoreStateNotes(mainSleep, "sleep");
  if (mainSleep !== records[0]) {
    notes.unshift("More recent naps are not shown; this is the latest main sleep.");
  }
  return { record: mainSleep, notes };
}

const cycleIdentitySchema = cycleRecordSchema.omit({ score: true });

/** The latest cycle as read for the workout resource: the record, none, or a failed read. */
type LatestCycleRead =
  | { status: "read"; cycle: ReturnType<typeof cycleIdentitySchema.parse> | undefined }
  | { status: "failed" };

async function readLatestCycleForWorkout(client: WhoopClient): Promise<LatestCycleRead> {
  try {
    const [record] = pageRecords(await getPage(client, CYCLE_PATH, false));
    if (record === undefined) {
      return { status: "read", cycle: undefined };
    }
    const parsed = cycleIdentitySchema.safeParse(record);
    return parsed.success ? { status: "read", cycle: parsed.data } : { status: "failed" };
  } catch {
    return { status: "failed" };
  }
}

/** The main sleep of a cycle as read for the workout resource: found, none, or a failed read. */
type CycleSleepRead = { status: "read"; sleep: Sleep | undefined } | { status: "failed" };

/**
 * The main sleep that started `cycleId` (the one placeDays would pick with
 * isBetterSleep), from the latest sleep page, else from /v2/cycle/{id}/sleep
 * (404: the cycle has no main sleep, e.g. the partial first day of wear).
 */
async function readCycleMainSleep(
  client: WhoopClient,
  page: Promise<unknown>,
  cycleId: number
): Promise<CycleSleepRead> {
  let best: Sleep | undefined;
  try {
    for (const record of pageRecords(await page)) {
      const parsed = sleepRecordSchema.safeParse(record);
      if (!parsed.success || parsed.data.nap || parsed.data.cycle_id !== cycleId) continue;
      if (best === undefined || isBetterSleep(parsed.data, best)) best = parsed.data;
    }
  } catch {
    return { status: "failed" };
  }
  if (best !== undefined) {
    return { status: "read", sleep: best };
  }
  try {
    const raw = await client.get<unknown>(`/v2/cycle/${cycleId}/sleep`, {
      cache: true,
      ttlMs: CYCLE_TTL_MS,
    });
    const parsed = sleepRecordSchema.safeParse(raw);
    return parsed.success && !parsed.data.nap && parsed.data.cycle_id === cycleId
      ? { status: "read", sleep: parsed.data }
      : { status: "failed" };
  } catch (error: unknown) {
    return httpStatusOf(error) === 404
      ? { status: "read", sleep: undefined }
      : { status: "failed" };
  }
}

/** The newest finished workout in a page: end at or before now and after its start. */
function newestFinishedWorkout(records: JsonRecord[], nowMs: number): JsonRecord | undefined {
  const finished = records.flatMap((record) => {
    const startMs = typeof record.start === "string" ? Date.parse(record.start) : Number.NaN;
    const endMs = typeof record.end === "string" ? Date.parse(record.end) : Number.NaN;
    return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs <= nowMs && endMs > startMs
      ? [{ record, startMs, id: String(record.id) }]
      : [];
  });
  finished.sort(
    (left, right) =>
      right.startMs - left.startMs || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  );
  return finished[0]?.record;
}

/**
 * The latest finished workout as the shared workout summary. Its day is the
 * local day of the latest WHOOP cycle when that cycle contains the start (the
 * day its main sleep ended, as get_day places it); otherwise the workout's
 * local start date (day_by_fallback). A day is never after the local today.
 */
async function latestWorkoutView(client: WhoopClient): Promise<unknown> {
  const nowMs = Date.now();
  const sleepPage = getPage(client, SLEEP_PATH, false);
  // Settled here; readCycleMainSleep reports a failure only when the day needs it.
  sleepPage.catch(() => undefined);
  const [page, cycleRead] = await Promise.all([
    client.get<unknown>(WORKOUT_LIST_PATH, { cache: true, ttlMs: CYCLE_TTL_MS }),
    readLatestCycleForWorkout(client),
  ]);
  const latest = newestFinishedWorkout(pageRecords(page), nowMs);
  if (latest === undefined) {
    return { message: "No workout data available yet." };
  }
  const parsed = workoutRecordSchema.safeParse(latest);
  if (!parsed.success) {
    return {
      message:
        "The latest workout could not be read because WHOOP returned unexpected values; older workouts are not shown in its place.",
    };
  }
  const workout = parsed.data;
  const startMs = Date.parse(workout.start);
  const cycle = cycleRead.status === "read" ? cycleRead.cycle : undefined;
  const cycleStartMs = cycle ? Date.parse(cycle.start) : Number.NaN;
  const cycleEndMs = cycle?.end ? Date.parse(cycle.end) : Number.POSITIVE_INFINITY;
  const contained = cycle !== undefined && cycleStartMs <= startMs && startMs < cycleEndMs;

  let placement: WorkoutPlacement | null = null;
  let dayEstimated = false;
  let dayClamped = false;
  if (contained && cycle) {
    const sleepRead = await readCycleMainSleep(client, sleepPage, cycle.id);
    dayEstimated = sleepRead.status === "failed";
    const mainSleepByCycle = new Map<number, Sleep>();
    if (sleepRead.status === "read" && sleepRead.sleep !== undefined) {
      mainSleepByCycle.set(cycle.id, sleepRead.sleep);
    }
    // A finished workout never counts toward a day after today (the cycle-start
    // estimate of an open cycle begun in the afternoon would be tomorrow).
    const today = localDay(new Date(nowMs).toISOString(), workout.timezone_offset);
    let day = mainDayOf(cycle, mainSleepByCycle);
    if (day > today) {
      day = today;
      dayClamped = true;
    }
    placement = {
      day,
      cycle,
      fallback: false,
      spans_cycle_boundary: Date.parse(workout.end) > cycleEndMs,
      after_midnight_in_previous_cycle: localDay(workout.start, workout.timezone_offset) > day,
    };
  }
  const summary = normalizeWorkout(workout, placement, contained && !cycle?.end);
  if (summary === null) {
    return { message: "No workout data available yet." };
  }

  const notes = scoreStateNotes(latest, "workout");
  if (summary.recorded_fraction !== null && summary.recorded_fraction < MIN_RECORDED_FRACTION) {
    notes.push(
      `Heart-rate data covers only ${Math.round(summary.recorded_fraction * 100)}% of this workout, so its strain, heart-rate zones and calories reflect the recorded part only.`
    );
  }
  if (dayEstimated) {
    notes.push(
      dayClamped
        ? "The day is estimated because sleep data could not be read: the cycle start would place it after today, so it is shown on today."
        : "The day is estimated from the cycle start because sleep data could not be read."
    );
  } else if (dayClamped) {
    notes.push(
      "The current WHOOP cycle has no main sleep record, and its start would place this workout after today, so day is today."
    );
  }
  if (cycleRead.status === "failed") {
    notes.push(
      "The latest WHOOP cycle could not be read, so day is the workout's local start date (day_by_fallback)."
    );
  } else if (cycle && startMs < cycleStartMs) {
    const which = cycle.end ? "latest" : "current";
    notes.push(
      `This workout started before the ${which} WHOOP cycle (started ${localTimestamp(cycle.start, cycle.timezone_offset) ?? cycle.start}), so it is not part of that cycle's strain.`
    );
  } else if (cycle && !contained) {
    notes.push(
      "This workout started after the latest WHOOP cycle ended and the next cycle has not synced yet, so day is the workout's local start date (day_by_fallback)."
    );
  }
  if (HR_ZONE_CAVEAT_SPORT.test(workout.sport_name)) {
    notes.push(
      "Heart-rate zones and strain measure cardiovascular load, which can understate the muscular effort of strength training."
    );
  }
  return withNotes({ ...roundWorkoutSummary(summary) }, notes);
}

export const RESOURCE_DEFINITIONS: ResourceDefinition[] = [
  {
    uri: "whoop://v2/user/recovery/latest",
    name: "Latest Recovery",
    description:
      "Most recent recovery score including HRV, resting heart rate, and SpO2. Its cycle_id is the cycle whose morning it belongs to; notes say when it belongs to an earlier cycle than the current one (today's recovery not available yet), is not scored yet, or WHOOP is still calibrating.",
    mimeType: "application/json",
    ttlMs: CYCLE_TTL_MS,
    fetch: async (client) => {
      const link = await readWithLatestCycle(
        client,
        async (fresh) => pageRecords(await getPage(client, RECOVERY_PATH, fresh))[0],
        (record) => record?.cycle_id
      );
      const latest = link.value;
      if (latest === undefined) {
        return { message: "No recovery data available yet." };
      }
      const notes = scoreStateNotes(latest, "recovery");
      const score = latest.score;
      if (isRecord(score) && score.user_calibrating === true) {
        notes.push(
          "WHOOP is still calibrating to this user (user_calibrating is true): treat the recovery score as provisional."
        );
      }
      const cycleNote = earlierCycleNote(
        latest,
        link,
        "recovery",
        "The recovery for that cycle is not available yet (last night's sleep may still be syncing or being scored)."
      );
      if (cycleNote !== undefined) {
        notes.unshift(cycleNote);
      }
      return withNotes(latest, notes);
    },
  },
  {
    uri: "whoop://v2/user/sleep/latest",
    name: "Latest Sleep",
    description:
      "Most recent main (non-nap) sleep including stages, duration, and performance. Time asleep is light + slow-wave + REM stage time; total_in_bed_time_milli also includes time awake. Its cycle_id is the cycle whose morning it belongs to; notes say when it belongs to an earlier cycle than the current one (last night's sleep not available yet).",
    mimeType: "application/json",
    ttlMs: CYCLE_TTL_MS,
    fetch: async (client) => {
      const link = await readWithLatestCycle(
        client,
        async (fresh) => latestSleepView(pageRecords(await getPage(client, SLEEP_PATH, fresh))),
        (view) =>
          view !== undefined && view.record.nap !== true ? view.record.cycle_id : undefined
      );
      const view = link.value;
      if (view === undefined) {
        return { message: "No sleep data available yet." };
      }
      const notes = [...view.notes];
      if (view.record.nap !== true) {
        const cycleNote = earlierCycleNote(
          view.record,
          link,
          "sleep",
          "The sleep for that cycle (last night's) is not available yet; it may still be syncing or being scored."
        );
        if (cycleNote !== undefined) {
          notes.unshift(cycleNote);
        }
      }
      return withNotes(view.record, notes);
    },
  },
  {
    uri: "whoop://v2/user/cycle/latest",
    name: "Latest Cycle",
    description:
      "Current or most recent physiological cycle including strain and calorie data. A cycle runs from one sleep onset to the next; end is null while it is still in progress.",
    mimeType: "application/json",
    ttlMs: CYCLE_TTL_MS,
    fetch: async (client) => {
      const page = await client.get<unknown>("/v2/cycle?limit=1", {
        cache: true,
        ttlMs: CYCLE_TTL_MS,
      });
      const [latest] = pageRecords(page);
      if (latest === undefined) {
        return { message: "No cycle data available yet." };
      }
      const notes: string[] = [];
      if (latest.end === null || latest.end === undefined) {
        notes.push(
          "This cycle is still in progress (end is null): strain and energy are totals so far, not final values."
        );
      }
      notes.push(...scoreStateNotes(latest, "cycle"));
      return withNotes(latest, notes);
    },
  },
  {
    uri: "whoop://v2/user/workout/latest",
    name: "Latest Workout",
    description:
      "Most recent finished workout as a summary: sport, local start and end, duration, strain, average and max heart rate, energy (kJ and kcal), recorded_fraction (share of the session with heart-rate data), zone minutes and shares, Edwards TRIMP, GPS distance, pace and speed when recorded, and flags. day is the local day of the WHOOP cycle containing its start. Notes say when it is not scored yet, heart-rate data is partial, it started before the current cycle, or heart-rate zones understate strength training.",
    mimeType: "application/json",
    ttlMs: CYCLE_TTL_MS,
    fetch: latestWorkoutView,
  },
  {
    uri: "whoop://v2/user/profile",
    name: "User Profile",
    description: "Authenticated user's basic profile — name and email.",
    mimeType: "application/json",
    ttlMs: PROFILE_TTL_MS,
    fetch: async (client) => {
      return client.get("/v2/user/profile/basic", { cache: true, ttlMs: PROFILE_TTL_MS });
    },
  },
];

// ---------------------------------------------------------------------------
// Resource registration
// ---------------------------------------------------------------------------

/** Options for {@link registerResources}. */
export interface RegisterResourcesOptions {
  /** Read failures are logged here at warn (error class and HTTP status only). */
  logger?: Logger;
}

/** The HTTP status of the first WHOOP API error in an error's cause chain. */
function httpStatusOf(error: unknown): number | undefined {
  let current: unknown = error;
  for (let depth = 0; depth <= 5 && current instanceof Error; depth++) {
    if (current instanceof WhoopApiError) {
      return current.statusCode;
    }
    current = current.cause;
  }
  return undefined;
}

/**
 * Register all WHOOP resources on the given MCP server.
 *
 * Caching is delegated to the client's shared `MemoryCache`; this function is
 * stateless and registers read handlers only.
 */
export function registerResources(
  server: McpServer,
  client: WhoopClient,
  options: RegisterResourcesOptions = {}
): void {
  for (const def of RESOURCE_DEFINITIONS) {
    server.registerResource(
      def.name,
      def.uri,
      { description: def.description, mimeType: def.mimeType },
      async (uri: URL) => {
        try {
          const data = await def.fetch(client);
          return {
            contents: [
              {
                uri: uri.href,
                mimeType: def.mimeType,
                text: JSON.stringify(data, null, 2),
              },
            ],
          };
        } catch (error: unknown) {
          // Described by error type and HTTP status only — no bodies, tokens or health data.
          const reason = describeWhoopError(error) ?? "Retry later or verify authorization.";
          const message = `Resource unavailable. ${reason}`;
          const httpStatus = httpStatusOf(error);
          options.logger?.warn("resource read failed", {
            uri: def.uri,
            errorClass: error instanceof Error ? error.name : typeof error,
            ...(httpStatus !== undefined ? { httpStatus } : {}),
          });
          return {
            contents: [
              {
                uri: uri.href,
                mimeType: "application/json",
                text: JSON.stringify({ error: message }),
              },
            ],
          };
        }
      }
    );
  }
}
