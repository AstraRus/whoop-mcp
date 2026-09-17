/**
 * Registry tools: workout log, workout context and personal records (package P7).
 *
 * None of them has an aggregate variant: each lists or compares single
 * workout records, which aggregate mode omits, so they are absent there.
 */

import { PERSONAL_RECORDS_TOOL } from "../get-personal-records.js";
import { WORKOUT_CONTEXT_TOOL } from "../get-workout-context.js";
import { WORKOUT_LOG_TOOL } from "../get-workout-log.js";
import type { AnyToolDefinition } from "../tool-definition.js";

/** Registry tools for workout log, workout context and personal records. */
export const WORKOUT_TOOLS: readonly AnyToolDefinition[] = [
  WORKOUT_LOG_TOOL,
  WORKOUT_CONTEXT_TOOL,
  PERSONAL_RECORDS_TOOL,
];
