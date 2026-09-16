/**
 * MCP Resources — ambient health context backed by the shared API client cache.
 *
 * Exposes 4 resources:
 * - whoop://v2/user/recovery/latest — most recent recovery score
 * - whoop://v2/user/sleep/latest — most recent main (non-nap) sleep
 * - whoop://v2/user/cycle/latest — current or most recent cycle
 * - whoop://v2/user/profile — user profile (cached 1hr)
 *
 * Records are passed through as WHOOP returns them. When a record needs
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
import { describeWhoopError } from "../api/client.js";
import { parseUtcOffset } from "../tools/date-utils.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Logger } from "../logging/logger.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** TTL for slower-changing cached lists (used by get_today for recovery, sleep and workouts) — 5 minutes */
export const DYNAMIC_TTL_MS = 5 * 60 * 1000;

/**
 * TTL for the cycle, recovery and sleep resources — 2 minutes (strain updates
 * frequently). Recovery and sleep share it so their cache entries expire
 * together with the cycle they are compared against.
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
  logger?: Logger;
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
  _options: RegisterResourcesOptions = {}
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
          const errorName = error instanceof Error ? error.name : typeof error;
          console.error(`[whoop-mcp] Resource read failed for ${def.uri} (${errorName})`);
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
