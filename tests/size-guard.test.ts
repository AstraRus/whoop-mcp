/**
 * Result size guard for every registry tool.
 *
 * - Inventory: every registry tool (and every aggregate variant) has a
 *   maximum-argument case here, so a new tool cannot skip this check.
 * - Each tool at its maximum arguments on stressUser (365 days, 2 workouts a
 *   day, naps) returns compact JSON text within MAX_TOOL_TEXT_CHARS. The call
 *   is repeated with a shared history cache until the history is complete,
 *   because a first call that stops at its request budget returns less.
 * - A synthetic tool one character above the limit gets the isError guidance,
 *   and one exactly at the limit does not.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryCache } from "../src/cache/memory-cache.js";
import type { PrivacyMode } from "../src/privacy.js";
import { ADDITIONAL_TOOLS } from "../src/tools/registry/index.js";
import { MAX_TOOL_TEXT_CHARS } from "../src/tools/tool-definition.js";
import { connectServer, type ToolCallOutcome } from "./helpers/contract.js";
import { createWhoopFixtureClient } from "./helpers/whoop-fixture-client.js";
import { stressUser, type WhoopUserFixture } from "./helpers/whoop-users.js";

/** Name of the synthetic tool appended to the registry for the guard itself. */
const PROBE_TOOL = "size_guard_probe";

vi.mock("../src/tools/registry/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/tools/registry/index.js")>();
  const { z } = await import("zod");
  const { defineTool } = await import("../src/tools/tool-definition.js");
  const variant = {
    title: "Size guard probe",
    description: "Returns a text field whose JSON serialization has exactly `chars` characters.",
    inputSchema: z.object({ chars: z.number().int().min(11) }),
    outputSchema: z.object({ text: z.string() }),
    run: async (args: { chars: number }): Promise<{ text: string }> => ({
      // JSON.stringify({ text: "" }) is 11 characters.
      text: "x".repeat(args.chars - 11),
    }),
  };
  const probe = defineTool({
    name: "size_guard_probe",
    annotations: { readOnlyHint: true },
    standard: variant,
    aggregate: variant,
  });
  return { ...actual, ADDITIONAL_TOOLS: [...actual.ADDITIONAL_TOOLS, probe] };
});

const TIMEOUT_MS = 600_000;

/** Most calls per case while the history cache fills. */
const MAX_REPEATS = 8;

let stress: WhoopUserFixture | undefined;
function user(): WhoopUserFixture {
  stress ??= stressUser();
  return stress;
}

/** The newest scored workout that ended at least a day before `now`. */
function settledWorkoutId(data: WhoopUserFixture): string {
  const cutoff = data.now.getTime() - 86_400_000;
  const workout = data.workouts.find(
    (candidate) => candidate.score_state === "SCORED" && Date.parse(candidate.end) <= cutoff
  );
  if (!workout) throw new Error("stressUser has no settled workout");
  return workout.id;
}

/** Three tags on every one of the last 180 local days (the input maximum). */
function maxTags(data: WhoopUserFixture): Array<{ name: string; dates: string[] }> {
  const today = new Date(data.now.getTime() + 2 * 3_600_000).toISOString().slice(0, 10);
  const dates = Array.from({ length: 180 }, (_, index) =>
    new Date(Date.parse(`${today}T00:00:00Z`) - index * 86_400_000).toISOString().slice(0, 10)
  );
  return ["alcohol", "late meal", "travel-day"].map((name, index) => ({
    name,
    dates: dates.filter((_, day) => day % (index + 1) === 0),
  }));
}

type ArgsFor = (data: WhoopUserFixture) => Record<string, unknown>;

/** Maximum-argument cases per registry tool in standard mode. */
const STANDARD_CASES: Record<string, Array<[string, ArgsFor]>> = {
  get_sync_status: [["no arguments", () => ({})]],
  get_day: [
    ["yesterday with timeline", () => ({ date: "yesterday", include_timeline: true })],
    ["today with timeline", () => ({ date: "today", include_timeline: true })],
  ],
  export_health_data: [
    [
      "180 days, every dataset, naps, json",
      () => ({
        start: "last 179 days",
        datasets: ["daily", "workouts", "sleeps"],
        format: "json",
        include_naps: true,
      }),
    ],
    [
      "180 days, every dataset, naps, csv",
      () => ({
        start: "last 179 days",
        datasets: ["daily", "workouts", "sleeps"],
        format: "csv",
        include_naps: true,
      }),
    ],
  ],
  get_workout_log: [
    ["365 days, limit 50, unscored", () => ({ days: 365, limit: 50, include_unscored: true })],
    ["365 days, limit 50, pace sort", () => ({ days: 365, limit: 50, sort: "pace" })],
  ],
  get_workout_context: [
    ["compare 365 days", (data) => ({ id: settledWorkoutId(data), compare_days: 365 })],
  ],
  get_personal_records: [["1095 days", () => ({ days: 1095, recent_days: 60 })]],
  get_training_load: [
    ["180 days trimp", () => ({ days: 180, load_metric: "trimp" })],
    ["180 days day_strain", () => ({ days: 180, load_metric: "day_strain" })],
  ],
  get_sport_breakdown: [["365 days", () => ({ days: 365, min_recorded_fraction: 0 })]],
  get_sleep_analysis: [["90 days", () => ({ days: 90, include_nights: true, include_naps: true })]],
  get_recovery_analysis: [
    ["90 days, baseline 60", () => ({ days: 90, baseline_days: 60, include_days: true })],
  ],
  get_sleep_need: [
    ["history 120 with wake time", () => ({ history_days: 120, wake_time: "06:30" })],
  ],
  get_recovery_drivers: [
    [
      "180 days, every outcome, focus and 3 tags",
      (data) => ({
        days: 180,
        outcomes: ["recovery", "hrv", "rhr", "sleep_performance", "asleep_hours"],
        include_calibrating: true,
        focus: "prior_day_strain",
        custom_tags: maxTags(data),
      }),
    ],
  ],
};

/** Maximum-argument cases per registry tool with an aggregate variant. */
const AGGREGATE_CASES: Record<string, Array<[string, ArgsFor]>> = {
  get_sync_status: [["no arguments", () => ({})]],
  get_training_load: [
    ["26 weeks trimp", () => ({ weeks: 26, load_metric: "trimp" })],
    ["26 weeks day_strain", () => ({ weeks: 26, load_metric: "day_strain" })],
  ],
  get_sport_breakdown: [
    ["latest block", () => ({ block_offset: 1 })],
    ["oldest block", () => ({ block_offset: 26 })],
  ],
};

afterEach(() => {
  vi.useRealTimers();
});

describe("size guard inventory", () => {
  const registry = ADDITIONAL_TOOLS.filter((definition) => definition.name !== PROBE_TOOL);

  it("has a maximum-argument case for every registry tool", () => {
    expect(Object.keys(STANDARD_CASES).sort()).toEqual(
      registry.map((definition) => definition.name).sort()
    );
  });

  it("has a maximum-argument case for every aggregate variant", () => {
    expect(Object.keys(AGGREGATE_CASES).sort()).toEqual(
      registry
        .filter((definition) => definition.aggregate !== undefined)
        .map((definition) => definition.name)
        .sort()
    );
  });
});

async function callUntilComplete(
  mode: PrivacyMode,
  tool: string,
  args: Record<string, unknown>
): Promise<{ outcome: ToolCallOutcome; calls: number }> {
  const data = user();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(data.now);
  const cache = new MemoryCache({ maxEntries: 500 });
  const connection = await connectServer(createWhoopFixtureClient(data), {
    privacyMode: mode,
    historyCache: cache,
    now: () => new Date(),
  });
  try {
    let outcome = await connection.callTool(tool, args);
    let calls = 1;
    while (
      calls < MAX_REPEATS &&
      !outcome.isError &&
      outcome.structured !== null &&
      outcome.structured.truncated === true
    ) {
      outcome = await connection.callTool(tool, args);
      calls += 1;
    }
    return { outcome, calls };
  } finally {
    await connection.close();
  }
}

describe.each(["standard", "aggregate"] as const)(
  "%s mode at maximum arguments on stressUser",
  (mode) => {
    const cases = Object.entries(mode === "standard" ? STANDARD_CASES : AGGREGATE_CASES).flatMap(
      ([tool, list]) => list.map(([label, args]) => [tool, label, args] as const)
    );

    it.each(cases)(
      "%s (%s) stays within MAX_TOOL_TEXT_CHARS",
      async (tool, _label, argsFor) => {
        const { outcome } = await callUntilComplete(mode, tool, argsFor(user()));
        expect(outcome.isError, outcome.isError ? outcome.text : "").toBe(false);
        expect(outcome.structured).not.toBeNull();
        expect(outcome.text).toBe(JSON.stringify(outcome.structured));
        expect(outcome.text.length).toBeLessThanOrEqual(MAX_TOOL_TEXT_CHARS);
        if ("truncated" in outcome.structured!) {
          expect(outcome.structured!.truncated, `${tool} history still truncated`).toBe(false);
        }
      },
      TIMEOUT_MS
    );
  }
);

describe("oversized results", () => {
  it.each(["standard", "aggregate"] as const)(
    "%s mode returns the isError guidance one character above the limit",
    async (mode) => {
      const connection = await connectServer(createWhoopFixtureClient(), { privacyMode: mode });
      try {
        const atLimit = await connection.callTool(PROBE_TOOL, { chars: MAX_TOOL_TEXT_CHARS });
        expect(atLimit.isError).toBe(false);
        expect(atLimit.text.length).toBe(MAX_TOOL_TEXT_CHARS);

        const above = await connection.callTool(PROBE_TOOL, { chars: MAX_TOOL_TEXT_CHARS + 1 });
        expect(above.isError).toBe(true);
        expect(above.structured).toBeNull();
        expect(above.text).toBe(
          `The result is too large for the MCP client (${MAX_TOOL_TEXT_CHARS + 1} characters); request fewer days, a lower limit or fewer datasets.`
        );
      } finally {
        await connection.close();
      }
    }
  );
});
