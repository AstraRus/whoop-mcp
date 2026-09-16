/**
 * Pure statistical utility functions for analytical tools.
 *
 * All functions operate on number arrays. Empty arrays throw.
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
