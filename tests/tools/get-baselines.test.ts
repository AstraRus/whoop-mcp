import { describe, it, expect, vi, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { getBaselines, baselinesOutputSchema } from "../../src/tools/get-baselines.js";
import { WhoopApiError, type WhoopClient } from "../../src/api/client.js";
import type { Cycle, Recovery, Sleep } from "../../src/api/types.js";
import { createWhoopServer } from "../../src/server.js";
import { aggregateOutputSchemas } from "../../src/tools/output-contracts.js";
import { MAX_TOOL_TEXT_CHARS } from "../../src/tools/tool-definition.js";
import { assertNeutralText, connectServer } from "../helpers/contract.js";
import { createWhoopFixtureClient } from "../helpers/whoop-fixture-client.js";
import { liveShapedUser, matureUser, stressUser } from "../helpers/whoop-users.js";
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
    // The fixture records carry no SpO2, skin temperature or sleep efficiency at all.
    for (const metric of ["spo2", "skin_temp", "sleep_efficiency"] as const)
      expect(result.metric_status[metric].status, metric).toBe("not_reported");
    expect(result.notes).toEqual([
      "SpO2: WHOOP reported no SpO2 on any of the 20 scored recoveries in this window: not reported (WHOOP 4.0 or later).",
      "Skin temperature: WHOOP reported no skin temperature on any of the 20 scored recoveries in this window: not reported (WHOOP 4.0 or later).",
      "Sleep efficiency: WHOOP reported no sleep efficiency on any of the 20 scored main sleeps in this window.",
    ]);
    for (const metric of ["disturbances_per_hour", "rem_share", "deep_share"] as const)
      expect(result.metric_status[metric].status, metric).toBe("available");
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
      "HRV, resting heart rate, recovery score, SpO2 and skin temperature: Recovery data could not be read (the WHOOP request failed).",
      "Sleep efficiency: WHOOP reported no sleep efficiency on any of the 20 scored main sleeps in this window.",
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
      Array(11).fill("unavailable")
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
    // Cycles placed both calibrating recoveries on their days: the cycle source is available
    // (it no longer mirrors the recovery status).
    expect(sources.cycle).toMatchObject({
      status: "available",
      records_fetched: 3,
      records_used: 2,
      exclusions: {},
    });
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
    // SpO2 and skin temperature are null on both recoveries: not reported rather than calibrating.
    expect(result.metric_status.spo2.status).toBe("not_reported");
    expect(result.notes[1]).toBe(
      "SpO2: WHOOP reported no SpO2 on any of the 2 scored recoveries in this window: not reported (WHOOP 4.0 or later)."
    );
    expect(result.notes).toHaveLength(6);
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
    // The two nights are in the current week, which is not released yet.
    expect(data.metric_status.hrv).toMatchObject({
      status: "insufficient_data",
      reason: "Not enough data yet (0 of 14 samples in released weeks with at least 3 each).",
    });
    expect(data.notes[0]).toBe(
      "Aggregate privacy mode uses whole released weeks: 8 weeks ending 2026-09-13."
    );
    for (const hidden of ["latest", "user_id", "sleep_id", "observed_period", "T05:13", "T21:13"])
      expect(result.text).not.toContain(hidden);
    // 30 days snap to 8 whole released weeks, labelled Monday to Sunday.
    expect(result.structuredContent).toMatchObject({
      period: { start: "2026-07-20", end: "2026-09-13" },
      data_quality: {
        evaluated_at: "2026-09-16",
        requested_period: { start: "2026-07-20", end: "2026-09-13" },
      },
    });
  });
});

// ---------------------------------------------------------------------------
// A regular schedule at +02:00: bed 23:00 local (21:00Z), wake 07:00 local
// (05:00Z), one scored cycle, sleep and non-calibrating recovery per day.
// Only records that exist at `now` are served, newest first.
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const HOUR = 3_600_000;

function regularClient(
  now: Date,
  days = 40,
  overrides: Record<string, (path: string) => unknown> = {}
): WhoopClient {
  const cycles: Cycle[] = [];
  const sleeps: Sleep[] = [];
  const recoveries: Recovery[] = [];
  for (let index = -1; index < days; index += 1) {
    const bed = Date.parse("2026-09-15T21:00:00.000Z") - index * DAY;
    const wake = bed + 8 * HOUR;
    if (bed > now.getTime()) continue;
    const id = 5000 - index;
    const iso = (ms: number): string => new Date(ms).toISOString();
    const cycle = liveCycle(id, iso(bed), bed + DAY <= now.getTime() ? iso(bed + DAY) : null);
    cycles.push(cycle);
    if (wake > now.getTime()) continue;
    sleeps.push(liveSleep(`sleep-${id}`, id, iso(bed), iso(wake)));
    recoveries.push(liveRecovery(id, `sleep-${id}`, iso(wake + 10 * 60_000), false));
  }
  const data: Record<string, unknown[]> = {
    "/v2/cycle": cycles,
    "/v2/activity/sleep": sleeps,
    "/v2/recovery": recoveries,
  };
  return {
    get: vi.fn(async (path: string) => {
      const base = path.split("?")[0]!;
      const override = overrides[base];
      if (override) return override(path);
      return { records: data[base] ?? [], next_token: null };
    }),
  } as unknown as WhoopClient;
}

describe("getBaselines at its minimum baseline_days", () => {
  it.each(["2026-09-16T13:00:00.000Z", "2026-09-16T22:00:00.000Z", "2026-09-16T03:00:00.000Z"])(
    "produces every baseline with baseline_days 14 at %s",
    async (nowIso) => {
      const now = new Date(nowIso);
      const result = await getBaselines(regularClient(now), { baseline_days: 14 }, now);
      for (const metric of [
        "hrv",
        "rhr",
        "recovery_score",
        "sleep_hours",
        "respiratory_rate",
        "sleep_efficiency",
        "disturbances_per_hour",
        "rem_share",
        "deep_share",
      ] as const) {
        expect(result.metric_status[metric].status, metric).toBe("available");
        expect(result.metric_status[metric].sample_size).toBeGreaterThanOrEqual(14);
        expect(result.metrics[metric]).not.toBeNull();
      }
      // The regular schedule's recoveries carry no SpO2 or skin temperature.
      expect(result.notes).toEqual([
        expect.stringMatching(
          /^SpO2: WHOOP reported no SpO2 on any of the \d+ scored recoveries in this window: not reported \(WHOOP 4\.0 or later\)\.$/
        ),
        expect.stringMatching(/^Skin temperature: WHOOP reported no skin temperature on any of/),
      ]);
    }
  );

  it("reads baseline_days + 2 days and reports local-offset periods", async () => {
    const now = new Date("2026-09-16T13:00:00.000Z"); // 15:00 local
    const result = await getBaselines(regularClient(now), { baseline_days: 14 }, now);
    expect(result.data_quality.requested_period).toEqual({
      start: "2026-08-31T15:00:00.000+02:00",
      end: "2026-09-16T15:00:00.000+02:00",
    });
    // Local days 09-01..09-15: the recovery for 09-01 belongs to the cycle that began on
    // the evening of 08-31, and today (09-16, also the latest observation) is left out.
    expect(result.period).toEqual({
      start: "2026-09-01T00:00:00.000+02:00",
      end: "2026-09-15T23:59:59.999+02:00",
    });
    expect(result.data_quality.observed_period).toEqual(result.period);
    expect(result.metric_status.hrv.sample_size).toBe(15);
  });
});

describe("getBaselines with a failing later page", () => {
  it.each([
    [
      "a rate-limited",
      (): never => {
        throw new WhoopApiError(429, "Too Many Requests", null);
      },
    ],
    ["a malformed", (): unknown => ({ records: null, next_token: null })],
  ])("keeps the sleeps already read when %s page follows", async (_label, laterPage) => {
    const now = new Date("2026-09-16T13:00:00.000Z");
    const full = regularClient(now, 40);
    const all = (await full.get<{ records: Sleep[] }>("/v2/activity/sleep")).records;
    const client = regularClient(now, 40, {
      "/v2/activity/sleep": (path) =>
        path.includes("nextToken=") ? laterPage() : { records: all.slice(0, 25), next_token: "p2" },
    });
    const result = await getBaselines(client, { baseline_days: 45 }, now);
    expect(result.metric_status.sleep_hours).toMatchObject({
      status: "available",
      sample_size: 24,
    });
    expect(result.metric_status.hrv.sample_size).toBeGreaterThan(24);
    expect(result.truncated).toBe(true);
    expect(result.data_quality.sources.sleep).toMatchObject({
      status: "available",
      records_fetched: 25,
      truncated: true,
    });
    expect(result.notes).toContain(
      "Partial history: a later page of sleep data could not be read from WHOOP, so older records in the window were not included. Retry for a complete result."
    );
    expect(result.data_quality.limitations).toContain(
      "Partial history: not every page in the window was read."
    );
  });
});

// ---------------------------------------------------------------------------
// SpO2, skin temperature and the added sleep metrics
// ---------------------------------------------------------------------------

/**
 * `days` regular nights at +02:00 ending with the night before 2026-09-16
 * (newest first); the oldest `calibrating` recoveries are calibrating and
 * nights listed in `lowCoverage` (0 = newest) have 2 h without strap data.
 */
function detailedClient(
  days: number,
  options: {
    calibrating?: number;
    lowCoverage?: number[];
    spo2?: (index: number) => number | null;
    skinTemp?: (index: number) => number | null;
  } = {}
): WhoopClient {
  const cycles: Cycle[] = [];
  const sleeps: Sleep[] = [];
  const recoveries: Recovery[] = [];
  const iso = (ms: number): string => new Date(ms).toISOString();
  for (let index = 0; index < days; index++) {
    const bed = Date.parse("2026-09-15T21:00:00.000Z") - index * DAY;
    const wake = bed + 8 * HOUR;
    const id = 7000 - index;
    cycles.push(liveCycle(id, iso(bed), index === 0 ? null : iso(bed + DAY)));
    const lowCoverage = options.lowCoverage?.includes(index) ?? false;
    sleeps.push(
      liveSleep(`sleep-${id}`, id, iso(bed), iso(wake), {
        stage_summary: {
          total_in_bed_time_milli: 8 * HOUR,
          total_awake_time_milli: lowCoverage ? 0 : HOUR,
          total_no_data_time_milli: lowCoverage ? 2 * HOUR : 0,
          total_light_sleep_time_milli: (lowCoverage ? 3 : 4) * HOUR,
          total_slow_wave_sleep_time_milli: HOUR + index * 60_000,
          total_rem_sleep_time_milli: 2 * HOUR - index * 60_000,
          sleep_cycle_count: 5,
          disturbance_count: 7 + (index % 5),
        },
        sleep_efficiency_percentage: 80 + (index % 10),
      })
    );
    const recovery = liveRecovery(
      id,
      `sleep-${id}`,
      iso(wake + 10 * 60_000),
      index >= days - (options.calibrating ?? 0)
    );
    recovery.score!.spo2_percentage = options.spo2 ? options.spo2(index) : 95 + (index % 4);
    recovery.score!.skin_temp_celsius = options.skinTemp
      ? options.skinTemp(index)
      : 33 + index / 10;
    recoveries.push(recovery);
  }
  const data: Record<string, unknown[]> = {
    "/v2/cycle": cycles,
    "/v2/activity/sleep": sleeps,
    "/v2/recovery": recoveries,
  };
  return {
    get: vi.fn(async (path: string) => ({
      records: data[path.split("?")[0]!] ?? [],
      next_token: null,
    })),
  } as unknown as WhoopClient;
}

const DETAIL_NOW = new Date("2026-09-16T13:00:00.000Z"); // 15:00 local

describe("getBaselines — SpO2, skin temperature and sleep detail", () => {
  it("builds a skin temperature band from 16 non-calibrating days, leaving out the latest and calibrating ones", async () => {
    const result = await getBaselines(detailedClient(20, { calibrating: 3 }), {}, DETAIL_NOW);

    // 20 recoveries: the oldest 3 are calibrating and the newest (today, 09-16) is the latest.
    const expected = Array.from({ length: 16 }, (_, offset) => 33 + (offset + 1) / 10);
    const mean = expected.reduce((sum, value) => sum + value, 0) / expected.length;
    expect(result.metric_status.skin_temp).toEqual({
      status: "available",
      sample_size: 16,
      required_sample_size: 14,
      unit: "°C",
      reason: null,
    });
    expect(result.metrics.skin_temp).toMatchObject({ sample_size: 16, latest: 33 });
    expect(result.metrics.skin_temp!.mean).toBeCloseTo(mean, 9);
    expect(result.metrics.skin_temp!.p10).toBeCloseTo(33.25, 9);
    expect(result.metrics.skin_temp!.latest_percentile).toBe(0);
    expect(result.metrics.spo2).toMatchObject({ sample_size: 16 });
    expect(result.data_quality.sources.recovery?.exclusions.calibrating).toBe(3);
  });

  it("reports SpO2 as not reported when every scored recovery lacks it, even while calibrating", async () => {
    const result = await getBaselines(
      detailedClient(20, { calibrating: 20, spo2: () => null }),
      {},
      DETAIL_NOW
    );

    expect(result.metrics.spo2).toBeNull();
    expect(result.metric_status.spo2).toMatchObject({
      status: "not_reported",
      sample_size: 0,
      reason:
        "WHOOP reported no SpO2 on any of the 20 scored recoveries in this window: not reported (WHOOP 4.0 or later).",
    });
    // Skin temperature is reported, so it is calibrating like the other recovery metrics.
    expect(result.metric_status.skin_temp.status).toBe("calibrating");
    expect(result.metric_status.hrv.status).toBe("calibrating");
  });

  it("counts only reported SpO2 values and keeps the metric available with enough of them", async () => {
    const result = await getBaselines(
      detailedClient(20, { spo2: (index) => (index % 5 === 4 ? null : 96) }),
      {},
      DETAIL_NOW
    );

    expect(result.metric_status.spo2).toMatchObject({ status: "available", sample_size: 15 });
    expect(result.metrics.spo2).toMatchObject({ mean: 96, constant_baseline: true });
  });

  it("leaves nights with low data coverage out of the added sleep metrics only", async () => {
    const result = await getBaselines(
      detailedClient(20, { lowCoverage: [3, 8, 13] }),
      {},
      DETAIL_NOW
    );

    // 20 nights, the newest is the latest observation: 19 earlier nights, 3 with low coverage.
    expect(result.metrics.sleep_hours?.sample_size).toBe(19);
    expect(result.metrics.respiratory_rate?.sample_size).toBe(19);
    for (const metric of [
      "sleep_efficiency",
      "disturbances_per_hour",
      "rem_share",
      "deep_share",
    ] as const) {
      expect(result.metric_status[metric], metric).toMatchObject({
        status: "available",
        sample_size: 16,
        unit: expect.any(String),
      });
    }
    expect(result.metrics.rem_share!.mean).toBeGreaterThan(0);
    expect(result.metrics.rem_share!.mean + result.metrics.deep_share!.mean).toBeLessThan(100);
    expect(result.data_quality.limitations).toContain(
      "Nights with low data coverage (no strap data for more than 20% of time in bed) are not used for sleep efficiency, disturbances per hour, REM share or deep sleep share."
    );
  });

  it("explains too few nights for the added sleep metrics with the low-coverage count", async () => {
    const result = await getBaselines(
      detailedClient(15, { lowCoverage: [2] }),
      { baseline_days: 14 },
      DETAIL_NOW
    );

    expect(result.metric_status.sleep_hours.status).toBe("available");
    expect(result.metric_status.sleep_efficiency).toMatchObject({
      status: "insufficient_data",
      sample_size: 13,
    });
    expect(result.metric_status.sleep_efficiency.reason).toBe(
      "Not enough data yet (15 scored main sleeps in this window; 13 of 14 earlier ones needed, the most recent night and today are not counted). 1 night with low data coverage (no strap data for more than 20% of time in bed) is not used."
    );
    expect(result.notes).toContain(
      `Sleep efficiency, disturbances per hour, REM share and deep sleep share: ${result.metric_status.sleep_efficiency.reason}`
    );
  });
});

// ---------------------------------------------------------------------------
// Shared fixture users, both privacy modes
// ---------------------------------------------------------------------------

describe("get_baselines on the shared fixture users", () => {
  const ROUNDED_TO_TENTHS = new Set([
    "respiratory_rate",
    "sleep_hours",
    "skin_temp",
    "disturbances_per_hour",
  ]);

  async function callBaselines(
    data: ReturnType<typeof matureUser>,
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
      return await connection.callTool("get_baselines", args);
    } finally {
      await connection.close();
    }
  }

  it("computes every band for a mature account in standard mode", async () => {
    const result = await callBaselines(matureUser(), "standard", { baseline_days: 60 });
    expect(result.isError, result.text).toBe(false);
    const report = result.structured as unknown as BaselineShape;
    for (const [metric, status] of Object.entries(report.metric_status))
      expect(status.status, metric).toBe("available");
    expect(report.metrics.skin_temp).toHaveProperty("latest");
    expect(report.metrics.sleep_efficiency!.sample_size).toBeLessThan(
      report.metrics.sleep_hours!.sample_size
    );
    assertNeutralText(report);
  });

  it("omits the latest observation, p10 and p90 for every metric in aggregate mode", async () => {
    const result = await callBaselines(matureUser(), "aggregate");
    expect(result.isError, result.text).toBe(false);
    const report = result.structured as unknown as BaselineShape;
    expect(aggregateOutputSchemas.get_baselines!.safeParse(report).success).toBe(true);
    // 30 days snap to 8 released weeks ending the Sunday before Wednesday 09-16.
    expect(report.period).toEqual({ start: "2026-07-20", end: "2026-09-13" });
    expect(report.notes[0]).toBe(
      "Aggregate privacy mode uses whole released weeks: 8 weeks ending 2026-09-13."
    );
    expect(Object.keys(report.metrics)).toHaveLength(11);
    for (const [metric, band] of Object.entries(report.metrics)) {
      expect(band, metric).not.toBeNull();
      expect(Object.keys(band!).sort(), metric).toEqual([
        "constant_baseline",
        "mean",
        "median",
        "p25",
        "p50",
        "p75",
        "sample_size",
        "std_dev",
      ]);
      const step = ROUNDED_TO_TENTHS.has(metric) ? 0.1 : 1;
      for (const key of ["mean", "median", "std_dev", "p25", "p50", "p75"] as const) {
        const value = band![key];
        expect(Math.abs(value / step - Math.round(value / step)), `${metric}.${key}`).toBeLessThan(
          1e-9
        );
      }
    }
    // Every day of the 8 weeks has a non-calibrating recovery; whole weeks only.
    expect(report.metrics.hrv!.sample_size).toBe(56);
    expect(report.metrics.sleep_efficiency!.sample_size % 1).toBe(0);
    expect(report.data_quality).toMatchObject({
      evaluated_at: "2026-09-16",
      requested_period: { start: "2026-07-20", end: "2026-09-13" },
      sources: { recovery: { status: "available", records_used: 56 } },
    });
    expect(result.text).not.toMatch(/latest|p10|p90|T\d{2}:\d{2}/);
    assertNeutralText(report);
  });

  it("explains the calibrating live-shaped user in aggregate mode without per-record data", async () => {
    const result = await callBaselines(liveShapedUser(), "aggregate", { baseline_days: 14 });
    expect(result.isError, result.text).toBe(false);
    const report = result.structured as unknown as BaselineShape;
    expect(report.period).toEqual({ start: "2026-08-31", end: "2026-09-13" });
    for (const status of Object.values(report.metric_status))
      expect(status).toMatchObject({ status: "insufficient_data", sample_size: 0 });
    assertNeutralText(report);
  });

  it("stays within the text size limit at 180 days on the stress user in both modes", async () => {
    for (const mode of ["standard", "aggregate"] as const) {
      const result = await callBaselines(stressUser(), mode, { baseline_days: 180 });
      expect(result.isError, result.text.slice(0, 200)).toBe(false);
      expect(result.text.length).toBeLessThan(MAX_TOOL_TEXT_CHARS);
    }
  });
});

interface BaselineShape {
  period: { start: string; end: string } | null;
  metrics: Record<
    string,
    {
      sample_size: number;
      mean: number;
      median: number;
      std_dev: number;
      p25: number;
      p50: number;
      p75: number;
    } | null
  >;
  metric_status: Record<string, { status: string; sample_size: number }>;
  notes: string[];
  data_quality: Record<string, unknown>;
}
