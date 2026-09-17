/**
 * Tests for get-today.ts — get_today composite tool.
 *
 * Fixtures follow the live WHOOP shape: a cycle starts at sleep onset (the
 * previous local evening), the current cycle has end: null, sleep and recovery
 * point at the cycle whose morning they belong to, records come newest-first,
 * next_token is null on the last page, and a new user is still calibrating.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { WhoopClient, WhoopFetchResult, WhoopGetOptions } from "../../src/api/client.js";
import {
  cacheKey,
  createWhoopClient,
  WhoopApiError,
  WhoopAuthError,
  WhoopNetworkError,
} from "../../src/api/client.js";
import { MemoryCache } from "../../src/cache/memory-cache.js";
import { CYCLE_TTL_MS } from "../../src/resources/index.js";
import { recoveryZone } from "../../src/tools/analytics-utils.js";
import {
  getToday,
  LONG_CYCLE_MS,
  MAX_SYNC_GAP_MS,
  STALE_SLEEP_MS,
  TODAY_LIST_PATHS,
} from "../../src/tools/get-today.js";
import { outputSchemas } from "../../src/tools/output-contracts.js";
import type { Recovery, Sleep, Cycle, Workout } from "../../src/api/types.js";
import { createWhoopFixtureClient } from "../helpers/whoop-fixture-client.js";
import { LIVE_SHAPED_IDS, liveShapedUser } from "../helpers/whoop-users.js";

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

    it("reports the current cycle as the requested period, in local time", async () => {
      const result = await getToday(createMockClient());

      expect(result.data_quality.requested_period).toEqual({
        start: "2026-09-15T23:13:31.460+02:00",
        end: "2026-09-16T12:00:00.000+02:00",
      });
      expect(result.data_quality.observed_period).toEqual({
        start: "2026-09-15T23:13:31.460+02:00",
        end: "2026-09-16T10:00:00.000+02:00",
      });
      expect(Date.parse(result.data_quality.requested_period.start)).toBe(
        Date.parse(CURRENT_CYCLE_START)
      );
      expect(Date.parse(result.data_quality.observed_period!.end)).toBe(
        Date.parse(latestWorkout.end)
      );
      expect(result.data_quality.method_version).toBe("today-5");
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
      expect(result.data_quality.requested_period.start).toBe("2026-09-15T00:39:47.770+02:00");
      expect(Date.parse(result.data_quality.requested_period.start)).toBe(
        Date.parse(PREVIOUS_CYCLE_START)
      );
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
      expect(result.data_quality.requested_period.start).toBe("2026-09-15T23:13:31.460+02:00");
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
        disturbances: 2,
        sleep_cycles: 4,
        no_data_hours: 0,
        // WHOOP reports 0 while calibrating: not a value
        consistency_pct: null,
        need_hours_including_debt: 8,
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
      expect(result.data_quality.requested_period.start).toBe("2026-09-16T00:00:00.000+02:00");
      expect(Date.parse(result.data_quality.requested_period.start)).toBe(
        Date.parse("2026-09-15T22:00:00.000Z")
      );
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

  describe("local time periods", () => {
    /** Every record of every list moved to `offset` (same instants). */
    function inOffset(offset: string, responses = liveResponses()): Required<Responses> {
      const move = (value: unknown): unknown => {
        const { records } = value as { records: Array<Record<string, unknown>> };
        return page(records.map((record) => ({ ...record, timezone_offset: offset })));
      };
      return {
        recovery: responses.recovery,
        sleep: move(responses.sleep),
        cycle: move(responses.cycle),
        workout: move(responses.workout),
      };
    }

    function expectSameInstants(
      periods: { start: string; end: string },
      expected: { start: string; end: string }
    ): void {
      expect(Date.parse(periods.start)).toBe(Date.parse(expected.start));
      expect(Date.parse(periods.end)).toBe(Date.parse(expected.end));
    }

    it("writes the cycle start 21:13:31.460Z as 23:13:31.460+02:00 and keeps UTC timestamps", async () => {
      const result = await getToday(createMockClient());
      const quality = result.data_quality;

      expect(quality.requested_period.start).toBe("2026-09-15T23:13:31.460+02:00");
      expect(quality.requested_period.end).toBe("2026-09-16T12:00:00.000+02:00");
      expectSameInstants(quality.requested_period, {
        start: CURRENT_CYCLE_START,
        end: FIXED_NOW.toISOString(),
      });
      expectSameInstants(quality.observed_period!, {
        start: CURRENT_CYCLE_START,
        end: latestWorkout.end,
      });
      expect(result.timestamp).toBe("2026-09-16T10:00:00.000Z");
      expect(quality.evaluated_at).toBe("2026-09-16T10:00:00.000Z");
      expectValidContract(result);
    });

    it("writes the same instants at -05:00", async () => {
      const result = await getToday(createMockClient(inOffset("-05:00")));
      const quality = result.data_quality;

      expect(quality.requested_period).toEqual({
        start: "2026-09-15T16:13:31.460-05:00",
        end: "2026-09-16T05:00:00.000-05:00",
      });
      expect(quality.observed_period).toEqual({
        start: "2026-09-15T16:13:31.460-05:00",
        end: "2026-09-16T03:00:00.000-05:00",
      });
      expectSameInstants(quality.requested_period, {
        start: CURRENT_CYCLE_START,
        end: FIXED_NOW.toISOString(),
      });
      expectSameInstants(quality.observed_period!, {
        start: CURRENT_CYCLE_START,
        end: latestWorkout.end,
      });
      expect(result.strain?.day_strain).toBe(8.4);
      expect(result.sleep?.asleep_hours).toBe(6.5);
    });

    it("uses local midnight in the latest sleep's offset without an open cycle", async () => {
      // Cycles stay at +02:00 and are closed; sleeps are at -05:00.
      const closed = page([{ ...currentCycle, end: "2026-09-16T09:00:00.000Z" }, previousCycle]);
      const result = await getToday(
        createMockClient({ ...inOffset("-05:00"), cycle: closed, workout: page([]) })
      );
      const quality = result.data_quality;

      // 10:00Z is 05:00 on 09-16 at -05:00
      expect(quality.requested_period).toEqual({
        start: "2026-09-16T00:00:00.000-05:00",
        end: "2026-09-16T05:00:00.000-05:00",
      });
      expectSameInstants(quality.requested_period, {
        start: "2026-09-16T05:00:00.000Z",
        end: FIXED_NOW.toISOString(),
      });
      // The latest sleep ended on 09-15 local, so nothing is shown.
      expect(quality.observed_period).toBeNull();
    });

    it("uses the latest cycle's offset when there is neither an open cycle nor a sleep", async () => {
      const closed = page([
        { ...currentCycle, end: "2026-09-16T09:00:00.000Z", timezone_offset: "+05:30" },
      ]);
      const result = await getToday(
        createMockClient({ cycle: closed, sleep: page([]), workout: page([]) })
      );

      expect(result.data_quality.requested_period).toEqual({
        start: "2026-09-16T00:00:00.000+05:30",
        end: "2026-09-16T15:30:00.000+05:30",
      });
    });

    it("writes each observed bound in its own record's offset", async () => {
      const workout = { ...latestWorkout, timezone_offset: "+01:00" };
      const result = await getToday(createMockClient({ workout: page([workout]) }));

      expect(result.data_quality.observed_period).toEqual({
        start: "2026-09-15T23:13:31.460+02:00",
        end: "2026-09-16T09:00:00.000+01:00",
      });
    });
  });

  describe("sleep and recovery detail", () => {
    it("adds the WHOOP sleep detail, zone and recorded percent on the live-shaped account", async () => {
      const data = liveShapedUser();
      vi.setSystemTime(data.now);
      const result = await getToday(createWhoopFixtureClient(data), data.now);

      const sleep = data.sleeps.find((record) => record.id === LIVE_SHAPED_IDS.sleeps.second)!;
      const need = sleep.score!.sleep_needed;
      const recovery = data.recoveries.find(
        (record) => record.cycle_id === LIVE_SHAPED_IDS.cycles.open
      )!;
      expect(result.sleep).toMatchObject({
        disturbances: sleep.score!.stage_summary.disturbance_count,
        sleep_cycles: sleep.score!.stage_summary.sleep_cycle_count,
        no_data_hours: 0,
        consistency_pct: null,
        need_hours_including_debt:
          Math.round(
            ((need.baseline_milli +
              need.need_from_sleep_debt_milli +
              need.need_from_recent_strain_milli +
              need.need_from_recent_nap_milli) /
              3_600_000) *
              10
          ) / 10,
      });
      expect(sleep.score!.sleep_consistency_percentage).toBe(0);
      expect(result.recovery).toMatchObject({
        user_calibrating: true,
        zone: recoveryZone(recovery.score!.recovery_score),
      });
      expect(result.strain?.last_workout).toMatchObject({
        sport_name: "running",
        percent_recorded: 100,
      });
      expect(result.data_quality.sources.sleep?.status).toBe("available");
      expect(result.data_quality.sources.recovery?.status).toBe("calibrating");
      expectValidContract(result);
    });

    it.each([
      { label: "a 0 while calibrating", consistency: 0, calibrating: true, expected: null },
      { label: "a 0 after calibration", consistency: 0, calibrating: false, expected: 0 },
      { label: "a value while calibrating", consistency: 85, calibrating: true, expected: 85 },
      { label: "no value", consistency: null, calibrating: false, expected: null },
    ])("reports consistency for $label", async ({ consistency, calibrating, expected }) => {
      const result = await getToday(
        createMockClient({
          sleep: page([
            {
              ...currentSleep,
              score: { ...sleepScore, sleep_consistency_percentage: consistency },
            },
          ]),
          recovery: page([
            {
              ...currentRecovery,
              score: { ...currentRecovery.score!, user_calibrating: calibrating },
            },
          ]),
        })
      );

      expect(result.sleep?.consistency_pct).toBe(expected);
      expectValidContract(result);
    });

    it("judges a 0 consistency by the newest scored recovery when today's is still pending", async () => {
      const result = await getToday(
        createMockClient({
          recovery: page([
            { ...currentRecovery, score_state: "PENDING_SCORE", score: null },
            previousRecovery,
          ]),
        })
      );

      expect(result.recovery).toBeNull();
      expect(result.sleep?.consistency_pct).toBeNull();
    });

    it("lowers the sleep need by a recent nap (WHOOP reports nap need as 0 or negative)", async () => {
      const result = await getToday(
        createMockClient({
          sleep: page([
            {
              ...currentSleep,
              score: {
                ...sleepScore,
                sleep_needed: {
                  baseline_milli: 28_800_000,
                  need_from_sleep_debt_milli: 2_700_000,
                  need_from_recent_strain_milli: 900_000,
                  need_from_recent_nap_milli: -1_800_000,
                },
                stage_summary: { ...sleepScore.stage_summary, total_no_data_time_milli: 540_000 },
              },
            },
          ]),
        })
      );

      // 8 + 0.75 + 0.25 - 0.5
      expect(result.sleep?.need_hours_including_debt).toBe(8.5);
      expect(result.sleep?.no_data_hours).toBe(0.2);
    });

    it.each([
      [33, "red"],
      [34, "yellow"],
      [66, "yellow"],
      [67, "green"],
    ] as const)("puts a recovery of %i in the %s zone", async (score, zone) => {
      const result = await getToday(
        createMockClient({
          recovery: page([
            { ...currentRecovery, score: { ...currentRecovery.score!, recovery_score: score } },
          ]),
        })
      );

      expect(result.recovery?.zone).toBe(zone);
      expect(result.summary).toContain(`Recovery ${score}% (${zone}, calibrating)`);
    });

    it("reports percent_recorded from a 0-1 fraction and from a percentage", async () => {
      for (const [value, expected] of [
        [0.99975777, 100],
        [0.87, 87],
        [1, 100],
        [87, 87],
      ] as const) {
        const workout = {
          ...latestWorkout,
          score: { ...latestWorkout.score!, percent_recorded: value },
        };
        const result = await getToday(createMockClient({ workout: page([workout]) }));
        expect(result.strain?.last_workout?.percent_recorded).toBe(expected);
      }
    });
  });

  describe("fetch metadata", () => {
    /** A mock client that also reports fetch metadata, recording every request's options. */
    function metaClient(
      meta: Partial<Record<keyof typeof PATHS, { fetchedAt: number; cacheStatus: "hit" | "miss" }>>
    ): WhoopClient & { requests: Array<[string, WhoopGetOptions | undefined]> } {
      const base = createMockClient();
      const requests: Array<[string, WhoopGetOptions | undefined]> = [];
      return {
        requests,
        get: base.get,
        async getWithMeta<T>(
          path: string,
          options?: WhoopGetOptions
        ): Promise<WhoopFetchResult<T>> {
          requests.push([path, options]);
          const data = await base.get<T>(path, options);
          const name = (Object.keys(PATHS) as Array<keyof typeof PATHS>).find((key) =>
            path.startsWith(PATHS[key])
          )!;
          const entry = meta[name] ?? { fetchedAt: FIXED_NOW.getTime(), cacheStatus: "miss" };
          return { data, fetchedAt: entry.fetchedAt, cacheStatus: entry.cacheStatus };
        },
      };
    }

    it("reports unknown fetch time and cache status for a client without metadata", async () => {
      const result = await getToday(createMockClient());

      for (const quality of Object.values(result.data_quality.sources)) {
        expect(quality).toMatchObject({ fetched_at: null, cache_status: "unknown" });
      }
      expect(result.data_quality.limitations).toContain(
        "Fetch time and cache status are not available from the client."
      );
    });

    it("reads all four lists with the cycle TTL and reports when each was fetched", async () => {
      const fetchedAt = FIXED_NOW.getTime() - 60_000;
      const client = metaClient({
        sleep: { fetchedAt, cacheStatus: "hit" },
        cycle: { fetchedAt, cacheStatus: "hit" },
      });
      const result = await getToday(client);

      expect(client.requests).toHaveLength(4);
      for (const [path, options] of client.requests) {
        expect(Object.values(TODAY_LIST_PATHS)).toContain(path);
        expect(options).toEqual({ cache: true, ttlMs: CYCLE_TTL_MS });
      }
      expect(result.data_quality.sources.sleep).toMatchObject({
        fetched_at: "2026-09-16T09:59:00.000Z",
        cache_status: "hit",
      });
      expect(result.data_quality.sources.recovery).toMatchObject({
        fetched_at: "2026-09-16T10:00:00.000Z",
        cache_status: "miss",
      });
      const limitations = result.data_quality.limitations.join(" ");
      expect(limitations).not.toContain("not available from the client");
      expect(limitations).toContain("fetched_at and cache_status per source");
      expect(vi.mocked(client.get)).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ refresh: true })
      );
    });

    it("does not re-read when the current cycle's sleep is in the cached list", async () => {
      const client = metaClient({
        sleep: { fetchedAt: FIXED_NOW.getTime() - 90_000, cacheStatus: "hit" },
        recovery: { fetchedAt: FIXED_NOW.getTime() - 90_000, cacheStatus: "hit" },
      });
      await getToday(client);

      expect(client.requests).toHaveLength(4);
    });

    it("marks a failed list as a cache miss without a fetch time", async () => {
      const base = metaClient({});
      const client: WhoopClient = {
        get: base.get,
        async getWithMeta<T>(path: string, options?: WhoopGetOptions) {
          if (path.startsWith(PATHS.workout)) throw new WhoopApiError(503, "Unavailable", null);
          return base.getWithMeta!<T>(path, options);
        },
      };
      const result = await getToday(client);

      expect(result.data_quality.sources.workout).toMatchObject({
        status: "fetch_failed",
        fetched_at: null,
        cache_status: "miss",
      });
    });
  });

  describe("cache desync between the cycle, sleep and recovery lists (real client and cache)", () => {
    const MINUTE = 60_000;

    /** Before the morning sync: the previous cycle is still open. */
    function preSync(): Required<Responses> {
      return {
        recovery: page([previousRecovery]),
        sleep: page([previousSleep]),
        cycle: page([{ ...previousCycle, end: null }, firstCycle]),
        workout: page([olderWorkout]),
      };
    }

    type ListName = keyof typeof PATHS;

    interface Harness {
      client: WhoopClient;
      cache: MemoryCache;
      state: { synced: Set<ListName>; failing: Set<ListName> };
      counts: Record<ListName, number>;
      syncAll(): void;
      reset(): void;
    }

    function harness(cacheOptions: { maxEntries?: number } = {}): Harness {
      const state = {
        synced: new Set<ListName>(),
        failing: new Set<ListName>(),
      };
      const counts: Record<ListName, number> = { recovery: 0, sleep: 0, cycle: 0, workout: 0 };
      vi.stubGlobal(
        "fetch",
        vi.fn((input: string | URL) => {
          const url = new URL(String(input));
          const name = (Object.keys(PATHS) as ListName[]).find(
            (key) => url.pathname === PATHS[key]
          )!;
          counts[name] += 1;
          if (state.failing.has(name)) {
            return Promise.resolve(new Response("{}", { status: 503, statusText: "Unavailable" }));
          }
          const body = state.synced.has(name) ? liveResponses()[name] : preSync()[name];
          return Promise.resolve(
            new Response(JSON.stringify(body), {
              status: 200,
              headers: { "content-type": "application/json" },
            })
          );
        })
      );
      const cache = new MemoryCache(cacheOptions);
      const client = createWhoopClient({
        accessToken: "test-token",
        baseUrl: "https://api.test",
        cache,
      });
      const syncAll = (): void => {
        for (const name of Object.keys(PATHS) as ListName[]) state.synced.add(name);
      };
      const reset = (): void => {
        for (const name of Object.keys(counts) as ListName[]) counts[name] = 0;
      };
      return { client, cache, state, counts, syncAll, reset };
    }

    function at(offsetMs: number): Date {
      vi.setSystemTime(FIXED_NOW.getTime() + offsetMs);
      return new Date(FIXED_NOW.getTime() + offsetMs);
    }

    const listKey = (name: ListName): string => cacheKey(TODAY_LIST_PATHS[name]);

    function expectToday(result: Awaited<ReturnType<typeof getToday>>): void {
      expect(result.strain?.day_strain).toBe(8.4);
      expect(result.sleep?.asleep_hours).toBe(6.5);
      expect(result.recovery?.score).toBe(72);
      expect(result.data_quality.sources.sleep).toMatchObject({
        status: "available",
        cache_status: "miss",
      });
      expect(result.notes.join(" ")).not.toContain("No main sleep is linked");
      expectValidContract(result);
    }

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("re-reads sleep and recovery cached before a new cycle appeared (earlier partial failure)", async () => {
      const h = harness();
      // T: the sleep and recovery requests fail, so only the cycle and workout lists are cached.
      h.state.failing.add("sleep").add("recovery");
      await getToday(h.client, at(0));
      // T+1.5 min: sleep and recovery are read (before the sync) and cached.
      h.state.failing.clear();
      await getToday(h.client, at(1.5 * MINUTE));
      // The strap syncs; at T+3 min the cycle entry has expired, sleep and recovery have not.
      h.syncAll();
      h.reset();
      const result = await getToday(h.client, at(3 * MINUTE));

      expectToday(result);
      expect(h.counts).toEqual({ recovery: 1, sleep: 1, cycle: 1, workout: 1 });
      expect(result.data_quality.sources.cycle?.cache_status).toBe("miss");

      // Without fetch metadata the same timeline shows the stale pairing.
      const control = harness();
      control.state.failing.add("sleep").add("recovery");
      const plain: WhoopClient = { get: control.client.get.bind(control.client) };
      await getToday(plain, at(0));
      control.state.failing.clear();
      await getToday(plain, at(1.5 * MINUTE));
      control.syncAll();
      const stale = await getToday(plain, at(3 * MINUTE));
      expect(stale.sleep).toBeNull();
      expect(stale.notes).toContain("No main sleep is linked to the current cycle yet.");
    });

    it("re-reads them when the cycle entry was evicted from the LRU cache", async () => {
      const h = harness({ maxEntries: 4 });
      await getToday(h.client, at(0));
      // The cycle list becomes the least recently used entry and is evicted.
      for (const name of ["recovery", "sleep", "workout"] as const) h.cache.get(listKey(name));
      h.cache.set("GET:/v2/user/profile/basic", {});
      expect(h.cache.has(listKey("cycle"))).toBe(false);
      expect(h.cache.has(listKey("sleep"))).toBe(true);

      h.syncAll();
      h.reset();
      const result = await getToday(h.client, at(MINUTE));

      expectToday(result);
      expect(h.counts.sleep).toBe(1);
      expect(h.counts.recovery).toBe(1);
      expect(h.counts.workout).toBe(0);
    });

    it("re-reads them after a webhook-style invalidation of the cycle prefix only", async () => {
      const h = harness();
      await getToday(h.client, at(0));
      h.syncAll();
      h.cache.deleteWhere((key) => key.startsWith("GET:/v2/cycle"));
      h.reset();

      const result = await getToday(h.client, at(MINUTE));

      expectToday(result);
      expect(h.counts).toEqual({ recovery: 1, sleep: 1, cycle: 1, workout: 0 });
    });

    it("re-reads when only the recovery list predates the new cycle", async () => {
      const h = harness();
      await getToday(h.client, at(0));
      h.syncAll();
      h.cache.deleteWhere((key) => key.startsWith("GET:/v2/cycle") || key.includes("/sleep"));
      h.reset();

      const result = await getToday(h.client, at(MINUTE));

      expectToday(result);
      expect(h.counts).toEqual({ recovery: 1, sleep: 1, cycle: 1, workout: 0 });
    });

    it("re-reads at most once per call, and not again once the lists are newer than the cycle", async () => {
      const h = harness();
      await getToday(h.client, at(0));
      // Only the cycle has synced: WHOOP has not processed last night's sleep yet.
      h.state.synced.add("cycle");
      h.cache.deleteWhere((key) => key.startsWith("GET:/v2/cycle"));
      h.reset();

      const first = await getToday(h.client, at(MINUTE));
      expect(first.sleep).toBeNull();
      expect(first.notes).toContain("No main sleep is linked to the current cycle yet.");
      expect(h.counts).toEqual({ recovery: 1, sleep: 1, cycle: 1, workout: 0 });

      h.reset();
      const second = await getToday(h.client, at(1.2 * MINUTE));
      expect(second.sleep).toBeNull();
      expect(h.counts).toEqual({ recovery: 0, sleep: 0, cycle: 0, workout: 0 });
    });

    it("makes no extra requests when the cached lists are in step", async () => {
      const h = harness();
      h.syncAll();
      await getToday(h.client, at(0));
      h.reset();

      const result = await getToday(h.client, at(MINUTE));

      expect(h.counts).toEqual({ recovery: 0, sleep: 0, cycle: 0, workout: 0 });
      expect(result.data_quality.sources.sleep?.cache_status).toBe("hit");
      expect(result.data_quality.sources.sleep?.fetched_at).toBe(FIXED_NOW.toISOString());
    });

    it("keeps the cached lists and says so when the re-read fails", async () => {
      const h = harness();
      await getToday(h.client, at(0));
      h.syncAll();
      h.state.failing.add("sleep");
      h.cache.deleteWhere((key) => key.startsWith("GET:/v2/cycle"));

      const result = await getToday(h.client, at(MINUTE));

      expect(result.sleep).toBeNull();
      expect(result.data_quality.sources.sleep?.status).not.toBe("fetch_failed");
      expect(result.notes).toContain(
        "WHOOP has a newer cycle than the cached sleep and recovery lists, and they could not be read again right now, so the sleep and recovery shown may not include the latest ones yet."
      );
      expectValidContract(result);
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
