/**
 * Tests for get_workout_context (package P7, standard mode only).
 *
 * Covers: a closed-cycle session on the live-shaped account (calibrating
 * recovery before, sleep and recovery after, gap to sleep onset, other
 * sessions of the day), the partial first day, an open cycle (not_yet), a
 * missing or pending night, a strap-off gap (not_yet), source failures,
 * comparison percentiles with ties (10 earlier sessions), insufficient data
 * (4 earlier sessions), pace over GPS sessions only, a low-recording target,
 * input validation, 404 guidance, mature data, the MCP contract and absence
 * in aggregate mode.
 */

import { describe, expect, it } from "vitest";
import { WhoopApiError } from "../../src/api/client.js";
import type { Cycle, Recovery, ScoreState, Sleep, Workout } from "../../src/api/types.js";
import { localMidnightMs } from "../../src/tools/analytics-utils.js";
import { addDays } from "../../src/tools/day-model.js";
import {
  getWorkoutContext,
  MIN_PRIOR_SESSIONS,
  MORNING_RECOVERY_NOTE,
  OPEN_CYCLE_NOTE,
  SINGLE_OBSERVATION_NOTE,
  workoutContextInputSchema,
  workoutContextOutputSchema,
  type WorkoutContextOutput,
} from "../../src/tools/get-workout-context.js";
import { MAX_TOOL_TEXT_CHARS, type ToolContext } from "../../src/tools/tool-definition.js";
import { assertNeutralText, connectServer, listToolNames } from "../helpers/contract.js";
import {
  createWhoopFixtureClient,
  type WhoopFixtureClientOptions,
} from "../helpers/whoop-fixture-client.js";
import {
  LIVE_SHAPED_IDS,
  liveShapedUser,
  matureUser,
  type WhoopUserFixture,
} from "../helpers/whoop-users.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const OFFSET = "+02:00";
const TODAY = "2026-09-16";
const IDS = LIVE_SHAPED_IDS;

const iso = (ms: number): string => new Date(ms).toISOString();

type Options = WhoopFixtureClientOptions & { now: Date };

function contextFor(options: Options): ToolContext {
  const client = createWhoopFixtureClient(options);
  return { client, privacyMode: "standard", now: () => options.now, startedAtMs: Date.now() };
}

async function run(
  options: Options,
  id: string,
  compareDays?: number
): Promise<WorkoutContextOutput> {
  const output = await getWorkoutContext(
    workoutContextInputSchema.parse(
      compareDays === undefined ? { id } : { id, compare_days: compareDays }
    ),
    contextFor(options)
  );
  workoutContextOutputSchema.parse(output);
  assertNeutralText([output.notes, output.warnings]);
  return output;
}

function live(
  edit: (fixture: WhoopUserFixture) => Partial<WhoopUserFixture> = () => ({})
): Options {
  const fixture = liveShapedUser();
  return { ...fixture, ...edit(fixture), now: fixture.now };
}

// ---------------------------------------------------------------------------
// Planned accounts
// ---------------------------------------------------------------------------

interface SessionPlan {
  day: string;
  minute: number;
  minutes: number;
  sport?: string;
  strain?: number;
  hr?: number;
  fraction?: number;
  /** Elapsed pace in seconds per km; the distance follows from the duration */
  pace?: number | null;
  state?: ScoreState;
}

function localMs(day: string, minute: number): number {
  return localMidnightMs(day, OFFSET) + minute * MINUTE_MS;
}

function workoutOf(plan: SessionPlan, id: string): Workout {
  const startMs = localMs(plan.day, plan.minute);
  const durationMs = plan.minutes * MINUTE_MS;
  const fraction = plan.fraction ?? 1;
  const recordedMs = Math.round(durationMs * fraction);
  const state = plan.state ?? "SCORED";
  const pace = plan.pace ?? null;
  return {
    user_id: 1,
    created_at: iso(startMs + durationMs + MINUTE_MS),
    updated_at: iso(startMs + durationMs + MINUTE_MS),
    score_state: state,
    start: iso(startMs),
    end: iso(startMs + durationMs),
    timezone_offset: OFFSET,
    id,
    sport_name: plan.sport ?? "running",
    sport_id: plan.sport === undefined || plan.sport === "running" ? 0 : 63,
    v1_id: null,
    score:
      state === "SCORED"
        ? {
            strain: plan.strain ?? 10,
            average_heart_rate: plan.hr ?? 150,
            max_heart_rate: 180,
            kilojoule: 900,
            percent_recorded: fraction,
            zone_durations: {
              zone_zero_milli: 0,
              zone_one_milli: 0,
              zone_two_milli: recordedMs,
              zone_three_milli: 0,
              zone_four_milli: 0,
              zone_five_milli: 0,
            },
            distance_meter: pace === null ? null : ((plan.minutes * 60) / pace) * 1000,
            altitude_gain_meter: null,
            altitude_change_meter: null,
          }
        : null,
  };
}

/** One cycle per local day starting 23:00 the evening before; the last (today's) is open */
function cyclesFor(firstDay: string, lastDay: string): Cycle[] {
  const cycles: Cycle[] = [];
  for (let day = firstDay, index = 0; day <= lastDay; day = addDays(day, 1), index++) {
    const startMs = localMs(addDays(day, -1), 23 * 60);
    const last = day === lastDay;
    cycles.push({
      user_id: 1,
      created_at: iso(startMs + 8 * HOUR_MS),
      updated_at: iso(startMs + 25 * HOUR_MS),
      score_state: "SCORED",
      start: iso(startMs),
      end: last ? null : iso(startMs + 24 * HOUR_MS),
      timezone_offset: OFFSET,
      id: 9000 + index,
      score: { strain: 11, kilojoule: 9000, average_heart_rate: 70, max_heart_rate: 170 },
    });
  }
  return cycles;
}

const TARGET: SessionPlan = {
  day: TODAY,
  minute: 8 * 60,
  minutes: 50,
  pace: 300,
  strain: 10,
  hr: 150,
};

/** Ten earlier scored runs with ties; three without GPS and one recorded at 80% */
const PRIORS: SessionPlan[] = [
  { day: "2026-09-01", minute: 480, minutes: 40, pace: 280, strain: 8, hr: 140 },
  { day: "2026-09-02", minute: 480, minutes: 45, pace: 290, strain: 10, hr: 150 },
  { day: "2026-09-03", minute: 480, minutes: 50, pace: 300, strain: 10, hr: 150 },
  { day: "2026-09-04", minute: 480, minutes: 50, pace: 300, strain: 12, hr: 155 },
  { day: "2026-09-05", minute: 480, minutes: 55, pace: 310, strain: 9, hr: 145 },
  { day: "2026-09-06", minute: 480, minutes: 60, pace: 320, strain: 11, hr: 160 },
  { day: "2026-09-07", minute: 480, minutes: 30, pace: 330, strain: 7, hr: 135 },
  { day: "2026-09-08", minute: 480, minutes: 35, pace: null, strain: 10, hr: 150 },
  { day: "2026-09-09", minute: 480, minutes: 50, pace: null, strain: 13, hr: 165 },
  { day: "2026-09-10", minute: 480, minutes: 65, pace: null, strain: 6, hr: 130, fraction: 0.8 },
];

function plannedAccount(priors: readonly SessionPlan[], target: SessionPlan = TARGET): Options {
  const others: SessionPlan[] = [
    { day: "2026-09-11", minute: 480, minutes: 40, sport: "walking" },
    { day: "2026-09-12", minute: 480, minutes: 40, state: "PENDING_SCORE" },
    // 100 days earlier: outside the default 90-day comparison.
    { day: addDays(TODAY, -100), minute: 480, minutes: 45, pace: 250, strain: 15 },
  ];
  return {
    cycles: cyclesFor(addDays(TODAY, -110), TODAY),
    workouts: [
      workoutOf(target, "target"),
      ...priors.map((plan, index) => workoutOf(plan, `prior-${index}`)),
      ...others.map((plan, index) => workoutOf(plan, `other-${index}`)),
    ],
    now: new Date(localMs(TODAY, 22 * 60)),
  };
}

// ---------------------------------------------------------------------------
// Day, before and after on the live-shaped account
// ---------------------------------------------------------------------------

describe("liveShapedUser", () => {
  it("joins a closed-cycle session with the calibrating recovery before and the night after", async () => {
    const fixture = liveShapedUser();
    const output = await run(live(), IDS.workouts.morningRun);
    expect(output.workout).toMatchObject({
      id: IDS.workouts.morningRun,
      sport_id: 0,
      day: "2026-09-15",
    });
    expect(output.day).toEqual({
      date: "2026-09-15",
      day_strain: 15.88,
      in_progress: false,
      partial: false,
      other_workouts: [
        {
          id: IDS.workouts.middayWalk,
          sport_name: "walking",
          start_local: "2026-09-15T12:31:22.940+02:00",
          strain: 4.41,
        },
        {
          id: IDS.workouts.weightliftingDay2,
          sport_name: "weightlifting_msk",
          start_local: "2026-09-15T17:40:05.331+02:00",
          strain: 8.72,
        },
        {
          id: IDS.workouts.padel,
          sport_name: "padel",
          start_local: "2026-09-15T20:05:17.402+02:00",
          strain: 12.61,
        },
      ],
    });
    expect(output.before.recovery).toEqual({
      status: "available",
      score: 58,
      zone: "yellow",
      hrv_rmssd_milli: 71.4,
      resting_heart_rate: 61,
      calibrating: true,
    });
    const sleep = fixture.sleeps.find((entry) => entry.id === IDS.sleeps.second)!;
    const stages = sleep.score!.stage_summary;
    const asleepHours =
      (stages.total_light_sleep_time_milli +
        stages.total_slow_wave_sleep_time_milli +
        stages.total_rem_sleep_time_milli) /
      HOUR_MS;
    const workout = fixture.workouts.find((entry) => entry.id === IDS.workouts.morningRun)!;
    const gapHours = (Date.parse(sleep.start) - Date.parse(workout.end)) / HOUR_MS;
    expect(output.after).toEqual({
      status: "available",
      date: TODAY,
      gap_to_sleep_onset_hours: Math.round(gapHours * 10) / 10,
      sleep: {
        asleep_hours: Math.round(asleepHours * 100) / 100,
        performance_pct: 83,
        efficiency_pct: 91.73,
        need_from_recent_strain_hours: 0.95,
      },
      recovery: {
        score: 67,
        zone: "green",
        hrv_rmssd_milli: 84.9,
        resting_heart_rate: 58,
        calibrating: true,
      },
    });
    expect(output.after.gap_to_sleep_onset_hours).toBe(14.7);
    expect(output.notes).toContain(MORNING_RECOVERY_NOTE);
    expect(output.notes).toContain(SINGLE_OBSERVATION_NOTE);
    expect(output.notes.join(" ")).toMatch(/calibrating/);
    expect(output.comparison).toMatchObject({
      sport_name: "running",
      compare_days: 90,
      prior_sessions: 0,
      status: "insufficient_data",
    });
    expect(output.truncated).toBe(false);
    expect(output.warnings).toEqual([]);
    expect(output.data_quality.method_version).toBe("workout-context-1");
    expect(output.data_quality.sources.workout!.status).toBe("available");
    expect(output.data_quality.sources.recoveries!.records_used).toBe(2);
  });

  it("marks the partial first day: no recovery before, the first night after", async () => {
    const output = await run(live(), IDS.workouts.lateWalk);
    expect(output.day).toMatchObject({ date: "2026-09-14", partial: true, in_progress: false });
    expect(output.day.day_strain).toBe(9.42);
    expect(output.before.recovery).toMatchObject({ status: "missing", score: null });
    expect(output.notes).not.toContain(MORNING_RECOVERY_NOTE);
    expect(output.after).toMatchObject({
      status: "available",
      date: "2026-09-15",
      gap_to_sleep_onset_hours: 1,
    });
    expect(output.after.recovery).toMatchObject({ score: 58, calibrating: true });
    expect(output.notes.join(" ")).toMatch(/first day WHOOP was worn/);
  });

  it("reports not_yet while the session's cycle is open", async () => {
    const output = await run(live(), IDS.workouts.eveningRun);
    expect(output.day).toMatchObject({ date: TODAY, day_strain: null, in_progress: true });
    expect(output.after).toEqual({
      status: "not_yet",
      date: null,
      gap_to_sleep_onset_hours: null,
      sleep: null,
      recovery: null,
    });
    expect(output.comparison).toMatchObject({ prior_sessions: 1, status: "insufficient_data" });
    expect(output.notes.join(" ")).toMatch(/1 of 5 found/);
  });

  it("says the open cycle has no sleep after the session yet, without claiming it does not exist", async () => {
    const output = await run(live(), IDS.workouts.eveningRun);
    expect(output.notes).toContain(OPEN_CYCLE_NOTE);
    expect(output.notes.join(" ")).not.toMatch(/do(es)? not exist/);
    // The cycle's sleep ended 06:58 local, 16.5 hours before 23:30: not stale.
    expect(output.notes.join(" ")).not.toMatch(/not processed a newer one/);
  });

  it("reports a missing recovery after the session as missing, not as an error", async () => {
    const options = live((fixture) => ({
      recoveries: fixture.recoveries.filter((recovery) => recovery.cycle_id !== IDS.cycles.open),
    }));
    const output = await run(options, IDS.workouts.morningRun);
    expect(output.after.status).toBe("missing");
    expect(output.after.recovery).toBeNull();
    expect(output.after.sleep).toMatchObject({ performance_pct: 83 });
    expect(output.before.recovery.status).toBe("available");
  });

  it("reports a night WHOOP is still scoring as pending", async () => {
    const options = live((fixture) => ({
      sleeps: fixture.sleeps.map(
        (sleep): Sleep =>
          sleep.id === IDS.sleeps.second
            ? { ...sleep, score_state: "PENDING_SCORE", score: null }
            : sleep
      ),
      recoveries: fixture.recoveries.map(
        (recovery): Recovery =>
          recovery.cycle_id === IDS.cycles.open
            ? { ...recovery, score_state: "PENDING_SCORE", score: null }
            : recovery
      ),
    }));
    const output = await run(options, IDS.workouts.morningRun);
    expect(output.after.status).toBe("pending");
    expect(output.after.sleep).toEqual({
      asleep_hours: null,
      performance_pct: null,
      efficiency_pct: null,
      need_from_recent_strain_hours: null,
    });
    expect(output.after.recovery).toEqual({
      score: null,
      zone: null,
      hrv_rmssd_milli: null,
      resting_heart_rate: null,
      calibrating: null,
    });
    expect(output.after.gap_to_sleep_onset_hours).toBe(14.7);
  });

  it("reports not_yet after a strap-off gap instead of borrowing a later night", async () => {
    const options = live((fixture) => ({
      // The 09-16 cycle, its sleep and recovery never happened (strap off from 23:13).
      cycles: fixture.cycles.filter((cycle) => cycle.id !== IDS.cycles.open),
      sleeps: fixture.sleeps.filter((sleep) => sleep.cycle_id !== IDS.cycles.open),
      recoveries: fixture.recoveries.filter((recovery) => recovery.cycle_id !== IDS.cycles.open),
      workouts: fixture.workouts.filter((workout) => workout.start < "2026-09-16"),
    }));
    const output = await run(options, IDS.workouts.morningRun);
    expect(output.day).toMatchObject({ date: "2026-09-15", in_progress: false, day_strain: 15.88 });
    expect(output.after).toMatchObject({ status: "not_yet", sleep: null, recovery: null });
    expect(output.notes.join(" ")).toMatch(
      /No WHOOP cycle starts where this session's cycle ended/
    );
  });

  it("reports unavailable parts and warnings when sleeps and recoveries fail", async () => {
    const options = live();
    const output = await run(
      {
        ...options,
        failures: [
          { path: /^\/v2\/recovery/, error: new WhoopApiError(500, "x", {}) },
          { path: /^\/v2\/activity\/sleep/, error: new WhoopApiError(503, "x", {}) },
        ],
      },
      IDS.workouts.morningRun
    );
    expect(output.before.recovery).toMatchObject({ status: "unavailable", score: null });
    expect(output.after).toMatchObject({ status: "unavailable", sleep: null, recovery: null });
    expect(output.warnings.join(" ")).toMatch(
      /Recovery data could not be loaded \(WHOOP API returned HTTP 500\)/
    );
    expect(output.warnings.join(" ")).toMatch(
      /Sleep data could not be loaded \(WHOOP API returned HTTP 503\)/
    );
    // The next cycle's start still dates the sleep onset.
    expect(output.after.gap_to_sleep_onset_hours).toBe(14.7);
  });

  it("notes a session after local midnight that counts toward the previous day", async () => {
    const options = live((fixture) => {
      const template = fixture.workouts.find((workout) => workout.id === IDS.workouts.lateWalk)!;
      return {
        workouts: [
          ...fixture.workouts,
          {
            ...template,
            id: "after-midnight",
            start: "2026-09-14T22:20:00.000Z",
            end: "2026-09-14T22:30:00.000Z",
            score: {
              ...template.score!,
              zone_durations: {
                zone_zero_milli: 600_000,
                zone_one_milli: 0,
                zone_two_milli: 0,
                zone_three_milli: 0,
                zone_four_milli: 0,
                zone_five_milli: 0,
              },
            },
          },
        ],
      };
    });
    const output = await run(options, "after-midnight");
    expect(output.workout).toMatchObject({ day: "2026-09-14", local_date: "2026-09-15" });
    expect(output.day.date).toBe("2026-09-14");
    expect(output.day.other_workouts.map((entry) => entry.id)).toEqual([IDS.workouts.lateWalk]);
    expect(output.notes.join(" ")).toMatch(
      /started after local midnight on 2026-09-15 but counts toward 2026-09-14/
    );
    expect(output.after.gap_to_sleep_onset_hours).toBe(0.2);
  });
});

// ---------------------------------------------------------------------------
// Open cycle before WHOOP processes the next sleep (timestamps of the owner's
// account on 2026-09-15..17; ids and values are synthetic)
// ---------------------------------------------------------------------------

describe("open cycle while the next sleep is not processed", () => {
  const RUN_ID = "b4e9f098-0000-4000-8000-000000000001";
  const NIGHTS = [
    // [cycle start = sleep onset, sleep end, cycle end]
    ["2026-09-13T22:00:00.000Z", null, "2026-09-14T22:39:47.770Z"],
    ["2026-09-14T22:39:47.770Z", "2026-09-15T05:59:33.530Z", "2026-09-15T21:13:31.460Z"],
    // Closed at 2026-09-16T21:15:09.780Z in WHOOP once the next sleep synced; open before that.
    ["2026-09-15T21:13:31.460Z", "2026-09-16T05:13:59.350Z", null],
  ] as const;

  function account(nowIso: string): Options {
    const template = liveShapedUser();
    const sleepTemplate = template.sleeps[0]!;
    const recoveryTemplate = template.recoveries[0]!;
    const cycles: Cycle[] = [];
    const sleeps: Sleep[] = [];
    const recoveries: Recovery[] = [];
    NIGHTS.forEach(([start, sleepEnd, end], index) => {
      const id = 88_001 + index;
      cycles.push({
        user_id: 1,
        created_at: sleepEnd ?? start,
        updated_at: end ?? sleepEnd ?? start,
        score_state: "SCORED",
        start,
        end,
        timezone_offset: OFFSET,
        id,
        score: { strain: 12, kilojoule: 9000, average_heart_rate: 75, max_heart_rate: 170 },
      });
      if (sleepEnd === null) return;
      const sleepId = `5a1e0000-0000-4000-8000-00000000000${index}`;
      sleeps.push({
        ...sleepTemplate,
        id: sleepId,
        cycle_id: id,
        user_id: 1,
        start,
        end: sleepEnd,
        created_at: sleepEnd,
        updated_at: sleepEnd,
        timezone_offset: OFFSET,
      });
      recoveries.push({
        ...recoveryTemplate,
        cycle_id: id,
        sleep_id: sleepId,
        user_id: 1,
        created_at: sleepEnd,
        updated_at: sleepEnd,
      });
    });
    const at = (localStart: string): { day: string; minute: number } => ({
      day: localStart.slice(0, 10),
      minute: Number(localStart.slice(11, 13)) * 60 + Number(localStart.slice(14, 16)),
    });
    const workouts = [
      workoutOf({ ...at("2026-09-16T21:33"), minutes: 30, pace: 358, strain: 12.4 }, RUN_ID),
      workoutOf({ ...at("2026-09-16T16:30"), minutes: 65, sport: "weightlifting_msk" }, "lift"),
      workoutOf({ ...at("2026-09-16T08:16"), minutes: 19, sport: "walking" }, "walk"),
      workoutOf({ ...at("2026-09-15T08:18"), minutes: 31, pace: 380 }, "earlier-run"),
    ];
    const now = new Date(nowIso);
    return { cycles, sleeps, recoveries, workouts, now };
  }

  it("names the sleep WHOOP last processed when the open cycle is old (hidden next cycle, 07:45 local)", async () => {
    const output = await run(account("2026-09-17T05:45:00.000Z"), RUN_ID);
    expect(output.day).toMatchObject({ date: "2026-09-16", in_progress: true });
    expect(output.after).toEqual({
      status: "not_yet",
      date: null,
      gap_to_sleep_onset_hours: null,
      sleep: null,
      recovery: null,
    });
    const text = output.notes.join(" ");
    expect(text).not.toMatch(/do(es)? not exist/);
    expect(output.notes).toContain(OPEN_CYCLE_NOTE);
    expect(output.notes).toContain(
      "This cycle began with the sleep that ended 2026-09-16T07:13:59.350+02:00, about 25 hours ago, and WHOOP has not processed a newer one. If you have slept since then, WHOOP has not processed that sleep yet (or did not detect it); opening the WHOOP app to sync may help."
    );
  });

  it("gives only the open-cycle note on the evening of the session (22:30 local)", async () => {
    const output = await run(account("2026-09-16T20:30:00.000Z"), RUN_ID);
    expect(output.after.status).toBe("not_yet");
    expect(output.notes).toContain(OPEN_CYCLE_NOTE);
    expect(output.notes.join(" ")).not.toMatch(/not processed a newer one|do(es)? not exist/);
  });

  it("dates the cycle start when the sleeps cannot be read", async () => {
    const options = account("2026-09-17T05:45:00.000Z");
    const output = await run(
      {
        ...options,
        failures: [{ path: /^\/v2\/activity\/sleep/, error: new WhoopApiError(503, "x", {}) }],
      },
      RUN_ID
    );
    expect(output.notes).toContain(
      "This cycle began 2026-09-15T23:13:31.460+02:00, about 33 hours ago, and WHOOP has not processed a newer one. If you have slept since then, WHOOP has not processed that sleep yet (or did not detect it); opening the WHOOP app to sync may help."
    );
  });
});

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

describe("comparison", () => {
  it("gives mid-rank percentiles with ties against 10 earlier sessions", async () => {
    const output = await run(plannedAccount(PRIORS), "target");
    expect(output.comparison).toEqual({
      sport_name: "running",
      compare_days: 90,
      prior_sessions: 10,
      required_prior_sessions: MIN_PRIOR_SESSIONS,
      status: "available",
      percentiles: {
        // below 4 (30, 35, 40, 45), equal 3 (50 ×3) of 10
        duration: 55,
        // HR-qualified only (the 80% session is left out): below 3, equal 3 of 9
        strain: 50,
        // TRIMP 2 × minutes (100 for the target): below 4, equal 3 of 9
        trimp: 61.1,
        average_heart_rate: 50,
        // GPS sessions only: slower 4 (310, 320, 330 and half of two 300s) of 7 → 57.1
        pace_faster_than_pct: 57.1,
        // beats per km 750: below 4, equal 1 of 7
        beats_per_km: 64.3,
      },
      typical: {
        duration_minutes: 50,
        strain: 10,
        trimp: 100,
        average_heart_rate: 150,
        pace_sec_per_km: 300,
      },
      sample_sizes: {
        duration: 10,
        strain: 9,
        trimp: 9,
        average_heart_rate: 9,
        pace: 7,
        beats_per_km: 7,
      },
    });
    const text = output.notes.join(" ");
    expect(text).toMatch(/1 earlier unscored running session is not compared/);
    expect(output.data_quality.sources.workouts!.exclusions).toMatchObject({
      other_sport: 1,
      pending: 1,
    });
    // No sleep or recovery data in this account: before is missing, after not yet (open cycle).
    expect(output.before.recovery.status).toBe("missing");
    expect(output.after.status).toBe("not_yet");
  });

  it("reports insufficient_data with 4 earlier sessions", async () => {
    const output = await run(plannedAccount(PRIORS.slice(0, 4)), "target");
    expect(output.comparison.status).toBe("insufficient_data");
    expect(output.comparison.prior_sessions).toBe(4);
    expect(Object.values(output.comparison.percentiles).every((value) => value === null)).toBe(
      true
    );
    expect(Object.values(output.comparison.typical).every((value) => value === null)).toBe(true);
    expect(output.notes.join(" ")).toMatch(/4 of 5 found/);
  });

  it("leaves pace out when fewer than 5 earlier sessions have GPS", async () => {
    const priors = PRIORS.map((plan, index) => (index >= 4 ? { ...plan, pace: null } : plan));
    const output = await run(plannedAccount(priors), "target");
    expect(output.comparison.status).toBe("available");
    expect(output.comparison.sample_sizes.pace).toBe(4);
    expect(output.comparison.percentiles.pace_faster_than_pct).toBeNull();
    expect(output.comparison.typical.pace_sec_per_km).toBeNull();
    expect(output.comparison.percentiles.duration).toBe(55);
    expect(output.notes.join(" ")).toMatch(
      /pace \(GPS sessions of at least 1 km with plausible speed\) 4 of 5/
    );
  });

  it("compares only earlier sessions within compare_days", async () => {
    const output = await run(plannedAccount(PRIORS), "target", 14);
    // 09-02 .. 09-10 are within 14 days of 09-16 08:00; 09-01 is not.
    expect(output.comparison.prior_sessions).toBe(9);
    expect(output.comparison.compare_days).toBe(14);
  });

  it("leaves strain and heart-rate metrics out for a target recorded under 90%", async () => {
    const output = await run(plannedAccount(PRIORS, { ...TARGET, fraction: 0.8 }), "target");
    expect(output.comparison.percentiles).toMatchObject({
      duration: 55,
      strain: null,
      trimp: null,
      average_heart_rate: null,
      beats_per_km: null,
      pace_faster_than_pct: 57.1,
    });
    expect(output.notes.join(" ")).toMatch(/under 90%/);
  });
});

// ---------------------------------------------------------------------------
// Validation, errors, mature data and contract
// ---------------------------------------------------------------------------

describe("validation and errors", () => {
  it("rejects a malformed id in the input schema", () => {
    expect(workoutContextInputSchema.safeParse({ id: "../cycle/1" }).success).toBe(false);
    expect(workoutContextInputSchema.safeParse({ id: "a".repeat(65) }).success).toBe(false);
    expect(workoutContextInputSchema.safeParse({ id: "abc", compare_days: 13 }).success).toBe(
      false
    );
    expect(workoutContextInputSchema.safeParse({ id: IDS.workouts.padel }).success).toBe(true);
  });

  it("throws the WHOOP 404 for an unknown id", async () => {
    await expect(
      getWorkoutContext({ id: "00000000-0000-4000-8000-000000000000" }, contextFor(live()))
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("mature user", () => {
  it("compares a run with a quarter of earlier runs within the size limit", async () => {
    const fixture = matureUser({ days: 120 });
    const runs = fixture.workouts
      .filter((workout) => workout.sport_name === "running" && workout.score_state === "SCORED")
      .sort((left, right) => Date.parse(right.start) - Date.parse(left.start));
    const target = runs.find(
      (workout) => Date.parse(workout.end) < fixture.now.getTime() - 2 * 24 * HOUR_MS
    )!;
    const output = await run({ ...fixture, now: fixture.now }, target.id, 365);
    expect(output.comparison.status).toBe("available");
    expect(output.comparison.prior_sessions).toBeGreaterThanOrEqual(MIN_PRIOR_SESSIONS);
    for (const value of Object.values(output.comparison.percentiles)) {
      if (value !== null) expect(value >= 0 && value <= 100).toBe(true);
    }
    expect(["available", "pending", "missing", "not_yet"]).toContain(output.after.status);
    expect(output.day.date).toBe(output.workout.day);
    expect(JSON.stringify(output).length).toBeLessThan(MAX_TOOL_TEXT_CHARS);
  });
});

describe("contract", () => {
  it("returns the contract over MCP, schema errors for bad ids and 404 guidance", async () => {
    const fixture = liveShapedUser();
    const client = createWhoopFixtureClient({ ...fixture, now: fixture.now });
    const connection = await connectServer(client, { now: () => fixture.now });
    try {
      const tool = connection.tools.find((entry) => entry.name === "get_workout_context")!;
      expect(tool.title).toBe("Workout context");
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.description!.length).toBeLessThanOrEqual(1000);
      const result = await connection.callTool("get_workout_context", {
        id: IDS.workouts.padel,
      });
      expect(result.isError).toBe(false);
      expect(workoutContextOutputSchema.parse(result.structured).day.date).toBe("2026-09-15");
      const malformed = await connection.callTool("get_workout_context", { id: "bad/id" });
      expect(malformed.isError).toBe(true);
      const missing = await connection.callTool("get_workout_context", {
        id: "00000000-0000-4000-8000-000000000000",
      });
      expect(missing.isError).toBe(true);
      expect(missing.text).toMatch(/WHOOP found no matching record \(HTTP 404\)/);
    } finally {
      await connection.close();
    }
  });

  it("is absent in aggregate mode", async () => {
    expect(await listToolNames("standard")).toContain("get_workout_context");
    expect(await listToolNames("aggregate")).not.toContain("get_workout_context");
  });
});
