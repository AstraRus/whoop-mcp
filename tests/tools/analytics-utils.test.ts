import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import {
  WhoopApiError,
  WhoopAuthError,
  WhoopNetworkError,
  WhoopRateBudgetError,
  type WhoopClient,
} from "../../src/api/client.js";
import { sleepRecordSchema } from "../../src/api/record-schemas.js";
import { percentile, circularStats } from "../../src/tools/stats-utils.js";
import {
  cycleDay,
  formatLocalTimestamp,
  loadAnalyticsSource,
  localDay,
  localMidnightMs,
  mostRelevantError,
} from "../../src/tools/analytics-utils.js";
import { sleepFixture } from "../helpers/analytics-fixtures.js";

describe("analytics primitives", () => {
  it("interpolates percentiles without mutating values", () => {
    const values = [30, 0, 10, 20];
    expect(percentile(values, 25)).toBe(7.5);
    expect(percentile(values, 0)).toBe(0);
    expect(percentile(values, 100)).toBe(30);
    expect(values).toEqual([30, 0, 10, 20]);
    expect(() => percentile([], 50)).toThrow();
    expect(() => percentile([1], 101)).toThrow();
    expect(() => percentile([NaN], 50)).toThrow();
  });
  it("handles midnight and undefined antipodal means", () => {
    const result = circularStats([1430, 10]);
    expect(Math.min(result.mean!, 1440 - result.mean!)).toBeCloseTo(0);
    expect(result.sd).toBeCloseTo(10, 0);
    expect(circularStats([0, 720])).toEqual({ mean: null, sd: null });
    expect(circularStats([])).toEqual({ mean: null, sd: null });
  });
  it("uses the recorded offset rather than the host timezone", () => {
    expect(localDay("2026-09-10T01:00:00Z", "-05:00")).toBe("2026-09-09");
    expect(localDay("2026-03-08T06:30:00Z", "-05:00")).toBe("2026-03-08");
    expect(localDay("2026-11-01T06:30:00Z", "-04:00")).toBe("2026-11-01");
  });
});

describe("cycleDay", () => {
  it("assigns a cycle to the local day it covers, not the evening it starts", () => {
    // Live shape: bedtime 23:13 local (+02:00) on the 15th starts the cycle for the 16th
    expect(cycleDay({ start: "2026-09-15T21:13:31.460Z", timezone_offset: "+02:00" })).toBe(
      "2026-09-16"
    );
    // After-midnight bedtime stays on the same local day
    expect(cycleDay({ start: "2026-09-15T23:30:00.000Z", timezone_offset: "+02:00" })).toBe(
      "2026-09-16"
    );
    // The first cycle of a new strap starts at local midnight
    expect(cycleDay({ start: "2026-09-13T22:00:00.000Z", timezone_offset: "+02:00" })).toBe(
      "2026-09-14"
    );
    // 22:00 local bedtime at -05:00 on the 15th covers the 16th
    expect(cycleDay({ start: "2026-09-16T03:00:00.000Z", timezone_offset: "-05:00" })).toBe(
      "2026-09-16"
    );
  });
});

describe("formatLocalTimestamp", () => {
  it("writes the wall-clock time in the offset so the date part is the local date", () => {
    const ms = Date.parse("2026-09-13T22:00:00.000Z");
    expect(formatLocalTimestamp(ms, "+02:00")).toBe("2026-09-14T00:00:00.000+02:00");
    expect(formatLocalTimestamp(ms, "-05:30")).toBe("2026-09-13T16:30:00.000-05:30");
    expect(formatLocalTimestamp(ms, "Z")).toBe("2026-09-13T22:00:00.000Z");
    expect(Date.parse(formatLocalTimestamp(ms, "+02:00"))).toBe(ms);
    expect(() => formatLocalTimestamp(ms, "CET")).toThrow();
  });

  it("finds local midnight of a day in an offset", () => {
    expect(new Date(localMidnightMs("2026-09-14", "+02:00")).toISOString()).toBe(
      "2026-09-13T22:00:00.000Z"
    );
    expect(new Date(localMidnightMs("2026-09-14", "-05:00")).toISOString()).toBe(
      "2026-09-14T05:00:00.000Z"
    );
  });
});

describe("loadAnalyticsSource", () => {
  const PERIOD = { start: "2026-08-01T00:00:00.000Z", end: "2026-09-10T12:00:00.000Z" };
  const sleeps = Array.from({ length: 40 }, (_, index) => sleepFixture(index));

  function pagedClient(later: () => unknown, first?: () => unknown): WhoopClient {
    return {
      get: vi.fn(async (path: string) => {
        if (!path.includes("nextToken=")) {
          return first ? first() : { records: sleeps.slice(0, 25), next_token: "p2" };
        }
        return later();
      }),
    } as unknown as WhoopClient;
  }

  it("reads every page", async () => {
    const source = await loadAnalyticsSource(
      pagedClient(() => ({ records: sleeps.slice(25), next_token: null })),
      "/v2/activity/sleep",
      PERIOD,
      sleepRecordSchema
    );
    expect(source.records).toHaveLength(40);
    expect(source.quality.truncated).toBe(false);
    expect(source.partialError).toBeUndefined();
  });

  it.each([
    ["a rate-limited", new WhoopApiError(429, "Too Many Requests", null)],
    ["a network failure on", new WhoopNetworkError(new Error("ECONNRESET"))],
  ])("keeps page 1 and marks the source partial after %s later page", async (_label, error) => {
    const source = await loadAnalyticsSource(
      pagedClient(() => {
        throw error;
      }),
      "/v2/activity/sleep",
      PERIOD,
      sleepRecordSchema
    );
    expect(source.records).toHaveLength(25);
    expect(source.quality).toMatchObject({ records_fetched: 25, truncated: true });
    expect(source.quality.status).not.toBe("fetch_failed");
    expect(source.partialError).toBe(error);
    expect(source.error).toBeUndefined();
  });

  it("keeps page 1 when a later page is malformed", async () => {
    const source = await loadAnalyticsSource(
      pagedClient(() => ({ records: null, next_token: null })),
      "/v2/activity/sleep",
      PERIOD,
      sleepRecordSchema
    );
    expect(source.records).toHaveLength(25);
    expect(source.quality.truncated).toBe(true);
    expect(source.quality.status).not.toBe("invalid");
    expect(source.partialError).toBeInstanceOf(z.ZodError);
  });

  it("still fails the source when the first page fails or is malformed", async () => {
    const failure = new WhoopApiError(429, "Too Many Requests", null);
    const failed = await loadAnalyticsSource(
      pagedClient(
        () => ({ records: [], next_token: null }),
        () => {
          throw failure;
        }
      ),
      "/v2/activity/sleep",
      PERIOD,
      sleepRecordSchema
    );
    expect(failed).toMatchObject({ records: [], error: failure });
    expect(failed.quality).toMatchObject({ status: "fetch_failed", truncated: false });
    expect(failed.partialError).toBeUndefined();

    const malformed = await loadAnalyticsSource(
      pagedClient(
        () => ({ records: [], next_token: null }),
        () => ({ records: "invalid" })
      ),
      "/v2/activity/sleep",
      PERIOD,
      sleepRecordSchema
    );
    expect(malformed.records).toEqual([]);
    expect(malformed.quality.status).toBe("invalid");
  });
});

describe("mostRelevantError", () => {
  const auth = new WhoopAuthError(new Error("refresh failed"));
  const unauthorized = new WhoopApiError(401, "Unauthorized", null);
  const rateLimited = new WhoopApiError(429, "Too Many Requests", null);
  const serverError = new WhoopApiError(500, "Internal Server Error", null);
  const network = new WhoopNetworkError(new Error("socket hang up"));
  const budget = new WhoopRateBudgetError();

  it("prefers auth, then 401/403, then rate limits, then other API errors, then network", () => {
    expect(mostRelevantError([network, serverError, rateLimited, unauthorized, auth])).toBe(auth);
    expect(mostRelevantError([network, serverError, rateLimited, unauthorized])).toBe(unauthorized);
    expect(mostRelevantError([network, serverError, rateLimited])).toBe(rateLimited);
    expect(mostRelevantError([network, serverError])).toBe(serverError);
  });

  it("ranks the server's request budget like a WHOOP 429, ahead of other API and network errors", () => {
    expect(mostRelevantError([network, budget])).toBe(budget);
    expect(mostRelevantError([serverError, budget])).toBe(budget);
    const wrapped = new WhoopNetworkError(budget);
    expect(mostRelevantError([network, wrapped])).toBe(wrapped);
    expect(mostRelevantError([budget, unauthorized])).toBe(unauthorized);
  });

  it("wraps a reason that is not an Error", () => {
    const error = mostRelevantError(["boom"]);
    expect(error.message).toBe("All WHOOP requests failed.");
    expect(error.cause).toBe("boom");
  });
});
