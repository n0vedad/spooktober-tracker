/**
 * Fetch complete follow lists from the public Bluesky AppView.
 */

import type { ProfileViewLike } from "../ingest/seed.js";
import { fetchWithTimeout } from "../utils/fetch-with-timeout.js";

const GET_FOLLOWS_URL =
  "https://public.api.bsky.app/xrpc/app.bsky.graph.getFollows";

// Safety stop against endless pagination (100 follows per page)
const MAX_PAGES = 1000;
// Retries per page after rate limiting or transient server errors
const MAX_RETRIES = 5;
// Wait time when a rate-limited response names no reset time
const DEFAULT_RETRY_MS = 10_000;

export interface FetchFollowListDeps {
  fetchFn?: typeof fetchWithTimeout;
  sleep?: (ms: number) => Promise<void>;
  // Receives the profile views of each page (used to seed snapshots)
  onPage?: (follows: ProfileViewLike[]) => Promise<void> | void;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * How long to wait before retrying a rate-limited request.
 *
 * @param response The 429 response.
 * @returns Delay in milliseconds.
 */
function retryDelay(response: Response): number {
  // Bluesky sends `ratelimit-reset` (unix seconds); Retry-After is the HTTP standard
  const reset = Number(response.headers.get("ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) {
    return Math.max(1000, reset * 1000 - Date.now());
  }
  const retryAfter = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
  return DEFAULT_RETRY_MS;
}

/**
 * Fetch every account a DID follows.
 *
 * @param did Account whose follows to load.
 * @param deps Optional fetch/sleep implementations (tests).
 * @returns DIDs of all followed accounts; empty for deleted/unknown accounts.
 * @throws When the API keeps failing, so incomplete lists are never cached.
 */
export async function fetchFollowList(
  did: string,
  deps: FetchFollowListDeps = {},
): Promise<string[]> {
  const fetchFn = deps.fetchFn ?? fetchWithTimeout;
  const sleep = deps.sleep ?? defaultSleep;
  const follows: string[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(GET_FOLLOWS_URL);
    url.searchParams.set("actor", did);
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("cursor", cursor);

    let response: Response | undefined;
    for (let attempt = 0; ; attempt++) {
      response = await fetchFn(url.toString(), {
        headers: { Accept: "application/json" },
      });
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt >= MAX_RETRIES) break;
      await sleep(
        response.status === 429 ? retryDelay(response) : 1000 * 2 ** attempt,
      );
    }

    // Deleted, deactivated or unknown accounts follow nobody we can see
    if (response.status === 400 || response.status === 404) return follows;
    if (!response.ok) {
      throw new Error(
        `getFollows failed for ${did}: ${response.status} ${response.statusText}`,
      );
    }

    const data = (await response.json()) as {
      follows: ProfileViewLike[];
      cursor?: string;
    };
    for (const follow of data.follows) follows.push(follow.did);
    await deps.onPage?.(data.follows);

    if (!data.cursor || data.follows.length === 0) return follows;
    cursor = data.cursor;
  }

  console.warn(`⚠️  Follow list of ${did} truncated at ${follows.length}`);
  return follows;
}
