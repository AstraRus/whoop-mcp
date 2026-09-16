/**
 * Long-window WHOOP history, read in 30-day chunks within a per-call request
 * budget and cached chunk by chunk.
 *
 * - Chunks sit on a fixed UTC epoch grid (multiples of 30 days), so the same
 *   chunk has the same cache key on every call.
 * - A closed chunk (its end is in the past) is queried with start and end; the
 *   open chunk (containing now) without end. WHOOP's `start` includes records
 *   still ongoing at it and `end` is exclusive on record start, so a record
 *   spanning a chunk boundary is returned by both chunks and merged by id.
 * - Chunks are read newest first, at most two at a time. Reading stops at the
 *   first chunk that failed, was cut short (a later page failed, or a page,
 *   record or budget cap) or could not be read within the budget. Earlier
 *   chunks stay available: `complete_since` says from when the data is complete.
 * - Only complete chunks are cached: HIST:v1:<endpoint>:<chunk start ms>, with
 *   ":open" for the open chunk. Chunks ending at least 30 days ago are kept for
 *   6 hours, at least 3 days ago for 60 minutes, anything more recent as long
 *   as the cycle resources (2 minutes). A repeated request therefore continues
 *   with older chunks once the newer ones come from the cache.
 * - Pages use the client without its per-request cache, with the budget's
 *   deadline; the process-wide rate limiter paces them (no fixed delay here).
 */

import { z } from "zod";
import type { WhoopClient } from "./client.js";
import { WhoopRateBudgetError } from "./rate-limiter.js";
import type { MemoryCache } from "../cache/memory-cache.js";
import { CYCLE_TTL_MS } from "../resources/index.js";
import {
  parseRecords,
  sourceQuality,
  type AnalyticsSource,
  type SourceQuality,
} from "../tools/analytics-utils.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

/** Length of one history chunk in days. */
export const HISTORY_CHUNK_DAYS = 30;

/** Length of one history chunk in milliseconds. */
export const HISTORY_CHUNK_MS = HISTORY_CHUNK_DAYS * DAY_MS;

/** A chunk that ended at least this long ago is settled (WHOOP edits are rare). */
export const SETTLED_MS = 3 * DAY_MS;

/** A chunk that ended at least this long ago is archived. */
export const ARCHIVE_AGE_MS = 30 * DAY_MS;

/** Cache lifetime of a settled chunk. */
export const CLOSED_TTL_MS = 60 * MINUTE_MS;

/** Cache lifetime of an archived chunk. */
export const ARCHIVE_TTL_MS = 6 * 60 * MINUTE_MS;

/** Cache lifetime of the open chunk and of chunks that ended within SETTLED_MS. */
export const RECENT_TTL_MS = CYCLE_TTL_MS;

/** Pages one tool call may request across all its history sources, by default. */
export const DEFAULT_PAGE_BUDGET = 60;

/** Wall-clock time after the start of a tool call when history loading stops requesting pages. */
export const HISTORY_DEADLINE_MS = 20_000;

/** Pages read for one chunk before it counts as incomplete. */
export const MAX_PAGES_PER_CHUNK = 40;

/** Records read for one chunk before it counts as incomplete. */
export const MAX_RECORDS_PER_CHUNK = 1000;

/** No older chunk is scheduled once a source has loaded this many records. */
export const MAX_RECORDS_PER_SOURCE = 5000;

/** Chunks of one source read at the same time. */
export const HISTORY_CHUNK_CONCURRENCY = 2;

/** Prefix of every history chunk cache key (kept when tokens are refreshed). */
export const HISTORY_CACHE_PREFIX = "HIST:";

/** WHOOP page size used for history requests. */
const PAGE_LIMIT = "25";

/** Limitations every tool that reads history reports in data_quality. */
export const HISTORY_LIMITATIONS: readonly string[] = [
  "Records older than 3 days may be served from a server cache for up to 60 minutes (older than 30 days: up to 6 hours); recent edits or deletions in WHOOP may take that long to appear unless webhooks are enabled.",
  "History is read in 30-day chunks within a per-call request and time budget that keeps the server under WHOOP's rate limit; truncated and complete_since show when older data was not read, and repeating the request continues from the cache.",
];

/** Collections that can be read as history. */
export const HISTORY_ENDPOINTS = [
  "/v2/cycle",
  "/v2/recovery",
  "/v2/activity/sleep",
  "/v2/activity/workout",
] as const;

/** A collection that can be read as history. */
export type HistoryEndpoint = (typeof HISTORY_ENDPOINTS)[number];

const PAGE_SCHEMA = z.object({
  records: z.array(z.unknown()),
  next_token: z.string().max(4096).nullish(),
});

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

/** Pages and wall-clock time one tool call may spend on history, shared by its sources. */
export interface HistoryBudget {
  /** Epoch ms (wall clock) after which no page is requested. */
  readonly deadlineMs: number;
  /** Pages still allowed. */
  readonly pagesRemaining: number;
  /** Take one page; false (nothing taken) when no page is left or the deadline has passed. */
  takePage(): boolean;
}

/** Options for {@link createHistoryBudget}. */
export interface HistoryBudgetOptions {
  /** Default {@link DEFAULT_PAGE_BUDGET}. */
  pages?: number;
  /** Usually ctx.startedAtMs + HISTORY_DEADLINE_MS. */
  deadlineMs: number;
}

/** Create a request budget for one tool call. */
export function createHistoryBudget(options: HistoryBudgetOptions): HistoryBudget {
  let pages = Math.max(0, Math.floor(options.pages ?? DEFAULT_PAGE_BUDGET));
  const deadlineMs = options.deadlineMs;
  return {
    deadlineMs,
    get pagesRemaining(): number {
      return pages;
    },
    takePage(): boolean {
      if (pages <= 0 || Date.now() >= deadlineMs) return false;
      pages -= 1;
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A loaded history source. */
export type HistorySource<T> = AnalyticsSource<T> & {
  /**
   * ISO instant from which the loaded records are complete (every chunk from
   * it to now was read in full), or null when even the newest chunk is not.
   */
  complete_since: string | null;
  chunks_total: number;
  chunks_from_cache: number;
};

/** Options for {@link loadHistory}. */
export interface LoadHistoryOptions {
  /** Chunk cache; without it nothing is cached. */
  cache?: MemoryCache;
  /** Shared by all sources of one tool call. Default: a fresh default budget. */
  budget?: HistoryBudget;
  /** Logical now (open chunk, cache tiers). Default: the system clock. */
  now?: () => Date;
}

/** A chunk as fetched (and, when complete, cached). */
interface ChunkData {
  records: unknown[];
  complete: boolean;
  partialError?: unknown;
}

type ChunkState = "complete" | "incomplete" | "failed" | "unread";

interface ChunkOutcome {
  state: ChunkState;
  records: unknown[];
  hit: boolean;
  /** When the data was stored (hit) or fetched; null when nothing was read. */
  storedAt: number | null;
  error?: unknown;
}

interface Chunk {
  startMs: number;
  open: boolean;
  key: string;
  ttlMs: number;
  path: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function idPart(value: unknown): string | undefined {
  return typeof value === "number" || typeof value === "string" ? String(value) : undefined;
}

/** Identity of a raw record: cycle, sleep and workout id; recovery user_id:cycle_id. */
function recordKey(endpoint: HistoryEndpoint, record: unknown): string | undefined {
  if (!isRecord(record)) return undefined;
  if (endpoint === "/v2/recovery") {
    const user = idPart(record.user_id);
    const cycle = idPart(record.cycle_id);
    return user !== undefined && cycle !== undefined ? `${user}:${cycle}` : undefined;
  }
  return idPart(record.id);
}

function updatedAtMs(record: unknown): number {
  const value = isRecord(record) && typeof record.updated_at === "string" ? record.updated_at : "";
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

function chunkTtlMs(chunkEndMs: number, open: boolean, nowMs: number): number {
  if (open) return RECENT_TTL_MS;
  if (chunkEndMs <= nowMs - ARCHIVE_AGE_MS) return ARCHIVE_TTL_MS;
  if (chunkEndMs <= nowMs - SETTLED_MS) return CLOSED_TTL_MS;
  return RECENT_TTL_MS;
}

/** The chunks covering [startMs, endMs), newest first. */
function chunksFor(
  endpoint: HistoryEndpoint,
  startMs: number,
  endMs: number,
  nowMs: number
): Chunk[] {
  const chunks: Chunk[] = [];
  if (startMs >= endMs) return chunks;
  for (
    let chunkStart = Math.floor(startMs / HISTORY_CHUNK_MS) * HISTORY_CHUNK_MS;
    chunkStart < endMs;
    chunkStart += HISTORY_CHUNK_MS
  ) {
    const chunkEnd = chunkStart + HISTORY_CHUNK_MS;
    const open = chunkEnd > nowMs;
    const query = new URLSearchParams({ start: iso(chunkStart) });
    if (!open) query.set("end", iso(chunkEnd));
    query.set("limit", PAGE_LIMIT);
    chunks.push({
      startMs: chunkStart,
      open,
      key: `${HISTORY_CACHE_PREFIX}v1:${endpoint}:${chunkStart}${open ? ":open" : ""}`,
      ttlMs: chunkTtlMs(chunkEnd, open, nowMs),
      path: `${endpoint}?${query.toString()}`,
    });
  }
  return chunks.reverse();
}

/**
 * Read every page of a chunk. A failure on the first page (including a budget
 * refusal) throws, so nothing is cached; a later failure or a cap returns the
 * records read so far as incomplete.
 */
async function fetchChunk(
  client: WhoopClient,
  chunk: Chunk,
  budget: HistoryBudget
): Promise<ChunkData> {
  const records: unknown[] = [];
  let nextToken: string | null | undefined;
  for (let page = 0; ; page++) {
    if (page >= MAX_PAGES_PER_CHUNK || records.length >= MAX_RECORDS_PER_CHUNK) {
      return { records, complete: false };
    }
    if (!budget.takePage()) {
      const error = new WhoopRateBudgetError();
      if (page === 0) throw error;
      return { records, complete: false, partialError: error };
    }
    const path =
      page === 0 ? chunk.path : `${chunk.path}&nextToken=${encodeURIComponent(nextToken ?? "")}`;
    let parsed: z.infer<typeof PAGE_SCHEMA>;
    try {
      parsed = PAGE_SCHEMA.parse(
        await client.get<unknown>(path, { deadlineMs: budget.deadlineMs })
      );
    } catch (error: unknown) {
      if (page === 0) throw error;
      return { records, complete: false, partialError: error };
    }
    records.push(...parsed.records);
    nextToken = parsed.next_token;
    if (!nextToken) return { records, complete: true };
  }
}

async function loadChunk(
  client: WhoopClient,
  chunk: Chunk,
  budget: HistoryBudget,
  cache: MemoryCache | undefined
): Promise<ChunkOutcome> {
  try {
    const { value, storedAt, hit } =
      cache !== undefined
        ? await cache.getOrFetchWithMeta(
            chunk.key,
            chunk.ttlMs,
            () => fetchChunk(client, chunk, budget),
            { store: (data) => data.complete }
          )
        : { value: await fetchChunk(client, chunk, budget), storedAt: Date.now(), hit: false };
    return {
      state: value.complete ? "complete" : "incomplete",
      records: value.records,
      hit,
      storedAt,
      ...(value.partialError !== undefined ? { error: value.partialError } : {}),
    };
  } catch (error: unknown) {
    return {
      state: error instanceof WhoopRateBudgetError ? "unread" : "failed",
      records: [],
      hit: false,
      storedAt: null,
      error,
    };
  }
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Load a WHOOP collection over `period` in cached 30-day chunks.
 *
 * Records are merged across chunks and deduplicated by id (recoveries by
 * user_id and cycle_id), keeping the most recently updated version; they are
 * not filtered to the period (the first chunk starts on the grid before it), so
 * callers place records by day themselves and then run finishQuality.
 *
 * - quality.truncated: some chunk was incomplete, failed or not read.
 * - quality.cache_status: "hit" only when every chunk came from the cache.
 * - quality.fetched_at: when the oldest data used was fetched.
 * - When nothing was loaded and the newest chunk failed: status "fetch_failed"
 *   with `error` ("invalid" for a malformed page), like loadAnalyticsSource.
 *   Otherwise the first chunk failure, if any, is `partialError`.
 *
 * @throws RangeError when the period is not a pair of valid timestamps
 */
export async function loadHistory<T>(
  client: WhoopClient,
  endpoint: HistoryEndpoint,
  period: { start: string; end: string },
  schema: z.ZodType<T>,
  options: LoadHistoryOptions = {}
): Promise<HistorySource<T>> {
  const nowMs = (options.now?.() ?? new Date()).getTime();
  const startMs = Date.parse(period.start);
  const requestedEndMs = Date.parse(period.end);
  if (!Number.isFinite(startMs) || !Number.isFinite(requestedEndMs) || !Number.isFinite(nowMs)) {
    throw new RangeError("Invalid history period.");
  }
  const endMs = Math.min(requestedEndMs, nowMs);
  const budget =
    options.budget ?? createHistoryBudget({ deadlineMs: Date.now() + HISTORY_DEADLINE_MS });
  const chunks = chunksFor(endpoint, startMs, endMs, nowMs);

  const outcomes: Array<ChunkOutcome | undefined> = chunks.map(() => undefined);
  let nextIndex = 0;
  let stopped = false;
  let loadedRecords = 0;
  const worker = async (): Promise<void> => {
    while (!stopped && nextIndex < chunks.length) {
      const index = nextIndex;
      nextIndex += 1;
      const outcome = await loadChunk(client, chunks[index]!, budget, options.cache);
      outcomes[index] = outcome;
      loadedRecords += outcome.records.length;
      if (outcome.state !== "complete" || loadedRecords >= MAX_RECORDS_PER_SOURCE) {
        stopped = true;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(HISTORY_CHUNK_CONCURRENCY, chunks.length) }, () => worker())
  );

  const states = outcomes.map((outcome) => outcome?.state ?? "unread");
  const truncated = states.some((state) => state !== "complete");
  let completePrefix = 0;
  while (completePrefix < chunks.length && states[completePrefix] === "complete") {
    completePrefix += 1;
  }
  // Complete from the start of the oldest chunk in the unbroken run of complete
  // chunks from the newest one (never before the requested start).
  let completeSince: string | null = null;
  if (completePrefix === chunks.length) {
    completeSince = iso(startMs);
  } else if (completePrefix > 0) {
    completeSince = iso(Math.max(startMs, chunks[completePrefix - 1]!.startMs));
  }
  const chunksFromCache = outcomes.filter((outcome) => outcome?.hit === true).length;
  const meta = {
    complete_since: completeSince,
    chunks_total: chunks.length,
    chunks_from_cache: chunksFromCache,
  };

  // Merge newest chunk first; a later duplicate replaces an entry only when it
  // was updated more recently, and keeps the position of the first one.
  const merged = new Map<string, { record: unknown; updatedMs: number }>();
  const unkeyed: unknown[] = [];
  for (const outcome of outcomes) {
    for (const record of outcome?.records ?? []) {
      const key = recordKey(endpoint, record);
      if (key === undefined) {
        unkeyed.push(record);
        continue;
      }
      const updatedMs = updatedAtMs(record);
      const existing = merged.get(key);
      if (existing === undefined || updatedMs > existing.updatedMs) {
        merged.set(key, { record, updatedMs });
      }
    }
  }
  const rawRecords = [...[...merged.values()].map((entry) => entry.record), ...unkeyed];

  const newest = outcomes[0];
  if (
    rawRecords.length === 0 &&
    newest !== undefined &&
    (newest.state === "failed" || newest.state === "unread")
  ) {
    const error = newest.error ?? new WhoopRateBudgetError();
    if (error instanceof z.ZodError) {
      return { records: [], quality: failedQuality("invalid"), ...meta };
    }
    return { records: [], quality: failedQuality("fetch_failed"), error, ...meta };
  }

  const quality = sourceQuality(rawRecords.length, truncated);
  if (chunks.length > 0) {
    quality.cache_status = chunksFromCache === chunks.length ? "hit" : "miss";
  }
  const storedTimes = outcomes.flatMap((outcome) =>
    outcome?.storedAt !== null && outcome?.storedAt !== undefined ? [outcome.storedAt] : []
  );
  if (storedTimes.length > 0) {
    quality.fetched_at = iso(Math.min(...storedTimes));
  }
  const records = parseRecords(rawRecords, schema, quality);
  const partialError = outcomes.find(
    (outcome) =>
      outcome !== undefined && outcome.state !== "complete" && outcome.error !== undefined
  )?.error;
  return partialError !== undefined
    ? { records, quality, partialError, ...meta }
    : { records, quality, ...meta };
}

function failedQuality(status: "fetch_failed" | "invalid"): SourceQuality {
  return { ...sourceQuality(0, true), status, cache_status: "miss" };
}
