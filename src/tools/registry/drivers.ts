/**
 * Registry tools: recovery drivers (package P9).
 * get_recovery_drivers has no aggregate variant: tags and pair-level
 * associations can isolate single nights, so it is absent in aggregate mode.
 */

import { RECOVERY_DRIVERS_TOOL } from "../get-recovery-drivers.js";
import type { AnyToolDefinition } from "../tool-definition.js";

/** Registry tools for recovery drivers. */
export const DRIVERS_TOOLS: readonly AnyToolDefinition[] = [RECOVERY_DRIVERS_TOOL];
