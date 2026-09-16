/**
 * Shared types and utilities for collection tool handlers.
 *
 * All 4 collection tools (recovery, sleep, workout, cycle) use the same
 * query parameter shape and query string building logic.
 *
 * Enhanced date expressions ("today", "last 7 days", etc.) and ISO 8601
 * dates are resolved to full UTC timestamps before sending to the WHOOP API,
 * using the user's local calendar days.
 */

import type { WhoopClient } from "../api/client.js";
import { WhoopApiError, WhoopNetworkError } from "../api/client.js";
import type { CycleCollection } from "../api/types.js";
import { ENDPOINT_CYCLE } from "../api/endpoints.js";
import { offsetSchema } from "../api/record-schemas.js";
import { CYCLE_TTL_MS } from "../resources/index.js";
import { InvalidDateExpression, resolveDateExpression } from "./date-utils.js";

/** Input params shared by all collection endpoints */
export interface CollectionParams {
  start?: string;
  end?: string;
  limit?: number;
  nextToken?: string;
}

/** How long a successfully read UTC offset is reused (it only changes with travel/DST) */
const UTC_OFFSET_TTL_MS = 60 * 60 * 1000;

/** Regex for a date-time that already names its instant (trailing Z or offset) */
const ZONED_DATE_TIME_REGEX = /T[\d:.]+(Z|[+-]\d{2}:\d{2})$/;

/**
 * Whether resolving `value` depends on the user's calendar day — true for
 * relative expressions, date-only values and zone-less date-times.
 */
export function dependsOnLocalDay(value: string | undefined): boolean {
  return value !== undefined && !ZONED_DATE_TIME_REGEX.test(value.trim());
}

/** The user's UTC offset and whether it is a UTC fallback rather than a value read from WHOOP */
export interface UserUtcOffsetInfo {
  /** Offset used for calendar-day math, e.g. "+02:00" or "Z" */
  offset: string;
  /**
   * True when no offset could be read (lookup failed with nothing read before,
   * or the latest cycle has no valid offset) and UTC days are used instead.
   * False for an offset read from WHOOP, and for an account with no cycles yet.
   */
  fallback: boolean;
}

/** Last offset successfully read per client; reused for an hour and after a failed lookup */
const offsetMemo = new WeakMap<WhoopClient, { offset: string; expiresAt: number }>();

/** Whether a failed offset lookup is worth one immediate retry (transient network blip or 5xx) */
function isRetryableLookupError(error: unknown): boolean {
  if (error instanceof WhoopApiError) {
    return error.statusCode >= 500;
  }
  if (error instanceof WhoopNetworkError) {
    const cause = error.cause;
    // A timeout already waited 30s; don't double it
    return !(
      cause instanceof Error &&
      (cause.name === "TimeoutError" || cause.name === "AbortError")
    );
  }
  return false;
}

async function fetchLatestCycleOffset(client: WhoopClient): Promise<string | null | undefined> {
  // Same path and TTL as the cycle/latest resource, so sharing its cache entry
  // never makes either caller's data older than 2 minutes. The derived offset
  // is memoized separately (offsetMemo).
  const page = await client.get<CycleCollection>(`${ENDPOINT_CYCLE}?limit=1`, {
    cache: true,
    ttlMs: CYCLE_TTL_MS,
  });
  const records = page.records ?? [];
  if (records.length === 0) {
    return undefined;
  }
  const offset: unknown = records[0]?.timezone_offset;
  return typeof offset === "string" && offsetSchema.safeParse(offset).success ? offset : null;
}

/**
 * The user's current UTC offset, read from their most recent cycle so day
 * boundaries follow local midnight, travel and DST, plus whether UTC ("Z") is
 * only a fallback.
 *
 * A successfully read offset is reused for an hour. A failed lookup is never
 * cached: transient network errors and 5xx are retried once, then the last
 * offset read for this client is reused; only when none exists does it fall
 * back to UTC with `fallback: true`. Never throws.
 */
export async function resolveUserUtcOffsetInfo(client: WhoopClient): Promise<UserUtcOffsetInfo> {
  const memo = offsetMemo.get(client);
  if (memo !== undefined && Date.now() < memo.expiresAt) {
    return { offset: memo.offset, fallback: false };
  }

  let latest: string | null | undefined;
  try {
    try {
      latest = await fetchLatestCycleOffset(client);
    } catch (error: unknown) {
      if (!isRetryableLookupError(error)) {
        throw error;
      }
      latest = await fetchLatestCycleOffset(client);
    }
  } catch {
    return memo !== undefined
      ? { offset: memo.offset, fallback: false }
      : { offset: "Z", fallback: true };
  }

  if (typeof latest === "string") {
    offsetMemo.set(client, { offset: latest, expiresAt: Date.now() + UTC_OFFSET_TTL_MS });
    return { offset: latest, fallback: false };
  }
  if (memo !== undefined) {
    return { offset: memo.offset, fallback: false };
  }
  // No cycles yet: nothing to localise. A cycle without a valid offset: fallback.
  return { offset: "Z", fallback: latest === null };
}

/**
 * The user's current UTC offset (e.g. "+02:00"), read from their most recent
 * cycle. Falls back to UTC ("Z") when it cannot be determined; use
 * {@link resolveUserUtcOffsetInfo} to tell a fallback from a real UTC user.
 */
export async function resolveUserUtcOffset(client: WhoopClient): Promise<string> {
  return (await resolveUserUtcOffsetInfo(client)).offset;
}

/**
 * Build a query string from collection params.
 * Resolves date expressions and ISO 8601 dates in start/end to UTC timestamps,
 * taking calendar days in `utcOffset`. Omits undefined values. Returns empty
 * string if no params are set.
 *
 * @param params - Optional collection query parameters
 * @param utcOffset - The user's UTC offset for calendar-day math (default UTC)
 * @returns Query string (e.g. "?start=...&limit=5") or empty string
 * @throws InvalidDateExpression for unrecognized or invalid dates
 */
export function buildCollectionQuery(params: CollectionParams, utcOffset: string = "Z"): string {
  const searchParams = new URLSearchParams();
  const now = new Date();
  const start =
    params.start === undefined
      ? undefined
      : resolveDateExpression(params.start, now, utcOffset).start;
  const end =
    params.end === undefined ? undefined : resolveDateExpression(params.end, now, utcOffset).end;

  // WHOOP answers a reversed range with a bare 400; explain it instead
  if (start !== undefined && end !== undefined && Date.parse(end) < Date.parse(start)) {
    throw new InvalidDateExpression(
      `End (${params.end}) is before start (${params.start}). Swap them or widen the range.`
    );
  }
  if (start !== undefined) {
    searchParams.set("start", start);
  }
  if (end !== undefined) {
    searchParams.set("end", end);
  }
  if (params.limit !== undefined) {
    searchParams.set("limit", String(params.limit));
  }
  if (params.nextToken !== undefined) {
    searchParams.set("nextToken", params.nextToken);
  }

  const query = searchParams.toString();
  return query ? `?${query}` : "";
}

/**
 * Build a collection query, looking up the user's UTC offset only when a
 * start/end value depends on the calendar day.
 */
export async function buildLocalCollectionQuery(
  client: WhoopClient,
  params: CollectionParams
): Promise<string> {
  const utcOffset =
    dependsOnLocalDay(params.start) || dependsOnLocalDay(params.end)
      ? await resolveUserUtcOffset(client)
      : "Z";
  return buildCollectionQuery(params, utcOffset);
}

/** Note added when the user's time zone could not be read and UTC days were used */
export const UTC_OFFSET_FALLBACK_NOTE =
  "Your time zone could not be read from WHOOP, so days here are UTC calendar days and may be shifted by a few hours.";

/** `notes` plus the UTC fallback note when the offset lookup fell back to UTC */
export function withOffsetNote(notes: string[], fallback: boolean): string[] {
  return fallback ? [...notes, UTC_OFFSET_FALLBACK_NOTE] : notes;
}
