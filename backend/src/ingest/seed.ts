/**
 * Seed baseline snapshots from AppView profile views.
 *
 * Jetstream only delivers new states, so the first change of an account
 * nobody has seen before cannot be detected. Accounts someone cares about
 * (logged-in users, opted-in accounts, their follows and bubbles) are
 * therefore seeded from profile data the AppView already returned.
 */

import { retryDelay } from "../bubble/follow-lists.js";
import { seedSnapshots, type ProfileSnapshot } from "../db.js";
import { fetchWithTimeout } from "../utils/fetch-with-timeout.js";

const GET_PROFILES_URL =
  "https://public.api.bsky.app/xrpc/app.bsky.actor.getProfiles";
// Retries of a rate-limited or failing getProfiles request
const MAX_RETRIES = 4;

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The fields of an AppView profile view (profileView/profileViewDetailed)
 * needed for a snapshot.
 */
export interface ProfileViewLike {
  did: string;
  handle?: string;
  displayName?: string;
  avatar?: string;
}

/**
 * Extract the blob CID from an AppView avatar URL
 * (https://cdn.bsky.app/img/avatar/plain/<did>/<cid>[@jpeg]).
 *
 * @param url Avatar URL, if any.
 * @returns The CID, or null.
 */
export function avatarCidFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  const last = new URL(url).pathname.split("/").at(-1) ?? "";
  const cid = last.split("@")[0];
  return /^ba[a-z2-7]+$/.test(cid) ? cid : null;
}

/**
 * Convert a profile view into a baseline snapshot.
 *
 * @param view AppView profile view.
 * @returns Snapshot (normalised like Jetstream records: empty = null).
 */
export function snapshotFromView(view: ProfileViewLike): ProfileSnapshot {
  return {
    did: view.did,
    handle:
      view.handle && view.handle !== "handle.invalid" ? view.handle : null,
    display_name: view.displayName ? view.displayName : null,
    avatar_cid: avatarCidFromUrl(view.avatar),
    profile_seen: true,
  };
}

/**
 * Load profile views of up to 25 accounts per request. Rate limits (429)
 * and server errors are retried.
 *
 * @param dids Accounts to load.
 * @param fetchFn Fetch implementation (tests).
 * @param sleep Wait between retries (tests).
 * @returns Profile views of the accounts that exist.
 */
export async function fetchProfiles(
  dids: readonly string[],
  fetchFn: typeof fetchWithTimeout = fetchWithTimeout,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<ProfileViewLike[]> {
  const views: ProfileViewLike[] = [];
  for (let i = 0; i < dids.length; i += 25) {
    const url = new URL(GET_PROFILES_URL);
    for (const did of dids.slice(i, i + 25)) {
      url.searchParams.append("actors", did);
    }
    let response: Response;
    for (let attempt = 0; ; attempt++) {
      response = await fetchFn(url.toString());
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt >= MAX_RETRIES) break;
      await sleep(
        response.status === 429 ? retryDelay(response) : 1000 * 2 ** attempt,
      );
    }
    if (!response.ok) throw new Error(`getProfiles failed: ${response.status}`);
    const data = (await response.json()) as { profiles: ProfileViewLike[] };
    views.push(...data.profiles);
  }
  return views;
}

/**
 * Seed the given profile views, logging instead of throwing (seeding is an
 * optimisation and must never break the caller).
 *
 * @param views Profile views from any AppView response.
 */
export async function seedFromViews(
  views: readonly ProfileViewLike[],
): Promise<void> {
  try {
    await seedSnapshots(views.map(snapshotFromView));
  } catch (error) {
    console.warn("⚠️  Could not seed profile snapshots:", error);
  }
}

/**
 * Seed accounts by DID (one getProfiles request per 25 accounts).
 *
 * @param dids Accounts to seed.
 */
export async function seedAccounts(dids: readonly string[]): Promise<void> {
  try {
    await seedFromViews(await fetchProfiles(dids));
  } catch (error) {
    console.warn("⚠️  Could not load profiles to seed:", error);
  }
}
