/**
 * Workout normalization shared by every workout tool: recorded fraction, zone
 * minutes, Edwards TRIMP, GPS pace and quality flags, with one summary shape.
 *
 * WHOOP reports percent_recorded as a 0-1 fraction (live-verified, e.g.
 * 0.99975777; a literal 1 means fully recorded) although its spec says 0-100;
 * both are accepted. Zone durations sum to duration × fraction. sport_id is
 * deprecated and 0 for running, so it is passed through as-is (never `|| null`).
 * Values are unrounded until {@link roundWorkoutSummary}.
 */

import { z } from "zod";
import type { Workout, ZoneDurations } from "../api/types.js";
import { formatLocalTimestamp, localDay } from "./analytics-utils.js";
import type { WorkoutPlacement } from "./day-model.js";
import { roundTo } from "./stats-utils.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Sessions recorded below this fraction are flagged low_recording; HR-derived stats need at least this */
export const MIN_RECORDED_FRACTION = 0.9;

/** Kilojoules per kilocalorie */
export const KJ_PER_KCAL = 4.184;

/** Faster average speeds than this (m/s) are flagged gps_suspect */
export const GPS_MAX_SPEED_MPS = 25;

/** Sports whose heart-rate zones understate the effort (caveat note only, not a taxonomy) */
export const HR_ZONE_CAVEAT_SPORT = /weightlifting|powerlifting|strength/i;

/** Smallest allowed gap between recorded minutes and duration × fraction */
export const ZONE_SUM_TOLERANCE_MINUTES = 1;

/** Relative gap between recorded minutes and duration × fraction allowed above the minimum */
export const ZONE_SUM_TOLERANCE_FRACTION = 0.05;

const MINUTE_MS = 60_000;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const WORKOUT_FLAGS = [
  "low_recording",
  "zone_sum_mismatch",
  "gps_suspect",
  "spans_cycle_boundary",
  "after_midnight_in_previous_cycle",
  "day_by_fallback",
  "cycle_in_progress",
  "not_scored",
] as const;

export type WorkoutFlag = (typeof WORKOUT_FLAGS)[number];

const zonesSchema = z.object({
  zone_0: z.number(),
  zone_1: z.number(),
  zone_2: z.number(),
  zone_3: z.number(),
  zone_4: z.number(),
  zone_5: z.number(),
});

export const workoutGpsSchema = z.object({
  distance_km: z.number(),
  avg_pace_sec_per_km: z
    .number()
    .describe("Elapsed time (including pauses) per kilometre, in seconds"),
  avg_speed_kmh: z.number().describe("Distance over elapsed time"),
  altitude_gain_m: z.number().nullable(),
  altitude_change_m: z.number().nullable(),
  beats_per_km: z
    .number()
    .nullable()
    .describe(
      "Average heart rate × recorded minutes per kilometre; null when less than 90% was recorded"
    ),
});

export const workoutSummarySchema = z.object({
  id: z.string(),
  sport_name: z.string(),
  sport_id: z.number().int().nullable().describe("Deprecated WHOOP sport id; 0 is running"),
  day: z
    .string()
    .describe(
      "Local day (YYYY-MM-DD) the workout counts toward: the day of the WHOOP cycle containing its start"
    ),
  local_date: z.string().describe("Local calendar date of the start, in the workout's own offset"),
  start_local: z.string(),
  end_local: z.string(),
  timezone_offset: z.string(),
  score_state: z.enum(["SCORED", "PENDING_SCORE", "UNSCORABLE"]),
  duration_minutes: z.number().describe("Elapsed minutes from start to end"),
  recorded_fraction: z
    .number()
    .nullable()
    .describe("Share of the session with heart-rate data, 0-1"),
  recorded_minutes: z.number().nullable().describe("Sum of heart-rate zone minutes"),
  strain: z.number().nullable(),
  kilojoule: z.number().nullable(),
  kcal: z.number().nullable(),
  average_heart_rate: z.number().nullable(),
  max_heart_rate: z.number().nullable(),
  zone_minutes: zonesSchema.describe("Minutes in WHOOP %max-HR zones 0-5").nullable(),
  zone_share_pct: zonesSchema
    .describe("Percent of recorded minutes per zone; null when no minutes were recorded")
    .nullable(),
  trimp: z.number().nullable().describe("Edwards TRIMP: sum of zone number × zone minutes (1-5)"),
  high_intensity_minutes: z.number().nullable().describe("Zone 4 + zone 5 minutes"),
  gps: workoutGpsSchema.nullable(),
  flags: z.array(z.enum(WORKOUT_FLAGS)),
});

export type WorkoutSummary = z.infer<typeof workoutSummarySchema>;
export type WorkoutGps = z.infer<typeof workoutGpsSchema>;
export type ZoneMinutes = z.infer<typeof zonesSchema>;

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/**
 * WHOOP's percent_recorded as a 0-1 fraction: values up to 1 are already a
 * fraction, larger values are percentages. Clamped to [0, 1].
 */
export function recordedFraction(value: number): number {
  const fraction = value <= 1 ? value : value / 100;
  return Math.min(1, Math.max(0, fraction));
}

/** percent_recorded as a percentage with one decimal (0.99975777 → 100, 87 → 87) */
export function recordedPercent(value: number): number {
  return roundTo(recordedFraction(value) * 100, 1);
}

/** Zone durations in minutes (unrounded) */
export function zoneMinutes(zones: ZoneDurations): ZoneMinutes {
  return {
    zone_0: zones.zone_zero_milli / MINUTE_MS,
    zone_1: zones.zone_one_milli / MINUTE_MS,
    zone_2: zones.zone_two_milli / MINUTE_MS,
    zone_3: zones.zone_three_milli / MINUTE_MS,
    zone_4: zones.zone_four_milli / MINUTE_MS,
    zone_5: zones.zone_five_milli / MINUTE_MS,
  };
}

/** Edwards TRIMP: Σ i × minutes in zone i for i = 1..5 (zone 0 adds nothing) */
export function edwardsTrimp(minutes: ZoneMinutes): number {
  return (
    minutes.zone_1 +
    2 * minutes.zone_2 +
    3 * minutes.zone_3 +
    4 * minutes.zone_4 +
    5 * minutes.zone_5
  );
}

/** Kilojoules to kilocalories */
export function kjToKcal(kilojoule: number): number {
  return kilojoule / KJ_PER_KCAL;
}

function zoneSum(minutes: ZoneMinutes): number {
  return (
    minutes.zone_0 +
    minutes.zone_1 +
    minutes.zone_2 +
    minutes.zone_3 +
    minutes.zone_4 +
    minutes.zone_5
  );
}

function mapZones(minutes: ZoneMinutes, map: (value: number) => number): ZoneMinutes {
  return {
    zone_0: map(minutes.zone_0),
    zone_1: map(minutes.zone_1),
    zone_2: map(minutes.zone_2),
    zone_3: map(minutes.zone_3),
    zone_4: map(minutes.zone_4),
    zone_5: map(minutes.zone_5),
  };
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * One workout as an unrounded summary. `placement` comes from assignWorkouts
 * (null when the workout could not be placed: its day is the local start day
 * and day_by_fallback is set). `cycleOpen` marks a workout in a cycle still in
 * progress. Unscored workouts have every score field null.
 *
 * @returns null when the workout ends at or before its start (count it as invalid_duration)
 */
export function normalizeWorkout(
  workout: Workout,
  placement: WorkoutPlacement | null,
  cycleOpen: boolean
): WorkoutSummary | null {
  const startMs = Date.parse(workout.start);
  const endMs = Date.parse(workout.end);
  if (!(endMs > startMs)) return null;
  const durationMinutes = (endMs - startMs) / MINUTE_MS;
  const localDate = localDay(workout.start, workout.timezone_offset);
  const score = workout.score_state === "SCORED" ? (workout.score ?? null) : null;
  const flags = new Set<WorkoutFlag>();

  let fraction: number | null = null;
  let recorded: number | null = null;
  let zones: ZoneMinutes | null = null;
  let shares: ZoneMinutes | null = null;
  let gps: WorkoutGps | null = null;
  if (score) {
    fraction = recordedFraction(score.percent_recorded);
    zones = zoneMinutes(score.zone_durations);
    recorded = zoneSum(zones);
    const total = recorded;
    shares = total > 0 ? mapZones(zones, (value) => (100 * value) / total) : null;
    if (fraction < MIN_RECORDED_FRACTION) flags.add("low_recording");
    const expected = durationMinutes * fraction;
    if (
      Math.abs(recorded - expected) >
      Math.max(ZONE_SUM_TOLERANCE_MINUTES, ZONE_SUM_TOLERANCE_FRACTION * expected)
    ) {
      flags.add("zone_sum_mismatch");
    }
    const distanceMeter = score.distance_meter;
    if (typeof distanceMeter === "number" && Number.isFinite(distanceMeter) && distanceMeter > 0) {
      const km = distanceMeter / 1000;
      const seconds = (endMs - startMs) / 1000;
      const speedMps = distanceMeter / seconds;
      if (speedMps > GPS_MAX_SPEED_MPS || durationMinutes < 1) flags.add("gps_suspect");
      gps = {
        distance_km: km,
        avg_pace_sec_per_km: seconds / km,
        avg_speed_kmh: km / (seconds / 3600),
        altitude_gain_m: score.altitude_gain_meter ?? null,
        altitude_change_m: score.altitude_change_meter ?? null,
        beats_per_km:
          fraction >= MIN_RECORDED_FRACTION ? (score.average_heart_rate * recorded) / km : null,
      };
    }
  } else {
    flags.add("not_scored");
  }
  if (placement?.spans_cycle_boundary) flags.add("spans_cycle_boundary");
  if (placement?.after_midnight_in_previous_cycle) flags.add("after_midnight_in_previous_cycle");
  if (!placement || placement.fallback) flags.add("day_by_fallback");
  if (cycleOpen) flags.add("cycle_in_progress");

  return {
    id: workout.id,
    sport_name: workout.sport_name,
    sport_id: workout.sport_id ?? null,
    day: placement?.day ?? localDate,
    local_date: localDate,
    start_local: formatLocalTimestamp(startMs, workout.timezone_offset),
    end_local: formatLocalTimestamp(endMs, workout.timezone_offset),
    timezone_offset: workout.timezone_offset,
    score_state: workout.score_state,
    duration_minutes: durationMinutes,
    recorded_fraction: fraction,
    recorded_minutes: recorded,
    strain: score ? score.strain : null,
    kilojoule: score ? score.kilojoule : null,
    kcal: score ? kjToKcal(score.kilojoule) : null,
    average_heart_rate: score ? score.average_heart_rate : null,
    max_heart_rate: score ? score.max_heart_rate : null,
    zone_minutes: zones,
    zone_share_pct: shares,
    trimp: zones ? edwardsTrimp(zones) : null,
    high_intensity_minutes: zones ? zones.zone_4 + zones.zone_5 : null,
    gps,
    flags: WORKOUT_FLAGS.filter((flag) => flags.has(flag)),
  };
}

/**
 * Round a summary for output: minutes 1 dp, fraction 3, strain 2, kJ/kcal 0,
 * heart rate 0, shares 1, TRIMP 1, km 2, pace 0, speed 1, altitude 0,
 * beats per km 0.
 */
export function roundWorkoutSummary(summary: WorkoutSummary): WorkoutSummary {
  const gps = summary.gps;
  return {
    ...summary,
    duration_minutes: roundTo(summary.duration_minutes, 1),
    recorded_fraction: roundTo(summary.recorded_fraction, 3),
    recorded_minutes: roundTo(summary.recorded_minutes, 1),
    strain: roundTo(summary.strain, 2),
    kilojoule: roundTo(summary.kilojoule, 0),
    kcal: roundTo(summary.kcal, 0),
    average_heart_rate: roundTo(summary.average_heart_rate, 0),
    max_heart_rate: roundTo(summary.max_heart_rate, 0),
    zone_minutes: summary.zone_minutes
      ? mapZones(summary.zone_minutes, (value) => roundTo(value, 1))
      : null,
    zone_share_pct: summary.zone_share_pct
      ? mapZones(summary.zone_share_pct, (value) => roundTo(value, 1))
      : null,
    trimp: roundTo(summary.trimp, 1),
    high_intensity_minutes: roundTo(summary.high_intensity_minutes, 1),
    gps: gps
      ? {
          distance_km: roundTo(gps.distance_km, 2),
          avg_pace_sec_per_km: roundTo(gps.avg_pace_sec_per_km, 0),
          avg_speed_kmh: roundTo(gps.avg_speed_kmh, 1),
          altitude_gain_m: roundTo(gps.altitude_gain_m, 0),
          altitude_change_m: roundTo(gps.altitude_change_m, 0),
          beats_per_km: roundTo(gps.beats_per_km, 0),
        }
      : null,
    flags: [...summary.flags],
  };
}
