/**
 * Tool: get_sync_status
 *
 * Whether the WHOOP data this server can read is up to date, and why today's
 * numbers may be missing: the strap has not synced, WHOOP has not processed
 * the latest sleep yet, the account has no data yet, or WHOOP cannot be read.
 * It reports record states and times, history coverage and server runtime
 * facts, never health values.
 *
 * Standard mode reads the newest cycle, recent sleeps, the newest recovery and
 * workout (sharing the cache keys of the resources and get_today), the cycle
 * history of the last 90 days through the history loader, and a one-record
 * probe for older cycles.
 *
 * Aggregate mode exposes no current-activity facts: it reads only the cycle
 * history of the last 13 released weeks (whole local weeks released two days
 * after they end) plus a probe for cycles before them, so its output cannot
 * change between the Wednesday a week is released and the next Tuesday unless
 * WHOOP data inside released weeks changes.
 */

import { z } from "zod";
import type { WhoopClient } from "../api/client.js";
import { describeWhoopError, WhoopApiError, WhoopAuthError } from "../api/client.js";
import {
  createHistoryBudget,
  HISTORY_DEADLINE_MS,
  loadConsistentHistory,
  loadHistory,
  type HistoryBudget,
  type HistoryLoader,
} from "../api/history.js";
import {
  cycleRecordSchema,
  recoveryRecordSchema,
  sleepRecordSchema,
  workoutRecordSchema,
} from "../api/record-schemas.js";
import type { Cycle } from "../api/types.js";
import { CYCLE_TTL_MS, SLEEP_LOOKBACK_LIMIT } from "../resources/index.js";
import type { RuntimeSnapshot } from "../runtime-status.js";
import { packageVersion } from "../runtime-status.js";
import { aggregateEvaluatedAt, lastReleasedWeeks } from "./aggregate-window.js";
import { cycleDay, DAY_MS, formatLocalTimestamp, HOUR_MS } from "./analytics-utils.js";
import { resolveUserUtcOffsetInfo, withOffsetNote } from "./collection-utils.js";
import { mondayOf } from "./day-model.js";
import { LONG_CYCLE_MS, MAX_SYNC_GAP_MS, STALE_SLEEP_MS } from "./get-today.js";
import { roundTo } from "./stats-utils.js";
import { defineTool, type ToolContext } from "./tool-definition.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Tool name. */
export const SYNC_STATUS_TOOL_NAME = "get_sync_status";

/** Days of cycle history read to date the first cycle of a new account (standard mode). */
export const SYNC_STATUS_HISTORY_DAYS = 90;

/** Released weeks read in aggregate mode. */
export const SYNC_STATUS_RELEASED_WEEKS = 13;

/** Cache TTL of the older-history probe. */
export const OLDER_HISTORY_PROBE_TTL_MS = 10 * 60 * 1000;

/**
 * The standard probe boundary (now − 90 days) is floored to this grid so its
 * request, and therefore its cache key, repeats between calls.
 */
export const OLDER_HISTORY_PROBE_GRID_MS = HOUR_MS;

/** Newest cycle: the cycle resource's request and cache key. */
export const SYNC_CYCLE_PATH = "/v2/cycle?limit=1";

/** Recent sleeps: the sleep resource's request and cache key (naps can hide the main sleep). */
export const SYNC_SLEEP_PATH = `/v2/activity/sleep?limit=${SLEEP_LOOKBACK_LIMIT}`;

/** Newest recovery: the recovery resource's request and cache key. */
export const SYNC_RECOVERY_PATH = "/v2/recovery?limit=1";

/** Newest workout. */
export const SYNC_WORKOUT_PATH = "/v2/activity/workout?limit=1";

const CACHED = { cache: true, ttlMs: CYCLE_TTL_MS } as const;

/** A re-read that bypasses and replaces the cached entry (shared with the resources and get_today). */
const REFRESHED = { cache: true, ttlMs: CYCLE_TTL_MS, refresh: true } as const;

// ---------------------------------------------------------------------------
// Output contracts
// ---------------------------------------------------------------------------

const localTimestamp = z
  .string()
  .describe("Local time with its UTC offset (ISO 8601), e.g. 2026-09-16T23:13:31.460+02:00");
const hoursSince = z.number().nonnegative().nullable();
const refreshOutcomeSchema = z.enum(["ok", "transient_failure", "rejected", "client_rejected"]);
const scoreStateSchema = z.enum(["scored", "pending", "unscorable", "none", "unavailable"]);
const count = z.number().int().nonnegative();

const standardOutputSchema = z.object({
  evaluated_at: localTimestamp,
  utc_offset: z.object({
    offset: z.string(),
    fallback: z.boolean().describe("True when the offset could not be read and UTC is used"),
  }),
  assessment: z.enum([
    "up_to_date",
    "sleep_not_processed_yet",
    "strap_not_synced",
    "no_data_yet",
    "unavailable",
  ]),
  history: z.object({
    first_cycle_date: z
      .string()
      .nullable()
      .describe(
        "Local day of the first WHOOP cycle; null when history reaches back 90 days or more"
      ),
    days_with_cycles: count.nullable(),
    more_than_90_days: z.boolean().nullable(),
  }),
  latest: z.object({
    cycle: z.object({
      state: z.enum(["open", "closed", "none", "unavailable"]),
      started: localTimestamp.nullable(),
      last_updated: localTimestamp.nullable(),
      hours_since_update: hoursSince,
    }),
    sleep: z.object({
      state: scoreStateSchema,
      ended: localTimestamp.nullable(),
      hours_since_end: hoursSince,
      linked_to_current_cycle: z.boolean().nullable(),
      only_naps_recent: z.boolean(),
    }),
    recovery: z.object({
      state: scoreStateSchema,
      calibrating: z.boolean().nullable(),
      linked_to_current_cycle: z.boolean().nullable(),
    }),
    workout: z.object({
      state: scoreStateSchema,
      started: localTimestamp.nullable(),
    }),
  }),
  server: z.object({
    version: z.string(),
    commit: z.string().nullable(),
    privacy_mode: z.enum(["standard", "aggregate"]),
    oauth_connector: z.boolean().nullable(),
    webhooks: z.object({
      enabled: z.boolean().nullable(),
      last_event_at: localTimestamp.nullable(),
    }),
    whoop_auth: z.object({
      access_token_expires_in_minutes: z
        .number()
        .int()
        .nullable()
        .describe("Negative once the access token has expired (it is refreshed on the next use)"),
      last_refresh_outcome: refreshOutcomeSchema.nullable(),
    }),
    whoop_api: z.object({
      requests_last_minute: count.nullable(),
      rate_limited_responses_total: count.nullable(),
    }),
  }),
  notes: z.array(z.string()),
});

const aggregateOutputSchema = z.object({
  evaluated_on: z.string().describe("The user's local date (YYYY-MM-DD)"),
  assessment: z.enum(["connected", "no_data_yet", "unavailable"]),
  released_weeks: z.object({
    latest_week_start: z
      .string()
      .nullable()
      .describe("Monday of the latest released week (released two days after it ends)"),
    weeks_with_data_last_13: z.number().int().min(0).max(SYNC_STATUS_RELEASED_WEEKS).nullable(),
  }),
  history: z.object({
    more_than_90_days: z
      .boolean()
      .nullable()
      .describe("Whether WHOOP has cycles from before the last 13 released weeks"),
  }),
  server: z.object({
    version: z.string(),
    commit: z.string().nullable(),
    privacy_mode: z.enum(["standard", "aggregate"]),
    oauth_connector: z.boolean().nullable(),
    webhooks_enabled: z.boolean().nullable(),
    whoop_auth_last_refresh_outcome: refreshOutcomeSchema.nullable(),
  }),
  notes: z.array(z.string()),
});

/** get_sync_status output in standard mode. */
export type SyncStatus = z.infer<typeof standardOutputSchema>;

/** get_sync_status output in aggregate mode. */
export type AggregateSyncStatus = z.infer<typeof aggregateOutputSchema>;

const inputSchema = z.object({});

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

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The records of a collection page; a malformed page throws (the read is unavailable). */
function pageRecords(page: unknown): unknown[] {
  if (!isRecord(page) || !Array.isArray(page.records)) {
    throw new TypeError("WHOOP returned a collection page without records.");
  }
  return page.records;
}

/** Hours from `fromMs` to `nowMs`, one decimal, never negative. */
function hoursFrom(fromMs: number, nowMs: number): number {
  return roundTo(Math.max(0, nowMs - fromMs) / HOUR_MS, 1);
}

/** Whole hours for notes. */
function wholeHours(fromMs: number, nowMs: number): number {
  return Math.round(Math.max(0, nowMs - fromMs) / HOUR_MS);
}

function localAt(timestamp: string, offset: string): string {
  return formatLocalTimestamp(Date.parse(timestamp), offset);
}

function scoreState(value: string): "scored" | "pending" | "unscorable" {
  return value === "SCORED" ? "scored" : value === "PENDING_SCORE" ? "pending" : "unscorable";
}

/** Plain-language reason a WHOOP read failed (type and status only, never bodies). */
function failureReason(error: unknown): string {
  return (
    describeWhoopError(error) ??
    (error instanceof TypeError
      ? "WHOOP returned an unexpected response."
      : "The request failed; retry later.")
  );
}

/** Why a history load failed: its error, or an unreadable page. */
function historyFailureReason(history: { quality: { status: string }; error?: unknown }): string {
  return history.error === undefined && history.quality.status === "invalid"
    ? "WHOOP returned an unexpected response."
    : failureReason(history.error);
}

/** Auth failures: the token could not be refreshed, or WHOOP rejected the authorization. */
function isAuthFailure(error: unknown): boolean {
  return (
    error instanceof WhoopAuthError ||
    (error instanceof WhoopApiError && (error.statusCode === 401 || error.statusCode === 403))
  );
}

const cycleIdentitySchema = cycleRecordSchema.omit({ score: true });
const sleepIdentitySchema = sleepRecordSchema.omit({ score: true });
const recoveryIdentitySchema = recoveryRecordSchema.omit({ score: true });
const workoutIdentitySchema = workoutRecordSchema.omit({ score: true });

type CycleIdentity = z.infer<typeof cycleIdentitySchema>;
type SleepIdentity = z.infer<typeof sleepIdentitySchema>;

/** Records of a page that match `schema`; unreadable records are skipped. */
function parseAll<T>(records: unknown[], schema: z.ZodType<T>): T[] {
  return records.flatMap((record) => {
    const parsed = schema.safeParse(record);
    return parsed.success ? [parsed.data] : [];
  });
}

/** Loads the cycle history over `period` for one call, through the shared history cache. */
function cycleHistoryLoader(
  ctx: ToolContext,
  period: { start: string; end: string },
  budget: HistoryBudget
): HistoryLoader<Cycle> {
  return (extra) =>
    loadHistory<Cycle>(ctx.client, "/v2/cycle", period, cycleRecordSchema, {
      budget,
      now: () => ctx.now(),
      ...(ctx.historyCache !== undefined ? { cache: ctx.historyCache } : {}),
      ...extra,
    });
}

/**
 * Whether the newest-cycle read and the recent-sleeps read disagree, as reads
 * from different sides of a WHOOP sync do: the newest sleep does not belong to
 * the newest cycle, or the newest main sleep ended after the open cycle started
 * without belonging to it. Unreadable or empty reads never disagree.
 */
function latestReadsOutOfStep(cycleRead: Settled<unknown>, sleepRead: Settled<unknown>): boolean {
  if (!cycleRead.ok || !sleepRead.ok) return false;
  let cycles: CycleIdentity[];
  let sleeps: SleepIdentity[];
  try {
    cycles = parseAll(pageRecords(cycleRead.value), cycleIdentitySchema);
    sleeps = parseAll(pageRecords(sleepRead.value), sleepIdentitySchema);
  } catch {
    return false;
  }
  const newestCycle = [...cycles].sort((a, b) => Date.parse(b.start) - Date.parse(a.start))[0];
  if (newestCycle === undefined || sleeps.length === 0) return false;
  const newestSleep = [...sleeps].sort((a, b) => Date.parse(b.start) - Date.parse(a.start))[0]!;
  if (newestSleep.cycle_id !== newestCycle.id) return true;
  if (newestCycle.end !== null && newestCycle.end !== undefined) return false;
  const cycleStartMs = Date.parse(newestCycle.start);
  const newestMain = sleeps
    .filter((sleep) => !sleep.nap)
    .sort((a, b) => Date.parse(b.end) - Date.parse(a.end))[0];
  return (
    newestMain !== undefined &&
    newestMain.cycle_id !== newestCycle.id &&
    Date.parse(newestMain.end) > cycleStartMs
  );
}

/** The older-history probe: whether WHOOP has a cycle starting before `endMs`. */
async function probeOlderCycles(client: WhoopClient, endMs: number): Promise<boolean> {
  const query = new URLSearchParams({ end: iso(endMs), limit: "1" });
  const page = await client.get<unknown>(`/v2/cycle?${query.toString()}`, {
    cache: true,
    ttlMs: OLDER_HISTORY_PROBE_TTL_MS,
  });
  return pageRecords(page).length > 0;
}

// ---------------------------------------------------------------------------
// Standard variant
// ---------------------------------------------------------------------------

interface LatestReads {
  cycle: Settled<unknown>;
  sleep: Settled<unknown>;
  recovery: Settled<unknown>;
  workout: Settled<unknown>;
}

function serverBlock(ctx: ToolContext, nowMs: number, offset: string): SyncStatus["server"] {
  const snapshot: RuntimeSnapshot | undefined = ctx.runtime?.snapshot();
  const expiresAt = snapshot?.whoop_auth.access_token_expires_at;
  const lastEventAt = snapshot?.webhooks.last_event_at;
  return {
    version: snapshot?.version ?? packageVersion(),
    commit: snapshot?.commit ?? null,
    privacy_mode: ctx.privacyMode,
    oauth_connector: snapshot?.oauth_connector ?? null,
    webhooks: {
      enabled: snapshot?.webhooks.enabled ?? null,
      last_event_at:
        lastEventAt !== undefined && lastEventAt !== null ? localAt(lastEventAt, offset) : null,
    },
    whoop_auth: {
      access_token_expires_in_minutes:
        expiresAt !== undefined && expiresAt !== null
          ? Math.round((Date.parse(expiresAt) - nowMs) / 60_000)
          : null,
      last_refresh_outcome: snapshot?.whoop_auth.last_refresh?.outcome ?? null,
    },
    whoop_api: {
      requests_last_minute: snapshot?.whoop_api.requests_last_minute ?? null,
      rate_limited_responses_total: snapshot?.whoop_api.rate_limited_responses_total ?? null,
    },
  };
}

/** Standard get_sync_status. */
export async function getSyncStatus(ctx: ToolContext): Promise<SyncStatus> {
  const now = ctx.now();
  const nowMs = now.getTime();
  const client = ctx.client;
  const historyStartMs =
    Math.floor((nowMs - SYNC_STATUS_HISTORY_DAYS * DAY_MS) / OLDER_HISTORY_PROBE_GRID_MS) *
    OLDER_HISTORY_PROBE_GRID_MS;
  const budget = createHistoryBudget({ deadlineMs: ctx.startedAtMs + HISTORY_DEADLINE_MS });

  const [
    offsetInfo,
    firstCycleRead,
    firstSleepRead,
    firstRecoveryRead,
    workoutRead,
    loaded,
    probe,
  ] = await Promise.all([
    resolveUserUtcOffsetInfo(client),
    settle(client.get<unknown>(SYNC_CYCLE_PATH, CACHED)),
    settle(client.get<unknown>(SYNC_SLEEP_PATH, CACHED)),
    settle(client.get<unknown>(SYNC_RECOVERY_PATH, CACHED)),
    settle(client.get<unknown>(SYNC_WORKOUT_PATH, CACHED)),
    loadConsistentHistory([
      cycleHistoryLoader(ctx, { start: iso(historyStartMs), end: iso(nowMs) }, budget),
    ]),
    settle(probeOlderCycles(client, historyStartMs)),
  ]);
  const [history] = loaded.sources;
  let cycleRead = firstCycleRead;
  let sleepRead = firstSleepRead;
  let recoveryRead = firstRecoveryRead;
  // The newest cycle and the recent sleeps can come from caches filled on
  // different sides of a WHOOP sync (or WHOOP can create a night's cycle a few
  // seconds before its sleep): read them, and the newest recovery, once more.
  if (latestReadsOutOfStep(cycleRead, sleepRead)) {
    [cycleRead, sleepRead, recoveryRead] = await Promise.all([
      settle(client.get<unknown>(SYNC_CYCLE_PATH, REFRESHED)),
      settle(client.get<unknown>(SYNC_SLEEP_PATH, REFRESHED)),
      settle(client.get<unknown>(SYNC_RECOVERY_PATH, REFRESHED)),
    ]);
  }
  const offset = offsetInfo.offset;
  const reads: LatestReads = {
    cycle: cycleRead,
    sleep: sleepRead,
    recovery: recoveryRead,
    workout: workoutRead,
  };
  const notes: string[] = [...loaded.warnings];

  // --- Newest cycle ----------------------------------------------------------
  let cycleFailure: unknown;
  let newestCycle: CycleIdentity | undefined;
  if (reads.cycle.ok) {
    try {
      const cycles = parseAll(pageRecords(reads.cycle.value), cycleIdentitySchema);
      newestCycle = cycles.sort((a, b) => Date.parse(b.start) - Date.parse(a.start))[0];
      if (newestCycle === undefined && pageRecords(reads.cycle.value).length > 0) {
        cycleFailure = new TypeError("Unreadable cycle.");
      }
    } catch (error: unknown) {
      cycleFailure = error;
    }
  } else {
    cycleFailure = reads.cycle.error;
  }
  const cycleOpen =
    newestCycle !== undefined &&
    (newestCycle.end === null ||
      newestCycle.end === undefined ||
      Date.parse(newestCycle.end) > nowMs);
  const cycleUpdatedMs = newestCycle ? Date.parse(newestCycle.updated_at) : Number.NaN;
  const latestCycle: SyncStatus["latest"]["cycle"] =
    cycleFailure !== undefined
      ? { state: "unavailable", started: null, last_updated: null, hours_since_update: null }
      : newestCycle === undefined
        ? { state: "none", started: null, last_updated: null, hours_since_update: null }
        : {
            state: cycleOpen ? "open" : "closed",
            started: localAt(newestCycle.start, newestCycle.timezone_offset),
            last_updated: localAt(newestCycle.updated_at, newestCycle.timezone_offset),
            hours_since_update: hoursFrom(cycleUpdatedMs, nowMs),
          };
  const linked = (cycleId: number): boolean | null =>
    newestCycle === undefined ? null : cycleId === newestCycle.id;

  // --- Latest main sleep -----------------------------------------------------
  let latestSleep: SyncStatus["latest"]["sleep"] = {
    state: "unavailable",
    ended: null,
    hours_since_end: null,
    linked_to_current_cycle: null,
    only_naps_recent: false,
  };
  let mainSleep: SleepIdentity | undefined;
  let sleepFailure: unknown;
  try {
    if (!reads.sleep.ok) throw reads.sleep.error;
    const raw = pageRecords(reads.sleep.value);
    const sleeps = parseAll(raw, sleepIdentitySchema);
    if (sleeps.length < raw.length) throw new TypeError("Unreadable sleep.");
    mainSleep = sleeps
      .filter((sleep) => !sleep.nap && Date.parse(sleep.end) > Date.parse(sleep.start))
      .sort((a, b) => Date.parse(b.end) - Date.parse(a.end))[0];
    const onlyNaps = sleeps.length > 0 && sleeps.every((sleep) => sleep.nap);
    latestSleep = mainSleep
      ? {
          state: scoreState(mainSleep.score_state),
          ended: localAt(mainSleep.end, mainSleep.timezone_offset),
          hours_since_end: hoursFrom(Date.parse(mainSleep.end), nowMs),
          linked_to_current_cycle: linked(mainSleep.cycle_id),
          only_naps_recent: onlyNaps,
        }
      : {
          state: "none",
          ended: null,
          hours_since_end: null,
          linked_to_current_cycle: null,
          only_naps_recent: onlyNaps,
        };
    if (onlyNaps) {
      notes.push(
        `Only naps were found among the latest ${raw.length} sleep records, so there is no recent main sleep to report.`
      );
    } else if (mainSleep?.score_state === "PENDING_SCORE") {
      notes.push("WHOOP has not finished scoring the latest main sleep yet (PENDING_SCORE).");
    }
  } catch (error: unknown) {
    sleepFailure = error;
  }

  // --- Newest recovery -------------------------------------------------------
  let latestRecovery: SyncStatus["latest"]["recovery"] = {
    state: "unavailable",
    calibrating: null,
    linked_to_current_cycle: null,
  };
  let recoveryFailure: unknown;
  try {
    if (!reads.recovery.ok) throw reads.recovery.error;
    const raw = pageRecords(reads.recovery.value);
    const [record] = raw;
    if (record === undefined) {
      latestRecovery = { state: "none", calibrating: null, linked_to_current_cycle: null };
    } else {
      const identity = recoveryIdentitySchema.safeParse(record);
      if (!identity.success) throw new TypeError("Unreadable recovery.");
      const full = recoveryRecordSchema.safeParse(record);
      const calibrating =
        identity.data.score_state === "SCORED" && full.success && full.data.score
          ? full.data.score.user_calibrating
          : null;
      latestRecovery = {
        state: scoreState(identity.data.score_state),
        calibrating,
        linked_to_current_cycle: linked(identity.data.cycle_id),
      };
      if (calibrating === true) {
        notes.push(
          "WHOOP is still calibrating recovery for this account (user_calibrating is true), so recovery scores are provisional."
        );
      }
    }
  } catch (error: unknown) {
    recoveryFailure = error;
  }

  // --- Newest workout ---------------------------------------------------------
  let latestWorkout: SyncStatus["latest"]["workout"] = { state: "unavailable", started: null };
  let workoutFailure: unknown;
  try {
    if (!reads.workout.ok) throw reads.workout.error;
    const raw = pageRecords(reads.workout.value);
    const workouts = parseAll(raw, workoutIdentitySchema);
    if (workouts.length < raw.length) throw new TypeError("Unreadable workout.");
    const newest = workouts.sort((a, b) => Date.parse(b.start) - Date.parse(a.start))[0];
    latestWorkout = newest
      ? {
          state: scoreState(newest.score_state),
          started: localAt(newest.start, newest.timezone_offset),
        }
      : { state: "none", started: null };
  } catch (error: unknown) {
    workoutFailure = error;
  }

  // --- Assessment ------------------------------------------------------------
  let assessment: SyncStatus["assessment"];
  if (cycleFailure !== undefined) {
    assessment = "unavailable";
    notes.unshift(
      `${isAuthFailure(cycleFailure) ? "WHOOP sign-in failed, so no WHOOP data could be read" : "The newest WHOOP cycle could not be read"}: ${failureReason(cycleFailure)}`
    );
  } else if (newestCycle === undefined) {
    assessment = "no_data_yet";
    notes.unshift(
      "WHOOP has no cycles for this account yet. They appear once the strap has been worn and has synced with the WHOOP app."
    );
  } else if (nowMs - cycleUpdatedMs > MAX_SYNC_GAP_MS) {
    assessment = "strap_not_synced";
    notes.unshift(
      `WHOOP has not updated the latest cycle since ${localAt(newestCycle.updated_at, newestCycle.timezone_offset)}, about ${wholeHours(cycleUpdatedMs, nowMs)} hours ago; the strap may not have synced with the WHOOP app since then.`
    );
  } else if (!cycleOpen && newestCycle.end) {
    assessment = "sleep_not_processed_yet";
    notes.unshift(
      `The latest WHOOP cycle ended ${localAt(newestCycle.end, newestCycle.timezone_offset)} and no newer cycle has synced yet. WHOOP starts the next cycle once it has processed the sleep that began then, so today's cycle, sleep and recovery are not available yet.`
    );
  } else {
    const sleepEndMs = mainSleep ? Date.parse(mainSleep.end) : undefined;
    const cycleStartMs = Date.parse(newestCycle.start);
    const outdated =
      sleepEndMs !== undefined
        ? nowMs - sleepEndMs > STALE_SLEEP_MS
        : nowMs - cycleStartMs > LONG_CYCLE_MS;
    if (outdated && mainSleep && sleepEndMs !== undefined) {
      assessment = "sleep_not_processed_yet";
      notes.unshift(
        `The latest main sleep ended ${localAt(mainSleep.end, mainSleep.timezone_offset)}, about ${wholeHours(sleepEndMs, nowMs)} hours ago, and WHOOP has not processed a newer one. A sleep since then is either not processed yet or was not detected; opening the WHOOP app to sync may help.`
      );
    } else if (outdated) {
      assessment = "sleep_not_processed_yet";
      notes.unshift(
        `The current WHOOP cycle started ${localAt(newestCycle.start, newestCycle.timezone_offset)}, about ${wholeHours(cycleStartMs, nowMs)} hours ago, and no newer sleep has been processed. A sleep since then is either not processed yet or was not detected; opening the WHOOP app to sync may help.`
      );
    } else {
      assessment = "up_to_date";
    }
  }
  const failures: Array<[string, unknown]> = [
    ["latest sleep", sleepFailure],
    ["latest recovery", recoveryFailure],
    ["latest workout", workoutFailure],
  ];
  for (const [label, failure] of failures) {
    const sameAsCycle =
      cycleFailure !== undefined && failureReason(failure) === failureReason(cycleFailure);
    if (failure !== undefined && !sameAsCycle) {
      notes.push(`The ${label} could not be read: ${failureReason(failure)}`);
    }
  }

  // --- History ----------------------------------------------------------------
  const historyFailed =
    history.quality.status === "fetch_failed" || history.quality.status === "invalid";
  const moreThan90Days = probe.ok ? probe.value : null;
  let firstCycleDate: string | null = null;
  let daysWithCycles: number | null = null;
  if (historyFailed) {
    if (cycleFailure === undefined) {
      notes.push(
        `The cycle history could not be read, so first_cycle_date and days_with_cycles are null: ${historyFailureReason(history)}`
      );
    }
  } else if (moreThan90Days === true) {
    notes.push(
      `WHOOP has cycles from more than ${SYNC_STATUS_HISTORY_DAYS} days ago, so first_cycle_date and days_with_cycles are not reported.`
    );
  } else if (moreThan90Days === null) {
    if (cycleFailure === undefined) {
      notes.push(
        `Whether WHOOP has cycles from more than ${SYNC_STATUS_HISTORY_DAYS} days ago could not be read, so first_cycle_date and days_with_cycles are null: ${failureReason(probe.ok ? undefined : probe.error)}`
      );
    }
  } else if (history.quality.truncated) {
    notes.push(
      "The cycle history could not be read in full within this call's WHOOP request budget, so first_cycle_date and days_with_cycles are null; repeating the request continues from the server cache."
    );
  } else {
    const days = new Set(
      history.records
        .filter((cycle) => Date.parse(cycle.start) <= nowMs)
        .map((cycle) => cycleDay(cycle))
    );
    const sorted = [...days].sort();
    firstCycleDate = sorted[0] ?? null;
    daysWithCycles = days.size;
  }

  return {
    evaluated_at: formatLocalTimestamp(nowMs, offset),
    utc_offset: { offset, fallback: offsetInfo.fallback },
    assessment,
    history: {
      first_cycle_date: firstCycleDate,
      days_with_cycles: daysWithCycles,
      more_than_90_days: moreThan90Days,
    },
    latest: {
      cycle: latestCycle,
      sleep: latestSleep,
      recovery: latestRecovery,
      workout: latestWorkout,
    },
    server: serverBlock(ctx, nowMs, offset),
    notes: withOffsetNote(notes, offsetInfo.fallback),
  };
}

// ---------------------------------------------------------------------------
// Aggregate variant
// ---------------------------------------------------------------------------

/** Aggregate get_sync_status: released weeks only, no current-activity facts. */
export async function getAggregateSyncStatus(ctx: ToolContext): Promise<AggregateSyncStatus> {
  const now = ctx.now();
  const client = ctx.client;
  const offsetInfo = await resolveUserUtcOffsetInfo(client);
  const offset = offsetInfo.offset;
  const weeks = lastReleasedWeeks(now, offset, SYNC_STATUS_RELEASED_WEEKS);
  const releasedMondays = new Set(weeks.map((week) => week.monday));
  const latestWeek = weeks[weeks.length - 1]!;
  const windowEndMs = latestWeek.endMs;
  // One day before the oldest released Monday: a cycle starting the evening
  // before it can still count toward that Monday.
  const loadStartMs = weeks[0]!.startMs - DAY_MS;
  const budget = createHistoryBudget({ deadlineMs: ctx.startedAtMs + HISTORY_DEADLINE_MS });

  const [loaded, probe] = await Promise.all([
    loadConsistentHistory([
      cycleHistoryLoader(ctx, { start: iso(loadStartMs), end: iso(windowEndMs) }, budget),
    ]),
    settle(probeOlderCycles(client, loadStartMs)),
  ]);
  const [history] = loaded.sources;

  const notes: string[] = [
    "Aggregate mode reports only whole local weeks, released two days after they end; the latest records, sync times and request counts are not shown.",
    ...loaded.warnings,
  ];
  const historyFailed =
    history.quality.status === "fetch_failed" || history.quality.status === "invalid";
  const moreThan90Days = probe.ok ? probe.value : null;

  let weeksWithData: number | null = null;
  let anyReleasedCycle = false;
  if (!historyFailed) {
    const mondays = new Set<string>();
    for (const cycle of history.records) {
      if (!(Date.parse(cycle.start) < windowEndMs)) continue;
      const monday = mondayOf(cycleDay(cycle));
      if (releasedMondays.has(monday)) mondays.add(monday);
    }
    anyReleasedCycle = mondays.size > 0;
    if (history.quality.truncated) {
      notes.push(
        "The released weeks could not be read in full within this call's WHOOP request budget, so weeks_with_data_last_13 is null; repeating the request continues from the server cache."
      );
    } else {
      weeksWithData = mondays.size;
    }
  }

  let assessment: AggregateSyncStatus["assessment"];
  if (historyFailed) {
    assessment = "unavailable";
    notes.unshift(`WHOOP data could not be read: ${historyFailureReason(history)}`);
  } else if (anyReleasedCycle || moreThan90Days === true) {
    assessment = "connected";
  } else if (!history.quality.truncated && moreThan90Days === false) {
    assessment = "no_data_yet";
    notes.push(
      "No released week contains WHOOP cycles and WHOOP has no older cycles; newer data is counted once its week is released."
    );
  } else {
    assessment = "connected";
  }
  if (moreThan90Days === null && !historyFailed) {
    notes.push(
      `Whether WHOOP has cycles from before the last ${SYNC_STATUS_RELEASED_WEEKS} released weeks could not be read, so more_than_90_days is null: ${failureReason(probe.ok ? undefined : probe.error)}`
    );
  }

  const snapshot = ctx.runtime?.snapshot();
  return {
    evaluated_on: aggregateEvaluatedAt(now, offset),
    assessment,
    released_weeks: {
      latest_week_start: latestWeek.monday,
      weeks_with_data_last_13: weeksWithData,
    },
    history: { more_than_90_days: moreThan90Days },
    server: {
      version: snapshot?.version ?? packageVersion(),
      commit: snapshot?.commit ?? null,
      privacy_mode: ctx.privacyMode,
      oauth_connector: snapshot?.oauth_connector ?? null,
      webhooks_enabled: snapshot?.webhooks.enabled ?? null,
      whoop_auth_last_refresh_outcome: snapshot?.whoop_auth.last_refresh?.outcome ?? null,
    },
    notes: withOffsetNote(notes, offsetInfo.fallback),
  };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const SYNC_STATUS_TOOL = defineTool({
  name: SYNC_STATUS_TOOL_NAME,
  annotations: { readOnlyHint: true },
  standard: {
    title: "Sync status",
    description:
      "Whether WHOOP data is up to date, and why today's data may be missing. assessment: up_to_date; sleep_not_processed_yet (the open cycle's latest main sleep ended over 20 hours ago, or the newest cycle ended and no newer cycle has synced); strap_not_synced (WHOOP has not updated the newest cycle for 24 hours); no_data_yet (no cycles); unavailable (WHOOP could not be read, notes say why). latest gives the state and local times of the newest cycle, main sleep, recovery and workout, hours since they were updated or ended, and whether sleep and recovery link to the newest cycle. history gives the first cycle date and days with cycles for accounts with under 90 days of data. server gives the version, privacy mode, webhook and WHOOP sign-in state and request counters. No health values.",
    inputSchema,
    outputSchema: standardOutputSchema,
    run: async (_args, ctx) => getSyncStatus(ctx),
  },
  aggregate: {
    title: "Sync status",
    description:
      "WHOOP connection status in aggregate privacy mode, without current-activity details. assessment: connected; no_data_yet (no cycles in released weeks or before them); unavailable (WHOOP could not be read, notes say why). released_weeks gives the Monday of the latest released week (whole local weeks are released two days after they end) and how many of the last 13 released weeks contain WHOOP cycles; history.more_than_90_days says whether WHOOP has cycles from before those weeks. server gives the version, privacy mode, webhook flag and the last WHOOP sign-in refresh outcome. Latest records, sync times and request counts are not shown in this mode.",
    inputSchema,
    outputSchema: aggregateOutputSchema,
    run: async (_args, ctx) => getAggregateSyncStatus(ctx),
  },
});
