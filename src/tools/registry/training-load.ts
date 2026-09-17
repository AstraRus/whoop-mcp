/**
 * Registry tools: training load and sport breakdown (package P6).
 * Both are registered in standard and aggregate privacy mode.
 */

import { SPORT_BREAKDOWN_STANDARD, SPORT_BREAKDOWN_TOOL_NAME } from "../get-sport-breakdown.js";
import { TRAINING_LOAD_STANDARD, TRAINING_LOAD_TOOL_NAME } from "../get-training-load.js";
import { defineTool, type AnyToolDefinition } from "../tool-definition.js";
import { SPORT_BREAKDOWN_AGGREGATE, TRAINING_LOAD_AGGREGATE } from "../training-aggregate.js";

/** get_training_load */
export const TRAINING_LOAD_TOOL = defineTool({
  name: TRAINING_LOAD_TOOL_NAME,
  annotations: { readOnlyHint: true },
  standard: TRAINING_LOAD_STANDARD,
  aggregate: TRAINING_LOAD_AGGREGATE,
});

/** get_sport_breakdown */
export const SPORT_BREAKDOWN_TOOL = defineTool({
  name: SPORT_BREAKDOWN_TOOL_NAME,
  annotations: { readOnlyHint: true },
  standard: SPORT_BREAKDOWN_STANDARD,
  aggregate: SPORT_BREAKDOWN_AGGREGATE,
});

/** Registry tools for training load and sport breakdown. */
export const TRAINING_LOAD_TOOLS: readonly AnyToolDefinition[] = [
  TRAINING_LOAD_TOOL,
  SPORT_BREAKDOWN_TOOL,
];
