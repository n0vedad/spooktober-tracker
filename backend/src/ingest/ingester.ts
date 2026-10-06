/**
 * Network-wide ingestion of profile and handle updates from Jetstream v2.
 *
 * Events are processed strictly one after another, and the cursor only
 * advances after an event has been persisted. After a failure the stream is
 * restarted from the last processed event; detection is idempotent, so a
 * replayed event never produces a duplicate change.
 */

import type { RawEvent, RawRecordJson } from "@bsky/jetstream";
import {
  readProfileRecord,
  type createProfileTracker,
  type TrackResult,
} from "./profile-tracker.js";

export const PROFILE_COLLECTION = "app.bsky.actor.profile";

// Raw live event as delivered by `Jetstream.live({ raw: true })`
export type LiveEvent = RawEvent<RawRecordJson>;

/**
 * Opens an event stream starting after `cursor` (or live when undefined).
 */
export type EventSource = (opts: {
  cursor: number | undefined;
  signal: AbortSignal;
}) => AsyncIterable<LiveEvent>;

export interface IngesterDeps {
  source: EventSource;
  tracker: ReturnType<typeof createProfileTracker>;
  // Current handle from the DID document (v2 identity events carry none)
  resolveHandle(did: string): Promise<string | null>;
  loadCursor(): Promise<number | undefined>;
  saveCursor(seq: number): Promise<void>;
  // Minimum time between two cursor writes (default 5s)
  cursorSaveIntervalMs?: number;
  // Delay before restarting after a failure (default: 1s, 2s, 4s ... max 60s)
  retryDelayMs?: (attempt: number) => number;
  log?: Pick<Console, "log" | "warn" | "error">;
}

export interface IngesterStatus {
  running: boolean;
  startedAt: string | null;
  lastSeq: number | null;
  lastEventTime: string | null;
  eventsProcessed: number;
  changesDetected: number;
  consecutiveFailures: number;
}

const defaultRetryDelay = (attempt: number) =>
  Math.min(1000 * 2 ** (attempt - 1), 60_000);

/**
 * Long-running consumer that feeds Jetstream events into the profile tracker.
 */
export class Ingester {
  private abort: AbortController | null = null;
  private loop: Promise<void> | null = null;
  private lastSeq: number | null = null;
  private lastSavedSeq: number | null = null;
  private lastSaveAt = 0;
  private lastEventTime: string | null = null;
  private startedAt: Date | null = null;
  private eventsProcessed = 0;
  private changesDetected = 0;
  private consecutiveFailures = 0;
  private readonly log: Pick<Console, "log" | "warn" | "error">;

  constructor(private readonly deps: IngesterDeps) {
    this.log = deps.log ?? console;
  }

  /**
   * Start consuming in the background.
   *
   * @param cursor Optional start position (v2 seq, or unix microseconds
   *   >= 1e15). Defaults to the persisted cursor, or live when none exists.
   */
  async start(cursor?: number): Promise<void> {
    if (this.loop) return;
    this.lastSeq = cursor ?? (await this.deps.loadCursor()) ?? null;
    this.lastSavedSeq = this.lastSeq;
    this.startedAt = new Date();
    this.abort = new AbortController();
    this.loop = this.run(this.abort.signal);
  }

  /**
   * Stop consuming and persist the cursor of the last processed event.
   */
  async stop(): Promise<void> {
    if (!this.loop) return;
    this.abort?.abort();
    await this.loop;
    this.loop = null;
    this.abort = null;
    this.startedAt = null;
    await this.flushCursor(true);
  }

  /**
   * Snapshot of the ingester state for status endpoints.
   */
  status(): IngesterStatus {
    return {
      running: this.loop !== null,
      startedAt: this.startedAt?.toISOString() ?? null,
      lastSeq: this.lastSeq,
      lastEventTime: this.lastEventTime,
      eventsProcessed: this.eventsProcessed,
      changesDetected: this.changesDetected,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  // Consume until aborted, restarting from the last processed event on failure.
  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const stream = this.deps.source({
          cursor: this.lastSeq ?? undefined,
          signal,
        });
        for await (const event of stream) {
          if (signal.aborted) break;
          await this.process(event);
          this.consecutiveFailures = 0;
        }
        // A live stream only ends when aborted; otherwise reconnect
        if (signal.aborted) break;
        throw new Error("Jetstream stream ended unexpectedly");
      } catch (error) {
        if (signal.aborted) break;
        this.consecutiveFailures++;
        const delay = (this.deps.retryDelayMs ?? defaultRetryDelay)(
          this.consecutiveFailures,
        );
        this.log.error(
          `❌ Ingestion failed (attempt ${this.consecutiveFailures}), restarting in ${delay}ms:`,
          error,
        );
        await sleep(delay, signal);
      }
    }
  }

  // Route one event to the tracker and advance the cursor.
  private async process(event: LiveEvent): Promise<void> {
    let result: TrackResult | null = null;

    if (event.kind === "commit") {
      const { commit } = event;
      if (commit.collection === PROFILE_COLLECTION && commit.rkey === "self") {
        const record =
          commit.operation === "delete" ? undefined : commit.record;
        result = await this.deps.tracker.trackProfile({
          did: event.did,
          seq: event.seq,
          time: new Date(event.time),
          ...readProfileRecord(record),
        });
      }
    } else if (event.kind === "identity") {
      const handle = await this.handleFor(event.did, event.identity.handle);
      if (handle) {
        result = await this.deps.tracker.trackHandle({
          did: event.did,
          seq: event.seq,
          time: new Date(event.time),
          handle,
        });
      }
    }

    if (result === "changed") this.changesDetected++;
    this.eventsProcessed++;
    this.lastSeq = event.seq;
    this.lastEventTime = event.time;
    await this.flushCursor(false);
  }

  // Handle from the event, else from the DID document. A failed lookup only
  // skips this identity event instead of stalling the whole stream.
  private async handleFor(
    did: string,
    announced: string | undefined,
  ): Promise<string | null> {
    if (announced) return announced;
    try {
      return await this.deps.resolveHandle(did);
    } catch (error) {
      this.log.warn(
        `⚠️  Could not resolve handle for ${did}: ${error instanceof Error ? error.message : error}`,
      );
      return null;
    }
  }

  // Persist the cursor, at most once per interval unless forced.
  private async flushCursor(force: boolean): Promise<void> {
    if (this.lastSeq === null || this.lastSeq === this.lastSavedSeq) return;
    const interval = this.deps.cursorSaveIntervalMs ?? 5000;
    if (!force && Date.now() - this.lastSaveAt < interval) return;
    await this.deps.saveCursor(this.lastSeq);
    this.lastSavedSeq = this.lastSeq;
    this.lastSaveAt = Date.now();
  }
}

// Resolve after `ms`, or immediately when the signal aborts.
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
