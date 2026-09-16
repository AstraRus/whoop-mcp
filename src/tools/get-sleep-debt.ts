import { z } from "zod";
import type { WhoopClient } from "../api/client.js";
import { ENDPOINT_SLEEP } from "../api/endpoints.js";
import { sleepRecordSchema } from "../api/record-schemas.js";
import { dependsOnLocalDay, resolveUserUtcOffset } from "./collection-utils.js";
import { resolveDateExpression } from "./date-utils.js";
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
  observedPeriod,
  periodSchema,
  finishQuality,
  exclude,
} from "./analytics-utils.js";

/** Scored main sleeps needed before deficit totals and consistency are reported. */
export const SLEEP_DEBT_MIN_NIGHTS = 3;

export const sleepDebtInputSchema = z.object({
  days: z
    .number()
    .int()
    .min(3)
    .max(90)
    .optional()
    .describe(
      "Window length in days (3-90). Default: 14. Without `start` the window ends now; with `start` it runs forward from `start`, clamped to now."
    ),
  start: z
    .string()
    .max(100)
    .optional()
    .describe(
      'Window start: a date (YYYY-MM-DD, from local midnight), a date-time with offset, or a relative expression such as "yesterday" or "last 7 days" (its first day is used). Default: `days` before now.'
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

export async function getSleepDebt(
  client: WhoopClient,
  params: z.infer<typeof sleepDebtInputSchema> = {},
  now: Date = new Date()
): Promise<SleepDebtReport> {
  const { days = 14, start } = sleepDebtInputSchema.parse(params);
  const utcOffset = dependsOnLocalDay(start) ? await resolveUserUtcOffset(client) : "Z";
  const startTime = start
    ? Date.parse(resolveDateExpression(start, now, utcOffset).start)
    : now.getTime() - days * DAY_MS;
  const endTime = Math.min(startTime + days * DAY_MS, now.getTime());
  if (!Number.isFinite(startTime) || startTime >= endTime)
    throw new RangeError("Sleep window must begin before the evaluation time.");
  const period = { start: new Date(startTime).toISOString(), end: new Date(endTime).toISOString() };
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
  const observed = observedPeriod(selected.map((night) => night.end));
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
  if (source.quality.truncated)
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
    period,
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
    summary: `${lead}${standing}${status === "available" ? " Social jetlag is a circular midpoint heuristic." : ""}${source.quality.truncated ? " Partial history: pagination limit reached." : ""}`,
    notes,
    disclaimer: DISCLAIMER,
    data_quality: {
      evaluated_at: now.toISOString(),
      requested_period: period,
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
