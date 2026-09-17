/**
 * MCP Prompts — pre-built conversation starters for health queries.
 *
 * Standard privacy mode registers 13 prompts: the five original ones
 * (weekly_health_review, sleep_analysis, recovery_trend, workout_recap,
 * health_check) and eight task prompts grouped by topic:
 * - training (./training.ts): workout_recap, day_review, session_debrief,
 *   training_load_check;
 * - sleep and recovery (./sleep-recovery.ts): sleep_analysis, recovery_trend,
 *   morning_briefing, evening_briefing, recovery_drivers;
 * - platform (./platform.ts): export_my_data, data_status_check, and in
 *   aggregate mode the only prompt, aggregate_overview.
 *
 * Prompts are static message templates that name the tools to call. Every
 * argument is interpolated only after an allowlist, regular-expression or
 * clamp check, so free text from a client never reaches the message. Each
 * prompt carries guidance on reading WHOOP data honestly (nulls, calibrating
 * data, local days), plus training guidance for the training and day prompts.
 *
 * The topic modules import only types from this module; everything else is
 * passed in through {@link PromptKit}, so there is no runtime import cycle.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PrivacyMode } from "../privacy.js";
import { registerAggregatePrompts, registerPlatformPrompts } from "./platform.js";
import {
  registerRecoveryTrend,
  registerSleepAnalysis,
  registerSleepRecoveryPrompts,
} from "./sleep-recovery.js";
import { registerTrainingPrompts, registerWorkoutRecap } from "./training.js";

// ---------------------------------------------------------------------------
// Shared text
// ---------------------------------------------------------------------------

/** Default number of days reviewed by weekly_health_review */
export const DEFAULT_REVIEW_DAYS = 7;

/** Largest review window the date tools accept */
export const MAX_REVIEW_DAYS = 90;

/** Guidance appended to every standard-mode prompt on how to read WHOOP data honestly. */
export const DATA_GUIDANCE =
  `How to read the data:\n` +
  `- If a value is null, or a tool returns warnings, notes or data-quality details (for example "not enough data" while WHOOP is still calibrating in the first days of wear), say so plainly. Never treat a missing value as 0 and don't fill gaps with guesses.\n` +
  `- Recoveries with user_calibrating = true are provisional; say so whenever you use one.\n` +
  `- Don't describe a trend that rests on fewer than 4 data points; report the individual values instead.\n` +
  `- Sleep hours mean time asleep (light + slow-wave + REM) from main sleeps. Naps and time in bed are separate figures; label them if you use them.\n` +
  `- Collection tools (get_*_collection) return records newest first, at most 25 per call (default 10). They also include records that were still ongoing at the window start, such as the cycle and sleep that began the evening before, so check each record's start before assigning it to a day. Keep calling with next_token until it is null, and if a tool reports truncated results, say which period is missing.\n` +
  `- State which days the numbers cover, and don't give medical diagnoses.`;

/** Guidance appended to the training and day prompts. */
export const TRAINING_GUIDANCE =
  `How to read training and day data:\n` +
  `- Strain is WHOOP's 0-21 score and is not linear: don't add day strain across days, and don't split it into workouts (day strain is not the sum of workout strains).\n` +
  `- TRIMP and heart-rate zones undercount strength sessions, where effort shows little in heart rate. Pace is the elapsed average pace of the whole session, pauses included, not a split.\n` +
  `- Acute:chronic ratio, EWMA (ATL, CTL, TSB) and monotony describe the load pattern only; don't present them as injury risk, readiness or advice.\n` +
  `- Relationships between behaviours and recovery are observational and need the stated minimum number of pairs; report one only when the tool marks it consistent, and never as a cause.\n` +
  `- A workout after local midnight but before the next sleep belongs to the previous WHOOP day: use the day a tool reports, not the calendar date of the start.\n` +
  `- The sleep need estimate is a statistical estimate from past WHOOP sleep-need records, not WHOOP's Sleep Planner.\n` +
  `- If a tool reports truncated history, say which data may be missing; repeating the same call continues loading from the cache.`;

/** Guidance appended to the aggregate-mode prompt. */
export const AGGREGATE_GUIDANCE =
  `How to read the data:\n` +
  `- This server runs in aggregate privacy mode: results cover whole released weeks only. Don't describe single days, nights or workouts, and don't try to derive them by subtracting one result from another.\n` +
  `- A null value is withheld or unknown, never 0. Notes say why (a week not released yet, a week with a record still open or being scored, or fewer than 3 samples); say so plainly instead of guessing.\n` +
  `- Calibrating recoveries are not used, and values are rounded.\n` +
  `- Sleep hours mean time asleep on main sleeps. Strain is WHOOP's non-linear 0-21 score.\n` +
  `- If a note says data could not be read completely, repeating the call continues loading from the cache.\n` +
  `- State which weeks the numbers cover, and don't give medical diagnoses.`;

/** Guidance blocks a prompt can append. */
export type PromptGuidance = "data" | "training" | "aggregate";

const GUIDANCE_TEXT: Record<PromptGuidance, string> = {
  data: DATA_GUIDANCE,
  training: TRAINING_GUIDANCE,
  aggregate: AGGREGATE_GUIDANCE,
};

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
 * A `start` expression covering exactly `days` local days, today included, so
 * collection and range results line up with get_calendar / get_trend `days`.
 * "last N days" means today plus the N previous days (N + 1 days), so
 * N = days - 1; a single day is "today" ("last 0 days" is not a valid expression).
 */
export function lastDaysExpression(days: number): string {
  return days <= 1 ? "today" : `last ${days - 1} days`;
}

/** Day window shared by sleep_analysis and workout_recap */
export const RECENT_DAYS = 14;

/** Prompts registered in standard mode, in prompts/list order. */
export const STANDARD_PROMPT_NAMES = [
  "weekly_health_review",
  "sleep_analysis",
  "recovery_trend",
  "workout_recap",
  "health_check",
  "morning_briefing",
  "evening_briefing",
  "recovery_drivers",
  "day_review",
  "session_debrief",
  "training_load_check",
  "export_my_data",
  "data_status_check",
] as const;

/** Prompts registered in aggregate mode. */
export const AGGREGATE_PROMPT_NAMES = ["aggregate_overview"] as const;

/** A prompts/get result: one user message. */
export interface PromptMessages {
  [key: string]: unknown;
  messages: Array<{ role: "user"; content: { type: "text"; text: string } }>;
}

/** What the topic modules need from this module. */
export interface PromptKit {
  /** One user message: `text` followed by the requested guidance blocks. */
  message(text: string, guidance: readonly PromptGuidance[]): PromptMessages;
  lastDaysExpression(days: number): string;
  recentDays: number;
}

function promptMessage(text: string, guidance: readonly PromptGuidance[]): PromptMessages {
  const blocks = [text, ...guidance.map((name) => GUIDANCE_TEXT[name])];
  return {
    messages: [
      {
        role: "user" as const,
        content: { type: "text" as const, text: blocks.join("\n\n") },
      },
    ],
  };
}

const KIT: PromptKit = {
  message: promptMessage,
  lastDaysExpression,
  recentDays: RECENT_DAYS,
};

// ---------------------------------------------------------------------------
// Prompt definitions
// ---------------------------------------------------------------------------

/** Options for {@link registerPrompts}. */
export interface RegisterPromptsOptions {
  privacyMode: PrivacyMode;
}

/**
 * Register the MCP prompts for the privacy mode: 13 in standard mode, only
 * aggregate_overview in aggregate mode.
 */
export function registerPrompts(
  server: McpServer,
  options: RegisterPromptsOptions = { privacyMode: "standard" }
): void {
  if (options.privacyMode === "aggregate") {
    registerAggregatePrompts(server, KIT);
    return;
  }

  // -------------------------------------------------------------------------
  // weekly_health_review
  // -------------------------------------------------------------------------
  server.registerPrompt(
    "weekly_health_review",
    {
      description:
        "Comprehensive review of recovery, sleep, and workouts from a specified number of days. Provides observations on overall health trends.",
      argsSchema: {
        days: z
          .string()
          .optional()
          .describe(`Number of days to review, 1-${MAX_REVIEW_DAYS} (default: 7)`),
      },
    },
    (args) => {
      const days = parseReviewDays(args.days);
      return promptMessage(
        `Please provide a comprehensive health review for the past ${days} days. ` +
          `Use the following tools to gather data:\n\n` +
          `1. **get_calendar** with days ${days} — Day-by-day recovery, sleep and strain for the period\n` +
          `2. **get_weekly_summary** — Averages for recovery, HRV, resting heart rate, sleep and workouts over the current Monday-to-Sunday week (pass week_start for an earlier week); these are calendar weeks, so say so when they don't match the ${days}-day period\n` +
          `3. **get_baselines** — The user's personal ranges, to put the period in context\n` +
          `4. **get_sport_breakdown** with start "${lastDaysExpression(days)}" — Workouts per sport (sessions, time, strain, energy) for the same ${days} days\n` +
          `5. **get_recovery_collection** / **get_sleep_collection** with start "${lastDaysExpression(days)}" — Record-level detail, only if needed\n\n` +
          `Analyze the data and provide:\n` +
          `- Overall recovery direction (improving, declining, stable), or why there is not enough data yet to tell\n` +
          `- Sleep quality assessment and patterns\n` +
          `- Training load and strain summary\n` +
          `- What stands out compared with the user's own earlier days and baselines, as observations only (no advice or medical interpretation)`,
        ["data"]
      );
    }
  );

  registerSleepAnalysis(server, KIT);
  registerRecoveryTrend(server, KIT);
  registerWorkoutRecap(server, KIT);

  // -------------------------------------------------------------------------
  // health_check
  // -------------------------------------------------------------------------
  server.registerPrompt(
    "health_check",
    {
      description:
        "Quick health status check — uses cached resource data for an instant snapshot of current recovery, sleep, and strain.",
    },
    () =>
      promptMessage(
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
          `- Today's recovery score and WHOOP zone (green/yellow/red) with HRV and resting heart rate, marked provisional while WHOOP is calibrating, or that it is not available yet\n` +
          `- Last night's sleep quality, or that last night's sleep has not synced yet\n` +
          `- Today's strain so far\n` +
          `- Anything missing, provisional or not synced yet`,
        ["data"]
      )
  );

  registerSleepRecoveryPrompts(server, KIT);
  registerTrainingPrompts(server, KIT);
  registerPlatformPrompts(server, KIT);
}
