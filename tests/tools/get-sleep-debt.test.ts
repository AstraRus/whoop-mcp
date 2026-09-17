import { describe, it, expect, vi, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { getSleepDebt, sleepDebtOutputSchema } from "../../src/tools/get-sleep-debt.js";
import { WhoopApiError, WhoopNetworkError, type WhoopClient } from "../../src/api/client.js";
import type { Sleep } from "../../src/api/types.js";
import { createWhoopServer } from "../../src/server.js";
import { InvalidDateExpression } from "../../src/tools/date-utils.js";
import { runSleepAnalysis } from "../../src/tools/get-sleep-analysis.js";
import type { Logger } from "../../src/logging/logger.js";
import { aggregateOutputSchemas } from "../../src/tools/output-contracts.js";
import { analyticsClient, ANALYTICS_NOW, sleepFixture } from "../helpers/analytics-fixtures.js";
import { MAX_TOOL_TEXT_CHARS } from "../../src/tools/tool-definition.js";
import { assertNeutralText, connectServer } from "../helpers/contract.js";
import { createWhoopFixtureClient } from "../helpers/whoop-fixture-client.js";
import {
  liveShapedUser,
  MATURE_USER_NOW,
  matureUser,
  stressUser,
  type WhoopUserFixture,
} from "../helpers/whoop-users.js";

// ---------------------------------------------------------------------------
// Live-shaped fixtures: a new user at +02:00 who started wearing WHOOP on
// Monday evening. Cycles start at sleep onset, the current cycle has end:null,
// WHOOP returns newest first and the last page carries next_token:null.
// ---------------------------------------------------------------------------

const LIVE_NOW = new Date("2026-09-16T10:00:00.000Z"); // 12:00 local

function liveSleep(
  id: string,
  cycleId: number,
  start: string,
  end: string,
  score: Partial<NonNullable<Sleep["score"]>> = {}
): Sleep {
  return {
    id,
    cycle_id: cycleId,
    v1_id: null,
    user_id: 7,
    created_at: end,
    updated_at: end,
    start,
    end,
    timezone_offset: "+02:00",
    nap: false,
    score_state: "SCORED",
    score: {
      stage_summary: {
        total_in_bed_time_milli: 28_800_000,
        total_awake_time_milli: 1_800_000,
        total_no_data_time_milli: 0,
        total_light_sleep_time_milli: 14_400_000,
        total_slow_wave_sleep_time_milli: 5_400_000,
        total_rem_sleep_time_milli: 7_200_000,
        sleep_cycle_count: 5,
        disturbance_count: 12,
      },
      sleep_needed: {
        baseline_milli: 28_800_000,
        need_from_sleep_debt_milli: 3_600_000,
        need_from_recent_strain_milli: 1_800_000,
        need_from_recent_nap_milli: 0,
      },
      respiratory_rate: 15.2,
      sleep_performance_percentage: 81,
      sleep_efficiency_percentage: 93,
      sleep_consistency_percentage: 0,
      ...score,
    },
  };
}

/** The two nights recorded so far, newest first. */
function liveSleeps(): Sleep[] {
  return [
    liveSleep("s2", 3, "2026-09-15T21:13:31.460Z", "2026-09-16T05:13:59.350Z", {
      respiratory_rate: null,
      sleep_performance_percentage: null,
      sleep_efficiency_percentage: null,
    }),
    liveSleep("s1", 2, "2026-09-14T20:30:00.000Z", "2026-09-15T04:30:00.000Z"),
  ];
}

const LIVE_CYCLE = {
  id: 3,
  user_id: 7,
  created_at: "2026-09-15T21:13:31.460Z",
  updated_at: "2026-09-16T06:00:00.000Z",
  start: "2026-09-15T21:13:31.460Z",
  end: null,
  timezone_offset: "+02:00",
  score_state: "SCORED",
  score: { strain: 6.1, kilojoule: 5000, average_heart_rate: 64, max_heart_rate: 140 },
};

/**
 * Fake WHOOP API serving each endpoint as the given pages; the last page has
 * next_token:null. The `limit=1` cycle lookup (user offset) returns the newest cycle.
 */
function liveClient(pages: Record<string, unknown[][]>): WhoopClient {
  return {
    get: vi.fn(async (path: string) => {
      const [base = "", query = ""] = path.split("?");
      const params = new URLSearchParams(query);
      if (base === "/v2/cycle" && params.get("limit") === "1")
        return { records: [LIVE_CYCLE], next_token: "more" };
      const chunks = pages[base] ?? [[]];
      const index = Number(params.get("nextToken") ?? 0);
      return {
        records: chunks[index],
        next_token: index + 1 < chunks.length ? String(index + 1) : null,
      };
    }),
  } as unknown as WhoopClient;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("getSleepDebt", () => {
  it("resolves relative dates against the injected evaluation clock", async () => {
    const result = await getSleepDebt(
      analyticsClient(),
      { start: "yesterday", days: 3 },
      new Date("2026-08-10T12:00:00Z")
    );
    // The fixtures' newest cycle is at +00:00, so the period is written in that offset.
    expect(result.period.start).toBe("2026-08-09T00:00:00.000+00:00");
  });

  it.each([
    { records: "invalid" },
    {},
    { records: [], next_token: 42 },
    { records: [{ id: "not-a-sleep" }], next_token: null },
  ])("reports unreadable data %j as unavailable, not as insufficient data", async (page) => {
    const result = await getSleepDebt(
      analyticsClient(0, { "/v2/activity/sleep": page }),
      {},
      ANALYTICS_NOW
    );
    expect(result.status).toBe("unavailable");
    expect(result.data_quality.sources.sleep?.status).toBe("invalid");
    expect(result.nights_analyzed).toBe(0);
    expect(result.total_debt_hours).toBeNull();
    expect(result.notes[0]).toContain("Sleep data could not be read");
    expect(result.summary).toContain("could not be read");
    expect(result.summary).not.toMatch(/not enough data|insufficient/i);
    expect(sleepDebtOutputSchema.safeParse(result).success).toBe(true);
  });

  it("rethrows the underlying failure when the sleep request fails", async () => {
    const failure = new WhoopNetworkError(new Error("down"));
    await expect(
      getSleepDebt(analyticsClient(0, { "/v2/activity/sleep": failure }), {}, ANALYTICS_NOW)
    ).rejects.toBe(failure);
  });

  it("preserves nap adjustment, uses asleep stages, and separates standing debt", async () => {
    const result = await getSleepDebt(analyticsClient(4), {}, ANALYTICS_NOW);
    expect(result.nights[0]).toMatchObject({ needed_hours: 8, achieved_hours: 7, debt_hours: 1 });
    expect(result.total_debt_hours).toBe(4);
    expect(result.standing_debt_hours).toBe(5);
    expect(result.consistency.bedtime_std_dev_minutes).toBeCloseTo(0);
    expect(result.status).toBe("available");
    // Four weekday nights (Monday to Thursday) and no weekend night: no social jetlag.
    expect(result.consistency.social_jetlag_minutes).toBeNull();
    expect(result.notes).toEqual([
      "Weekday and weekend midpoints need 2 nights each (weekday 4, weekend 0); social jetlag is null until both have them.",
    ]);
    expect(result.summary).toContain("not outstanding debt");
    expect(result.summary).not.toContain("Social jetlag");
  });
  it("excludes naps and pending scores, picks longest main sleep per day", async () => {
    const records = [
      sleepFixture(1),
      sleepFixture(2),
      sleepFixture(3),
      { ...sleepFixture(1), id: "nap", nap: true },
      { ...sleepFixture(4), score_state: "PENDING_SCORE" },
      { ...sleepFixture(1), id: "short", start: "2026-09-09T05:00:00Z" },
    ];
    const result = await getSleepDebt(
      analyticsClient(0, { "/v2/activity/sleep": { records } }),
      {},
      ANALYTICS_NOW
    );
    expect(result.nights_analyzed).toBe(3);
    expect(result.total_debt_hours).toBe(3);
    expect(result.data_quality.sources.sleep?.exclusions.nap).toBe(1);
    expect(result.data_quality.sources.sleep?.exclusions.pending).toBe(1);
    expect(result.notes).toContain("1 sleep is still being scored by WHOOP and not counted yet.");
  });
  it("returns null aggregates for insufficient data and says how many nights exist", async () => {
    const result = await getSleepDebt(analyticsClient(2), {}, ANALYTICS_NOW);
    expect(result.total_debt_hours).toBeNull();
    expect(result.avg_nightly_debt_hours).toBeNull();
    expect(result.status).toBe("insufficient_data");
    expect(result.nights_required).toBe(3);
    expect(result.consistency.social_jetlag_minutes).toBeNull();
    expect(result.nights).toHaveLength(2);
    expect(result.notes[0]).toContain("Not enough data yet: 2 of 3 required scored main sleeps");
    expect(result.summary).toContain("Not enough data yet: 2 of 3");
    expect(result.data_quality.sources.sleep?.status).toBe("available");
  });

  it("keeps weekend-only social jetlag null and treats surplus as zero deficit", async () => {
    const records = [4, 11, 18].map((index) => sleepFixture(index));
    for (const record of records) record.score!.sleep_needed.baseline_milli = 14_400_000;
    const result = await getSleepDebt(
      analyticsClient(0, { "/v2/activity/sleep": { records } }),
      { days: 30 },
      ANALYTICS_NOW
    );
    expect(result.nights_analyzed).toBe(3);
    expect(result.total_debt_hours).toBe(0);
    expect(result.consistency.social_jetlag_minutes).toBeNull();
  });

  it("rejects invalid needs and preserves missing-night counts", async () => {
    const invalid = sleepFixture(1);
    invalid.score!.sleep_needed.need_from_recent_nap_milli = -100_000_000;
    const result = await getSleepDebt(
      analyticsClient(0, {
        "/v2/activity/sleep": { records: [invalid, sleepFixture(2), sleepFixture(5)] },
      }),
      {},
      ANALYTICS_NOW
    );
    expect(result.nights_analyzed).toBe(2);
    expect(result.total_debt_hours).toBeNull();
    expect(result.data_quality.sources.sleep?.exclusions.invalid_need).toBe(1);
    expect(result.status).toBe("insufficient_data");
    expect(result.notes.join(" ")).toContain("invalid WHOOP sleep-need value");
  });
  it("skips individual malformed records without hiding the valid ones", async () => {
    const result = await getSleepDebt(
      analyticsClient(0, {
        "/v2/activity/sleep": {
          records: [sleepFixture(1), { id: "broken" }, sleepFixture(2), sleepFixture(3)],
          next_token: null,
        },
      }),
      {},
      ANALYTICS_NOW
    );
    expect(result.status).toBe("available");
    expect(result.nights_analyzed).toBe(3);
    expect(result.notes).toContain(
      "1 sleep record did not match the expected format and was skipped."
    );
  });
  it("caps echoed nights without reducing the analyzed set", async () => {
    const result = await getSleepDebt(analyticsClient(60), { days: 90 }, ANALYTICS_NOW);
    expect(result.nights).toHaveLength(30);
    expect(result.nights_analyzed).toBe(60);
    expect(result.output_capped).toBe(true);
    expect(result.truncated).toBe(false);
  });
  it("rejects future starts and returns resolved historical windows", async () => {
    await expect(
      getSleepDebt(analyticsClient(), { start: "2027-01-01" }, ANALYTICS_NOW)
    ).rejects.toThrow();
    const result = await getSleepDebt(
      analyticsClient(),
      { start: "2026-09-01", days: 3 },
      ANALYTICS_NOW
    );
    // The exclusive window end (09-04 00:00) is reported as the last millisecond it covers.
    expect(result.period).toEqual({
      start: "2026-09-01T00:00:00.000+00:00",
      end: "2026-09-03T23:59:59.999+00:00",
    });
    expect(result.data_quality.requested_period).toEqual(result.period);
  });
  it("surfaces pagination truncation in notes", async () => {
    const result = await getSleepDebt(
      analyticsClient(0, {
        "/v2/activity/sleep": {
          records: Array.from({ length: 501 }, (_, index) => sleepFixture(index % 90)),
          next_token: "more",
        },
      }),
      { days: 90 },
      ANALYTICS_NOW
    );
    expect(result.truncated).toBe(true);
    expect(result.notes.join(" ")).toContain("Partial history");
  });
});

describe("getSleepDebt with a new, calibrating user (live shape)", () => {
  it("reads the final page (next_token: null) and explains the sparse history", async () => {
    const result = await getSleepDebt(
      liveClient({ "/v2/activity/sleep": [liveSleeps()] }),
      {},
      LIVE_NOW
    );
    expect(result.data_quality.sources.sleep).toMatchObject({
      status: "available",
      records_fetched: 2,
      records_used: 2,
      exclusions: {},
    });
    expect(result.status).toBe("insufficient_data");
    expect(result.nights_analyzed).toBe(2);
    expect(result.nights.map((night) => night.date)).toEqual(["2026-09-16", "2026-09-15"]);
    expect(result.nights[0]).toMatchObject({ needed_hours: 8.5, achieved_hours: 7.5 });
    expect(result.nights[0]!.debt_hours).toBeCloseTo(1);
    expect(result.standing_debt_hours).toBe(1);
    expect(result.standing_debt_date).toBe("2026-09-16");
    expect(result.total_debt_hours).toBeNull();
    expect(result.consistency.bedtime_std_dev_minutes).toBeNull();
    expect(result.notes).toEqual([
      "Not enough data yet: 2 of 3 required scored main sleeps in this window, so deficit totals and bedtime/wake consistency are not calculated.",
    ]);
    expect(sleepDebtOutputSchema.safeParse(result).success).toBe(true);
  });

  it("follows every page up to the one with next_token: null", async () => {
    const [newest, older] = liveSleeps();
    const third = liveSleep("s0", 1, "2026-09-13T20:00:00.000Z", "2026-09-14T04:00:00.000Z");
    const client = liveClient({ "/v2/activity/sleep": [[newest], [older, third]] });
    const result = await getSleepDebt(client, {}, LIVE_NOW);
    expect(result.data_quality.sources.sleep?.records_fetched).toBe(3);
    expect(result.status).toBe("available");
    expect(result.nights_analyzed).toBe(3);
    expect(result.total_debt_hours).not.toBeNull();
    // Monday to Wednesday wake days only.
    expect(result.notes).toEqual([
      "Weekday and weekend midpoints need 2 nights each (weekday 3, weekend 0); social jetlag is null until both have them.",
    ]);
  });

  it("notes a night that WHOOP is still scoring", async () => {
    const pending: Sleep = {
      ...liveSleep("s3", 4, "2026-09-16T21:00:00.000Z", "2026-09-17T05:00:00.000Z"),
      score_state: "PENDING_SCORE",
      score: null,
    };
    const result = await getSleepDebt(
      liveClient({ "/v2/activity/sleep": [[pending, ...liveSleeps()]] }),
      {},
      new Date("2026-09-17T06:00:00.000Z")
    );
    expect(result.nights_analyzed).toBe(2);
    expect(result.notes).toContain("1 sleep is still being scored by WHOOP and not counted yet.");
  });

  it("resolves a date-only start at the user's local midnight", async () => {
    const result = await getSleepDebt(
      liveClient({ "/v2/activity/sleep": [liveSleeps()] }),
      { start: "2026-09-14", days: 3 },
      LIVE_NOW
    );
    expect(result.period.start).toBe("2026-09-14T00:00:00.000+02:00");
    expect(result.period.end).toBe("2026-09-16T12:00:00.000+02:00");
    expect(result.nights_analyzed).toBe(2);
    expect(result.data_quality.observed_period).toEqual({
      start: "2026-09-15T06:30:00.000+02:00",
      end: "2026-09-16T07:13:59.350+02:00",
    });
  });

  describe("a range expression in start covers that range", () => {
    const AFTERNOON = new Date("2026-09-16T13:00:00.000Z"); // 15:00 local, Wednesday

    it.each(["last 14 days", "this month", "this week", "last 2 weeks", "last 7 days"])(
      "%s includes this morning's night and ends now",
      async (start) => {
        const result = await getSleepDebt(
          liveClient({ "/v2/activity/sleep": [liveSleeps()] }),
          { start },
          AFTERNOON
        );
        expect(result.nights_analyzed).toBe(2);
        expect(result.standing_debt_date).toBe("2026-09-16");
        expect(result.period.end).toBe("2026-09-16T15:00:00.000+02:00");
      }
    );

    it("this month starts on the 1st at local midnight", async () => {
      const result = await getSleepDebt(
        liveClient({ "/v2/activity/sleep": [liveSleeps()] }),
        { start: "this month" },
        AFTERNOON
      );
      expect(result.period.start).toBe("2026-09-01T00:00:00.000+02:00");
    });

    it("last week covers last Monday to Sunday only", async () => {
      const result = await getSleepDebt(
        liveClient({ "/v2/activity/sleep": [liveSleeps()] }),
        { start: "last week" },
        AFTERNOON
      );
      expect(result.period).toEqual({
        start: "2026-09-07T00:00:00.000+02:00",
        end: "2026-09-13T23:59:59.999+02:00",
      });
      expect(result.nights_analyzed).toBe(0);
      expect(result.standing_debt_date).toBeNull();
    });

    it("uses the range's first day plus an explicit days", async () => {
      const result = await getSleepDebt(
        liveClient({ "/v2/activity/sleep": [liveSleeps()] }),
        { start: "last week", days: 9 },
        AFTERNOON
      );
      expect(result.period).toEqual({
        start: "2026-09-07T00:00:00.000+02:00",
        end: "2026-09-15T23:59:59.999+02:00",
      });
      expect(result.nights.map((night) => night.date)).toEqual(["2026-09-15"]);
    });

    it("keeps start + days for a single day", async () => {
      const result = await getSleepDebt(
        liveClient({ "/v2/activity/sleep": [liveSleeps()] }),
        { start: "yesterday" },
        AFTERNOON
      );
      expect(result.period.start).toBe("2026-09-15T00:00:00.000+02:00");
      expect(result.nights_analyzed).toBe(2);
    });

    it("rejects a range longer than 90 days plus today", async () => {
      const client = liveClient({ "/v2/activity/sleep": [liveSleeps()] });
      await expect(getSleepDebt(client, { start: "last 6 months" }, AFTERNOON)).rejects.toThrow(
        InvalidDateExpression
      );
      const longest = await getSleepDebt(client, { start: "last 90 days" }, AFTERNOON);
      expect(longest.period.start).toBe("2026-06-18T00:00:00.000+02:00");
    });
  });

  it.each([
    ["a rate-limited", new WhoopApiError(429, "Too Many Requests", null)],
    ["a malformed", { records: null, next_token: null }],
  ])("keeps the sleeps already read when %s later page fails", async (_label, failure) => {
    const [newest, older] = liveSleeps();
    const client = {
      get: vi.fn(async (path: string) => {
        if (path.startsWith("/v2/cycle")) return { records: [LIVE_CYCLE], next_token: null };
        if (!path.includes("nextToken=")) return { records: [newest, older], next_token: "p2" };
        if (failure instanceof Error) throw failure;
        return failure;
      }),
    } as unknown as WhoopClient;
    const result = await getSleepDebt(client, {}, LIVE_NOW);
    expect(result.status).toBe("insufficient_data");
    expect(result.nights_analyzed).toBe(2);
    expect(result.truncated).toBe(true);
    expect(result.data_quality.sources.sleep).toMatchObject({
      status: "available",
      records_fetched: 2,
      truncated: true,
    });
    expect(result.notes).toContain(
      "Partial history: a later page of sleep data could not be read from WHOOP, so older sleeps in the window were not included. Retry for a complete result."
    );
    expect(result.summary).toContain("Partial history: older sleeps could not be read.");
  });
});

describe("get_sleep_debt through the MCP server", () => {
  async function call(
    whoop: WhoopClient,
    privacyMode: "standard" | "aggregate",
    args: Record<string, unknown> = {},
    now: Date = LIVE_NOW
  ): Promise<{ isError?: boolean; structuredContent?: unknown; text: string }> {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const { server } = createWhoopServer(whoop, { privacyMode, disableResources: true });
    const client = new Client({ name: "sleep-debt-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({ name: "get_sleep_debt", arguments: args });
      const text = (result.content as Array<{ text: string }>)[0]!.text;
      return {
        isError: result.isError as boolean | undefined,
        structuredContent: result.structuredContent,
        text,
      };
    } finally {
      await client.close();
      await server.close();
    }
  }

  it("passes the standard contract for the calibrating user", async () => {
    const result = await call(liveClient({ "/v2/activity/sleep": [liveSleeps()] }), "standard");
    expect(result.isError, result.text).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      status: "insufficient_data",
      nights_analyzed: 2,
      nights_required: 3,
    });
  });

  it("keeps status and notes in aggregate mode without per-night data", async () => {
    const result = await call(liveClient({ "/v2/activity/sleep": [liveSleeps()] }), "aggregate");
    expect(result.isError, result.text).toBeFalsy();
    const data = result.structuredContent as Record<string, unknown>;
    expect(aggregateOutputSchemas.get_sleep_debt!.safeParse(data).success).toBe(true);
    // Both nights are in the current week, which is not released yet.
    expect(data).toMatchObject({
      status: "insufficient_data",
      nights_analyzed: 0,
      nights_required: 3,
    });
    expect(data.notes).toEqual([
      "Aggregate privacy mode uses whole released weeks: 2 weeks ending 2026-09-13.",
      "Not enough data yet: 0 of 3 required scored main sleeps in released weeks with at least 3 each, so deficit totals and bedtime/wake consistency are not calculated.",
    ]);
    for (const hidden of ['"nights"', "standing_debt", "summary", "T05:13", "2026-09-15"])
      expect(result.text).not.toContain(hidden);
  });

  it.each([
    // days snap to 2, 4, 8 or 12 released weeks; start is ignored.
    [{ start: "2026-09-14", days: 3 }, LIVE_NOW, { start: "2026-08-31", end: "2026-09-13" }],
    [{ start: "yesterday", days: 3 }, LIVE_NOW, { start: "2026-08-31", end: "2026-09-13" }],
    [{ days: 3 }, new Date("2026-09-16T23:30:00.000Z"), { start: "2026-08-31", end: "2026-09-13" }],
    [{ start: "last week" }, LIVE_NOW, { start: "2026-08-31", end: "2026-09-13" }],
    [{ days: 30 }, LIVE_NOW, { start: "2026-07-20", end: "2026-09-13" }],
    [{ days: 90 }, LIVE_NOW, { start: "2026-06-22", end: "2026-09-13" }],
    // Tuesday 23:30 local: the week of 09-07 is not released until Wednesday.
    [{}, new Date("2026-09-15T21:30:00.000Z"), { start: "2026-08-24", end: "2026-09-06" }],
  ])(
    "labels the aggregate period for %j with whole released weeks",
    async (args, now, expected) => {
      const result = await call(
        liveClient({ "/v2/activity/sleep": [liveSleeps()] }),
        "aggregate",
        args,
        now
      );
      expect(result.isError, result.text).toBeFalsy();
      const data = result.structuredContent as {
        period: unknown;
        data_quality: { requested_period: unknown };
      };
      expect(data.period).toEqual(expected);
      expect(data.data_quality.requested_period).toEqual(expected);
    }
  );

  it("explains unreadable data in aggregate mode", async () => {
    const result = await call(
      { get: vi.fn(async () => ({ records: "invalid" })) } as unknown as WhoopClient,
      "aggregate"
    );
    expect(result.isError, result.text).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      status: "unavailable",
      // Every request fails here, so the time-zone fallback note is added too
      notes: expect.arrayContaining([
        expect.stringContaining("Sleep or cycle data for these weeks could not be read completely"),
        expect.stringContaining("time zone could not be read"),
      ]),
    });
  });
});

describe("get_sleep_debt on the shared fixture users", () => {
  async function call(
    data: WhoopUserFixture,
    privacyMode: "standard" | "aggregate",
    args: Record<string, unknown> = {}
  ): Promise<{ isError: boolean; text: string; structured: Record<string, unknown> | null }> {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(data.now);
    const connection = await connectServer(createWhoopFixtureClient(data), {
      privacyMode,
      disableResources: true,
    });
    try {
      return await connection.callTool("get_sleep_debt", args);
    } finally {
      await connection.close();
    }
  }

  it("reports rounded deficits over two released weeks of a mature account in aggregate mode", async () => {
    const data = matureUser();
    const aggregate = await call(data, "aggregate");
    expect(aggregate.isError, aggregate.text).toBe(false);
    const report = aggregate.structured as {
      nights_analyzed: number;
      total_debt_hours: number;
      avg_nightly_debt_hours: number;
      consistency: Record<string, number>;
      data_quality: { sources: Record<string, { records_used: number }> };
    };
    expect(report).toMatchObject({
      period: { start: "2026-08-31", end: "2026-09-13" },
      nights_analyzed: 14,
      status: "available",
    });
    expect(Math.round(report.total_debt_hours * 10) / 10).toBe(report.total_debt_hours);
    for (const value of Object.values(report.consistency))
      expect(Number.isInteger(value)).toBe(true);
    expect(report.data_quality.sources.sleep!.records_used).toBe(14);
    expect(aggregate.text).not.toMatch(/T\d{2}:\d{2}|standing_debt|"nights"/);
    assertNeutralText(aggregate.structured);

    // Standard mode over the same local days lists nights with the same total (unrounded).
    const standard = await call(data, "standard", { start: "2026-08-31", days: 14 });
    const nights = standard.structured!.nights as Array<{ date: string; debt_hours: number }>;
    const total = nights
      .filter((night) => night.date >= "2026-08-31" && night.date <= "2026-09-13")
      .reduce((sum, night) => sum + night.debt_hours, 0);
    expect(report.total_debt_hours).toBe(Math.round(total * 10) / 10);
  });

  it("leaves out a released week with fewer than 3 scored nights", async () => {
    const data = matureUser();
    // Keep only 2 main sleeps waking in the week of 2026-08-31.
    let kept = 0;
    const sleeps = data.sleeps.filter((sleep) => {
      const wake = new Date(Date.parse(sleep.end) + 60 * 60_000).toISOString().slice(0, 10);
      if (sleep.nap || wake < "2026-08-31" || wake > "2026-09-06") return true;
      kept += 1;
      return kept <= 2;
    });
    const result = await call({ ...data, sleeps }, "aggregate");
    expect(result.structured).toMatchObject({ nights_analyzed: 7 });
    expect(result.structured!.notes).toContain(
      "1 week with fewer than 3 scored nights is left out."
    );
  });

  it("still rejects an unrecognized start in aggregate mode", async () => {
    const result = await call(matureUser(), "aggregate", { start: "banana" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^Unrecognized date expression/);
  });

  it("explains the calibrating live-shaped user in both modes with neutral wording", async () => {
    for (const mode of ["standard", "aggregate"] as const) {
      const result = await call(liveShapedUser(), mode);
      expect(result.isError, result.text).toBe(false);
      expect(result.structured?.status).toBe("insufficient_data");
      assertNeutralText(result.structured);
    }
  });

  it("stays within the text size limit at 90 days on the stress user in both modes", async () => {
    for (const mode of ["standard", "aggregate"] as const) {
      const result = await call(stressUser(), mode, { days: 90 });
      expect(result.isError, result.text.slice(0, 200)).toBe(false);
      expect(result.text.length).toBeLessThan(MAX_TOOL_TEXT_CHARS);
    }
  });
});

describe("get_sleep_debt social jetlag group minimums", () => {
  const MINUTE_MS = 60_000;
  const AGGREGATE_JETLAG_NOTE =
    "Social jetlag needs at least 3 weekday and 3 weekend nights in the released weeks, so it is null.";

  /** Local wake day of a sleep in its own recorded offset. */
  function wakeDay(sleep: Sleep): string {
    const match = /^([+-])(\d{2}):(\d{2})$/.exec(sleep.timezone_offset)!;
    const offset = (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
    return new Date(Date.parse(sleep.end) + offset * MINUTE_MS).toISOString().slice(0, 10);
  }

  function mainSleepWaking(data: WhoopUserFixture, day: string): Sleep {
    const sleep = data.sleeps.find((record) => !record.nap && wakeDay(record) === day);
    if (!sleep) throw new Error(`no main sleep waking on ${day}`);
    return sleep;
  }

  /** Move a night's wake time by `minutes` (as light sleep), keeping its wake day. */
  function shiftWake(data: WhoopUserFixture, day: string, minutes: number): void {
    const sleep = mainSleepWaking(data, day);
    sleep.end = new Date(Date.parse(sleep.end) + minutes * MINUTE_MS).toISOString();
    sleep.score!.stage_summary.total_in_bed_time_milli += minutes * MINUTE_MS;
    sleep.score!.stage_summary.total_light_sleep_time_milli += minutes * MINUTE_MS;
  }

  function markUnscorable(data: WhoopUserFixture, day: string): void {
    const sleep = mainSleepWaking(data, day);
    sleep.score_state = "UNSCORABLE";
    sleep.score = undefined;
  }

  async function aggregate(
    data: WhoopUserFixture,
    days: number
  ): Promise<Awaited<ReturnType<typeof getSleepDebt>>> {
    return getSleepDebt(createWhoopFixtureClient(data), { days }, data.now, {
      privacyMode: "aggregate",
    });
  }

  it.each([0, 40])(
    "keeps aggregate social jetlag null with a single weekday night group (Friday wake +%i min)",
    async (shift) => {
      // Data from Thursday 2026-09-10: the released week 09-07..09-13 has two weekday nights.
      const data = matureUser({ days: 7, splitNightDays: [] });
      expect(data.now.getTime()).toBe(Date.parse(MATURE_USER_NOW));
      if (shift) shiftWake(data, "2026-09-11", shift);
      const result = await aggregate(data, 14);
      expect(result.status).toBe("available");
      expect(result.consistency.bedtime_std_dev_minutes).not.toBeNull();
      expect(result.consistency.waketime_std_dev_minutes).not.toBeNull();
      expect(result.consistency.social_jetlag_minutes).toBeNull();
      expect(result.notes).toContain(AGGREGATE_JETLAG_NOTE);
      expect(aggregateOutputSchemas.get_sleep_debt!.safeParse(result).success).toBe(true);
      assertNeutralText(result);
    }
  );

  it.each([
    ["as generated (2 weekend nights)", false],
    ["with the Sunday night unscorable (1 weekend night)", true],
  ])("keeps aggregate social jetlag null for a Monday-start account %s", async (_label, drop) => {
    const data = matureUser({
      days: 10,
      now: "2026-09-23T23:30:00+02:00",
      offsetChange: null,
      splitNightDays: [],
    });
    if (drop) markUnscorable(data, "2026-09-20");
    const result = await aggregate(data, 14);
    expect(result.status).toBe("available");
    expect(result.consistency.bedtime_std_dev_minutes).not.toBeNull();
    expect(result.consistency.social_jetlag_minutes).toBeNull();
    expect(result.notes).toContain(AGGREGATE_JETLAG_NOTE);
  });

  it("releases aggregate social jetlag with at least 3 nights in each group, without the note", async () => {
    const result = await aggregate(matureUser(), 14);
    expect(result.status).toBe("available");
    expect(result.consistency.social_jetlag_minutes).not.toBeNull();
    expect(result.notes).not.toContain(AGGREGATE_JETLAG_NOTE);
  });

  it("does not add the aggregate jetlag note when there is not enough data", async () => {
    const result = await aggregate(liveShapedUser(), 14);
    expect(result.status).toBe("insufficient_data");
    expect(result.notes).not.toContain(AGGREGATE_JETLAG_NOTE);
  });

  it("keeps standard social jetlag null with 4 weekday and 1 weekend nights, as get_sleep_analysis", async () => {
    // Wake days Thursday 09-10 back to Sunday 09-06.
    const debt = await getSleepDebt(analyticsClient(5), { days: 7 }, ANALYTICS_NOW);
    const analysis = await runSleepAnalysis(
      { days: 7 },
      {
        client: analyticsClient(5),
        privacyMode: "standard",
        now: () => ANALYTICS_NOW,
        startedAtMs: Date.now(),
      }
    );
    const note =
      "Weekday and weekend midpoints need 2 nights each (weekday 4, weekend 1); social jetlag is null until both have them.";
    expect(debt.status).toBe("available");
    expect(debt.consistency.bedtime_std_dev_minutes).not.toBeNull();
    expect(debt.consistency.social_jetlag_minutes).toBeNull();
    expect(debt.notes).toContain(note);
    expect(debt.summary).not.toContain("Social jetlag");
    expect(analysis.timing).toMatchObject({
      weekday_nights: 4,
      weekend_nights: 1,
      social_jetlag_minutes: null,
    });
    expect(analysis.notes).toContain(note);
  });

  it("releases standard social jetlag with 2 nights in each group and names the heuristic", async () => {
    // Wake days Thursday 09-10 back to Saturday 09-05.
    const result = await getSleepDebt(analyticsClient(6), { days: 7 }, ANALYTICS_NOW);
    expect(result.consistency.social_jetlag_minutes).not.toBeNull();
    expect(result.notes.join(" ")).not.toContain("social jetlag is null");
    expect(result.summary).toContain("Social jetlag is a circular midpoint heuristic.");
  });
});

describe("get_sleep_debt with a window starting in the future", () => {
  type Level = "debug" | "info" | "warn" | "error";
  type CapturedLine = { level: Level; msg: string; fields: Record<string, unknown> };

  function captureLogger(): Logger & { lines: CapturedLine[] } {
    const lines: CapturedLine[] = [];
    const at =
      (level: Level) =>
      (msg: string, fields: Record<string, unknown> = {}): void => {
        lines.push({ level, msg, fields });
      };
    return { lines, debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
  }

  it("returns the date message and logs InvalidDateExpression at info", async () => {
    const data = liveShapedUser();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(data.now);
    const logger = captureLogger();
    const connection = await connectServer(createWhoopFixtureClient(data), {
      disableResources: true,
      logger,
    });
    try {
      const result = await connection.callTool("get_sleep_debt", { start: "2030-01-01" });
      expect(result.isError).toBe(true);
      expect(result.text).toBe(
        'The sleep window "2030-01-01" begins at or after the current time; get_sleep_debt needs a window that starts in the past.'
      );
    } finally {
      await connection.close();
    }
    const failures = logger.lines.filter((line) => line.msg === "tool call failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      level: "info",
      fields: {
        tool: "get_sleep_debt",
        outcome: "invalid_input",
        errorClass: "InvalidDateExpression",
      },
    });
    expect(JSON.stringify(logger.lines)).not.toContain("2030-01-01");
  });

  it("throws InvalidDateExpression from getSleepDebt", async () => {
    await expect(
      getSleepDebt(analyticsClient(), { start: "2027-01-01" }, ANALYTICS_NOW)
    ).rejects.toThrow(InvalidDateExpression);
  });
});
