/**
 * Registry tools: sync and server status (package P3).
 * get_sync_status has an aggregate variant that reports released weeks only.
 */

import { SYNC_STATUS_TOOL } from "../get-sync-status.js";
import type { AnyToolDefinition } from "../tool-definition.js";

/** Registry tools for sync and server status. */
export const STATUS_TOOLS: readonly AnyToolDefinition[] = [SYNC_STATUS_TOOL];
