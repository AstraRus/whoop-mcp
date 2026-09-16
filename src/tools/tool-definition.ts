/**
 * Declarative tool definitions for tools registered through the registry
 * (src/tools/registry). The server registers each definition with its output
 * contract: the standard variant in standard privacy mode, and the aggregate
 * variant (when present) in aggregate mode. Results are validated against the
 * variant's output schema and returned as compact JSON text, within
 * {@link MAX_TOOL_TEXT_CHARS}.
 */

import type { z } from "zod";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { WhoopClient } from "../api/client.js";
import type { MemoryCache } from "../cache/memory-cache.js";
import type { Logger } from "../logging/logger.js";
import type { PrivacyMode } from "../privacy.js";
import type { RuntimeStatus } from "../runtime-status.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Largest text result (characters) a registry tool may return. The same data
 * is also sent as structuredContent, and common MCP clients truncate larger
 * results.
 */
export const MAX_TOOL_TEXT_CHARS = 100_000;

/** Registry tool names: lower snake case, 3-64 characters. */
export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{2,63}$/;

/** Longest description a registry tool may advertise. */
export const MAX_TOOL_DESCRIPTION_CHARS = 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Everything a registry tool may use while it runs. Created per call. */
export interface ToolContext {
  client: WhoopClient;
  privacyMode: PrivacyMode;
  /** Process-wide cache for history chunks (absent in tests that do not pass one). */
  historyCache?: MemoryCache;
  runtime?: RuntimeStatus;
  logger?: Logger;
  /** The logical current time (analysis windows, open cycles). */
  now(): Date;
  /** Wall-clock epoch ms when this call started (request budgets and deadlines). */
  startedAtMs: number;
}

/** A plain z.object input schema (no refinements; check cross-field rules in run). */
export type ToolInputSchema = z.ZodObject;

/** A z.object output schema, advertised as the tool's outputSchema. */
export type ToolOutputSchema = z.ZodObject;

/** One privacy-mode variant of a tool. */
export interface ToolVariant<
  I extends ToolInputSchema = ToolInputSchema,
  O extends ToolOutputSchema = ToolOutputSchema,
> {
  description: string;
  /** Short human-readable title. */
  title: string;
  inputSchema: I;
  outputSchema: O;
  /**
   * Produce the result. Invalid user input throws InvalidDateExpression; WHOOP
   * failures throw the client error. An aggregate variant returns the already
   * projected payload.
   */
  run(args: z.infer<I>, ctx: ToolContext): Promise<z.input<O>>;
}

/** A tool registered through the registry. */
export interface ToolDefinition<
  I extends ToolInputSchema = ToolInputSchema,
  O extends ToolOutputSchema = ToolOutputSchema,
  AI extends ToolInputSchema = ToolInputSchema,
  AO extends ToolOutputSchema = ToolOutputSchema,
> {
  /** Matches {@link TOOL_NAME_PATTERN}. */
  name: string;
  annotations: ToolAnnotations;
  standard: ToolVariant<I, O>;
  /** Registered in aggregate mode when present; otherwise the tool is absent there. */
  aggregate?: ToolVariant<AI, AO>;
}

/** A tool definition with its schema types erased, for registry lists. */
export type AnyToolDefinition = ToolDefinition<
  ToolInputSchema,
  ToolOutputSchema,
  ToolInputSchema,
  ToolOutputSchema
>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Typed helper for declaring a tool: infers the run argument and result types
 * from the schemas.
 *
 * @throws Error when the name does not match {@link TOOL_NAME_PATTERN}
 */
export function defineTool<
  I extends ToolInputSchema,
  O extends ToolOutputSchema,
  AI extends ToolInputSchema = ToolInputSchema,
  AO extends ToolOutputSchema = ToolOutputSchema,
>(definition: ToolDefinition<I, O, AI, AO>): ToolDefinition<I, O, AI, AO> {
  if (!TOOL_NAME_PATTERN.test(definition.name)) {
    throw new Error(`Invalid tool name "${definition.name}".`);
  }
  return definition;
}

/**
 * Check a registry tool list: valid unique names that do not collide with
 * `reservedNames` (the legacy tools), and per variant a non-empty title, a
 * description of at most {@link MAX_TOOL_DESCRIPTION_CHARS} characters and a
 * readOnlyHint annotation.
 *
 * @throws Error naming the first problem found
 */
export function validateToolDefinitions(
  tools: readonly AnyToolDefinition[],
  reservedNames: readonly string[]
): void {
  const reserved = new Set(reservedNames);
  const seen = new Set<string>();
  for (const tool of tools) {
    if (!TOOL_NAME_PATTERN.test(tool.name)) {
      throw new Error(`Invalid tool name "${tool.name}".`);
    }
    if (reserved.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" collides with a legacy tool.`);
    }
    if (seen.has(tool.name)) {
      throw new Error(`Duplicate tool name "${tool.name}".`);
    }
    seen.add(tool.name);
    if (tool.annotations.readOnlyHint !== true) {
      throw new Error(`Tool "${tool.name}" must be annotated readOnlyHint: true.`);
    }
    const variants = tool.aggregate ? [tool.standard, tool.aggregate] : [tool.standard];
    for (const variant of variants) {
      if (variant.title.trim().length === 0) {
        throw new Error(`Tool "${tool.name}" needs a title.`);
      }
      if (
        variant.description.trim().length === 0 ||
        variant.description.length > MAX_TOOL_DESCRIPTION_CHARS
      ) {
        throw new Error(
          `Tool "${tool.name}" needs a description of 1-${MAX_TOOL_DESCRIPTION_CHARS} characters.`
        );
      }
    }
  }
}
