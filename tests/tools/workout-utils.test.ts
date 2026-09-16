import { describe, it, expect } from "vitest";
import type { Workout, WorkoutScore } from "../../src/api/types.js";
import type { WorkoutPlacement } from "../../src/tools/day-model.js";
import {
  edwardsTrimp,
  GPS_MAX_SPEED_MPS,
  HR_ZONE_CAVEAT_SPORT,
  KJ_PER_KCAL,
  kjToKcal,
  MIN_RECORDED_FRACTION,
  normalizeWorkout,
  recordedFraction,
  recordedPercent,
  roundWorkoutSummary,
  workoutSummarySchema,
  zoneMinutes,
} from "../../src/tools/workout-utils.js";
import { LIVE_SHAPED_IDS, liveShapedUser } from "../helpers/whoop-users.js";

const live = liveShapedUser();
const byId = (id: string): Workout => live.workouts.find((workout) => workout.id === id)!;
const eveningRun = byId(LIVE_SHAPED_IDS.workouts.eveningRun);
const morningRun = byId(LIVE_SHAPED_IDS.workouts.morningRun);
const lateWalk = byId(LIVE_SHAPED_IDS.workouts.lateWalk);

const placed = (day: string, patch: Partial<WorkoutPlacement> = {}): WorkoutPlacement => ({
  day,
  cycle: null,
  fallback: false,
  spans_cycle_boundary: false,
  after_midnight_in_previous_cycle: false,
  ...patch,
});

function withScore(workout: Workout, patch: Partial<WorkoutScore>): Workout {
  return { ...workout, score: { ...workout.score!, ...patch } };
}

/** A 60-minute workout at `start` with the given offset and fully recorded zones */
function hourWorkout(start: string, offset: string): Workout {
  const startMs = Date.parse(start);
  return {
    ...lateWalk,
    id: `hour-${offset}`,
    start: new Date(startMs).toISOString(),
    end: new Date(startMs + 3_600_000).toISOString(),
    timezone_offset: offset,
    score: {
      ...lateWalk.score!,
      percent_recorded: 1,
      zone_durations: {
        zone_zero_milli: 600_000,
        zone_one_milli: 600_000,
        zone_two_milli: 600_000,
        zone_three_milli: 600_000,
        zone_four_milli: 600_000,
        zone_five_milli: 600_000,
      },
    },
  };
}

describe("recorded fraction", () => {
  it("reads WHOOP's 0-1 fraction and a 0-100 percentage", () => {
    expect(recordedFraction(1)).toBe(1);
    expect(recordedFraction(0.99975777)).toBe(0.99975777);
    expect(recordedFraction(87)).toBe(0.87);
    expect(recordedFraction(100)).toBe(1);
    expect(recordedFraction(0)).toBe(0);
    expect(recordedFraction(-0.2)).toBe(0);
    expect(recordedFraction(250)).toBe(1);
  });

  it("formats the percentage with one decimal", () => {
    expect(recordedPercent(1)).toBe(100);
    expect(recordedPercent(0.99975777)).toBe(100);
    expect(recordedPercent(0.8765)).toBe(87.7);
    expect(recordedPercent(87)).toBe(87);
  });
});

describe("zones, TRIMP and energy", () => {
  it("weights zone minutes 1-5 for Edwards TRIMP", () => {
    const minutes = zoneMinutes({
      zone_zero_milli: 10 * 60_000,
      zone_one_milli: 10 * 60_000,
      zone_two_milli: 20 * 60_000,
      zone_three_milli: 30 * 60_000,
      zone_four_milli: 40 * 60_000,
      zone_five_milli: 50 * 60_000,
    });
    expect(minutes).toEqual({
      zone_0: 10,
      zone_1: 10,
      zone_2: 20,
      zone_3: 30,
      zone_4: 40,
      zone_5: 50,
    });
    // 1·10 + 2·20 + 3·30 + 4·40 + 5·50
    expect(edwardsTrimp(minutes)).toBe(550);
  });

  it("converts kilojoules to kilocalories", () => {
    expect(KJ_PER_KCAL).toBe(4.184);
    expect(kjToKcal(4184)).toBe(1000);
  });
});

describe("normalizeWorkout", () => {
  it("summarizes a GPS run and preserves sport_id 0", () => {
    const summary = normalizeWorkout(morningRun, placed("2026-09-15"), false)!;
    expect(summary.sport_id).toBe(0);
    expect(summary.sport_name).toBe("running");
    expect(summary.flags).toEqual([]);
    const durationMinutes = (Date.parse(morningRun.end) - Date.parse(morningRun.start)) / 60_000;
    expect(summary.duration_minutes).toBe(durationMinutes);
    expect(summary.recorded_fraction).toBe(1);
    expect(summary.recorded_minutes).toBeCloseTo(durationMinutes, 9);
    const km = 7.4126;
    expect(summary.gps!.distance_km).toBeCloseTo(km, 12);
    expect(summary.gps!.avg_pace_sec_per_km).toBeCloseTo((durationMinutes * 60) / km, 9);
    expect(summary.gps!.avg_speed_kmh).toBeCloseTo(km / (durationMinutes / 60), 9);
    expect(summary.gps!.beats_per_km).toBeCloseTo((152 * summary.recorded_minutes!) / km, 9);
    expect(summary.gps!.altitude_gain_m).toBe(61.3);
    expect(summary.kcal).toBeCloseTo(2011.42 / 4.184, 9);
    expect(summary.high_intensity_minutes).toBeCloseTo((701_506 + 139_526) / 60_000, 9);
    const shares = Object.values(summary.zone_share_pct!).reduce((sum, value) => sum + value, 0);
    expect(shares).toBeCloseTo(100, 9);
    expect(workoutSummarySchema.safeParse(summary).success).toBe(true);
  });

  it("keeps a nearly complete recording (0.99975777) free of flags", () => {
    const summary = normalizeWorkout(eveningRun, placed("2026-09-16"), true)!;
    expect(summary.recorded_fraction).toBe(0.99975777);
    expect(summary.flags).toEqual(["cycle_in_progress"]);
    expect(summary.gps!.beats_per_km).not.toBeNull();
  });

  it("flags low recording and withholds beats per km below 90%", () => {
    const partial = withScore(morningRun, {
      percent_recorded: 87,
      zone_durations: {
        ...morningRun.score!.zone_durations,
        zone_zero_milli: morningRun.score!.zone_durations.zone_zero_milli - 325_000,
      },
    });
    const summary = normalizeWorkout(partial, placed("2026-09-15"), false)!;
    expect(summary.recorded_fraction).toBe(0.87);
    expect(summary.recorded_fraction!).toBeLessThan(MIN_RECORDED_FRACTION);
    expect(summary.flags).toContain("low_recording");
    expect(summary.gps!.beats_per_km).toBeNull();
    const atThreshold = normalizeWorkout(
      withScore(morningRun, { percent_recorded: 0.9 }),
      placed("2026-09-15"),
      false
    )!;
    expect(atThreshold.flags).not.toContain("low_recording");
    expect(atThreshold.gps!.beats_per_km).not.toBeNull();
  });

  it("flags zone sums that disagree with duration × fraction", () => {
    expect(normalizeWorkout(lateWalk, placed("2026-09-14"), false)!.flags).not.toContain(
      "zone_sum_mismatch"
    );
    const short = withScore(lateWalk, {
      zone_durations: { ...lateWalk.score!.zone_durations, zone_zero_milli: 0 },
    });
    expect(normalizeWorkout(short, placed("2026-09-14"), false)!.flags).toContain(
      "zone_sum_mismatch"
    );
  });

  it("has no GPS block without a positive finite distance", () => {
    expect(normalizeWorkout(lateWalk, placed("2026-09-14"), false)!.gps).toBeNull();
    const zero = withScore(morningRun, { distance_meter: 0 });
    expect(normalizeWorkout(zero, placed("2026-09-15"), false)!.gps).toBeNull();
    const nullDistance = withScore(morningRun, { distance_meter: null });
    expect(normalizeWorkout(nullDistance, placed("2026-09-15"), false)!.gps).toBeNull();
  });

  it("flags implausible GPS speed and sub-minute sessions with distance", () => {
    const seconds = (Date.parse(morningRun.end) - Date.parse(morningRun.start)) / 1000;
    const fast = withScore(morningRun, { distance_meter: (GPS_MAX_SPEED_MPS + 1) * seconds });
    expect(normalizeWorkout(fast, placed("2026-09-15"), false)!.flags).toContain("gps_suspect");
    const blip: Workout = {
      ...morningRun,
      end: new Date(Date.parse(morningRun.start) + 40_000).toISOString(),
      score: { ...morningRun.score!, distance_meter: 150 },
    };
    expect(normalizeWorkout(blip, placed("2026-09-15"), false)!.flags).toContain("gps_suspect");
  });

  it("nulls every score field of an unscored workout", () => {
    const pending: Workout = { ...morningRun, score_state: "PENDING_SCORE", score: null };
    const summary = normalizeWorkout(pending, placed("2026-09-15"), false)!;
    expect(summary).toMatchObject({
      score_state: "PENDING_SCORE",
      recorded_fraction: null,
      recorded_minutes: null,
      strain: null,
      kilojoule: null,
      kcal: null,
      average_heart_rate: null,
      max_heart_rate: null,
      zone_minutes: null,
      zone_share_pct: null,
      trimp: null,
      high_intensity_minutes: null,
      gps: null,
      flags: ["not_scored"],
    });
    expect(summary.duration_minutes).toBeGreaterThan(0);
    const unscorable: Workout = { ...morningRun, score_state: "UNSCORABLE" };
    expect(normalizeWorkout(unscorable, placed("2026-09-15"), false)!.strain).toBeNull();
    expect(workoutSummarySchema.safeParse(summary).success).toBe(true);
  });

  it("returns null for a workout ending at or before its start", () => {
    expect(normalizeWorkout({ ...lateWalk, end: lateWalk.start }, null, false)).toBeNull();
    expect(
      normalizeWorkout(
        { ...lateWalk, end: new Date(Date.parse(lateWalk.start) - 60_000).toISOString() },
        null,
        false
      )
    ).toBeNull();
  });

  it("writes local times in the workout's own offset (+02:00, −05:00, Z)", () => {
    const start = "2026-09-15T02:30:00.000Z";
    const plus = normalizeWorkout(hourWorkout(start, "+02:00"), null, false)!;
    expect(plus.start_local).toBe("2026-09-15T04:30:00.000+02:00");
    expect(plus.end_local).toBe("2026-09-15T05:30:00.000+02:00");
    expect(plus.local_date).toBe("2026-09-15");
    const minus = normalizeWorkout(hourWorkout(start, "-05:00"), null, false)!;
    expect(minus.start_local).toBe("2026-09-14T21:30:00.000-05:00");
    expect(minus.local_date).toBe("2026-09-14");
    const utc = normalizeWorkout(hourWorkout(start, "Z"), null, false)!;
    expect(utc.start_local).toBe("2026-09-15T02:30:00.000Z");
    expect(utc.local_date).toBe("2026-09-15");
    for (const summary of [plus, minus, utc]) {
      expect(Date.parse(summary.start_local)).toBe(Date.parse(start));
      expect(summary.trimp).toBe(150);
    }
  });

  it("takes the day and placement flags from assignWorkouts", () => {
    const late = normalizeWorkout(
      lateWalk,
      placed("2026-09-14", { spans_cycle_boundary: true, after_midnight_in_previous_cycle: true }),
      false
    )!;
    expect(late.day).toBe("2026-09-14");
    expect(late.flags).toEqual(["spans_cycle_boundary", "after_midnight_in_previous_cycle"]);
    const fallback = normalizeWorkout(lateWalk, placed("2026-09-14", { fallback: true }), false)!;
    expect(fallback.flags).toEqual(["day_by_fallback"]);
    const unplaced = normalizeWorkout(hourWorkout("2026-09-15T02:30:00Z", "-05:00"), null, true)!;
    expect(unplaced.day).toBe("2026-09-14");
    expect(unplaced.flags).toEqual(["day_by_fallback", "cycle_in_progress"]);
  });
});

describe("roundWorkoutSummary", () => {
  it("rounds each field to its output precision", () => {
    const rounded = roundWorkoutSummary(normalizeWorkout(eveningRun, placed("2026-09-16"), true)!);
    const raw = normalizeWorkout(eveningRun, placed("2026-09-16"), true)!;
    const decimals = (value: number): number => (String(value).split(".")[1] ?? "").length;
    expect(decimals(rounded.duration_minutes)).toBeLessThanOrEqual(1);
    expect(rounded.recorded_fraction).toBe(1);
    expect(rounded.strain).toBe(12.45);
    expect(rounded.kilojoule).toBe(2204);
    expect(rounded.kcal).toBe(Math.round(2203.79 / 4.184));
    expect(rounded.average_heart_rate).toBe(155);
    expect(rounded.gps!.distance_km).toBe(8.1);
    expect(rounded.gps!.avg_pace_sec_per_km).toBe(Math.round(raw.gps!.avg_pace_sec_per_km));
    expect(decimals(rounded.gps!.avg_speed_kmh)).toBeLessThanOrEqual(1);
    expect(rounded.gps!.altitude_gain_m).toBe(45);
    expect(rounded.gps!.altitude_change_m).toBe(-1);
    expect(Number.isInteger(rounded.gps!.beats_per_km)).toBe(true);
    for (const value of Object.values(rounded.zone_minutes!)) {
      expect(decimals(value)).toBeLessThanOrEqual(1);
    }
    expect(decimals(rounded.trimp!)).toBeLessThanOrEqual(1);
    expect(workoutSummarySchema.safeParse(rounded).success).toBe(true);
    // The raw summary is not mutated
    expect(raw.strain).toBe(12.4467);
  });

  it("keeps nulls of unscored workouts", () => {
    const pending: Workout = { ...lateWalk, score_state: "PENDING_SCORE", score: null };
    const rounded = roundWorkoutSummary(normalizeWorkout(pending, null, false)!);
    expect(rounded.gps).toBeNull();
    expect(rounded.zone_minutes).toBeNull();
    expect(rounded.trimp).toBeNull();
  });
});

describe("HR_ZONE_CAVEAT_SPORT", () => {
  it("matches strength sports by name only", () => {
    expect(HR_ZONE_CAVEAT_SPORT.test("weightlifting_msk")).toBe(true);
    expect(HR_ZONE_CAVEAT_SPORT.test("Powerlifting")).toBe(true);
    expect(HR_ZONE_CAVEAT_SPORT.test("strength_trainer")).toBe(true);
    expect(HR_ZONE_CAVEAT_SPORT.test("running")).toBe(false);
  });
});
