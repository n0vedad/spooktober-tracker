/**
 * Opt-in tracking: accounts that like or follow the labeler agree to be
 * labeled. Both are public, so they are polled from the public AppView
 * (labeler subscriptions themselves are private preferences).
 */

import { fetchWithTimeout } from "../utils/fetch-with-timeout.js";
import type { Labeler } from "./service.js";

const APPVIEW = "https://public.api.bsky.app/xrpc";
// Safety stop for pagination (100 entries per page)
const MAX_PAGES = 1000;

/**
 * Collect every page of a paginated AppView list.
 *
 * @param url Endpoint URL with fixed query parameters.
 * @param pick Extracts the DIDs and cursor from one page.
 * @param fetchFn Fetch implementation (tests).
 * @returns All DIDs.
 * @throws On any failed page, so a partial list is never mistaken for opt-outs.
 */
async function collectPages(
  url: URL,
  pick: (data: any) => { dids: string[]; cursor?: string },
  fetchFn: typeof fetchWithTimeout,
): Promise<string[]> {
  const dids: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const pageUrl = new URL(url);
    pageUrl.searchParams.set("limit", "100");
    if (cursor) pageUrl.searchParams.set("cursor", cursor);
    const response = await fetchFn(pageUrl.toString());
    if (!response.ok) {
      throw new Error(`${url.pathname} failed: ${response.status}`);
    }
    const result = pick(await response.json());
    dids.push(...result.dids);
    if (!result.cursor || result.dids.length === 0) return dids;
    cursor = result.cursor;
  }
  return dids;
}

/**
 * Accounts following the labeler account.
 */
export function fetchFollowers(
  labelerDid: string,
  fetchFn: typeof fetchWithTimeout = fetchWithTimeout,
): Promise<string[]> {
  const url = new URL(`${APPVIEW}/app.bsky.graph.getFollowers`);
  url.searchParams.set("actor", labelerDid);
  return collectPages(
    url,
    (data) => ({
      dids: (data.followers ?? []).map((f: { did: string }) => f.did),
      cursor: data.cursor,
    }),
    fetchFn,
  );
}

/**
 * Accounts that liked the labeler (its app.bsky.labeler.service record).
 */
export function fetchLikers(
  labelerDid: string,
  fetchFn: typeof fetchWithTimeout = fetchWithTimeout,
): Promise<string[]> {
  const url = new URL(`${APPVIEW}/app.bsky.feed.getLikes`);
  url.searchParams.set(
    "uri",
    `at://${labelerDid}/app.bsky.labeler.service/self`,
  );
  return collectPages(
    url,
    (data) => ({
      dids: (data.likes ?? []).map(
        (l: { actor: { did: string } }) => l.actor.did,
      ),
      cursor: data.cursor,
    }),
    fetchFn,
  );
}

export interface OptInSyncDeps {
  labeler: Pick<Labeler, "did" | "onOptIn" | "onOptOut">;
  fetchFollowers: (did: string) => Promise<string[]>;
  fetchLikers: (did: string) => Promise<string[]>;
  getOptIns: () => Promise<Map<string, string>>;
  saveOptIn: (did: string, via: string) => Promise<void>;
  removeOptIn: (did: string) => Promise<void>;
  // Called for every new opt-in (e.g. to precompute the account's bubble)
  onNewOptIn?: (did: string) => void;
  log?: Pick<Console, "log" | "warn" | "error">;
}

/**
 * Create the opt-in synchronisation.
 *
 * @param deps Fetchers, storage and labeler.
 * @returns `sync()` for one pass, `start()`/`stop()` for periodic polling.
 */
export function createOptInSync(deps: OptInSyncDeps) {
  const log = deps.log ?? console;
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;

  async function syncOnce(): Promise<void> {
    const [followers, likers] = await Promise.all([
      deps.fetchFollowers(deps.labeler.did),
      deps.fetchLikers(deps.labeler.did),
    ]);

    const current = new Map<string, string>();
    for (const did of followers) current.set(did, "follow");
    for (const did of likers) {
      current.set(did, current.has(did) ? "like+follow" : "like");
    }
    current.delete(deps.labeler.did);

    const previous = await deps.getOptIns();

    // An empty answer while many had opted in is far more likely an API
    // glitch than everyone leaving at once; never mass-retract on it
    if (current.size === 0 && previous.size > 5) {
      log.warn("⚠️  Opt-in sync returned no accounts; keeping previous state");
      return;
    }

    for (const [did, via] of current) {
      const before = previous.get(did);
      if (before === via) continue;
      await deps.saveOptIn(did, via);
      if (before === undefined) {
        log.log(`🎃 Opt-in (${via}): ${did}`);
        deps.onNewOptIn?.(did);
        await deps.labeler.onOptIn(did);
      }
    }
    for (const did of previous.keys()) {
      if (current.has(did)) continue;
      log.log(`👋 Opt-out: ${did}`);
      await deps.removeOptIn(did);
      await deps.labeler.onOptOut(did);
    }
  }

  /**
   * Run one synchronisation (concurrent calls share the running pass).
   */
  function sync(): Promise<void> {
    running ??= syncOnce().finally(() => {
      running = null;
    });
    return running;
  }

  function start(intervalMs: number) {
    const tick = () =>
      sync().catch((error) => log.error("❌ Opt-in sync failed:", error));
    void tick();
    timer = setInterval(tick, intervalMs);
    timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { sync, start, stop };
}
