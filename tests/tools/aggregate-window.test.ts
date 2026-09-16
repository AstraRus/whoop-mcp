import { describe, it, expect } from "vitest";
import {
  AGGREGATE_RELEASE_LAG_DAYS,
  AGGREGATE_WEEK_MIN_SAMPLES,
  aggregateEvaluatedAt,
  aggregateSourceCounts,
  blockOf,
  currentWeekMonday,
  differenceSafe,
  EPOCH_MONDAY,
  gateWeeks,
  lastReleasedBlock,
  lastReleasedWeeks,
  releasedWeeksEnd,
  roundStep,
  snapWeeks,
  weekFinal,
} from "../../src/tools/aggregate-window.js";
import { AGGREGATE_MIN_SAMPLES } from "../../src/tools/output-contracts.js";
import { localDay } from "../../src/tools/analytics-utils.js";
import { addDays, assignWorkouts, mondayOf, placeDays } from "../../src/tools/day-model.js";
import { sourceQuality } from "../../src/tools/analytics-utils.js";
import { matureUser, type WhoopUserFixture } from "../helpers/whoop-users.js";

const HOUR_MS = 3_600_000;

/** A local wall-clock instant in `offset` */
function local(dateTime: string, offset: string): Date {
  return new Date(`${dateTime}${offset}`);
}

function placementOf(fixture: WhoopUserFixture): ReturnType<typeof placeDays> {
  return placeDays({
    cycles: fixture.cycles,
    sleeps: fixture.sleeps,
    recoveries: fixture.recoveries,
    sleepsAvailable: true,
    today: localDay(fixture.now.toISOString(), fixture.offset),
    utcOffset: fixture.offset,
  });
}

describe("constants", () => {
  it("shares the aggregate sample minimum with the output contracts", () => {
    expect(AGGREGATE_WEEK_MIN_SAMPLES).toBe(AGGREGATE_MIN_SAMPLES);
    expect(AGGREGATE_RELEASE_LAG_DAYS).toBe(2);
    expect(mondayOf(EPOCH_MONDAY)).toBe(EPOCH_MONDAY);
  });
});

describe("local weeks", () => {
  it("finds the local ISO week of now in the user's offset", () => {
    // The same instant is Sunday 23:30 at -05:00 and Monday 06:30 at +02:00
    const instant = new Date("2026-09-21T04:30:00.000Z");
    expect(currentWeekMonday(instant, "-05:00")).toBe("2026-09-14");
    expect(currentWeekMonday(instant, "+02:00")).toBe("2026-09-21");
    expect(currentWeekMonday(local("2026-09-21T00:00:00.000", "+02:00"), "+02:00")).toBe(
      "2026-09-21"
    );
    expect(currentWeekMonday(local("2026-09-20T23:59:59.999", "+02:00"), "+02:00")).toBe(
      "2026-09-14"
    );
  });

  it("releases a week at Wednesday 00:00 local, two days after it ends", () => {
    for (const offset of ["+02:00", "-05:00"]) {
      const tuesday = local("2026-09-22T23:59:59.999", offset);
      const wednesday = local("2026-09-23T00:00:00.000", offset);
      expect(releasedWeeksEnd(tuesday, offset)).toBe(
        local("2026-09-13T23:59:59.999", offset).getTime()
      );
      expect(releasedWeeksEnd(wednesday, offset)).toBe(
        local("2026-09-20T23:59:59.999", offset).getTime()
      );
    }
  });

  it("is identical from Wednesday 00:00 to the next Tuesday 23:59 local", () => {
    const offset = "+02:00";
    const start = local("2026-09-23T00:00:00.000", offset).getTime();
    const end = local("2026-09-29T23:59:59.999", offset).getTime();
    const reference = {
      end: releasedWeeksEnd(new Date(start), offset),
      weeks: lastReleasedWeeks(new Date(start), offset, 4),
      block: lastReleasedBlock(new Date(start), offset, 4),
    };
    for (let ms = start; ms <= end; ms += HOUR_MS) {
      const now = new Date(ms);
      expect(releasedWeeksEnd(now, offset)).toBe(reference.end);
      expect(lastReleasedWeeks(now, offset, 4)).toEqual(reference.weeks);
      expect(lastReleasedBlock(now, offset, 4)).toEqual(reference.block);
    }
    expect(releasedWeeksEnd(new Date(end), offset)).toBe(reference.end);
    expect(releasedWeeksEnd(new Date(end + 1), offset)).not.toBe(reference.end);
  });

  it("lists released weeks oldest first, ending at releasedWeeksEnd", () => {
    const now = local("2026-09-23T09:00:00.000", "+02:00");
    const weeks = lastReleasedWeeks(now, "+02:00", 3);
    expect(weeks.map((week) => [week.monday, week.sunday])).toEqual([
      ["2026-08-31", "2026-09-06"],
      ["2026-09-07", "2026-09-13"],
      ["2026-09-14", "2026-09-20"],
    ]);
    expect(weeks.at(-1)!.endMs).toBe(releasedWeeksEnd(now, "+02:00") + 1);
    expect(weeks[0]!.startMs).toBe(local("2026-08-31T00:00:00.000", "+02:00").getTime());
    expect(() => lastReleasedWeeks(now, "+02:00", 0)).toThrow(RangeError);
  });

  it("uses the given offset for bounds across a DST change while days stay labels", () => {
    // After a +02:00 → +01:00 change, local midnight moves one hour later in UTC.
    const now = local("2026-10-28T12:00:00.000", "+01:00");
    const summer = lastReleasedWeeks(now, "+02:00", 1)[0]!;
    const winter = lastReleasedWeeks(now, "+01:00", 1)[0]!;
    expect(winter.monday).toBe("2026-10-19");
    expect(summer.monday).toBe(winter.monday);
    expect(winter.startMs - summer.startMs).toBe(HOUR_MS);
    expect(winter.endMs - winter.startMs).toBe(7 * 24 * HOUR_MS);
  });
});

describe("snapWeeks", () => {
  it("picks the smallest allowed count covering the days, else the largest", () => {
    const allowed = [1, 2, 4, 8, 13];
    expect(snapWeeks(7, allowed)).toBe(1);
    expect(snapWeeks(8, allowed)).toBe(2);
    expect(snapWeeks(30, allowed)).toBe(8);
    expect(snapWeeks(60, allowed)).toBe(13);
    expect(snapWeeks(365, allowed)).toBe(13);
    expect(snapWeeks(14, [13, 2, 4])).toBe(2);
    expect(() => snapWeeks(0, allowed)).toThrow(RangeError);
    expect(() => snapWeeks(7, [])).toThrow(RangeError);
  });
});

describe("blocks", () => {
  it("aligns blocks to the epoch Monday", () => {
    expect(blockOf(EPOCH_MONDAY, 4)).toMatchObject({
      index: 0,
      start: "1970-01-05",
      end: "1970-02-01",
    });
    const block = blockOf("2026-09-14", 4);
    expect(block.mondays).toHaveLength(4);
    expect(block.mondays).toContain("2026-09-14");
    expect(block.end).toBe(addDays(block.start, 27));
    expect(
      (Date.parse(`${block.start}T00:00:00Z`) - Date.parse(`${EPOCH_MONDAY}T00:00:00Z`)) /
        (28 * 86_400_000)
    ).toBe(block.index);
    for (const monday of block.mondays) expect(blockOf(monday, 4)).toEqual(block);
    expect(blockOf("2026-09-14", 13).mondays).toHaveLength(13);
    expect(() => blockOf("2026-09-15", 4)).toThrow(RangeError);
  });

  it("returns the latest fully released block and earlier ones by offset", () => {
    const now = local("2026-09-23T09:00:00.000", "+02:00");
    const latestReleased = lastReleasedWeeks(now, "+02:00", 1)[0]!.monday;
    const latest = lastReleasedBlock(now, "+02:00", 4);
    expect(latest.end <= addDays(latestReleased, 6)).toBe(true);
    const containing = blockOf(latestReleased, 4);
    expect(latest.index).toBe(
      containing.mondays.at(-1) === latestReleased ? containing.index : containing.index - 1
    );
    expect(lastReleasedBlock(now, "+02:00", 4, 3).index).toBe(latest.index - 2);
    // On the Wednesday a block's last week is released, that block becomes the latest.
    const blockEndWednesday = local(`${addDays(latest.end, 3 + 28)}T00:00:00.000`, "+02:00");
    expect(lastReleasedBlock(blockEndWednesday, "+02:00", 4).index).toBe(latest.index + 1);
    expect(() => lastReleasedBlock(now, "+02:00", 4, 0)).toThrow(RangeError);
  });
});

describe("weekFinal", () => {
  const fixture = matureUser({ days: 60, seed: 21 });
  const placement = placementOf(fixture);
  const today = localDay(fixture.now.toISOString(), fixture.offset);

  it("withholds the week with the open cycle and the pending last night", () => {
    expect(weekFinal(mondayOf(today), placement)).toBe(false);
  });

  it("accepts a settled past week", () => {
    expect(weekFinal(addDays(mondayOf(today), -21), placement)).toBe(true);
  });

  it("withholds a week whose Sunday cycle is still open (Monday 00:10 before the sleep syncs)", () => {
    const sundayNight = matureUser({
      days: 60,
      seed: 21,
      now: local("2026-09-21T00:10:00.000", "+02:00"),
    });
    const sunday = "2026-09-20";
    const sundayPlacement = placementOf(sundayNight);
    const sundayCycle = sundayPlacement.cycleByDay.get(sunday);
    expect(sundayCycle).toBeDefined();
    expect(sundayCycle!.end ?? null).toBeNull();
    // The week before is settled
    expect(weekFinal(addDays(mondayOf(sunday), -7), sundayPlacement)).toBe(true);
    expect(weekFinal(mondayOf(sunday), sundayPlacement)).toBe(false);
  });

  it("withholds a week with a pending record placed in it", () => {
    const monday = addDays(mondayOf(today), -14);
    const wednesday = addDays(monday, 2);
    const cycle = placement.cycleByDay.get(wednesday)!;
    const pendingRecoveries = fixture.recoveries.map((recovery) =>
      recovery.cycle_id === cycle.id
        ? { ...recovery, score_state: "PENDING_SCORE" as const }
        : recovery
    );
    const pendingPlacement = placeDays({
      cycles: fixture.cycles,
      sleeps: fixture.sleeps,
      recoveries: pendingRecoveries,
      sleepsAvailable: true,
      today,
      utcOffset: fixture.offset,
    });
    expect(weekFinal(monday, placement)).toBe(true);
    expect(weekFinal(monday, pendingPlacement)).toBe(false);
    expect(weekFinal(addDays(monday, -7), pendingPlacement)).toBe(true);

    const workouts = assignWorkouts(fixture.workouts, placement, fixture.cycles);
    const records = fixture.workouts.map((workout) => ({
      day: workouts.get(workout.id)!.day,
      score_state: workout.score_state,
    }));
    expect(weekFinal(monday, placement, records)).toBe(true);
    expect(
      weekFinal(monday, placement, [
        ...records,
        { day: addDays(monday, 6), score_state: "PENDING_SCORE" },
      ])
    ).toBe(false);
  });

  it("checks displaced cycles of a split night", () => {
    const split = matureUser({ days: 60, seed: 21, splitNightDays: [30] });
    const splitPlacement = placementOf(split);
    const [{ day, other }] = splitPlacement.displaced as [
      (typeof splitPlacement.displaced)[number],
    ];
    expect(weekFinal(mondayOf(day), splitPlacement)).toBe(true);
    const pendingCycles = split.cycles.map((cycle) =>
      cycle.id === other.id
        ? { ...cycle, score_state: "PENDING_SCORE" as const, score: null }
        : cycle
    );
    const pendingPlacement = placeDays({
      cycles: pendingCycles,
      sleeps: split.sleeps,
      recoveries: split.recoveries,
      sleepsAvailable: true,
      today: localDay(split.now.toISOString(), split.offset),
      utcOffset: split.offset,
    });
    expect(weekFinal(mondayOf(day), pendingPlacement)).toBe(false);
  });
});

describe("gating and rounding", () => {
  it("splits weeks by the sample minimum, keeping order", () => {
    const weeks = [
      { monday: "2026-08-31", samples: 7 },
      { monday: "2026-09-07", samples: 2 },
      { monday: "2026-09-14", samples: 3 },
      { monday: "2026-09-21", samples: 0 },
    ];
    expect(gateWeeks(weeks)).toEqual({
      released: [weeks[0], weeks[2]],
      withheld: [weeks[1], weeks[3]],
    });
    expect(gateWeeks(weeks, 7).released).toEqual([weeks[0]]);
  });

  it("treats a difference as safe only for 0 or at least 3 withheld samples", () => {
    expect(differenceSafe(0)).toBe(true);
    expect(differenceSafe(1)).toBe(false);
    expect(differenceSafe(2)).toBe(false);
    expect(differenceSafe(3)).toBe(true);
    expect(differenceSafe(40)).toBe(true);
  });

  it("rounds to a step without floating-point residue", () => {
    expect(roundStep(123, 10)).toBe(120);
    expect(roundStep(125, 10)).toBe(130);
    expect(roundStep(-15, 10)).toBe(-20);
    expect(roundStep(1234, 100)).toBe(1200);
    expect(roundStep(1.1234, 0.05)).toBe(1.1);
    expect(roundStep(1.125, 0.05)).toBe(1.15);
    expect(roundStep(1.33, 0.05)).toBe(1.35);
    expect(roundStep(12.34, 0.1)).toBe(12.3);
    expect(roundStep(0.0000123, 1e-6)).toBe(0.000012);
    expect(() => roundStep(1, 0)).toThrow(RangeError);
    expect(() => roundStep(NaN, 1)).toThrow(RangeError);
  });
});

describe("aggregateSourceCounts", () => {
  const released = ["2026-09-07", "2026-09-14"];

  it("counts only records placed in released weeks", () => {
    const counts = aggregateSourceCounts(
      { ...sourceQuality(9), status: "available" },
      [
        { day: "2026-09-06", exclusion: null },
        { day: "2026-09-07", exclusion: null },
        { day: "2026-09-13", exclusion: "calibrating" },
        { day: "2026-09-20", exclusion: null },
        { day: "2026-09-20", exclusion: "pending" },
        { day: "2026-09-21", exclusion: "pending" },
        { day: null, exclusion: "missing_join" },
      ],
      released
    );
    expect(counts).toEqual({
      status: "available",
      records_fetched: 4,
      records_used: 2,
      exclusions: { calibrating: 1, pending: 1 },
      truncated: false,
    });
  });

  it("does not change when records are added after the released weeks", () => {
    const base = [
      { day: "2026-09-08", exclusion: null },
      { day: "2026-09-15", exclusion: "unscored" },
    ];
    const later = [
      ...base,
      { day: "2026-09-22", exclusion: null },
      { day: "2026-09-23", exclusion: "pending" },
    ];
    const quality = sourceQuality(0);
    expect(aggregateSourceCounts(quality, later, released)).toEqual(
      aggregateSourceCounts(quality, base, released)
    );
  });

  it("recomputes the status from the counted records", () => {
    const quality = { ...sourceQuality(3, true), status: "available" as const };
    expect(
      aggregateSourceCounts(quality, [{ day: "2026-09-21", exclusion: null }], released)
    ).toMatchObject({ status: "missing", records_fetched: 0, truncated: true });
    expect(
      aggregateSourceCounts(quality, [{ day: "2026-09-09", exclusion: "pending" }], released).status
    ).toBe("pending");
    expect(
      aggregateSourceCounts(quality, [{ day: "2026-09-09", exclusion: "calibrating" }], released)
        .status
    ).toBe("calibrating");
    expect(
      aggregateSourceCounts(
        { ...quality, status: "fetch_failed" },
        [{ day: "2026-09-09", exclusion: null }],
        released
      ).status
    ).toBe("fetch_failed");
  });

  it("projects evaluated_at to the local date", () => {
    const now = new Date("2026-09-21T03:30:00.000Z");
    expect(aggregateEvaluatedAt(now, "+02:00")).toBe("2026-09-21");
    expect(aggregateEvaluatedAt(now, "-05:00")).toBe("2026-09-20");
  });
});
