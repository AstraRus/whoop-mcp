/**
 * Training and day prompts (standard mode): workout_recap, day_review,
 * session_debrief and training_load_check.
 *
 * Arguments are matched against a fixed pattern before they are written into a
 * message; anything else falls back to the default or is left out.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PromptKit } from "./index.js";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/** Default day for day_review */
export const DEFAULT_REVIEW_DAY = "yesterday";

/** Days of get_calendar context in day_review */
export const DAY_REVIEW_CONTEXT_DAYS = 7;

/** Days of chronic load context in workout_recap and training_load_check */
export const TRAINING_CONTEXT_DAYS = 28;

/** Sessions listed by workout_recap */
export const WORKOUT_RECAP_LIMIT = 25;

/** A WHOOP workout id as get_workout_context accepts it. */
const WORKOUT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The day_review `date`: "today", "yesterday" or a real calendar date
 * YYYY-MM-DD; anything else gives {@link DEFAULT_REVIEW_DAY}.
 */
export function parseReviewDay(value: string | undefined): string {
  const trimmed = value?.trim().toLowerCase() ?? "";
  if (trimmed === "today" || trimmed === "yesterday") return trimmed;
  if (!DAY_PATTERN.test(trimmed)) return DEFAULT_REVIEW_DAY;
  const ms = Date.parse(`${trimmed}T00:00:00.000Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== trimmed) {
    return DEFAULT_REVIEW_DAY;
  }
  return trimmed;
}

/** A workout id matching get_workout_context's pattern, or undefined. */
export function parseWorkoutId(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";
  return WORKOUT_ID_PATTERN.test(trimmed) ? trimmed : undefined;
}

/** A YYYY-MM-DD day shifted by `count` calendar days. */
function shiftDay(day: string, count: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + count * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

// ---------------------------------------------------------------------------
// Rewritten original prompt
// ---------------------------------------------------------------------------

/** workout_recap: sport breakdown, training load and the workout log. */
export function registerWorkoutRecap(server: McpServer, kit: PromptKit): void {
  const days = kit.recentDays;
  server.registerPrompt(
    "workout_recap",
    {
      description:
        "Summarize recent workouts and training load — sessions and time per sport, heart-rate zones, TRIMP, weekly totals and acute versus chronic load.",
    },
    () =>
      kit.message(
        `Summarize my recent workouts and training load. ` +
          `Use the following tools:\n\n` +
          `1. **get_sport_breakdown** with days ${days} — Sessions, time, strain, energy, heart-rate zones and TRIMP per sport over the last ${days} days\n` +
          `2. **get_training_load** with days ${TRAINING_CONTEXT_DAYS} — Daily load, acute and chronic load, monotony and weekly totals up to the last completed WHOOP day\n` +
          `3. **get_workout_log** with days ${days} and limit ${WORKOUT_RECAP_LIMIT} — The individual sessions, newest first, with totals over every match\n\n` +
          `Provide a recap including:\n` +
          `- Total sessions and the breakdown by sport\n` +
          `- Time, energy and TRIMP totals, and the intensity distribution in WHOOP heart-rate zones\n` +
          `- Weekly totals, week-over-week change and acute versus chronic load, as numbers\n` +
          `- Notable sessions from the log (for example the longest or the highest strain), with the WHOOP day each counts toward`,
        ["data", "training"]
      )
  );
}

// ---------------------------------------------------------------------------
// New prompts
// ---------------------------------------------------------------------------

/** day_review, session_debrief and training_load_check. */
export function registerTrainingPrompts(server: McpServer, kit: PromptKit): void {
  server.registerPrompt(
    "day_review",
    {
      description:
        "Review one local day: its WHOOP cycle, recovery, sleep, naps and workouts, the next morning's recovery and the surrounding week.",
      argsSchema: {
        date: z
          .string()
          .optional()
          .describe('Day to review: YYYY-MM-DD, "today" or "yesterday" (default: yesterday)'),
      },
    },
    (args) => {
      const day = parseReviewDay(args.date);
      const relative = day === "today" || day === "yesterday";
      const label = relative ? day : `on ${day}`;
      const calendar = relative
        ? `**get_calendar** with days ${DAY_REVIEW_CONTEXT_DAYS} — The last ${DAY_REVIEW_CONTEXT_DAYS} days for context`
        : `**get_calendar** with start "${shiftDay(day, -(DAY_REVIEW_CONTEXT_DAYS - 1))}" and days ${DAY_REVIEW_CONTEXT_DAYS} — The ${DAY_REVIEW_CONTEXT_DAYS} days up to ${day} for context`;
      return kit.message(
        `Review my WHOOP day ${label}. ` +
          `Use the following tools:\n\n` +
          `1. **get_day** with date "${day}" — The cycle, recovery, main sleep, naps and workouts placed on that local day, the previous day's strain and the next morning's recovery\n` +
          `2. ${calendar}\n\n` +
          `Report:\n` +
          `- The day's status (complete, in_progress, no_cycle_yet, records_without_cycle or no_data) and what it means for the values shown\n` +
          `- Recovery, main sleep (time asleep against WHOOP's need) and day strain\n` +
          `- Workouts by sport with duration, strain, heart-rate zones and TRIMP, including any that count toward this day although they started after local midnight\n` +
          `- How the day compares with the surrounding days, using only days that have data\n` +
          `- The next morning's recovery, or its status when it is not available`,
        ["data", "training"]
      );
    }
  );

  server.registerPrompt(
    "session_debrief",
    {
      description:
        "Debrief one workout (the most recent one by default): the session, its WHOOP day, the recovery before it, the night after it and earlier sessions of the same sport.",
      argsSchema: {
        workout_id: z
          .string()
          .optional()
          .describe("WHOOP workout id (UUID); default: the most recent scored workout"),
      },
    },
    (args) => {
      const id = parseWorkoutId(args.workout_id);
      const steps =
        id !== undefined
          ? `1. **get_workout_context** with id "${id}" — The session, the local day it counts toward, the recovery before it, the sleep and recovery after it, and percentiles against earlier sessions of the same sport\n\n`
          : `1. **get_workout_log** with limit 1 and sort "newest" — The most recent scored session and its id\n` +
            `2. **get_workout_context** with the id from step 1 — The session, the local day it counts toward, the recovery before it, the sleep and recovery after it, and percentiles against earlier sessions of the same sport\n\n`;
      return kit.message(
        `Debrief ${id !== undefined ? `my WHOOP workout ${id}` : "my most recent WHOOP workout"}. ` +
          `Use the following tools:\n\n` +
          steps +
          `Report:\n` +
          `- Sport, the WHOOP day it counts toward, duration, strain, heart-rate zones, TRIMP and, for GPS sessions, distance and pace\n` +
          `- The morning recovery before the session\n` +
          `- The sleep and recovery after it, or their status (not_yet, pending, missing or unavailable)\n` +
          `- Percentiles against earlier sessions of the same sport where at least 5 exist, otherwise that there are too few to compare\n` +
          `- That one night after one session is a single observation, not an effect of the session`,
        ["data", "training"]
      );
    }
  );

  server.registerPrompt(
    "training_load_check",
    {
      description:
        "Check training load neutrally: acute and chronic load, their ratio, week-over-week change, monotony and load by sport, or when enough history will exist.",
    },
    () =>
      kit.message(
        `Check my training load from WHOOP. ` +
          `Use the following tools:\n\n` +
          `1. **get_training_load** — Daily load (Edwards TRIMP by default) with acute (7-day) and chronic (28-day) means, their ratio, EWMA, monotony and weekly totals, ending at the last completed WHOOP day\n` +
          `2. **get_sport_breakdown** with days ${TRAINING_CONTEXT_DAYS} — Sessions, time, heart-rate zones and TRIMP per sport over the last ${TRAINING_CONTEXT_DAYS} days\n\n` +
          `Report neutrally:\n` +
          `- The status; if it is insufficient_history, the worn days so far and available_from_day (quote that date), and only the values that already exist\n` +
          `- Acute and chronic load and their ratio as plain numbers (for example "acute load is 18% above the 28-day mean"), without risk zones or targets\n` +
          `- Week-over-week change for completed weeks and monotony, with the days they cover\n` +
          `- Load by sport and the intensity distribution in WHOOP heart-rate zones`,
        ["data", "training"]
      )
  );
}
