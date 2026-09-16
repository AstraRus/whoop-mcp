/**
 * Regression tests for payload shapes the live WHOOP API actually sends but
 * the spec only calls "optional": explicit nulls (next_token on the last page,
 * GPS fields on non-GPS workouts, v1_id, optional score fields), the "Z"
 * offset, and bare dates that WHOOP rejects with a 404.
 */

import { describe, it, expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { createWhoopServer, describeContractIssues } from "../src/server.js";
import type { WhoopClient } from "../src/api/client.js";
import { fetchAllPages } from "../src/api/pagination.js";
import {
  cycleRecordSchema,
  recoveryRecordSchema,
  sleepRecordSchema,
  workoutRecordSchema,
} from "../src/api/record-schemas.js";
import { loadAnalyticsSource, localDay } from "../src/tools/analytics-utils.js";
import { buildLocalCollectionQuery, resolveUserUtcOffset } from "../src/tools/collection-utils.js";

const RECOVERY = {
  cycle_id: 3,
  sleep_id: "4be8213f-9bf5-4a74-a3d5-527537891f05",
  user_id: 1,
  created_at: "2026-09-16T05:17:36.057Z",
  updated_at: "2026-09-16T05:17:36.057Z",
  score_state: "SCORED",
  score: {
    user_calibrating: true,
    recovery_score: 66,
    resting_heart_rate: 60,
    hrv_rmssd_milli: 107.9,
    spo2_percentage: null,
    skin_temp_celsius: null,
  },
};

const SLEEP = {
  id: "4be8213f-9bf5-4a74-a3d5-527537891f05",
  cycle_id: 3,
  v1_id: null,
  user_id: 1,
  created_at: "2026-09-16T05:17:36.057Z",
  updated_at: "2026-09-16T05:17:36.057Z",
  start: "2026-09-15T21:13:31.460Z",
  end: "2026-09-16T05:13:59.350Z",
  timezone_offset: "+02:00",
  nap: false,
  score_state: "SCORED",
  score: {
    stage_summary: {
      total_in_bed_time_milli: 28827890,
      total_awake_time_milli: 2446050,
      total_no_data_time_milli: 0,
      total_light_sleep_time_milli: 12693470,
      total_slow_wave_sleep_time_milli: 4848100,
      total_rem_sleep_time_milli: 8840270,
      sleep_cycle_count: 5,
      disturbance_count: 13,
    },
    sleep_needed: {
      baseline_milli: 28432150,
      need_from_sleep_debt_milli: 3148936,
      need_from_recent_strain_milli: 3915042,
      need_from_recent_nap_milli: 0,
    },
    respiratory_rate: null,
    sleep_performance_percentage: null,
    sleep_efficiency_percentage: null,
    sleep_consistency_percentage: null,
  },
};

const CYCLE = {
  id: 3,
  user_id: 1,
  created_at: "2026-09-16T05:17:30.602Z",
  updated_at: "2026-09-16T06:57:49.180Z",
  start: "2026-09-15T21:13:31.460Z",
  end: null,
  timezone_offset: "+02:00",
  score_state: "SCORED",
  score: { strain: 7.7, kilojoule: 5614.2, average_heart_rate: 66, max_heart_rate: 155 },
};

const WORKOUT = {
  id: "0f7e1b52-5c34-4a2a-9d8d-2b6f3c1c9a10",
  v1_id: null,
  user_id: 1,
  created_at: "2026-09-15T18:00:00.000Z",
  updated_at: "2026-09-15T18:05:00.000Z",
  start: "2026-09-15T17:00:00.000Z",
  end: "2026-09-15T17:45:00.000Z",
  timezone_offset: "+02:00",
  sport_name: "weightlifting",
  sport_id: null,
  score_state: "SCORED",
  score: {
    strain: 9.1,
    average_heart_rate: 120,
    max_heart_rate: 160,
    kilojoule: 1200,
    percent_recorded: 100,
    distance_meter: null,
    altitude_gain_meter: null,
    altitude_change_meter: null,
    zone_durations: {
      zone_zero_milli: 0,
      zone_one_milli: 600000,
      zone_two_milli: 900000,
      zone_three_milli: 900000,
      zone_four_milli: 300000,
      zone_five_milli: 0,
    },
  },
};

const LAST_PAGES: Record<string, unknown> = {
  "/v2/recovery": { records: [RECOVERY], next_token: null },
  "/v2/activity/sleep": { records: [SLEEP], next_token: null },
  "/v2/cycle": { records: [CYCLE], next_token: null },
  "/v2/activity/workout": { records: [WORKOUT], next_token: null },
  "/v2/activity/workout/0f7e1b52-5c34-4a2a-9d8d-2b6f3c1c9a10": WORKOUT,
};

async function connect(
  whoopClient: WhoopClient
): Promise<{ client: Client; close: () => Promise<void> }> {
  const { server } = createWhoopServer(whoopClient);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "live-shapes", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return {
    client,
    close: async (): Promise<void> => {
      await client.close();
      await server.close();
    },
  };
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as Array<{ text: string }>)[0]!.text;
}

describe("record schemas accept explicit nulls for spec-optional fields", () => {
  it.each([
    ["recovery", recoveryRecordSchema, RECOVERY],
    ["sleep", sleepRecordSchema, SLEEP],
    ["cycle", cycleRecordSchema, CYCLE],
    ["workout", workoutRecordSchema, WORKOUT],
  ] as const)("%s", (_name, schema, record) => {
    expect(schema.safeParse(record).success).toBe(true);
  });

  it("accepts the 'Z' timezone offset", () => {
    expect(cycleRecordSchema.safeParse({ ...CYCLE, timezone_offset: "Z" }).success).toBe(true);
    expect(localDay("2026-09-16T23:30:00Z", "Z")).toBe("2026-09-16");
  });
});

describe("collection tools on the last page (next_token: null)", () => {
  const whoopClient: WhoopClient = {
    get: <T>(path: string): Promise<T> => {
      const fixture = LAST_PAGES[path.split("?")[0]!];
      return fixture ? Promise.resolve(fixture as T) : Promise.reject(new Error(path));
    },
  };

  it.each([
    "get_recovery_collection",
    "get_sleep_collection",
    "get_cycle_collection",
    "get_workout_collection",
  ])("%s returns the records instead of a contract error", async (name) => {
    const { client, close } = await connect(whoopClient);
    try {
      const result = await client.callTool({ name, arguments: { start: "2026-09-13" } });
      expect(result.isError, textOf(result)).toBeFalsy();
      expect(JSON.parse(textOf(result))).toMatchObject({ next_token: null });
    } finally {
      await close();
    }
  });

  it("get_workout_by_id accepts a non-GPS workout", async () => {
    const { client, close } = await connect(whoopClient);
    try {
      const result = await client.callTool({
        name: "get_workout_by_id",
        arguments: { id: WORKOUT.id },
      });
      expect(result.isError, textOf(result)).toBeFalsy();
    } finally {
      await close();
    }
  });
});

describe("contract failure diagnostics", () => {
  it("names the failing field and type without echoing values", () => {
    const schema = z.object({ records: z.array(z.object({ strain: z.number() })) });
    const parsed = schema.safeParse({ records: [{ strain: null }, { strain: "secret-value" }] });
    expect(parsed.success).toBe(false);
    const message = describeContractIssues(parsed.error!);
    expect(message).toContain("records.0.strain");
    expect(message).toContain("null");
    expect(message).not.toContain("secret-value");
  });

  it("is included in the tool error text", async () => {
    const { client, close } = await connect({
      get: <T>(): Promise<T> =>
        Promise.resolve({ records: [{ ...CYCLE, score_state: "BOGUS" }], next_token: null } as T),
    });
    try {
      const result = await client.callTool({ name: "get_cycle_collection", arguments: {} });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("records.0.score_state");
    } finally {
      await close();
    }
  });
});

describe("pagination and analytics loading with next_token: null", () => {
  it("fetchAllPages is not truncated when the last page exactly fills maxRecords", async () => {
    const client = {
      get: vi.fn().mockResolvedValue({ records: [{ id: 1 }, { id: 2 }], next_token: null }),
    } as unknown as WhoopClient;
    const result = await fetchAllPages(client, "/v2/cycle", { maxRecords: 2 });
    expect(result).toEqual({ records: [{ id: 1 }, { id: 2 }], truncated: false });
  });

  it("loadAnalyticsSource keeps the records of a final page", async () => {
    const client: WhoopClient = {
      get: <T>(): Promise<T> => Promise.resolve({ records: [SLEEP], next_token: null } as T),
    };
    const { records, quality } = await loadAnalyticsSource(
      client,
      "/v2/activity/sleep",
      { start: "2026-09-10T00:00:00.000Z", end: "2026-09-17T00:00:00.000Z" },
      sleepRecordSchema
    );
    expect(records).toHaveLength(1);
    expect(quality.status).not.toBe("invalid");
    expect(quality.records_fetched).toBe(1);
  });
});

describe("local calendar days for collection queries", () => {
  it("uses the latest cycle's offset for date-only input, cached", async () => {
    const get = vi.fn().mockResolvedValue({ records: [CYCLE], next_token: "t" });
    const query = await buildLocalCollectionQuery({ get } as unknown as WhoopClient, {
      start: "2026-09-13",
    });
    expect(new URLSearchParams(query.slice(1)).get("start")).toBe("2026-09-12T22:00:00.000Z");
    expect(get).toHaveBeenCalledWith("/v2/cycle?limit=1", expect.objectContaining({ cache: true }));
  });

  it("skips the offset lookup when every date names its instant", async () => {
    const get = vi.fn();
    await buildLocalCollectionQuery({ get } as unknown as WhoopClient, {
      start: "2026-09-13T00:00:00Z",
      end: "2026-09-14T00:00:00+02:00",
      limit: 5,
    });
    expect(get).not.toHaveBeenCalled();
  });

  it("falls back to UTC when the offset cannot be read", async () => {
    const failing = { get: vi.fn().mockRejectedValue(new Error("down")) } as unknown as WhoopClient;
    expect(await resolveUserUtcOffset(failing)).toBe("Z");
    const empty = {
      get: vi.fn().mockResolvedValue({ records: [], next_token: null }),
    } as unknown as WhoopClient;
    expect(await resolveUserUtcOffset(empty)).toBe("Z");
  });
});

describe("integration follow-ups", () => {
  it("rejects a reversed collection range locally with a clear message", async () => {
    const { buildCollectionQuery } = await import("../src/tools/collection-utils.js");
    expect(() => buildCollectionQuery({ start: "2026-09-16", end: "2026-09-13" })).toThrow(
      /before start/
    );
    // A single day given as both start and end is fine (whole local day)
    expect(() => buildCollectionQuery({ start: "2026-09-16", end: "2026-09-16" })).not.toThrow();
  });

  it("get_sleep_debt and get_baselines surface the real upstream failure", async () => {
    const { WhoopApiError } = await import("../src/api/client.js");
    const { client, close } = await connect({
      get: <T>(): Promise<T> => Promise.reject(new WhoopApiError(429, "Too Many Requests", "")),
    });
    try {
      for (const name of ["get_sleep_debt", "get_baselines"]) {
        const result = await client.callTool({ name, arguments: {} });
        expect(result.isError).toBe(true);
        expect(textOf(result)).not.toMatch(/internet connection/i);
        expect(textOf(result)).toMatch(/rate|429|too many/i);
      }
    } finally {
      await close();
    }
  });

  it("saveTokens writes atomically and leaves no temp file", async () => {
    const { mkdtemp, readdir, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { saveTokens } = await import("../src/auth/token-store.js");
    const dir = await mkdtemp(join(tmpdir(), "whoop-mcp-atomic-"));
    const tokens = { access_token: "a", refresh_token: "r", expires_at: 1, token_type: "Bearer" };
    await saveTokens(tokens, dir);
    await saveTokens({ ...tokens, refresh_token: "r2" }, dir);
    expect(await readdir(dir)).toEqual(["tokens.json"]);
    expect(JSON.parse(await readFile(join(dir, "tokens.json"), "utf-8"))).toMatchObject({
      refresh_token: "r2",
    });
  });
});
