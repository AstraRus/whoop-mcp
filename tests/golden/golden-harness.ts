/**
 * Golden files: JSON snapshots under tests/golden that pin client-visible
 * server output.
 *
 * A golden is compared by value and byte for byte (key order and formatting;
 * CRLF from a Windows checkout is normalized). A missing golden fails.
 *
 * Regenerating: UPDATE_GOLDENS=1 rewrites every golden a run produces. Each
 * golden belongs to the package that owns its tool, resource or prompt, so
 * regenerate only your own files by listing them (comma-separated, paths
 * relative to tests/golden without ".json", "*" matches within a path segment):
 *
 *   UPDATE_GOLDENS=outputs/standard-get_today,tools-list/*-get_today vitest run tests/golden
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolCallOutcome } from "../helpers/contract.js";

/** Directory holding the golden files. */
export const GOLDEN_DIR = dirname(fileURLToPath(import.meta.url));

/** How a text payload relates to its JSON value. */
export type TextFormat = "pretty_json" | "compact_json" | "text";

/** A tool result as stored in a golden. */
export interface RenderedToolResult {
  isError: boolean;
  /** pretty_json/compact_json: the text is exactly that serialization of structuredContent. */
  text_format: TextFormat;
  /** Present only when text_format is "text". */
  text?: string;
  structuredContent: Record<string, unknown> | null;
}

/** One resource content item as stored in a golden. */
export interface RenderedResourceContent {
  uri: string;
  mimeType: string | null;
  /** pretty_json/compact_json: `json` serialized that way is exactly the text. */
  text_format: TextFormat;
  json?: unknown;
  text?: string;
}

function matchesPattern(path: string, pattern: string): boolean {
  const escaped = pattern
    .trim()
    .replace(/\.json$/, "")
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  return new RegExp(`^${escaped}$`).test(path);
}

/** Whether this run rewrites the golden at `path` (relative to tests/golden, without .json). */
export function shouldUpdateGolden(path: string): boolean {
  const setting = process.env.UPDATE_GOLDENS?.trim();
  if (!setting || setting === "0" || setting === "false") return false;
  if (setting === "1" || setting === "true" || setting === "all") return true;
  return setting.split(",").some((pattern) => matchesPattern(path, pattern));
}

/** The golden file content for a value. */
export function serializeGolden(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Compare `actual` with the golden at `path` (relative to tests/golden, without
 * .json), or write it when this run updates that golden. Mismatches are soft
 * assertions: the test fails, but later goldens in the same test are still
 * compared (or written).
 */
export function expectGolden(path: string, actual: unknown): void {
  const file = join(GOLDEN_DIR, `${path}.json`);
  const serialized = serializeGolden(actual);
  if (shouldUpdateGolden(path)) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, serialized, "utf8");
    return;
  }
  if (!existsSync(file)) {
    expect
      .soft(
        false,
        `Golden file tests/golden/${path}.json is missing. Goldens are captured from the reference ` +
          `implementation: run with UPDATE_GOLDENS=${path} only if this output is new and owned by your change.`
      )
      .toBe(true);
    return;
  }
  const expectedText = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  expect.soft(JSON.parse(serialized), `golden ${path}`).toStrictEqual(JSON.parse(expectedText));
  expect.soft(serialized, `golden ${path} (key order and formatting)`).toBe(expectedText);
}

function textFormatOf(text: string, value: unknown): TextFormat {
  if (text === JSON.stringify(value, null, 2)) return "pretty_json";
  if (text === JSON.stringify(value)) return "compact_json";
  return "text";
}

/** Render a tool outcome for a golden. */
export function renderToolOutcome(outcome: ToolCallOutcome): RenderedToolResult {
  const format =
    outcome.structured === null ? "text" : textFormatOf(outcome.text, outcome.structured);
  return {
    isError: outcome.isError,
    text_format: format,
    ...(format === "text" ? { text: outcome.text } : {}),
    structuredContent: outcome.structured,
  };
}

/** Render resource contents for a golden: JSON text is stored parsed with its format. */
export function renderResourceContents(result: ReadResourceResult): RenderedResourceContent[] {
  return result.contents.map((content) => {
    const base = { uri: content.uri, mimeType: content.mimeType ?? null };
    if (!("text" in content) || typeof content.text !== "string") {
      return { ...base, text_format: "text" as const, text: "(binary content)" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content.text);
    } catch {
      return { ...base, text_format: "text" as const, text: content.text };
    }
    const format = textFormatOf(content.text, parsed);
    return format === "text"
      ? { ...base, text_format: format, text: content.text }
      : { ...base, text_format: format, json: parsed };
  });
}
