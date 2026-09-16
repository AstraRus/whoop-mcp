/**
 * Tests for collection-utils.ts — buildCollectionQuery and the user offset lookup.
 *
 * Covers edge cases: empty params, all params, single param,
 * undefined values omitted, and enhanced date expression resolution.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildCollectionQuery,
  buildLocalCollectionQuery,
  resolveUserUtcOffset,
  resolveUserUtcOffsetInfo,
} from "../../src/tools/collection-utils.js";
import {
  createWhoopClient,
  WhoopApiError,
  WhoopAuthError,
  WhoopNetworkError,
} from "../../src/api/client.js";
import type { WhoopClient } from "../../src/api/client.js";
import { MemoryCache } from "../../src/cache/memory-cache.js";
import { CYCLE_TTL_MS, RESOURCE_DEFINITIONS } from "../../src/resources/index.js";

describe("buildCollectionQuery", () => {
  it("returns empty string when no params are set", () => {
    expect(buildCollectionQuery({})).toBe("");
  });

  it("returns empty string when all params are undefined", () => {
    expect(
      buildCollectionQuery({
        start: undefined,
        end: undefined,
        limit: undefined,
        nextToken: undefined,
      })
    ).toBe("");
  });

  it("returns query string with all params when all are provided", () => {
    const query = buildCollectionQuery({
      start: "2026-04-01T00:00:00.000Z",
      end: "2026-04-10T00:00:00.000Z",
      limit: 5,
      nextToken: "abc123",
    });

    expect(query).toContain("?");
    const params = new URLSearchParams(query.slice(1));
    expect(params.get("start")).toBe("2026-04-01T00:00:00.000Z");
    expect(params.get("end")).toBe("2026-04-10T00:00:00.000Z");
    expect(params.get("limit")).toBe("5");
    expect(params.get("nextToken")).toBe("abc123");
  });

  it("returns query string with only start when only start is provided", () => {
    const query = buildCollectionQuery({
      start: "2026-04-01T00:00:00.000Z",
    });

    expect(query).toMatch(/^\?start=/);
    const params = new URLSearchParams(query.slice(1));
    expect(params.get("start")).toBe("2026-04-01T00:00:00.000Z");
    expect(params.has("end")).toBe(false);
    expect(params.has("limit")).toBe(false);
    expect(params.has("nextToken")).toBe(false);
  });

  it("returns query string with only end when only end is provided", () => {
    const query = buildCollectionQuery({
      end: "2026-04-10T00:00:00.000Z",
    });

    const params = new URLSearchParams(query.slice(1));
    expect(params.get("end")).toBe("2026-04-10T00:00:00.000Z");
    expect(params.has("start")).toBe(false);
  });

  it("returns query string with only limit when only limit is provided", () => {
    const query = buildCollectionQuery({ limit: 10 });

    const params = new URLSearchParams(query.slice(1));
    expect(params.get("limit")).toBe("10");
    expect(params.has("start")).toBe(false);
    expect(params.has("end")).toBe(false);
    expect(params.has("nextToken")).toBe(false);
  });

  it("returns query string with only nextToken when only nextToken is provided", () => {
    const query = buildCollectionQuery({ nextToken: "page2" });

    const params = new URLSearchParams(query.slice(1));
    expect(params.get("nextToken")).toBe("page2");
    expect(params.has("start")).toBe(false);
  });

  it("omits undefined values from the query string", () => {
    const query = buildCollectionQuery({
      start: "2026-04-01T00:00:00.000Z",
      end: undefined,
      limit: 25,
      nextToken: undefined,
    });

    const params = new URLSearchParams(query.slice(1));
    expect(params.get("start")).toBe("2026-04-01T00:00:00.000Z");
    expect(params.get("limit")).toBe("25");
    expect(params.has("end")).toBe(false);
    expect(params.has("nextToken")).toBe(false);
  });

  it("converts limit number to string in query", () => {
    const query = buildCollectionQuery({ limit: 1 });

    const params = new URLSearchParams(query.slice(1));
    expect(params.get("limit")).toBe("1");
  });

  it("starts with ? when at least one param is set", () => {
    const query = buildCollectionQuery({ limit: 5 });

    expect(query.startsWith("?")).toBe(true);
  });

  describe("enhanced date resolution", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-05-28T12:00:00.000Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("resolves 'today' in start to ISO 8601 start-of-day", () => {
      const query = buildCollectionQuery({ start: "today" });
      const params = new URLSearchParams(query.slice(1));
      expect(params.get("start")).toBe("2026-05-28T00:00:00.000Z");
    });

    it("resolves 'today' in end to ISO 8601 end-of-day", () => {
      const query = buildCollectionQuery({ end: "today" });
      const params = new URLSearchParams(query.slice(1));
      expect(params.get("end")).toBe("2026-05-28T23:59:59.999Z");
    });

    it("resolves 'last 7 days' in start to 7 days ago", () => {
      const query = buildCollectionQuery({ start: "last 7 days" });
      const params = new URLSearchParams(query.slice(1));
      expect(params.get("start")).toBe("2026-05-21T00:00:00.000Z");
    });

    it("passes through ISO 8601 UTC timestamps unchanged", () => {
      const query = buildCollectionQuery({ start: "2026-04-01T00:00:00.000Z" });
      const params = new URLSearchParams(query.slice(1));
      expect(params.get("start")).toBe("2026-04-01T00:00:00.000Z");
    });

    it("expands date-only start/end to full timestamps covering both days", () => {
      const query = buildCollectionQuery({ start: "2026-09-13", end: "2026-09-16" }, "+02:00");
      const params = new URLSearchParams(query.slice(1));
      expect(params.get("start")).toBe("2026-09-12T22:00:00.000Z");
      expect(params.get("end")).toBe("2026-09-16T21:59:59.999Z");
    });

    it("throws InvalidDateExpression for unrecognized expressions", () => {
      expect(() => buildCollectionQuery({ start: "next tuesday" })).toThrow(
        "Unrecognized date expression"
      );
    });
  });
});

// ---------------------------------------------------------------------------
// resolveUserUtcOffsetInfo / resolveUserUtcOffset
// ---------------------------------------------------------------------------

const BASE_URL = "https://whoop.test/developer";
const START = Date.parse("2026-09-16T08:00:00.000Z"); // 10:00 local at +02:00

function cycle(strain: number, offset: unknown = "+02:00"): Record<string, unknown> {
  return {
    id: 3,
    user_id: 1,
    created_at: "2026-09-15T21:13:31.000Z",
    updated_at: "2026-09-15T21:13:31.000Z",
    start: "2026-09-15T21:13:31.000Z",
    end: null,
    timezone_offset: offset,
    score_state: "SCORED",
    score: { strain, kilojoule: 1000, average_heart_rate: 60, max_heart_rate: 120 },
  };
}

function page(records: unknown[]): { records: unknown[]; next_token: null } {
  return { records, next_token: null };
}

/** A client whose GETs answer with `responses` in order (an Error rejects) */
function mockClient(...responses: unknown[]): {
  client: WhoopClient;
  get: ReturnType<typeof vi.fn>;
} {
  const get = vi.fn();
  for (const response of responses) {
    if (response instanceof Error) {
      get.mockRejectedValueOnce(response);
    } else {
      get.mockResolvedValueOnce(response);
    }
  }
  return { client: { get } as unknown as WhoopClient, get };
}

describe("resolveUserUtcOffsetInfo", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: START });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads the offset from the latest cycle with the cycle resource's 2-minute TTL", async () => {
    const { client, get } = mockClient(page([cycle(5)]));

    expect(await resolveUserUtcOffsetInfo(client)).toEqual({ offset: "+02:00", fallback: false });
    expect(get).toHaveBeenCalledWith("/v2/cycle?limit=1", { cache: true, ttlMs: CYCLE_TTL_MS });
  });

  it("reuses a successfully read offset for an hour, then reads it again", async () => {
    const { client, get } = mockClient(page([cycle(5)]), page([cycle(5, "+03:00")]));

    await resolveUserUtcOffsetInfo(client);
    vi.advanceTimersByTime(59 * 60_000);
    expect(await resolveUserUtcOffset(client)).toBe("+02:00");
    expect(get).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2 * 60_000);
    expect(await resolveUserUtcOffset(client)).toBe("+03:00");
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("flags a UTC fallback when the lookup fails and does not cache the failure", async () => {
    const { client, get } = mockClient(new Error("down"), page([cycle(5)]));

    expect(await resolveUserUtcOffsetInfo(client)).toEqual({ offset: "Z", fallback: true });
    expect(await resolveUserUtcOffsetInfo(client)).toEqual({ offset: "+02:00", fallback: false });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("keeps resolveUserUtcOffset returning 'Z' when the offset cannot be read", async () => {
    const { client } = mockClient(
      new WhoopApiError(500, "", null),
      new WhoopApiError(503, "", null)
    );
    expect(await resolveUserUtcOffset(client)).toBe("Z");
  });

  it.each([
    ["a network blip", new WhoopNetworkError(new TypeError("fetch failed"))],
    ["a 5xx", new WhoopApiError(502, "Bad Gateway", null)],
  ])("retries once after %s", async (_label, error) => {
    const { client, get } = mockClient(error, page([cycle(5)]));

    expect(await resolveUserUtcOffsetInfo(client)).toEqual({ offset: "+02:00", fallback: false });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["a timeout", new WhoopNetworkError(Object.assign(new Error("t"), { name: "TimeoutError" }))],
    ["a 429 after the client's own retries", new WhoopApiError(429, "Too Many Requests", null)],
    ["a 401", new WhoopApiError(401, "Unauthorized", null)],
    ["a failed token refresh", new WhoopAuthError(new Error("revoked"))],
  ])("does not retry after %s", async (_label, error) => {
    const { client, get } = mockClient(error, page([cycle(5)]));

    expect(await resolveUserUtcOffsetInfo(client)).toEqual({ offset: "Z", fallback: true });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("reuses the last offset read when a later lookup fails", async () => {
    const failure = new WhoopApiError(503, "", null);
    const { client } = mockClient(page([cycle(5)]), failure, failure);

    await resolveUserUtcOffsetInfo(client);
    vi.advanceTimersByTime(61 * 60_000);
    expect(await resolveUserUtcOffsetInfo(client)).toEqual({ offset: "+02:00", fallback: false });
  });

  it("uses UTC without flagging a fallback for an account with no cycles yet, and does not memoize it", async () => {
    const { client, get } = mockClient(page([]), page([cycle(5)]));

    expect(await resolveUserUtcOffsetInfo(client)).toEqual({ offset: "Z", fallback: false });
    expect(await resolveUserUtcOffsetInfo(client)).toEqual({ offset: "+02:00", fallback: false });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("flags a fallback when the latest cycle has no valid offset", async () => {
    const { client } = mockClient(page([cycle(5, null)]));
    expect(await resolveUserUtcOffsetInfo(client)).toEqual({ offset: "Z", fallback: true });
  });

  it("keeps each client's offset separate", async () => {
    const a = mockClient(page([cycle(5, "+02:00")]));
    const b = mockClient(page([cycle(5, "-05:00")]));

    expect(await resolveUserUtcOffset(a.client)).toBe("+02:00");
    expect(await resolveUserUtcOffset(b.client)).toBe("-05:00");
  });
});

// ---------------------------------------------------------------------------
// Regressions with the real client and a shared MemoryCache
// ---------------------------------------------------------------------------

describe("offset lookup with the real client and shared cache", () => {
  let upstream: Array<Record<string, unknown>>;
  let failNextOffsetLookup: boolean;
  let offsetLookups: number;

  beforeEach(() => {
    vi.useFakeTimers({ now: START, toFake: ["Date"] });
    upstream = [cycle(5)];
    failNextOffsetLookup = false;
    offsetLookups = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL): Promise<Response> => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/v2/cycle") && url.searchParams.get("limit") === "1") {
          offsetLookups++;
          if (failNextOffsetLookup) {
            failNextOffsetLookup = false;
            throw new TypeError("fetch failed (ECONNRESET)");
          }
        }
        return new Response(JSON.stringify(page(upstream)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function realClient(): WhoopClient {
    return createWhoopClient({ accessToken: "t", baseUrl: BASE_URL, cache: new MemoryCache() });
  }

  async function readCycleLatest(client: WhoopClient): Promise<Record<string, unknown>> {
    const definition = RESOURCE_DEFINITIONS.find((d) => d.uri === "whoop://v2/user/cycle/latest");
    if (definition === undefined) throw new Error("cycle/latest resource missing");
    return (await definition.fetch(client)) as Record<string, unknown>;
  }

  it("does not make the cycle/latest resource serve strain older than 2 minutes", async () => {
    const client = realClient();
    expect(await resolveUserUtcOffset(client)).toBe("+02:00");

    upstream = [cycle(14.2)];
    vi.advanceTimersByTime(3 * 60_000);
    expect((await readCycleLatest(client)).score).toMatchObject({ strain: 14.2 });
    expect(offsetLookups).toBe(2);

    upstream = [cycle(16.8)];
    vi.advanceTimersByTime(42 * 60_000);
    // The memoized offset needs no request and leaves the resource's entry alone
    expect(await resolveUserUtcOffset(client)).toBe("+02:00");
    expect(offsetLookups).toBe(2);
    expect((await readCycleLatest(client)).score).toMatchObject({ strain: 16.8 });
    expect(offsetLookups).toBe(3);
  });

  it("does not show a finished cycle as in progress after a new one starts", async () => {
    const client = realClient();
    await resolveUserUtcOffset(client);

    upstream = [
      { ...cycle(0.4), id: 4, start: "2026-09-16T21:40:00.000Z" },
      { ...cycle(11.9), end: "2026-09-16T21:40:00.000Z" },
    ];
    vi.advanceTimersByTime(30 * 60_000);
    expect((await readCycleLatest(client)).id).toBe(4);
  });

  it("resolves local days after a transient failure instead of silently using UTC", async () => {
    const client = realClient();
    failNextOffsetLookup = true;

    const query = await buildLocalCollectionQuery(client, {
      start: "2026-09-15",
      end: "2026-09-15",
    });

    const params = new URLSearchParams(query.slice(1));
    expect(params.get("start")).toBe("2026-09-14T22:00:00.000Z");
    expect(params.get("end")).toBe("2026-09-15T21:59:59.999Z");
    expect(offsetLookups).toBe(2);
  });
});
