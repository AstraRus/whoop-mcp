/**
 * Enhanced date handling for MCP tool inputs.
 *
 * Converts relative date expressions ("today", "last 7 days", etc.)
 * to ISO 8601 start/end pairs. Uses a strict regex allowlist —
 * anything not explicitly supported is rejected.
 *
 * Calendar-day math ("today", "2026-09-13", "this week") runs in the user's
 * UTC offset when one is supplied, so day boundaries match the user's local
 * midnight rather than UTC midnight. Results are always UTC ISO 8601 strings.
 */

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

/** Error thrown when a date expression cannot be parsed */
export class InvalidDateExpression extends Error {
  public override readonly name = "InvalidDateExpression";

  constructor(message: string) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Resolved date range from a date expression */
export interface DateRange {
  start: string;
  end: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of days allowed in "last N days" */
const MAX_LAST_N_DAYS = 365;

/** Regex for ISO 8601 date or date-time strings */
export const ISO_8601_REGEX =
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/;

/** Regex for a trailing UTC designator or offset on a date-time */
const ZONE_SUFFIX_REGEX = /(Z|[+-]\d{2}:\d{2})$/;

/** Regex for a UTC offset ("Z", "+02:00", "-05:30") */
const UTC_OFFSET_REGEX = /^(?:Z|([+-])(\d{2}):(\d{2}))$/;

/** Regex for "last N days" expressions */
const LAST_N_DAYS_REGEX = /^last\s+(\d+)\s+days?$/i;

/** Regex for "last N weeks" expressions */
const LAST_N_WEEKS_REGEX = /^last\s+(\d+)\s+weeks?$/i;

/** Maximum number of weeks allowed in "last N weeks" */
const MAX_LAST_N_WEEKS = 52;

/** Regex for "last N months" expressions */
const LAST_N_MONTHS_REGEX = /^last\s+(\d+)\s+months?$/i;

/** Maximum number of months allowed in "last N months" */
const MAX_LAST_N_MONTHS = 12;

/** Regex for "this quarter" */
const THIS_QUARTER_REGEX = /^this\s+quarter$/i;

/** Regex for "last quarter" */
const LAST_QUARTER_REGEX = /^last\s+quarter$/i;

/** Regex for "last year" */
const LAST_YEAR_REGEX = /^last\s+year$/i;

/** Regex for "YYYY-MM" month literal */
const MONTH_LITERAL_REGEX = /^(\d{4})-(0[1-9]|1[0-2])$/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a UTC offset ("Z", "+02:00", "-05:30") into minutes east of UTC.
 *
 * @throws InvalidDateExpression for malformed offsets
 */
export function parseUtcOffset(offset: string): number {
  const match = offset.match(UTC_OFFSET_REGEX);
  if (!match) {
    throw new InvalidDateExpression(`Invalid UTC offset: "${offset}".`);
  }
  if (!match[1]) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

/**
 * Format the start of a local calendar day as a UTC ISO 8601 string.
 * `date` carries the local wall-clock day in its UTC fields.
 */
function startOfDayUTC(date: Date, offsetMs: number): string {
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - offsetMs
  );
  return d.toISOString();
}

/** Format the end of a local calendar day (23:59:59.999 local) as a UTC ISO 8601 string */
function endOfDayUTC(date: Date, offsetMs: number): string {
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59, 999) -
      offsetMs
  );
  return d.toISOString();
}

/** Get the Monday of the week containing the given date (ISO week) */
function getMondayUTC(date: Date): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay();
  // Sunday (0) → go back 6 days; Monday (1) → stay; etc.
  const diff = day === 0 ? 6 : day - 1;
  d.setUTCDate(d.getUTCDate() - diff);
  return d;
}

/** Get the last day of a given month (handles leap years) */
function lastDayOfMonthUTC(year: number, month: number): Date {
  // month is 0-indexed; day 0 of next month gives last day of current month
  return new Date(Date.UTC(year, month + 1, 0));
}

/**
 * Resolve an ISO 8601 literal. A date-only value covers that whole local day;
 * a date-time without a zone is read as local time; a zoned date-time keeps
 * its instant. WHOOP rejects date-only and zone-less values with a 404, so
 * everything is normalized to a full UTC timestamp.
 */
function resolveIsoLiteral(value: string, offsetMs: number): DateRange {
  const [datePart = "", timePart] = value.split("T");
  const [year = NaN, month = NaN, day = NaN] = datePart.split("-").map(Number);
  const calendarDay = new Date(Date.UTC(year, month - 1, day));
  if (
    calendarDay.getUTCFullYear() !== year ||
    calendarDay.getUTCMonth() !== month - 1 ||
    calendarDay.getUTCDate() !== day
  ) {
    throw new InvalidDateExpression(`Invalid calendar date: "${value}".`);
  }

  if (timePart === undefined) {
    return {
      start: startOfDayUTC(calendarDay, offsetMs),
      end: endOfDayUTC(calendarDay, offsetMs),
    };
  }

  const instant = ZONE_SUFFIX_REGEX.test(timePart)
    ? Date.parse(value)
    : Date.parse(`${value}Z`) - offsetMs;
  if (!Number.isFinite(instant)) {
    throw new InvalidDateExpression(`Invalid date-time: "${value}".`);
  }
  const iso = new Date(instant).toISOString();
  return { start: iso, end: iso };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Resolve a date expression to an ISO 8601 start/end range.
 *
 * Supported expressions (case-insensitive):
 * - ISO 8601 dates (the whole local day) and date-times (normalized to UTC)
 * - "today"
 * - "yesterday"
 * - "last N days" (1 ≤ N ≤ 365)
 * - "last N weeks" (1 ≤ N ≤ 52)
 * - "last N months" (1 ≤ N ≤ 12)
 * - "this week" (Monday to today)
 * - "last week" (previous Monday to Sunday)
 * - "this month" (1st to today)
 * - "last month" (full previous month)
 * - "this quarter" (quarter start to today)
 * - "last quarter" (full previous quarter)
 * - "last year" (full previous calendar year)
 * - "YYYY-MM" (full calendar month)
 *
 * Calendar days are taken in `utcOffset` (the user's offset, e.g. "+02:00");
 * the default "Z" keeps plain UTC days.
 *
 * @throws InvalidDateExpression for unrecognized or invalid expressions
 */
export function resolveDateExpression(
  expression: string,
  now: Date = new Date(),
  utcOffset: string = "Z"
): DateRange {
  const trimmed = expression.trim();
  const offsetMs = parseUtcOffset(utcOffset) * 60_000;
  // The user's local wall-clock time, carried in the UTC fields
  const local = new Date(now.getTime() + offsetMs);

  if (trimmed.length === 0) {
    throw new InvalidDateExpression("Unrecognized date expression: empty string");
  }

  // ISO 8601 date or date-time
  if (ISO_8601_REGEX.test(trimmed)) {
    return resolveIsoLiteral(trimmed, offsetMs);
  }

  const lower = trimmed.toLowerCase();

  // "today"
  if (lower === "today") {
    return { start: startOfDayUTC(local, offsetMs), end: endOfDayUTC(local, offsetMs) };
  }

  // "yesterday"
  if (lower === "yesterday") {
    const yesterday = new Date(
      Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - 1)
    );
    return { start: startOfDayUTC(yesterday, offsetMs), end: endOfDayUTC(yesterday, offsetMs) };
  }

  // "last N days"
  const lastNMatch = lower.match(LAST_N_DAYS_REGEX);
  if (lastNMatch?.[1]) {
    const n = parseInt(lastNMatch[1], 10);
    if (n <= 0) {
      throw new InvalidDateExpression(
        `Invalid day count: ${n}. Must be between 1 and ${MAX_LAST_N_DAYS}.`
      );
    }
    if (n > MAX_LAST_N_DAYS) {
      throw new InvalidDateExpression(`Day count ${n} exceeds maximum of ${MAX_LAST_N_DAYS} days.`);
    }
    const start = new Date(
      Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - n)
    );
    return { start: startOfDayUTC(start, offsetMs), end: endOfDayUTC(local, offsetMs) };
  }

  // "this week"
  if (lower === "this week") {
    const monday = getMondayUTC(local);
    return { start: startOfDayUTC(monday, offsetMs), end: endOfDayUTC(local, offsetMs) };
  }

  // "last week"
  if (lower === "last week") {
    const thisMonday = getMondayUTC(local);
    const lastMonday = new Date(thisMonday);
    lastMonday.setUTCDate(lastMonday.getUTCDate() - 7);
    const lastSunday = new Date(thisMonday);
    lastSunday.setUTCDate(lastSunday.getUTCDate() - 1);
    return { start: startOfDayUTC(lastMonday, offsetMs), end: endOfDayUTC(lastSunday, offsetMs) };
  }

  // "this month"
  if (lower === "this month") {
    const firstOfMonth = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1));
    return { start: startOfDayUTC(firstOfMonth, offsetMs), end: endOfDayUTC(local, offsetMs) };
  }

  // "last month"
  if (lower === "last month") {
    const lastMonthYear =
      local.getUTCMonth() === 0 ? local.getUTCFullYear() - 1 : local.getUTCFullYear();
    const lastMonthMonth = local.getUTCMonth() === 0 ? 11 : local.getUTCMonth() - 1;
    const firstOfLastMonth = new Date(Date.UTC(lastMonthYear, lastMonthMonth, 1));
    const endOfLastMonth = lastDayOfMonthUTC(lastMonthYear, lastMonthMonth);
    return {
      start: startOfDayUTC(firstOfLastMonth, offsetMs),
      end: endOfDayUTC(endOfLastMonth, offsetMs),
    };
  }

  // "last N weeks"
  const lastNWeeksMatch = lower.match(LAST_N_WEEKS_REGEX);
  if (lastNWeeksMatch?.[1]) {
    const n = parseInt(lastNWeeksMatch[1], 10);
    if (n <= 0) {
      throw new InvalidDateExpression(
        `Invalid week count: ${n}. Must be between 1 and ${MAX_LAST_N_WEEKS}.`
      );
    }
    if (n > MAX_LAST_N_WEEKS) {
      throw new InvalidDateExpression(
        `Week count ${n} exceeds maximum of ${MAX_LAST_N_WEEKS} weeks.`
      );
    }
    const start = new Date(
      Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - n * 7)
    );
    return { start: startOfDayUTC(start, offsetMs), end: endOfDayUTC(local, offsetMs) };
  }

  // "last N months"
  const lastNMonthsMatch = lower.match(LAST_N_MONTHS_REGEX);
  if (lastNMonthsMatch?.[1]) {
    const n = parseInt(lastNMonthsMatch[1], 10);
    if (n <= 0) {
      throw new InvalidDateExpression(
        `Invalid month count: ${n}. Must be between 1 and ${MAX_LAST_N_MONTHS}.`
      );
    }
    if (n > MAX_LAST_N_MONTHS) {
      throw new InvalidDateExpression(
        `Month count ${n} exceeds maximum of ${MAX_LAST_N_MONTHS} months.`
      );
    }
    // Subtract N months, clamping to last valid day of target month
    const targetYear = local.getUTCFullYear();
    const targetMonth = local.getUTCMonth() - n;
    const targetDay = local.getUTCDate();
    // Get last day of the target month to clamp
    const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
    const clampedDay = Math.min(targetDay, lastDay);
    const start = new Date(Date.UTC(targetYear, targetMonth, clampedDay));
    return { start: startOfDayUTC(start, offsetMs), end: endOfDayUTC(local, offsetMs) };
  }

  // "this quarter"
  if (THIS_QUARTER_REGEX.test(lower)) {
    const quarterStartMonth = Math.floor(local.getUTCMonth() / 3) * 3;
    const quarterStart = new Date(Date.UTC(local.getUTCFullYear(), quarterStartMonth, 1));
    return { start: startOfDayUTC(quarterStart, offsetMs), end: endOfDayUTC(local, offsetMs) };
  }

  // "last quarter"
  if (LAST_QUARTER_REGEX.test(lower)) {
    const currentQuarter = Math.floor(local.getUTCMonth() / 3);
    let qStartMonth: number;
    let qYear: number;
    if (currentQuarter === 0) {
      // Q1 → last quarter is Q4 of previous year
      qStartMonth = 9; // October
      qYear = local.getUTCFullYear() - 1;
    } else {
      qStartMonth = (currentQuarter - 1) * 3;
      qYear = local.getUTCFullYear();
    }
    const qEndMonth = qStartMonth + 2;
    const quarterStart = new Date(Date.UTC(qYear, qStartMonth, 1));
    const quarterEnd = lastDayOfMonthUTC(qYear, qEndMonth);
    return {
      start: startOfDayUTC(quarterStart, offsetMs),
      end: endOfDayUTC(quarterEnd, offsetMs),
    };
  }

  // "last year"
  if (LAST_YEAR_REGEX.test(lower)) {
    const lastYear = local.getUTCFullYear() - 1;
    const yearStart = new Date(Date.UTC(lastYear, 0, 1));
    const yearEnd = new Date(Date.UTC(lastYear, 11, 31));
    return { start: startOfDayUTC(yearStart, offsetMs), end: endOfDayUTC(yearEnd, offsetMs) };
  }

  // "YYYY-MM" month literal
  const monthLiteralMatch = trimmed.match(MONTH_LITERAL_REGEX);
  if (monthLiteralMatch?.[1] && monthLiteralMatch[2]) {
    const year = parseInt(monthLiteralMatch[1], 10);
    if (year < 2010 || year > 2099) {
      throw new InvalidDateExpression(`Year ${year} is outside supported range (2010-2099).`);
    }
    const month = parseInt(monthLiteralMatch[2], 10) - 1; // 0-indexed
    const monthStart = new Date(Date.UTC(year, month, 1));
    const monthEnd = lastDayOfMonthUTC(year, month);
    return { start: startOfDayUTC(monthStart, offsetMs), end: endOfDayUTC(monthEnd, offsetMs) };
  }

  throw new InvalidDateExpression(
    `Unrecognized date expression: "${trimmed}". ` +
      'Supported: "today", "yesterday", "last N days", "last N weeks", "last N months", ' +
      '"this week", "last week", "this month", "last month", "this quarter", "last quarter", ' +
      '"last year", "YYYY-MM", or an ISO 8601 date (YYYY-MM-DD) or date-time.'
  );
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate that a resolved date range does not exceed maxDays.
 *
 * @param start - ISO 8601 start date
 * @param end - ISO 8601 end date
 * @param maxDays - Maximum allowed span in days (default: 365)
 * @throws InvalidDateExpression if end < start or range exceeds maxDays
 */
export function validateDateRange(start: string, end: string, maxDays: number = 365): void {
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();

  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    throw new InvalidDateExpression(
      `Invalid date string: start="${start}", end="${end}". Expected ISO 8601 format.`
    );
  }

  if (endMs < startMs) {
    throw new InvalidDateExpression(`End date is before start date: ${end} < ${start}`);
  }

  const diffDays = (endMs - startMs) / (1000 * 60 * 60 * 24);
  if (diffDays > maxDays) {
    throw new InvalidDateExpression(
      `Date range of ${Math.ceil(diffDays)} days exceeds maximum of ${maxDays} days.`
    );
  }
}
