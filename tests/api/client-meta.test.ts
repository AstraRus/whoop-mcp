/**
 * Tests for WhoopClient.getWithMeta (fetch time and cache status) and the
 * `refresh` GET option.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cacheKey, createWhoopClient, WhoopApiError } from "../../src/api/client.js";
import { MemoryCache } from "../../src/cache/memory-cache.js";

const BASE_URL = "https://api.test";
const PATH = "/v2/cycle?limit=25";
const T0 = Date.parse("2026-09-16T10:00:00.000Z");

/** A fetch stub answering each request with the next body (a number status answers with that error). */
function stubFetch(...bodies: Array<unknown>): ReturnType<typeof vi.fn> {
  let call = 0;
  const fetchStub = vi.fn(() => {
    const body = bodies[Math.min(call, bodies.length - 1)];
    call += 1;
    if (typeof body === "number") {
      return Promise.resolve(new Response("{}", { status: body, statusText: "Error" }));
    }
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
  });
  vi.stubGlobal("fetch", fetchStub);
  return fetchStub;
}

describe("WhoopClient.getWithMeta", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reports a miss with the fetch time, then a hit with the time the entry was stored", async () => {
    const fetchStub = stubFetch({ records: [1] }, { records: [2] });
    const client = createWhoopClient({
      accessToken: "token",
      baseUrl: BASE_URL,
      cache: new MemoryCache(),
    });

    const first = await client.getWithMeta!<{ records: number[] }>(PATH, {
      cache: true,
      ttlMs: 120_000,
    });
    expect(first).toEqual({ data: { records: [1] }, fetchedAt: T0, cacheStatus: "miss" });

    vi.setSystemTime(T0 + 60_000);
    const second = await client.getWithMeta!<{ records: number[] }>(PATH, {
      cache: true,
      ttlMs: 120_000,
    });
    expect(second).toEqual({ data: { records: [1] }, fetchedAt: T0, cacheStatus: "hit" });
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("shares cache entries with get()", async () => {
    const fetchStub = stubFetch({ records: [1] });
    const client = createWhoopClient({
      accessToken: "token",
      baseUrl: BASE_URL,
      cache: new MemoryCache(),
    });

    await client.get(PATH, { cache: true, ttlMs: 120_000 });
    vi.setSystemTime(T0 + 1_000);
    const meta = await client.getWithMeta!(PATH, { cache: true, ttlMs: 120_000 });

    expect(meta.cacheStatus).toBe("hit");
    expect(meta.fetchedAt).toBe(T0);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("refetches and stores with refresh: true", async () => {
    const fetchStub = stubFetch({ records: [1] }, { records: [2] }, { records: [3] });
    const cache = new MemoryCache();
    const client = createWhoopClient({ accessToken: "token", baseUrl: BASE_URL, cache });

    await client.getWithMeta!(PATH, { cache: true, ttlMs: 120_000 });
    vi.setSystemTime(T0 + 30_000);
    const refreshed = await client.getWithMeta!<{ records: number[] }>(PATH, {
      cache: true,
      ttlMs: 120_000,
      refresh: true,
    });
    expect(refreshed).toEqual({
      data: { records: [2] },
      fetchedAt: T0 + 30_000,
      cacheStatus: "miss",
    });
    expect(fetchStub).toHaveBeenCalledTimes(2);

    // The refreshed value replaced the entry: later readers are served it.
    vi.setSystemTime(T0 + 60_000);
    const after = await client.getWithMeta!<{ records: number[] }>(PATH, {
      cache: true,
      ttlMs: 120_000,
    });
    expect(after).toEqual({ data: { records: [2] }, fetchedAt: T0 + 30_000, cacheStatus: "hit" });
    expect(await client.get<{ records: number[] }>(PATH, { cache: true, ttlMs: 120_000 })).toEqual({
      records: [2],
    });
    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(cache.has(cacheKey(PATH))).toBe(true);
  });

  it("keeps no stale entry when a refresh fails", async () => {
    stubFetch({ records: [1] }, 503);
    const cache = new MemoryCache();
    const client = createWhoopClient({ accessToken: "token", baseUrl: BASE_URL, cache });

    await client.getWithMeta!(PATH, { cache: true, ttlMs: 120_000 });
    await expect(
      client.getWithMeta!(PATH, { cache: true, ttlMs: 120_000, refresh: true })
    ).rejects.toBeInstanceOf(WhoopApiError);
    expect(cache.has(cacheKey(PATH))).toBe(false);
  });

  it("reports a miss at the current time without the cache option or without a cache", async () => {
    const fetchStub = stubFetch({ records: [] });
    const cached = createWhoopClient({
      accessToken: "token",
      baseUrl: BASE_URL,
      cache: new MemoryCache(),
    });
    const uncached = createWhoopClient({ accessToken: "token", baseUrl: BASE_URL });

    for (const [client, options] of [
      [cached, undefined],
      [cached, { refresh: true }],
      [uncached, { cache: true, refresh: true }],
    ] as const) {
      expect(await client.getWithMeta!(PATH, options)).toEqual({
        data: { records: [] },
        fetchedAt: T0,
        cacheStatus: "miss",
      });
    }
    expect(fetchStub).toHaveBeenCalledTimes(3);
  });
});
