/**
 * Platform prompts: export_my_data and data_status_check (standard mode) and
 * aggregate_overview, the only prompt in aggregate privacy mode.
 *
 * Numeric arguments are clamped and the format is allowlisted before either is
 * written into a message.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PromptKit } from "./index.js";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/** Days exported by export_my_data without `days` */
export const DEFAULT_EXPORT_DAYS = 30;

/** Most days export_health_data exports in one call */
export const MAX_EXPORT_DAYS = 180;

/** Formats export_health_data accepts */
export const EXPORT_FORMATS = ["csv", "json"] as const;

/** An export format. */
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** Released weeks covered by aggregate_overview without `weeks` */
export const DEFAULT_OVERVIEW_WEEKS = 4;

/** Fewest weeks aggregate_overview covers */
export const MIN_OVERVIEW_WEEKS = 2;

/** Most weeks aggregate_overview covers */
export const MAX_OVERVIEW_WEEKS = 13;

/** Largest get_trend `days` */
const MAX_TREND_DAYS = 90;

/** Fewest weeks the aggregate get_training_load lists */
const MIN_LOAD_WEEKS = 4;

/** Metrics aggregate_overview trends */
const OVERVIEW_TREND_METRICS = ["recovery", "hrv", "sleep_duration", "strain"] as const;

/**
 * A whole number in `value` clamped to [min, max], or `fallback` when `value`
 * is not a plain non-negative integer.
 */
function clampedInteger(
  value: string | undefined,
  min: number,
  max: number,
  fallback: number
): number {
  const trimmed = value?.trim() ?? "";
  if (!/^\d{1,6}$/.test(trimmed)) return fallback;
  return Math.min(max, Math.max(min, Number(trimmed)));
}

/** export_my_data `days`: 1-180 (clamped), default 30. */
export function parseExportDays(value: string | undefined): number {
  return clampedInteger(value, 1, MAX_EXPORT_DAYS, DEFAULT_EXPORT_DAYS);
}

/** export_my_data `format`: csv or json, default csv. */
export function parseExportFormat(value: string | undefined): ExportFormat {
  const trimmed = value?.trim().toLowerCase() ?? "";
  return (EXPORT_FORMATS as readonly string[]).includes(trimmed)
    ? (trimmed as ExportFormat)
    : "csv";
}

/** aggregate_overview `weeks`: 2-13 (clamped), default 4. */
export function parseOverviewWeeks(value: string | undefined): number {
  return clampedInteger(value, MIN_OVERVIEW_WEEKS, MAX_OVERVIEW_WEEKS, DEFAULT_OVERVIEW_WEEKS);
}

// ---------------------------------------------------------------------------
// Standard mode
// ---------------------------------------------------------------------------

/** export_my_data and data_status_check. */
export function registerPlatformPrompts(server: McpServer, kit: PromptKit): void {
  server.registerPrompt(
    "export_my_data",
    {
      description:
        "Export WHOOP daily and workout rows as CSV or JSON for the last N local days, with the period, row counts and any cap or truncation stated.",
      argsSchema: {
        days: z
          .string()
          .optional()
          .describe(
            `Local days to export, today included, 1-${MAX_EXPORT_DAYS} (default: ${DEFAULT_EXPORT_DAYS})`
          ),
        format: z.string().optional().describe('"csv" (default) or "json"'),
      },
    },
    (args) => {
      const days = parseExportDays(args.days);
      const format = parseExportFormat(args.format);
      const start = kit.lastDaysExpression(days);
      return kit.message(
        `Export my WHOOP data for the last ${days} ${days === 1 ? "day" : "days"} as ${format.toUpperCase()}. ` +
          `Use the following tool:\n\n` +
          `1. **export_health_data** with start "${start}" and format "${format}" — Daily rows and workout rows for the last ${days} local ${days === 1 ? "day" : "days"}, today included\n\n` +
          `Then tell me:\n` +
          `- The period exported (period.start to period.end) and the row count of each dataset\n` +
          `- Whether output_capped is true: the export keeps the newest days within 60,000 characters, and first_included_day and the notes give where to start the next export for the older days\n` +
          `- Whether truncated is true or warnings report data that could not be loaded, and for which days\n` +
          `- That empty cells are unknown values, not zero, and that energy covers whole WHOOP cycles (sleep onset to sleep onset)\n\n` +
          `Show the exported ${format === "csv" ? "CSV text of each dataset" : "rows"} unchanged, without recomputing or rounding any value.`,
        ["data"]
      );
    }
  );

  server.registerPrompt(
    "data_status_check",
    {
      description:
        "Check whether WHOOP data is up to date and explain in plain language why today's data may be missing.",
    },
    () =>
      kit.message(
        `Check whether my WHOOP data is up to date. ` +
          `Use the following tool:\n\n` +
          `1. **get_sync_status** — The assessment, the state and local times of the newest cycle, main sleep, recovery and workout, the account's history and the server status\n\n` +
          `Then explain in plain language:\n` +
          `- What the assessment means: up_to_date; sleep_not_processed_yet (WHOOP has not processed the latest sleep into a new cycle yet); strap_not_synced (WHOOP has not updated the newest cycle for 24 hours); no_data_yet; or unavailable, with the reason from notes\n` +
          `- Whether the latest sleep and recovery belong to the current cycle, and how long ago the newest records ended or were updated\n` +
          `- For an account with little history, the first cycle date and the days with data, and that recoveries stay provisional while WHOOP is calibrating\n` +
          `- Server details (WHOOP sign-in refresh outcome, rate-limited responses) only if they point to a problem`,
        ["data"]
      )
  );
}

// ---------------------------------------------------------------------------
// Aggregate mode
// ---------------------------------------------------------------------------

/** aggregate_overview, the only aggregate-mode prompt. */
export function registerAggregatePrompts(server: McpServer, kit: PromptKit): void {
  server.registerPrompt(
    "aggregate_overview",
    {
      description:
        "Overview of the latest released weeks in aggregate privacy mode: the latest released week, trends, the last two released weeks compared and weekly training load.",
      argsSchema: {
        weeks: z
          .string()
          .optional()
          .describe(
            `Released weeks to cover, ${MIN_OVERVIEW_WEEKS}-${MAX_OVERVIEW_WEEKS} (default: ${DEFAULT_OVERVIEW_WEEKS})`
          ),
      },
    },
    (args) => {
      const weeks = parseOverviewWeeks(args.weeks);
      const trendDays = Math.min(weeks * 7, MAX_TREND_DAYS);
      const loadWeeks = Math.max(weeks, MIN_LOAD_WEEKS);
      const [firstMetric, ...otherMetrics] = OVERVIEW_TREND_METRICS;
      const others = otherMetrics.map((metric) => `"${metric}"`);
      const repeatWith = `${others.slice(0, -1).join(", ")} and ${others[others.length - 1]}`;
      return kit.message(
        `Give me an overview of my WHOOP data over the last ${weeks} released weeks. ` +
          `Use the following tools:\n\n` +
          `1. **get_sync_status** — released_weeks.latest_week_start is the Monday of the latest released week\n` +
          `2. **get_weekly_summary** with week_start set to that Monday — Averages and totals for the latest released week\n` +
          `3. **get_trend** with metric "${firstMetric}" and days ${trendDays} — Mean, spread and trend over released weeks (days is rounded up to 1, 2, 4, 8 or 13 weeks; period gives the weeks used); repeat with metric ${repeatWith}\n` +
          `4. **compare_periods** with period_a from the Monday 7 days before that Monday to the Sunday before it, and period_b from that Monday to the Sunday 6 days after it — The last 2 released weeks side by side\n` +
          `5. **get_training_load** with weeks ${loadWeeks} — Weekly sessions, workout minutes, TRIMP, energy and mean day strain over released weeks\n\n` +
          `Report:\n` +
          `- The weeks each result covers\n` +
          `- Averages, trends and changes with their sample sizes, and the training load by week\n` +
          `- Which values are null because a week is not released, is withheld or has fewer than 3 samples, as the notes say`,
        ["aggregate"]
      );
    }
  );
}
