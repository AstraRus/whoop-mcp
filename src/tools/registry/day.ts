/**
 * Registry tools: per-day detail and data export (package P5).
 *
 * Neither tool has an aggregate variant: get_day shows single-day records and
 * export_health_data raw daily rows, both of which aggregate mode omits, so
 * they are absent there.
 */

import { EXPORT_HEALTH_DATA_TOOL } from "../export-health-data.js";
import { GET_DAY_TOOL } from "../get-day.js";
import type { AnyToolDefinition } from "../tool-definition.js";

/** Registry tools for per-day detail and data export. */
export const DAY_TOOLS: readonly AnyToolDefinition[] = [GET_DAY_TOOL, EXPORT_HEALTH_DATA_TOOL];
