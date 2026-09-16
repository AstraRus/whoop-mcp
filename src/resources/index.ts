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
 * cycle still in progress, only naps found) a `notes` array is added next to
 * the record's own fields.
 *
 * Caching, in-flight deduplication, and invalidation are handled by the
 * `MemoryCache` injected into the WHOOP client (opt-in per request via the
 * `cache` option). Resources and tools share that one cache keyed by request
 * path.
 */

import type { WhoopClient } from "../api/client.js";
import { describeWhoopError } from "../api/client.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** TTL for recovery and sleep resources — 5 minutes */
export const DYNAMIC_TTL_MS = 5 * 60 * 1000;

/** TTL for the cycle resource — 2 minutes (strain updates more frequently) */
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

export const RESOURCE_DEFINITIONS: ResourceDefinition[] = [
  {
    uri: "whoop://v2/user/recovery/latest",
    name: "Latest Recovery",
    description:
      "Most recent recovery score including HRV, resting heart rate, and SpO2. Adds notes when the recovery is not scored yet or WHOOP is still calibrating.",
    mimeType: "application/json",
    ttlMs: DYNAMIC_TTL_MS,
    fetch: async (client) => {
      const page = await client.get<unknown>("/v2/recovery?limit=1", {
        cache: true,
        ttlMs: DYNAMIC_TTL_MS,
      });
      const [latest] = pageRecords(page);
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
      return withNotes(latest, notes);
    },
  },
  {
    uri: "whoop://v2/user/sleep/latest",
    name: "Latest Sleep",
    description:
      "Most recent main (non-nap) sleep including stages, duration, and performance. Time asleep is light + slow-wave + REM stage time; total_in_bed_time_milli also includes time awake.",
    mimeType: "application/json",
    ttlMs: DYNAMIC_TTL_MS,
    fetch: async (client) => {
      const page = await client.get<unknown>(`/v2/activity/sleep?limit=${SLEEP_LOOKBACK_LIMIT}`, {
        cache: true,
        ttlMs: DYNAMIC_TTL_MS,
      });
      const records = pageRecords(page);
      if (records.length === 0) {
        return { message: "No sleep data available yet." };
      }
      const mainSleep = records.find((record) => record.nap !== true);
      if (mainSleep === undefined) {
        return withNotes(records[0]!, [
          `Only naps were found among the latest ${records.length} sleep records; this is the most recent nap, not a main sleep.`,
          ...scoreStateNotes(records[0]!, "nap"),
        ]);
      }
      const notes = scoreStateNotes(mainSleep, "sleep");
      if (mainSleep !== records[0]) {
        notes.unshift("More recent naps are not shown; this is the latest main sleep.");
      }
      return withNotes(mainSleep, notes);
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

/**
 * Register all WHOOP resources on the given MCP server.
 *
 * Caching is delegated to the client's shared `MemoryCache`; this function is
 * stateless and registers read handlers only.
 */
export function registerResources(server: McpServer, client: WhoopClient): void {
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
