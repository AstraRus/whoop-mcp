/**
 * Tests for get_recovery_drivers (package P9).
 *
 * Covers: the live-shaped calibrating account (partial first day, calibrating
 * recovery, every combination too_few_pairs), a planted late-bedtime → lower
 * HRV link across 20 seeds against noise behaviours, AR(0.7) series without a
 * link (effective sample size), binary group sizes and a failed workout
 * stream, bedtime wrap-around, tag dates at +02:00 and −05:00, calibration,
 * strain band edges, tertile cut points, the 3-hour late-workout boundary,
 * after-midnight workouts on a 30-day history chunk boundary (mid-window and on
 * the last wake day), same_day by each day's own morning zone, sleep outcomes
 * from the night's own sleep, tautological and partly-by-construction
 * combinations, source failures (all, required, recovery with mixed outcomes,
 * workouts), truncated history, request accounting and the deadline under the
 * rate limiter, output size on stressUser, neutral wording and the MCP
 * contract in both privacy modes.
 */

import { describe, it, expect, vi } from "vitest";
import { WhoopApiError } from "../../src/api/client.js";
import {
  DEFAULT_PAGE_BUDGET,
  HISTORY_CHUNK_MS,
  HISTORY_DEADLINE_MS,
  HISTORY_LIMITATIONS,
  SETTLED_MS,
} from "../../src/api/history.js";
import { createRateLimiter, DEFAULT_RATE_LIMIT_PER_MINUTE } from "../../src/api/rate-limiter.js";
import type { Cycle, Recovery, ScoreState, Sleep, Workout } from "../../src/api/types.js";
import { MemoryCache } from "../../src/cache/memory-cache.js";
import { DISCLAIMER, localDay } from "../../src/tools/analytics-utils.js";
import { buildNights, placeDays, type Night } from "../../src/tools/day-model.js";
import {
  DRIVER_BEHAVIOURS,
  DRIVERS_MIN_PAIRS,
  DRIVERS_MIN_REPORTED_P,
  LATE_WORKOUT_HOURS,
  nightBehaviours,
  RECOVERY_DRIVERS_TOOL,
  recoveryDriversOutputSchema,
  strainBand,
  strengthOf,
  type RecoveryDriversInput,
  type RecoveryDriversReport,
} from "../../src/tools/get-recovery-drivers.js";
import { correlationInterval, quantileCuts, roundTo } from "../../src/tools/stats-utils.js";
import { MAX_TOOL_TEXT_CHARS, type ToolContext } from "../../src/tools/tool-definition.js";
import { assertNeutralText, connectServer, listToolNames } from "../helpers/contract.js";
import {
  createWhoopFixtureClient,
  type WhoopFixtureClient,
  type WhoopFixtureClientOptions,
} from "../helpers/whoop-fixture-client.js";
import {
  createLcg,
  hashSeed,
  liveShapedUser,
  matureUser,
  offsetMinutes,
  stressUser,
  type WhoopUserFixture,
} from "../helpers/whoop-users.js";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const TOOL = "get_recovery_drivers";
/** Several tests run the tool dozens of times or through a full MCP server; the suite runs in parallel. */
const TEST_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Night-plan fixtures
// ---------------------------------------------------------------------------

interface WorkoutPlan {
  /** Start in minutes after local midnight of the plan's wake day */
  startLocalMin?: number;
  /** End this many minutes before the next night's sleep onset */
  endBeforeNextOnsetMin?: number;
  durationMin: number;
  /** percent_recorded (0-1). Default 1 */
  fraction?: number;
  /** Minutes in zone 4 and in zone 5 each. Default 5 */
  zoneHighMin?: number;
  state?: ScoreState;
}

/**
 * Night d: the main sleep waking on day d and the cycle it starts (d's day,
 * ending at the next night's onset). Behaviours of night d + 1 come from
 * night d's cycle (strain, workouts, nap); outcomes of night d from its own
 * sleep and recovery.
 */
interface NightPlan {
  /** Sleep onset in minutes from local midnight of the wake day (−30 = 23:30 the evening before) */
  bedtime: number;
  inBedMin: number;
  asleepMin: number;
  hrv: number;
  rhr: number;
  recovery: number;
  calibrating?: boolean;
  recoveryState?: ScoreState;
  sleepState?: ScoreState;
  performance: number | null;
  disturbances: number;
  debtHours: number;
  /** Day strain of the cycle this sleep starts */
  strain: number;
  cycleState?: ScoreState;
  /** Workouts during the cycle this sleep starts */
  workouts: WorkoutPlan[];
  /** A nap at 15:00 local during the cycle this sleep starts */
  nap?: ScoreState;
  /** Wake-day offset; default the fixture offset */
  offset?: string;
}

interface PlannedUser {
  now: Date;
  offset: string;
  cycles: Cycle[];
  sleeps: Sleep[];
  recoveries: Recovery[];
  workouts: Workout[];
  /** Wake day of each plan */
  wakeDays: string[];
}

function addDaysTo(day: string, count: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + count * DAY_MS).toISOString().slice(0, 10);
}

/** The instant `minutes` after local midnight of `day` in `offset` (negative: the evening before) */
function localMs(day: string, minutes: number, offset: string): number {
  return Date.parse(`${day}T00:00:00.000Z`) + (minutes - offsetMinutes(offset)) * MINUTE_MS;
}

const iso = (ms: number): string => new Date(ms).toISOString();

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** Build WHOOP records from night plans; the last plan wakes on `lastWakeDay`, now is 20:00 that day */
function buildUser(
  plans: readonly NightPlan[],
  options: { offset?: string; lastWakeDay?: string; nowLocalMin?: number } = {}
): PlannedUser {
  const offset = options.offset ?? "+02:00";
  const lastWakeDay = options.lastWakeDay ?? "2026-09-16";
  const wakeDays = plans.map((_, index) => addDaysTo(lastWakeDay, index - (plans.length - 1)));
  const offsets = plans.map((plan) => plan.offset ?? offset);
  const onsets = plans.map((plan, index) =>
    localMs(wakeDays[index]!, plan.bedtime, offsets[index]!)
  );
  const cycles: Cycle[] = [];
  const sleeps: Sleep[] = [];
  const recoveries: Recovery[] = [];
  const workouts: Workout[] = [];
  plans.forEach((plan, index) => {
    const tz = offsets[index]!;
    const onset = onsets[index]!;
    const nextOnset = onsets[index + 1];
    const cycleId = 500_000 + index;
    const sleepId = `sleep-${String(index).padStart(4, "0")}`;
    const end = onset + Math.round(plan.inBedMin * MINUTE_MS);
    const created = iso(end + 5 * MINUTE_MS);
    const inBed = end - onset;
    const asleep = Math.round(plan.asleepMin * MINUTE_MS);
    const light = Math.round(asleep * 0.55);
    const slowWave = Math.round(asleep * 0.2);
    const sleepState = plan.sleepState ?? "SCORED";
    cycles.push({
      id: cycleId,
      user_id: 1,
      created_at: created,
      updated_at: nextOnset === undefined ? created : iso(nextOnset + 10 * MINUTE_MS),
      start: iso(onset),
      end: nextOnset === undefined ? null : iso(nextOnset),
      timezone_offset: tz,
      score_state: plan.cycleState ?? "SCORED",
      score:
        (plan.cycleState ?? "SCORED") === "SCORED"
          ? { strain: plan.strain, kilojoule: 8000, average_heart_rate: 62, max_heart_rate: 150 }
          : null,
    });
    sleeps.push({
      id: sleepId,
      cycle_id: cycleId,
      user_id: 1,
      created_at: created,
      updated_at: created,
      start: iso(onset),
      end: iso(end),
      timezone_offset: tz,
      nap: false,
      score_state: sleepState,
      v1_id: null,
      score:
        sleepState === "SCORED"
          ? {
              stage_summary: {
                total_in_bed_time_milli: inBed,
                total_awake_time_milli: inBed - asleep,
                total_no_data_time_milli: 0,
                total_light_sleep_time_milli: light,
                total_slow_wave_sleep_time_milli: slowWave,
                total_rem_sleep_time_milli: asleep - light - slowWave,
                sleep_cycle_count: 4,
                disturbance_count: plan.disturbances,
              },
              sleep_needed: {
                baseline_milli: 27_000_000,
                need_from_sleep_debt_milli: Math.round(plan.debtHours * 3_600_000),
                need_from_recent_strain_milli: 1_000_000,
                need_from_recent_nap_milli: 0,
              },
              respiratory_rate: 15,
              sleep_performance_percentage: plan.performance,
              sleep_efficiency_percentage: roundTo((100 * asleep) / inBed, 2),
              sleep_consistency_percentage: 80,
            }
          : null,
    });
    const recoveryState = plan.recoveryState ?? "SCORED";
    recoveries.push({
      cycle_id: cycleId,
      sleep_id: sleepId,
      user_id: 1,
      created_at: created,
      updated_at: created,
      score_state: recoveryState,
      score:
        recoveryState === "SCORED"
          ? {
              user_calibrating: plan.calibrating ?? false,
              recovery_score: clamp(Math.round(plan.recovery), 1, 99),
              resting_heart_rate: clamp(plan.rhr, 30, 120),
              hrv_rmssd_milli: clamp(plan.hrv, 5, 250),
              spo2_percentage: 96,
              skin_temp_celsius: 33.5,
            }
          : null,
    });
    plan.workouts.forEach((workout, workoutIndex) => {
      let startMs: number;
      if (workout.endBeforeNextOnsetMin !== undefined) {
        // The newest cycle is still open: no night follows it, so its late workout is left out.
        if (nextOnset === undefined) return;
        startMs = nextOnset - (workout.endBeforeNextOnsetMin + workout.durationMin) * MINUTE_MS;
      } else {
        startMs = localMs(wakeDays[index]!, workout.startLocalMin ?? 12 * 60, tz);
      }
      const endMs = startMs + workout.durationMin * MINUTE_MS;
      const fraction = workout.fraction ?? 1;
      const recorded = Math.round((endMs - startMs) * fraction);
      const high = Math.round((workout.zoneHighMin ?? 5) * MINUTE_MS);
      const state = workout.state ?? "SCORED";
      workouts.push({
        id: `workout-${String(index).padStart(4, "0")}-${workoutIndex}`,
        user_id: 1,
        created_at: iso(endMs + MINUTE_MS),
        updated_at: iso(endMs + MINUTE_MS),
        start: iso(startMs),
        end: iso(endMs),
        timezone_offset: tz,
        sport_name: "running",
        sport_id: 0,
        score_state: state,
        v1_id: null,
        score:
          state === "SCORED"
            ? {
                strain: 10,
                average_heart_rate: 140,
                max_heart_rate: 175,
                kilojoule: 1500,
                percent_recorded: fraction,
                zone_durations: {
                  zone_zero_milli: 0,
                  zone_one_milli: Math.max(0, recorded - 2 * high - 60_000),
                  zone_two_milli: 60_000,
                  zone_three_milli: 0,
                  zone_four_milli: high,
                  zone_five_milli: high,
                },
                distance_meter: null,
                altitude_gain_meter: null,
                altitude_change_meter: null,
              }
            : null,
      });
    });
    if (plan.nap !== undefined) {
      const napStart = localMs(wakeDays[index]!, 15 * 60, tz);
      const napEnd = napStart + 30 * MINUTE_MS;
      sleeps.push({
        id: `nap-${String(index).padStart(4, "0")}`,
        cycle_id: cycleId,
        user_id: 1,
        created_at: iso(napEnd + MINUTE_MS),
        updated_at: iso(napEnd + MINUTE_MS),
        start: iso(napStart),
        end: iso(napEnd),
        timezone_offset: tz,
        nap: true,
        score_state: plan.nap,
        v1_id: null,
        score:
          plan.nap === "SCORED"
            ? {
                stage_summary: {
                  total_in_bed_time_milli: 30 * MINUTE_MS,
                  total_awake_time_milli: 5 * MINUTE_MS,
                  total_no_data_time_milli: 0,
                  total_light_sleep_time_milli: 20 * MINUTE_MS,
                  total_slow_wave_sleep_time_milli: 5 * MINUTE_MS,
                  total_rem_sleep_time_milli: 0,
                  sleep_cycle_count: 1,
                  disturbance_count: 1,
                },
                sleep_needed: {
                  baseline_milli: 0,
                  need_from_sleep_debt_milli: 0,
                  need_from_recent_strain_milli: 0,
                  need_from_recent_nap_milli: 0,
                },
                respiratory_rate: 15,
                sleep_performance_percentage: null,
                sleep_efficiency_percentage: 83,
                sleep_consistency_percentage: null,
              }
            : null,
      });
    }
  });
  const now = new Date(localMs(lastWakeDay, options.nowLocalMin ?? 20 * 60, offset));
  const newest = <T extends { start: string }>(records: T[]): T[] =>
    records.sort((left, right) => Date.parse(right.start) - Date.parse(left.start));
  return {
    now,
    offset,
    cycles: newest(cycles),
    sleeps: newest(sleeps),
    recoveries: recoveries.reverse(),
    workouts: newest(workouts),
    wakeDays,
  };
}

/** A standard-normal draw from an LCG (Box-Muller) */
function gaussian(random: () => number): () => number {
  return () => {
    const u = Math.max(random(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
  };
}

/** An unremarkable night: every behaviour and outcome independent noise */
function noiseNight(random: () => number, overrides: Partial<NightPlan> = {}): NightPlan {
  const normal = gaussian(random);
  const inBed = clamp(460 + 35 * normal(), 330, 560);
  const asleep = inBed * (0.84 + 0.1 * random());
  const workouts: WorkoutPlan[] = [];
  const count = Math.floor(random() * 3);
  for (let i = 0; i < count; i++) {
    workouts.push({
      startLocalMin: 11 * 60 + Math.floor(random() * 8 * 60),
      durationMin: 25 + Math.floor(random() * 35),
      zoneHighMin: Math.floor(random() * 10),
    });
  }
  if (random() < 0.3) {
    workouts.push({ endBeforeNextOnsetMin: 20 + Math.floor(random() * 140), durationMin: 30 });
  }
  return {
    bedtime: clamp(-30 + 45 * normal(), -150, 120),
    inBedMin: inBed,
    asleepMin: asleep,
    hrv: 70 + 13 * normal(),
    rhr: 55 + 4 * normal(),
    recovery: 60 + 15 * normal(),
    performance: clamp(Math.round((asleep / 480) * 100), 1, 100),
    disturbances: 4 + Math.floor(random() * 14),
    debtHours: random() * 1.2,
    strain: roundTo(clamp(10 + 3 * normal(), 0.5, 20.5), 4),
    workouts,
    ...(random() < 0.15 ? { nap: "SCORED" as const } : {}),
    ...overrides,
  };
}

/** 91 nights (the first one outside the default 90-day window) with a planted bedtime → HRV link */
function plantedUser(seed: number): PlannedUser {
  const random = createLcg(hashSeed("p9-planted", seed));
  const normal = gaussian(random);
  const plans: NightPlan[] = [];
  for (let d = 0; d < 91; d++) {
    const base = noiseNight(random);
    const z = normal();
    plans.push({
      ...base,
      bedtime: clamp(-30 + 45 * z, -150, 120),
      // rho ≈ −0.6: HRV falls 8 ms per SD of later bedtime, with 10.7 ms of noise.
      hrv: 70 - 8 * z + 10.7 * normal(),
    });
  }
  return buildUser(plans);
}

/** Independent AR(0.7) series for day strain and HRV (no link between them) */
function autocorrelatedUser(seed: number): PlannedUser {
  const random = createLcg(hashSeed("p9-ar", seed));
  const normal = gaussian(random);
  let a = normal();
  let b = normal();
  const innovation = Math.sqrt(1 - 0.49);
  const plans: NightPlan[] = [];
  for (let d = 0; d < 91; d++) {
    a = 0.7 * a + innovation * normal();
    b = 0.7 * b + innovation * normal();
    plans.push(
      noiseNight(random, {
        strain: roundTo(clamp(10 + 3 * a, 0.5, 20.5), 4),
        hrv: 70 + 13 * b,
      })
    );
  }
  return buildUser(plans);
}

// ---------------------------------------------------------------------------
// Running the tool
// ---------------------------------------------------------------------------

type Fixture = Pick<WhoopUserFixture, "now" | "cycles" | "sleeps" | "recoveries" | "workouts">;

function clientFor(
  fixture: Fixture,
  extra: Partial<WhoopFixtureClientOptions> = {}
): WhoopFixtureClient {
  return createWhoopFixtureClient({
    cycles: fixture.cycles,
    sleeps: fixture.sleeps,
    recoveries: fixture.recoveries,
    workouts: fixture.workouts,
    now: fixture.now,
    ...extra,
  });
}

/** Run the standard variant directly (no MCP), validating the result against the output contract */
async function runDrivers(
  fixture: Fixture,
  args: RecoveryDriversInput = {},
  options: { client?: WhoopFixtureClient; cache?: MemoryCache } = {}
): Promise<RecoveryDriversReport> {
  const ctx: ToolContext = {
    client: options.client ?? clientFor(fixture),
    privacyMode: "standard",
    now: () => fixture.now,
    startedAtMs: Date.now(),
    ...(options.cache ? { historyCache: options.cache } : {}),
  };
  const result = await RECOVERY_DRIVERS_TOOL.standard.run(args, ctx);
  return recoveryDriversOutputSchema.parse(result);
}

function findingOf(
  report: RecoveryDriversReport,
  behaviour: string,
  outcome: string
): RecoveryDriversReport["findings"][number] | undefined {
  return report.findings.find(
    (finding) => finding.behaviour === behaviour && finding.outcome === outcome
  );
}

function notTestedOf(
  report: RecoveryDriversReport,
  behaviour: string,
  outcome: string
): RecoveryDriversReport["not_tested"][number] | undefined {
  return report.not_tested.find(
    (entry) => entry.behaviour === behaviour && entry.outcome === outcome
  );
}

function nightsOf(user: Fixture, offset: string, workoutsAvailable = true): Night[] {
  const today = localDay(user.now.toISOString(), offset);
  const placement = placeDays({
    cycles: user.cycles,
    sleeps: user.sleeps,
    recoveries: user.recoveries,
    sleepsAvailable: true,
    today,
    utcOffset: offset,
  });
  return buildNights({
    sleeps: user.sleeps,
    cycles: user.cycles,
    recoveries: user.recoveries,
    workouts: workoutsAvailable ? user.workouts : null,
    workoutsCompleteSince: workoutsAvailable ? "1970-01-01T00:00:00.000Z" : null,
    placement,
    nowMs: user.now.getTime(),
  }).nights;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe(
  "get_recovery_drivers on the live-shaped calibrating account",
  { timeout: TEST_TIMEOUT_MS },
  () => {
    it("reports calibrating, excludes the partial first day with its reason and tests nothing", async () => {
      const live = liveShapedUser();
      const report = await runDrivers(live);
      expect(report.status).toBe("calibrating");
      expect(report.pairs_analyzed).toBe(0);
      expect(report.pairs_required).toBe(DRIVERS_MIN_PAIRS);
      expect(report.excluded_pairs).toEqual({
        calibrating: 1,
        pending: 0,
        unscored: 0,
        no_prior_cycle: 0,
        partial_or_in_progress: 1,
        short_or_long_cycle: 0,
        truncated_history: 0,
      });
      expect(report.findings).toEqual([]);
      const combinations = DRIVER_BEHAVIOURS.length * 3;
      expect(report.not_tested).toHaveLength(combinations);
      expect(report.not_tested.every((entry) => entry.reason === "too_few_pairs")).toBe(true);
      expect(report.not_tested_summary).toEqual({
        too_few_pairs: combinations,
        too_few_distinct_values: 0,
        group_too_small: 0,
        data_unavailable: 0,
        tautological: 0,
        low_effective_sample: 0,
      });
      expect(report.output_capped).toBe(false);
      expect(report.truncated).toBe(false);
      expect(report.buckets).toBeNull();
      expect(report.notes.join(" ")).toContain("0 of 14 pairs required");
      expect(report.notes.join(" ")).toContain("partial first day");
      expect(report.data_quality.method_version).toBe("recovery-drivers-1");
      expect(report.data_quality.sources.recovery!.exclusions.calibrating).toBe(1);
      expect(report.data_quality.observed_period).toBeNull();
      expect(report.period).toEqual({
        start: "2026-06-19T00:00:00.000+02:00",
        end: "2026-09-16T23:30:00.000+02:00",
        days: 90,
        first_day: "2026-06-19",
        last_day: "2026-09-16",
      });
      expect(report.data_quality.requested_period).toEqual({
        start: report.period.start,
        end: report.period.end,
      });
      expect(report.data_quality.evaluated_at).toBe("2026-09-16T23:30:00.000+02:00");
      expect(report.data_quality.limitations).toEqual(
        expect.arrayContaining([...HISTORY_LIMITATIONS])
      );
      expect(report.disclaimer).toBe(DISCLAIMER);
      expect(report.warnings).toEqual([]);
      assertNeutralText(report);
    });

    it("includes the calibrating night with include_calibrating and stays insufficient", async () => {
      const report = await runDrivers(liveShapedUser(), { include_calibrating: true });
      expect(report.status).toBe("insufficient_data");
      expect(report.pairs_analyzed).toBe(1);
      expect(report.excluded_pairs.calibrating).toBe(0);
      expect(report.excluded_pairs.partial_or_in_progress).toBe(1);
      expect(report.not_tested.every((entry) => entry.reason === "too_few_pairs")).toBe(true);
      expect(report.not_tested.find((entry) => entry.behaviour === "prior_day_strain")?.n).toBe(1);
      // The 09-15 padel session ended 1 h 39 min before the 23:13 onset.
      expect(report.evening_training).toMatchObject({ late_days: 1, other_days: 0 });
      expect(report.evening_training.late_outcome_mean).toBeNull();
      expect(report.same_day?.zones.yellow).toEqual({
        days: 1,
        strain_mean: null,
        strain_median: null,
      });
      assertNeutralText(report);
    });
  }
);

describe("statistical behaviour", { timeout: TEST_TIMEOUT_MS }, () => {
  it("finds a planted late-bedtime → lower HRV link and keeps noise inconsistent across 20 seeds", async () => {
    let plantedConsistent = 0;
    let noiseTests = 0;
    let noiseConsistent = 0;
    let seedsWithConsistentNoise = 0;
    const rhos: number[] = [];
    for (let seed = 1; seed <= 20; seed++) {
      const report = await runDrivers(plantedUser(seed));
      expect(report.status).toBe("available");
      expect(report.pairs_analyzed).toBe(90);
      const planted = findingOf(report, "bedtime_min", "hrv");
      expect(planted).toBeDefined();
      rhos.push(planted!.effect.spearman_rho!);
      if (planted!.consistent && planted!.q! <= 0.1) plantedConsistent++;
      let noiseInSeed = false;
      for (const finding of report.findings) {
        if (finding.behaviour === "bedtime_min" && finding.outcome === "hrv") continue;
        // Bedtime deviation is derived from bedtime but not linked to HRV in the fixture.
        noiseTests++;
        if (finding.consistent) {
          noiseConsistent++;
          noiseInSeed = true;
        }
      }
      if (noiseInSeed) seedsWithConsistentNoise++;
      // Every combination is either reported as a finding or counted as not tested.
      const notTested = Object.values(report.not_tested_summary).reduce((a, b) => a + b, 0);
      expect(report.findings.length + notTested).toBe(DRIVER_BEHAVIOURS.length * 3);
    }
    expect(plantedConsistent).toBe(20);
    const meanRho = rhos.reduce((sum, rho) => sum + rho, 0) / rhos.length;
    expect(meanRho).toBeGreaterThan(-0.7);
    expect(meanRho).toBeLessThan(-0.5);
    expect(noiseTests).toBeGreaterThan(20 * 30);
    // No noise behaviour is consistent in at least 95% of the 20 seeds (19 of 20)...
    expect(seedsWithConsistentNoise).toBeLessThanOrEqual(1);
    // ...and across all seeds far fewer than 5% of the noise tests are.
    expect(noiseConsistent / noiseTests).toBeLessThanOrEqual(0.01);
  });

  it("describes a consistent finding with direction, strength, CI and n; others neutrally", async () => {
    const report = await runDrivers(plantedUser(3));
    const planted = findingOf(report, "bedtime_min", "hrv")!;
    expect(report.findings[0]).toBe(planted);
    expect(planted.kind).toBe("continuous");
    expect(planted.ci95!.high).toBeLessThan(0);
    expect(planted.text).toMatch(
      /^On nights with a later bedtime, next-morning HRV tended to be lower \((moderate|large) association: rho -0\.\d\d, 95% CI -0\.\d\d to -0\.\d\d, n=90\)\.$/
    );
    expect(planted.strength).toBe(strengthOf(planted.effect.spearman_rho!));
    expect(planted.partly_by_construction).toBe(false);
    for (const finding of report.findings.filter((entry) => !entry.consistent)) {
      expect(finding.text).toBe(`No consistent association found (n=${finding.n}).`);
    }
    // Consistent findings first, then by effect size.
    const consistentFlags = report.findings.map((finding) => finding.consistent);
    expect(consistentFlags).toEqual([...consistentFlags].sort((a, b) => Number(b) - Number(a)));
    const partly = findingOf(report, "asleep_hours", "recovery");
    expect(partly?.partly_by_construction).toBe(true);
    assertNeutralText(report);
  });

  it("does not report independent AR(0.7) series as consistent and shrinks n_eff well below n", async () => {
    let consistent = 0;
    let naiveSignificant = 0;
    const ratios: number[] = [];
    for (let seed = 1; seed <= 20; seed++) {
      const report = await runDrivers(autocorrelatedUser(seed));
      const finding = findingOf(report, "prior_day_strain", "hrv")!;
      expect(finding).toBeDefined();
      ratios.push(finding.n_eff / finding.n);
      if (finding.consistent) consistent++;
      const naive = correlationInterval(finding.effect.spearman_rho!, finding.n)!;
      if (naive.low > 0 || naive.high < 0) naiveSignificant++;
      if (naive.low > 0 || naive.high < 0) expect(finding.p!).toBeGreaterThan(naive.p);
    }
    expect(consistent).toBe(0);
    const meanRatio = ratios.reduce((sum, ratio) => sum + ratio, 0) / ratios.length;
    expect(meanRatio).toBeLessThan(0.6);
    // Without the correction some of these unrelated series would look related.
    expect(naiveSignificant).toBeGreaterThan(0);
  });

  it("classifies strength by |rho| or |delta|", () => {
    expect(strengthOf(0.099)).toBe("negligible");
    expect(strengthOf(-0.1)).toBe("small");
    expect(strengthOf(0.3)).toBe("moderate");
    expect(strengthOf(-0.5)).toBe("large");
  });
});

describe("binary behaviours and workouts", { timeout: TEST_TIMEOUT_MS }, () => {
  function steadyNights(
    count: number,
    seed: number,
    lateOn: (index: number) => boolean
  ): NightPlan[] {
    const random = createLcg(hashSeed("p9-steady", seed));
    return Array.from({ length: count }, (_, index) =>
      noiseNight(random, {
        workouts: lateOn(index)
          ? [{ endBeforeNextOnsetMin: 60, durationMin: 40 }]
          : [{ startLocalMin: 12 * 60, durationMin: 40 }],
      })
    );
  }

  it("reports group_too_small for late_workout with only 4 late nights", async () => {
    const lateIndexes = new Set([10, 30, 50, 70]);
    const user = buildUser(steadyNights(91, 1, (index) => lateIndexes.has(index)));
    const report = await runDrivers(user);
    expect(report.status).toBe("available");
    for (const outcome of ["recovery", "hrv", "rhr"]) {
      expect(notTestedOf(report, "late_workout", outcome)).toMatchObject({
        reason: "group_too_small",
        n: 90,
      });
    }
    expect(report.evening_training).toMatchObject({ late_days: 4, other_days: 86 });
    expect(report.evening_training.difference).toBeNull();
  });

  it("marks workout behaviours data_unavailable when workouts cannot be read (never 'no workout')", async () => {
    const user = plantedUser(5);
    const client = clientFor(user, {
      failures: [
        { path: /\/v2\/activity\/workout/, error: new WhoopApiError(500, "Server Error", {}) },
      ],
    });
    const report = await runDrivers(user, { focus: "late_workout" }, { client });
    expect(report.status).toBe("available");
    for (const behaviour of [
      "late_workout",
      "prior_day_trimp",
      "prior_day_workout_minutes",
      "hard_zone_minutes",
      "last_workout_to_bed_min",
    ]) {
      for (const outcome of ["recovery", "hrv", "rhr"]) {
        expect(notTestedOf(report, behaviour, outcome)?.reason).toBe("data_unavailable");
      }
    }
    expect(report.evening_training).toMatchObject({
      late_days: 0,
      other_days: 0,
      difference: null,
    });
    expect(report.buckets).toBeNull();
    expect(report.warnings.join(" ")).toContain("Workout data could not be read");
    expect(report.data_quality.sources.workout!.status).toBe("fetch_failed");
    expect(findingOf(report, "bedtime_min", "hrv")?.consistent).toBe(true);
  });

  it("counts a workout ending 2 h 55 min before sleep onset as late and 3 h 05 min as not", async () => {
    expect(LATE_WORKOUT_HOURS).toBe(3);
    const random = createLcg(hashSeed("p9-late-boundary"));
    const plans = Array.from({ length: 31 }, (_, index) =>
      noiseNight(random, {
        workouts: [{ endBeforeNextOnsetMin: index % 2 === 0 ? 175 : 185, durationMin: 45 }],
      })
    );
    // The newest night has no following onset, so its cycle gets a midday workout instead.
    plans[30] = { ...plans[30]!, workouts: [{ startLocalMin: 12 * 60, durationMin: 45 }] };
    const user = buildUser(plans);
    const report = await runDrivers(user, { days: 30 });
    // Nights 1..30 are in the window; night k's prior workouts are from plan k − 1.
    const late = Array.from({ length: 30 }, (_, k) => (k % 2 === 0 ? 1 : 0)).reduce<number>(
      (sum, value) => sum + value,
      0
    );
    expect(report.evening_training).toMatchObject({ late_days: late, other_days: 30 - late });

    const nights = nightsOf(user, "+02:00");
    const byGap = new Map<number, number | null>();
    for (const night of nights) {
      const workout = night.workouts_in_prior_cycle?.[0];
      if (!workout) continue;
      const gap = Math.round((Date.parse(night.sleep.start) - Date.parse(workout.end)) / MINUTE_MS);
      byGap.set(gap, nightBehaviours(night).late_workout);
    }
    expect(byGap.get(175)).toBe(1);
    expect(byGap.get(185)).toBe(0);
  });

  // A wake day whose UTC midnight is a multiple of 30 days since the epoch (a history chunk boundary).
  const boundaryDay = new Date(
    Math.floor(Date.parse("2026-09-10T00:00:00Z") / HISTORY_CHUNK_MS) * HISTORY_CHUNK_MS
  )
    .toISOString()
    .slice(0, 10);
  for (const { daysAfter, startMin, durationMin } of [
    { daysAfter: 5, startMin: 5, durationMin: 25 },
    { daysAfter: 0, startMin: 30, durationMin: 10 },
    { daysAfter: 0, startMin: -10, durationMin: 30 },
  ]) {
    const clock = `${startMin < 0 ? "23" : "00"}:${String((startMin + 60) % 60).padStart(2, "0")}`;
    it(`counts a ${clock} workout at a history chunk boundary ${daysAfter} days before the last wake day toward the previous day, once`, async () => {
      const lastWakeDay = addDaysTo(boundaryDay, daysAfter);
      const random = createLcg(hashSeed("p9-chunk", daysAfter, startMin));
      const plans = Array.from({ length: 40 }, () =>
        noiseNight(random, { workouts: [{ startLocalMin: 12 * 60, durationMin: 30 }] })
      );
      const boundaryIndex = 39 - daysAfter;
      // The night waking on the boundary day starts at 00:50; the workout before it ends 10-20
      // minutes earlier, after local (UTC) midnight, in the previous day's cycle.
      const onsetMin = 50;
      plans[boundaryIndex] = { ...plans[boundaryIndex]!, bedtime: onsetMin };
      plans[boundaryIndex - 1] = {
        ...plans[boundaryIndex - 1]!,
        workouts: [{ endBeforeNextOnsetMin: onsetMin - (startMin + durationMin), durationMin }],
      };
      const user = buildUser(plans, { offset: "Z", lastWakeDay });
      const boundaryMs = Date.parse(`${boundaryDay}T00:00:00.000Z`);
      const workout = user.workouts.find(
        (entry) => Date.parse(entry.start) === boundaryMs + startMin * MINUTE_MS
      );
      expect(workout).toBeDefined();
      const report = await runDrivers(user, { days: 30, focus: "late_workout" });
      expect(report.truncated).toBe(false);
      // Exactly one late night: the one waking on the boundary day.
      expect(report.evening_training.late_days).toBe(1);
      expect(report.buckets!.groups.find((group) => group.label === "yes")!.n).toBe(1);
      // A workout returned by both chunks is merged: every workout overlapping the chunk grid once.
      const gridStartMs =
        Math.floor(
          Date.parse(`${addDaysTo(report.period.first_day, -2)}T00:00:00.000Z`) / HISTORY_CHUNK_MS
        ) * HISTORY_CHUNK_MS;
      const overlapping = user.workouts.filter(
        (entry) =>
          Date.parse(entry.end) > gridStartMs && Date.parse(entry.start) < user.now.getTime()
      );
      expect(report.data_quality.sources.workout!.records_fetched).toBe(overlapping.length);
      const night = nightsOf(user, "Z").find((entry) => entry.wake_day === boundaryDay)!;
      expect(night.prior_day).toBe(addDaysTo(boundaryDay, -1));
      expect(night.workouts_in_prior_cycle?.map((entry) => entry.id)).toEqual([workout!.id]);
    });
  }

  it("derives night behaviours with unknown values as null", () => {
    const random = createLcg(hashSeed("p9-behaviours"));
    const plans: NightPlan[] = [
      noiseNight(random, {
        workouts: [
          { startLocalMin: 10 * 60, durationMin: 60, fraction: 0.85, zoneHighMin: 6 },
          { endBeforeNextOnsetMin: 100, durationMin: 30 },
        ],
      }),
      noiseNight(random, {
        workouts: [
          { startLocalMin: 10 * 60, durationMin: 40, zoneHighMin: 4 },
          { startLocalMin: 13 * 60, durationMin: 20, state: "PENDING_SCORE" },
        ],
        nap: "PENDING_SCORE",
      }),
      noiseNight(random, { workouts: [], nap: "SCORED" }),
      noiseNight(random, {
        workouts: [{ startLocalMin: 9 * 60, durationMin: 50, zoneHighMin: 3 }],
      }),
      noiseNight(random, { workouts: [] }),
    ];
    for (const plan of plans) delete plan.nap;
    plans[1]!.nap = "PENDING_SCORE";
    plans[2]!.nap = "SCORED";
    const user = buildUser(plans);
    const byWake = new Map(nightsOf(user, "+02:00").map((night) => [night.wake_day, night]));
    const night = (index: number): Night => byWake.get(user.wakeDays[index]!)!;

    // Low recording: timing is known, load is not.
    const lowRecording = nightBehaviours(night(1));
    expect(lowRecording.prior_day_workout_minutes).toBeCloseTo(90, 6);
    expect(lowRecording.prior_day_trimp).toBeNull();
    expect(lowRecording.hard_zone_minutes).toBeNull();
    expect(lowRecording.late_workout).toBe(1);
    expect(lowRecording.last_workout_to_bed_min).toBeCloseTo(100, 6);
    expect(lowRecording.nap_before).toBe(0);

    // An unscored workout and an unscored nap.
    const unscored = nightBehaviours(night(2));
    expect(unscored.prior_day_workout_minutes).toBeCloseTo(60, 6);
    expect(unscored.prior_day_trimp).toBeNull();
    expect(unscored.unscored_workouts).toBe(1);
    expect(unscored.late_workout).toBe(0);
    expect(unscored.nap_before).toBeNull();

    // A known day without workouts is 0; time from the last workout only exists on workout days.
    const rest = nightBehaviours(night(3));
    expect(rest.prior_day_workout_minutes).toBe(0);
    expect(rest.prior_day_trimp).toBe(0);
    expect(rest.hard_zone_minutes).toBe(0);
    expect(rest.late_workout).toBe(0);
    expect(rest.last_workout_to_bed_min).toBeNull();
    expect(rest.nap_before).toBe(1);

    // Scored and fully recorded: TRIMP from zones, zone 4 + 5 minutes.
    const scored = nightBehaviours(night(4));
    expect(scored.hard_zone_minutes).toBeCloseTo(6, 6);
    expect(scored.prior_day_trimp).toBeCloseTo((50 - 6 - 1) * 1 + 1 * 2 + 3 * 4 + 3 * 5, 6);
    expect(scored.debt_entering_hours).toBeCloseTo(plans[4]!.debtHours, 3);
    expect(scored.asleep_hours).toBeCloseTo(
      Math.round(plans[4]!.asleepMin * MINUTE_MS) / 3_600_000,
      6
    );

    // Workouts unavailable: every workout value is null.
    const unavailable = nightsOf(user, "+02:00", false).find(
      (entry) => entry.wake_day === user.wakeDays[4]
    )!;
    const values = nightBehaviours(unavailable);
    expect([
      values.prior_day_workout_minutes,
      values.prior_day_trimp,
      values.hard_zone_minutes,
      values.late_workout,
      values.last_workout_to_bed_min,
    ]).toEqual([null, null, null, null, null]);
  });
});

describe("local days, bedtimes and tags", { timeout: TEST_TIMEOUT_MS }, () => {
  it("orders a 23:30 bedtime before 00:30 (unwrapped around the window's circular mean)", async () => {
    const random = createLcg(hashSeed("p9-wrap"));
    const normal = gaussian(random);
    const bedtimes = [-60, -30, 0, 30, 60];
    const plans = Array.from({ length: 61 }, (_, index) => {
      const bedtime = bedtimes[(index * 3) % 5]!;
      // Later bedtime (23:00 → 01:00) → lower HRV, in the unwrapped order only.
      return noiseNight(random, { bedtime, hrv: 90 - 0.3 * (bedtime + 60) + 3 * normal() });
    });
    const report = await runDrivers(buildUser(plans), { days: 60, focus: "bedtime_min" });
    const finding = findingOf(report, "bedtime_min", "hrv")!;
    expect(finding.effect.spearman_rho).toBeLessThan(-0.8);
    expect(finding.consistent).toBe(true);
    const buckets = report.buckets!;
    expect(buckets.basis).toBe("tertiles");
    expect(buckets.unit).toBe("minutes after local midnight");
    // Tertile cuts reported as clock minutes: before midnight and after midnight.
    expect(buckets.cut_points).toHaveLength(2);
    expect(buckets.cut_points![0]).toBeGreaterThan(1400);
    expect(buckets.cut_points![1]).toBeLessThan(60);
    const hrvMeans = buckets.groups.map(
      (group) => group.outcomes.find((entry) => entry.outcome === "hrv")!.mean!
    );
    expect(hrvMeans[0]).toBeGreaterThan(hrvMeans[1]!);
    expect(hrvMeans[1]).toBeGreaterThan(hrvMeans[2]!);
  });

  for (const offset of ["+02:00", "-05:00"]) {
    it(`maps tag date D to the sleep ending on D+1 at ${offset}`, async () => {
      const random = createLcg(hashSeed("p9-tags", offset));
      const normal = gaussian(random);
      const lastWakeDay = "2026-09-16";
      const tagged = new Set<number>();
      const plans = Array.from({ length: 91 }, (_, index) => {
        const isTagged = index % 4 === 1;
        if (isTagged) tagged.add(index);
        // Bedtimes on both sides of midnight, so UTC and local dates differ.
        return noiseNight(random, {
          bedtime: index % 2 === 0 ? -25 : 35,
          hrv: 70 + 5 * normal() - (isTagged ? 20 : 0),
        });
      });
      const user = buildUser(plans, { offset, lastWakeDay });
      const dates = [...tagged]
        .filter((index) => index >= 1)
        .map((index) => addDaysTo(user.wakeDays[index]!, -1));
      const shifted = dates.map((date) => addDaysTo(date, 1)).filter((date) => date < "2026-09-16");
      const report = await runDrivers(user, {
        outcomes: ["hrv"],
        custom_tags: [
          { name: "alcohol", dates: [...dates, "2025-12-31", "2026-09-16"] },
          { name: "shifted", dates: shifted },
        ],
      });
      const tag = report.tags.find((entry) => entry.name === "alcohol")!;
      expect(tag.dates_matched).toBe(dates.length);
      expect(tag.dates_outside_window).toEqual(["2025-12-31", "2026-09-16"]);
      expect(tag.dates_without_pair).toEqual([]);
      const finding = findingOf(report, "tag:alcohol", "hrv")!;
      expect(finding.kind).toBe("binary");
      expect(finding.consistent).toBe(true);
      expect(finding.effect.median_difference!).toBeLessThan(-14);
      expect(finding.effect.median_difference!).toBeGreaterThan(-26);
      expect(finding.effect.cliffs_delta!).toBeLessThan(-0.8);
      expect(finding.text).toMatch(
        /^On nights after days tagged "alcohol", next-morning HRV tended to be lower \(large association: Cliff's delta -[01]\.\d\d, median difference -\d+\.\d ms, n=90\)\.$/
      );
      // The same dates one day later match the nights after the low-HRV nights: the lower
      // HRV does not follow them (their untagged group contains the low nights instead).
      const shiftedFinding = findingOf(report, "tag:shifted", "hrv")!;
      expect(report.tags.find((entry) => entry.name === "shifted")!.dates_matched).toBe(
        shifted.length
      );
      expect(shiftedFinding.effect.cliffs_delta!).toBeGreaterThan(0);
      expect(shiftedFinding.text).not.toContain("tended to be lower");
      expect(report.notes.join(" ")).toContain("days not listed for a tag are assumed");
      assertNeutralText(report);
    });
  }

  it("reports tag dates inside the window without an analysed night", async () => {
    const random = createLcg(hashSeed("p9-tag-gap"));
    const plans = Array.from({ length: 31 }, () => noiseNight(random));
    plans[20] = { ...plans[20]!, sleepState: "PENDING_SCORE" };
    const user = buildUser(plans);
    const report = await runDrivers(user, {
      days: 30,
      custom_tags: [
        {
          name: "late meal",
          dates: [addDaysTo(user.wakeDays[20]!, -1), addDaysTo(user.wakeDays[5]!, -1)],
        },
      ],
    });
    expect(report.excluded_pairs.pending).toBe(1);
    expect(report.tags).toEqual([
      {
        name: "late meal",
        dates_matched: 1,
        dates_outside_window: [],
        dates_without_pair: [addDaysTo(user.wakeDays[20]!, -1)],
      },
    ]);
  });
});

describe("calibration, buckets and sections", { timeout: TEST_TIMEOUT_MS }, () => {
  it("excludes calibrating recoveries by default and includes them with the flag", async () => {
    const random = createLcg(hashSeed("p9-calibrating"));
    const plans = Array.from({ length: 91 }, (_, index) =>
      noiseNight(random, { calibrating: index <= 30 })
    );
    const user = buildUser(plans);
    const byDefault = await runDrivers(user);
    expect(byDefault.excluded_pairs.calibrating).toBe(30);
    expect(byDefault.pairs_analyzed).toBe(60);
    expect(byDefault.status).toBe("available");
    const included = await runDrivers(user, { include_calibrating: true });
    expect(included.excluded_pairs.calibrating).toBe(0);
    expect(included.pairs_analyzed).toBe(90);

    const early = buildUser(plans.slice(0, 40));
    const calibrating = await runDrivers(early, { days: 39 });
    expect(calibrating.status).toBe("calibrating");
    expect(calibrating.pairs_analyzed).toBe(9);
    expect(calibrating.notes[0]).toContain("9 of 14 pairs required");
  });

  it("puts strain band edges 9.99/10/13.99/14/17.99/18 into WHOOP's bands", async () => {
    expect(strainBand(0)).toBe("Light");
    expect(strainBand(9.99)).toBe("Light");
    expect(strainBand(10)).toBe("Moderate");
    expect(strainBand(13.99)).toBe("Moderate");
    expect(strainBand(14)).toBe("High");
    expect(strainBand(17.99)).toBe("High");
    expect(strainBand(18)).toBe("All out");
    expect(strainBand(21)).toBe("All out");

    const random = createLcg(hashSeed("p9-bands"));
    const strains = [
      9.99, 10, 13.99, 14, 17.99, 18, 9.99, 10, 13.99, 14, 17.99, 9.99, 10, 13.99, 14, 17.99,
    ];
    const plans = Array.from({ length: strains.length + 1 }, (_, index) =>
      noiseNight(random, { strain: strains[index] ?? 12 })
    );
    const report = await runDrivers(buildUser(plans), { days: 30, focus: "prior_day_strain" });
    expect(report.pairs_analyzed).toBe(16);
    const buckets = report.buckets!;
    expect(buckets.basis).toBe("whoop_strain_bands");
    expect(buckets.cut_points).toEqual([10, 14, 18]);
    expect(buckets.groups.map((group) => [group.label, group.low, group.high, group.n])).toEqual([
      ["Light", 0, 10, 3],
      ["Moderate", 10, 14, 6],
      ["High", 14, 18, 6],
      ["All out", 18, 21, 1],
    ]);
    const allOut = buckets.groups[3]!.outcomes;
    expect(
      allOut.every((entry) => entry.n === 1 && entry.mean === null && entry.median === null)
    ).toBe(true);
    const light = buckets.groups[0]!.outcomes.find((entry) => entry.outcome === "hrv")!;
    expect(light.n).toBe(3);
    expect(light.mean).not.toBeNull();
    expect(report.notes.join(" ")).toContain("Strain bands are WHOOP's");
  });

  it("reports tertile cut points for a continuous focus and no buckets below 14 pairs", async () => {
    const user = plantedUser(7);
    const report = await runDrivers(user, { focus: "asleep_hours" });
    const buckets = report.buckets!;
    expect(buckets.basis).toBe("tertiles");
    const nights = nightsOf(user, "+02:00").filter(
      (night) => night.wake_day >= report.period.first_day
    );
    const values = nights.map((night) => nightBehaviours(night).asleep_hours!);
    const cuts = quantileCuts(values, 3)!;
    expect(buckets.cut_points).toEqual(cuts.map((cut) => roundTo(cut, 2)));
    expect(buckets.groups.map((group) => group.n).reduce((a, b) => a + b, 0)).toBe(90);

    const small = await runDrivers(liveShapedUser(), {
      focus: "asleep_hours",
      include_calibrating: true,
    });
    expect(small.buckets).toBeNull();
    expect(small.notes.join(" ")).toContain("Buckets for asleep_hours need 14 pairs");
  });

  it("groups each previous day's strain by that day's own morning recovery zone with 3 days per zone", async () => {
    const random = createLcg(hashSeed("p9-same-day"));
    // Plan k: the recovery of the sleep starting day k and day k's strain.
    const plans = Array.from({ length: 31 }, (_, index) =>
      noiseNight(random, {
        recovery: index < 2 ? 20 : index % 2 === 0 ? 80 : 50,
        strain: index < 2 ? 6 : index % 2 === 0 ? 15 : 9,
        calibrating: index === 4,
      })
    );
    const user = buildUser(plans);
    const report = await runDrivers(user, { days: 30 });
    const zones = report.same_day!.zones;
    // Nights 1..30 are in the window; their previous days are 0..29. Days 0 and 1 are red,
    // below the 3-day minimum; day 4's morning recovery is calibrating and left out.
    expect(zones.red).toEqual({ days: 2, strain_mean: null, strain_median: null });
    expect(zones.green).toEqual({ days: 13, strain_mean: 15, strain_median: 15 });
    expect(zones.yellow).toEqual({ days: 14, strain_mean: 9, strain_median: 9 });
    expect(report.same_day!.min_days_per_zone).toBe(3);
    // Recoveries used: 28 same-day mornings plus the next-morning recoveries of the pairs.
    expect(report.data_quality.sources.recovery!.records_used).toBe(30);

    const included = await runDrivers(user, { days: 30, include_calibrating: true });
    expect(included.same_day!.zones.green.days).toBe(14);
  });

  it("uses the night's own sleep for sleep outcomes and skips tautological combinations", async () => {
    const random = createLcg(hashSeed("p9-sleep-outcome"));
    const normal = gaussian(random);
    const strains: number[] = [];
    const plans = Array.from({ length: 91 }, (_, index) => {
      const strain = roundTo(clamp(10 + 3 * normal(), 1, 20), 4);
      strains.push(strain);
      // Night index's performance follows the previous day's strain (plan index − 1).
      const previous = strains[index - 1] ?? 10;
      return noiseNight(random, {
        strain,
        performance: clamp(Math.round(70 + 3 * (previous - 10) + 4 * normal()), 1, 100),
      });
    });
    const report = await runDrivers(buildUser(plans), {
      outcomes: ["sleep_performance", "asleep_hours"],
    });
    const finding = findingOf(report, "prior_day_strain", "sleep_performance")!;
    expect(finding.consistent).toBe(true);
    expect(finding.effect.spearman_rho).toBeGreaterThan(0.6);
    expect(finding.text).toContain("sleep performance that night tended to be higher");
    expect(report.not_tested_summary.tautological).toBe(6);
    for (const [behaviour, outcome] of [
      ["asleep_hours", "asleep_hours"],
      ["asleep_hours", "sleep_performance"],
      ["efficiency_pct", "sleep_performance"],
      ["efficiency_pct", "asleep_hours"],
      ["disturbances_per_hour", "sleep_performance"],
      ["debt_entering_hours", "sleep_performance"],
    ] as const) {
      expect(notTestedOf(report, behaviour, outcome)?.reason).toBe("tautological");
    }
    expect(findingOf(report, "efficiency_pct", "recovery")).toBeUndefined();
    expect(report.findings.every((entry) => entry.outcome !== "recovery")).toBe(true);
    expect(report.evening_training.outcome).toBe("sleep_performance");
    // Recoveries are read only for same_day (each previous day's own morning).
    const sameDayDays = Object.values(report.same_day!.zones).reduce(
      (sum, zone) => sum + zone.days,
      0
    );
    expect(report.data_quality.sources.recovery!.records_used).toBe(sameDayDays);
    expect(report.notes.join(" ")).not.toContain("WHOOP measures HRV");
    expect(findingOf(report, "disturbances_per_hour", "asleep_hours")?.partly_by_construction).toBe(
      true
    );
  });
});

describe("failures, truncation and limits", { timeout: TEST_TIMEOUT_MS }, () => {
  it("throws the WHOOP error when every source fails", async () => {
    const user = plantedUser(2);
    const client = clientFor(user, {
      failures: [{ path: /\/v2\//, error: new WhoopApiError(401, "Unauthorized", {}) }],
    });
    const connection = await connectServer(client, { now: () => user.now });
    try {
      const result = await connection.callTool(TOOL, {});
      expect(result.isError).toBe(true);
      expect(result.structured).toBeNull();
    } finally {
      await connection.close();
    }
  });

  it("reports unavailable when a required source fails", async () => {
    const user = plantedUser(2);
    const client = clientFor(user, {
      failures: [
        { path: /\/v2\/activity\/sleep/, error: new WhoopApiError(503, "Unavailable", {}) },
      ],
    });
    const report = await runDrivers(
      user,
      { custom_tags: [{ name: "alcohol", dates: [] }] },
      { client }
    );
    expect(report.status).toBe("unavailable");
    expect(report.pairs_analyzed).toBe(0);
    expect(report.findings).toEqual([]);
    expect(report.not_tested.every((entry) => entry.reason === "data_unavailable")).toBe(true);
    expect(report.not_tested_summary.data_unavailable).toBe((DRIVER_BEHAVIOURS.length + 1) * 3);
    expect(report.output_capped).toBe(true);
    expect(report.same_day).toBeNull();
    expect(report.warnings.join(" ")).toContain("Sleep data could not be read");
    expect(report.notes[0]).toContain("required WHOOP data could not be read (sleep)");
  });

  it("keeps sleep outcomes available when only recoveries fail", async () => {
    const user = plantedUser(4);
    const client = clientFor(user, {
      failures: [{ path: /\/v2\/recovery/, error: new WhoopApiError(500, "Server Error", {}) }],
    });
    const sleepOnly = await runDrivers(user, { outcomes: ["asleep_hours"] }, { client });
    expect(sleepOnly.status).toBe("available");
    expect(sleepOnly.pairs_analyzed).toBe(90);
    expect(sleepOnly.same_day).toBeNull();
    expect(sleepOnly.warnings.join(" ")).toContain("Recovery data could not be read");

    // With a recovery outcome as well, that outcome is data_unavailable and the sleep outcome is tested.
    const mixed = await runDrivers(user, { outcomes: ["hrv", "asleep_hours"] }, { client });
    expect(mixed.status).toBe("available");
    expect(mixed.pairs_analyzed).toBe(90);
    expect(mixed.excluded_pairs).toEqual(sleepOnly.excluded_pairs);
    for (const behaviour of DRIVER_BEHAVIOURS) {
      expect(notTestedOf(mixed, behaviour, "hrv")?.reason).toBe("data_unavailable");
    }
    expect(mixed.findings.every((entry) => entry.outcome === "asleep_hours")).toBe(true);
    expect(mixed.findings.length).toBeGreaterThan(0);
    expect(mixed.evening_training).toMatchObject({ outcome: "hrv", late_days: 0, other_days: 0 });
    expect(mixed.warnings.join(" ")).toContain(
      "recovery, HRV and resting heart rate outcomes are not tested (data_unavailable)"
    );
    expect(mixed.data_quality.sources.recovery!.status).toBe("fetch_failed");

    // Only recovery outcomes: the required source failed.
    const recoveryOnly = await runDrivers(user, { outcomes: ["hrv"] }, { client });
    expect(recoveryOnly.status).toBe("unavailable");
    expect(recoveryOnly.notes[0]).toContain("required WHOOP data could not be read (recovery)");
  });

  it("reports calibrating when calibrating recoveries leave nights for sleep outcomes only", async () => {
    const report = await runDrivers(liveShapedUser(), { outcomes: ["hrv", "asleep_hours"] });
    expect(report.status).toBe("calibrating");
    // The 09-16 night is a pair for hours asleep only; its recovery is calibrating.
    expect(report.pairs_analyzed).toBe(1);
    expect(report.excluded_pairs.calibrating).toBe(0);
    expect(report.excluded_pairs.partial_or_in_progress).toBe(1);
    expect(report.notes[0]).toContain("1 night with a calibrating recovery is left out");
    expect(report.notes.join(" ")).toContain(
      "Nights used for sleep outcomes only, without a usable recovery: 1 with a calibrating recovery."
    );
    expect(report.data_quality.sources.recovery!.exclusions.calibrating).toBe(1);
    expect(report.data_quality.sources.recovery!.records_used).toBe(0);
    assertNeutralText(report);
  });

  it("marks nights before an incomplete history chunk as truncated_history", async () => {
    const user = matureUser({ days: 120, seed: 3 });
    const nowMs = user.now.getTime();
    const newestChunk = Math.floor(nowMs / HISTORY_CHUNK_MS) * HISTORY_CHUNK_MS;
    const olderStart = encodeURIComponent(iso(newestChunk - HISTORY_CHUNK_MS));
    const client = clientFor(user, {
      failures: [
        {
          path: new RegExp(`/v2/activity/sleep\\?start=${olderStart.replace(/\./g, "\\.")}`),
          page: 2,
          error: new WhoopApiError(500, "Server Error", {}),
        },
      ],
    });
    const report = await runDrivers(user, {}, { client });
    expect(report.truncated).toBe(true);
    expect(report.excluded_pairs.truncated_history).toBeGreaterThan(0);
    const completeFrom = localDay(iso(newestChunk), "+01:00");
    expect(report.notes.join(" ")).toContain(`sleep complete from ${completeFrom}`);
    expect(report.data_quality.sources.sleep!.truncated).toBe(true);
    // Every analysed night lies in the complete part of the history.
    expect(Date.parse(report.data_quality.observed_period!.start)).toBeGreaterThanOrEqual(
      newestChunk
    );
  });

  it("rejects invalid tag dates and duplicate tag names", async () => {
    const user = liveShapedUser();
    const connection = await connectServer(clientFor(user), { now: () => user.now });
    try {
      const invalid = await connection.callTool(TOOL, {
        custom_tags: [{ name: "alcohol", dates: ["2026-02-30"] }],
      });
      expect(invalid.isError).toBe(true);
      expect(invalid.text).toContain('Invalid calendar date "2026-02-30"');
      const duplicate = await connection.callTool(TOOL, {
        custom_tags: [
          { name: "Alcohol", dates: [] },
          { name: "alcohol", dates: [] },
        ],
      });
      expect(duplicate.isError).toBe(true);
      expect(duplicate.text).toContain("more than once");
      const badName = await connection.callTool(TOOL, {
        custom_tags: [{ name: "-bad", dates: [] }],
      });
      expect(badName.isError).toBe(true);
    } finally {
      await connection.close();
    }
  });

  it("stays within the page budget and the deadline under the rate limiter, continues from the cache and then re-reads only recent chunks", async () => {
    vi.useFakeTimers();
    try {
      const user = stressUser();
      const cache = new MemoryCache({ maxEntries: 500 });
      const client = clientFor(user, {
        rateLimiter: createRateLimiter({ perMinute: DEFAULT_RATE_LIMIT_PER_MINUTE }),
      });
      const call = async (): Promise<{
        report: RecoveryDriversReport;
        elapsedMs: number;
        paths: string[];
      }> => {
        const startedAtMs = Date.now();
        const before = client.calls.length;
        let settled = false;
        const pending = runDrivers(user, { days: 180 }, { client, cache }).finally(() => {
          settled = true;
        });
        while (!settled) await vi.advanceTimersByTimeAsync(100);
        const report = await pending;
        return { report, elapsedMs: Date.now() - startedAtMs, paths: client.calls.slice(before) };
      };

      // Paced at 60 requests per minute (20 at once), the first call stops at the deadline.
      const first = await call();
      expect(first.elapsedMs).toBeLessThanOrEqual(HISTORY_DEADLINE_MS + 200);
      // The offset lookup is the only request outside the history budget.
      expect(first.paths.length).toBeLessThanOrEqual(DEFAULT_PAGE_BUDGET + 1);
      expect(first.report.truncated).toBe(true);
      expect(first.report.notes.join(" ")).toContain(
        "Repeating the request continues from the cache"
      );

      // Repeated calls continue with the older chunks until the 180 days are complete.
      let latest = first;
      for (let attempt = 0; attempt < 4 && latest.report.truncated; attempt++) {
        latest = await call();
        expect(latest.elapsedMs).toBeLessThanOrEqual(HISTORY_DEADLINE_MS + 200);
        expect(latest.paths.length).toBeLessThanOrEqual(DEFAULT_PAGE_BUDGET);
      }
      expect(latest.report.truncated).toBe(false);
      expect(latest.report.excluded_pairs.truncated_history).toBe(0);
      expect(latest.report.pairs_analyzed).toBeGreaterThan(first.report.pairs_analyzed);

      // Ten minutes later only the open chunk and chunks ending within 3 days are read again.
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      const repeat = await call();
      // Same analysis; only cache_status and fetched_at in data_quality differ.
      expect({ ...repeat.report, data_quality: null }).toEqual({
        ...latest.report,
        data_quality: null,
      });
      const nowMs = user.now.getTime();
      for (const path of repeat.paths) {
        const end = new URL(path, "https://whoop.test").searchParams.get("end");
        if (end !== null) expect(Date.parse(end)).toBeGreaterThan(nowMs - SETTLED_MS);
      }
      expect(repeat.paths.length).toBeLessThan(first.paths.length);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns stressUser at maximum arguments within MAX_TOOL_TEXT_CHARS with neutral text and a valid contract", async () => {
    const user = stressUser();
    const connection = await connectServer(clientFor(user), { now: () => user.now });
    try {
      const tagDates = (step: number): string[] =>
        Array.from({ length: 180 }, (_, index) => addDaysTo("2026-09-15", -index * step)).slice(
          0,
          180
        );
      const result = await connection.callTool(TOOL, {
        days: 180,
        outcomes: ["recovery", "hrv", "rhr", "sleep_performance", "asleep_hours"],
        include_calibrating: true,
        focus: "prior_day_strain",
        custom_tags: [
          { name: "alcohol", dates: tagDates(3) },
          { name: "late meal", dates: tagDates(2) },
          { name: "Travel_day-1", dates: tagDates(7) },
        ],
      });
      expect(result.isError).toBe(false);
      expect(result.text.length).toBeLessThanOrEqual(MAX_TOOL_TEXT_CHARS);
      const report = recoveryDriversOutputSchema.parse(result.structured);
      expect(JSON.parse(result.text)).toEqual(result.structured);
      expect(report.findings.length).toBeLessThanOrEqual(40);
      expect(report.not_tested.length).toBeLessThanOrEqual(40);
      for (const finding of report.findings) {
        expect(finding.p!).toBeGreaterThanOrEqual(DRIVERS_MIN_REPORTED_P);
        expect(finding.q!).toBeGreaterThanOrEqual(DRIVERS_MIN_REPORTED_P);
      }
      const disturbances = findingOf(report, "disturbances_per_hour", "asleep_hours");
      if (disturbances) expect(disturbances.partly_by_construction).toBe(true);
      expect(report.output_capped).toBe(true);
      expect(report.tags).toHaveLength(3);
      expect(report.buckets?.basis).toBe("whoop_strain_bands");
      assertNeutralText(report);
    } finally {
      await connection.close();
    }
  });
});

describe("registration", { timeout: TEST_TIMEOUT_MS }, () => {
  it("is listed in standard mode with a read-only annotation and absent in aggregate mode", async () => {
    expect(await listToolNames("standard")).toContain(TOOL);
    expect(await listToolNames("aggregate")).not.toContain(TOOL);
    const connection = await connectServer(createWhoopFixtureClient());
    try {
      const tool = connection.tools.find((entry) => entry.name === TOOL)!;
      expect(tool.title).toBe("Recovery patterns");
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.description!.length).toBeLessThanOrEqual(1000);
      expect(tool.outputSchema).toBeDefined();
    } finally {
      await connection.close();
    }
  });

  it("validates the live-shaped result against the contract in standard mode and is not callable in aggregate mode", async () => {
    const user = liveShapedUser();
    const standard = await connectServer(clientFor(user), { now: () => user.now });
    try {
      const result = await standard.callTool(TOOL, {
        include_calibrating: true,
        focus: "bedtime_min",
      });
      expect(result.isError).toBe(false);
      expect(result.text).toBe(JSON.stringify(result.structured));
      assertNeutralText(result.structured);
    } finally {
      await standard.close();
    }
    const aggregate = await connectServer(clientFor(user), {
      privacyMode: "aggregate",
      now: () => user.now,
    });
    try {
      const result = await aggregate.client
        .callTool({ name: TOOL, arguments: {} })
        .then((value) => ({ rejected: false, value }))
        .catch(() => ({ rejected: true, value: null }));
      const isError =
        result.rejected || (result.value as { isError?: boolean } | null)?.isError === true;
      expect(isError).toBe(true);
    } finally {
      await aggregate.close();
    }
  });

  it("runs on a mature user with gaps, a split night, naps and an offset change", async () => {
    const user = matureUser({ days: 120, seed: 11 });
    const report = await runDrivers(user, { focus: "nap_before" });
    expect(report.status).toBe("available");
    expect(report.pairs_analyzed).toBeGreaterThan(70);
    expect(report.excluded_pairs.pending).toBe(1);
    expect(report.buckets?.basis).toBe("binary_groups");
    expect(report.buckets?.groups.map((group) => group.label)).toEqual(["no", "yes"]);
    const analysed = nightsOf(user, user.offset).filter(
      (night) => night.wake_day >= report.period.first_day
    );
    expect(analysed.length).toBeGreaterThanOrEqual(report.pairs_analyzed);
    assertNeutralText(report);
  });
});
