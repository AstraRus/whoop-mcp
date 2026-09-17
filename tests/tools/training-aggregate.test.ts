/**
 * Tests for the aggregate privacy variants of get_training_load and
 * get_sport_breakdown (package P6).
 *
 * Covers: the differencing check against an independent rank computation,
 * released-week gating and rounding, week-over-week change and the weekly
 * ratio from released values (null when one of the last 5 weeks is withheld),
 * byte-identical output from Wednesday 00:00 to the next Tuesday 23:59, the
 * other-pool and differenceSafe rules, released block totals never isolating
 * fewer than 3 sessions together with the released weekly totals (planned
 * blocks and matureUser seeds), a leak scan on the live-shaped account, sport
 * filters (a pooled sport's filter answers like a sport that does not exist),
 * non-final blocks, source counts limited to final released weeks,
 * day placement by main sleep shared with get_weekly_summary (weekly totals
 * never differ between aggregate tools; unreadable sleeps withhold every week),
 * output size on stressUser and both tools in the aggregate tools/list with
 * aggregate contracts.
 */

import { describe, expect, it } from "vitest";
import { WhoopApiError } from "../../src/api/client.js";
import type { Cycle, ScoreState, Workout } from "../../src/api/types.js";
import {
  AGGREGATE_WEEK_MIN_SAMPLES,
  blockOf,
  lastReleasedBlock,
  lastReleasedWeeks,
  roundStep,
} from "../../src/tools/aggregate-window.js";
import { localMidnightMs } from "../../src/tools/analytics-utils.js";
import { addDays, assignWorkouts, mondayOf, placeDays } from "../../src/tools/day-model.js";
import { roundPartsToTotal } from "../../src/tools/get-training-load.js";
import { MAX_TOOL_TEXT_CHARS, type ToolContext } from "../../src/tools/tool-definition.js";
import {
  getSportBreakdownAggregate,
  getTrainingLoadAggregate,
  releasableGroups,
  sportBreakdownAggregateOutputSchema,
  sumsIsolateFewerThanThree,
  trainingLoadAggregateOutputSchema,
  type SportBreakdownAggregateInput,
  type SportBreakdownAggregateOutput,
  type TrainingLoadAggregateInput,
  type TrainingLoadAggregateOutput,
} from "../../src/tools/training-aggregate.js";
import { MIN_RECORDED_FRACTION, recordedFraction } from "../../src/tools/workout-utils.js";
import { assertNeutralText, connectServer, listToolNames } from "../helpers/contract.js";
import {
  createWhoopFixtureClient,
  type WhoopFixtureClient,
  type WhoopFixtureClientOptions,
} from "../helpers/whoop-fixture-client.js";
import {
  createLcg,
  liveShapedUser,
  matureUser,
  stressUser,
  type WhoopUserFixture,
} from "../helpers/whoop-users.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const OFFSET = "+02:00";

// ---------------------------------------------------------------------------
// Independent differencing check
// ---------------------------------------------------------------------------

function rankOf(vectors: readonly number[][]): number {
  const matrix = vectors.map((vector) => [...vector]);
  const width = matrix[0]?.length ?? 0;
  let rank = 0;
  for (let column = 0; column < width && rank < matrix.length; column++) {
    let pivot = -1;
    for (let row = rank; row < matrix.length; row++) {
      if (Math.abs(matrix[row]![column]!) > 1e-9) {
        pivot = row;
        break;
      }
    }
    if (pivot === -1) continue;
    [matrix[rank], matrix[pivot]] = [matrix[pivot]!, matrix[rank]!];
    for (let row = 0; row < matrix.length; row++) {
      if (row === rank) continue;
      const factor = matrix[row]![column]! / matrix[rank]![column]!;
      if (factor === 0) continue;
      for (let k = column; k < width; k++) matrix[row]![k]! -= factor * matrix[rank]![k]!;
    }
    rank += 1;
  }
  return rank;
}

/** The first set of 1 or 2 sessions whose sum lies in the span of `rows`, found by rank */
function isolatedByRank(rows: readonly (readonly number[])[], sessions: number): string | null {
  const vector = (indexes: readonly number[]): number[] => {
    const values = new Array<number>(sessions).fill(0);
    for (const index of indexes) values[index] = 1;
    return values;
  };
  const matrix = rows.filter((row) => row.length > 0).map(vector);
  if (matrix.length === 0) return null;
  const base = rankOf(matrix);
  for (let s = 0; s < sessions; s++) {
    if (rankOf([...matrix, vector([s])]) === base) return `session ${s}`;
  }
  for (let s = 0; s < sessions; s++) {
    for (let t = s + 1; t < sessions; t++) {
      if (rankOf([...matrix, vector([s, t])]) === base) return `sessions ${s} and ${t}`;
    }
  }
  return null;
}

describe("sumsIsolateFewerThanThree", () => {
  it("finds single sessions and pairs recovered by differencing", () => {
    expect(sumsIsolateFewerThanThree([[0, 1, 2]], 3)).toBe(false);
    expect(
      sumsIsolateFewerThanThree(
        [
          [0, 1, 2],
          [1, 2],
        ],
        3
      )
    ).toBe(true);
    expect(
      sumsIsolateFewerThanThree(
        [
          [0, 1, 2, 3],
          [2, 3],
        ],
        4
      )
    ).toBe(true);
    expect(
      sumsIsolateFewerThanThree(
        [
          [0, 1, 2, 3, 4],
          [0, 1, 2],
        ],
        5
      )
    ).toBe(true);
    // Two weekly totals and two released sports leave one pooled session.
    const weeks = [
      [0, 1, 2],
      [3, 4, 5, 6],
    ];
    expect(sumsIsolateFewerThanThree([...weeks, [0, 3, 4], [1, 5, 6]], 7)).toBe(true);
    expect(sumsIsolateFewerThanThree([...weeks, [0, 3, 4]], 7)).toBe(false);
    expect(() => sumsIsolateFewerThanThree([[0, 5]], 3)).toThrow(RangeError);
  });

  it("agrees with an independent rank computation on random sums", () => {
    const random = createLcg(20260917);
    for (let trial = 0; trial < 400; trial++) {
      const sessions = 3 + Math.floor(random() * 7);
      const rows: number[][] = [];
      const rowCount = 1 + Math.floor(random() * 5);
      for (let row = 0; row < rowCount; row++) {
        const members = Array.from({ length: sessions }, (_, index) => index).filter(
          () => random() < 0.55
        );
        if (members.length >= 3) rows.push(members);
      }
      expect(sumsIsolateFewerThanThree(rows, sessions)).toBe(
        isolatedByRank(rows, sessions) !== null
      );
    }
  });

  it("releases groups in order and withholds the one that would isolate a session", () => {
    const released = releasableGroups(
      [
        { id: "a", order: 0, sessions: 3, name: "a", rows: { minutes: [0, 3, 4] } },
        { id: "b", order: 0, sessions: 3, name: "b", rows: { minutes: [1, 5, 6] } },
        {
          id: "overall",
          order: 5,
          sessions: 7,
          name: "overall",
          rows: { minutes: [0, 1, 2, 3, 4, 5, 6] },
        },
      ],
      {
        minutes: [
          [0, 1, 2],
          [3, 4, 5, 6],
        ],
      },
      7
    );
    expect([...released].sort()).toEqual(["a", "overall"]);
  });

  it("rounds shares to sum exactly to their total", () => {
    const shares = roundPartsToTotal([33.333, 33.333, 33.334], 1);
    expect(shares.reduce((sum, value) => sum + value, 0)).toBeCloseTo(100, 9);
    // Floors 12 + 30 + 57 leave one unit for the largest remainder (0.46).
    expect(roundPartsToTotal([12.46, 30.1, 57.44], 0)).toEqual([13, 30, 57]);
  });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface SessionPlan {
  minute?: number;
  minutes: number;
  sport: string;
  fraction?: number;
  state?: ScoreState;
  km?: number;
  kj?: number;
  strain?: number;
  hr?: number;
}

function localMs(day: string, minute: number, offset = OFFSET): number {
  return localMidnightMs(day, offset) + minute * MINUTE_MS;
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** A worn day every day from firstDay (partial) to lastDay (open), sessions from `sessionsOn` */
function plannedAccount(options: {
  firstDay: string;
  lastDay: string;
  sessionsOn: (day: string) => SessionPlan[];
  now: Date;
  cycleState?: (day: string) => ScoreState;
}): { cycles: Cycle[]; workouts: Workout[]; now: Date } {
  const days: string[] = [];
  for (let day = options.firstDay; day <= options.lastDay; day = addDays(day, 1)) days.push(day);
  const startOf = (index: number): number =>
    index === 0 ? localMs(days[0]!, 0) : localMs(addDays(days[index]!, -1), 23 * 60);
  const cycles: Cycle[] = days.map((day, index) => {
    const startMs = startOf(index);
    const endMs = index === days.length - 1 ? null : startOf(index + 1);
    const state = options.cycleState?.(day) ?? "SCORED";
    return {
      user_id: 1,
      created_at: iso(startMs + 7 * HOUR_MS),
      updated_at: iso((endMs ?? startMs) + MINUTE_MS),
      score_state: state,
      start: iso(startMs),
      end: endMs === null ? null : iso(endMs),
      timezone_offset: OFFSET,
      id: 20_000 + index,
      score:
        state === "SCORED"
          ? {
              strain: 9 + (index % 5),
              kilojoule: 8000,
              average_heart_rate: 70,
              max_heart_rate: 150,
            }
          : null,
    };
  });
  const workouts: Workout[] = [];
  for (const day of days) {
    options.sessionsOn(day).forEach((plan, k) => {
      const startMs = localMs(day, plan.minute ?? 540 + k * 180);
      const durationMs = Math.round(plan.minutes * MINUTE_MS);
      const fraction = plan.fraction ?? 1;
      const zoneTwo = Math.round(durationMs * fraction * 0.6);
      const zoneThree = Math.round(durationMs * fraction * 0.3);
      const state = plan.state ?? "SCORED";
      workouts.push({
        user_id: 1,
        created_at: iso(startMs + durationMs + MINUTE_MS),
        updated_at: iso(startMs + durationMs + MINUTE_MS),
        score_state: state,
        start: iso(startMs),
        end: iso(startMs + durationMs),
        timezone_offset: OFFSET,
        id: `p-${day}-${k}`,
        sport_name: plan.sport,
        sport_id: 0,
        v1_id: null,
        score:
          state === "SCORED"
            ? {
                strain: plan.strain ?? 7.5,
                average_heart_rate: plan.hr ?? 128,
                max_heart_rate: 165,
                kilojoule: plan.kj ?? 900,
                percent_recorded: fraction,
                zone_durations: {
                  zone_zero_milli: Math.round(durationMs * fraction) - zoneTwo - zoneThree,
                  zone_one_milli: 0,
                  zone_two_milli: zoneTwo,
                  zone_three_milli: zoneThree,
                  zone_four_milli: 0,
                  zone_five_milli: 0,
                },
                distance_meter: plan.km === undefined ? null : plan.km * 1000,
                altitude_gain_meter: null,
                altitude_change_meter: null,
              }
            : null,
      });
    });
  }
  return { cycles, workouts, now: options.now };
}

function contextFor(client: WhoopFixtureClient, now: Date): ToolContext {
  return { client, privacyMode: "aggregate", now: () => now, startedAtMs: Date.now() };
}

async function loadAggregate(
  data: { cycles: Cycle[]; workouts: Workout[]; now: Date },
  args: TrainingLoadAggregateInput = {},
  extra: Partial<WhoopFixtureClientOptions> = {}
): Promise<TrainingLoadAggregateOutput> {
  const client = createWhoopFixtureClient({
    cycles: data.cycles,
    workouts: data.workouts,
    now: data.now,
    ...extra,
  });
  const output = await getTrainingLoadAggregate(args, contextFor(client, data.now));
  trainingLoadAggregateOutputSchema.parse(output);
  assertNeutralText(output.notes);
  return output;
}

async function breakdownAggregate(
  data: { cycles: Cycle[]; workouts: Workout[]; now: Date },
  args: SportBreakdownAggregateInput = {},
  extra: Partial<WhoopFixtureClientOptions> = {}
): Promise<SportBreakdownAggregateOutput> {
  const client = createWhoopFixtureClient({
    cycles: data.cycles,
    workouts: data.workouts,
    now: data.now,
    ...extra,
  });
  const output = await getSportBreakdownAggregate(args, contextFor(client, data.now));
  sportBreakdownAggregateOutputSchema.parse(output);
  assertNeutralText(output.notes);
  return output;
}

/** The fixture as seen at `at`: later records dropped, later cycle ends open, later updates undone */
function viewAsOf(fixture: WhoopUserFixture, at: Date): WhoopUserFixture {
  const ms = at.getTime();
  const created = (record: { created_at: string }): boolean => Date.parse(record.created_at) <= ms;
  const notUpdatedLater = <T extends { created_at: string; updated_at: string }>(record: T): T =>
    Date.parse(record.updated_at) > ms ? { ...record, updated_at: record.created_at } : record;
  return {
    ...fixture,
    now: at,
    cycles: fixture.cycles
      .filter((cycle) => created(cycle) && Date.parse(cycle.start) <= ms)
      .map((cycle) =>
        cycle.end !== null && cycle.end !== undefined && Date.parse(cycle.end) > ms
          ? { ...cycle, end: null }
          : cycle
      )
      .map(notUpdatedLater),
    sleeps: fixture.sleeps.filter((sleep) => created(sleep) && Date.parse(sleep.end) <= ms),
    recoveries: fixture.recoveries.filter(created),
    workouts: fixture.workouts
      .filter((workout) => created(workout) && Date.parse(workout.end) <= ms)
      .map(notUpdatedLater),
  };
}

function withoutEvaluatedAt<T extends { data_quality: { evaluated_at: string } }>(
  output: T
): unknown {
  return { ...output, data_quality: { ...output.data_quality, evaluated_at: "" } };
}

// A Wednesday: the latest released week is 2026-09-07..13.
const WEDNESDAY = new Date("2026-09-16T12:00:00+02:00");

// ---------------------------------------------------------------------------
// get_training_load (aggregate)
// ---------------------------------------------------------------------------

describe("get_training_load aggregate", () => {
  it("lists released weeks with rounded values and gates weeks below 3 sessions", async () => {
    const lowWeek = "2026-08-10";
    const data = plannedAccount({
      firstDay: "2026-06-20",
      lastDay: "2026-09-16",
      now: WEDNESDAY,
      sessionsOn: (day) => {
        const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
        if (mondayOf(day) === lowWeek)
          return weekday === 2 || weekday === 4 ? [{ minutes: 47, sport: "running" }] : [];
        return weekday % 2 === 1
          ? [{ minutes: 41 + weekday, sport: weekday === 3 ? "cycling" : "running", kj: 777 }]
          : [];
      },
    });
    const output = await loadAggregate(data);
    const released = lastReleasedWeeks(WEDNESDAY, OFFSET, 8).map((week) => week.monday);
    expect(output.period).toEqual({ start_week: released[0], end_week: "2026-09-07", weeks: 8 });
    expect(output.weeks.map((week) => week.week_start)).toEqual(released);
    for (const week of output.weeks) {
      if (week.workout_minutes !== null) expect(week.workout_minutes % 10).toBe(0);
      if (week.trimp !== null) expect(week.trimp % 10).toBe(0);
      if (week.workout_kj !== null) expect(week.workout_kj % 100).toBe(0);
      if (week.mean_day_strain !== null)
        expect(roundStep(week.mean_day_strain, 0.1)).toBe(week.mean_day_strain);
    }
    const low = output.weeks.find((week) => week.week_start === lowWeek)!;
    expect(low).toMatchObject({
      released: false,
      sessions: 2,
      workout_minutes: null,
      trimp: null,
      workout_kj: null,
      change_vs_previous_pct: null,
    });
    expect(low.mean_day_strain).not.toBeNull();
    const after = output.weeks.find((week) => week.week_start === addDays(lowWeek, 7))!;
    expect(after.change_vs_previous_pct).toBeNull();
    const steady = output.weeks.find((week) => week.week_start === "2026-08-31")!;
    const before = output.weeks.find((week) => week.week_start === "2026-08-24")!;
    expect(steady.released).toBe(true);
    expect(steady.sessions).toBe(3);
    expect(steady.change_vs_previous_pct).toBe(
      Math.round(((steady.trimp! - before.trimp!) / before.trimp!) * 100)
    );
    expect(output.notes).toContain(
      "Workout values of 1 week is withheld: fewer than 3 scored sessions."
    );
    for (const note of output.notes) {
      // Only the week label of the released window may appear.
      expect(note.replace("2026-09-13", "")).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    }
    expect(output.data_quality.evaluated_at).toBe("2026-09-16");
    expect(output.data_quality.requested_period).toEqual({
      start: addDays(released[0]!, -7),
      end: "2026-09-13",
    });
    expect(Object.keys(output)).not.toContain("days");
    expect(Object.keys(output)).not.toContain("today_so_far");
  });

  it("computes the weekly ratio from released values and nulls it when one of the last 5 weeks is withheld", async () => {
    const build = (lowWeek: string | null): ReturnType<typeof plannedAccount> =>
      plannedAccount({
        firstDay: "2026-06-20",
        lastDay: "2026-09-16",
        now: WEDNESDAY,
        sessionsOn: (day) => {
          const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
          const count =
            mondayOf(day) === lowWeek ? (weekday === 1 || weekday === 5 ? 1 : 0) : weekday % 2;
          return count > 0
            ? [{ minutes: mondayOf(day) === "2026-09-07" ? 70 : 45, sport: "running" }]
            : [];
        },
      });
    const full = await loadAggregate(build(null));
    const last = full.weeks[full.weeks.length - 1]!;
    const prior = full.weeks.slice(-5, -1);
    const lastMean = last.trimp! / last.worn_days!;
    const priorMean =
      prior.reduce((sum, week) => sum + week.trimp!, 0) /
      prior.reduce((sum, week) => sum + week.worn_days!, 0);
    expect(full.acute_chronic_weekly).toEqual({
      last_week_mean_daily_load: roundStep(lastMean, 1),
      prior_4_weeks_mean_daily_load: roundStep(priorMean, 1),
      ratio: roundStep(lastMean / priorMean, 0.05),
    });
    expect(full.acute_chronic_weekly.ratio).toBeGreaterThan(1);

    const withheld = await loadAggregate(build("2026-08-24"));
    expect(withheld.weeks.find((week) => week.week_start === "2026-08-24")!.released).toBe(false);
    expect(withheld.acute_chronic_weekly.ratio).toBeNull();
    expect(withheld.acute_chronic_weekly.prior_4_weeks_mean_daily_load).toBeNull();
    expect(withheld.acute_chronic_weekly.last_week_mean_daily_load).toBe(
      full.acute_chronic_weekly.last_week_mean_daily_load
    );
  });

  it("gates mean day strain on 3 completed cycles and withholds weeks that are not final", async () => {
    const data = plannedAccount({
      firstDay: "2026-07-01",
      lastDay: "2026-09-16",
      now: WEDNESDAY,
      sessionsOn: () => [{ minutes: 30, sport: "walking" }],
      cycleState: (day) =>
        mondayOf(day) === "2026-08-17" && day !== "2026-08-17" && day !== "2026-08-18"
          ? "UNSCORABLE"
          : "SCORED",
    });
    const strain = await loadAggregate(data, { load_metric: "day_strain", weeks: 4 });
    const lowCycles = strain.weeks.find((week) => week.week_start === "2026-08-17")!;
    expect(lowCycles).toMatchObject({
      completed_cycles: 2,
      mean_day_strain: null,
      released: false,
    });
    expect(lowCycles.workout_minutes).not.toBeNull();
    expect(strain.load_unit).toBe("strain (0-21)");

    // A pending workout makes its week not final: every value and count is withheld.
    const pending = plannedAccount({
      firstDay: "2026-07-01",
      lastDay: "2026-09-16",
      now: WEDNESDAY,
      sessionsOn: (day) => [
        {
          minutes: 30,
          sport: "walking",
          ...(day === "2026-09-09" ? { state: "PENDING_SCORE" as const } : {}),
        },
      ],
    });
    const output = await loadAggregate(pending, { weeks: 4 });
    const last = output.weeks[output.weeks.length - 1]!;
    expect(last).toEqual({
      week_start: "2026-09-07",
      released: false,
      worn_days: null,
      sessions: null,
      active_days: null,
      workout_minutes: null,
      trimp: null,
      workout_kj: null,
      mean_day_strain: null,
      completed_cycles: null,
      change_vs_previous_pct: null,
    });
    expect(output.notes.some((note) => note.startsWith("1 week is withheld"))).toBe(true);
    expect(output.acute_chronic_weekly.last_week_mean_daily_load).toBeNull();
  });

  it("gives identical output from Wednesday 00:00 to the next Tuesday 23:59", async () => {
    const tuesday = new Date("2026-09-22T23:59:00+01:00");
    const fixture = matureUser({ days: 120, now: tuesday });
    const wednesday = new Date("2026-09-16T00:00:00+01:00");
    const early = viewAsOf(fixture, wednesday);
    for (const args of [{}, { load_metric: "day_strain" as const, weeks: 12 }]) {
      const first = await loadAggregate(early, args);
      const second = await loadAggregate(fixture, args);
      expect(withoutEvaluatedAt(second)).toEqual(withoutEvaluatedAt(first));
      expect(first.data_quality.evaluated_at).toBe("2026-09-16");
      expect(second.data_quality.evaluated_at).toBe("2026-09-22");
    }
    for (const args of [{}, { block_offset: 2 }]) {
      const first = await breakdownAggregate(early, args);
      const second = await breakdownAggregate(fixture, args);
      expect(withoutEvaluatedAt(second)).toEqual(withoutEvaluatedAt(first));
    }
    // One millisecond before Wednesday the previous week is still the latest released one.
    const tuesdayBefore = viewAsOf(fixture, new Date(wednesday.getTime() - 1));
    const before = await loadAggregate(tuesdayBefore);
    expect(before.period.end_week).toBe("2026-08-31");
  });

  it("counts source records only in final released weeks", async () => {
    const fixture = matureUser({ days: 120 });
    const base = await loadAggregate(fixture, { weeks: 4 });
    const later = {
      ...fixture,
      workouts: [
        ...fixture.workouts,
        {
          ...fixture.workouts[0]!,
          id: "added-after-release",
          start: "2026-09-16T08:00:00.000Z",
          end: "2026-09-16T08:30:00.000Z",
          created_at: "2026-09-16T08:31:00.000Z",
          updated_at: "2026-09-16T08:31:00.000Z",
        },
      ],
    };
    const after = await loadAggregate(later, { weeks: 4 });
    expect(after.data_quality.sources).toEqual(base.data_quality.sources);
    expect(after.weeks).toEqual(base.weeks);
  });
});

// ---------------------------------------------------------------------------
// Day placement shared with the other aggregate tools
// ---------------------------------------------------------------------------

/**
 * The fixture with the main sleep that ends on `monday` morning moved to a
 * daytime sleep on the Sunday before (13:00-21:30 local): its cycle then starts
 * on Sunday afternoon. Placed by its main sleep, that cycle (and the Monday
 * workouts it contains) belongs to Sunday; 12 hours after its start is Monday.
 */
function withDaytimeSleepBefore(fixture: WhoopUserFixture, monday: string): WhoopUserFixture {
  const cycles = fixture.cycles.map((cycle) => ({ ...cycle }));
  const sleeps = fixture.sleeps.map((sleep) => ({ ...sleep }));
  const mainSleep = sleeps.find((sleep) => {
    const end = Date.parse(sleep.end);
    const midnight = localMidnightMs(monday, sleep.timezone_offset);
    return !sleep.nap && end > midnight && end < midnight + 12 * HOUR_MS;
  });
  if (!mainSleep) throw new Error("fixture has no main sleep ending on that Monday");
  const cycle = cycles.find((candidate) => candidate.id === mainSleep.cycle_id)!;
  const previous = cycles.find((candidate) => candidate.end === cycle.start)!;
  const sundayMidnight = localMidnightMs(addDays(monday, -1), cycle.timezone_offset);
  cycle.start = iso(sundayMidnight + 13 * HOUR_MS);
  previous.end = cycle.start;
  mainSleep.start = cycle.start;
  mainSleep.end = iso(sundayMidnight + 21.5 * HOUR_MS);
  return { ...fixture, cycles, sleeps };
}

describe("aggregate day placement", () => {
  it("places days by main sleep like get_weekly_summary, so weekly totals never differ between tools", async () => {
    const base = matureUser({ days: 120 });
    const weeks = lastReleasedWeeks(base.now, "+01:00", 6);
    const fixture = withDaytimeSleepBefore(base, weeks[3]!.monday);
    const client = createWhoopFixtureClient({ ...fixture, now: fixture.now });
    const connection = await connectServer(client, {
      privacyMode: "aggregate",
      now: () => fixture.now,
    });
    try {
      let compared = 0;
      for (const metric of ["workout_kj", "day_strain"] as const) {
        const load = (
          await connection.callTool("get_training_load", { weeks: 6, load_metric: metric })
        ).structured as TrainingLoadAggregateOutput;
        for (const week of load.weeks) {
          const weekly = (
            await connection.callTool("get_weekly_summary", { week_start: week.week_start })
          ).structured as {
            workouts: { count: number | null; total_calories_kj: number | null };
            strain: { average_daily_strain: number | null };
            sample_sizes: { completed_cycles: number };
          };
          expect(week.sessions, week.week_start).toBe(weekly.workouts.count);
          if (metric === "workout_kj") {
            expect(week.workout_kj).not.toBeNull();
            expect(
              Math.abs(week.workout_kj! - weekly.workouts.total_calories_kj!)
            ).toBeLessThanOrEqual(50);
          } else {
            expect(week.completed_cycles, week.week_start).toBe(
              weekly.sample_sizes.completed_cycles
            );
            expect(week.mean_day_strain).toBe(weekly.strain.average_daily_strain);
          }
          compared++;
        }
      }
      expect(compared).toBe(12);
    } finally {
      await connection.close();
    }
  });

  it("withholds every week when sleeps cannot be read completely", async () => {
    const fixture = matureUser({ days: 120 });
    const client = createWhoopFixtureClient({
      ...fixture,
      now: fixture.now,
      failures: [
        {
          path: /^\/v2\/activity\/sleep/,
          error: new WhoopApiError(503, "Service Unavailable", {}),
        },
      ],
    });
    const ctx = contextFor(client, fixture.now);
    const load = await getTrainingLoadAggregate({ weeks: 4 }, ctx);
    trainingLoadAggregateOutputSchema.parse(load);
    expect(load.weeks.every((week) => !week.released && week.sessions === null)).toBe(true);
    expect(load.notes.join(" ")).toContain("Sleep data could not be read completely");
    assertNeutralText(load.notes);
    const breakdown = await getSportBreakdownAggregate({}, contextFor(client, fixture.now));
    sportBreakdownAggregateOutputSchema.parse(breakdown);
    expect(breakdown.status).toBe("withheld");
    expect(breakdown.sports).toEqual([]);
    expect(breakdown.overall.kilojoule_total).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// get_sport_breakdown (aggregate)
// ---------------------------------------------------------------------------

/** Released rows of both aggregate outputs for one block, as session index sets per metric */
function releasedRows(
  load: TrainingLoadAggregateOutput,
  breakdown: SportBreakdownAggregateOutput,
  sessions: readonly { day: string; sport: string; fullyRecorded: boolean; gps: boolean }[]
): Record<string, number[][]> {
  const rows: Record<string, number[][]> = {
    minutes: [],
    kj: [],
    trimp: [],
    strain: [],
    distance: [],
  };
  const indexes = (filter: (session: (typeof sessions)[number]) => boolean): number[] =>
    sessions.flatMap((session, index) => (filter(session) ? [index] : []));
  const blockStart = breakdown.block.start_week;
  const blockEnd = addDays(breakdown.block.end_week, 6);
  for (const week of load.weeks) {
    if (week.week_start < blockStart || week.week_start > blockEnd) continue;
    const inWeek = indexes((session) => mondayOf(session.day) === week.week_start);
    if (week.workout_minutes !== null) {
      rows.minutes!.push(inWeek);
      // Weekly workout strain totals released by get_weekly_summary for the same weeks.
      rows.strain!.push(inWeek);
    }
    if (week.workout_kj !== null) rows.kj!.push(inWeek);
    if (week.trimp !== null) rows.trimp!.push(inWeek);
  }
  const counts = new Map<string, number>();
  for (const session of sessions) counts.set(session.sport, (counts.get(session.sport) ?? 0) + 1);
  for (const sport of breakdown.sports) {
    const members = indexes((session) => session.sport === sport.sport_name);
    const hr = indexes((session) => session.sport === sport.sport_name && session.fullyRecorded);
    if (sport.duration_minutes_total !== null) rows.minutes!.push(members);
    if (sport.kilojoule_total !== null) rows.kj!.push(members);
    if (sport.strain_mean !== null) rows.strain!.push(members);
    if (sport.trimp_total !== null) {
      rows.trimp!.push(hr);
      rows.minutes!.push(hr);
    }
    if (sport.gps?.distance_km_total !== null && sport.gps !== null) {
      const gps = indexes((session) => session.sport === sport.sport_name && session.gps);
      rows.distance!.push(gps);
      rows.minutes!.push(gps);
    }
  }
  const pooled = (session: (typeof sessions)[number]): boolean =>
    (counts.get(session.sport) ?? 0) < AGGREGATE_WEEK_MIN_SAMPLES;
  if (breakdown.other?.duration_minutes_total != null) rows.minutes!.push(indexes(pooled));
  if (breakdown.other?.kilojoule_total != null) rows.kj!.push(indexes(pooled));
  if (breakdown.other?.trimp_total != null) {
    rows.trimp!.push(indexes((session) => pooled(session) && session.fullyRecorded));
    rows.minutes!.push(indexes((session) => pooled(session) && session.fullyRecorded));
  }
  if (breakdown.overall.duration_minutes_total !== null) rows.minutes!.push(indexes(() => true));
  if (breakdown.overall.kilojoule_total !== null) rows.kj!.push(indexes(() => true));
  if (breakdown.overall.trimp_total !== null) {
    rows.trimp!.push(indexes((session) => session.fullyRecorded));
    rows.minutes!.push(indexes((session) => session.fullyRecorded));
  }
  return rows;
}

/** Scored sessions placed in the block, by the shared day model */
function blockSessions(
  data: { cycles: Cycle[]; workouts: Workout[]; now: Date },
  block: { start_week: string; end_week: string },
  offset: string
): { day: string; sport: string; fullyRecorded: boolean; gps: boolean }[] {
  const placement = placeDays({
    cycles: data.cycles,
    sleeps: [],
    recoveries: [],
    sleepsAvailable: false,
    today: "2999-01-01",
    utcOffset: offset,
  });
  const days = assignWorkouts(data.workouts, placement, data.cycles);
  const end = addDays(block.end_week, 6);
  return data.workouts
    .filter((workout) => workout.score_state === "SCORED" && workout.score)
    .map((workout) => ({
      day: days.get(workout.id)!.day,
      sport: workout.sport_name,
      fullyRecorded: recordedFraction(workout.score!.percent_recorded) >= MIN_RECORDED_FRACTION,
      gps: typeof workout.score!.distance_meter === "number" && workout.score!.distance_meter > 0,
    }))
    .filter((session) => session.day >= block.start_week && session.day <= end);
}

function expectNoIsolation(rows: Record<string, number[][]>, sessionCount: number): void {
  for (const [metric, metricRows] of Object.entries(rows)) {
    const isolated = isolatedByRank(metricRows, sessionCount);
    expect(isolated, `${metric}: ${isolated}`).toBeNull();
  }
}

describe("get_sport_breakdown aggregate", () => {
  const block = lastReleasedBlock(WEDNESDAY, OFFSET, 4, 1);

  it("pools small sports as other and withholds overall totals when the pool is below 3", async () => {
    const plan = (poolSessions: number): ReturnType<typeof plannedAccount> =>
      plannedAccount({
        firstDay: addDays(block.start, -10),
        lastDay: "2026-09-16",
        now: WEDNESDAY,
        sessionsOn: (day) => {
          if (day < block.start || day > block.end) return [];
          const index = Math.round((Date.parse(day) - Date.parse(block.start)) / 86_400_000);
          const sessions: SessionPlan[] = [];
          if (index % 2 === 0) sessions.push({ minutes: 50, sport: "running", km: 9 });
          if (index % 3 === 1) sessions.push({ minutes: 35, sport: "walking" });
          if (index < poolSessions) {
            sessions.push({
              minutes: 60,
              sport: ["padel", "rowing", "yoga"][index % 3]!,
              minute: 1080,
            });
          }
          return sessions;
        },
      });
    const small = await breakdownAggregate(plan(2));
    expect(small.status).toBe("available");
    expect(small.sports.map((sport) => sport.sport_name).sort()).toEqual(["running", "walking"]);
    expect(small.other).toMatchObject({
      sports: 2,
      sessions: 2,
      duration_minutes_total: null,
      kilojoule_total: null,
      trimp_total: null,
    });
    expect(small.overall.duration_minutes_total).toBeNull();
    expect(small.notes.some((note) => note.includes("so overall totals are withheld"))).toBe(true);
    expect(JSON.stringify(small)).not.toMatch(/padel|rowing|yoga/);

    const large = await breakdownAggregate(plan(6));
    expect(large.other).toMatchObject({ sports: 3, sessions: 6 });
    expect(large.other!.duration_minutes_total).toBe(360);
    expect(large.overall.duration_minutes_total).not.toBeNull();
    for (const output of [small, large]) {
      const data = plan(output === small ? 2 : 6);
      const load = await loadAggregate(data, { weeks: 8 });
      const sessions = blockSessions(data, output.block, OFFSET);
      expectNoIsolation(releasedRows(load, output, sessions), sessions.length);
    }
  });

  it("withholds overall and other totals when a week with fewer than 3 sessions could be isolated", async () => {
    const data = plannedAccount({
      firstDay: addDays(block.start, -10),
      lastDay: "2026-09-16",
      now: WEDNESDAY,
      sessionsOn: (day) => {
        if (day < block.start || day > block.end) return [];
        const week = Math.floor((Date.parse(day) - Date.parse(block.start)) / (7 * 86_400_000));
        const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
        if (week === 2)
          return weekday === 3 || weekday === 6 ? [{ minutes: 40, sport: "running" }] : [];
        return weekday % 2 === 0
          ? [
              { minutes: 45, sport: "running" },
              ...(weekday === 4 ? [{ minutes: 25, sport: "yoga" }] : []),
            ]
          : [];
      },
    });
    const output = await breakdownAggregate(data);
    const load = await loadAggregate(data, { weeks: 8 });
    expect(load.weeks.find((week) => week.week_start === block.mondays[2])!.released).toBe(false);
    expect(output.overall).toMatchObject({ duration_minutes_total: null, kilojoule_total: null });
    expect(output.notes).toContain(
      "Overall and other totals are withheld: subtracting the released weekly totals from them would isolate fewer than 3 sessions."
    );
    const sessions = blockSessions(data, output.block, OFFSET);
    expectNoIsolation(releasedRows(load, output, sessions), sessions.length);
  });

  it("never lets released totals isolate fewer than 3 sessions on matureUser blocks", async () => {
    let checked = 0;
    let withheldGroups = 0;
    for (const seed of [1, 2, 3, 4]) {
      const fixture = matureUser({ days: 150, seed });
      for (const blockOffset of [1, 2, 3]) {
        const output = await breakdownAggregate(fixture, { block_offset: blockOffset });
        if (output.status !== "available") continue;
        checked += 1;
        if (output.notes.some((note) => note.includes("would isolate fewer than 3 sessions"))) {
          withheldGroups += 1;
        }
        const load = await loadAggregate(fixture, { weeks: 26 });
        const sessions = blockSessions(fixture, output.block, "+02:00");
        expect(output.overall.sessions).toBe(sessions.length);
        expectNoIsolation(releasedRows(load, output, sessions), sessions.length);
        // Released sport totals equal the rounded sums of their sessions.
        for (const sport of output.sports) {
          expect(sport.sessions).toBe(
            sessions.filter((session) => session.sport === sport.sport_name).length
          );
          expect(sport.sessions).toBeGreaterThanOrEqual(AGGREGATE_WEEK_MIN_SAMPLES);
          if (sport.duration_minutes_total !== null)
            expect(sport.duration_minutes_total % 10).toBe(0);
          if (sport.kilojoule_total !== null) expect(sport.kilojoule_total % 100).toBe(0);
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(8);
    // The check is exercised: some blocks needed totals withheld beyond the pooling rules.
    expect(withheldGroups).toBeGreaterThan(0);
  });

  it("releases no single-workout value on the live-shaped account", async () => {
    const live = liveShapedUser();
    const lastMonday = blockOf("2026-09-14", 4).mondays[3]!;
    const now = new Date(localMs(addDays(lastMonday, 9), 12 * 60));
    const cycles = live.cycles.map((cycle) =>
      cycle.end === null ? { ...cycle, end: "2026-09-16T21:30:00.000Z" } : cycle
    );
    const data = { cycles, workouts: live.workouts, now };
    const breakdown = await breakdownAggregate(data);
    const load = await loadAggregate(data, { weeks: 4 });
    expect(breakdown.block.start_week <= "2026-09-14").toBe(true);
    expect(breakdown.overall.sessions).toBe(8);
    expect(load.weeks.find((week) => week.week_start === "2026-09-14")!.sessions).toBe(8);

    // Per-workout values of each metric at the rounding step its released totals use.
    const perWorkout = {
      minutes: new Set<number>(),
      kj: new Set<number>(),
      kcal: new Set<number>(),
      trimp: new Set<number>(),
      trimpDaily: new Set<number>(),
      km: new Set<number>(),
    };
    for (const workout of live.workouts) {
      const score = workout.score!;
      const zones = score.zone_durations;
      const trimp =
        (zones.zone_one_milli +
          2 * zones.zone_two_milli +
          3 * zones.zone_three_milli +
          4 * zones.zone_four_milli +
          5 * zones.zone_five_milli) /
        MINUTE_MS;
      perWorkout.minutes.add(
        roundStep((Date.parse(workout.end) - Date.parse(workout.start)) / MINUTE_MS, 10)
      );
      perWorkout.kj.add(roundStep(score.kilojoule, 100));
      perWorkout.kcal.add(roundStep(score.kilojoule / 4.184, 100));
      perWorkout.trimp.add(roundStep(trimp, 10));
      perWorkout.trimpDaily.add(roundStep(trimp, 1));
      if (score.distance_meter) perWorkout.km.add(roundStep(score.distance_meter / 1000, 1));
    }
    const checked: [keyof typeof perWorkout, number | null | undefined][] = [];
    for (const entry of [
      ...breakdown.sports,
      breakdown.overall,
      ...(breakdown.other ? [breakdown.other] : []),
    ]) {
      checked.push(
        ["minutes", entry.duration_minutes_total],
        ["kj", entry.kilojoule_total],
        ["kcal", entry.kcal_total],
        ["trimp", entry.trimp_total]
      );
    }
    for (const sport of breakdown.sports) checked.push(["km", sport.gps?.distance_km_total]);
    for (const week of load.weeks) {
      checked.push(
        ["minutes", week.workout_minutes],
        ["trimp", week.trimp],
        ["kj", week.workout_kj]
      );
    }
    checked.push(
      ["trimpDaily", load.acute_chronic_weekly.last_week_mean_daily_load],
      ["trimpDaily", load.acute_chronic_weekly.prior_4_weeks_mean_daily_load]
    );
    const released = checked.filter(
      (item): item is [keyof typeof perWorkout, number] => typeof item[1] === "number"
    );
    expect(released.length).toBeGreaterThan(5);
    for (const [metric, value] of released) {
      expect(perWorkout[metric].has(value), `${metric} ${value}`).toBe(false);
    }
    // Averages come only from sports with at least 3 sessions.
    for (const sport of breakdown.sports) expect(sport.sessions).toBeGreaterThanOrEqual(3);
    expect(breakdown.sports.map((sport) => sport.sport_name)).toEqual(["walking"]);
  });

  it("says when a block has no WHOOP data at all, not only no workouts", async () => {
    const live = liveShapedUser();
    // The latest released block on 2026-09-17 ends before the account's first day.
    const empty = await breakdownAggregate({
      cycles: live.cycles,
      workouts: live.workouts,
      now: live.now,
    });
    expect(empty.block.end_week < "2026-09-14").toBe(true);
    expect(empty.status).toBe("no_workouts");
    expect(empty.notes).toContain("No WHOOP data for this block.");

    // A released block with worn days but no workouts is only no_workouts.
    const lastMonday = blockOf("2026-09-14", 4).mondays[3]!;
    const now = new Date(localMs(addDays(lastMonday, 9), 12 * 60));
    const cycles = live.cycles.map((cycle) =>
      cycle.end === null ? { ...cycle, end: "2026-09-16T21:30:00.000Z" } : cycle
    );
    const rest = await breakdownAggregate({ cycles, workouts: [], now });
    expect(rest.block.start_week <= "2026-09-14").toBe(true);
    expect(rest.status).toBe("no_workouts");
    expect(rest.notes).not.toContain("No WHOOP data for this block.");
  });

  it("filters one sport without revealing pooled sports", async () => {
    const fixture = matureUser({ days: 120, seed: 2 });
    const all = await breakdownAggregate(fixture);
    const released = all.sports.find((sport) => sport.duration_minutes_total !== null);
    expect(released).toBeDefined();
    const filtered = await breakdownAggregate(fixture, {
      sport: released!.sport_name.toUpperCase(),
    });
    expect(filtered.sports).toEqual([released]);
    expect(filtered.other).toBeNull();
    expect(filtered.overall).toMatchObject({
      sessions: released!.sessions,
      duration_minutes_total: released!.duration_minutes_total,
    });
    const unknown = await breakdownAggregate(fixture, { sport: "rowing" });
    expect(unknown.sports).toEqual([]);
    expect(unknown.overall.duration_minutes_total).toBeNull();
    expect(
      unknown.notes.some((note) => note.startsWith('No sport "rowing" with at least 3 sessions'))
    ).toBe(true);
  });

  it("answers a filter for a pooled sport exactly like one for a sport that does not exist", async () => {
    let pooledBlocks = 0;
    for (const seed of [1, 2]) {
      const fixture = matureUser({ days: 120, seed });
      const names = [...new Set(fixture.workouts.map((workout) => workout.sport_name))];
      for (const block_offset of [1, 2, 3]) {
        const all = await breakdownAggregate(fixture, { block_offset });
        if (all.other !== null && (all.other.sports ?? 0) > 0) pooledBlocks++;
        const shown = new Set(all.sports.map((sport) => sport.sport_name));
        // The queried name is echoed; everything else must not depend on it.
        const normalized = async (query: string): Promise<string> =>
          JSON.stringify(await breakdownAggregate(fixture, { block_offset, sport: query }))
            .split(query)
            .join("<SPORT>");
        const baseline = await normalized("NO_SUCH_SPORT");
        for (const name of names.filter((candidate) => !shown.has(candidate))) {
          expect(
            await normalized(name.toUpperCase()),
            `seed ${seed} block ${block_offset} ${name}`
          ).toBe(baseline);
        }
        expect(baseline).not.toContain("so it is withheld");
      }
    }
    // At least one block pools a sport, so the comparison covers pooled names.
    expect(pooledBlocks).toBeGreaterThan(0);
  });

  it("withholds a block that is not final and moves back with block_offset", async () => {
    const pendingDay = addDays(block.start, 3);
    const data = plannedAccount({
      firstDay: addDays(block.start, -40),
      lastDay: "2026-09-16",
      now: WEDNESDAY,
      sessionsOn: (day) => [
        {
          minutes: 30,
          sport: "walking",
          ...(day === pendingDay ? { state: "PENDING_SCORE" as const } : {}),
        },
      ],
    });
    const output = await breakdownAggregate(data);
    expect(output).toMatchObject({ status: "withheld", sports: [], other: null });
    expect(output.overall).toEqual({
      sessions: null,
      active_days: null,
      duration_minutes_total: null,
      kilojoule_total: null,
      kcal_total: null,
      trimp_total: null,
    });
    const previous = await breakdownAggregate(data, { block_offset: 2 });
    expect(previous.block.start_week).toBe(addDays(block.start, -28));
    expect(previous.status).toBe("available");
  });
});

// ---------------------------------------------------------------------------
// Registration and size
// ---------------------------------------------------------------------------

describe("aggregate registration", () => {
  it("lists both tools in aggregate mode with aggregate contracts", async () => {
    const names = await listToolNames("aggregate");
    expect(names).toEqual(expect.arrayContaining(["get_training_load", "get_sport_breakdown"]));
    const fixture = matureUser({ days: 120 });
    const client = createWhoopFixtureClient({ ...fixture, now: fixture.now });
    const connection = await connectServer(client, {
      privacyMode: "aggregate",
      now: () => fixture.now,
    });
    try {
      const load = connection.tools.find((tool) => tool.name === "get_training_load")!;
      const loadProperties = Object.keys(load.outputSchema?.properties ?? {});
      expect(loadProperties).toEqual(expect.arrayContaining(["weeks", "acute_chronic_weekly"]));
      for (const absent of ["days", "ewma", "monotony", "today_so_far", "warnings"]) {
        expect(loadProperties).not.toContain(absent);
      }
      expect(Object.keys(load.inputSchema.properties ?? {}).sort()).toEqual([
        "load_metric",
        "weeks",
      ]);
      const breakdown = connection.tools.find((tool) => tool.name === "get_sport_breakdown")!;
      expect(Object.keys(breakdown.inputSchema.properties ?? {}).sort()).toEqual([
        "block_offset",
        "sport",
      ]);
      expect(JSON.stringify(breakdown.outputSchema)).not.toMatch(
        /time_of_day|efficiency|median|peak|fastest|latest/
      );
      for (const tool of [load, breakdown]) {
        expect(tool.annotations?.readOnlyHint).toBe(true);
        expect(tool.description?.length ?? 0).toBeLessThanOrEqual(1000);
      }

      const loadResult = await connection.callTool("get_training_load", { weeks: 26 });
      expect(loadResult.isError).toBe(false);
      expect(loadResult.text).not.toContain("\n");
      const breakdownResult = await connection.callTool("get_sport_breakdown", {});
      expect(breakdownResult.isError).toBe(false);
      const rejected = await connection.callTool("get_training_load", { days: 42 });
      expect(rejected.isError).toBe(false);
      expect((rejected.structured as TrainingLoadAggregateOutput).weeks).toHaveLength(8);
    } finally {
      await connection.close();
    }
  });

  it("stays within the output limit on stressUser", async () => {
    const fixture = stressUser();
    const client = createWhoopFixtureClient({ ...fixture, now: fixture.now });
    const connection = await connectServer(client, {
      privacyMode: "aggregate",
      now: () => fixture.now,
    });
    try {
      const load = await connection.callTool("get_training_load", { weeks: 26 });
      expect(load.isError).toBe(false);
      expect(load.text.length).toBeLessThanOrEqual(MAX_TOOL_TEXT_CHARS);
      const breakdown = await connection.callTool("get_sport_breakdown", { block_offset: 26 });
      expect(breakdown.isError).toBe(false);
      expect(breakdown.text.length).toBeLessThanOrEqual(MAX_TOOL_TEXT_CHARS);
    } finally {
      await connection.close();
    }
  });
});
