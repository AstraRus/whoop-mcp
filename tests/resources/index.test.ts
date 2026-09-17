import { describe, it, expect, vi, afterEach } from "vitest";
import {
  RESOURCE_DEFINITIONS,
  registerResources,
  DYNAMIC_TTL_MS,
  CYCLE_TTL_MS,
  PROFILE_TTL_MS,
  SLEEP_LOOKBACK_LIMIT,
  WORKOUT_LIST_PATH,
} from "../../src/resources/index.js";
import type { Logger } from "../../src/logging/logger.js";
import type { Workout } from "../../src/api/types.js";
import { getToday, TODAY_LIST_PATHS } from "../../src/tools/get-today.js";
import { workoutSummarySchema } from "../../src/tools/workout-utils.js";
import { connectServer } from "../helpers/contract.js";
import { createWhoopFixtureClient } from "../helpers/whoop-fixture-client.js";
import { LIVE_SHAPED_IDS, liveShapedUser } from "../helpers/whoop-users.js";
import type { WhoopClient, WhoopGetOptions } from "../../src/api/client.js";
import {
  createWhoopClient,
  WhoopApiError,
  WhoopAuthError,
  WhoopNetworkError,
} from "../../src/api/client.js";
import { MemoryCache } from "../../src/cache/memory-cache.js";

// ---------------------------------------------------------------------------
// Live-shaped fixtures: a user who started wearing WHOOP on Monday evening
// (+02:00), still calibrating. A cycle starts at sleep onset; the current
// cycle has end null; the last page has next_token null.
// ---------------------------------------------------------------------------

const OPEN_CYCLE = {
  id: 1_003,
  user_id: 7,
  created_at: "2026-09-15T21:40:00.000Z",
  updated_at: "2026-09-16T10:00:00.000Z",
  start: "2026-09-15T21:40:00.000Z",
  end: null,
  timezone_offset: "+02:00",
  score_state: "SCORED",
  score: { strain: 6.1, kilojoule: 4200, average_heart_rate: 64, max_heart_rate: 131 },
};

const CLOSED_CYCLE = {
  ...OPEN_CYCLE,
  id: 1_002,
  start: "2026-09-14T21:15:00.000Z",
  end: "2026-09-15T21:40:00.000Z",
};

const MAIN_SLEEP = {
  id: "5d1f3c2a-7b8e-4f60-9a1b-2c3d4e5f6a7b",
  v1_id: null,
  cycle_id: 1_003,
  user_id: 7,
  created_at: "2026-09-16T05:30:00.000Z",
  updated_at: "2026-09-16T05:45:00.000Z",
  start: "2026-09-15T21:40:00.000Z",
  end: "2026-09-16T05:25:00.000Z",
  timezone_offset: "+02:00",
  nap: false,
  score_state: "SCORED",
  score: {
    stage_summary: {
      total_in_bed_time_milli: 27_900_000,
      total_awake_time_milli: 2_100_000,
      total_no_data_time_milli: 0,
      total_light_sleep_time_milli: 12_000_000,
      total_slow_wave_sleep_time_milli: 6_600_000,
      total_rem_sleep_time_milli: 7_200_000,
      sleep_cycle_count: 4,
      disturbance_count: 9,
    },
    sleep_needed: {
      baseline_milli: 27_000_000,
      need_from_sleep_debt_milli: 0,
      need_from_recent_strain_milli: 0,
      need_from_recent_nap_milli: 0,
    },
    respiratory_rate: 15.2,
    sleep_performance_percentage: 88,
    sleep_consistency_percentage: 0,
    sleep_efficiency_percentage: 92.5,
  },
};

const NAP = {
  ...MAIN_SLEEP,
  id: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
  start: "2026-09-16T11:00:00.000Z",
  end: "2026-09-16T11:25:00.000Z",
  nap: true,
};

const CALIBRATING_RECOVERY = {
  cycle_id: 1_003,
  sleep_id: MAIN_SLEEP.id,
  user_id: 7,
  created_at: "2026-09-16T05:46:00.000Z",
  updated_at: "2026-09-16T05:46:00.000Z",
  score_state: "SCORED",
  score: {
    user_calibrating: true,
    recovery_score: 58,
    resting_heart_rate: 57,
    hrv_rmssd_milli: 48.2,
    spo2_percentage: 96.1,
    skin_temp_celsius: 33.9,
  },
};

function pageOf(...records: unknown[]): { records: unknown[]; next_token: null } {
  return { records, next_token: null };
}

function clientReturning(page: unknown): WhoopClient {
  return { get: vi.fn().mockResolvedValue(page) };
}

function definition(uri: string): (typeof RESOURCE_DEFINITIONS)[number] {
  const def = RESOURCE_DEFINITIONS.find((d) => d.uri === uri);
  if (!def) throw new Error(`missing resource ${uri}`);
  return def;
}

// ---------------------------------------------------------------------------
// RESOURCE_DEFINITIONS tests
// ---------------------------------------------------------------------------

describe("RESOURCE_DEFINITIONS", () => {
  it("defines the 4 legacy resources and the latest workout", () => {
    expect(RESOURCE_DEFINITIONS.map((def) => def.uri)).toEqual([
      "whoop://v2/user/recovery/latest",
      "whoop://v2/user/sleep/latest",
      "whoop://v2/user/cycle/latest",
      "whoop://v2/user/workout/latest",
      "whoop://v2/user/profile",
    ]);
  });

  it("all resources have required fields", () => {
    for (const def of RESOURCE_DEFINITIONS) {
      expect(def.uri).toMatch(/^whoop:\/\//);
      expect(def.name).toBeTruthy();
      expect(def.description).toBeTruthy();
      expect(def.mimeType).toBe("application/json");
      expect(def.ttlMs).toBeGreaterThan(0);
      expect(typeof def.fetch).toBe("function");
    }
  });

  it("recovery and sleep resources share the cycle resource's 2-minute TTL", () => {
    const linkedResources = RESOURCE_DEFINITIONS.filter(
      (d) => d.uri === "whoop://v2/user/recovery/latest" || d.uri === "whoop://v2/user/sleep/latest"
    );
    expect(linkedResources).toHaveLength(2);
    for (const def of linkedResources) {
      expect(def.ttlMs).toBe(CYCLE_TTL_MS);
    }
    expect(DYNAMIC_TTL_MS).toBeGreaterThan(CYCLE_TTL_MS);
  });

  it("cycle resource uses 2-minute TTL", () => {
    expect(definition("whoop://v2/user/cycle/latest").ttlMs).toBe(CYCLE_TTL_MS);
  });

  it("profile resource uses 1-hour TTL", () => {
    expect(definition("whoop://v2/user/profile").ttlMs).toBe(PROFILE_TTL_MS);
  });

  it("describes sleep hours as time asleep, not time in bed", () => {
    const description = definition("whoop://v2/user/sleep/latest").description;
    expect(description).toContain("non-nap");
    expect(description).toContain("light + slow-wave + REM");
  });

  describe("recovery latest fetcher", () => {
    const def = definition("whoop://v2/user/recovery/latest");

    it("returns first record from recovery endpoint", async () => {
      const mockClient = clientReturning({ records: [{ recovery_score: 85 }] });

      const result = await def.fetch(mockClient);
      expect(result).toEqual({ recovery_score: 85 });
      expect(mockClient.get).toHaveBeenCalledWith("/v2/recovery?limit=1", {
        cache: true,
        ttlMs: CYCLE_TTL_MS,
      });
    });

    it("returns empty message when no records", async () => {
      const result = await def.fetch(clientReturning(pageOf()));
      expect(result).toEqual({ message: "No recovery data available yet." });
    });

    it("treats a missing, null or malformed records field as no data", async () => {
      for (const page of [{}, { records: null }, { records: "oops" }, null, { records: [null] }]) {
        await expect(def.fetch(clientReturning(page))).resolves.toEqual({
          message: "No recovery data available yet.",
        });
      }
    });

    it("keeps a calibrating recovery and marks it provisional", async () => {
      const result = (await def.fetch(clientReturning(pageOf(CALIBRATING_RECOVERY)))) as Record<
        string,
        unknown
      >;

      expect(result).toMatchObject(CALIBRATING_RECOVERY);
      expect(result.notes).toEqual([expect.stringContaining("still calibrating")]);
      expect(result.notes).toEqual([expect.stringContaining("provisional")]);
    });

    it("does not add notes to a scored, calibrated recovery", async () => {
      const calibrated = {
        ...CALIBRATING_RECOVERY,
        score: { ...CALIBRATING_RECOVERY.score, user_calibrating: false },
      };
      const result = await def.fetch(clientReturning(pageOf(calibrated)));
      expect(result).toEqual(calibrated);
    });

    it("explains a recovery that is not scored yet", async () => {
      const pending = { ...CALIBRATING_RECOVERY, score_state: "PENDING_SCORE", score: undefined };
      const result = (await def.fetch(clientReturning(pageOf(pending)))) as {
        notes: string[];
      };

      expect(result.notes).toEqual([expect.stringContaining("PENDING_SCORE")]);
    });

    it("explains an unscorable recovery", async () => {
      const unscorable = { ...CALIBRATING_RECOVERY, score_state: "UNSCORABLE", score: null };
      const result = (await def.fetch(clientReturning(pageOf(unscorable)))) as {
        notes: string[];
      };

      expect(result.notes).toEqual([expect.stringContaining("UNSCORABLE")]);
    });

    it("does not modify the cached record", async () => {
      const page = pageOf({ ...CALIBRATING_RECOVERY });
      await def.fetch(clientReturning(page));
      expect(page.records[0]).not.toHaveProperty("notes");
    });
  });

  describe("sleep latest fetcher", () => {
    const def = definition("whoop://v2/user/sleep/latest");

    it("returns the latest main sleep unchanged", async () => {
      const mockClient = clientReturning(pageOf(MAIN_SLEEP));

      const result = await def.fetch(mockClient);
      expect(result).toEqual(MAIN_SLEEP);
      expect(mockClient.get).toHaveBeenCalledWith(
        `/v2/activity/sleep?limit=${SLEEP_LOOKBACK_LIMIT}`,
        { cache: true, ttlMs: CYCLE_TTL_MS }
      );
    });

    it("skips a more recent nap and says so", async () => {
      const result = (await def.fetch(clientReturning(pageOf(NAP, MAIN_SLEEP)))) as Record<
        string,
        unknown
      >;

      expect(result).toMatchObject({ id: MAIN_SLEEP.id, nap: false });
      expect(result.notes).toEqual([expect.stringContaining("naps are not shown")]);
    });

    it("returns the latest nap with a note when only naps are found", async () => {
      const result = (await def.fetch(clientReturning(pageOf(NAP)))) as Record<string, unknown>;

      expect(result).toMatchObject({ id: NAP.id, nap: true });
      expect(result.notes).toEqual([expect.stringContaining("Only naps")]);
    });

    it("explains a main sleep that is not scored yet", async () => {
      const pending = { ...MAIN_SLEEP, score_state: "PENDING_SCORE", score: undefined };
      const result = (await def.fetch(clientReturning(pageOf(pending)))) as { notes: string[] };

      expect(result.notes).toEqual([expect.stringContaining("not scored this sleep yet")]);
    });

    it("returns empty message when no records", async () => {
      const result = await def.fetch(clientReturning(pageOf()));
      expect(result).toEqual({ message: "No sleep data available yet." });
    });

    it("treats a missing records field as no data", async () => {
      const result = await def.fetch(clientReturning({ next_token: null }));
      expect(result).toEqual({ message: "No sleep data available yet." });
    });
  });

  describe("cycle latest fetcher", () => {
    const def = definition("whoop://v2/user/cycle/latest");

    it("returns a closed cycle unchanged", async () => {
      const mockClient = clientReturning(pageOf(CLOSED_CYCLE));

      const result = await def.fetch(mockClient);
      expect(result).toEqual(CLOSED_CYCLE);
      expect(mockClient.get).toHaveBeenCalledWith("/v2/cycle?limit=1", {
        cache: true,
        ttlMs: CYCLE_TTL_MS,
      });
    });

    it("marks the current cycle (end null) as in progress", async () => {
      const result = (await def.fetch(clientReturning(pageOf(OPEN_CYCLE)))) as Record<
        string,
        unknown
      >;

      expect(result).toMatchObject({ id: OPEN_CYCLE.id, end: null });
      expect(result.notes).toEqual([expect.stringContaining("still in progress")]);
    });

    it("treats a missing end as in progress too", async () => {
      const result = (await def.fetch(clientReturning(pageOf({ id: 200 })))) as Record<
        string,
        unknown
      >;
      expect(result.notes).toEqual([expect.stringContaining("still in progress")]);
    });

    it("returns empty message when no records", async () => {
      const result = await def.fetch(clientReturning(pageOf()));
      expect(result).toEqual({ message: "No cycle data available yet." });
    });
  });

  describe("profile fetcher", () => {
    const def = definition("whoop://v2/user/profile");

    it("returns profile from profile endpoint", async () => {
      const mockClient = clientReturning({ first_name: "Jane" });

      const result = await def.fetch(mockClient);
      expect(result).toEqual({ first_name: "Jane" });
      expect(mockClient.get).toHaveBeenCalledWith("/v2/user/profile/basic", {
        cache: true,
        ttlMs: PROFILE_TTL_MS,
      });
    });
  });
});

// ---------------------------------------------------------------------------
// registerResources tests
// ---------------------------------------------------------------------------

type ReadCallback = (uri: URL) => Promise<{ contents: Array<{ text: string }> }>;

function mockLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function recoveryReadCallback(mockClient: WhoopClient, logger?: Logger): ReadCallback {
  const mockServer = { registerResource: vi.fn() };
  registerResources(mockServer as never, mockClient, logger ? { logger } : {});
  const recoveryCall = mockServer.registerResource.mock.calls.find(
    (c: unknown[]) => c[1] === "whoop://v2/user/recovery/latest"
  );
  return recoveryCall![3] as ReadCallback;
}

describe("registerResources", () => {
  it("registers 5 resources on the server", () => {
    const mockServer = {
      registerResource: vi.fn(),
    };
    const mockClient: WhoopClient = { get: vi.fn().mockResolvedValue({}) };

    registerResources(mockServer as never, mockClient);

    expect(mockServer.registerResource).toHaveBeenCalledTimes(5);
  });

  it("registers resources with correct URIs and metadata", () => {
    const mockServer = {
      registerResource: vi.fn(),
    };
    const mockClient: WhoopClient = { get: vi.fn().mockResolvedValue({}) };

    registerResources(mockServer as never, mockClient);

    const calls = mockServer.registerResource.mock.calls;
    const uris = calls.map((c: unknown[]) => c[1]);

    expect(uris).toContain("whoop://v2/user/recovery/latest");
    expect(uris).toContain("whoop://v2/user/sleep/latest");
    expect(uris).toContain("whoop://v2/user/cycle/latest");
    expect(uris).toContain("whoop://v2/user/workout/latest");
    expect(uris).toContain("whoop://v2/user/profile");
  });

  it("resource read callback returns JSON content", async () => {
    const callback = recoveryReadCallback({
      get: vi.fn().mockResolvedValue({ records: [{ recovery_score: 85 }] }),
    });
    const result = await callback(new URL("whoop://v2/user/recovery/latest"));

    expect(result).toEqual({
      contents: [
        {
          uri: "whoop://v2/user/recovery/latest",
          mimeType: "application/json",
          text: JSON.stringify({ recovery_score: 85 }, null, 2),
        },
      ],
    });
  });

  it("resource read callback returns error JSON on failure", async () => {
    // Suppress stderr output during this test
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const callback = recoveryReadCallback({
      get: vi.fn().mockRejectedValue(new Error("API timeout")),
    });
    const result = await callback(new URL("whoop://v2/user/recovery/latest"));

    expect(result).toEqual({
      contents: [
        {
          uri: "whoop://v2/user/recovery/latest",
          mimeType: "application/json",
          text: JSON.stringify({
            error: "Resource unavailable. Retry later or verify authorization.",
          }),
        },
      ],
    });

    stderrSpy.mockRestore();
  });

  it.each([
    [new WhoopApiError(429, "Too Many Requests", { detail: "SECRET" }), "rate limit"],
    [new WhoopApiError(503, "Service Unavailable", "SECRET"), "temporarily unavailable"],
    [new WhoopAuthError(new Error("invalid_grant SECRET")), "setup --verify"],
    [new WhoopNetworkError(new TypeError("fetch failed SECRET")), "Network error"],
  ])("explains WHOOP failures in the resource error (%s)", async (error, phrase) => {
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = mockLogger();
    const callback = recoveryReadCallback({ get: vi.fn().mockRejectedValue(error) }, logger);
    const result = await callback(new URL("whoop://v2/user/recovery/latest"));

    const payload = JSON.parse(result.contents[0]!.text) as { error: string };
    expect(payload.error).toMatch(/^Resource unavailable\. /);
    expect(payload.error).toContain(phrase);
    expect(payload.error).not.toContain("SECRET");
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain("SECRET");
    expect(stderrSpy).not.toHaveBeenCalled();

    stderrSpy.mockRestore();
  });

  it("logs a read failure at warn with the URI, error class and HTTP status only", async () => {
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = mockLogger();
    const apiCallback = recoveryReadCallback(
      {
        get: vi.fn().mockRejectedValue(new WhoopApiError(503, "Unavailable", { token: "SECRET" })),
      },
      logger
    );
    await apiCallback(new URL("whoop://v2/user/recovery/latest"));
    const authCallback = recoveryReadCallback(
      {
        get: vi
          .fn()
          .mockRejectedValue(
            new WhoopAuthError(new WhoopApiError(401, "Unauthorized", "SECRET body"))
          ),
      },
      logger
    );
    await authCallback(new URL("whoop://v2/user/recovery/latest"));
    const plainCallback = recoveryReadCallback(
      { get: vi.fn().mockRejectedValue(new Error("timeout SECRET")) },
      logger
    );
    await plainCallback(new URL("whoop://v2/user/recovery/latest"));

    expect(vi.mocked(logger.warn).mock.calls).toEqual([
      [
        "resource read failed",
        { uri: "whoop://v2/user/recovery/latest", errorClass: "WhoopApiError", httpStatus: 503 },
      ],
      [
        "resource read failed",
        { uri: "whoop://v2/user/recovery/latest", errorClass: "WhoopAuthError", httpStatus: 401 },
      ],
      ["resource read failed", { uri: "whoop://v2/user/recovery/latest", errorClass: "Error" }],
    ]);
    expect(logger.error).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();

    stderrSpy.mockRestore();
  });

  it("reads without logging when no logger is passed", async () => {
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const callback = recoveryReadCallback({ get: vi.fn().mockRejectedValue(new Error("x")) });
    const result = await callback(new URL("whoop://v2/user/recovery/latest"));

    expect(result.contents[0]!.text).toContain("Resource unavailable");
    expect(stderrSpy).not.toHaveBeenCalled();
    stderrSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Linkage to the latest cycle (latest recovery/sleep must not pose as today's)
// ---------------------------------------------------------------------------

type Pages = Record<string, unknown>;

const RECOVERY_PATH = "/v2/recovery?limit=1";
const SLEEP_PATH = `/v2/activity/sleep?limit=${SLEEP_LOOKBACK_LIMIT}`;
const CYCLE_PATH = "/v2/cycle?limit=1";

/** Earlier cycle's main sleep and recovery (the night of 14 -> 15 September). */
const EARLIER_SLEEP = {
  ...MAIN_SLEEP,
  id: "0b1c2d3e-4f50-4a61-8b72-9c8d7e6f5a4b",
  cycle_id: CLOSED_CYCLE.id,
  start: "2026-09-14T21:15:00.000Z",
  end: "2026-09-15T05:00:00.000Z",
};
const EARLIER_RECOVERY = {
  ...CALIBRATING_RECOVERY,
  cycle_id: CLOSED_CYCLE.id,
  sleep_id: EARLIER_SLEEP.id,
  score: { ...CALIBRATING_RECOVERY.score, recovery_score: 95 },
};

/**
 * A client serving `cached` for cached GETs and `fresh` for GETs that bypass the
 * cache (what WHOOP returns right now). An Error value is thrown.
 */
function linkedClient(cached: Pages, fresh: Pages = cached): WhoopClient {
  return {
    get: vi.fn((path: string, options?: WhoopGetOptions) => {
      const value = (options?.cache === true ? cached : fresh)[path];
      if (value instanceof Error) return Promise.reject(value);
      if (value === undefined) return Promise.reject(new Error(`unexpected path ${path}`));
      return Promise.resolve(value);
    }),
  } as unknown as WhoopClient;
}

function uncachedPaths(client: WhoopClient): string[] {
  const calls = (client.get as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  return calls.filter((call) => call[1] === undefined).map((call) => String(call[0]));
}

describe("latest recovery/sleep linkage to the latest cycle", () => {
  const recoveryDef = definition("whoop://v2/user/recovery/latest");
  const sleepDef = definition("whoop://v2/user/sleep/latest");

  it("flags a recovery from an earlier cycle while the current cycle has none yet", async () => {
    const client = linkedClient({
      [RECOVERY_PATH]: pageOf(EARLIER_RECOVERY),
      [CYCLE_PATH]: pageOf(OPEN_CYCLE),
    });

    const result = (await recoveryDef.fetch(client)) as { cycle_id: number; notes: string[] };

    expect(result).toMatchObject({ cycle_id: CLOSED_CYCLE.id, score: { recovery_score: 95 } });
    expect(result.notes[0]).toContain("belongs to an earlier cycle (cycle_id 1002)");
    expect(result.notes[0]).toContain(
      "the current cycle (id 1003, started 2026-09-15T23:40+02:00)"
    );
    expect(result.notes[0]).toContain("not available yet");
    expect(result.notes[0]).toContain("Don't present it as today's recovery");
    expect(result.notes[1]).toContain("still calibrating");
    // The mismatch was re-checked against WHOOP, bypassing the cache.
    expect(uncachedPaths(client).sort()).toEqual([CYCLE_PATH, RECOVERY_PATH]);
  });

  it("adds no cycle note and makes no uncached call when the recovery is the current cycle's", async () => {
    const client = linkedClient({
      [RECOVERY_PATH]: pageOf(CALIBRATING_RECOVERY),
      [CYCLE_PATH]: pageOf(OPEN_CYCLE),
    });

    const result = (await recoveryDef.fetch(client)) as { notes: string[] };

    expect(result.notes).toEqual([expect.stringContaining("still calibrating")]);
    expect(uncachedPaths(client)).toEqual([]);
  });

  it("uses the fresh recovery when only the cached recovery is out of step with the cycle", async () => {
    const client = linkedClient(
      { [RECOVERY_PATH]: pageOf(EARLIER_RECOVERY), [CYCLE_PATH]: pageOf(OPEN_CYCLE) },
      { [RECOVERY_PATH]: pageOf(CALIBRATING_RECOVERY), [CYCLE_PATH]: pageOf(OPEN_CYCLE) }
    );

    const result = (await recoveryDef.fetch(client)) as { cycle_id: number; notes: string[] };

    expect(result).toMatchObject({ cycle_id: OPEN_CYCLE.id, score: { recovery_score: 58 } });
    expect(JSON.stringify(result.notes)).not.toContain("earlier cycle");
  });

  it("does not blame the recovery when only the cached cycle is stale", async () => {
    const staleOpenCycle = { ...CLOSED_CYCLE, end: null };
    const client = linkedClient(
      { [RECOVERY_PATH]: pageOf(CALIBRATING_RECOVERY), [CYCLE_PATH]: pageOf(staleOpenCycle) },
      { [RECOVERY_PATH]: pageOf(CALIBRATING_RECOVERY), [CYCLE_PATH]: pageOf(OPEN_CYCLE) }
    );

    const result = (await recoveryDef.fetch(client)) as { cycle_id: number; notes: string[] };

    expect(result.cycle_id).toBe(OPEN_CYCLE.id);
    expect(JSON.stringify(result.notes)).not.toContain("cycle_id");
  });

  it("says the link could not be confirmed when the re-check fails", async () => {
    const client = linkedClient(
      { [RECOVERY_PATH]: pageOf(EARLIER_RECOVERY), [CYCLE_PATH]: pageOf(OPEN_CYCLE) },
      { [RECOVERY_PATH]: new Error("429"), [CYCLE_PATH]: new Error("429") }
    );

    const result = (await recoveryDef.fetch(client)) as { cycle_id: number; notes: string[] };

    expect(result.cycle_id).toBe(CLOSED_CYCLE.id);
    expect(result.notes[0]).toContain("could not be re-checked");
    expect(result.notes[0]).toContain("get_today");
  });

  it("still returns the recovery when the cycle cannot be read", async () => {
    const client = linkedClient({
      [RECOVERY_PATH]: pageOf(EARLIER_RECOVERY),
      [CYCLE_PATH]: new Error("503"),
    });

    const result = (await recoveryDef.fetch(client)) as { cycle_id: number; notes: string[] };

    expect(result.cycle_id).toBe(CLOSED_CYCLE.id);
    expect(result.notes).toEqual([expect.stringContaining("still calibrating")]);
  });

  it("names the latest (closed) cycle without calling the recovery today's", async () => {
    const closedLatest = { ...OPEN_CYCLE, end: "2026-09-16T21:00:00.000Z" };
    const client = linkedClient({
      [RECOVERY_PATH]: pageOf(EARLIER_RECOVERY),
      [CYCLE_PATH]: pageOf(closedLatest),
    });

    const result = (await recoveryDef.fetch(client)) as { notes: string[] };

    expect(result.notes[0]).toContain("not the latest cycle (id 1003");
    expect(result.notes[0]).not.toContain("today's");
  });

  it("flags last night's sleep as missing when the latest main sleep is from an earlier cycle", async () => {
    const client = linkedClient({
      [SLEEP_PATH]: pageOf(EARLIER_SLEEP),
      [CYCLE_PATH]: pageOf(OPEN_CYCLE),
    });

    const result = (await sleepDef.fetch(client)) as { id: string; notes: string[] };

    expect(result.id).toBe(EARLIER_SLEEP.id);
    expect(result.notes).toEqual([
      expect.stringContaining("This sleep belongs to an earlier cycle (cycle_id 1002)"),
    ]);
    expect(result.notes[0]).toContain("last night's");
    expect(result.notes[0]).toContain("Don't present it as today's sleep");
  });

  it("keeps the nap note next to the earlier-cycle note", async () => {
    const newerNap = { ...NAP, cycle_id: CLOSED_CYCLE.id, start: "2026-09-15T12:00:00.000Z" };
    const client = linkedClient({
      [SLEEP_PATH]: pageOf(newerNap, EARLIER_SLEEP),
      [CYCLE_PATH]: pageOf(OPEN_CYCLE),
    });

    const result = (await sleepDef.fetch(client)) as { notes: string[] };

    expect(result.notes).toEqual([
      expect.stringContaining("earlier cycle"),
      expect.stringContaining("naps are not shown"),
    ]);
  });

  it("does not add a cycle note to a nap-only result or a current main sleep", async () => {
    const napOnly = await sleepDef.fetch(
      linkedClient({ [SLEEP_PATH]: pageOf(NAP), [CYCLE_PATH]: pageOf(CLOSED_CYCLE) })
    );
    expect(JSON.stringify(napOnly)).not.toContain("earlier cycle");

    const current = await sleepDef.fetch(
      linkedClient({ [SLEEP_PATH]: pageOf(MAIN_SLEEP), [CYCLE_PATH]: pageOf(OPEN_CYCLE) })
    );
    expect(current).toEqual(MAIN_SLEEP);
  });

  it("serves today's recovery after a morning sync despite an older cached read (real client and cache)", async () => {
    // Live timeline: the cycle is read (and cached) at 05:16, recovery and sleep at 05:17, all
    // before the strap syncs; the new cycle, sleep and recovery appear; at 05:18:30 the cycle
    // entry has expired but the recovery and sleep entries have not.
    let synced = false;
    let clock = Date.parse("2026-09-16T05:16:00.000Z");
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);
    const fetchSpy = vi.fn((input: string | URL) => {
      const path = new URL(String(input)).pathname;
      const body = path.startsWith("/v2/cycle")
        ? pageOf(synced ? OPEN_CYCLE : { ...CLOSED_CYCLE, end: null })
        : path.startsWith("/v2/recovery")
          ? pageOf(synced ? CALIBRATING_RECOVERY : EARLIER_RECOVERY)
          : pageOf(synced ? MAIN_SLEEP : EARLIER_SLEEP);
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      );
    });
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const client = createWhoopClient({
        accessToken: "test-token",
        baseUrl: "https://api.test",
        cache: new MemoryCache(),
      });
      const cycleBefore = (await definition("whoop://v2/user/cycle/latest").fetch(client)) as {
        id: number;
      };
      expect(cycleBefore.id).toBe(CLOSED_CYCLE.id);

      clock += 60_000;
      const before = (await recoveryDef.fetch(client)) as { cycle_id: number; notes: string[] };
      const sleepBefore = (await sleepDef.fetch(client)) as { id: string; notes?: string[] };
      // Consistent with the cycle known at the time: no earlier-cycle note.
      expect(before.cycle_id).toBe(CLOSED_CYCLE.id);
      expect(JSON.stringify(before.notes)).not.toContain("earlier cycle");
      expect(sleepBefore).toMatchObject({ id: EARLIER_SLEEP.id });
      expect(sleepBefore.notes).toBeUndefined();

      synced = true;
      clock += 90_000;
      const after = (await recoveryDef.fetch(client)) as { cycle_id: number; notes: string[] };
      expect(after).toMatchObject({ cycle_id: OPEN_CYCLE.id, score: { recovery_score: 58 } });
      expect(JSON.stringify(after.notes)).not.toContain("earlier cycle");

      const sleepAfter = (await sleepDef.fetch(client)) as { id: string; notes?: string[] };
      expect(sleepAfter.id).toBe(MAIN_SLEEP.id);
      expect(sleepAfter.notes).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
      nowSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Latest workout
// ---------------------------------------------------------------------------

describe("latest workout resource", () => {
  const workoutDef = definition("whoop://v2/user/workout/latest");
  const LIVE = liveShapedUser();
  const LIVE_OPEN_CYCLE = LIVE.cycles.find((cycle) => cycle.id === LIVE_SHAPED_IDS.cycles.open)!;
  const byId = (id: string): Workout => LIVE.workouts.find((workout) => workout.id === id)!;
  const eveningRun = byId(LIVE_SHAPED_IDS.workouts.eveningRun);
  const weightlifting = byId(LIVE_SHAPED_IDS.workouts.weightliftingDay3);
  const padel = byId(LIVE_SHAPED_IDS.workouts.padel);

  type Summary = Record<string, unknown> & { notes?: string[] };

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function pinNow(iso: string = LIVE.now.toISOString()): void {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(iso);
  }

  function workoutClient(
    workouts: unknown[],
    cycles: unknown = pageOf(LIVE_OPEN_CYCLE)
  ): WhoopClient {
    return linkedClient({
      [WORKOUT_LIST_PATH]: pageOf(...workouts),
      [CYCLE_PATH]: cycles,
    });
  }

  it("reads get_today's workout list key and the cycle resource's key, both with the cycle TTL", async () => {
    pinNow();
    const client = workoutClient([eveningRun]);
    await workoutDef.fetch(client);

    expect(WORKOUT_LIST_PATH).toBe(TODAY_LIST_PATHS.workout);
    expect(workoutDef.ttlMs).toBe(CYCLE_TTL_MS);
    expect(client.get).toHaveBeenCalledWith(WORKOUT_LIST_PATH, {
      cache: true,
      ttlMs: CYCLE_TTL_MS,
    });
    expect(client.get).toHaveBeenCalledWith(CYCLE_PATH, { cache: true, ttlMs: CYCLE_TTL_MS });
  });

  it("summarizes the live-shaped evening run, keeping sport_id 0 and placing it on the cycle's day", async () => {
    pinNow();
    const result = (await workoutDef.fetch(workoutClient(LIVE.workouts))) as Summary;

    expect(workoutSummarySchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({
      id: eveningRun.id,
      sport_name: "running",
      sport_id: 0,
      day: "2026-09-16",
      local_date: "2026-09-16",
      start_local: "2026-09-16T19:26:03.118+02:00",
      score_state: "SCORED",
      recorded_fraction: 1,
      flags: ["cycle_in_progress"],
    });
    expect(result.gps).not.toBeNull();
    expect(result.notes).toBeUndefined();
  });

  it("chooses the newest finished workout over one still in progress", async () => {
    pinNow("2026-09-16T17:00:00.000Z"); // 19:00 local: the evening run has not ended yet
    const inProgress: Workout = { ...eveningRun, start: "2026-09-16T16:50:00.000Z" };
    const result = (await workoutDef.fetch(
      workoutClient([inProgress, weightlifting, padel])
    )) as Summary;

    expect(result.id).toBe(weightlifting.id);
  });

  it("returns a message when no workout has finished", async () => {
    pinNow("2026-09-16T17:00:00.000Z");
    const inProgress: Workout = { ...eveningRun, start: "2026-09-16T16:50:00.000Z" };

    expect(await workoutDef.fetch(workoutClient([]))).toEqual({
      message: "No workout data available yet.",
    });
    expect(await workoutDef.fetch(workoutClient([inProgress]))).toEqual({
      message: "No workout data available yet.",
    });
  });

  it("explains a workout WHOOP has not scored yet", async () => {
    pinNow();
    const pending: Workout = { ...eveningRun, score_state: "PENDING_SCORE", score: null };
    const result = (await workoutDef.fetch(workoutClient([pending]))) as Summary;

    expect(result).toMatchObject({
      score_state: "PENDING_SCORE",
      strain: null,
      zone_minutes: null,
      recorded_fraction: null,
      gps: null,
      flags: ["cycle_in_progress", "not_scored"],
    });
    expect(result.notes).toEqual([
      "WHOOP has not scored this workout yet (PENDING_SCORE); score values are missing until it does.",
    ]);
  });

  it("notes a workout that started before the current cycle and dates it by its start", async () => {
    pinNow();
    const result = (await workoutDef.fetch(workoutClient([padel]))) as Summary;

    expect(result).toMatchObject({ id: padel.id, day: "2026-09-15", flags: ["day_by_fallback"] });
    expect(result.notes).toEqual([
      "This workout started before the current WHOOP cycle (started 2026-09-15T23:13+02:00), so it is not part of that cycle's strain.",
    ]);
  });

  it("notes partial heart-rate data and the strength-training caveat", async () => {
    pinNow();
    const partial: Workout = {
      ...weightlifting,
      score: { ...weightlifting.score!, percent_recorded: 0.62 },
    };
    const result = (await workoutDef.fetch(workoutClient([partial]))) as Summary;

    expect(result.flags).toContain("low_recording");
    expect(result.notes).toEqual([
      "Heart-rate data covers only 62% of this workout, so its strain, heart-rate zones and calories reflect the recorded part only.",
      "Heart-rate zones and strain measure cardiovascular load, which can understate the muscular effort of strength training.",
    ]);
  });

  it("still summarizes the workout when the cycle cannot be read", async () => {
    pinNow();
    const result = (await workoutDef.fetch(
      workoutClient([eveningRun], new Error("503"))
    )) as Summary;

    expect(result).toMatchObject({ id: eveningRun.id, flags: ["day_by_fallback"] });
    expect(result.notes).toEqual([expect.stringContaining("could not be read")]);
  });

  it("rejects when the workout list cannot be read, so the read callback explains it", async () => {
    pinNow();
    const error = new WhoopApiError(429, "Too Many Requests", {});
    const mockServer = { registerResource: vi.fn() };
    const logger = mockLogger();
    registerResources(
      mockServer as never,
      linkedClient({ [WORKOUT_LIST_PATH]: error, [CYCLE_PATH]: pageOf(LIVE_OPEN_CYCLE) }),
      { logger }
    );
    const call = mockServer.registerResource.mock.calls.find(
      (c: unknown[]) => c[1] === "whoop://v2/user/workout/latest"
    )!;
    const result = await (call[3] as ReadCallback)(new URL("whoop://v2/user/workout/latest"));

    expect(JSON.parse(result.contents[0]!.text)).toEqual({
      error:
        "Resource unavailable. WHOOP rate limit reached (HTTP 429). Wait a minute, then retry.",
    });
    expect(logger.warn).toHaveBeenCalledWith("resource read failed", {
      uri: "whoop://v2/user/workout/latest",
      errorClass: "WhoopApiError",
      httpStatus: 429,
    });
  });

  it("shares one workout request with get_today within the TTL (real client and cache)", async () => {
    pinNow();
    const fixture = createWhoopFixtureClient(LIVE);
    const workoutFetches: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = new URL(String(input));
        const path = `${url.pathname}${url.search}`;
        if (url.pathname === "/v2/activity/workout") workoutFetches.push(path);
        return new Response(JSON.stringify(await fixture.get(path)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      })
    );
    const client = createWhoopClient({
      accessToken: "test-token",
      baseUrl: "https://api.test",
      cache: new MemoryCache(),
    });

    const today = await getToday(client, LIVE.now);
    vi.setSystemTime(LIVE.now.getTime() + 60_000);
    const result = (await workoutDef.fetch(client)) as Summary;

    expect(today.strain?.last_workout?.sport_name).toBe("running");
    expect(result.id).toBe(eveningRun.id);
    expect(workoutFetches).toEqual(["/v2/activity/workout?limit=25"]);
  });

  it("is listed and read through the MCP server in standard mode, and absent in aggregate mode, where only the guide is listed", async () => {
    pinNow();
    const standard = await connectServer(createWhoopFixtureClient(LIVE));
    try {
      const listed = (await standard.listResources()).find(
        (resource) => resource.uri === "whoop://v2/user/workout/latest"
      );
      expect(listed).toMatchObject({ name: "Latest Workout", mimeType: "application/json" });
      const read = await standard.readResource("whoop://v2/user/workout/latest");
      const content = read.contents[0] as { text: string };
      expect(JSON.parse(content.text)).toMatchObject({ id: eveningRun.id, sport_id: 0 });
    } finally {
      await standard.close();
    }

    const aggregate = await connectServer(createWhoopFixtureClient(LIVE), {
      privacyMode: "aggregate",
    });
    try {
      expect((await aggregate.listResources()).map((resource) => resource.uri)).toEqual([
        "whoop://server/guide",
      ]);
      await expect(aggregate.readResource("whoop://v2/user/workout/latest")).rejects.toThrow();
    } finally {
      await aggregate.close();
    }
  });
});
