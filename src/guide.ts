/**
 * Server guide: the MCP initialize `instructions` and the markdown guide.
 * Stubs until package P10 writes the content.
 */

import type { PrivacyMode } from "./privacy.js";

/**
 * Instructions sent in the MCP initialize result for `mode`, or undefined for
 * none.
 */
export function buildServerInstructions(_mode: PrivacyMode): string | undefined {
  return undefined;
}

/** The markdown server guide for `mode`, or null when there is none. */
export function buildGuideMarkdown(_mode: PrivacyMode): string | null {
  return null;
}
