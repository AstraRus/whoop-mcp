/**
 * MCP server setup and tool registration.
 *
 * Creates an McpServer with all 6 WHOOP tools registered.
 * Each tool handler calls the WHOOP API via the provided WhoopClient.
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
import { readFileSync } from "node:fs";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { getBaselines, baselinesInputSchema } from "./tools/get-baselines.js";
import { getSleepDebt, sleepDebtInputSchema } from "./tools/get-sleep-debt.js";
import {
  outputSchemas,
  aggregateOutputSchemas,
  privacyModeSchema,
  projectAggregateDates,
  type PrivacyMode,
} from "./tools/output-contracts.js";

// ---------------------------------------------------------------------------
// Package version
// ---------------------------------------------------------------------------

/** Read the version from package.json at startup */
function getPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as {
      version: string;
    };
    return pkg.version;
  } catch {
    return "0.0.0";
  }
}

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
      'Return records that occurred at or after this time. A date (YYYY-MM-DD) or relative expression (e.g. "today", "yesterday", "last 7 days", "this week") starts at local midnight; a date-time may include an offset.'
    ),
  end: z
    .string()
    .optional()
    .describe(
      "Return records before this time. A date (YYYY-MM-DD) or relative expression includes that whole local day. Defaults to now."
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

function jsonContent(data: unknown): CallToolResult {
  const text = JSON.stringify(data, null, 2);
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
    const text = error.message.replace(/\p{Cc}+/gu, " ").replace(/"([^"]{60})[^"]+"/g, '"$1…"');
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
async function safeTool<T>(fn: () => Promise<T>): Promise<CallToolResult> {
  try {
    return jsonContent(await fn());
  } catch (error: unknown) {
    return errorResponse(error);
  }
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

/** Options for createWhoopServer */
export interface CreateServerOptions {
  privacyMode?: PrivacyMode;
  /** Disable MCP resource registration (set via WHOOP_MCP_DISABLE_RESOURCES=1) */
  disableResources?: boolean;
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
  const server = new McpServer({
    name: "whoop-mcp",
    version: getPackageVersion(),
  });

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
    server.registerTool(
      name,
      { ...config, inputSchema: config.inputSchema ?? z.object({}), outputSchema: schema },
      async (args) => {
        const result = await handler(args as z.infer<z.ZodObject<Shape>>);
        if (result.isError) return result;
        const validated = schema.safeParse(result.structuredContent);
        if (!validated.success)
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `WHOOP data did not match the expected output contract (${describeContractIssues(validated.error)}).`,
              },
            ],
          };
        return jsonContent(
          privacyMode === "aggregate" ? projectAggregateDates(validated.data) : validated.data
        );
      }
    );
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
        'Get recovery scores for a date range. Accepts ISO 8601 or relative dates ("today", "last 7 days", "this week"). Returns HRV, resting heart rate, SpO2, and skin temp for each day.',
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
        'Get sleep records for a date range. Accepts ISO 8601 or relative dates ("today", "last 7 days", "this week"). Returns sleep stages, duration, respiratory rate, and performance scores.',
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
        'Get workout records for a date range. Accepts ISO 8601 or relative dates ("today", "last 7 days", "this week"). Returns strain, heart rate zones, calories (kilojoule), and sport type. score.percent_recorded is a 0-1 fraction (1 = fully recorded); distance and altitude are null for workouts without GPS.',
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
        'Get physiological cycles for a date range. Accepts ISO 8601 or relative dates ("today", "last 7 days", "this week"). Returns strain, calories, and heart rate data per cycle.',
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
        "Summarize one Monday-to-Sunday week in the user's local time: average/min/max recovery, HRV, resting heart rate, sleep (hours asleep on main sleeps, naps excluded; performance; efficiency), workout count/strain/calories and average daily strain, plus the recovery trend. Each record counts in exactly one week by its local day; today's in-progress strain is excluded. Values that cannot be computed yet are null (never 0) and notes say why; the recovery trend needs at least 4 scored days. Calibrating recoveries are included and flagged by calibrating=true. sample_sizes gives the counts behind each average.",
      inputSchema: z.object({
        week_start: z
          .string()
          .optional()
          .describe(
            'Any day in the week to summarize; it is snapped to that local week\'s Monday. Accepts YYYY-MM-DD, an ISO date-time, or "today", "yesterday", "this week", "last week". Defaults to the current week.'
          ),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args: { week_start?: string }) => safeTool(() => getWeeklySummary(client, args))
  );

  // -------------------------------------------------------------------------
  // Tool 11: compare_periods
  // -------------------------------------------------------------------------
  registerTool(
    "compare_periods",
    {
      description:
        'Compare average recovery, sleep and strain between two non-overlapping periods (up to 90 days each); change_pct is period B relative to period A. Dates are the user\'s local days and each day counts in exactly one period. Sleep hours are time asleep (light + deep + REM) on main sleeps, naps excluded; strain uses completed cycles only. With fewer than 3 scored days in either period (e.g. while WHOOP is still calibrating), existing averages are still returned but change_pct is null, direction is "insufficient_data" and notes explain why; warnings report data that could not be loaded or was truncated.',
      inputSchema: z.object({
        period_a_start: isoDateString.describe(
          "Start of the first (baseline) period: YYYY-MM-DD starts at local midnight; a date-time may include an offset."
        ),
        period_a_end: isoDateString.describe(
          "End of the first period: YYYY-MM-DD includes that whole local day; a date-time is exclusive."
        ),
        period_b_start: isoDateString.describe(
          "Start of the second period, compared against the first: YYYY-MM-DD starts at local midnight."
        ),
        period_b_end: isoDateString.describe(
          "End of the second period: YYYY-MM-DD includes that whole local day; a date-time is exclusive."
        ),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args: {
      period_a_start: string;
      period_a_end: string;
      period_b_start: string;
      period_b_end: string;
    }) => safeTool(() => comparePeriods(client, args))
  );

  // -------------------------------------------------------------------------
  // Tool 12: get_trend
  // -------------------------------------------------------------------------
  registerTool(
    "get_trend",
    {
      description:
        "Analyze one health metric over the last N local days (today included): values oldest first with their local dates, statistics, a linear-regression slope per day, and anomalies. trend.change is the raw direction (increasing/decreasing/stable); trend.direction says whether that is improving or declining for this metric (better_when: higher for recovery, HRV and sleep; lower for resting heart rate; strain has no better direction, so direction is null). Confidence reflects fit and sample size (low below 7 points, at most medium below 14). With fewer than 4 data points (e.g. while WHOOP is still calibrating) status is insufficient_data, trend fields are null, anomalies are empty and notes say why; statistics are still given for the data that exists. sleep_duration is hours asleep on main sleeps (naps excluded); strain uses completed cycles only.",
      inputSchema: z.object({
        metric: z
          .enum(["recovery", "hrv", "rhr", "sleep_duration", "sleep_performance", "strain"])
          .describe("The health metric to analyze."),
        days: z
          .number()
          .int()
          .min(7)
          .max(90)
          .optional()
          .describe(
            "Number of local calendar days to analyze, today included (7–90). Default: 30."
          ),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args: {
      metric: "recovery" | "hrv" | "rhr" | "sleep_duration" | "sleep_performance" | "strain";
      days?: number;
    }) => safeTool(() => getTrend(client, args))
  );

  // -------------------------------------------------------------------------
  // Tool 13: get_today
  // -------------------------------------------------------------------------
  registerTool(
    "get_today",
    {
      description:
        "Get today's complete health snapshot — recovery score, last night's sleep, current strain, and last workout in one call. " +
        "Today is the current WHOOP cycle, which starts at last night's sleep onset; sleep and recovery are the ones linked to that cycle. " +
        "Sleep hours are time asleep (time_in_bed_hours is separate). recovery.user_calibrating=true means WHOOP is still learning the user's baselines and the score is provisional. " +
        "A section is null when its data is not available yet or could not be fetched; `notes` explains why in plain language and data_quality.sources gives each source's status.",
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
        "Get a day-by-day grid of recovery, sleep, and strain over the user's local days. Perfect for weekly/monthly overviews. Each row shows the WHOOP cycle covering that day: the recovery and main sleep from that morning (sleep_hours = time asleep, naps excluded) and that cycle's strain. Today's strain is still accumulating (day_strain_in_progress) and is left out of averages.strain. Calibrating recoveries are shown with recovery_calibrating: true. Missing or unscored data is null and explained in notes; averages cover only days with data (see sample_sizes). warnings report streams that failed to load or hit the record limit (truncated).",
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
            'First day of the grid: a local date (YYYY-MM-DD), a date-time, or a relative expression (e.g. "yesterday", "last 14 days", "this week"). The grid then runs forward for `days` days, clamped to today. Without start, the grid ends today and runs backward.'
          ),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args: { days?: number; start?: string }) => safeTool(() => getCalendar(client, args))
  );

  // -------------------------------------------------------------------------
  // MCP Resources
  // -------------------------------------------------------------------------
  registerTool(
    "get_baselines",
    {
      description:
        "Personal rolling distributions for HRV, RHR, respiratory rate, sleep hours (asleep time) and recovery. Excludes latest observations from baselines; not medical advice. Each baseline needs 14 earlier data points: until then metric_status says 'calibrating' (WHOOP still calibrating), 'insufficient_data' or 'unavailable' (data could not be read), with a reason and counts in `notes`.",
      inputSchema: baselinesInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => safeTool(() => getBaselines(client, args))
  );
  registerTool(
    "get_sleep_debt",
    {
      description:
        "Observed nightly sleep deficits, standing debt and local clock consistency. Deficit sum is not outstanding debt or a recovery prediction. Totals and consistency need 3 scored main sleeps (nights_required); with fewer, status is 'insufficient_data' and the nights that exist are still listed. status 'unavailable' means the sleep data could not be read. `notes` explains either case.",
      inputSchema: sleepDebtInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => safeTool(() => getSleepDebt(client, args))
  );

  if (!options?.disableResources && privacyMode === "standard") {
    registerResources(server, client);
  }

  // -------------------------------------------------------------------------
  // MCP Prompts
  // -------------------------------------------------------------------------
  if (privacyMode === "standard") registerPrompts(server);

  return { server };
}
