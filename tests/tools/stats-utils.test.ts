/**
 * Tests for stats-utils.ts — statistical functions for analytical tools.
 *
 * Covers: isConstant, mean, median, linearRegression,
 * detectAnomalies, trendDirection. Edge cases: empty arrays,
 * single values, constant data, monotonic sequences.
 */

import { describe, it, expect } from "vitest";
import {
  isConstant,
  mean,
  median,
  linearRegression,
  linearRegressionXY,
  MIN_TREND_POINTS,
  detectAnomalies,
  trendDirection,
  trendConfidence,
  roundTo,
  sampleStandardDeviation,
  ranks,
  spearman,
  normalCdf,
  lag1RankAutocorrelation,
  effectiveSampleSize,
  correlationInterval,
  mannWhitney,
  cliffsDelta,
  benjaminiHochberg,
  medianAbsoluteDeviation,
  robustZ,
  percentileRank,
  rollingMean,
  ewmaSeries,
  fosterWeek,
  quantileCuts,
  kNearestMedian,
  circularSignedDeltaMinutes,
  MIN_LAG1_PAIRS,
} from "../../src/tools/stats-utils.js";
import { createLcg, hashSeed } from "../helpers/whoop-users.js";

// ---------------------------------------------------------------------------
// mean
// ---------------------------------------------------------------------------

describe("isConstant", () => {
  it("is true only when every value is identical", () => {
    expect(isConstant([7])).toBe(true);
    expect(isConstant([70.1, 70.1, 70.1])).toBe(true);
    expect(isConstant([70.1, 70.1, 70.2])).toBe(false);
  });

  it("throws for empty array", () => {
    expect(() => isConstant([])).toThrow(/empty/i);
  });
});

describe("mean", () => {
  it("returns identical decimal values exactly, without rounding drift", () => {
    expect(mean(Array(21).fill(70.1))).toBe(70.1);
  });

  it("computes the arithmetic mean", () => {
    expect(mean([1, 2, 3, 4, 5])).toBe(3);
  });

  it("handles a single value", () => {
    expect(mean([42])).toBe(42);
  });

  it("handles negative values", () => {
    expect(mean([-10, 10])).toBe(0);
  });

  it("handles decimal values", () => {
    expect(mean([1.5, 2.5, 3.0])).toBeCloseTo(2.333, 2);
  });

  it("throws for empty array", () => {
    expect(() => mean([])).toThrow(/empty/i);
  });
});

// ---------------------------------------------------------------------------
// median
// ---------------------------------------------------------------------------

describe("median", () => {
  it("returns middle value for odd-length arrays", () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it("returns average of two middle values for even-length arrays", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("handles a single value", () => {
    expect(median([7])).toBe(7);
  });

  it("handles unsorted input", () => {
    expect(median([5, 1, 3, 2, 4])).toBe(3);
  });

  it("does not mutate the input array", () => {
    const input = [3, 1, 2];
    median(input);
    expect(input).toEqual([3, 1, 2]);
  });

  it("throws for empty array", () => {
    expect(() => median([])).toThrow(/empty/i);
  });
});

// ---------------------------------------------------------------------------
// linearRegression
// ---------------------------------------------------------------------------

describe("linearRegression", () => {
  it("returns positive slope for monotonically increasing values", () => {
    const result = linearRegression([1, 2, 3, 4, 5]);
    expect(result.slope).toBe(1);
    expect(result.r2).toBeCloseTo(1.0, 5);
  });

  it("returns negative slope for monotonically decreasing values", () => {
    const result = linearRegression([5, 4, 3, 2, 1]);
    expect(result.slope).toBe(-1);
    expect(result.r2).toBeCloseTo(1.0, 5);
  });

  it("returns zero slope for constant values", () => {
    const result = linearRegression([3, 3, 3, 3]);
    expect(result.slope).toBe(0);
    expect(result.r2).toBe(0);
  });

  it("returns slope and R² for noisy data", () => {
    // Slight upward trend with noise
    const result = linearRegression([1, 3, 2, 4, 3, 5]);
    expect(result.slope).toBeGreaterThan(0);
    expect(result.r2).toBeGreaterThan(0);
    expect(result.r2).toBeLessThanOrEqual(1);
  });

  it("handles two values", () => {
    const result = linearRegression([10, 20]);
    expect(result.slope).toBe(10);
    expect(result.r2).toBeCloseTo(1.0, 5);
  });

  it("returns zero slope and zero R² for single value", () => {
    const result = linearRegression([42]);
    expect(result.slope).toBe(0);
    expect(result.r2).toBe(0);
  });

  it("throws for empty array", () => {
    expect(() => linearRegression([])).toThrow(/empty/i);
  });

  it("returns NaN-safe results (no NaN in output)", () => {
    const result = linearRegression([5, 5, 5]);
    expect(Number.isNaN(result.slope)).toBe(false);
    expect(Number.isNaN(result.r2)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// linearRegressionXY
// ---------------------------------------------------------------------------

describe("linearRegressionXY", () => {
  it("matches linearRegression when xs are 0..n-1", () => {
    const values = [1, 3, 2, 4, 3, 5];
    const indexed = linearRegression(values);
    const explicit = linearRegressionXY([0, 1, 2, 3, 4, 5], values);
    expect(explicit.slope).toBeCloseTo(indexed.slope, 10);
    expect(explicit.r2).toBeCloseTo(indexed.r2, 10);
  });

  it("respects gaps between xs (slope per unit of x, not per point)", () => {
    const result = linearRegressionXY([0, 1, 4, 5], [10, 12, 18, 20]);
    expect(result.slope).toBeCloseTo(2, 10);
    expect(result.r2).toBeCloseTo(1, 10);
  });

  it("does not depend on the order of (x, y) pairs", () => {
    const forward = linearRegressionXY([0, 1, 2, 3], [4, 3, 2, 1]);
    const reversed = linearRegressionXY([3, 2, 1, 0], [1, 2, 3, 4]);
    expect(reversed.slope).toBeCloseTo(forward.slope, 10);
    expect(forward.slope).toBeCloseTo(-1, 10);
  });

  it("returns zero slope and R² for one point, identical xs or constant ys", () => {
    expect(linearRegressionXY([3], [42])).toEqual({ slope: 0, r2: 0 });
    expect(linearRegressionXY([2, 2, 2], [1, 5, 9])).toEqual({ slope: 0, r2: 0 });
    expect(linearRegressionXY([0, 1, 2], [7, 7, 7])).toEqual({ slope: 0, r2: 0 });
  });

  it("returns exactly zero slope and R² for identical decimal ys (no rounding drift)", () => {
    const xs = [0, 2, 6, 5, 6, 9, 7, 7, 9, 13];
    expect(linearRegressionXY(xs, Array(10).fill(70.1))).toEqual({ slope: 0, r2: 0 });
  });

  it("throws for empty or mismatched arrays and non-finite values", () => {
    expect(() => linearRegressionXY([], [])).toThrow(/empty/i);
    expect(() => linearRegressionXY([0, 1], [1])).toThrow(/same length/);
    expect(() => linearRegressionXY([0, 1], [1, Number.NaN])).toThrow(RangeError);
  });

  it("exports a minimum of 4 points for trend claims", () => {
    expect(MIN_TREND_POINTS).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// detectAnomalies
// ---------------------------------------------------------------------------

describe("detectAnomalies", () => {
  it("detects values more than 2σ from the mean by default", () => {
    // Mean=5, stddev=~1.58. Value 10 is >2σ away
    const values = [5, 5, 5, 5, 5, 10];
    const anomalies = detectAnomalies(values);

    expect(anomalies.length).toBeGreaterThanOrEqual(1);
    expect(anomalies.some((a) => a.value === 10)).toBe(true);
  });

  it("returns empty array when no anomalies exist", () => {
    const anomalies = detectAnomalies([5, 5, 5, 5]);
    expect(anomalies).toEqual([]);
  });

  it("uses custom threshold", () => {
    // With threshold=1, more values become anomalies
    const values = [1, 2, 3, 4, 100];
    const anomalies1 = detectAnomalies(values, 1);
    const anomalies2 = detectAnomalies(values, 2);

    expect(anomalies1.length).toBeGreaterThanOrEqual(anomalies2.length);
  });

  it("returns correct index, value, and deviation", () => {
    // Mean 50/3, sample SD sqrt(5000/3) ≈ 40.82: 100 lies 2.04 SD above the mean
    const values = [0, 0, 0, 0, 0, 100];
    const anomalies = detectAnomalies(values);

    expect(anomalies).toHaveLength(1);
    const anomaly = anomalies[0]!;
    expect(anomaly.index).toBe(5);
    expect(anomaly.value).toBe(100);
    expect(anomaly.deviation).toBeCloseTo((100 - 50 / 3) / Math.sqrt(5000 / 3), 12);
  });

  it("measures deviations in sample standard deviations (the std_dev tools report)", () => {
    // Population SD of [0, 0, 0, 0, 10] is 4 (10 lies 2.0 SD above the mean 2);
    // the sample SD is sqrt(20) ≈ 4.47, so 10 lies only 1.79 SD above it.
    const values = [0, 0, 0, 0, 10];
    expect(detectAnomalies(values, 1.9)).toEqual([]);
    const [anomaly] = detectAnomalies(values, 1.5);
    expect(anomaly!.deviation).toBeCloseTo(8 / sampleStandardDeviation(values)!, 12);
  });

  it("returns empty array for single value", () => {
    const anomalies = detectAnomalies([42]);
    expect(anomalies).toEqual([]);
  });

  it("returns empty array for constant values", () => {
    const anomalies = detectAnomalies([5, 5, 5, 5, 5]);
    expect(anomalies).toEqual([]);
  });

  it("throws for empty array", () => {
    expect(() => detectAnomalies([])).toThrow(/empty/i);
  });
});

// ---------------------------------------------------------------------------
// trendDirection
// ---------------------------------------------------------------------------

describe("trendDirection", () => {
  it('returns "improving" for positive slope with high R²', () => {
    expect(trendDirection(0.5, 0.8)).toBe("improving");
  });

  it('returns "declining" for negative slope with high R²', () => {
    expect(trendDirection(-0.5, 0.8)).toBe("declining");
  });

  it('returns "stable" for zero slope', () => {
    expect(trendDirection(0, 0.9)).toBe("stable");
  });

  it('returns "stable" for low R² regardless of slope', () => {
    expect(trendDirection(5.0, 0.3)).toBe("stable");
    expect(trendDirection(-5.0, 0.1)).toBe("stable");
  });

  it('returns "stable" for medium R² with near-zero slope', () => {
    // R² between 0.4 and 0.7 — "medium confidence"
    // Near-zero slope (below 0.001 threshold) should be stable
    const result = trendDirection(0.0005, 0.5);
    expect(result).toBe("stable");
  });

  it("uses R² threshold boundaries correctly", () => {
    // R² = 0.4 exactly → low confidence → stable
    expect(trendDirection(10, 0.4)).toBe("stable");
    // R² = 0.41 → medium confidence → with significant slope, should give direction
    expect(trendDirection(10, 0.41)).toBe("improving");
    // R² = 0.7 exactly → medium → improving
    expect(trendDirection(10, 0.7)).toBe("improving");
  });
});

// ---------------------------------------------------------------------------
// F0.10 additions
// ---------------------------------------------------------------------------

describe("trendConfidence", () => {
  it("caps confidence by sample size and rates constant values on size alone", () => {
    expect(trendConfidence(0.99, 6, false)).toBe("low");
    expect(trendConfidence(0.99, 7, false)).toBe("medium");
    expect(trendConfidence(0.99, 14, false)).toBe("high");
    expect(trendConfidence(0.5, 20, false)).toBe("medium");
    expect(trendConfidence(0.4, 20, false)).toBe("low");
    expect(trendConfidence(0, 14, true)).toBe("high");
    expect(trendConfidence(0, 10, true)).toBe("medium");
  });
});

describe("roundTo", () => {
  it("rounds half away from zero without floating-point surprises", () => {
    expect(roundTo(1.005, 2)).toBe(1.01);
    expect(roundTo(-1.005, 2)).toBe(-1.01);
    expect(roundTo(0.285, 2)).toBe(0.29);
    expect(roundTo(-2.5, 0)).toBe(-3);
    expect(roundTo(1234.5678, 0)).toBe(1235);
    expect(roundTo(0.99975777, 3)).toBe(1);
  });

  it("never returns negative zero and keeps null", () => {
    expect(Object.is(roundTo(-0.04, 1), 0)).toBe(true);
    expect(roundTo(null, 2)).toBeNull();
  });

  it("rejects non-finite values and invalid digit counts", () => {
    expect(() => roundTo(NaN, 1)).toThrow(RangeError);
    expect(() => roundTo(Infinity, 1)).toThrow(RangeError);
    expect(() => roundTo(1, -1)).toThrow(RangeError);
    expect(() => roundTo(1, 1.5)).toThrow(RangeError);
  });
});

describe("sampleStandardDeviation", () => {
  it("uses the n − 1 denominator", () => {
    expect(sampleStandardDeviation([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(Math.sqrt(32 / 7), 12);
    expect(sampleStandardDeviation([70.1, 70.1, 70.1])).toBe(0);
  });

  it("is null below two values and rejects non-finite input", () => {
    expect(sampleStandardDeviation([5])).toBeNull();
    expect(sampleStandardDeviation([])).toBeNull();
    expect(() => sampleStandardDeviation([1, NaN])).toThrow(RangeError);
  });
});

describe("ranks and spearman", () => {
  it("averages tied ranks in input order", () => {
    expect(ranks([3, 1, 3, 2])).toEqual([3.5, 1, 3.5, 2]);
    expect(ranks([7, 7, 7])).toEqual([2, 2, 2]);
    expect(ranks([])).toEqual([]);
    expect(() => ranks([1, Infinity])).toThrow(RangeError);
  });

  it("correlates ranks, not values", () => {
    expect(spearman([1, 2, 3, 4, 5], [1, 4, 9, 16, 1000])).toBe(1);
    expect(spearman([1, 2, 3, 4, 5], [10, 8, 6, 4, 2])).toBe(-1);
    // ys ranks [1, 2, 3.5, 5, 3.5]: 8 / sqrt(10 · 9.5)
    expect(spearman([1, 2, 3, 4, 5], [5, 6, 7, 8, 7])).toBeCloseTo(8 / Math.sqrt(95), 12);
  });

  it("is null without variance or pairs and rejects mismatched lengths", () => {
    expect(spearman([1, 2, 3], [4, 4, 4])).toBeNull();
    expect(spearman([1], [2])).toBeNull();
    expect(spearman([], [])).toBeNull();
    expect(() => spearman([1, 2], [1])).toThrow(/same length/);
    expect(() => spearman([1, NaN], [1, 2])).toThrow(RangeError);
  });
});

describe("normalCdf", () => {
  it("matches the standard normal distribution", () => {
    expect(Math.abs(normalCdf(1.96) - 0.975)).toBeLessThanOrEqual(1e-5);
    expect(Math.abs(normalCdf(-1.96) - 0.025)).toBeLessThanOrEqual(1e-5);
    expect(normalCdf(0)).toBeCloseTo(0.5, 8);
    expect(normalCdf(1.2) + normalCdf(-1.2)).toBeCloseTo(1, 12);
    expect(normalCdf(8)).toBeCloseTo(1, 12);
    expect(() => normalCdf(NaN)).toThrow(RangeError);
  });
});

describe("lag1RankAutocorrelation", () => {
  const series = (values: number[], start = 0): { index: number; value: number }[] =>
    values.map((value, offset) => ({ index: start + offset, value }));

  it("pairs only index-consecutive points, in any input order", () => {
    const rising = series([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(lag1RankAutocorrelation([...rising].reverse())).toEqual({ r1: 1, pairs: 11 });
    // Two runs of 6 with a gap: 5 + 5 pairs
    const gapped = [...series([1, 2, 3, 4, 5, 6]), ...series([7, 8, 9, 10, 11, 12], 10)];
    expect(lag1RankAutocorrelation(gapped)).toEqual({ r1: 1, pairs: 10 });
  });

  it(`is null below ${MIN_LAG1_PAIRS} pairs and rejects duplicate indexes`, () => {
    expect(lag1RankAutocorrelation(series([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))).toEqual({
      r1: null,
      pairs: 9,
    });
    expect(() =>
      lag1RankAutocorrelation([
        { index: 1, value: 1 },
        { index: 1, value: 2 },
      ])
    ).toThrow(RangeError);
    expect(() => lag1RankAutocorrelation([{ index: 0.5, value: 1 }])).toThrow(RangeError);
  });
});

describe("effectiveSampleSize", () => {
  it("halves n without both autocorrelation estimates", () => {
    expect(effectiveSampleSize(31, null, 0.4)).toBe(15);
    expect(effectiveSampleSize(31, 0.4, null)).toBe(15);
  });

  it("shrinks n by positive lag-1 autocorrelation only, clamped to [min(4, n), n]", () => {
    expect(effectiveSampleSize(100, 0.5, 0.5)).toBe(60);
    expect(effectiveSampleSize(100, -0.5, 0.9)).toBe(100);
    expect(effectiveSampleSize(10, 0.99, 0.99)).toBe(4);
    expect(effectiveSampleSize(3, 0.99, 0.99)).toBe(3);
    expect(() => effectiveSampleSize(-1, 0, 0)).toThrow(RangeError);
  });
});

describe("correlationInterval", () => {
  it("uses the Bonett-Wright standard error on Fisher's z", () => {
    const result = correlationInterval(0.5, 28)!;
    const se = Math.sqrt(1.125 / 25);
    expect(result.low).toBeCloseTo(Math.tanh(Math.atanh(0.5) - 1.959964 * se), 12);
    expect(result.high).toBeCloseTo(Math.tanh(Math.atanh(0.5) + 1.959964 * se), 12);
    expect(result.low).toBeCloseTo(0.1327, 4);
    expect(result.high).toBeCloseTo(0.7465, 4);
    expect(result.p).toBeCloseTo(0.00961, 4);
  });

  it("is symmetric at zero, finite at ±1 and null at nEff <= 3", () => {
    const zero = correlationInterval(0, 10)!;
    expect(zero.low).toBeCloseTo(-zero.high, 12);
    expect(zero.p).toBeCloseTo(1, 6);
    const perfect = correlationInterval(1, 10)!;
    expect(Number.isFinite(perfect.low) && Number.isFinite(perfect.p)).toBe(true);
    expect(correlationInterval(0.9, 3)).toBeNull();
  });

  it("keeps the false-positive rate near 5% on autocorrelated series via nEff", () => {
    const gaussian = (random: () => number): number =>
      Math.sqrt(-2 * Math.log(Math.max(random(), 1e-12))) * Math.cos(2 * Math.PI * random());
    const ar = (random: () => number, n: number, phi: number): number[] => {
      let x = gaussian(random) / Math.sqrt(1 - phi * phi);
      return Array.from({ length: n }, () => (x = phi * x + gaussian(random)));
    };
    const reps = 1000;
    let naive = 0;
    let corrected = 0;
    for (let rep = 0; rep < reps; rep++) {
      const random = createLcg(hashSeed("ar-0.7", rep));
      const xs = ar(random, 30, 0.7);
      const ys = ar(random, 30, 0.7);
      const rho = spearman(xs, ys)!;
      const autocorrelation = (values: number[]): number | null =>
        lag1RankAutocorrelation(values.map((value, index) => ({ index, value }))).r1;
      const nEff = effectiveSampleSize(30, autocorrelation(xs), autocorrelation(ys));
      if (correlationInterval(rho, 30)!.p <= 0.05) naive++;
      const interval = correlationInterval(rho, nEff);
      if (interval && interval.p <= 0.05) corrected++;
    }
    expect(corrected / reps).toBeLessThanOrEqual(0.08);
    expect(naive / reps).toBeGreaterThan(0.12);
  });
});

describe("mannWhitney and cliffsDelta", () => {
  it("computes U and a two-sided normal-approximation p", () => {
    expect(mannWhitney([1, 2, 3], [4, 5, 6])).toEqual({ u: 0, p: expect.closeTo(0.0495, 4) });
    expect(mannWhitney([4, 5, 6], [1, 2, 3])!.u).toBe(9);
    // Ranks [1.5, 1.5, 3.5 | 3.5, 5.5, 5.5]; tie-corrected variance 4.8
    const tied = mannWhitney([1, 1, 2], [2, 3, 3])!;
    expect(tied.u).toBe(0.5);
    expect(tied.p).toBeCloseTo(2 * (1 - normalCdf(4 / Math.sqrt(4.8))), 12);
  });

  it("shrinks z by the effective-sample ratio", () => {
    expect(mannWhitney([1, 2, 3], [4, 5, 6], 0.5)!.p).toBeCloseTo(
      2 * (1 - normalCdf((4.5 / Math.sqrt(5.25)) * Math.SQRT1_2)),
      12
    );
    expect(() => mannWhitney([1], [2], 0)).toThrow(RangeError);
    expect(() => mannWhitney([1], [2], 1.5)).toThrow(RangeError);
  });

  it("is null for empty groups or all-tied values", () => {
    expect(mannWhitney([], [1, 2])).toBeNull();
    expect(mannWhitney([3, 3], [3, 3])).toBeNull();
  });

  it("measures dominance with Cliff's delta", () => {
    expect(cliffsDelta([4, 5, 6], [1, 2, 3])).toBe(1);
    expect(cliffsDelta([1, 2, 3], [4, 5, 6])).toBe(-1);
    expect(cliffsDelta([1, 2], [2, 1])).toBe(0);
    expect(cliffsDelta([2, 3], [1, 3])).toBe(0.25);
    expect(cliffsDelta([], [1])).toBeNull();
  });
});

describe("benjaminiHochberg", () => {
  it("returns monotone step-up q-values in input order", () => {
    const q = benjaminiHochberg([0.01, 0.04, 0.03, 0.2, 0.5]);
    expect(q[0]).toBeCloseTo(0.05, 10);
    expect(q[1]).toBeCloseTo(0.0667, 4);
    expect(q[2]).toBeCloseTo(0.0667, 4);
    expect(q[3]).toBeCloseTo(0.25, 10);
    expect(q[4]).toBeCloseTo(0.5, 10);
  });

  it("caps at 1 and validates p-values", () => {
    expect(benjaminiHochberg([0.9, 0.95])).toEqual([0.95, 0.95]);
    expect(benjaminiHochberg([1, 1, 1])).toEqual([1, 1, 1]);
    expect(benjaminiHochberg([])).toEqual([]);
    expect(() => benjaminiHochberg([1.2])).toThrow(RangeError);
  });
});

describe("robust statistics and percentile rank", () => {
  it("computes the MAD and robust z", () => {
    expect(medianAbsoluteDeviation([1, 2, 3, 4, 100])).toBe(1);
    expect(medianAbsoluteDeviation([])).toBeNull();
    expect(robustZ(10, [1, 2, 3, 4, 100])).toBeCloseTo(7 / 1.4826, 12);
    expect(robustZ(10, [5, 5, 5])).toBeNull();
    expect(robustZ(10, [])).toBeNull();
    expect(() => robustZ(NaN, [1, 2])).toThrow(RangeError);
  });

  it("gives the mid-rank percentile get_baselines reports", () => {
    expect(percentileRank([1, 2, 3, 4], 3)).toBe(62.5);
    expect(percentileRank([5, 5, 5, 5], 5)).toBe(50);
    expect(percentileRank([1, 2], 0)).toBe(0);
    expect(percentileRank([], 1)).toBeNull();
  });
});

describe("daily load series", () => {
  it("averages known values in a trailing window", () => {
    const series = [null, 1, 2, null, 4];
    expect(rollingMean(series, 4, 3, 2)).toEqual({ mean: 3, known: 2 });
    expect(rollingMean(series, 4, 3, 3)).toEqual({ mean: null, known: 2 });
    expect(rollingMean(series, 1, 7, 1)).toEqual({ mean: 1, known: 1 });
    expect(() => rollingMean(series, 5, 3, 1)).toThrow(RangeError);
    expect(() => rollingMean(series, 0, 0, 1)).toThrow(RangeError);
  });

  it("follows the EWMA recurrence, counting unknown days as zero", () => {
    const step = ewmaSeries(Array<number>(42).fill(1), 42);
    expect(Math.abs(step.values[41]! - (1 - (41 / 42) ** 42))).toBeLessThanOrEqual(1e-9);
    expect(ewmaSeries([null, 2], 2)).toEqual({ values: [0, 1], unknown_counted_as_zero: 1 });
    expect(ewmaSeries([300, 300], 7, 300).values).toEqual([300, 300]);
    expect(() => ewmaSeries([1], 0.5)).toThrow(RangeError);
  });

  it("computes Foster monotony and strain with the sample SD", () => {
    const week = fosterWeek([100, 0, 100, 0, 100, 0, 100]);
    expect(week.reason).toBeNull();
    expect(week.monotony).toBeCloseTo(1.069, 3);
    expect(week.strain).toBeCloseTo(427.6, 1);
    expect(fosterWeek([100, null, 100, 0, 100, 0, 100])).toEqual({
      monotony: null,
      strain: null,
      reason: "unknown_days",
    });
    expect(fosterWeek([50, 50, 50, 50, 50, 50, 50]).reason).toBe("identical_daily_loads");
    expect(() => fosterWeek([1, 2, 3])).toThrow(RangeError);
  });
});

describe("buckets, neighbours and clock deltas", () => {
  it("cuts values into quantile groups", () => {
    const cuts = quantileCuts([9, 1, 8, 2, 7, 3, 6, 4, 5], 3)!;
    expect(cuts[0]).toBeCloseTo(11 / 3, 12);
    expect(cuts[1]).toBeCloseTo(19 / 3, 12);
    expect(quantileCuts([], 3)).toBeNull();
    expect(() => quantileCuts([1], 1)).toThrow(RangeError);
  });

  it("takes the median of the k nearest points, ties to the smaller x", () => {
    const points = [
      { x: 10, y: 100 },
      { x: 3, y: 30 },
      { x: 1, y: 10 },
      { x: 2, y: 20 },
    ];
    expect(kNearestMedian(points, 2.5, 2)).toBe(25);
    expect(kNearestMedian(points, 2.5, 1)).toBe(20);
    expect(kNearestMedian(points, 2.5, 10)).toBe(25);
    expect(kNearestMedian([], 1, 3)).toBeNull();
    expect(() => kNearestMedian(points, 1, 0)).toThrow(RangeError);
  });

  it("wraps signed clock differences to (−720, 720]", () => {
    expect(circularSignedDeltaMinutes(23 * 60 + 30, 30)).toBe(-60);
    expect(circularSignedDeltaMinutes(30, 23 * 60 + 30)).toBe(60);
    expect(circularSignedDeltaMinutes(720, 0)).toBe(720);
    expect(circularSignedDeltaMinutes(0, 720)).toBe(720);
    expect(circularSignedDeltaMinutes(-30, 30)).toBe(-60);
    expect(circularSignedDeltaMinutes(100, 100)).toBe(0);
  });
});
