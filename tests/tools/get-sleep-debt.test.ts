import { describe, it, expect, vi, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { getSleepDebt, sleepDebtOutputSchema } from "../../src/tools/get-sleep-debt.js";
import { WhoopNetworkError, type WhoopClient } from "../../src/api/client.js";
import type { Sleep } from "../../src/api/types.js";
import { createWhoopServer } from "../../src/server.js";
import { aggregateOutputSchemas } from "../../src/tools/output-contracts.js";
import { analyticsClient, ANALYTICS_NOW, sleepFixture } from "../helpers/analytics-fixtures.js";

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
    expect(result.period.start).toBe("2026-08-09T00:00:00.000Z");
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
    expect(result.notes).toEqual([]);
    expect(result.summary).toContain("not outstanding debt");
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
    expect(result.period).toEqual({
      start: "2026-09-01T00:00:00.000Z",
      end: "2026-09-04T00:00:00.000Z",
    });
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
    expect(result.notes).toEqual([]);
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
    expect(result.period.start).toBe("2026-09-13T22:00:00.000Z");
    expect(result.nights_analyzed).toBe(2);
  });
});

describe("get_sleep_debt through the MCP server", () => {
  async function call(
    whoop: WhoopClient,
    privacyMode: "standard" | "aggregate"
  ): Promise<{ isError?: boolean; structuredContent?: unknown; text: string }> {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(LIVE_NOW);
    const { server } = createWhoopServer(whoop, { privacyMode, disableResources: true });
    const client = new Client({ name: "sleep-debt-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({ name: "get_sleep_debt", arguments: {} });
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
    expect(data).toMatchObject({ status: "insufficient_data", nights_required: 3 });
    expect(data.notes).toEqual([expect.stringContaining("Not enough data yet: 2 of 3")]);
    for (const hidden of ['"nights"', "standing_debt", "summary", "T05:13", "2026-09-15"])
      expect(result.text).not.toContain(hidden);
  });

  it("explains unreadable data in aggregate mode", async () => {
    const result = await call(
      { get: vi.fn(async () => ({ records: "invalid" })) } as unknown as WhoopClient,
      "aggregate"
    );
    expect(result.isError, result.text).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      status: "unavailable",
      notes: [expect.stringContaining("Sleep data could not be read")],
    });
  });
});
