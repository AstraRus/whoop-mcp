import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  ADDITIONAL_TOOLS,
  LEGACY_AGGREGATE_TOOL_NAMES,
  LEGACY_TOOL_NAMES,
} from "../../src/tools/registry/index.js";
import {
  defineTool,
  MAX_TOOL_DESCRIPTION_CHARS,
  TOOL_NAME_PATTERN,
  validateToolDefinitions,
  type AnyToolDefinition,
} from "../../src/tools/tool-definition.js";
import { aggregateOutputSchemas, outputSchemas } from "../../src/tools/output-contracts.js";
import { listToolNames } from "../helpers/contract.js";

function tool(name: string): AnyToolDefinition {
  return defineTool({
    name,
    annotations: { readOnlyHint: true },
    standard: {
      title: "Placeholder",
      description: "A tool used only by tests.",
      inputSchema: z.object({ days: z.number().int().optional() }),
      outputSchema: z.object({ days: z.number() }),
      run: async (args) => ({ days: args.days ?? 7 }),
    },
  });
}

describe("legacy tool names", () => {
  it("lists the 16 legacy tools, each with a standard output contract", () => {
    expect(LEGACY_TOOL_NAMES).toHaveLength(16);
    expect(new Set(LEGACY_TOOL_NAMES).size).toBe(16);
    expect([...LEGACY_TOOL_NAMES].sort()).toEqual(Object.keys(outputSchemas).sort());
  });

  it("lists the legacy aggregate tools, each with an aggregate output contract", () => {
    expect([...LEGACY_AGGREGATE_TOOL_NAMES].sort()).toEqual(
      Object.keys(aggregateOutputSchemas).sort()
    );
  });

  it("matches the tools the server registers, in both modes", async () => {
    const additionalStandard = ADDITIONAL_TOOLS.map((definition) => definition.name);
    const additionalAggregate = ADDITIONAL_TOOLS.filter((definition) => definition.aggregate).map(
      (definition) => definition.name
    );
    expect(await listToolNames("standard")).toEqual(
      [...LEGACY_TOOL_NAMES, ...additionalStandard].sort()
    );
    expect(await listToolNames("aggregate")).toEqual(
      [...LEGACY_AGGREGATE_TOOL_NAMES, ...additionalAggregate].sort()
    );
  });
});

describe("ADDITIONAL_TOOLS", () => {
  it("passes registry validation: unique names, no legacy collisions, titles and descriptions", () => {
    expect(() => validateToolDefinitions(ADDITIONAL_TOOLS, LEGACY_TOOL_NAMES)).not.toThrow();
    for (const definition of ADDITIONAL_TOOLS) {
      expect(definition.name).toMatch(TOOL_NAME_PATTERN);
    }
  });
});

describe("validateToolDefinitions", () => {
  it("accepts distinct, well-formed tools", () => {
    expect(() =>
      validateToolDefinitions([tool("get_day"), tool("get_sync_status")], LEGACY_TOOL_NAMES)
    ).not.toThrow();
  });

  it("rejects a duplicate name", () => {
    expect(() =>
      validateToolDefinitions([tool("get_day"), tool("get_day")], LEGACY_TOOL_NAMES)
    ).toThrow('Duplicate tool name "get_day".');
  });

  it("rejects a collision with a legacy tool", () => {
    expect(() => validateToolDefinitions([tool("get_today")], LEGACY_TOOL_NAMES)).toThrow(
      'Tool "get_today" collides with a legacy tool.'
    );
  });

  it("rejects malformed names", () => {
    for (const name of ["Get_day", "gd", "1_day", "get-day", `g${"x".repeat(64)}`]) {
      const definition = { ...tool("get_day"), name };
      expect(() => validateToolDefinitions([definition], LEGACY_TOOL_NAMES)).toThrow(
        "Invalid tool name"
      );
    }
  });

  it("rejects tools that are not read-only, untitled, or over-long descriptions", () => {
    const base = tool("get_day");
    expect(() =>
      validateToolDefinitions([{ ...base, annotations: {} }], LEGACY_TOOL_NAMES)
    ).toThrow("readOnlyHint");
    expect(() =>
      validateToolDefinitions(
        [{ ...base, standard: { ...base.standard, title: " " } }],
        LEGACY_TOOL_NAMES
      )
    ).toThrow("needs a title");
    expect(() =>
      validateToolDefinitions(
        [
          {
            ...base,
            aggregate: {
              ...base.standard,
              description: "x".repeat(MAX_TOOL_DESCRIPTION_CHARS + 1),
            },
          },
        ],
        LEGACY_TOOL_NAMES
      )
    ).toThrow("description");
  });
});

describe("defineTool", () => {
  it("returns the definition and rejects an invalid name", () => {
    const definition = tool("get_day");
    expect(definition.name).toBe("get_day");
    expect(() => defineTool({ ...definition, name: "Bad Name" })).toThrow("Invalid tool name");
  });
});
