/**
 * Tests for day-model.ts — the shared placement of WHOOP records on local days.
 *
 * Covers: equivalence with get_calendar rows, workouts before sleep onset and
 * after local midnight, the extended fetch window on a 30-day chunk boundary,
 * the partial first day, a displaced cycle on a split night, strap-off gaps,
 * an offset change, deterministic tie-breaks under shuffled input, and the
 * night joins (prior cycle, recovery, naps, workouts).
 */

import { describe, it, expect } from "vitest";
import type { Cycle, Recovery, Sleep, Workout } from "../../src/api/types.js";
import type { WhoopClient } from "../../src/api/client.js";
import { asleepHours, DAY_MS, localDay, localMidnightMs } from "../../src/tools/analytics-utils.js";
import { getCalendar } from "../../src/tools/get-calendar.js";
import {
  addDays,
  assignWorkouts,
  buildNights,
  cycleStrain,
  daysBetween,
  fetchRangeForDays,
  isBetterSleep,
  isOpenCycle,
  mondayOf,
  nextCycle,
  placeDays,
  previousCycle,
  resolveDayWindow,
  type DayPlacement,
} from "../../src/tools/day-model.js";
import { createWhoopFixtureClient } from "../helpers/whoop-fixture-client.js";
import {
  createLcg,
  hashSeed,
  LIVE_SHAPED_IDS,
  liveShapedUser,
  matureUser,
  type WhoopUserFixture,
} from "../helpers/whoop-users.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** 30-day history chunks on the UTC epoch grid (src/api/history.ts HISTORY_CHUNK_DAYS) */
const CHUNK_MS = 30 * DAY_MS;

function placementOf(fixture: WhoopUserFixture, sleepsAvailable = true): DayPlacement {
  return placeDays({
    cycles: fixture.cycles,
    sleeps: fixture.sleeps,
    recoveries: fixture.recoveries,
    sleepsAvailable,
    today: localDay(fixture.now.toISOString(), fixture.offset),
    utcOffset: fixture.offset,
  });
}

/** Every record of a collection overlapping [startMs, endMs), read page by page */
async function fetchRange<T>(
  client: WhoopClient,
  endpoint: string,
  startMs: number,
  endMs: number
): Promise<T[]> {
  const records: T[] = [];
  let token: string | null | undefined;
  do {
    const query = new URLSearchParams({
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
      limit: "25",
    });
    if (token) query.set("nextToken", token);
    const page = await client.get<{ records: T[]; next_token?: string | null }>(
      `${endpoint}?${query.toString()}`
    );
    records.push(...page.records);
    token = page.next_token;
  } while (token);
  return records;
}

function shuffled<T>(values: readonly T[], seed: number): T[] {
  const random = createLcg(hashSeed("shuffle", seed));
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

/** An order-independent view of a placement */
function describePlacement(placement: DayPlacement): unknown {
  const sortedEntries = <K, V>(map: Map<K, V>): [K, V][] =>
    [...map.entries()].sort(([left], [right]) => String(left).localeCompare(String(right)));
  return {
    byDay: sortedEntries(placement.byDay).map(([day, entry]) => [
      day,
      entry.cycle?.id ?? null,
      entry.sleep?.id ?? null,
      entry.recovery ? `${entry.recovery.cycle_id}:${entry.recovery.sleep_id}` : null,
    ]),
    cycleByDay: sortedEntries(placement.cycleByDay).map(([day, cycle]) => [day, cycle.id]),
    dayOfCycle: sortedEntries(placement.dayOfCycle),
    displaced: placement.displaced
      .map(({ day, shown, other }) => [day, shown.id, other.id])
      .sort((left, right) => String(left).localeCompare(String(right))),
    partialDays: [...placement.partialDays].sort(),
    openCycleDay: placement.openCycleDay ?? null,
    newestCycle: placement.newestCycle?.id ?? null,
    mainSleepByCycle: sortedEntries(placement.mainSleepByCycle).map(([id, sleep]) => [
      id,
      sleep.id,
    ]),
    recoveryByCycle: sortedEntries(placement.recoveryByCycle).map(([id, recovery]) => [
      id,
      recovery.sleep_id,
    ]),
  };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

const live = liveShapedUser();
const { cycles: LIVE_CYCLES, sleeps: LIVE_SLEEPS, workouts: LIVE_WORKOUTS } = LIVE_SHAPED_IDS;

// ---------------------------------------------------------------------------
// Helpers exported with the model
// ---------------------------------------------------------------------------

describe("day helpers", () => {
  it("shifts days, counts days and finds ISO Mondays", () => {
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(daysBetween("2026-09-01", "2026-09-16")).toBe(15);
    expect(mondayOf("2026-09-16")).toBe("2026-09-14");
    expect(mondayOf("2026-09-14")).toBe("2026-09-14");
    expect(mondayOf("2026-09-20")).toBe("2026-09-14");
    expect(mondayOf("2027-01-01")).toBe("2026-12-28");
  });

  it("covers two extra local days on each side, clamped to now", () => {
    const nowMs = Date.parse("2026-09-16T21:30:00.000Z");
    expect(fetchRangeForDays("2026-09-10", "2026-09-12", "+02:00", nowMs)).toEqual({
      startMs: Date.parse("2026-09-08T00:00:00.000+02:00"),
      endMs: Date.parse("2026-09-14T00:00:00.000+02:00"),
    });
    expect(fetchRangeForDays("2026-09-10", "2026-09-16", "-05:00", nowMs)).toEqual({
      startMs: Date.parse("2026-09-08T00:00:00.000-05:00"),
      endMs: nowMs,
    });
  });

  it("resolves day windows with get_calendar semantics and a configurable noun", () => {
    const now = new Date("2026-09-16T12:00:00.000Z");
    expect(resolveDayWindow({}, now, "+02:00", { defaultDays: 7, maxDays: 90 })).toEqual({
      firstDay: "2026-09-10",
      lastDay: "2026-09-16",
      ascending: false,
      fromDateTime: false,
      notes: [],
    });
    const capped = resolveDayWindow({ start: "this month", days: 3 }, now, "+02:00", {
      defaultDays: 14,
      maxDays: 365,
      noun: "log",
    });
    expect(capped).toMatchObject({ firstDay: "2026-09-01", lastDay: "2026-09-03" });
    expect(capped.notes).toEqual([
      '"this month" covers 2026-09-01 to 2026-09-16; with days 3 the log shows only 2026-09-01 to 2026-09-03. Leave out days to show the whole range.',
    ]);
    const long = resolveDayWindow({ start: "last month" }, now, "+02:00", {
      defaultDays: 7,
      maxDays: 10,
    });
    expect(long).toMatchObject({ firstDay: "2026-08-22", lastDay: "2026-08-31" });
    expect(long.notes[0]).toContain(
      "more than the 10-day maximum; the grid shows its last 10 days"
    );
  });
});

// ---------------------------------------------------------------------------
// Calendar equivalence
// ---------------------------------------------------------------------------

describe("placeDays matches get_calendar", () => {
  it.each([
    ["14-day +02:00 user", { days: 14, seed: 1 }, 14],
    ["14-day -05:00 user", { days: 14, seed: 2, offset: "-05:00" }, 14],
    ["30-day user with a gap, a split night and an offset change", { days: 30, seed: 3 }, 21],
  ])("%s", async (_label, options, gridDays) => {
    const fixture = matureUser(options);
    const client = createWhoopFixtureClient({ ...fixture, now: fixture.now });
    const grid = await getCalendar(client, { days: gridDays }, fixture.now);
    expect(grid.days).toHaveLength(gridDays);

    // The same records get_calendar fetched: one local day before the grid to one after it.
    const offset = grid.period.utc_offset;
    const startMs = localMidnightMs(addDays(grid.period.start, -1), offset);
    const endMs = localMidnightMs(addDays(grid.period.end, 1), offset);
    const [cycles, sleeps, recoveries] = await Promise.all([
      fetchRange<Cycle>(client, "/v2/cycle", startMs, endMs),
      fetchRange<Sleep>(client, "/v2/activity/sleep", startMs, endMs),
      fetchRange<Recovery>(client, "/v2/recovery", startMs, endMs),
    ]);
    const placement = placeDays({
      cycles,
      sleeps,
      recoveries,
      sleepsAvailable: true,
      today: localDay(fixture.now.toISOString(), offset),
      utcOffset: offset,
    });

    for (const row of grid.days) {
      const entry = placement.byDay.get(row.date) ?? {};
      const recovery =
        entry.recovery?.score_state === "SCORED" && entry.recovery.score
          ? entry.recovery.score.recovery_score
          : null;
      const sleep =
        entry.sleep?.score_state === "SCORED" && entry.sleep.score
          ? round1(asleepHours(entry.sleep))
          : null;
      expect({
        date: row.date,
        recovery_score: recovery,
        sleep_hours: sleep,
        day_strain: entry.cycle ? cycleStrain(entry.cycle) : null,
        day_strain_in_progress: entry.cycle !== undefined && isOpenCycle(entry.cycle),
        day_strain_partial: entry.cycle !== undefined && placement.partialDays.has(row.date),
      }).toEqual({
        date: row.date,
        recovery_score: row.recovery_score,
        sleep_hours: row.sleep_hours,
        day_strain: row.day_strain,
        day_strain_in_progress: row.day_strain_in_progress,
        day_strain_partial: row.day_strain_partial,
      });
    }
    // Every displaced cycle inside the grid produced exactly one calendar warning.
    const displacedInGrid = placement.displaced.filter(
      ({ day }) => day >= grid.period.start && day <= grid.period.end
    );
    expect(grid.warnings.filter((warning) => warning.startsWith("Two WHOOP cycles"))).toHaveLength(
      displacedInGrid.length
    );
  });
});

// ---------------------------------------------------------------------------
// Placement scenarios
// ---------------------------------------------------------------------------

describe("placeDays scenarios", () => {
  it("marks the partial first strap day and the open cycle's day", () => {
    const placement = placementOf(live);
    expect([...placement.partialDays]).toEqual(["2026-09-14"]);
    expect(placement.cycleByDay.get("2026-09-14")?.id).toBe(LIVE_CYCLES.firstDay);
    // The 00:39 onset cycle covers 09-15; the open cycle started 23:13 on 09-15 covers 09-16.
    expect(placement.dayOfCycle.get(LIVE_CYCLES.afterMidnightOnset)).toBe("2026-09-15");
    expect(placement.dayOfCycle.get(LIVE_CYCLES.open)).toBe("2026-09-16");
    expect(placement.newestCycle?.id).toBe(LIVE_CYCLES.open);
    // Today is 09-16, so the open cycle is not "before today"
    expect(placement.openCycleDay).toBeUndefined();

    const afterMidnight = placementOf(liveShapedUser({ now: "2026-09-17T00:30:00+02:00" }));
    expect(afterMidnight.openCycleDay).toBe("2026-09-16");
  });

  it("does not detect partial days when the sleep stream failed", () => {
    expect(placementOf({ ...live, sleeps: [] }, false).partialDays.size).toBe(0);
  });

  it("lists the shorter cycle of a split night as displaced on its main day", () => {
    const fixture = matureUser({ days: 30, seed: 3 });
    const placement = placementOf(fixture);
    expect(placement.displaced).toHaveLength(1);
    const [{ day, shown, other }] = placement.displaced as [DayPlacement["displaced"][number]];
    const sleepOf = (cycle: Cycle): Sleep => placement.mainSleepByCycle.get(cycle.id)!;
    expect(localDay(sleepOf(shown).end, shown.timezone_offset)).toBe(day);
    expect(localDay(sleepOf(other).end, other.timezone_offset)).toBe(day);
    expect(isBetterSleep(sleepOf(shown), sleepOf(other))).toBe(true);
    expect(placement.cycleByDay.get(day)?.id).toBe(shown.id);
    expect(placement.dayOfCycle.get(other.id)).toBe(day);
    // The two cycles are consecutive: the short one ends where the shown one starts.
    expect(nextCycle(other, fixture.cycles)?.id).toBe(shown.id);
  });

  it("keeps one cycle per worn day across a +02:00 → +01:00 offset change", () => {
    const fixture = matureUser({ days: 30, seed: 4, gapDays: [], splitNightDays: [] });
    const offsets = new Set(fixture.cycles.map((cycle) => cycle.timezone_offset));
    expect(offsets).toEqual(new Set(["+02:00", "+01:00"]));
    const placement = placementOf(fixture);
    const today = localDay(fixture.now.toISOString(), fixture.offset);
    const days = [...placement.cycleByDay.keys()].sort();
    expect(days).toHaveLength(30);
    expect(days[29]).toBe(today);
    expect(daysBetween(days[0]!, days[29]!)).toBe(29);
    expect(placement.displaced).toEqual([]);

    const assigned = assignWorkouts(fixture.workouts, placement, fixture.cycles);
    for (const workout of fixture.workouts) {
      const placed = assigned.get(workout.id)!;
      const startDay = localDay(workout.start, workout.timezone_offset);
      expect(placed.fallback).toBe(false);
      expect(placed.day).toBe(
        placed.after_midnight_in_previous_cycle ? addDays(startDay, -1) : startDay
      );
    }
  });

  it("returns no next or previous cycle across a strap-off gap", () => {
    const fixture = matureUser({ days: 30, seed: 5, gapDays: [13, 14] });
    const ordered = [...fixture.cycles].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    const beforeGap = ordered.find(
      (cycle, index) =>
        cycle.end &&
        ordered[index + 1] &&
        Date.parse(ordered[index + 1]!.start) > Date.parse(cycle.end)
    )!;
    const afterGap = ordered[ordered.indexOf(beforeGap) + 1]!;
    expect(Date.parse(afterGap.start) - Date.parse(beforeGap.end!)).toBeGreaterThan(DAY_MS);
    expect(nextCycle(beforeGap, fixture.cycles)).toBeUndefined();
    expect(previousCycle(afterGap, fixture.cycles)).toBeUndefined();
    // Ordinary neighbours are found by boundary, not by index
    const middle = ordered[5]!;
    expect(nextCycle(middle, shuffled(fixture.cycles, 1))?.id).toBe(ordered[6]!.id);
    expect(previousCycle(middle, shuffled(fixture.cycles, 2))?.id).toBe(ordered[4]!.id);
    expect(nextCycle(ordered[ordered.length - 1]!, fixture.cycles)).toBeUndefined();

    const { nights } = buildNights({
      sleeps: fixture.sleeps,
      cycles: fixture.cycles,
      recoveries: fixture.recoveries,
      workouts: fixture.workouts,
      workoutsCompleteSince: fixture.cycles.at(-1)!.start,
      placement: placementOf(fixture),
      nowMs: fixture.now.getTime(),
    });
    const afterGapNight = nights.find((night) => night.cycle_after?.id === afterGap.id)!;
    expect(afterGapNight.prior_cycle).toBeNull();
    expect(afterGapNight.prior_flags).toBeNull();
    expect(afterGapNight.workouts_in_prior_cycle).toBeNull();
    expect(afterGapNight.naps_in_prior_cycle).toBeNull();
  });

  it("matches consecutive cycles within 60 seconds and prefers exact boundaries", () => {
    const base = live.cycles.find((cycle) => cycle.id === LIVE_CYCLES.afterMidnightOnset)!;
    const endMs = Date.parse(base.end!);
    const cycleAt = (id: number, startOffsetMs: number, end: string | null = null): Cycle => ({
      ...base,
      id,
      start: new Date(endMs + startOffsetMs).toISOString(),
      end,
    });
    const near = cycleAt(2, 30_000);
    const far = cycleAt(3, 61_000);
    const exact = cycleAt(4, 0);
    expect(nextCycle(base, [base, far, near])?.id).toBe(2);
    expect(nextCycle(base, [base, far])).toBeUndefined();
    expect(nextCycle(base, [near, exact, base])?.id).toBe(4);
    expect(nextCycle({ ...base, end: null }, [base, exact])).toBeUndefined();

    const later: Cycle = { ...base, id: 9, start: new Date(endMs + 45_000).toISOString() };
    expect(previousCycle(later, [later, base])?.id).toBe(base.id);
    expect(previousCycle({ ...later, start: new Date(endMs + 90_000).toISOString() }, [base])).toBe(
      undefined
    );
    expect(previousCycle(later, [later, { ...base, end: null }])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Workouts
// ---------------------------------------------------------------------------

describe("assignWorkouts", () => {
  it("places a 23:17 workout before the 00:39 sleep onset on that day", () => {
    const placement = placementOf(live);
    const assigned = assignWorkouts(live.workouts, placement, live.cycles);
    expect(assigned.get(LIVE_WORKOUTS.lateWalk)).toMatchObject({
      day: "2026-09-14",
      fallback: false,
      spans_cycle_boundary: false,
      after_midnight_in_previous_cycle: false,
    });
    expect(assigned.get(LIVE_WORKOUTS.lateWalk)!.cycle?.id).toBe(LIVE_CYCLES.firstDay);
    const days = [...assigned.values()].map((placed) => placed.day);
    expect(days.filter((day) => day === "2026-09-15")).toHaveLength(4);
    expect(days.filter((day) => day === "2026-09-16")).toHaveLength(3);
  });

  it("places a 00:40 workout before the next sleep on the open cycle's day", () => {
    const now = "2026-09-17T01:00:00+02:00";
    const fixture = liveShapedUser({ now });
    const template = fixture.workouts.find((w) => w.id === LIVE_WORKOUTS.manualWalk)!;
    const afterMidnight: Workout = {
      ...template,
      id: "after-midnight-walk",
      created_at: "2026-09-16T22:56:00.000Z",
      updated_at: "2026-09-16T22:56:00.000Z",
      start: "2026-09-16T22:40:00.000Z",
      end: "2026-09-16T22:55:00.000Z",
    };
    const placement = placementOf(fixture);
    expect(placement.openCycleDay).toBe("2026-09-16");
    const placed = assignWorkouts([afterMidnight], placement, fixture.cycles).get(
      afterMidnight.id
    )!;
    expect(placed).toMatchObject({
      day: "2026-09-16",
      fallback: false,
      spans_cycle_boundary: false,
      after_midnight_in_previous_cycle: true,
    });
    expect(placed.cycle?.id).toBe(LIVE_CYCLES.open);
  });

  it("fetches and places a 00:05 workout of the last day when its start is a chunk boundary", async () => {
    // A UTC user whose local midnight 2026-09-04 is a 30-day epoch chunk boundary.
    const boundary = Math.ceil(Date.parse("2026-09-01T00:00:00.000Z") / CHUNK_MS) * CHUNK_MS;
    const boundaryDay = new Date(boundary).toISOString().slice(0, 10);
    const now = new Date(boundary + 12 * 3_600_000);
    const fixture = matureUser({
      days: 20,
      seed: 7,
      offset: "Z",
      now,
      offsetChange: null,
      gapDays: [],
      splitNightDays: [],
      lateWorkoutEvery: 20,
    });
    const lastDay = addDays(boundaryDay, -1);
    const late = fixture.workouts.find(
      (workout) =>
        localDay(workout.start, "Z") === boundaryDay && workout.start < `${boundaryDay}T01`
    )!;
    expect(late).toBeDefined();

    const client = createWhoopFixtureClient({ ...fixture, now });
    const range = fetchRangeForDays(addDays(lastDay, -6), lastDay, "Z", now.getTime());
    const oldEnd = localMidnightMs(addDays(lastDay, 1), "Z");
    expect(oldEnd).toBe(boundary);
    expect(Date.parse(late.start)).toBeGreaterThanOrEqual(oldEnd);
    expect(Date.parse(late.start)).toBeLessThan(range.endMs);

    const narrow = await fetchRange<Workout>(client, "/v2/activity/workout", range.startMs, oldEnd);
    expect(narrow.map((workout) => workout.id)).not.toContain(late.id);
    const [cycles, sleeps, recoveries, workouts] = await Promise.all([
      fetchRange<Cycle>(client, "/v2/cycle", range.startMs, range.endMs),
      fetchRange<Sleep>(client, "/v2/activity/sleep", range.startMs, range.endMs),
      fetchRange<Recovery>(client, "/v2/recovery", range.startMs, range.endMs),
      fetchRange<Workout>(client, "/v2/activity/workout", range.startMs, range.endMs),
    ]);
    expect(workouts.map((workout) => workout.id)).toContain(late.id);
    const placement = placeDays({
      cycles,
      sleeps,
      recoveries,
      sleepsAvailable: true,
      today: localDay(now.toISOString(), "Z"),
      utcOffset: "Z",
    });
    expect(assignWorkouts(workouts, placement, cycles).get(late.id)).toMatchObject({
      day: lastDay,
      fallback: false,
      after_midnight_in_previous_cycle: true,
    });
  });

  it("falls back to the local start day without a containing cycle", () => {
    const fixture = matureUser({ days: 30, seed: 5, gapDays: [13, 14] });
    const placement = placementOf(fixture);
    const gapStart = Date.parse(
      [...fixture.cycles]
        .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
        .find((cycle, index, ordered) => {
          const next = ordered[index + 1];
          return cycle.end && next && Date.parse(next.start) > Date.parse(cycle.end);
        })!.end!
    );
    const template = fixture.workouts[0]!;
    const inGap: Workout = {
      ...template,
      id: "gap-workout",
      timezone_offset: "-05:00",
      start: new Date(gapStart + 10 * 3_600_000).toISOString(),
      end: new Date(gapStart + 11 * 3_600_000).toISOString(),
    };
    expect(assignWorkouts([inGap], placement, fixture.cycles).get(inGap.id)).toEqual({
      day: localDay(inGap.start, "-05:00"),
      cycle: null,
      fallback: true,
      spans_cycle_boundary: false,
      after_midnight_in_previous_cycle: false,
    });
  });

  it("flags a workout running past its cycle's end and bounds stale open cycles", () => {
    const placement = placementOf(live);
    const first = live.cycles.find((cycle) => cycle.id === LIVE_CYCLES.firstDay)!;
    const spanning: Workout = {
      ...live.workouts[0]!,
      id: "spanning",
      start: new Date(Date.parse(first.end!) - 600_000).toISOString(),
      end: new Date(Date.parse(first.end!) + 600_000).toISOString(),
    };
    expect(assignWorkouts([spanning], placement, live.cycles).get("spanning")).toMatchObject({
      day: "2026-09-14",
      spans_cycle_boundary: true,
    });

    // An open cycle that is not the newest ends where the next cycle starts.
    const stale = live.cycles.map((cycle) =>
      cycle.id === LIVE_CYCLES.afterMidnightOnset ? { ...cycle, end: null } : cycle
    );
    const stalePlacement = placeDays({
      cycles: stale,
      sleeps: live.sleeps,
      recoveries: live.recoveries,
      sleepsAvailable: true,
      today: "2026-09-16",
      utcOffset: "+02:00",
    });
    const morning = live.workouts.find((w) => w.id === LIVE_WORKOUTS.manualWalk)!;
    expect(assignWorkouts([morning], stalePlacement, stale).get(morning.id)).toMatchObject({
      day: "2026-09-16",
    });
    expect(assignWorkouts([morning], stalePlacement, stale).get(morning.id)!.cycle?.id).toBe(
      LIVE_CYCLES.open
    );
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("deterministic tie-breaks", () => {
  it("prefers the smaller id for otherwise identical sleeps", () => {
    const sleep = live.sleeps.find((candidate) => candidate.id === LIVE_SLEEPS.first)!;
    const a: Sleep = { ...sleep, id: "a-sleep" };
    const b: Sleep = { ...sleep, id: "b-sleep" };
    expect(isBetterSleep(a, b)).toBe(true);
    expect(isBetterSleep(b, a)).toBe(false);
    for (const order of [
      [a, b],
      [b, a],
    ]) {
      const placement = placeDays({
        cycles: live.cycles,
        sleeps: order,
        recoveries: [],
        sleepsAvailable: true,
        today: "2026-09-16",
        utcOffset: "+02:00",
      });
      expect(placement.mainSleepByCycle.get(sleep.cycle_id)?.id).toBe("a-sleep");
      const { nights, excluded } = buildNights({
        sleeps: order,
        cycles: live.cycles,
        recoveries: [],
        workouts: null,
        workoutsCompleteSince: null,
        placement,
        nowMs: live.now.getTime(),
      });
      expect(nights.map((night) => night.sleep.id)).toEqual(["a-sleep"]);
      expect(excluded.duplicate_day).toBe(1);
    }
  });

  it("gives identical placement, workout days and nights for shuffled input", () => {
    const fixture = matureUser({ days: 45, seed: 11 });
    const run = (seed: number): unknown => {
      const input = {
        cycles: shuffled(fixture.cycles, seed),
        sleeps: shuffled(fixture.sleeps, seed + 1),
        recoveries: shuffled(fixture.recoveries, seed + 2),
        workouts: shuffled(fixture.workouts, seed + 3),
      };
      const placement = placeDays({
        ...input,
        sleepsAvailable: true,
        today: localDay(fixture.now.toISOString(), fixture.offset),
        utcOffset: fixture.offset,
      });
      const assigned = assignWorkouts(input.workouts, placement, input.cycles);
      const { nights, excluded } = buildNights({
        ...input,
        workoutsCompleteSince: "2020-01-01T00:00:00.000Z",
        placement,
        nowMs: fixture.now.getTime(),
      });
      return {
        placement: describePlacement(placement),
        workouts: [...assigned.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([id, placed]) => [id, { ...placed, cycle: placed.cycle?.id ?? null }]),
        nights: nights.map((night) => ({
          ...night,
          sleep: night.sleep.id,
          cycle_after: night.cycle_after?.id ?? null,
          prior_cycle: night.prior_cycle?.id ?? null,
          recovery: night.recovery?.sleep_id ?? null,
          naps_in_prior_cycle: night.naps_in_prior_cycle?.map((nap) => nap.id) ?? null,
          workouts_in_prior_cycle:
            night.workouts_in_prior_cycle?.map((workout) => workout.id) ?? null,
        })),
        excluded,
      };
    };
    const reference = run(0);
    for (const seed of [10, 20, 30, 40]) expect(run(seed)).toEqual(reference);
  });
});

// ---------------------------------------------------------------------------
// Nights
// ---------------------------------------------------------------------------

describe("buildNights", () => {
  it("joins the live-shaped nights to their cycles, recoveries and prior-day activity", () => {
    const { nights, excluded } = buildNights({
      sleeps: live.sleeps,
      cycles: live.cycles,
      recoveries: live.recoveries,
      workouts: live.workouts,
      workoutsCompleteSince: "2026-09-13T22:00:00.000Z",
      placement: placementOf(live),
      nowMs: live.now.getTime(),
    });
    expect(excluded).toEqual({ nap: 0, invalid_duration: 0, not_ended: 0, duplicate_day: 0 });
    expect(nights.map((night) => [night.sleep.id, night.wake_day])).toEqual([
      [LIVE_SLEEPS.second, "2026-09-16"],
      [LIVE_SLEEPS.first, "2026-09-15"],
    ]);
    const [second, first] = nights as [(typeof nights)[number], (typeof nights)[number]];

    expect(first.cycle_after?.id).toBe(LIVE_CYCLES.afterMidnightOnset);
    expect(first.prior_cycle?.id).toBe(LIVE_CYCLES.firstDay);
    expect(first.prior_day).toBe("2026-09-14");
    expect(first.prior_flags).toEqual({
      partial_first_day: true,
      open: false,
      short: false,
      long: false,
      strain_unscored: false,
    });
    expect(first.recovery?.sleep_id).toBe(LIVE_SLEEPS.first);
    expect(first.calibrating).toBe(true);
    expect(first.naps_in_prior_cycle).toEqual([]);
    expect(first.workouts_in_prior_cycle?.map((workout) => workout.id)).toEqual([
      LIVE_WORKOUTS.lateWalk,
    ]);
    expect(first.flags).toEqual({
      cycle_mismatch: false,
      stage_sum_mismatch: false,
      low_data_coverage: false,
    });

    expect(second.prior_cycle?.id).toBe(LIVE_CYCLES.afterMidnightOnset);
    expect(second.prior_day).toBe("2026-09-15");
    expect(second.prior_flags?.partial_first_day).toBe(false);
    expect(second.workouts_in_prior_cycle?.map((workout) => workout.id)).toEqual([
      LIVE_WORKOUTS.morningRun,
      LIVE_WORKOUTS.middayWalk,
      LIVE_WORKOUTS.weightliftingDay2,
      LIVE_WORKOUTS.padel,
    ]);
  });

  it("holds its join properties on a mature account", () => {
    const fixture = matureUser({ days: 60, seed: 12 });
    const placement = placementOf(fixture);
    const withWorkouts = buildNights({
      sleeps: fixture.sleeps,
      cycles: fixture.cycles,
      recoveries: fixture.recoveries,
      workouts: fixture.workouts,
      workoutsCompleteSince: fixture.cycles.at(-1)!.start,
      placement,
      nowMs: fixture.now.getTime(),
    });
    expect(withWorkouts.nights.length).toBeGreaterThan(50);
    expect(withWorkouts.excluded.nap).toBe(fixture.sleeps.filter((sleep) => sleep.nap).length);
    expect(withWorkouts.excluded.duplicate_day).toBe(1); // the split night
    const wakeDays = withWorkouts.nights.map((night) => night.wake_day);
    expect(new Set(wakeDays).size).toBe(wakeDays.length);
    for (let i = 1; i < withWorkouts.nights.length; i++) {
      expect(Date.parse(withWorkouts.nights[i - 1]!.sleep.end)).toBeGreaterThan(
        Date.parse(withWorkouts.nights[i]!.sleep.end)
      );
    }
    let napsSeen = 0;
    let lowCoverage = 0;
    for (const night of withWorkouts.nights) {
      expect(night.sleep.nap).toBe(false);
      if (night.recovery) expect(night.recovery.sleep_id).toBe(night.sleep.id);
      if (night.prior_cycle) {
        expect(Date.parse(night.prior_cycle.end!)).toBeLessThanOrEqual(
          Date.parse(night.sleep.start)
        );
        expect(night.workouts_in_prior_cycle).not.toBeNull();
        for (const workout of night.workouts_in_prior_cycle!) {
          expect(Date.parse(workout.start)).toBeGreaterThanOrEqual(
            Date.parse(night.prior_cycle.start)
          );
          expect(Date.parse(workout.start)).toBeLessThan(Date.parse(night.prior_cycle.end!));
        }
        for (const nap of night.naps_in_prior_cycle!)
          expect(nap.cycle_id).toBe(night.prior_cycle.id);
        napsSeen += night.naps_in_prior_cycle!.length;
      }
      if (night.flags.low_data_coverage) lowCoverage++;
      expect(night.flags.stage_sum_mismatch).toBe(false);
    }
    expect(napsSeen).toBeGreaterThan(0);
    expect(lowCoverage).toBeGreaterThan(0);
    // The pending last night is kept (scored state is decided by callers)
    expect(withWorkouts.nights[0]!.sleep.score_state).toBe("PENDING_SCORE");
    expect(withWorkouts.nights[0]!.recovery?.score_state).toBe("PENDING_SCORE");
    expect(withWorkouts.nights[0]!.calibrating).toBeNull();

    const withoutWorkouts = buildNights({
      sleeps: fixture.sleeps,
      cycles: fixture.cycles,
      recoveries: fixture.recoveries,
      workouts: null,
      workoutsCompleteSince: fixture.cycles.at(-1)!.start,
      placement,
      nowMs: fixture.now.getTime(),
    });
    for (const night of withoutWorkouts.nights) expect(night.workouts_in_prior_cycle).toBeNull();

    // Workout history complete only from the 20th newest night on: older priors are unknown.
    const cutoff = withWorkouts.nights[20]!.sleep.start;
    const partial = buildNights({
      sleeps: fixture.sleeps,
      cycles: fixture.cycles,
      recoveries: fixture.recoveries,
      workouts: fixture.workouts,
      workoutsCompleteSince: cutoff,
      placement,
      nowMs: fixture.now.getTime(),
    });
    for (const night of partial.nights) {
      if (!night.prior_cycle) continue;
      if (Date.parse(night.prior_cycle.start) < Date.parse(cutoff)) {
        expect(night.workouts_in_prior_cycle).toBeNull();
      } else {
        expect(night.workouts_in_prior_cycle).not.toBeNull();
      }
    }
    const unknown = buildNights({
      sleeps: fixture.sleeps,
      cycles: fixture.cycles,
      recoveries: fixture.recoveries,
      workouts: fixture.workouts,
      workoutsCompleteSince: null,
      placement,
      nowMs: fixture.now.getTime(),
    });
    for (const night of unknown.nights) expect(night.workouts_in_prior_cycle).toBeNull();
  });

  it("finds the prior cycle by fallback, flags mismatches and skips unfinished sleeps", () => {
    const sleep = live.sleeps.find((candidate) => candidate.id === LIVE_SLEEPS.second)!;
    const prior = live.cycles.find((cycle) => cycle.id === LIVE_CYCLES.afterMidnightOnset)!;
    const shiftedSleep: Sleep = {
      ...sleep,
      cycle_id: 999_999,
      start: new Date(Date.parse(sleep.start) + 3 * 60_000).toISOString(),
    };
    const cyclesWithoutAfter = live.cycles.filter((cycle) => cycle.id !== LIVE_CYCLES.open);
    const placement = placeDays({
      cycles: cyclesWithoutAfter,
      sleeps: [shiftedSleep],
      recoveries: live.recoveries,
      sleepsAvailable: true,
      today: "2026-09-16",
      utcOffset: "+02:00",
    });
    const [night] = buildNights({
      sleeps: [shiftedSleep],
      cycles: cyclesWithoutAfter,
      recoveries: live.recoveries,
      workouts: [],
      workoutsCompleteSince: "2026-09-01T00:00:00.000Z",
      placement,
      nowMs: live.now.getTime(),
    }).nights;
    expect(night!.cycle_after).toBeNull();
    expect(night!.prior_cycle?.id).toBe(prior.id);
    expect(night!.recovery).toBeNull();
    expect(night!.calibrating).toBeNull();

    const stages = sleep.score!.stage_summary;
    const mismatched = buildNights({
      sleeps: [
        {
          ...sleep,
          start: new Date(Date.parse(sleep.start) + 120_000).toISOString(),
          score: {
            ...sleep.score!,
            stage_summary: {
              ...stages,
              total_in_bed_time_milli: stages.total_in_bed_time_milli + 120_000,
            },
          },
        },
      ],
      cycles: live.cycles,
      recoveries: live.recoveries,
      workouts: null,
      workoutsCompleteSince: null,
      placement: placementOf(live),
      nowMs: live.now.getTime(),
    }).nights[0]!;
    expect(mismatched.flags.cycle_mismatch).toBe(true);
    expect(mismatched.flags.stage_sum_mismatch).toBe(true);

    const unfinished = buildNights({
      sleeps: [sleep, { ...sleep, id: "zero", end: sleep.start }],
      cycles: live.cycles,
      recoveries: live.recoveries,
      workouts: null,
      workoutsCompleteSince: null,
      placement: placementOf(live),
      nowMs: Date.parse(sleep.end) - 1,
    });
    expect(unfinished.nights).toEqual([]);
    expect(unfinished.excluded).toEqual({
      nap: 0,
      invalid_duration: 1,
      not_ended: 1,
      duplicate_day: 0,
    });
  });

  it("flags short, long, open and unscored prior cycles", () => {
    const sleep = live.sleeps.find((candidate) => candidate.id === LIVE_SLEEPS.second)!;
    const flagsFor = (prior: Cycle): unknown => {
      const cycles = live.cycles.map((cycle) => (cycle.id === prior.id ? prior : cycle));
      return buildNights({
        sleeps: [sleep],
        cycles,
        recoveries: [],
        workouts: null,
        workoutsCompleteSince: null,
        placement: placeDays({
          cycles,
          sleeps: [sleep],
          recoveries: [],
          sleepsAvailable: true,
          today: "2026-09-16",
          utcOffset: "+02:00",
        }),
        nowMs: live.now.getTime(),
      }).nights[0]!.prior_flags;
    };
    const prior = live.cycles.find((cycle) => cycle.id === LIVE_CYCLES.afterMidnightOnset)!;
    const endMs = Date.parse(prior.end!);
    expect(
      flagsFor({ ...prior, start: new Date(endMs - 11 * 3_600_000).toISOString() })
    ).toMatchObject({ short: true, long: false });
    expect(
      flagsFor({ ...prior, start: new Date(endMs - 37 * 3_600_000).toISOString() })
    ).toMatchObject({ short: false, long: true });
    expect(flagsFor({ ...prior, score_state: "PENDING_SCORE", score: null })).toMatchObject({
      strain_unscored: true,
    });
  });
});
