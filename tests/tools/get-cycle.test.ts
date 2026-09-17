import { describe, it, expect, vi } from "vitest";
import { getCycleCollection } from "../../src/tools/get-cycle.js";
import type { CycleCollection } from "../../src/api/types.js";
import { ENDPOINT_CYCLE } from "../../src/api/endpoints.js";
import { createMockClient } from "../helpers/mock-client.js";
import { WhoopApiError, type WhoopClient } from "../../src/api/client.js";
import { UTC_OFFSET_FALLBACK_NOTE } from "../../src/tools/collection-utils.js";
import { connectServer } from "../helpers/contract.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CYCLE_FIXTURE: CycleCollection = {
  records: [
    {
      id: 200,
      user_id: 12345,
      created_at: "2026-04-10T00:00:00.000Z",
      updated_at: "2026-04-10T23:59:59.000Z",
      start: "2026-04-10T00:00:00.000Z",
      end: "2026-04-10T23:59:59.000Z",
      timezone_offset: "-04:00",
      score_state: "SCORED",
      score: {
        strain: 12.5,
        kilojoule: 9500,
        average_heart_rate: 68,
        max_heart_rate: 182,
      },
    },
  ],
  next_token: "cycle-page-2",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getCycleCollection", () => {
  it("calls the cycle endpoint with no query params when none provided", async () => {
    const client = createMockClient(CYCLE_FIXTURE);

    await getCycleCollection(client, {});

    expect(client.get).toHaveBeenCalledWith(ENDPOINT_CYCLE);
  });

  it("includes all params in query string when all provided", async () => {
    const client = createMockClient(CYCLE_FIXTURE);

    await getCycleCollection(client, {
      start: "2026-04-01T00:00:00.000Z",
      end: "2026-04-10T00:00:00.000Z",
      limit: 10,
      nextToken: "next-page",
    });

    const calledPath = (client.get as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    const url = new URL(calledPath, "https://placeholder.test");

    expect(url.pathname).toBe(ENDPOINT_CYCLE);
    expect(url.searchParams.get("start")).toBe("2026-04-01T00:00:00.000Z");
    expect(url.searchParams.get("end")).toBe("2026-04-10T00:00:00.000Z");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.get("nextToken")).toBe("next-page");
  });

  it("omits undefined params from query string", async () => {
    const client = createMockClient(CYCLE_FIXTURE);

    await getCycleCollection(client, { end: "2026-04-10T00:00:00.000Z" });

    const calledPath = (client.get as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;

    expect(calledPath).not.toContain("start");
    expect(calledPath).not.toContain("limit");
    expect(calledPath).not.toContain("nextToken");
  });

  it("returns the cycle collection from the API", async () => {
    const client = createMockClient(CYCLE_FIXTURE);

    const result = await getCycleCollection(client, {});

    expect(result).toEqual(CYCLE_FIXTURE);
  });

  it("propagates API errors", async () => {
    const client = createMockClient(undefined);
    (client.get as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("WHOOP API error: 404 Not Found")
    );

    await expect(getCycleCollection(client, {})).rejects.toThrow("WHOOP API error: 404 Not Found");
  });
});

describe("getCycleCollection — UTC fallback note", () => {
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

    const result = await getCycleCollection(client, { start: "2026-09-14", end: "2026-09-14" });

    expect(result.notes).toEqual([UTC_OFFSET_FALLBACK_NOTE]);
    const dataPath = client.paths.find(
      (path) => path.startsWith(`${ENDPOINT_CYCLE}?`) && path.includes("start=")
    )!;
    const query = new URLSearchParams(dataPath.split("?")[1]);
    expect(query.get("start")).toBe("2026-09-14T00:00:00.000Z");
    expect(query.get("end")).toBe("2026-09-14T23:59:59.999Z");
  });

  it("adds no note for zoned date-times, which need no time zone lookup", async () => {
    const client = lookupFailing();

    const result = await getCycleCollection(client, { start: "2026-09-14T00:00:00+02:00" });

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

    const result = await getCycleCollection(client, { start: "yesterday" });

    expect(result).not.toHaveProperty("notes");
  });

  it("keeps the note in the get_cycle_collection output contract", async () => {
    const connection = await connectServer(lookupFailing(), { disableResources: true });
    try {
      const result = await connection.callTool("get_cycle_collection", { start: "today" });
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
