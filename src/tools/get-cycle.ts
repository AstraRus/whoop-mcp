/**
 * Tool: get_cycle_collection
 *
 * Fetches paginated physiological cycles for a date range.
 * Returns strain, calories, and heart rate data per cycle.
 *
 * When a date in start or end depends on the user's local day and the user's
 * time zone could not be read from WHOOP, UTC days are used and the result
 * carries notes with UTC_OFFSET_FALLBACK_NOTE.
 */

import type { WhoopClient } from "../api/client.js";
import type { CycleCollection } from "../api/types.js";
import { ENDPOINT_CYCLE } from "../api/endpoints.js";
import {
  buildCollectionQuery,
  dependsOnLocalDay,
  resolveUserUtcOffsetInfo,
  UTC_OFFSET_FALLBACK_NOTE,
} from "./collection-utils.js";
import type { CollectionParams } from "./collection-utils.js";

/**
 * Get physiological cycles for a date range.
 *
 * @param client - Authenticated WHOOP API client
 * @param params - Optional filtering: start, end, limit, nextToken
 * @returns Paginated physiological collection, with notes when UTC days were used as a fallback
 */
export async function getCycleCollection(
  client: WhoopClient,
  params: CollectionParams
): Promise<CycleCollection & { notes?: string[] }> {
  const local = dependsOnLocalDay(params.start) || dependsOnLocalDay(params.end);
  const { offset, fallback } = local
    ? await resolveUserUtcOffsetInfo(client)
    : { offset: "Z", fallback: false };
  const query = buildCollectionQuery(params, offset);
  const page = await client.get<CycleCollection>(`${ENDPOINT_CYCLE}${query}`);
  return fallback ? { ...page, notes: [UTC_OFFSET_FALLBACK_NOTE] } : page;
}
