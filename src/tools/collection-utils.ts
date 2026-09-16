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
import type { CycleCollection } from "../api/types.js";
import { ENDPOINT_CYCLE } from "../api/endpoints.js";
import { offsetSchema } from "../api/record-schemas.js";
import { InvalidDateExpression, resolveDateExpression } from "./date-utils.js";

/** Input params shared by all collection endpoints */
export interface CollectionParams {
  start?: string;
  end?: string;
  limit?: number;
  nextToken?: string;
}

/** How long the user's UTC offset is cached (it only changes with travel/DST) */
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

/**
 * The user's current UTC offset (e.g. "+02:00"), read from their most recent
 * cycle so day boundaries follow local midnight, travel and DST. Falls back
 * to UTC ("Z") when no cycle is available.
 */
export async function resolveUserUtcOffset(client: WhoopClient): Promise<string> {
  try {
    const page = await client.get<CycleCollection>(`${ENDPOINT_CYCLE}?limit=1`, {
      cache: true,
      ttlMs: UTC_OFFSET_TTL_MS,
    });
    const offset = page.records?.[0]?.timezone_offset;
    return offset !== undefined && offsetSchema.safeParse(offset).success ? offset : "Z";
  } catch {
    return "Z";
  }
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
