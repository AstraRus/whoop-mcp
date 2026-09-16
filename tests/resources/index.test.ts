import { describe, it, expect, vi } from "vitest";
import {
  RESOURCE_DEFINITIONS,
  registerResources,
  DYNAMIC_TTL_MS,
  CYCLE_TTL_MS,
  PROFILE_TTL_MS,
  SLEEP_LOOKBACK_LIMIT,
} from "../../src/resources/index.js";
import type { WhoopClient } from "../../src/api/client.js";
import { WhoopApiError, WhoopAuthError, WhoopNetworkError } from "../../src/api/client.js";

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
  it("defines exactly 4 resources", () => {
    expect(RESOURCE_DEFINITIONS).toHaveLength(4);
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

  it("recovery and sleep resources use 5-minute TTL", () => {
    const fiveMinResources = RESOURCE_DEFINITIONS.filter(
      (d) => d.uri === "whoop://v2/user/recovery/latest" || d.uri === "whoop://v2/user/sleep/latest"
    );
    expect(fiveMinResources).toHaveLength(2);
    for (const def of fiveMinResources) {
      expect(def.ttlMs).toBe(DYNAMIC_TTL_MS);
    }
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
        ttlMs: DYNAMIC_TTL_MS,
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
        { cache: true, ttlMs: DYNAMIC_TTL_MS }
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

function recoveryReadCallback(mockClient: WhoopClient): ReadCallback {
  const mockServer = { registerResource: vi.fn() };
  registerResources(mockServer as never, mockClient);
  const recoveryCall = mockServer.registerResource.mock.calls.find(
    (c: unknown[]) => c[1] === "whoop://v2/user/recovery/latest"
  );
  return recoveryCall![3] as ReadCallback;
}

describe("registerResources", () => {
  it("registers 4 resources on the server", () => {
    const mockServer = {
      registerResource: vi.fn(),
    };
    const mockClient: WhoopClient = { get: vi.fn().mockResolvedValue({}) };

    registerResources(mockServer as never, mockClient);

    expect(mockServer.registerResource).toHaveBeenCalledTimes(4);
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
    const callback = recoveryReadCallback({ get: vi.fn().mockRejectedValue(error) });
    const result = await callback(new URL("whoop://v2/user/recovery/latest"));

    const payload = JSON.parse(result.contents[0]!.text) as { error: string };
    expect(payload.error).toMatch(/^Resource unavailable\. /);
    expect(payload.error).toContain(phrase);
    expect(payload.error).not.toContain("SECRET");
    expect(JSON.stringify(stderrSpy.mock.calls)).not.toContain("SECRET");

    stderrSpy.mockRestore();
  });

  it("resource read logs errors to stderr", async () => {
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const callback = recoveryReadCallback({
      get: vi.fn().mockRejectedValue(new Error("timeout")),
    });
    await callback(new URL("whoop://v2/user/recovery/latest"));

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Resource read failed"));

    stderrSpy.mockRestore();
  });
});
