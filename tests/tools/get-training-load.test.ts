/**
 * Tests for get_training_load (package P6, standard mode).
 *
 * Covers: acute/chronic means and ratio on planned loads, EWMA seeding (window
 * mean when older history exists, zero at the first worn day otherwise) and
 * warm-up nulls, Foster monotony, the live-shaped calibrating account
 * (insufficient history, available_from_day, today_so_far, partial first
 * day), day strain on partial and open days, low-recording TRIMP, week totals
 * across a month and an offset change, failed and truncated sources, a strap
 * off for weeks (older history merged), request accounting and output size on
 * stressUser, neutral wording and the MCP contract. Regression tests: day
 * placement like get_calendar (a split night whose first sleep is longer, the
 * two-cycles warning, a day sleeper's open cycle never after today, cycles-only
 * placement with a warning when sleeps fail) and the window-mean EWMA seed from
 * the first 28 known loads (a gap at the start of the analysed range).
 */

import { describe, expect, it } from "vitest";
import { WhoopApiError } from "../../src/api/client.js";
import { DEFAULT_PAGE_BUDGET, HISTORY_CHUNK_MS } from "../../src/api/history.js";
import type { Cycle, ScoreState, Sleep, Workout } from "../../src/api/types.js";
import { MemoryCache } from "../../src/cache/memory-cache.js";
import { localMidnightMs } from "../../src/tools/analytics-utils.js";
import { addDays, daysBetween, mondayOf, placeDays } from "../../src/tools/day-model.js";
import { getCalendar } from "../../src/tools/get-calendar.js";
import {
  acuteChronicReading,
  ewmaWindowSeed,
  getTrainingLoad,
  LOAD_HISTORY_EXTRA_DAYS,
  SLEEP_PLACEMENT_WARNING,
  trainingLoadOutputSchema,
  type TrainingLoadInput,
  type TrainingLoadOutput,
} from "../../src/tools/get-training-load.js";
import { getWeeklySummary } from "../../src/tools/get-weekly-summary.js";
import { roundTo } from "../../src/tools/stats-utils.js";
import { getTrainingLoadAggregate } from "../../src/tools/training-aggregate.js";
import { MAX_TOOL_TEXT_CHARS, type ToolContext } from "../../src/tools/tool-definition.js";
import { assertNeutralText, connectServer } from "../helpers/contract.js";
import {
  createWhoopFixtureClient,
  type WhoopFixtureClient,
  type WhoopFixtureClientOptions,
} from "../helpers/whoop-fixture-client.js";
import {
  liveShapedUser,
  matureUser,
  stressUser,
  type WhoopUserFixture,
} from "../helpers/whoop-users.js";

const MINUTE_MS = 60_000;
const OFFSET = "+02:00";

// ---------------------------------------------------------------------------
// Planned users
// ---------------------------------------------------------------------------

interface SessionPlan {
  /** Elapsed minutes */
  minutes: number;
  /** Zone 1-5 minutes; default every recorded minute in zone 3 */
  zones?: [number, number, number, number, number];
  fraction?: number;
  /** Local start, minutes after midnight (default 10:00) */
  startMinute?: number;
  state?: ScoreState;
  sport?: string;
  kj?: number;
}

interface DayPlan {
  worn: boolean;
  strain?: number;
  cycleState?: ScoreState;
  sessions?: SessionPlan[];
}

interface PlannedUser {
  cycles: Cycle[];
  workouts: Workout[];
  now: Date;
  firstDay: string;
  lastDay: string;
}

function localMs(day: string, minute: number, offset = OFFSET): number {
  return localMidnightMs(day, offset) + minute * MINUTE_MS;
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** A worn day whose TRIMP load is `load` (one zone-3 session), 0 without a session */
function trimpDay(load: number, extra: Partial<DayPlan> = {}): DayPlan {
  return {
    worn: true,
    sessions: load > 0 ? [{ minutes: load / 3 }] : [],
    ...extra,
  };
}

const unworn: DayPlan = { worn: false };

/**
 * Cycles and workouts for `plans` (oldest first, the last on `lastDay`). A worn
 * day's cycle starts at 23:00 the evening before (the first worn day at local
 * midnight when partialFirst) and ends where the next day's starts, at 21:00
 * before an unworn day, or stays open on the last day (openLast).
 */
function buildUser(options: {
  lastDay: string;
  plans: readonly DayPlan[];
  openLast?: boolean;
  partialFirst?: boolean;
  now?: Date;
  offset?: string;
}): PlannedUser {
  const offset = options.offset ?? OFFSET;
  const openLast = options.openLast ?? true;
  const partialFirst = options.partialFirst ?? true;
  const count = options.plans.length;
  const dayOf = (index: number): string => addDays(options.lastDay, index - (count - 1));
  const firstWorn = options.plans.findIndex((plan) => plan.worn);
  const startOf = (index: number): number =>
    index === firstWorn && partialFirst
      ? localMs(dayOf(index), 0, offset)
      : localMs(addDays(dayOf(index), -1), 23 * 60, offset);
  const cycles: Cycle[] = [];
  const workouts: Workout[] = [];
  options.plans.forEach((plan, index) => {
    if (!plan.worn) {
      return;
    }
    const day = dayOf(index);
    const startMs = startOf(index);
    const next = options.plans[index + 1];
    const endMs =
      next?.worn === true
        ? startOf(index + 1)
        : index === count - 1 && openLast
          ? null
          : localMs(day, 21 * 60, offset);
    const state = plan.cycleState ?? "SCORED";
    cycles.push({
      user_id: 1,
      created_at: iso(startMs + 8 * 3_600_000),
      updated_at: iso((endMs ?? startMs) + 5 * MINUTE_MS),
      score_state: state,
      start: iso(startMs),
      end: endMs === null ? null : iso(endMs),
      timezone_offset: offset,
      id: 10_000 + index,
      score:
        state === "SCORED"
          ? {
              strain: plan.strain ?? 10,
              kilojoule: 8000,
              average_heart_rate: 70,
              max_heart_rate: 160,
            }
          : null,
    });
  });
  options.plans.forEach((plan, index) => {
    (plan.sessions ?? []).forEach((session, k) => {
      workouts.push(sessionRecord(dayOf(index), session, `w-${dayOf(index)}-${k}`, offset));
    });
  });
  return {
    cycles,
    workouts,
    now: options.now ?? new Date(localMs(options.lastDay, 22 * 60, offset)),
    firstDay: dayOf(0),
    lastDay: options.lastDay,
  };
}

function sessionRecord(day: string, plan: SessionPlan, id: string, offset = OFFSET): Workout {
  const startMs = localMs(day, plan.startMinute ?? 600, offset);
  const durationMs = Math.round(plan.minutes * MINUTE_MS);
  const fraction = plan.fraction ?? 1;
  const recordedMs = Math.round(durationMs * fraction);
  const zones = (plan.zones ?? [0, 0, plan.minutes * fraction, 0, 0]).map((minutes) =>
    Math.round(minutes * MINUTE_MS)
  );
  const zoneZero = Math.max(0, recordedMs - zones.reduce((sum, value) => sum + value, 0));
  const state = plan.state ?? "SCORED";
  return {
    user_id: 1,
    created_at: iso(startMs + durationMs + MINUTE_MS),
    updated_at: iso(startMs + durationMs + MINUTE_MS),
    score_state: state,
    start: iso(startMs),
    end: iso(startMs + durationMs),
    timezone_offset: offset,
    id,
    sport_name: plan.sport ?? "running",
    sport_id: 0,
    v1_id: null,
    score:
      state === "SCORED"
        ? {
            strain: 10,
            average_heart_rate: 140,
            max_heart_rate: 170,
            kilojoule: plan.kj ?? 1000,
            percent_recorded: fraction,
            zone_durations: {
              zone_zero_milli: zoneZero,
              zone_one_milli: zones[0]!,
              zone_two_milli: zones[1]!,
              zone_three_milli: zones[2]!,
              zone_four_milli: zones[3]!,
              zone_five_milli: zones[4]!,
            },
            distance_meter: null,
            altitude_gain_meter: null,
            altitude_change_meter: null,
          }
        : null,
  };
}

function clientFor(
  user: { cycles: Cycle[]; workouts: Workout[]; now: Date },
  extra: Partial<WhoopFixtureClientOptions> = {}
): WhoopFixtureClient {
  return createWhoopFixtureClient({
    cycles: user.cycles,
    workouts: user.workouts,
    now: user.now,
    ...extra,
  });
}

function contextFor(client: WhoopFixtureClient, now: Date, cache?: MemoryCache): ToolContext {
  return {
    client,
    privacyMode: "standard",
    now: () => now,
    startedAtMs: Date.now(),
    ...(cache !== undefined ? { historyCache: cache } : {}),
  };
}

async function run(
  user: { cycles: Cycle[]; workouts: Workout[]; now: Date },
  args: TrainingLoadInput = {},
  extra: Partial<WhoopFixtureClientOptions> = {}
): Promise<{ output: TrainingLoadOutput; client: WhoopFixtureClient }> {
  const client = clientFor(user, extra);
  const output = await getTrainingLoad(args, contextFor(client, user.now));
  trainingLoadOutputSchema.parse(output);
  assertNeutralText([output.notes, output.warnings, output.acute_chronic.reading]);
  return { output, client };
}

function dayEntry(output: TrainingLoadOutput, date: string): TrainingLoadOutput["days"][number] {
  const entry = output.days.find((day) => day.date === date);
  if (!entry) throw new Error(`no day ${date}`);
  return entry;
}

const TODAY = "2026-09-16";

// ---------------------------------------------------------------------------
// Acute and chronic
// ---------------------------------------------------------------------------

describe("acute and chronic load", () => {
  it("compares the last 7 days with the last 28 (35 days at 300, then 7 at 450)", async () => {
    const plans = [
      ...Array.from({ length: 35 }, () => trimpDay(300)),
      ...Array.from({ length: 7 }, () => trimpDay(450)),
      trimpDay(0),
    ];
    const user = buildUser({ lastDay: TODAY, plans });
    const { output } = await run(user);
    expect(output.as_of_day).toBe(addDays(TODAY, -1));
    expect(output.period).toMatchObject({
      start_day: addDays(TODAY, -42),
      end_day: addDays(TODAY, -1),
    });
    expect(output.days).toHaveLength(42);
    expect(output.acute_chronic.acute_mean).toBe(450);
    expect(output.acute_chronic.chronic_mean).toBe(337.5);
    expect(output.acute_chronic.ratio).toBe(1.33);
    expect(output.acute_chronic.acute_known_days).toBe(7);
    expect(output.acute_chronic.chronic_known_days).toBe(28);
    expect(output.acute_chronic.reading).toBe(
      "Acute load (mean of the last 7 days) is 33% above the 28-day mean."
    );
    expect(output.status).toBe("available");
    expect(output.load_unit).toBe("TRIMP (Edwards)");
    const last = output.days[output.days.length - 1]!;
    expect(last).toMatchObject({
      load: 450,
      trimp: 450,
      acute_mean: 450,
      chronic_mean: 337.5,
      ratio: 1.33,
    });
    // The open cycle is excluded from every window and reported separately.
    expect(output.days.some((day) => day.date === TODAY)).toBe(false);
    expect(output.today_so_far).toEqual({ date: TODAY, day_strain: 10, sessions: 0, load: 0 });
  });

  it("reads the ratio neutrally", () => {
    expect(acuteChronicReading(0.82)).toBe(
      "Acute load (mean of the last 7 days) is 18% below the 28-day mean."
    );
    expect(acuteChronicReading(1.001)).toBe(
      "Acute load (mean of the last 7 days) equals the 28-day mean."
    );
    assertNeutralText([acuteChronicReading(1.6), acuteChronicReading(0.4)]);
  });

  it("needs 5 known days for the acute mean and 21 for the chronic mean", async () => {
    /** 60 worn days, then the 28-day window: `early` unworn days in its first 21, `late` in its last 7 */
    const plansWith = (early: number, late: number): DayPlan[] => [
      ...Array.from({ length: 60 }, () => trimpDay(200)),
      ...Array.from({ length: 21 }, (_, index) => (index < early ? unworn : trimpDay(200))),
      ...Array.from({ length: 7 }, (_, index) => (index < late ? unworn : trimpDay(200))),
      trimpDay(0),
    ];
    const below = (await run(buildUser({ lastDay: TODAY, plans: plansWith(5, 3) }))).output;
    expect(below.acute_chronic).toMatchObject({
      acute_known_days: 4,
      acute_mean: null,
      chronic_known_days: 20,
      chronic_mean: null,
      ratio: null,
    });
    expect(below.status).toBe("insufficient_history");
    // Unworn days are null, never 0.
    expect(dayEntry(below, addDays(TODAY, -7))).toMatchObject({
      worn: false,
      load: null,
      sessions: null,
      trimp: null,
    });

    const at = (await run(buildUser({ lastDay: TODAY, plans: plansWith(5, 2) }))).output;
    expect(at.acute_chronic).toMatchObject({
      acute_known_days: 5,
      acute_mean: 200,
      chronic_known_days: 21,
      chronic_mean: 200,
      ratio: 1,
    });
    expect(at.status).toBe("available");
  });
});

// ---------------------------------------------------------------------------
// EWMA
// ---------------------------------------------------------------------------

describe("EWMA seeding", () => {
  it("keeps ATL = CTL = load and TSB 0 on a long constant load with older history", async () => {
    const plans = [...Array.from({ length: 300 }, () => trimpDay(300)), trimpDay(0)];
    const user = buildUser({ lastDay: TODAY, plans });
    const { output } = await run(user, { days: 60 });
    expect(output.ewma_seed).toBe("window_mean");
    expect(output.ewma).toMatchObject({ atl: 300, ctl: 300, tsb: 0, warming_up: false });
    for (const day of output.days) {
      expect(day.atl).toBe(300);
      expect(day.ctl).toBe(300);
      expect(day.tsb).toBe(0);
    }
    expect(output.history.first_worn_day_is_lower_bound).toBe(true);
    expect(output.monotony.last_7_days).toMatchObject({
      monotony: null,
      reason: "identical_daily_loads",
    });
  });

  it("seeds from the window mean when the probe finds older history (CTL not ~13% low)", async () => {
    const days = 42;
    const asOf = addDays(TODAY, -1);
    const analysedFrom = addDays(asOf, -(days + LOAD_HISTORY_EXTRA_DAYS));
    // Worn every day from the analysed start; one old cycle long before, beyond the loaded chunks.
    const plans = [
      ...Array.from({ length: daysBetween(analysedFrom, TODAY) }, () => trimpDay(300)),
      trimpDay(0),
    ];
    const user = buildUser({ lastDay: TODAY, plans, partialFirst: false });
    const oldStart = localMs(addDays(analysedFrom, -150), 23 * 60);
    user.cycles.push({
      ...user.cycles[0]!,
      id: 1,
      start: iso(oldStart),
      end: iso(oldStart + 20 * 3_600_000),
      created_at: iso(oldStart + 21 * 3_600_000),
      updated_at: iso(oldStart + 21 * 3_600_000),
    });
    const { output, client } = await run(user, { days });
    expect(client.calls.some((path) => path.startsWith("/v2/cycle?end="))).toBe(true);
    expect(output.history.analysed_from_day).toBe(analysedFrom);
    expect(output.ewma_seed).toBe("window_mean");
    expect(output.ewma.started_on).toBe(analysedFrom);
    expect(output.days[0]!.ctl).toBe(300);
    expect(output.ewma.ctl).toBe(300);
    expect(output.history.first_worn_day).toBe(analysedFrom);
    expect(output.history.first_worn_day_is_lower_bound).toBe(true);
    expect(output.notes).toContain(
      `WHOOP history continues before ${analysedFrom}, so ATL and CTL start there from the mean of its first 28 known daily loads (${analysedFrom} to ${addDays(analysedFrom, 27)}) instead of 0.`
    );

    // Without the older cycle the same loads start from 0 and CTL is null until day 42.
    user.cycles.pop();
    const fresh = (await run(user, { days })).output;
    expect(fresh.ewma_seed).toBe("zero_at_first_worn_day");
    expect(fresh.history.first_worn_day_is_lower_bound).toBe(false);
    const ctlAtEnd = fresh.ewma.ctl!;
    // 86 days after the first worn day a zero seed is still about 13% low.
    expect(ctlAtEnd).toBeLessThan(300 * 0.9);
    expect(ctlAtEnd).toBeGreaterThan(300 * 0.85);
  });

  it("starts a fresh account at 0 on the first worn day with warm-up nulls", async () => {
    const plans = [...Array.from({ length: 50 }, () => trimpDay(200)), trimpDay(0)];
    const user = buildUser({ lastDay: TODAY, plans });
    const { output } = await run(user, { days: 60 });
    const firstWorn = addDays(TODAY, -50);
    expect(output.ewma_seed).toBe("zero_at_first_worn_day");
    expect(output.ewma.started_on).toBe(firstWorn);
    expect(output.ewma.warming_up).toBe(true);
    expect(output.history).toMatchObject({
      first_worn_day: firstWorn,
      first_worn_day_is_lower_bound: false,
      worn_days: 50,
    });
    for (const day of output.days) {
      const since = daysBetween(firstWorn, day.date);
      if (since < 0) {
        expect(day).toMatchObject({ worn: false, atl: null, ctl: null, tsb: null, load: null });
      } else if (since < 42) {
        expect(day.atl).not.toBeNull();
        expect(day.ctl).toBeNull();
        expect(day.tsb).toBeNull();
      } else {
        expect(day.ctl).not.toBeNull();
        expect(day.tsb).not.toBeNull();
      }
    }
    // First step from 0: 200 / 7.
    expect(dayEntry(output, firstWorn).atl).toBe(28.6);
    expect(output.status).toBe("available");
    expect(output.acute_chronic.available_from_day).toBe(addDays(firstWorn, 27));
  });

  it("counts unknown days as 0 in the EWMA and reports how many", async () => {
    const plans = [
      ...Array.from({ length: 120 }, (_, index) => (index % 10 === 3 ? unworn : trimpDay(250))),
      trimpDay(0),
    ];
    const user = buildUser({ lastDay: TODAY, plans });
    const { output } = await run(user, { days: 30 });
    expect(output.ewma_seed).toBe("window_mean");
    const analysed = 30 + LOAD_HISTORY_EXTRA_DAYS + 1;
    const unknown = Array.from({ length: analysed }, (_, index) =>
      addDays(addDays(TODAY, -1), -index)
    ).filter((day) => ((daysBetween(addDays(TODAY, -120), day) % 10) + 10) % 10 === 3).length;
    expect(output.ewma.unknown_days_counted_as_zero).toBe(unknown);
    expect(output.history.unknown_days).toBe(unknown);
    expect(
      output.notes.some((note) =>
        note.startsWith(`${unknown} days without a known load count as 0`)
      )
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Monotony
// ---------------------------------------------------------------------------

describe("Foster monotony", () => {
  it("reports monotony and strain for the last 7 days and the last completed week", async () => {
    // TODAY is a Wednesday; as_of (Tuesday) ends the last 7 days.
    const pattern = [100, 0, 100, 0, 100, 0, 100];
    const plans = [
      ...Array.from({ length: 40 }, () => trimpDay(120)),
      ...pattern.map((load) => trimpDay(load)),
      trimpDay(0),
    ];
    const user = buildUser({ lastDay: TODAY, plans });
    const { output } = await run(user, { days: 14 });
    expect(output.monotony.last_7_days).toMatchObject({
      start_day: addDays(TODAY, -7),
      end_day: addDays(TODAY, -1),
      monotony: 1.07,
      foster_strain: 427.6,
      reason: null,
    });
    const lastWeek = mondayOf(addDays(TODAY, -7));
    expect(output.monotony.last_completed_week?.week_start).toBe(lastWeek);
  });

  it("returns unknown_days when a day of the week is unworn", async () => {
    const plans = [
      ...Array.from({ length: 40 }, () => trimpDay(120)),
      trimpDay(100),
      trimpDay(0),
      unworn,
      trimpDay(0),
      trimpDay(100),
      trimpDay(0),
      trimpDay(100),
      trimpDay(0),
    ];
    const user = buildUser({ lastDay: TODAY, plans });
    const { output } = await run(user, { days: 14 });
    expect(output.monotony.last_7_days).toMatchObject({
      monotony: null,
      foster_strain: null,
      reason: "unknown_days",
    });
  });
});

// ---------------------------------------------------------------------------
// The live-shaped account
// ---------------------------------------------------------------------------

describe("liveShapedUser", () => {
  it("reports insufficient history with available_from_day, today_so_far and the partial first day", async () => {
    const fixture = liveShapedUser();
    const client = createWhoopFixtureClient({ ...fixture, now: fixture.now });
    const output = await getTrainingLoad({}, contextFor(client, fixture.now));
    trainingLoadOutputSchema.parse(output);
    expect(output.status).toBe("insufficient_history");
    expect(output.as_of_day).toBe("2026-09-15");
    expect(output.acute_chronic.available_from_day).toBe("2026-10-11");
    expect(output.history).toMatchObject({
      first_worn_day: "2026-09-14",
      first_worn_day_is_lower_bound: false,
      worn_days: 2,
    });
    expect(output.ewma_seed).toBe("zero_at_first_worn_day");
    expect(output.today_so_far).toMatchObject({ date: "2026-09-16", sessions: 3 });
    expect(output.today_so_far!.day_strain).toBe(13.1);
    expect(output.today_so_far!.load).not.toBeNull();

    const partial = dayEntry(output, "2026-09-14");
    expect(partial).toMatchObject({ worn: true, partial: true, day_strain: null, sessions: 1 });
    expect(partial.flags).toContain("partial_day");
    const complete = dayEntry(output, "2026-09-15");
    expect(complete).toMatchObject({ worn: true, partial: false, day_strain: 15.9, sessions: 4 });
    expect(output.notes.some((note) => note.includes("available from 2026-10-11"))).toBe(true);
    assertNeutralText([output.notes, output.warnings]);

    const strain = await getTrainingLoad(
      { load_metric: "day_strain" },
      contextFor(createWhoopFixtureClient({ ...fixture, now: fixture.now }), fixture.now)
    );
    expect(dayEntry(strain, "2026-09-14").load).toBeNull();
    expect(dayEntry(strain, "2026-09-15").load).toBe(15.9);
    expect(strain.today_so_far).toMatchObject({ date: "2026-09-16", load: 13.1 });
    expect(strain.load_by_sport_28d).toEqual([]);
    expect(
      strain.notes.some((note) => note.includes("Foster monotony assumes a linear load"))
    ).toBe(true);
  });

  it("has no completed day before the first cycle closes", async () => {
    const fixture = liveShapedUser({ now: "2026-09-14T20:00:00+02:00" });
    const client = createWhoopFixtureClient({ ...fixture, now: fixture.now });
    const output = await getTrainingLoad({}, contextFor(client, fixture.now));
    trainingLoadOutputSchema.parse(output);
    expect(output.status).toBe("insufficient_history");
    expect(output.as_of_day).toBeNull();
    expect(output.days).toEqual([]);
    expect(output.today_so_far).toMatchObject({ date: "2026-09-14", sessions: 0 });
    expect(output.history.first_worn_day).toBe("2026-09-14");
    expect(output.acute_chronic.available_from_day).toBe("2026-10-11");
  });
});

// ---------------------------------------------------------------------------
// Day strain, recording and weeks
// ---------------------------------------------------------------------------

describe("days and weeks", () => {
  it("skips partial and open days for day strain and nulls TRIMP for low recording", async () => {
    const plans: DayPlan[] = [
      trimpDay(90, { strain: 6 }),
      trimpDay(120, { strain: 11 }),
      { worn: true, strain: 12, sessions: [{ minutes: 60, fraction: 0.85 }] },
      { worn: true, strain: 9, cycleState: "PENDING_SCORE", sessions: [] },
      trimpDay(150, { strain: 14 }),
    ];
    const user = buildUser({ lastDay: TODAY, plans });
    const { output } = await run(user, { load_metric: "day_strain", days: 14 });
    const first = dayEntry(output, addDays(TODAY, -4));
    expect(first).toMatchObject({ partial: true, day_strain: null, load: null });
    expect(dayEntry(output, addDays(TODAY, -3))).toMatchObject({ day_strain: 11, load: 11 });
    const low = dayEntry(output, addDays(TODAY, -2));
    expect(low).toMatchObject({ day_strain: 12, trimp: null, sessions: 1 });
    expect(low.workout_minutes).toBe(60);
    expect(low.flags).toContain("low_recording");
    const unscored = dayEntry(output, addDays(TODAY, -1));
    expect(unscored).toMatchObject({ worn: true, day_strain: null, load: null, sessions: 0 });
    expect(unscored.flags).toContain("strain_not_scored");
    expect(output.today_so_far).toMatchObject({ date: TODAY, day_strain: 14, load: 14 });

    const trimp = (await run(user, { days: 14 })).output;
    expect(dayEntry(trimp, addDays(TODAY, -2)).load).toBeNull();
    expect(dayEntry(trimp, addDays(TODAY, -3)).load).toBe(120);
    expect(trimp.notes.some((note) => note.includes("TRIMP is null there"))).toBe(true);
  });

  it("nulls a day's workout values while a session is pending", async () => {
    const plans: DayPlan[] = [
      ...Array.from({ length: 10 }, () => trimpDay(100)),
      { worn: true, sessions: [{ minutes: 30 }, { minutes: 40, state: "PENDING_SCORE" }] },
      trimpDay(0),
    ];
    const user = buildUser({ lastDay: TODAY, plans });
    const { output } = await run(user, { days: 14 });
    const pending = dayEntry(output, addDays(TODAY, -1));
    expect(pending).toMatchObject({ sessions: 1, workout_minutes: null, trimp: null, load: null });
    expect(pending.flags).toContain("pending_workout");
    expect(output.data_quality.sources.workouts!.exclusions.pending).toBe(1);
  });

  it("totals ISO weeks across a month boundary from the placed days", async () => {
    const plans = [
      ...Array.from({ length: 60 }, (_, index) => trimpDay(60 + (index % 5) * 30)),
      trimpDay(0),
    ];
    const user = buildUser({ lastDay: TODAY, plans });
    const { output } = await run(user, { days: 28 });
    const week = output.weeks.find((entry) => entry.week_start === "2026-08-31");
    expect(week).toBeDefined();
    const weekDays = output.days.filter(
      (day) => day.date >= "2026-08-31" && day.date <= "2026-09-06"
    );
    expect(weekDays.map((day) => day.date)).toEqual([
      "2026-08-31",
      "2026-09-01",
      "2026-09-02",
      "2026-09-03",
      "2026-09-04",
      "2026-09-05",
      "2026-09-06",
    ]);
    const sum = (values: (number | null)[]): number =>
      values.reduce<number>((total, value) => total + (value ?? 0), 0);
    expect(week!.sessions).toBe(sum(weekDays.map((day) => day.sessions)));
    expect(week!.trimp).toBeCloseTo(sum(weekDays.map((day) => day.trimp)), 0);
    expect(week!.worn_days).toBe(7);
    expect(week!.in_progress).toBe(false);
    expect(week!.completed_cycles).toBe(7);
    expect(week!.monotony).not.toBeNull();
    const previousTrimp = sum(
      output.days
        .filter((day) => day.date >= "2026-08-24" && day.date <= "2026-08-30")
        .map((day) => day.trimp)
    );
    expect(week!.change_vs_previous_pct).toBe(
      Math.round(((week!.trimp! - previousTrimp) / previousTrimp) * 100)
    );
    const current = output.weeks[output.weeks.length - 1]!;
    expect(current).toMatchObject({ week_start: "2026-09-14", in_progress: true });
    expect(current.change_vs_previous_pct).toBeNull();
    expect(current.monotony).toBeNull();
  });

  it("keeps 7 local days per week across an offset change (DST)", async () => {
    const fixture = matureUser({ days: 90, offsetChange: { day: 75, offset: "+01:00" } });
    const client = createWhoopFixtureClient({ ...fixture, now: fixture.now });
    const output = await getTrainingLoad({ days: 42 }, contextFor(client, fixture.now));
    trainingLoadOutputSchema.parse(output);
    const dates = output.days.map((day) => day.date);
    for (let index = 1; index < dates.length; index++) {
      expect(daysBetween(dates[index - 1]!, dates[index]!)).toBe(1);
    }
    for (const week of output.weeks.filter((entry) => !entry.in_progress)) {
      const weekDays = output.days.filter(
        (day) => day.date >= week.week_start && day.date <= addDays(week.week_start, 6)
      );
      if (weekDays.length < 7) continue;
      expect(week.worn_days).toBe(weekDays.filter((day) => day.worn === true).length);
      expect(week.sessions).toBe(weekDays.reduce((total, day) => total + (day.sessions ?? 0), 0));
    }
    expect(output.status).toBe("available");
  });

  it("lists load by sport over the last 28 days with shares", async () => {
    const plans = [
      ...Array.from({ length: 40 }, (_, index) => ({
        worn: true,
        sessions: [
          { minutes: 30, sport: index % 2 === 0 ? "running" : "cycling" },
          ...(index % 4 === 0 ? [{ minutes: 20, sport: "walking", fraction: 0.8 }] : []),
        ],
      })),
      trimpDay(0),
    ];
    const user = buildUser({ lastDay: TODAY, plans });
    const { output } = await run(user, { days: 28 });
    const names = output.load_by_sport_28d.map((sport) => sport.sport_name);
    expect(names.slice(0, 2).sort()).toEqual(["cycling", "running"]);
    const walking = output.load_by_sport_28d.find((sport) => sport.sport_name === "walking")!;
    expect(walking.load).toBe(0);
    expect(walking.sessions_without_load).toBe(walking.sessions);
    const shares = output.load_by_sport_28d.reduce((sum, sport) => sum + (sport.share_pct ?? 0), 0);
    expect(Math.abs(shares - 100)).toBeLessThanOrEqual(1);
    const minutes = (await run(user, { load_metric: "workout_minutes", days: 28 })).output;
    const walkingMinutes = minutes.load_by_sport_28d.find(
      (sport) => sport.sport_name === "walking"
    )!;
    expect(walkingMinutes.load).toBe(walkingMinutes.sessions * 20);
    expect(minutes.load_unit).toBe("minutes");
  });
});

// ---------------------------------------------------------------------------
// Failures, truncation and older history
// ---------------------------------------------------------------------------

describe("failed and partial sources", () => {
  const plans = [...Array.from({ length: 40 }, () => trimpDay(150, { strain: 12 })), trimpDay(0)];

  it("keeps the day_strain path when workouts fail", async () => {
    const user = buildUser({ lastDay: TODAY, plans });
    const failures = [
      {
        path: /^\/v2\/activity\/workout/,
        error: new WhoopApiError(503, "Service Unavailable", {}),
      },
    ];
    const strain = (await run(user, { load_metric: "day_strain", days: 14 }, { failures })).output;
    expect(strain.status).toBe("available");
    expect(
      strain.warnings.some((warning) => warning.startsWith("Workout data could not be loaded"))
    ).toBe(true);
    expect(strain.days.every((day) => day.sessions === null && day.trimp === null)).toBe(true);
    expect(strain.acute_chronic.chronic_mean).toBe(12);
    // The open day's plan has the default cycle strain of 10.
    expect(strain.today_so_far).toMatchObject({ sessions: null, load: 10 });

    const trimp = (await run(user, { days: 14 }, { failures })).output;
    expect(trimp.status).toBe("unavailable");
    expect(trimp.days.every((day) => day.load === null)).toBe(true);
    expect(trimp.data_quality.sources.workouts!.status).toBe("fetch_failed");
  });

  it("reports unavailable when cycles fail and throws when both sources fail", async () => {
    const user = buildUser({ lastDay: TODAY, plans });
    const cycleFailure = {
      path: /^\/v2\/cycle\?start=/,
      error: new WhoopApiError(500, "Internal Server Error", {}),
    };
    const output = (await run(user, {}, { failures: [cycleFailure] })).output;
    expect(output.status).toBe("unavailable");
    expect(output.days).toEqual([]);
    expect(
      output.warnings.some((warning) => warning.startsWith("Cycle data could not be loaded"))
    ).toBe(true);

    const client = clientFor(user, {
      failures: [
        cycleFailure,
        { path: /^\/v2\/activity\/workout/, error: new WhoopApiError(401, "Unauthorized", {}) },
      ],
    });
    await expect(getTrainingLoad({}, contextFor(client, user.now))).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it("marks first_worn_day as a lower bound when older cycle chunks cannot be read", async () => {
    const fixture = matureUser({ days: 120 });
    const today = "2026-09-16";
    const analysedStart = addDays(today, -(2 + 42 + LOAD_HISTORY_EXTRA_DAYS + 2));
    const chunkStart =
      Math.floor(localMidnightMs(analysedStart, "+01:00") / HISTORY_CHUNK_MS) * HISTORY_CHUNK_MS;
    const chunkIso = encodeURIComponent(new Date(chunkStart).toISOString());
    const client = createWhoopFixtureClient({
      ...fixture,
      now: fixture.now,
      failures: [
        {
          path: new RegExp(`^/v2/cycle\\?start=${chunkIso.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
          error: new WhoopApiError(502, "Bad Gateway", {}),
        },
      ],
    });
    const output = await getTrainingLoad({ days: 42 }, contextFor(client, fixture.now));
    trainingLoadOutputSchema.parse(output);
    expect(output.truncated).toBe(true);
    expect(output.history.first_worn_day_is_lower_bound).toBe(true);
    expect(
      output.notes.some((note) => note.startsWith("Cycle history could not be read completely"))
    ).toBe(true);
    // Days before the complete range are unknown, not unworn.
    const unknownDays = output.days.filter((day) => day.worn === null);
    for (const day of unknownDays) expect(day.load).toBeNull();
  });

  it("reads older history when the strap has been off for weeks", async () => {
    const offDays = 40;
    const plans = [
      ...Array.from({ length: 150 }, () => trimpDay(200)),
      ...Array.from({ length: offDays }, () => unworn),
    ];
    const user = buildUser({ lastDay: TODAY, plans, openLast: false });
    const { output, client } = await run(user, { days: 42 });
    const lastWorn = addDays(TODAY, -offDays);
    expect(output.as_of_day).toBe(lastWorn);
    expect(output.today_so_far).toBeNull();
    // The whole analysed range was loaded: every day is worn and known.
    expect(output.days.every((day) => day.worn === true && day.load !== null)).toBe(true);
    expect(output.history.worn_days).toBe(42 + LOAD_HISTORY_EXTRA_DAYS + 1);
    expect(output.ewma_seed).toBe("window_mean");
    expect(output.ewma).toMatchObject({ atl: 200, ctl: 200, tsb: 0 });
    const neededStart = localMidnightMs(
      addDays(lastWorn, -(42 + LOAD_HISTORY_EXTRA_DAYS + 2)),
      OFFSET
    );
    const oldestChunk = new Date(
      Math.floor(neededStart / HISTORY_CHUNK_MS) * HISTORY_CHUNK_MS
    ).toISOString();
    expect(client.calls.some((path) => path.includes(encodeURIComponent(oldestChunk)))).toBe(true);
    expect(output.truncated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Regression: EWMA seed from the first known loads
// ---------------------------------------------------------------------------

describe("EWMA window-mean seed from known loads", () => {
  const range = (from: number, to: number): number[] =>
    Array.from({ length: to - from + 1 }, (_, index) => from + index);

  it("keeps CTL and TSB on every day when the analysed range starts with an 8-day gap", async () => {
    // matureUser starts 120 days ago; days 32..39 are the first 8 analysed days.
    const fixture = matureUser({ gapDays: range(32, 39), pendingLast: false });
    const client = createWhoopFixtureClient({ ...fixture, now: fixture.now });
    const output = await getTrainingLoad(
      { load_metric: "day_strain" },
      contextFor(client, fixture.now)
    );
    trainingLoadOutputSchema.parse(output);
    expect(output.ewma_seed).toBe("window_mean");
    expect(output.days).toHaveLength(42);
    for (const day of output.days) {
      expect(day.ctl, day.date).not.toBeNull();
      expect(day.tsb, day.date).not.toBeNull();
    }
    expect(Math.abs(output.ewma.ctl! - 9.3)).toBeLessThanOrEqual(0.2);
    const analysedFrom = output.history.analysed_from_day!;
    // The first known load follows the gap; the 28th is 27 known days later.
    expect(output.notes).toContain(
      `WHOOP history continues before ${analysedFrom}, so ATL and CTL start there from the mean of its first 28 known daily loads (${addDays(analysedFrom, 8)} to ${addDays(analysedFrom, 35)}) instead of 0.`
    );
    assertNeutralText([output.notes, output.warnings]);
  });

  it("keeps CTL with trimp across a 7-day gap", async () => {
    const fixture = matureUser({ gapDays: range(33, 39), pendingLast: false });
    const client = createWhoopFixtureClient({ ...fixture, now: fixture.now });
    const output = await getTrainingLoad({}, contextFor(client, fixture.now));
    trainingLoadOutputSchema.parse(output);
    expect(output.ewma_seed).toBe("window_mean");
    expect(output.ewma.ctl).not.toBeNull();
    expect(output.ewma.tsb).not.toBeNull();
    expect(output.days.every((day) => day.ctl !== null)).toBe(true);
  });

  it("nulls CTL and TSB only when the analysed range has fewer than 21 known loads", async () => {
    const days = 14;
    const asOf = addDays(TODAY, -1);
    const analysedFrom = addDays(asOf, -(days + LOAD_HISTORY_EXTRA_DAYS));
    const total = daysBetween(analysedFrom, TODAY) + 1;
    const oldCycle = (template: Cycle): Cycle => {
      const oldStart = localMs(addDays(analysedFrom, -150), 23 * 60);
      return {
        ...template,
        id: 1,
        start: iso(oldStart),
        end: iso(oldStart + 20 * 3_600_000),
        created_at: iso(oldStart + 21 * 3_600_000),
        updated_at: iso(oldStart + 21 * 3_600_000),
      };
    };
    // 20 worn days before today (known loads), then today's open cycle.
    const plans = Array.from({ length: total }, (_, index) =>
      index >= total - 21 ? trimpDay(index === total - 1 ? 0 : 120) : unworn
    );
    const user = buildUser({ lastDay: TODAY, plans, partialFirst: false });
    user.cycles.push(oldCycle(user.cycles[0]!));
    const { output } = await run(user, { days });
    expect(output.ewma_seed).toBe("window_mean");
    expect(output.days.every((day) => day.ctl === null && day.tsb === null)).toBe(true);
    expect(output.ewma.atl).not.toBeNull();
    expect(output.notes).toContain(
      `WHOOP history continues before ${analysedFrom}, but only 20 days in the analysed range have a known load (21 needed to seed CTL), so CTL and TSB are null.`
    );

    // One more known load seeds CTL although the first 28 analysed days are unknown.
    const more = buildUser({
      lastDay: TODAY,
      plans: plans.map((plan, index) => (index === total - 22 ? trimpDay(120) : plan)),
      partialFirst: false,
    });
    more.cycles.push(oldCycle(more.cycles[0]!));
    const seeded = (await run(more, { days })).output;
    expect(seeded.days.every((day) => day.ctl !== null && day.tsb !== null)).toBe(true);
    expect(seeded.notes.some((note) => note.includes("first 21 known daily loads"))).toBe(true);
  });

  it("limits the seed to the first 42 analysed days when they hold 21 known loads", () => {
    const loads: (number | null)[] = Array.from({ length: 80 }, (_, index) =>
      index < 42 ? (index % 2 === 0 ? 10 : null) : 50
    );
    // 21 known loads in the first 42 days (even indexes); the 28th known load is day 48.
    const seed = ewmaWindowSeed(loads);
    expect(seed.indexes).toHaveLength(21);
    expect(seed.indexes[seed.indexes.length - 1]).toBe(40);
    expect(seed.known).toBe(21 + 38);
    // With only 20 in the first 42 days, the first 28 known loads are used.
    loads[40] = null;
    const wider = ewmaWindowSeed(loads);
    expect(wider.indexes).toHaveLength(28);
    expect(wider.indexes[27]).toBe(49);
    // The 28th known load within the first 42 days: the first 28.
    expect(ewmaWindowSeed(Array.from({ length: 60 }, () => 5)).indexes).toHaveLength(28);
  });
});

// ---------------------------------------------------------------------------
// Regression: day placement like get_calendar
// ---------------------------------------------------------------------------

/** matureUser with a split night on day 50 whose first sleep is the longer one (379 vs 100 minutes) */
function splitNightFirstLonger(): { fixture: WhoopUserFixture; day: string } {
  const fixture = structuredClone(matureUser({ days: 60, seed: 3, splitNightDays: [50] }));
  const placement = placeDays({
    cycles: fixture.cycles,
    sleeps: fixture.sleeps,
    recoveries: [],
    sleepsAvailable: true,
    today: TODAY,
    utcOffset: fixture.offset,
  });
  const displaced = placement.displaced[0]!;
  const first = fixture.cycles.find((cycle) => cycle.id === displaced.other.id)!;
  const second = fixture.cycles.find((cycle) => cycle.id === displaced.shown.id)!;
  const firstSleep = fixture.sleeps.find(
    (sleep) => sleep.id === placement.mainSleepByCycle.get(first.id)!.id
  )!;
  const secondSleep = fixture.sleeps.find(
    (sleep) => sleep.id === placement.mainSleepByCycle.get(second.id)!.id
  )!;
  const secondStart = Date.parse(secondSleep.end) - 100 * MINUTE_MS;
  first.end = iso(secondStart);
  second.start = iso(secondStart);
  secondSleep.start = iso(secondStart);
  firstSleep.end = iso(secondStart - 40 * MINUTE_MS);
  return { fixture, day: displaced.day };
}

function fullClient(
  fixture: WhoopUserFixture,
  extra: Partial<WhoopFixtureClientOptions> = {}
): WhoopFixtureClient {
  return createWhoopFixtureClient({ ...fixture, now: fixture.now, ...extra });
}

/**
 * A normal sleeper with one disrupted night (+02:00): awake through the night
 * of 09-16, main sleep 09-17 13:00-20:00, sessions on 09-16 18:00 and 09-17
 * 21:15; now 09-17 23:00 local.
 */
function daySleeper(): { cycles: Cycle[]; sleeps: Sleep[]; workouts: Workout[]; now: Date } {
  const bounds: [number, number | null, number][] = [
    [localMs("2026-09-13", 1393), localMs("2026-09-14", 1393), localMs("2026-09-14", 420)],
    [localMs("2026-09-14", 1393), localMs("2026-09-15", 1393), localMs("2026-09-15", 420)],
    [localMs("2026-09-15", 1393), localMs("2026-09-17", 780), localMs("2026-09-16", 420)],
    [localMs("2026-09-17", 780), null, localMs("2026-09-17", 1200)],
  ];
  const cycles: Cycle[] = [];
  const sleeps: Sleep[] = [];
  bounds.forEach(([startMs, endMs, sleepEndMs], index) => {
    cycles.push({
      id: 7000 + index,
      user_id: 1,
      created_at: iso(sleepEndMs + 10 * MINUTE_MS),
      updated_at: iso((endMs ?? sleepEndMs) + 10 * MINUTE_MS),
      start: iso(startMs),
      end: endMs === null ? null : iso(endMs),
      timezone_offset: OFFSET,
      score_state: "SCORED",
      score: { strain: 10 + index, kilojoule: 8000, average_heart_rate: 70, max_heart_rate: 150 },
    });
    const inBed = sleepEndMs - startMs;
    const awake = Math.round(inBed * 0.1);
    const light = Math.round(inBed * 0.45);
    const deep = Math.round(inBed * 0.2);
    sleeps.push({
      id: `00000000-0000-4000-8000-00000000000${index}`,
      cycle_id: 7000 + index,
      v1_id: null,
      user_id: 1,
      created_at: iso(sleepEndMs + 5 * MINUTE_MS),
      updated_at: iso(sleepEndMs + 5 * MINUTE_MS),
      start: iso(startMs),
      end: iso(sleepEndMs),
      timezone_offset: OFFSET,
      nap: false,
      score_state: "SCORED",
      score: {
        stage_summary: {
          total_in_bed_time_milli: inBed,
          total_awake_time_milli: awake,
          total_no_data_time_milli: 0,
          total_light_sleep_time_milli: light,
          total_slow_wave_sleep_time_milli: deep,
          total_rem_sleep_time_milli: inBed - awake - light - deep,
          sleep_cycle_count: 4,
          disturbance_count: 8,
        },
        sleep_needed: {
          baseline_milli: 28_000_000,
          need_from_sleep_debt_milli: 0,
          need_from_recent_strain_milli: 0,
          need_from_recent_nap_milli: 0,
        },
        respiratory_rate: 15,
        sleep_performance_percentage: 80,
        sleep_consistency_percentage: 70,
        sleep_efficiency_percentage: 90,
      },
    });
  });
  const workouts = [
    sessionRecord("2026-09-16", { minutes: 60, startMinute: 18 * 60 }, "w-0916"),
    sessionRecord("2026-09-17", { minutes: 45, startMinute: 21 * 60 + 15 }, "w-0917"),
  ];
  return { cycles, sleeps, workouts, now: new Date(localMs("2026-09-17", 23 * 60)) };
}

describe("day placement like get_calendar", () => {
  it("uses the cycle get_calendar shows after a split night whose first sleep is longer", async () => {
    const { fixture, day } = splitNightFirstLonger();
    expect(day).toBe("2026-09-07");
    const output = await getTrainingLoad(
      { load_metric: "day_strain" },
      contextFor(fullClient(fixture), fixture.now)
    );
    trainingLoadOutputSchema.parse(output);
    const calendar = await getCalendar(fullClient(fixture), { start: day, days: 1 }, fixture.now);
    const row = calendar.days.find((entry) => entry.date === day)!;
    expect(row.day_strain).not.toBeNull();
    expect(dayEntry(output, day).day_strain).toBe(roundTo(row.day_strain!, 1));
    expect(dayEntry(output, day).day_strain).toBe(1.4);

    const weekly = await getWeeklySummary(fullClient(fixture), { week_start: day }, fixture.now);
    const week = output.weeks.find((entry) => entry.week_start === mondayOf(day))!;
    expect(week.mean_day_strain).toBe(roundTo(weekly.strain.average_daily_strain!, 1));
    expect(week.mean_day_strain).toBe(8.7);

    const aggregate = await getTrainingLoadAggregate(
      { load_metric: "day_strain", weeks: 4 },
      { ...contextFor(fullClient(fixture), fixture.now), privacyMode: "aggregate" }
    );
    const aggregateWeek = aggregate.weeks.find((entry) => entry.week_start === mondayOf(day))!;
    expect(aggregateWeek.mean_day_strain).toBe(week.mean_day_strain);

    expect(output.warnings.filter((warning) => warning.startsWith("Two WHOOP cycles"))).toEqual([
      `Two WHOOP cycles belong to ${day} (for example, a second main sleep ended that day). The day uses the cycle that started 2026-09-06 22:41; the cycle that started 2026-09-07 05:39 (strain 5.7) is left out of that day's strain; its workouts count on that day.`,
    ]);
    expect(output.data_quality.sources.sleeps!.status).toBe("available");
    expect(output.data_quality.limitations.join(" ")).toContain("split nights");
    assertNeutralText([output.notes, output.warnings]);
  });

  it("warns about the two cycles of the unmodified split night", async () => {
    const fixture = matureUser({ days: 60, seed: 3, splitNightDays: [50] });
    const output = await getTrainingLoad(
      { load_metric: "day_strain" },
      contextFor(fullClient(fixture), fixture.now)
    );
    const calendar = await getCalendar(
      fullClient(fixture),
      { start: "2026-09-07", days: 1 },
      fixture.now
    );
    const two = output.warnings.filter((warning) => warning.startsWith("Two WHOOP cycles"));
    expect(two).toHaveLength(1);
    expect(two[0]).toContain("belong to 2026-09-07");
    expect(dayEntry(output, "2026-09-07").day_strain).toBe(
      roundTo(calendar.days.find((entry) => entry.date === "2026-09-07")!.day_strain!, 1)
    );
    expect(output.data_quality.sources.cycles!.exclusions.displaced).toBe(1);
  });

  it("dates today_so_far on today for a day sleeper, with and without sleeps", async () => {
    const data = daySleeper();
    const output = await getTrainingLoad(
      {},
      contextFor(createWhoopFixtureClient({ ...data }), data.now)
    );
    trainingLoadOutputSchema.parse(output);
    expect(output.as_of_day).toBe("2026-09-16");
    expect(output.today_so_far).toMatchObject({ date: "2026-09-17", sessions: 1 });
    expect(dayEntry(output, "2026-09-16").sessions).toBe(1);
    expect(output.warnings).not.toContain(SLEEP_PLACEMENT_WARNING);

    // Sleeps unreadable: the open cycle counts toward 12 hours after its start
    // (tomorrow), but today_so_far is never after today.
    const failing = createWhoopFixtureClient({
      ...data,
      failures: [
        {
          path: /^\/v2\/activity\/sleep/,
          error: new WhoopApiError(503, "Service Unavailable", {}),
        },
      ],
    });
    const cyclesOnly = await getTrainingLoad({}, contextFor(failing, data.now));
    trainingLoadOutputSchema.parse(cyclesOnly);
    expect(cyclesOnly.today_so_far).toMatchObject({ date: "2026-09-17", sessions: 1 });
    expect(cyclesOnly.warnings).toContain(SLEEP_PLACEMENT_WARNING);
    expect(cyclesOnly.data_quality.sources.sleeps!.status).toBe("fetch_failed");
    assertNeutralText([cyclesOnly.notes, cyclesOnly.warnings]);
  });

  it("repeats a call with sleeps from the cache", async () => {
    const fixture = matureUser({ days: 60 });
    const client = fullClient(fixture);
    const cache = new MemoryCache({ maxEntries: 200 });
    const first = await getTrainingLoad({}, contextFor(client, fixture.now, cache));
    expect(client.calls.some((path) => path.startsWith("/v2/activity/sleep"))).toBe(true);
    expect(first.truncated).toBe(false);
    const before = client.calls.length;
    const again = await getTrainingLoad({}, contextFor(client, fixture.now, cache));
    expect(client.calls.length - before).toBeLessThanOrEqual(2);
    expect(again.days).toEqual(first.days);
    expect(again.warnings).toEqual(first.warnings);
  });
});

// ---------------------------------------------------------------------------
// Size, requests and the MCP contract
// ---------------------------------------------------------------------------

describe("stressUser, requests and contract", () => {
  it("stays within the output limit and the request budget at 180 days", async () => {
    const fixture = stressUser();
    const client = createWhoopFixtureClient({ ...fixture, now: fixture.now });
    const cache = new MemoryCache({ maxEntries: 500 });
    const connection = await connectServer(client, {
      privacyMode: "standard",
      now: () => fixture.now,
      historyCache: cache,
    });
    try {
      const started = Date.now();
      const result = await connection.callTool("get_training_load", { days: 180 });
      expect(result.isError).toBe(false);
      expect(result.text.length).toBeLessThanOrEqual(MAX_TOOL_TEXT_CHARS);
      expect(Date.now() - started).toBeLessThan(20_000);
      const structured = result.structured as TrainingLoadOutput;
      expect(structured.days).toHaveLength(180);
      expect(structured.status).toBe("available");
      // History pages plus the offset lookup and at most one probe.
      expect(client.calls.length).toBeLessThanOrEqual(DEFAULT_PAGE_BUDGET + 2);
      assertNeutralText([structured.notes, structured.warnings, structured.acute_chronic.reading]);

      const before = client.calls.length;
      const repeat = await connection.callTool("get_training_load", { days: 180 });
      expect(repeat.isError).toBe(false);
      expect(client.calls.length - before).toBeLessThanOrEqual(2);
      expect((repeat.structured as TrainingLoadOutput).days).toEqual(structured.days);
    } finally {
      await connection.close();
    }
  });

  it("validates against the advertised contract with every load metric", async () => {
    const fixture = matureUser({ days: 60 });
    const client = createWhoopFixtureClient({ ...fixture, now: fixture.now });
    const connection = await connectServer(client, {
      privacyMode: "standard",
      now: () => fixture.now,
    });
    try {
      const tool = connection.tools.find((entry) => entry.name === "get_training_load");
      expect(tool?.title).toBe("Training load");
      expect(tool?.annotations?.readOnlyHint).toBe(true);
      expect(tool?.description?.length ?? 0).toBeLessThanOrEqual(1000);
      for (const load_metric of ["trimp", "day_strain", "workout_minutes", "workout_kj"]) {
        const result = await connection.callTool("get_training_load", { load_metric, days: 14 });
        expect(result.isError).toBe(false);
        const structured = result.structured as TrainingLoadOutput;
        expect(structured.load_metric).toBe(load_metric);
        expect(JSON.parse(result.text)).toEqual(structured);
        expect(result.text).not.toContain("\n");
        assertNeutralText(structured.notes);
      }
      const invalid = await connection.callTool("get_training_load", { days: 7 });
      expect(invalid.isError).toBe(true);
    } finally {
      await connection.close();
    }
  });
});
