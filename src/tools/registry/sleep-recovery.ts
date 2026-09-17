/**
 * Registry tools: sleep analysis, recovery analysis and sleep need (package P8).
 *
 * None has an aggregate variant: each reports per-night or per-day rows, a
 * latest observation or an estimate for tonight, which aggregate mode omits,
 * so they are absent there.
 */

import { getRecoveryAnalysisTool } from "../get-recovery-analysis.js";
import { getSleepAnalysisTool } from "../get-sleep-analysis.js";
import { getSleepNeedTool } from "../get-sleep-need.js";
import type { AnyToolDefinition } from "../tool-definition.js";

/** Registry tools for sleep analysis, recovery analysis and sleep need. */
export const SLEEP_RECOVERY_TOOLS: readonly AnyToolDefinition[] = [
  getSleepAnalysisTool,
  getRecoveryAnalysisTool,
  getSleepNeedTool,
];
