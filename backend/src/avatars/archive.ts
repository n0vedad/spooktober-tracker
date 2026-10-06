/**
 * Archives avatar thumbnails of detected changes.
 *
 * A PDS deletes the old avatar as soon as the profile is saved with a new
 * one; afterwards it is only served while the Bluesky CDN still has it
 * cached. So both avatars of a change are fetched right away: the old one
 * (best effort, from the CDN cache) and the new one (still on the PDS), which
 * makes the next change of the same account reliable.
 */

import type { AvatarThumb } from "./store.js";

// Small CDN variant; plenty for the 56 px avatars of the change cards
export const thumbnailUrl = (did: string, cid: string) =>
  `https://cdn.bsky.app/img/avatar_thumbnail/plain/${did}/${cid}@jpeg`;

// Thumbnails are a few KB; anything far bigger is not what we asked for
const MAX_BYTES = 256 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
const CONCURRENCY = 4;
// Drop work instead of growing without bound if the CDN is slow
const MAX_QUEUE = 1000;

interface Deps {
  has: (did: string, cid: string) => Promise<boolean>;
  save: (did: string, cid: string, thumb: AvatarThumb) => Promise<void>;
  fetch?: typeof fetch;
}

interface AvatarChange {
  did: string;
  old_avatar: string | null;
  new_avatar: string | null;
}

export function createAvatarArchive(deps: Deps) {
  const doFetch = deps.fetch ?? fetch;
  const queue: Array<{ did: string; cid: string }> = [];
  const pending = new Set<string>();
  let active = 0;
  let idleWaiters: Array<() => void> = [];

  const download = async (did: string, cid: string) => {
    if (await deps.has(did, cid)) return;
    const response = await doFetch(thumbnailUrl(did, cid), {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    // Gone from the PDS and the CDN cache: nothing to archive
    if (!response.ok) return;
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.startsWith("image/")) return;
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length === 0 || data.length > MAX_BYTES) return;
    await deps.save(did, cid, { data, content_type: contentType });
  };

  const pump = () => {
    while (active < CONCURRENCY && queue.length > 0) {
      const { did, cid } = queue.shift()!;
      active++;
      download(did, cid)
        .catch((error) => {
          console.warn(
            `⚠️  Could not archive avatar ${cid} of ${did}:`,
            error instanceof Error ? error.message : error,
          );
        })
        .finally(() => {
          active--;
          pending.delete(`${did}/${cid}`);
          pump();
        });
    }
    if (active === 0 && queue.length === 0) {
      const waiters = idleWaiters;
      idleWaiters = [];
      waiters.forEach((resolve) => resolve());
    }
  };

  const enqueue = (did: string, cid: string | null) => {
    if (!cid) return;
    const key = `${did}/${cid}`;
    if (pending.has(key) || queue.length >= MAX_QUEUE) return;
    pending.add(key);
    queue.push({ did, cid });
  };

  return {
    /**
     * Archive the avatars of a change in the background.
     */
    onChange(change: AvatarChange): void {
      if (change.old_avatar === change.new_avatar) return;
      // Old one first: it may drop out of the CDN cache any moment
      enqueue(change.did, change.old_avatar);
      enqueue(change.did, change.new_avatar);
      pump();
    },

    /**
     * Resolves once all queued downloads are done (tests, shutdown).
     */
    idle(): Promise<void> {
      if (active === 0 && queue.length === 0) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    },
  };
}

export type AvatarArchive = ReturnType<typeof createAvatarArchive>;
