/**
 * The server guide: initialize instructions and the whoop://server/guide
 * resource in both privacy modes, checked against a real server so every tool
 * name the text mentions is registered in that mode.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GUIDE_MIME_TYPE,
  GUIDE_RESOURCE_URI,
  MAX_INSTRUCTIONS_CHARS,
  buildGuideMarkdown,
  buildServerInstructions,
} from "../src/guide.js";
import type { PrivacyMode } from "../src/privacy.js";
import { ADDITIONAL_TOOLS, LEGACY_TOOL_NAMES } from "../src/tools/registry/index.js";
import { connectServer, type ContractConnection } from "./helpers/contract.js";
import { createWhoopFixtureClient } from "./helpers/whoop-fixture-client.js";

const MODES = ["standard", "aggregate"] as const;

/** Every tool name either privacy mode can register. */
const ALL_TOOL_NAMES: readonly string[] = [
  ...LEGACY_TOOL_NAMES,
  ...ADDITIONAL_TOOLS.map((definition) => definition.name),
];

/** Known tool names that appear as words in `text`. */
function mentionedToolNames(text: string): string[] {
  return ALL_TOOL_NAMES.filter((name) => new RegExp(`\\b${name}\\b`).test(text));
}

/** Tool-like identifiers in `text` (get_* words), which catch misspelt tool names. */
function toolLikeNames(text: string): string[] {
  const words = [...text.matchAll(/\b(get_[a-z0-9_]+|compare_periods)\b/g)].map(
    (match) => match[1]!
  );
  return [...new Set(words)];
}

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

describe("initialize instructions", () => {
  it.each(MODES)("%s mode sends instructions within the character limit", (mode) => {
    const instructions = connection(mode).client.getInstructions();
    expect(instructions).toBe(buildServerInstructions(mode));
    expect(instructions!.length).toBeGreaterThan(200);
    expect(instructions!.length).toBeLessThanOrEqual(MAX_INSTRUCTIONS_CHARS);
  });

  it.each(MODES)("%s mode instructions name only registered tools", async (mode) => {
    const registered = new Set((await connection(mode).listTools()).map((tool) => tool.name));
    const instructions = buildServerInstructions(mode)!;
    for (const name of [...mentionedToolNames(instructions), ...toolLikeNames(instructions)]) {
      expect(registered.has(name), `${name} in ${mode} instructions`).toBe(true);
    }
  });

  it("standard instructions route each kind of question to its tool", () => {
    const text = buildServerInstructions("standard")!;
    expect(text).toContain(
      "today: get_today; one local day: get_day; a range of days: get_calendar"
    );
    expect(text).toContain(
      "training: get_training_load, get_sport_breakdown, get_workout_log, get_workout_context, get_personal_records"
    );
    expect(text).toContain("sleep: get_sleep_analysis, get_sleep_debt, get_sleep_need");
    expect(text).toContain("recovery: get_recovery_analysis, get_baselines, get_trend");
    expect(text).toContain("get_recovery_drivers");
    expect(text).toContain("missing or old data: get_sync_status; export: export_health_data");
    expect(text).toContain("A WHOOP cycle starts at sleep onset");
    expect(text).toContain("strain and workouts still count toward the previous day");
    expect(text).toContain("Sleep hours are time asleep");
    expect(text).toContain("null, never 0");
    expect(text).toContain("calibrating");
    expect(text).toContain("WHOOP's rate limit");
    expect(text).toContain("not medical advice");
  });

  it("aggregate instructions list the aggregate tools and released-week windows", () => {
    const text = buildServerInstructions("aggregate")!;
    for (const name of [
      "get_weekly_summary",
      "get_trend",
      "compare_periods",
      "get_baselines",
      "get_sleep_debt",
      "get_training_load",
      "get_sport_breakdown",
      "get_sync_status",
    ]) {
      expect(text).toContain(name);
    }
    expect(text).toContain("released two days after they end (from Wednesday, local time)");
    expect(text).toContain("at least 3 samples");
    expect(text).toContain("not medical advice");
  });
});

describe("guide resource", () => {
  it.each(MODES)("%s mode lists the guide as markdown", async (mode) => {
    const listed = (await connection(mode).listResources()).find(
      (resource) => resource.uri === GUIDE_RESOURCE_URI
    );
    expect(listed).toMatchObject({ name: "Server Guide", mimeType: GUIDE_MIME_TYPE });
    expect(listed?.description).toBeTruthy();
  });

  it.each(MODES)("%s mode reads the markdown guide for that mode", async (mode) => {
    const result = await connection(mode).readResource(GUIDE_RESOURCE_URI);
    expect(result.contents).toHaveLength(1);
    const content = result.contents[0] as { uri: string; mimeType: string; text: string };
    expect(content.uri).toBe(GUIDE_RESOURCE_URI);
    expect(content.mimeType).toBe("text/markdown");
    expect(content.text).toBe(buildGuideMarkdown(mode));
    expect(content.text.startsWith("# WHOOP MCP server guide\n")).toBe(true);
  });

  it.each(MODES)("%s mode guide has every section", (mode) => {
    const guide = buildGuideMarkdown(mode)!;
    for (const heading of [
      "## Which tool for which question",
      "## How days and cycles work",
      "## Data quality, calibrating and nulls",
      "## Privacy modes",
      "## Rate limits and history loading",
      "## What the WHOOP API does not provide",
    ]) {
      expect(guide).toContain(`\n${heading}\n`);
    }
    for (const missing of [
      "Strength Trainer",
      "journal",
      "stress",
      "steps",
      "VO2 max",
      "continuous heart rate or HRV",
      "body measurement history",
    ]) {
      expect(guide).toContain(missing);
    }
  });

  it.each(MODES)("%s mode guide names every registered tool and no other tool", async (mode) => {
    const registered = (await connection(mode).listTools()).map((tool) => tool.name);
    const guide = buildGuideMarkdown(mode)!;
    const mentioned = new Set([...mentionedToolNames(guide), ...toolLikeNames(guide)]);
    expect([...mentioned].sort()).toEqual([...registered].sort());
  });

  it("aggregate guide names no standard-only resource or prompt", () => {
    const guide = buildGuideMarkdown("aggregate")!;
    expect(guide).not.toContain("whoop://v2/");
    expect(guide).not.toContain("health_check");
    expect(guide).toContain("aggregate_overview");
    expect(guide).toContain("released two days after it ends");
  });

  it("standard guide names every standard resource and prompt", async () => {
    const guide = buildGuideMarkdown("standard")!;
    for (const resource of await connection("standard").listResources()) {
      expect(guide).toContain(resource.uri);
    }
    for (const prompt of await connection("standard").listPrompts()) {
      expect(guide).toContain(`\`${prompt.name}\``);
    }
  });

  it.each(MODES)("%s mode omits the guide when resources are disabled", async (mode) => {
    const disabled = await connectServer(createWhoopFixtureClient(), {
      privacyMode: mode,
      disableResources: true,
    });
    try {
      await expect(disabled.listResources()).rejects.toThrow("Method not found");
      await expect(disabled.readResource(GUIDE_RESOURCE_URI)).rejects.toThrow();
      // The instructions do not depend on resources.
      expect(disabled.client.getInstructions()).toBe(buildServerInstructions(mode));
    } finally {
      await disabled.close();
    }
  });
});
