/**
 * Golden regression snapshots of every client-visible legacy surface, captured
 * from the reference implementation (commit 897d74b) before the feature
 * release refactors:
 *
 * - tools-list/<mode>-<tool>.json: each legacy tool's tools/list entry in both
 *   privacy modes (16 standard, 5 aggregate).
 * - outputs/<mode>-<tool>.json: tool results on fixed fixtures and clocks
 *   (standard: all 16 legacy tools; aggregate: the 5 aggregate tools). By-id
 *   tools include malformed-id and 404 cases.
 * - resources/<name>.json: the 4 legacy resources (listing entry and reads).
 * - prompts/<name>.json: the 5 legacy prompts (listing entry and default args).
 * - fixtures.json: fingerprints of the fixtures the goldens were rendered from.
 *
 * Every golden belongs to the package that owns that tool, resource or prompt;
 * see golden-harness.ts for how to regenerate only your own files.
 */

import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WhoopApiError, WhoopNetworkError } from "../../src/api/client.js";
import type { PrivacyMode } from "../../src/privacy.js";
import { connectServer } from "../helpers/contract.js";
import {
  createWhoopFixtureClient,
  encodeFixturePageToken,
  type FixtureFailure,
} from "../helpers/whoop-fixture-client.js";
import {
  LIVE_SHAPED_IDS,
  liveShapedUser,
  matureUser,
  type WhoopUserFixture,
} from "../helpers/whoop-users.js";
import { expectGolden, renderResourceContents, renderToolOutcome } from "./golden-harness.js";

const GOLDEN_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Fixtures (every option spelled out, so helper defaults can evolve)
// ---------------------------------------------------------------------------

const LIVE = "liveShapedUser";
const LIVE_SYNC_RACE = "liveShapedUser@2026-09-16T07:01:37+02:00";
const LIVE_AFTER_MIDNIGHT = "liveShapedUser@2026-09-17T00:30:00+02:00";
const MATURE = "matureUser";
const RISING = "matureUser-rising-hrv";
const FALLING = "matureUser-falling-hrv";
const EMPTY = "emptyAccount";

type FixtureName =
  | typeof LIVE
  | typeof LIVE_SYNC_RACE
  | typeof LIVE_AFTER_MIDNIGHT
  | typeof MATURE
  | typeof RISING
  | typeof FALLING
  | typeof EMPTY;

const MATURE_OPTIONS = {
  days: 120,
  seed: 1,
  offset: "+02:00",
  now: "2026-09-16T23:30:00+02:00",
  gapDays: [54, 55],
  napEvery: 6,
  calibratingFirst: 3,
  pendingLast: true,
  offsetChange: { day: 80, offset: "+01:00" },
  workoutsPerDay: 1,
  lowCoverageEvery: 11,
  splitNightDays: [36],
  lateWorkoutEvery: 9,
  hrvDriftPerDay: 0.15,
} as const;

/** 60 quirk-free days whose HRV level (and with it recovery) drifts steadily. */
function trendingUser(hrvDriftPerDay: number): WhoopUserFixture {
  return matureUser({
    days: 60,
    seed: 3,
    offset: "+02:00",
    now: "2026-09-16T23:30:00+02:00",
    gapDays: [],
    napEvery: 0,
    calibratingFirst: 0,
    pendingLast: false,
    offsetChange: null,
    workoutsPerDay: 1,
    lowCoverageEvery: 0,
    splitNightDays: [],
    lateWorkoutEvery: 0,
    hrvDriftPerDay,
  });
}

const FIXTURE_BUILDERS: Record<FixtureName, () => WhoopUserFixture> = {
  [LIVE]: () => liveShapedUser({ now: "2026-09-16T23:30:00+02:00" }),
  // The new cycle is synced but last night's sleep and recovery are not yet.
  [LIVE_SYNC_RACE]: () => liveShapedUser({ now: "2026-09-16T07:01:37+02:00" }),
  // After local midnight, before the next sleep: today's cycle does not exist yet.
  [LIVE_AFTER_MIDNIGHT]: () => liveShapedUser({ now: "2026-09-17T00:30:00+02:00" }),
  [MATURE]: () =>
    matureUser({
      ...MATURE_OPTIONS,
      gapDays: [...MATURE_OPTIONS.gapDays],
      splitNightDays: [...MATURE_OPTIONS.splitNightDays],
      offsetChange: { ...MATURE_OPTIONS.offsetChange },
    }),
  [RISING]: () => trendingUser(0.5),
  [FALLING]: () => trendingUser(-0.5),
  [EMPTY]: () => {
    const live = liveShapedUser({ now: "2026-09-16T23:30:00+02:00" });
    return { ...live, cycles: [], sleeps: [], recoveries: [], workouts: [] };
  },
};

const fixtureCache = new Map<FixtureName, WhoopUserFixture>();
function fixture(name: FixtureName): WhoopUserFixture {
  let value = fixtureCache.get(name);
  if (!value) {
    value = FIXTURE_BUILDERS[name]();
    fixtureCache.set(name, value);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

/** A serializable failure injected into the fixture API. */
interface FailureSpec {
  /** Regular expression source matched against the request path. */
  path: string;
  /** HTTP status of a WhoopApiError, or "network" for a WhoopNetworkError. */
  status: number | "network";
}

interface ToolCase {
  name: string;
  fixture: FixtureName;
  args: Record<string, unknown> | ((data: WhoopUserFixture) => Record<string, unknown>);
  failures?: FailureSpec[];
}

function toFailure(spec: FailureSpec): FixtureFailure {
  return {
    path: new RegExp(spec.path),
    error: () =>
      spec.status === "network"
        ? new WhoopNetworkError(new TypeError("fetch failed"))
        : new WhoopApiError(spec.status, "Fixture failure", null),
  };
}

const COLLECTIONS: Record<string, string> = {
  get_recovery_collection: "^/v2/recovery",
  get_sleep_collection: "^/v2/activity/sleep",
  get_workout_collection: "^/v2/activity/workout",
  get_cycle_collection: "^/v2/cycle\\?(?!limit=1$)",
};

function collectionCases(tool: string): ToolCase[] {
  return [
    { name: "default arguments", fixture: LIVE, args: {} },
    {
      name: "yesterday as start and end",
      fixture: LIVE,
      args: { start: "yesterday", end: "yesterday" },
    },
    {
      name: "first page of a local date range",
      fixture: LIVE,
      args: { start: "2026-09-14", end: "2026-09-16", limit: 2 },
    },
    {
      name: "second page via nextToken",
      fixture: LIVE,
      args: {
        start: "2026-09-14",
        end: "2026-09-16",
        limit: 2,
        nextToken: encodeFixturePageToken(2, 2),
      },
    },
    {
      name: "last 7 days on a mature account",
      fixture: MATURE,
      args: { start: "last 7 days", limit: 25 },
    },
    {
      name: "zoned date-times across a strap-off gap",
      fixture: MATURE,
      args: { start: "2026-07-12T18:00:00+02:00", end: "2026-07-16T12:00:00Z", limit: 25 },
    },
    { name: "empty account", fixture: EMPTY, args: { start: "last 7 days" } },
    { name: "end before start", fixture: LIVE, args: { start: "2026-09-16", end: "2026-09-13" } },
    { name: "unrecognized date expression", fixture: LIVE, args: { start: "the other day" } },
    { name: "limit above 25", fixture: LIVE, args: { limit: 26 } },
    {
      name: "WHOOP rate limit",
      fixture: LIVE,
      args: { limit: 5 },
      failures: [{ path: COLLECTIONS[tool]!, status: 429 }],
    },
  ];
}

const UNKNOWN_UUID = "00000000-0000-4000-8000-000000000000";

function byIdCases(kind: "sleep" | "workout"): ToolCase[] {
  const found: ToolCase[] =
    kind === "sleep"
      ? [
          { name: "scored main sleep", fixture: LIVE, args: { id: LIVE_SHAPED_IDS.sleeps.second } },
          {
            name: "pending main sleep",
            fixture: MATURE,
            args: (data) => ({ id: data.sleeps.find((sleep) => !sleep.nap)!.id }),
          },
          {
            name: "nap",
            fixture: MATURE,
            args: (data) => ({ id: data.sleeps.find((sleep) => sleep.nap)!.id }),
          },
        ]
      : [
          {
            name: "GPS run with sport_id 0",
            fixture: LIVE,
            args: { id: LIVE_SHAPED_IDS.workouts.morningRun },
          },
          {
            name: "run with percent_recorded 0.99975777",
            fixture: LIVE,
            args: { id: LIVE_SHAPED_IDS.workouts.eveningRun },
          },
          {
            name: "manual-shaped walk",
            fixture: LIVE,
            args: { id: LIVE_SHAPED_IDS.workouts.manualWalk },
          },
        ];
  return [
    ...found,
    {
      name: "malformed id rejected by the input schema",
      fixture: LIVE,
      args: { id: "../user/profile" },
    },
    { name: "missing id", fixture: LIVE, args: {} },
    {
      name: "malformed id that passes the schema (404)",
      fixture: LIVE,
      args: { id: "not-a-uuid" },
    },
    { name: "unknown id (404)", fixture: LIVE, args: { id: UNKNOWN_UUID } },
    {
      name: "WHOOP authorization failure",
      fixture: LIVE,
      args: { id: UNKNOWN_UUID },
      failures: [{ path: "^/v2/activity/", status: 401 }],
    },
  ];
}

const CYCLE_BY_ID_CASES: ToolCase[] = [
  { name: "open cycle", fixture: LIVE, args: { id: LIVE_SHAPED_IDS.cycles.open } },
  { name: "partial first-day cycle", fixture: LIVE, args: { id: LIVE_SHAPED_IDS.cycles.firstDay } },
  { name: "negative id rejected by the input schema", fixture: LIVE, args: { id: -1 } },
  { name: "string id rejected by the input schema", fixture: LIVE, args: { id: "81002" } },
  { name: "fractional id rejected by the input schema", fixture: LIVE, args: { id: 81002.5 } },
  { name: "unknown id (404)", fixture: LIVE, args: { id: 999_999_999 } },
  {
    name: "network failure",
    fixture: LIVE,
    args: { id: LIVE_SHAPED_IDS.cycles.open },
    failures: [{ path: "^/v2/cycle/", status: "network" }],
  },
];

const WEEKLY_SUMMARY_CASES: ToolCase[] = [
  { name: "current week (first week of wear)", fixture: LIVE, args: {} },
  { name: "last week before the strap was worn", fixture: LIVE, args: { week_start: "last week" } },
  { name: "current week after local midnight", fixture: LIVE_AFTER_MIDNIGHT, args: {} },
  { name: "current week with a pending night", fixture: MATURE, args: {} },
  { name: "last week", fixture: MATURE, args: { week_start: "last week" } },
  { name: "week with a strap-off gap", fixture: MATURE, args: { week_start: "2026-07-15" } },
  {
    name: "week with the offset change",
    fixture: MATURE,
    args: { week_start: "2026-08-08T12:00:00Z" },
  },
  { name: "week with a split night", fixture: MATURE, args: { week_start: "2026-06-25" } },
  { name: "empty account", fixture: EMPTY, args: {} },
  { name: "unrecognized week_start", fixture: LIVE, args: { week_start: "someday" } },
  {
    name: "workout stream unavailable",
    fixture: MATURE,
    args: { week_start: "last week" },
    failures: [{ path: "^/v2/activity/workout", status: 503 }],
  },
];

const COMPARE_PERIODS_CASES: ToolCase[] = [
  {
    name: "two months on a mature account",
    fixture: MATURE,
    args: {
      period_a_start: "2026-07-01",
      period_a_end: "2026-07-31",
      period_b_start: "2026-08-15",
      period_b_end: "2026-09-14",
    },
  },
  {
    name: "date-time bounds ending now",
    fixture: MATURE,
    args: {
      period_a_start: "2026-08-01T00:00:00+02:00",
      period_a_end: "2026-08-15T12:00:00+02:00",
      period_b_start: "2026-08-16",
      period_b_end: "2026-09-16T21:30:00Z",
    },
  },
  {
    name: "calibrating account with too few days",
    fixture: LIVE,
    args: {
      period_a_start: "2026-09-01",
      period_a_end: "2026-09-07",
      period_b_start: "2026-09-14",
      period_b_end: "2026-09-16",
    },
  },
  {
    name: "overlapping periods",
    fixture: MATURE,
    args: {
      period_a_start: "2026-08-01",
      period_a_end: "2026-08-20",
      period_b_start: "2026-08-15",
      period_b_end: "2026-08-30",
    },
  },
  {
    name: "relative expression rejected by the input schema",
    fixture: MATURE,
    args: {
      period_a_start: "last week",
      period_a_end: "2026-09-07",
      period_b_start: "2026-09-08",
      period_b_end: "2026-09-14",
    },
  },
  {
    name: "sleep stream unavailable",
    fixture: MATURE,
    args: {
      period_a_start: "2026-08-01",
      period_a_end: "2026-08-14",
      period_b_start: "2026-08-15",
      period_b_end: "2026-08-28",
    },
    failures: [{ path: "^/v2/activity/sleep", status: 500 }],
  },
  {
    name: "rising HRV and recovery",
    fixture: RISING,
    args: {
      period_a_start: "2026-07-20",
      period_a_end: "2026-08-09",
      period_b_start: "2026-08-20",
      period_b_end: "2026-09-09",
    },
  },
  {
    name: "falling HRV and recovery",
    fixture: FALLING,
    args: {
      period_a_start: "2026-07-20",
      period_a_end: "2026-08-09",
      period_b_start: "2026-08-20",
      period_b_end: "2026-09-09",
    },
  },
];

const TREND_METRICS = ["recovery", "hrv", "rhr", "sleep_duration", "sleep_performance", "strain"];
const TREND_CASES: ToolCase[] = [
  ...TREND_METRICS.map(
    (metric): ToolCase => ({
      name: `${metric} over 30 days`,
      fixture: MATURE,
      args: { metric, days: 30 },
    })
  ),
  { name: "recovery over 90 days", fixture: MATURE, args: { metric: "recovery", days: 90 } },
  { name: "strain with default days", fixture: MATURE, args: { metric: "strain" } },
  {
    name: "sleep_duration over 7 days",
    fixture: MATURE,
    args: { metric: "sleep_duration", days: 7 },
  },
  { name: "rising hrv over 60 days", fixture: RISING, args: { metric: "hrv", days: 60 } },
  { name: "rising recovery over 60 days", fixture: RISING, args: { metric: "recovery", days: 60 } },
  { name: "rhr under rising hrv over 60 days", fixture: RISING, args: { metric: "rhr", days: 60 } },
  { name: "falling hrv over 60 days", fixture: FALLING, args: { metric: "hrv", days: 60 } },
  {
    name: "falling recovery over 60 days",
    fixture: FALLING,
    args: { metric: "recovery", days: 60 },
  },
  { name: "calibrating account", fixture: LIVE, args: { metric: "recovery", days: 7 } },
  { name: "calibrating account strain", fixture: LIVE, args: { metric: "strain" } },
  { name: "empty account", fixture: EMPTY, args: { metric: "hrv", days: 14 } },
  { name: "unknown metric", fixture: LIVE, args: { metric: "vo2max" } },
  { name: "days below the minimum", fixture: LIVE, args: { metric: "hrv", days: 6 } },
  {
    name: "recovery stream rate limited",
    fixture: MATURE,
    args: { metric: "hrv", days: 14 },
    failures: [{ path: "^/v2/recovery", status: 429 }],
  },
];

const TODAY_CASES: ToolCase[] = [
  { name: "evening with every section", fixture: LIVE, args: {} },
  { name: "cycle synced before sleep and recovery", fixture: LIVE_SYNC_RACE, args: {} },
  { name: "after local midnight before the next sleep", fixture: LIVE_AFTER_MIDNIGHT, args: {} },
  { name: "pending last night", fixture: MATURE, args: {} },
  { name: "empty account", fixture: EMPTY, args: {} },
  {
    name: "workout stream unavailable",
    fixture: LIVE,
    args: {},
    failures: [{ path: "^/v2/activity/workout", status: 500 }],
  },
  {
    name: "every primary stream rejected",
    fixture: LIVE,
    args: {},
    failures: [{ path: "^/v2/(recovery|cycle|activity/sleep)", status: 401 }],
  },
];

const CALENDAR_CASES: ToolCase[] = [
  { name: "default week on a new account", fixture: LIVE, args: {} },
  { name: "three days", fixture: LIVE, args: { days: 3 } },
  {
    name: "after local midnight before the next sleep",
    fixture: LIVE_AFTER_MIDNIGHT,
    args: { days: 3 },
  },
  { name: "30 days", fixture: MATURE, args: { days: 30 } },
  { name: "90 days", fixture: MATURE, args: { days: 90 } },
  { name: "last week", fixture: MATURE, args: { start: "last week" } },
  { name: "strap-off gap", fixture: MATURE, args: { start: "2026-07-10", days: 10 } },
  { name: "split night", fixture: MATURE, args: { start: "2026-06-22", days: 7 } },
  { name: "offset change", fixture: MATURE, args: { start: "2026-08-05T09:00:00+02:00", days: 7 } },
  { name: "start after today", fixture: LIVE, args: { start: "2026-10-01" } },
  { name: "unrecognized start", fixture: LIVE, args: { start: "whenever" } },
  {
    name: "cycle stream unavailable",
    fixture: LIVE,
    args: { days: 3 },
    failures: [{ path: "^/v2/cycle\\?start=", status: 500 }],
  },
];

const BASELINES_CASES: ToolCase[] = [
  { name: "calibrating account", fixture: LIVE, args: {} },
  { name: "default window", fixture: MATURE, args: {} },
  { name: "60 days", fixture: MATURE, args: { baseline_days: 60 } },
  { name: "14 days", fixture: MATURE, args: { baseline_days: 14 } },
  { name: "empty account", fixture: EMPTY, args: {} },
  { name: "baseline_days above the maximum", fixture: MATURE, args: { baseline_days: 181 } },
  {
    name: "every stream rate limited",
    fixture: LIVE,
    args: {},
    failures: [{ path: "^/v2/", status: 429 }],
  },
];

const SLEEP_DEBT_CASES: ToolCase[] = [
  { name: "calibrating account", fixture: LIVE, args: {} },
  { name: "default window", fixture: MATURE, args: {} },
  { name: "30 days", fixture: MATURE, args: { days: 30 } },
  { name: "last week", fixture: MATURE, args: { start: "last week" } },
  { name: "start with days", fixture: MATURE, args: { start: "2026-08-01", days: 10 } },
  { name: "empty account", fixture: EMPTY, args: {} },
  { name: "unrecognized start", fixture: MATURE, args: { start: "banana" } },
  {
    name: "sleep stream unavailable",
    fixture: MATURE,
    args: {},
    failures: [{ path: "^/v2/activity/sleep", status: 503 }],
  },
];

const STANDARD_TOOL_CASES: Record<string, ToolCase[]> = {
  get_profile: [
    { name: "profile", fixture: LIVE, args: {} },
    {
      name: "WHOOP authorization failure",
      fixture: LIVE,
      args: {},
      failures: [{ path: "^/v2/user/", status: 401 }],
    },
  ],
  get_body_measurement: [
    { name: "body measurement", fixture: LIVE, args: {} },
    {
      name: "WHOOP unavailable",
      fixture: LIVE,
      args: {},
      failures: [{ path: "^/v2/user/", status: 502 }],
    },
  ],
  get_recovery_collection: collectionCases("get_recovery_collection"),
  get_sleep_collection: collectionCases("get_sleep_collection"),
  get_workout_collection: collectionCases("get_workout_collection"),
  get_cycle_collection: collectionCases("get_cycle_collection"),
  get_sleep_by_id: byIdCases("sleep"),
  get_workout_by_id: byIdCases("workout"),
  get_cycle_by_id: CYCLE_BY_ID_CASES,
  get_weekly_summary: WEEKLY_SUMMARY_CASES,
  compare_periods: COMPARE_PERIODS_CASES,
  get_trend: TREND_CASES,
  get_today: TODAY_CASES,
  get_calendar: CALENDAR_CASES,
  get_baselines: BASELINES_CASES,
  get_sleep_debt: SLEEP_DEBT_CASES,
};

const AGGREGATE_TOOL_CASES: Record<string, ToolCase[]> = {
  compare_periods: COMPARE_PERIODS_CASES,
  get_baselines: BASELINES_CASES,
  get_sleep_debt: SLEEP_DEBT_CASES,
  get_trend: TREND_CASES,
  get_weekly_summary: WEEKLY_SUMMARY_CASES,
};

const LEGACY_RESOURCES: Record<string, string> = {
  "recovery-latest": "whoop://v2/user/recovery/latest",
  "sleep-latest": "whoop://v2/user/sleep/latest",
  "cycle-latest": "whoop://v2/user/cycle/latest",
  "workout-latest": "whoop://v2/user/workout/latest",
  profile: "whoop://v2/user/profile",
};

interface ResourceCase {
  name: string;
  fixture: FixtureName;
  failures?: FailureSpec[];
}

const RESOURCE_CASES: ResourceCase[] = [
  { name: "evening with every record", fixture: LIVE },
  { name: "cycle synced before sleep and recovery", fixture: LIVE_SYNC_RACE },
  { name: "after local midnight before the next sleep", fixture: LIVE_AFTER_MIDNIGHT },
  { name: "pending last night after naps", fixture: MATURE },
  { name: "empty account", fixture: EMPTY },
  { name: "WHOOP unavailable", fixture: LIVE, failures: [{ path: "^/v2/", status: 503 }] },
];

const LEGACY_PROMPTS = [
  "weekly_health_review",
  "sleep_analysis",
  "recovery_trend",
  "workout_recap",
  "health_check",
];

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function pinClock(data: WhoopUserFixture): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(data.now);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function renderToolCases(
  mode: PrivacyMode,
  tool: string,
  cases: ToolCase[]
): Promise<unknown> {
  const rendered: unknown[] = [];
  for (const testCase of cases) {
    const data = fixture(testCase.fixture);
    const args = typeof testCase.args === "function" ? testCase.args(data) : testCase.args;
    pinClock(data);
    const client = createWhoopFixtureClient({
      ...data,
      failures: (testCase.failures ?? []).map(toFailure),
    });
    const connection = await connectServer(client, { privacyMode: mode, disableResources: true });
    try {
      const outcome = await connection.callTool(tool, args);
      rendered.push({
        name: testCase.name,
        fixture: testCase.fixture,
        now: data.now.toISOString(),
        arguments: args,
        ...(testCase.failures ? { failures: testCase.failures } : {}),
        result: renderToolOutcome(outcome),
      });
    } finally {
      await connection.close();
      vi.useRealTimers();
    }
  }
  return { tool, mode, cases: rendered };
}

function fingerprint(data: WhoopUserFixture): unknown {
  return {
    now: data.now.toISOString(),
    offset: data.offset,
    records: {
      cycles: data.cycles.length,
      sleeps: data.sleeps.length,
      recoveries: data.recoveries.length,
      workouts: data.workouts.length,
    },
    sha256: createHash("sha256").update(JSON.stringify(data)).digest("hex"),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("golden fixtures", () => {
  it("are the fixtures the goldens were rendered from", () => {
    const fingerprints = Object.fromEntries(
      (Object.keys(FIXTURE_BUILDERS) as FixtureName[]).map((name) => [
        name,
        fingerprint(fixture(name)),
      ])
    );
    expectGolden("fixtures", fingerprints);
  });
});

describe("golden tools/list entries", () => {
  it.each(["standard", "aggregate"] as const)(
    "%s mode",
    async (mode) => {
      const cases = mode === "standard" ? STANDARD_TOOL_CASES : AGGREGATE_TOOL_CASES;
      const connection = await connectServer(createWhoopFixtureClient(), { privacyMode: mode });
      try {
        const names = connection.tools.map((tool) => tool.name);
        expect(names).toEqual(expect.arrayContaining(Object.keys(cases)));
        for (const tool of Object.keys(cases)) {
          expectGolden(
            `tools-list/${mode}-${tool}`,
            connection.tools.find((entry) => entry.name === tool)
          );
        }
      } finally {
        await connection.close();
      }
    },
    GOLDEN_TIMEOUT_MS
  );
});

describe("golden tool outputs (standard)", () => {
  it.each(Object.keys(STANDARD_TOOL_CASES))(
    "%s",
    async (tool) => {
      expectGolden(
        `outputs/standard-${tool}`,
        await renderToolCases("standard", tool, STANDARD_TOOL_CASES[tool]!)
      );
    },
    GOLDEN_TIMEOUT_MS
  );
});

describe("golden tool outputs (aggregate)", () => {
  it.each(Object.keys(AGGREGATE_TOOL_CASES))(
    "%s",
    async (tool) => {
      expectGolden(
        `outputs/aggregate-${tool}`,
        await renderToolCases("aggregate", tool, AGGREGATE_TOOL_CASES[tool]!)
      );
    },
    GOLDEN_TIMEOUT_MS
  );
});

describe("golden resources", () => {
  it.each(Object.keys(LEGACY_RESOURCES))(
    "%s",
    async (name) => {
      // The legacy read-failure path logs to stderr; keep test output clean.
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const uri = LEGACY_RESOURCES[name]!;
      const listing = await (async () => {
        const connection = await connectServer(createWhoopFixtureClient());
        try {
          return (
            (await connection.listResources()).find((resource) => resource.uri === uri) ?? null
          );
        } finally {
          await connection.close();
        }
      })();
      const reads: unknown[] = [];
      for (const testCase of RESOURCE_CASES) {
        const data = fixture(testCase.fixture);
        pinClock(data);
        const client = createWhoopFixtureClient({
          ...data,
          failures: (testCase.failures ?? []).map(toFailure),
        });
        const connection = await connectServer(client);
        try {
          const result = await connection.readResource(uri);
          reads.push({
            name: testCase.name,
            fixture: testCase.fixture,
            now: data.now.toISOString(),
            ...(testCase.failures ? { failures: testCase.failures } : {}),
            contents: renderResourceContents(result),
          });
        } finally {
          await connection.close();
          vi.useRealTimers();
        }
      }
      expectGolden(`resources/${name}`, { uri, listing, reads });
    },
    GOLDEN_TIMEOUT_MS
  );
});

describe("golden prompts", () => {
  it.each(LEGACY_PROMPTS)(
    "%s",
    async (name) => {
      const connection = await connectServer(createWhoopFixtureClient());
      try {
        const listing =
          (await connection.listPrompts()).find((prompt) => prompt.name === name) ?? null;
        // Every argument left at its default (an empty arguments object).
        const defaultArguments = await connection.getPrompt(name, {});
        // A client that omits `arguments` altogether.
        const omittedArguments = await connection.getPrompt(name).then(
          (result) => ({ result }),
          (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) })
        );
        expectGolden(`prompts/${name}`, {
          name,
          listing,
          default_arguments: defaultArguments,
          omitted_arguments: omittedArguments,
        });
      } finally {
        await connection.close();
      }
    },
    GOLDEN_TIMEOUT_MS
  );
});
