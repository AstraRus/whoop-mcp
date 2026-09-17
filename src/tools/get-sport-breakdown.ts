/**
 * Tool: get_sport_breakdown
 *
 * Scored WHOOP workouts on the user's local days, grouped by sport: volume,
 * strain, energy, heart rate, WHOOP %max-HR zone shares, Edwards TRIMP, GPS
 * distance and pace with a beats-per-km efficiency trend, plus overall
 * shares, the intensity distribution and the time of day sessions start.
 *
 * - A session counts toward the local day of the WHOOP cycle containing its
 *   start (assignWorkouts), with cycles placed on days by their main sleeps
 *   exactly as get_calendar places them (split nights, daytime main sleeps;
 *   without complete sleeps, the day 12 hours after the cycle start, with a
 *   warning). A session of the open cycle is never placed after today.
 *   Workouts, cycles and sleeps are read as one snapshot of history over
 *   fetchRangeForDays, so after-midnight sessions on the last day are loaded.
 * - Unscored sessions never contribute values (counted in excluded.not_scored).
 *   Sessions below 90% recorded heart-rate data are included but left out of
 *   heart-rate derived values (heart rate, zones, TRIMP, beats per km).
 * - Means, medians and maxima need 3 sessions; zone shares are percentages of
 *   recorded zone minutes only, without any training-model label.
 */

import { z } from "zod";
import { HISTORY_LIMITATIONS } from "../api/history.js";
import type { Sleep } from "../api/types.js";
import {
  dataQualitySchema,
  DAY_MS,
  DISCLAIMER,
  exclude,
  finishQuality,
  formatLocalTimestamp,
  localDay,
  localMidnightMs,
  type DataQuality,
} from "./analytics-utils.js";
import { resolveUserUtcOffsetInfo, withOffsetNote } from "./collection-utils.js";
import { addDays, daysBetween, fetchRangeForDays, resolveDayWindow } from "./day-model.js";
import {
  buildSessions,
  coveredSinceMs,
  dayCovered,
  loadTrainingSources,
  observedSpan,
  placeTrainingDays,
  plural,
  roundPartsToTotal,
  SLEEP_PLACEMENT_WARNING,
  sleepsUsable,
  sourceUnreadable,
  sourceWarnings,
  throwIfAllFailed,
  trainingHistoryOptions,
  TARGETED_SLEEPS_NOTE,
  truncationNote,
  type TrainingSession,
} from "./get-training-load.js";
import {
  isConstant,
  linearRegressionXY,
  median,
  roundTo,
  trendConfidence,
  trendDirection,
} from "./stats-utils.js";
import type { ToolContext, ToolVariant } from "./tool-definition.js";
import { HR_ZONE_CAVEAT_SPORT, type ZoneMinutes } from "./workout-utils.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Days without `days` */
export const SPORT_BREAKDOWN_DEFAULT_DAYS = 30;

/** Fewest days `days` accepts */
export const SPORT_BREAKDOWN_MIN_DAYS = 7;

/** Longest window in local days */
export const SPORT_BREAKDOWN_MAX_DAYS = 365;

/** Sessions a mean, median or maximum needs */
export const SPORT_MIN_SESSIONS = 3;

/** Qualifying sessions the efficiency trend needs */
export const EFFICIENCY_TREND_MIN_SESSIONS = 6;

/** Days the efficiency trend's sessions must span */
export const EFFICIENCY_TREND_MIN_SPAN_DAYS = 14;

/** Shortest GPS distance (km) for the fastest pace and efficiency */
export const PACE_MIN_DISTANCE_KM = 1;

/** Fewest effective days before sessions_per_week is reported */
export const SESSIONS_PER_WEEK_MIN_DAYS = 7;

/** Share of zone 1-5 minutes from weightlifting-type sports above which a caveat note is added */
export const HR_ZONE_CAVEAT_SHARE = 0.2;

/** Most sports listed */
export const MAX_BREAKDOWN_SPORTS = 40;

/** Local start hours of the time-of-day buckets: morning 05-12, afternoon 12-17, evening 17-22, night 22-05 */
export const TIME_OF_DAY_HOURS = { morning: 5, afternoon: 12, evening: 17, night: 22 } as const;

const METHOD_VERSION = "sport-breakdown-1";

const INTENSITY_BASIS = "recorded minutes in WHOOP %max-HR zones 1-5 (zone 0 excluded)";

const BREAKDOWN_LIMITATIONS: readonly string[] = [
  "A session counts toward the local day of the WHOOP cycle containing its start, with cycles placed as get_calendar places them (the day their main sleep ended); a session after local midnight but before the next sleep belongs to the previous day.",
  "Heart-rate zones are WHOOP %max-HR zones, not lab-derived thresholds; TRIMP is Edwards TRIMP (zone number × zone minutes).",
  "Pace uses elapsed time over the whole session (pauses included), not moving time.",
];

// ---------------------------------------------------------------------------
// Session totals (shared with the aggregate variant)
// ---------------------------------------------------------------------------

/** Unrounded totals of a set of scored sessions */
export interface SessionTotals {
  sessions: number;
  activeDays: number;
  firstDay: string | null;
  lastDay: string | null;
  durationMinutes: number;
  recordedMinutes: number;
  kilojoule: number;
  kcal: number;
  strains: number[];
  durations: number[];
  /** Sessions with at least 90% recorded heart-rate data */
  hrSessions: number;
  hrRecordedMinutes: number;
  /** Σ average heart rate × recorded minutes over hrSessions */
  hrWeightedSum: number;
  peakHeartRate: number | null;
  /** Zone minutes over hrSessions */
  zones: ZoneMinutes;
  /** Edwards TRIMP over hrSessions */
  trimp: number;
  lowRecordingSessions: number;
  gps: {
    /** Sessions with a plausible GPS distance */
    sessions: number;
    suspectSessions: number;
    distanceKm: number;
    elapsedSeconds: number;
    altitudeGain: number | null;
    /** Fastest elapsed pace among sessions of at least PACE_MIN_DISTANCE_KM */
    fastestPace: number | null;
  };
}

function emptyZones(): ZoneMinutes {
  return { zone_0: 0, zone_1: 0, zone_2: 0, zone_3: 0, zone_4: 0, zone_5: 0 };
}

/** Totals of scored sessions (unscored ones must be filtered out first) */
export function sessionTotals(sessions: readonly TrainingSession[]): SessionTotals {
  const days = new Set<string>();
  const zones = emptyZones();
  const totals: SessionTotals = {
    sessions: sessions.length,
    activeDays: 0,
    firstDay: null,
    lastDay: null,
    durationMinutes: 0,
    recordedMinutes: 0,
    kilojoule: 0,
    kcal: 0,
    strains: [],
    durations: [],
    hrSessions: 0,
    hrRecordedMinutes: 0,
    hrWeightedSum: 0,
    peakHeartRate: null,
    zones,
    trimp: 0,
    lowRecordingSessions: 0,
    gps: {
      sessions: 0,
      suspectSessions: 0,
      distanceKm: 0,
      elapsedSeconds: 0,
      altitudeGain: null,
      fastestPace: null,
    },
  };
  for (const { summary, fullyRecorded } of sessions) {
    days.add(summary.day);
    if (totals.firstDay === null || summary.day < totals.firstDay) totals.firstDay = summary.day;
    if (totals.lastDay === null || summary.day > totals.lastDay) totals.lastDay = summary.day;
    totals.durationMinutes += summary.duration_minutes;
    totals.durations.push(summary.duration_minutes);
    totals.recordedMinutes += summary.recorded_minutes ?? 0;
    totals.kilojoule += summary.kilojoule ?? 0;
    totals.kcal += summary.kcal ?? 0;
    if (summary.strain !== null) totals.strains.push(summary.strain);
    if (fullyRecorded && summary.zone_minutes !== null) {
      const recorded = summary.recorded_minutes ?? 0;
      totals.hrSessions += 1;
      totals.hrRecordedMinutes += recorded;
      totals.hrWeightedSum += (summary.average_heart_rate ?? 0) * recorded;
      if (summary.max_heart_rate !== null) {
        totals.peakHeartRate = Math.max(totals.peakHeartRate ?? 0, summary.max_heart_rate);
      }
      zones.zone_0 += summary.zone_minutes.zone_0;
      zones.zone_1 += summary.zone_minutes.zone_1;
      zones.zone_2 += summary.zone_minutes.zone_2;
      zones.zone_3 += summary.zone_minutes.zone_3;
      zones.zone_4 += summary.zone_minutes.zone_4;
      zones.zone_5 += summary.zone_minutes.zone_5;
      totals.trimp += summary.trimp ?? 0;
    } else {
      totals.lowRecordingSessions += 1;
    }
    const gps = summary.gps;
    if (gps !== null) {
      if (summary.flags.includes("gps_suspect")) {
        totals.gps.suspectSessions += 1;
      } else {
        totals.gps.sessions += 1;
        totals.gps.distanceKm += gps.distance_km;
        totals.gps.elapsedSeconds += summary.duration_minutes * 60;
        if (gps.altitude_gain_m !== null) {
          totals.gps.altitudeGain = (totals.gps.altitudeGain ?? 0) + gps.altitude_gain_m;
        }
        if (
          gps.distance_km >= PACE_MIN_DISTANCE_KM &&
          (totals.gps.fastestPace === null || gps.avg_pace_sec_per_km < totals.gps.fastestPace)
        ) {
          totals.gps.fastestPace = gps.avg_pace_sec_per_km;
        }
      }
    }
  }
  totals.activeDays = days.size;
  return totals;
}

/** Zone shares (percent of recorded zone minutes, zone 0 included); null without minutes */
export function zoneShares(zones: ZoneMinutes): ZoneMinutes | null {
  const total =
    zones.zone_0 + zones.zone_1 + zones.zone_2 + zones.zone_3 + zones.zone_4 + zones.zone_5;
  if (!(total > 0)) return null;
  return {
    zone_0: (100 * zones.zone_0) / total,
    zone_1: (100 * zones.zone_1) / total,
    zone_2: (100 * zones.zone_2) / total,
    zone_3: (100 * zones.zone_3) / total,
    zone_4: (100 * zones.zone_4) / total,
    zone_5: (100 * zones.zone_5) / total,
  };
}

/** Zone shares rounded so they sum to exactly 100 */
export function roundZoneShares(shares: ZoneMinutes, digits: number): ZoneMinutes {
  const [zone_0, zone_1, zone_2, zone_3, zone_4, zone_5] = roundPartsToTotal(
    [shares.zone_0, shares.zone_1, shares.zone_2, shares.zone_3, shares.zone_4, shares.zone_5],
    digits
  ) as [number, number, number, number, number, number];
  return { zone_0, zone_1, zone_2, zone_3, zone_4, zone_5 };
}

/** Weighted average heart rate (Σ avgHR × recorded / Σ recorded); null without recorded minutes */
export function weightedHeartRate(totals: SessionTotals): number | null {
  return totals.hrRecordedMinutes > 0 ? totals.hrWeightedSum / totals.hrRecordedMinutes : null;
}

/** Case-insensitive sport matching key */
export function sportKey(name: string): string {
  return name.trim().toLowerCase();
}

/** Compare sport names for a stable order */
export function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const sportBreakdownInputSchema = z.object({
  days: z
    .number()
    .int()
    .min(SPORT_BREAKDOWN_MIN_DAYS)
    .max(SPORT_BREAKDOWN_MAX_DAYS)
    .optional()
    .describe(
      "Local days (7-365). Default 30. Without start the window ends today; with a single-day start it runs forward from it."
    ),
  start: z
    .string()
    .max(100)
    .optional()
    .describe(
      'Where the window starts, as in get_calendar: a range expression ("last 30 days", "this month", "last week", "YYYY-MM") covers that range up to today (at most 365 days) unless days is also given; a single day (YYYY-MM-DD, "yesterday") or a date-time starts the window and it runs forward days days, clamped to today.'
    ),
  sport: z
    .string()
    .max(100)
    .optional()
    .describe("Only this sport: exact WHOOP sport_name, case-insensitive (e.g. running)."),
  min_recorded_fraction: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      "Leave out sessions that recorded less than this fraction of heart-rate data (0-1). Default 0 includes all; sessions below 0.9 still count but are left out of heart-rate statistics."
    ),
});

export type SportBreakdownInput = z.infer<typeof sportBreakdownInputSchema>;

const nullableNumber = z.number().nullable();

const zonesSchema = z.object({
  zone_0: z.number(),
  zone_1: z.number(),
  zone_2: z.number(),
  zone_3: z.number(),
  zone_4: z.number(),
  zone_5: z.number(),
});

const efficiencySchema = z.object({
  metric: z.literal("beats_per_km"),
  better_when: z.literal("lower"),
  qualifying_sessions: z
    .number()
    .int()
    .describe(
      "GPS sessions of at least 1 km with 90% recorded heart-rate data and plausible speed"
    ),
  latest: nullableNumber,
  median: nullableNumber,
  trend: z.object({
    status: z.enum(["available", "insufficient_data"]),
    slope_per_week: nullableNumber.describe("Change in beats per km per week"),
    change: z.enum(["improving", "declining", "stable"]).nullable(),
    confidence: z.enum(["high", "medium", "low"]).nullable(),
  }),
});

const sportSchema = z.object({
  sport_name: z.string(),
  sport_id: z.number().int().nullable().describe("Deprecated WHOOP sport id; 0 is running"),
  status: z.enum(["available", "few_sessions"]),
  sessions: z.number().int(),
  active_days: z.number().int(),
  sessions_per_week: nullableNumber,
  first_day: z.string(),
  last_day: z.string(),
  duration_minutes: z.object({ total: z.number(), mean: nullableNumber, median: nullableNumber }),
  recorded_minutes_total: z.number().describe("Heart-rate zone minutes of every included session"),
  strain: z.object({ mean: nullableNumber, median: nullableNumber, max: nullableNumber }),
  kilojoule: z.object({ total: z.number(), mean: nullableNumber }),
  kcal: z.object({ total: z.number(), mean: nullableNumber }),
  heart_rate: z.object({
    weighted_average: nullableNumber.describe(
      "Σ average HR × recorded minutes / Σ recorded minutes"
    ),
    peak: nullableNumber,
    sessions_used: z.number().int(),
  }),
  zone_minutes: zonesSchema.nullable().describe("Sessions with 90% recorded heart-rate data"),
  zone_share_pct: zonesSchema.nullable(),
  trimp: z.object({
    total: nullableNumber,
    mean: nullableNumber,
    per_hour: nullableNumber.describe("TRIMP per hour of recorded zone minutes"),
    sessions_used: z.number().int(),
  }),
  high_intensity_minutes: nullableNumber.describe("Zone 4 + zone 5 minutes"),
  low_recording_sessions: z
    .number()
    .int()
    .describe(
      "Included sessions below 90% recorded heart-rate data (left out of heart-rate values)"
    ),
  gps: z
    .object({
      sessions: z.number().int(),
      suspect_sessions: z
        .number()
        .int()
        .describe("GPS sessions with an implausible speed, left out of distance and pace"),
      distance_km_total: z.number(),
      distance_km_mean: nullableNumber,
      avg_pace_sec_per_km: nullableNumber.describe(
        "Σ elapsed seconds / Σ km (time-weighted, pauses included)"
      ),
      fastest_session_pace_sec_per_km: nullableNumber,
      altitude_gain_m_total: nullableNumber,
      efficiency: efficiencySchema,
    })
    .nullable(),
  excluded: z.object({
    not_scored: z.number().int(),
    low_recording: z.number().int().describe("Sessions below min_recorded_fraction"),
  }),
});

export const sportBreakdownOutputSchema = z.object({
  status: z.enum(["available", "no_workouts", "unavailable"]),
  period: z.object({
    start_day: z.string(),
    end_day: z.string(),
    days: z.number().int(),
    utc_offset: z.string(),
  }),
  filters: z.object({ sport: z.string().nullable(), min_recorded_fraction: z.number() }),
  sports: z.array(sportSchema),
  output_capped: z.boolean(),
  overall: z.object({
    sessions: z.number().int(),
    active_days: z.number().int(),
    worn_days: z.number().int().nullable(),
    duration_minutes_total: z.number(),
    trimp_total: nullableNumber,
    kilojoule_total: z.number(),
    kcal_total: z.number(),
    share_by_sport: z.array(
      z.object({
        sport_name: z.string(),
        sessions_pct: z.number(),
        minutes_pct: nullableNumber,
        trimp_pct: nullableNumber,
      })
    ),
    intensity_distribution: z.object({
      basis: z.literal(INTENSITY_BASIS),
      low_pct: nullableNumber.describe("Zones 1-3"),
      moderate_pct: nullableNumber.describe("Zone 4"),
      high_pct: nullableNumber.describe("Zone 5"),
      minutes: z.number(),
    }),
    time_of_day: z
      .object({
        morning: z.number().int(),
        afternoon: z.number().int(),
        evening: z.number().int(),
        night: z.number().int(),
      })
      .describe(
        "Sessions by local start hour: morning 05-12, afternoon 12-17, evening 17-22, night 22-05"
      ),
  }),
  truncated: z.boolean(),
  notes: z.array(z.string()),
  warnings: z.array(z.string()),
  disclaimer: z.string(),
  data_quality: dataQualitySchema,
});

export type SportBreakdownOutput = z.infer<typeof sportBreakdownOutputSchema>;
type SportEntry = z.infer<typeof sportSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Time-of-day bucket of a local start hour */
export function timeOfDayBucket(hour: number): "morning" | "afternoon" | "evening" | "night" {
  if (hour >= TIME_OF_DAY_HOURS.morning && hour < TIME_OF_DAY_HOURS.afternoon) return "morning";
  if (hour >= TIME_OF_DAY_HOURS.afternoon && hour < TIME_OF_DAY_HOURS.evening) return "afternoon";
  if (hour >= TIME_OF_DAY_HOURS.evening && hour < TIME_OF_DAY_HOURS.night) return "evening";
  return "night";
}

function meanOf(values: readonly number[]): number | null {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function roundZones(zones: ZoneMinutes, digits: number): ZoneMinutes {
  return {
    zone_0: roundTo(zones.zone_0, digits),
    zone_1: roundTo(zones.zone_1, digits),
    zone_2: roundTo(zones.zone_2, digits),
    zone_3: roundTo(zones.zone_3, digits),
    zone_4: roundTo(zones.zone_4, digits),
    zone_5: roundTo(zones.zone_5, digits),
  };
}

/** The beats-per-km efficiency block of one sport's GPS sessions */
export function efficiencyOf(
  sessions: readonly TrainingSession[]
): z.infer<typeof efficiencySchema> {
  const qualifying = sessions
    .filter(
      (session) =>
        session.fullyRecorded &&
        session.summary.gps !== null &&
        session.summary.gps.beats_per_km !== null &&
        session.summary.gps.distance_km >= PACE_MIN_DISTANCE_KM &&
        !session.summary.flags.includes("gps_suspect")
    )
    .sort((left, right) => left.startMs - right.startMs);
  const values = qualifying.map((session) => session.summary.gps!.beats_per_km!);
  const latest = values.length > 0 ? values[values.length - 1]! : null;
  const trend: z.infer<typeof efficiencySchema>["trend"] = {
    status: "insufficient_data",
    slope_per_week: null,
    change: null,
    confidence: null,
  };
  const first = qualifying[0];
  const last = qualifying[qualifying.length - 1];
  if (
    first !== undefined &&
    last !== undefined &&
    qualifying.length >= EFFICIENCY_TREND_MIN_SESSIONS &&
    (last.startMs - first.startMs) / DAY_MS >= EFFICIENCY_TREND_MIN_SPAN_DAYS
  ) {
    const xs = qualifying.map((session) => (session.startMs - first.startMs) / DAY_MS);
    const { slope, r2 } = linearRegressionXY(xs, values);
    trend.status = "available";
    trend.slope_per_week = roundTo(slope * 7, 1);
    // Fewer beats per km is better, so a falling line counts as improving.
    trend.change = trendDirection(-slope, r2);
    trend.confidence = trendConfidence(r2, values.length, isConstant(values));
  }
  return {
    metric: "beats_per_km",
    better_when: "lower",
    qualifying_sessions: qualifying.length,
    latest: roundTo(latest, 0),
    median: values.length >= SPORT_MIN_SESSIONS ? roundTo(median(values), 0) : null,
    trend,
  };
}

function sportEntry(
  sportName: string,
  sessions: readonly TrainingSession[],
  excluded: { not_scored: number; low_recording: number },
  effectiveDays: number | null
): SportEntry {
  const totals = sessionTotals(sessions);
  const n = totals.sessions;
  const enough = n >= SPORT_MIN_SESSIONS;
  const hrEnough = totals.hrSessions >= SPORT_MIN_SESSIONS;
  const ids = new Set(sessions.map((session) => session.summary.sport_id));
  const sportId = ids.size === 1 ? ([...ids][0] ?? null) : null;
  const gpsSessions = sessions.filter((session) => session.summary.gps !== null);
  const gpsEnough = totals.gps.sessions >= SPORT_MIN_SESSIONS;
  const shares = totals.hrSessions > 0 ? zoneShares(totals.zones) : null;
  return {
    sport_name: sportName,
    sport_id: sportId,
    status: enough ? "available" : "few_sessions",
    sessions: n,
    active_days: totals.activeDays,
    sessions_per_week:
      effectiveDays !== null && effectiveDays >= SESSIONS_PER_WEEK_MIN_DAYS
        ? roundTo(n / (effectiveDays / 7), 1)
        : null,
    first_day: totals.firstDay ?? "",
    last_day: totals.lastDay ?? "",
    duration_minutes: {
      total: roundTo(totals.durationMinutes, 1),
      mean: enough ? roundTo(totals.durationMinutes / n, 1) : null,
      median: enough ? roundTo(median(totals.durations), 1) : null,
    },
    recorded_minutes_total: roundTo(totals.recordedMinutes, 1),
    strain: {
      mean: enough ? roundTo(meanOf(totals.strains), 2) : null,
      median: enough && totals.strains.length > 0 ? roundTo(median(totals.strains), 2) : null,
      max: enough && totals.strains.length > 0 ? roundTo(Math.max(...totals.strains), 2) : null,
    },
    kilojoule: {
      total: roundTo(totals.kilojoule, 0),
      mean: enough ? roundTo(totals.kilojoule / n, 0) : null,
    },
    kcal: { total: roundTo(totals.kcal, 0), mean: enough ? roundTo(totals.kcal / n, 0) : null },
    heart_rate: {
      weighted_average: hrEnough ? roundTo(weightedHeartRate(totals), 0) : null,
      peak: hrEnough ? roundTo(totals.peakHeartRate, 0) : null,
      sessions_used: totals.hrSessions,
    },
    zone_minutes: totals.hrSessions > 0 ? roundZones(totals.zones, 1) : null,
    zone_share_pct: shares ? roundZoneShares(shares, 1) : null,
    trimp: {
      total: totals.hrSessions > 0 ? roundTo(totals.trimp, 1) : null,
      mean: hrEnough ? roundTo(totals.trimp / totals.hrSessions, 1) : null,
      per_hour:
        hrEnough && totals.hrRecordedMinutes > 0
          ? roundTo(totals.trimp / (totals.hrRecordedMinutes / 60), 1)
          : null,
      sessions_used: totals.hrSessions,
    },
    high_intensity_minutes:
      totals.hrSessions > 0 ? roundTo(totals.zones.zone_4 + totals.zones.zone_5, 1) : null,
    low_recording_sessions: totals.lowRecordingSessions,
    gps:
      gpsSessions.length === 0
        ? null
        : {
            sessions: totals.gps.sessions,
            suspect_sessions: totals.gps.suspectSessions,
            distance_km_total: roundTo(totals.gps.distanceKm, 2),
            distance_km_mean: gpsEnough
              ? roundTo(totals.gps.distanceKm / totals.gps.sessions, 2)
              : null,
            avg_pace_sec_per_km:
              gpsEnough && totals.gps.distanceKm > 0
                ? roundTo(totals.gps.elapsedSeconds / totals.gps.distanceKm, 0)
                : null,
            fastest_session_pace_sec_per_km: gpsEnough ? roundTo(totals.gps.fastestPace, 0) : null,
            altitude_gain_m_total: roundTo(totals.gps.altitudeGain, 0),
            efficiency: efficiencyOf(gpsSessions),
          },
    excluded: { ...excluded },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Run get_sport_breakdown.
 *
 * @throws InvalidDateExpression for an unparseable start
 * @throws the most relevant WHOOP error when both workouts and cycles fail to load
 */
export async function getSportBreakdown(
  args: SportBreakdownInput,
  ctx: ToolContext
): Promise<SportBreakdownOutput> {
  const now = ctx.now();
  const nowMs = now.getTime();
  const { offset: utcOffset, fallback: offsetFallback } = await resolveUserUtcOffsetInfo(
    ctx.client
  );
  const today = localDay(now.toISOString(), utcOffset);
  const minFraction = args.min_recorded_fraction ?? 0;
  const sportFilter = args.sport !== undefined ? sportKey(args.sport) : null;
  const window = resolveDayWindow(
    {
      ...(args.days !== undefined ? { days: args.days } : {}),
      ...(args.start !== undefined ? { start: args.start } : {}),
    },
    now,
    utcOffset,
    {
      defaultDays: SPORT_BREAKDOWN_DEFAULT_DAYS,
      maxDays: SPORT_BREAKDOWN_MAX_DAYS,
      noun: "breakdown",
    }
  );
  const { firstDay, lastDay } = window;
  const notes: string[] = [...window.notes];
  const warnings: string[] = [];
  const windowDays = Math.max(0, daysBetween(firstDay, lastDay) + 1);
  const requestedPeriod = {
    start: formatLocalTimestamp(localMidnightMs(firstDay, utcOffset), utcOffset),
    end: formatLocalTimestamp(localMidnightMs(addDays(lastDay, 1), utcOffset) - 1, utcOffset),
  };
  const filters = { sport: args.sport ?? null, min_recorded_fraction: minFraction };
  const emptyOverall: SportBreakdownOutput["overall"] = {
    sessions: 0,
    active_days: 0,
    worn_days: null,
    duration_minutes_total: 0,
    trimp_total: 0,
    kilojoule_total: 0,
    kcal_total: 0,
    share_by_sport: [],
    intensity_distribution: {
      basis: INTENSITY_BASIS,
      low_pct: null,
      moderate_pct: null,
      high_pct: null,
      minutes: 0,
    },
    time_of_day: { morning: 0, afternoon: 0, evening: 0, night: 0 },
  };
  const evaluatedAt = formatLocalTimestamp(nowMs, utcOffset);

  if (firstDay > today) {
    const fromDateTime = window.fromDateTime
      ? " (a date-time start counts from its nearest local midnight)"
      : "";
    return {
      status: "no_workouts",
      period: { start_day: firstDay, end_day: firstDay, days: 0, utc_offset: utcOffset },
      filters,
      sports: [],
      output_capped: false,
      overall: emptyOverall,
      truncated: false,
      notes: withOffsetNote(
        [
          ...notes,
          `The start date ${firstDay}${fromDateTime} is after today (${today}); there are no days to break down.`,
        ],
        offsetFallback
      ),
      warnings,
      disclaimer: DISCLAIMER,
      data_quality: {
        evaluated_at: evaluatedAt,
        requested_period: requestedPeriod,
        observed_period: null,
        sources: {},
        method_version: METHOD_VERSION,
        limitations: [...HISTORY_LIMITATIONS, ...BREAKDOWN_LIMITATIONS],
      },
    };
  }

  // --- Load ------------------------------------------------------------------

  const range = fetchRangeForDays(firstDay, lastDay, utcOffset, nowMs);
  const { cycles, workouts, sleeps, sleepsTargeted, ...loaded } = await loadTrainingSources(
    ctx,
    trainingHistoryOptions(ctx),
    range.startMs,
    range.endMs
  );
  warnings.push(...loaded.warnings);
  throwIfAllFailed([cycles, workouts]);
  const cyclesAvailable = !sourceUnreadable(cycles);
  const workoutsAvailable = !sourceUnreadable(workouts);
  warnings.push(
    ...sourceWarnings("Workout", workouts, "no sport can be broken down"),
    ...sourceWarnings(
      "Cycle",
      cycles,
      "sessions are placed on their local start day and worn days are unknown"
    )
  );
  const truncated =
    cycles.quality.truncated || workouts.quality.truncated || sleeps.quality.truncated;
  const workoutQuality = workouts.quality;
  const cycleQuality = cycles.quality;
  const sleepQuality = sleeps.quality;

  // --- Place ------------------------------------------------------------------------

  const sleepsPlaced = cyclesAvailable && sleepsUsable(sleeps);
  if (cyclesAvailable && !sleepsPlaced) warnings.push(SLEEP_PLACEMENT_WARNING);
  if (sleepsPlaced && sleepsTargeted) notes.push(TARGETED_SLEEPS_NOTE);
  const placement = placeTrainingDays({
    cycles: cyclesAvailable ? cycles.records : [],
    sleeps: sleeps.records,
    sleepsAvailable: sleepsPlaced,
    today,
    utcOffset,
  });
  const sessions = workoutsAvailable
    ? buildSessions(
        workouts.records,
        placement,
        cyclesAvailable ? cycles.records : [],
        workoutQuality,
        today
      )
    : [];
  const inWindow = (day: string): boolean => day >= firstDay && day <= lastDay;

  const usedCycles = cyclesAvailable
    ? cycles.records.filter((cycle) => {
        const day = placement.dayOfCycle.get(cycle.id);
        const placed =
          day !== undefined && inWindow(day) && placement.cycleByDay.get(day) === cycle;
        if (!placed) exclude(cycleQuality, "outside_window");
        return placed;
      })
    : [];
  const wornDays = cyclesAvailable
    ? [...placement.cycleByDay.keys()].filter((day) => inWindow(day)).length
    : null;

  // The first worn day bounds sessions_per_week when wear started inside the window.
  let effectiveStart = firstDay;
  if (cyclesAvailable && dayCovered(firstDay, coveredSinceMs(cycles), utcOffset)) {
    const placedDays = [...placement.cycleByDay.keys()].filter((day) => day <= lastDay).sort();
    const firstPlaced = placedDays[0];
    if (firstPlaced !== undefined && firstPlaced > firstDay) effectiveStart = firstPlaced;
  }
  const effectiveDays = daysBetween(effectiveStart, lastDay) + 1;

  // --- Filter ----------------------------------------------------------------------

  const presentSports = new Map<string, number>();
  const bySport = new Map<
    string,
    { sessions: TrainingSession[]; not_scored: number; low_recording: number }
  >();
  const entryFor = (
    name: string
  ): { sessions: TrainingSession[]; not_scored: number; low_recording: number } => {
    let entry = bySport.get(name);
    if (!entry) {
      entry = { sessions: [], not_scored: 0, low_recording: 0 };
      bySport.set(name, entry);
    }
    return entry;
  };
  const included: TrainingSession[] = [];
  let notScored = 0;
  let belowFraction = 0;
  for (const session of sessions) {
    const summary = session.summary;
    if (!inWindow(summary.day)) {
      exclude(workoutQuality, "outside_window");
      continue;
    }
    presentSports.set(summary.sport_name, (presentSports.get(summary.sport_name) ?? 0) + 1);
    if (sportFilter !== null && sportKey(summary.sport_name) !== sportFilter) {
      exclude(workoutQuality, "filtered_out");
      continue;
    }
    if (!session.scored) {
      exclude(workoutQuality, session.pending ? "pending" : "unscored");
      entryFor(summary.sport_name).not_scored += 1;
      notScored += 1;
      continue;
    }
    if ((summary.recorded_fraction ?? 0) < minFraction) {
      exclude(workoutQuality, "below_min_recorded_fraction");
      entryFor(summary.sport_name).low_recording += 1;
      belowFraction += 1;
      continue;
    }
    entryFor(summary.sport_name).sessions.push(session);
    included.push(session);
  }

  // --- Sports -------------------------------------------------------------------------

  const totals = sessionTotals(included);
  const allSports = [...bySport.entries()]
    .filter(([, entry]) => entry.sessions.length > 0)
    .map(([name, entry]) => ({
      name,
      sessions: entry.sessions,
      totals: sessionTotals(entry.sessions),
      entry: sportEntry(
        name,
        entry.sessions,
        { not_scored: entry.not_scored, low_recording: entry.low_recording },
        effectiveDays
      ),
    }))
    .sort(
      (left, right) =>
        right.totals.sessions - left.totals.sessions ||
        right.totals.durationMinutes - left.totals.durationMinutes ||
        compareNames(left.name, right.name)
    );
  const listed = allSports.slice(0, MAX_BREAKDOWN_SPORTS);
  const outputCapped = allSports.length > listed.length;

  /** Percent shares of one whole, rounded to sum to 100; nulls when the whole is not above 0 */
  const sharesOf = (parts: readonly number[], whole: number): (number | null)[] =>
    whole > 0
      ? roundPartsToTotal(
          parts.map((part) => (100 * part) / whole),
          1
        )
      : parts.map(() => null);
  const intensityMinutes =
    totals.zones.zone_1 +
    totals.zones.zone_2 +
    totals.zones.zone_3 +
    totals.zones.zone_4 +
    totals.zones.zone_5;
  const sessionShares = sharesOf(
    allSports.map((sport) => sport.totals.sessions),
    totals.sessions
  );
  const minuteShares = sharesOf(
    allSports.map((sport) => sport.totals.durationMinutes),
    totals.durationMinutes
  );
  const trimpShares = sharesOf(
    allSports.map((sport) => sport.totals.trimp),
    totals.trimp
  );
  const intensityShares = sharesOf(
    [
      totals.zones.zone_1 + totals.zones.zone_2 + totals.zones.zone_3,
      totals.zones.zone_4,
      totals.zones.zone_5,
    ],
    intensityMinutes
  );
  const timeOfDay = { morning: 0, afternoon: 0, evening: 0, night: 0 };
  for (const session of included) {
    timeOfDay[timeOfDayBucket(Number(session.summary.start_local.slice(11, 13)))] += 1;
  }

  const overall: SportBreakdownOutput["overall"] = {
    sessions: totals.sessions,
    active_days: totals.activeDays,
    worn_days: wornDays,
    duration_minutes_total: roundTo(totals.durationMinutes, 1),
    trimp_total:
      totals.hrSessions > 0 ? roundTo(totals.trimp, 1) : totals.sessions === 0 ? 0 : null,
    kilojoule_total: roundTo(totals.kilojoule, 0),
    kcal_total: roundTo(totals.kcal, 0),
    share_by_sport: listed.map((sport, index) => ({
      sport_name: sport.name,
      sessions_pct: sessionShares[index] ?? 0,
      minutes_pct: minuteShares[index] ?? null,
      trimp_pct: totals.hrSessions > 0 ? (trimpShares[index] ?? null) : null,
    })),
    intensity_distribution: {
      basis: INTENSITY_BASIS,
      low_pct: intensityShares[0] ?? null,
      moderate_pct: intensityShares[1] ?? null,
      high_pct: intensityShares[2] ?? null,
      minutes: roundTo(intensityMinutes, 1),
    },
    time_of_day: timeOfDay,
  };

  // --- Status and notes ----------------------------------------------------------------

  let status: SportBreakdownOutput["status"];
  if (!workoutsAvailable) status = "unavailable";
  else if (included.length > 0) status = "available";
  else status = "no_workouts";

  if (workoutsAvailable && sportFilter !== null) {
    const matched = [...presentSports.keys()].some((name) => sportKey(name) === sportFilter);
    if (!matched) {
      const names = [...presentSports.keys()].sort(compareNames).slice(0, MAX_BREAKDOWN_SPORTS);
      notes.push(
        names.length > 0
          ? `No session of "${args.sport}" in this window; sports present: ${names.join(", ")}.`
          : `No session of "${args.sport}" in this window, and no other sessions either.`
      );
    }
  }
  // No cycle (or none readable) and no workout of any state placed in the window.
  if (workoutsAvailable && presentSports.size === 0 && (wornDays ?? 0) === 0) {
    notes.push("No WHOOP data for this window.");
  }
  const fewSports = listed.filter((sport) => sport.entry.status === "few_sessions").length;
  if (fewSports > 0) {
    notes.push(
      `${plural(fewSports, "sport")} ${fewSports === 1 ? "has" : "have"} fewer than ${SPORT_MIN_SESSIONS} sessions (status few_sessions): means, medians and maxima are null there.`
    );
  }
  if (included.length > 0 && effectiveDays < SESSIONS_PER_WEEK_MIN_DAYS) {
    notes.push(
      `sessions_per_week is null: the window covers only ${plural(effectiveDays, "day")} of wear (from ${effectiveStart}); ${SESSIONS_PER_WEEK_MIN_DAYS} are needed.`
    );
  } else if (included.length > 0 && effectiveStart > firstDay) {
    notes.push(
      `sessions_per_week counts from the first worn day in the window (${effectiveStart}), ${plural(effectiveDays, "day")}.`
    );
  }
  if (notScored > 0) {
    notes.push(
      `${plural(notScored, "session")} WHOOP has not scored (pending or unscorable) ${notScored === 1 ? "is" : "are"} left out of every value (excluded.not_scored).`
    );
  }
  if (belowFraction > 0) {
    notes.push(
      `${plural(belowFraction, "session")} recorded less than ${minFraction} of heart-rate data and ${belowFraction === 1 ? "is" : "are"} left out (excluded.low_recording).`
    );
  }
  if (totals.lowRecordingSessions > 0) {
    notes.push(
      `${plural(totals.lowRecordingSessions, "session")} recorded less than 90% heart-rate data: counted in sessions, duration, strain and energy, but left out of heart rate, zones, TRIMP and beats per km (heart_rate.sessions_used).`
    );
  }
  for (const sport of listed) {
    const efficiency = sport.entry.gps?.efficiency;
    if (!efficiency || efficiency.qualifying_sessions === 0) continue;
    if (efficiency.trend.status === "insufficient_data") {
      notes.push(
        `The beats-per-km trend for ${sport.name} needs ${EFFICIENCY_TREND_MIN_SESSIONS} qualifying sessions spanning ${EFFICIENCY_TREND_MIN_SPAN_DAYS} days (${efficiency.qualifying_sessions} of ${EFFICIENCY_TREND_MIN_SESSIONS} so far).`
      );
    }
  }
  if (listed.some((sport) => sport.entry.gps?.efficiency.qualifying_sessions)) {
    notes.push(
      "Beats per km (average heart rate × recorded minutes per km) also moves with heat, terrain, pauses (elapsed time) and GPS error; it is a within-sport comparison over time, not a fitness score."
    );
  }
  const suspect = totals.gps.suspectSessions;
  if (suspect > 0) {
    notes.push(
      `${plural(suspect, "GPS session")} with an implausible speed ${suspect === 1 ? "is" : "are"} left out of distance, pace and beats per km.`
    );
  }
  if (intensityMinutes > 0) {
    const caveatMinutes = included
      .filter(
        (session) => session.fullyRecorded && HR_ZONE_CAVEAT_SPORT.test(session.summary.sport_name)
      )
      .reduce((sum, session) => {
        const zones = session.summary.zone_minutes;
        return zones
          ? sum + zones.zone_1 + zones.zone_2 + zones.zone_3 + zones.zone_4 + zones.zone_5
          : sum;
      }, 0);
    if (caveatMinutes / intensityMinutes > HR_ZONE_CAVEAT_SHARE) {
      notes.push(
        `Weightlifting-type sessions make up ${roundTo((100 * caveatMinutes) / intensityMinutes, 0)}% of the zone 1-5 minutes; heart-rate zones understate the effort of strength work, so the intensity distribution leans low for them.`
      );
    }
  }
  if (outputCapped) {
    notes.push(
      `sports lists the ${MAX_BREAKDOWN_SPORTS} sports with the most sessions; overall covers all ${allSports.length}.`
    );
  }
  const fallback = included.filter((session) => session.cycleId === null).length;
  if (fallback > 0 && cyclesAvailable) {
    warnings.push(
      `${plural(fallback, "workout")} had no containing WHOOP cycle and ${fallback === 1 ? "was" : "were"} placed on ${fallback === 1 ? "its" : "their"} local start day.`
    );
  }
  for (const [label, source] of [
    ["Workout", workouts],
    ["Cycle", cycles],
  ] as const) {
    const note = truncationNote(
      label,
      source,
      utcOffset,
      label === "Workout"
        ? "the breakdown may miss older sessions"
        : "worn days may be undercounted"
    );
    if (note !== null) notes.push(note);
  }

  // --- Data quality ----------------------------------------------------------------------

  const updatedAt = new Map(workouts.records.map((workout) => [workout.id, workout.updated_at]));
  finishQuality(
    workoutQuality,
    included.map((session) => ({ updated_at: updatedAt.get(session.summary.id) ?? "" }))
  );
  finishQuality(cycleQuality, usedCycles);
  // Main sleeps are used to place the cycles used.
  const usedCycleIds = new Set(usedCycles.map((cycle) => cycle.id));
  const usedSleeps: Sleep[] = [];
  if (sleepsPlaced) {
    for (const sleep of sleeps.records) {
      if (sleep.nap) exclude(sleepQuality, "nap");
      else if (
        usedCycleIds.has(sleep.cycle_id) &&
        placement.mainSleepByCycle.get(sleep.cycle_id)?.id === sleep.id
      ) {
        usedSleeps.push(sleep);
      } else exclude(sleepQuality, "outside_window");
    }
  }
  finishQuality(sleepQuality, usedSleeps);
  const dataQuality: DataQuality = {
    evaluated_at: evaluatedAt,
    requested_period: requestedPeriod,
    observed_period: observedSpan(
      included.map((session) => ({
        startMs: session.startMs,
        endMs: session.endMs,
        offset: session.summary.timezone_offset,
      }))
    ),
    sources: { workouts: workoutQuality, cycles: cycleQuality, sleeps: sleepQuality },
    method_version: METHOD_VERSION,
    limitations: [...HISTORY_LIMITATIONS, ...BREAKDOWN_LIMITATIONS],
  };

  return {
    status,
    period: { start_day: firstDay, end_day: lastDay, days: windowDays, utc_offset: utcOffset },
    filters,
    sports: listed.map((sport) => sport.entry),
    output_capped: outputCapped,
    overall,
    truncated,
    notes: withOffsetNote(notes, offsetFallback),
    warnings,
    disclaimer: DISCLAIMER,
    data_quality: dataQuality,
  };
}

// ---------------------------------------------------------------------------
// Tool variant
// ---------------------------------------------------------------------------

export const SPORT_BREAKDOWN_TOOL_NAME = "get_sport_breakdown";

/** The standard-mode variant of get_sport_breakdown */
export const SPORT_BREAKDOWN_STANDARD: ToolVariant<
  typeof sportBreakdownInputSchema,
  typeof sportBreakdownOutputSchema
> = {
  title: "Sport breakdown",
  description:
    "Your scored WHOOP workouts per sport over local days (default the last 30, up to 365): sessions, sessions per week, duration, strain, energy, weighted heart rate, WHOOP %max-HR zone minutes and shares, Edwards TRIMP, GPS distance, time-weighted pace and a beats-per-km efficiency trend, plus shares by sport, the zone 1-5 intensity distribution and the time of day sessions start. A session counts toward the day of the WHOOP cycle containing its start. Means, medians and maxima need 3 sessions; sessions below 90% recorded heart-rate data are left out of heart-rate values. Filter with sport (exact name, case-insensitive) or min_recorded_fraction.",
  inputSchema: sportBreakdownInputSchema,
  outputSchema: sportBreakdownOutputSchema,
  run: getSportBreakdown,
};
