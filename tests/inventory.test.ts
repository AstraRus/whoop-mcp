/**
 * The final client-visible inventory of the 0.8.0 server: exact tools,
 * resources and prompts per privacy mode, and the listing rules every tool
 * follows. Adding, removing or renaming anything a client can see must update
 * this file together with the README tool reference (tests/docs.test.ts).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrivacyMode } from "../src/privacy.js";
import { ADDITIONAL_TOOLS, LEGACY_TOOL_NAMES } from "../src/tools/registry/index.js";
import { MAX_TOOL_DESCRIPTION_CHARS } from "../src/tools/tool-definition.js";
import { connectServer, type ContractConnection } from "./helpers/contract.js";
import { createWhoopFixtureClient } from "./helpers/whoop-fixture-client.js";

const MODES = ["standard", "aggregate"] as const;

/** The 16 tools that existed before 0.8.0. */
const LEGACY_TOOLS = [
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
];

/** Tools added in 0.8.0. */
const NEW_TOOLS = [
  "export_health_data",
  "get_day",
  "get_personal_records",
  "get_recovery_analysis",
  "get_recovery_drivers",
  "get_sleep_analysis",
  "get_sleep_need",
  "get_sport_breakdown",
  "get_sync_status",
  "get_training_load",
  "get_workout_context",
  "get_workout_log",
];

const EXPECTED_TOOLS: Record<PrivacyMode, string[]> = {
  standard: [...LEGACY_TOOLS, ...NEW_TOOLS].sort(),
  aggregate: [
    "compare_periods",
    "get_baselines",
    "get_sleep_debt",
    "get_sport_breakdown",
    "get_sync_status",
    "get_training_load",
    "get_trend",
    "get_weekly_summary",
  ],
};

const EXPECTED_RESOURCES: Record<PrivacyMode, string[]> = {
  standard: [
    "whoop://server/guide",
    "whoop://v2/user/cycle/latest",
    "whoop://v2/user/profile",
    "whoop://v2/user/recovery/latest",
    "whoop://v2/user/sleep/latest",
    "whoop://v2/user/workout/latest",
  ],
  aggregate: ["whoop://server/guide"],
};

const EXPECTED_PROMPTS: Record<PrivacyMode, string[]> = {
  standard: [
    "data_status_check",
    "day_review",
    "evening_briefing",
    "export_my_data",
    "health_check",
    "morning_briefing",
    "recovery_drivers",
    "recovery_trend",
    "session_debrief",
    "sleep_analysis",
    "training_load_check",
    "weekly_health_review",
    "workout_recap",
  ],
  aggregate: ["aggregate_overview"],
};

const connections = new Map<PrivacyMode, ContractConnection>();

function connection(mode: PrivacyMode): ContractConnection {
  const value = connections.get(mode);
  if (!value) throw new Error(`no ${mode} connection`);
  return value;
}

beforeAll(async () => {
  for (const mode of MODES) {
    connections.set(mode, await connectServer(createWhoopFixtureClient(), { privacyMode: mode }));
  }
});

afterAll(async () => {
  for (const value of connections.values()) await value.close();
});

describe("tools/list", () => {
  it("has 28 standard and 8 aggregate tools", () => {
    expect(EXPECTED_TOOLS.standard).toHaveLength(28);
    expect(EXPECTED_TOOLS.aggregate).toHaveLength(8);
    expect(new Set(EXPECTED_TOOLS.standard).size).toBe(28);
  });

  it.each(MODES)("%s mode lists exactly the expected tools", async (mode) => {
    const names = (await connection(mode).listTools()).map((tool) => tool.name).sort();
    expect(names).toEqual(EXPECTED_TOOLS[mode]);
  });

  it("matches the registry: legacy tools plus every registry tool", () => {
    expect([...LEGACY_TOOL_NAMES].sort()).toEqual(LEGACY_TOOLS);
    expect(ADDITIONAL_TOOLS.map((definition) => definition.name).sort()).toEqual(NEW_TOOLS);
    const aggregateRegistry = ADDITIONAL_TOOLS.filter(
      (definition) => definition.aggregate !== undefined
    ).map((definition) => definition.name);
    expect(aggregateRegistry.sort()).toEqual([
      "get_sport_breakdown",
      "get_sync_status",
      "get_training_load",
    ]);
  });

  it.each(MODES)(
    "%s mode: every tool advertises an object output schema and is read-only",
    async (mode) => {
      for (const tool of await connection(mode).listTools()) {
        expect(tool.outputSchema?.type, tool.name).toBe("object");
        expect(Object.keys(tool.outputSchema?.properties ?? {}).length, tool.name).toBeGreaterThan(
          0
        );
        expect(tool.inputSchema.type, tool.name).toBe("object");
        expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
        expect(tool.description?.trim().length ?? 0, tool.name).toBeGreaterThan(0);
      }
    }
  );

  it.each(MODES)(
    "%s mode: every new tool has a short title and a description of at most 1000 characters",
    async (mode) => {
      const tools = await connection(mode).listTools();
      for (const tool of tools.filter((candidate) => NEW_TOOLS.includes(candidate.name))) {
        expect(tool.title, tool.name).toBeTruthy();
        expect(tool.title!.length, tool.name).toBeLessThanOrEqual(40);
        expect(tool.description!.length, tool.name).toBeLessThanOrEqual(MAX_TOOL_DESCRIPTION_CHARS);
      }
    }
  );

  it("never lists a tool that revokes WHOOP access or writes data", async () => {
    for (const mode of MODES) {
      for (const tool of await connection(mode).listTools()) {
        expect(tool.name).not.toMatch(/revoke|delete|write|update|set_/);
      }
    }
  });
});

describe("resources/list", () => {
  it.each(MODES)("%s mode lists exactly the expected resources", async (mode) => {
    const uris = (await connection(mode).listResources()).map((resource) => resource.uri).sort();
    expect(uris).toEqual(EXPECTED_RESOURCES[mode]);
  });

  it.each(MODES)("%s mode lists no resources with WHOOP_MCP_DISABLE_RESOURCES", async (mode) => {
    const disabled = await connectServer(createWhoopFixtureClient(), {
      privacyMode: mode,
      disableResources: true,
    });
    try {
      await expect(disabled.listResources()).rejects.toThrow("Method not found");
    } finally {
      await disabled.close();
    }
  });
});

describe("prompts/list", () => {
  it("has 13 standard prompts and 1 aggregate prompt", () => {
    expect(EXPECTED_PROMPTS.standard).toHaveLength(13);
    expect(EXPECTED_PROMPTS.aggregate).toHaveLength(1);
  });

  it.each(MODES)("%s mode lists exactly the expected prompts", async (mode) => {
    const names = (await connection(mode).listPrompts()).map((prompt) => prompt.name).sort();
    expect(names).toEqual(EXPECTED_PROMPTS[mode]);
  });

  it.each(MODES)("%s mode keeps prompts when resources are disabled", async (mode) => {
    const disabled = await connectServer(createWhoopFixtureClient(), {
      privacyMode: mode,
      disableResources: true,
    });
    try {
      const names = (await disabled.listPrompts()).map((prompt) => prompt.name).sort();
      expect(names).toEqual(EXPECTED_PROMPTS[mode]);
    } finally {
      await disabled.close();
    }
  });
});
