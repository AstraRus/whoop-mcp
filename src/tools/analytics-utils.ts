import { z } from "zod";
import { offsetSchema } from "../api/record-schemas.js";
import type { Sleep } from "../api/types.js";
import type { WhoopClient } from "../api/client.js";
import {
  WhoopApiError,
  WhoopAuthError,
  WhoopNetworkError,
  WhoopRateBudgetError,
} from "../api/client.js";
import { fetchAllPages, ABSOLUTE_MAX_RECORDS } from "../api/pagination.js";
import { parseUtcOffset } from "./date-utils.js";

export const DISCLAIMER = "Statistical observation from your data, not medical advice.";
export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
export const periodSchema = z.object({ start: z.string(), end: z.string() });
export const sourceQualitySchema = z.object({
  status: z.enum([
    "available",
    "pending",
    "missing",
    "stale",
    "unscored",
    "calibrating",
    "invalid",
    "fetch_failed",
  ]),
  fetched_at: z.string().nullable(),
  source_updated_at: z.string().nullable(),
  cache_status: z.enum(["hit", "miss", "unknown"]),
  records_fetched: z.number().int().nonnegative(),
  records_used: z.number().int().nonnegative(),
  exclusions: z.record(z.string(), z.number().int().nonnegative()),
  truncated: z.boolean(),
});
export const dataQualitySchema = z.object({
  evaluated_at: z.string(),
  requested_period: periodSchema,
  observed_period: periodSchema.nullable(),
  sources: z.record(z.string(), sourceQualitySchema),
  method_version: z.string(),
  limitations: z.array(z.string()),
});
export type SourceQuality = z.infer<typeof sourceQualitySchema>;
export type DataQuality = z.infer<typeof dataQualitySchema>;

export function sourceQuality(count = 0, truncated = false): SourceQuality {
  return {
    status: "missing",
    fetched_at: null,
    source_updated_at: null,
    cache_status: "unknown",
    records_fetched: count,
    records_used: 0,
    exclusions: {},
    truncated,
  };
}

export function exclude(quality: SourceQuality, reason: string): void {
  quality.exclusions[reason] = (quality.exclusions[reason] ?? 0) + 1;
}

export function localTime(timestamp: string, offset: string): Date {
  offsetSchema.parse(offset);
  return new Date(Date.parse(timestamp) + parseUtcOffset(offset) * 60_000);
}

export function localDay(timestamp: string, offset: string): string {
  return localTime(timestamp, offset).toISOString().slice(0, 10);
}

/**
 * An instant written as ISO 8601 wall-clock time in `offset` (e.g.
 * "2026-09-15T00:00:00.000+02:00"; "Z" stays UTC), so its first 10
 * characters are the local date there.
 *
 * @throws InvalidDateExpression for a malformed offset
 */
export function formatLocalTimestamp(ms: number, offset: string): string {
  const wallClock = new Date(ms + parseUtcOffset(offset) * 60_000).toISOString().slice(0, 23);
  return `${wallClock}${offset === "Z" ? "Z" : offset}`;
}

/** The UTC instant of local midnight starting `day` (YYYY-MM-DD) in `offset`. */
export function localMidnightMs(day: string, offset: string): number {
  return Date.parse(`${day}T00:00:00.000Z`) - parseUtcOffset(offset) * 60_000;
}

/**
 * The local calendar day a WHOOP cycle belongs to. A cycle starts at sleep
 * onset — usually the evening before the day it covers — so the day is taken
 * 12 hours after the start: bedtime at 23:00 counts toward the next day, at
 * 01:00 toward the same day.
 */
export function cycleDay(cycle: { start: string; timezone_offset: string }): string {
  const midCycle = new Date(Date.parse(cycle.start) + 12 * HOUR_MS).toISOString();
  return localDay(midCycle, cycle.timezone_offset);
}

/** WHOOP's recovery colour bands */
export type RecoveryZone = "green" | "yellow" | "red";

/** Lowest recovery score in the green band */
export const RECOVERY_GREEN_MIN = 67;

/** Lowest recovery score in the yellow band */
export const RECOVERY_YELLOW_MIN = 34;

/** WHOOP's recovery zone for a score: green 67-100, yellow 34-66, red 0-33 */
export function recoveryZone(score: number): RecoveryZone {
  if (score >= RECOVERY_GREEN_MIN) return "green";
  if (score >= RECOVERY_YELLOW_MIN) return "yellow";
  return "red";
}

export function asleepHours(sleep: Sleep): number {
  const stages = sleep.score!.stage_summary;
  return (
    (stages.total_light_sleep_time_milli +
      stages.total_slow_wave_sleep_time_milli +
      stages.total_rem_sleep_time_milli) /
    HOUR_MS
  );
}

export function observedPeriod(timestamps: string[]): { start: string; end: string } | null {
  const sorted = timestamps
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(left) - Date.parse(right));
  return sorted.length ? { start: sorted[0]!, end: sorted[sorted.length - 1]! } : null;
}

export function parseRecords<T>(
  records: unknown[],
  schema: z.ZodType<T>,
  quality: SourceQuality
): T[] {
  const parsed: T[] = [];
  for (const record of records) {
    const result = schema.safeParse(record);
    if (result.success) parsed.push(result.data);
    else exclude(quality, "invalid");
  }
  if (!parsed.length && records.length) quality.status = "invalid";
  return parsed;
}

/** Lower rank = more actionable for the user */
function errorRank(error: unknown): number {
  if (error instanceof WhoopAuthError) return 0;
  if (error instanceof WhoopApiError) {
    if (error.statusCode === 401 || error.statusCode === 403) return 1;
    if (error.statusCode === 429) return 2;
    return 3;
  }
  // The server's own rate limiter (or the call's deadline) held the request back:
  // as actionable as a 429 from WHOOP, and never a network problem.
  if (error instanceof WhoopRateBudgetError) return 2;
  if (error instanceof WhoopNetworkError) {
    return error.cause instanceof WhoopRateBudgetError ? 2 : 4;
  }
  return 5;
}

/**
 * Pick the most relevant of several upstream failures (auth, then rate limit
 * including the server's own request budget, then other API errors, then
 * network) so the server can explain it accurately.
 */
export function mostRelevantError(reasons: unknown[]): Error {
  const reason = [...reasons].sort((left, right) => errorRank(left) - errorRank(right))[0];
  return reason instanceof Error
    ? reason
    : new Error("All WHOOP requests failed.", { cause: reason });
}

/** A loaded analytics source. */
export interface AnalyticsSource<T> {
  records: T[];
  quality: SourceQuality;
  /** The first page failed (status "fetch_failed"): the original error. */
  error?: unknown;
  /**
   * A later page failed or was malformed: the records already read are kept,
   * `quality.truncated` is true, and this holds the original error.
   */
  partialError?: unknown;
}

/**
 * Fetch and validate every page of an analytics source. A failure on the
 * first page is reported as status "fetch_failed" with the original `error`
 * (or "invalid" for a malformed page), so callers that cannot continue can
 * rethrow it and the user sees the real cause (authorization, rate limit,
 * network) instead of a generic message. A failure on a later page keeps the
 * records already read, marks the source truncated and sets `partialError`.
 */
export async function loadAnalyticsSource<T>(
  client: WhoopClient,
  endpoint: string,
  period: { start: string; end: string },
  schema: z.ZodType<T>
): Promise<AnalyticsSource<T>> {
  const query = new URLSearchParams({ ...period, limit: "25" });
  const pageSchema = z.object({
    records: z.array(z.unknown()),
    next_token: z.string().max(4096).nullish(),
  });
  let pagesRead = 0;
  let partialError: unknown;
  const validatedClient: WhoopClient = {
    get: async <Result>(path: string): Promise<Result> => {
      try {
        const page = pageSchema.parse(await client.get<unknown>(path));
        pagesRead += 1;
        return page as Result;
      } catch (error: unknown) {
        if (pagesRead === 0) throw error;
        // A later page failed: end pagination here and keep what was read.
        partialError = error;
        return { records: [], next_token: null } as Result;
      }
    },
  };
  try {
    const result = await fetchAllPages<unknown>(validatedClient, `${endpoint}?${query}`, {
      maxRecords: ABSOLUTE_MAX_RECORDS,
    });
    const partial = partialError !== undefined;
    const quality = sourceQuality(result.records.length, result.truncated || partial);
    const records = parseRecords(result.records, schema, quality);
    return partial ? { records, quality, partialError } : { records, quality };
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      return { records: [], quality: { ...sourceQuality(), status: "invalid" } };
    }
    return { records: [], quality: { ...sourceQuality(), status: "fetch_failed" }, error };
  }
}

export function mainSleeps(
  records: Sleep[],
  period: { start: string; end: string },
  quality: SourceQuality
): Sleep[] {
  const selected = new Map<string, Sleep>();
  for (const record of records) {
    const duration = Date.parse(record.end) - Date.parse(record.start);
    if (
      duration <= 0 ||
      Date.parse(record.end) < Date.parse(period.start) ||
      Date.parse(record.end) >= Date.parse(period.end)
    ) {
      exclude(quality, "outside_window_or_invalid_duration");
      continue;
    }
    if (record.nap) {
      exclude(quality, "nap");
      continue;
    }
    if (record.score_state !== "SCORED" || !record.score) {
      exclude(quality, record.score_state === "PENDING_SCORE" ? "pending" : "unscored");
      continue;
    }
    const key = localDay(record.end, record.timezone_offset);
    const previous = selected.get(key);
    if (previous) {
      exclude(quality, "duplicate_day");
      const previousDuration = Date.parse(previous.end) - Date.parse(previous.start);
      if (
        duration < previousDuration ||
        (duration === previousDuration &&
          (Date.parse(record.end) < Date.parse(previous.end) ||
            (record.end === previous.end && record.id >= previous.id)))
      )
        continue;
    }
    selected.set(key, record);
  }
  return [...selected.values()].sort((left, right) => Date.parse(right.end) - Date.parse(left.end));
}

export function finishQuality(quality: SourceQuality, records: { updated_at: string }[]): void {
  quality.records_used = records.length;
  quality.source_updated_at =
    observedPeriod(records.map((record) => record.updated_at))?.end ?? null;
  if (records.length) quality.status = "available";
  else if (quality.status !== "fetch_failed" && quality.status !== "invalid") {
    quality.status = quality.exclusions.pending
      ? "pending"
      : quality.exclusions.calibrating
        ? "calibrating"
        : quality.exclusions.unscored
          ? "unscored"
          : "missing";
  }
}
