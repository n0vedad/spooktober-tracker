/**
 * Background computation of users' bubbles.
 *
 * Loading the follow list of every account a user follows takes thousands of
 * API requests, so it runs as a background job with progress reporting.
 * Follow lists are cached and shared between users.
 */

import { computeBubble } from "./compute.js";

// Cached follow lists and computed bubbles are refreshed after this time
export const BUBBLE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Parallel follow-list requests across all running jobs
const DEFAULT_CONCURRENCY = 8;

export interface BubbleServiceDeps {
  fetchFollowList(did: string): Promise<string[]>;
  getCachedFollowLists(
    dids: readonly string[],
    maxAgeMs: number,
  ): Promise<Map<string, string[]>>;
  saveFollowList(did: string, follows: readonly string[]): Promise<void>;
  getBubbleInfo(
    userDid: string,
  ): Promise<{ followsCount: number; computedAt: Date } | null>;
  saveBubble(
    userDid: string,
    followsCount: number,
    members: ReturnType<typeof computeBubble>,
  ): Promise<void>;
  // Called with the user, their follows and bubble members once saved
  onSaved?(userDid: string, dids: string[]): void;
  concurrency?: number;
  maxAgeMs?: number;
  log?: Pick<Console, "log" | "warn" | "error">;
}

/**
 * Bubble state of a user as reported to the frontend.
 */
export type BubbleStatus =
  | { state: "ready"; followsCount: number; computedAt: string }
  | {
      state: "computing";
      done: number;
      total: number;
      // Previous bubble stays usable while it is being refreshed
      previous: { followsCount: number; computedAt: string } | null;
    }
  | {
      state: "failed";
      error: string;
      // The last bubble stays usable when only its refresh failed
      previous: { followsCount: number; computedAt: string } | null;
    };

interface Job {
  done: number;
  total: number;
  promise: Promise<void>;
}

/**
 * Minimal promise-based semaphore limiting concurrent work.
 */
function createLimiter(max: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((r) => waiting.push(r));
    active++;
    try {
      return await task();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

/**
 * Create the bubble service.
 *
 * @param deps Fetching and storage operations.
 * @returns Functions to query and trigger bubble computations.
 */
export function createBubbleService(deps: BubbleServiceDeps) {
  const maxAgeMs = deps.maxAgeMs ?? BUBBLE_MAX_AGE_MS;
  const log = deps.log ?? console;
  const limit = createLimiter(deps.concurrency ?? DEFAULT_CONCURRENCY);
  const jobs = new Map<string, Job>();
  const failures = new Map<string, string>();

  // Cached follow list, or a fresh one from the API (then cached)
  async function loadFollowList(
    did: string,
    cached: Map<string, string[]>,
  ): Promise<string[]> {
    const hit = cached.get(did);
    if (hit) return hit;
    const follows = await limit(() => deps.fetchFollowList(did));
    await deps.saveFollowList(did, follows);
    return follows;
  }

  async function compute(userDid: string, job: Job): Promise<void> {
    const startedAt = Date.now();
    const own = await loadFollowList(
      userDid,
      await deps.getCachedFollowLists([userDid], maxAgeMs),
    );
    const follows = [...new Set(own)].filter((did) => did !== userDid);
    job.total = follows.length;

    const cached = await deps.getCachedFollowLists(follows, maxAgeMs);
    const lists = new Map<string, string[]>();
    let skipped = 0;

    await Promise.all(
      follows.map(async (did) => {
        try {
          lists.set(did, await loadFollowList(did, cached));
        } catch (error) {
          // One unreachable account must not fail the whole bubble
          skipped++;
          log.warn(`⚠️  Skipping follow list of ${did}:`, error);
        } finally {
          job.done++;
        }
      }),
    );

    // Accounts whose list failed still count as direct follows
    for (const did of follows) if (!lists.has(did)) lists.set(did, []);

    const members = computeBubble(userDid, lists);
    await deps.saveBubble(userDid, follows.length, members);
    deps.onSaved?.(userDid, [
      userDid,
      ...follows,
      ...members.map((m) => m.did),
    ]);
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    log.log(
      `🫧 Bubble for ${userDid}: ${members.length} accounts from ${follows.length} follows in ${seconds}s` +
        (skipped ? ` (${skipped} lists skipped)` : ""),
    );
  }

  /**
   * Current bubble state of a user.
   */
  async function status(userDid: string): Promise<BubbleStatus | null> {
    const info = await deps.getBubbleInfo(userDid);
    const previous = info
      ? {
          followsCount: info.followsCount,
          computedAt: info.computedAt.toISOString(),
        }
      : null;

    const job = jobs.get(userDid);
    if (job) {
      return { state: "computing", done: job.done, total: job.total, previous };
    }
    if (failures.has(userDid)) {
      return { state: "failed", error: failures.get(userDid)!, previous };
    }
    return previous ? { state: "ready", ...previous } : null;
  }

  /**
   * Start computing a user's bubble unless a fresh one exists or a job runs.
   *
   * @param userDid User DID.
   * @param force Recompute even if the stored bubble is fresh.
   * @returns The bubble state after the call.
   */
  async function ensure(userDid: string, force = false): Promise<BubbleStatus> {
    if (!jobs.has(userDid)) {
      const info = await deps.getBubbleInfo(userDid);
      const fresh =
        info !== null && Date.now() - info.computedAt.getTime() < maxAgeMs;

      // A failed run is retried on the next call, even with a fresh bubble
      if (force || !fresh || failures.has(userDid)) {
        failures.delete(userDid);
        const job: Job = { done: 0, total: 0, promise: Promise.resolve() };
        jobs.set(userDid, job);
        job.promise = compute(userDid, job)
          .catch((error) => {
            log.error(`❌ Bubble computation failed for ${userDid}:`, error);
            failures.set(userDid, "Could not load your network");
          })
          .finally(() => jobs.delete(userDid));
      }
    }
    return (await status(userDid))!;
  }

  /**
   * Wait for a running computation (tests and graceful shutdown).
   */
  async function settle(userDid: string): Promise<void> {
    await jobs.get(userDid)?.promise;
  }

  return { ensure, status, settle };
}
