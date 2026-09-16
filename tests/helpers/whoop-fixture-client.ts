/**
 * An in-memory WHOOP API that serves fixture records the way the live API does.
 *
 * Live-verified behaviour it reproduces:
 * - Collections (/v2/cycle, /v2/recovery, /v2/activity/sleep, /v2/activity/workout)
 *   return records whose interval [start, end ?? now) overlaps the requested
 *   [start, end): `start` includes records still ongoing at it, and `end` is
 *   exclusive on the record start. A recovery uses its cycle's interval (a
 *   point at created_at when the cycle is not in the fixture).
 * - Records come newest first (by interval start, ties by id descending).
 * - `limit` defaults to 10; anything but an integer 1-25 is HTTP 400.
 * - `nextToken` is an opaque base64url token; `next_token` is an explicit null
 *   on the last page. A malformed token is HTTP 400.
 * - A bare date (YYYY-MM-DD) in start/end is HTTP 404 (as WHOOP answers it); any
 *   other value that is not an ISO date-time with a zone is HTTP 400.
 * - By id: /v2/cycle/{id}, /v2/cycle/{id}/sleep (the main sleep), /v2/cycle/{id}/recovery,
 *   /v2/activity/sleep/{id}, /v2/activity/workout/{id}; profile and body. Anything
 *   missing is WhoopApiError 404; a non-numeric cycle id is 400.
 *
 * Record arrays are read live on every request (a test may push or edit records
 * between calls), and every response is a deep clone, so tools can never mutate
 * the fixture. Caching options are recorded but ignored: every call is served
 * fresh.
 *
 * Like the real client, a request whose `deadlineMs` has passed is refused with
 * WhoopRateBudgetError before it is sent, and with a `rateLimiter` every request
 * first waits for a slot (refused the same way when its deadline passes while
 * waiting) and releases it once served. Refused requests are never recorded.
 */

import type { WhoopClient, WhoopGetOptions } from "../../src/api/client.js";
import { WhoopApiError, WhoopRateBudgetError } from "../../src/api/client.js";
import type { RateLimiter } from "../../src/api/rate-limiter.js";
import type {
  BodyMeasurement,
  Cycle,
  Recovery,
  Sleep,
  UserProfile,
  Workout,
} from "../../src/api/types.js";

/** Largest `limit` WHOOP accepts on a collection request. */
export const FIXTURE_MAX_PAGE_SIZE = 25;

/** Page size WHOOP uses when `limit` is omitted. */
export const FIXTURE_DEFAULT_PAGE_SIZE = 10;

/** An injected failure. */
export interface FixtureFailure {
  /** Matched against the requested path including its query string. */
  path: RegExp;
  /**
   * 1-based page of a collection request: 1 is the request without nextToken,
   * 2 the request with the first page's next_token, and so on. Omitted: every
   * page (and non-collection requests).
   */
  page?: number;
  /** How many matching requests fail. Omitted: all of them. */
  times?: number;
  /** Thrown for a matching request. A function is called per request to build the error. */
  error: unknown;
}

/** Options for {@link createWhoopFixtureClient}. */
export interface WhoopFixtureClientOptions {
  cycles?: readonly Cycle[];
  sleeps?: readonly Sleep[];
  recoveries?: readonly Recovery[];
  workouts?: readonly Workout[];
  /** Served at /v2/user/profile/basic; 404 when absent. */
  profile?: UserProfile;
  /** Served at /v2/user/measurement/body; 404 when absent. */
  body?: BodyMeasurement;
  failures?: readonly FixtureFailure[];
  /** After this many requests every further request is WhoopApiError 429 (reported to `rateLimiter`). */
  rateLimitAfter?: number;
  /**
   * Process-wide pacing, as the real client applies it: every request waits for
   * a slot (with its deadlineMs) and releases it once served.
   */
  rateLimiter?: RateLimiter;
  /** End of open cycles. Default: Date.now() at request time (follows fake timers). */
  now?: Date | string | number | (() => Date | number);
}

/** One request as the client received it. */
export interface FixtureRequest {
  path: string;
  options: WhoopGetOptions | undefined;
}

/** A WhoopClient serving fixtures, plus the requests it received. */
export type WhoopFixtureClient = WhoopClient & {
  /**
   * Every requested path (with query string), in order, including failed ones.
   * Requests refused by their deadline or the rate limiter were never sent and
   * are not listed.
   */
  calls: string[];
  /** Every request with its options, in order (the same requests as `calls`). */
  requests: FixtureRequest[];
};

type AnyRecord = Cycle | Sleep | Recovery | Workout;

interface Interval {
  startMs: number;
  endMs: number;
}

const COLLECTION_PATHS = new Set([
  "/v2/cycle",
  "/v2/recovery",
  "/v2/activity/sleep",
  "/v2/activity/workout",
]);

const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ZONED_DATE_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

function apiError(status: number): WhoopApiError {
  const statusText =
    status === 400
      ? "Bad Request"
      : status === 404
        ? "Not Found"
        : status === 429
          ? "Too Many Requests"
          : "Error";
  return new WhoopApiError(status, statusText, { message: statusText });
}

/** The opaque page token for the record at `offset`, requested as page `page` (1-based). */
export function encodeFixturePageToken(offset: number, page: number): string {
  return Buffer.from(JSON.stringify({ o: offset, p: page }), "utf8").toString("base64url");
}

/** Decode a page token; undefined when it is malformed. */
export function decodeFixturePageToken(
  token: string
): { offset: number; page: number } | undefined {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    if (typeof decoded !== "object" || decoded === null) return undefined;
    const { o, p } = decoded as { o?: unknown; p?: unknown };
    if (!Number.isInteger(o) || !Number.isInteger(p)) return undefined;
    if ((o as number) < 1 || (p as number) < 2) return undefined;
    return { offset: o as number, page: p as number };
  } catch {
    return undefined;
  }
}

function nowMsOf(now: WhoopFixtureClientOptions["now"]): number {
  const value = typeof now === "function" ? now() : now;
  if (value === undefined) return Date.now();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return Date.parse(value);
}

/** An instant query parameter: null when absent; throws the WHOOP status for bad values. */
function parseInstantParam(value: string | null): number | null {
  if (value === null) return null;
  if (BARE_DATE.test(value)) throw apiError(404);
  const ms = Date.parse(value);
  if (!ZONED_DATE_TIME.test(value) || !Number.isFinite(ms)) throw apiError(400);
  return ms;
}

function compareIds(left: string | number, right: string | number): number {
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0;
}

/** Create a WHOOP client that serves `options` like the live API. */
export function createWhoopFixtureClient(
  options: WhoopFixtureClientOptions = {}
): WhoopFixtureClient {
  const calls: string[] = [];
  const requests: FixtureRequest[] = [];
  const failures = (options.failures ?? []).map((failure) => ({
    failure,
    remaining: failure.times ?? Number.POSITIVE_INFINITY,
  }));

  const cycles = (): readonly Cycle[] => options.cycles ?? [];
  const sleeps = (): readonly Sleep[] => options.sleeps ?? [];
  const recoveries = (): readonly Recovery[] => options.recoveries ?? [];
  const workouts = (): readonly Workout[] => options.workouts ?? [];

  function intervalOf(base: string, record: AnyRecord, nowMs: number): Interval {
    if (base === "/v2/recovery") {
      const recovery = record as Recovery;
      const cycle = cycles().find((candidate) => candidate.id === recovery.cycle_id);
      if (cycle) return intervalOf("/v2/cycle", cycle, nowMs);
      const created = Date.parse(recovery.created_at);
      return { startMs: created, endMs: created };
    }
    const activity = record as Cycle | Sleep | Workout;
    const startMs = Date.parse(activity.start);
    const endMs =
      activity.end === null || activity.end === undefined ? nowMs : Date.parse(activity.end);
    return { startMs, endMs };
  }

  function idOf(base: string, record: AnyRecord): string | number {
    return base === "/v2/recovery" ? (record as Recovery).cycle_id : (record as Cycle).id;
  }

  function listFor(base: string): readonly AnyRecord[] {
    if (base === "/v2/cycle") return cycles();
    if (base === "/v2/recovery") return recoveries();
    if (base === "/v2/activity/sleep") return sleeps();
    return workouts();
  }

  function collection(base: string, params: URLSearchParams, nowMs: number): unknown {
    const limitParam = params.get("limit");
    let limit = FIXTURE_DEFAULT_PAGE_SIZE;
    if (limitParam !== null) {
      if (!/^\d+$/.test(limitParam)) throw apiError(400);
      limit = Number(limitParam);
      if (limit < 1 || limit > FIXTURE_MAX_PAGE_SIZE) throw apiError(400);
    }
    const startMs = parseInstantParam(params.get("start"));
    const endMs = parseInstantParam(params.get("end"));
    if (startMs !== null && endMs !== null && endMs < startMs) throw apiError(400);
    const tokenParam = params.get("nextToken");
    let offset = 0;
    let page = 1;
    if (tokenParam !== null) {
      const token = decodeFixturePageToken(tokenParam);
      if (!token) throw apiError(400);
      offset = token.offset;
      page = token.page;
    }

    const matching = listFor(base)
      .map((record) => ({ record, interval: intervalOf(base, record, nowMs) }))
      .filter(({ interval }) => {
        const recordEnd = Math.max(interval.startMs, interval.endMs);
        if (endMs !== null && !(interval.startMs < endMs)) return false;
        if (startMs === null) return true;
        // A zero-length record is a point: it is inside when it lies at or after start.
        return recordEnd === interval.startMs ? interval.startMs >= startMs : recordEnd > startMs;
      })
      .sort(
        (left, right) =>
          right.interval.startMs - left.interval.startMs ||
          compareIds(idOf(base, right.record), idOf(base, left.record))
      );

    const records = matching.slice(offset, offset + limit).map(({ record }) => record);
    const nextOffset = offset + limit;
    return {
      records,
      next_token:
        nextOffset < matching.length ? encodeFixturePageToken(nextOffset, page + 1) : null,
    };
  }

  function byPath(base: string, nowMs: number, params: URLSearchParams): unknown {
    if (COLLECTION_PATHS.has(base)) return collection(base, params, nowMs);
    if (base === "/v2/user/profile/basic") {
      if (!options.profile) throw apiError(404);
      return options.profile;
    }
    if (base === "/v2/user/measurement/body") {
      if (!options.body) throw apiError(404);
      return options.body;
    }

    const cycleMatch = /^\/v2\/cycle\/([^/]+)(?:\/(sleep|recovery))?$/.exec(base);
    if (cycleMatch) {
      const rawId = decodeURIComponent(cycleMatch[1]!);
      if (!/^\d+$/.test(rawId)) throw apiError(400);
      const cycleId = Number(rawId);
      const cycle = cycles().find((candidate) => candidate.id === cycleId);
      if (!cycle) throw apiError(404);
      if (cycleMatch[2] === undefined) return cycle;
      if (cycleMatch[2] === "sleep") {
        const sleep = sleeps()
          .filter((candidate) => candidate.cycle_id === cycleId && !candidate.nap)
          .sort(
            (left, right) =>
              Date.parse(right.start) - Date.parse(left.start) || compareIds(right.id, left.id)
          )[0];
        if (!sleep) throw apiError(404);
        return sleep;
      }
      const recovery = recoveries()
        .filter((candidate) => candidate.cycle_id === cycleId)
        .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at))[0];
      if (!recovery) throw apiError(404);
      return recovery;
    }

    const activityMatch = /^\/v2\/activity\/(sleep|workout)\/([^/]+)$/.exec(base);
    if (activityMatch) {
      const id = decodeURIComponent(activityMatch[2]!);
      const list: readonly (Sleep | Workout)[] =
        activityMatch[1] === "sleep" ? sleeps() : workouts();
      const record = list.find((candidate) => candidate.id === id);
      if (!record) throw apiError(404);
      return record;
    }

    throw apiError(404);
  }

  function serve<T>(path: string, getOptions: WhoopGetOptions | undefined): T {
    calls.push(path);
    requests.push({ path, options: getOptions === undefined ? undefined : { ...getOptions } });
    if (options.rateLimitAfter !== undefined && calls.length > options.rateLimitAfter) {
      options.rateLimiter?.note429(null);
      throw apiError(429);
    }

    const queryIndex = path.indexOf("?");
    const base = queryIndex === -1 ? path : path.slice(0, queryIndex);
    const params = new URLSearchParams(queryIndex === -1 ? "" : path.slice(queryIndex + 1));
    const token = params.get("nextToken");
    const page = token === null ? 1 : decodeFixturePageToken(token)?.page;

    for (const entry of failures) {
      const { failure } = entry;
      failure.path.lastIndex = 0;
      if (entry.remaining <= 0 || !failure.path.test(path)) continue;
      if (failure.page !== undefined && failure.page !== page) continue;
      entry.remaining -= 1;
      throw typeof failure.error === "function"
        ? (failure.error as () => unknown)()
        : failure.error;
    }

    return structuredClone(byPath(base, nowMsOf(options.now), params)) as T;
  }

  const client: WhoopFixtureClient = {
    calls,
    requests,
    async get<T>(path: string, getOptions?: WhoopGetOptions): Promise<T> {
      const deadlineMs = getOptions?.deadlineMs;
      if (deadlineMs !== undefined && Date.now() >= deadlineMs) {
        throw new WhoopRateBudgetError();
      }
      // Without a limiter the request is served synchronously (no await before it).
      const release =
        options.rateLimiter === undefined
          ? undefined
          : await options.rateLimiter.acquire(deadlineMs);
      try {
        return serve<T>(path, getOptions);
      } finally {
        release?.();
      }
    },
  };
  return client;
}
