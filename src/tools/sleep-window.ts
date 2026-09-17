/**
 * The sleep window shared by get_sleep_debt and the sleep analysis tools:
 * a UTC-instant window that starts at `start` (or `days` before now) and ends
 * no later than now.
 */

import { InvalidDateExpression, resolveDateExpression } from "./date-utils.js";
import { DAY_MS } from "./analytics-utils.js";

export interface SleepWindowOptions {
  /** Tool named in the oversized-window error */
  toolName: string;
  /** Longest window in days; a range expression may add the partial current day */
  maxDays: number;
}

const DEFAULT_OPTIONS: SleepWindowOptions = { toolName: "get_sleep_debt", maxDays: 90 };

/**
 * The sleep window [startTime, endTime) in UTC milliseconds. A single day or
 * date-time `start` runs for `days`; a range expression covers its own range
 * unless `days` was given explicitly. The end is clamped to now.
 *
 * @throws InvalidDateExpression for unparseable or oversized windows, and for
 *   a window that would begin at or after now
 */
export function resolveSleepWindow(
  start: string | undefined,
  requestedDays: number | undefined,
  days: number,
  now: Date,
  utcOffset: string,
  options: SleepWindowOptions = DEFAULT_OPTIONS
): { startTime: number; endTime: number } {
  const nowMs = now.getTime();
  if (start === undefined) return { startTime: nowMs - days * DAY_MS, endTime: nowMs };
  const range = resolveDateExpression(start, now, utcOffset);
  const startTime = Date.parse(range.start);
  // A resolved range ends at 23:59:59.999 local: its exclusive end is one millisecond later.
  const rangeEnd = Date.parse(range.end) + 1;
  const isRange = rangeEnd - startTime > DAY_MS;
  const endTime = Math.min(
    isRange && requestedDays === undefined ? rangeEnd : startTime + days * DAY_MS,
    nowMs
  );
  if (!Number.isFinite(startTime) || startTime >= endTime)
    throw new InvalidDateExpression(
      `The sleep window "${start}" begins at or after the current time; ${options.toolName} needs a window that starts in the past.`
    );
  const spanDays = (endTime - startTime) / DAY_MS;
  if (spanDays > options.maxDays + 1)
    throw new InvalidDateExpression(
      `The sleep window "${start}" spans ${Math.ceil(spanDays)} days; ${options.toolName} covers at most ${options.maxDays} days (plus today). Use a shorter range, or a start date with days.`
    );
  return { startTime, endTime };
}
