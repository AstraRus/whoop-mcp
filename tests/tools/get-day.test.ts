/**
 * Tests for get_day (package P5).
 *
 * Covers the live-shaped calibrating account (+02:00): the partial first day
 * with its 23:17 walk, the 00:39-onset day with four workouts, a GPS run and
 * the next morning's recovery, the in-progress day, the after-midnight window
 * before the next sleep syncs, naps, a PENDING sleep holding back its
 * recovery, a failed cycle stream, input validation, the cycle_id path, a
 * −05:00 clone, parity with get_calendar on a 14-day mature user (values and
 * workout placement), a split night, caps, truncation, request accounting and
 * output size on stressUser, neutral wording, and the MCP contract in both
 * privacy modes.
 */

import { describe, expect, it } from "vitest";
import { WhoopApiError } from "../../src/api/client.js";
import { DEFAULT_PAGE_BUDGET, HISTORY_LIMITATIONS } from "../../src/api/history.js";
import type { Cycle, Sleep, Workout } from "../../src/api/types.js";
import { MemoryCache } from "../../src/cache/memory-cache.js";
import { localDay } from "../../src/tools/analytics-utils.js";
import { addDays, assignWorkouts, placeDays } from "../../src/tools/day-model.js";
import { getCalendar } from "../../src/tools/get-calendar.js";
import {
  GET_DAY_METHOD_VERSION,
  GET_DAY_TOOL,
  getDay,
  getDayOutputSchema,
  MAX_DAY_WORKOUTS,
  MAX_TIMELINE_ENTRIES,
  resolveGetDayDate,
  type GetDayInput,
  type GetDayResult,
} from "../../src/tools/get-day.js";
import { roundTo } from "../../src/tools/stats-utils.js";
import { MAX_TOOL_TEXT_CHARS, type ToolContext } from "../../src/tools/tool-definition.js";
import { InvalidDateExpression } from "../../src/tools/date-utils.js";
import { assertNeutralText, connectServer, listToolNames } from "../helpers/contract.js";
import {
  createWhoopFixtureClient,
  type WhoopFixtureClient,
  type WhoopFixtureClientOptions,
} from "../helpers/whoop-fixture-client.js";
import {
  LIVE_SHAPED_IDS,
  liveShapedUser,
  matureUser,
  offsetMinutes,
  stressUser,
  type WhoopUserFixture,
} from "../helpers/whoop-users.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const IDS = LIVE_SHAPED_IDS;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clientFor(
  user: WhoopUserFixture,
  options: Partial<WhoopFixtureClientOptions> = {}
): WhoopFixtureClient {
  return createWhoopFixtureClient({
    cycles: user.cycles,
    sleeps: user.sleeps,
    recoveries: user.recoveries,
    workouts: user.workouts,
    profile: user.profile,
    body: user.body,
    now: user.now,
    ...options,
  });
}

function contextFor(
  client: WhoopFixtureClient,
  now: Date,
  extra: Partial<ToolContext> = {}
): ToolContext {
  return { client, privacyMode: "standard", now: () => now, startedAtMs: Date.now(), ...extra };
}

/** Run get_day and validate the result against its output contract. */
async function runDay(
  user: WhoopUserFixture,
  args: GetDayInput,
  client: WhoopFixtureClient = clientFor(user),
  extra: Partial<ToolContext> = {}
): Promise<GetDayResult> {
  const result = await getDay(args, contextFor(client, user.now, extra));
  return getDayOutputSchema.parse(result);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** The same account in another offset: every instant moves so local wall-clock times stay. */
function atOffset(user: WhoopUserFixture, offset: string, extraMs = 0): WhoopUserFixture {
  const deltaMs = (offsetMinutes(user.offset) - offsetMinutes(offset)) * MINUTE_MS + extraMs;
  const shift = (value: string): string => iso(Date.parse(value) + deltaMs);
  return {
    ...user,
    now: new Date(user.now.getTime() + deltaMs),
    offset,
    cycles: user.cycles.map((cycle) => ({
      ...cycle,
      created_at: shift(cycle.created_at),
      updated_at: shift(cycle.updated_at),
      start: shift(cycle.start),
      end: cycle.end === null || cycle.end === undefined ? cycle.end : shift(cycle.end),
      timezone_offset: offset,
    })),
    sleeps: user.sleeps.map((sleep) => ({
      ...sleep,
      created_at: shift(sleep.created_at),
      updated_at: shift(sleep.updated_at),
      start: shift(sleep.start),
      end: shift(sleep.end),
      timezone_offset: offset,
    })),
    recoveries: user.recoveries.map((recovery) => ({
      ...recovery,
      created_at: shift(recovery.created_at),
      updated_at: shift(recovery.updated_at),
    })),
    workouts: user.workouts.map((workout) => ({
      ...workout,
      created_at: shift(workout.created_at),
      updated_at: shift(workout.updated_at),
      start: shift(workout.start),
      end: shift(workout.end),
      timezone_offset: offset,
    })),
  };
}

/** A scored walk whose zone durations sum to its duration. */
function makeWorkout(input: {
  id: string;
  startMs: number;
  minutes: number;
  offset: string;
  userId: number;
  sport?: string;
}): Workout {
  const duration = Math.round(input.minutes * MINUTE_MS);
  const one = Math.round(duration * 0.6);
  const endMs = input.startMs + duration;
  return {
    user_id: input.userId,
    created_at: iso(endMs + 60_000),
    updated_at: iso(endMs + 62_000),
    score_state: "SCORED",
    start: iso(input.startMs),
    end: iso(endMs),
    timezone_offset: input.offset,
    id: input.id,
    sport_name: input.sport ?? "walking",
    sport_id: 63,
    v1_id: null,
    score: {
      strain: 3.5,
      average_heart_rate: 100,
      max_heart_rate: 120,
      kilojoule: 400,
      percent_recorded: 1,
      zone_durations: {
        zone_zero_milli: duration - one,
        zone_one_milli: one,
        zone_two_milli: 0,
        zone_three_milli: 0,
        zone_four_milli: 0,
        zone_five_milli: 0,
      },
      distance_meter: null,
      altitude_gain_meter: null,
      altitude_change_meter: null,
    },
  };
}

function asleepHoursOf(sleep: Sleep): number {
  const stages = sleep.score!.stage_summary;
  return (
    (stages.total_light_sleep_time_milli +
      stages.total_slow_wave_sleep_time_milli +
      stages.total_rem_sleep_time_milli) /
    HOUR_MS
  );
}

function cycleById(user: WhoopUserFixture, id: number): Cycle {
  const cycle = user.cycles.find((candidate) => candidate.id === id);
  if (!cycle) throw new Error(`no cycle ${id}`);
  return cycle;
}

function workoutById(user: WhoopUserFixture, id: string): Workout {
  const workout = user.workouts.find((candidate) => candidate.id === id);
  if (!workout) throw new Error(`no workout ${id}`);
  return workout;
}

/** The result without wall-clock fetch times, for comparing two calls. */
function stable(result: GetDayResult): GetDayResult {
  const sources = Object.fromEntries(
    Object.entries(result.data_quality.sources).map(([name, source]) => [
      name,
      { ...source, fetched_at: null },
    ])
  );
  return { ...result, data_quality: { ...result.data_quality, sources } };
}

function textOf(result: GetDayResult): string[] {
  return [...result.notes, ...result.warnings, ...result.timeline.map((entry) => entry.label)];
}

// ---------------------------------------------------------------------------
// Live-shaped account
// ---------------------------------------------------------------------------

describe("get_day on the live-shaped account (+02:00)", () => {
  it("09-14: a partial first-day cycle with the 23:17 walk and no recovery", async () => {
    const user = liveShapedUser();
    const day = await runDay(user, { date: "2026-09-14" });

    expect(day.date).toBe("2026-09-14");
    expect(day.utc_offset).toBe("+02:00");
    expect(day.status).toBe("complete");
    expect(day.cycle).toMatchObject({
      id: IDS.cycles.firstDay,
      start_local: "2026-09-14T00:00:00.000+02:00",
      end_local: "2026-09-15T00:39:27.317+02:00",
      in_progress: false,
      partial_first_day: true,
      score_state: "SCORED",
      day_strain: 9.42,
    });
    expect(day.recovery).toBeNull();
    expect(day.sleep).toBeNull();
    expect(day.naps).toEqual([]);
    expect(day.workouts.map((workout) => workout.id)).toEqual([IDS.workouts.lateWalk]);
    expect(day.workouts[0]).toMatchObject({
      day: "2026-09-14",
      local_date: "2026-09-14",
      start_local: "2026-09-14T23:17:43.512+02:00",
      flags: [],
    });
    expect(day.notes).toContain(
      "Strain for 2026-09-14 covers only part of the day (WHOOP was first worn partway through it; partial_first_day: true)."
    );
    expect(day.previous_day).toBeNull();
    expect(day.next_morning).toEqual({
      date: "2026-09-15",
      status: "available",
      recovery_score: 58,
      calibrating: true,
      hrv_rmssd_milli: 71.4,
      resting_heart_rate: 61,
    });
    expect(day.truncated).toBe(false);
    expect(day.warnings).toEqual([]);
    assertNeutralText(textOf(day));
  });

  it("09-15: the 00:39-onset cycle with calibrating recovery, four sorted workouts and the next morning", async () => {
    const user = liveShapedUser();
    const day = await runDay(user, { date: "2026-09-15" });
    const cycle = cycleById(user, IDS.cycles.afterMidnightOnset);
    const firstSleep = user.sleeps.find((sleep) => sleep.id === IDS.sleeps.first)!;

    expect(day.status).toBe("complete");
    expect(day.cycle).toMatchObject({
      id: cycle.id,
      start_local: "2026-09-15T00:39:27.317+02:00",
      end_local: "2026-09-15T23:13:31.460+02:00",
      cycle_hours: roundTo((Date.parse(cycle.end!) - Date.parse(cycle.start)) / HOUR_MS, 1),
      in_progress: false,
      partial_first_day: false,
      day_strain: roundTo(cycle.score!.strain, 2),
      kilojoule: roundTo(cycle.score!.kilojoule, 0),
      kcal: roundTo(cycle.score!.kilojoule / 4.184, 0),
    });
    expect(day.notes).toContain(
      "Energy covers the whole WHOOP cycle (sleep onset to next sleep onset), not a calendar day."
    );

    // Calibrating recovery is flagged, not hidden.
    expect(day.recovery).toMatchObject({
      score_state: "SCORED",
      recovery_score: 58,
      zone: "yellow",
      calibrating: true,
      held_back: false,
      spo2_pct: 96.3,
      skin_temp_celsius: 33.62,
    });
    expect(day.notes).toContain(
      "WHOOP is still calibrating: recovery for 2026-09-15 is provisional (calibrating: true)."
    );
    expect(day.data_quality.sources.recovery!.status).toBe("calibrating");

    // Main sleep: asleep = light + SWS + REM, consistency 0 while calibrating → null.
    expect(day.sleep).toMatchObject({
      id: IDS.sleeps.first,
      asleep_hours: roundTo(asleepHoursOf(firstSleep), 2),
      consistency_pct: null,
      consistency_reason: "zero_during_calibration",
    });
    expect(day.sleep!.need_hours!.from_recent_nap).toBe(0);
    const shares = day.sleep!.stage_share_pct!;
    expect(shares.light + shares.deep + shares.rem).toBeCloseTo(100, 0);

    // Four workouts ordered by start; the GPS run keeps sport_id 0.
    expect(day.workouts.map((workout) => workout.id)).toEqual([
      IDS.workouts.morningRun,
      IDS.workouts.middayWalk,
      IDS.workouts.weightliftingDay2,
      IDS.workouts.padel,
    ]);
    expect(day.workouts.map((workout) => workout.day)).toEqual(Array(4).fill("2026-09-15"));
    const run = day.workouts[0]!;
    const rawRun = workoutById(user, IDS.workouts.morningRun);
    const elapsedSeconds = (Date.parse(rawRun.end) - Date.parse(rawRun.start)) / 1000;
    const km = rawRun.score!.distance_meter! / 1000;
    const zones = rawRun.score!.zone_durations;
    const recordedMinutes =
      (zones.zone_zero_milli +
        zones.zone_one_milli +
        zones.zone_two_milli +
        zones.zone_three_milli +
        zones.zone_four_milli +
        zones.zone_five_milli) /
      MINUTE_MS;
    expect(run.sport_id).toBe(0);
    expect(run.sport_name).toBe("running");
    expect(run.gps).toEqual({
      distance_km: roundTo(km, 2),
      avg_pace_sec_per_km: roundTo(elapsedSeconds / km, 0),
      avg_speed_kmh: roundTo(km / (elapsedSeconds / 3600), 1),
      altitude_gain_m: roundTo(rawRun.score!.altitude_gain_meter!, 0),
      altitude_change_m: roundTo(rawRun.score!.altitude_change_meter!, 0),
      beats_per_km: roundTo((rawRun.score!.average_heart_rate * recordedMinutes) / km, 0),
    });
    expect(day.workouts[1]!.gps).toBeNull();

    // Totals add minutes, energy and TRIMP; strain is never summed.
    const raw = day.workouts.map((workout) => workoutById(user, workout.id));
    const kj = raw.reduce((sum, workout) => sum + workout.score!.kilojoule, 0);
    expect(day.workout_totals).toMatchObject({
      count: 4,
      kilojoule: roundTo(kj, 0),
      distance_km: roundTo(km, 2),
      workout_kj_share_of_day_pct: roundTo((100 * kj) / cycle.score!.kilojoule, 1),
    });
    expect(day.workout_totals).not.toHaveProperty("strain");
    expect(day.notes).toContain(
      "Day strain is WHOOP's non-linear 0-21 score and is not the sum of workout strains."
    );
    expect(day.notes.some((note) => note.includes("weightlifting_msk"))).toBe(true);

    // The previous day's strain is partial, so it is not reported as a day strain.
    expect(day.previous_day).toEqual({
      date: "2026-09-14",
      day_strain: null,
      day_strain_partial: true,
      workouts: 1,
      trimp: expect.any(Number),
    });
    expect(day.next_morning).toMatchObject({
      date: "2026-09-16",
      status: "available",
      recovery_score: 67,
      calibrating: true,
    });
    expect(day.data_quality.method_version).toBe(GET_DAY_METHOD_VERSION);
    expect(day.data_quality.limitations).toEqual(expect.arrayContaining([...HISTORY_LIMITATIONS]));
    expect(day.data_quality.requested_period).toEqual({
      start: "2026-09-15T00:00:00.000+02:00",
      end: "2026-09-15T23:59:59.999+02:00",
    });
    expect(day.data_quality.sources.workout).toMatchObject({
      records_used: 4,
      status: "available",
    });
    assertNeutralText(textOf(day));
  });

  it("09-16 (today): in progress with three workouts including the manual-shaped walk", async () => {
    const user = liveShapedUser();
    const day = await runDay(user, {});
    const cycle = cycleById(user, IDS.cycles.open);

    expect(day.date).toBe("2026-09-16");
    expect(day.status).toBe("in_progress");
    expect(day.cycle).toMatchObject({
      id: cycle.id,
      end_local: null,
      in_progress: true,
      day_strain: roundTo(cycle.score!.strain, 2),
      cycle_hours: roundTo((user.now.getTime() - Date.parse(cycle.start)) / HOUR_MS, 1),
    });
    expect(day.workouts.map((workout) => workout.id)).toEqual([
      IDS.workouts.manualWalk,
      IDS.workouts.weightliftingDay3,
      IDS.workouts.eveningRun,
    ]);
    expect(day.workouts[0]!.start_local).toBe("2026-09-16T09:30:00.000+02:00");
    expect(day.workouts.every((workout) => workout.flags.includes("cycle_in_progress"))).toBe(true);
    const eveningRun = day.workouts[2]!;
    expect(eveningRun.recorded_fraction).toBe(1);
    expect(eveningRun.flags).not.toContain("low_recording");
    expect(eveningRun.flags).not.toContain("zone_sum_mismatch");
    expect(day.workout_totals!.workout_kj_share_of_day_pct).toBeNull();
    expect(day.notes).toContain(
      "Strain for 2026-09-16 is still accumulating (in_progress: true); day_strain is the strain so far."
    );
    expect(day.next_morning).toEqual({
      date: null,
      status: "not_yet",
      recovery_score: null,
      calibrating: null,
      hrv_rmssd_milli: null,
      resting_heart_rate: null,
    });
    expect(day.previous_day).toMatchObject({
      date: "2026-09-15",
      day_strain: roundTo(cycleById(user, IDS.cycles.afterMidnightOnset).score!.strain, 2),
      day_strain_partial: false,
      workouts: 4,
    });
    assertNeutralText(textOf(day));
  });

  it("after midnight before the next sleep syncs: today has no cycle yet and a 00:10 workout counts toward yesterday", async () => {
    const user = liveShapedUser({ now: "2026-09-17T00:30:00+02:00" });
    const lateId = "b0c0ffee-0000-4000-8000-000000000010";
    user.workouts.push(
      makeWorkout({
        id: lateId,
        startMs: Date.parse("2026-09-17T00:10:00+02:00"),
        minutes: 15,
        offset: "+02:00",
        userId: IDS.userId,
      })
    );
    const client = clientFor(user);

    const today = await runDay(user, { date: "today" }, client);
    expect(today.date).toBe("2026-09-17");
    expect(today.status).toBe("no_cycle_yet");
    expect(today.cycle).toBeNull();
    expect(today.workouts).toEqual([]);
    expect(today.workout_totals).toBeNull();
    expect(today.next_morning.status).toBe("not_yet");
    expect(today.notes[0]).toContain("Today's (2026-09-17) WHOOP cycle has not started yet");
    expect(today.notes[0]).toContain("which belongs to 2026-09-16");
    expect(today.notes[0]).toContain("This is not missing data.");
    expect(today.notes.join(" ")).not.toMatch(/strap|not worn/i);
    expect(today.previous_day).toMatchObject({ date: "2026-09-16", day_strain: null, workouts: 4 });

    const yesterday = await runDay(user, { date: "yesterday" }, client);
    expect(yesterday.date).toBe("2026-09-16");
    expect(yesterday.status).toBe("in_progress");
    expect(yesterday.workouts.map((workout) => workout.id)).toEqual([
      IDS.workouts.manualWalk,
      IDS.workouts.weightliftingDay3,
      IDS.workouts.eveningRun,
      lateId,
    ]);
    const late = yesterday.workouts[3]!;
    expect(late.day).toBe("2026-09-16");
    expect(late.local_date).toBe("2026-09-17");
    expect(late.flags).toEqual(["after_midnight_in_previous_cycle", "cycle_in_progress"]);
    expect(yesterday.notes).toContain(
      "1 workout started after local midnight but before the next sleep, so it counts toward 2026-09-16, the day of that cycle (flag after_midnight_in_previous_cycle)."
    );
    assertNeutralText([...textOf(today), ...textOf(yesterday)]);
  });

  it("lists a nap separately and keeps it out of the main sleep's asleep hours", async () => {
    const base = liveShapedUser();
    const withNap = liveShapedUser();
    const second = withNap.sleeps.find((sleep) => sleep.id === IDS.sleeps.second)!;
    const napStart = Date.parse("2026-09-16T14:05:00+02:00");
    const napEnd = napStart + 30 * MINUTE_MS;
    const nap: Sleep = {
      ...structuredClone(second),
      id: "c0ffee00-0000-4000-8000-00000000a001",
      created_at: iso(napEnd + 120_000),
      updated_at: iso(napEnd + 120_000),
      start: iso(napStart),
      end: iso(napEnd),
      nap: true,
      score: {
        ...structuredClone(second.score!),
        stage_summary: {
          total_in_bed_time_milli: 30 * MINUTE_MS,
          total_awake_time_milli: 4 * MINUTE_MS,
          total_no_data_time_milli: 0,
          total_light_sleep_time_milli: 20 * MINUTE_MS,
          total_slow_wave_sleep_time_milli: 6 * MINUTE_MS,
          total_rem_sleep_time_milli: 0,
          sleep_cycle_count: 1,
          disturbance_count: 1,
        },
        sleep_consistency_percentage: null,
        sleep_performance_percentage: null,
      },
    };
    withNap.sleeps.unshift(nap);

    const without = await runDay(base, { date: "2026-09-16" });
    const day = await runDay(withNap, { date: "2026-09-16", include_timeline: true });
    expect(day.naps).toEqual([
      {
        id: nap.id,
        start_local: "2026-09-16T14:05:00.000+02:00",
        end_local: "2026-09-16T14:35:00.000+02:00",
        score_state: "SCORED",
        asleep_hours: roundTo(26 / 60, 2),
      },
    ]);
    expect(day.sleep!.id).toBe(IDS.sleeps.second);
    expect(day.sleep!.asleep_hours).toBe(without.sleep!.asleep_hours);
    expect(day.notes).toContain(
      "1 nap is listed separately in naps and not included in the main sleep's asleep_hours."
    );
    expect(day.timeline.filter((entry) => entry.kind === "nap")).toHaveLength(1);
    expect(day.data_quality.sources.sleep!.records_used).toBe(2);
  });

  it("leaves unscored workouts out of totals and notes low recording", async () => {
    const user = liveShapedUser();
    user.workouts = user.workouts.map((workout) => {
      if (workout.id === IDS.workouts.middayWalk) {
        return { ...workout, score_state: "PENDING_SCORE", score: null };
      }
      if (workout.id === IDS.workouts.padel) {
        const zones = workout.score!.zone_durations;
        const half = (value: number): number => Math.round(value / 2);
        return {
          ...workout,
          score: {
            ...workout.score!,
            percent_recorded: 0.5,
            zone_durations: {
              zone_zero_milli: half(zones.zone_zero_milli),
              zone_one_milli: half(zones.zone_one_milli),
              zone_two_milli: half(zones.zone_two_milli),
              zone_three_milli: half(zones.zone_three_milli),
              zone_four_milli: half(zones.zone_four_milli),
              zone_five_milli: half(zones.zone_five_milli),
            },
          },
        };
      }
      return workout;
    });
    const day = await runDay(user, { date: "2026-09-15" });
    const pending = day.workouts.find((workout) => workout.id === IDS.workouts.middayWalk)!;
    expect(pending).toMatchObject({
      score_state: "PENDING_SCORE",
      strain: null,
      kilojoule: null,
      trimp: null,
      zone_minutes: null,
      flags: ["not_scored"],
    });
    const padel = day.workouts.find((workout) => workout.id === IDS.workouts.padel)!;
    expect(padel.flags).toEqual(["low_recording"]);
    const scoredKj = user.workouts
      .filter((workout) =>
        [IDS.workouts.morningRun, IDS.workouts.weightliftingDay2, IDS.workouts.padel].includes(
          workout.id as never
        )
      )
      .reduce((sum, workout) => sum + workout.score!.kilojoule, 0);
    expect(day.workout_totals).toMatchObject({
      count: 4,
      trimp: null,
      kilojoule: roundTo(scoredKj, 0),
      workout_kj_share_of_day_pct: null,
    });
    expect(day.notes).toContain(
      "1 workout is not scored (pending or unscorable): score values are null and left out of workout_totals, and total TRIMP is null."
    );
    expect(day.notes).toContain(
      "1 workout recorded heart rate for less than 90% of its duration (flag low_recording); zone minutes and TRIMP cover only the recorded part."
    );
    expect(day.data_quality.sources.workout).toMatchObject({
      records_used: 3,
      exclusions: { pending: 1 },
    });
    assertNeutralText(textOf(day));
  });

  it("holds back a scored recovery while its sleep is PENDING_SCORE", async () => {
    const user = liveShapedUser();
    user.sleeps = user.sleeps.map((sleep) =>
      sleep.id === IDS.sleeps.second
        ? { ...sleep, score_state: "PENDING_SCORE", score: null }
        : sleep
    );
    const client = clientFor(user);

    const day = await runDay(user, { date: "2026-09-16" }, client);
    expect(day.sleep).toMatchObject({
      id: IDS.sleeps.second,
      score_state: "PENDING_SCORE",
      asleep_hours: null,
      need_hours: null,
      consistency_pct: null,
      consistency_reason: null,
    });
    expect(day.recovery).toEqual({
      score_state: "SCORED",
      recovery_score: null,
      zone: null,
      hrv_rmssd_milli: null,
      resting_heart_rate: null,
      spo2_pct: null,
      skin_temp_celsius: null,
      calibrating: null,
      held_back: true,
    });
    expect(day.notes).toContain(
      "Recovery for 2026-09-16 is held back (held_back: true) until WHOOP finishes scoring its sleep."
    );
    expect(day.notes).toContain(
      "The sleep for 2026-09-16 is still being scored by WHOOP; its values are null."
    );
    expect(day.data_quality.sources.recovery).toMatchObject({
      status: "pending",
      records_used: 0,
      exclusions: { held_back: 1 },
    });
    expect(day.data_quality.sources.sleep).toMatchObject({
      status: "pending",
      exclusions: { pending: 1 },
    });

    const before = await runDay(user, { date: "2026-09-15" }, client);
    expect(before.next_morning).toMatchObject({
      date: "2026-09-16",
      status: "pending",
      recovery_score: null,
    });
  });

  it("with the cycle stream failing: records without a cycle, a warning and fallback-placed workouts", async () => {
    const user = liveShapedUser();
    const client = clientFor(user, {
      failures: [
        {
          path: /^\/v2\/cycle\?start=/,
          error: () => new WhoopApiError(500, "Internal Server Error", {}),
        },
      ],
    });
    const day = await runDay(user, { date: "2026-09-15" }, client);

    expect(day.status).toBe("records_without_cycle");
    expect(day.cycle).toBeNull();
    expect(day.sleep!.id).toBe(IDS.sleeps.first);
    expect(day.recovery!.recovery_score).toBe(58);
    expect(day.workouts.map((workout) => workout.id)).toEqual([
      IDS.workouts.morningRun,
      IDS.workouts.middayWalk,
      IDS.workouts.weightliftingDay2,
      IDS.workouts.padel,
    ]);
    expect(day.workouts.every((workout) => workout.flags.includes("day_by_fallback"))).toBe(true);
    expect(day.warnings).toContain(
      "Cycle data could not be loaded (WHOOP API returned HTTP 500), so the cycle, strain and energy are null and workouts are placed on their local start day."
    );
    expect(day.warnings).toContain(
      "4 workouts on 2026-09-15 are not inside a loaded WHOOP cycle and were placed on their local start day (flag day_by_fallback)."
    );
    expect(day.notes[0]).toContain("No WHOOP cycle is available for 2026-09-15");
    expect(day.next_morning.status).toBe("unavailable");
    expect(day.workout_totals).toMatchObject({ count: 4, workout_kj_share_of_day_pct: null });
    expect(day.data_quality.sources.cycle!.status).toBe("fetch_failed");
    expect(day.truncated).toBe(false);
    assertNeutralText(textOf(day));
  });

  it("throws the WHOOP error when every source fails", async () => {
    const user = liveShapedUser();
    const client = clientFor(user, {
      failures: [
        {
          path: /\?start=/,
          error: () => new WhoopApiError(503, "Service Unavailable", {}),
        },
      ],
    });
    await expect(getDay({ date: "2026-09-15" }, contextFor(client, user.now))).rejects.toThrow(
      WhoopApiError
    );
  });

  it("marks truncated history with a warning when a later page fails", async () => {
    const user = stressUser();
    const today = localDay(user.now.toISOString(), user.offset);
    const client = clientFor(user, {
      failures: [
        {
          path: /^\/v2\/activity\/workout\?start=/,
          page: 2,
          error: () => new WhoopApiError(500, "Internal Server Error", {}),
        },
      ],
    });
    const day = await runDay(user, { date: addDays(today, -1) }, client);
    expect(day.truncated).toBe(true);
    expect(day.warnings.some((warning) => warning.includes("could not be read completely"))).toBe(
      true
    );
    expect(day.data_quality.sources.workout!.truncated).toBe(true);
  });

  it("shows no data for a day before the account's first record without claiming the strap was off", async () => {
    const user = liveShapedUser();
    const day = await runDay(user, { date: "2026-09-10" });
    expect(day.status).toBe("no_data");
    expect(day.notes).toEqual(["No WHOOP records for this day (2026-09-10)."]);
    expect(day.workout_totals).toBeNull();
    expect(day.workouts).toEqual([]);
    expect(day.previous_day).toBeNull();
    expect(day.next_morning.status).toBe("missing");
    expect(day.data_quality.observed_period).toBeNull();
  });

  it("builds a time-ordered timeline only when asked", async () => {
    const user = liveShapedUser();
    const client = clientFor(user);
    const plain = await runDay(user, { date: "2026-09-15" }, client);
    expect(plain.timeline).toEqual([]);

    const day = await runDay(user, { date: "2026-09-15", include_timeline: true }, client);
    expect(day.timeline.map((entry) => entry.kind)).toEqual([
      "cycle_start",
      "sleep",
      "workout",
      "workout",
      "workout",
      "workout",
      "cycle_end",
    ]);
    expect(day.timeline[0]).toEqual({
      kind: "cycle_start",
      start_local: "2026-09-15T00:39:27.317+02:00",
      end_local: null,
      label: "WHOOP cycle started (sleep onset)",
      id: String(IDS.cycles.afterMidnightOnset),
    });
    const starts = day.timeline.map((entry) => Date.parse(entry.start_local));
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    // Everything except the timeline is the same as without it.
    expect(stable({ ...day, timeline: [] })).toEqual(stable({ ...plain, timeline: [] }));
  });

  it("caps workouts at 25 and the timeline at 60 while totals cover every workout", async () => {
    const user = liveShapedUser();
    const extra = 60;
    for (let index = 0; index < extra; index++) {
      user.workouts.push(
        makeWorkout({
          id: `d0d0d0d0-0000-4000-8000-${String(index).padStart(12, "0")}`,
          startMs: Date.parse("2026-09-16T11:00:00+02:00") + index * 5 * MINUTE_MS,
          minutes: 4,
          offset: "+02:00",
          userId: IDS.userId,
        })
      );
    }
    const day = await runDay(user, { date: "2026-09-16", include_timeline: true });
    expect(day.workouts).toHaveLength(MAX_DAY_WORKOUTS);
    expect(day.workout_totals!.count).toBe(extra + 3);
    expect(day.timeline).toHaveLength(MAX_TIMELINE_ENTRIES);
    expect(day.output_capped).toBe(true);
    expect(day.notes).toContain(
      `Only the first ${MAX_DAY_WORKOUTS} of ${extra + 3} workouts are listed (output_capped: true); workout_totals cover all of them.`
    );
    expect(JSON.stringify(day).length).toBeLessThan(MAX_TOOL_TEXT_CHARS);
  });
});

// ---------------------------------------------------------------------------
// Input and the cycle_id path
// ---------------------------------------------------------------------------

describe("get_day input", () => {
  const now = new Date("2026-09-16T23:30:00+02:00");

  it("resolves today, yesterday, dates and a date-time's local day", () => {
    expect(resolveGetDayDate(undefined, now, "+02:00")).toBe("2026-09-16");
    expect(resolveGetDayDate("today", now, "+02:00")).toBe("2026-09-16");
    expect(resolveGetDayDate("yesterday", now, "+02:00")).toBe("2026-09-15");
    expect(resolveGetDayDate("2026-09-14", now, "+02:00")).toBe("2026-09-14");
    // 23:50 at −05:00 is 06:50 the next morning at +02:00.
    expect(resolveGetDayDate("2026-09-15T23:50:00-05:00", now, "+02:00")).toBe("2026-09-16");
    expect(resolveGetDayDate("2026-09-15T23:50:00", now, "+02:00")).toBe("2026-09-15");
  });

  it("rejects ranges, future days and unparseable values", () => {
    expect(() => resolveGetDayDate("last week", now, "+02:00")).toThrow(
      /get_day shows one local day; use get_calendar for ranges\./
    );
    expect(() => resolveGetDayDate("last 2 days", now, "+02:00")).toThrow(InvalidDateExpression);
    expect(() => resolveGetDayDate("2026-09", now, "+02:00")).toThrow(InvalidDateExpression);
    expect(() => resolveGetDayDate("2026-09-17", now, "+02:00")).toThrow(
      "2026-09-17 is after today (2026-09-16); get_day shows days up to today."
    );
    expect(() => resolveGetDayDate("someday", now, "+02:00")).toThrow(InvalidDateExpression);
  });

  it("rejects date and cycle_id together", async () => {
    const user = liveShapedUser();
    const client = clientFor(user);
    await expect(
      getDay({ date: "2026-09-15", cycle_id: IDS.cycles.open }, contextFor(client, user.now))
    ).rejects.toThrow("Pass either date or cycle_id, not both");
    expect(client.calls).toEqual([]);
  });

  it("the cycle_id path equals the date path", async () => {
    const user = liveShapedUser();
    for (const [cycleId, date] of [
      [IDS.cycles.firstDay, "2026-09-14"],
      [IDS.cycles.afterMidnightOnset, "2026-09-15"],
      [IDS.cycles.open, "2026-09-16"],
    ] as const) {
      const byId = await runDay(user, { cycle_id: cycleId, include_timeline: true });
      const byDate = await runDay(user, { date, include_timeline: true });
      expect(stable(byId)).toEqual(stable(byDate));
    }
  });

  it("the cycle_id path lands on the day placeDays gives each cycle", async () => {
    const user = matureUser({ days: 14, seed: 3 });
    const client = clientFor(user);
    const today = localDay(user.now.toISOString(), user.offset);
    const placement = placeDays({
      cycles: user.cycles,
      sleeps: user.sleeps,
      recoveries: user.recoveries,
      sleepsAvailable: true,
      today,
      utcOffset: user.offset,
    });
    for (const cycle of user.cycles.slice(0, 6)) {
      const expectedDay = placement.dayOfCycle.get(cycle.id)!;
      const byId = await runDay(user, { cycle_id: cycle.id }, client);
      expect(byId.date).toBe(expectedDay);
    }
  });
});

// ---------------------------------------------------------------------------
// Offsets, parity and placement
// ---------------------------------------------------------------------------

describe("get_day offsets and parity", () => {
  it("a −05:00 clone shows the same local days, values and workout placement", async () => {
    const plus = liveShapedUser();
    const minus = atOffset(plus, "-05:00");
    for (const date of ["2026-09-14", "2026-09-15", "2026-09-16"]) {
      const a = await runDay(plus, { date, include_timeline: true });
      const b = await runDay(minus, { date, include_timeline: true });
      const localClock = (value: string | null): string | null =>
        value === null ? null : value.slice(0, 23);
      expect(b.utc_offset).toBe("-05:00");
      expect(b.status).toBe(a.status);
      expect({ ...b.cycle, start_local: null, end_local: null }).toEqual({
        ...a.cycle,
        start_local: null,
        end_local: null,
      });
      expect(localClock(b.cycle!.start_local)).toBe(localClock(a.cycle!.start_local));
      expect(b.recovery).toEqual(a.recovery);
      expect(b.sleep?.asleep_hours).toBe(a.sleep?.asleep_hours);
      expect(b.workouts.map((workout) => [workout.id, workout.day, workout.flags])).toEqual(
        a.workouts.map((workout) => [workout.id, workout.day, workout.flags])
      );
      expect(b.workouts.map((workout) => localClock(workout.start_local))).toEqual(
        a.workouts.map((workout) => localClock(workout.start_local))
      );
      expect(b.workout_totals).toEqual(a.workout_totals);
      expect(b.previous_day).toEqual(a.previous_day);
      expect(b.next_morning).toEqual(a.next_morning);
      expect(b.notes).toEqual(a.notes);
    }
  });

  it("matches get_calendar rows on a 14-day mature user and places every workout once", async () => {
    const user = matureUser({ days: 14 });
    const client = clientFor(user);
    const calendar = await getCalendar(client, { days: 14 }, user.now);
    expect(calendar.days).toHaveLength(14);

    const seen = new Map<string, string>();
    for (const row of calendar.days) {
      const day = await runDay(user, { date: row.date }, client);
      expect(day.date).toBe(row.date);
      const recoveryScore = day.recovery?.recovery_score ?? null;
      expect(recoveryScore).toBe(roundTo(row.recovery_score, 1));
      expect(day.recovery?.calibrating ?? null).toBe(row.recovery_calibrating);
      const asleep = day.sleep?.asleep_hours ?? null;
      if (row.sleep_hours === null) expect(asleep).toBeNull();
      else expect(Math.abs(asleep! - row.sleep_hours)).toBeLessThanOrEqual(0.05 + 1e-9);
      expect(day.cycle?.day_strain ?? null).toBe(roundTo(row.day_strain, 2));
      expect(day.cycle?.in_progress ?? false).toBe(row.day_strain_in_progress);
      expect(day.cycle?.partial_first_day ?? false).toBe(row.day_strain_partial);
      if (day.cycle === null)
        expect(["no_data", "no_cycle_yet", "records_without_cycle"]).toContain(day.status);
      for (const workout of day.workouts) {
        expect(seen.has(workout.id)).toBe(false);
        seen.set(workout.id, day.date);
      }
      assertNeutralText(textOf(day));
    }

    // The narrow per-day window places workouts as a full-history placement does.
    const today = localDay(user.now.toISOString(), user.offset);
    const placement = placeDays({
      cycles: user.cycles,
      sleeps: user.sleeps,
      recoveries: user.recoveries,
      sleepsAvailable: true,
      today,
      utcOffset: user.offset,
    });
    const assigned = assignWorkouts(user.workouts, placement, user.cycles);
    const gridDays = new Set(calendar.days.map((row) => row.date));
    const expected = new Map(
      [...assigned]
        .filter(([, value]) => gridDays.has(value.day))
        .map(([id, value]) => [id, value.day])
    );
    expect(seen).toEqual(expected);
    expect(
      user.workouts.some(
        (workout) =>
          localDay(workout.start, workout.timezone_offset) !== assigned.get(workout.id)!.day
      )
    ).toBe(true);
  });

  it("warns on a split night where two cycles share one day", async () => {
    const user = matureUser({ days: 14 });
    const client = clientFor(user);
    const today = localDay(user.now.toISOString(), user.offset);
    const placement = placeDays({
      cycles: user.cycles,
      sleeps: user.sleeps,
      recoveries: user.recoveries,
      sleepsAvailable: true,
      today,
      utcOffset: user.offset,
    });
    expect(placement.displaced.length).toBeGreaterThan(0);
    const { day: splitDay, shown, other } = placement.displaced[0]!;
    const day = await runDay(user, { date: splitDay }, client);
    expect(day.cycle!.id).toBe(shown.id);
    expect(
      day.warnings.some(
        (warning) =>
          warning.startsWith(`Two WHOOP cycles belong to ${splitDay}`) &&
          warning.includes(`(id ${other.id})`)
      )
    ).toBe(true);
    const byId = await runDay(user, { cycle_id: other.id }, client);
    expect(byId.date).toBe(splitDay);
    expect(byId.warnings).toContain(
      `Cycle ${other.id} belongs to ${splitDay}, but another cycle is shown for that day (see the warning about two cycles).`
    );
  });
});

// ---------------------------------------------------------------------------
// Size, requests and the MCP contract
// ---------------------------------------------------------------------------

describe("get_day size, requests and contract", () => {
  it("stays within the request budget on stressUser and is served from the history cache on repeat", async () => {
    const user = stressUser();
    const client = clientFor(user);
    const cache = new MemoryCache({ maxEntries: 500 });
    const first = await runDay(user, { include_timeline: true }, client, { historyCache: cache });
    expect(first.status).toBe("in_progress");
    expect(client.calls.length).toBeLessThanOrEqual(DEFAULT_PAGE_BUDGET + 2);
    expect(JSON.stringify(first).length).toBeLessThanOrEqual(MAX_TOOL_TEXT_CHARS);

    const before = client.calls.length;
    const second = await runDay(user, { include_timeline: true }, client, { historyCache: cache });
    expect(client.calls.slice(before).filter((path) => path.includes("start="))).toEqual([]);
    expect(second).toEqual({
      ...first,
      data_quality: {
        ...first.data_quality,
        sources: second.data_quality.sources,
      },
    });
    expect(
      Object.values(second.data_quality.sources).every((source) => source.cache_status === "hit")
    ).toBe(true);
  });

  it("is registered in standard mode only, with a short title and read-only annotation", async () => {
    expect(GET_DAY_TOOL.aggregate).toBeUndefined();
    expect(GET_DAY_TOOL.standard.title).toBe("Day details");
    expect(GET_DAY_TOOL.annotations).toEqual({ readOnlyHint: true });
    expect(GET_DAY_TOOL.standard.description.length).toBeLessThanOrEqual(1000);
    expect(await listToolNames("standard")).toContain("get_day");
    expect(await listToolNames("aggregate")).not.toContain("get_day");
  });

  it("validates its contract through the MCP server and keeps stressUser text within the limit", async () => {
    const live = liveShapedUser();
    const connection = await connectServer(clientFor(live), { now: () => live.now });
    try {
      const tool = connection.tools.find((candidate) => candidate.name === "get_day");
      expect(tool?.outputSchema).toBeDefined();
      const result = await connection.callTool("get_day", {
        date: "2026-09-15",
        include_timeline: true,
      });
      expect(result.isError).toBe(false);
      expect(result.structured).toMatchObject({ date: "2026-09-15", status: "complete" });
      expect(result.text).toBe(JSON.stringify(result.structured));

      const range = await connection.callTool("get_day", { date: "last week" });
      expect(range.isError).toBe(true);
      expect(range.text).toContain("get_day shows one local day; use get_calendar for ranges.");

      const both = await connection.callTool("get_day", { date: "today", cycle_id: 1 });
      expect(both.isError).toBe(true);
      expect(both.text).toContain("Pass either date or cycle_id, not both");

      const unknown = await connection.callTool("get_day", { cycle_id: 999_999 });
      expect(unknown.isError).toBe(true);
      expect(unknown.text).toContain("WHOOP found no matching record (HTTP 404)");

      const tooLong = await connection.callTool("get_day", { date: "x".repeat(41) });
      expect(tooLong.isError).toBe(true);
    } finally {
      await connection.close();
    }

    const stress = stressUser();
    const stressConnection = await connectServer(clientFor(stress), { now: () => stress.now });
    try {
      const today = localDay(stress.now.toISOString(), stress.offset);
      for (const date of [today, addDays(today, -1), addDays(today, -100)]) {
        const result = await stressConnection.callTool("get_day", { date, include_timeline: true });
        expect(result.isError).toBe(false);
        expect(result.text.length).toBeLessThanOrEqual(MAX_TOOL_TEXT_CHARS);
      }
    } finally {
      await stressConnection.close();
    }
  });
});
