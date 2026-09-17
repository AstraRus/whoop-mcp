/**
 * CSV writing for data exports (RFC 4180).
 *
 * - A cell containing a comma, a double quote, CR or LF is wrapped in double
 *   quotes, and double quotes inside it are doubled.
 * - Records end with "\n"; the header is the first record.
 * - null is an empty cell; booleans are `true` / `false`; finite numbers are
 *   written as JavaScript prints them (a non-finite number is an empty cell).
 * - Formula guard: a text cell starting with =, +, -, @, tab or CR gets a
 *   leading apostrophe, so spreadsheet programs show it as text instead of
 *   evaluating it. Numbers are never guarded (a negative number stays a number).
 */

/** One CSV cell value. */
export type CsvCell = string | number | boolean | null;

/** Text cells starting with one of these characters are prefixed with an apostrophe. */
export const CSV_FORMULA_START = /^[=+\-@\t\r]/;

/** Cells containing one of these characters are quoted. */
const NEEDS_QUOTES = /[",\r\n]/;

/** A text cell with the formula guard applied (no quoting). */
export function guardCsvText(value: string): string {
  return CSV_FORMULA_START.test(value) ? `'${value}` : value;
}

/** One cell as CSV text: formula guard, then RFC 4180 quoting. */
export function formatCsvCell(value: CsvCell): string {
  if (value === null) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  const text = guardCsvText(value);
  return NEEDS_QUOTES.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One record (without its line ending). */
export function formatCsvRow(cells: readonly CsvCell[]): string {
  return cells.map(formatCsvCell).join(",");
}

/** A CSV document: the header record, then one record per row, each ending with "\n". */
export function toCsv(columns: readonly string[], rows: readonly (readonly CsvCell[])[]): string {
  let text = `${formatCsvRow(columns)}\n`;
  for (const row of rows) text += `${formatCsvRow(row)}\n`;
  return text;
}
