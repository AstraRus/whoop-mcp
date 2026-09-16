/**
 * Tests for get-calendar.ts — get_calendar grid tool.
 *
 * Fixtures follow live WHOOP shapes: records newest-first, next_token null on
 * the last page, a cycle starting at the evening sleep onset (sleep.start ===
 * cycle.start), sleep/recovery linked to that cycle by cycle_id, a +02:00
 * offset, calibrating recoveries, a sparse 3-day history and an open current
 * cycle (end: null).
 *
 * Covers: local-day grid, cycle/recovery/sleep joins (strain on the right
 * row, today's in-progress strain), no cycle lost to a day collision and no
 * cascade from a second main sleep on one day, asleep hours, calibrating flags
 * and notes, the partial first strap day, sparse averages, today's row after
 * local midnight before the next sleep, the start parameter (single days,
 * date-times and range expressions), partial stream failure, truncation,
 * invalid records and the output contract.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import type { WhoopClient } from "../../src/api/client.js";
import { WhoopApiError, WhoopNetworkError } from "../../src/api/client.js";
import { getCalendar } from "../../src/tools/get-calendar.js";
import { outputSchemas } from "../../src/tools/output-contracts.js";
import * as pagination from "../../src/api/pagination.js";
import type { Recovery, Sleep, Cycle, ScoreState } from "../../src/api/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** 2026-09-16 14:38 local time at +02:00 */
const NOW = new Date("2026-09-16T12:38:00.000Z");
const OFFSET = "+02:00";
const HOUR = 3_600_000;

/** A local wall-clock time at `offset`, as a UTC ISO string */
function at(localDateTime: string, offset: string = OFFSET): string {
  return new Date(`${localDateTime}:00.000${offset}`).toISOString();
}

function makeCycle(options: {
  id: number;
  start: string;
  end: string | null;
  strain?: number;
  offset?: string;
  state?: ScoreState;
}): Cycle {
  const state = options.state ?? "SCORED";
  return {
    id: options.id,
    user_id: 42,
    created_at: options.start,
    updated_at: options.end ?? options.start,
    start: options.start,
    end: options.end,
    timezone_offset: options.offset ?? OFFSET,
    score_state: state,
    score:
      state === "SCORED"
        ? {
            strain: options.strain ?? 10,
            kilojoule: 8000,
            average_heart_rate: 70,
            max_heart_rate: 150,
          }
        : null,
  };
}

function makeSleep(options: {
  id: string;
  cycleId: number;
  start: string;
  end: string;
  asleepHours?: number;
  nap?: boolean;
  offset?: string;
  state?: ScoreState;
  performance?: number | null;
}): Sleep {
  const state = options.state ?? "SCORED";
  const asleep = (options.asleepHours ?? 7) * HOUR;
  return {
    id: options.id,
    cycle_id: options.cycleId,
    user_id: 42,
    created_at: options.end,
    updated_at: options.end,
    start: options.start,
    end: options.end,
    timezone_offset: options.offset ?? OFFSET,
    nap: options.nap ?? false,
    score_state: state,
    v1_id: null,
    score:
      state === "SCORED"
        ? {
            stage_summary: {
              // In bed is deliberately longer than asleep (awake time in bed)
              total_in_bed_time_milli: asleep + 0.75 * HOUR,
              total_awake_time_milli: 0.75 * HOUR,
              total_no_data_time_milli: 0,
              total_light_sleep_time_milli: asleep * 0.5,
              total_slow_wave_sleep_time_milli: asleep * 0.25,
              total_rem_sleep_time_milli: asleep * 0.25,
              sleep_cycle_count: 4,
              disturbance_count: 1,
            },
            sleep_needed: {
              baseline_milli: 8 * HOUR,
              need_from_sleep_debt_milli: 0,
              need_from_recent_strain_milli: 0,
              need_from_recent_nap_milli: 0,
            },
            respiratory_rate: 15,
            sleep_performance_percentage:
              options.performance === undefined ? 80 : options.performance,
            sleep_consistency_percentage: 0,
            sleep_efficiency_percentage: 90,
          }
        : null,
  };
}

function makeRecovery(options: {
  cycleId: number;
  sleepId: string;
  createdAt: string;
  score?: number;
  calibrating?: boolean;
  state?: ScoreState;
}): Recovery {
  const state = options.state ?? "SCORED";
  return {
    cycle_id: options.cycleId,
    sleep_id: options.sleepId,
    user_id: 42,
    created_at: options.createdAt,
    updated_at: options.createdAt,
    score_state: state,
    score:
      state === "SCORED"
        ? {
            user_calibrating: options.calibrating ?? false,
            recovery_score: options.score ?? 60,
            resting_heart_rate: 60,
            hrv_rmssd_milli: 50,
            spo2_percentage: null,
            skin_temp_celsius: null,
          }
        : null,
  };
}

// Live-shaped sparse history: the strap went on for Monday 2026-09-14.
// Cycle 1 starts at local midnight with no sleep before it; cycle 2 starts at
// the first sleep onset (00:39 local on 09-15); cycle 3 starts at 23:13 local
// on 09-15 and is still open.
const CYCLE_1 = makeCycle({
  id: 1001,
  start: at("2026-09-14T00:00"),
  end: at("2026-09-15T00:39"),
  strain: 7.9,
});
const CYCLE_2 = makeCycle({
  id: 1002,
  start: at("2026-09-15T00:39"),
  end: at("2026-09-15T23:13"),
  strain: 19.0,
});
const CYCLE_3 = makeCycle({ id: 1003, start: at("2026-09-15T23:13"), end: null, strain: 7.8 });

const SLEEP_2 = makeSleep({
  id: "sleep-0915",
  cycleId: 1002,
  start: CYCLE_2.start,
  end: at("2026-09-15T07:30"),
  asleepHours: 6.5,
});
const SLEEP_3 = makeSleep({
  id: "sleep-0916",
  cycleId: 1003,
  start: CYCLE_3.start,
  end: at("2026-09-16T07:05"),
  asleepHours: 7,
  performance: 88,
});
const NAP_3 = makeSleep({
  id: "nap-0916",
  cycleId: 1003,
  start: at("2026-09-16T13:00"),
  end: at("2026-09-16T13:40"),
  asleepHours: 0.5,
  nap: true,
});

const RECOVERY_2 = makeRecovery({
  cycleId: 1002,
  sleepId: "sleep-0915",
  createdAt: at("2026-09-15T08:04"),
  score: 55,
  calibrating: true,
});
const RECOVERY_3 = makeRecovery({
  cycleId: 1003,
  sleepId: "sleep-0916",
  createdAt: at("2026-09-16T07:17"),
  score: 70,
  calibrating: true,
});

/** Newest-first, as WHOOP returns them */
const LIVE = {
  cycle: [CYCLE_3, CYCLE_2, CYCLE_1],
  sleep: [NAP_3, SLEEP_3, SLEEP_2],
  recovery: [RECOVERY_3, RECOVERY_2],
};

// ---------------------------------------------------------------------------
// Mock client
// ---------------------------------------------------------------------------

type Stream = unknown[] | Error | { records: unknown[]; next_token: string | null };

interface MockStreams {
  cycle?: Stream;
  sleep?: Stream;
  recovery?: Stream;
  /** Response for the offset lookup (GET /v2/cycle?limit=1); defaults to the newest cycle */
  offsetLookup?: Stream;
}

function respond(stream: Stream | undefined): Promise<unknown> {
  if (stream instanceof Error) return Promise.reject(stream);
  if (stream === undefined) return Promise.resolve({ records: [], next_token: null });
  if (Array.isArray(stream)) return Promise.resolve({ records: stream, next_token: null });
  return Promise.resolve(stream);
}

function createMockClient(streams: MockStreams): {
  client: WhoopClient;
  get: ReturnType<typeof vi.fn>;
} {
  const get = vi.fn((path: string): Promise<unknown> => {
    if (path === "/v2/cycle?limit=1") {
      if (streams.offsetLookup !== undefined) return respond(streams.offsetLookup);
      const cycles = Array.isArray(streams.cycle) ? streams.cycle : [];
      return respond(cycles.slice(0, 1));
    }
    if (path.startsWith("/v2/recovery?")) return respond(streams.recovery);
    if (path.startsWith("/v2/activity/sleep?")) return respond(streams.sleep);
    if (path.startsWith("/v2/cycle?")) return respond(streams.cycle);
    return Promise.reject(new Error(`Unexpected path: ${path}`));
  });
  return { client: { get } as unknown as WhoopClient, get };
}

function rowFor(
  result: Awaited<ReturnType<typeof getCalendar>>,
  date: string
): Awaited<ReturnType<typeof getCalendar>>["days"][number] {
  const row = result.days.find((day) => day.date === date);
  if (!row) throw new Error(`No row for ${date}`);
  return row;
}

function queryOf(get: ReturnType<typeof vi.fn>, prefix: string): URLSearchParams {
  const path = get.mock.calls.map((call) => call[0] as string).find((p) => p.startsWith(prefix));
  if (!path) throw new Error(`No call to ${prefix}`);
  return new URLSearchParams(path.slice(path.indexOf("?") + 1));
}

/** Consecutive normal days (bed 23:00, wake 07:00 local), newest-first, last cycle open */
function history(
  days: Array<{ date: string; recovery: number; strain: number; asleep: number }>,
  offset: string = OFFSET
): { cycle: Cycle[]; sleep: Sleep[]; recovery: Recovery[] } {
  const cycle: Cycle[] = [];
  const sleep: Sleep[] = [];
  const recovery: Recovery[] = [];
  days.forEach((day, index) => {
    const previous = new Date(Date.parse(`${day.date}T00:00:00Z`) - 86_400_000)
      .toISOString()
      .slice(0, 10);
    const next = days[index + 1];
    const id = 2000 + index;
    const start = at(`${previous}T23:00`, offset);
    cycle.push(
      makeCycle({
        id,
        start,
        end: next ? at(`${day.date}T23:00`, offset) : null,
        strain: day.strain,
        offset,
      })
    );
    sleep.push(
      makeSleep({
        id: `s-${day.date}`,
        cycleId: id,
        start,
        end: at(`${day.date}T07:00`, offset),
        asleepHours: day.asleep,
        offset,
      })
    );
    recovery.push(
      makeRecovery({
        cycleId: id,
        sleepId: `s-${day.date}`,
        createdAt: at(`${day.date}T07:15`, offset),
        score: day.recovery,
      })
    );
  });
  return { cycle: cycle.reverse(), sleep: sleep.reverse(), recovery: recovery.reverse() };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getCalendar", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("local-day grid", () => {
    it("returns a 7-day grid of local days ending today, most recent first", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      const { client } = createMockClient(LIVE);

      const result = await getCalendar(client, {});

      expect(result.period).toEqual({
        start: "2026-09-10",
        end: "2026-09-16",
        days: 7,
        utc_offset: "+02:00",
      });
      expect(result.days.map((d) => d.date)).toEqual([
        "2026-09-16",
        "2026-09-15",
        "2026-09-14",
        "2026-09-13",
        "2026-09-12",
        "2026-09-11",
        "2026-09-10",
      ]);
    });

    it("uses the user's local day for today, not the UTC day", async () => {
      // 23:30 UTC on 09-15 is already 01:30 on 09-16 at +02:00
      const { client } = createMockClient(LIVE);

      const result = await getCalendar(client, { days: 3 }, new Date("2026-09-15T23:30:00Z"));

      expect(result.period.end).toBe("2026-09-16");
      expect(result.days[0]?.date).toBe("2026-09-16");
    });

    it("fetches from local midnight the day before the grid to local midnight after it", async () => {
      const { client, get } = createMockClient(LIVE);

      await getCalendar(client, {}, NOW);

      for (const prefix of ["/v2/recovery?", "/v2/activity/sleep?", "/v2/cycle?start"]) {
        const query = queryOf(get, prefix);
        // Grid 09-10..09-16 at +02:00: from 09-09 00:00 local to 09-17 00:00 local
        expect(query.get("start")).toBe("2026-09-08T22:00:00.000Z");
        expect(query.get("end")).toBe("2026-09-16T22:00:00.000Z");
      }
    });

    it("falls back to UTC days with a warning when the timezone cannot be read", async () => {
      const { client } = createMockClient({ ...LIVE, offsetLookup: new Error("down") });

      const result = await getCalendar(client, { days: 3 }, NOW);

      expect(result.period.utc_offset).toBe("Z");
      expect(result.warnings.join(" ")).toMatch(/timezone/);
    });
  });

  describe("row alignment (cycle joins)", () => {
    it("puts recovery, sleep and strain of the cycle covering a day on that day's row", async () => {
      const { client } = createMockClient(LIVE);

      const result = await getCalendar(client, { days: 3 }, NOW);

      expect(rowFor(result, "2026-09-15")).toMatchObject({
        recovery_score: 55,
        sleep_hours: 6.5,
        day_strain: 19.0,
        day_strain_in_progress: false,
      });
      expect(rowFor(result, "2026-09-14")).toMatchObject({
        recovery_score: null,
        recovery_zone: null,
        recovery_calibrating: null,
        sleep_hours: null,
        sleep_performance_pct: null,
        day_strain: 7.9,
        day_strain_in_progress: false,
        day_strain_partial: true,
      });
    });

    it("shows the in-progress cycle's strain on today's row", async () => {
      const { client } = createMockClient(LIVE);

      const result = await getCalendar(client, { days: 3 }, NOW);

      expect(rowFor(result, "2026-09-16")).toEqual({
        date: "2026-09-16",
        recovery_score: 70,
        recovery_zone: "green",
        recovery_calibrating: true,
        sleep_hours: 7,
        sleep_performance_pct: 88,
        day_strain: 7.8,
        day_strain_in_progress: true,
        day_strain_partial: false,
      });
      expect(result.notes.join(" ")).toMatch(/2026-09-16 is still accumulating/);
    });

    it("keeps every cycle: none is lost when cycles would share a day", async () => {
      // Strap on at 18:00, first sleep onset at 23:30 the same evening: both
      // cycles are 12h-mapped to 09-15, but the partial one covers 09-14.
      const partial = makeCycle({
        id: 1,
        start: at("2026-09-14T18:00"),
        end: at("2026-09-14T23:30"),
        strain: 4.2,
      });
      const first = makeCycle({
        id: 2,
        start: at("2026-09-14T23:30"),
        end: at("2026-09-15T23:00"),
        strain: 12.3,
      });
      const sleep = makeSleep({
        id: "s1",
        cycleId: 2,
        start: first.start,
        end: at("2026-09-15T07:00"),
      });
      const { client } = createMockClient({ cycle: [first, partial], sleep: [sleep] });

      const result = await getCalendar(client, { days: 3 }, NOW);

      expect(rowFor(result, "2026-09-15").day_strain).toBe(12.3);
      expect(rowFor(result, "2026-09-14").day_strain).toBe(4.2);
      expect(result.averages.sample_sizes.strain).toBe(2);
      expect(result.warnings).toEqual([]);
    });

    it("joins recovery by cycle_id even when it was created on the previous UTC date", async () => {
      // +05:30: wake at 05:00 local on 09-16 is 23:30 UTC on 09-15
      const offset = "+05:30";
      const cycle = makeCycle({
        id: 7,
        start: at("2026-09-15T23:00", offset),
        end: null,
        strain: 6.1,
        offset,
      });
      const sleep = makeSleep({
        id: "s7",
        cycleId: 7,
        start: cycle.start,
        end: at("2026-09-16T05:00", offset),
        offset,
      });
      const recovery = makeRecovery({
        cycleId: 7,
        sleepId: "s7",
        createdAt: at("2026-09-16T05:15", offset),
        score: 81,
      });
      expect(recovery.created_at.slice(0, 10)).toBe("2026-09-15");
      const { client } = createMockClient({ cycle: [cycle], sleep: [sleep], recovery: [recovery] });

      const result = await getCalendar(client, { days: 2 }, NOW);

      expect(rowFor(result, "2026-09-16")).toMatchObject({
        recovery_score: 81,
        sleep_hours: 7,
        day_strain: 6.1,
      });
      expect(rowFor(result, "2026-09-15").recovery_score).toBeNull();
    });

    it("maps a full week of normal days one row each", async () => {
      const week = history([
        { date: "2026-09-10", recovery: 70, strain: 11.5, asleep: 8 },
        { date: "2026-09-11", recovery: 55, strain: 7.3, asleep: 7 },
        { date: "2026-09-12", recovery: 65, strain: 9.0, asleep: 7.5 },
        { date: "2026-09-13", recovery: 30, strain: 15.8, asleep: 6 },
        { date: "2026-09-14", recovery: 88, strain: 5.2, asleep: 8 },
        { date: "2026-09-15", recovery: 42, strain: 12.1, asleep: 7 },
        { date: "2026-09-16", recovery: 75, strain: 8.4, asleep: 7.5 },
      ]);
      const { client } = createMockClient(week);

      const result = await getCalendar(client, {}, NOW);

      expect(result.days.map((d) => d.recovery_score)).toEqual([75, 42, 88, 30, 65, 55, 70]);
      expect(result.days.map((d) => d.day_strain)).toEqual([8.4, 12.1, 5.2, 15.8, 9.0, 7.3, 11.5]);
      expect(result.days.map((d) => d.sleep_hours)).toEqual([7.5, 7, 8, 6, 7.5, 7, 8]);
      expect(result.days.map((d) => d.day_strain_in_progress)).toEqual([
        true,
        false,
        false,
        false,
        false,
        false,
        false,
      ]);
      // Recovery average over 7 days; strain over the 6 completed days
      expect(result.averages.recovery).toBeCloseTo(60.7, 1);
      expect(result.averages.strain).toBeCloseTo((12.1 + 5.2 + 15.8 + 9.0 + 7.3 + 11.5) / 6, 1);
      expect(result.averages.sleep_hours).toBeCloseTo(7.3, 1);
      expect(result.averages.sample_sizes).toEqual({ recovery: 7, sleep_hours: 7, strain: 6 });
      expect(result.notes).toEqual([
        "Strain for 2026-09-16 is still accumulating (day_strain_in_progress: true) and is left out of averages.strain.",
      ]);
      expect(result.warnings).toEqual([]);
      expect(result.truncated).toBe(false);
    });
  });

  describe("values", () => {
    it("computes recovery_zone from the score", async () => {
      const days = history([
        { date: "2026-09-13", recovery: 30, strain: 1, asleep: 7 },
        { date: "2026-09-14", recovery: 34, strain: 1, asleep: 7 },
        { date: "2026-09-15", recovery: 66, strain: 1, asleep: 7 },
        { date: "2026-09-16", recovery: 67, strain: 1, asleep: 7 },
      ]);
      const { client } = createMockClient(days);

      const result = await getCalendar(client, { days: 4 }, NOW);

      expect(result.days.map((d) => d.recovery_zone)).toEqual(["green", "yellow", "yellow", "red"]);
    });

    it("reports sleep_hours as time asleep, not time in bed, and ignores naps", async () => {
      const { client } = createMockClient(LIVE);

      const result = await getCalendar(client, { days: 1 }, NOW);

      // Asleep 7h (in bed 7.75h); the newer nap on the same cycle is ignored
      expect(result.days[0]?.sleep_hours).toBe(7);
    });

    it("does not include workout_count", async () => {
      const { client } = createMockClient(LIVE);

      const result = await getCalendar(client, { days: 1 }, NOW);

      expect(result.days[0]).not.toHaveProperty("workout_count");
    });
  });

  describe("sparse and calibrating data", () => {
    it("flags calibrating recoveries and explains sparse averages", async () => {
      const { client } = createMockClient(LIVE);

      const result = await getCalendar(client, {}, NOW);

      expect(rowFor(result, "2026-09-15").recovery_calibrating).toBe(true);
      expect(rowFor(result, "2026-09-16").recovery_calibrating).toBe(true);
      for (const date of ["2026-09-10", "2026-09-11", "2026-09-12", "2026-09-13"]) {
        expect(rowFor(result, date)).toEqual({
          date,
          recovery_score: null,
          recovery_zone: null,
          recovery_calibrating: null,
          sleep_hours: null,
          sleep_performance_pct: null,
          day_strain: null,
          day_strain_in_progress: false,
          day_strain_partial: false,
        });
      }
      // 09-14 is the partial first strap day: its strain is shown but not averaged
      expect(rowFor(result, "2026-09-14")).toMatchObject({
        day_strain: 7.9,
        day_strain_partial: true,
      });
      expect(result.averages).toEqual({
        recovery: 62.5,
        sleep_hours: 6.8,
        strain: 19.0,
        sample_sizes: { recovery: 2, sleep_hours: 2, strain: 1 },
      });
      expect(result.notes).toEqual([
        "WHOOP is still calibrating: recovery for 2026-09-15, 2026-09-16 is provisional (recovery_calibrating: true) and is included in averages.recovery.",
        "Strain for 2026-09-16 is still accumulating (day_strain_in_progress: true) and is left out of averages.strain.",
        "Strain for 2026-09-14 covers only part of the day (WHOOP was first worn partway through it; day_strain_partial: true) and is left out of averages.strain.",
        "No WHOOP data before 2026-09-14 in this range; the 4 earlier day(s) are null.",
        "Not enough data yet for reliable averages: recovery 2 of 7 days, sleep 2 of 7 days, strain 1 of 5 completed days. An average is null when no day has data.",
      ]);
      expect(result.warnings).toEqual([]);
    });

    it("returns null averages and a note when there is no data at all", async () => {
      const { client } = createMockClient({});

      const result = await getCalendar(client, {}, NOW);

      expect(result.days).toHaveLength(7);
      for (const day of result.days) {
        expect(day.recovery_score).toBeNull();
        expect(day.sleep_hours).toBeNull();
        expect(day.day_strain).toBeNull();
      }
      expect(result.averages).toEqual({
        recovery: null,
        sleep_hours: null,
        strain: null,
        sample_sizes: { recovery: 0, sleep_hours: 0, strain: 0 },
      });
      expect(result.notes).toEqual([
        "No WHOOP data for any day in this range; all values are null.",
      ]);
    });

    it("shows pending and unscorable records as null with a note", async () => {
      const pendingRecovery = makeRecovery({
        cycleId: 1003,
        sleepId: "sleep-0916",
        createdAt: RECOVERY_3.created_at,
        state: "PENDING_SCORE",
      });
      const unscorableSleep = makeSleep({
        id: "sleep-0915",
        cycleId: 1002,
        start: CYCLE_2.start,
        end: SLEEP_2.end,
        state: "UNSCORABLE",
      });
      const { client } = createMockClient({
        cycle: LIVE.cycle,
        sleep: [SLEEP_3, unscorableSleep],
        recovery: [pendingRecovery, RECOVERY_2],
      });

      const result = await getCalendar(client, { days: 3 }, NOW);

      expect(rowFor(result, "2026-09-16")).toMatchObject({
        recovery_score: null,
        recovery_zone: null,
        sleep_hours: 7,
        day_strain: 7.8,
      });
      expect(rowFor(result, "2026-09-15")).toMatchObject({
        recovery_score: 55,
        sleep_hours: null,
        sleep_performance_pct: null,
        day_strain: 19.0,
      });
      expect(result.notes).toContain(
        "Recovery for 2026-09-16 is still being scored by WHOOP; shown as null."
      );
      expect(result.notes).toContain("WHOOP could not score sleep for 2026-09-15; shown as null.");
    });
  });

  describe("start parameter", () => {
    it("starts the grid at a local date and iterates forward, clamped to today", async () => {
      const { client, get } = createMockClient(LIVE);

      const result = await getCalendar(client, { start: "2026-09-14", days: 10 }, NOW);

      expect(result.period).toEqual({
        start: "2026-09-14",
        end: "2026-09-16",
        days: 3,
        utc_offset: "+02:00",
      });
      expect(result.days.map((d) => d.date)).toEqual(["2026-09-14", "2026-09-15", "2026-09-16"]);
      expect(result.days.map((d) => d.day_strain)).toEqual([7.9, 19.0, 7.8]);
      expect(queryOf(get, "/v2/cycle?start").get("start")).toBe("2026-09-12T22:00:00.000Z");
    });

    it("honours start + days inside the past", async () => {
      const { client } = createMockClient(LIVE);

      const result = await getCalendar(client, { start: "2026-09-13", days: 2 }, NOW);

      expect(result.days.map((d) => d.date)).toEqual(["2026-09-13", "2026-09-14"]);
      expect(result.days.map((d) => d.day_strain)).toEqual([null, 7.9]);
    });

    it("resolves relative expressions in the user's timezone", async () => {
      const { client } = createMockClient(LIVE);

      // 23:30 UTC on 09-15 is 01:30 on 09-16 locally, so "yesterday" is 09-15
      const result = await getCalendar(
        client,
        { start: "yesterday", days: 7 },
        new Date("2026-09-15T23:30:00Z")
      );

      expect(result.period.start).toBe("2026-09-15");
      expect(result.period.end).toBe("2026-09-16");
    });

    it("shows the whole range for a range expression, ending today", async () => {
      const { client } = createMockClient(LIVE);

      const lastFourteen = await getCalendar(client, { start: "last 14 days" }, NOW);
      const thisMonth = await getCalendar(client, { start: "this month" }, NOW);
      const monthLiteral = await getCalendar(client, { start: "2026-09" }, NOW);

      // "last 14 days" is today plus the previous 14 days
      expect(lastFourteen.period).toMatchObject({
        start: "2026-09-02",
        end: "2026-09-16",
        days: 15,
      });
      expect(rowFor(lastFourteen, "2026-09-16")).toMatchObject({
        recovery_score: 70,
        day_strain: 7.8,
      });
      expect(lastFourteen.averages.sample_sizes.recovery).toBe(2);
      expect(lastFourteen.notes.join(" ")).not.toMatch(/No WHOOP data for any day/);
      expect(thisMonth.period).toMatchObject({ start: "2026-09-01", end: "2026-09-16", days: 16 });
      expect(monthLiteral.period).toMatchObject({ start: "2026-09-01", end: "2026-09-16" });
    });

    it('includes today for "last 7 days" without days', async () => {
      const { client } = createMockClient(LIVE);

      const result = await getCalendar(client, { start: "last 7 days" }, NOW);

      expect(result.period).toMatchObject({ start: "2026-09-09", end: "2026-09-16", days: 8 });
      expect(result.days[result.days.length - 1]?.date).toBe("2026-09-16");
    });

    it('keeps a past range such as "last week" to its own days', async () => {
      const { client } = createMockClient(LIVE);

      const result = await getCalendar(client, { start: "last week" }, NOW);

      expect(result.period).toMatchObject({ start: "2026-09-07", end: "2026-09-13", days: 7 });
    });

    it("uses the range's first day plus days when days is also given, with a note", async () => {
      const { client } = createMockClient(LIVE);

      const result = await getCalendar(client, { start: "last 7 days", days: 7 }, NOW);

      expect(result.period).toMatchObject({ start: "2026-09-09", end: "2026-09-15", days: 7 });
      expect(result.notes[0]).toBe(
        '"last 7 days" covers 2026-09-09 to 2026-09-16; with days 7 the grid shows only 2026-09-09 to 2026-09-15. Leave out days to show the whole range.'
      );
    });

    it("shows the last 90 days of a longer range, with a note and throttled paging", async () => {
      const spy = vi
        .spyOn(pagination, "fetchAllPages")
        .mockResolvedValue({ records: [], truncated: false });
      const { client } = createMockClient({ offsetLookup: [CYCLE_3] });

      const result = await getCalendar(client, { start: "last year" }, NOW);

      expect(result.period).toMatchObject({ start: "2025-10-03", end: "2025-12-31", days: 90 });
      expect(result.notes[0]).toBe(
        '"last year" covers 2025-01-01 to 2025-12-31, more than the 90-day maximum; the grid shows its last 90 days (2025-10-03 to 2025-12-31).'
      );
      expect(spy).toHaveBeenCalledTimes(3);
      for (const call of spy.mock.calls) {
        expect(call[2]?.interPageDelayMs).toBe(100);
      }
    });

    it("starts a date-time at its nearest local midnight", async () => {
      const { client } = createMockClient(LIVE);

      // 00:00 UTC is 02:00 local: most of 09-14 lies after it
      const early = await getCalendar(client, { start: "2026-09-14T00:00:00Z", days: 2 }, NOW);
      // 13:00 local: most of 09-14 lies before it, so the grid starts on 09-15
      const afternoon = await getCalendar(
        client,
        { start: "2026-09-14T13:00:00+02:00", days: 2 },
        NOW
      );

      expect(early.period).toMatchObject({ start: "2026-09-14", end: "2026-09-15" });
      expect(afternoon.period).toMatchObject({ start: "2026-09-15", end: "2026-09-16" });
    });

    it("returns an empty grid with a note when start is in the future", async () => {
      const { client } = createMockClient(LIVE);

      const result = await getCalendar(client, { start: "2026-10-01", days: 7 }, NOW);

      expect(result.period).toEqual({
        start: "2026-10-01",
        end: "2026-10-01",
        days: 0,
        utc_offset: "+02:00",
      });
      expect(result.days).toEqual([]);
      expect(result.averages.recovery).toBeNull();
      expect(result.averages.sleep_hours).toBeNull();
      expect(result.averages.strain).toBeNull();
      expect(result.notes[0]).toMatch(/after today/);
    });
  });

  describe("two cycles on one day (second main sleep)", () => {
    /** A week of normal nights; recovery = day of month + 30, strain = day of month */
    function numberedWeek(): { cycle: Cycle[]; sleep: Sleep[]; recovery: Recovery[] } {
      return history(
        ["10", "11", "12", "13", "14", "15", "16"].map((day) => ({
          date: `2026-09-${day}`,
          recovery: Number(day) + 30,
          strain: Number(day),
          asleep: 7,
        }))
      );
    }

    it("keeps every other day's own data when a daytime main sleep adds a cycle mid-grid", async () => {
      const week = numberedWeek();
      // 09-13: the night cycle ends at a 14:00 main sleep (nap: false), which starts its own cycle
      const cycle13 = week.cycle.find((c) => c.start === at("2026-09-12T23:00"))!;
      cycle13.end = at("2026-09-13T14:00");
      const extra = makeCycle({
        id: 999,
        start: at("2026-09-13T14:00"),
        end: at("2026-09-13T23:00"),
        strain: 3.3,
      });
      const extraSleep = makeSleep({
        id: "day-sleep",
        cycleId: 999,
        start: extra.start,
        end: at("2026-09-13T19:00"),
        asleepHours: 4.5,
      });
      const extraRecovery = makeRecovery({
        cycleId: 999,
        sleepId: "day-sleep",
        createdAt: at("2026-09-13T19:10"),
        score: 99,
      });
      const { client } = createMockClient({
        cycle: [...week.cycle.slice(0, 3), extra, ...week.cycle.slice(3)],
        sleep: [...week.sleep.slice(0, 3), extraSleep, ...week.sleep.slice(3)],
        recovery: [...week.recovery.slice(0, 3), extraRecovery, ...week.recovery.slice(3)],
      });

      const result = await getCalendar(client, {}, NOW);

      expect(result.days.map((d) => d.date)).toEqual([
        "2026-09-16",
        "2026-09-15",
        "2026-09-14",
        "2026-09-13",
        "2026-09-12",
        "2026-09-11",
        "2026-09-10",
      ]);
      expect(result.days.map((d) => d.recovery_score)).toEqual([46, 45, 44, 43, 42, 41, 40]);
      expect(result.days.map((d) => d.day_strain)).toEqual([16, 15, 14, 13, 12, 11, 10]);
      expect(result.days.map((d) => d.sleep_hours)).toEqual([7, 7, 7, 7, 7, 7, 7]);
      expect(result.averages.sample_sizes).toEqual({ recovery: 7, sleep_hours: 7, strain: 6 });
      expect(result.warnings).toEqual([
        "Two WHOOP cycles belong to 2026-09-13 (for example, a second main sleep ended that day). The row shows the cycle that started 2026-09-12 23:00; the cycle that started 2026-09-13 14:00 (strain 3.3) is left out of the grid and its averages.",
      ]);
    });

    it("does not shift older days when the second main sleep is today", async () => {
      const week = numberedWeek();
      const cycle16 = week.cycle[0]!;
      cycle16.end = at("2026-09-16T12:00");
      const shift = makeCycle({ id: 998, start: at("2026-09-16T12:00"), end: null, strain: 2 });
      const shiftSleep = makeSleep({
        id: "shift",
        cycleId: 998,
        start: shift.start,
        end: at("2026-09-16T18:00"),
        asleepHours: 5.5,
      });
      const { client } = createMockClient({
        cycle: [shift, ...week.cycle],
        sleep: [shiftSleep, ...week.sleep],
        recovery: week.recovery,
      });

      const result = await getCalendar(client, {}, new Date("2026-09-16T19:00:00Z"));

      expect(result.days.map((d) => d.recovery_score)).toEqual([46, 45, 44, 43, 42, 41, 40]);
      expect(result.days.map((d) => d.day_strain)).toEqual([16, 15, 14, 13, 12, 11, 10]);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toMatch(
        /^Two WHOOP cycles belong to 2026-09-16 .*started 2026-09-16 12:00 \(strain 2 so far\) is left out/
      );
    });
  });

  describe("partial first strap day", () => {
    it("keeps the first day's strain on its row but leaves it out of averages.strain", async () => {
      const { client } = createMockClient(LIVE);

      const result = await getCalendar(client, { start: "2026-09-14", days: 3 }, NOW);

      expect(result.days.map((d) => d.day_strain_partial)).toEqual([true, false, false]);
      expect(rowFor(result, "2026-09-14").day_strain).toBe(7.9);
      expect(result.averages.strain).toBe(19.0);
      expect(result.averages.sample_sizes.strain).toBe(1);
      expect(result.notes.join(" ")).toMatch(/Strain for 2026-09-14 covers only part of the day/);
    });

    it("still averages a cycle without a sleep that did not start at local midnight", async () => {
      // Mid-history night the strap missed: cycle 11 has no sleep but starts at a bedtime
      const cycle1 = makeCycle({
        id: 11,
        start: at("2026-09-13T23:00"),
        end: at("2026-09-14T23:30"),
        strain: 9,
      });
      const cycle2 = makeCycle({ id: 12, start: at("2026-09-14T23:30"), end: null, strain: 5 });
      const sleep2 = makeSleep({
        id: "s12",
        cycleId: 12,
        start: cycle2.start,
        end: at("2026-09-15T07:00"),
      });
      const { client } = createMockClient({ cycle: [cycle2, cycle1], sleep: [sleep2] });

      const result = await getCalendar(client, { start: "2026-09-14", days: 2 }, NOW);

      expect(rowFor(result, "2026-09-14")).toMatchObject({
        day_strain: 9,
        day_strain_partial: false,
      });
      expect(result.averages.strain).toBe(9);
      expect(result.notes.join(" ")).not.toMatch(/only part of the day/);
    });

    it("does not flag a midnight cycle that comes after a recorded main sleep", async () => {
      const early = makeCycle({
        id: 21,
        start: at("2026-09-13T23:00"),
        end: at("2026-09-15T00:00"),
        strain: 12,
      });
      const earlySleep = makeSleep({
        id: "s21",
        cycleId: 21,
        start: early.start,
        end: at("2026-09-14T07:00"),
      });
      const midnight = makeCycle({
        id: 22,
        start: at("2026-09-15T00:00"),
        end: at("2026-09-15T23:00"),
        strain: 8,
      });
      const { client } = createMockClient({ cycle: [midnight, early], sleep: [earlySleep] });

      const result = await getCalendar(client, { start: "2026-09-14", days: 2 }, NOW);

      expect(result.days.map((d) => d.day_strain_partial)).toEqual([false, false]);
      expect(result.averages.sample_sizes.strain).toBe(2);
    });
  });

  describe("after local midnight, before the next sleep syncs", () => {
    /** 01:30 local on 2026-09-17: the cycle that started 09-15 23:13 is still open */
    const AFTER_MIDNIGHT = new Date("2026-09-16T23:30:00Z");

    it("does not describe today's empty row as missing data or strap-off time", async () => {
      const { client } = createMockClient(LIVE);

      const result = await getCalendar(client, {}, AFTER_MIDNIGHT);

      expect(result.period).toMatchObject({ start: "2026-09-11", end: "2026-09-17", days: 7 });
      expect(rowFor(result, "2026-09-17")).toMatchObject({
        recovery_score: null,
        sleep_hours: null,
        day_strain: null,
        day_strain_in_progress: false,
      });
      expect(rowFor(result, "2026-09-16")).toMatchObject({
        day_strain: 7.8,
        day_strain_in_progress: true,
      });
      const notes = result.notes.join(" ");
      expect(notes).not.toMatch(/while it was off/);
      expect(notes).not.toMatch(/No WHOOP data for any day/);
      expect(result.notes).toContain(
        "Today's (2026-09-17) WHOOP cycle has not started yet: a new cycle begins at your next sleep and appears once that sleep syncs. Until then, strain is still being added to the open cycle that started 2026-09-15 23:13, shown on 2026-09-16 (day_strain_in_progress: true). Its row stays null until then; this is not missing data."
      );
      expect(result.notes).toContain(
        "No WHOOP data before 2026-09-14 in this range; the 3 earlier day(s) are null."
      );
      // Today cannot have a recovery or sleep yet, so it is not counted as missing
      expect(notes).toMatch(/recovery 2 of 6 days, sleep 2 of 6 days/);
    });

    it.each([[{ start: "today" }], [{ days: 1 }]])(
      "explains a single empty today row and gives the open cycle's strain (%j)",
      async (params) => {
        const { client } = createMockClient(LIVE);

        const result = await getCalendar(client, params, AFTER_MIDNIGHT);

        expect(result.days.map((d) => d.date)).toEqual(["2026-09-17"]);
        expect(result.notes).toEqual([
          "Today's (2026-09-17) WHOOP cycle has not started yet: a new cycle begins at your next sleep and appears once that sleep syncs. Until then, strain is still being added to the open cycle that started 2026-09-15 23:13, which belongs to 2026-09-16, outside this grid; its strain so far is 7.8. Its row stays null until then; this is not missing data.",
        ]);
      }
    );

    it("covers every day since an open cycle that has run for more than a day", async () => {
      // No sleep detected on the nights before 09-15 and 09-16: the cycle from 09-13 23:00 is still open
      const open = makeCycle({ id: 31, start: at("2026-09-13T23:00"), end: null, strain: 14 });
      const sleep = makeSleep({
        id: "s31",
        cycleId: 31,
        start: open.start,
        end: at("2026-09-14T07:00"),
      });
      const { client } = createMockClient({ cycle: [open], sleep: [sleep] });

      const result = await getCalendar(client, { start: "2026-09-14" }, NOW);

      expect(result.days.map((d) => d.date)).toEqual(["2026-09-14", "2026-09-15", "2026-09-16"]);
      expect(result.notes.join(" ")).not.toMatch(/No WHOOP data/);
      expect(result.notes).toContain(
        "No WHOOP cycle has started yet for 2026-09-15, 2026-09-16: a new cycle begins at your next sleep and appears once that sleep syncs. Until then, strain is still being added to the open cycle that started 2026-09-13 23:00, shown on 2026-09-14 (day_strain_in_progress: true). Their rows stay null until then; this is not missing data."
      );
    });

    it("adds no such note once today's cycle exists", async () => {
      const { client } = createMockClient(LIVE);

      const result = await getCalendar(client, { days: 1 }, NOW);

      expect(rowFor(result, "2026-09-16").day_strain).toBe(7.8);
      expect(result.notes.join(" ")).not.toMatch(/has not started yet/);
    });
  });

  describe("partial failures", () => {
    it("nulls only the recovery columns when the recovery stream fails", async () => {
      const { client } = createMockClient({
        ...LIVE,
        recovery: new WhoopApiError(429, "Too Many Requests", {}),
      });

      const result = await getCalendar(client, { days: 3 }, NOW);

      expect(result.days.every((d) => d.recovery_score === null)).toBe(true);
      expect(rowFor(result, "2026-09-16")).toMatchObject({ sleep_hours: 7, day_strain: 7.8 });
      expect(result.averages.recovery).toBeNull();
      expect(result.warnings).toEqual([
        "Recovery data could not be loaded (WHOOP API returned HTTP 429), so these columns are null for every day: recovery_score, recovery_zone, recovery_calibrating.",
      ]);
      // The failed column is not reported as "not enough data"
      expect(result.notes.join(" ")).not.toMatch(/recovery 0 of/);
    });

    it("places recovery and sleep by date when the cycle stream fails", async () => {
      const { client } = createMockClient({
        ...LIVE,
        cycle: new WhoopApiError(503, "Service Unavailable", {}),
        offsetLookup: [CYCLE_3],
      });

      const result = await getCalendar(client, { days: 3 }, NOW);

      expect(rowFor(result, "2026-09-16")).toMatchObject({
        recovery_score: 70,
        sleep_hours: 7,
        day_strain: null,
      });
      expect(rowFor(result, "2026-09-15")).toMatchObject({ recovery_score: 55, sleep_hours: 6.5 });
      expect(result.warnings[0]).toMatch(/^Cycle data could not be loaded .*HTTP 503.*day_strain/);
      // An empty day is not presented as certainly empty while a stream is missing
      expect(result.notes).toContain(
        "No WHOOP data before 2026-09-15 in this range; the 1 earlier day(s) are null. Some data could not be loaded; see warnings."
      );
    });

    it("describes a wrapped API failure by its HTTP status", async () => {
      const wrapped = new WhoopNetworkError(new WhoopApiError(429, "Too Many Requests", {}));
      const { client } = createMockClient({ ...LIVE, sleep: wrapped });

      const result = await getCalendar(client, { days: 3 }, NOW);

      expect(result.warnings).toEqual([
        "Sleep data could not be loaded (WHOOP API returned HTTP 429), so these columns are null for every day: sleep_hours, sleep_performance_pct.",
      ]);
      expect(rowFor(result, "2026-09-16")).toMatchObject({ recovery_score: 70, sleep_hours: null });
    });

    it("throws when every stream fails", async () => {
      const error = new WhoopApiError(500, "Server Error", {});
      const { client } = createMockClient({ cycle: error, sleep: error, recovery: error });

      await expect(getCalendar(client, {}, NOW)).rejects.toBe(error);
    });

    it("skips records that do not match the WHOOP format, with a warning", async () => {
      const broken = { ...CYCLE_1, timezone_offset: "bogus" };
      const { client } = createMockClient({ ...LIVE, cycle: [CYCLE_3, CYCLE_2, broken] });

      const result = await getCalendar(client, { days: 3 }, NOW);

      expect(rowFor(result, "2026-09-14").day_strain).toBeNull();
      expect(rowFor(result, "2026-09-15").day_strain).toBe(19.0);
      expect(result.warnings).toEqual([
        "1 cycle record(s) did not match the expected WHOOP format and were skipped.",
      ]);
    });
  });

  describe("pagination", () => {
    it("requests all three streams with a start parameter", async () => {
      const { client, get } = createMockClient(LIVE);

      await getCalendar(client, { days: 30 }, NOW);

      const paths = get.mock.calls.map((c) => c[0] as string);
      expect(paths.some((p) => p.startsWith("/v2/recovery?start="))).toBe(true);
      expect(paths.some((p) => p.startsWith("/v2/activity/sleep?start="))).toBe(true);
      expect(paths.some((p) => p.startsWith("/v2/cycle?start="))).toBe(true);
    });

    it("sizes record limits per fetched day, with more room for sleeps (naps)", async () => {
      const spy = vi
        .spyOn(pagination, "fetchAllPages")
        .mockResolvedValue({ records: [], truncated: false });
      const { client } = createMockClient({});

      await getCalendar(client, { days: 7 }, NOW);

      const limits = Object.fromEntries(
        spy.mock.calls.map((call) => [String(call[1]).split("?")[0], call[2]?.maxRecords])
      );
      // 7 grid days + the day before + the open end = 9 fetched days
      expect(limits).toEqual({ "/v2/recovery": 18, "/v2/activity/sleep": 36, "/v2/cycle": 18 });
    });

    it("surfaces truncation when a stream hits its record limit", async () => {
      // days=1 → 3 fetched days → cycle limit 6; WHOOP still has more pages
      const cycles = Array.from({ length: 6 }, (_, index) =>
        makeCycle({
          id: 100 + index,
          start: new Date(Date.parse(CYCLE_3.start) - index * 86_400_000).toISOString(),
          end:
            index === 0
              ? null
              : new Date(Date.parse(CYCLE_3.start) - (index - 1) * 86_400_000).toISOString(),
          strain: 5,
        })
      );
      const { client } = createMockClient({
        cycle: { records: cycles, next_token: "more" },
        offsetLookup: [CYCLE_3],
      });

      const result = await getCalendar(client, { days: 1 }, NOW);

      expect(result.truncated).toBe(true);
      expect(result.warnings).toEqual([
        "Cycle data hit the 6-record limit. WHOOP returns newest records first, so days before 2026-09-11 may be missing data in: day_strain. Request fewer days for a complete grid.",
      ]);
    });
  });

  describe("interPageDelayMs throttling", () => {
    it("passes interPageDelayMs=0 for small ranges (numDays <= 30)", async () => {
      const spy = vi
        .spyOn(pagination, "fetchAllPages")
        .mockResolvedValue({ records: [], truncated: false });
      const client = { get: vi.fn() } as unknown as WhoopClient;

      await getCalendar(client, { days: 30 }, NOW);

      expect(spy).toHaveBeenCalledTimes(3);
      for (const call of spy.mock.calls) {
        expect(call[2]?.interPageDelayMs).toBe(0);
      }
    });

    it("passes interPageDelayMs=100 for large ranges (numDays > 30)", async () => {
      const spy = vi
        .spyOn(pagination, "fetchAllPages")
        .mockResolvedValue({ records: [], truncated: false });
      const client = { get: vi.fn() } as unknown as WhoopClient;

      await getCalendar(client, { days: 90 }, NOW);

      expect(spy).toHaveBeenCalledTimes(3);
      for (const call of spy.mock.calls) {
        expect(call[2]?.interPageDelayMs).toBe(100);
      }
    });
  });

  describe("output contract", () => {
    const contract = outputSchemas.get_calendar!;

    it("accepts the live-shaped sparse result", async () => {
      const { client } = createMockClient(LIVE);
      const result = await getCalendar(client, { days: 90 }, NOW);
      expect(contract.safeParse(JSON.parse(JSON.stringify(result))).success).toBe(true);
    });

    it("accepts empty, future-start and degraded results", async () => {
      const empty = await getCalendar(createMockClient({}).client, {}, NOW);
      const future = await getCalendar(createMockClient({}).client, { start: "2026-12-01" }, NOW);
      const degraded = await getCalendar(
        createMockClient({ ...LIVE, sleep: new Error("boom") }).client,
        {},
        NOW
      );
      for (const result of [empty, future, degraded]) {
        expect(contract.safeParse(JSON.parse(JSON.stringify(result))).success).toBe(true);
      }
    });
  });
});
