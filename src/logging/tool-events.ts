/**
 * Structured log events for MCP tool calls.
 *
 * Every tool call logs one line: debug 'tool call ok' on success, or 'tool call
 * failed' at info/warn/error with a classification of the failure (outcome,
 * error class, WHOOP HTTP status, token-refresh status, the chain of cause
 * names, output-contract field paths).
 *
 * Privacy rules (enforced here, not by callers):
 * - never an error message, argument value, record field value, URL or token;
 * - error and cause names only when they look like identifiers;
 * - contract issue paths with value-like segments (dates, ids) replaced by '*';
 * - stack frames as file:line only (file base name, no directories).
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { WhoopApiError, WhoopAuthError, WhoopNetworkError } from "../api/client.js";
import { WhoopRateBudgetError } from "../api/rate-limiter.js";
import { TokenRefreshError } from "../auth/token-refresh-error.js";
import type { PrivacyMode } from "../privacy.js";
import { InvalidDateExpression } from "../tools/date-utils.js";
import type { Logger } from "./logger.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Deepest `cause` followed when classifying an error. */
export const MAX_CAUSE_DEPTH = 5;

/** Most output-contract issues listed in one log line. */
export const MAX_CONTRACT_ISSUES = 5;

/** Most stack frames listed for an internal error. */
export const MAX_STACK_FRAMES = 8;

/** Most argument names listed in one log line. */
export const MAX_ARG_KEYS = 20;

/** errorClass of an isError result whose error was not captured. */
export const UNCAPTURED_ERROR_CLASS = "uncaptured";

/** An identifier-like name (error class, argument name, schema field). */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** How a tool call ended. */
export type ToolOutcome =
  | "invalid_input"
  | "upstream_error"
  | "contract_violation"
  | "output_too_large"
  | "internal_error";

/** Log level of a failed tool call. */
export type ToolFailureLevel = "info" | "warn" | "error";

/** A failure reduced to fields that are safe to log. */
export interface ToolErrorClassification {
  outcome: ToolOutcome;
  level: ToolFailureLevel;
  /** Name of the thrown error ('unknown' for values without a usable name). */
  errorClass: string;
  /** HTTP status of the first WhoopApiError in the cause chain. */
  httpStatus?: number;
  /** HTTP status of the first TokenRefreshError in the cause chain. */
  refreshStatus?: number;
  /** Names of the error and its causes, outermost first (at most 1 + MAX_CAUSE_DEPTH). */
  causeChain: string[];
  /** file:line frames, for internal errors only. */
  stackFrames?: string[];
}

/** One finished tool call, as registerContracted reports it. */
export interface ToolOutcomeEvent {
  tool: string;
  durationMs: number;
  requestId?: string;
  /** Names of the arguments the caller passed (never their values). */
  argKeys: readonly string[];
  privacyMode: PrivacyMode;
  /** The result returned to the client (success, or an isError result). */
  result?: CallToolResult;
  /** The error behind a failure, when known. */
  error?: unknown;
  /** The output-contract failure: the result did not match the tool's schema. */
  contractError?: z.ZodError;
  /** Characters of a result rejected as too large for MCP clients. */
  outputChars?: number;
}

// ---------------------------------------------------------------------------
// Error capture
// ---------------------------------------------------------------------------

const toolErrors = new WeakMap<object, unknown>();

/**
 * Remember the error behind an isError tool result so the registration layer
 * can classify it after the handler returned. Returns `result` unchanged.
 */
export function rememberToolError<R extends object>(result: R, error: unknown): R {
  toolErrors.set(result, error);
  return result;
}

/** The error remembered for `result` with {@link rememberToolError}, or undefined. */
export function toolErrorOf(result: object): unknown {
  return toolErrors.get(result);
}

// ---------------------------------------------------------------------------
// Sanitizing helpers
// ---------------------------------------------------------------------------

/** An identifier-like name, or `fallback`. */
function safeName(value: unknown, fallback: string): string {
  return typeof value === "string" && IDENTIFIER.test(value) ? value : fallback;
}

/** The loggable name of a thrown value. */
function nameOf(error: unknown): string {
  if (error instanceof Error) return safeName(error.name, "Error");
  if (error === null) return "null";
  return typeof error;
}

/** The error and its causes, outermost first. */
function causeList(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH && current !== undefined; depth++) {
    chain.push(current);
    current = current instanceof Error ? current.cause : undefined;
  }
  return chain;
}

/**
 * file:line frames from an error stack: the base file name and line only, no
 * directories, function names or columns.
 */
export function stackFramesOf(error: unknown): string[] {
  if (!(error instanceof Error) || typeof error.stack !== "string") return [];
  // The stack starts with "<name>: <message>", and a message can span lines:
  // skip it so message text is never read as a frame.
  let stack = error.stack;
  const header = String(error.message).length > 0 ? `${error.name}: ${error.message}` : error.name;
  if (stack.startsWith(header)) {
    stack = stack.slice(header.length);
  } else {
    const firstFrame = stack.search(/\n\s+at /);
    stack = firstFrame === -1 ? "" : stack.slice(firstFrame);
  }
  const frames: string[] = [];
  for (const line of stack.split("\n")) {
    if (!/^\s+at /.test(line)) continue;
    const match = /([^\s/\\():]+):(\d+):\d+\)?\s*$/.exec(line);
    if (!match) continue;
    const file = match[1] ?? "";
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(file)) continue;
    frames.push(`${file}:${match[2]}`);
    if (frames.length >= MAX_STACK_FRAMES) break;
  }
  return frames;
}

/** Names safe to log (identifier-like), sorted, at most MAX_ARG_KEYS. */
function safeKeys(keys: readonly string[]): string[] {
  return keys
    .filter((key) => IDENTIFIER.test(key))
    .sort()
    .slice(0, MAX_ARG_KEYS);
}

/** Argument names of a tool call safe to log (identifier-like), sorted, at most MAX_ARG_KEYS. */
export function argKeysOf(args: unknown): string[] {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return [];
  return safeKeys(Object.keys(args));
}

/**
 * Contract issues as `path:code`. Path segments that are not identifiers or
 * array indexes (record keys such as dates or ids) become '*'.
 */
export function contractIssuesOf(error: z.ZodError): string[] {
  return error.issues.slice(0, MAX_CONTRACT_ISSUES).map((issue) => {
    const path = issue.path
      .map((segment) =>
        typeof segment === "number"
          ? String(segment)
          : typeof segment === "string" && IDENTIFIER.test(segment)
            ? segment
            : "*"
      )
      .join(".");
    return `${path}:${safeName(issue.code, "unknown")}`;
  });
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** Outcome and level of one recognized error, or null when it is not recognized. */
function classifyOne(error: unknown): Pick<ToolErrorClassification, "outcome" | "level"> | null {
  if (
    error instanceof InvalidDateExpression ||
    error instanceof z.ZodError ||
    error instanceof RangeError
  ) {
    return { outcome: "invalid_input", level: "info" };
  }
  if (error instanceof WhoopApiError) {
    const status = error.statusCode;
    return {
      outcome: "upstream_error",
      level: status === 400 || status === 404 ? "info" : "warn",
    };
  }
  if (
    error instanceof WhoopRateBudgetError ||
    error instanceof WhoopNetworkError ||
    error instanceof WhoopAuthError ||
    error instanceof TokenRefreshError
  ) {
    return { outcome: "upstream_error", level: "warn" };
  }
  return null;
}

/**
 * Classify a tool failure for logging.
 *
 * - info: invalid input (InvalidDateExpression, ZodError, RangeError) and
 *   WHOOP 400/404;
 * - warn: other WHOOP statuses (401/403/429/5xx), network, authentication and
 *   request-budget errors;
 * - error: anything else (internal_error, with file:line stack frames).
 *
 * The first recognized error in the cause chain decides the outcome; the
 * outermost error names the class.
 */
export function classifyToolError(error: unknown): ToolErrorClassification {
  const chain = causeList(error);
  const classification: ToolErrorClassification = {
    outcome: "internal_error",
    level: "error",
    errorClass: nameOf(error),
    causeChain: chain.map(nameOf),
  };

  const recognized = chain.map(classifyOne).find((entry) => entry !== null);
  if (recognized) {
    classification.outcome = recognized.outcome;
    classification.level = recognized.level;
  }

  const api = chain.find((entry): entry is WhoopApiError => entry instanceof WhoopApiError);
  if (api && Number.isInteger(api.statusCode)) classification.httpStatus = api.statusCode;
  const refresh = chain.find(
    (entry): entry is TokenRefreshError => entry instanceof TokenRefreshError
  );
  if (refresh && Number.isInteger(refresh.statusCode)) {
    classification.refreshStatus = refresh.statusCode;
  }

  if (!recognized) {
    const frames = stackFramesOf(error);
    if (frames.length > 0) classification.stackFrames = frames;
  }
  return classification;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/**
 * Log one finished tool call: debug 'tool call ok' for a success, otherwise
 * 'tool call failed' at the classified level. Does nothing without a logger.
 */
export function logToolOutcome(logger: Logger | undefined, event: ToolOutcomeEvent): void {
  if (logger === undefined) return;
  const base: Record<string, unknown> = {
    tool: safeName(event.tool, "unknown"),
    durationMs: Number.isFinite(event.durationMs) ? Math.max(0, Math.round(event.durationMs)) : 0,
    ...(event.requestId !== undefined && /^[A-Za-z0-9-]{1,64}$/.test(event.requestId)
      ? { requestId: event.requestId }
      : {}),
  };

  const failed =
    event.contractError !== undefined ||
    event.outputChars !== undefined ||
    event.error !== undefined ||
    event.result?.isError === true;
  if (!failed) {
    logger.debug("tool call ok", {
      ...base,
      argKeys: safeKeys(event.argKeys),
      privacyMode: event.privacyMode,
    });
    return;
  }

  let classification: ToolErrorClassification;
  const extra: Record<string, unknown> = {};
  if (event.contractError !== undefined) {
    classification = {
      outcome: "contract_violation",
      level: "error",
      errorClass: "ZodError",
      causeChain: ["ZodError"],
    };
    extra.contractIssues = contractIssuesOf(event.contractError);
  } else if (event.outputChars !== undefined) {
    classification = {
      outcome: "output_too_large",
      level: "warn",
      errorClass: "OutputTooLarge",
      causeChain: [],
    };
    extra.chars = event.outputChars;
  } else if (event.error !== undefined) {
    classification = classifyToolError(event.error);
  } else {
    // An isError result whose error was not captured with rememberToolError:
    // the cause is unknown, so it is not reported as a server defect.
    classification = {
      outcome: "internal_error",
      level: "warn",
      errorClass: UNCAPTURED_ERROR_CLASS,
      causeChain: [],
    };
  }

  const { level, ...fields } = classification;
  logger[level]("tool call failed", {
    ...base,
    ...fields,
    ...extra,
    argKeys: safeKeys(event.argKeys),
    privacyMode: event.privacyMode,
  });
}
