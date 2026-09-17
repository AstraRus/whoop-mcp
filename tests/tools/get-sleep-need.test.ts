/**
 * Tests for get_sleep_need (package P8).
 *
 * Covers: the live-shaped account (one pair: insufficient history, last night's
 * WHOOP need, today's strain in progress), a synthetic account whose WHOOP need
 * follows a known rule (debt = 0.5 × shortfall A, strain need = f(strain)):
 * variant A, exact carry fraction and match rate, component model selected;
 * a drifting need where persistence wins; strain so far above the observed
 * range; nap components (fewer than 3 nap pairs, a negative ratio applied with
 * its sign, nonzero nap need without naps); closed newest cycle; pending last
 * night; pair exclusions; in-bed arithmetic; source failures; output size and
 * requests on stressUser; neutral wording and the MCP contract.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { WhoopApiError, type WhoopClient } from "../../src/api/client.js";
import { DEFAULT_PAGE_BUDGET } from "../../src/api/history.js";
import { MemoryCache } from "../../src/cache/memory-cache.js";
import type { Cycle, Recovery, ScoreState, Sleep } from "../../src/api/types.js";
import { addDays } from "../../src/tools/day-model.js";
import {
  buildSleepNeedPairs,
  DEBT_MODEL_MIN_PAIRS,
  fitDebtModel,
  getSleepNeedTool,
  IN_BED_ARITHMETIC_LABEL,
  inBedArithmetic,
  indexSleepNeedRecords,
  NAP_MODEL_MIN_PAIRS,
  runSleepNeed,
  SLEEP_NEED_LABEL,
  sleepNeedOutputSchema,
  STRAIN_MODEL_MIN_PAIRS,
  type SleepNeedInput,
  type SleepNeedReport,
} from "../../src/tools/get-sleep-need.js";
import { MAX_TOOL_TEXT_CHARS, type ToolContext } from "../../src/tools/tool-definition.js";
import { assertNeutralText, connectServer, listToolNames } from "../helpers/contract.js";
import {
  createWhoopFixtureClient,
  type WhoopFixtureClient,
  type WhoopFixtureClientOptions,
} from "../helpers/whoop-fixture-client.js";
import {
  LIVE_SHAPED_IDS,
  liveShapedUser,
  matureUser,
  stressUser,
  type WhoopUserFixture,
} from "../helpers/whoop-users.js";

/** Tests that run stressUser or the MCP server take longer under a loaded full-suite run. */
const HEAVY_TEST_TIMEOUT_MS = 30_000;

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const OFFSET = "+02:00";
const LAST_DAY = "2026-09-16";

// ---------------------------------------------------------------------------
// Synthetic need accounts
// ---------------------------------------------------------------------------

/** A night's WHOOP need components in milliseconds. */
interface NeedMs {
  baseline: number;
  debt: number;
  strain: number;
  nap: number;
}

/** What the need rule sees of the previous night and the cycle it started. */
interface PreviousNight {
  index: number;
  asleepMs: number;
  need: NeedMs;
  strain: number;
  napAsleepMs: number;
}

interface NeedUserOptions {
  /** Nights 0..count−1; the last one started the open cycle. */
  count: number;
  asleepMin: (index: number) => number;
  /** Strain of cycle `index` (the last one is the strain so far). */
  strain: (index: number) => number;
  /** Asleep minutes of the naps in cycle `index`. */
  naps?: (index: number) => number[];
  /** This night's need from the previous night (null for the first night). */
  need: (index: number, previous: PreviousNight | null) => NeedMs;
  /** State of night `index` (default SCORED). */
  state?: (index: number) => ScoreState;
  calibratingFirst?: number;
  now?: string;
  efficiency?: number;
}

const BASELINE_MS = 27_000_000;
const STRAIN_SET = [6, 9, 12, 15, 18];

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Consecutive nights at 23:00 local, each starting a cycle that ends at the next onset. */
function needUser(options: NeedUserOptions): WhoopUserFixture {
  const base = liveShapedUser();
  const cycles: Cycle[] = [];
  const sleeps: Sleep[] = [];
  const recoveries: Recovery[] = [];
  const onset = (index: number): number =>
    Date.parse(`${addDays(LAST_DAY, index - options.count)}T23:00:00${OFFSET}`);
  let previous: PreviousNight | null = null;
  for (let index = 0; index < options.count; index++) {
    const startMs = onset(index);
    const asleepMs = options.asleepMin(index) * MINUTE_MS;
    const awakeMs = 30 * MINUTE_MS;
    const endMs = startMs + asleepMs + awakeMs;
    const light = Math.round((asleepMs * 0.55) / MINUTE_MS) * MINUTE_MS;
    const sws = Math.round((asleepMs * 0.2) / MINUTE_MS) * MINUTE_MS;
    const need = options.need(index, previous);
    const state = options.state?.(index) ?? "SCORED";
    const cycleId = 70_000 + index;
    const sleepId = `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    const open = index === options.count - 1;
    cycles.push({
      user_id: 1,
      created_at: iso(startMs + 8 * HOUR_MS),
      updated_at: iso(startMs + 8 * HOUR_MS),
      score_state: "SCORED",
      start: iso(startMs),
      end: open ? null : iso(onset(index + 1)),
      timezone_offset: OFFSET,
      id: cycleId,
      score: {
        strain: options.strain(index),
        kilojoule: 9000,
        average_heart_rate: 65,
        max_heart_rate: 160,
      },
    });
    sleeps.push({
      user_id: 1,
      created_at: iso(endMs + 5 * MINUTE_MS),
      updated_at: iso(endMs + 5 * MINUTE_MS),
      score_state: state,
      start: iso(startMs),
      end: iso(endMs),
      timezone_offset: OFFSET,
      id: sleepId,
      cycle_id: cycleId,
      nap: false,
      v1_id: null,
      score:
        state === "SCORED"
          ? {
              stage_summary: {
                total_in_bed_time_milli: endMs - startMs,
                total_awake_time_milli: awakeMs,
                total_no_data_time_milli: 0,
                total_light_sleep_time_milli: light,
                total_slow_wave_sleep_time_milli: sws,
                total_rem_sleep_time_milli: asleepMs - light - sws,
                sleep_cycle_count: 4,
                disturbance_count: 8,
              },
              sleep_needed: {
                baseline_milli: need.baseline,
                need_from_sleep_debt_milli: need.debt,
                need_from_recent_strain_milli: need.strain,
                need_from_recent_nap_milli: need.nap,
              },
              respiratory_rate: 15,
              sleep_performance_percentage: 85,
              sleep_efficiency_percentage: options.efficiency ?? 90,
              sleep_consistency_percentage: 70,
            }
          : null,
    });
    recoveries.push({
      cycle_id: cycleId,
      sleep_id: sleepId,
      user_id: 1,
      created_at: iso(endMs + 5 * MINUTE_MS),
      updated_at: iso(endMs + 5 * MINUTE_MS),
      score_state: state === "SCORED" ? "SCORED" : "PENDING_SCORE",
      score:
        state === "SCORED"
          ? {
              user_calibrating: index < (options.calibratingFirst ?? 0),
              recovery_score: 60,
              resting_heart_rate: 55,
              hrv_rmssd_milli: 60,
              spo2_percentage: 96,
              skin_temp_celsius: 33.5,
            }
          : null,
    });
    let napAsleepMs = 0;
    (options.naps?.(index) ?? []).forEach((minutes, k) => {
      const napStart =
        Date.parse(`${addDays(LAST_DAY, index - options.count + 1)}T14:00:00${OFFSET}`) +
        k * 2 * HOUR_MS;
      const napAsleep = minutes * MINUTE_MS;
      const napEnd = napStart + napAsleep + 5 * MINUTE_MS;
      napAsleepMs += napAsleep;
      sleeps.push({
        user_id: 1,
        created_at: iso(napEnd + MINUTE_MS),
        updated_at: iso(napEnd + MINUTE_MS),
        score_state: "SCORED",
        start: iso(napStart),
        end: iso(napEnd),
        timezone_offset: OFFSET,
        id: `20000000-0000-4000-8000-${String(index * 10 + k).padStart(12, "0")}`,
        cycle_id: cycleId,
        nap: true,
        v1_id: null,
        score: {
          stage_summary: {
            total_in_bed_time_milli: napEnd - napStart,
            total_awake_time_milli: 5 * MINUTE_MS,
            total_no_data_time_milli: 0,
            total_light_sleep_time_milli: napAsleep,
            total_slow_wave_sleep_time_milli: 0,
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
          sleep_efficiency_percentage: 90,
          sleep_consistency_percentage: null,
        },
      });
    });
    previous = { index, asleepMs, need, strain: options.strain(index), napAsleepMs };
  }
  const now = new Date(options.now ?? `${LAST_DAY}T23:30:00${OFFSET}`);
  return { ...base, now, offset: OFFSET, cycles, sleeps, recoveries, workouts: [] };
}

/** WHOOP-like rule: debt = 0.5 × shortfall A, strain need = strain × 2 min, nap = −0.5 × nap asleep. */
function exactNeed(_index: number, previous: PreviousNight | null): NeedMs {
  if (!previous) return { baseline: BASELINE_MS, debt: 0, strain: 0, nap: 0 };
  const strain = previous.strain * 120_000;
  const nap = -0.5 * previous.napAsleepMs;
  const shortfall = Math.max(
    0,
    previous.need.baseline + previous.need.strain + previous.need.nap - previous.asleepMs
  );
  return { baseline: BASELINE_MS, debt: 0.5 * shortfall, strain, nap };
}

const exactOptions: NeedUserOptions = {
  count: 41,
  asleepMin: (index) => 400 + ((index * 37) % 120),
  strain: (index) => STRAIN_SET[index % STRAIN_SET.length]!,
  need: exactNeed,
  calibratingFirst: 4,
};

function clientFor(
  user: WhoopUserFixture,
  extra: Partial<WhoopFixtureClientOptions> = {}
): WhoopFixtureClient {
  return createWhoopFixtureClient({
    cycles: user.cycles,
    sleeps: user.sleeps,
    recoveries: user.recoveries,
    workouts: user.workouts,
    now: user.now,
    ...extra,
  });
}

function contextFor(client: WhoopClient, now: Date): ToolContext {
  return { client, privacyMode: "standard", now: () => now, startedAtMs: Date.now() };
}

async function need(
  user: WhoopUserFixture,
  args: SleepNeedInput = {},
  client: WhoopClient = clientFor(user)
): Promise<SleepNeedReport> {
  const report = await runSleepNeed(args, contextFor(client, user.now));
  sleepNeedOutputSchema.parse(report);
  // The fixed label (spec wording) states what the estimate is not; generated text is checked.
  assertNeutralText([
    report.notes,
    report.warnings,
    report.in_bed_arithmetic?.label ?? "",
    report.data_quality.limitations,
  ]);
  expect(JSON.stringify(report)).not.toMatch(/go to bed/i);
  return report;
}

function hours(ms: number): number {
  return ms / HOUR_MS;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

// ---------------------------------------------------------------------------
// Live-shaped account
// ---------------------------------------------------------------------------

describe("live-shaped account", () => {
  it("has one pair: insufficient history with last night's WHOOP need and today's strain in progress", async () => {
    const user = liveShapedUser();
    const report = await need(user);
    expect(report.status).toBe("insufficient_history");
    expect(report.label).toBe(SLEEP_NEED_LABEL);
    expect(report.history).toMatchObject({
      pairs: 1,
      calibrating_pairs: 1,
      first_day: "2026-07-19",
    });
    expect(report.estimate).toEqual({
      hours: null,
      range_hours: null,
      selected_model: null,
      backtest: {
        pairs: 0,
        component_mae_min: null,
        persistence_mae_min: null,
        p80_abs_error_min: null,
      },
    });
    const sleep = user.sleeps.find((record) => record.id === LIVE_SHAPED_IDS.sleeps.second)!;
    const stages = sleep.score!.stage_summary;
    expect(report.last_night).toEqual({
      date: "2026-09-16",
      whoop_need: {
        baseline: round(hours(27_904_512), 2),
        debt: round(hours(2_108_337), 2),
        strain: round(hours(3_402_118), 2),
        nap: 0,
        total_including_debt: round(hours(27_904_512 + 2_108_337 + 3_402_118), 2),
        total_excluding_debt: round(hours(27_904_512 + 3_402_118), 2),
      },
      asleep_hours: round(
        hours(
          stages.total_light_sleep_time_milli +
            stages.total_slow_wave_sleep_time_milli +
            stages.total_rem_sleep_time_milli
        ),
        2
      ),
      performance_pct: 83,
      calibrating: true,
    });
    expect(report.today_so_far).toEqual({
      cycle_started_local: "2026-09-15T23:13:31.460+02:00",
      strain_so_far: 13.05,
      strain_in_progress: true,
      naps: { count: 0, asleep_hours: 0, unscored: 0 },
    });
    expect(report.components.baseline).toEqual({
      hours: 7.75,
      method: "latest_whoop_baseline",
      source_date: "2026-09-16",
    });
    expect(report.components.debt).toMatchObject({
      hours: null,
      variant: null,
      pairs: 1,
      required: DEBT_MODEL_MIN_PAIRS,
    });
    expect(report.components.strain).toMatchObject({
      hours: null,
      k: null,
      required: STRAIN_MODEL_MIN_PAIRS,
      in_observed_range: null,
      basis: "strain_so_far",
    });
    expect(report.components.nap).toMatchObject({
      hours: 0,
      method: "none_today",
      pairs: 0,
      required: NAP_MODEL_MIN_PAIRS,
      nap_free_nonzero_count: 0,
    });
    expect(report.notes[0]).toContain(
      "Not enough history for an estimate: 1 usable pair of consecutive scored nights"
    );
    expect(report.evaluated_at_local).toBe("2026-09-16T23:30:00.000+02:00");
    expect(report.in_bed_arithmetic).toBeNull();
    expect(report.data_quality.method_version).toBe("sleep-need-1");
  });

  it("reports no_current_cycle when the newest cycle is closed", async () => {
    const live = liveShapedUser();
    const user: WhoopUserFixture = {
      ...live,
      cycles: live.cycles.filter((cycle) => cycle.id !== LIVE_SHAPED_IDS.cycles.open),
    };
    const report = await need(user, { wake_time: "06:30" });
    expect(report.status).toBe("no_current_cycle");
    expect(report.last_night).toBeNull();
    expect(report.today_so_far).toBeNull();
    expect(report.estimate.hours).toBeNull();
    expect(report.notes[0]).toContain(
      "the latest cycle ended 2026-09-15 23:13 (UTC+02:00), when WHOOP detected a new sleep, and the next cycle has not synced yet"
    );
    expect(report.in_bed_arithmetic).toMatchObject({
      in_bed_hours_for_estimate: null,
      latest_in_bed_start_local_for_estimate: null,
      hours_until_wake_time: 7,
    });
  });

  it("reports last_night_unavailable while last night is pending", async () => {
    const user = matureUser({ days: 30 });
    const report = await need(user);
    expect(report.status).toBe("last_night_unavailable");
    expect(report.last_night).toBeNull();
    expect(report.today_so_far).not.toBeNull();
    expect(report.today_so_far!.strain_in_progress).toBe(true);
    expect(report.estimate.hours).toBeNull();
    expect(report.notes[0]).toContain("still being scored by WHOOP");
  });
});

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

describe("component models", () => {
  it("recovers a known carry fraction and strain rule and selects the component model", async () => {
    const user = needUser(exactOptions);
    const report = await need(user, { wake_time: "06:30" });
    expect(report.history.pairs).toBe(40);
    expect(report.history.calibrating_pairs).toBe(4);
    expect(report.components.debt).toMatchObject({
      variant: "A",
      carry_fraction: 0.5,
      exact_match_rate: 1,
      loo_mae_min: 0,
      pairs: 40,
    });
    const index = indexSleepNeedRecords(
      user.cycles,
      user.sleeps,
      user.recoveries,
      user.now.getTime()
    );
    const { pairs } = buildSleepNeedPairs(index, addDays(LAST_DAY, -59));
    expect(pairs).toHaveLength(40);
    expect(Math.abs(fitDebtModel(pairs, "A").k! - 0.5)).toBeLessThan(1e-9);
    expect(fitDebtModel(pairs, "B").maeMin!).toBeGreaterThan(fitDebtModel(pairs, "A").maeMin!);

    expect(report.components.strain).toMatchObject({
      k: 5,
      loo_mae_min: 0,
      observed_max_strain: 18,
      in_observed_range: true,
    });
    expect(report.components.nap).toMatchObject({ hours: 0, method: "none_today" });

    // Tonight: last night (index 40) is P, the open cycle's strain so far is 6.
    const last = user.sleeps.filter((sleep) => !sleep.nap).at(-1)!;
    const lastNeed = last.score!.sleep_needed;
    const lastAsleep = 400 + ((40 * 37) % 120);
    const shortfall = Math.max(
      0,
      lastNeed.baseline_milli +
        lastNeed.need_from_recent_strain_milli +
        lastNeed.need_from_recent_nap_milli -
        lastAsleep * MINUTE_MS
    );
    const expected = hours(BASELINE_MS + 0.5 * shortfall + 6 * 120_000);
    expect(report.status).toBe("estimated");
    expect(report.estimate.selected_model).toBe("component");
    expect(report.estimate.hours).toBe(round(expected, 2));
    expect(report.components.debt.hours).toBe(round(hours(0.5 * shortfall), 2));
    expect(report.components.strain.hours).toBe(round(hours(6 * 120_000), 2));
    expect(report.estimate.backtest.pairs).toBe(40);
    expect(report.estimate.backtest.component_mae_min).toBe(0);
    expect(report.estimate.backtest.persistence_mae_min!).toBeGreaterThan(0);
    expect(report.estimate.range_hours).toEqual({
      low: round(expected, 2),
      high: round(expected, 2),
    });

    expect(report.in_bed_arithmetic).toMatchObject({
      wake_time_local: "06:30",
      utc_offset: OFFSET,
      typical_efficiency_pct: 90,
      efficiency_nights: 14,
      in_bed_hours_for_estimate: round(expected / 0.9, 2),
      hours_until_wake_time: 7,
      label: IN_BED_ARITHMETIC_LABEL,
    });
  });

  it("uses persistence when the need drifts and the components cannot follow it", async () => {
    const user = needUser({
      ...exactOptions,
      strain: () => 10,
      need: (index) => ({
        baseline: BASELINE_MS,
        debt: Math.round(3_600_000 + 2_400_000 * Math.sin(index / 6)),
        strain: 1_200_000,
        nap: 0,
      }),
    });
    const report = await need(user);
    expect(report.status).toBe("estimated");
    expect(report.estimate.selected_model).toBe("persistence");
    expect(report.estimate.backtest.component_mae_min!).toBeGreaterThan(
      report.estimate.backtest.persistence_mae_min!
    );
    expect(report.estimate.hours).toBe(report.last_night!.whoop_need.total_including_debt);
    expect(report.estimate.range_hours!.high).toBeGreaterThan(report.estimate.hours!);
    expect(report.notes[0]).toContain("selected_model persistence");
  });

  it("leaves the estimate null when strain so far is above the observed range", async () => {
    const user = needUser({
      ...exactOptions,
      strain: (index) => (index === exactOptions.count - 1 ? 19 : STRAIN_SET[index % 5]!),
    });
    const report = await need(user);
    expect(report.components.strain).toMatchObject({
      hours: null,
      in_observed_range: false,
      observed_max_strain: 18,
    });
    expect(report.status).toBe("insufficient_history");
    expect(report.estimate.hours).toBeNull();
    expect(report.estimate.selected_model).toBeNull();
    expect(report.notes[0]).toContain("above the highest cycle strain in the pairs");
  });

  it("needs 3 nap pairs for a nap today", async () => {
    const napDays = new Set([10, 25]);
    const user = needUser({
      ...exactOptions,
      naps: (index) => (napDays.has(index) || index === exactOptions.count - 1 ? [40] : []),
    });
    const report = await need(user);
    expect(report.today_so_far!.naps).toEqual({ count: 1, asleep_hours: 0.67, unscored: 0 });
    expect(report.components.nap).toMatchObject({
      hours: null,
      method: "ratio_of_nap_asleep",
      ratio: null,
      pairs: 2,
    });
    expect(report.status).toBe("insufficient_history");
    expect(report.notes[0]).toContain("nap ratio needs 3 pairs with naps (2 of 3)");
  });

  it("applies a negative nap ratio with its sign", async () => {
    const user = needUser({
      ...exactOptions,
      naps: (index) => (index % 7 === 3 || index === exactOptions.count - 1 ? [30] : []),
    });
    const report = await need(user);
    expect(report.components.nap.pairs).toBeGreaterThanOrEqual(NAP_MODEL_MIN_PAIRS);
    expect(report.components.nap).toMatchObject({
      method: "ratio_of_nap_asleep",
      ratio: -0.5,
      hours: -0.25,
      nap_free_nonzero_count: 0,
    });
    expect(report.status).toBe("estimated");
    expect(report.estimate.selected_model).toBe("component");
    const { baseline, debt, strain, nap } = report.components;
    expect(report.estimate.hours!).toBeCloseTo(
      baseline.hours! + debt.hours! + strain.hours! + nap.hours!,
      1
    );
    expect(nap.hours!).toBeLessThan(0);
    expect(report.estimate.hours!).toBeLessThan(baseline.hours! + debt.hours! + strain.hours!);
  });

  it("leaves the nap component null when a nap-free pair had a nonzero nap need", async () => {
    const user = needUser({
      ...exactOptions,
      need: (index, previous) => {
        const base = exactNeed(index, previous);
        return index === 20 ? { ...base, nap: -300_000 } : base;
      },
    });
    const report = await need(user);
    expect(report.components.nap).toMatchObject({
      hours: null,
      method: "none_today",
      nap_free_nonzero_count: 1,
    });
    expect(report.status).toBe("insufficient_history");
    expect(report.notes[0]).toContain("1 nap-free pair had a nonzero WHOOP nap component");
  });

  it("excludes pairs around unscored sleeps, unscored strain, unscored naps and short cycles", async () => {
    const user = needUser({
      ...exactOptions,
      state: (index) => (index === 12 ? "PENDING_SCORE" : "SCORED"),
      naps: (index) => (index === 25 ? [20] : []),
    });
    const edited: WhoopUserFixture = {
      ...user,
      // Cycle 30's strain is not scored; the nap in cycle 25 is still pending.
      cycles: user.cycles.map((cycle) =>
        cycle.id === 70_030 ? { ...cycle, score_state: "PENDING_SCORE", score: null } : cycle
      ),
      sleeps: user.sleeps.map((sleep) =>
        sleep.nap && sleep.cycle_id === 70_025
          ? { ...sleep, score_state: "PENDING_SCORE", score: null }
          : sleep
      ),
    };
    const report = await need(edited);
    // Night 12 pending: pairs (11, 12) and (12, 13); cycle 30: pair (30, 31); cycle 25: pair (25, 26).
    expect(report.history.excluded).toEqual({
      unscored_sleep: 2,
      short_or_long_cycle: 0,
      strain_unscored: 1,
      unscored_naps: 1,
    });
    expect(report.history.pairs).toBe(36);
    expect(report.notes.some((note) => note.includes("history.excluded"))).toBe(true);

    // A split night (two main sleeps, a short cycle between them) in a mature account.
    const mature = await need(matureUser({ days: 60, pendingLast: false }));
    expect(mature.history.excluded.short_or_long_cycle).toBeGreaterThan(0);
    expect(mature.status).not.toBe("last_night_unavailable");
  });
});

// ---------------------------------------------------------------------------
// In-bed arithmetic
// ---------------------------------------------------------------------------

describe("in-bed arithmetic", () => {
  it("counts back from the wake time and gives the hours until it", () => {
    const result = inBedArithmetic({
      estimateHours: 7.2,
      efficiencyPct: 90,
      efficiencyNights: 14,
      wakeTime: "06:30",
      nowMs: Date.parse("2026-09-16T23:30:00+02:00"),
      offset: "+02:00",
    });
    expect(result).toEqual({
      wake_time_local: "06:30",
      utc_offset: "+02:00",
      typical_efficiency_pct: 90,
      efficiency_nights: 14,
      in_bed_hours_for_estimate: 8,
      latest_in_bed_start_local_for_estimate: "22:30",
      hours_until_wake_time: 7,
      label: IN_BED_ARITHMETIC_LABEL,
    });
    const earlyMorning = inBedArithmetic({
      estimateHours: 9,
      efficiencyPct: 90,
      efficiencyNights: 5,
      wakeTime: "07:15",
      nowMs: Date.parse("2026-09-17T01:00:00-05:00"),
      offset: "-05:00",
    });
    expect(earlyMorning.in_bed_hours_for_estimate).toBe(10);
    expect(earlyMorning.latest_in_bed_start_local_for_estimate).toBe("21:15");
    expect(earlyMorning.hours_until_wake_time).toBe(6.25);
  });

  it("has no boolean judgement field in its contract", () => {
    const arithmetic = sleepNeedOutputSchema.shape.in_bed_arithmetic.unwrap();
    for (const field of Object.values(arithmetic.shape)) {
      expect(field).not.toBeInstanceOf(z.ZodBoolean);
    }
    expect(JSON.stringify(z.toJSONSchema(sleepNeedOutputSchema))).not.toMatch(/not_enough_time/);
  });
});

// ---------------------------------------------------------------------------
// Failures, size and contract
// ---------------------------------------------------------------------------

describe("failures, size and contract", () => {
  it("throws when cycles fail and warns when recoveries fail", async () => {
    const user = needUser(exactOptions);
    const failing = clientFor(user, {
      failures: [
        { path: /^\/v2\/cycle\?start/, error: new WhoopApiError(401, "Unauthorized", {}) },
      ],
    });
    await expect(runSleepNeed({}, contextFor(failing, user.now))).rejects.toBeInstanceOf(
      WhoopApiError
    );

    const noRecoveries = clientFor(user, {
      failures: [{ path: /^\/v2\/recovery/, error: new WhoopApiError(503, "Unavailable", {}) }],
    });
    const report = await need(user, {}, noRecoveries);
    expect(report.status).toBe("estimated");
    expect(report.last_night!.calibrating).toBeNull();
    expect(report.history.calibrating_pairs).toBe(0);
    expect(report.warnings[0]).toContain("Recovery data could not be read");
  });

  it(
    "stays within the request budget and text limit on stressUser",
    async () => {
      const user = stressUser({ pendingLast: false });
      const client = clientFor(user);
      const report = await need(user, { history_days: 120, wake_time: "07:00" }, client);
      expect(client.calls.length).toBeLessThanOrEqual(DEFAULT_PAGE_BUDGET + 1);
      expect(JSON.stringify(report).length).toBeLessThanOrEqual(MAX_TOOL_TEXT_CHARS);
      expect(report.history.pairs).toBeGreaterThan(STRAIN_MODEL_MIN_PAIRS);
      expect(["estimated", "insufficient_history"]).toContain(report.status);
    },
    HEAVY_TEST_TIMEOUT_MS
  );

  it(
    "serves a repeated call from the history cache",
    async () => {
      const user = stressUser();
      const client = clientFor(user);
      const cache = new MemoryCache({ maxEntries: 500 });
      const ctx: ToolContext = { ...contextFor(client, user.now), historyCache: cache };
      const first = await runSleepNeed({ history_days: 120 }, ctx);
      const before = client.calls.length;
      const second = await runSleepNeed({ history_days: 120 }, ctx);
      expect(client.calls.slice(before).filter((path) => path.includes("start="))).toEqual([]);
      expect(
        Object.values(second.data_quality.sources).every((source) => source.cache_status === "hit")
      ).toBe(true);
      expect({ ...second, data_quality: null }).toEqual({ ...first, data_quality: null });
    },
    HEAVY_TEST_TIMEOUT_MS
  );

  it(
    "is registered in standard mode only, with a valid contract",
    async () => {
      expect(getSleepNeedTool.aggregate).toBeUndefined();
      expect(getSleepNeedTool.standard.title).toBe("Sleep need estimate");
      expect(getSleepNeedTool.annotations).toEqual({ readOnlyHint: true });
      expect(getSleepNeedTool.standard.description.length).toBeLessThanOrEqual(1000);
      expect(await listToolNames("standard")).toContain("get_sleep_need");
      expect(await listToolNames("aggregate")).not.toContain("get_sleep_need");

      for (const user of [liveShapedUser(), needUser(exactOptions)]) {
        const connection = await connectServer(clientFor(user), { now: () => user.now });
        try {
          const result = await connection.callTool("get_sleep_need", { wake_time: "06:30" });
          expect(result.isError).toBe(false);
          expect(result.text).toBe(JSON.stringify(result.structured));
          assertNeutralText((result.structured as SleepNeedReport).notes);
          const bad = await connection.callTool("get_sleep_need", { wake_time: "6:30" });
          expect(bad.isError).toBe(true);
          const short = await connection.callTool("get_sleep_need", { history_days: 7 });
          expect(short.isError).toBe(true);
        } finally {
          await connection.close();
        }
      }
    },
    HEAVY_TEST_TIMEOUT_MS
  );
});
