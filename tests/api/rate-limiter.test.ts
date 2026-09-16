import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createRateLimiter,
  WhoopRateBudgetError,
  type RateLimitRelease,
} from "../../src/api/rate-limiter.js";
import { createWhoopClient, describeWhoopError } from "../../src/api/client.js";
import type { Logger } from "../../src/logging/logger.js";

const T0 = Date.parse("2026-09-16T10:00:00.000Z");

function silentLogger(): Logger & { warn: ReturnType<typeof vi.fn> } {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("createRateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("grants the burst immediately, then one request per second at 60/min", async () => {
    const limiter = createRateLimiter({ perMinute: 60 });
    const grantedAt: number[] = [];
    const all = Array.from({ length: 25 }, () =>
      limiter.acquire().then((release) => {
        grantedAt.push(Date.now() - T0);
        release();
      })
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(grantedAt).toHaveLength(20);
    expect(grantedAt.every((at) => at === 0)).toBe(true);

    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.all(all);
    expect(grantedAt.slice(20)).toEqual([1_000, 2_000, 3_000, 4_000, 5_000]);
  });

  it("keeps at most maxConcurrent requests in flight", async () => {
    const limiter = createRateLimiter({ perMinute: 60, maxConcurrent: 4 });
    const releases: RateLimitRelease[] = [];
    const pending = Array.from({ length: 6 }, () =>
      limiter.acquire().then((release) => releases.push(release))
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(releases).toHaveLength(4);

    releases[0]!();
    releases[0]!(); // a second call of the same release is a no-op
    await vi.advanceTimersByTimeAsync(0);
    expect(releases).toHaveLength(5);

    releases[1]!();
    await Promise.all(pending);
    expect(releases).toHaveLength(6);
  });

  it("serves waiters first in, first out", async () => {
    const limiter = createRateLimiter({ perMinute: 60, burst: 1 });
    const order: number[] = [];
    const pending = [0, 1, 2].map((index) =>
      limiter.acquire().then((release) => {
        order.push(index);
        release();
      })
    );
    await vi.advanceTimersByTimeAsync(3_000);
    await Promise.all(pending);
    expect(order).toEqual([0, 1, 2]);
  });

  it("rejects a waiter whose deadline passes with WhoopRateBudgetError, without granting it", async () => {
    const limiter = createRateLimiter({ perMinute: 60, burst: 1 });
    const first = await limiter.acquire();
    first();

    const late = limiter.acquire(T0 + 500);
    const outcome = late.then(
      () => "granted",
      (error: unknown) => error
    );
    await vi.advanceTimersByTimeAsync(600);
    const error = await outcome;
    expect(error).toBeInstanceOf(WhoopRateBudgetError);
    expect(limiter.stats().requests_last_minute).toBe(1);

    // The next waiter is still served once a token is available
    const next = limiter.acquire();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(next).resolves.toBeTypeOf("function");
  });

  it("rejects immediately when the deadline has already passed", async () => {
    const limiter = createRateLimiter({ perMinute: 60 });
    await expect(limiter.acquire(T0 - 1)).rejects.toBeInstanceOf(WhoopRateBudgetError);
    expect(limiter.stats().requests_last_minute).toBe(0);
  });

  it("pauses every request for Retry-After after a 429", async () => {
    const limiter = createRateLimiter({ perMinute: 60 });
    limiter.note429(3_000);
    const grantedAt: number[] = [];
    const pending = [0, 1].map(() =>
      limiter.acquire().then((release) => {
        grantedAt.push(Date.now() - T0);
        release();
      })
    );

    await vi.advanceTimersByTimeAsync(2_999);
    expect(grantedAt).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all(pending);
    expect(grantedAt).toEqual([3_000, 3_000]);
  });

  it("pauses 2 s after a 429 without Retry-After and caps long pauses at 60 s", async () => {
    const limiter = createRateLimiter({ perMinute: 60 });
    limiter.note429(null);
    const short = limiter.acquire();
    await vi.advanceTimersByTimeAsync(1_999);
    let granted = false;
    void short.then(() => (granted = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(granted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    (await short)();

    limiter.note429(10 * 60_000);
    const capped = limiter.acquire();
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(capped).resolves.toBeTypeOf("function");
  });

  it("drains the bucket until X-RateLimit-Reset when few requests remain", async () => {
    const limiter = createRateLimiter({ perMinute: 60 });
    limiter.noteHeaders(50, 30); // plenty remaining: no effect
    (await limiter.acquire())();

    limiter.noteHeaders(2, 5);
    const pending = limiter.acquire();
    let grantedAt: number | undefined;
    void pending.then(() => (grantedAt = Date.now() - T0));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(grantedAt).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(grantedAt).toBe(5_000);
  });

  it("ignores rate-limit headers that are missing", async () => {
    const limiter = createRateLimiter({ perMinute: 60 });
    limiter.noteHeaders(1, null);
    limiter.noteHeaders(null, 30);
    await expect(limiter.acquire()).resolves.toBeTypeOf("function");
  });

  it("counts requests, throttled waits and 429s", async () => {
    const logger = silentLogger();
    const limiter = createRateLimiter({ perMinute: 60, burst: 2, logger });
    for (let i = 0; i < 2; i++) (await limiter.acquire())();
    const waiting = limiter.acquire();
    const waitingToo = limiter.acquire();
    limiter.note429(1_000);

    await vi.advanceTimersByTimeAsync(3_000);
    (await waiting)();
    (await waitingToo)();

    const stats = limiter.stats();
    expect(stats).toEqual({
      requests_last_minute: 4,
      requests_today_utc: 4,
      throttled_waits_total: 2,
      rate_limited_responses_total: 1,
      last_rate_limited_at: "2026-09-16T10:00:00.000Z",
    });
    // The pause warning is logged at most once per minute and never names a URL
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith("whoop rate limiter paused", {
      waitMs: expect.any(Number),
      queued: expect.any(Number),
    });

    await vi.advanceTimersByTimeAsync(61_000);
    expect(limiter.stats().requests_last_minute).toBe(0);
    expect(limiter.stats().requests_today_utc).toBe(4);

    vi.setSystemTime(Date.parse("2026-09-17T00:00:01.000Z"));
    expect(limiter.stats().requests_today_utc).toBe(0);
  });

  it("rejects non-positive options", () => {
    expect(() => createRateLimiter({ perMinute: 0 })).toThrow(RangeError);
    expect(() => createRateLimiter({ perMinute: 60, burst: Number.NaN })).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// WHOOP client wiring
// ---------------------------------------------------------------------------

describe("WHOOP client with a rate limiter", () => {
  const BASE_URL = "https://test.whoop.api";
  let mockFetch: ReturnType<typeof vi.fn>;

  function response(status: number, headers: Record<string, string> = {}): Response {
    const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "Error",
      headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
      json: () => Promise.resolve({ records: [] }),
      text: () => Promise.resolve("{}"),
    } as unknown as Response;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("acquires a slot for every attempt and releases it once headers arrive", async () => {
    const limiter = createRateLimiter({ perMinute: 60 });
    const acquire = vi.spyOn(limiter, "acquire");
    mockFetch.mockResolvedValue(response(200));
    const client = createWhoopClient({ accessToken: "t", baseUrl: BASE_URL, rateLimiter: limiter });

    await Promise.all([client.get("/v2/cycle"), client.get("/v2/recovery")]);

    expect(acquire).toHaveBeenCalledTimes(2);
    expect(limiter.stats().requests_last_minute).toBe(2);
    // Both slots were released: four more requests fit in the concurrency limit at once
    const releases = await Promise.all([0, 1, 2, 3].map(() => limiter.acquire()));
    expect(releases).toHaveLength(4);
  });

  it("reports a 429 to the limiter and acquires again for the retry", async () => {
    const limiter = createRateLimiter({ perMinute: 60 });
    const acquire = vi.spyOn(limiter, "acquire");
    mockFetch
      .mockResolvedValueOnce(response(429, { "Retry-After": "3" }))
      .mockResolvedValueOnce(response(200));
    const client = createWhoopClient({ accessToken: "t", baseUrl: BASE_URL, rateLimiter: limiter });

    const pending = client.get("/v2/cycle");
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(pending).resolves.toEqual({ records: [] });

    expect(acquire).toHaveBeenCalledTimes(2);
    expect(limiter.stats().rate_limited_responses_total).toBe(1);
  });

  it("passes X-RateLimit headers to the limiter", async () => {
    const limiter = createRateLimiter({ perMinute: 60 });
    const noteHeaders = vi.spyOn(limiter, "noteHeaders");
    mockFetch.mockResolvedValue(
      response(200, { "X-RateLimit-Remaining": "1", "X-RateLimit-Reset": "12" })
    );
    const client = createWhoopClient({ accessToken: "t", baseUrl: BASE_URL, rateLimiter: limiter });

    await client.get("/v2/cycle");
    expect(noteHeaders).toHaveBeenCalledWith(1, 12);
  });

  it("acquires for the retry after a token refresh", async () => {
    const limiter = createRateLimiter({ perMinute: 60 });
    const acquire = vi.spyOn(limiter, "acquire");
    mockFetch.mockResolvedValueOnce(response(401)).mockResolvedValueOnce(response(200));
    const client = createWhoopClient({
      accessToken: "old",
      baseUrl: BASE_URL,
      rateLimiter: limiter,
      onTokenRefresh: () => Promise.resolve("new"),
    });

    await client.get("/v2/cycle");
    expect(acquire).toHaveBeenCalledTimes(2);
  });

  it("sends no request when the deadline passes while waiting for the limiter", async () => {
    const limiter = createRateLimiter({ perMinute: 60, burst: 1 });
    (await limiter.acquire())();
    mockFetch.mockResolvedValue(response(200));
    const client = createWhoopClient({ accessToken: "t", baseUrl: BASE_URL, rateLimiter: limiter });

    const pending = client.get("/v2/cycle", { deadlineMs: T0 + 200 });
    const outcome = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(300);

    const error = await outcome;
    expect(error).toBeInstanceOf(WhoopRateBudgetError);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(describeWhoopError(error)).toBe(
      "The server paused WHOOP requests to stay within WHOOP's per-minute request limit; retry in a minute or request a shorter period."
    );
  });

  it("stops before a 429 retry delay that would pass the deadline", async () => {
    mockFetch.mockResolvedValue(response(429, { "Retry-After": "5" }));
    const client = createWhoopClient({ accessToken: "t", baseUrl: BASE_URL });

    await expect(client.get("/v2/cycle", { deadlineMs: T0 + 2_000 })).rejects.toBeInstanceOf(
      WhoopRateBudgetError
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("refuses a request whose deadline already passed, even without a limiter", async () => {
    mockFetch.mockResolvedValue(response(200));
    const client = createWhoopClient({ accessToken: "t", baseUrl: BASE_URL });

    await expect(client.get("/v2/cycle", { deadlineMs: T0 })).rejects.toBeInstanceOf(
      WhoopRateBudgetError
    );
    expect(mockFetch).not.toHaveBeenCalled();
    // Without a deadline nothing changes
    await expect(client.get("/v2/cycle")).resolves.toEqual({ records: [] });
  });
  it("keeps 16 concurrent callers under WHOOP's 100 requests per minute with the default limit", async () => {
    // A WHOOP double that answers 429 once more than 100 requests arrived within a minute
    const sentAt: number[] = [];
    let rateLimited = 0;
    mockFetch.mockImplementation(async () => {
      const at = Date.now();
      sentAt.push(at);
      const lastMinute = sentAt.filter((t) => t > at - 60_000).length;
      if (lastMinute > 100) {
        rateLimited += 1;
        return response(429, { "Retry-After": "1" });
      }
      return response(200);
    });
    const limiter = createRateLimiter({ perMinute: 60 });
    const client = createWhoopClient({ accessToken: "t", baseUrl: BASE_URL, rateLimiter: limiter });

    const callers = Array.from({ length: 16 }, async (_, caller) => {
      for (let page = 0; page < 12; page++) {
        await client.get(`/v2/cycle?caller=${caller}&page=${page}`);
      }
    });
    const done = Promise.all(callers);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await done;

    expect(sentAt).toHaveLength(16 * 12);
    expect(rateLimited).toBe(0);
    const busiestMinute = Math.max(
      ...sentAt.map((start) => sentAt.filter((t) => t >= start && t < start + 60_000).length)
    );
    expect(busiestMinute).toBeLessThanOrEqual(60 + 20);
  });
});
