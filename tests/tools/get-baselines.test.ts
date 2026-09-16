import { describe, it, expect, vi, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { getBaselines, baselinesOutputSchema } from "../../src/tools/get-baselines.js";
import type { WhoopClient } from "../../src/api/client.js";
import type { Cycle, Recovery, Sleep } from "../../src/api/types.js";
import { createWhoopServer } from "../../src/server.js";
import { aggregateOutputSchemas } from "../../src/tools/output-contracts.js";
import {
  analyticsClient,
  ANALYTICS_NOW,
  recoveryFixture,
  sleepFixture,
} from "../helpers/analytics-fixtures.js";

// ---------------------------------------------------------------------------
// Live-shaped fixtures: a new user at +02:00 who started wearing WHOOP on
// Monday evening and is still calibrating. Cycles start at sleep onset, the
// current cycle has end:null, sleep/recovery join their cycle via cycle_id,
// WHOOP returns newest first and the last page carries next_token:null.
// ---------------------------------------------------------------------------

const LIVE_NOW = new Date("2026-09-16T10:00:00.000Z"); // 12:00 local

function liveCycle(id: number, start: string, end: string | null): Cycle {
  return {
    id,
    user_id: 7,
    created_at: start,
    updated_at: end ?? "2026-09-16T06:00:00.000Z",
    start,
    end,
    timezone_offset: "+02:00",
    score_state: "SCORED",
    score: { strain: 6.1, kilojoule: 5000, average_heart_rate: 64, max_heart_rate: 140 },
  };
}

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

function liveRecovery(
  cycleId: number,
  sleepId: string,
  created: string,
  calibrating = true
): Recovery {
  return {
    cycle_id: cycleId,
    sleep_id: sleepId,
    user_id: 7,
    created_at: created,
    updated_at: created,
    score_state: "SCORED",
    score: {
      user_calibrating: calibrating,
      recovery_score: 64,
      resting_heart_rate: 58,
      hrv_rmssd_milli: 95,
      spo2_percentage: null,
      skin_temp_celsius: null,
    },
  };
}

type LiveData = { recovery: Recovery[]; sleep: Sleep[]; cycle: Cycle[] };

/** Two nights and two calibrating recoveries, newest first. */
function liveData(): LiveData {
  return {
    cycle: [
      liveCycle(3, "2026-09-15T21:13:31.460Z", null),
      liveCycle(2, "2026-09-14T20:30:00.000Z", "2026-09-15T21:13:31.460Z"),
      liveCycle(1, "2026-09-14T15:00:00.000Z", "2026-09-14T20:30:00.000Z"),
    ],
    sleep: [
      liveSleep("s2", 3, "2026-09-15T21:13:31.460Z", "2026-09-16T05:13:59.350Z", {
        respiratory_rate: null,
        sleep_performance_percentage: null,
        sleep_efficiency_percentage: null,
      }),
      liveSleep("s1", 2, "2026-09-14T20:30:00.000Z", "2026-09-15T04:30:00.000Z"),
    ],
    recovery: [
      liveRecovery(3, "s2", "2026-09-16T05:17:36.057Z"),
      liveRecovery(2, "s1", "2026-09-15T04:35:00.000Z"),
    ],
  };
}

/** Fake WHOOP API serving each endpoint as one final page (next_token: null). */
function liveClient(data: LiveData, overrides: Record<string, unknown> = {}): WhoopClient {
  const pages: Record<string, unknown> = {
    "/v2/recovery": { records: data.recovery, next_token: null },
    "/v2/activity/sleep": { records: data.sleep, next_token: null },
    "/v2/cycle": { records: data.cycle, next_token: null },
    ...overrides,
  };
  return {
    get: vi.fn(async (path: string) => {
      const page = pages[path.split("?")[0]!];
      if (page instanceof Error) throw page;
      return page;
    }),
  } as unknown as WhoopClient;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("getBaselines", () => {
  it("excludes latest and current day, uses midrank ties and flags constant baselines", async () => {
    const result = await getBaselines(analyticsClient(), {}, ANALYTICS_NOW);
    expect(result.metrics.hrv).toMatchObject({
      mean: 40,
      latest: 100,
      latest_percentile: 100,
      sample_size: 19,
      constant_baseline: true,
    });
    expect(result.metrics.rhr?.latest_percentile).toBe(50);
    expect(result.metric_status.hrv).toEqual({
      status: "available",
      sample_size: 19,
      required_sample_size: 14,
      unit: "ms",
      reason: null,
    });
    expect(result.notes).toEqual([]);
    expect(result.data_quality.sources.recovery?.cache_status).toBe("unknown");
    expect(result.disclaimer).toContain("not medical advice");
  });
  it("returns null bands below 14 historical points and says how many exist", async () => {
    const result = await getBaselines(analyticsClient(14), {}, ANALYTICS_NOW);
    expect(result.metrics.hrv).toBeNull();
    expect(result.metric_status.hrv).toMatchObject({
      sample_size: 13,
      required_sample_size: 14,
      status: "insufficient_data",
    });
    expect(result.metric_status.hrv.reason).toContain("Not enough data yet (13 of 14");
    expect(result.metric_status.sleep_hours.reason).toContain("13 of 14");
  });
  it("excludes calibration and missing cycle context without affecting sleep", async () => {
    const records = Array.from({ length: 20 }, (_, index) => recoveryFixture(index));
    records[1]!.score!.user_calibrating = true;
    const result = await getBaselines(
      analyticsClient(20, { "/v2/recovery": { records }, "/v2/cycle": { records: [] } }),
      {},
      ANALYTICS_NOW
    );
    expect(result.metrics.hrv).toBeNull();
    expect(result.metrics.sleep_hours?.mean).toBe(7);
    expect(result.data_quality.sources.recovery?.exclusions.calibrating).toBe(1);
    expect(result.data_quality.sources.recovery?.exclusions.missing_join).toBe(19);
    // The newest recovery is no longer calibrating, so this is not "calibrating".
    expect(result.metric_status.hrv.status).toBe("insufficient_data");
    expect(result.metric_status.hrv.reason).toContain("1 earlier calibrating recovery not used");
    expect(result.notes).toContain(
      "19 recoveries could not be matched to a WHOOP cycle and were not used."
    );
  });
  it("retains sleep baselines when recovery fetching fails and says recovery was unreadable", async () => {
    const result = await getBaselines(
      analyticsClient(20, { "/v2/recovery": new Error("secret") }),
      {},
      ANALYTICS_NOW
    );
    expect(result.metrics.hrv).toBeNull();
    expect(result.metrics.sleep_hours).not.toBeNull();
    expect(result.metric_status.hrv).toMatchObject({
      status: "unavailable",
      reason: "Recovery data could not be read (the WHOOP request failed).",
    });
    expect(result.metric_status.sleep_hours.status).toBe("available");
    expect(result.notes).toEqual([
      "HRV, resting heart rate and recovery score: Recovery data could not be read (the WHOOP request failed).",
    ]);
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  it("reports a malformed page as unavailable rather than insufficient data", async () => {
    const result = await getBaselines(
      analyticsClient(20, { "/v2/activity/sleep": { records: "invalid" } }),
      {},
      ANALYTICS_NOW
    );
    expect(result.data_quality.sources.sleep?.status).toBe("invalid");
    for (const metric of ["sleep_hours", "respiratory_rate"] as const)
      expect(result.metric_status[metric]).toMatchObject({
        status: "unavailable",
        reason: "Sleep data could not be read (WHOOP returned data in an unexpected format).",
      });
    expect(result.metric_status.hrv.status).toBe("available");
  });
  it("marks recovery metrics unavailable when cycles cannot be read", async () => {
    const result = await getBaselines(
      analyticsClient(20, { "/v2/cycle": new Error("down") }),
      {},
      ANALYTICS_NOW
    );
    expect(result.metric_status.recovery_score.status).toBe("unavailable");
    expect(result.metric_status.recovery_score.reason).toContain(
      "Cycle data could not be read (the WHOOP request failed)."
    );
  });
  it("returns a structured report when every source is malformed", async () => {
    const malformed = { records: "invalid" };
    const result = await getBaselines(
      analyticsClient(0, {
        "/v2/recovery": malformed,
        "/v2/activity/sleep": malformed,
        "/v2/cycle": malformed,
      }),
      {},
      ANALYTICS_NOW
    );
    expect(Object.values(result.metric_status).map((status) => status.status)).toEqual(
      Array(5).fill("unavailable")
    );
    expect(baselinesOutputSchema.safeParse(result).success).toBe(true);
  });
  it("ignores a null respiratory rate instead of counting or crashing on it", async () => {
    const sleeps = Array.from({ length: 20 }, (_, index) => sleepFixture(index));
    sleeps[5]!.score!.respiratory_rate = null;
    const result = await getBaselines(
      analyticsClient(20, { "/v2/activity/sleep": { records: sleeps, next_token: null } }),
      {},
      ANALYTICS_NOW
    );
    expect(result.metrics.sleep_hours?.sample_size).toBe(19);
    expect(result.metrics.respiratory_rate).toMatchObject({ sample_size: 18, mean: 15 });
    expect(result.metric_status.respiratory_rate).toMatchObject({
      status: "available",
      reason: null,
    });
  });
  it("rejects out-of-range inputs", async () => {
    await expect(
      getBaselines(analyticsClient(), { baseline_days: 181 }, ANALYTICS_NOW)
    ).rejects.toThrow();
  });

  it("reports truncation without silently presenting complete history", async () => {
    const result = await getBaselines(
      analyticsClient(0, {
        "/v2/recovery": {
          records: Array.from({ length: 501 }, (_, index) => recoveryFixture(index)),
          next_token: "more",
        },
      }),
      { baseline_days: 180 },
      ANALYTICS_NOW
    );
    expect(result.truncated).toBe(true);
    expect(result.data_quality.sources.recovery?.records_fetched).toBe(500);
    expect(result.data_quality.limitations.join(" ")).toContain("Partial history");
    expect(result.notes.join(" ")).toContain("Partial history");
  });
});

describe("getBaselines with a new, calibrating user (live shape)", () => {
  it("reads every final page and reports recovery metrics as calibrating", async () => {
    const result = await getBaselines(liveClient(liveData()), {}, LIVE_NOW);
    const { sources } = result.data_quality;
    expect(sources.recovery).toMatchObject({
      status: "calibrating",
      records_fetched: 2,
      records_used: 0,
      exclusions: { calibrating: 2 },
    });
    expect(sources.sleep).toMatchObject({
      status: "available",
      records_fetched: 2,
      records_used: 2,
    });
    // Cycles were read; they are unused only because the recoveries are calibrating.
    expect(sources.cycle).toMatchObject({ status: "calibrating", records_fetched: 3 });
    for (const metric of ["hrv", "rhr", "recovery_score"] as const) {
      expect(result.metrics[metric]).toBeNull();
      expect(result.metric_status[metric]).toMatchObject({
        status: "calibrating",
        sample_size: 0,
        required_sample_size: 14,
      });
      expect(result.metric_status[metric].reason).toContain(
        "WHOOP is still calibrating, so 2 of 2 scored recoveries so far are not used."
      );
    }
    expect(result.metric_status.sleep_hours).toMatchObject({
      status: "insufficient_data",
      sample_size: 1,
    });
    expect(result.metric_status.sleep_hours.reason).toContain(
      "Not enough data yet (2 scored main sleeps in this window; 1 of 14"
    );
    expect(result.metric_status.respiratory_rate.reason).toContain(
      "WHOOP reported no respiratory rate for 1 of 2 scored main sleeps."
    );
    expect(result.notes[0]).toMatch(
      /^HRV, resting heart rate and recovery score: WHOOP is still calibrating/
    );
    expect(result.notes).toHaveLength(3);
    expect(Object.values(result.metrics).every((band) => band === null)).toBe(true);
    expect(baselinesOutputSchema.safeParse(result).success).toBe(true);
  });

  it("stops saying calibrating once WHOOP's newest recovery is no longer calibrating", async () => {
    const data = liveData();
    data.recovery[0] = liveRecovery(3, "s2", "2026-09-16T05:17:36.057Z", false);
    const result = await getBaselines(liveClient(data), {}, LIVE_NOW);
    expect(result.metric_status.hrv.status).toBe("insufficient_data");
    expect(result.metric_status.hrv.reason).toContain("1 earlier calibrating recovery not used");
    expect(result.data_quality.sources.recovery).toMatchObject({
      status: "available",
      records_used: 1,
    });
  });

  it("notes a recovery WHOOP is still scoring without losing the calibrating state", async () => {
    const data = liveData();
    data.recovery.unshift({
      ...liveRecovery(4, "s3", "2026-09-17T05:10:00.000Z"),
      score_state: "PENDING_SCORE",
      score: null,
    });
    const result = await getBaselines(liveClient(data), {}, new Date("2026-09-17T06:00:00.000Z"));
    expect(result.metric_status.hrv.status).toBe("calibrating");
    expect(result.notes).toContain(
      "1 recovery is still being scored by WHOOP and not counted yet."
    );
  });
});

describe("get_baselines through the MCP server", () => {
  async function call(
    whoop: WhoopClient,
    privacyMode: "standard" | "aggregate"
  ): Promise<{ isError?: boolean; structuredContent?: unknown; text: string }> {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(LIVE_NOW);
    const { server } = createWhoopServer(whoop, { privacyMode, disableResources: true });
    const client = new Client({ name: "baselines-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({ name: "get_baselines", arguments: {} });
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
    const result = await call(liveClient(liveData()), "standard");
    expect(result.isError, result.text).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      metric_status: { hrv: { status: "calibrating" } },
    });
  });

  it("keeps statuses, reasons and notes in aggregate mode without per-record data", async () => {
    const result = await call(liveClient(liveData()), "aggregate");
    expect(result.isError, result.text).toBeFalsy();
    const data = result.structuredContent as {
      metric_status: Record<string, { status: string; reason: string | null }>;
      notes: string[];
    };
    expect(aggregateOutputSchemas.get_baselines!.safeParse(data).success).toBe(true);
    expect(data.metric_status.hrv).toMatchObject({
      status: "calibrating",
      reason: expect.stringContaining("WHOOP is still calibrating"),
    });
    expect(data.notes[0]).toContain("WHOOP is still calibrating");
    for (const hidden of ["latest", "user_id", "sleep_id", "observed_period", "T05:13", "T21:13"])
      expect(result.text).not.toContain(hidden);
  });
});
