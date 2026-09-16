import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ARCHIVE_TTL_MS,
  CLOSED_TTL_MS,
  createHistoryBudget,
  DEFAULT_PAGE_BUDGET,
  HISTORY_CHUNK_MS,
  HISTORY_DEADLINE_MS,
  HISTORY_LIMITATIONS,
  loadHistory,
  MAX_PAGES_PER_CHUNK,
  MAX_RECORDS_PER_CHUNK,
  MAX_RECORDS_PER_SOURCE,
  RECENT_TTL_MS,
} from "../../src/api/history.js";
import { WhoopApiError, WhoopRateBudgetError, type WhoopClient } from "../../src/api/client.js";
import { cycleRecordSchema, recoveryRecordSchema } from "../../src/api/record-schemas.js";
import type { Cycle, Recovery } from "../../src/api/types.js";
import { MemoryCache } from "../../src/cache/memory-cache.js";
import { CYCLE_TTL_MS } from "../../src/resources/index.js";
import { createWhoopFixtureClient } from "../helpers/whoop-fixture-client.js";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/** Start of the 30-day chunk containing 2026-09-16 (2026-09-04T00:00Z). */
const B = Math.floor(Date.parse("2026-09-16T21:30:00Z") / HISTORY_CHUNK_MS) * HISTORY_CHUNK_MS;
/** Logical now: 10.5 days into the open chunk [B, B + 30 d). */
const NOW = B + 10 * DAY_MS + 12 * HOUR_MS;

const iso = (ms: number): string => new Date(ms).toISOString();

function cycle(id: number, startMs: number, endMs: number | null, updatedMs?: number): Cycle {
  return {
    id,
    user_id: 7,
    created_at: iso(startMs),
    updated_at: iso(updatedMs ?? (endMs ?? startMs) + HOUR_MS),
    start: iso(startMs),
    end: endMs === null ? null : iso(endMs),
    timezone_offset: "+02:00",
    score_state: "SCORED",
    score: { strain: 10, kilojoule: 8000, average_heart_rate: 60, max_heart_rate: 150 },
  };
}

/**
 * Consecutive cycles every `stepMs` from `firstStartMs`, the newest open. With
 * a start 2 h before a chunk boundary, one cycle spans every boundary.
 */
function consecutiveCycles(firstStartMs: number, stepMs: number, nowMs = NOW): Cycle[] {
  const cycles: Cycle[] = [];
  for (let id = 1, start = firstStartMs; start < nowMs; id++, start += stepMs) {
    const end = start + stepMs;
    cycles.push(cycle(id, start, end > nowMs ? null : end));
  }
  return cycles;
}

function period(startMs: number, endMs = NOW): { start: string; end: string } {
  return { start: iso(startMs), end: iso(endMs) };
}

function farBudget(pages = DEFAULT_PAGE_BUDGET): ReturnType<typeof createHistoryBudget> {
  return createHistoryBudget({ pages, deadlineMs: Date.now() + 10 * 60 * MINUTE_MS });
}

const now = (): Date => new Date(Date.now());

describe("loadHistory", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads 30-day epoch chunks newest first with start/end, limit 25 and the budget deadline", async () => {
    const cycles = consecutiveCycles(B - 60 * DAY_MS - 2 * HOUR_MS, DAY_MS);
    const client = createWhoopFixtureClient({ cycles });
    const budget = farBudget();

    const source = await loadHistory(
      client,
      "/v2/cycle",
      period(B - 45 * DAY_MS),
      cycleRecordSchema,
      { budget, now }
    );

    const firstPages = client.calls.filter((path) => !path.includes("nextToken"));
    expect(firstPages).toEqual([
      `/v2/cycle?start=${encodeURIComponent(iso(B))}&limit=25`,
      `/v2/cycle?start=${encodeURIComponent(iso(B - 30 * DAY_MS))}&end=${encodeURIComponent(iso(B))}&limit=25`,
      `/v2/cycle?start=${encodeURIComponent(iso(B - 60 * DAY_MS))}&end=${encodeURIComponent(iso(B - 30 * DAY_MS))}&limit=25`,
    ]);
    // 30 cycles per closed chunk: a second page each
    expect(client.calls.filter((path) => path.includes("nextToken="))).toHaveLength(2);
    for (const request of client.requests) {
      expect(request.options).toEqual({ deadlineMs: budget.deadlineMs });
    }
    expect(budget.pagesRemaining).toBe(DEFAULT_PAGE_BUDGET - 5);

    expect(source.chunks_total).toBe(3);
    expect(source.chunks_from_cache).toBe(0);
    expect(source.complete_since).toBe(iso(B - 45 * DAY_MS));
    expect(source.quality).toMatchObject({
      truncated: false,
      cache_status: "miss",
      status: "missing",
    });
    expect(source.quality.fetched_at).toBe(iso(NOW));
    expect(source.error).toBeUndefined();
    expect(source.partialError).toBeUndefined();
  });

  it("merges a record returned by two chunks once and does not filter to the period", async () => {
    const cycles = consecutiveCycles(B - 60 * DAY_MS - 2 * HOUR_MS, DAY_MS);
    const client = createWhoopFixtureClient({ cycles });

    const source = await loadHistory(
      client,
      "/v2/cycle",
      period(B - 45 * DAY_MS),
      cycleRecordSchema,
      { now }
    );

    const ids = source.records.map((record) => record.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Everything overlapping [B - 60 d, now): the grid chunk starts before the period
    expect(ids).toHaveLength(cycles.length);
    expect(source.quality.records_fetched).toBe(cycles.length);
    const spanning = cycles.find((c) => Date.parse(c.start) === B - 2 * HOUR_MS)!;
    expect(ids.filter((id) => id === spanning.id)).toHaveLength(1);
    // Newest first
    expect(ids[0]).toBe(cycles[cycles.length - 1]!.id);
  });

  it("keeps the most recently updated version of a duplicate", async () => {
    const older = cycle(1, B - 2 * HOUR_MS, B + 22 * HOUR_MS, B + 23 * HOUR_MS);
    const newer = { ...older, updated_at: iso(B + 30 * HOUR_MS), score_state: "UNSCORABLE" };
    const client: WhoopClient = {
      get: async <T>(path: string): Promise<T> => {
        const chunkStart = Date.parse(new URLSearchParams(path.split("?")[1]).get("start")!);
        // The older chunk returns the newer version, the newest chunk the older one
        const record = chunkStart === B ? older : newer;
        return { records: [record], next_token: null } as T;
      },
    };

    const source = await loadHistory(
      client,
      "/v2/cycle",
      period(B - 10 * DAY_MS),
      cycleRecordSchema,
      { now }
    );

    expect(source.records).toHaveLength(1);
    expect(source.records[0]!.score_state).toBe("UNSCORABLE");
  });

  it("dedupes recoveries by user_id and cycle_id", async () => {
    const cycles = [
      cycle(10, B - 2 * HOUR_MS, B + 22 * HOUR_MS),
      cycle(11, B + 22 * HOUR_MS, null),
    ];
    const recovery = (cycleId: number, sleepId: string): Recovery => ({
      cycle_id: cycleId,
      sleep_id: sleepId,
      user_id: 7,
      created_at: iso(B + HOUR_MS),
      updated_at: iso(B + HOUR_MS),
      score_state: "SCORED",
      score: {
        user_calibrating: true,
        recovery_score: 50,
        resting_heart_rate: 55,
        hrv_rmssd_milli: 60,
        spo2_percentage: 96,
        skin_temp_celsius: 33.5,
      },
    });
    const client = createWhoopFixtureClient({
      cycles,
      recoveries: [recovery(10, "s-10"), recovery(11, "s-11")],
    });

    const source = await loadHistory(
      client,
      "/v2/recovery",
      period(B - 5 * DAY_MS),
      recoveryRecordSchema,
      { now }
    );

    expect(source.chunks_total).toBe(2);
    expect(source.records.map((record) => record.cycle_id).sort()).toEqual([10, 11]);
  });

  it("URL-encodes next_token", async () => {
    const paths: string[] = [];
    const client: WhoopClient = {
      get: async <T>(path: string): Promise<T> => {
        paths.push(path);
        return (
          path.includes("nextToken")
            ? { records: [], next_token: null }
            : { records: [], next_token: "a+b/c=" }
        ) as T;
      },
    };

    await loadHistory(client, "/v2/cycle", period(B + DAY_MS), cycleRecordSchema, { now });

    expect(paths[1]).toBe(`${paths[0]}&nextToken=a%2Bb%2Fc%3D`);
  });

  // -------------------------------------------------------------------------
  // Caching
  // -------------------------------------------------------------------------

  describe("chunk cache", () => {
    const cycles = consecutiveCycles(B - 60 * DAY_MS - 2 * HOUR_MS, DAY_MS);

    it("serves closed chunks from the cache and refetches the open chunk after 2 minutes", async () => {
      const client = createWhoopFixtureClient({ cycles });
      const cache = new MemoryCache({ maxEntries: 500 });
      const load = (): ReturnType<typeof loadHistory<Cycle>> =>
        loadHistory(client, "/v2/cycle", period(B - 45 * DAY_MS), cycleRecordSchema, {
          cache,
          now,
        });

      await load();
      const firstCalls = client.calls.length;

      vi.setSystemTime(NOW + MINUTE_MS);
      const allCached = await load();
      expect(client.calls.length).toBe(firstCalls);
      expect(allCached.chunks_from_cache).toBe(3);
      expect(allCached.quality.cache_status).toBe("hit");
      expect(allCached.quality.fetched_at).toBe(iso(NOW));

      vi.setSystemTime(NOW + RECENT_TTL_MS + 1);
      const openRefetched = await load();
      expect(client.calls.slice(firstCalls)).toEqual([
        `/v2/cycle?start=${encodeURIComponent(iso(B))}&limit=25`,
      ]);
      expect(openRefetched.chunks_from_cache).toBe(2);
      expect(openRefetched.quality.cache_status).toBe("miss");
      expect(openRefetched.quality.fetched_at).toBe(iso(NOW));
      expect(openRefetched.records).toHaveLength(allCached.records.length);
    });

    it("keeps settled chunks 60 minutes and archived chunks 6 hours", async () => {
      expect(RECENT_TTL_MS).toBe(CYCLE_TTL_MS);
      const client = createWhoopFixtureClient({ cycles });
      const cache = new MemoryCache({ maxEntries: 500 });
      const load = (): Promise<unknown> =>
        loadHistory(client, "/v2/cycle", period(B - 45 * DAY_MS), cycleRecordSchema, {
          cache,
          now,
        });
      const settledStart = `start=${encodeURIComponent(iso(B - 30 * DAY_MS))}&end`;
      const archivedStart = `start=${encodeURIComponent(iso(B - 60 * DAY_MS))}&end`;
      const firstPagesSince = (from: number, fragment: string): number =>
        client.calls
          .slice(from)
          .filter((path) => path.includes(fragment) && !path.includes("nextToken")).length;

      await load();
      let mark = client.calls.length;

      // [B - 30 d, B) ended 10.5 days ago: settled
      vi.setSystemTime(NOW + CLOSED_TTL_MS - 1);
      await load();
      expect(firstPagesSince(mark, settledStart)).toBe(0);

      mark = client.calls.length;
      vi.setSystemTime(NOW + CLOSED_TTL_MS);
      await load();
      expect(firstPagesSince(mark, settledStart)).toBe(1);
      expect(firstPagesSince(mark, archivedStart)).toBe(0);

      // [B - 60 d, B - 30 d) ended 40.5 days ago: archived
      mark = client.calls.length;
      vi.setSystemTime(NOW + ARCHIVE_TTL_MS);
      await load();
      expect(firstPagesSince(mark, archivedStart)).toBe(1);
    });

    it("treats a chunk that ended less than 3 days ago as recent", async () => {
      const recentNow = B + DAY_MS;
      vi.setSystemTime(recentNow);
      const client = createWhoopFixtureClient({
        cycles: consecutiveCycles(B - 20 * DAY_MS - 2 * HOUR_MS, DAY_MS, recentNow),
      });
      const cache = new MemoryCache({ maxEntries: 500 });
      const load = (): Promise<unknown> =>
        loadHistory(client, "/v2/cycle", period(B - 10 * DAY_MS, recentNow), cycleRecordSchema, {
          cache,
          now,
        });

      await load();
      const mark = client.calls.length;
      vi.setSystemTime(recentNow + RECENT_TTL_MS);
      await load();
      expect(client.calls.slice(mark).filter((path) => !path.includes("nextToken"))).toHaveLength(
        2
      );
    });

    it("uses the same keys at different times", async () => {
      const client = createWhoopFixtureClient({ cycles });
      const cache = new MemoryCache({ maxEntries: 500 });
      const keysAt = async (ms: number, startMs: number): Promise<string[]> => {
        vi.setSystemTime(ms);
        const spy = vi.spyOn(cache, "getOrFetchWithMeta");
        await loadHistory(client, "/v2/cycle", period(startMs, ms), cycleRecordSchema, {
          cache,
          now,
        });
        const keys = spy.mock.calls.map((args) => args[0]);
        spy.mockRestore();
        return keys;
      };

      const first = await keysAt(NOW, B - 45 * DAY_MS);
      const later = await keysAt(NOW + DAY_MS + 5 * HOUR_MS, B - 50 * DAY_MS);
      expect(first).toEqual([
        `HIST:v1:/v2/cycle:${B}:open`,
        `HIST:v1:/v2/cycle:${B - 30 * DAY_MS}`,
        `HIST:v1:/v2/cycle:${B - 60 * DAY_MS}`,
      ]);
      expect(later).toEqual(first);
    });

    it("caches nothing without a cache option", async () => {
      const client = createWhoopFixtureClient({ cycles });
      await loadHistory(client, "/v2/cycle", period(B - 45 * DAY_MS), cycleRecordSchema, { now });
      const firstCalls = client.calls.length;
      const second = await loadHistory(
        client,
        "/v2/cycle",
        period(B - 45 * DAY_MS),
        cycleRecordSchema,
        { now }
      );
      expect(client.calls.length).toBe(2 * firstCalls);
      expect(second.chunks_from_cache).toBe(0);
      expect(second.quality.cache_status).toBe("miss");
    });

    it("keeps history chunks when a token refresh removes every other cache entry", async () => {
      const client = createWhoopFixtureClient({ cycles });
      const cache = new MemoryCache({ maxEntries: 500 });
      cache.set("GET:/v2/cycle?limit=1", { records: [] });
      await loadHistory(client, "/v2/cycle", period(B - 45 * DAY_MS), cycleRecordSchema, {
        cache,
        now,
      });
      const firstCalls = client.calls.length;

      expect(cache.deleteWhere((key) => !key.startsWith("HIST:"))).toBe(1);

      const again = await loadHistory(
        client,
        "/v2/cycle",
        period(B - 45 * DAY_MS),
        cycleRecordSchema,
        { cache, now }
      );
      expect(client.calls.length).toBe(firstCalls);
      expect(again.chunks_from_cache).toBe(3);
      expect(cache.has("GET:/v2/cycle?limit=1")).toBe(false);
    });

    it("does not repopulate the cache from a fetch that was in flight during clear()", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const fixture = createWhoopFixtureClient({ cycles });
      const client: WhoopClient = {
        get: async <T>(path: string, options?: Parameters<WhoopClient["get"]>[1]): Promise<T> => {
          await gate;
          return fixture.get<T>(path, options);
        },
      };
      const cache = new MemoryCache({ maxEntries: 500 });

      const pending = loadHistory(client, "/v2/cycle", period(B + DAY_MS), cycleRecordSchema, {
        cache,
        now,
      });
      cache.clear();
      release();
      const source = await pending;

      expect(source.records.length).toBeGreaterThan(0);
      expect(cache.size).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Failures, budget and deadline
  // -------------------------------------------------------------------------

  describe("failures and budget", () => {
    const cycles = consecutiveCycles(B - 60 * DAY_MS - 2 * HOUR_MS, DAY_MS);

    it("keeps records of a chunk whose later page failed, marks it truncated and does not cache it", async () => {
      const settledFirstPage = new RegExp(
        `start=${encodeURIComponent(iso(B - 30 * DAY_MS)).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}&end`
      );
      const failure = new WhoopApiError(503, "Service Unavailable", null);
      const fixture = createWhoopFixtureClient({
        cycles,
        failures: [{ path: settledFirstPage, page: 2, times: 1, error: failure }],
      });
      // The open chunk answers late, so the failure is known before it completes
      let delayOpenChunk = true;
      const client: WhoopClient = {
        get: async <T>(path: string, options?: Parameters<WhoopClient["get"]>[1]): Promise<T> => {
          if (delayOpenChunk && !path.includes("end=")) {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          return fixture.get<T>(path, options);
        },
      };
      const cache = new MemoryCache({ maxEntries: 500 });

      const partial = await loadHistory(
        client,
        "/v2/cycle",
        period(B - 45 * DAY_MS),
        cycleRecordSchema,
        { cache, now }
      );

      expect(partial.partialError).toBe(failure);
      expect(partial.error).toBeUndefined();
      expect(partial.quality.truncated).toBe(true);
      expect(partial.complete_since).toBe(iso(B));
      // The open chunk plus the first page (25 records) of the failed chunk; the
      // cycle spanning B is in both
      const openCount = cycles.filter((c) => c.end === null || Date.parse(c.end!) > B).length;
      expect(partial.records).toHaveLength(openCount + 25 - 1);
      // The oldest chunk was not scheduled
      expect(
        fixture.calls.some((path) => path.includes(encodeURIComponent(iso(B - 60 * DAY_MS))))
      ).toBe(false);
      expect(cache.has(`HIST:v1:/v2/cycle:${B - 30 * DAY_MS}`)).toBe(false);
      expect(cache.has(`HIST:v1:/v2/cycle:${B}:open`)).toBe(true);

      delayOpenChunk = false;
      const retried = await loadHistory(
        client,
        "/v2/cycle",
        period(B - 45 * DAY_MS),
        cycleRecordSchema,
        { cache, now }
      );
      expect(retried.quality.truncated).toBe(false);
      expect(retried.partialError).toBeUndefined();
      expect(retried.chunks_from_cache).toBe(1);
      expect(retried.records).toHaveLength(cycles.length);
    });

    it("reports fetch_failed with the error when the newest chunk fails and nothing loaded", async () => {
      const failure = new WhoopApiError(401, "Unauthorized", null);
      const client = createWhoopFixtureClient({
        cycles,
        failures: [{ path: /^\/v2\/cycle/, error: failure }],
      });

      const source = await loadHistory(
        client,
        "/v2/cycle",
        period(B - 45 * DAY_MS),
        cycleRecordSchema,
        { now }
      );

      expect(source.records).toEqual([]);
      expect(source.error).toBe(failure);
      expect(source.quality.status).toBe("fetch_failed");
      expect(source.quality.truncated).toBe(true);
      expect(source.complete_since).toBeNull();
    });

    it("reports invalid for a malformed first page", async () => {
      const client: WhoopClient = {
        get: async <T>(): Promise<T> => ({ records: "nope" }) as T,
      };
      const source = await loadHistory(client, "/v2/cycle", period(B + DAY_MS), cycleRecordSchema, {
        now,
      });
      expect(source.quality.status).toBe("invalid");
      expect(source.error).toBeUndefined();
    });

    it("stops when the page budget runs out and continues older chunks from the cache next time", async () => {
      // One cycle every two days: every chunk fits one page
      const sparse = consecutiveCycles(B - 90 * DAY_MS - 2 * HOUR_MS, 2 * DAY_MS);
      const client = createWhoopFixtureClient({ cycles: sparse });
      const cache = new MemoryCache({ maxEntries: 500 });
      const load = (pages: number): ReturnType<typeof loadHistory<Cycle>> =>
        loadHistory(client, "/v2/cycle", period(B - 90 * DAY_MS), cycleRecordSchema, {
          cache,
          budget: farBudget(pages),
          now,
        });

      const first = await load(2);
      expect(client.calls).toHaveLength(2);
      expect(first.quality.truncated).toBe(true);
      expect(first.complete_since).toBe(iso(B - 30 * DAY_MS));
      expect(first.partialError).toBeInstanceOf(WhoopRateBudgetError);
      expect(first.chunks_total).toBe(4);

      const second = await load(2);
      expect(client.calls).toHaveLength(4);
      expect(second.chunks_from_cache).toBe(2);
      expect(second.quality.truncated).toBe(false);
      expect(second.complete_since).toBe(iso(B - 90 * DAY_MS));
      expect(second.records).toHaveLength(sparse.length);
    });

    it("stops requesting pages once the deadline passes", async () => {
      const fixture = createWhoopFixtureClient({ cycles });
      const deadlineMs = NOW + 1_000;
      const client: WhoopClient = {
        get: async <T>(path: string, options?: Parameters<WhoopClient["get"]>[1]): Promise<T> => {
          const result = await fixture.get<T>(path, options);
          vi.setSystemTime(NOW + 5_000);
          return result;
        },
      };

      const source = await loadHistory(
        client,
        "/v2/cycle",
        period(B - 45 * DAY_MS),
        cycleRecordSchema,
        { budget: createHistoryBudget({ deadlineMs }), now: () => new Date(NOW) }
      );

      // Both newest chunks started before the deadline; the second page of the
      // settled chunk and the oldest chunk were not requested
      expect(fixture.calls).toHaveLength(2);
      expect(source.quality.truncated).toBe(true);
      expect(source.complete_since).toBe(iso(B));
      expect(source.partialError).toBeInstanceOf(WhoopRateBudgetError);
    });

    it("reports the budget error as fetch_failed when the deadline passed before anything loaded", async () => {
      const client = createWhoopFixtureClient({ cycles });
      const source = await loadHistory(
        client,
        "/v2/cycle",
        period(B - 45 * DAY_MS),
        cycleRecordSchema,
        { budget: createHistoryBudget({ deadlineMs: NOW }), now }
      );
      expect(client.calls).toEqual([]);
      expect(source.quality.status).toBe("fetch_failed");
      expect(source.error).toBeInstanceOf(WhoopRateBudgetError);
    });

    it("serves cached chunks even after the deadline", async () => {
      const client = createWhoopFixtureClient({ cycles });
      const cache = new MemoryCache({ maxEntries: 500 });
      await loadHistory(client, "/v2/cycle", period(B - 45 * DAY_MS), cycleRecordSchema, {
        cache,
        now,
      });
      const source = await loadHistory(
        client,
        "/v2/cycle",
        period(B - 45 * DAY_MS),
        cycleRecordSchema,
        { cache, budget: createHistoryBudget({ deadlineMs: NOW }), now }
      );
      expect(source.quality.truncated).toBe(false);
      expect(source.chunks_from_cache).toBe(3);
    });

    it("marks a chunk over the page cap incomplete", async () => {
      let served = 0;
      const client: WhoopClient = {
        get: async <T>(): Promise<T> => {
          served += 1;
          const records = Array.from({ length: 25 }, (_, index) =>
            cycle(served * 100 + index, B + HOUR_MS, B + 2 * HOUR_MS)
          );
          return { records, next_token: `page-${served}` } as T;
        },
      };
      const source = await loadHistory(client, "/v2/cycle", period(B + DAY_MS), cycleRecordSchema, {
        budget: farBudget(1_000),
        now,
      });
      expect(served).toBe(MAX_PAGES_PER_CHUNK);
      expect(source.records).toHaveLength(MAX_RECORDS_PER_CHUNK);
      expect(source.quality.truncated).toBe(true);
      expect(source.complete_since).toBeNull();
    });

    it("schedules no older chunk once the source holds MAX_RECORDS_PER_SOURCE records", async () => {
      const chunkStarts: number[] = [];
      const client: WhoopClient = {
        get: async <T>(path: string): Promise<T> => {
          const params = new URLSearchParams(path.split("?")[1]);
          const start = Date.parse(params.get("start")!);
          const page = Number(params.get("nextToken") ?? "0");
          if (page === 0) chunkStarts.push(start);
          const records = Array.from({ length: 25 }, (_, index) =>
            cycle(start / 1000 + page * 25 + index, start + HOUR_MS, start + 2 * HOUR_MS)
          );
          return {
            records,
            next_token: page + 1 < MAX_PAGES_PER_CHUNK ? String(page + 1) : null,
          } as T;
        },
      };
      const source = await loadHistory(
        client,
        "/v2/cycle",
        period(B - 240 * DAY_MS),
        cycleRecordSchema,
        { budget: farBudget(10_000), now }
      );
      expect(source.chunks_total).toBe(9);
      const loadedChunks = MAX_RECORDS_PER_SOURCE / MAX_RECORDS_PER_CHUNK;
      expect(chunkStarts.length).toBeGreaterThanOrEqual(loadedChunks);
      expect(chunkStarts.length).toBeLessThanOrEqual(loadedChunks + 1);
      expect(source.quality.truncated).toBe(true);
    });

    it("reads at most two chunks at a time", async () => {
      vi.useRealTimers();
      let inFlight = 0;
      let maxInFlight = 0;
      const client: WhoopClient = {
        get: async <T>(): Promise<T> => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight -= 1;
          return { records: [], next_token: null } as T;
        },
      };
      const source = await loadHistory(
        client,
        "/v2/cycle",
        period(B - 150 * DAY_MS, B + DAY_MS),
        cycleRecordSchema,
        { now: () => new Date(NOW) }
      );
      expect(source.chunks_total).toBe(6);
      expect(maxInFlight).toBe(2);
    });
  });

  it("returns no chunks for an empty period and rejects invalid timestamps", async () => {
    const client = createWhoopFixtureClient();
    const empty = await loadHistory(client, "/v2/cycle", period(NOW + DAY_MS), cycleRecordSchema, {
      now,
    });
    expect(empty.chunks_total).toBe(0);
    expect(empty.records).toEqual([]);
    expect(empty.quality.truncated).toBe(false);
    expect(client.calls).toEqual([]);

    await expect(
      loadHistory(client, "/v2/cycle", { start: "yesterday", end: iso(NOW) }, cycleRecordSchema)
    ).rejects.toThrow(RangeError);
  });

  it("uses the default budget of 60 pages and a 20-second deadline", () => {
    const budget = createHistoryBudget({ deadlineMs: NOW + HISTORY_DEADLINE_MS });
    expect(budget.pagesRemaining).toBe(60);
    expect(HISTORY_DEADLINE_MS).toBe(20_000);
    expect(budget.takePage()).toBe(true);
    expect(budget.pagesRemaining).toBe(59);
    vi.setSystemTime(NOW + HISTORY_DEADLINE_MS);
    expect(budget.takePage()).toBe(false);
    expect(budget.pagesRemaining).toBe(59);
  });

  it("exports the history limitations", () => {
    expect(HISTORY_LIMITATIONS).toHaveLength(2);
    expect(HISTORY_LIMITATIONS[0]).toContain(
      "up to 60 minutes (older than 30 days: up to 6 hours)"
    );
    expect(HISTORY_LIMITATIONS[1]).toContain("complete_since");
  });
});
