import { describe, it, expect, vi } from "vitest";
import { getWorkoutCollection } from "../../src/tools/get-workout.js";
import type { WorkoutCollection } from "../../src/api/types.js";
import { ENDPOINT_WORKOUT } from "../../src/api/endpoints.js";
import { createMockClient } from "../helpers/mock-client.js";
import { WhoopApiError, type WhoopClient } from "../../src/api/client.js";
import { UTC_OFFSET_FALLBACK_NOTE } from "../../src/tools/collection-utils.js";
import { connectServer } from "../helpers/contract.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WORKOUT_FIXTURE: WorkoutCollection = {
  records: [
    {
      id: "workout-1",
      user_id: 12345,
      created_at: "2026-04-10T18:00:00.000Z",
      updated_at: "2026-04-10T19:00:00.000Z",
      start: "2026-04-10T17:00:00.000Z",
      end: "2026-04-10T18:00:00.000Z",
      timezone_offset: "-04:00",
      sport_name: "Running",
      score_state: "SCORED",
      sport_id: 63,
      score: {
        strain: 14.2,
        average_heart_rate: 155,
        max_heart_rate: 182,
        kilojoule: 2100,
        percent_recorded: 100,
        zone_durations: {
          zone_zero_milli: 0,
          zone_one_milli: 120000,
          zone_two_milli: 600000,
          zone_three_milli: 1200000,
          zone_four_milli: 900000,
          zone_five_milli: 180000,
        },
        distance_meter: 8500,
        altitude_gain_meter: 45,
        altitude_change_meter: 2,
      },
    },
  ],
  next_token: "workout-page-2",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getWorkoutCollection", () => {
  it("calls the workout endpoint with no query params when none provided", async () => {
    const client = createMockClient(WORKOUT_FIXTURE);

    await getWorkoutCollection(client, {});

    expect(client.get).toHaveBeenCalledWith(ENDPOINT_WORKOUT);
  });

  it("includes all params in query string when all provided", async () => {
    const client = createMockClient(WORKOUT_FIXTURE);

    await getWorkoutCollection(client, {
      start: "2026-04-01T00:00:00.000Z",
      end: "2026-04-10T00:00:00.000Z",
      limit: 20,
      nextToken: "page3",
    });

    const calledPath = (client.get as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    const url = new URL(calledPath, "https://placeholder.test");

    expect(url.pathname).toBe(ENDPOINT_WORKOUT);
    expect(url.searchParams.get("start")).toBe("2026-04-01T00:00:00.000Z");
    expect(url.searchParams.get("end")).toBe("2026-04-10T00:00:00.000Z");
    expect(url.searchParams.get("limit")).toBe("20");
    expect(url.searchParams.get("nextToken")).toBe("page3");
  });

  it("omits undefined params from query string", async () => {
    const client = createMockClient(WORKOUT_FIXTURE);

    await getWorkoutCollection(client, { limit: 5 });

    const calledPath = (client.get as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;

    expect(calledPath).not.toContain("start");
    expect(calledPath).not.toContain("end");
    expect(calledPath).not.toContain("nextToken");
  });

  it("returns the workout collection from the API", async () => {
    const client = createMockClient(WORKOUT_FIXTURE);

    const result = await getWorkoutCollection(client, {});

    expect(result).toEqual(WORKOUT_FIXTURE);
  });

  it("propagates API errors", async () => {
    const client = createMockClient(undefined);
    (client.get as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("WHOOP API error: 503 Service Unavailable")
    );

    await expect(getWorkoutCollection(client, {})).rejects.toThrow(
      "WHOOP API error: 503 Service Unavailable"
    );
  });
});

describe("getWorkoutCollection — UTC fallback note", () => {
  /** A client whose offset lookup (/v2/cycle?limit=1) fails and whose collection returns one empty page. */
  function lookupFailing(): WhoopClient & { paths: string[] } {
    const paths: string[] = [];
    return {
      paths,
      get: vi.fn(async (path: string) => {
        paths.push(path);
        if (path === "/v2/cycle?limit=1") throw new WhoopApiError(401, "Unauthorized", null);
        return { records: [], next_token: null };
      }),
    } as unknown as WhoopClient & { paths: string[] };
  }

  it("adds the UTC fallback note when a local-day date is read in UTC", async () => {
    const client = lookupFailing();

    const result = await getWorkoutCollection(client, { start: "2026-09-14", end: "2026-09-14" });

    expect(result.notes).toEqual([UTC_OFFSET_FALLBACK_NOTE]);
    const dataPath = client.paths.find(
      (path) => path.startsWith(`${ENDPOINT_WORKOUT}?`) && path.includes("start=")
    )!;
    const query = new URLSearchParams(dataPath.split("?")[1]);
    expect(query.get("start")).toBe("2026-09-14T00:00:00.000Z");
    expect(query.get("end")).toBe("2026-09-14T23:59:59.999Z");
  });

  it("adds no note for zoned date-times, which need no time zone lookup", async () => {
    const client = lookupFailing();

    const result = await getWorkoutCollection(client, { start: "2026-09-14T00:00:00+02:00" });

    expect(result).not.toHaveProperty("notes");
    expect(client.paths).toHaveLength(1);
  });

  it("adds no note when the user's time zone is read from WHOOP", async () => {
    const client = {
      get: vi.fn(async (path: string) =>
        path === "/v2/cycle?limit=1"
          ? { records: [{ timezone_offset: "+02:00" }], next_token: null }
          : { records: [], next_token: null }
      ),
    } as unknown as WhoopClient;

    const result = await getWorkoutCollection(client, { start: "yesterday" });

    expect(result).not.toHaveProperty("notes");
  });

  it("keeps the note in the get_workout_collection output contract", async () => {
    const connection = await connectServer(lookupFailing(), { disableResources: true });
    try {
      const result = await connection.callTool("get_workout_collection", { start: "today" });
      expect(result.isError, result.text).toBe(false);
      expect(result.structured).toEqual({
        records: [],
        next_token: null,
        notes: [UTC_OFFSET_FALLBACK_NOTE],
      });
    } finally {
      await connection.close();
    }
  });
});
