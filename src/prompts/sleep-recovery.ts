/**
 * Sleep and recovery prompts (standard mode): sleep_analysis, recovery_trend,
 * morning_briefing, evening_briefing and recovery_drivers.
 *
 * Arguments are allowlisted or matched against a fixed pattern before they are
 * written into a message; anything else is left out.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  DRIVER_BEHAVIOURS,
  DRIVER_OUTCOMES,
  type DriverBehaviour,
  type DriverOutcome,
} from "../tools/get-recovery-drivers.js";
import type { PromptKit } from "./index.js";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/** A 24-hour local wake time, as get_sleep_need accepts it. */
const WAKE_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Days of recoveries shown for context by morning_briefing */
export const MORNING_RECOVERY_DAYS = 7;

/** Days analysed by recovery_trend */
export const RECOVERY_TREND_DAYS = 30;

/** A valid "HH:MM" wake time, or undefined for anything else. */
export function parseWakeTime(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";
  return WAKE_TIME_PATTERN.test(trimmed) ? trimmed : undefined;
}

/** An allowlisted get_recovery_drivers outcome, or undefined. */
export function parseDriverOutcome(value: string | undefined): DriverOutcome | undefined {
  const trimmed = value?.trim().toLowerCase() ?? "";
  return (DRIVER_OUTCOMES as readonly string[]).includes(trimmed)
    ? (trimmed as DriverOutcome)
    : undefined;
}

/** An allowlisted get_recovery_drivers focus behaviour, or undefined. */
export function parseDriverFocus(value: string | undefined): DriverBehaviour | undefined {
  const trimmed = value?.trim().toLowerCase() ?? "";
  return (DRIVER_BEHAVIOURS as readonly string[]).includes(trimmed)
    ? (trimmed as DriverBehaviour)
    : undefined;
}

// ---------------------------------------------------------------------------
// Rewritten original prompts
// ---------------------------------------------------------------------------

/** sleep_analysis: sleep distributions, nightly need and two sleep trends. */
export function registerSleepAnalysis(server: McpServer, kit: PromptKit): void {
  const days = kit.recentDays;
  server.registerPrompt(
    "sleep_analysis",
    {
      description:
        "Analyze recent sleep: time asleep against WHOOP's nightly sleep need, efficiency, consistency, stages, timing, naps and trends.",
    },
    () =>
      kit.message(
        `Analyze my recent sleep patterns and quality. ` +
          `Use the following tools:\n\n` +
          `1. **get_sleep_analysis** with days ${days} — Time asleep and in bed, efficiency, performance, consistency, stage shares, bedtime and wake-time regularity and naps over the last ${days} days, with one row per night\n` +
          `2. **get_sleep_debt** with days ${days} — Each night's time asleep against WHOOP's sleep need for that night, and bedtime consistency\n` +
          `3. **get_trend** with metric "sleep_duration" and days ${days} — Direction of time asleep\n` +
          `4. **get_trend** with metric "deep_share" and days ${days} — Direction of the slow-wave (deep) share of time asleep\n\n` +
          `Provide insights on:\n` +
          `- Average time asleep compared with WHOOP's own sleep need for each night, rather than general population figures\n` +
          `- Sleep performance, efficiency and consistency, and how regular bedtimes and wake times were\n` +
          `- Stage shares, and any direction in time asleep or deep sleep if there are enough nights to judge\n` +
          `- Naps as a separate figure, and nights flagged for low data coverage or not scored yet`,
        ["data"]
      )
  );
}

/** recovery_trend: recovery analysis, baselines and three trends. */
export function registerRecoveryTrend(server: McpServer, kit: PromptKit): void {
  const days = RECOVERY_TREND_DAYS;
  server.registerPrompt(
    "recovery_trend",
    {
      description:
        "Analyze how recovery is trending — recovery zones, HRV, resting heart rate and deviations from personal baselines over time.",
    },
    () =>
      kit.message(
        `How is my recovery trending? ` +
          `Use the following tools to analyze:\n\n` +
          `1. **get_recovery_analysis** with days ${days} — Recovery zones, HRV, resting heart rate, the 7-day HRV mean and variation, weekday patterns and each day's deviations from my personal baseline\n` +
          `2. **get_baselines** — Personal HRV, resting heart rate and recovery ranges (says when recoveries are excluded because WHOOP is calibrating)\n` +
          `3. **get_trend** with metric "recovery" and days ${days} — Recovery score direction\n` +
          `4. **get_trend** with metric "hrv" and days ${days} — HRV direction\n` +
          `5. **get_trend** with metric "rhr" and days ${days} — Resting heart rate direction\n\n` +
          `Analyze and explain:\n` +
          `- Is recovery improving, declining, or stable — or is there not enough data yet to tell?\n` +
          `- How recent HRV and resting heart rate compare with the personal ranges (for resting heart rate, lower is usually the favourable direction)\n` +
          `- Days flagged as unusual, noting that a deviation beyond 2 robust z-scores happens on about 5% of days by chance\n` +
          `- How resting heart rate and HRV relate to the recovery scores`,
        ["data"]
      )
  );
}

// ---------------------------------------------------------------------------
// New prompts
// ---------------------------------------------------------------------------

/** morning_briefing, evening_briefing and recovery_drivers. */
export function registerSleepRecoveryPrompts(server: McpServer, kit: PromptKit): void {
  server.registerPrompt(
    "morning_briefing",
    {
      description:
        "Morning briefing: today's recovery and last night's sleep with the past week for context, and why a section may not be available yet.",
    },
    () =>
      kit.message(
        `Give me a short morning briefing from my WHOOP data. ` +
          `Use the following tools:\n\n` +
          `1. **get_today** — Today's recovery, last night's sleep, strain so far and the latest workout\n` +
          `2. **get_recovery_analysis** with days ${MORNING_RECOVERY_DAYS} — The past ${MORNING_RECOVERY_DAYS} days of recoveries for context (zones, HRV and resting heart rate, with deviations from my baseline once there is enough history)\n` +
          `3. **get_day** with date "yesterday" — Only if yesterday's strain or workouts are needed to put today in context\n` +
          `4. **get_sync_status** — Only when a section of get_today is null or data_quality marks a source as stale, to explain why (for example WHOOP has not processed the sleep yet, or the strap has not synced)\n\n` +
          `Report:\n` +
          `- Today's recovery score and zone with HRV and resting heart rate, marked provisional while WHOOP is calibrating, or that it is not available yet and why\n` +
          `- Last night's time asleep against WHOOP's sleep need, with sleep performance and efficiency\n` +
          `- How today's recovery compares with the past ${MORNING_RECOVERY_DAYS} days, using only the values that exist\n` +
          `- Anything missing or not synced yet`,
        ["data", "training"]
      )
  );

  server.registerPrompt(
    "evening_briefing",
    {
      description:
        "Evening briefing: today's strain and workouts so far and a statistical estimate of tonight's sleep need, optionally for a wake time.",
      argsSchema: {
        wake_time: z
          .string()
          .optional()
          .describe('Planned wake time as 24-hour local "HH:MM", e.g. "06:30" (optional)'),
      },
    },
    (args) => {
      const wakeTime = parseWakeTime(args.wake_time);
      const needStep =
        wakeTime !== undefined
          ? `3. **get_sleep_need** with wake_time "${wakeTime}" — A statistical estimate of tonight's sleep need from my past WHOOP sleep-need records, plus the in-bed arithmetic for waking at ${wakeTime}\n\n`
          : `3. **get_sleep_need** — A statistical estimate of tonight's sleep need from my past WHOOP sleep-need records (no wake time was given, so there is no in-bed arithmetic; ask me for a wake time if I want it)\n\n`;
      const wakeReport =
        wakeTime !== undefined
          ? `- The hours in bed the estimate corresponds to and the latest in-bed start that arithmetic gives for ${wakeTime}, labelled as arithmetic that ignores the time it takes to fall asleep\n`
          : "";
      return kit.message(
        `Give me an evening briefing from my WHOOP data. ` +
          `Use the following tools:\n\n` +
          `1. **get_today** — Today's recovery and strain so far (the current WHOOP cycle stays open until the next sleep)\n` +
          `2. **get_day** with date "today" — Today's workouts, naps and cycle details\n` +
          needStep +
          `Report:\n` +
          `- Today's strain so far and the workouts behind it, noting that strain keeps accumulating until the next sleep\n` +
          `- The sleep need estimate with its status, range and selected model; if the status is not estimated, say why and give WHOOP's need from last night instead\n` +
          wakeReport +
          `- That the estimate is not WHOOP's Sleep Planner and not a recommendation`,
        ["data", "training"]
      );
    }
  );

  server.registerPrompt(
    "recovery_drivers",
    {
      description:
        "Look for observational patterns between behaviours (bedtime, time asleep, strain, training load, late workouts, naps, sleep debt) and next-morning recovery, HRV, resting heart rate or sleep.",
      argsSchema: {
        outcome: z
          .string()
          .optional()
          .describe(`Outcome to relate behaviours to: ${DRIVER_OUTCOMES.join(", ")} (optional)`),
        focus: z
          .string()
          .optional()
          .describe(
            `One behaviour to add bucket means for: ${DRIVER_BEHAVIOURS.join(", ")} (optional)`
          ),
      },
    },
    (args) => {
      const outcome = parseDriverOutcome(args.outcome);
      const focus = parseDriverFocus(args.focus);
      const settings = [
        ...(outcome !== undefined ? [`outcomes ["${outcome}"]`] : []),
        ...(focus !== undefined ? [`focus "${focus}"`] : []),
      ];
      const withSettings = settings.length > 0 ? ` with ${settings.join(" and ")}` : "";
      const outcomeText =
        outcome !== undefined
          ? `next-morning ${outcome}`
          : "next-morning recovery, HRV and resting heart rate";
      return kit.message(
        `Look for patterns between my behaviours and ${outcomeText} in my WHOOP data. ` +
          `Use the following tools:\n\n` +
          `1. **get_recovery_drivers**${withSettings} — Observational tests of bedtime, time asleep, day strain, training load, late workouts, naps and sleep debt against the outcome, with effective sample sizes and false-discovery control\n\n` +
          `Report:\n` +
          `- First the status, pairs_analyzed against pairs_required and excluded_pairs by reason. While the status is calibrating or insufficient_data, say how many pairs exist and how many are required, and stop there\n` +
          `- Findings only where consistent is true, each with n, the effect (rho or Cliff's delta) and its 95% confidence interval, in the past tense; say when partly_by_construction is true\n` +
          `- That the remaining combinations showed no consistent association or were not tested (not_tested_summary), without listing them all\n` +
          (focus !== undefined
            ? `- The bucket means for ${focus}, with the count in each bucket\n`
            : "") +
          `- If I mention a behaviour WHOOP cannot see (for example alcohol or a late meal), ask me for the exact dates first and call **get_recovery_drivers** again with custom_tags only for the dates I confirm; never infer tag dates from the data`,
        ["data", "training"]
      );
    }
  );
}
