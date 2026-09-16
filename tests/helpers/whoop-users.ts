/**
 * Deterministic WHOOP users for tests: record shapes verified against the live
 * API, values synthetic.
 *
 * Shape facts every user honours (live-verified):
 * - A cycle starts at sleep onset and consecutive cycles share the exact
 *   boundary string (cycle.end === next.start); the newest cycle is open
 *   (end null). A strap-off gap ends a cycle without a following cycle.
 * - A main sleep starts exactly at its cycle's start; total_in_bed_time_milli
 *   === end − start; light + slow-wave + REM + awake + no-data === in bed.
 * - need_from_recent_nap_milli is 0 or negative.
 * - Workout percent_recorded is a 0-1 fraction and the zone durations sum to
 *   duration × fraction (rounded to the millisecond); GPS fields are explicit
 *   nulls except for GPS sports; running has sport_id 0.
 * - Optional fields are explicit nulls (v1_id, next_token, GPS, …), records are
 *   returned newest first, and key order follows the live payloads.
 *
 * Every function is pure: the same options always give deep-equal output.
 * Records created after `now` are left out, a cycle that ends after `now` is
 * returned open, and an updated_at after `now` falls back to created_at, so a
 * fixture can be viewed "as of" an earlier instant (score values are not
 * rewound).
 */

import type {
  BodyMeasurement,
  Cycle,
  Recovery,
  Sleep,
  UserProfile,
  Workout,
  ZoneDurations,
} from "../../src/api/types.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** A complete WHOOP account snapshot. Collections are newest first. */
export interface WhoopUserFixture {
  /** The instant the fixture describes; pass it to vi.setSystemTime. */
  now: Date;
  /** The user's UTC offset at `now`. */
  offset: string;
  profile: UserProfile;
  body: BodyMeasurement;
  cycles: Cycle[];
  sleeps: Sleep[];
  recoveries: Recovery[];
  workouts: Workout[];
}

// ---------------------------------------------------------------------------
// Time and randomness helpers
// ---------------------------------------------------------------------------

/** Minutes east of UTC for "Z", "+HH:MM" or "-HH:MM". */
export function offsetMinutes(offset: string): number {
  if (offset === "Z") return 0;
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
  if (!match) throw new RangeError(`Invalid UTC offset: ${offset}`);
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

/** "+HH:MM" / "-HH:MM" for minutes east of UTC. */
export function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const absolute = Math.abs(minutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, "0");
  return `${sign}${hours}:${String(absolute % 60).padStart(2, "0")}`;
}

function toMs(value: string | Date): number {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ms)) throw new RangeError(`Invalid instant: ${String(value)}`);
  return ms;
}

const iso = (ms: number): string => new Date(ms).toISOString();

function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The instant of `minuteOfDay` minutes after local midnight of `day` in `offset`. */
function localMs(day: string, minuteOfDay: number, offset: string): number {
  return (
    Date.parse(`${day}T00:00:00.000Z`) + minuteOfDay * MINUTE_MS - offsetMinutes(offset) * MINUTE_MS
  );
}

function localDate(ms: number, offset: string): string {
  return new Date(ms + offsetMinutes(offset) * MINUTE_MS).toISOString().slice(0, 10);
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** A 32-bit FNV-1a hash of the parts, used to seed independent random streams. */
export function hashSeed(...parts: Array<string | number>): number {
  let hash = 0x811c9dc5;
  for (const part of parts) {
    const text = `${String(part)}|`;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return hash >>> 0;
}

/** A deterministic linear congruential generator returning values in [0, 1). */
export function createLcg(seed: number): () => number {
  let state = seed >>> 0;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  next();
  next();
  return next;
}

/** A deterministic RFC 4122 version-4-shaped UUID for the given parts. */
export function fixtureUuid(...parts: Array<string | number>): string {
  const random = createLcg(hashSeed("uuid", ...parts));
  let hex = "";
  while (hex.length < 32) {
    hex += Math.floor(random() * 0x10000)
      .toString(16)
      .padStart(4, "0");
  }
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  hex = `${hex.slice(0, 12)}4${hex.slice(13, 16)}${variant}${hex.slice(17, 32)}`;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// ---------------------------------------------------------------------------
// Record builders (key order follows the live payloads)
// ---------------------------------------------------------------------------

interface CycleInput {
  id: number;
  userId: number;
  createdAt: string;
  updatedAt: string;
  start: string;
  end: string | null;
  offset: string;
  score: { strain: number; kilojoule: number; average_heart_rate: number; max_heart_rate: number };
}

function cycleRecord(input: CycleInput): Cycle {
  return {
    user_id: input.userId,
    created_at: input.createdAt,
    updated_at: input.updatedAt,
    score_state: "SCORED",
    start: input.start,
    end: input.end,
    timezone_offset: input.offset,
    id: input.id,
    score: { ...input.score },
  };
}

interface SleepInput {
  id: string;
  cycleId: number;
  userId: number;
  createdAt: string;
  updatedAt: string;
  start: string;
  end: string;
  offset: string;
  nap: boolean;
  /** Null for a PENDING_SCORE sleep. */
  score: {
    awake: number;
    noData: number;
    light: number;
    slowWave: number;
    cycles: number;
    disturbances: number;
    baseline: number;
    debt: number;
    strain: number;
    /** 0 or negative */
    nap: number;
    respiratoryRate: number | null;
    performance: number | null;
    efficiency: number | null;
    consistency: number | null;
  } | null;
}

/** A sleep whose in-bed time is end − start and whose REM time completes the stage sum. */
function sleepRecord(input: SleepInput): Sleep {
  const inBed = Date.parse(input.end) - Date.parse(input.start);
  const score = input.score;
  return {
    user_id: input.userId,
    created_at: input.createdAt,
    updated_at: input.updatedAt,
    score_state: score ? "SCORED" : "PENDING_SCORE",
    start: input.start,
    end: input.end,
    timezone_offset: input.offset,
    id: input.id,
    cycle_id: input.cycleId,
    nap: input.nap,
    v1_id: null,
    score: score
      ? {
          stage_summary: {
            total_in_bed_time_milli: inBed,
            total_awake_time_milli: score.awake,
            total_no_data_time_milli: score.noData,
            total_light_sleep_time_milli: score.light,
            total_slow_wave_sleep_time_milli: score.slowWave,
            total_rem_sleep_time_milli:
              inBed - score.awake - score.noData - score.light - score.slowWave,
            sleep_cycle_count: score.cycles,
            disturbance_count: score.disturbances,
          },
          sleep_needed: {
            baseline_milli: score.baseline,
            need_from_sleep_debt_milli: score.debt,
            need_from_recent_strain_milli: score.strain,
            need_from_recent_nap_milli: score.nap,
          },
          respiratory_rate: score.respiratoryRate,
          sleep_performance_percentage: score.performance,
          sleep_efficiency_percentage: score.efficiency,
          sleep_consistency_percentage: score.consistency,
        }
      : null,
  };
}

interface RecoveryInput {
  cycleId: number;
  sleepId: string;
  userId: number;
  createdAt: string;
  updatedAt: string;
  /** Null for a PENDING_SCORE recovery. */
  score: {
    calibrating: boolean;
    recovery: number;
    rhr: number;
    hrv: number;
    spo2: number | null;
    skinTemp: number | null;
  } | null;
}

function recoveryRecord(input: RecoveryInput): Recovery {
  const score = input.score;
  return {
    user_id: input.userId,
    created_at: input.createdAt,
    updated_at: input.updatedAt,
    score_state: score ? "SCORED" : "PENDING_SCORE",
    cycle_id: input.cycleId,
    sleep_id: input.sleepId,
    score: score
      ? {
          user_calibrating: score.calibrating,
          recovery_score: score.recovery,
          resting_heart_rate: score.rhr,
          hrv_rmssd_milli: score.hrv,
          spo2_percentage: score.spo2,
          skin_temp_celsius: score.skinTemp,
        }
      : null,
  };
}

/** Sport names and (deprecated) sport ids as the live API reports them. */
export const SPORT_IDS = {
  running: 0,
  cycling: 1,
  walking: 63,
  weightlifting_msk: 123,
  padel: 249,
} as const;

export type FixtureSport = keyof typeof SPORT_IDS;

/** Sports that carry GPS distance and altitude. */
const GPS_SPORTS: ReadonlySet<FixtureSport> = new Set(["running", "cycling"]);

interface WorkoutInput {
  id: string;
  userId: number;
  createdAt: string;
  updatedAt: string;
  start: string;
  end: string;
  offset: string;
  sport: FixtureSport;
  strain: number;
  averageHeartRate: number;
  maxHeartRate: number;
  kilojoule: number;
  percentRecorded: number;
  /** Zone 1-5 milliseconds; zone 0 completes duration × percent_recorded. */
  zones: [number, number, number, number, number];
  gps: { distance: number; altitudeGain: number; altitudeChange: number } | null;
}

function workoutRecord(input: WorkoutInput): Workout {
  const duration = Date.parse(input.end) - Date.parse(input.start);
  const recorded = Math.round(duration * input.percentRecorded);
  const [one, two, three, four, five] = input.zones;
  const zoneZero = recorded - one - two - three - four - five;
  if (zoneZero < 0) throw new RangeError(`Zone durations exceed the recorded time of ${input.id}`);
  const zones: ZoneDurations = {
    zone_zero_milli: zoneZero,
    zone_one_milli: one,
    zone_two_milli: two,
    zone_three_milli: three,
    zone_four_milli: four,
    zone_five_milli: five,
  };
  return {
    user_id: input.userId,
    created_at: input.createdAt,
    updated_at: input.updatedAt,
    score_state: "SCORED",
    start: input.start,
    end: input.end,
    timezone_offset: input.offset,
    id: input.id,
    sport_name: input.sport,
    sport_id: SPORT_IDS[input.sport],
    v1_id: null,
    score: {
      strain: input.strain,
      average_heart_rate: input.averageHeartRate,
      max_heart_rate: input.maxHeartRate,
      kilojoule: input.kilojoule,
      percent_recorded: input.percentRecorded,
      zone_durations: zones,
      distance_meter: input.gps?.distance ?? null,
      altitude_gain_meter: input.gps?.altitudeGain ?? null,
      altitude_change_meter: input.gps?.altitudeChange ?? null,
    },
  };
}

/**
 * The fixture as of `nowMs`: records created later are dropped, a cycle ending
 * later is open, an update later than `nowMs` has not happened yet (updated_at
 * falls back to created_at), and every collection is sorted newest first.
 */
function asOf(fixture: WhoopUserFixture, nowMs: number): WhoopUserFixture {
  const created = (record: { created_at: string }): boolean =>
    Date.parse(record.created_at) <= nowMs;
  const ended = (record: { end: string }): boolean => Date.parse(record.end) <= nowMs;
  const notUpdatedLater = <T extends { created_at: string; updated_at: string }>(record: T): T =>
    Date.parse(record.updated_at) > nowMs ? { ...record, updated_at: record.created_at } : record;
  const newestStart = (left: { start: string }, right: { start: string }): number =>
    Date.parse(right.start) - Date.parse(left.start);
  return {
    ...fixture,
    cycles: fixture.cycles
      .filter((cycle) => created(cycle) && Date.parse(cycle.start) <= nowMs)
      .map((cycle) =>
        cycle.end !== null && cycle.end !== undefined && Date.parse(cycle.end) > nowMs
          ? { ...cycle, end: null }
          : cycle
      )
      .map(notUpdatedLater)
      .sort(newestStart),
    sleeps: fixture.sleeps
      .filter((sleep) => created(sleep) && ended(sleep))
      .map(notUpdatedLater)
      .sort(newestStart),
    recoveries: fixture.recoveries
      .filter(created)
      .map(notUpdatedLater)
      .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at)),
    workouts: fixture.workouts
      .filter((workout) => created(workout) && ended(workout))
      .map(notUpdatedLater)
      .sort(newestStart),
  };
}

// ---------------------------------------------------------------------------
// liveShapedUser
// ---------------------------------------------------------------------------

/** Default evaluation instant of {@link liveShapedUser}: 23:30 local on its third day. */
export const LIVE_SHAPED_NOW = "2026-09-16T23:30:00+02:00";

/** The live-shaped user's UTC offset. */
export const LIVE_SHAPED_OFFSET = "+02:00";

/** Ids of the live-shaped user's records, for tests that look records up. */
export const LIVE_SHAPED_IDS = {
  userId: 7001,
  /** 09-14 partial first day (starts 00:00 local), 09-15 (00:39 onset), 09-16 (open) */
  cycles: { firstDay: 81001, afterMidnightOnset: 81002, open: 81003 },
  sleeps: {
    /** 00:39 → 07:21 local on 09-15, cycle 81002 */
    first: "6f1d2c3b-4a59-4e68-9b7c-0d1e2f3a4b01",
    /** 23:13 on 09-15 → 06:58 local on 09-16, cycle 81003 */
    second: "6f1d2c3b-4a59-4e68-9b7c-0d1e2f3a4b02",
  },
  workouts: {
    /** 09-14 23:17 local walk (before the 00:39 onset) */
    lateWalk: "a3c5e7f9-1b2d-4f60-8a1c-3e5f7a9b0c01",
    /** 09-15 07:52 local GPS run, sport_id 0 */
    morningRun: "a3c5e7f9-1b2d-4f60-8a1c-3e5f7a9b0c02",
    middayWalk: "a3c5e7f9-1b2d-4f60-8a1c-3e5f7a9b0c03",
    weightliftingDay2: "a3c5e7f9-1b2d-4f60-8a1c-3e5f7a9b0c04",
    padel: "a3c5e7f9-1b2d-4f60-8a1c-3e5f7a9b0c05",
    /** 09-16 whole-second timestamps, updated_at hours after created_at */
    manualWalk: "a3c5e7f9-1b2d-4f60-8a1c-3e5f7a9b0c06",
    weightliftingDay3: "a3c5e7f9-1b2d-4f60-8a1c-3e5f7a9b0c07",
    /** 09-16 19:26 local GPS run, percent_recorded 0.99975777 */
    eveningRun: "a3c5e7f9-1b2d-4f60-8a1c-3e5f7a9b0c08",
  },
} as const;

/**
 * The verified live mix of a new, calibrating +02:00 account (values synthetic):
 * - 3 cycles: 09-14 starting exactly 00:00 local (partial first day), 09-15
 *   starting 00:39 local (sleep onset after midnight), 09-16 open.
 * - 2 SCORED main sleeps (consistency 0, nap need 0) and 2 SCORED recoveries,
 *   both calibrating, with numeric SpO2 and skin temperature.
 * - 8 workouts: 2 GPS runs (sport_id 0), 3 walks (one manual-shaped), 2
 *   weightlifting_msk, 1 padel. percent_recorded is 1 except the evening run
 *   (0.99975777).
 */
export function liveShapedUser(options: { now?: string | Date } = {}): WhoopUserFixture {
  const nowMs = toMs(options.now ?? LIVE_SHAPED_NOW);
  const { userId, cycles, sleeps, workouts } = LIVE_SHAPED_IDS;
  const offset = LIVE_SHAPED_OFFSET;

  const cycleRecords: Cycle[] = [
    cycleRecord({
      id: cycles.firstDay,
      userId,
      createdAt: "2026-09-14T06:12:40.331Z",
      updatedAt: "2026-09-15T05:25:01.113Z",
      start: "2026-09-13T22:00:00.000Z",
      end: "2026-09-14T22:39:27.317Z",
      offset,
      score: { strain: 9.4217, kilojoule: 8914.6, average_heart_rate: 69, max_heart_rate: 158 },
    }),
    cycleRecord({
      id: cycles.afterMidnightOnset,
      userId,
      createdAt: "2026-09-15T05:25:01.113Z",
      updatedAt: "2026-09-16T05:01:34.745Z",
      start: "2026-09-14T22:39:27.317Z",
      end: "2026-09-15T21:13:31.460Z",
      offset,
      score: { strain: 15.8836, kilojoule: 13602.3, average_heart_rate: 77, max_heart_rate: 181 },
    }),
    cycleRecord({
      id: cycles.open,
      userId,
      createdAt: "2026-09-16T05:01:34.745Z",
      updatedAt: "2026-09-16T18:16:02.337Z",
      start: "2026-09-15T21:13:31.460Z",
      end: null,
      offset,
      score: { strain: 13.0542, kilojoule: 10187.9, average_heart_rate: 73, max_heart_rate: 179 },
    }),
  ];

  const sleepRecords: Sleep[] = [
    sleepRecord({
      id: sleeps.first,
      cycleId: cycles.afterMidnightOnset,
      userId,
      createdAt: "2026-09-15T05:25:06.590Z",
      updatedAt: "2026-09-15T05:25:06.590Z",
      start: "2026-09-14T22:39:27.317Z",
      end: "2026-09-15T05:21:48.905Z",
      offset,
      nap: false,
      score: {
        awake: 2_011_340,
        noData: 0,
        light: 11_208_407,
        slowWave: 4_902_115,
        cycles: 4,
        disturbances: 11,
        baseline: 27_904_512,
        debt: 0,
        strain: 1_322_871,
        nap: 0,
        respiratoryRate: 14.765625,
        performance: 71,
        efficiency: 91.67,
        consistency: 0,
      },
    }),
    sleepRecord({
      id: sleeps.second,
      cycleId: cycles.open,
      userId,
      createdAt: "2026-09-16T05:01:40.207Z",
      updatedAt: "2026-09-16T05:01:40.207Z",
      start: "2026-09-15T21:13:31.460Z",
      end: "2026-09-16T04:58:12.066Z",
      offset,
      nap: false,
      score: {
        awake: 2_305_114,
        noData: 0,
        light: 12_410_833,
        slowWave: 4_977_291,
        cycles: 5,
        disturbances: 14,
        baseline: 27_904_512,
        debt: 2_108_337,
        strain: 3_402_118,
        nap: 0,
        respiratoryRate: 15.234375,
        performance: 83,
        efficiency: 91.73,
        consistency: 0,
      },
    }),
  ];

  const recoveryRecords: Recovery[] = [
    recoveryRecord({
      cycleId: cycles.afterMidnightOnset,
      sleepId: sleeps.first,
      userId,
      createdAt: "2026-09-15T05:25:06.590Z",
      updatedAt: "2026-09-15T05:25:06.590Z",
      score: {
        calibrating: true,
        recovery: 58,
        rhr: 61,
        hrv: 71.431,
        spo2: 96.25,
        skinTemp: 33.618,
      },
    }),
    recoveryRecord({
      cycleId: cycles.open,
      sleepId: sleeps.second,
      userId,
      createdAt: "2026-09-16T05:01:40.207Z",
      updatedAt: "2026-09-16T05:01:40.207Z",
      score: {
        calibrating: true,
        recovery: 67,
        rhr: 58,
        hrv: 84.907,
        spo2: 95.8,
        skinTemp: 33.871,
      },
    }),
  ];

  const workoutRecords: Workout[] = [
    workoutRecord({
      id: workouts.lateWalk,
      userId,
      createdAt: "2026-09-14T21:43:52.004Z",
      updatedAt: "2026-09-14T21:43:55.618Z",
      start: "2026-09-14T21:17:43.512Z",
      end: "2026-09-14T21:41:09.228Z",
      offset,
      sport: "walking",
      strain: 3.1062,
      averageHeartRate: 98,
      maxHeartRate: 121,
      kilojoule: 412.73,
      percentRecorded: 1,
      zones: [811_450, 192_153, 0, 0, 0],
      gps: null,
    }),
    workoutRecord({
      id: workouts.morningRun,
      userId,
      createdAt: "2026-09-15T06:36:21.447Z",
      updatedAt: "2026-09-15T06:36:24.902Z",
      start: "2026-09-15T05:52:10.084Z",
      end: "2026-09-15T06:33:55.690Z",
      offset,
      sport: "running",
      strain: 11.9384,
      averageHeartRate: 152,
      maxHeartRate: 177,
      kilojoule: 2011.42,
      percentRecorded: 1,
      zones: [121_904, 402_221, 1_110_337, 701_506, 139_526],
      gps: { distance: 7412.6, altitudeGain: 61.3, altitudeChange: 2.4 },
    }),
    workoutRecord({
      id: workouts.middayWalk,
      userId,
      createdAt: "2026-09-15T11:08:30.772Z",
      updatedAt: "2026-09-15T11:08:33.019Z",
      start: "2026-09-15T10:31:22.940Z",
      end: "2026-09-15T11:05:48.105Z",
      offset,
      sport: "walking",
      strain: 4.4127,
      averageHeartRate: 103,
      maxHeartRate: 128,
      kilojoule: 603.18,
      percentRecorded: 1,
      zones: [1_214_440, 239_723, 0, 0, 0],
      gps: null,
    }),
    workoutRecord({
      id: workouts.weightliftingDay2,
      userId,
      createdAt: "2026-09-15T16:45:11.260Z",
      updatedAt: "2026-09-15T16:45:14.583Z",
      start: "2026-09-15T15:40:05.331Z",
      end: "2026-09-15T16:42:51.874Z",
      offset,
      sport: "weightlifting_msk",
      strain: 8.7215,
      averageHeartRate: 118,
      maxHeartRate: 164,
      kilojoule: 1288.51,
      percentRecorded: 1,
      zones: [1_504_227, 1_301_889, 488_105, 70_006, 0],
      gps: null,
    }),
    workoutRecord({
      id: workouts.padel,
      userId,
      createdAt: "2026-09-15T19:37:02.845Z",
      updatedAt: "2026-09-15T19:37:06.114Z",
      start: "2026-09-15T18:05:17.402Z",
      end: "2026-09-15T19:34:40.019Z",
      offset,
      sport: "padel",
      strain: 12.6093,
      averageHeartRate: 136,
      maxHeartRate: 181,
      kilojoule: 2544.87,
      percentRecorded: 1,
      zones: [900_331, 1_803_776, 1_660_209, 701_112, 92_075],
      gps: null,
    }),
    workoutRecord({
      id: workouts.manualWalk,
      userId,
      createdAt: "2026-09-16T08:10:00.000Z",
      updatedAt: "2026-09-16T11:48:05.000Z",
      start: "2026-09-16T07:30:00.000Z",
      end: "2026-09-16T08:10:00.000Z",
      offset,
      sport: "walking",
      strain: 4.9016,
      averageHeartRate: 105,
      maxHeartRate: 131,
      kilojoule: 702.04,
      percentRecorded: 1,
      zones: [1_380_000, 480_000, 0, 0, 0],
      gps: null,
    }),
    workoutRecord({
      id: workouts.weightliftingDay3,
      userId,
      createdAt: "2026-09-16T16:07:40.088Z",
      updatedAt: "2026-09-16T16:07:43.551Z",
      start: "2026-09-16T15:12:44.617Z",
      end: "2026-09-16T16:05:19.230Z",
      offset,
      sport: "weightlifting_msk",
      strain: 7.8841,
      averageHeartRate: 114,
      maxHeartRate: 158,
      kilojoule: 1041.26,
      percentRecorded: 1,
      zones: [1_302_448, 1_080_590, 371_300, 50_064, 0],
      gps: null,
    }),
    workoutRecord({
      id: workouts.eveningRun,
      userId,
      createdAt: "2026-09-16T18:14:09.330Z",
      updatedAt: "2026-09-16T18:16:02.337Z",
      start: "2026-09-16T17:26:03.118Z",
      end: "2026-09-16T18:11:47.905Z",
      offset,
      sport: "running",
      strain: 12.4467,
      averageHeartRate: 155,
      maxHeartRate: 179,
      kilojoule: 2203.79,
      percentRecorded: 0.99975777,
      zones: [90_315, 350_227, 1_202_441, 902_118, 179_017],
      gps: { distance: 8103.4, altitudeGain: 44.7, altitudeChange: -1.3 },
    }),
  ];

  return asOf(
    {
      now: new Date(nowMs),
      offset,
      profile: {
        user_id: userId,
        email: "live.shaped@example.com",
        first_name: "Live",
        last_name: "Shaped",
      },
      body: { height_meter: 1.82, weight_kilogram: 79.4, max_heart_rate: 189 },
      cycles: cycleRecords,
      sleeps: sleepRecords,
      recoveries: recoveryRecords,
      workouts: workoutRecords,
    },
    nowMs
  );
}

// ---------------------------------------------------------------------------
// matureUser / stressUser
// ---------------------------------------------------------------------------

/** Default evaluation instant of {@link matureUser}. */
export const MATURE_USER_NOW = "2026-09-16T23:30:00+02:00";

/** Options for {@link matureUser}. Quirks are on by default; pass [] / 0 / false / null to disable one. */
export interface MatureUserOptions {
  /** Local days with data, the last one being the local day of `now`. Default 120. */
  days?: number;
  /** Seed of every random stream. Default 1. */
  seed?: number;
  /** UTC offset in effect on the first day. Default "+02:00". */
  offset?: string;
  /** Default {@link MATURE_USER_NOW}. */
  now?: string | Date;
  /**
   * Day indexes (0 = first day) with the strap off: no records that day, the
   * cycle before the gap ends at strap-off without a following cycle. Only
   * indexes 1..days-2 apply. Default: two consecutive days at 45% of the span
   * when days >= 21, else none.
   */
  gapDays?: readonly number[];
  /** A nap on every Nth day (days with index % N === N - 1); 0 = none. Default 6. */
  napEvery?: number;
  /** The first N recoveries are calibrating (sleep consistency 0). Default 0. */
  calibratingFirst?: number;
  /** The newest main sleep and its recovery are PENDING_SCORE. Default true. */
  pendingLast?: boolean;
  /**
   * From day index `day` on, records use `offset` (e.g. a DST change). Default:
   * one hour earlier than the first-day offset from two thirds of the span when
   * days >= 10 (+02:00 → +01:00), else null.
   */
  offsetChange?: { day: number; offset: string } | null;
  /** Workouts per worn day (0-4). With 1, about one day in six is a rest day. Default 1. */
  workoutsPerDay?: number;
  /** Every Nth night has no-data time above 20% of time in bed; 0 = none. Default 11. */
  lowCoverageEvery?: number;
  /**
   * Day indexes with a split night: two main sleeps (and two cycles) ending on
   * the same wake day. Default [floor(days * 0.3)] when days >= 7.
   */
  splitNightDays?: readonly number[];
  /**
   * Every Nth day the sleep onset is after 00:50 local and a walk starts after
   * local midnight before it (it belongs to the previous day's cycle); 0 = none.
   * Default 9.
   */
  lateWorkoutEvery?: number;
  /**
   * Daily drift of the HRV level (ms per day). Recovery follows HRV and resting
   * heart rate moves against it, so a positive drift gives rising recovery and
   * HRV and slightly falling resting heart rate. Default 0 (no trend).
   */
  hrvDriftPerDay?: number;
}

interface SportProfile {
  minutes: [number, number];
  heartRate: [number, number];
  maxAbove: [number, number];
  strain: [number, number];
  kjPerMinute: [number, number];
  zoneWeights: [number, number, number, number, number, number];
  speed: [number, number] | null;
}

const SPORT_PROFILES: Record<FixtureSport, SportProfile> = {
  running: {
    minutes: [25, 65],
    heartRate: [140, 165],
    maxAbove: [15, 30],
    strain: [9, 15],
    kjPerMinute: [11, 14],
    zoneWeights: [0.02, 0.08, 0.2, 0.4, 0.25, 0.05],
    speed: [2.5, 3.4],
  },
  cycling: {
    minutes: [45, 90],
    heartRate: [125, 150],
    maxAbove: [20, 35],
    strain: [9, 14],
    kjPerMinute: [9, 12],
    zoneWeights: [0.03, 0.12, 0.3, 0.35, 0.17, 0.03],
    speed: [5.5, 8],
  },
  walking: {
    minutes: [20, 60],
    heartRate: [90, 112],
    maxAbove: [15, 30],
    strain: [2.5, 6],
    kjPerMinute: [4.5, 6.5],
    zoneWeights: [0.3, 0.55, 0.15, 0, 0, 0],
    speed: null,
  },
  weightlifting_msk: {
    minutes: [40, 75],
    heartRate: [105, 130],
    maxAbove: [30, 45],
    strain: [6, 11],
    kjPerMinute: [6, 8],
    zoneWeights: [0.12, 0.42, 0.33, 0.11, 0.02, 0],
    speed: null,
  },
  padel: {
    minutes: [60, 90],
    heartRate: [125, 145],
    maxAbove: [35, 50],
    strain: [10, 15],
    kjPerMinute: [8, 10],
    zoneWeights: [0.05, 0.2, 0.33, 0.28, 0.12, 0.02],
    speed: null,
  },
};

type Slot = "morning" | "midday" | "afternoon" | "evening";

/** Local start window (minutes after midnight) and longest duration per slot. */
const SLOTS: Record<Slot, { from: number; spread: number; maxMinutes: number }> = {
  morning: { from: 8 * 60 + 15, spread: 45, maxMinutes: 90 },
  midday: { from: 11 * 60 + 30, spread: 30, maxMinutes: 75 },
  afternoon: { from: 16 * 60, spread: 30, maxMinutes: 90 },
  evening: { from: 18 * 60 + 30, spread: 60, maxMinutes: 90 },
};

function slotsFor(count: number, random: () => number): Slot[] {
  if (count <= 0) return [];
  if (count === 1) return [(["morning", "midday", "evening"] as const)[Math.floor(random() * 3)]!];
  if (count === 2) return ["morning", "evening"];
  if (count === 3) return ["morning", "midday", "evening"];
  return ["morning", "midday", "afternoon", "evening"];
}

function pickSport(random: () => number, slot: Slot): FixtureSport {
  const draw = random();
  const sport: FixtureSport =
    draw < 0.3
      ? "running"
      : draw < 0.55
        ? "walking"
        : draw < 0.8
          ? "weightlifting_msk"
          : draw < 0.9
            ? "padel"
            : "cycling";
  return sport === "padel" && (slot === "morning" || slot === "midday") ? "walking" : sport;
}

interface PlannedCycle {
  day: number;
  startMs: number;
  endMs: number | null;
  offset: string;
  /** The main sleep starting this cycle, when there is one. */
  sleep: { endMs: number; short: boolean } | null;
}

/**
 * A long-lived account generated from a seeded LCG: one cycle per local day
 * with its main sleep and recovery, workouts, and (by default) strap-off gaps,
 * naps, a split night, low-coverage nights, an after-midnight workout pattern,
 * an offset change and a pending last night. Each day draws from its own
 * random streams, so toggling one quirk leaves the other days' values alone.
 */
export function matureUser(options: MatureUserOptions = {}): WhoopUserFixture {
  const days = options.days ?? 120;
  if (!Number.isInteger(days) || days < 2) throw new RangeError("matureUser needs at least 2 days");
  const seed = options.seed ?? 1;
  const baseOffset = options.offset ?? "+02:00";
  const nowMs = toMs(options.now ?? MATURE_USER_NOW);
  const offsetChange =
    options.offsetChange === undefined
      ? days >= 10
        ? { day: Math.floor((days * 2) / 3), offset: formatOffset(offsetMinutes(baseOffset) - 60) }
        : null
      : options.offsetChange;
  const gapDays = new Set(
    (
      options.gapDays ?? (days >= 21 ? [Math.floor(days * 0.45), Math.floor(days * 0.45) + 1] : [])
    ).filter((day) => day >= 1 && day <= days - 2)
  );
  const napEvery = options.napEvery ?? 6;
  const calibratingFirst = options.calibratingFirst ?? 0;
  const pendingLast = options.pendingLast ?? true;
  const workoutsPerDay = Math.max(0, Math.min(4, options.workoutsPerDay ?? 1));
  const lowCoverageEvery = options.lowCoverageEvery ?? 11;
  const splitNightDays = new Set(
    options.splitNightDays ?? (days >= 7 ? [Math.floor(days * 0.3)] : [])
  );
  const lateWorkoutEvery = options.lateWorkoutEvery ?? 9;
  const hrvDriftPerDay = options.hrvDriftPerDay ?? 0;

  const userId = 9000 + seed;
  const stream = (day: number, purpose: string): (() => number) =>
    createLcg(hashSeed(seed, day, purpose));
  const between = (random: () => number, [low, high]: [number, number]): number =>
    low + random() * (high - low);
  const jitter = (random: () => number): number => Math.floor(random() * 1000);

  const offsetAt = (day: number): string =>
    offsetChange && day >= offsetChange.day ? offsetChange.offset : baseOffset;
  const today = localDate(nowMs, offsetAt(days - 1));
  const dateOf = (day: number): string => addDays(today, day - (days - 1));
  const worn = (day: number): boolean => day >= 0 && day < days && !gapDays.has(day);
  const isEvery = (day: number, every: number): boolean => every > 0 && day % every === every - 1;
  const lateWorkoutDay = (day: number): boolean =>
    day >= 1 &&
    isEvery(day, lateWorkoutEvery) &&
    worn(day) &&
    worn(day - 1) &&
    !splitNightDays.has(day);

  // --- Sleep onsets (cycle starts) and wake times per worn day -------------
  const onsetMs = new Map<number, number>();
  const wakeMs = new Map<number, number>();
  const splitSecondStartMs = new Map<number, number>();
  const splitFirstEndMs = new Map<number, number>();
  for (let day = 0; day < days; day += 1) {
    if (!worn(day)) continue;
    const offset = offsetAt(day);
    const random = stream(day, "night");
    if (day === 0) {
      onsetMs.set(day, localMs(dateOf(0), 0, offset));
      continue;
    }
    const split = splitNightDays.has(day);
    let onset: number;
    if (lateWorkoutDay(day)) {
      onset = localMs(dateOf(day), 55 + random() * 10, offset);
    } else if (split) {
      onset = localMs(dateOf(day - 1), 22 * 60 + 40 + random() * 20, offset);
    } else {
      onset = localMs(dateOf(day - 1), 22 * 60 + 30 + random() * 150, offset);
    }
    onset = Math.floor(onset) + jitter(random);
    onsetMs.set(day, onset);
    const wake =
      Math.floor(localMs(dateOf(day), 5 * 60 + 45 + random() * 120, offset)) + jitter(random);
    wakeMs.set(day, wake);
    if (split) {
      const firstEnd = onset + Math.floor((150 + random() * 30) * MINUTE_MS);
      splitFirstEndMs.set(day, firstEnd);
      splitSecondStartMs.set(day, firstEnd + Math.floor((60 + random() * 30) * MINUTE_MS));
    }
  }

  // --- Cycles --------------------------------------------------------------
  const planned: PlannedCycle[] = [];
  for (let day = 0; day < days; day += 1) {
    if (!worn(day)) continue;
    const offset = offsetAt(day);
    const start = onsetMs.get(day)!;
    let end: number | null;
    if (day === days - 1) end = null;
    else if (worn(day + 1)) end = onsetMs.get(day + 1)!;
    else {
      const random = stream(day, "strap-off");
      end = Math.floor(localMs(dateOf(day), 21 * 60 + 30 + random() * 30, offset)) + jitter(random);
    }
    if (day === 0) {
      planned.push({ day, startMs: start, endMs: end, offset, sleep: null });
    } else if (splitNightDays.has(day)) {
      const secondStart = splitSecondStartMs.get(day)!;
      planned.push({
        day,
        startMs: start,
        endMs: secondStart,
        offset,
        sleep: { endMs: splitFirstEndMs.get(day)!, short: true },
      });
      planned.push({
        day,
        startMs: secondStart,
        endMs: end,
        offset,
        sleep: { endMs: wakeMs.get(day)!, short: false },
      });
    } else {
      planned.push({
        day,
        startMs: start,
        endMs: end,
        offset,
        sleep: { endMs: wakeMs.get(day)!, short: false },
      });
    }
  }

  const cycles: Cycle[] = [];
  const sleeps: Sleep[] = [];
  const recoveries: Recovery[] = [];
  const workouts: Workout[] = [];

  const baselineNeed = 27_200_000 + Math.floor(createLcg(hashSeed(seed, "baseline"))() * 1_600_000);
  const hrvMean = 55 + createLcg(hashSeed(seed, "hrv-mean"))() * 20;
  let hrvState = hrvMean;
  let recoveryIndex = 0;
  let workoutIndex = 0;
  let previousCycleStrain = 0;
  let previousNapAsleep = 0;
  const newestMainSleepIndex = planned.length - 1;

  // Workouts per day, generated before cycles so cycle strain can reflect them.
  const workoutsByDay = new Map<number, Workout[]>();
  const addWorkout = (day: number, workout: Workout): void => {
    const list = workoutsByDay.get(day) ?? [];
    list.push(workout);
    workoutsByDay.set(day, list);
    workouts.push(workout);
  };
  const buildWorkout = (
    sport: FixtureSport,
    startMs: number,
    minutes: number,
    random: () => number,
    offset: string
  ): Workout => {
    const profile = SPORT_PROFILES[sport];
    const index = workoutIndex;
    workoutIndex += 1;
    const manual = index % 29 === 28;
    let start = startMs;
    let end = startMs + Math.floor(minutes * MINUTE_MS) + (manual ? 0 : jitter(random) * 60);
    if (manual) {
      start = Math.floor(start / 1000) * 1000;
      end = Math.floor(end / 1000) * 1000;
    }
    const percentRecorded = index % 17 === 16 ? 0.87 : index % 23 === 11 ? 0.9993 : 1;
    const recorded = Math.round((end - start) * percentRecorded);
    const weights = profile.zoneWeights.map((weight) => weight * (0.8 + random() * 0.4));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    const zones = weights.slice(1).map((weight) => Math.floor((recorded * weight) / total)) as [
      number,
      number,
      number,
      number,
      number,
    ];
    const averageHeartRate = Math.round(between(random, profile.heartRate));
    const created = manual ? end : end + Math.floor((60 + random() * 180) * 1000) + jitter(random);
    const updated = manual
      ? created + Math.floor(3 + random() * 2) * HOUR_MS
      : created + Math.floor(random() * 5000);
    const speed = profile.speed ? between(random, profile.speed) : 0;
    return workoutRecord({
      id: fixtureUuid(seed, "workout", index),
      userId,
      createdAt: iso(created),
      updatedAt: iso(updated),
      start: iso(start),
      end: iso(end),
      offset,
      sport,
      strain: round(between(random, profile.strain), 4),
      averageHeartRate,
      maxHeartRate: Math.min(198, averageHeartRate + Math.round(between(random, profile.maxAbove))),
      kilojoule: round(minutes * between(random, profile.kjPerMinute), 2),
      percentRecorded,
      zones,
      gps: GPS_SPORTS.has(sport)
        ? {
            distance: round(((end - start) / 1000) * speed, 1),
            altitudeGain: round(5 + random() * 115, 1),
            altitudeChange: round(-25 + random() * 50, 1),
          }
        : null,
    });
  };

  for (let day = 0; day < days; day += 1) {
    if (!worn(day)) continue;
    const offset = offsetAt(day);
    const random = stream(day, "workouts");
    let count = workoutsPerDay;
    if (count === 1 && random() < 0.18) count = 0;
    for (const slot of slotsFor(count, random)) {
      const sport = pickSport(random, slot);
      const window = SLOTS[slot];
      const [low, high] = SPORT_PROFILES[sport].minutes;
      const minutes = Math.min(window.maxMinutes, low + random() * (high - low));
      const start =
        Math.floor(localMs(dateOf(day), window.from + random() * window.spread, offset)) +
        jitter(random);
      addWorkout(day, buildWorkout(sport, start, minutes, random, offset));
    }
    // A walk after local midnight, before a late onset: it belongs to the previous day's cycle.
    if (lateWorkoutDay(day)) {
      const lateRandom = stream(day, "late-workout");
      const previousOffset = offsetAt(day - 1);
      const start =
        Math.floor(localMs(dateOf(day), 5 + lateRandom() * 5, previousOffset)) + jitter(lateRandom);
      addWorkout(
        day - 1,
        buildWorkout("walking", start, 25 + lateRandom() * 10, lateRandom, previousOffset)
      );
    }
  }

  // Naps per day.
  const napByDay = new Map<number, { startMs: number; endMs: number; random: () => number }>();
  for (let day = 1; day < days; day += 1) {
    if (!worn(day) || !isEvery(day, napEvery)) continue;
    const random = stream(day, "nap");
    const start =
      Math.floor(localMs(dateOf(day), 14 * 60 + 10 + random() * 20, offsetAt(day))) +
      jitter(random);
    napByDay.set(day, {
      startMs: start,
      endMs: start + Math.floor((20 + random() * 25) * MINUTE_MS),
      random,
    });
  }

  planned.forEach((plan, index) => {
    const random = stream(plan.day, plan.sleep?.short ? "cycle-short" : "cycle");
    const cycleId = 300_000 + index;
    const dayWorkouts = plan.sleep?.short ? [] : (workoutsByDay.get(plan.day) ?? []);
    const workoutStrain = dayWorkouts.reduce(
      (sum, workout) => sum + (workout.score?.strain ?? 0),
      0
    );
    const workoutKj = dayWorkouts.reduce(
      (sum, workout) => sum + (workout.score?.kilojoule ?? 0),
      0
    );
    const workoutMax = dayWorkouts.reduce(
      (max, workout) => Math.max(max, workout.score?.max_heart_rate ?? 0),
      0
    );
    const partial = plan.day === 0 ? 0.8 : plan.sleep?.short ? 0.25 : 1;
    const strain = round(Math.min(20.5, (5 + workoutStrain * 0.45 + random() * 2) * partial), 4);
    const kilojoule = round((7000 + random() * 2500) * partial + workoutKj, 1);

    let cycleCreated: number;
    let sleepCreated = 0;
    if (plan.sleep) {
      sleepCreated = plan.sleep.endMs + Math.floor((120 + random() * 240) * 1000) + jitter(random);
      cycleCreated = sleepCreated - Math.floor((3 + random() * 5) * 1000);
    } else {
      cycleCreated =
        Math.floor(localMs(dateOf(plan.day), 6 * 60 + 10 + random() * 30, plan.offset)) +
        jitter(random);
    }
    const nap = plan.sleep?.short ? undefined : napByDay.get(plan.day);

    // --- Main sleep and recovery ------------------------------------------
    if (plan.sleep) {
      const sleepId = fixtureUuid(seed, "sleep", plan.day, plan.sleep.short ? "a" : "b");
      const inBed = plan.sleep.endMs - plan.startMs;
      const pending = pendingLast && index === newestMainSleepIndex;
      const calibrating = recoveryIndex < calibratingFirst;
      const lowCoverage = isEvery(plan.day, lowCoverageEvery) && !plan.sleep.short;
      const awake = Math.round(inBed * (0.05 + random() * 0.06));
      const noData = lowCoverage ? Math.round(inBed * (0.22 + random() * 0.08)) : 0;
      const asleep = inBed - awake - noData;
      const light = Math.round(asleep * (0.48 + random() * 0.08));
      const slowWave = Math.round(asleep * (0.17 + random() * 0.06));
      const debt = Math.round(random() * 3_200_000);
      const strainNeed = Math.round(previousCycleStrain * 160_000);
      const napNeed = previousNapAsleep > 0 ? -Math.round(previousNapAsleep * 0.85) : 0;
      const baseline = baselineNeed + Math.round(random() * 400_000);
      const need = baseline + debt + strainNeed + napNeed;
      const cycleCount = 3 + Math.floor(random() * 4);
      const disturbances = 4 + Math.floor(random() * 15);
      const respiratoryRate = Math.round((13.8 + random() * 2.4) * 64) / 64;
      const consistency = calibrating ? 0 : 55 + Math.floor(random() * 38);
      sleeps.push(
        sleepRecord({
          id: sleepId,
          cycleId,
          userId,
          createdAt: iso(sleepCreated),
          updatedAt: iso(sleepCreated),
          start: iso(plan.startMs),
          end: iso(plan.sleep.endMs),
          offset: plan.offset,
          nap: false,
          score: pending
            ? null
            : {
                awake,
                noData,
                light,
                slowWave,
                cycles: plan.sleep.short ? 1 : cycleCount,
                disturbances,
                baseline,
                debt,
                strain: strainNeed,
                nap: napNeed,
                respiratoryRate,
                performance: Math.min(100, Math.round((asleep / need) * 100)),
                efficiency: round((asleep / inBed) * 100, 2),
                consistency,
              },
        })
      );
      const hrvLevel = hrvMean + hrvDriftPerDay * plan.day;
      hrvState = Math.max(
        20,
        Math.min(160, hrvLevel + 0.6 * (hrvState - hrvLevel) + (random() - 0.5) * 24)
      );
      const hrv = round(hrvState, 3);
      recoveries.push(
        recoveryRecord({
          cycleId,
          sleepId,
          userId,
          createdAt: iso(sleepCreated),
          updatedAt: iso(sleepCreated),
          score: pending
            ? null
            : {
                calibrating,
                recovery: Math.max(
                  1,
                  Math.min(99, Math.round(58 + (hrv - hrvMean) * 1.3 + (random() - 0.5) * 36))
                ),
                rhr: Math.round(56 - (hrv - hrvMean) * 0.08 + (random() - 0.5) * 6),
                hrv,
                spo2: round(95 + random() * 3.5, 2),
                skinTemp: round(33.2 + random() * 1.4, 3),
              },
        })
      );
      recoveryIndex += 1;
      previousNapAsleep = 0;
    }

    // --- Nap ------------------------------------------------------------------
    let napCreated = 0;
    if (nap) {
      const napRandom = nap.random;
      const inBed = nap.endMs - nap.startMs;
      const awake = Math.round(inBed * (0.1 + napRandom() * 0.1));
      const asleep = inBed - awake;
      const light = Math.round(asleep * 0.7);
      const slowWave = Math.round(asleep * 0.2);
      napCreated = nap.endMs + Math.floor((120 + napRandom() * 120) * 1000) + jitter(napRandom);
      sleeps.push(
        sleepRecord({
          id: fixtureUuid(seed, "nap", plan.day),
          cycleId,
          userId,
          createdAt: iso(napCreated),
          updatedAt: iso(napCreated),
          start: iso(nap.startMs),
          end: iso(nap.endMs),
          offset: plan.offset,
          nap: true,
          score: {
            awake,
            noData: 0,
            light,
            slowWave,
            cycles: 1,
            disturbances: 1 + Math.floor(napRandom() * 3),
            baseline: 0,
            debt: 0,
            strain: 0,
            nap: 0,
            respiratoryRate: Math.round((13.8 + napRandom() * 2.4) * 64) / 64,
            performance: null,
            efficiency: round((asleep / inBed) * 100, 2),
            consistency: null,
          },
        })
      );
      previousNapAsleep = asleep;
    }

    // --- Cycle ------------------------------------------------------------------
    const nextPlanned = planned[index + 1];
    const latestActivity = Math.max(
      cycleCreated,
      napCreated,
      ...dayWorkouts.map((workout) => Date.parse(workout.updated_at))
    );
    let updated: number;
    if (plan.endMs === null) updated = latestActivity;
    else if (nextPlanned && nextPlanned.startMs === plan.endMs) {
      // Closed when the next cycle is created (its sleep was processed).
      updated = Math.max(latestActivity, plan.endMs + 5 * MINUTE_MS);
    } else updated = Math.max(latestActivity, plan.endMs + 2 * HOUR_MS);
    cycles.push(
      cycleRecord({
        id: cycleId,
        userId,
        createdAt: iso(cycleCreated),
        updatedAt: iso(updated),
        start: iso(plan.startMs),
        end: plan.endMs === null ? null : iso(plan.endMs),
        offset: plan.offset,
        score: {
          strain,
          kilojoule,
          average_heart_rate: 60 + Math.floor(random() * 15),
          max_heart_rate: Math.max(workoutMax, 115 + Math.floor(random() * 30)),
        },
      })
    );
    previousCycleStrain = plan.sleep?.short ? previousCycleStrain : strain;
  });

  return asOf(
    {
      now: new Date(nowMs),
      offset: offsetAt(days - 1),
      profile: {
        user_id: userId,
        email: `mature.user.${seed}@example.com`,
        first_name: "Mature",
        last_name: `User ${seed}`,
      },
      body: {
        height_meter: 1.76,
        weight_kilogram: round(72.5 + (seed % 10) / 10, 1),
        max_heart_rate: 192,
      },
      cycles,
      sleeps,
      recoveries,
      workouts,
    },
    nowMs
  );
}

/** A year of dense data for output-size guards: 2 workouts a day and a nap every third day. */
export function stressUser(options: MatureUserOptions = {}): WhoopUserFixture {
  return matureUser({ days: 365, workoutsPerDay: 2, napEvery: 3, ...options });
}
