/**
 * Notices withdrawn opt-ins right away.
 *
 * Opt-ins are polled every few minutes. To react to an unlike or unfollow
 * immediately, a second, small Jetstream connection follows the likes and
 * follows of the opted-in accounts only (`dids` filter). A delete event
 * carries no subject, so any deleted like or follow of a watched account
 * triggers a (debounced) opt-in sync, which finds out whether it was the
 * labeler. Following all likes network-wide (~300 events/s) to also catch
 * new opt-ins instantly would cost far more than it is worth.
 */

import type { LiveEvent } from "../ingest/ingester.js";

export const LIKE_COLLECTION = "app.bsky.feed.like";
export const FOLLOW_COLLECTION = "app.bsky.graph.follow";

// Wait before reconnecting after a failed connection
const RETRY_MS = 30_000;

interface Deps {
  // Live likes/follows of the given accounts until the signal aborts
  open: (dids: string[], signal: AbortSignal) => AsyncIterable<LiveEvent>;
  getOptIns: () => Promise<Map<string, string>>;
  // An opted-in account deleted a like or follow
  onWithdrawal: (did: string) => void;
  retryMs?: number;
  log?: Pick<Console, "log" | "warn">;
}

export function createOptInWatch(deps: Deps) {
  const log = deps.log ?? console;
  const retryMs = deps.retryMs ?? RETRY_MS;
  let abort: AbortController | null = null;
  // Sorted DIDs of the running connection, to skip needless reconnects
  let watching = "";

  async function run(dids: string[], signal: AbortSignal) {
    while (!signal.aborted) {
      try {
        for await (const event of deps.open(dids, signal)) {
          if (
            event.kind === "commit" &&
            event.commit.operation === "delete" &&
            (event.commit.collection === LIKE_COLLECTION ||
              event.commit.collection === FOLLOW_COLLECTION)
          ) {
            deps.onWithdrawal(event.did);
          }
        }
      } catch (error) {
        if (signal.aborted) return;
        log.warn(
          "⚠️  Opt-in watch disconnected:",
          error instanceof Error ? error.message : error,
        );
      }
      // The polling sync still covers the gap until the reconnect
      await new Promise((resolve) => setTimeout(resolve, retryMs).unref());
    }
  }

  return {
    /**
     * Watch the current opt-ins; reconnects only when they changed.
     */
    async update(): Promise<void> {
      const dids = [...(await deps.getOptIns()).keys()].sort();
      const key = dids.join(",");
      if (key === watching) return;
      watching = key;
      abort?.abort();
      abort = null;
      if (dids.length === 0) return;
      abort = new AbortController();
      void run(dids, abort.signal);
    },

    stop(): void {
      abort?.abort();
      abort = null;
      watching = "";
    },
  };
}

export type OptInWatch = ReturnType<typeof createOptInWatch>;
