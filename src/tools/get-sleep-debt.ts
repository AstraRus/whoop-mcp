import { z } from "zod";
import type { WhoopClient } from "../api/client.js";
import { ENDPOINT_SLEEP } from "../api/endpoints.js";
import { sleepRecordSchema } from "../api/record-schemas.js";
import { resolveUserUtcOffsetInfo, withOffsetNote } from "./collection-utils.js";
import { InvalidDateExpression, resolveDateExpression } from "./date-utils.js";
import { circularStats, mean } from "./stats-utils.js";
import {
  asleepHours,
  dataQualitySchema,
  DAY_MS,
  DISCLAIMER,
  HOUR_MS,
  loadAnalyticsSource,
  mostRelevantError,
  mainSleeps,
  localDay,
  localTime,
  periodSchema,
  finishQuality,
  exclude,
  formatLocalTimestamp,
} from "./analytics-utils.js";

/** Scored main sleeps needed before deficit totals and consistency are reported. */
export const SLEEP_DEBT_MIN_NIGHTS = 3;

/** Longest sleep window, in days; a range expression may add the partial current day. */
export const SLEEP_DEBT_MAX_DAYS = 90;

export const sleepDebtInputSchema = z.object({
  days: z
    .number()
    .int()
    .min(3)
    .max(90)
    .optional()
    .describe(
      "Window length in days (3-90). Default: 14. Without `start` the window ends now. With `start` it runs forward from `start` for this many days, clamped to now; this also overrides the end of a range expression in `start`."
    ),
  start: z
    .string()
    .max(100)
    .optional()
    .describe(
      'Window start. A single day (YYYY-MM-DD from local midnight, "today", "yesterday") or a date-time with offset starts a window of `days` (default 14), clamped to now. A range expression ("last 7 days", "last 2 weeks", "this week", "last week", "this month", "last month", "YYYY-MM") covers exactly that range, ending at its end or now, unless `days` is also given, in which case the window is its first day plus `days`. Ranges longer than 90 days plus today are rejected. Default: `days` before now.'
    ),
});
const nightSchema = z.object({
  date: z.string(),
  needed_hours: z.number(),
  achieved_hours: z.number(),
  debt_hours: z.number(),
});
export const sleepDebtOutputSchema = z.object({
  period: periodSchema,
  nights_analyzed: z.number().int(),
  /**
   * available: at least nights_required scored main sleeps. insufficient_data:
   * sleep data was read but has too few nights. unavailable: sleep data could
   * not be read.
   */
  status: z.enum(["available", "insufficient_data", "unavailable"]),
  nights_required: z.number().int(),
  total_debt_hours: z.number().nullable(),
  avg_nightly_debt_hours: z.number().nullable(),
  standing_debt_hours: z.number().nullable(),
  standing_debt_date: z.string().nullable(),
  consistency: z.object({
    bedtime_std_dev_minutes: z.number().nullable(),
    waketime_std_dev_minutes: z.number().nullable(),
    social_jetlag_minutes: z.number().nullable(),
  }),
  nights: z.array(nightSchema).max(30),
  output_capped: z.boolean(),
  truncated: z.boolean(),
  summary: z.string(),
  notes: z.array(z.string()),
  disclaimer: z.string(),
  data_quality: dataQualitySchema,
});
export type SleepDebtReport = z.infer<typeof sleepDebtOutputSchema>;

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/**
 * The sleep window [startTime, endTime) in UTC milliseconds. A single day or
 * date-time `start` runs for `days`; a range expression covers its own range
 * unless `days` was given explicitly. The end is clamped to now.
 *
 * @throws InvalidDateExpression for unparseable or oversized windows
 * @throws RangeError when the window would begin at or after now
 */
function resolveSleepWindow(
  start: string | undefined,
  requestedDays: number | undefined,
  days: number,
  now: Date,
  utcOffset: string
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
    throw new RangeError("Sleep window must begin before the evaluation time.");
  const spanDays = (endTime - startTime) / DAY_MS;
  if (spanDays > SLEEP_DEBT_MAX_DAYS + 1)
    throw new InvalidDateExpression(
      `The sleep window "${start}" spans ${Math.ceil(spanDays)} days; get_sleep_debt covers at most ${SLEEP_DEBT_MAX_DAYS} days (plus today). Use a shorter range, or a start date with days.`
    );
  return { startTime, endTime };
}

export async function getSleepDebt(
  client: WhoopClient,
  params: z.infer<typeof sleepDebtInputSchema> = {},
  now: Date = new Date()
): Promise<SleepDebtReport> {
  const { days: requestedDays, start } = sleepDebtInputSchema.parse(params);
  const days = requestedDays ?? 14;
  // The user's current offset resolves local days in `start` and labels the reported period.
  const { offset: utcOffset, fallback: offsetFallback } = await resolveUserUtcOffsetInfo(client);
  const { startTime, endTime } = resolveSleepWindow(start, requestedDays, days, now, utcOffset);
  // Fetching and night selection use UTC instants; the reported period uses the user's offset.
  const period = { start: new Date(startTime).toISOString(), end: new Date(endTime).toISOString() };
  const reportedPeriod = {
    start: formatLocalTimestamp(startTime, utcOffset),
    // A bound before now is exclusive: report its last millisecond so the date is the last day covered.
    end: formatLocalTimestamp(endTime < now.getTime() ? endTime - 1 : endTime, utcOffset),
  };
  const source = await loadAnalyticsSource(client, ENDPOINT_SLEEP, period, sleepRecordSchema);
  if (source.quality.status === "fetch_failed") throw mostRelevantError([source.error]);
  const readable = source.quality.status !== "invalid";
  const selected = mainSleeps(source.records, period, source.quality).filter((night) => {
    const need = night.score!.sleep_needed;
    if (
      need.baseline_milli + need.need_from_recent_strain_milli + need.need_from_recent_nap_milli <
      0
    ) {
      exclude(source.quality, "invalid_need");
      return false;
    }
    return true;
  });
  const nights = selected.map((night) => {
    const need = night.score!.sleep_needed;
    const needed =
      (need.baseline_milli + need.need_from_recent_strain_milli + need.need_from_recent_nap_milli) /
      HOUR_MS;
    const achieved = asleepHours(night);
    return {
      date: localDay(night.end, night.timezone_offset),
      needed_hours: needed,
      achieved_hours: achieved,
      debt_hours: Math.max(0, needed - achieved),
    };
  });
  const bedtimes: number[] = [];
  const waketimes: number[] = [];
  const weekdays: number[] = [];
  const weekends: number[] = [];
  for (const night of selected) {
    const bedtime = localTime(night.start, night.timezone_offset);
    const wake = localTime(night.end, night.timezone_offset);
    const bedMinutes =
      bedtime.getUTCHours() * 60 + bedtime.getUTCMinutes() + bedtime.getUTCSeconds() / 60;
    bedtimes.push(bedMinutes);
    waketimes.push(wake.getUTCHours() * 60 + wake.getUTCMinutes() + wake.getUTCSeconds() / 60);
    const midpoint =
      (bedMinutes + (Date.parse(night.end) - Date.parse(night.start)) / 120_000) % 1440;
    (wake.getUTCDay() === 0 || wake.getUTCDay() === 6 ? weekends : weekdays).push(midpoint);
  }
  const weekdayMean = circularStats(weekdays).mean;
  const weekendMean = circularStats(weekends).mean;
  const midpointDistance =
    weekdayMean === null || weekendMean === null ? null : Math.abs(weekdayMean - weekendMean);
  const sufficient = nights.length >= SLEEP_DEBT_MIN_NIGHTS;
  finishQuality(source.quality, selected);
  const newestNight = selected[0];
  const oldestNight = selected[selected.length - 1];
  const observed =
    newestNight && oldestNight
      ? {
          start: formatLocalTimestamp(Date.parse(oldestNight.end), oldestNight.timezone_offset),
          end: formatLocalTimestamp(Date.parse(newestNight.end), newestNight.timezone_offset),
        }
      : null;
  const status = !readable ? "unavailable" : sufficient ? "available" : "insufficient_data";

  // Notes carry counts only (no dates or values), so they are kept in aggregate privacy mode.
  const notes: string[] = [];
  if (status === "unavailable")
    notes.push(
      "Sleep data could not be read: WHOOP returned data in an unexpected format, so no sleep debt was calculated. This does not mean no sleep was recorded."
    );
  else if (status === "insufficient_data")
    notes.push(
      `Not enough data yet: ${nights.length} of ${SLEEP_DEBT_MIN_NIGHTS} required scored main sleeps in this window, so deficit totals and bedtime/wake consistency are not calculated.`
    );
  const invalidRecords = source.quality.exclusions.invalid ?? 0;
  if (readable && invalidRecords)
    notes.push(
      `${plural(invalidRecords, "sleep record")} did not match the expected format and ${invalidRecords === 1 ? "was" : "were"} skipped.`
    );
  const pending = source.quality.exclusions.pending ?? 0;
  if (pending)
    notes.push(
      `${plural(pending, "sleep")} ${pending === 1 ? "is" : "are"} still being scored by WHOOP and not counted yet.`
    );
  const invalidNeed = source.quality.exclusions.invalid_need ?? 0;
  if (invalidNeed)
    notes.push(
      `${plural(invalidNeed, "sleep")} with an invalid WHOOP sleep-need value ${invalidNeed === 1 ? "was" : "were"} skipped.`
    );
  const partial = source.partialError !== undefined;
  if (partial)
    notes.push(
      "Partial history: a later page of sleep data could not be read from WHOOP, so older sleeps in the window were not included. Retry for a complete result."
    );
  else if (source.quality.truncated)
    notes.push(
      "Partial history: the WHOOP pagination limit was reached, so the oldest sleeps in the window were not read."
    );

  const lead =
    status === "available" ? "Sum of observed nightly deficits, not outstanding debt." : notes[0]!;
  const standing =
    status === "insufficient_data" && selected[0]
      ? " Standing debt is WHOOP's own figure from the most recent night."
      : "";
  return {
    period: reportedPeriod,
    nights_analyzed: nights.length,
    status,
    nights_required: SLEEP_DEBT_MIN_NIGHTS,
    total_debt_hours: sufficient
      ? nights.reduce((total, night) => total + night.debt_hours, 0)
      : null,
    avg_nightly_debt_hours: sufficient ? mean(nights.map((night) => night.debt_hours)) : null,
    standing_debt_hours: selected[0]
      ? selected[0].score!.sleep_needed.need_from_sleep_debt_milli / HOUR_MS
      : null,
    standing_debt_date: nights[0]?.date ?? null,
    consistency: {
      bedtime_std_dev_minutes: sufficient ? circularStats(bedtimes).sd : null,
      waketime_std_dev_minutes: sufficient ? circularStats(waketimes).sd : null,
      social_jetlag_minutes:
        sufficient && midpointDistance !== null
          ? Math.min(midpointDistance, 1440 - midpointDistance)
          : null,
    },
    nights: nights.slice(0, 30),
    output_capped: nights.length > 30,
    truncated: source.quality.truncated,
    summary: `${lead}${standing}${status === "available" ? " Social jetlag is a circular midpoint heuristic." : ""}${partial ? " Partial history: older sleeps could not be read." : source.quality.truncated ? " Partial history: pagination limit reached." : ""}`,
    notes: withOffsetNote(notes, offsetFallback),
    disclaimer: DISCLAIMER,
    data_quality: {
      evaluated_at: now.toISOString(),
      requested_period: reportedPeriod,
      observed_period: observed,
      sources: { sleep: source.quality },
      method_version: "sleep-debt-2",
      limitations: [
        "One recorded offset cannot reconstruct within-sleep DST changes.",
        "Deficit totals do not predict recovery or prescribe repayment.",
      ],
    },
  };
}
