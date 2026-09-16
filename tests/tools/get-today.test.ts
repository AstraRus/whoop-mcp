/**
 * Tests for get-today.ts — get_today composite tool.
 *
 * Fixtures follow the live WHOOP shape: a cycle starts at sleep onset (the
 * previous local evening), the current cycle has end: null, sleep and recovery
 * point at the cycle whose morning they belong to, records come newest-first,
 * next_token is null on the last page, and a new user is still calibrating.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { WhoopClient } from "../../src/api/client.js";
import { WhoopApiError, WhoopAuthError, WhoopNetworkError } from "../../src/api/client.js";
import {
  getToday,
  LONG_CYCLE_MS,
  MAX_SYNC_GAP_MS,
  STALE_SLEEP_MS,
} from "../../src/tools/get-today.js";
import { outputSchemas } from "../../src/tools/output-contracts.js";
import type { Recovery, Sleep, Cycle, Workout } from "../../src/api/types.js";

// ---------------------------------------------------------------------------
// Fixtures — user at +02:00 who started wearing WHOOP on Monday evening
// ---------------------------------------------------------------------------

/** 12:00 local (+02:00) on Wednesday 2026-09-16 */
const FIXED_NOW = new Date("2026-09-16T10:00:00.000Z");
const OFFSET = "+02:00";
const USER = 42;

const CURRENT_CYCLE_START = "2026-09-15T21:13:31.460Z"; // 23:13 local on 09-15
const PREVIOUS_CYCLE_START = "2026-09-14T22:39:47.770Z"; // 00:39 local on 09-15
const FIRST_CYCLE_START = "2026-09-14T17:00:00.000Z"; // first wear, Monday evening

const currentCycle: Cycle = {
  id: 3003,
  user_id: USER,
  created_at: "2026-09-16T05:17:30.602Z",
  updated_at: "2026-09-16T09:57:49.180Z",
  start: CURRENT_CYCLE_START,
  end: null,
  timezone_offset: OFFSET,
  score_state: "SCORED",
  score: { strain: 8.4, kilojoule: 1200, average_heart_rate: 68, max_heart_rate: 155 },
};

const previousCycle: Cycle = {
  id: 3002,
  user_id: USER,
  created_at: "2026-09-15T06:04:13.212Z",
  updated_at: "2026-09-16T05:17:35.807Z",
  start: PREVIOUS_CYCLE_START,
  end: CURRENT_CYCLE_START,
  timezone_offset: OFFSET,
  score_state: "SCORED",
  score: { strain: 14.2, kilojoule: 2500, average_heart_rate: 75, max_heart_rate: 170 },
};

const firstCycle: Cycle = {
  id: 3001,
  user_id: USER,
  created_at: "2026-09-14T17:00:00.000Z",
  updated_at: "2026-09-15T06:04:13.212Z",
  start: FIRST_CYCLE_START,
  end: PREVIOUS_CYCLE_START,
  timezone_offset: OFFSET,
  score_state: "SCORED",
  score: { strain: 3.1, kilojoule: 600, average_heart_rate: 62, max_heart_rate: 110 },
};

const sleepScore: NonNullable<Sleep["score"]> = {
  stage_summary: {
    total_in_bed_time_milli: 27000000, // 7.5h
    total_awake_time_milli: 1800000, // 0.5h
    total_no_data_time_milli: 0,
    total_light_sleep_time_milli: 10800000, // 3h
    total_slow_wave_sleep_time_milli: 5400000, // 1.5h
    total_rem_sleep_time_milli: 7200000, // 2h
    sleep_cycle_count: 4,
    disturbance_count: 2,
  },
  sleep_needed: {
    baseline_milli: 28800000,
    need_from_sleep_debt_milli: 0,
    need_from_recent_strain_milli: 0,
    need_from_recent_nap_milli: 0,
  },
  respiratory_rate: 15.2,
  sleep_performance_percentage: 85,
  sleep_efficiency_percentage: 92,
  sleep_consistency_percentage: 0,
};

/** Last night's main sleep: starts exactly at the current cycle's start */
const currentSleep: Sleep = {
  id: "sleep-3",
  cycle_id: currentCycle.id,
  user_id: USER,
  created_at: "2026-09-16T05:17:36.057Z",
  updated_at: "2026-09-16T05:17:36.057Z",
  start: CURRENT_CYCLE_START,
  end: "2026-09-16T04:43:31.460Z", // 06:43 local
  timezone_offset: OFFSET,
  nap: false,
  score_state: "SCORED",
  v1_id: null,
  score: sleepScore,
};

const previousSleep: Sleep = {
  ...currentSleep,
  id: "sleep-2",
  cycle_id: previousCycle.id,
  created_at: "2026-09-15T06:04:13.212Z",
  updated_at: "2026-09-15T06:04:13.212Z",
  start: PREVIOUS_CYCLE_START,
  end: "2026-09-15T06:09:47.770Z",
};

/** A nap in the current cycle — newer than last night's sleep, same cycle_id */
const currentNap: Sleep = {
  ...currentSleep,
  id: "nap-3",
  created_at: "2026-09-16T08:35:00.000Z",
  updated_at: "2026-09-16T08:35:00.000Z",
  start: "2026-09-16T08:00:00.000Z",
  end: "2026-09-16T08:30:00.000Z",
  nap: true,
};

const currentRecovery: Recovery = {
  cycle_id: currentCycle.id,
  sleep_id: currentSleep.id,
  user_id: USER,
  created_at: "2026-09-16T05:17:36.057Z",
  updated_at: "2026-09-16T05:17:36.057Z",
  score_state: "SCORED",
  score: {
    user_calibrating: true,
    recovery_score: 72,
    resting_heart_rate: 55,
    hrv_rmssd_milli: 45.2,
    spo2_percentage: 97,
    skin_temp_celsius: 33.5,
  },
};

const previousRecovery: Recovery = {
  ...currentRecovery,
  cycle_id: previousCycle.id,
  sleep_id: previousSleep.id,
  created_at: "2026-09-15T06:04:13.212Z",
  updated_at: "2026-09-15T06:04:13.212Z",
  score: { ...currentRecovery.score!, recovery_score: 50 },
};

const zones = {
  zone_zero_milli: 0,
  zone_one_milli: 60000,
  zone_two_milli: 120000,
  zone_three_milli: 1800000,
  zone_four_milli: 600000,
  zone_five_milli: 0,
};

/** This morning's non-GPS workout: WHOOP sends explicit nulls for distance/altitude */
const latestWorkout: Workout = {
  id: "workout-2",
  user_id: USER,
  created_at: "2026-09-16T08:00:00.000Z",
  updated_at: "2026-09-16T08:05:00.000Z",
  start: "2026-09-16T07:00:00.000Z",
  end: "2026-09-16T08:00:00.000Z",
  timezone_offset: OFFSET,
  sport_name: "Functional Fitness",
  sport_id: 0,
  v1_id: null,
  score_state: "SCORED",
  score: {
    strain: 12.5,
    average_heart_rate: 145,
    max_heart_rate: 172,
    kilojoule: 800,
    percent_recorded: 100,
    zone_durations: zones,
    distance_meter: null,
    altitude_gain_meter: null,
    altitude_change_meter: null,
  },
};

const olderWorkout: Workout = {
  ...latestWorkout,
  id: "workout-1",
  created_at: "2026-09-15T16:00:00.000Z",
  updated_at: "2026-09-15T16:05:00.000Z",
  start: "2026-09-15T15:00:00.000Z",
  end: "2026-09-15T16:00:00.000Z",
  sport_name: "Running",
  score: {
    ...latestWorkout.score!,
    strain: 9.1,
    distance_meter: 5000,
    altitude_gain_meter: 40,
    altitude_change_meter: 2,
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A last page as WHOOP returns it */
function page<T>(records: T[]): { records: T[]; next_token: null } {
  return { records, next_token: null };
}

type Responses = Partial<Record<"recovery" | "sleep" | "cycle" | "workout", unknown>>;

const PATHS = {
  recovery: "/v2/recovery",
  sleep: "/v2/activity/sleep",
  cycle: "/v2/cycle",
  workout: "/v2/activity/workout",
} as const;

/** Live-shaped account: 3 cycles, 2 main sleeps + a nap, 2 calibrating recoveries, 2 workouts */
function liveResponses(): Required<Responses> {
  return {
    recovery: page([currentRecovery, previousRecovery]),
    sleep: page([currentNap, currentSleep, previousSleep]),
    cycle: page([currentCycle, previousCycle, firstCycle]),
    workout: page([latestWorkout, olderWorkout]),
  };
}

function createMockClient(overrides: Responses = {}): WhoopClient {
  const responses = { ...liveResponses(), ...overrides };
  const get = vi.fn().mockImplementation((path: string) => {
    for (const [name, prefix] of Object.entries(PATHS)) {
      if (path.startsWith(prefix)) {
        const value = responses[name as keyof typeof PATHS];
        return value instanceof Error
          ? Promise.reject(value)
          : Promise.resolve(structuredClone(value));
      }
    }
    return Promise.reject(new Error(`Unexpected path: ${path}`));
  });
  return { get } as unknown as WhoopClient;
}

function expectValidContract(result: unknown): void {
  const parsed = outputSchemas.get_today!.safeParse(result);
  expect(parsed.success).toBe(true);
  // The contract must not strip anything the tool returns
  expect(parsed.data).toEqual(result);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getToday", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("current cycle selection (bedtime before local midnight)", () => {
    it("treats the open cycle that started last evening as today's cycle", async () => {
      const result = await getToday(createMockClient());

      expect(result.strain).toMatchObject({ day_strain: 8.4, energy_burned_kj: 1200 });
      expect(result.sleep?.asleep_hours).toBe(6.5);
      expect(result.recovery).toMatchObject({ score: 72, user_calibrating: true });
      expect(result.data_quality.sources.cycle).toMatchObject({
        status: "available",
        records_fetched: 3,
        records_used: 1,
        truncated: false,
      });
      expect(result.data_quality.sources.sleep).toMatchObject({
        status: "available",
        records_used: 1,
      });
      expect(result.data_quality.sources.recovery).toMatchObject({
        status: "calibrating",
        records_used: 1,
      });
      expectValidContract(result);
    });

    it("reports the current cycle as the requested period", async () => {
      const result = await getToday(createMockClient());

      expect(result.data_quality.requested_period).toEqual({
        start: CURRENT_CYCLE_START,
        end: FIXED_NOW.toISOString(),
      });
      expect(result.data_quality.observed_period).toEqual({
        start: CURRENT_CYCLE_START,
        end: latestWorkout.end,
      });
      expect(result.data_quality.method_version).toBe("today-4");
    });

    it("keeps today's sleep, recovery and strain after local midnight until the next sleep", async () => {
      // 00:30 local on 09-17: same open cycle, no new sleep yet
      const result = await getToday(createMockClient(), new Date("2026-09-16T22:30:00.000Z"));

      expect(result.recovery?.score).toBe(72);
      expect(result.sleep).not.toBeNull();
      expect(result.strain?.day_strain).toBe(8.4);
      expect(result.data_quality.sources.sleep?.status).toBe("available");
    });

    it("uses the still-open previous cycle at 01:30 local before the user has slept", async () => {
      const result = await getToday(
        createMockClient({
          recovery: page([previousRecovery]),
          sleep: page([previousSleep]),
          cycle: page([{ ...previousCycle, end: null }, firstCycle]),
          workout: page([olderWorkout]),
        }),
        new Date("2026-09-15T23:30:00.000Z")
      );

      expect(result.strain?.day_strain).toBe(14.2);
      expect(result.recovery?.score).toBe(50);
      expect(result.sleep).not.toBeNull();
      expect(result.data_quality.requested_period.start).toBe(PREVIOUS_CYCLE_START);
    });

    it("handles a bedtime after local midnight at a negative offset", async () => {
      const cycle: Cycle = {
        ...currentCycle,
        start: "2026-09-16T05:30:00.000Z", // 00:30 local at -05:00
        timezone_offset: "-05:00",
      };
      const sleep: Sleep = {
        ...currentSleep,
        start: cycle.start,
        end: "2026-09-16T13:00:00.000Z",
        timezone_offset: "-05:00",
      };
      const result = await getToday(
        createMockClient({
          cycle: page([cycle]),
          sleep: page([sleep]),
          recovery: page([currentRecovery]),
        }),
        new Date("2026-09-17T03:00:00.000Z") // 22:00 local on 09-16
      );

      expect(result.recovery?.score).toBe(72);
      expect(result.strain?.day_strain).toBe(8.4);
    });

    it("never promotes a closed cycle to today's strain", async () => {
      const result = await getToday(
        createMockClient({
          cycle: page([{ ...currentCycle, end: "2026-09-16T09:00:00.000Z" }, previousCycle]),
        })
      );

      expect(result.strain).toBeNull();
      expect(result.data_quality.sources.cycle?.status).toBe("stale");
      expect(result.notes).toContain(
        "Today's strain is not available: the latest WHOOP cycle ended 2026-09-16 11:00 (UTC+02:00), when WHOOP detected a new sleep, and the next cycle has not synced yet (WHOOP creates it once that sleep is processed)."
      );
      expect(result.notes.join(" ")).not.toContain("no open WHOOP cycle");
      expectValidContract(result);
    });

    it("ignores records that start in the future", async () => {
      const future: Cycle = { ...currentCycle, id: 9999, start: "2026-09-16T11:00:00.000Z" };
      const result = await getToday(
        createMockClient({
          cycle: page([future, { ...currentCycle, end: future.start }, previousCycle]),
        })
      );

      expect(result.strain?.day_strain).toBe(8.4);
    });
  });

  describe("long cycles, unprocessed sleep and sync gaps", () => {
    /** 23:30 local on 09-17: no sleep detected on the night of 09-16, cycle open ~48.3h */
    const DAY_TWO_LATE = new Date("2026-09-17T21:30:00.000Z");
    const NO_NEWER_SLEEP = "No newer sleep has been processed since";

    it("keeps showing an open cycle older than 48 hours that WHOOP just updated", async () => {
      const cycle: Cycle = {
        ...currentCycle,
        updated_at: "2026-09-17T21:20:00.000Z",
        score: { ...currentCycle.score!, strain: 17.2 },
      };
      const result = await getToday(
        createMockClient({ cycle: page([cycle, previousCycle, firstCycle]) }),
        DAY_TWO_LATE
      );

      expect(result.strain?.day_strain).toBe(17.2);
      expect(result.data_quality.sources.cycle).toMatchObject({
        status: "available",
        source_updated_at: cycle.updated_at,
      });
      expect(result.data_quality.requested_period.start).toBe(CURRENT_CYCLE_START);
      expect(result.summary).not.toContain("No data available");
      expect(result.notes).toContain(
        "The current WHOOP cycle started 2026-09-15 23:13 (UTC+02:00), about 48 hours ago. A cycle only ends when WHOOP detects the next sleep, so the strain shown covers that whole period."
      );
      const text = result.notes.join(" ");
      expect(text).not.toContain("no open WHOOP cycle");
      expect(text).not.toContain("may not have synced");
      expectValidContract(result);
    });

    it("keeps showing the open cycle after two missed nights", async () => {
      const cycle: Cycle = {
        ...currentCycle,
        updated_at: "2026-09-18T09:55:00.000Z",
        score: { ...currentCycle.score!, strain: 18.4 },
      };
      const result = await getToday(
        createMockClient({ cycle: page([cycle, previousCycle]) }),
        new Date("2026-09-18T10:00:00.000Z") // 12:00 local on 09-18, cycle ~60.8h
      );

      expect(result.strain?.day_strain).toBe(18.4);
      expect(result.data_quality.sources.cycle?.status).toBe("available");
      expect(result.notes.join(" ")).toContain("about 61 hours ago");
    });

    it("notes the long cycle only after LONG_CYCLE_MS", async () => {
      const start = Date.parse(CURRENT_CYCLE_START);
      const before = await getToday(createMockClient(), new Date(start + LONG_CYCLE_MS - 60_000));
      const after = await getToday(createMockClient(), new Date(start + LONG_CYCLE_MS + 60_000));

      expect(before.notes.join(" ")).not.toContain("The current WHOOP cycle started");
      expect(after.notes.join(" ")).toContain("The current WHOOP cycle started");
    });

    it("shows the strain of a cycle WHOOP has not updated for a day, flagged as possibly not synced", async () => {
      const cycle: Cycle = { ...currentCycle, updated_at: "2026-09-16T05:30:00.000Z" };
      const result = await getToday(
        createMockClient({ cycle: page([cycle, previousCycle]) }),
        DAY_TWO_LATE
      );

      expect(result.strain?.day_strain).toBe(8.4);
      expect(result.data_quality.sources.cycle).toMatchObject({
        status: "stale",
        source_updated_at: cycle.updated_at,
      });
      expect(result.summary).toContain("cycle: stale");
      expect(result.notes).toContain(
        "WHOOP has not updated the current cycle since 2026-09-16 07:30 (UTC+02:00), about 40 hours ago; the strap may not have synced recently, so the strain shown may be incomplete."
      );
      expectValidContract(result);
    });

    it("applies the sync gap at MAX_SYNC_GAP_MS since the cycle's last update", async () => {
      const updated = Date.parse(currentCycle.updated_at);
      const synced = await getToday(
        createMockClient(),
        new Date(updated + MAX_SYNC_GAP_MS - 60_000)
      );
      const unsynced = await getToday(
        createMockClient(),
        new Date(updated + MAX_SYNC_GAP_MS + 60_000)
      );

      expect(synced.data_quality.sources.cycle?.status).toBe("available");
      expect(synced.notes.join(" ")).not.toContain("may not have synced");
      expect(unsynced.strain?.day_strain).toBe(8.4);
      expect(unsynced.data_quality.sources.cycle?.status).toBe("stale");
      expect(unsynced.notes.join(" ")).toContain("may not have synced");
    });

    it("flags yesterday morning's sleep and recovery while the wake-up is not processed yet", async () => {
      // 07:40 local on 09-17: the user is awake, WHOOP has not processed the night yet,
      // so the 09-16 cycle is still open and its sleep/recovery are a day old.
      const result = await getToday(createMockClient(), new Date("2026-09-17T05:40:00.000Z"));

      expect(result.recovery).toMatchObject({ score: 72, user_calibrating: true });
      expect(result.sleep?.asleep_hours).toBe(6.5);
      expect(result.strain?.day_strain).toBe(8.4);
      expect(result.data_quality.sources.recovery?.status).toBe("stale");
      expect(result.data_quality.sources.sleep?.status).toBe("stale");
      expect(result.data_quality.sources.cycle?.status).toBe("available");
      expect(result.summary).toBe(
        "Recovery 72% (green, calibrating), 6.5h sleep, strain 8.4. recovery: stale, sleep: stale. No newer sleep processed since 2026-09-16 06:43 (UTC+02:00), so sleep and recovery are from that morning"
      );
      expect(result.notes).toContain(
        "No newer sleep has been processed since the sleep that ended 2026-09-16 06:43 (UTC+02:00), about 25 hours ago, so the sleep and recovery shown are from that morning, not from last night. If you have slept since then, WHOOP has not processed that sleep yet (or did not detect it); opening the WHOOP app to sync may help."
      );
      expect(result.notes.join(" ")).toContain("Recovery is still calibrating");
      expectValidContract(result);
    });

    it("flags the previous cycle's sleep and recovery before WHOOP creates today's cycle", async () => {
      // Live shape before processing: the 09-15 cycle is still open, the 09-16 sleep,
      // recovery and cycle do not exist yet. 07:40 local on 09-16.
      const result = await getToday(
        createMockClient({
          recovery: page([previousRecovery]),
          sleep: page([previousSleep]),
          cycle: page([{ ...previousCycle, end: null }, firstCycle]),
          workout: page([olderWorkout]),
        }),
        new Date("2026-09-16T05:40:00.000Z")
      );

      expect(result.recovery?.score).toBe(50);
      expect(result.strain?.day_strain).toBe(14.2);
      expect(result.data_quality.sources.recovery?.status).toBe("stale");
      expect(result.data_quality.sources.sleep?.status).toBe("stale");
      expect(result.notes.join(" ")).toContain(
        `${NO_NEWER_SLEEP} the sleep that ended 2026-09-15 08:09 (UTC+02:00), about 24 hours ago`
      );
      expect(result.summary).toContain("No newer sleep processed since 2026-09-15 08:09");
      expectValidContract(result);
    });

    it("dates the recovery by the cycle start when the sleep endpoint failed", async () => {
      const result = await getToday(
        createMockClient({ sleep: new WhoopApiError(503, "Unavailable", null) }),
        new Date("2026-09-17T05:40:00.000Z")
      );

      expect(result.recovery?.score).toBe(72);
      expect(result.data_quality.sources.recovery?.status).toBe("stale");
      expect(result.notes).toContain(
        "No newer sleep has been processed since the sleep that began 2026-09-15 23:13 (UTC+02:00), so the recovery shown is from that morning, not from last night. If you have slept since then, WHOOP has not processed that sleep yet (or did not detect it); opening the WHOOP app to sync may help."
      );
      expect(result.summary).toContain(
        "No newer sleep processed since the current cycle began, so recovery is from an earlier morning"
      );
      expectValidContract(result);
    });

    it("does not call a sleep that is still pending a day later last night's", async () => {
      const result = await getToday(
        createMockClient({
          sleep: page([{ ...currentSleep, score_state: "PENDING_SCORE", score: null }]),
        }),
        new Date("2026-09-17T05:40:00.000Z")
      );

      expect(result.recovery).toBeNull();
      expect(result.notes).toContain(
        "The latest recovery is held back until the latest sleep is scored."
      );
      expect(result.notes).toContain("The latest sleep is still being scored by WHOOP.");
      expect(result.notes.join(" ")).toContain(
        "so the sleep and recovery linked to the current cycle are from that morning"
      );
    });

    it("does not flag this morning's sleep at midday or just after local midnight", async () => {
      for (const now of [FIXED_NOW, new Date("2026-09-16T22:30:00.000Z")]) {
        const result = await getToday(createMockClient(), now);
        expect(result.notes.join(" ")).not.toContain(NO_NEWER_SLEEP);
        expect(result.summary).not.toContain("No newer sleep");
        expect(result.data_quality.sources.sleep?.status).toBe("available");
        expect(result.data_quality.sources.recovery?.status).toBe("calibrating");
      }
    });

    it("applies the stale-sleep threshold at STALE_SLEEP_MS after the sleep ended", async () => {
      const end = Date.parse(currentSleep.end);
      const fresh = await getToday(createMockClient(), new Date(end + STALE_SLEEP_MS - 60_000));
      const stale = await getToday(createMockClient(), new Date(end + STALE_SLEEP_MS + 60_000));

      expect(fresh.data_quality.sources.sleep?.status).toBe("available");
      expect(stale.data_quality.sources.sleep?.status).toBe("stale");
      expect(stale.sleep).not.toBeNull();
    });
  });

  describe("sleep and recovery joins", () => {
    it("joins last night's main sleep by cycle_id, skipping a newer nap in the same cycle", async () => {
      const result = await getToday(createMockClient());

      expect(result.sleep).toMatchObject({
        total_hours: 6.5,
        asleep_hours: 6.5,
        time_in_bed_hours: 7.5,
        rem_hours: 2,
        deep_hours: 1.5,
        light_hours: 3,
        awake_hours: 0.5,
        performance_pct: 85,
        efficiency_pct: 92,
        respiratory_rate: 15.2,
      });
      expect(result.data_quality.sources.sleep?.source_updated_at).toBe(currentSleep.updated_at);
    });

    it("does not substitute an older sleep when the current cycle has no main sleep yet", async () => {
      const result = await getToday(
        createMockClient({
          sleep: page([currentNap, previousSleep]),
          recovery: page([previousRecovery]),
        })
      );

      expect(result.sleep).toBeNull();
      expect(result.recovery).toBeNull();
      expect(result.strain?.day_strain).toBe(8.4);
      expect(result.data_quality.sources.sleep?.status).toBe("missing");
      expect(result.data_quality.sources.recovery?.status).toBe("missing");
      expect(result.notes).toContain("No main sleep is linked to the current cycle yet.");
      expect(result.notes).toContain("Today's recovery has not been recorded yet.");
    });

    it("does not show the previous cycle's recovery as today's", async () => {
      const result = await getToday(createMockClient({ recovery: page([previousRecovery]) }));

      expect(result.recovery).toBeNull();
      expect(result.sleep).not.toBeNull();
      expect(result.data_quality.sources.recovery?.status).toBe("missing");
    });

    it.each([
      { label: "mismatched sleep", recovery: { ...currentRecovery, sleep_id: "other" } },
      { label: "mismatched cycle", recovery: { ...currentRecovery, cycle_id: 999 } },
      { label: "another user", recovery: { ...currentRecovery, user_id: 7 } },
    ])("suppresses recovery for $label", async ({ recovery }) => {
      const result = await getToday(createMockClient({ recovery: page([recovery]) }));
      expect(result.recovery).toBeNull();
    });

    it("does not substitute older sleep when the newest main sleep has an invalid score", async () => {
      const result = await getToday(
        createMockClient({
          sleep: page([
            {
              ...currentSleep,
              id: "newest",
              end: "2026-09-16T05:00:00Z",
              score: { ...sleepScore, respiratory_rate: Number.NaN },
            },
            currentSleep,
          ]),
        })
      );
      expect(result.sleep).toBeNull();
      expect(result.recovery).toBeNull();
      expect(result.data_quality.sources.sleep?.status).toBe("invalid");
    });

    it("holds recovery back while the linked sleep is still pending", async () => {
      const result = await getToday(
        createMockClient({
          sleep: page([{ ...currentSleep, score_state: "PENDING_SCORE", score: null }]),
        })
      );

      expect(result.recovery).toBeNull();
      expect(result.sleep).toBeNull();
      expect(result.strain?.day_strain).toBe(8.4);
      expect(result.data_quality.sources.sleep?.status).toBe("pending");
      expect(result.data_quality.sources.recovery).toMatchObject({
        status: "pending",
        records_used: 0,
      });
      expect(result.notes).toContain(
        "Today's recovery is held back until last night's sleep is scored."
      );
      expectValidContract(result);
    });

    it("shows a scored recovery whose sleep WHOOP could not score", async () => {
      const result = await getToday(
        createMockClient({
          sleep: page([{ ...currentSleep, score_state: "UNSCORABLE", score: null }]),
        })
      );

      expect(result.recovery).toMatchObject({ score: 72, user_calibrating: true });
      expect(result.sleep).toBeNull();
      expect(result.data_quality.sources.sleep?.status).toBe("unscored");
      expect(result.data_quality.sources.recovery).toMatchObject({
        status: "calibrating",
        records_used: 1,
      });
      expect(result.summary).toBe("Recovery 72% (green, calibrating), strain 8.4. sleep: unscored");
      expect(result.notes).toContain(
        "Last night's sleep could not be scored by WHOOP, but WHOOP did score the recovery that follows it, so that recovery is shown."
      );
      expect(result.notes.join(" ")).not.toContain("held back");
      expectValidContract(result);
    });

    it("reports a pending recovery as pending with no score", async () => {
      const result = await getToday(
        createMockClient({
          recovery: page([{ ...currentRecovery, score_state: "PENDING_SCORE", score: null }]),
        })
      );

      expect(result.recovery).toBeNull();
      expect(result.data_quality.sources.recovery?.status).toBe("pending");
      expect(result.notes).toContain("Today's recovery is still being scored by WHOOP.");
      expect(result.summary).not.toContain("calibrating");
    });

    it("reports explicit and absent optional values as null", async () => {
      const result = await getToday(
        createMockClient({
          recovery: page([
            {
              ...currentRecovery,
              score: {
                ...currentRecovery.score!,
                spo2_percentage: null,
                skin_temp_celsius: undefined,
              },
            },
          ]),
          sleep: page([
            {
              ...currentSleep,
              score: {
                ...sleepScore,
                sleep_performance_percentage: undefined,
                respiratory_rate: null,
                sleep_efficiency_percentage: null,
              },
            },
          ]),
        })
      );

      expect(result.recovery).toMatchObject({ spo2_pct: null, skin_temp_celsius: null });
      expect(result.sleep).toMatchObject({
        performance_pct: null,
        efficiency_pct: null,
        respiratory_rate: null,
      });
      expectValidContract(result);
    });

    it("excludes today's recovery when its score is invalid and says so", async () => {
      const result = await getToday(
        createMockClient({
          recovery: page([
            { ...currentRecovery, score: { ...currentRecovery.score!, hrv_rmssd_milli: NaN } },
          ]),
        })
      );

      expect(result.recovery).toBeNull();
      expect(result.data_quality.sources.recovery).toMatchObject({
        status: "invalid",
        exclusions: { invalid: 1 },
      });
      expect(result.notes.join(" ")).toContain("could not be read");
    });
  });

  describe("calibrating users", () => {
    it("shows a calibrating recovery with an explicit flag, summary marker and note", async () => {
      const result = await getToday(createMockClient());

      expect(result.recovery?.user_calibrating).toBe(true);
      expect(result.summary).toBe("Recovery 72% (green, calibrating), 6.5h sleep, strain 8.4");
      expect(result.notes).toContain(
        "Recovery is still calibrating (2 scored nights so far): WHOOP needs more nights to learn your baselines, so treat this score as provisional."
      );
    });

    it("omits the night count when the recovery page is truncated", async () => {
      const result = await getToday(
        createMockClient({
          recovery: { records: [currentRecovery, previousRecovery], next_token: "more" },
        })
      );

      expect(result.data_quality.sources.recovery?.truncated).toBe(true);
      expect(result.notes.join(" ")).toContain("Recovery is still calibrating: WHOOP needs");
    });

    it("does not flag a calibrated recovery", async () => {
      const calibrated: Recovery = {
        ...currentRecovery,
        score: { ...currentRecovery.score!, user_calibrating: false },
      };
      const result = await getToday(createMockClient({ recovery: page([calibrated]) }));

      expect(result.recovery?.user_calibrating).toBe(false);
      expect(result.data_quality.sources.recovery?.status).toBe("available");
      expect(result.summary).toBe("Recovery 72% (green), 6.5h sleep, strain 8.4");
      expect(result.notes).toEqual([]);
    });

    it("returns what exists for a first-day user without a recovery yet", async () => {
      const result = await getToday(
        createMockClient({
          recovery: page([]),
          sleep: page([]),
          cycle: page([{ ...firstCycle, end: null }]),
          workout: page([]),
        }),
        new Date("2026-09-14T20:00:00.000Z")
      );

      expect(result.strain).toEqual({ day_strain: 3.1, energy_burned_kj: 600, last_workout: null });
      expect(result.sleep).toBeNull();
      expect(result.recovery).toBeNull();
      expect(result.summary).toBe(
        "strain 3.1. recovery: missing, sleep: missing, workout: missing"
      );
      expect(result.notes).toEqual([
        "Today's recovery has not been recorded yet.",
        "No main sleep is linked to the current cycle yet.",
        "No workouts have been recorded yet.",
      ]);
      expectValidContract(result);
    });

    it("explains an empty account instead of failing", async () => {
      const result = await getToday(
        createMockClient({
          recovery: page([]),
          sleep: page([]),
          cycle: page([]),
          workout: page([]),
        })
      );

      expect(result.summary).toBe(
        "No data available yet today. recovery: missing, sleep: missing, cycle: missing, workout: missing"
      );
      expect(result.notes).toContain(
        "Today's recovery is not available: there is no current cycle or sleep to link it to."
      );
      expect(result.data_quality.requested_period.start).toBe("2026-09-16T00:00:00.000Z");
      expectValidContract(result);
    });
  });

  describe("workouts", () => {
    it("accepts null distance/altitude fields and returns the true latest workout", async () => {
      const result = await getToday(
        createMockClient({ workout: page([olderWorkout, latestWorkout]) }) // wrong order on purpose
      );

      expect(result.strain?.last_workout).toEqual({
        sport_name: "Functional Fitness",
        strain: 12.5,
        occurred_at: latestWorkout.start,
        percent_recorded: 100,
      });
      expect(result.data_quality.sources.workout).toMatchObject({
        status: "available",
        records_fetched: 2,
        records_used: 1,
        exclusions: {},
        source_updated_at: latestWorkout.updated_at,
      });
    });

    it("does not replace an unreadable newest workout with an older one", async () => {
      const broken: Workout = {
        ...latestWorkout,
        score: { ...latestWorkout.score!, strain: 99 },
      };
      const result = await getToday(createMockClient({ workout: page([broken, olderWorkout]) }));

      expect(result.strain?.last_workout).toBeNull();
      expect(result.data_quality.sources.workout).toMatchObject({
        status: "invalid",
        exclusions: { invalid: 1 },
      });
    });

    it("notes when the latest workout happened before the current cycle", async () => {
      const result = await getToday(createMockClient({ workout: page([olderWorkout]) }));

      expect(result.strain?.last_workout?.occurred_at).toBe(olderWorkout.start);
      expect(result.notes).toContain(
        "The latest workout started 2026-09-15 17:00 (UTC+02:00), before the current cycle began, so it is not part of today's strain."
      );
    });

    it("returns null last_workout when no workouts exist", async () => {
      const result = await getToday(createMockClient({ workout: page([]) }));

      expect(result.strain).not.toBeNull();
      expect(result.strain!.last_workout).toBeNull();
    });

    it("returns null last_workout when the workout endpoint fails (but cycle succeeds)", async () => {
      const result = await getToday(
        createMockClient({ workout: new WhoopApiError(500, "Server Error", null) })
      );

      expect(result.strain).not.toBeNull();
      expect(result.strain!.last_workout).toBeNull();
      expect(result.data_quality.sources.workout?.status).toBe("fetch_failed");
      expect(result.notes[0]).toContain("Could not fetch workout data from WHOOP");
    });
  });

  describe("partial failures", () => {
    it("returns null recovery when the recovery endpoint fails", async () => {
      const result = await getToday(
        createMockClient({ recovery: new WhoopNetworkError(new Error("timeout")) })
      );

      expect(result.recovery).toBeNull();
      expect(result.sleep).not.toBeNull();
      expect(result.strain).not.toBeNull();
      expect(result.summary).toBe("6.5h sleep, strain 8.4. recovery: fetch_failed");
      expect(result.notes).toEqual([
        "Could not fetch recovery data from WHOOP (authorization, rate limit or network problem); those sections are unavailable, not empty.",
      ]);
    });

    it("keeps recovery linked by cycle when the sleep endpoint fails", async () => {
      const result = await getToday(
        createMockClient({ sleep: new WhoopApiError(503, "Unavailable", null) })
      );

      expect(result.sleep).toBeNull();
      expect(result.recovery?.score).toBe(72);
      expect(result.strain).not.toBeNull();
      expect(result.data_quality.sources.sleep?.status).toBe("fetch_failed");
    });

    it("links sleep and recovery without cycle data when the cycle endpoint fails", async () => {
      const result = await getToday(
        createMockClient({ cycle: new WhoopApiError(503, "Unavailable", null) })
      );

      expect(result.strain).toBeNull();
      expect(result.sleep).not.toBeNull();
      expect(result.recovery?.score).toBe(72);
      // Fallback window: today's local calendar day in the sleep's offset
      expect(result.data_quality.requested_period.start).toBe("2026-09-15T22:00:00.000Z");
      expectValidContract(result);
    });

    it("does not guess last night's sleep without cycle data once the local day has moved on", async () => {
      const result = await getToday(
        createMockClient({ cycle: new WhoopApiError(503, "Unavailable", null) }),
        new Date("2026-09-16T22:30:00.000Z") // 00:30 local on 09-17
      );

      expect(result.sleep).toBeNull();
      expect(result.recovery).toBeNull();
      expect(result.data_quality.sources.sleep?.status).toBe("stale");
      expect(result.notes).toContain(
        "Last night's sleep is not available: the latest main sleep ended 2026-09-16 06:43 (UTC+02:00)."
      );
    });

    it("does not summarize unverifiable recovery without sleep and cycle context", async () => {
      const result = await getToday(
        createMockClient({
          sleep: new WhoopAuthError(new Error("refresh failed")),
          cycle: new WhoopAuthError(new Error("refresh failed")),
          workout: new WhoopAuthError(new Error("refresh failed")),
        })
      );

      expect(result.recovery).toBeNull();
      expect(result.summary).toBe(
        "No data could be loaded from WHOOP right now. recovery: missing, sleep: fetch_failed, cycle: fetch_failed, workout: fetch_failed"
      );
      expect(result.notes[0]).toBe(
        "Could not fetch sleep, cycle, workout data from WHOOP (authorization, rate limit or network problem); those sections are unavailable, not empty."
      );
      expectValidContract(result);
    });

    it("flags truncated pages", async () => {
      const result = await getToday(
        createMockClient({ sleep: { records: [currentSleep], next_token: "more" } })
      );

      expect(result.data_quality.sources.sleep).toMatchObject({
        truncated: true,
        fetched_at: null,
        cache_status: "unknown",
      });
    });
  });

  describe("unscored records", () => {
    it("handles an unscored recovery (no score field)", async () => {
      const result = await getToday(
        createMockClient({
          recovery: page([{ ...currentRecovery, score_state: "UNSCORABLE", score: undefined }]),
        })
      );

      expect(result.recovery).toBeNull();
      expect(result.data_quality.sources.recovery?.status).toBe("unscored");
    });

    it("handles a pending sleep (no score field)", async () => {
      const result = await getToday(
        createMockClient({
          sleep: page([{ ...currentSleep, score_state: "PENDING_SCORE", score: undefined }]),
        })
      );

      expect(result.sleep).toBeNull();
      expect(result.notes).toContain("Last night's sleep is still being scored by WHOOP.");
    });

    it("handles a pending cycle (no score field)", async () => {
      const result = await getToday(
        createMockClient({
          cycle: page([{ ...currentCycle, score_state: "PENDING_SCORE", score: undefined }]),
        })
      );

      expect(result.strain).toBeNull();
      expect(result.data_quality.sources.cycle?.status).toBe("pending");
      // The recovery join only needs the cycle's identity, not its score
      expect(result.recovery?.score).toBe(72);
      expect(result.notes).toContain("Today's strain is still being scored by WHOOP.");
    });
  });

  describe("all primary endpoints fail", () => {
    it("rethrows a network error when every request failed at the network level", async () => {
      const network = new WhoopNetworkError(new Error("ECONNRESET"));
      const client = createMockClient({
        recovery: network,
        sleep: network,
        cycle: network,
        workout: network,
      });

      await expect(getToday(client)).rejects.toBe(network);
    });

    it("rethrows the auth error instead of reporting a network problem", async () => {
      const auth = new WhoopAuthError(new Error("refresh failed"));
      const client = createMockClient({
        recovery: new WhoopNetworkError(new Error("ECONNRESET")),
        sleep: auth,
        cycle: new WhoopApiError(429, "Too Many Requests", null),
        workout: page([latestWorkout]),
      });

      await expect(getToday(client)).rejects.toBe(auth);
    });

    it("prefers a rate-limit error over server and network errors", async () => {
      const rateLimit = new WhoopApiError(429, "Too Many Requests", null);
      const client = createMockClient({
        recovery: new WhoopApiError(500, "Server Error", null),
        sleep: new WhoopNetworkError(new Error("ECONNRESET")),
        cycle: rateLimit,
      });

      await expect(getToday(client)).rejects.toBe(rateLimit);
    });

    it("rethrows unknown errors unchanged rather than calling them network errors", async () => {
      const first = new Error("fail 1");
      const client = createMockClient({
        recovery: first,
        sleep: new Error("fail 2"),
        cycle: new Error("fail 3"),
        workout: new Error("fail 4"),
      });

      const error = await getToday(client).catch((caught: unknown) => caught);
      expect(error).toBe(first);
      expect(error).not.toBeInstanceOf(WhoopNetworkError);
    });
  });

  it("makes all API calls in parallel", async () => {
    const client = createMockClient();

    await getToday(client);

    const get = vi.mocked(client.get);
    expect(get).toHaveBeenCalledTimes(4);
    const paths = get.mock.calls.map(([path]) => path);
    for (const prefix of Object.values(PATHS)) {
      expect(paths.some((path) => path.startsWith(`${prefix}?limit=25`))).toBe(true);
    }
  });
});
