/**
 * The tool registry: the 16 legacy tool names registered directly in
 * server.ts, and every other tool, registered through its ToolDefinition.
 *
 * Importing this module validates the registry (unique, well-formed names that
 * do not collide with legacy tools; titles, descriptions and read-only
 * annotations) and throws on the first problem.
 */

import { validateToolDefinitions, type AnyToolDefinition } from "../tool-definition.js";
import { STATUS_TOOLS } from "./status.js";
import { DAY_TOOLS } from "./day.js";
import { WORKOUT_TOOLS } from "./workouts.js";
import { TRAINING_LOAD_TOOLS } from "./training-load.js";
import { SLEEP_RECOVERY_TOOLS } from "./sleep-recovery.js";
import { DRIVERS_TOOLS } from "./drivers.js";

/** Tools registered directly in server.ts (standard mode; five also in aggregate mode). */
export const LEGACY_TOOL_NAMES = [
  "get_profile",
  "get_body_measurement",
  "get_recovery_collection",
  "get_sleep_collection",
  "get_workout_collection",
  "get_cycle_collection",
  "get_sleep_by_id",
  "get_workout_by_id",
  "get_cycle_by_id",
  "get_weekly_summary",
  "compare_periods",
  "get_trend",
  "get_today",
  "get_calendar",
  "get_baselines",
  "get_sleep_debt",
] as const;

/** A legacy tool name. */
export type LegacyToolName = (typeof LEGACY_TOOL_NAMES)[number];

/** Legacy tools that also have an aggregate-mode contract. */
export const LEGACY_AGGREGATE_TOOL_NAMES = [
  "get_weekly_summary",
  "compare_periods",
  "get_trend",
  "get_baselines",
  "get_sleep_debt",
] as const;

/** Every registry tool, registered after the legacy tools in this order. */
export const ADDITIONAL_TOOLS: readonly AnyToolDefinition[] = [
  ...STATUS_TOOLS,
  ...DAY_TOOLS,
  ...WORKOUT_TOOLS,
  ...TRAINING_LOAD_TOOLS,
  ...SLEEP_RECOVERY_TOOLS,
  ...DRIVERS_TOOLS,
];

validateToolDefinitions(ADDITIONAL_TOOLS, LEGACY_TOOL_NAMES);
