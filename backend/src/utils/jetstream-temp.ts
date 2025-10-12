/**
 * Temporary Jetstream streaming utilities.
 *
 * Exposes a factory to create a TemporaryJetstreamManager that coordinates
 * short‑lived backfill streams per user. All external behaviors are injected
 * via dependencies to avoid circular imports with the main Jetstream service.
 */

import WebSocket from "ws";

export type TempDeps = {
  // Core helpers
  getCursor24hAgo: () => number;
  buildJetstreamRequest: (cursor?: number) => { host: string; url: string };
  cursorToHumanReadable: (cursorUs: number) => string;
  withDBRetry: <T>(operation: () => Promise<T>, context: string) => Promise<T>;

  // DB/API helpers
  markBackfillStarted: (userDID: string) => Promise<void>;
  markBackfillCompleted: (userDID: string) => Promise<void>;
  resolveHandle: (did: string) => Promise<string | null>;
  getIgnoredUsers: () => Promise<Array<{ did: string }>>;

  // Event persistence handlers (from main service)
  handleIdentityEvent: (
    event: any,
    profileData: Map<string, any>,
    logPrefix?: string,
  ) => Promise<void>;
  handleProfileCommit: (
    event: any,
    profileData: Map<string, any>,
    logPrefix?: string,
  ) => Promise<void>;
  handleFollowEvent: (
    event: any,
    mainService: any,
    logPrefix?: string,
    isInBackfill?: boolean,
  ) => Promise<void>;

  // Broadcast
  triggerMonitoringStatusBroadcast: () => void;

  // Limits and cross‑references
  maxConcurrentTempStreams: number;
  mainJetstreamService: any; // instance of main JetstreamService
};

/**
 * Core runtime state:
 * - ws: active WebSocket connection (null when disconnected)
 * - profileData: in-memory profile snapshot cache keyed by DID
 * - startTime: timestamp when this temp stream started (backfill cutoff)
 */
class TemporaryJetstreamService {
  private ws: WebSocket | null = null;
  private profileData = new Map<string, any>();
  private readonly startTime: Date;

  /**
   * Reconnect/backfill state:
   * - reconnectAttempts: consecutive reconnect count (for backoff)
   * - reconnectTimeout: scheduled reconnect timer or null
   * - shouldRun: controls whether to keep reconnecting
   * - lastCursor: last processed microsecond cursor (resume)
   * - initialCursor: initial starting cursor (backfill window)
   * - lastHost: last connected Jetstream host (diagnostics)
   * - hasStopped: idempotent stop guard
   */
  private reconnectAttempts = 0;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private shouldRun = true;
  private lastCursor: number | null = null;
  private initialCursor: number | null = null;
  private lastHost: string | undefined;
  private hasStopped = false;

  /**
   * Create a temporary stream session for a user's follow list.
   *
   * @param deps Injected helpers (DB ops, URL builders, etc.).
   * @param userDID Target DID for which to backfill.
   * @param userHandle Optional handle for readable logs (may be null).
   * @param follows List of DIDs to monitor during this temporary session.
   * @param onStopped Callback invoked when the stream stops (manual or auto).
   */
  constructor(
    private readonly deps: TempDeps,
    private readonly userDID: string,
    private readonly userHandle: string | null,
    private readonly follows: string[],
    private readonly onStopped: (triggeredByManager: boolean) => void,
  ) {
    // Capture start timestamp (used to detect when backfill has caught up)
    this.startTime = new Date();
  }

  // Human-friendly label for logs/UI.
  private get userLabel(): string {
    return this.userHandle
      ? `${this.userDID} (@${this.userHandle})`
      : this.userDID;
  }

  // Prefix used in logs for temporary streams; prefer handle, fallback to DID
  private get logPrefix(): string {
    return this.userHandle
      ? `[Temp/@${this.userHandle}]`
      : `[Temp/${this.userDID}]`;
  }

  // Launch the temporary stream.
  async start() {
    console.log(
      `🚀 Starting temporary Jetstream for user ${this.userLabel} (${this.follows.length} DIDs)`,
    );
    this.shouldRun = true;
    this.hasStopped = false;
    this.reconnectAttempts = 0;
    this.lastCursor = null;
    this.initialCursor = this.deps.getCursor24hAgo();
    this.connect();
  }

  // Establish the WebSocket connection for this short-lived session.
  private connect() {
    if (!this.shouldRun) return;

    // Reset host tracking and clear any pending reconnect timer
    this.lastHost = undefined;
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    // Choose resume cursor: prefer last processed cursor, otherwise
    // the initial seed, otherwise default to 24h lookback
    const cursor =
      this.lastCursor ?? this.initialCursor ?? this.deps.getCursor24hAgo();

    // Cache the initial starting cursor for consistent resume/backfill context
    if (this.initialCursor === null) this.initialCursor = cursor;

    // Build websocket URL for the temporary stream and capture selected host
    const { url, host } = this.deps.buildJetstreamRequest(cursor);
    // Remember the host for later diagnostics/logging
    this.lastHost = host;
    // Log connection attempt with user label and DID count
    console.log(
      `🔌 Temporary Jetstream connecting to ${host} for ${this.userLabel} (${this.follows.length} DIDs)`,
    );

    // Produce a human-readable label for the starting/resume cursor
    const cursorLabel = this.deps.cursorToHumanReadable(cursor);

    // Log whether we resume from a saved cursor or start fresh
    if (this.lastCursor)
      console.log(
        `${this.logPrefix} 📍 Resuming from cursor: ${cursor} (${cursorLabel})`,
      );
    else
      console.log(
        `${this.logPrefix} 📍 Starting from cursor: ${cursor} (${cursorLabel})`,
      );

    // Establish a new WebSocket session for the temporary backfill stream.
    this.ws = new WebSocket(url);

    // Handle connection lifecycle.
    this.ws.on("open", () => {
      console.log(
        `✅ Temporary Jetstream connected for user ${this.userLabel}`,
      );
      this.reconnectAttempts = 0;
      if (this.reconnectTimeout) {
        clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = null;
      }

      // Push the DID list so Jetstream delivers the correct events.
      const message = buildOptionsUpdateMessage(this.follows);
      this.ws?.send(message);
      console.log(
        `📤 Temporary: Sent to Jetstream with ${this.follows.length} DIDs`,
      );
    });

    // Forward Jetstream payloads to the persistence helpers.
    this.ws.on("message", (data: WebSocket.Data) => {
      try {
        const event = JSON.parse(data.toString());
        void this.processEvent(event);
      } catch (error) {
        console.error("❌ Error parsing Jetstream event:", error);
      }
    });

    // Connection closed: log and reconnect if needed
    this.ws.on("close", (code, reason) => {
      // Convert reason (Buffer | undefined) to readable text
      const reasonText = reason?.toString("utf8") || "No close reason provided";
      console.log(
        `🔌 Temporary Jetstream disconnected for user ${this.userLabel} from ${this.lastHost ?? "unknown host"} (code: ${code}, reason: ${reasonText})`,
      );

      // Drop socket reference
      this.ws = null;

      // Service was intentionally stopped: reset attempts and skip reconnects
      if (!this.shouldRun) {
        this.reconnectAttempts = 0;
        return;
      }

      // Increment attempts and compute exponential backoff (capped at 30s)
      this.reconnectAttempts++;
      const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);

      // Log scheduled reconnect timing and attempt count
      console.log(
        `${this.logPrefix} 🔄 Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts})...`,
      );

      // Schedule reconnect after delay
      this.reconnectTimeout = setTimeout(() => this.connect(), delay);
      // Broadcast status so UI reflects the temporary stream reconnection
      void this.deps.triggerMonitoringStatusBroadcast();
    });

    // Surface WebSocket level failures for observability.
    this.ws.on("error", (error) => {
      console.error(
        `❌ Temporary Jetstream error for user ${this.userLabel}:`,
        error,
      );
    });
  }

  // Persist profile updates encountered during the backfill stream.
  private async processEvent(event: any): Promise<void> {
    try {
      const logPrefix = this.logPrefix;

      // Advance lastCursor using the event's microsecond timestamp
      // so subsequent resumes continue from the latest processed point
      if (event.time_us) this.lastCursor = event.time_us;

      // Check if backfill is complete (event timestamp is after stream start time)
      if (event.time_us) {
        const eventTime = event.time_us / 1000; // Convert microseconds to milliseconds
        const startTimeMs = this.startTime.getTime();
        if (eventTime >= startTimeMs) {
          console.log(
            `${logPrefix} ✅ 24h backfill complete (caught up to live events), stopping temporary stream`,
          );
          this.stop();
          return;
        }
      }

      // Persist identity changes (handle changes).
      if (event.kind === "identity") {
        await this.deps.withDBRetry(
          () =>
            this.deps.handleIdentityEvent(event, this.profileData, logPrefix),
          `Persisting temporary Jetstream identity event for ${this.userDID}`,
        );
      }

      // Persist profile changes when relevant fields are updated.
      if (event.kind === "commit") {
        await this.deps.withDBRetry(
          () =>
            this.deps.handleProfileCommit(event, this.profileData, logPrefix),
          `Persisting temporary Jetstream commit event for ${this.userDID}`,
        );

        // Process follow/unfollow events (always in temp streams)
        await this.deps.withDBRetry(
          () =>
            this.deps.handleFollowEvent(
              event,
              this.deps.mainJetstreamService,
              logPrefix,
              false,
            ),
          `Processing temporary Jetstream follow event for ${this.userDID}`,
        );
      }
    } catch (error) {
      console.error("❌ Error processing temporary Jetstream event:", error);
    }
  }

  // Stop the stream and emit diagnostic output.
  stop(triggeredByManager = false) {
    this.shouldRun = false;

    // Cancel any scheduled reconnects and reset attempt counter
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.reconnectAttempts = 0;

    // Close active websocket connection and drop reference
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    // Idempotent stop: only execute once
    if (this.hasStopped) return;
    this.hasStopped = true;

    // Log total runtime duration for visibility
    const duration = Date.now() - this.startTime.getTime();
    console.log(
      `🛑 Temporary Jetstream stopped for user ${this.userLabel} (ran for ${Math.floor(duration / 1000)}s)`,
    );

    // Notify manager/caller that the temporary stream finished
    try {
      this.onStopped(triggeredByManager);
    } catch (error) {
      console.error(
        `❌ Failed to finalize temporary stream for ${this.userLabel}:`,
        error,
      );
    }
  }

  // Human-readable identifier used in logs/UI for this temp stream
  getLabel(): string {
    return this.userLabel;
  }

  // Provide diagnostic snapshot for the manager.
  getStatus() {
    return {
      userDID: this.userDID,
      followCount: this.follows.length,
      startTime: this.startTime,
      running: this.ws !== null,
    };
  }
}

/**
 * Coordinates temporary per-user Jetstream sessions with a concurrency limit.
 * Uses injected dependencies to avoid circular imports with the main service.
 */
class TemporaryJetstreamManager {
  private activeStreams = new Map<string, TemporaryJetstreamService>();
  private queue: Array<{
    userDID: string;
    follows: string[];
    resolve: () => void;
    reject: (err: Error) => void;
  }> = [];

  constructor(private readonly deps: TempDeps) {}

  /**
   * Start a temporary stream for a user or queue it if capacity is reached.
   * @param userDID DID of the user to backfill for.
   * @param follows List of follow DIDs for this user.
   * @returns Queue status with optional position.
   * @throws Error when the user already has an active temp stream.
   */
  async startForUser(
    userDID: string,
    follows: string[],
  ): Promise<{ queued: boolean; position?: number }> {
    if (this.activeStreams.has(userDID)) {
      throw new Error("User already has an active temporary stream");
    }

    // Queque Check
    if (this.activeStreams.size >= this.deps.maxConcurrentTempStreams) {
      return new Promise<{ queued: boolean; position?: number }>(
        (resolve, reject) => {
          this.queue.push({
            userDID,
            follows,
            resolve: () => resolve({ queued: false }),
            reject,
          });
          console.log(
            `📋 User ${userDID} queued (position ${this.queue.length})`,
          );
          this.deps.triggerMonitoringStatusBroadcast();
        },
      ).then(() => ({ queued: true, position: this.queue.length }));
    }

    // Capacity available: start the temporary stream immediately
    await this.startStreamForUser(userDID, follows);
    return { queued: false };
  }

  /**
   * Create, track and bootstrap a TemporaryJetstreamService for a user.
   * @param userDID Target user DID.
   * @param follows Follow DID list.
   */
  private async startStreamForUser(userDID: string, follows: string[]) {
    const userHandle = await this.deps.resolveHandle(userDID);
    const userLabel = userHandle ? `${userDID} (@${userHandle})` : userDID;

    // Exclude ignored DIDs from the temporary stream's follow list
    const ignoredRows = await this.deps.getIgnoredUsers();
    const ignoredSet = new Set(ignoredRows.map((u) => u.did));
    const filteredFollows = follows.filter((did) => !ignoredSet.has(did));
    const removedCount = follows.length - filteredFollows.length;
    if (removedCount > 0) {
      console.log(
        `🚫 Filtered ${removedCount} ignored DID(s) for ${userLabel} (from ${follows.length} → ${filteredFollows.length})`,
      );
    }

    // If nothing remains to backfill after filtering, mark backfill done and skip starting a stream
    if (filteredFollows.length === 0) {
      await this.deps.withDBRetry(
        () => this.deps.markBackfillStarted(userDID),
        `Marking backfill started for ${userDID}`,
      );
      await this.deps.withDBRetry(
        () => this.deps.markBackfillCompleted(userDID),
        `Marking backfill completed for ${userDID}`,
      );
      this.deps.triggerMonitoringStatusBroadcast();
      console.log(
        `⏭️ No non-ignored follows for ${userLabel}; skipping temporary stream`,
      );
      return;
    }

    // Instantiate a temporary stream for this user; finalize callback
    // removes the stream from tracking when it stops
    const service = new TemporaryJetstreamService(
      this.deps,
      userDID,
      userHandle,
      filteredFollows,
      (triggeredByManager) =>
        void this.finalizeStream(userDID, triggeredByManager),
    );

    // Track active temporary stream instance
    this.activeStreams.set(userDID, service);

    // Persist backfill start state before establishing the connection
    await this.deps.withDBRetry(
      () => this.deps.markBackfillStarted(userDID),
      `Marking backfill started for ${userDID}`,
    );

    // Launch the temporary stream and announce availability
    try {
      await service.start();
      console.log(
        `✅ Temporary stream started for ${userLabel} (${this.activeStreams.size}/${this.deps.maxConcurrentTempStreams})`,
      );
      this.deps.triggerMonitoringStatusBroadcast();

      // Stream startup failed: remove from active set and reset backfill state
    } catch (error) {
      console.error(
        `❌ Failed to start temporary stream for ${userLabel}:`,
        error,
      );
      this.activeStreams.delete(userDID);
      try {
        await this.deps.withDBRetry(
          () => this.deps.markBackfillCompleted(userDID),
          `Marking backfill completed for ${userDID}`,
        );
      } catch (dbError) {
        console.error(
          `❌ Failed to reset backfill state for ${userDID}:`,
          dbError,
        );
      }

      // Notify listeners and rethrow for upstream handling
      this.deps.triggerMonitoringStatusBroadcast();
      throw error;
    }
  }

  /**
   * Stop an active temporary stream for a user (if present) and free capacity.
   * @param userDID User DID whose temp stream should be stopped.
   */
  async stopForUser(userDID: string) {
    const service = this.activeStreams.get(userDID);
    if (service) service.stop(true);
  }

  /**
   * Promote the next queued request if capacity allows and resolve its promise.
   */
  private async processQueue() {
    if (this.queue.length === 0) return;
    if (this.activeStreams.size >= this.deps.maxConcurrentTempStreams) return;

    // Dequeue the next pending request, if any, and start it
    const next = this.queue.shift();

    // Log queue progress and notify listeners (admin UI)
    if (next) {
      console.log(
        `📤 Processing queued request for ${next.userDID} (${this.queue.length} remaining in queue)`,
      );
      this.deps.triggerMonitoringStatusBroadcast();

      // Start the temporary stream and resolve the enqueued promise
      try {
        await this.startStreamForUser(next.userDID, next.follows);
        next.resolve();

        // Propagate failure to the enqueuer
      } catch (err) {
        next.reject(err as Error);
      }
    }
  }

  /**
   * Return current manager status used by monitoring/admin endpoints.
   * @returns Snapshot containing active count, queue size and limits.
   */
  getStatus() {
    return {
      activeStreams: this.activeStreams.size,
      maxStreams: this.deps.maxConcurrentTempStreams,
      queueLength: this.queue.length,
      availableSlots: Math.max(
        0,
        this.deps.maxConcurrentTempStreams - this.activeStreams.size,
      ),
      activeUsers: Array.from(this.activeStreams.keys()),
    };
  }

  /**
   * Check whether a user can start immediately or must be queued.
   * @param userDID DID to check.
   * @returns Allowed flag with optional reason and queue position.
   */
  canStartStream(userDID: string): {
    allowed: boolean;
    reason?: string;
    queuePosition?: number;
  } {
    // Disallow starting if the user already has an active temp stream
    if (this.activeStreams.has(userDID)) {
      return {
        allowed: false,
        reason: "User already has an active temporary stream",
      };
    }

    // At capacity: return queue info (1-based position)
    if (this.activeStreams.size >= this.deps.maxConcurrentTempStreams) {
      return {
        allowed: false,
        reason: "Server at capacity. You will be queued.",
        queuePosition: this.queue.length + 1,
      };
    }
    return { allowed: true };
  }

  /**
   * Finalize a temporary Jetstream stream and perform post‑stop bookkeeping.
   *
   * @param userDID - DID whose temporary stream finished.
   * @param triggeredByManager - True if stop was initiated by the manager; false when auto.
   * @returns Promise that resolves after DB state/broadcast/queue processing completes.
   */
  private async finalizeStream(
    userDID: string,
    triggeredByManager: boolean,
  ): Promise<void> {
    // Look up the active service; nothing to do if already removed
    const service = this.activeStreams.get(userDID);

    // Remove from active set and log status line
    if (!service) return;
    this.activeStreams.delete(userDID);
    const finalizerSource = triggeredByManager ? "manager" : "auto";
    const userLabel = service.getLabel();
    console.log(
      `📉 Temporary stream finalized (${finalizerSource}) for ${userLabel} — ${this.activeStreams.size}/${this.deps.maxConcurrentTempStreams} active`,
    );

    // Persist backfill completion for this user
    try {
      await this.deps.withDBRetry(
        () => this.deps.markBackfillCompleted(userDID),
        `Marking backfill completed for ${userDID}`,
      );
    } catch (error) {
      console.error(
        `❌ Failed to record backfill completion for ${userLabel}:`,
        error,
      );
    }

    // Notify listeners about updated temp‑stream status
    try {
      this.deps.triggerMonitoringStatusBroadcast();
      // Continue with next queued request, if any
    } finally {
      await this.processQueue();
    }
  }
}

/**
 * Build a Jetstream `options_update` message for a given DID list.
 *
 * Populates `wantedCollections` and `wantedDids` for the temporary stream and
 * disables message size limits. Used after the `requireHello` handshake to
 * inform Jetstream which record types and DIDs to deliver.
 *
 * @param dids Readonly list of DIDs to monitor.
 * @returns JSON string payload to send via WebSocket.
 */
function buildOptionsUpdateMessage(dids: readonly string[]): string {
  // Build Subscriber‑Sourced options message for Jetstream (requireHello mode)
  const message = {
    type: "options_update",
    payload: {
      // Record types Jetstream should emit for the subscribed DIDs
      wantedCollections: ["app.bsky.actor.profile", "app.bsky.graph.follow"],
      // DIDs to monitor (no limit here; upstream may cap)
      wantedDids: dids,
      // No size limit for messages from Jetstream
      maxMessageSizeBytes: 0,
    },
  } as const;
  return JSON.stringify(message);
}

/**
 * Create a TemporaryJetstreamManager instance.
 *
 * Coordinates short-lived per-user backfill streams using injected
 * dependencies to avoid circular imports with the main service.
 *
 * @param deps Injected helpers, limits and references used by the manager.
 * @returns New TemporaryJetstreamManager ready to start/queue temp streams.
 */
export function createTemporaryJetstreamManager(deps: TempDeps) {
  return new TemporaryJetstreamManager(deps);
}
