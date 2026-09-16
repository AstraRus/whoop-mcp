/**
 * Process-wide pacing of WHOOP API requests.
 *
 * WHOOP limits an app to 100 requests per minute and 10,000 per day. Several
 * MCP tool calls can run at once and long-window tools read many pages, so
 * every request the WHOOP client sends first takes a slot here:
 *
 * - a token bucket (capacity `burst`, refilled at `perMinute` per minute)
 *   paces requests, with waiters served first in, first out;
 * - at most `maxConcurrent` requests are in flight at a time;
 * - a 429 response pauses every request for its Retry-After (2 s without one),
 *   capped at 60 s;
 * - when WHOOP reports X-RateLimit-Remaining <= 2 together with
 *   X-RateLimit-Reset, the bucket is drained and requests wait for the reset
 *   (capped at 60 s);
 * - a waiter whose deadline passes is rejected with
 *   {@link WhoopRateBudgetError} and its request is never sent.
 *
 * Logs never include URLs, ids or tokens.
 */

import type { Logger } from "../logging/logger.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default requests per minute (WHOOP allows 100). */
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 60;

/** Lowest accepted WHOOP_RATE_LIMIT_PER_MINUTE. */
export const MIN_RATE_LIMIT_PER_MINUTE = 10;

/** Highest accepted WHOOP_RATE_LIMIT_PER_MINUTE (headroom below WHOOP's 100). */
export const MAX_RATE_LIMIT_PER_MINUTE = 95;

/** Default bucket capacity: requests that may be sent back to back. */
export const DEFAULT_RATE_LIMIT_BURST = 20;

/** Default maximum WHOOP requests in flight at once. */
export const DEFAULT_MAX_CONCURRENT_REQUESTS = 4;

/** Pause after a 429 without a usable Retry-After header. */
export const DEFAULT_RATE_LIMITED_PAUSE_MS = 2_000;

/** Upper bound for any pause (429 Retry-After or X-RateLimit-Reset). */
export const MAX_RATE_LIMIT_PAUSE_MS = 60_000;

/** X-RateLimit-Remaining at or below this drains the bucket until the reset. */
export const LOW_REMAINING_REQUESTS = 2;

/** The "paused" warning is logged at most once per this interval. */
const PAUSE_LOG_INTERVAL_MS = 60_000;

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** Tolerance for floating-point token arithmetic. */
const TOKEN_EPSILON = 1e-9;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * A WHOOP request was not sent because the caller's deadline or request
 * budget ran out while it waited for the rate limiter.
 */
export class WhoopRateBudgetError extends Error {
  public override readonly name = "WhoopRateBudgetError";

  constructor(options?: { cause?: unknown }) {
    super(
      "WHOOP request not sent: the request budget or deadline for this call was reached.",
      options
    );
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Releases a slot taken with {@link RateLimiter.acquire}; calling it again does nothing. */
export type RateLimitRelease = () => void;

/** Request counters, as reported by runtime status. */
export interface RateLimiterStats {
  /** Requests granted in the last 60 seconds. */
  requests_last_minute: number;
  /** Requests granted since 00:00 UTC. */
  requests_today_utc: number;
  /** Requests that had to wait for a token or a pause. */
  throttled_waits_total: number;
  /** 429 responses reported via {@link RateLimiter.note429}. */
  rate_limited_responses_total: number;
  /** ISO time of the latest 429, or null. */
  last_rate_limited_at: string | null;
}

/** Process-wide WHOOP request pacing. */
export interface RateLimiter {
  /**
   * Wait for a request slot. Resolves with the function that releases it
   * (call it once the response headers arrived).
   *
   * @param deadlineMs - Epoch ms; when it passes before a slot is granted, the
   *   promise rejects with {@link WhoopRateBudgetError}.
   */
  acquire(deadlineMs?: number): Promise<RateLimitRelease>;
  /** A 429 arrived: pause every request for `retryAfterMs` (2 s when null), capped at 60 s. */
  note429(retryAfterMs: number | null): void;
  /** WHOOP's X-RateLimit-Remaining / X-RateLimit-Reset (seconds) of a response, when present. */
  noteHeaders(remaining: number | null, resetSeconds: number | null): void;
  stats(): RateLimiterStats;
}

/** Timer functions, injectable for tests. */
export interface RateLimiterTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Options for {@link createRateLimiter}. */
export interface RateLimiterOptions {
  perMinute: number;
  /** Bucket capacity. Default {@link DEFAULT_RATE_LIMIT_BURST}. */
  burst?: number;
  /** Maximum requests in flight. Default {@link DEFAULT_MAX_CONCURRENT_REQUESTS}. */
  maxConcurrent?: number;
  /** Clock in epoch ms. Default Date.now (read at call time). */
  now?: () => number;
  timers?: RateLimiterTimers;
  logger?: Logger;
}

interface Waiter {
  resolve: (release: RateLimitRelease) => void;
  reject: (error: Error) => void;
  deadlineMs: number | undefined;
  deadlineTimer: unknown;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a WHOOP request limiter.
 *
 * @throws RangeError when an option is not a positive finite number
 */
export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const perMinute = options.perMinute;
  const burst = options.burst ?? DEFAULT_RATE_LIMIT_BURST;
  const maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_REQUESTS;
  for (const [name, value] of [
    ["perMinute", perMinute],
    ["burst", burst],
    ["maxConcurrent", maxConcurrent],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`Rate limiter ${name} must be a positive number.`);
    }
  }
  const now = options.now ?? ((): number => Date.now());
  const timers: RateLimiterTimers = options.timers ?? {
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const logger = options.logger;
  const tokensPerMs = perMinute / MINUTE_MS;

  let tokens = burst;
  let lastRefillAt = now();
  /** No request is granted before this epoch ms (429 pause or header drain). */
  let pausedUntil = 0;
  let inFlight = 0;
  const queue: Waiter[] = [];

  let wakeTimer: unknown;
  let wakeAt = Number.POSITIVE_INFINITY;

  /** Grant times within the last minute, oldest first. */
  const recentGrants: number[] = [];
  let grantsDay = Math.floor(now() / DAY_MS);
  let grantsToday = 0;
  let throttledWaits = 0;
  let rateLimitedResponses = 0;
  let lastRateLimitedAt: number | null = null;
  let lastPauseLogAt = Number.NEGATIVE_INFINITY;

  function refill(at: number): void {
    if (at > lastRefillAt) {
      tokens = Math.min(burst, tokens + (at - lastRefillAt) * tokensPerMs);
      lastRefillAt = at;
    }
  }

  function pruneGrants(at: number): void {
    while (recentGrants.length > 0 && recentGrants[0]! <= at - MINUTE_MS) {
      recentGrants.shift();
    }
  }

  function recordGrant(at: number): void {
    pruneGrants(at);
    recentGrants.push(at);
    const day = Math.floor(at / DAY_MS);
    if (day !== grantsDay) {
      grantsDay = day;
      grantsToday = 0;
    }
    grantsToday += 1;
  }

  /** Milliseconds until the head of the queue could get a token, ignoring concurrency. */
  function rateWaitMs(at: number): number {
    const pauseWait = Math.max(0, pausedUntil - at);
    const tokenWait =
      tokens >= 1 - TOKEN_EPSILON ? 0 : Math.ceil((1 - tokens) / tokensPerMs - TOKEN_EPSILON);
    return Math.max(pauseWait, tokenWait);
  }

  function logPause(at: number, waitMs: number): void {
    if (logger === undefined || at - lastPauseLogAt < PAUSE_LOG_INTERVAL_MS) return;
    lastPauseLogAt = at;
    logger.warn("whoop rate limiter paused", { waitMs, queued: queue.length });
  }

  function scheduleWake(at: number): void {
    if (wakeTimer !== undefined && wakeAt <= at) return;
    if (wakeTimer !== undefined) timers.clearTimeout(wakeTimer);
    wakeAt = at;
    wakeTimer = timers.setTimeout(
      () => {
        wakeTimer = undefined;
        wakeAt = Number.POSITIVE_INFINITY;
        pump();
      },
      Math.max(0, at - now())
    );
  }

  function makeRelease(): RateLimitRelease {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      inFlight -= 1;
      pump();
    };
  }

  function grant(waiter: Waiter, at: number): void {
    tokens = Math.max(0, tokens - 1);
    inFlight += 1;
    recordGrant(at);
    if (waiter.deadlineTimer !== undefined) timers.clearTimeout(waiter.deadlineTimer);
    waiter.resolve(makeRelease());
  }

  function pump(): void {
    const at = now();
    refill(at);
    while (queue.length > 0 && inFlight < maxConcurrent) {
      const head = queue[0]!;
      if (head.deadlineMs !== undefined && at >= head.deadlineMs) {
        queue.shift();
        rejectWaiter(head);
        continue;
      }
      const waitMs = rateWaitMs(at);
      if (waitMs > 0) {
        scheduleWake(at + waitMs);
        return;
      }
      queue.shift();
      grant(head, at);
    }
  }

  function rejectWaiter(waiter: Waiter): void {
    if (waiter.deadlineTimer !== undefined) timers.clearTimeout(waiter.deadlineTimer);
    waiter.reject(new WhoopRateBudgetError());
  }

  function expire(waiter: Waiter): void {
    const index = queue.indexOf(waiter);
    if (index === -1) return;
    queue.splice(index, 1);
    waiter.deadlineTimer = undefined;
    rejectWaiter(waiter);
    pump();
  }

  return {
    acquire(deadlineMs?: number): Promise<RateLimitRelease> {
      return new Promise<RateLimitRelease>((resolve, reject) => {
        const at = now();
        if (deadlineMs !== undefined && at >= deadlineMs) {
          reject(new WhoopRateBudgetError());
          return;
        }
        const waiter: Waiter = { resolve, reject, deadlineMs, deadlineTimer: undefined };
        queue.push(waiter);
        pump();
        if (!queue.includes(waiter)) return;
        const waitMs = rateWaitMs(at);
        if (waitMs > 0) {
          throttledWaits += 1;
          logPause(at, waitMs);
        }
        if (deadlineMs !== undefined) {
          waiter.deadlineTimer = timers.setTimeout(() => expire(waiter), deadlineMs - at);
        }
      });
    },

    note429(retryAfterMs: number | null): void {
      const at = now();
      rateLimitedResponses += 1;
      lastRateLimitedAt = at;
      const pauseMs = Math.min(
        Math.max(0, retryAfterMs ?? DEFAULT_RATE_LIMITED_PAUSE_MS),
        MAX_RATE_LIMIT_PAUSE_MS
      );
      if (pauseMs <= 0) return;
      pausedUntil = Math.max(pausedUntil, at + pauseMs);
      logPause(at, pausedUntil - at);
      if (queue.length > 0) scheduleWake(pausedUntil);
    },

    noteHeaders(remaining: number | null, resetSeconds: number | null): void {
      if (
        remaining === null ||
        resetSeconds === null ||
        !Number.isFinite(remaining) ||
        !Number.isFinite(resetSeconds) ||
        remaining > LOW_REMAINING_REQUESTS ||
        resetSeconds <= 0
      ) {
        return;
      }
      const at = now();
      refill(at);
      tokens = 0;
      pausedUntil = Math.max(
        pausedUntil,
        at + Math.min(resetSeconds * 1000, MAX_RATE_LIMIT_PAUSE_MS)
      );
      if (queue.length > 0) scheduleWake(pausedUntil);
    },

    stats(): RateLimiterStats {
      const at = now();
      pruneGrants(at);
      return {
        requests_last_minute: recentGrants.length,
        requests_today_utc: Math.floor(at / DAY_MS) === grantsDay ? grantsToday : 0,
        throttled_waits_total: throttledWaits,
        rate_limited_responses_total: rateLimitedResponses,
        last_rate_limited_at:
          lastRateLimitedAt === null ? null : new Date(lastRateLimitedAt).toISOString(),
      };
    },
  };
}
