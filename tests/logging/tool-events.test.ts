/**
 * Structured tool-call logging: classification, privacy of every log line,
 * and the registerContracted integration across every registered tool.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  WhoopApiError,
  WhoopAuthError,
  WhoopNetworkError,
  createWhoopClient,
} from "../../src/api/client.js";
import { cycleRecordSchema } from "../../src/api/record-schemas.js";
import { WhoopRateBudgetError } from "../../src/api/rate-limiter.js";
import { TokenRefreshError } from "../../src/auth/token-refresh-error.js";
import type { Logger } from "../../src/logging/logger.js";
import {
  MAX_CAUSE_DEPTH,
  MAX_CONTRACT_ISSUES,
  UNCAPTURED_ERROR_CLASS,
  argKeysOf,
  classifyToolError,
  contractIssuesOf,
  logToolOutcome,
  rememberToolError,
  stackFramesOf,
  toolErrorOf,
  type ToolOutcomeEvent,
} from "../../src/logging/tool-events.js";
import type { PrivacyMode } from "../../src/privacy.js";
import { InvalidDateExpression } from "../../src/tools/date-utils.js";
import { defineTool, type AnyToolDefinition } from "../../src/tools/tool-definition.js";
import { connectServer } from "../helpers/contract.js";
import { createWhoopFixtureClient } from "../helpers/whoop-fixture-client.js";
import { LIVE_SHAPED_IDS, liveShapedUser } from "../helpers/whoop-users.js";

// Registry tools as registered, plus tools a test appends.
const registry = vi.hoisted(() => ({ tools: [] as unknown[], actual: [] as unknown[] }));

vi.mock("../../src/tools/registry/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/registry/index.js")>();
  registry.actual = [...actual.ADDITIONAL_TOOLS];
  registry.tools.push(...actual.ADDITIONAL_TOOLS);
  return { ...actual, ADDITIONAL_TOOLS: registry.tools };
});

type Level = "debug" | "info" | "warn" | "error";

interface CapturedLogger extends Logger {
  lines: Array<{ level: Level; msg: string; fields: Record<string, unknown> }>;
}

function captureLogger(): CapturedLogger {
  const lines: CapturedLogger["lines"] = [];
  const at =
    (level: Level) =>
    (msg: string, fields: Record<string, unknown> = {}): void => {
      lines.push({ level, msg, fields });
    };
  return { lines, debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}

function event(overrides: Partial<ToolOutcomeEvent> = {}): ToolOutcomeEvent {
  return {
    tool: "get_trend",
    durationMs: 12.6,
    requestId: "0b8f5a8e-6f1f-4d0e-9d7c-3c2b1a0f9e8d",
    argKeys: ["metric", "days"],
    privacyMode: "standard" as PrivacyMode,
    ...overrides,
  };
}

const ERROR_RESULT = { isError: true, content: [{ type: "text" as const, text: "failed" }] };

// ---------------------------------------------------------------------------
// classifyToolError
// ---------------------------------------------------------------------------

describe("classifyToolError", () => {
  it.each([
    [400, "info"],
    [404, "info"],
    [401, "warn"],
    [403, "warn"],
    [409, "warn"],
    [429, "warn"],
    [500, "warn"],
    [503, "warn"],
  ])("WhoopApiError %i is an upstream error at %s", (status, level) => {
    const classified = classifyToolError(new WhoopApiError(status, "status text", { detail: 1 }));
    expect(classified).toEqual({
      outcome: "upstream_error",
      level,
      errorClass: "WhoopApiError",
      httpStatus: status,
      causeChain: ["WhoopApiError"],
    });
  });

  it("InvalidDateExpression is invalid input at info", () => {
    expect(
      classifyToolError(new InvalidDateExpression('Unrecognized date "tomorrow-ish"'))
    ).toMatchObject({
      outcome: "invalid_input",
      level: "info",
      errorClass: "InvalidDateExpression",
    });
  });

  it("a RangeError (e.g. an invalid Date) is an internal error at error with file:line frames", () => {
    let error: unknown;
    try {
      new Date(Number.NaN).toISOString();
    } catch (caught: unknown) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RangeError);
    const classified = classifyToolError(error);
    expect(classified).toMatchObject({
      outcome: "internal_error",
      level: "error",
      errorClass: "RangeError",
    });
    expect(classified.stackFrames?.length).toBeGreaterThan(0);
    for (const frame of classified.stackFrames ?? []) {
      expect(frame).toMatch(/^[A-Za-z0-9_.-]+:\d+$/);
    }
    expect(classified.contractIssues).toBeUndefined();
  });

  it("a WHOOP record that fails to parse is an internal error with frames and path:code issues only", () => {
    const record = {
      id: "0f0f0f0f-aaaa-4bbb-8ccc-123456789abc",
      start: "canary-invalid-Qzx-date",
      score: { strain: "123.456789" },
    };
    const parsed = cycleRecordSchema.safeParse(record);
    expect(parsed.success).toBe(false);
    const error = parsed.error!;
    const classified = classifyToolError(error);
    expect(classified).toMatchObject({
      outcome: "internal_error",
      level: "error",
      errorClass: "ZodError",
    });
    expect(classified.stackFrames?.length).toBeGreaterThan(0);
    for (const frame of classified.stackFrames ?? []) {
      expect(frame).toMatch(/^[A-Za-z0-9_.-]+:\d+$/);
    }
    expect(classified.contractIssues?.length).toBeGreaterThan(0);
    for (const issue of classified.contractIssues ?? []) {
      expect(issue).toMatch(/^[A-Za-z0-9_.*]*:[a-z_]+$/);
    }
    const serialized = JSON.stringify(classified);
    for (const value of [record.id, record.start, record.score.strain]) {
      expect(serialized).not.toContain(value);
    }
  });

  it("an empty ZodError is still an internal error", () => {
    expect(classifyToolError(new z.ZodError([]))).toMatchObject({
      outcome: "internal_error",
      level: "error",
      contractIssues: [],
    });
  });

  it.each([
    [new WhoopNetworkError(new TypeError("fetch failed")), ["WhoopNetworkError", "TypeError"]],
    [new WhoopRateBudgetError(), ["WhoopRateBudgetError"]],
    [new TokenRefreshError(500, "server error"), ["TokenRefreshError"]],
  ])("%s is an upstream error at warn", (error, chain) => {
    expect(classifyToolError(error)).toMatchObject({
      outcome: "upstream_error",
      level: "warn",
      causeChain: chain,
    });
  });

  it("reports the token endpoint status of a failed refresh", () => {
    const error = new WhoopAuthError(new TokenRefreshError(503, "unavailable"));
    expect(classifyToolError(error)).toEqual({
      outcome: "upstream_error",
      level: "warn",
      errorClass: "WhoopAuthError",
      refreshStatus: 503,
      causeChain: ["WhoopAuthError", "TokenRefreshError"],
    });
  });

  it("classifies by the first recognized error in the cause chain", () => {
    const wrapped = new Error("wrapper", { cause: new WhoopApiError(404, "Not Found", null) });
    expect(classifyToolError(wrapped)).toMatchObject({
      outcome: "upstream_error",
      level: "info",
      errorClass: "Error",
      httpStatus: 404,
      causeChain: ["Error", "WhoopApiError"],
    });
  });

  it("reports unknown errors at error level with file:line frames only", () => {
    const classified = classifyToolError(new TypeError("Cannot read properties of undefined"));
    expect(classified.outcome).toBe("internal_error");
    expect(classified.level).toBe("error");
    expect(classified.errorClass).toBe("TypeError");
    expect(classified.stackFrames?.length).toBeGreaterThan(0);
    for (const frame of classified.stackFrames ?? []) {
      expect(frame).toMatch(/^[A-Za-z0-9_.-]+:\d+$/);
    }
  });

  it("names non-Error values by type and caps the cause chain", () => {
    expect(classifyToolError("a string with 123.456789")).toMatchObject({
      outcome: "internal_error",
      errorClass: "string",
      causeChain: ["string"],
    });
    let deep: Error = new Error("root");
    for (let i = 0; i < 10; i++) deep = new Error(`level ${i}`, { cause: deep });
    expect(classifyToolError(deep).causeChain).toHaveLength(MAX_CAUSE_DEPTH + 1);
  });

  it("never uses an error name that is not an identifier", () => {
    const error = new Error("boom");
    error.name = "user@example.com 123.456789";
    expect(classifyToolError(error).errorClass).toBe("Error");
  });
});

describe("sanitizing helpers", () => {
  it("stackFramesOf never reads frames out of a multi-line message", () => {
    const error = new Error("first line\n    at leaked-123.456789:1:2\n    at secret.ts:9:9");
    const frames = stackFramesOf(error);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.join(" ")).not.toContain("123.456789");
    expect(frames.join(" ")).not.toContain("secret.ts");
  });

  it("argKeysOf keeps identifier-like names only, sorted", () => {
    expect(argKeysOf({ start: "2026-09-14", days: 7, "not a key": 1 })).toEqual(["days", "start"]);
    expect(argKeysOf(undefined)).toEqual([]);
    expect(argKeysOf(["x"])).toEqual([]);
  });

  it("contractIssuesOf writes path:code, masking value-like keys and capping the list", () => {
    const schema = z.object({
      days: z.record(z.string(), z.object({ hours: z.number() })),
      rows: z.array(z.object({ value: z.string() })),
    });
    const parsed = schema.safeParse({
      days: { "2026-09-14": { hours: "x" } },
      rows: Array.from({ length: 8 }, () => ({ value: 123.456789 })),
    });
    expect(parsed.success).toBe(false);
    const issues = contractIssuesOf(parsed.error!);
    expect(issues).toHaveLength(MAX_CONTRACT_ISSUES);
    expect(issues[0]).toBe("days.*.hours:invalid_type");
    expect(issues[1]).toBe("rows.0.value:invalid_type");
  });

  it("rememberToolError associates an error with a result object", () => {
    const error = new WhoopApiError(429, "Too Many Requests", null);
    const result = rememberToolError({ ...ERROR_RESULT }, error);
    expect(toolErrorOf(result)).toBe(error);
    expect(toolErrorOf({ ...ERROR_RESULT })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// logToolOutcome
// ---------------------------------------------------------------------------

describe("logToolOutcome", () => {
  it("logs exactly one warn for a WHOOP 429", () => {
    const logger = captureLogger();
    logToolOutcome(logger, {
      ...event(),
      result: ERROR_RESULT,
      error: new WhoopApiError(429, "Too Many Requests", { body: "123.456789" }),
    });
    expect(logger.lines).toEqual([
      {
        level: "warn",
        msg: "tool call failed",
        fields: {
          tool: "get_trend",
          durationMs: 13,
          requestId: "0b8f5a8e-6f1f-4d0e-9d7c-3c2b1a0f9e8d",
          outcome: "upstream_error",
          errorClass: "WhoopApiError",
          httpStatus: 429,
          causeChain: ["WhoopApiError"],
          argKeys: ["days", "metric"],
          privacyMode: "standard",
        },
      },
    ]);
  });

  it("logs invalid dates at info", () => {
    const logger = captureLogger();
    logToolOutcome(logger, {
      ...event(),
      error: new InvalidDateExpression('Unrecognized date expression "2026-99-99"'),
    });
    expect(logger.lines).toHaveLength(1);
    expect(logger.lines[0]).toMatchObject({
      level: "info",
      fields: { outcome: "invalid_input", errorClass: "InvalidDateExpression" },
    });
    expect(JSON.stringify(logger.lines)).not.toContain("2026-99-99");
  });

  it("logs a success at debug only", () => {
    const logger = captureLogger();
    logToolOutcome(logger, {
      ...event(),
      result: { content: [{ type: "text", text: '{"hrv":123.456789}' }] },
    });
    expect(logger.lines).toEqual([
      {
        level: "debug",
        msg: "tool call ok",
        fields: {
          tool: "get_trend",
          durationMs: 13,
          requestId: "0b8f5a8e-6f1f-4d0e-9d7c-3c2b1a0f9e8d",
          argKeys: ["days", "metric"],
          privacyMode: "standard",
        },
      },
    ]);
  });

  it("reports the token endpoint status behind a WhoopAuthError", () => {
    const logger = captureLogger();
    logToolOutcome(logger, {
      ...event(),
      error: new WhoopAuthError(new TokenRefreshError(503, "Service Unavailable")),
    });
    expect(logger.lines[0]).toMatchObject({
      level: "warn",
      fields: { refreshStatus: 503, outcome: "upstream_error" },
    });
  });

  it("logs an oversized result at warn with its size", () => {
    const logger = captureLogger();
    logToolOutcome(logger, { ...event(), result: ERROR_RESULT, outputChars: 100_001 });
    expect(logger.lines).toEqual([
      {
        level: "warn",
        msg: "tool call failed",
        fields: expect.objectContaining({
          outcome: "output_too_large",
          errorClass: "OutputTooLarge",
          chars: 100_001,
        }),
      },
    ]);
  });

  it("logs an isError result without a captured error at warn as uncaptured", () => {
    const logger = captureLogger();
    logToolOutcome(logger, { ...event(), result: ERROR_RESULT });
    expect(logger.lines[0]).toMatchObject({
      level: "warn",
      fields: { outcome: "internal_error", errorClass: UNCAPTURED_ERROR_CLASS },
    });
  });

  it("drops a request id that is not id-shaped and does nothing without a logger", () => {
    const logger = captureLogger();
    logToolOutcome(logger, { ...event({ requestId: "user@example.com" }) });
    expect(logger.lines[0]?.fields).not.toHaveProperty("requestId");
    expect(() => logToolOutcome(undefined, event())).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// registerContracted integration
// ---------------------------------------------------------------------------

/** Values planted in the fixture: none may ever appear in a log line. */
const SENTINELS = {
  email: "canary.sentinel.q7z@example.test",
  firstName: "Qzxcanaryfirst",
  lastName: "Qzxcanarylast",
  weight: 123.456789,
  hrv: 71.918273,
  respiratoryRate: 14.637281,
  kilojoule: 8914.617283,
  strain: 13.572468,
  invalidDate: "canary-invalid-Qzx-date",
};

function canaryUser(): ReturnType<typeof liveShapedUser> {
  const user = liveShapedUser();
  user.profile = {
    ...user.profile,
    email: SENTINELS.email,
    first_name: SENTINELS.firstName,
    last_name: SENTINELS.lastName,
  };
  user.body = { ...user.body, weight_kilogram: SENTINELS.weight };
  for (const recovery of user.recoveries) {
    if (recovery.score) recovery.score.hrv_rmssd_milli = SENTINELS.hrv;
  }
  for (const sleep of user.sleeps) {
    if (sleep.score) sleep.score.respiratory_rate = SENTINELS.respiratoryRate;
  }
  for (const cycle of user.cycles) {
    if (cycle.score) cycle.score.kilojoule = SENTINELS.kilojoule;
  }
  for (const workout of user.workouts) {
    if (workout.score) workout.score.strain = SENTINELS.strain;
  }
  return user;
}

function sentinelStrings(): string[] {
  return [
    ...Object.values(SENTINELS).map(String),
    ...Object.values(LIVE_SHAPED_IDS.sleeps),
    ...Object.values(LIVE_SHAPED_IDS.workouts),
  ];
}

/** Arguments that exercise each legacy tool; registry tools use their defaults unless an input is required. */
const LEGACY_ARGS: Record<string, Record<string, unknown>> = {
  get_recovery_collection: { start: "2026-09-14", limit: 25 },
  get_sleep_collection: { start: "2026-09-14", limit: 25 },
  get_workout_collection: { start: "2026-09-14", limit: 25 },
  get_cycle_collection: { start: "2026-09-14", limit: 25 },
  get_sleep_by_id: { id: LIVE_SHAPED_IDS.sleeps.second },
  get_workout_by_id: { id: LIVE_SHAPED_IDS.workouts.eveningRun },
  get_cycle_by_id: { id: LIVE_SHAPED_IDS.cycles.open },
  compare_periods: {
    period_a_start: "2026-09-14",
    period_a_end: "2026-09-14",
    period_b_start: "2026-09-15",
    period_b_end: "2026-09-16",
  },
  get_trend: { metric: "hrv", days: 7 },
  get_calendar: { days: 7 },
  get_workout_context: { id: LIVE_SHAPED_IDS.workouts.eveningRun },
};

describe("tool call logging through the server", () => {
  const fixture = canaryUser();

  beforeEach(() => {
    registry.tools.length = 0;
    registry.tools.push(...registry.actual);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(fixture.now);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([["standard" as const], ["aggregate" as const]])(
    "logs one line per call for every %s tool without any planted value",
    async (privacyMode) => {
      const logger = captureLogger();
      const client = createWhoopFixtureClient({ ...fixture, now: fixture.now });
      const connection = await connectServer(client, {
        privacyMode,
        logger,
        now: () => fixture.now,
      });
      let calls = 0;
      const outputs: string[] = [];
      try {
        for (const tool of connection.tools) {
          outputs.push((await connection.callTool(tool.name, LEGACY_ARGS[tool.name] ?? {})).text);
          calls++;
        }
        // Failures: a missing record, and a date argument that is not a date.
        if (connection.tools.some((tool) => tool.name === "get_sleep_by_id")) {
          await connection.callTool("get_sleep_by_id", {
            id: "0f0f0f0f-aaaa-4bbb-8ccc-123456789abc",
          });
          calls++;
        }
        if (connection.tools.some((tool) => tool.name === "get_calendar")) {
          const invalid = await connection.callTool("get_calendar", {
            start: SENTINELS.invalidDate,
          });
          expect(invalid.isError).toBe(true);
          calls++;
        }
      } finally {
        await connection.close();
      }

      const toolLines = logger.lines.filter(
        (line) => line.msg === "tool call ok" || line.msg === "tool call failed"
      );
      expect(toolLines).toHaveLength(calls);
      expect(new Set(toolLines.map((line) => line.fields.tool))).toEqual(
        new Set(connection.tools.map((tool) => tool.name))
      );
      for (const line of toolLines) {
        expect(line.fields.privacyMode).toBe(privacyMode);
        expect(typeof line.fields.durationMs).toBe("number");
      }
      const serialized = JSON.stringify(logger.lines);
      for (const sentinel of sentinelStrings()) {
        expect(serialized).not.toContain(sentinel);
      }
      // The planted values did reach the tool results, so a leak would show.
      if (privacyMode === "standard") {
        const combined = outputs.join(" ");
        expect(combined).toContain(SENTINELS.email);
        expect(combined).toContain(LIVE_SHAPED_IDS.workouts.eveningRun);
      }
    },
    60_000
  );

  it("logs no ids, dates or query strings from WHOOP requests of a real client over a mocked fetch", async () => {
    const logger = captureLogger();
    const fixtureClient = createWhoopFixtureClient({ ...fixture, now: fixture.now });
    const BASE_URL = "https://whoop.canary.test";
    let served = 0;
    const fetchMock = vi.fn(async (url: string): Promise<Response> => {
      served += 1;
      // One 429 and one TimeoutError along the way; everything else from the fixture
      if (served === 2) {
        return new Response("{}", {
          status: 429,
          statusText: "Too Many Requests",
          headers: { "retry-after": "0" },
        });
      }
      if (served === 5) {
        throw new DOMException(`timeout for ${url}`, "TimeoutError");
      }
      try {
        const data = await fixtureClient.get<unknown>(url.slice(BASE_URL.length));
        return new Response(JSON.stringify(data), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      } catch (error: unknown) {
        const status = error instanceof WhoopApiError ? error.statusCode : 500;
        return new Response("{}", { status, statusText: "Error" });
      }
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = createWhoopClient({ accessToken: "canary-token", baseUrl: BASE_URL, logger });
    const connection = await connectServer(client, { logger, now: () => fixture.now });
    try {
      for (const tool of connection.tools) {
        await connection.callTool(tool.name, LEGACY_ARGS[tool.name] ?? {});
      }
    } finally {
      await connection.close();
      vi.unstubAllGlobals();
    }

    const requestUrls = fetchMock.mock.calls.map(([url]) => url);
    expect(requestUrls.some((url) => url.includes("?start="))).toBe(true);
    expect(requestUrls.some((url) => url.includes(LIVE_SHAPED_IDS.workouts.eveningRun))).toBe(true);
    const whoopLines = logger.lines.filter((line) => line.msg.startsWith("whoop api"));
    expect(whoopLines.map((line) => line.msg)).toEqual(
      expect.arrayContaining(["whoop api request", "whoop api rate limited", "whoop api timeout"])
    );
    for (const line of whoopLines) {
      expect(line.fields).not.toHaveProperty("url");
      expect(line.fields.endpoint).toMatch(/^(\/(v\d+|[a-z_]+|:id))+$/);
    }
    const serialized = JSON.stringify(logger.lines);
    expect(serialized).not.toContain("?");
    expect(serialized).not.toContain(BASE_URL);
    expect(serialized).not.toContain("canary-token");
    const dates = new Set<string>();
    for (const url of requestUrls) {
      const query = url.split("?")[1];
      if (query === undefined) continue;
      for (const [, value] of new URLSearchParams(query)) dates.add(value);
    }
    for (const value of [
      ...sentinelStrings(),
      ...Object.values(LIVE_SHAPED_IDS.cycles).map(String),
      ...[...dates].filter((value) => value.length > 2),
      ...[...dates].map((value) => encodeURIComponent(value)).filter((value) => value.length > 2),
    ]) {
      expect(serialized).not.toContain(value);
    }
  }, 60_000);

  it("classifies errors thrown inside legacy and registry tools by their real class", async () => {
    const logger = captureLogger();
    const client = createWhoopFixtureClient({
      ...fixture,
      now: fixture.now,
      failures: [
        {
          path: /^\/v2\/activity\/workout(\?|$)/,
          error: () => new WhoopApiError(429, "Too Many Requests", { body: SENTINELS.email }),
        },
      ],
    });
    const connection = await connectServer(client, { logger, now: () => fixture.now });
    try {
      // Legacy tool: the handler throws a WHOOP 429 inside safeTool.
      expect((await connection.callTool("get_workout_collection", {})).isError).toBe(true);
      // Legacy tool: invalid user input.
      expect(
        (await connection.callTool("get_calendar", { start: SENTINELS.invalidDate })).isError
      ).toBe(true);
      // Registry tool: invalid user input thrown from run().
      expect((await connection.callTool("get_day", { date: "last week" })).isError).toBe(true);
    } finally {
      await connection.close();
    }
    const failures = logger.lines.filter((line) => line.msg === "tool call failed");
    expect(failures).toEqual([
      {
        level: "warn",
        msg: "tool call failed",
        fields: expect.objectContaining({
          tool: "get_workout_collection",
          outcome: "upstream_error",
          errorClass: "WhoopApiError",
          httpStatus: 429,
        }),
      },
      {
        level: "info",
        msg: "tool call failed",
        fields: expect.objectContaining({
          tool: "get_calendar",
          outcome: "invalid_input",
          errorClass: "InvalidDateExpression",
        }),
      },
      {
        level: "info",
        msg: "tool call failed",
        fields: expect.objectContaining({
          tool: "get_day",
          outcome: "invalid_input",
          errorClass: "InvalidDateExpression",
        }),
      },
    ]);
    expect(JSON.stringify(logger.lines)).not.toContain(UNCAPTURED_ERROR_CLASS);
    expect(JSON.stringify(logger.lines)).not.toContain(SENTINELS.email);
  });

  it("logs a contract violation at error with field paths and no values", async () => {
    const leaky: AnyToolDefinition = defineTool({
      name: "canary_contract",
      annotations: { readOnlyHint: true },
      standard: {
        title: "Canary contract",
        description: "Returns data that breaks its own output contract.",
        inputSchema: z.object({ note: z.string().optional() }),
        outputSchema: z.object({ value: z.string(), email: z.number() }),
        run: async () =>
          ({ value: SENTINELS.weight, email: SENTINELS.email }) as unknown as {
            value: string;
            email: number;
          },
      },
    });
    registry.tools.push(leaky);
    const logger = captureLogger();
    const connection = await connectServer(createWhoopFixtureClient(), { logger });
    try {
      const result = await connection.callTool("canary_contract", { note: SENTINELS.firstName });
      expect(result.isError).toBe(true);
    } finally {
      await connection.close();
    }
    const failures = logger.lines.filter((line) => line.msg === "tool call failed");
    expect(failures).toEqual([
      {
        level: "error",
        msg: "tool call failed",
        fields: expect.objectContaining({
          tool: "canary_contract",
          outcome: "contract_violation",
          contractIssues: ["value:invalid_type", "email:invalid_type"],
          argKeys: ["note"],
        }),
      },
    ]);
    const serialized = JSON.stringify(logger.lines);
    for (const sentinel of [SENTINELS.email, String(SENTINELS.weight), SENTINELS.firstName]) {
      expect(serialized).not.toContain(sentinel);
    }
  });

  it("logs a successful call at debug with the request id of its HTTP request", async () => {
    const logger = captureLogger();
    const { createWhoopServer } = await import("../../src/server.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { server } = createWhoopServer(createWhoopFixtureClient({ ...fixture }), {
      logger,
      disableResources: true,
      requestContext: {
        requestId: "6c1d9a52-3a0e-4f7c-9a55-2b8f7d0e1c44",
        auth: "oauth",
        clientId: "dcr.x.y",
      },
    });
    const client = new Client({ name: "log-test", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    try {
      await client.callTool({ name: "get_profile", arguments: {} });
    } finally {
      await client.close();
      await server.close();
    }
    expect(logger.lines).toEqual([
      {
        level: "debug",
        msg: "tool call ok",
        fields: {
          tool: "get_profile",
          durationMs: expect.any(Number),
          requestId: "6c1d9a52-3a0e-4f7c-9a55-2b8f7d0e1c44",
          argKeys: [],
          privacyMode: "standard",
        },
      },
    ]);
  });
});
