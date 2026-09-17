/**
 * Tests for the RFC 4180 CSV writer used by export_health_data (package P5):
 * quoting, doubled quotes, line endings, null and boolean cells, and the
 * spreadsheet formula guard (text only, never numbers).
 */

import { describe, expect, it } from "vitest";
import {
  CSV_FORMULA_START,
  formatCsvCell,
  formatCsvRow,
  guardCsvText,
  toCsv,
  type CsvCell,
} from "../../src/tools/csv.js";

/** A strict RFC 4180 reader for round trips (records end with "\n"). */
function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let cell = "";
  let quoted = false;
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      cell += char;
      index += 1;
      continue;
    }
    if (char === '"' && cell === "") {
      quoted = true;
    } else if (char === ",") {
      record.push(cell);
      cell = "";
    } else if (char === "\n") {
      record.push(cell);
      records.push(record);
      record = [];
      cell = "";
    } else {
      cell += char;
    }
    index += 1;
  }
  if (cell !== "" || record.length > 0) throw new Error("CSV text must end with a line ending");
  return records;
}

describe("formatCsvCell", () => {
  it("writes null as an empty cell and booleans as true/false", () => {
    expect(formatCsvCell(null)).toBe("");
    expect(formatCsvCell(true)).toBe("true");
    expect(formatCsvCell(false)).toBe("false");
  });

  it("writes finite numbers as JavaScript prints them and never guards them", () => {
    expect(formatCsvCell(0)).toBe("0");
    expect(formatCsvCell(15.88)).toBe("15.88");
    expect(formatCsvCell(-1.3)).toBe("-1.3");
    expect(formatCsvCell(-0)).toBe("0");
    expect(formatCsvCell(Number.NaN)).toBe("");
    expect(formatCsvCell(Number.POSITIVE_INFINITY)).toBe("");
  });

  it("leaves plain text unquoted", () => {
    expect(formatCsvCell("walking")).toBe("walking");
    expect(formatCsvCell("2026-09-15T00:39:27.317+02:00")).toBe("2026-09-15T00:39:27.317+02:00");
    expect(formatCsvCell("")).toBe("");
  });

  it("quotes cells containing a comma, a double quote, CR or LF and doubles the quotes", () => {
    expect(formatCsvCell("a,b")).toBe('"a,b"');
    expect(formatCsvCell('say "hi"')).toBe('"say ""hi"""');
    expect(formatCsvCell("line\nbreak")).toBe('"line\nbreak"');
    expect(formatCsvCell("carriage\rreturn")).toBe('"carriage\rreturn"');
    expect(formatCsvCell('"')).toBe('""""');
  });

  it("guards text starting with =, +, -, @, tab or CR with a leading apostrophe", () => {
    expect(formatCsvCell("=SUM(A1:A2)")).toBe("'=SUM(A1:A2)");
    // A cell that is exactly a UTC offset is left as it is ...
    expect(formatCsvCell("+02:00")).toBe("+02:00");
    expect(formatCsvCell("-05:00")).toBe("-05:00");
    expect(formatCsvCell("+00:00")).toBe("+00:00");
    // ... but anything more than a bare offset is still guarded.
    expect(formatCsvCell("+02:00x")).toBe("'+02:00x");
    expect(formatCsvCell("+2:00")).toBe("'+2:00");
    expect(formatCsvCell("-05:00,=1")).toBe('"\'-05:00,=1"');
    expect(formatCsvCell("+1+1")).toBe("'+1+1");
    expect(formatCsvCell("+02:00\n=1")).toBe('"\'+02:00\n=1"');
    expect(formatCsvCell("+02:00\n")).toBe('"\'+02:00\n"');
    expect(formatCsvCell(" +02:00")).toBe(" +02:00");
    expect(formatCsvCell("@cmd")).toBe("'@cmd");
    expect(formatCsvCell("\tindent")).toBe("'\tindent");
    expect(formatCsvCell("\rstart")).toBe('"\'\rstart"');
    // Not at the start: no guard.
    expect(formatCsvCell("a=b")).toBe("a=b");
    expect(formatCsvCell(" =b")).toBe(" =b");
  });

  it("applies the guard before quoting", () => {
    expect(formatCsvCell('=HYPERLINK("x","y")')).toBe('"\'=HYPERLINK(""x"",""y"")"');
    expect(formatCsvCell("-1,2")).toBe('"\'-1,2"');
  });
});

describe("guardCsvText", () => {
  it("matches exactly the six formula starters", () => {
    for (const start of ["=", "+", "-", "@", "\t", "\r"]) {
      expect(CSV_FORMULA_START.test(`${start}x`)).toBe(true);
      expect(guardCsvText(`${start}x`)).toBe(`'${start}x`);
    }
    for (const start of ["a", "1", " ", "'", '"', "\n", "#"]) {
      expect(guardCsvText(`${start}x`)).toBe(`${start}x`);
    }
  });
});

describe("toCsv", () => {
  it("writes a header record and one record per row, each ending with \\n", () => {
    const text = toCsv(
      ["id", "name", "value", "flag"],
      [
        ["1", "walking", 3.1, true],
        ["2", null, null, false],
      ]
    );
    expect(text).toBe("id,name,value,flag\n1,walking,3.1,true\n2,,,false\n");
    expect(text).not.toContain("\r\n");
  });

  it("writes only the header for no rows", () => {
    expect(toCsv(["a", "b"], [])).toBe("a,b\n");
  });

  it("round-trips hostile text through an RFC 4180 reader", () => {
    const hostile = [
      'quote " inside',
      "comma, inside",
      "multi\nline\r\ntext",
      "=1+1",
      "@SUM(1)",
      "-2",
      "+3",
      "\tTab",
      "plain",
    ];
    const rows: CsvCell[][] = hostile.map((value, index) => [index, value, null, index % 2 === 0]);
    const parsed = parseCsv(toCsv(["n", "text", "empty", "even"], rows));
    expect(parsed[0]).toEqual(["n", "text", "empty", "even"]);
    expect(parsed).toHaveLength(hostile.length + 1);
    hostile.forEach((value, index) => {
      const record = parsed[index + 1]!;
      expect(record).toHaveLength(4);
      expect(record[0]).toBe(String(index));
      const expected = CSV_FORMULA_START.test(value) ? `'${value}` : value;
      expect(record[1]).toBe(expected);
      expect(record[2]).toBe("");
      expect(record[3]).toBe(index % 2 === 0 ? "true" : "false");
    });
  });

  it("formats a row the same way as its cells", () => {
    const cells: CsvCell[] = ["a,b", 1, null, true, "=x"];
    expect(formatCsvRow(cells)).toBe(cells.map(formatCsvCell).join(","));
  });
});
