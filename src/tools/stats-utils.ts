/**
 * Pure statistical utility functions for analytical tools.
 *
 * The descriptive functions (mean, median, standardDeviation, regression,
 * anomalies) throw on empty arrays. The inferential and load helpers below
 * trendConfidence return null when a statistic is undefined (too few values,
 * zero variance) and throw RangeError for non-finite input.
 * No NaN propagation — edge cases return defined values.
 * No runtime dependencies.
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function assertNonEmpty(values: number[], name: string): void {
  if (values.length === 0) {
    throw new Error(`${name}: cannot operate on an empty array`);
  }
}

export function percentile(values: number[], percent: number): number {
  assertNonEmpty(values, "percentile");
  if (
    !Number.isFinite(percent) ||
    percent < 0 ||
    percent > 100 ||
    values.some((value) => !Number.isFinite(value))
  ) {
    throw new RangeError("Percentile requires finite observations and a percentage from 0 to 100.");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const position = ((sorted.length - 1) * percent) / 100;
  const lower = Math.floor(position);
  return sorted[lower]! + (sorted[Math.ceil(position)]! - sorted[lower]!) * (position - lower);
}

export function circularStats(minutes: number[]): { mean: number | null; sd: number | null } {
  if (!minutes.length) return { mean: null, sd: null };
  if (minutes.some((value) => !Number.isFinite(value)))
    throw new RangeError("Clock times must be finite.");
  const radians = minutes.map((value) => (value * Math.PI) / 720);
  const cosine = mean(radians.map(Math.cos));
  const sine = mean(radians.map(Math.sin));
  const length = Math.min(1, Math.hypot(cosine, sine));
  if (length < 1e-10) return { mean: null, sd: null };
  return {
    mean: ((Math.atan2(sine, cosine) * 720) / Math.PI + 1440) % 1440,
    sd: (Math.sqrt(-2 * Math.log(length)) * 720) / Math.PI,
  };
}

// ---------------------------------------------------------------------------
// Basic statistics
// ---------------------------------------------------------------------------

/**
 * Whether every value is identical (true for a single value).
 * @throws Error if values is empty
 */
export function isConstant(values: number[]): boolean {
  assertNonEmpty(values, "isConstant");
  return values.every((value) => value === values[0]);
}

/**
 * Arithmetic mean. Identical values return that value exactly (summing
 * decimals such as 70.1 would otherwise drift to 70.09999999999998).
 * @throws Error if values is empty
 */
export function mean(values: number[]): number {
  assertNonEmpty(values, "mean");
  if (isConstant(values)) {
    return values[0]!;
  }
  let sum = 0;
  for (const v of values) {
    sum += v;
  }
  return sum / values.length;
}

/**
 * Median — middle value (average of two middle for even-length).
 * Does not mutate the input array.
 * @throws Error if values is empty
 */
export function median(values: number[]): number {
  assertNonEmpty(values, "median");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

/**
 * Population standard deviation.
 * Returns 0 for a single value or constant array.
 * @throws Error if values is empty
 */
export function standardDeviation(values: number[]): number {
  assertNonEmpty(values, "standardDeviation");
  if (isConstant(values)) {
    return 0;
  }
  const avg = mean(values);
  let sumSquaredDiffs = 0;
  for (const v of values) {
    const diff = v - avg;
    sumSquaredDiffs += diff * diff;
  }
  return Math.sqrt(sumSquaredDiffs / values.length);
}

// ---------------------------------------------------------------------------
// Linear regression
// ---------------------------------------------------------------------------

/** Result of linear regression */
export interface LinearRegressionResult {
  /** Slope per unit index */
  slope: number;
  /** R² goodness of fit (0–1) */
  r2: number;
}

/**
 * Simple linear regression on values indexed 0, 1, 2, ...
 *
 * Returns slope (change per index) and R² (coefficient of determination).
 * Single value or constant values return { slope: 0, r2: 0 }.
 *
 * @throws Error if values is empty
 */
export function linearRegression(values: number[]): LinearRegressionResult {
  assertNonEmpty(values, "linearRegression");
  const n = values.length;

  if (n === 1) {
    return { slope: 0, r2: 0 };
  }

  // x = 0, 1, 2, ..., n-1
  // Sum of x = n*(n-1)/2
  // Sum of x² = n*(n-1)*(2n-1)/6
  const sumX = (n * (n - 1)) / 2;
  const sumX2 = (n * (n - 1) * (2 * n - 1)) / 6;

  let sumY = 0;
  let sumXY = 0;
  for (let i = 0; i < n; i++) {
    sumY += values[i]!;
    sumXY += i * values[i]!;
  }

  const denominator = n * sumX2 - sumX * sumX;

  // denominator is 0 only if all x values are identical (impossible with 0..n-1 and n>1)
  // but guard anyway for NaN safety
  if (denominator === 0) {
    return { slope: 0, r2: 0 };
  }

  const slope = (n * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / n;

  // Compute R²
  const yMean = sumY / n;
  let ssTot = 0;
  let ssRes = 0;
  for (let i = 0; i < n; i++) {
    const diff = values[i]! - yMean;
    ssTot += diff * diff;
    const predicted = intercept + slope * i;
    const residual = values[i]! - predicted;
    ssRes += residual * residual;
  }

  // If ssTot is 0 (constant values), R² is undefined — return 0
  const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot;

  return { slope, r2 };
}

/**
 * Fewest data points a trend (direction, slope, confidence) is reported for.
 * Two or three points always fit a line well, so they say nothing about a
 * trend.
 */
export const MIN_TREND_POINTS = 4;

/**
 * Simple linear regression of ys on explicit xs (e.g. days since the first
 * observation), so gaps between observations are respected. Callers must pass
 * xs in chronological order together with their ys.
 *
 * Returns slope (change in y per unit of x) and R². A single point, identical
 * xs or constant ys return { slope: 0, r2: 0 }.
 *
 * @throws Error if the arrays are empty or differ in length
 * @throws RangeError if any value is not finite
 */
export function linearRegressionXY(xs: number[], ys: number[]): LinearRegressionResult {
  assertNonEmpty(ys, "linearRegressionXY");
  if (xs.length !== ys.length) {
    throw new Error("linearRegressionXY: xs and ys must have the same length");
  }
  if ([...xs, ...ys].some((value) => !Number.isFinite(value))) {
    throw new RangeError("linearRegressionXY requires finite values.");
  }
  const n = ys.length;
  const xMean = mean(xs);
  const yMean = mean(ys);
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - xMean;
    const dy = ys[i]! - yMean;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  // Constant ys are checked exactly: rounding in the mean leaves syy tiny but non-zero
  if (n === 1 || sxx === 0 || isConstant(ys)) {
    return { slope: 0, r2: 0 };
  }
  const slope = sxy / sxx;
  const r2 = syy === 0 ? 0 : Math.min(1, (sxy * sxy) / (sxx * syy));
  return { slope, r2 };
}

// ---------------------------------------------------------------------------
// Anomaly detection
// ---------------------------------------------------------------------------

/** A detected anomaly */
export interface Anomaly {
  /** Index in the input array */
  index: number;
  /** The anomalous value */
  value: number;
  /** Number of standard deviations from the mean */
  deviation: number;
}

/**
 * Detect values more than `threshold` standard deviations from the mean.
 *
 * Returns empty array for constant values or single value (stddev=0).
 *
 * @param values - Data points
 * @param threshold - Number of σ for anomaly detection (default: 2)
 * @throws Error if values is empty
 */
export function detectAnomalies(values: number[], threshold: number = 2): Anomaly[] {
  assertNonEmpty(values, "detectAnomalies");

  const avg = mean(values);
  const stdDev = standardDeviation(values);

  // No anomalies possible when stddev is 0 (constant or single value)
  if (stdDev === 0) {
    return [];
  }

  const anomalies: Anomaly[] = [];
  for (let i = 0; i < values.length; i++) {
    const deviation = Math.abs(values[i]! - avg) / stdDev;
    if (deviation > threshold) {
      anomalies.push({ index: i, value: values[i]!, deviation });
    }
  }

  return anomalies;
}

// ---------------------------------------------------------------------------
// Trend direction
// ---------------------------------------------------------------------------

/** Trend direction classification */
export type TrendDirectionResult = "improving" | "declining" | "stable";

/**
 * Classify a trend based on slope and R².
 *
 * R² thresholds:
 * - ≤ 0.4: low confidence → always "stable"
 * - > 0.4: sufficient confidence → use slope sign
 *
 * Near-zero slopes (|slope| < 0.001) are always "stable".
 */
export function trendDirection(slope: number, r2: number): TrendDirectionResult {
  // Low confidence — no meaningful trend
  if (r2 <= 0.4) {
    return "stable";
  }

  // Near-zero slope — stable regardless of R²
  if (Math.abs(slope) < 0.001) {
    return "stable";
  }

  return slope > 0 ? "improving" : "declining";
}

/** Confidence level based on R² and the number of data points */
export type TrendConfidence = "high" | "medium" | "low";

/** Fewer points than this cap trend confidence at "low" */
export const LOW_CONFIDENCE_BELOW = 7;

/** Fewer points than this cap trend confidence at "medium" */
export const MEDIUM_CONFIDENCE_BELOW = 14;

/**
 * Classify R² into a confidence level, capped by how many points there are.
 * Identical values have no variance for R² to explain (it is reported as 0),
 * yet a flat line fits them exactly, so they are rated on sample size alone.
 */
export function trendConfidence(
  r2: number,
  sampleSize: number,
  constant: boolean
): TrendConfidence {
  if (sampleSize < LOW_CONFIDENCE_BELOW) return "low";
  const fit = constant ? 1 : r2;
  const fromFit: TrendConfidence = fit > 0.7 ? "high" : fit > 0.4 ? "medium" : "low";
  if (sampleSize < MEDIUM_CONFIDENCE_BELOW && fromFit === "high") return "medium";
  return fromFit;
}

// ---------------------------------------------------------------------------
// Rounding and validation
// ---------------------------------------------------------------------------

function assertFinite(values: readonly number[], name: string): void {
  if (values.some((value) => !Number.isFinite(value))) {
    throw new RangeError(`${name} requires finite values.`);
  }
}

/**
 * Round to `digits` decimals, half away from zero within floating-point
 * precision (1.005 → 1.01, −2.5 → −3), never returning −0. Null stays null.
 *
 * @throws RangeError for a non-finite value or a digits count outside 0-10
 */
export function roundTo(value: number, digits: number): number;
export function roundTo(value: number | null, digits: number): number | null;
export function roundTo(value: number | null, digits: number): number | null {
  if (value === null) return null;
  if (!Number.isFinite(value)) throw new RangeError("roundTo requires a finite value.");
  if (!Number.isInteger(digits) || digits < 0 || digits > 10) {
    throw new RangeError("roundTo requires 0-10 digits.");
  }
  const factor = 10 ** digits;
  const scaled = value * factor;
  const magnitude = Math.round(Math.abs(scaled) * (1 + Number.EPSILON));
  const rounded = (Math.sign(scaled) * magnitude) / factor;
  return rounded === 0 ? 0 : rounded;
}

// ---------------------------------------------------------------------------
// Dispersion and ranks
// ---------------------------------------------------------------------------

/**
 * Sample standard deviation (n − 1 denominator); null with fewer than 2 values.
 * @throws RangeError for non-finite values
 */
export function sampleStandardDeviation(values: readonly number[]): number | null {
  assertFinite(values, "sampleStandardDeviation");
  if (values.length < 2) return null;
  if (isConstant([...values])) return 0;
  const avg = mean([...values]);
  let sum = 0;
  for (const value of values) sum += (value - avg) ** 2;
  return Math.sqrt(sum / (values.length - 1));
}

/**
 * 1-based ranks in input order; tied values share the average of their ranks
 * ([3, 1, 3, 2] → [3.5, 1, 3.5, 2]).
 * @throws RangeError for non-finite values
 */
export function ranks(values: readonly number[]): number[] {
  assertFinite(values, "ranks");
  const order = values
    .map((value, index) => ({ value, index }))
    .sort((left, right) => left.value - right.value || left.index - right.index);
  const result = new Array<number>(values.length);
  let position = 0;
  while (position < order.length) {
    let end = position;
    while (end + 1 < order.length && order[end + 1]!.value === order[position]!.value) end++;
    const averageRank = (position + end) / 2 + 1;
    for (let k = position; k <= end; k++) result[order[k]!.index] = averageRank;
    position = end + 1;
  }
  return result;
}

function pearson(xs: readonly number[], ys: readonly number[]): number | null {
  const n = xs.length;
  if (n < 2) return null;
  const xMean = xs.reduce((sum, value) => sum + value, 0) / n;
  const yMean = ys.reduce((sum, value) => sum + value, 0) / n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - xMean;
    const dy = ys[i]! - yMean;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  return Math.max(-1, Math.min(1, sxy / Math.sqrt(sxx * syy)));
}

/**
 * Spearman rank correlation (Pearson correlation of average ranks). Null with
 * fewer than 2 pairs or when either side has zero variance.
 * @throws Error when the arrays differ in length; RangeError for non-finite values
 */
export function spearman(xs: readonly number[], ys: readonly number[]): number | null {
  if (xs.length !== ys.length) throw new Error("spearman: xs and ys must have the same length");
  const xRanks = ranks(xs);
  const yRanks = ranks(ys);
  return pearson(xRanks, yRanks);
}

/**
 * Standard normal cumulative distribution Φ(x), via the Abramowitz & Stegun
 * 7.1.26 approximation of erf (absolute error below 1.5e-7).
 * @throws RangeError for a non-finite x
 */
export function normalCdf(x: number): number {
  if (!Number.isFinite(x)) throw new RangeError("normalCdf requires a finite value.");
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const polynomial =
    t *
    (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - polynomial * Math.exp(-z * z);
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

// ---------------------------------------------------------------------------
// Autocorrelation-aware correlation
// ---------------------------------------------------------------------------

/** Fewest index-consecutive pairs a lag-1 autocorrelation is estimated from */
export const MIN_LAG1_PAIRS = 10;

/**
 * Lag-1 Spearman autocorrelation over pairs whose indexes are consecutive
 * (index and index + 1, e.g. consecutive days); gaps break pairs. r1 is null
 * below MIN_LAG1_PAIRS pairs or without variance.
 * @throws RangeError for duplicate or non-integer indexes or non-finite values
 */
export function lag1RankAutocorrelation(points: readonly { index: number; value: number }[]): {
  r1: number | null;
  pairs: number;
} {
  assertFinite(
    points.map((point) => point.value),
    "lag1RankAutocorrelation"
  );
  const sorted = [...points].sort((left, right) => left.index - right.index);
  const firsts: number[] = [];
  const seconds: number[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const point = sorted[i]!;
    if (!Number.isInteger(point.index)) {
      throw new RangeError("lag1RankAutocorrelation requires integer indexes.");
    }
    const next = sorted[i + 1];
    if (!next) break;
    if (next.index === point.index) {
      throw new RangeError("lag1RankAutocorrelation requires unique indexes.");
    }
    if (next.index === point.index + 1) {
      firsts.push(point.value);
      seconds.push(next.value);
    }
  }
  const pairs = firsts.length;
  return { r1: pairs < MIN_LAG1_PAIRS ? null : spearman(firsts, seconds), pairs };
}

/**
 * Effective sample size of a correlation between two autocorrelated series
 * (AR(1) correction). Without both lag-1 estimates it is floor(n / 2);
 * otherwise ρ = max(0, r1x)·max(0, r1y) and floor(n(1 − ρ)/(1 + ρ)) is
 * clamped to [min(4, n), n].
 * @throws RangeError for a negative or non-integer n or a non-finite r1
 */
export function effectiveSampleSize(n: number, r1x: number | null, r1y: number | null): number {
  if (!Number.isInteger(n) || n < 0) throw new RangeError("effectiveSampleSize requires n >= 0.");
  if (r1x === null || r1y === null) return Math.floor(n / 2);
  assertFinite([r1x, r1y], "effectiveSampleSize");
  const rho = Math.max(0, r1x) * Math.max(0, r1y);
  const raw = Math.floor((n * (1 - rho)) / (1 + rho));
  return Math.min(n, Math.max(Math.min(4, n), raw));
}

/** z value of the two-sided 95% normal interval */
export const Z_95 = 1.959964;

/**
 * 95% confidence interval and two-sided p for a Spearman correlation, using
 * the Bonett-Wright standard error sqrt((1 + rho²/2)/(nEff − 3)) on Fisher's
 * z scale. Null when nEff <= 3.
 * @throws RangeError for non-finite input
 */
export function correlationInterval(
  rho: number,
  nEff: number
): { low: number; high: number; p: number } | null {
  assertFinite([rho, nEff], "correlationInterval");
  if (nEff <= 3) return null;
  const se = Math.sqrt((1 + (rho * rho) / 2) / (nEff - 3));
  const z = Math.atanh(Math.max(-0.999999, Math.min(0.999999, rho)));
  return {
    low: Math.tanh(z - Z_95 * se),
    high: Math.tanh(z + Z_95 * se),
    p: Math.min(1, Math.max(0, 2 * (1 - normalCdf(Math.abs(z) / se)))),
  };
}

/**
 * Mann-Whitney U test of `a` against `b` (U counts pairs where a > b, ties
 * half) with the tie-corrected normal approximation. The z statistic is
 * scaled by sqrt(nEffRatio) to account for autocorrelation. Null when either
 * group is empty or every value is tied.
 * @throws RangeError for non-finite values or a ratio outside (0, 1]
 */
export function mannWhitney(
  a: readonly number[],
  b: readonly number[],
  nEffRatio = 1
): { u: number; p: number } | null {
  assertFinite([...a, ...b], "mannWhitney");
  if (!Number.isFinite(nEffRatio) || nEffRatio <= 0 || nEffRatio > 1) {
    throw new RangeError("mannWhitney requires an effective-sample ratio in (0, 1].");
  }
  const na = a.length;
  const nb = b.length;
  if (na === 0 || nb === 0) return null;
  const combined = ranks([...a, ...b]);
  const rankSumA = combined.slice(0, na).reduce((sum, value) => sum + value, 0);
  const u = rankSumA - (na * (na + 1)) / 2;
  const total = na + nb;
  const counts = new Map<number, number>();
  for (const value of [...a, ...b]) counts.set(value, (counts.get(value) ?? 0) + 1);
  let tieTerm = 0;
  for (const count of counts.values()) tieTerm += count ** 3 - count;
  const variance = ((na * nb) / 12) * (total + 1 - tieTerm / (total * (total - 1)));
  if (!(variance > 0)) return null;
  const z = ((u - (na * nb) / 2) / Math.sqrt(variance)) * Math.sqrt(nEffRatio);
  return { u, p: Math.min(1, Math.max(0, 2 * (1 - normalCdf(Math.abs(z))))) };
}

/**
 * Cliff's delta: (pairs with a > b − pairs with a < b) / (|a|·|b|), in [−1, 1].
 * Null when either group is empty.
 * @throws RangeError for non-finite values
 */
export function cliffsDelta(a: readonly number[], b: readonly number[]): number | null {
  assertFinite([...a, ...b], "cliffsDelta");
  if (a.length === 0 || b.length === 0) return null;
  let greater = 0;
  let less = 0;
  for (const x of a) {
    for (const y of b) {
      if (x > y) greater++;
      else if (x < y) less++;
    }
  }
  return (greater - less) / (a.length * b.length);
}

/**
 * Benjamini-Hochberg q-values (step-up, monotone, capped at 1), in input order.
 * @throws RangeError for p-values outside [0, 1]
 */
export function benjaminiHochberg(pValues: readonly number[]): number[] {
  if (pValues.some((p) => !Number.isFinite(p) || p < 0 || p > 1)) {
    throw new RangeError("benjaminiHochberg requires p-values from 0 to 1.");
  }
  const m = pValues.length;
  const order = pValues
    .map((p, index) => ({ p, index }))
    .sort((left, right) => left.p - right.p || left.index - right.index);
  const q = new Array<number>(m);
  let running = 1;
  for (let rank = m; rank >= 1; rank--) {
    const item = order[rank - 1]!;
    running = Math.min(running, (item.p * m) / rank);
    q[item.index] = running;
  }
  return q;
}

// ---------------------------------------------------------------------------
// Robust location and personal percentiles
// ---------------------------------------------------------------------------

/**
 * Median absolute deviation from the median (unscaled); null when empty.
 * @throws RangeError for non-finite values
 */
export function medianAbsoluteDeviation(values: readonly number[]): number | null {
  assertFinite(values, "medianAbsoluteDeviation");
  if (values.length === 0) return null;
  const center = median([...values]);
  return median(values.map((value) => Math.abs(value - center)));
}

/** Scale that makes the MAD a consistent estimator of a normal SD */
export const MAD_SCALE = 1.4826;

/**
 * Robust z-score of `x` against a reference: (x − median) / (1.4826·MAD).
 * Null when the reference is empty or its MAD is 0.
 * @throws RangeError for non-finite values
 */
export function robustZ(x: number, reference: readonly number[]): number | null {
  assertFinite([x, ...reference], "robustZ");
  const mad = medianAbsoluteDeviation(reference);
  if (mad === null || mad === 0) return null;
  return (x - median([...reference])) / (MAD_SCALE * mad);
}

/**
 * Mid-rank percentile of `value` within `values`: the share below plus half
 * the share equal, in percent (get_baselines latest_percentile). Null when
 * `values` is empty.
 * @throws RangeError for non-finite values
 */
export function percentileRank(values: readonly number[], value: number): number | null {
  assertFinite([value, ...values], "percentileRank");
  if (values.length === 0) return null;
  return (
    (100 *
      (values.filter((item) => item < value).length +
        0.5 * values.filter((item) => item === value).length)) /
    values.length
  );
}

// ---------------------------------------------------------------------------
// Daily load series
// ---------------------------------------------------------------------------

/**
 * Mean of the known values among the `window` entries ending at `endIndex`
 * (entries before index 0 count as unknown). Null below `minKnown` known values.
 * @throws RangeError for invalid window arguments or non-finite values
 */
export function rollingMean(
  series: readonly (number | null)[],
  endIndex: number,
  window: number,
  minKnown: number
): { mean: number | null; known: number } {
  if (
    !Number.isInteger(endIndex) ||
    endIndex < 0 ||
    endIndex >= series.length ||
    !Number.isInteger(window) ||
    window < 1 ||
    !Number.isInteger(minKnown) ||
    minKnown < 1
  ) {
    throw new RangeError("rollingMean requires an index in the series and a positive window.");
  }
  const known: number[] = [];
  for (let index = Math.max(0, endIndex - window + 1); index <= endIndex; index++) {
    const value = series[index];
    if (value !== null && value !== undefined) known.push(value);
  }
  assertFinite(known, "rollingMean");
  if (known.length < minKnown) return { mean: null, known: known.length };
  return { mean: known.reduce((sum, value) => sum + value, 0) / known.length, known: known.length };
}

/**
 * Exponentially weighted moving average of daily loads starting from `seed`:
 * x_t = x_{t−1} + (load_t − x_{t−1}) / tau. Unknown (null) loads count as 0
 * and are counted in `unknown_counted_as_zero`.
 * @throws RangeError for tau < 1 or non-finite values
 */
export function ewmaSeries(
  series: readonly (number | null)[],
  tau: number,
  seed = 0
): { values: number[]; unknown_counted_as_zero: number } {
  if (!Number.isFinite(tau) || tau < 1) throw new RangeError("ewmaSeries requires tau >= 1.");
  assertFinite([seed, ...series.filter((load): load is number => load !== null)], "ewmaSeries");
  const values: number[] = [];
  let unknown = 0;
  let current = seed;
  for (const load of series) {
    if (load === null) unknown++;
    current = current + ((load ?? 0) - current) / tau;
    values.push(current);
  }
  return { values, unknown_counted_as_zero: unknown };
}

/**
 * Foster monotony (mean / sample SD of the 7 daily loads) and strain (weekly
 * total × monotony). Null with a reason when a day is unknown or every day
 * has the same load (SD 0).
 * @throws RangeError unless given exactly 7 loads; for non-finite loads
 */
export function fosterWeek(loads: readonly (number | null)[]): {
  monotony: number | null;
  strain: number | null;
  reason: null | "unknown_days" | "identical_daily_loads";
} {
  if (loads.length !== 7) throw new RangeError("fosterWeek requires exactly 7 daily loads.");
  const known = loads.filter((load): load is number => load !== null);
  assertFinite(known, "fosterWeek");
  if (known.length < 7) return { monotony: null, strain: null, reason: "unknown_days" };
  const sd = sampleStandardDeviation(known) ?? 0;
  if (sd === 0) return { monotony: null, strain: null, reason: "identical_daily_loads" };
  const total = known.reduce((sum, load) => sum + load, 0);
  const monotony = total / 7 / sd;
  return { monotony, strain: total * monotony, reason: null };
}

// ---------------------------------------------------------------------------
// Buckets and nearest neighbours
// ---------------------------------------------------------------------------

/**
 * The k − 1 cut points splitting `values` into k quantile groups (linear
 * interpolation, as percentile()). Null when `values` is empty.
 * @throws RangeError for k < 2 or non-finite values
 */
export function quantileCuts(values: readonly number[], k: number): number[] | null {
  if (!Number.isInteger(k) || k < 2) throw new RangeError("quantileCuts requires k >= 2.");
  assertFinite(values, "quantileCuts");
  if (values.length === 0) return null;
  const cuts: number[] = [];
  for (let i = 1; i < k; i++) cuts.push(percentile([...values], (100 * i) / k));
  return cuts;
}

/**
 * Median y of the k points nearest to `x` (ties in distance go to the smaller
 * x, then the smaller y). Uses every point when k exceeds their number; null
 * without points.
 * @throws RangeError for k < 1 or non-finite values
 */
export function kNearestMedian(
  points: readonly { x: number; y: number }[],
  x: number,
  k: number
): number | null {
  if (!Number.isInteger(k) || k < 1) throw new RangeError("kNearestMedian requires k >= 1.");
  assertFinite([x, ...points.flatMap((point) => [point.x, point.y])], "kNearestMedian");
  if (points.length === 0) return null;
  const nearest = [...points]
    .sort(
      (left, right) =>
        Math.abs(left.x - x) - Math.abs(right.x - x) || left.x - right.x || left.y - right.y
    )
    .slice(0, k);
  return median(nearest.map((point) => point.y));
}

/**
 * Signed difference a − b between two clock times in minutes, wrapped to
 * (−720, 720] (23:30 − 00:30 is −60).
 * @throws RangeError for non-finite values
 */
export function circularSignedDeltaMinutes(a: number, b: number): number {
  assertFinite([a, b], "circularSignedDeltaMinutes");
  const delta = (((a - b) % 1440) + 1440) % 1440;
  return delta > 720 ? delta - 1440 : delta;
}
