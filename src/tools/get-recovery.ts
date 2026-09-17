/**
 * Tool: get_recovery_collection
 *
 * Fetches paginated recovery scores for a date range.
 * Returns HRV, resting heart rate, SpO2, and skin temp for each day.
 *
 * When a date in start or end depends on the user's local day and the user's
 * time zone could not be read from WHOOP, UTC days are used and the result
 * carries notes with UTC_OFFSET_FALLBACK_NOTE.
 */

import type { WhoopClient } from "../api/client.js";
import type { RecoveryCollection } from "../api/types.js";
import { ENDPOINT_RECOVERY } from "../api/endpoints.js";
import {
  buildCollectionQuery,
  dependsOnLocalDay,
  resolveUserUtcOffsetInfo,
  UTC_OFFSET_FALLBACK_NOTE,
} from "./collection-utils.js";
import type { CollectionParams } from "./collection-utils.js";

/**
 * Get recovery scores for a date range.
 *
 * @param client - Authenticated WHOOP API client
 * @param params - Optional filtering: start, end, limit, nextToken
 * @returns Paginated recovery collection, with notes when UTC days were used as a fallback
 */
export async function getRecoveryCollection(
  client: WhoopClient,
  params: CollectionParams
): Promise<RecoveryCollection & { notes?: string[] }> {
  const local = dependsOnLocalDay(params.start) || dependsOnLocalDay(params.end);
  const { offset, fallback } = local
    ? await resolveUserUtcOffsetInfo(client)
    : { offset: "Z", fallback: false };
  const query = buildCollectionQuery(params, offset);
  const page = await client.get<RecoveryCollection>(`${ENDPOINT_RECOVERY}${query}`);
  return fallback ? { ...page, notes: [UTC_OFFSET_FALLBACK_NOTE] } : page;
}
