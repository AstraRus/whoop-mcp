/**
 * Server guide: the MCP initialize `instructions` and the markdown guide served
 * as the resource whoop://server/guide.
 *
 * Both are written per privacy mode and name only the tools registered in that
 * mode (tests/guide.test.ts checks every name against a real server). The text
 * is factual: how to pick a tool, how WHOOP days and cycles map to local days,
 * how missing and calibrating data is reported, how history is loaded within
 * WHOOP's rate limit and what the WHOOP API does not provide.
 */

import type { PrivacyMode } from "./privacy.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** URI of the markdown guide resource (registered in both modes unless resources are disabled). */
export const GUIDE_RESOURCE_URI = "whoop://server/guide";

/** MIME type of the guide resource. */
export const GUIDE_MIME_TYPE = "text/markdown";

/** Longest instructions text sent in the initialize result. */
export const MAX_INSTRUCTIONS_CHARS = 1800;

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

const STANDARD_INSTRUCTIONS = [
  "Read-only access to one person's WHOOP data. Pick the tool for the question:",
  "- today: get_today; one local day: get_day; a range of days: get_calendar",
  "- training: get_training_load, get_sport_breakdown, get_workout_log, get_workout_context, get_personal_records",
  "- sleep: get_sleep_analysis, get_sleep_debt, get_sleep_need",
  "- recovery: get_recovery_analysis, get_baselines, get_trend",
  "- patterns between behaviours and next-morning recovery: get_recovery_drivers",
  "- missing or old data: get_sync_status; export: export_health_data",
  "Days are the user's local days. A WHOOP cycle starts at sleep onset and runs to the next sleep onset; recovery and sleep belong to the morning it covers. After local midnight and before the next sleep syncs, strain and workouts still count toward the previous day.",
  "Sleep hours are time asleep (light + slow-wave + REM) on main sleeps; naps and time in bed are separate.",
  "Unknown values are null, never 0. Recoveries flagged calibrating (first weeks of wear) are provisional. Read status, notes and warnings before using values; below a minimum sample size values are null.",
  "Long histories load in 30-day chunks within WHOOP's rate limit: truncated true means older data was not read yet, and repeating the call continues from the cache.",
  "Results are descriptive, not medical advice.",
].join("\n");

const AGGREGATE_INSTRUCTIONS = [
  "Read-only WHOOP data in aggregate privacy mode: only weekly aggregates, no single days, records or latest values. Tools:",
  "- get_weekly_summary: one released week; get_trend: one metric over released weeks; compare_periods: two periods",
  "- get_baselines: personal distributions; get_sleep_debt: nightly deficits",
  "- get_training_load: weekly training load; get_sport_breakdown: one 4-week block per sport",
  "- get_sync_status: connection status and the latest released week",
  "Windows snap to released weeks: whole local Monday-to-Sunday weeks, released two days after they end (from Wednesday, local time). The current week, and last week before Wednesday, are not available. A week with a record still open or being scored is withheld, and a week counts toward a value only with at least 3 samples.",
  "A WHOOP cycle starts at sleep onset; workouts after local midnight before the next sleep count toward the previous day.",
  "Sleep hours are time asleep on main sleeps. Withheld or unknown values are null, never 0, and notes say why. Calibrating recoveries are not used. Values are rounded.",
  "Long histories load within WHOOP's rate limit; repeating a call continues from the cache.",
  "Results are descriptive, not medical advice.",
].join("\n");

/**
 * Instructions sent in the MCP initialize result for `mode` (at most
 * {@link MAX_INSTRUCTIONS_CHARS} characters).
 */
export function buildServerInstructions(mode: PrivacyMode): string | undefined {
  return mode === "aggregate" ? AGGREGATE_INSTRUCTIONS : STANDARD_INSTRUCTIONS;
}

// ---------------------------------------------------------------------------
// Guide
// ---------------------------------------------------------------------------

/** One row of the "Which tool for which question" table. */
interface ToolRow {
  question: string;
  tools: readonly string[];
  /** Registered in aggregate mode too (with an aggregate variant). */
  aggregate?: string;
}

const TOOL_ROWS: readonly ToolRow[] = [
  {
    question:
      "How am I doing today? Recovery, last night's sleep, strain so far and the latest workout",
    tools: ["get_today"],
  },
  {
    question:
      "What happened on one local day (cycle, recovery, sleep, naps, workouts, the next morning)?",
    tools: ["get_day"],
  },
  { question: "Day-by-day recovery, sleep and strain over a range", tools: ["get_calendar"] },
  {
    question: "One Monday-to-Sunday week",
    tools: ["get_weekly_summary"],
    aggregate: "One released week: averages, workout totals and daily strain",
  },
  {
    question: "Two periods side by side",
    tools: ["compare_periods"],
    aggregate: "Two periods, each snapped to the released weeks inside it",
  },
  {
    question: "One metric's direction over the last N days",
    tools: ["get_trend"],
    aggregate: "One metric's mean, spread and trend over 1-13 released weeks",
  },
  {
    question: "Personal ranges (baselines) for HRV, resting heart rate, sleep and more",
    tools: ["get_baselines"],
    aggregate: "Personal distributions over 2-26 released weeks",
  },
  {
    question: "Nightly deficits against WHOOP's sleep need and bedtime consistency",
    tools: ["get_sleep_debt"],
    aggregate: "Deficit totals and clock consistency over released weeks",
  },
  {
    question:
      "Training load: acute and chronic load, EWMA, monotony, weekly totals and load by sport",
    tools: ["get_training_load"],
    aggregate: "Weekly training load and a weekly acute:chronic ratio over released weeks",
  },
  {
    question: "Sessions, time, energy, heart-rate zones and pace per sport",
    tools: ["get_sport_breakdown"],
    aggregate: "One released 4-week block per sport",
  },
  {
    question: "A filtered or sorted list of workouts with totals",
    tools: ["get_workout_log"],
  },
  {
    question:
      "One workout with its day, the morning recovery before it, the night after it and earlier sessions of the sport",
    tools: ["get_workout_context"],
  },
  { question: "Personal bests per sport", tools: ["get_personal_records"] },
  {
    question: "Sleep distributions, stage shares, timing and naps",
    tools: ["get_sleep_analysis"],
  },
  {
    question: "A statistical estimate of the next sleep need (not WHOOP Sleep Planner)",
    tools: ["get_sleep_need"],
  },
  {
    question:
      "Recovery zones, deviations from the personal baseline, the 7-day HRV mean and weekday patterns",
    tools: ["get_recovery_analysis"],
  },
  {
    question: "Behaviours associated with next-morning recovery, HRV, resting heart rate or sleep",
    tools: ["get_recovery_drivers"],
  },
  {
    question: "Why data is missing or looks old",
    tools: ["get_sync_status"],
    aggregate: "Connection status, the latest released week and weeks with data",
  },
  {
    question: "Export daily, workout and sleep rows as CSV or JSON",
    tools: ["export_health_data"],
  },
  {
    question: "Raw WHOOP records (newest first, 25 per page, follow next_token)",
    tools: [
      "get_recovery_collection",
      "get_sleep_collection",
      "get_workout_collection",
      "get_cycle_collection",
    ],
  },
  {
    question: "One raw record by id",
    tools: ["get_sleep_by_id", "get_workout_by_id", "get_cycle_by_id"],
  },
  {
    question: "Profile and current body measurements",
    tools: ["get_profile", "get_body_measurement"],
  },
];

const STANDARD_PROMPTS = [
  "morning_briefing",
  "evening_briefing",
  "day_review",
  "weekly_health_review",
  "sleep_analysis",
  "recovery_trend",
  "recovery_drivers",
  "workout_recap",
  "session_debrief",
  "training_load_check",
  "health_check",
  "data_status_check",
  "export_my_data",
];

function toolTable(mode: PrivacyMode): string[] {
  const lines = ["| Question | Tool |", "| --- | --- |"];
  for (const row of TOOL_ROWS) {
    if (mode === "aggregate" && row.aggregate === undefined) continue;
    const question = mode === "aggregate" ? (row.aggregate ?? row.question) : row.question;
    lines.push(`| ${question} | ${row.tools.map((tool) => `\`${tool}\``).join(", ")} |`);
  }
  return lines;
}

function standardGuide(): string {
  return [
    "# WHOOP MCP server guide",
    "",
    "Read-only access to one person's WHOOP data (standard privacy mode). Every tool returns structured JSON that matches its advertised output schema.",
    "",
    "## Which tool for which question",
    "",
    ...toolTable("standard"),
    "",
    "Resources: `whoop://v2/user/recovery/latest`, `whoop://v2/user/sleep/latest`, `whoop://v2/user/cycle/latest`, `whoop://v2/user/workout/latest`, `whoop://v2/user/profile` and this guide (`whoop://server/guide`).",
    "",
    `Prompts: ${STANDARD_PROMPTS.map((name) => `\`${name}\``).join(", ")}.`,
    "",
    "## How days and cycles work",
    "",
    "- A WHOOP cycle runs from one sleep onset to the next. It usually starts the evening before the day it covers, and the newest cycle stays open (end null) until WHOOP processes the next sleep.",
    "- Days are the user's local days, in the UTC offset WHOOP records carry. A cycle is placed on the local day its main sleep ended (the morning it covers); its recovery and main sleep belong to that morning. Every day-based tool places records the same way as `get_calendar`.",
    "- A workout counts toward the day of the cycle containing its start. A workout after local midnight and before the next sleep syncs therefore counts toward the previous day, and so does its strain. Between local midnight and the next synced sleep, today has no cycle yet (`get_day` status no_cycle_yet).",
    "- The open (in-progress) cycle's strain is still accumulating and the first day of wear is partial; both are left out of averages and flagged.",
    "- Day strain is WHOOP's non-linear 0-21 score: it is not the sum of workout strains, and adding it across days is not meaningful. Cycle energy (kJ) covers sleep onset to sleep onset, not a calendar day.",
    '- Date inputs follow local midnight: YYYY-MM-DD, "today" and "yesterday" are local days, and "last N days" is today plus the N previous days. Weeks are Monday-to-Sunday local weeks.',
    "",
    "## Data quality, calibrating and nulls",
    "",
    "- Unknown values are null, never 0. A worn day without workouts has 0 for workout totals; a day without WHOOP data is null.",
    "- Records WHOOP has not scored yet (PENDING_SCORE) or could not score (UNSCORABLE) contribute no values; notes and exclusion counts say how many there were.",
    "- In the first weeks of wear WHOOP flags recoveries as calibrating (user_calibrating). They are shown with the flag and are left out of baselines, deviations and associations by default, with counts. WHOOP's sleep consistency of 0 while calibrating is reported as null.",
    "- Values that need a minimum sample size stay null below it, with a status such as insufficient_data, insufficient_history or calibrating and a note giving the count and the requirement (for example trends need 4 points, baselines 14 earlier values, sleep statistics 3 scored nights, recovery patterns 14 pairs of nights, training load 28 worn days).",
    "- Sleep hours are time asleep (light + slow-wave + REM) on main sleeps. Naps and time in bed are separate figures.",
    "- percent_recorded is a 0-1 fraction; sessions below 90% recorded are left out of heart-rate statistics. Heart-rate zones and TRIMP undercount strength sessions, and pace is the elapsed average pace including pauses.",
    "- Analysis tools return notes, warnings, truncated, data_quality (per-source status, fetch time and cache status; periods in local time) and a disclaimer. Relationships found by `get_recovery_drivers` are observational associations.",
    "- Nothing here is medical advice.",
    "",
    "## Privacy modes",
    "",
    "- standard (default): every tool, resource and prompt.",
    "- aggregate (WHOOP_MCP_PRIVACY_MODE=aggregate, set by the server operator; tool arguments cannot change it): only `get_weekly_summary`, `compare_periods`, `get_trend`, `get_baselines`, `get_sleep_debt`, `get_training_load`, `get_sport_breakdown` and `get_sync_status`, with outputs limited to whole released weeks (released two days after they end), at least 3 samples per week and rounded values; no per-day values, records, latest observations, record resources or record prompts. The release lag covers late syncs only: an edit in WHOOP to a released week (e.g. a workout added or deleted) changes its values on the next call, and comparing results before and after the edit reveals that record's contribution to within the rounding step.",
    "",
    "## Rate limits and history loading",
    "",
    "- WHOOP allows an app 100 requests per minute and 10,000 per day. The server paces every WHOOP request of the process (60 per minute by default, bursts of 20, 4 at a time) and pauses all requests after a 429 for WHOOP's Retry-After.",
    "- Long windows read history in 30-day chunks kept in memory: 2 minutes for the newest days, 60 minutes for chunks older than 3 days and 6 hours for chunks older than 30 days. One tool call reads at most 60 pages within 20 seconds.",
    "- When a call stops early, truncated is true and notes or warnings say which data may be missing; repeating the same call continues from the cache. Results may lag WHOOP edits by the cache time unless the server receives WHOOP webhooks.",
    "- Collection tools return at most 25 records per call; keep calling with next_token until it is null.",
    "",
    "## What the WHOOP API does not provide",
    "",
    "Strength Trainer exercises, sets, repetitions and weights; journal entries; stress; steps; VO2 max; continuous heart rate or HRV time series; body measurement history (only the current height, weight and max heart rate); WHOOP Sleep Planner and coaching. No tool returns these, and none of their values are estimated from other data.",
    "",
  ].join("\n");
}

function aggregateGuide(): string {
  return [
    "# WHOOP MCP server guide",
    "",
    "Read-only WHOOP data in aggregate privacy mode: weekly aggregates only. Every tool returns structured JSON that matches its advertised output schema.",
    "",
    "## Which tool for which question",
    "",
    ...toolTable("aggregate"),
    "",
    "The only resource is this guide (`whoop://server/guide`). The prompt `aggregate_overview` walks through the tools above.",
    "",
    "## How days and cycles work",
    "",
    "- A WHOOP cycle runs from one sleep onset to the next and is placed on the local day its main sleep ended. A workout counts toward the day of the cycle containing its start, so a workout after local midnight and before the next sleep counts toward the previous day.",
    "- Days are the user's local days and weeks are Monday-to-Sunday local weeks.",
    "- Windows snap to released weeks: a week is released two days after it ends (from Wednesday 00:00, local time). The current week, and last week before Wednesday, return null values with a note. A week with a cycle still open or a record still being scored is withheld.",
    "- `get_trend` rounds `days` up to 1, 2, 4, 8 or 13 weeks, `get_baselines` to 2, 4, 8, 13 or 26 weeks and `get_sleep_debt` to 2, 4, 8 or 12 weeks, each ending with the latest released week. `compare_periods` snaps each period inward to the released weeks inside it. `get_sport_breakdown` uses 4-week blocks on a fixed Monday grid.",
    "- Day strain is WHOOP's non-linear 0-21 score and is not the sum of workout strains.",
    "",
    "## Data quality, calibrating and nulls",
    "",
    "- Withheld and unknown values are null, never 0, and notes say why without dates of withheld weeks.",
    "- A week counts toward a value only with at least 3 samples (recoveries, nights, completed cycles or sessions); totals that could be subtracted from other released totals to isolate fewer than 3 sessions are withheld.",
    "- Calibrating recoveries (the first weeks of wear) are not used. Records WHOOP has not scored contribute no values.",
    "- Sleep hours are time asleep (light + slow-wave + REM) on main sleeps.",
    "- Values are rounded; data_quality counts only records placed in released weeks.",
    "- Nothing here is medical advice.",
    "",
    "## Privacy modes",
    "",
    "- aggregate (this server): set by the server operator with WHOOP_MCP_PRIVACY_MODE=aggregate; tool arguments cannot change it. No per-day values, individual records, latest observations, exact activity times or record resources are available.",
    "- standard (the default elsewhere): day-level tools, records, resources and prompts. Aggregate mode reduces disclosure; it is not anonymization. The release lag covers late syncs only: an edit in WHOOP to a released week (e.g. a workout added or deleted) changes its values on the next call, and comparing results before and after the edit reveals that record's contribution to within the rounding step.",
    "",
    "## Rate limits and history loading",
    "",
    "- WHOOP allows an app 100 requests per minute and 10,000 per day. The server paces every WHOOP request of the process (60 per minute by default) and pauses all requests after a 429.",
    "- History is read in 30-day chunks kept in memory within a per-call budget of 60 pages and 20 seconds. A week that could not be read completely is withheld with a note; repeating the call continues from the cache.",
    "",
    "## What the WHOOP API does not provide",
    "",
    "Strength Trainer exercises, sets, repetitions and weights; journal entries; stress; steps; VO2 max; continuous heart rate or HRV time series; body measurement history; WHOOP Sleep Planner and coaching.",
    "",
  ].join("\n");
}

/** The markdown server guide for `mode`. */
export function buildGuideMarkdown(mode: PrivacyMode): string | null {
  return mode === "aggregate" ? aggregateGuide() : standardGuide();
}
