/**
 * Tests for export_health_data (package P5).
 *
 * Covers window resolution (defaults, days, date-times, range expressions,
 * clamping, the 180-day limit), the live-shaped account in CSV and JSON,
 * identical CSV and JSON values on a sentinel fixture with hostile text, parity
 * of the daily rows with get_calendar on a 30-day mature user (including an
 * empty day with blank cells), a failed workout stream, truncated history, the
 * 60,000-character cap with first_included_day and its note, output size and
 * request accounting on stressUser, a −05:00 clone, an after-midnight workout
 * on the last day at a 30-day history chunk boundary, naps with a negative
 * nap need, neutral wording and the MCP contract in both privacy modes.
 */

import { describe, expect, it } from "vitest";
import { WhoopApiError } from "../../src/api/client.js";
import {
  DEFAULT_PAGE_BUDGET,
  HISTORY_CHUNK_MS,
  HISTORY_LIMITATIONS,
} from "../../src/api/history.js";
import type { Sleep, Workout } from "../../src/api/types.js";
import { localDay } from "../../src/tools/analytics-utils.js";
import { guardCsvText, type CsvCell } from "../../src/tools/csv.js";
import { InvalidDateExpression } from "../../src/tools/date-utils.js";
import { addDays, daysBetween } from "../../src/tools/day-model.js";
import {
  capBundles,
  DAILY_COLUMNS,
  EXPORT_HEALTH_DATA_TOOL,
  EXPORT_MAX_CHARS,
  EXPORT_MAX_DAYS,
  EXPORT_METHOD_VERSION,
  exportHealthData,
  exportHealthDataOutputSchema,
  resolveExportWindow,
  SLEEP_COLUMNS,
  WORKOUT_COLUMNS,
  type ExportHealthDataInput,
  type ExportHealthDataResult,
} from "../../src/tools/export-health-data.js";
import { getCalendar } from "../../src/tools/get-calendar.js";
import { roundTo } from "../../src/tools/stats-utils.js";
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
  offsetMinutes,
  stressUser,
  type WhoopUserFixture,
} from "../helpers/whoop-users.js";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const IDS = LIVE_SHAPED_IDS;

type Row = Record<string, CsvCell>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clientFor(
  user: WhoopUserFixture,
  options: Partial<WhoopFixtureClientOptions> = {}
): WhoopFixtureClient {
  return createWhoopFixtureClient({
    cycles: user.cycles,
    sleeps: user.sleeps,
    recoveries: user.recoveries,
    workouts: user.workouts,
    profile: user.profile,
    body: user.body,
    now: user.now,
    ...options,
  });
}

function contextFor(client: WhoopFixtureClient, now: Date): ToolContext {
  return { client, privacyMode: "standard", now: () => now, startedAtMs: Date.now() };
}

async function runExport(
  user: WhoopUserFixture,
  args: ExportHealthDataInput,
  client: WhoopFixtureClient = clientFor(user)
): Promise<ExportHealthDataResult> {
  const result = await exportHealthData(args, contextFor(client, user.now));
  return exportHealthDataOutputSchema.parse(result);
}

/** A strict RFC 4180 reader (records end with "\n"). */
function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"' && cell === "") {
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
  }
  if (cell !== "" || record.length > 0) throw new Error("unterminated CSV record");
  return records;
}

/** CSV records as objects keyed by the header. */
function csvRows(csv: string | undefined): Array<Record<string, string>> {
  const [header, ...records] = parseCsv(csv ?? "");
  return records.map((record) => {
    expect(record).toHaveLength(header!.length);
    return Object.fromEntries(header!.map((column, index) => [column, record[index]!]));
  });
}

/** How a JSON cell must appear in CSV after parsing. */
function csvText(value: CsvCell): string {
  if (value === null) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  return guardCsvText(value);
}

function jsonRows(result: ExportHealthDataResult, name: "daily" | "workouts" | "sleeps"): Row[] {
  const rows = result.datasets[name]?.rows;
  if (!rows) throw new Error(`no ${name} rows`);
  return rows;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** The same account in another offset, local wall-clock times unchanged, optionally moved. */
function atOffset(user: WhoopUserFixture, offset: string, extraMs = 0): WhoopUserFixture {
  const deltaMs = (offsetMinutes(user.offset) - offsetMinutes(offset)) * MINUTE_MS + extraMs;
  const shift = (value: string): string => iso(Date.parse(value) + deltaMs);
  return {
    ...user,
    now: new Date(user.now.getTime() + deltaMs),
    offset,
    cycles: user.cycles.map((cycle) => ({
      ...cycle,
      created_at: shift(cycle.created_at),
      updated_at: shift(cycle.updated_at),
      start: shift(cycle.start),
      end: cycle.end === null || cycle.end === undefined ? cycle.end : shift(cycle.end),
      timezone_offset: offset,
    })),
    sleeps: user.sleeps.map((sleep) => ({
      ...sleep,
      created_at: shift(sleep.created_at),
      updated_at: shift(sleep.updated_at),
      start: shift(sleep.start),
      end: shift(sleep.end),
      timezone_offset: offset,
    })),
    recoveries: user.recoveries.map((recovery) => ({
      ...recovery,
      created_at: shift(recovery.created_at),
      updated_at: shift(recovery.updated_at),
    })),
    workouts: user.workouts.map((workout) => ({
      ...workout,
      created_at: shift(workout.created_at),
      updated_at: shift(workout.updated_at),
      start: shift(workout.start),
      end: shift(workout.end),
      timezone_offset: offset,
    })),
  };
}

function lateWalk(template: Workout, id: string, startMs: number, minutes: number): Workout {
  const duration = minutes * MINUTE_MS;
  const one = Math.round(duration * 0.7);
  return {
    ...structuredClone(template),
    id,
    start: iso(startMs),
    end: iso(startMs + duration),
    created_at: iso(startMs + duration + 90_000),
    updated_at: iso(startMs + duration + 93_000),
    score: {
      ...structuredClone(template.score!),
      percent_recorded: 1,
      zone_durations: {
        zone_zero_milli: duration - one,
        zone_one_milli: one,
        zone_two_milli: 0,
        zone_three_milli: 0,
        zone_four_milli: 0,
        zone_five_milli: 0,
      },
    },
  };
}

function allText(result: ExportHealthDataResult): string[] {
  return [...result.notes, ...result.warnings];
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

describe("resolveExportWindow", () => {
  const now = new Date("2026-09-16T23:30:00+02:00");
  const offset = "+02:00";
  const window = (params: { start?: string; end?: string }): [string, string, number] => {
    const resolved = resolveExportWindow(params, now, offset);
    return [resolved.firstDay, resolved.lastDay, resolved.days];
  };

  it("defaults to the last 30 local days including today", () => {
    expect(window({})).toEqual(["2026-08-18", "2026-09-16", 30]);
    expect(window({ end: "2026-09-10" })).toEqual(["2026-08-12", "2026-09-10", 30]);
  });

  it("runs from a start day or date-time through end or today", () => {
    expect(window({ start: "2026-09-01" })).toEqual(["2026-09-01", "2026-09-16", 16]);
    expect(window({ start: "yesterday" })).toEqual(["2026-09-15", "2026-09-16", 2]);
    expect(window({ start: "2026-09-01", end: "2026-09-10" })).toEqual([
      "2026-09-01",
      "2026-09-10",
      10,
    ]);
    const fromDateTime = resolveExportWindow({ start: "2026-09-01T20:00:00+02:00" }, now, offset);
    expect([fromDateTime.firstDay, fromDateTime.lastDay]).toEqual(["2026-09-02", "2026-09-16"]);
    expect(fromDateTime.notes).toEqual([
      "The start date-time counts from its nearest local midnight (2026-09-02).",
    ]);
  });

  it("covers a start range expression and clamps the end to today", () => {
    expect(window({ start: "last week" })).toEqual(["2026-09-07", "2026-09-13", 7]);
    expect(window({ start: "2026-08" })).toEqual(["2026-08-01", "2026-08-31", 31]);
    expect(window({ start: "this month" })).toEqual(["2026-09-01", "2026-09-16", 16]);
    expect(window({ start: "last 60 days" })).toEqual(["2026-07-18", "2026-09-16", 61]);
    const clamped = resolveExportWindow({ start: "2026-09-01", end: "2026-09-30" }, now, offset);
    expect([clamped.firstDay, clamped.lastDay]).toEqual(["2026-09-01", "2026-09-16"]);
    expect(clamped.notes).toEqual([
      "The end 2026-09-30 is after today, so the export ends today (2026-09-16).",
    ]);
  });

  it("allows 180 days and rejects more, asking to split", () => {
    expect(window({ start: addDays("2026-09-16", -179) })[2]).toBe(EXPORT_MAX_DAYS);
    expect(() => window({ start: addDays("2026-09-16", -180) })).toThrow(InvalidDateExpression);
    expect(() => window({ start: "2026-01-01" })).toThrow(
      "2026-01-01 to 2026-09-16 covers 259 days; export_health_data exports at most 180 days per call. Split the range into parts of up to 180 days, e.g. start 2026-01-01 with end 2026-06-29, then start 2026-06-30."
    );
    expect(() => window({ start: "last year" })).toThrow(/at most 180 days/);
  });

  it("rejects a start after today, an end before the start and unparseable values", () => {
    expect(() => window({ start: "2026-09-17" })).toThrow(
      "The start 2026-09-17 is after today (2026-09-16); there are no days to export."
    );
    expect(() => window({ start: "2026-09-10", end: "2026-09-01" })).toThrow(
      "The end (2026-09-01) is before the start (2026-09-10). Swap them or widen the range."
    );
    expect(() => window({ start: "someday" })).toThrow(InvalidDateExpression);
    expect(() => window({ end: "soon" })).toThrow(InvalidDateExpression);
  });
});

// ---------------------------------------------------------------------------
// Live-shaped account
// ---------------------------------------------------------------------------

describe("export_health_data on the live-shaped account", () => {
  it("exports daily and workouts as CSV by default", async () => {
    const user = liveShapedUser();
    const result = await runExport(user, {});

    expect(result.period).toEqual({
      start: "2026-08-18",
      end: "2026-09-16",
      utc_offset: "+02:00",
      days: 30,
    });
    expect(result.format).toBe("csv");
    expect(Object.keys(result.datasets)).toEqual(["daily", "workouts"]);
    expect(result.first_included_day).toBe("2026-08-18");
    expect(result.output_capped).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.warnings).toEqual([]);

    const daily = result.datasets.daily!;
    expect(daily.columns).toEqual([...DAILY_COLUMNS]);
    expect(daily.rows).toBeUndefined();
    expect(daily.row_count).toBe(30);
    const rows = csvRows(daily.csv);
    expect(rows.map((row) => row.date)).toEqual(
      Array.from({ length: 30 }, (_, index) => addDays("2026-08-18", index))
    );

    // An empty day has blank cells after date and utc_offset (the offset is formula-guarded).
    const empty = rows.find((row) => row.date === "2026-09-13")!;
    expect(empty.utc_offset).toBe("'+02:00");
    expect(
      DAILY_COLUMNS.slice(2).every((column) => empty[column] === ""),
      JSON.stringify(empty)
    ).toBe(true);

    expect(rows.find((row) => row.date === "2026-09-14")).toMatchObject({
      cycle_id: String(IDS.cycles.firstDay),
      cycle_start_local: "2026-09-14T00:00:00.000+02:00",
      day_strain: "9.42",
      day_strain_in_progress: "false",
      day_strain_partial: "true",
      recovery_score: "",
      sleep_id: "",
      nap_count: "0",
      workout_count: "1",
    });
    expect(rows.find((row) => row.date === "2026-09-15")).toMatchObject({
      cycle_start_local: "2026-09-15T00:39:27.317+02:00",
      cycle_end_local: "2026-09-15T23:13:31.460+02:00",
      day_strain: "15.88",
      energy_kj: "13602",
      recovery_score: "58",
      recovery_calibrating: "true",
      hrv_rmssd_ms: "71.4",
      spo2_pct: "96.3",
      sleep_id: IDS.sleeps.first,
      sleep_score_state: "SCORED",
      asleep_h: "6.15",
      sleep_consistency_pct: "",
      sleep_performance_pct: "71",
      workout_count: "4",
    });
    expect(rows.find((row) => row.date === "2026-09-16")).toMatchObject({
      cycle_end_local: "",
      day_strain_in_progress: "true",
      recovery_score: "67",
      workout_count: "3",
    });

    const workouts = csvRows(result.datasets.workouts!.csv);
    expect(result.datasets.workouts!.columns).toEqual([...WORKOUT_COLUMNS]);
    expect(workouts.map((row) => row.workout_id)).toEqual([
      IDS.workouts.lateWalk,
      IDS.workouts.morningRun,
      IDS.workouts.middayWalk,
      IDS.workouts.weightliftingDay2,
      IDS.workouts.padel,
      IDS.workouts.manualWalk,
      IDS.workouts.weightliftingDay3,
      IDS.workouts.eveningRun,
    ]);
    expect(workouts.map((row) => row.day)).toEqual([
      "2026-09-14",
      "2026-09-15",
      "2026-09-15",
      "2026-09-15",
      "2026-09-15",
      "2026-09-16",
      "2026-09-16",
      "2026-09-16",
    ]);
    expect(workouts[1]).toMatchObject({
      sport_name: "running",
      sport_id: "0",
      distance_km: "7.41",
      recorded_pct: "100",
    });
    expect(workouts[2]).toMatchObject({ distance_km: "", altitude_gain_m: "" });
    expect(workouts[7]!.recorded_pct).toBe("100");

    expect(result.notes).toContain(
      "energy_kj, avg_hr_bpm and max_hr_bpm cover the whole WHOOP cycle (sleep onset to next sleep onset), not a calendar day; asleep_h is light + slow-wave + REM of the main sleep, without naps."
    );
    expect(result.notes).toContain(
      "WHOOP is still calibrating: recovery for 2026-09-15, 2026-09-16 is provisional (recovery_calibrating: true)."
    );
    expect(result.notes).toContain(
      "No WHOOP records for 27 days from 2026-08-18 to 2026-09-13; those rows have only date and utc_offset."
    );
    expect(result.data_quality.method_version).toBe(EXPORT_METHOD_VERSION);
    expect(result.data_quality.limitations).toEqual(
      expect.arrayContaining([...HISTORY_LIMITATIONS])
    );
    expect(result.data_quality.sources.workout).toMatchObject({ records_used: 8 });
    expect(result.data_quality.sources.recovery!.status).toBe("calibrating");
    expect(result.data_quality.requested_period).toEqual({
      start: "2026-08-18T00:00:00.000+02:00",
      end: "2026-09-16T23:30:00.000+02:00",
    });
    assertNeutralText(allText(result));
  });

  it("exports sleeps with naps and a negative nap need", async () => {
    const user = liveShapedUser();
    const second = user.sleeps.find((sleep) => sleep.id === IDS.sleeps.second)!;
    second.score!.sleep_needed.need_from_recent_nap_milli = -1_800_000;
    const napStart = Date.parse("2026-09-16T14:05:00+02:00");
    const nap: Sleep = {
      ...structuredClone(second),
      id: "c0ffee00-0000-4000-8000-00000000a001",
      created_at: iso(napStart + 40 * MINUTE_MS),
      updated_at: iso(napStart + 40 * MINUTE_MS),
      start: iso(napStart),
      end: iso(napStart + 30 * MINUTE_MS),
      nap: true,
      score: {
        ...structuredClone(second.score!),
        stage_summary: {
          total_in_bed_time_milli: 30 * MINUTE_MS,
          total_awake_time_milli: 4 * MINUTE_MS,
          total_no_data_time_milli: 0,
          total_light_sleep_time_milli: 20 * MINUTE_MS,
          total_slow_wave_sleep_time_milli: 6 * MINUTE_MS,
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
      },
    };
    user.sleeps.unshift(nap);
    const client = clientFor(user);

    const withoutNaps = await runExport(
      user,
      { datasets: ["sleeps", "daily"], format: "json" },
      client
    );
    expect(Object.keys(withoutNaps.datasets)).toEqual(["daily", "sleeps"]);
    expect(jsonRows(withoutNaps, "sleeps").map((row) => row.sleep_id)).toEqual([
      IDS.sleeps.first,
      IDS.sleeps.second,
    ]);
    expect(jsonRows(withoutNaps, "daily").find((row) => row.date === "2026-09-16")).toMatchObject({
      nap_count: 1,
      asleep_h: roundTo(
        (12_410_833 +
          4_977_291 +
          (Date.parse(second.end) -
            Date.parse(second.start) -
            2_305_114 -
            12_410_833 -
            4_977_291)) /
          3_600_000,
        2
      ),
    });

    const result = await runExport(
      user,
      { datasets: ["sleeps"], format: "json", include_naps: true },
      client
    );
    expect(result.datasets.sleeps!.columns).toEqual([...SLEEP_COLUMNS]);
    const rows = jsonRows(result, "sleeps");
    expect(rows.map((row) => [row.sleep_id, row.wake_day, row.nap])).toEqual([
      [IDS.sleeps.first, "2026-09-15", false],
      [IDS.sleeps.second, "2026-09-16", false],
      [nap.id, "2026-09-16", true],
    ]);
    expect(rows[1]).toMatchObject({
      need_from_recent_nap_h: -0.5,
      consistency_pct: null,
      score_state: "SCORED",
    });
    expect(rows[2]).toMatchObject({ asleep_min: 26, in_bed_min: 30, need_from_recent_nap_h: 0 });
    for (const row of rows) expect(row.need_from_recent_nap_h as number).toBeLessThanOrEqual(0);
    expect(
      result.notes.some((note) => note.includes("need_from_recent_nap_h is 0 or negative"))
    ).toBe(true);
    assertNeutralText(allText(result));
  });

  it("leaves score cells of unscored records empty and notes them", async () => {
    const user = liveShapedUser();
    user.workouts = user.workouts.map((workout) => {
      if (workout.id === IDS.workouts.middayWalk) {
        return { ...workout, score_state: "PENDING_SCORE", score: null };
      }
      if (workout.id === IDS.workouts.padel) {
        const zones = workout.score!.zone_durations;
        const half = (value: number): number => Math.round(value / 2);
        return {
          ...workout,
          score: {
            ...workout.score!,
            percent_recorded: 0.5,
            zone_durations: {
              zone_zero_milli: half(zones.zone_zero_milli),
              zone_one_milli: half(zones.zone_one_milli),
              zone_two_milli: half(zones.zone_two_milli),
              zone_three_milli: half(zones.zone_three_milli),
              zone_four_milli: half(zones.zone_four_milli),
              zone_five_milli: half(zones.zone_five_milli),
            },
          },
        };
      }
      return workout;
    });
    user.sleeps = user.sleeps.map((sleep) =>
      sleep.id === IDS.sleeps.second ? { ...sleep, score_state: "UNSCORABLE", score: null } : sleep
    );
    const result = await runExport(user, {
      start: "2026-09-14",
      datasets: ["daily", "workouts", "sleeps"],
      format: "json",
    });
    const pending = jsonRows(result, "workouts").find(
      (row) => row.workout_id === IDS.workouts.middayWalk
    )!;
    expect(pending).toMatchObject({
      score_state: "PENDING_SCORE",
      duration_min: expect.any(Number),
      strain: null,
      energy_kj: null,
      recorded_pct: null,
      zone0_min: null,
      trimp: null,
    });
    expect(
      jsonRows(result, "workouts").find((row) => row.workout_id === IDS.workouts.padel)
    ).toMatchObject({ recorded_pct: 50 });
    expect(jsonRows(result, "daily").find((row) => row.date === "2026-09-16")).toMatchObject({
      sleep_id: IDS.sleeps.second,
      sleep_score_state: "UNSCORABLE",
      asleep_h: null,
      // The recovery WHOOP scored for an unscorable sleep is shown (never scored later).
      recovery_score: 67,
    });
    expect(result.notes).toContain(
      "1 workout(s) are not scored yet or could not be scored (score_state); their score cells are empty."
    );
    expect(result.notes).toContain(
      "1 workout(s) recorded heart rate for less than 90% of their duration (recorded_pct); their zone minutes and TRIMP cover only the recorded part."
    );
    expect(result.notes).toContain(
      "1 row(s) of the sleeps dataset are not scored yet or could not be scored (score_state); their stage and need cells are empty."
    );
    expect(result.notes).toContain(
      "WHOOP could not score sleep for 2026-09-16; its cells are empty."
    );
    expect(result.data_quality.sources.workout).toMatchObject({
      records_used: 7,
      exclusions: { pending: 1 },
    });
    expect(result.data_quality.sources.sleep).toMatchObject({
      records_used: 1,
      exclusions: { unscored: 1 },
    });
    assertNeutralText(allText(result));
  });

  it("carries identical values in CSV and JSON on a sentinel fixture with hostile text", async () => {
    const user = liveShapedUser();
    // Collections are newest first: name the three oldest workouts by id.
    const hostileNames: Record<string, string> = {
      [IDS.workouts.lateWalk]: '=HYPERLINK("http://example.invalid","x"),\n@y',
      [IDS.workouts.morningRun]: '-2+3 "quoted", comma',
      [IDS.workouts.middayWalk]: "\tstarts with tab",
    };
    user.workouts = user.workouts.map((workout) =>
      hostileNames[workout.id] === undefined
        ? workout
        : { ...workout, sport_name: hostileNames[workout.id]! }
    );
    const second = user.sleeps.find((sleep) => sleep.id === IDS.sleeps.second)!;
    second.score!.sleep_needed.need_from_recent_nap_milli = -900_000;
    const client = clientFor(user);
    const args: ExportHealthDataInput = {
      start: "2026-09-10",
      datasets: ["daily", "workouts", "sleeps"],
    };
    const csv = await runExport(user, { ...args, format: "csv" }, client);
    const json = await runExport(user, { ...args, format: "json" }, client);

    for (const name of ["daily", "workouts", "sleeps"] as const) {
      const csvDataset = csv.datasets[name]!;
      const jsonDataset = json.datasets[name]!;
      expect(csvDataset.columns).toEqual(jsonDataset.columns);
      expect(csvDataset.row_count).toBe(jsonDataset.row_count);
      expect(jsonDataset.csv).toBeUndefined();
      const parsed = csvRows(csvDataset.csv);
      const rows = jsonRows(json, name);
      expect(parsed).toHaveLength(rows.length);
      rows.forEach((row, index) => {
        expect(Object.keys(row)).toEqual(jsonDataset.columns);
        for (const column of jsonDataset.columns) {
          expect(parsed[index]![column], `${name}[${index}].${column}`).toBe(csvText(row[column]!));
        }
      });
    }
    const hostile = jsonRows(json, "workouts")[0]!;
    expect(hostile.workout_id).toBe(IDS.workouts.lateWalk);
    expect(hostile.sport_name).toBe('=HYPERLINK("http://example.invalid","x"),\n@y');
    const parsedWorkouts = csvRows(csv.datasets.workouts!.csv);
    expect(parsedWorkouts[0]!.sport_name).toBe('\'=HYPERLINK("http://example.invalid","x"),\n@y');
    expect(csv.datasets.workouts!.csv).toContain(
      '"\'=HYPERLINK(""http://example.invalid"",""x""),\n@y"'
    );
    expect(parsedWorkouts[1]!.sport_name).toBe('\'-2+3 "quoted", comma');
    expect(parsedWorkouts[2]!.sport_name).toBe("'\tstarts with tab");
    expect(jsonRows(json, "sleeps")[1]!.need_from_recent_nap_h).toBe(-0.25);
    expect(csvRows(csv.datasets.sleeps!.csv)[1]!.need_from_recent_nap_h).toBe("-0.25");
    expect({ ...csv, datasets: null, format: null, data_quality: null }).toEqual({
      ...json,
      datasets: null,
      format: null,
      data_quality: null,
    });
  });
});

// ---------------------------------------------------------------------------
// Mature user: parity, failures and truncation
// ---------------------------------------------------------------------------

describe("export_health_data on a 30-day mature user", () => {
  it("daily rows equal get_calendar, and a strap-off day has blank cells", async () => {
    const user = matureUser({ days: 30 });
    const client = clientFor(user);
    const calendar = await getCalendar(client, { days: 30 }, user.now);
    const result = await runExport(user, { format: "json" }, client);
    const rows = jsonRows(result, "daily");
    expect(rows).toHaveLength(30);
    expect(result.period.days).toBe(30);

    const byDate = new Map(rows.map((row) => [row.date as string, row]));
    let emptyDays = 0;
    for (const day of calendar.days) {
      const row = byDate.get(day.date)!;
      expect(row, day.date).toBeDefined();
      expect(row.recovery_score).toBe(roundTo(day.recovery_score, 1));
      expect(row.recovery_calibrating).toBe(day.recovery_calibrating);
      if (day.sleep_hours === null) expect(row.asleep_h).toBeNull();
      else
        expect(Math.abs((row.asleep_h as number) - day.sleep_hours)).toBeLessThanOrEqual(
          0.05 + 1e-9
        );
      expect(row.sleep_performance_pct).toBe(roundTo(day.sleep_performance_pct, 1));
      expect(row.day_strain).toBe(roundTo(day.day_strain, 2));
      if (row.cycle_id !== null) {
        expect(row.day_strain_in_progress).toBe(day.day_strain_in_progress);
        expect(row.day_strain_partial).toBe(day.day_strain_partial);
      }
      const calendarEmpty =
        day.recovery_score === null && day.sleep_hours === null && day.day_strain === null;
      if (calendarEmpty && row.cycle_id === null && row.sleep_id === null) {
        emptyDays += 1;
        expect(
          DAILY_COLUMNS.slice(2).every((column) => row[column] === null),
          JSON.stringify(row)
        ).toBe(true);
      }
    }
    expect(emptyDays).toBeGreaterThanOrEqual(2);

    // workout_count matches the workouts dataset, and every workout is counted once.
    const workouts = jsonRows(result, "workouts");
    for (const row of rows) {
      const count = workouts.filter((workout) => workout.day === row.date).length;
      if (row.workout_count === null) expect(count).toBe(0);
      else expect(row.workout_count).toBe(count);
    }
    expect(new Set(workouts.map((workout) => workout.workout_id)).size).toBe(workouts.length);
    const displaced = result.warnings.filter((warning) => warning.startsWith("Two WHOOP cycles"));
    expect(displaced).toHaveLength(1);

    // The strap-off days in CSV are empty cells, never 0.
    const csv = await runExport(user, {}, client);
    const blank = csvRows(csv.datasets.daily!.csv).filter(
      (row) => row.cycle_id === "" && row.sleep_id === ""
    );
    expect(blank.length).toBe(emptyDays);
    for (const row of blank) {
      expect(
        Object.entries(row).filter(
          ([column, value]) => column !== "date" && column !== "utc_offset" && value !== ""
        )
      ).toEqual([]);
    }
    assertNeutralText(allText(result));
  });

  it("keeps daily values when the workout stream fails, with a warning", async () => {
    const user = matureUser({ days: 30 });
    const good = await runExport(user, { format: "json" });
    const failing = clientFor(user, {
      failures: [
        {
          path: /^\/v2\/activity\/workout\?start=/,
          error: () => new WhoopApiError(502, "Bad Gateway", {}),
        },
      ],
    });
    const result = await runExport(user, { format: "json" }, failing);

    expect(result.warnings).toContain(
      "Workout data could not be loaded (WHOOP API returned HTTP 502), so workout_count is empty, the workouts dataset has no rows."
    );
    expect(result.datasets.workouts).toEqual({
      columns: [...WORKOUT_COLUMNS],
      row_count: 0,
      rows: [],
    });
    expect(result.data_quality.sources.workout!.status).toBe("fetch_failed");
    expect(result.truncated).toBe(false);
    const goodRows = jsonRows(good, "daily");
    jsonRows(result, "daily").forEach((row, index) => {
      expect(row.workout_count).toBeNull();
      expect({ ...row, workout_count: null }).toEqual({ ...goodRows[index], workout_count: null });
    });
    assertNeutralText(allText(result));
  });

  it("marks truncated history with a warning when a later page fails", async () => {
    const user = stressUser();
    const client = clientFor(user, {
      failures: [
        {
          path: /^\/v2\/cycle\?start=/,
          page: 2,
          error: () => new WhoopApiError(500, "Internal Server Error", {}),
        },
      ],
    });
    const result = await runExport(user, { start: "last 89 days", format: "csv" }, client);
    expect(result.truncated).toBe(true);
    expect(result.data_quality.sources.cycle!.truncated).toBe(true);
    expect(
      result.warnings.some(
        (warning) =>
          warning.startsWith("Cycle history") && warning.includes("could not be read completely")
      )
    ).toBe(true);
  });

  it("throws the WHOOP error when every source fails", async () => {
    const user = liveShapedUser();
    const client = clientFor(user, {
      failures: [{ path: /\?start=/, error: () => new WhoopApiError(503, "Unavailable", {}) }],
    });
    await expect(exportHealthData({}, contextFor(client, user.now))).rejects.toThrow(WhoopApiError);
  });
});

// ---------------------------------------------------------------------------
// Cap, size and requests
// ---------------------------------------------------------------------------

describe("export_health_data cap and size", () => {
  it("capBundles keeps the most days that fit", () => {
    const render = (keep: number): ExportHealthDataResult["datasets"] => ({
      daily: { columns: [], row_count: 0, csv: "x".repeat(keep * 100) },
    });
    const overhead = JSON.stringify(render(0)).length;
    expect(capBundles(10, render, overhead + 1000).keep).toBe(10);
    expect(capBundles(10, render, overhead + 999).keep).toBe(9);
    expect(capBundles(10, render, overhead + 450).keep).toBe(4);
    expect(capBundles(10, render, overhead + 50).keep).toBe(0);
    expect(capBundles(0, render, overhead).keep).toBe(0);
  });

  it("caps a 180-day JSON export on stressUser, keeping the newest days, within the request budget", async () => {
    const user = stressUser();
    const client = clientFor(user);
    const today = localDay(user.now.toISOString(), user.offset);
    const result = await runExport(
      user,
      {
        start: addDays(today, -179),
        datasets: ["daily", "workouts", "sleeps"],
        format: "json",
        include_naps: true,
      },
      client
    );
    expect(client.calls.length).toBeLessThanOrEqual(DEFAULT_PAGE_BUDGET + 2);
    expect(result.period).toMatchObject({ start: addDays(today, -179), end: today, days: 180 });
    expect(result.output_capped).toBe(true);
    const first = result.first_included_day!;
    expect(first > result.period.start).toBe(true);
    expect(JSON.stringify(result.datasets).length).toBeLessThanOrEqual(EXPORT_MAX_CHARS);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(MAX_TOOL_TEXT_CHARS);

    const daily = jsonRows(result, "daily");
    expect(daily[0]!.date).toBe(first);
    expect(daily[daily.length - 1]!.date).toBe(today);
    expect(daily).toHaveLength(daysBetween(first, today) + 1);
    expect(jsonRows(result, "workouts").every((row) => (row.day as string) >= first)).toBe(true);
    expect(jsonRows(result, "sleeps").every((row) => (row.wake_day as string) >= first)).toBe(true);
    expect(jsonRows(result, "sleeps").some((row) => row.nap === true)).toBe(true);
    const note = result.notes.find((text) => text.startsWith("The export reached its"));
    expect(note).toBe(
      `The export reached its ${EXPORT_MAX_CHARS}-character limit, so it covers ${first} to ${today} (first_included_day; ${daily.length} of 180 days, output_capped: true). For the ${180 - daily.length} earlier days, request start ${result.period.start} with end ${addDays(first, -1)}. Format csv and fewer datasets fit more days per call.`
    );
    assertNeutralText(allText(result));

    // The data quality covers the included days only.
    const includedWorkouts = jsonRows(result, "workouts").filter(
      (row) => row.score_state === "SCORED"
    );
    expect(result.data_quality.sources.workout!.records_used).toBe(includedWorkouts.length);
  });

  it("a CSV export of the default datasets fits more days than JSON", async () => {
    const user = stressUser();
    const client = clientFor(user);
    const today = localDay(user.now.toISOString(), user.offset);
    const args: ExportHealthDataInput = { start: addDays(today, -179) };
    const csv = await runExport(user, { ...args, format: "csv" }, client);
    const json = await runExport(user, { ...args, format: "json" }, client);
    expect(JSON.stringify(csv.datasets).length).toBeLessThanOrEqual(EXPORT_MAX_CHARS);
    expect(csv.first_included_day! <= json.first_included_day!).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Offsets and the last-day window
// ---------------------------------------------------------------------------

describe("export_health_data offsets and windows", () => {
  it("a −05:00 clone exports the same local days and values", async () => {
    const plus = liveShapedUser();
    const minus = atOffset(plus, "-05:00");
    const args: ExportHealthDataInput = {
      start: "2026-09-12",
      datasets: ["daily", "workouts", "sleeps"],
      format: "json",
    };
    const a = await runExport(plus, args);
    const b = await runExport(minus, args);
    expect(b.period).toEqual({ ...a.period, utc_offset: "-05:00" });
    const withoutZone = (row: Row): Row =>
      Object.fromEntries(
        Object.entries(row).map(([column, value]) => [
          column,
          column === "utc_offset"
            ? null
            : typeof value === "string" && column.endsWith("_local")
              ? value.slice(0, 23)
              : value,
        ])
      );
    for (const name of ["daily", "workouts", "sleeps"] as const) {
      expect(jsonRows(b, name).map(withoutZone)).toEqual(jsonRows(a, name).map(withoutZone));
    }
    expect(
      jsonRows(b, "daily")
        .filter((row) => row.cycle_id !== null)
        .every((row) => row.utc_offset === "-05:00")
    ).toBe(true);
    expect(b.notes).toEqual(a.notes);
  });

  it("after midnight before the next sleep syncs, today's row is empty with a note, not missing data", async () => {
    const user = liveShapedUser({ now: "2026-09-17T00:30:00+02:00" });
    const result = await runExport(user, { start: "2026-09-14", format: "json" });
    const rows = jsonRows(result, "daily");
    expect(rows.map((row) => row.date)).toEqual([
      "2026-09-14",
      "2026-09-15",
      "2026-09-16",
      "2026-09-17",
    ]);
    const today = rows[3]!;
    expect(DAILY_COLUMNS.slice(2).every((column) => today[column] === null)).toBe(true);
    expect(rows[2]).toMatchObject({ day_strain_in_progress: true, workout_count: 3 });
    const note = result.notes.find((text) => text.startsWith("Today's (2026-09-17)"));
    expect(note).toContain("which belongs to 2026-09-16");
    expect(note).toContain("This is not missing data.");
    expect(result.notes.some((text) => text.startsWith("No WHOOP records"))).toBe(false);
    assertNeutralText(allText(result));
  });

  it("counts a 00:10 workout after the last day's midnight when that midnight is a history chunk boundary", async () => {
    const base = liveShapedUser({ now: "2026-09-17T00:30:00+02:00" });
    const late = lateWalk(
      base.workouts.find((workout) => workout.id === IDS.workouts.lateWalk)!,
      "b0c0ffee-0000-4000-8000-000000000010",
      Date.parse("2026-09-17T00:10:00+02:00"),
      15
    );
    base.workouts.push(late);
    // Move to UTC and 13 days earlier: local midnight starting 09-17 becomes
    // 2026-09-04T00:00Z, a 30-day history chunk boundary.
    const user = atOffset(base, "Z", -13 * DAY_MS);
    const boundary = Date.parse("2026-09-04T00:00:00Z");
    expect(boundary % HISTORY_CHUNK_MS).toBe(0);
    const shiftedLate = user.workouts.find((workout) => workout.id === late.id)!;
    expect(Date.parse(shiftedLate.start) - boundary).toBe(10 * MINUTE_MS);

    const client = clientFor(user);
    const result = await runExport(
      user,
      { start: "2026-09-01", end: "yesterday", format: "json" },
      client
    );
    expect(result.period).toMatchObject({
      start: "2026-09-01",
      end: "2026-09-03",
      utc_offset: "Z",
    });
    const lastDay = jsonRows(result, "daily").find((row) => row.date === "2026-09-03")!;
    expect(lastDay.workout_count).toBe(4);
    const lateRow = jsonRows(result, "workouts").find((row) => row.workout_id === late.id)!;
    expect(lateRow).toMatchObject({ day: "2026-09-03", start_local: "2026-09-04T00:10:00.000Z" });
    expect(result.notes).toContain(
      "1 workout(s) started after local midnight but before the next sleep, so they count toward the previous day (the day column), as in get_day and get_calendar."
    );
    // The chunk starting at the boundary was requested.
    expect(
      client.calls
        .map((path) => decodeURIComponent(path))
        .some((path) => path.startsWith(`/v2/activity/workout?start=${iso(boundary)}`))
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// MCP contract
// ---------------------------------------------------------------------------

describe("export_health_data contract", () => {
  it("is registered in standard mode only, with a short title and read-only annotation", async () => {
    expect(EXPORT_HEALTH_DATA_TOOL.aggregate).toBeUndefined();
    expect(EXPORT_HEALTH_DATA_TOOL.standard.title).toBe("Export health data");
    expect(EXPORT_HEALTH_DATA_TOOL.annotations).toEqual({ readOnlyHint: true });
    expect(EXPORT_HEALTH_DATA_TOOL.standard.description.length).toBeLessThanOrEqual(1000);
    expect(await listToolNames("standard")).toContain("export_health_data");
    expect(await listToolNames("aggregate")).not.toContain("export_health_data");
  });

  it("validates CSV and JSON results through the MCP server", async () => {
    const user = liveShapedUser();
    const connection = await connectServer(clientFor(user), { now: () => user.now });
    try {
      const tool = connection.tools.find((candidate) => candidate.name === "export_health_data");
      expect(tool?.outputSchema).toBeDefined();

      const csv = await connection.callTool("export_health_data", {});
      expect(csv.isError).toBe(false);
      expect(csv.text).toBe(JSON.stringify(csv.structured));
      expect(csv.structured).toMatchObject({ format: "csv", output_capped: false });

      const json = await connection.callTool("export_health_data", {
        start: "2026-09-14",
        datasets: ["sleeps", "workouts"],
        format: "json",
        include_naps: true,
      });
      expect(json.isError).toBe(false);
      const structured = json.structured as ExportHealthDataResult;
      expect(Object.keys(structured.datasets)).toEqual(["workouts", "sleeps"]);
      expect(structured.datasets.workouts!.row_count).toBe(8);

      const tooLong = await connection.callTool("export_health_data", { start: "2026-01-01" });
      expect(tooLong.isError).toBe(true);
      expect(tooLong.text).toContain("exports at most 180 days per call");

      const badDataset = await connection.callTool("export_health_data", { datasets: ["hourly"] });
      expect(badDataset.isError).toBe(true);
      const noDatasets = await connection.callTool("export_health_data", { datasets: [] });
      expect(noDatasets.isError).toBe(true);
    } finally {
      await connection.close();
    }
  });

  it("keeps a 180-day stressUser export within the text limit through the MCP server", async () => {
    const user = stressUser();
    const connection = await connectServer(clientFor(user), { now: () => user.now });
    try {
      const today = localDay(user.now.toISOString(), user.offset);
      for (const format of ["csv", "json"] as const) {
        const result = await connection.callTool("export_health_data", {
          start: addDays(today, -179),
          datasets: ["daily", "workouts", "sleeps"],
          include_naps: true,
          format,
        });
        expect(result.isError).toBe(false);
        expect(result.text.length).toBeLessThanOrEqual(MAX_TOOL_TEXT_CHARS);
      }
    } finally {
      await connection.close();
    }
  });
});
