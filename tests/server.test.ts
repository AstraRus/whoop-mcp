import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createWhoopServer } from "../src/server.js";
import { ADDITIONAL_TOOLS, LEGACY_TOOL_NAMES } from "../src/tools/registry/index.js";
import type { WhoopClient } from "../src/api/client.js";
import { WhoopApiError, WhoopNetworkError, WhoopAuthError } from "../src/api/client.js";
import type {
  UserProfile,
  BodyMeasurement,
  RecoveryCollection,
  SleepCollection,
  WorkoutCollection,
  CycleCollection,
  Sleep,
  Workout,
  Cycle,
} from "../src/api/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROFILE_FIXTURE: UserProfile = {
  user_id: 12345,
  email: "jane@example.com",
  first_name: "Jane",
  last_name: "Doe",
};

const BODY_MEASUREMENT_FIXTURE: BodyMeasurement = {
  height_meter: 1.78,
  weight_kilogram: 75.5,
  max_heart_rate: 195,
};

const RECOVERY_FIXTURE: RecoveryCollection = {
  records: [
    {
      cycle_id: 200,
      sleep_id: "sleep-1",
      user_id: 12345,
      created_at: "2026-04-10T08:00:00.000Z",
      updated_at: "2026-04-10T08:30:00.000Z",
      score_state: "SCORED",
      score: {
        user_calibrating: false,
        recovery_score: 85,
        resting_heart_rate: 52,
        hrv_rmssd_milli: 65.3,
        spo2_percentage: 97.5,
        skin_temp_celsius: 33.2,
      },
    },
  ],
};

const SLEEP_FIXTURE: SleepCollection = {
  records: [
    {
      id: "sleep-1",
      cycle_id: 200,
      user_id: 12345,
      created_at: "2026-04-10T06:00:00.000Z",
      updated_at: "2026-04-10T06:30:00.000Z",
      start: "2026-04-09T23:00:00.000Z",
      end: "2026-04-10T06:00:00.000Z",
      timezone_offset: "-04:00",
      nap: false,
      score_state: "SCORED",
      score: {
        stage_summary: {
          total_in_bed_time_milli: 25200000,
          total_awake_time_milli: 1800000,
          total_no_data_time_milli: 0,
          total_light_sleep_time_milli: 9000000,
          total_slow_wave_sleep_time_milli: 7200000,
          total_rem_sleep_time_milli: 7200000,
          sleep_cycle_count: 4,
          disturbance_count: 2,
        },
        sleep_needed: {
          baseline_milli: 28800000,
          need_from_sleep_debt_milli: 0,
          need_from_recent_strain_milli: 1800000,
          need_from_recent_nap_milli: 0,
        },
        respiratory_rate: 15.2,
        sleep_performance_percentage: 92,
        sleep_consistency_percentage: 85,
        sleep_efficiency_percentage: 93,
      },
    },
  ],
};

const WORKOUT_FIXTURE: WorkoutCollection = {
  records: [
    {
      id: "workout-1",
      user_id: 12345,
      created_at: "2026-04-10T18:00:00.000Z",
      updated_at: "2026-04-10T19:00:00.000Z",
      start: "2026-04-10T17:00:00.000Z",
      end: "2026-04-10T18:00:00.000Z",
      timezone_offset: "-04:00",
      sport_name: "Running",
      score_state: "SCORED",
      score: {
        strain: 14.2,
        average_heart_rate: 155,
        max_heart_rate: 182,
        kilojoule: 2100,
        percent_recorded: 100,
        zone_durations: {
          zone_zero_milli: 0,
          zone_one_milli: 120000,
          zone_two_milli: 600000,
          zone_three_milli: 1200000,
          zone_four_milli: 900000,
          zone_five_milli: 180000,
        },
        distance_meter: 8500,
        altitude_gain_meter: 45,
        altitude_change_meter: 2,
      },
    },
  ],
};

const CYCLE_FIXTURE: CycleCollection = {
  records: [
    {
      id: 200,
      user_id: 12345,
      created_at: "2026-04-10T00:00:00.000Z",
      updated_at: "2026-04-10T23:59:59.000Z",
      start: "2026-04-10T00:00:00.000Z",
      end: "2026-04-10T23:59:59.000Z",
      timezone_offset: "-04:00",
      score_state: "SCORED",
      score: {
        strain: 12.5,
        kilojoule: 9500,
        average_heart_rate: 68,
        max_heart_rate: 182,
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// Individual record fixtures
// ---------------------------------------------------------------------------

const SLEEP_BY_ID_FIXTURE: Sleep = SLEEP_FIXTURE.records[0]!;
const WORKOUT_BY_ID_FIXTURE: Workout = WORKOUT_FIXTURE.records[0]!;
const CYCLE_BY_ID_FIXTURE: Cycle = CYCLE_FIXTURE.records[0]!;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Endpoint-to-fixture mapping for the mock client */
const ENDPOINT_FIXTURES: Record<string, unknown> = {
  "/v2/user/profile/basic": PROFILE_FIXTURE,
  "/v2/user/measurement/body": BODY_MEASUREMENT_FIXTURE,
  "/v2/recovery": RECOVERY_FIXTURE,
  "/v2/activity/sleep": SLEEP_FIXTURE,
  "/v2/activity/workout": WORKOUT_FIXTURE,
  "/v2/cycle": CYCLE_FIXTURE,
};

/** Prefix-to-fixture mapping for individual record lookups */
const ID_LOOKUP_PREFIXES: Array<{ prefix: string; fixture: unknown }> = [
  { prefix: "/v2/activity/sleep/", fixture: SLEEP_BY_ID_FIXTURE },
  { prefix: "/v2/activity/workout/", fixture: WORKOUT_BY_ID_FIXTURE },
  { prefix: "/v2/cycle/", fixture: CYCLE_BY_ID_FIXTURE },
];

/** Mock WhoopClient that returns fixture data based on the endpoint path */
function createMockClient(): WhoopClient {
  return {
    get: async <T>(path: string): Promise<T> => {
      // Strip query string to match base endpoint
      const basePath = path.split("?")[0] ?? path;

      // Check exact match first (collection endpoints)
      const fixture = ENDPOINT_FIXTURES[basePath];
      if (fixture) {
        return fixture as T;
      }

      // Check prefix match for ID lookups
      for (const { prefix, fixture: idFixture } of ID_LOOKUP_PREFIXES) {
        if (basePath.startsWith(prefix)) {
          return idFixture as T;
        }
      }

      throw new Error(`Mock client: unexpected endpoint ${path}`);
    },
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("createWhoopServer", () => {
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const mockWhoopClient = createMockClient();
    const { server } = createWhoopServer(mockWhoopClient);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    client = new Client({ name: "test-client", version: "1.0.0" });

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    cleanup = async () => {
      await client.close();
      await server.close();
    };
  });

  afterAll(async () => {
    await cleanup();
  });

  // -------------------------------------------------------------------------
  // Tool listing
  // -------------------------------------------------------------------------

  describe("tools/list", () => {
    it("returns all registered tools", async () => {
      const result = await client.listTools();

      expect(result.tools).toHaveLength(16 + ADDITIONAL_TOOLS.length);
    });

    it("returns the legacy tools with the correct names", async () => {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name).sort();

      expect(names).toEqual(
        expect.arrayContaining([
          "compare_periods",
          "get_baselines",
          "get_body_measurement",
          "get_calendar",
          "get_cycle_by_id",
          "get_cycle_collection",
          "get_profile",
          "get_recovery_collection",
          "get_sleep_by_id",
          "get_sleep_collection",
          "get_sleep_debt",
          "get_today",
          "get_trend",
          "get_weekly_summary",
          "get_workout_by_id",
          "get_workout_collection",
        ])
      );
      expect(names).toEqual(expect.arrayContaining([...LEGACY_TOOL_NAMES]));
    });

    it("every tool has a description", async () => {
      const result = await client.listTools();

      for (const tool of result.tools) {
        expect(tool.description).toBeTruthy();
        expect(typeof tool.description).toBe("string");
      }
    });

    it("every tool has readOnlyHint annotation", async () => {
      const result = await client.listTools();

      for (const tool of result.tools) {
        expect(tool.annotations?.readOnlyHint).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Input schemas — singleton tools (no params)
  // -------------------------------------------------------------------------

  describe("get_profile schema", () => {
    it("has an object input schema with no required properties", async () => {
      const result = await client.listTools();
      const tool = result.tools.find((t) => t.name === "get_profile");

      expect(tool).toBeDefined();
      expect(tool!.inputSchema.type).toBe("object");
    });
  });

  describe("get_body_measurement schema", () => {
    it("has an object input schema with no required properties", async () => {
      const result = await client.listTools();
      const tool = result.tools.find((t) => t.name === "get_body_measurement");

      expect(tool).toBeDefined();
      expect(tool!.inputSchema.type).toBe("object");
    });
  });

  // -------------------------------------------------------------------------
  // Input schemas — collection tools (start, end, limit, nextToken)
  // -------------------------------------------------------------------------

  const collectionTools = [
    "get_recovery_collection",
    "get_sleep_collection",
    "get_workout_collection",
    "get_cycle_collection",
  ];

  for (const toolName of collectionTools) {
    describe(`${toolName} schema`, () => {
      it("has start, end, limit, and nextToken properties", async () => {
        const result = await client.listTools();
        const tool = result.tools.find((t) => t.name === toolName);

        expect(tool).toBeDefined();
        expect(tool!.inputSchema.type).toBe("object");

        const props = tool!.inputSchema.properties as Record<string, unknown>;
        expect(props).toHaveProperty("start");
        expect(props).toHaveProperty("end");
        expect(props).toHaveProperty("limit");
        expect(props).toHaveProperty("nextToken");
      });
    });
  }

  // -------------------------------------------------------------------------
  // Input schema — compare_periods (ISO 8601 regex validation)
  // -------------------------------------------------------------------------

  describe("compare_periods schema", () => {
    const validInput = {
      period_a_start: "2026-05-01T00:00:00.000Z",
      period_a_end: "2026-05-07T23:59:59.999Z",
      period_b_start: "2026-05-08T00:00:00.000Z",
      period_b_end: "2026-05-14T23:59:59.999Z",
    };

    it("accepts valid YYYY-MM-DD compare_periods inputs", async () => {
      const result = await client.callTool({
        name: "compare_periods",
        arguments: {
          period_a_start: "2026-05-01",
          period_a_end: "2026-05-07",
          period_b_start: "2026-05-08",
          period_b_end: "2026-05-14",
        },
      });
      // Schema accepts; handler may still error on data but not with a schema-validation message
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]!.text).not.toMatch(/Expected ISO 8601/);
    });

    it("accepts valid full ISO 8601 datetime compare_periods inputs", async () => {
      const result = await client.callTool({
        name: "compare_periods",
        arguments: validInput,
      });
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]!.text).not.toMatch(/Expected ISO 8601/);
    });

    it("rejects malformed compare_periods date input at schema level", async () => {
      const result = await client.callTool({
        name: "compare_periods",
        arguments: { ...validInput, period_a_start: "not-a-date" },
      });
      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]!.text).toMatch(/Expected ISO 8601/);
      expect(content[0]!.text).toMatch(/period_a_start/);
    });

    it("rejects relative date expressions at schema level (compare_periods requires explicit ISO)", async () => {
      const result = await client.callTool({
        name: "compare_periods",
        arguments: { ...validInput, period_b_end: "last 7 days" },
      });
      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]!.text).toMatch(/Expected ISO 8601/);
      expect(content[0]!.text).toMatch(/period_b_end/);
    });
  });

  // -------------------------------------------------------------------------
  // Tool handler behavior (real implementations)
  // -------------------------------------------------------------------------

  describe("tool handlers", () => {
    it("get_profile returns user profile as JSON text", async () => {
      const result = await client.callTool({
        name: "get_profile",
        arguments: {},
      });

      expect(result.isError).toBeFalsy();
      expect(result.content).toHaveLength(1);

      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0]!.text) as unknown;
      expect(parsed).toEqual(PROFILE_FIXTURE);
    });

    it("get_body_measurement returns body measurement as JSON text", async () => {
      const result = await client.callTool({
        name: "get_body_measurement",
        arguments: {},
      });

      expect(result.isError).toBeFalsy();
      expect(result.content).toHaveLength(1);

      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0]!.text) as unknown;
      expect(parsed).toEqual(BODY_MEASUREMENT_FIXTURE);
    });

    it("get_recovery_collection returns recovery data as JSON text", async () => {
      const result = await client.callTool({
        name: "get_recovery_collection",
        arguments: {},
      });

      expect(result.isError).toBeFalsy();
      expect(result.content).toHaveLength(1);

      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0]!.text) as unknown;
      expect(parsed).toEqual(RECOVERY_FIXTURE);
    });

    it("get_sleep_collection returns sleep data as JSON text", async () => {
      const result = await client.callTool({
        name: "get_sleep_collection",
        arguments: {},
      });

      expect(result.isError).toBeFalsy();
      expect(result.content).toHaveLength(1);

      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0]!.text) as unknown;
      expect(parsed).toEqual(SLEEP_FIXTURE);
    });

    it("get_workout_collection returns workout data as JSON text", async () => {
      const result = await client.callTool({
        name: "get_workout_collection",
        arguments: {},
      });

      expect(result.isError).toBeFalsy();
      expect(result.content).toHaveLength(1);

      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0]!.text) as unknown;
      expect(parsed).toEqual(WORKOUT_FIXTURE);
    });

    it("get_cycle_collection returns cycle data as JSON text", async () => {
      const result = await client.callTool({
        name: "get_cycle_collection",
        arguments: {},
      });

      expect(result.isError).toBeFalsy();
      expect(result.content).toHaveLength(1);

      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0]!.text) as unknown;
      expect(parsed).toEqual(CYCLE_FIXTURE);
    });

    it("get_sleep_by_id returns a single sleep record", async () => {
      const result = await client.callTool({
        name: "get_sleep_by_id",
        arguments: { id: "sleep-1" },
      });

      expect(result.isError).toBeFalsy();
      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0]!.text) as unknown;
      expect(parsed).toEqual(SLEEP_BY_ID_FIXTURE);
    });

    it("get_workout_by_id returns a single workout record", async () => {
      const result = await client.callTool({
        name: "get_workout_by_id",
        arguments: { id: "workout-1" },
      });

      expect(result.isError).toBeFalsy();
      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0]!.text) as unknown;
      expect(parsed).toEqual(WORKOUT_BY_ID_FIXTURE);
    });

    it("get_cycle_by_id returns a single cycle record", async () => {
      const result = await client.callTool({
        name: "get_cycle_by_id",
        arguments: { id: 200 },
      });

      expect(result.isError).toBeFalsy();
      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0]!.text) as unknown;
      expect(parsed).toEqual(CYCLE_BY_ID_FIXTURE);
    });

    it("get_today returns a snapshot with recovery, sleep, and strain", async () => {
      // Pinned to 16:00 local (-04:00) on the fixture day, with the fixture cycle still open.
      const { vi } = await import("vitest");
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-04-10T20:00:00Z"));
      const openCycleClient: WhoopClient = {
        get: async <T>(path: string, options?: Parameters<WhoopClient["get"]>[1]): Promise<T> =>
          path.startsWith("/v2/cycle?")
            ? ({ records: [{ ...CYCLE_FIXTURE.records[0]!, end: null }] } as T)
            : createMockClient().get<T>(path, options),
      };
      const { server: todayServer } = createWhoopServer(openCycleClient, {
        disableResources: true,
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const todayClient = new Client({ name: "get-today-test", version: "1.0.0" });
      await Promise.all([
        todayClient.connect(clientTransport),
        todayServer.connect(serverTransport),
      ]);
      try {
        const result = await todayClient.callTool({ name: "get_today", arguments: {} });

        expect(result.isError).toBeFalsy();
        expect(result.content).toHaveLength(1);
        const content = result.content as Array<{ type: string; text: string }>;
        const parsed = JSON.parse(content[0]!.text) as {
          timestamp: string;
          recovery: { score: number; zone: string; user_calibrating: boolean } | null;
          sleep: { asleep_hours: number; time_in_bed_hours: number } | null;
          strain: { day_strain: number; last_workout: { sport_name: string } | null } | null;
          summary: string;
          data_quality: { sources: Record<string, { status: string }> };
        };
        expect(result.structuredContent).toEqual(parsed);
        expect(parsed.timestamp).toBe("2026-04-10T20:00:00.000Z");
        expect(parsed.recovery).toMatchObject({
          score: 85,
          zone: "green",
          user_calibrating: false,
        });
        expect(parsed.sleep).toMatchObject({ asleep_hours: 6.5, time_in_bed_hours: 7 });
        expect(parsed.strain).toMatchObject({
          day_strain: 12.5,
          last_workout: { sport_name: "Running" },
        });
        expect(parsed.summary).toBe("Recovery 85% (green), 6.5h sleep, strain 12.5");
        expect(
          Object.fromEntries(
            Object.entries(parsed.data_quality.sources).map(([name, quality]) => [
              name,
              quality.status,
            ])
          )
        ).toEqual({
          recovery: "available",
          sleep: "available",
          cycle: "available",
          workout: "available",
        });
      } finally {
        await todayClient.close();
        await todayServer.close();
        vi.useRealTimers();
      }
    });

    it("get_calendar returns a grid with period, days, and averages", async () => {
      const result = await client.callTool({
        name: "get_calendar",
        arguments: { days: 7 },
      });

      expect(result.isError).toBeFalsy();
      expect(result.content).toHaveLength(1);

      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0]!.text) as Record<string, unknown>;
      expect(parsed).toHaveProperty("period");
      expect(parsed).toHaveProperty("days");
      expect(parsed).toHaveProperty("averages");
    });
  });

  // -------------------------------------------------------------------------
  // Input schemas — ID lookup tools
  // -------------------------------------------------------------------------

  describe("get_sleep_by_id schema", () => {
    it("has a required id property of type string", async () => {
      const result = await client.listTools();
      const tool = result.tools.find((t) => t.name === "get_sleep_by_id");

      expect(tool).toBeDefined();
      const props = tool!.inputSchema.properties as Record<string, { type: string }>;
      expect(props).toHaveProperty("id");
      expect(props.id!.type).toBe("string");
    });
  });

  describe("get_workout_by_id schema", () => {
    it("has a required id property of type string", async () => {
      const result = await client.listTools();
      const tool = result.tools.find((t) => t.name === "get_workout_by_id");

      expect(tool).toBeDefined();
      const props = tool!.inputSchema.properties as Record<string, { type: string }>;
      expect(props).toHaveProperty("id");
      expect(props.id!.type).toBe("string");
    });
  });

  describe("get_cycle_by_id schema", () => {
    it("has a required id property of type integer", async () => {
      const result = await client.listTools();
      const tool = result.tools.find((t) => t.name === "get_cycle_by_id");

      expect(tool).toBeDefined();
      const props = tool!.inputSchema.properties as Record<string, { type: string }>;
      expect(props).toHaveProperty("id");
      expect(props.id!.type).toBe("integer");
    });
  });
});

// ---------------------------------------------------------------------------
// Task 8d: Tool-level error handling
// ---------------------------------------------------------------------------

describe("createWhoopServer (error handling)", () => {
  /**
   * Helper to create a test setup where the mock client throws the given error.
   * Returns a connected MCP Client and a cleanup function.
   */
  async function createErrorServer(
    error: Error
  ): Promise<{ client: Client; cleanup: () => Promise<void> }> {
    const errorClient: WhoopClient = {
      get: async <T>(): Promise<T> => {
        throw error;
      },
    };
    const { server } = createWhoopServer(errorClient);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "error-test-client", version: "1.0.0" });
    await Promise.all([mcpClient.connect(clientTransport), server.connect(serverTransport)]);
    return {
      client: mcpClient,
      cleanup: async () => {
        await mcpClient.close();
        await server.close();
      },
    };
  }

  it("returns isError with message for WhoopApiError", async () => {
    const apiError = new WhoopApiError(403, "Forbidden", { message: "No access" });
    const { client: errClient, cleanup } = await createErrorServer(apiError);

    try {
      const result = await errClient.callTool({ name: "get_profile", arguments: {} });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]!.text).toContain("403");
      expect(content[0]!.text).not.toContain("No access");
      expect(content[0]!.text).toContain("denied access");
      expect(content[0]!.text).toContain("setup --verify");
    } finally {
      await cleanup();
    }
  });

  /** Call a tool against a client that always throws `error`; returns the error text. */
  async function errorText(
    error: unknown,
    name = "get_profile",
    args: Record<string, unknown> = {}
  ): Promise<string> {
    const throwingClient: WhoopClient = {
      get: async <T>(): Promise<T> => {
        throw error;
      },
    };
    const { server } = createWhoopServer(throwingClient);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "error-text-client", version: "1.0.0" });
    await Promise.all([mcpClient.connect(clientTransport), server.connect(serverTransport)]);
    try {
      const result = await mcpClient.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content).toHaveLength(1);
      return content[0]!.text;
    } finally {
      await mcpClient.close();
      await server.close();
    }
  }

  const SENSITIVE_BODY = {
    error_description: "refresh token rt-SECRET-123 rejected for jane@example.com",
    recovery_score: 42,
  };

  it.each([
    [400, "Bad Request", "get_cycle_collection", ["HTTP 400", "rejected the request parameters"]],
    [404, "Not Found", "get_cycle_by_id", ["HTTP 404", "no matching record"]],
    [401, "Unauthorized", "get_profile", ["HTTP 401", "setup --verify"]],
    [429, "Too Many Requests", "get_recovery_collection", ["HTTP 429", "rate limit"]],
    [500, "Internal Server Error", "get_sleep_collection", ["HTTP 500", "Retry later"]],
    [502, "Bad Gateway", "get_workout_collection", ["HTTP 502", "unavailable"]],
  ])("maps WhoopApiError %i to a specific message", async (status, statusText, tool, phrases) => {
    const args = tool === "get_cycle_by_id" ? { id: 1 } : {};
    const text = await errorText(new WhoopApiError(status, statusText, SENSITIVE_BODY), tool, args);

    for (const phrase of phrases) {
      expect(text).toContain(phrase);
    }
    expect(text).not.toContain("WHOOP API returned");
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("jane@example.com");
    expect(text).not.toContain(statusText);
  });

  it("does not suggest retrying a 400 or 404 rejection", async () => {
    expect(await errorText(new WhoopApiError(400, "Bad Request", null))).not.toMatch(/retry/i);
    expect(
      await errorText(new WhoopApiError(404, "Not Found", null), "get_cycle_by_id", { id: 1 })
    ).toContain("ids and dates");
  });

  it("passes an invalid date expression's own message through", async () => {
    const emptyClient: WhoopClient = {
      get: async <T>(): Promise<T> => ({ records: [], next_token: null }) as T,
    };
    const { server } = createWhoopServer(emptyClient);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "date-error-client", version: "1.0.0" });
    await Promise.all([mcpClient.connect(clientTransport), server.connect(serverTransport)]);

    try {
      const result = await mcpClient.callTool({
        name: "get_recovery_collection",
        arguments: { start: "next tuesday" },
      });

      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
      expect(text).toContain('Unrecognized date expression: "next tuesday"');
      expect(text).toContain("Supported:");
      expect(text).not.toContain("unexpected error");
    } finally {
      await mcpClient.close();
      await server.close();
    }
  });

  it("maps InvalidDateExpression thrown anywhere in a tool to its message", async () => {
    const { InvalidDateExpression } = await import("../src/tools/date-utils.js");
    const text = await errorText(
      new InvalidDateExpression("Periods overlap. Provide two non-overlapping time ranges.")
    );

    expect(text).toBe("Periods overlap. Provide two non-overlapping time ranges.");
  });

  it("bounds long or control-character date input echoed in the message", async () => {
    const { InvalidDateExpression } = await import("../src/tools/date-utils.js");
    const hugeInput = `x\n${"y".repeat(5000)}`;
    const text = await errorText(
      new InvalidDateExpression(
        `Unrecognized date expression: "${hugeInput}". Supported: "today", "yesterday".`
      )
    );

    expect(text.length).toBeLessThanOrEqual(600);
    expect(text).not.toMatch(/\p{Cc}/u);
    expect(text).toContain("…");
    expect(text).toContain('Supported: "today", "yesterday".');
  });

  // R22: the shortening must only cut long quoted values, never the message
  // text between two quoted values (which starts at a closing quote).
  it("keeps the text between two quoted values intact", async () => {
    const { InvalidDateExpression } = await import("../src/tools/date-utils.js");
    const message =
      'The end of period A must be after its start: period_a_end "2026-09-10" resolves to ' +
      '2026-09-10T23:59:59.999+02:00, which is not after period_a_start "2026-09-12" ' +
      "(2026-09-12T00:00:00.000+02:00).";

    expect(await errorText(new InvalidDateExpression(message))).toBe(message);
  });

  it("names the wrong parameter for a reversed compare_periods period", async () => {
    const cycle = {
      id: 1,
      user_id: 1,
      created_at: "2026-09-15T20:00:00.000Z",
      updated_at: "2026-09-15T20:00:00.000Z",
      start: "2026-09-15T20:00:00.000Z",
      end: null,
      timezone_offset: "+02:00",
      score_state: "PENDING_SCORE",
      score: null,
    };
    const fakeClient: WhoopClient = {
      get: async <T>(path: string): Promise<T> =>
        ({ records: path.startsWith("/v2/cycle") ? [cycle] : [], next_token: null }) as T,
    };
    const { server } = createWhoopServer(fakeClient);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "reversed-period-client", version: "1.0.0" });
    await Promise.all([mcpClient.connect(clientTransport), server.connect(serverTransport)]);

    try {
      const result = await mcpClient.callTool({
        name: "compare_periods",
        arguments: {
          period_a_start: "2026-09-12",
          period_a_end: "2026-09-10",
          period_b_start: "2026-09-13",
          period_b_end: "2026-09-15",
        },
      });

      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
      expect(text).toContain('period_a_end "2026-09-10"');
      expect(text).toContain('period_a_start "2026-09-12"');
      expect(text).not.toContain("…");
    } finally {
      await mcpClient.close();
      await server.close();
    }
  });

  it("still shortens a long quoted value that contains quotes or sits in parentheses", async () => {
    const { InvalidDateExpression } = await import("../src/tools/date-utils.js");
    const long = "z".repeat(200);
    const text = await errorText(
      new InvalidDateExpression(`Invalid date string: start="${long}", end=("${long}").`)
    );

    expect(text).toBe(
      `Invalid date string: start="${"z".repeat(60)}…", end=("${"z".repeat(60)}…").`
    );
  });

  it("names the failing fields for zod errors without echoing values", async () => {
    const { z } = await import("zod");
    const parsed = z.object({ days: z.number() }).safeParse({ days: "SECRET-VALUE" });
    const text = await errorText(parsed.error);

    expect(text).toContain("Invalid input or data");
    expect(text).toContain("days");
    expect(text).not.toContain("SECRET-VALUE");
  });

  it("reports a timeout as a network message", async () => {
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    const text = await errorText(new WhoopNetworkError(timeout));

    expect(text).toContain("Network error");
    expect(text).toContain("did not respond in time");
  });

  it("reports a token refresh that could not reach WHOOP as a network problem", async () => {
    const text = await errorText(
      new WhoopAuthError(new WhoopNetworkError(new TypeError("fetch failed")))
    );

    expect(text).toContain("Network error");
    expect(text).not.toContain("setup --verify");
  });

  it("reports an auth failure wrapped in a network error as an auth failure", async () => {
    const text = await errorText(new WhoopNetworkError(new WhoopAuthError(new Error("expired"))));

    expect(text).toContain("authentication failed");
    expect(text).not.toContain("internet connection");
  });

  it("keeps RangeError and unknown error details out of the message", async () => {
    // A RangeError comes from processing WHOOP data, not from the caller's input.
    expect(await errorText(new RangeError("Invalid time value SECRET"))).toBe(
      "The server could not process the WHOOP data for this request."
    );
    expect(await errorText(new Error("Insufficient data SECRET"))).toBe(
      "An unexpected error occurred. Check configuration and retry."
    );
  });

  it("returns isError with network message for WhoopNetworkError", async () => {
    const netError = new WhoopNetworkError(new TypeError("fetch failed"));
    const { client: errClient, cleanup } = await createErrorServer(netError);

    try {
      const result = await errClient.callTool({ name: "get_profile", arguments: {} });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]!.text).toContain("Network error");
    } finally {
      await cleanup();
    }
  });

  it("returns isError with auth message for WhoopAuthError", async () => {
    const authError = new WhoopAuthError(new Error("token expired"));
    const { client: errClient, cleanup } = await createErrorServer(authError);

    try {
      const result = await errClient.callTool({ name: "get_profile", arguments: {} });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]!.text).toContain("authentication failed");
    } finally {
      await cleanup();
    }
  });

  it("returns isError with generic message for unknown errors", async () => {
    const unknownError = new Error("Something went wrong");
    const { client: errClient, cleanup } = await createErrorServer(unknownError);

    try {
      const result = await errClient.callTool({ name: "get_profile", arguments: {} });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]!.text).toContain("unexpected error");
      expect(content[0]!.text).not.toContain("Something went wrong");
    } finally {
      await cleanup();
    }
  });

  it("error handling works for collection tools too", async () => {
    const apiError = new WhoopApiError(500, "Internal Server Error", null);
    const { client: errClient, cleanup } = await createErrorServer(apiError);

    try {
      const result = await errClient.callTool({
        name: "get_recovery_collection",
        arguments: {},
      });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]!.text).toContain("500");
    } finally {
      await cleanup();
    }
  });

  it("returns isError for WhoopApiError with string body", async () => {
    const apiError = new WhoopApiError(503, "Service Unavailable", "plain text error body");
    const { client: errClient, cleanup } = await createErrorServer(apiError);

    try {
      const result = await errClient.callTool({ name: "get_profile", arguments: {} });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]!.text).toContain("503");
      expect(content[0]!.text).toContain("Retry later");
      expect(content[0]!.text).not.toContain("plain text error body");
    } finally {
      await cleanup();
    }
  });

  it("returns isError with generic message for non-Error thrown values", async () => {
    // Simulate a tool handler that throws a non-Error value (e.g., a string)
    const nonErrorClient: WhoopClient = {
      get: async <T>(): Promise<T> => {
        throw "a string, not an Error";
      },
    };
    const { server } = createWhoopServer(nonErrorClient);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "non-error-test", version: "1.0.0" });
    await Promise.all([mcpClient.connect(clientTransport), server.connect(serverTransport)]);

    try {
      const result = await mcpClient.callTool({ name: "get_profile", arguments: {} });

      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]!.text).toBe("An unexpected error occurred. Check configuration and retry.");
    } finally {
      await mcpClient.close();
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// MCP Resources
// ---------------------------------------------------------------------------

describe("createWhoopServer (resources)", () => {
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const mockWhoopClient = createMockClient();
    const { server } = createWhoopServer(mockWhoopClient);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "resource-test-client", version: "1.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    cleanup = async () => {
      await client.close();
      await server.close();
    };
  });

  afterAll(async () => {
    await cleanup();
  });

  it("lists the 4 legacy resources with correct URIs", async () => {
    const result = await client.listResources();
    const uris = result.resources.map((r) => r.uri).sort();

    expect(uris).toEqual(
      expect.arrayContaining([
        "whoop://v2/user/cycle/latest",
        "whoop://v2/user/profile",
        "whoop://v2/user/recovery/latest",
        "whoop://v2/user/sleep/latest",
      ])
    );
  });

  it("all resources have descriptions and mimeType", async () => {
    const result = await client.listResources();
    for (const resource of result.resources) {
      expect(resource.description).toBeTruthy();
      expect(resource.mimeType).toBe(
        resource.uri === "whoop://server/guide" ? "text/markdown" : "application/json"
      );
    }
  });

  it("lists and reads workout/latest as a workout summary placed on its cycle's day", async () => {
    const result = await client.listResources();
    expect(result.resources.map((r) => r.uri)).toContain("whoop://v2/user/workout/latest");

    const read = await client.readResource({ uri: "whoop://v2/user/workout/latest" });
    const content = read.contents[0]!;
    expect(content.mimeType).toBe("application/json");
    const parsed = JSON.parse((content as { text: string }).text) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      id: "workout-1",
      sport_name: "Running",
      sport_id: null,
      day: "2026-04-10",
      start_local: "2026-04-10T13:00:00.000-04:00",
      duration_minutes: 60,
      strain: 14.2,
      recorded_fraction: 1,
      // The fixture's zone durations cover 50 of its 60 minutes.
      recorded_minutes: 50,
      flags: ["zone_sum_mismatch"],
    });
    expect(parsed).not.toHaveProperty("notes");
  });

  it("reads recovery/latest and returns JSON content", async () => {
    const result = await client.readResource({ uri: "whoop://v2/user/recovery/latest" });

    expect(result.contents).toHaveLength(1);
    const content = result.contents[0]!;
    expect(content.uri).toBe("whoop://v2/user/recovery/latest");
    expect(content.mimeType).toBe("application/json");
    expect("text" in content).toBe(true);

    const parsed = JSON.parse((content as { text: string }).text) as unknown;
    expect(parsed).toEqual(RECOVERY_FIXTURE.records[0]);
  });

  it("reads sleep/latest and returns JSON content", async () => {
    const result = await client.readResource({ uri: "whoop://v2/user/sleep/latest" });

    expect(result.contents).toHaveLength(1);
    const content = result.contents[0]!;
    const parsed = JSON.parse((content as { text: string }).text) as unknown;
    expect(parsed).toEqual(SLEEP_FIXTURE.records[0]);
  });

  it("reads cycle/latest and returns JSON content", async () => {
    const result = await client.readResource({ uri: "whoop://v2/user/cycle/latest" });

    expect(result.contents).toHaveLength(1);
    const content = result.contents[0]!;
    const parsed = JSON.parse((content as { text: string }).text) as unknown;
    expect(parsed).toEqual(CYCLE_FIXTURE.records[0]);
  });

  it("reads profile and returns JSON content", async () => {
    const result = await client.readResource({ uri: "whoop://v2/user/profile" });

    expect(result.contents).toHaveLength(1);
    const content = result.contents[0]!;
    const parsed = JSON.parse((content as { text: string }).text) as unknown;
    expect(parsed).toEqual(PROFILE_FIXTURE);
  });
});

// ---------------------------------------------------------------------------
// Resources disabled via option
// ---------------------------------------------------------------------------

describe("createWhoopServer (resources disabled)", () => {
  it("does not register resources when disableResources is true", async () => {
    const mockWhoopClient = createMockClient();
    const { server } = createWhoopServer(mockWhoopClient, {
      disableResources: true,
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "no-resources-test", version: "1.0.0" });
    await Promise.all([mcpClient.connect(clientTransport), server.connect(serverTransport)]);

    try {
      // When no resources are registered, the server doesn't advertise the
      // resources capability, so listResources throws "Method not found".
      await expect(mcpClient.listResources()).rejects.toThrow("Method not found");
    } finally {
      await mcpClient.close();
      await server.close();
    }
  });
});
