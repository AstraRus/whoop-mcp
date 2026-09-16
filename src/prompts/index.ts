/**
 * MCP Prompts — pre-built conversation starters for health queries.
 *
 * Provides 5 prompts that guide users toward the most valuable health
 * conversations. Prompts are static message templates that reference
 * tools and resources for the AI client to resolve.
 *
 * Every prompt steers toward the tools that already join and group WHOOP
 * records per local day (get_calendar, get_weekly_summary, get_baselines,
 * get_sleep_debt, get_today) and carries the same data-reading guidance, so
 * sparse or calibrating data is reported as such rather than guessed at.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PrivacyMode } from "../privacy.js";

// ---------------------------------------------------------------------------
// Shared text
// ---------------------------------------------------------------------------

/** Default number of days reviewed by weekly_health_review */
export const DEFAULT_REVIEW_DAYS = 7;

/** Largest review window the date tools accept */
export const MAX_REVIEW_DAYS = 90;

/** Guidance appended to every prompt on how to read WHOOP data honestly. */
export const DATA_GUIDANCE =
  `How to read the data:\n` +
  `- If a value is null, or a tool returns warnings, notes or data-quality details (for example "not enough data" while WHOOP is still calibrating in the first days of wear), say so plainly. Never treat a missing value as 0 and don't fill gaps with guesses.\n` +
  `- Recoveries with user_calibrating = true are provisional; say so whenever you use one.\n` +
  `- Don't describe a trend that rests on fewer than 4 data points; report the individual values instead.\n` +
  `- Sleep hours mean time asleep (light + slow-wave + REM) from main sleeps. Naps and time in bed are separate figures; label them if you use them.\n` +
  `- Collection tools (get_*_collection) return records newest first, at most 25 per call (default 10). They also include records that were still ongoing at the window start, such as the cycle and sleep that began the evening before, so check each record's start before assigning it to a day. Keep calling with next_token until it is null, and if a tool reports truncated results, say which period is missing.\n` +
  `- State which days the numbers cover, and don't give medical diagnoses.`;

/**
 * Parse the free-text `days` prompt argument into a whole number of days
 * between 1 and {@link MAX_REVIEW_DAYS}; anything else falls back to the default.
 */
export function parseReviewDays(value: string | undefined): number {
  const trimmed = value?.trim() ?? "";
  if (!/^\d{1,4}$/.test(trimmed)) {
    return DEFAULT_REVIEW_DAYS;
  }
  const days = Number(trimmed);
  if (days < 1) {
    return DEFAULT_REVIEW_DAYS;
  }
  return Math.min(days, MAX_REVIEW_DAYS);
}

/**
 * A collection-tool `start` expression covering exactly `days` local days, today
 * included, so collection results line up with get_calendar / get_trend `days`.
 * "last N days" means today plus the N previous days (N + 1 days), so N = days - 1;
 * a single day is "today" ("last 0 days" is not a valid expression).
 */
export function lastDaysExpression(days: number): string {
  return days <= 1 ? "today" : `last ${days - 1} days`;
}

/** Day window shared by sleep_analysis, recovery_trend and workout_recap */
export const RECENT_DAYS = 14;

function userMessage(text: string): {
  messages: Array<{ role: "user"; content: { type: "text"; text: string } }>;
} {
  return {
    messages: [
      {
        role: "user" as const,
        content: { type: "text" as const, text: `${text}\n\n${DATA_GUIDANCE}` },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Prompt definitions
// ---------------------------------------------------------------------------

/** Options for {@link registerPrompts}. */
export interface RegisterPromptsOptions {
  privacyMode: PrivacyMode;
}

/**
 * Register all MCP prompts on the server. Aggregate mode has no prompts.
 */
export function registerPrompts(
  server: McpServer,
  options: RegisterPromptsOptions = { privacyMode: "standard" }
): void {
  if (options.privacyMode !== "standard") return;

  // -------------------------------------------------------------------------
  // Prompt 1: weekly_health_review
  // -------------------------------------------------------------------------
  server.registerPrompt(
    "weekly_health_review",
    {
      description:
        "Comprehensive review of recovery, sleep, and workouts from a specified number of days. Provides insights into overall health trends.",
      argsSchema: {
        days: z
          .string()
          .optional()
          .describe(`Number of days to review, 1-${MAX_REVIEW_DAYS} (default: 7)`),
      },
    },
    (args) => {
      const days = parseReviewDays(args.days);
      return userMessage(
        `Please provide a comprehensive health review for the past ${days} days. ` +
          `Use the following tools to gather data:\n\n` +
          `1. **get_calendar** with days ${days} — Day-by-day recovery, sleep and strain for the period\n` +
          `2. **get_weekly_summary** — Averages for recovery, HRV, resting heart rate, sleep and workouts over the current Monday-to-Sunday week (pass week_start for an earlier week); these are calendar weeks, so say so when they don't match the ${days}-day period\n` +
          `3. **get_baselines** — The user's personal ranges, to put the period in context\n` +
          `4. **get_workout_collection** with start "${lastDaysExpression(days)}" — Workouts (strain, sport type, calories) for the same ${days} days\n` +
          `5. **get_recovery_collection** / **get_sleep_collection** with start "${lastDaysExpression(days)}" — Record-level detail, only if needed\n\n` +
          `Analyze the data and provide:\n` +
          `- Overall recovery direction (improving, declining, stable), or why there is not enough data yet to tell\n` +
          `- Sleep quality assessment and patterns\n` +
          `- Training load and strain summary\n` +
          `- Actionable recommendations based on the data`
      );
    }
  );

  // -------------------------------------------------------------------------
  // Prompt 2: sleep_analysis
  // -------------------------------------------------------------------------
  server.registerPrompt(
    "sleep_analysis",
    {
      description:
        "Analyze recent sleep patterns and quality — identifies trends in duration, performance, and efficiency.",
    },
    () =>
      userMessage(
        `Analyze my recent sleep patterns and quality. ` +
          `Use the following tools:\n\n` +
          `1. **get_sleep_debt** with days ${RECENT_DAYS} — Nightly time asleep against need, and bedtime consistency\n` +
          `2. **get_calendar** with days ${RECENT_DAYS} — Each night's sleep next to recovery and strain\n` +
          `3. **get_trend** with metric "sleep_duration" and days ${RECENT_DAYS} — Sleep duration direction\n` +
          `4. **get_trend** with metric "sleep_performance" and days ${RECENT_DAYS} — Sleep performance direction\n` +
          `5. **get_sleep_collection** with start "${lastDaysExpression(RECENT_DAYS)}" — Stage-level detail for the same ${RECENT_DAYS} days, only if needed\n\n` +
          `Provide insights on:\n` +
          `- Average time asleep vs recommended (7-9 hours)\n` +
          `- Sleep performance and efficiency patterns\n` +
          `- Any anomalies or concerning trends, if there are enough nights to judge\n` +
          `- Tips for improving sleep based on the data`
      )
  );

  // -------------------------------------------------------------------------
  // Prompt 3: recovery_trend
  // -------------------------------------------------------------------------
  server.registerPrompt(
    "recovery_trend",
    {
      description:
        "Analyze how recovery is trending — tracks HRV, resting heart rate, and recovery score over time.",
    },
    () =>
      userMessage(
        `How is my recovery trending? ` +
          `Use the following tools to analyze:\n\n` +
          `1. **get_baselines** — Personal HRV, resting heart rate and recovery ranges (says when recoveries are excluded because WHOOP is calibrating)\n` +
          `2. **get_trend** with metric "recovery" and days 30 — Recovery score direction\n` +
          `3. **get_trend** with metric "hrv" and days 30 — HRV direction\n` +
          `4. **get_trend** with metric "rhr" and days 30 — Resting heart rate direction\n` +
          `5. **get_recovery_collection** with start "${lastDaysExpression(RECENT_DAYS)}" — Recovery records from the last ${RECENT_DAYS} days (today included) for context\n\n` +
          `Analyze and explain:\n` +
          `- Is recovery improving, declining, or stable — or is there not enough data yet to tell?\n` +
          `- How recent HRV and resting heart rate compare with the personal ranges (for resting heart rate, lower is usually the favourable direction)\n` +
          `- Are there any anomalies that need attention?\n` +
          `- How resting heart rate and HRV relate to the recovery scores`
      )
  );

  // -------------------------------------------------------------------------
  // Prompt 4: workout_recap
  // -------------------------------------------------------------------------
  server.registerPrompt(
    "workout_recap",
    {
      description:
        "Summarize recent workouts and strain — shows training volume, sport breakdown, and strain patterns.",
    },
    () =>
      userMessage(
        `Summarize my recent workouts and training strain. ` +
          `Use the following tools:\n\n` +
          `1. **get_workout_collection** with start "${lastDaysExpression(RECENT_DAYS)}" — Workouts from the last ${RECENT_DAYS} days (today included)\n` +
          `2. **get_calendar** with days ${RECENT_DAYS} — Daily strain alongside recovery and sleep for the same days\n` +
          `3. **get_trend** with metric "strain" and days ${RECENT_DAYS} — Strain direction\n\n` +
          `Provide a recap including:\n` +
          `- Total workouts and sport type breakdown\n` +
          `- Total and average strain levels\n` +
          `- Strain direction (increasing/decreasing/stable), if there are enough days to judge\n` +
          `- Whether current training load looks sustainable given recovery`
      )
  );

  // -------------------------------------------------------------------------
  // Prompt 5: health_check
  // -------------------------------------------------------------------------
  server.registerPrompt(
    "health_check",
    {
      description:
        "Quick health status check — uses cached resource data for an instant snapshot of current recovery, sleep, and strain.",
    },
    () =>
      userMessage(
        `Give me a quick health status check. ` +
          `Use the following MCP resources for instant data (no tool calls needed for these):\n\n` +
          `1. **resource: whoop://v2/user/recovery/latest** — Latest recovery score, HRV, resting heart rate\n` +
          `2. **resource: whoop://v2/user/sleep/latest** — Latest main sleep\n` +
          `3. **resource: whoop://v2/user/cycle/latest** — Current cycle and strain so far\n\n` +
          `Read each resource's notes field when present (not scored yet, still calibrating, cycle in progress, belongs to an earlier cycle). ` +
          `The recovery and sleep are today's only when their cycle_id equals the cycle resource's id. ` +
          `If a note says one belongs to an earlier cycle, today's recovery or last night's sleep is not available yet: say so instead of reporting the older values as today's. ` +
          `If a resource is unavailable, or the cycle_ids differ without such a note, call **get_today**, which links sleep and recovery to the current cycle.\n\n` +
          `Provide a brief status update:\n` +
          `- Today's recovery level (green/yellow/red) and what it means, marked provisional while WHOOP is calibrating, or that it is not available yet\n` +
          `- Last night's sleep quality, or that last night's sleep has not synced yet\n` +
          `- Today's strain so far\n` +
          `- One actionable recommendation for today`
      )
  );
}
