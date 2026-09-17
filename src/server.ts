/**
 * MCP server setup and tool registration.
 *
 * Creates an McpServer with the legacy WHOOP tools registered directly below,
 * then every registry tool (src/tools/registry), resources and prompts. Each
 * tool result is validated against its output contract before it is returned.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WhoopClient } from "./api/client.js";
import { describeWhoopError } from "./api/client.js";
import { InvalidDateExpression } from "./tools/date-utils.js";
import { getProfile } from "./tools/get-profile.js";
import { getBodyMeasurement } from "./tools/get-body-measurement.js";
import { getRecoveryCollection } from "./tools/get-recovery.js";
import { getSleepCollection } from "./tools/get-sleep.js";
import { getWorkoutCollection } from "./tools/get-workout.js";
import { getCycleCollection } from "./tools/get-cycle.js";
import { getSleepById } from "./tools/get-sleep-by-id.js";
import { getWorkoutById } from "./tools/get-workout-by-id.js";
import { getCycleById } from "./tools/get-cycle-by-id.js";
import { getWeeklySummary } from "./tools/get-weekly-summary.js";
import { comparePeriods } from "./tools/compare-periods.js";
import { getTrend } from "./tools/get-trend.js";
import { getToday } from "./tools/get-today.js";
import { getCalendar } from "./tools/get-calendar.js";
import { registerResources } from "./resources/index.js";
import { registerPrompts } from "./prompts/index.js";
import { ISO_8601_REGEX } from "./tools/date-utils.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { getBaselines, baselinesInputSchema } from "./tools/get-baselines.js";
import { getSleepDebt, sleepDebtInputSchema } from "./tools/get-sleep-debt.js";
import {
  outputSchemas,
  aggregateOutputSchemas,
  privacyModeSchema,
  projectAggregate,
  type PrivacyMode,
} from "./tools/output-contracts.js";
import type { MemoryCache } from "./cache/memory-cache.js";
import type { Logger } from "./logging/logger.js";
import {
  argKeysOf,
  logToolOutcome,
  rememberToolError,
  toolErrorOf,
} from "./logging/tool-events.js";
import { packageVersion, type RuntimeStatus } from "./runtime-status.js";
import { buildGuideMarkdown, buildServerInstructions } from "./guide.js";
import { ADDITIONAL_TOOLS } from "./tools/registry/index.js";
import { MAX_TOOL_TEXT_CHARS, type ToolContext } from "./tools/tool-definition.js";

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

/** Input schema for string ID lookup (sleep, workout) */
const stringIdSchema = z.object({
  id: z
    .string()
    .regex(
      /^[a-zA-Z0-9_-]+$/,
      "ID must contain only alphanumeric characters, hyphens, and underscores"
    )
    .describe("The record ID to look up."),
});

/** Input schema for numeric ID lookup (cycle) */
const numericIdSchema = z.object({
  id: z.number().int().positive().describe("The record ID to look up."),
});

/** Reusable ISO 8601 date/datetime string with schema-level validation */
const isoDateString = z
  .string()
  .regex(ISO_8601_REGEX, "Expected ISO 8601 date in YYYY-MM-DD or full datetime format.");

/** Input schema shared by all collection endpoints (recovery, sleep, workout, cycle) */
const collectionInputSchema = z.object({
  start: z
    .string()
    .optional()
    .describe(
      'Return records that began at or after this time or were still ongoing at it: WHOOP includes records overlapping the start, such as a cycle or sleep that began the previous evening. A date (YYYY-MM-DD) or relative expression (e.g. "today", "yesterday", "last 7 days", "this week") starts at local midnight of its first day; "last N days" is today plus the N previous days. A date-time may include an offset.'
    ),
  end: z
    .string()
    .optional()
    .describe(
      'Return records that began before this time (exclusive). A date (YYYY-MM-DD) or relative expression ends at the end of its last local day, so start and end "yesterday" (or "last week") cover that whole period. Defaults to now.'
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(25)
    .optional()
    .describe("Max records to return (1-25). Defaults to 10."),
  nextToken: z
    .string()
    .optional()
    .describe(
      "The next_token from a previous response. A null or missing next_token means there are no more pages."
    ),
});

// ---------------------------------------------------------------------------
// JSON response helper
// ---------------------------------------------------------------------------

/** Text plus structuredContent; legacy tools use pretty JSON text, registry tools compact JSON. */
function jsonContent(data: unknown, compact = false): CallToolResult {
  const text = compact ? JSON.stringify(data) : JSON.stringify(data, null, 2);
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: JSON.parse(text) as Record<string, unknown>,
  };
}

// ---------------------------------------------------------------------------
// Error response helper
// ---------------------------------------------------------------------------

/** Format a caught error into an MCP-compatible isError response */
function errorResponse(error: unknown): {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
} {
  // WHOOP client errors are described by type and HTTP status only (never the
  // response body, URL, tokens or health data).
  const whoopMessage = describeWhoopError(error);
  let message: string;

  if (whoopMessage !== undefined) {
    message = whoopMessage;
  } else if (error instanceof InvalidDateExpression) {
    // Describes only the caller's own date input: pass it through, bounded.
    const maxLength = 600;
    // Shorten only long quoted values. A quoted value opens after the start,
    // whitespace or ( = : [ and closes before the end, whitespace or
    // punctuation, so the message text between two quoted values (which starts
    // at a closing quote) is never cut.
    const text = error.message
      .replace(/\p{Cc}+/gu, " ")
      .replace(/(^|[\s(=:[])"([^"]{60})[^"]+"(?=$|[\s.,;:)\]])/g, '$1"$2…"');
    message = text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
  } else if (error instanceof z.ZodError) {
    message = `Invalid input or data (${describeContractIssues(error)}). Check the requested parameters and date range.`;
  } else if (error instanceof RangeError) {
    message = "Invalid input or data. Check the requested parameters and date range.";
  } else {
    message = "An unexpected error occurred. Check configuration and retry.";
  }

  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

/** Maximum contract issues named in an error message */
const MAX_CONTRACT_ISSUES = 5;

/**
 * Summarize output-contract failures by field path and zod's default message
 * (which names types and limits, never input values) so failures can be
 * diagnosed. Custom messages are reduced to their code.
 */
export function describeContractIssues(error: z.ZodError): string {
  const described = error.issues.slice(0, MAX_CONTRACT_ISSUES).map((issue) => {
    const path = issue.path.length ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.code === "custom" ? issue.code : issue.message}`;
  });
  const more = error.issues.length - described.length;
  return more > 0 ? `${described.join("; ")}; +${more} more` : described.join("; ");
}

/** Wrap a tool handler with error-to-MCP-error conversion */
async function safeTool<T>(fn: () => Promise<T>, compact = false): Promise<CallToolResult> {
  try {
    return jsonContent(await fn(), compact);
  } catch (error: unknown) {
    return rememberToolError(errorResponse(error), error);
  }
}

/** The isError result for a registry tool result above MAX_TOOL_TEXT_CHARS. */
function tooLargeResponse(chars: number): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `The result is too large for the MCP client (${chars} characters); request fewer days, a lower limit or fewer datasets.`,
      },
    ],
  };
}

/** Total characters of a result's text content. */
function textLength(result: CallToolResult): number {
  return result.content.reduce(
    (sum, item) => sum + (item.type === "text" ? item.text.length : 0),
    0
  );
}

/** How registerContracted turns a validated result into the tool response. */
interface ContractOptions {
  /** Applied to the validated data before it is returned (aggregate projection). */
  project?: (data: Record<string, unknown>) => Record<string, unknown>;
  /** Compact JSON text instead of pretty JSON. */
  compact?: boolean;
  /** Return an isError result when the text exceeds MAX_TOOL_TEXT_CHARS. */
  sizeGuard?: boolean;
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

/** The request a server instance was created for (HTTP transport), for logging. */
export interface ServerRequestContext {
  requestId: string;
  auth: "static" | "oauth" | "stdio";
  clientId?: string;
}

/** Options for createWhoopServer */
export interface CreateServerOptions {
  privacyMode?: PrivacyMode;
  /** Disable MCP resource registration (set via WHOOP_MCP_DISABLE_RESOURCES=1) */
  disableResources?: boolean;
  /** Process-wide cache for history chunks, shared by registry tools. */
  historyCache?: MemoryCache;
  runtimeStatus?: RuntimeStatus;
  logger?: Logger;
  requestContext?: ServerRequestContext;
  /** The logical current time for registry tools. Default: the system clock. */
  now?: () => Date;
}

/** Return type for the configured MCP server. */
export interface WhoopServer {
  server: McpServer;
}

/**
 * Create a configured MCP server with all WHOOP tools and resources registered.
 *
 * This is a pure factory — it does not start transports, handle OAuth,
 * or read environment variables. Connect the returned server to any
 * transport (stdio, InMemoryTransport, MCP Inspector).
 *
 * @param client - WHOOP API client used by tool handlers
 * @param options - Optional configuration (e.g., disable resources)
 */
export function createWhoopServer(client: WhoopClient, options?: CreateServerOptions): WhoopServer {
  const privacyMode = privacyModeSchema.parse(options?.privacyMode ?? "standard");
  const logger = options?.logger;
  const instructions = buildServerInstructions(privacyMode);
  const server = new McpServer(
    {
      name: "whoop-mcp",
      version: packageVersion(),
    },
    instructions !== undefined ? { instructions } : undefined
  );

  /**
   * Register a tool whose result is validated against `outputSchema` before it
   * is returned. The handler's structuredContent is parsed with the schema; a
   * mismatch becomes an isError result naming the failing fields.
   */
  function registerContracted<Shape extends z.ZodRawShape>(
    name: string,
    config: {
      title?: string;
      description: string;
      inputSchema?: z.ZodObject<Shape>;
      annotations: ToolAnnotations;
    },
    outputSchema: z.ZodObject,
    handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<CallToolResult>,
    contract: ContractOptions = {}
  ): void {
    server.registerTool(
      name,
      { ...config, inputSchema: config.inputSchema ?? z.object({}), outputSchema },
      async (args) => {
        // One log line per call: debug on success, the classified failure
        // otherwise (names, statuses and field paths only; see tool-events).
        const startedAt = performance.now();
        const event = {
          tool: name,
          requestId: options?.requestContext?.requestId,
          argKeys: argKeysOf(args),
          privacyMode,
        };
        const finish = (
          response: CallToolResult,
          failure: { error?: unknown; contractError?: z.ZodError; outputChars?: number } = {}
        ): CallToolResult => {
          logToolOutcome(logger, {
            ...event,
            durationMs: performance.now() - startedAt,
            result: response,
            ...failure,
          });
          return response;
        };
        try {
          const result = await handler(args as z.infer<z.ZodObject<Shape>>);
          if (result.isError) return finish(result, { error: toolErrorOf(result) });
          const validated = outputSchema.safeParse(result.structuredContent);
          if (!validated.success)
            return finish(
              {
                isError: true,
                content: [
                  {
                    type: "text",
                    text: `WHOOP data did not match the expected output contract (${describeContractIssues(validated.error)}).`,
                  },
                ],
              },
              { contractError: validated.error }
            );
          const data = contract.project ? contract.project(validated.data) : validated.data;
          const response = jsonContent(data, contract.compact === true);
          if (contract.sizeGuard === true) {
            const chars = textLength(response);
            if (chars > MAX_TOOL_TEXT_CHARS) {
              return finish(tooLargeResponse(chars), { outputChars: chars });
            }
          }
          return finish(response);
        } catch (error: unknown) {
          logToolOutcome(logger, { ...event, durationMs: performance.now() - startedAt, error });
          throw error;
        }
      }
    );
  }

  /** Register a legacy tool with its contract for the current privacy mode (pretty JSON text). */
  function registerTool<Shape extends z.ZodRawShape>(
    name: string,
    config: { description: string; inputSchema?: z.ZodObject<Shape>; annotations: ToolAnnotations },
    handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<CallToolResult>
  ): void {
    const schema = (privacyMode === "aggregate" ? aggregateOutputSchemas : outputSchemas)[name];
    if (!schema) {
      if (privacyMode === "aggregate") return;
      throw new Error("Missing tool output contract.");
    }
    registerContracted(
      name,
      config,
      schema,
      handler,
      privacyMode === "aggregate" ? { project: (data) => projectAggregate(name, data) } : {}
    );
  }

  /** A fresh context for one registry tool call. */
  function toolContext(): ToolContext {
    return {
      client,
      privacyMode,
      ...(options?.historyCache !== undefined ? { historyCache: options.historyCache } : {}),
      ...(options?.runtimeStatus !== undefined ? { runtime: options.runtimeStatus } : {}),
      ...(logger !== undefined ? { logger } : {}),
      now: options?.now ?? ((): Date => new Date()),
      startedAtMs: Date.now(),
    };
  }

  // -------------------------------------------------------------------------
  // Tool 1: get_profile
  // -------------------------------------------------------------------------
  registerTool(
    "get_profile",
    {
      description: "Get the authenticated user's basic profile — name and email.",
      annotations: { readOnlyHint: true },
    },
    async () => safeTool(() => getProfile(client))
  );

  // -------------------------------------------------------------------------
  // Tool 2: get_body_measurement
  // -------------------------------------------------------------------------
  registerTool(
    "get_body_measurement",
    {
      description: "Get the user's body measurements — height, weight, and max heart rate.",
      annotations: { readOnlyHint: true },
    },
    async () => safeTool(() => getBodyMeasurement(client))
  );

  // -------------------------------------------------------------------------
  // Tool 3: get_recovery_collection
  // -------------------------------------------------------------------------
  registerTool(
    "get_recovery_collection",
    {
      description:
        'Get recovery scores for a date range. Accepts ISO 8601 or relative dates ("today", "last 7 days", "this week"). Returns HRV, resting heart rate, SpO2, and skin temp per recovery. Records are raw WHOOP records, newest first, and can include neighbouring days: each recovery belongs to the morning of its cycle (cycle_id), and cycles begin the previous evening, so a window ending yesterday can still return today\'s recovery first. Check each record rather than taking the first; for one value per local day use get_calendar.',
      inputSchema: collectionInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args: z.infer<typeof collectionInputSchema>) =>
      safeTool(() => getRecoveryCollection(client, args))
  );

  // -------------------------------------------------------------------------
  // Tool 4: get_sleep_collection
  // -------------------------------------------------------------------------
  registerTool(
    "get_sleep_collection",
    {
      description:
        'Get sleep records for a date range. Accepts ISO 8601 or relative dates ("today", "last 7 days", "this week"). Returns sleep stages, duration, respiratory rate, and performance scores. Records are raw WHOOP records, newest first, and include sleeps still ongoing at the window start: a night\'s sleep usually starts the previous evening and belongs to the next morning\'s cycle (cycle_id), so the first record may be last night\'s. Naps are separate records (nap true). Time asleep is light + slow-wave + REM; for per-night values by local day use get_calendar or get_sleep_debt.',
      inputSchema: collectionInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args: z.infer<typeof collectionInputSchema>) =>
      safeTool(() => getSleepCollection(client, args))
  );

  // -------------------------------------------------------------------------
  // Tool 5: get_workout_collection
  // -------------------------------------------------------------------------
  registerTool(
    "get_workout_collection",
    {
      description:
        'Get workout records for a date range. Accepts ISO 8601 or relative dates ("today", "last 7 days", "this week"). Returns strain, heart rate zones, calories (kilojoule), and sport type. score.percent_recorded is a 0-1 fraction (1 = fully recorded); distance and altitude are null for workouts without GPS. Records are raw WHOOP records, newest first, and include workouts still ongoing at the window start. For daily strain by local day use get_calendar.',
      inputSchema: collectionInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args: z.infer<typeof collectionInputSchema>) =>
      safeTool(() => getWorkoutCollection(client, args))
  );

  // -------------------------------------------------------------------------
  // Tool 6: get_cycle_collection
  // -------------------------------------------------------------------------
  registerTool(
    "get_cycle_collection",
    {
      description:
        'Get physiological cycles for a date range. Accepts ISO 8601 or relative dates ("today", "last 7 days", "this week"). Returns strain, calories, and heart rate data per cycle. Records are raw WHOOP records, newest first, and can include neighbouring days: a cycle starts at sleep onset (usually the previous local evening) and covers the next local day, and the in-progress cycle has end null with strain so far. So start and end "yesterday" return yesterday\'s cycle (begun the evening before) plus today\'s in-progress cycle (begun yesterday evening), which comes first. Check start and end rather than taking the first record; for per-day strain use get_calendar.',
      inputSchema: collectionInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args: z.infer<typeof collectionInputSchema>) =>
      safeTool(() => getCycleCollection(client, args))
  );

  // -------------------------------------------------------------------------
  // Tool 7: get_sleep_by_id
  // -------------------------------------------------------------------------
  registerTool(
    "get_sleep_by_id",
    {
      description:
        "Get a single sleep record by its ID. Returns sleep stages, duration, respiratory rate, and performance scores.",
      inputSchema: stringIdSchema,
      annotations: { readOnlyHint: true },
    },
    async (args: z.infer<typeof stringIdSchema>) => safeTool(() => getSleepById(client, args.id))
  );

  // -------------------------------------------------------------------------
  // Tool 8: get_workout_by_id
  // -------------------------------------------------------------------------
  registerTool(
    "get_workout_by_id",
    {
      description:
        "Get a single workout record by its ID. Returns strain, heart rate zones, calories (kilojoule), and sport type. score.percent_recorded is a 0-1 fraction (1 = fully recorded); distance and altitude are null for workouts without GPS.",
      inputSchema: stringIdSchema,
      annotations: { readOnlyHint: true },
    },
    async (args: z.infer<typeof stringIdSchema>) => safeTool(() => getWorkoutById(client, args.id))
  );

  // -------------------------------------------------------------------------
  // Tool 9: get_cycle_by_id
  // -------------------------------------------------------------------------
  registerTool(
    "get_cycle_by_id",
    {
      description:
        "Get a single physiological cycle by its ID. Returns strain, calories, and heart rate data.",
      inputSchema: numericIdSchema,
      annotations: { readOnlyHint: true },
    },
    async (args: z.infer<typeof numericIdSchema>) => safeTool(() => getCycleById(client, args.id))
  );

  // -------------------------------------------------------------------------
  // Tool 10: get_weekly_summary
  // -------------------------------------------------------------------------
  registerTool(
    "get_weekly_summary",
    {
      description:
        privacyMode === "aggregate"
          ? "Summarize one released Monday-to-Sunday week in the user's local time (aggregate privacy mode): average recovery, HRV, resting heart rate, sleep (hours asleep on main sleeps; performance; efficiency), workout count/strain/calories and average daily strain, plus the recovery trend. Windows snap to whole released weeks: a week is released two days after it ends (Wednesday, local time), so the current week, last week before Wednesday and later weeks return only nulls with a note. A week with a record still open or being scored is withheld. Each average needs at least 3 samples in the week (workout totals at least 3 workouts); calibrating recoveries are not used; values are rounded. Days, workouts and cycles are placed as get_calendar places them. sample_sizes gives the counts behind each average."
          : "Summarize one Monday-to-Sunday week in the user's local time: average/min/max recovery, HRV, resting heart rate, sleep (hours asleep on main sleeps, naps excluded; performance; efficiency), workout count/strain/calories and average daily strain, plus the recovery trend. Records are placed on local days as get_calendar shows them; a workout counts on the day of the WHOOP cycle containing its start, so one after midnight before the next sleep counts toward the previous day (a workout without a cycle uses its local start day, noted). Today's in-progress strain and a partial first day of wear are excluded from daily strain. total_strain sums per-workout strain and is not comparable to day strain. Values that cannot be computed yet are null (never 0) and notes say why; workout count/strain/calories are also null for a week with no WHOOP data at all (strap not worn yet, or a week that has not started), while a worn week without workouts gives 0. The recovery trend needs at least 4 scored days. Calibrating recoveries are included and flagged by calibrating=true. sample_sizes gives the counts behind each average; averages are rounded.",
      inputSchema: z.object({
        week_start: z
          .string()
          .optional()
          .describe(
            'Any day in the week to summarize; it is snapped to that local week\'s Monday. Prefer YYYY-MM-DD. Also accepts an ISO date-time (one written as midnight, e.g. 2026-09-14T00:00:00Z, means that date in any timezone; any other date-time means the user\'s local day it falls on), or "today", "yesterday", "this week", "last week". Defaults to the current week.'
          ),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args: { week_start?: string }) =>
      safeTool(() => getWeeklySummary(client, args, undefined, { privacyMode }))
  );

  // -------------------------------------------------------------------------
  // Tool 11: compare_periods
  // -------------------------------------------------------------------------
  registerTool(
    "compare_periods",
    {
      description:
        privacyMode === "aggregate"
          ? 'Compare average recovery, sleep and strain between two periods (up to 90 days each; aggregate privacy mode); change_pct is period B relative to period A in whole percent. Windows snap to released weeks: each period is snapped inward to the whole Monday-to-Sunday local weeks inside it that are released (two days after they end, i.e. from Wednesday local time); period_a/period_b.start and end give the weeks used (null, with a note, when a period contains none), and the periods must not share a week. Each week counts toward a metric only with at least 3 samples, a week with a record still open or being scored is withheld, and calibrating recoveries are not used. Sleep hours are time asleep on main sleeps; strain uses completed cycles. With fewer than 3 samples in either period, change_pct is null and direction is "insufficient_data". Averages are rounded.'
          : 'Compare average recovery, sleep and strain between two non-overlapping periods (up to 90 days each); change_pct is period B relative to period A. Dates are the user\'s local days and each day counts in exactly one period: with date-time bounds a local day counts when most of it lies inside the period (an end at or after now keeps today). period_a/period_b.first_day and last_day give the local days actually counted (null, with a note, when a period covers most of no day). Sleep hours are time asleep (light + deep + REM) on main sleeps, naps excluded; strain uses completed cycles only. With fewer than 3 scored days in either period (e.g. while WHOOP is still calibrating), existing averages are still returned but change_pct is null, direction is "insufficient_data" and notes explain why. training compares workouts per worn day (a local day with a WHOOP cycle; a workout counts on the day of the cycle containing its start): sessions, sessions_per_week, workout_minutes_per_worn_day and trimp_per_worn_day (Edwards TRIMP from WHOOP %max-HR zones), with direction from TRIMP; the means need at least 7 worn days in both periods, and training is null when workouts could not be loaded. warnings report data that could not be loaded or was truncated.',
      inputSchema: z.object({
        period_a_start: isoDateString.describe(
          "Start of the first (baseline) period: YYYY-MM-DD starts at local midnight; a date-time may include an offset."
        ),
        period_a_end: isoDateString.describe(
          "End of the first period: YYYY-MM-DD includes that whole local day; a date-time is exclusive, and a local day counts only when most of it lies before it."
        ),
        period_b_start: isoDateString.describe(
          "Start of the second period, compared against the first: YYYY-MM-DD starts at local midnight; a date-time may include an offset."
        ),
        period_b_end: isoDateString.describe(
          "End of the second period: YYYY-MM-DD includes that whole local day; a date-time is exclusive, and a local day counts only when most of it lies before it (an end at or after now keeps today)."
        ),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args: {
      period_a_start: string;
      period_a_end: string;
      period_b_start: string;
      period_b_end: string;
    }) => safeTool(() => comparePeriods(client, args, undefined, { privacyMode }))
  );

  // -------------------------------------------------------------------------
  // Tool 12: get_trend
  // -------------------------------------------------------------------------
  registerTool(
    "get_trend",
    {
      description:
        privacyMode === "aggregate"
          ? "Analyze one health metric in aggregate privacy mode: sample size, mean, standard deviation and a linear-regression trend (per-day values, dates, extremes and anomalies are not returned). Windows snap to whole released weeks: days is rounded up to 1, 2, 4, 8 or 13 Monday-to-Sunday local weeks ending with the latest released week (a week is released two days after it ends, i.e. from Wednesday local time); period gives the weeks used. A week with a record still open or being scored is withheld, a week counts toward the metric only with at least 3 samples, and calibrating recoveries are not used. Statistics and the trend need at least 4 samples. Values are rounded. Metrics as in standard mode: recovery, hrv, rhr, sleep_duration (hours asleep), sleep_performance, strain (completed cycles), sleep_efficiency, respiratory_rate, rem_share, deep_share, disturbances_per_hour, sleep_consistency, sleep_debt, spo2, skin_temp."
          : "Analyze one health metric over the last N local days (today included): values oldest first with their local dates, statistics, a linear-regression slope per day, and anomalies. trend.change is the raw direction (increasing/decreasing/stable); trend.direction says whether that is improving or declining for this metric (better_when: higher for recovery, HRV, sleep_duration, sleep_performance, sleep_efficiency and sleep_consistency; lower for resting heart rate and sleep_debt; strain, respiratory_rate, rem_share, deep_share, disturbances_per_hour, spo2 and skin_temp have no better direction, so direction is null). Confidence rates how well a sloped line fits the values (R²), capped by sample size (low below 7 points, at most medium below 14). Identical values are stable and rated on sample size alone. A stable trend from values that vary usually has low confidence: no consistent upward or downward direction was found, which does not mean the stability finding is unreliable. With fewer than 4 data points (e.g. while WHOOP is still calibrating) status is insufficient_data, trend fields are null, anomalies are empty and notes say why; statistics are still given for the data that exists. sleep_duration is hours asleep on main sleeps (naps excluded); strain uses completed cycles only. rem_share and deep_share are % of time asleep; disturbances_per_hour skips nights under 1 hour asleep; sleep_consistency skips WHOOP's 0 while calibrating; sleep_debt is WHOOP's sleep-debt need in hours; spo2 and skin_temp come from recoveries and are reported only by WHOOP 4.0 or later. sleep_efficiency, rem_share, deep_share, disturbances_per_hour and sleep_debt skip nights with low data coverage (counted in notes).",
      inputSchema: z.object({
        metric: z
          .enum([
            "recovery",
            "hrv",
            "rhr",
            "sleep_duration",
            "sleep_performance",
            "strain",
            "sleep_efficiency",
            "respiratory_rate",
            "rem_share",
            "deep_share",
            "disturbances_per_hour",
            "sleep_consistency",
            "sleep_debt",
            "spo2",
            "skin_temp",
          ])
          .describe("The health metric to analyze."),
        days: z
          .number()
          .int()
          .min(7)
          .max(90)
          .optional()
          .describe(
            privacyMode === "aggregate"
              ? "Number of local calendar days to cover (7–90), rounded up to 1, 2, 4, 8 or 13 whole released weeks. Default: 30."
              : "Number of local calendar days to analyze, today included (7–90). Default: 30."
          ),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args) => safeTool(() => getTrend(client, args, undefined, { privacyMode }))
  );

  // -------------------------------------------------------------------------
  // Tool 13: get_today
  // -------------------------------------------------------------------------
  registerTool(
    "get_today",
    {
      description:
        "Get today's complete health snapshot — recovery score, last night's sleep, current strain, and last workout in one call. " +
        "Today is the current WHOOP cycle, which starts at last night's sleep onset and stays open until WHOOP processes the next sleep (it can run longer than a day); sleep and recovery are the ones linked to that cycle. " +
        "If no newer sleep has been processed yet (wake-up not synced, or no sleep detected), the most recent sleep and recovery are still returned with status stale in data_quality.sources and a note giving their date: do not present them as last night's. A cycle WHOOP has not updated for a day is shown with cycle status stale and a possibly-not-synced note. " +
        "Sleep hours are time asleep (time_in_bed_hours is separate); sleep also gives disturbances, sleep_cycles, no_data_hours, consistency_pct (null while WHOOP is still calibrating and reports 0) and need_hours_including_debt (WHOOP's sleep need). recovery.user_calibrating=true means WHOOP is still learning the user's baselines and the score is provisional; recovery.zone is WHOOP's green/yellow/red band. " +
        "A section is null when its data is not available yet or could not be fetched; `notes` explains why in plain language and data_quality.sources gives each source's status, fetch time and cache status. data_quality periods are local times with their UTC offset.",
      annotations: { readOnlyHint: true },
    },
    async () => safeTool(() => getToday(client))
  );

  // -------------------------------------------------------------------------
  // Tool 14: get_calendar
  // -------------------------------------------------------------------------
  registerTool(
    "get_calendar",
    {
      description:
        "Get a day-by-day grid of recovery, sleep, and strain over the user's local days. Perfect for weekly/monthly overviews. Each row shows the WHOOP cycle covering that day: the recovery and main sleep from that morning (sleep_hours = time asleep, naps excluded) and that cycle's strain. Today's strain is still accumulating (day_strain_in_progress) and is left out of averages.strain. A new cycle starts only at the next sleep, so between local midnight and the next synced sleep today's row is empty and its strain is still added to the previous day's open cycle (a note says so). The first day WHOOP was worn has partial strain (day_strain_partial), also left out of averages.strain. If two cycles belong to one day (e.g. a second main sleep), the row keeps the better main sleep and a warning names the other. Calibrating recoveries are shown with recovery_calibrating: true. Missing or unscored data is null and explained in notes; averages cover only days with data (see sample_sizes). warnings report streams that failed to load or hit the record limit (truncated).",
      inputSchema: z.object({
        days: z
          .number()
          .int()
          .min(1)
          .max(90)
          .optional()
          .describe("Number of days to show. Default: 7. Max: 90."),
        start: z
          .string()
          .optional()
          .describe(
            'Where the grid starts. A range expression ("last 14 days" = today plus the previous 14 days, "this week", "this month", "last week", "YYYY-MM") shows that whole range, ending no later than today (at most its last 90 days); if `days` is also given, the grid is the range\'s first day plus `days` days instead. A single day (YYYY-MM-DD, "today", "yesterday") or a date-time (counted from its nearest local midnight) is the first day, and the grid runs forward `days` days (default 7), clamped to today. Without start, the grid ends today and runs back `days` days.'
          ),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args: { days?: number; start?: string }) => safeTool(() => getCalendar(client, args))
  );

  // -------------------------------------------------------------------------
  // Tools 15-16: get_baselines, get_sleep_debt
  // -------------------------------------------------------------------------
  registerTool(
    "get_baselines",
    {
      description:
        privacyMode === "aggregate"
          ? "Personal distributions (aggregate privacy mode) for HRV, RHR, respiratory rate, sleep hours (asleep time), recovery, SpO2, skin temperature, sleep efficiency, disturbances per hour, REM share and deep sleep share: sample size, mean, median, standard deviation and p25-p75 (no latest observation, no p10/p90); not medical advice. Windows snap to whole released weeks: baseline_days is rounded up to 2, 4, 8, 13 or 26 Monday-to-Sunday local weeks ending with the latest released week (released two days after it ends); `period` gives the weeks used. Each week counts toward a metric only with at least 3 samples; calibrating recoveries and nights with low data coverage (for the newer sleep metrics) are not used; values are rounded. Each baseline needs 14 samples: until then metric_status says 'calibrating', 'insufficient_data', 'not_reported' (WHOOP reported no value, e.g. SpO2 before WHOOP 4.0) or 'unavailable', with a reason in `notes`."
          : "Personal rolling distributions for HRV, RHR, respiratory rate, sleep hours (asleep time), recovery, SpO2, skin temperature, sleep efficiency, disturbances per hour, REM share and deep sleep share (% of time asleep). Excludes the latest observation and today from baselines, so it reads baseline_days + 2 days of history; not medical advice. `period` gives the local days the baselines cover. Recoveries WHOOP flags as calibrating are not used; nights with low data coverage are not used for sleep efficiency, disturbances per hour, REM share and deep sleep share. Each baseline needs 14 earlier data points: until then metric_status says 'calibrating' (WHOOP still calibrating), 'insufficient_data', 'not_reported' (WHOOP reported no value on any scored record, e.g. SpO2 and skin temperature need WHOOP 4.0 or later) or 'unavailable' (data could not be read), with a reason and counts in `notes`.",
      inputSchema: baselinesInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => safeTool(() => getBaselines(client, args, undefined, { privacyMode }))
  );
  registerTool(
    "get_sleep_debt",
    {
      description:
        privacyMode === "aggregate"
          ? "Observed nightly sleep deficits and local clock consistency (aggregate privacy mode; no per-night data, standing debt or summary). Windows snap to whole released weeks: `days` (default 14) is rounded up to 2, 4, 8 or 12 Monday-to-Sunday local weeks ending with the latest released week (released two days after it ends), and `start` is ignored; `period` gives the weeks used. Each week counts only with at least 3 scored main sleeps, and a week with a record still open or being scored is withheld. Deficit sum is not outstanding debt or a recovery prediction. Totals and consistency need 3 scored main sleeps (nights_required); with fewer, status is 'insufficient_data'. status 'unavailable' means the data could not be read completely. Values are rounded; `notes` explains every case."
          : "Observed nightly sleep deficits, standing debt and local clock consistency. A range expression in `start` (e.g. \"last week\", \"this month\") covers that whole range unless `days` is also given; `period` is written in the user's UTC offset. Deficit sum is not outstanding debt or a recovery prediction. Totals and consistency need 3 scored main sleeps (nights_required); with fewer, status is 'insufficient_data' and the nights that exist are still listed. status 'unavailable' means the sleep data could not be read. `notes` explains either case.",
      inputSchema: sleepDebtInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => safeTool(() => getSleepDebt(client, args, undefined, { privacyMode }))
  );

  // -------------------------------------------------------------------------
  // Registry tools: the standard variant, or in aggregate mode the aggregate
  // variant when the tool has one. Compact JSON text within MAX_TOOL_TEXT_CHARS.
  // -------------------------------------------------------------------------
  for (const definition of ADDITIONAL_TOOLS) {
    const variant = privacyMode === "aggregate" ? definition.aggregate : definition.standard;
    if (variant === undefined) continue;
    registerContracted(
      definition.name,
      {
        title: variant.title,
        description: variant.description,
        inputSchema: variant.inputSchema,
        annotations: definition.annotations,
      },
      variant.outputSchema,
      async (args) => safeTool(() => variant.run(args, toolContext()), true),
      { compact: true, sizeGuard: true }
    );
  }

  // -------------------------------------------------------------------------
  // MCP Resources
  // -------------------------------------------------------------------------
  if (!options?.disableResources && privacyMode === "standard") {
    registerResources(server, client, logger !== undefined ? { logger } : {});
  }

  // -------------------------------------------------------------------------
  // MCP Prompts (aggregate mode: aggregate_overview only)
  // -------------------------------------------------------------------------
  registerPrompts(server, { privacyMode });

  // -------------------------------------------------------------------------
  // Server guide resource (both modes, unless resources are disabled)
  // -------------------------------------------------------------------------
  const guide = options?.disableResources ? null : buildGuideMarkdown(privacyMode);
  if (guide !== null) {
    server.registerResource(
      "Server Guide",
      "whoop://server/guide",
      {
        description:
          "How to use this server: which tool answers which question, how WHOOP cycles map to local days, how missing and calibrating data is reported, privacy modes, rate limits and history loading, and what the WHOOP API does not provide.",
        mimeType: "text/markdown",
      },
      async (uri: URL) => ({
        contents: [{ uri: uri.href, mimeType: "text/markdown", text: guide }],
      })
    );
  }

  return { server };
}
