/**
 * Registration of registry tools (ADDITIONAL_TOOLS) by createWhoopServer: the
 * variant chosen per privacy mode, the per-call ToolContext, compact JSON
 * text, contract validation, error mapping and the result size guard.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AnyToolDefinition, ToolContext } from "../src/tools/tool-definition.js";
import { defineTool, MAX_TOOL_TEXT_CHARS } from "../src/tools/tool-definition.js";
import { createWhoopServer, type CreateServerOptions } from "../src/server.js";
import { MemoryCache } from "../src/cache/memory-cache.js";
import { createRuntimeStatus } from "../src/runtime-status.js";
import { InvalidDateExpression } from "../src/tools/date-utils.js";
import { WhoopRateBudgetError } from "../src/api/client.js";
import type { Logger } from "../src/logging/logger.js";
import { createWhoopFixtureClient } from "./helpers/whoop-fixture-client.js";

const registry = vi.hoisted(() => ({
  tools: [] as unknown[],
  instructions: undefined as string | undefined,
}));

vi.mock("../src/tools/registry/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/tools/registry/index.js")>();
  return { ...actual, ADDITIONAL_TOOLS: registry.tools };
});

vi.mock("../src/guide.js", () => ({
  buildServerInstructions: () => registry.instructions,
  buildGuideMarkdown: () => null,
}));

function useTools(...tools: AnyToolDefinition[]): void {
  registry.tools.length = 0;
  registry.tools.push(...tools);
}

async function connect(
  options: CreateServerOptions = {}
): Promise<{ client: Client; close: () => Promise<void> }> {
  const whoop = createWhoopFixtureClient({
    body: { height_meter: 1.8, weight_kilogram: 80, max_heart_rate: 190 },
  });
  const { server } = createWhoopServer(whoop, options);
  const client = new Client({ name: "registry-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  // Listing tools makes the client validate structured results against output schemas
  await client.listTools();
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

function textOf(result: CallToolResult): string {
  const [item] = result.content;
  if (item?.type !== "text") throw new Error("expected a text item");
  return item.text;
}

const echoTool = defineTool({
  name: "echo_days",
  annotations: { readOnlyHint: true },
  standard: {
    title: "Echo days",
    description: "Returns the requested days and details.",
    inputSchema: z.object({ days: z.number().int().min(1).max(30).optional() }),
    outputSchema: z.object({ days: z.number(), detail: z.array(z.string()) }),
    run: async (args) => ({ days: args.days ?? 7, detail: ["a", "b"] }),
  },
  aggregate: {
    title: "Echo weeks",
    description: "Returns released weeks only.",
    inputSchema: z.object({}),
    outputSchema: z.object({ weeks: z.number() }),
    run: async () => ({ weeks: 4 }),
  },
});

const standardOnlyTool = defineTool({
  name: "standard_only",
  annotations: { readOnlyHint: true },
  standard: {
    title: "Standard only",
    description: "Only in standard mode.",
    inputSchema: z.object({}),
    outputSchema: z.object({ ok: z.boolean() }),
    run: async () => ({ ok: true }),
  },
});

describe("registry tools in createWhoopServer", () => {
  beforeEach(() => {
    useTools();
    registry.instructions = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers the standard variant after the legacy tools with title and annotations", async () => {
    useTools(echoTool, standardOnlyTool);
    const { client, close } = await connect();
    try {
      const { tools } = await client.listTools();
      const names = tools.map((entry) => entry.name);
      expect(names.slice(-2)).toEqual(["echo_days", "standard_only"]);
      expect(names).toHaveLength(18);
      const echo = tools.find((entry) => entry.name === "echo_days")!;
      expect(echo).toMatchObject({
        title: "Echo days",
        description: "Returns the requested days and details.",
        annotations: { readOnlyHint: true },
      });
      expect(Object.keys(echo.inputSchema.properties ?? {})).toEqual(["days"]);
      expect(Object.keys(echo.outputSchema?.properties ?? {})).toEqual(["days", "detail"]);
    } finally {
      await close();
    }
  });

  it("returns compact JSON text equal to the structured content; legacy tools stay pretty", async () => {
    useTools(echoTool);
    const { client, close } = await connect();
    try {
      const result = await call(client, "echo_days", { days: 3 });
      expect(result.isError).not.toBe(true);
      expect(textOf(result)).toBe('{"days":3,"detail":["a","b"]}');
      expect(result.structuredContent).toEqual({ days: 3, detail: ["a", "b"] });

      const legacy = await call(client, "get_body_measurement");
      expect(textOf(legacy)).toContain("\n  ");
    } finally {
      await close();
    }
  });

  it("registers the aggregate variant in aggregate mode and skips tools without one", async () => {
    useTools(echoTool, standardOnlyTool);
    const { client, close } = await connect({ privacyMode: "aggregate" });
    try {
      const { tools } = await client.listTools();
      const names = tools.map((entry) => entry.name);
      expect(names).toContain("echo_days");
      expect(names).not.toContain("standard_only");
      expect(tools.find((entry) => entry.name === "echo_days")?.title).toBe("Echo weeks");

      const result = await call(client, "echo_days");
      expect(textOf(result)).toBe('{"weeks":4}');
    } finally {
      await close();
    }
  });

  it("passes a fresh context with the server options to every call", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-09-16T21:30:00Z"));
    const seen: ToolContext[] = [];
    useTools(
      defineTool({
        name: "context_probe",
        annotations: { readOnlyHint: true },
        standard: {
          title: "Context probe",
          description: "Records its context.",
          inputSchema: z.object({}),
          outputSchema: z.object({ ok: z.boolean() }),
          run: async (_args, ctx) => {
            seen.push(ctx);
            return { ok: true };
          },
        },
      })
    );
    const historyCache = new MemoryCache();
    const runtimeStatus = createRuntimeStatus({
      version: "1",
      commit: null,
      privacyMode: "standard",
    });
    const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const now = (): Date => new Date("2026-09-16T23:30:00+02:00");
    const { client, close } = await connect({ historyCache, runtimeStatus, logger, now });
    try {
      await call(client, "context_probe");
      vi.setSystemTime(Date.parse("2026-09-16T21:30:05Z"));
      await call(client, "context_probe");
    } finally {
      await close();
    }
    expect(seen).toHaveLength(2);
    const [first, second] = seen;
    expect(first!.privacyMode).toBe("standard");
    expect(first!.historyCache).toBe(historyCache);
    expect(first!.runtime).toBe(runtimeStatus);
    expect(first!.logger).toBe(logger);
    expect(first!.now().toISOString()).toBe("2026-09-16T21:30:00.000Z");
    expect(typeof first!.client.get).toBe("function");
    expect(first!.startedAtMs).toBe(Date.parse("2026-09-16T21:30:00Z"));
    expect(second!.startedAtMs).toBe(Date.parse("2026-09-16T21:30:05Z"));
  });

  it("defaults the context clock to the system time", async () => {
    let seenNow: Date | undefined;
    useTools(
      defineTool({
        name: "clock_probe",
        annotations: { readOnlyHint: true },
        standard: {
          title: "Clock probe",
          description: "Records now().",
          inputSchema: z.object({}),
          outputSchema: z.object({ ok: z.boolean() }),
          run: async (_args, ctx) => {
            seenNow = ctx.now();
            return { ok: true };
          },
        },
      })
    );
    const { client, close } = await connect();
    try {
      const before = Date.now();
      await call(client, "clock_probe");
      expect(seenNow!.getTime()).toBeGreaterThanOrEqual(before);
      expect(seenNow!.getTime()).toBeLessThanOrEqual(Date.now());
    } finally {
      await close();
    }
  });

  it("maps a contract mismatch and thrown errors to isError results", async () => {
    let failure: unknown;
    useTools(
      defineTool({
        name: "failing_tool",
        annotations: { readOnlyHint: true },
        standard: {
          title: "Failing tool",
          description: "Throws or returns bad data.",
          inputSchema: z.object({ mode: z.enum(["throw", "bad"]) }),
          outputSchema: z.object({ count: z.number().int() }),
          run: async (args) => {
            if (args.mode === "throw") throw failure;
            return { count: 1.5 };
          },
        },
      })
    );
    const { client, close } = await connect();
    try {
      const bad = await call(client, "failing_tool", { mode: "bad" });
      expect(bad.isError).toBe(true);
      expect(textOf(bad)).toMatch(
        /^WHOOP data did not match the expected output contract \(count:/
      );

      failure = new InvalidDateExpression('Unrecognized date expression: "someday".');
      const invalid = await call(client, "failing_tool", { mode: "throw" });
      expect(invalid.isError).toBe(true);
      expect(textOf(invalid)).toBe('Unrecognized date expression: "someday".');

      failure = new WhoopRateBudgetError();
      const budget = await call(client, "failing_tool", { mode: "throw" });
      expect(textOf(budget)).toBe(
        "The server paused WHOOP requests to stay within WHOOP's per-minute request limit; retry in a minute or request a shorter period."
      );
    } finally {
      await close();
    }
  });

  it("returns isError guidance when the compact text exceeds MAX_TOOL_TEXT_CHARS", async () => {
    // Compact JSON of {"s":"<k chars>"} is k + 8 characters
    useTools(
      defineTool({
        name: "sized_tool",
        annotations: { readOnlyHint: true },
        standard: {
          title: "Sized tool",
          description: "Returns a string of the requested length.",
          inputSchema: z.object({ extra: z.number().int() }),
          outputSchema: z.object({ s: z.string() }),
          run: async (args) => ({ s: "x".repeat(MAX_TOOL_TEXT_CHARS - 8 + args.extra) }),
        },
      })
    );
    const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { client, close } = await connect({ logger });
    try {
      const atLimit = await call(client, "sized_tool", { extra: 0 });
      expect(atLimit.isError).not.toBe(true);
      expect(textOf(atLimit)).toHaveLength(MAX_TOOL_TEXT_CHARS);

      const over = await call(client, "sized_tool", { extra: 1 });
      expect(over.isError).toBe(true);
      expect(over.structuredContent).toBeUndefined();
      expect(textOf(over)).toBe(
        `The result is too large for the MCP client (${MAX_TOOL_TEXT_CHARS + 1} characters); request fewer days, a lower limit or fewer datasets.`
      );
      expect(logger.warn).toHaveBeenCalledWith(
        "tool call failed",
        expect.objectContaining({
          tool: "sized_tool",
          outcome: "output_too_large",
          errorClass: "OutputTooLarge",
          chars: MAX_TOOL_TEXT_CHARS + 1,
        })
      );
      expect(logger.warn).not.toHaveBeenCalledWith("tool output too large", expect.anything());
    } finally {
      await close();
    }
  });

  it("sends the guide instructions when there are any", async () => {
    const without = await connect();
    try {
      expect(without.client.getInstructions()).toBeUndefined();
    } finally {
      await without.close();
    }

    registry.instructions = "Use get_today for today's snapshot.";
    const withInstructions = await connect();
    try {
      expect(withInstructions.client.getInstructions()).toBe("Use get_today for today's snapshot.");
    } finally {
      await withInstructions.close();
    }
  });

  it("registers only aggregate_overview in aggregate mode and all prompts in standard mode", async () => {
    const standard = await connect();
    try {
      expect((await standard.client.listPrompts()).prompts.length).toBeGreaterThan(0);
    } finally {
      await standard.close();
    }
    const aggregate = await connect({ privacyMode: "aggregate" });
    try {
      expect((await aggregate.client.listPrompts()).prompts.map((prompt) => prompt.name)).toEqual([
        "aggregate_overview",
      ]);
    } finally {
      await aggregate.close();
    }
  });
});
