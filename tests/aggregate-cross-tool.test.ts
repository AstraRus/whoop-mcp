/**
 * Cross-tool differencing check for aggregate privacy mode.
 *
 * Every aggregate tool is safe on its own; this test checks them together. On
 * a 120-day account whose per-record values are all distinct, it collects the
 * released numeric aggregates of all 8 aggregate tools over their argument
 * grids and expresses each one as a linear combination of per-record values
 * (per-day recoveries, nights and cycles; per-session workout values):
 * - a mean is mean·n = the sum over its samples, a total is that sum, a
 *   trend slope is Σ (x − x̄)(y − ȳ) / Σ (x − x̄)², linear in the values;
 * - the record set behind every value is reconstructed from the fixture with
 *   the shared day model, and CONFIRMED against the tool's own output: the
 *   sample size must match and the recomputed value must round to the
 *   released value, so the rows describe what the tools actually released.
 *
 * Then, per value family (one unknown per record), by Gaussian elimination
 * with tolerance:
 * - no unit vector (one record) and no sum of two records lies in the row
 *   space of all released rows, across tools;
 * - no combination pins one record within the metric's rounding step: for
 *   the orthogonal projection of each record's unit vector onto the row space
 *   (the least-squares estimate from released values), the contribution of the
 *   other records, at half the family's value range, exceeds the step.
 *
 * Not linear, and therefore not part of the rank check (see the README's
 * privacy notes): standard deviations, baseline medians and quartiles, change
 * percentages and directions, zone shares, weighted heart rate, circular
 * bedtime statistics, counts, and the weekly acute:chronic values, which are
 * computed from already rounded released values.
 *
 * Also: the aggregate get_sync_status output is identical from Wednesday 00:00
 * to the next Tuesday 23:59 local, apart from its evaluation date.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Cycle, Recovery, Sleep, Workout } from "../src/api/types.js";
import { MemoryCache } from "../src/cache/memory-cache.js";
import {
  AGGREGATE_WEEK_MIN_SAMPLES,
  AGGREGATE_WORKOUT_KJ_STEP,
  AGGREGATE_WORKOUT_STRAIN_STEP,
  lastReleasedWeeks,
} from "../src/tools/aggregate-window.js";
import { sourceQuality } from "../src/tools/analytics-utils.js";
import { resolveUserUtcOffsetInfo } from "../src/tools/collection-utils.js";
import { addDays, daysBetween, mondayOf } from "../src/tools/day-model.js";
import { BASELINE_AGGREGATE_WEEKS } from "../src/tools/get-baselines.js";
import { SLEEP_DEBT_AGGREGATE_WEEKS } from "../src/tools/get-sleep-debt.js";
import { buildSessions, type TrainingSession } from "../src/tools/get-training-load.js";
import { AGGREGATE_STEPS } from "../src/tools/training-aggregate.js";
import {
  AGGREGATE_METRIC_STEP,
  TREND_AGGREGATE_WEEKS,
  TREND_METRICS,
  extractMetricSamples,
  gateSamples,
  loadAggregateData,
  type AggregateData,
  type MetricSample,
  type SampleMetric,
  type TrendMetric,
} from "../src/tools/get-trend.js";
import { KJ_PER_KCAL } from "../src/tools/workout-utils.js";
import { connectServer, type ContractConnection } from "./helpers/contract.js";
import { createWhoopFixtureClient } from "./helpers/whoop-fixture-client.js";
import { matureUser, type WhoopUserFixture } from "./helpers/whoop-users.js";

const TIMEOUT_MS = 600_000;
const EPSILON = 1e-6;

/** Weeks of released history the grids cover (the fixture spans about 17). */
const HORIZON_WEEKS = 26;

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Fixture: a 120-day account with distinct per-record values
// ---------------------------------------------------------------------------

/**
 * Nudge every value an aggregate can release by a record-specific amount far
 * below every rounding step, so no two records share a value. Stage time moves
 * between light sleep and awake time, so time in bed and the stage sum stay
 * equal (no new data-quality flags).
 */
function withDistinctValues(data: WhoopUserFixture): WhoopUserFixture {
  const clone = structuredClone(data);
  // Irrational step multiples: decimal values never collide after a nudge.
  const nudge = (value: number, amount: number, max: number): number =>
    value + amount * Math.SQRT2 <= max ? value + amount * Math.SQRT2 : value - amount * Math.PI;
  clone.recoveries
    .slice()
    .sort((left, right) => left.cycle_id - right.cycle_id)
    .forEach((recovery: Recovery, index) => {
      const score = recovery.score;
      if (!score) return;
      score.recovery_score = nudge(score.recovery_score, (index + 1) * 0.0013, 100);
      score.hrv_rmssd_milli = nudge(score.hrv_rmssd_milli, (index + 1) * 0.00017, 500);
      score.resting_heart_rate = nudge(score.resting_heart_rate, (index + 1) * 0.0011, 250);
      if (typeof score.spo2_percentage === "number")
        score.spo2_percentage = nudge(score.spo2_percentage, (index + 1) * 0.0007, 100);
      if (typeof score.skin_temp_celsius === "number")
        score.skin_temp_celsius = nudge(score.skin_temp_celsius, (index + 1) * 0.00019, 45);
    });
  clone.sleeps
    .slice()
    .sort((left, right) => (left.id < right.id ? -1 : 1))
    .forEach((sleep: Sleep, index) => {
      const score = sleep.score;
      if (!score) return;
      const shift = (index + 1) * 7;
      const stages = score.stage_summary;
      if (stages.total_awake_time_milli >= shift) {
        stages.total_light_sleep_time_milli += shift;
        stages.total_awake_time_milli -= shift;
      } else if (stages.total_light_sleep_time_milli >= shift) {
        stages.total_light_sleep_time_milli -= shift;
        stages.total_awake_time_milli += shift;
      }
      score.sleep_needed.need_from_sleep_debt_milli += (index + 1) * 11;
      score.sleep_needed.baseline_milli += (index + 1) * 13;
      if (typeof score.sleep_performance_percentage === "number")
        score.sleep_performance_percentage = nudge(
          score.sleep_performance_percentage,
          (index + 1) * 0.0009,
          100
        );
      if (typeof score.sleep_efficiency_percentage === "number")
        score.sleep_efficiency_percentage = nudge(
          score.sleep_efficiency_percentage,
          (index + 1) * 0.0008,
          100
        );
      if (typeof score.respiratory_rate === "number")
        score.respiratory_rate = nudge(score.respiratory_rate, (index + 1) * 0.00007, 60);
      if (
        typeof score.sleep_consistency_percentage === "number" &&
        score.sleep_consistency_percentage > 0
      )
        score.sleep_consistency_percentage = nudge(
          score.sleep_consistency_percentage,
          (index + 1) * 0.0006,
          100
        );
    });
  clone.cycles
    .slice()
    .sort((left, right) => left.id - right.id)
    .forEach((cycle: Cycle, index) => {
      if (cycle.score) cycle.score.strain = nudge(cycle.score.strain, (index + 1) * 0.00011, 21);
    });
  clone.workouts
    .slice()
    .sort((left, right) => (left.id < right.id ? -1 : 1))
    .forEach((workout: Workout, index) => {
      const score = workout.score;
      if (!score) return;
      score.strain = nudge(score.strain, (index + 1) * 0.000013, 21);
      score.kilojoule += (index + 1) * 0.0017;
      if (typeof score.distance_meter === "number" && score.distance_meter > 0)
        score.distance_meter += (index + 1) * 0.013;
    });
  return clone;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** One released value as a linear combination of record values. */
interface Row {
  source: string;
  /** record key → coefficient */
  coefficients: Map<string, number>;
}

/** One unknown per record: a value family and its records. */
interface Family {
  name: string;
  /** Rounding step of the family's released values, in record units */
  step: number;
  values: Map<string, number>;
  rows: Row[];
}

class Ledger {
  readonly families = new Map<string, Family>();
  verified = 0;

  family(name: string, step: number): Family {
    let family = this.families.get(name);
    if (!family) {
      family = { name, step, values: new Map(), rows: [] };
      this.families.set(name, family);
    }
    family.step = Math.min(family.step, step);
    return family;
  }

  /** A row whose released value is a sum (coefficient 1) or scaled sum over `records`. */
  sum(
    familyName: string,
    step: number,
    source: string,
    records: ReadonlyArray<{ key: string; value: number }>,
    scale = 1
  ): void {
    const family = this.family(familyName, step);
    const coefficients = new Map<string, number>();
    for (const record of records) {
      family.values.set(record.key, record.value);
      coefficients.set(record.key, scale);
    }
    family.rows.push({ source, coefficients });
  }

  /** A least-squares slope row over chronological samples with day positions. */
  slope(
    familyName: string,
    step: number,
    source: string,
    records: ReadonlyArray<{ key: string; value: number; x: number }>
  ): void {
    const family = this.family(familyName, step);
    const meanX = records.reduce((sum, record) => sum + record.x, 0) / records.length;
    const sxx = records.reduce((sum, record) => sum + (record.x - meanX) ** 2, 0);
    const coefficients = new Map<string, number>();
    for (const record of records) {
      family.values.set(record.key, record.value);
      coefficients.set(record.key, (record.x - meanX) / sxx);
    }
    family.rows.push({ source, coefficients });
  }
}

/** Expect `released` to be `exact` rounded to `step` (roundStep half-width, float tolerance). */
function expectRounded(
  ledger: Ledger,
  label: string,
  released: number | null | undefined,
  exact: number,
  step: number
): void {
  expect(released, `${label} released`).not.toBeNull();
  expect(released, `${label} released`).not.toBeUndefined();
  expect(
    Math.abs((released as number) - exact),
    `${label}: released ${released}, recomputed ${exact}, step ${step}`
  ).toBeLessThanOrEqual(step / 2 + EPSILON * Math.max(1, Math.abs(exact)));
  ledger.verified += 1;
}

const sumOf = (records: ReadonlyArray<{ value: number }>): number =>
  records.reduce((total, record) => total + record.value, 0);

// ---------------------------------------------------------------------------
// Reconstructed record sets (shared day model), confirmed against every tool
// ---------------------------------------------------------------------------

interface Reconstruction {
  mondays: string[];
  final: Set<string>;
  /** metric → Monday → released samples (weeks with at least 3), chronological */
  samples: Map<SampleMetric, Map<string, MetricSample[]>>;
  /** Scored sessions placed in final weeks, by Monday */
  sessionsByWeek: Map<string, TrainingSession[]>;
  offset: string;
}

const DAY_METRICS: readonly SampleMetric[] = [...TREND_METRICS, "sleep_deficit"];

async function reconstruct(fixture: WhoopUserFixture): Promise<Reconstruction> {
  const client = createWhoopFixtureClient(fixture);
  const { offset } = await resolveUserUtcOffsetInfo(client);
  const weeks = lastReleasedWeeks(fixture.now, offset, HORIZON_WEEKS);
  const data: AggregateData = await loadAggregateData(client, weeks, offset, fixture.now, {
    workouts: true,
  });
  expect(data.placementComplete).toBe(true);
  expect(data.workoutsComplete).toBe(true);
  const final = new Set(data.finalMondays);
  const samples = new Map<SampleMetric, Map<string, MetricSample[]>>();
  for (const metric of DAY_METRICS) {
    const gated = gateSamples(extractMetricSamples(data, metric).samples, data.finalMondays);
    const byWeek = new Map<string, MetricSample[]>();
    for (const sample of gated.released) {
      const list = byWeek.get(sample.monday) ?? [];
      list.push(sample);
      byWeek.set(sample.monday, list);
    }
    samples.set(metric, byWeek);
  }
  const sessions = buildSessions(
    data.workout!.records,
    data.placement,
    data.cycle.records,
    sourceQuality()
  ).filter((session) => session.scored && final.has(mondayOf(session.summary.day)));
  const sessionsByWeek = new Map<string, TrainingSession[]>();
  for (const session of sessions) {
    const monday = mondayOf(session.summary.day);
    const list = sessionsByWeek.get(monday) ?? [];
    list.push(session);
    sessionsByWeek.set(monday, list);
  }
  return {
    mondays: weeks.map((week) => week.monday),
    final,
    samples,
    sessionsByWeek,
    offset,
  };
}

/** Released samples of `metric` in the given weeks, chronological as the tools order them. */
function samplesIn(
  model: Reconstruction,
  metric: SampleMetric,
  mondays: readonly string[]
): MetricSample[] {
  const byWeek = model.samples.get(metric)!;
  return mondays
    .flatMap((monday) => byWeek.get(monday) ?? [])
    .sort((left, right) => left.anchor - right.anchor || (left.day < right.day ? -1 : 1));
}

function sessionsIn(model: Reconstruction, mondays: readonly string[]): TrainingSession[] {
  return mondays.flatMap((monday) => model.sessionsByWeek.get(monday) ?? []);
}

/** Mondays from `first` to the week containing `last` */
function mondaysBetween(first: string, last: string): string[] {
  const mondays: string[] = [];
  for (let monday = mondayOf(first); monday <= last; monday = addDays(monday, 7)) {
    mondays.push(monday);
  }
  return mondays;
}

const dayRecords = (list: readonly MetricSample[]): Array<{ key: string; value: number }> =>
  list.map((sample) => ({ key: sample.key, value: sample.value }));

type SessionValue = (session: TrainingSession) => number | null;

const SESSION_VALUES: Record<string, SessionValue> = {
  workout_minutes: (session) => session.summary.duration_minutes,
  workout_kj: (session) => session.summary.kilojoule,
  workout_trimp: (session) => session.summary.trimp,
  workout_strain: (session) => session.summary.strain,
  gps_distance: (session) =>
    session.summary.gps !== null && !session.summary.flags.includes("gps_suspect")
      ? session.summary.gps.distance_km
      : null,
  recorded_minutes: (session) => session.summary.recorded_minutes,
};

function sessionRecords(
  sessions: readonly TrainingSession[],
  value: SessionValue
): Array<{ key: string; value: number }> {
  return sessions.flatMap((session) => {
    const result = value(session);
    return result === null ? [] : [{ key: session.summary.id, value: result }];
  });
}

async function structured(
  connection: ContractConnection,
  tool: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const outcome = await connection.callTool(tool, args);
  expect(outcome.isError, `${tool} ${JSON.stringify(args)}: ${outcome.text}`).toBe(false);
  return outcome.structured!;
}

// ---------------------------------------------------------------------------
// Collection per tool
// ---------------------------------------------------------------------------

const WEEKLY_FIELDS: Array<[string, string, TrendMetric]> = [
  ["recovery", "average_score", "recovery"],
  ["recovery", "average_hrv", "hrv"],
  ["recovery", "average_rhr", "rhr"],
  ["sleep", "average_duration_hours", "sleep_duration"],
  ["sleep", "average_performance_pct", "sleep_performance"],
  ["sleep", "average_efficiency_pct", "sleep_efficiency"],
  ["strain", "average_daily_strain", "strain"],
];

async function collectWeeklySummaries(
  connection: ContractConnection,
  model: Reconstruction,
  ledger: Ledger
): Promise<void> {
  for (const monday of model.mondays) {
    const weekly = await structured(connection, "get_weekly_summary", { week_start: monday });
    const sizes = weekly.sample_sizes as Record<string, number>;
    const label = `get_weekly_summary ${monday}`;
    expect(sizes.recovery_days, label).toBe(samplesIn(model, "recovery", [monday]).length);
    expect(sizes.sleep_nights, label).toBe(samplesIn(model, "sleep_duration", [monday]).length);
    expect(sizes.completed_cycles, label).toBe(samplesIn(model, "strain", [monday]).length);
    for (const [group, field, metric] of WEEKLY_FIELDS) {
      const released = (weekly[group] as Record<string, number | null>)[field];
      const list = samplesIn(model, metric, [monday]);
      if (list.length === 0) {
        expect(released, `${label} ${field}`).toBeNull();
        continue;
      }
      expectRounded(
        ledger,
        `${label} ${field}`,
        released,
        sumOf(list) / list.length,
        AGGREGATE_METRIC_STEP[metric]
      );
      ledger.sum(metric, AGGREGATE_METRIC_STEP[metric], `${label} ${field}`, dayRecords(list));
    }
    const workouts = weekly.workouts as Record<string, number | null>;
    const sessions = sessionsIn(model, [monday]);
    if (!model.final.has(monday)) {
      expect(workouts.total_strain, label).toBeNull();
      expect(workouts.total_calories_kj, label).toBeNull();
      continue;
    }
    if (workouts.count === null) {
      expect(sessions, label).toHaveLength(0);
      continue;
    }
    expect(workouts.count, `${label} workouts`).toBe(sessions.length);
    if (sessions.length < AGGREGATE_WEEK_MIN_SAMPLES) {
      expect(workouts.total_strain, label).toBeNull();
      expect(workouts.total_calories_kj, label).toBeNull();
      continue;
    }
    const strain = sessionRecords(sessions, SESSION_VALUES.workout_strain!);
    expectRounded(
      ledger,
      `${label} total_strain`,
      workouts.total_strain,
      sumOf(strain),
      AGGREGATE_WORKOUT_STRAIN_STEP
    );
    ledger.sum("workout_strain", AGGREGATE_WORKOUT_STRAIN_STEP, `${label} total_strain`, strain);
    const kj = sessionRecords(sessions, SESSION_VALUES.workout_kj!);
    expectRounded(
      ledger,
      `${label} total_calories_kj`,
      workouts.total_calories_kj,
      sumOf(kj),
      AGGREGATE_WORKOUT_KJ_STEP
    );
    ledger.sum("workout_kj", AGGREGATE_WORKOUT_KJ_STEP, `${label} total_calories_kj`, kj);
  }
}

async function collectTrends(
  connection: ContractConnection,
  model: Reconstruction,
  ledger: Ledger
): Promise<void> {
  for (const weeks of TREND_AGGREGATE_WEEKS) {
    const days = Math.min(weeks * 7, 90);
    for (const metric of TREND_METRICS) {
      const trend = await structured(connection, "get_trend", { metric, days });
      const period = trend.period as { start: string; end: string };
      const mondays = mondaysBetween(period.start, period.end);
      expect(mondays, `get_trend ${metric} ${days}`).toHaveLength(weeks);
      const list = samplesIn(model, metric, mondays);
      const label = `get_trend ${metric} ${weeks}w`;
      expect(trend.sample_size, label).toBe(list.length);
      const statistics = trend.statistics as { mean: number | null };
      const slope = (trend.trend as { slope: number | null }).slope;
      if (statistics.mean === null) {
        expect(list.length, label).toBeLessThan(4);
        expect(slope, label).toBeNull();
        continue;
      }
      const step = AGGREGATE_METRIC_STEP[metric];
      expectRounded(ledger, `${label} mean`, statistics.mean, sumOf(list) / list.length, step);
      ledger.sum(metric, step, `${label} mean`, dayRecords(list));
      const positioned = list.map((sample) => ({
        key: sample.key,
        value: sample.value,
        x: daysBetween(list[0]!.day, sample.day),
      }));
      const meanX = positioned.reduce((sum, record) => sum + record.x, 0) / positioned.length;
      const meanY = sumOf(positioned) / positioned.length;
      const sxx = positioned.reduce((sum, record) => sum + (record.x - meanX) ** 2, 0);
      const sxy = positioned.reduce(
        (sum, record) => sum + (record.x - meanX) * (record.value - meanY),
        0
      );
      expectRounded(ledger, `${label} slope`, slope, sxy / sxx, step / 10);
      ledger.slope(metric, step / 10, `${label} slope`, positioned);
    }
  }
}

/** Baseline metric → the trend metric whose samples it uses */
const BASELINE_METRIC: Record<string, TrendMetric> = {
  hrv: "hrv",
  rhr: "rhr",
  recovery_score: "recovery",
  respiratory_rate: "respiratory_rate",
  sleep_hours: "sleep_duration",
  spo2: "spo2",
  skin_temp: "skin_temp",
  sleep_efficiency: "sleep_efficiency",
  disturbances_per_hour: "disturbances_per_hour",
  rem_share: "rem_share",
  deep_share: "deep_share",
};

async function collectBaselines(
  connection: ContractConnection,
  model: Reconstruction,
  ledger: Ledger
): Promise<void> {
  for (const weeks of BASELINE_AGGREGATE_WEEKS) {
    const report = await structured(connection, "get_baselines", {
      baseline_days: Math.min(weeks * 7, 180),
    });
    const period = report.period as { start: string; end: string };
    const mondays = mondaysBetween(period.start, period.end);
    expect(mondays).toHaveLength(weeks);
    const metrics = report.metrics as Record<string, { sample_size: number; mean: number } | null>;
    const status = report.metric_status as Record<string, { sample_size: number }>;
    for (const [name, metric] of Object.entries(BASELINE_METRIC)) {
      const list = samplesIn(model, metric, mondays);
      const label = `get_baselines ${name} ${weeks}w`;
      expect(status[name]!.sample_size, label).toBe(list.length);
      const band = metrics[name];
      if (band === null || band === undefined) continue;
      const step = AGGREGATE_METRIC_STEP[metric];
      expectRounded(ledger, `${label} mean`, band.mean, sumOf(list) / list.length, step);
      ledger.sum(metric, step, `${label} mean`, dayRecords(list));
    }
  }
}

async function collectSleepDebt(
  connection: ContractConnection,
  model: Reconstruction,
  ledger: Ledger
): Promise<void> {
  for (const weeks of SLEEP_DEBT_AGGREGATE_WEEKS) {
    const debt = await structured(connection, "get_sleep_debt", { days: weeks * 7 });
    const period = debt.period as { start: string; end: string };
    const mondays = mondaysBetween(period.start, period.end);
    expect(mondays).toHaveLength(weeks);
    const list = samplesIn(model, "sleep_deficit", mondays);
    const label = `get_sleep_debt ${weeks}w`;
    expect(debt.nights_analyzed, label).toBe(list.length);
    if (debt.total_debt_hours === null) continue;
    expectRounded(ledger, `${label} total`, debt.total_debt_hours as number, sumOf(list), 0.1);
    ledger.sum("sleep_deficit", 0.1, `${label} total`, dayRecords(list));
    expectRounded(
      ledger,
      `${label} average`,
      debt.avg_nightly_debt_hours as number,
      sumOf(list) / list.length,
      0.1
    );
    ledger.sum("sleep_deficit", 0.1, `${label} average`, dayRecords(list));
  }
}

/** [weeks in A, weeks in B, weeks between them, weeks after B], counted back from the latest released week */
const COMPARE_GRID: Array<[number, number, number, number]> = [
  [1, 1, 0, 0],
  [1, 1, 1, 0],
  [1, 1, 0, 1],
  [1, 2, 0, 0],
  [2, 1, 0, 0],
  [1, 4, 1, 0],
  [2, 2, 0, 3],
  [4, 1, 2, 5],
  [4, 4, 0, 0],
  [4, 8, 0, 0],
  [8, 4, 1, 1],
  [3, 5, 2, 2],
  [2, 12, 0, 0],
  [12, 1, 0, 1],
  [5, 5, 0, 6],
];

async function collectComparisons(
  connection: ContractConnection,
  model: Reconstruction,
  ledger: Ledger
): Promise<void> {
  const latestFirst = [...model.mondays].reverse();
  const monday = (back: number): string => latestFirst[back]!;
  for (const [aWeeks, bWeeks, gap, after] of COMPARE_GRID) {
    const bLast = after;
    const bFirst = bLast + bWeeks - 1;
    const aLast = bFirst + 1 + gap;
    const aFirst = aLast + aWeeks - 1;
    const comparison = await structured(connection, "compare_periods", {
      period_a_start: monday(aFirst),
      period_a_end: addDays(monday(aLast), 6),
      period_b_start: monday(bFirst),
      period_b_end: addDays(monday(bLast), 6),
    });
    for (const side of ["a", "b"] as const) {
      const period = comparison[`period_${side}`] as {
        first_day: string | null;
        last_day: string | null;
      };
      expect(period.first_day).not.toBeNull();
      const mondays = mondaysBetween(period.first_day!, period.last_day!);
      expect(mondays).toHaveLength(side === "a" ? aWeeks : bWeeks);
      const label = `compare_periods ${aWeeks}/${bWeeks}/${gap}/${after} ${side}`;
      for (const [group, field, metric] of [
        ["recovery", `period_${side}_avg`, "recovery"],
        ["sleep", `period_${side}_avg_hours`, "sleep_duration"],
        ["strain", `period_${side}_avg`, "strain"],
      ] as const) {
        const block = comparison[group] as Record<string, number | null>;
        const list = samplesIn(model, metric, mondays);
        expect(block[`period_${side}_n`], `${label} ${group} n`).toBe(list.length);
        const released = block[field];
        if (list.length < AGGREGATE_WEEK_MIN_SAMPLES) {
          expect(released, `${label} ${group}`).toBeNull();
          continue;
        }
        const step = AGGREGATE_METRIC_STEP[metric];
        expectRounded(ledger, `${label} ${group}`, released, sumOf(list) / list.length, step);
        ledger.sum(metric, step, `${label} ${group}`, dayRecords(list));
      }
    }
  }
}

const LOAD_METRICS = ["trimp", "day_strain", "workout_minutes", "workout_kj"] as const;

async function collectTrainingLoad(
  connection: ContractConnection,
  model: Reconstruction,
  ledger: Ledger
): Promise<void> {
  /** week → field → value, identical in every call that lists the week */
  const seen = new Map<string, string>();
  for (const weeks of [4, 8, 13, 26]) {
    for (const loadMetric of LOAD_METRICS) {
      const load = await structured(connection, "get_training_load", {
        weeks,
        load_metric: loadMetric,
      });
      const listed = load.weeks as Array<{
        week_start: string;
        released: boolean;
        sessions: number | null;
        workout_minutes: number | null;
        trimp: number | null;
        workout_kj: number | null;
        mean_day_strain: number | null;
        completed_cycles: number | null;
      }>;
      expect(listed).toHaveLength(weeks);
      for (const week of listed) {
        // `released` and the change follow load_metric; every weekly value does not.
        const fingerprint = JSON.stringify([
          week.sessions,
          week.workout_minutes,
          week.trimp,
          week.workout_kj,
          week.mean_day_strain,
          week.completed_cycles,
        ]);
        const previous = seen.get(week.week_start);
        if (previous !== undefined) expect(fingerprint, week.week_start).toBe(previous);
        seen.set(week.week_start, fingerprint);
        if (weeks !== 26 || loadMetric !== "trimp") continue;

        const label = `get_training_load ${week.week_start}`;
        const monday = week.week_start;
        if (!model.final.has(monday)) {
          expect(week.sessions, label).toBeNull();
          expect(week.workout_minutes, label).toBeNull();
          expect(week.mean_day_strain, label).toBeNull();
          continue;
        }
        const sessions = sessionsIn(model, [monday]);
        const strain = samplesIn(model, "strain", [monday]);
        // A week without WHOOP data has unknown (null) counts.
        expect(week.sessions ?? 0, `${label} sessions`).toBe(sessions.length);
        expect(week.completed_cycles ?? 0, `${label} completed_cycles`).toBe(strain.length);
        if (strain.length >= AGGREGATE_WEEK_MIN_SAMPLES) {
          expectRounded(
            ledger,
            `${label} mean_day_strain`,
            week.mean_day_strain,
            sumOf(strain) / strain.length,
            0.1
          );
          ledger.sum("strain", 0.1, `${label} mean_day_strain`, dayRecords(strain));
        } else {
          expect(week.mean_day_strain, label).toBeNull();
        }
        if (sessions.length < AGGREGATE_WEEK_MIN_SAMPLES) {
          expect(week.workout_minutes, label).toBeNull();
          expect(week.trimp, label).toBeNull();
          expect(week.workout_kj, label).toBeNull();
          continue;
        }
        const minutes = sessionRecords(sessions, SESSION_VALUES.workout_minutes!);
        expectRounded(ledger, `${label} minutes`, week.workout_minutes, sumOf(minutes), 10);
        ledger.sum("workout_minutes", 10, `${label} minutes`, minutes);
        const kj = sessionRecords(sessions, SESSION_VALUES.workout_kj!);
        expectRounded(ledger, `${label} kJ`, week.workout_kj, sumOf(kj), 100);
        ledger.sum("workout_kj", 100, `${label} kJ`, kj);
        if (sessions.every((session) => session.fullyRecorded)) {
          const trimp = sessionRecords(sessions, SESSION_VALUES.workout_trimp!);
          expectRounded(ledger, `${label} TRIMP`, week.trimp, sumOf(trimp), 10);
          ledger.sum("workout_trimp", 10, `${label} TRIMP`, trimp);
        } else {
          expect(week.trimp, `${label} TRIMP with a low-recording session`).toBeNull();
        }
      }
    }
  }
}

interface Totals {
  duration_minutes_total: number | null;
  kilojoule_total: number | null;
  kcal_total: number | null;
  trimp_total: number | null;
}

/** Rows (and confirmations) for a released totals block over `sessions`. */
function totalsRows(
  ledger: Ledger,
  label: string,
  totals: Totals,
  sessions: TrainingSession[]
): void {
  const minutes = sessionRecords(sessions, SESSION_VALUES.workout_minutes!);
  const kj = sessionRecords(sessions, SESSION_VALUES.workout_kj!);
  if (totals.duration_minutes_total !== null) {
    expectRounded(ledger, `${label} minutes`, totals.duration_minutes_total, sumOf(minutes), 10);
    ledger.sum("workout_minutes", 10, `${label} minutes`, minutes);
  }
  if (totals.kilojoule_total !== null) {
    expectRounded(ledger, `${label} kJ`, totals.kilojoule_total, sumOf(kj), 100);
    ledger.sum("workout_kj", 100, `${label} kJ`, kj);
  }
  if (totals.kcal_total !== null) {
    expectRounded(ledger, `${label} kcal`, totals.kcal_total, sumOf(kj) / KJ_PER_KCAL, 100);
    ledger.sum("workout_kj", 100 * KJ_PER_KCAL, `${label} kcal`, kj, 1 / KJ_PER_KCAL);
  }
  if (totals.trimp_total !== null) {
    const hr = sessions.filter(
      (session) => session.fullyRecorded && session.summary.zone_minutes !== null
    );
    expect(hr.length, label).toBeGreaterThanOrEqual(AGGREGATE_WEEK_MIN_SAMPLES);
    const trimp = sessionRecords(hr, SESSION_VALUES.workout_trimp!);
    expectRounded(ledger, `${label} TRIMP`, totals.trimp_total, sumOf(trimp), 10);
    ledger.sum("workout_trimp", 10, `${label} TRIMP`, trimp);
    // Zone shares with TRIMP also give these sessions' recorded minutes.
    ledger.sum(
      "recorded_minutes",
      10,
      `${label} recorded minutes (zone shares)`,
      sessionRecords(hr, SESSION_VALUES.recorded_minutes!)
    );
  }
}

async function collectSportBreakdowns(
  connection: ContractConnection,
  model: Reconstruction,
  ledger: Ledger
): Promise<number> {
  let availableBlocks = 0;
  for (let blockOffset = 1; blockOffset <= 26; blockOffset++) {
    const breakdown = await structured(connection, "get_sport_breakdown", {
      block_offset: blockOffset,
    });
    const block = breakdown.block as { start_week: string; end_week: string };
    const mondays = mondaysBetween(block.start_week, block.end_week);
    expect(mondays).toHaveLength(4);
    const label = `get_sport_breakdown ${block.start_week}`;
    if (breakdown.status !== "available") {
      for (const sport of breakdown.sports as unknown[]) expect(sport, label).toBeUndefined();
      continue;
    }
    availableBlocks += 1;
    const scored = sessionsIn(model, mondays);
    const bySport = new Map<string, TrainingSession[]>();
    for (const session of scored) {
      const list = bySport.get(session.summary.sport_name) ?? [];
      list.push(session);
      bySport.set(session.summary.sport_name, list);
    }
    const sports = breakdown.sports as Array<
      Totals & {
        sport_name: string;
        sessions: number;
        strain_mean: number | null;
        gps: {
          sessions: number;
          distance_km_total: number | null;
          avg_pace_sec_per_km: number | null;
        } | null;
      }
    >;
    for (const sport of sports) {
      const sessions = bySport.get(sport.sport_name) ?? [];
      const sportLabel = `${label} ${sport.sport_name}`;
      expect(sport.sessions, sportLabel).toBe(sessions.length);
      expect(sessions.length, sportLabel).toBeGreaterThanOrEqual(AGGREGATE_WEEK_MIN_SAMPLES);
      totalsRows(ledger, sportLabel, sport, sessions);
      if (sport.strain_mean !== null) {
        const strain = sessionRecords(sessions, SESSION_VALUES.workout_strain!);
        expectRounded(
          ledger,
          `${sportLabel} strain_mean`,
          sport.strain_mean,
          sumOf(strain) / strain.length,
          0.1
        );
        ledger.sum("workout_strain", 0.1, `${sportLabel} strain_mean`, strain);
      }
      if (sport.gps !== null && sport.gps.distance_km_total !== null) {
        const gps = sessions.filter((session) => SESSION_VALUES.gps_distance!(session) !== null);
        expect(sport.gps.sessions, sportLabel).toBe(gps.length);
        const distance = sessionRecords(gps, SESSION_VALUES.gps_distance!);
        expectRounded(
          ledger,
          `${sportLabel} distance`,
          sport.gps.distance_km_total,
          sumOf(distance),
          1
        );
        ledger.sum("gps_distance", 1, `${sportLabel} distance`, distance);
        // Pace times distance gives these sessions' elapsed minutes.
        ledger.sum(
          "workout_minutes",
          10,
          `${sportLabel} minutes (pace × distance)`,
          sessionRecords(gps, SESSION_VALUES.workout_minutes!)
        );
      }
    }
    const releasedNames = new Set(sports.map((sport) => sport.sport_name));
    const pool = scored.filter((session) => !releasedNames.has(session.summary.sport_name));
    const other = breakdown.other as (Totals & { sessions: number }) | null;
    if (other !== null) {
      expect(other.sessions, `${label} other`).toBe(pool.length);
      totalsRows(ledger, `${label} other`, other, pool);
    } else {
      expect(pool, `${label} other`).toHaveLength(0);
    }
    const overall = breakdown.overall as Totals & { sessions: number | null };
    expect(overall.sessions, `${label} overall`).toBe(scored.length);
    totalsRows(ledger, `${label} overall`, overall, scored);
  }
  return availableBlocks;
}

// ---------------------------------------------------------------------------
// Linear algebra
// ---------------------------------------------------------------------------

const RANK_TOLERANCE = 1e-9;

interface Echelon {
  /** Pivot rows in reduced row echelon form, with their pivot columns */
  pivots: Array<{ column: number; row: Float64Array }>;
  columns: number;
}

/** Reduced row echelon form with partial pivoting (rows normalized to max |entry| 1 first). */
function reducedEchelon(rows: readonly Float64Array[], columns: number): Echelon {
  const matrix = rows.map((row) => {
    const scale = row.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
    return scale > 0 ? row.map((value) => value / scale) : Float64Array.from(row);
  });
  const pivots: Echelon["pivots"] = [];
  let rank = 0;
  for (let column = 0; column < columns && rank < matrix.length; column++) {
    let best = rank;
    for (let index = rank + 1; index < matrix.length; index++) {
      if (Math.abs(matrix[index]![column]!) > Math.abs(matrix[best]![column]!)) best = index;
    }
    if (Math.abs(matrix[best]![column]!) <= RANK_TOLERANCE) continue;
    [matrix[rank], matrix[best]] = [matrix[best]!, matrix[rank]!];
    const pivotRow = matrix[rank]!;
    const pivot = pivotRow[column]!;
    for (let k = 0; k < columns; k++) pivotRow[k] = pivotRow[k]! / pivot;
    for (let index = 0; index < matrix.length; index++) {
      if (index === rank) continue;
      const target = matrix[index]!;
      const factor = target[column]!;
      if (Math.abs(factor) <= RANK_TOLERANCE) continue;
      for (let k = 0; k < columns; k++) target[k] = target[k]! - factor * pivotRow[k]!;
    }
    pivots.push({ column, row: pivotRow });
    rank += 1;
  }
  return { pivots, columns };
}

/**
 * Record index sets of size 1 or 2 whose (unit) sum lies in the row space: a
 * pivot row whose free part is zero (its pivot record alone) or a unit vector
 * (its pivot record plus one free record), or two pivot rows whose free parts
 * cancel (their two pivot records).
 */
function isolatedSubsets(echelon: Echelon): number[][] {
  const pivotColumns = new Set(echelon.pivots.map((pivot) => pivot.column));
  const free: number[] = [];
  for (let column = 0; column < echelon.columns; column++) {
    if (!pivotColumns.has(column)) free.push(column);
  }
  const quantize = (value: number): number =>
    Math.abs(value) <= 1e-7 ? 0 : Math.round(value * 1e6);
  const found: number[][] = [];
  const byFreePart = new Map<string, number>();
  for (const { column, row } of echelon.pivots) {
    const part = free.map((index) => quantize(row[index]!));
    const nonZero = part.flatMap((value, index) => (value !== 0 ? [index] : []));
    if (nonZero.length === 0) found.push([column]);
    else if (nonZero.length === 1 && part[nonZero[0]!] === 1_000_000)
      found.push([column, free[nonZero[0]!]!]);
    const negated = part.map((value) => -value).join(",");
    const partner = byFreePart.get(negated);
    if (partner !== undefined && nonZero.length > 0) found.push([partner, column]);
    byFreePart.set(part.join(","), column);
  }
  return found;
}

/** Orthonormal basis of the row space (modified Gram-Schmidt, applied twice). */
function orthonormalBasis(rows: readonly Float64Array[], columns: number): Float64Array[] {
  const basis: Float64Array[] = [];
  for (const source of rows) {
    const vector = Float64Array.from(source);
    const initial = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    if (initial === 0) continue;
    for (let pass = 0; pass < 2; pass++) {
      for (const q of basis) {
        let dot = 0;
        for (let k = 0; k < columns; k++) dot += q[k]! * vector[k]!;
        for (let k = 0; k < columns; k++) vector[k] = vector[k]! - dot * q[k]!;
      }
    }
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    if (norm <= 1e-9 * initial) continue;
    basis.push(vector.map((value) => value / norm));
  }
  return basis;
}

interface FamilyReport {
  family: string;
  records: number;
  rows: number;
  rank: number;
  isolated: string[];
  pinned: string[];
  maxLeverage: number;
}

function analyzeFamily(family: Family): FamilyReport {
  const keys = [...family.values.keys()].sort();
  const column = new Map(keys.map((key, index) => [key, index]));
  const matrix = family.rows.map((row) => {
    const vector = new Float64Array(keys.length);
    for (const [key, coefficient] of row.coefficients) vector[column.get(key)!] = coefficient;
    return vector;
  });
  const echelon = reducedEchelon(matrix, keys.length);
  const isolated = isolatedSubsets(echelon).map((subset) =>
    subset.map((index) => keys[index]).join(" + ")
  );

  // Projection of each record's unit vector onto the row space.
  const basis = orthonormalBasis(matrix, keys.length);
  const values = keys.map((key) => family.values.get(key)!);
  const range = Math.max(...values) - Math.min(...values);
  const pinned: string[] = [];
  let maxLeverage = 0;
  for (let r = 0; r < keys.length; r++) {
    let leverage = 0;
    for (const q of basis) leverage += q[r]! * q[r]!;
    maxLeverage = Math.max(maxLeverage, leverage);
    if (leverage <= RANK_TOLERANCE) continue;
    // Cheap bound first: the other records' weights have L2 norm sqrt(h − h²).
    const lowerBound =
      (Math.sqrt(Math.max(0, leverage - leverage * leverage)) * range) / 2 / leverage;
    if (lowerBound > family.step) continue;
    const projection = new Float64Array(keys.length);
    for (const q of basis) {
      const weight = q[r]!;
      for (let k = 0; k < keys.length; k++) projection[k] = projection[k]! + weight * q[k]!;
    }
    let contamination = 0;
    for (let k = 0; k < keys.length; k++) if (k !== r) contamination += Math.abs(projection[k]!);
    const uncertainty = (contamination * range) / 2 / leverage;
    if (uncertainty <= family.step) pinned.push(`${keys[r]} (±${uncertainty.toFixed(3)})`);
  }
  return {
    family: family.name,
    records: keys.length,
    rows: family.rows.length,
    rank: echelon.pivots.length,
    isolated,
    pinned,
    maxLeverage,
  };
}

describe("linear algebra helpers", () => {
  it("finds a single record and a pair isolated by differencing, and nothing in disjoint blocks", () => {
    const toRows = (sets: number[][], columns: number): Float64Array[] =>
      sets.map((set) => {
        const row = new Float64Array(columns);
        for (const index of set) row[index] = 1;
        return row;
      });
    // [0,1,2,3] − [1,2,3] = record 0
    expect(
      isolatedSubsets(
        reducedEchelon(
          toRows(
            [
              [0, 1, 2, 3],
              [1, 2, 3],
            ],
            4
          ),
          4
        )
      )
    ).toEqual([[0]]);
    // [0,1,2,3,4] − [2,3,4] = records 0 + 1
    const pair = isolatedSubsets(
      reducedEchelon(
        toRows(
          [
            [0, 1, 2, 3, 4],
            [2, 3, 4],
          ],
          5
        ),
        5
      )
    );
    expect(pair.map((subset) => [...subset].sort())).toContainEqual([0, 1]);
    // Disjoint blocks of 3 and their unions: nothing
    expect(
      isolatedSubsets(
        reducedEchelon(
          toRows(
            [
              [0, 1, 2],
              [3, 4, 5],
              [0, 1, 2, 3, 4, 5],
            ],
            6
          ),
          6
        )
      )
    ).toEqual([]);
    // A block total minus a per-sport total leaves the pair outside the sport: {0..5} − {2,3,4,5} = 0 + 1
    const overlapping = toRows(
      [
        [0, 1, 2, 3],
        [2, 3, 4, 5],
        [0, 1, 2, 3, 4, 5],
      ],
      6
    );
    const pairs = isolatedSubsets(reducedEchelon(overlapping, 6)).map((subset) =>
      [...subset].sort()
    );
    expect(pairs).toContainEqual([0, 1]);
    // Only differences (not sums) of records follow from these overlapping sums.
    expect(
      isolatedSubsets(
        reducedEchelon(
          toRows(
            [
              [0, 1, 2],
              [3, 4, 5],
              [2, 3, 4],
              [0, 1, 5],
            ],
            6
          ),
          6
        )
      )
    ).toEqual([]);
  });

  it("measures pinning by projection", () => {
    const family: Family = {
      name: "test",
      step: 1,
      values: new Map(Array.from({ length: 6 }, (_, index) => [`r${index}`, 50 + index])),
      rows: [
        {
          source: "week 1",
          coefficients: new Map([
            ["r0", 1],
            ["r1", 1],
            ["r2", 1],
          ]),
        },
        {
          source: "week 2",
          coefficients: new Map([
            ["r3", 1],
            ["r4", 1],
            ["r5", 1],
          ]),
        },
      ],
    };
    const safe = analyzeFamily(family);
    expect(safe.isolated).toEqual([]);
    expect(safe.pinned).toEqual([]);
    expect(safe.maxLeverage).toBeCloseTo(1 / 3, 9);

    family.rows.push({
      source: "leak",
      coefficients: new Map([
        ["r1", 1],
        ["r2", 1],
      ]),
    });
    const leaky = analyzeFamily(family);
    expect(leaky.isolated).toContain("r0");
    expect(leaky.pinned.some((entry) => entry.startsWith("r0 "))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The cross-tool check
// ---------------------------------------------------------------------------

/** Accounts the cross-tool check runs on (120 days each, distinct values applied). */
const ACCOUNTS: Array<[string, () => WhoopUserFixture]> = [
  ["matureUser, 1 workout a day, +02:00 to +01:00", () => matureUser({ days: 120 })],
  [
    "matureUser, 3 workouts a day, -05:00, 10 calibrating days",
    () =>
      matureUser({
        days: 120,
        seed: 7,
        offset: "-05:00",
        workoutsPerDay: 3,
        calibratingFirst: 10,
      }),
  ],
  [
    "matureUser, 2 workouts a day, late workouts every other day",
    () => matureUser({ days: 120, seed: 3, workoutsPerDay: 2, lateWorkoutEvery: 2, napEvery: 3 }),
  ],
];

/** Collect every released value of every aggregate tool on `fixture` into a ledger. */
async function collectAll(
  fixture: WhoopUserFixture
): Promise<{ ledger: Ledger; model: Reconstruction; availableBlocks: number }> {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(fixture.now);
  const model = await reconstruct(fixture);
  const connection = await connectServer(createWhoopFixtureClient(fixture), {
    privacyMode: "aggregate",
    historyCache: new MemoryCache({ maxEntries: 500 }),
    now: () => new Date(),
  });
  const ledger = new Ledger();
  try {
    await collectWeeklySummaries(connection, model, ledger);
    await collectTrends(connection, model, ledger);
    await collectBaselines(connection, model, ledger);
    await collectSleepDebt(connection, model, ledger);
    await collectComparisons(connection, model, ledger);
    await collectTrainingLoad(connection, model, ledger);
    const availableBlocks = await collectSportBreakdowns(connection, model, ledger);
    return { ledger, model, availableBlocks };
  } finally {
    await connection.close();
  }
}

describe("aggregate privacy across tools", () => {
  it.each(ACCOUNTS)(
    "%s: no single record, pair of records or rounded combination is recoverable from all released aggregates",
    async (label, account) => {
      const fixture = withDistinctValues(account());
      const { ledger, model, availableBlocks } = await collectAll(fixture);

      // The grids released a substantial set of confirmed values.
      expect(model.final.size).toBeGreaterThanOrEqual(12);
      expect(availableBlocks).toBeGreaterThanOrEqual(3);
      expect(ledger.verified).toBeGreaterThan(400);

      const reports = [...ledger.families.values()].map(analyzeFamily);
      if (process.env.CROSS_TOOL_REPORT) {
        const summary = { account: label, verified: ledger.verified, availableBlocks, reports };
        process.stderr.write(`${JSON.stringify(summary)}\n`);
      }
      for (const name of [
        "recovery",
        "hrv",
        "rhr",
        "sleep_duration",
        "sleep_deficit",
        "strain",
        "workout_minutes",
        "workout_kj",
        "workout_trimp",
        "workout_strain",
        "gps_distance",
      ]) {
        const report = reports.find((candidate) => candidate.family === name);
        expect(report, `family ${name} collected`).toBeDefined();
        expect(report!.rows, `family ${name} rows`).toBeGreaterThanOrEqual(3);
      }

      // Distinct per-record values in every family.
      for (const family of ledger.families.values()) {
        const values = [...family.values.values()];
        expect(new Set(values).size, `${family.name} values distinct`).toBe(values.length);
      }

      // Every released linear value covers at least 3 records.
      for (const family of ledger.families.values()) {
        for (const row of family.rows) {
          expect(row.coefficients.size, `${family.name}: ${row.source}`).toBeGreaterThanOrEqual(
            AGGREGATE_WEEK_MIN_SAMPLES
          );
        }
      }

      for (const report of reports) {
        expect(report.isolated, `${report.family}: isolated by differencing`).toEqual([]);
        expect(report.pinned, `${report.family}: pinned within its rounding step`).toEqual([]);
        expect(report.maxLeverage, `${report.family}: a record fully determined`).toBeLessThan(
          1 - 1e-6
        );
      }
    },
    TIMEOUT_MS
  );

  it("rounds weekly workout energy with the same step in get_weekly_summary and get_training_load", () => {
    expect(AGGREGATE_STEPS.workout_kj).toBe(AGGREGATE_WORKOUT_KJ_STEP);
    expect(AGGREGATE_WORKOUT_STRAIN_STEP).toBe(1);
  });

  /**
   * Regression: a cycle that starts at local midnight without a main sleep (a
   * strap put back on after a gap) is a partial day for get_weekly_summary,
   * get_trend and compare_periods (isPartialDay). get_training_load once
   * checked only placeDays' window-dependent partialDays and still counted its
   * day strain, so differencing the two weekly means on this fixture
   * (7 × 9.1 − 6 × 8.8) recovered that one day's strain within ±0.65.
   */
  it(
    "a midnight-start cycle without a main sleep counts the same in every aggregate tool",
    async () => {
      const fixture = matureUser({ days: 120 });
      const target = fixture.sleeps.find(
        (sleep) => !sleep.nap && sleep.end.startsWith("2026-08-26")
      )!;
      const cycle = fixture.cycles.find((candidate) => candidate.id === target.cycle_id)!;
      const previous = fixture.cycles.find((candidate) => candidate.end === cycle.start)!;
      const offset = cycle.timezone_offset;
      // Strap off at 21:40 the evening before, back on at local midnight without a main sleep.
      previous.end = new Date(Date.parse(`2026-08-25T21:40:00${offset}`)).toISOString();
      cycle.start = new Date(Date.parse(`2026-08-26T00:00:00${offset}`)).toISOString();
      fixture.sleeps = fixture.sleeps.filter((sleep) => sleep.id !== target.id);
      fixture.recoveries = fixture.recoveries.filter((recovery) => recovery.cycle_id !== cycle.id);

      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(fixture.now);
      const connection = await connectServer(createWhoopFixtureClient(fixture), {
        privacyMode: "aggregate",
        historyCache: new MemoryCache({ maxEntries: 500 }),
        now: () => new Date(),
      });
      try {
        const weekly = await structured(connection, "get_weekly_summary", {
          week_start: "2026-08-24",
        });
        const load = await structured(connection, "get_training_load", {
          weeks: 8,
          load_metric: "day_strain",
        });
        const week = (
          load.weeks as Array<{
            week_start: string;
            mean_day_strain: number | null;
            completed_cycles: number | null;
          }>
        ).find((candidate) => candidate.week_start === "2026-08-24")!;
        expect(week.completed_cycles).toBe(
          (weekly.sample_sizes as { completed_cycles: number }).completed_cycles
        );
        expect(week.mean_day_strain).toBe(
          (weekly.strain as { average_daily_strain: number | null }).average_daily_strain
        );
      } finally {
        await connection.close();
      }
    },
    TIMEOUT_MS
  );
});

// ---------------------------------------------------------------------------
// get_sync_status (aggregate) through a release week
// ---------------------------------------------------------------------------

/** The fixture as seen at `nowMs`: later records dropped, later cycle ends open, later updates undone. */
function asOf(fixture: WhoopUserFixture, nowMs: number): WhoopUserFixture {
  const created = (record: { created_at: string }): boolean =>
    Date.parse(record.created_at) <= nowMs;
  const ended = (record: { end: string }): boolean => Date.parse(record.end) <= nowMs;
  const notUpdatedLater = <T extends { created_at: string; updated_at: string }>(record: T): T =>
    Date.parse(record.updated_at) > nowMs ? { ...record, updated_at: record.created_at } : record;
  return {
    ...fixture,
    now: new Date(nowMs),
    cycles: fixture.cycles
      .filter((cycle) => created(cycle) && Date.parse(cycle.start) <= nowMs)
      .map(
        (cycle): Cycle =>
          typeof cycle.end === "string" && Date.parse(cycle.end) > nowMs
            ? { ...cycle, end: null }
            : cycle
      )
      .map(notUpdatedLater),
    sleeps: fixture.sleeps.filter((sleep) => created(sleep) && ended(sleep)).map(notUpdatedLater),
    recoveries: fixture.recoveries.filter(created).map(notUpdatedLater),
    workouts: fixture.workouts
      .filter((workout) => created(workout) && ended(workout))
      .map(notUpdatedLater),
  };
}

describe("aggregate get_sync_status through a release week", () => {
  it(
    "is identical from Wednesday 00:00 to the next Tuesday 23:59 local, apart from evaluated_on",
    async () => {
      // +01:00 from the fixture's offset change on; the span runs Wednesday 16 to Tuesday 22 September.
      const full = matureUser({ days: 120, now: "2026-09-22T23:59:00+01:00" });
      const instants = [
        "2026-09-16T00:00:00+01:00",
        "2026-09-16T00:00:30+01:00",
        "2026-09-17T12:00:00+01:00",
        "2026-09-19T23:30:00+01:00",
        "2026-09-21T00:10:00+01:00",
        "2026-09-21T07:05:00+01:00",
        "2026-09-22T12:00:00+01:00",
        "2026-09-22T23:59:00+01:00",
      ];
      const outputs: string[] = [];
      const dates: string[] = [];
      for (const instant of instants) {
        const view = asOf(full, Date.parse(instant));
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(view.now);
        const connection = await connectServer(createWhoopFixtureClient(view), {
          privacyMode: "aggregate",
          historyCache: new MemoryCache({ maxEntries: 500 }),
          now: () => new Date(),
        });
        try {
          const status = await structured(connection, "get_sync_status", {});
          const { evaluated_on: evaluatedOn, ...rest } = status;
          dates.push(evaluatedOn as string);
          outputs.push(JSON.stringify(rest));
          expect(status.assessment).toBe("connected");
          const released = status.released_weeks as { latest_week_start: string };
          expect(released.latest_week_start).toBe("2026-09-07");
        } finally {
          await connection.close();
          vi.useRealTimers();
        }
      }
      expect(new Set(outputs).size).toBe(1);
      expect(dates[0]).toBe("2026-09-16");
      expect(dates[dates.length - 1]).toBe("2026-09-22");
      // No field or note carries a time of day.
      expect(outputs[0]).not.toMatch(/T\d{2}:\d{2}/);
    },
    TIMEOUT_MS
  );
});
