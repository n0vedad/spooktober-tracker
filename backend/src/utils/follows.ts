/**
 * Bluesky follows fetcher utilities.
 *
 * Provides helpers to load a user's follows from the public Bluesky API,
 * including a batched variant for multiple users. Kept separate from the
 * Jetstream service to improve cohesion and testability.
 */

import { fetchWithTimeout } from "./fetch-with-timeout.js";
import { resolveHandle } from "./handle-resolver.js";

/**
 * Minimal follow record (DID + handle [+ optional rkey]) used internally
 * when fetching and persisting follows for monitoring.
 */
export interface Follow {
  did: string;
  handle: string;
  rkey?: string;
}

/**
 * Subset of app.bsky.graph.getFollows response consumed by the fetcher.
 * Includes the follow items and a pagination cursor when more pages exist.
 */
interface GetFollowsResponse {
  follows: Array<{
    did: string;
    handle: string;
  }>;
  cursor?: string;
}

/**
 * Fetch all follows for a given DID from the Bluesky API.
 *
 * @param userDID The DID of the user whose follows to fetch.
 * @returns Array of follows (did + handle).
 */
export async function fetchFollowsFromBluesky(
  userDID: string,
): Promise<Follow[]> {
  const follows: Follow[] = [];
  let cursor: string | undefined;

  // Safety limit (100 pages = ~10,000 follows)
  const maxIterations = 100;
  let iterations = 0;

  try {
    while (iterations < maxIterations) {
      iterations++;

      // Build URL for app.bsky.graph.getFollows
      const url = new URL(
        "https://public.api.bsky.app/xrpc/app.bsky.graph.getFollows",
      );
      url.searchParams.set("actor", userDID);
      url.searchParams.set("limit", "100"); // Max allowed by API

      // Include pagination cursor when available to continue listing
      if (cursor) {
        url.searchParams.set("cursor", cursor);
      }

      // Fetch a page of follows with timeout protection (expects JSON)
      const response = await fetchWithTimeout(url.toString(), {
        headers: {
          Accept: "application/json",
        },
      });

      // Abort pagination and log when the API responds with an error
      if (!response.ok) {
        console.error(
          `❌ Failed to fetch follows for ${userDID}: ${response.status} ${response.statusText}`,
        );
        break;
      }

      const data = (await response.json()) as GetFollowsResponse;

      // Add follows to array
      for (const follow of data.follows) {
        follows.push({
          did: follow.did,
          handle: follow.handle,
        });
      }

      // Check if there are more pages
      if (!data.cursor) {
        break; // No more pages
      }
      cursor = data.cursor;
    }

    // Resolve user's handle for clearer logging (best-effort)
    const userHandle = await resolveHandle(userDID);
    // Log a concise summary including resolved handle when available
    console.log(
      `✅ Fetched ${follows.length} follows for ${userDID}${userHandle ? ` (@${userHandle})` : ""}`,
    );

    // Return the aggregated list of follows collected across pages
    return follows;
  } catch (error) {
    console.error(`❌ Error fetching follows for ${userDID}:`, error);
    return follows; // Return what we have so far
  }
}

/**
 * Fetch follows for multiple users in parallel.
 *
 * @param userDIDs Array of user DIDs to fetch follows for.
 * @returns Map of userDID -> follows array.
 */
export async function fetchFollowsForUsers(
  userDIDs: string[],
): Promise<Map<string, Follow[]>> {
  const results = new Map<string, Follow[]>();

  // Fetch all follows in parallel
  const promises = userDIDs.map(async (userDID) => {
    const follows = await fetchFollowsFromBluesky(userDID);
    results.set(userDID, follows);
  });

  await Promise.all(promises);
  return results;
}
