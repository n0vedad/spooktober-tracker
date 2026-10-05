/**
 * Handle suggestions from the public Bluesky AppView (no login needed).
 */

const TYPEAHEAD_URL =
  "https://public.api.bsky.app/xrpc/app.bsky.actor.searchActorsTypeahead";

// Suggestions shown at most
export const SUGGESTION_LIMIT = 8;

/**
 * One account suggested while typing a handle.
 */
export interface ActorSuggestion {
  did: string;
  handle: string;
  displayName?: string;
  avatar?: string;
}

/**
 * Search accounts whose handle or name starts with the query.
 *
 * @param query Partial handle (leading "@" is ignored).
 * @param signal Abort signal to cancel outdated requests.
 * @param fetchFn Fetch implementation (injectable for tests).
 * @returns Matching accounts (empty on errors).
 */
export async function searchActors(
  query: string,
  signal?: AbortSignal,
  fetchFn: typeof fetch = fetch,
): Promise<ActorSuggestion[]> {
  const q = query.trim().replace(/^@/, "");
  if (q.length < 2) return [];

  const url = `${TYPEAHEAD_URL}?q=${encodeURIComponent(q)}&limit=${SUGGESTION_LIMIT}`;
  const response = await fetchFn(url, { signal });
  if (!response.ok) return [];

  const data = (await response.json()) as { actors?: ActorSuggestion[] };
  return (data.actors ?? []).map(({ did, handle, displayName, avatar }) => ({
    did,
    handle,
    displayName,
    avatar,
  }));
}
