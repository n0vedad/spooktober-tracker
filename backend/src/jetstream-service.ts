/**
 * Backend Jetstream Service
 * Runs 24/7 monitoring all DIDs from the database
 * Adding new users with temporary monitoring
 */

import WebSocket from "ws";
import {
  addMonitoredFollows,
  getAllMonitoredDIDs,
  getFollowDIDByRkey,
  getLastKnownHandle,
  getMonitoredFollows,
  getMonitoringUserCount,
  getMonitoringUsers,
  hasMonitoringEnabled,
  insertChange,
  isDuplicateChange,
  markBackfillCompleted,
  markBackfillStarted,
  removeMonitoredFollow,
  removeMonitoredFollowByRkey,
} from "./db.js";
import { fetchFollowsForUsers } from "./utils/follows.js";
import {
  getPreviousHandleFromAuditLog,
  resolveHandle,
} from "./utils/handle-resolver.js";
import { createTemporaryJetstreamManager } from "./utils/jetstream-temp.js";
import {
  LOOKBACK_MS_24H as UTIL_LOOKBACK_MS_24H,
  buildJetstreamRequest,
  cursorToHumanReadable,
  getCursor24hAgo,
} from "./utils/jetstream-utils.js";

// Jetstream supports up to 10,000 DIDs via Subscriber Sourced Messages
const MAX_WANTED_DIDS = 10000;
// Re-export lookback constant for existing imports
export const LOOKBACK_MS_24H = UTIL_LOOKBACK_MS_24H;

// Max number of retry attempts for transient DB operations
const DB_RETRY_ATTEMPTS = 3;
// Base delay (ms) for exponential backoff between DB retries
const DB_RETRY_BASE_DELAY_MS = 200;

// Simple sleep helper used for retry backoff delays
const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

// Trigger a live monitoring status broadcast without creating a static import
// (avoids circular deps and only loads the route module on demand)
const triggerMonitoringStatusBroadcast = () => {
  void import("./routes/monitoring.js")
    .then(({ broadcastMonitoringStatusUpdate }) =>
      broadcastMonitoringStatusUpdate(),
    )
    .catch((error) => {
      console.error("❌ Failed to trigger monitoring status broadcast:", error);
    });
};

/**
 * Retry helper that re-executes transient Postgres operations.
 *
 * @param operation Async function to call.
 * @param context Short description for log output.
 * @returns Result of the operation.
 */
const withDBRetry = async <T>(
  operation: () => Promise<T>,
  context: string,
): Promise<T> => {
  let attempt = 0;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      attempt += 1;
      console.error(
        `❌ ${context} failed (attempt ${attempt}/${DB_RETRY_ATTEMPTS}):`,
        error,
      );

      // Give up after reaching the maximum number of retry attempts
      if (attempt >= DB_RETRY_ATTEMPTS) {
        throw error;
      }
      // Exponential backoff between retries (200ms, 400ms, 800ms, ...)
      const delayMs = DB_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      await wait(delayMs);
    }
  }
};

// buildJetstreamRequest moved to utils/jetstream-utils

/**
 * Build the message to send DIDs and collections to Jetstream.
 *
 * @param dids - DIDs to include in the `wantedDids` list.
 * @returns JSON string of the  message.
 */
const buildOptionsUpdateMessage = (dids: readonly string[]): string => {
  const maxDids = Math.min(dids.length, MAX_WANTED_DIDS);

  // Warn if we're hitting the limit
  if (dids.length > MAX_WANTED_DIDS) {
    console.warn(
      `⚠️  WARNING: ${dids.length} DIDs to monitor, but Jetstream limit is ${MAX_WANTED_DIDS}. Only monitoring first ${maxDids} DIDs.`,
    );
  }

  // Build Subscriber-Sourced options message for Jetstream (requireHello mode)
  const message = {
    type: "options_update",
    payload: {
      // Record types Jetstream should emit for the subscribed DIDs
      wantedCollections: ["app.bsky.actor.profile", "app.bsky.graph.follow"],
      // DIDs to monitor (capped to Jetstream's MAX_WANTED_DIDS)
      wantedDids: dids.slice(0, maxDids),
      maxMessageSizeBytes: 0, // No limit
    },
  };

  return JSON.stringify(message);
};

/**
 * Persist handle changes triggered by Jetstream identity events.
 *
 * @param event - Jetstream event payload from the socket.
 * @param profileData - Mutable cache of prior profile snapshots.
 * @param logPrefix - Optional prefix for log output (used by temp streams).
 */
async function handleIdentityEvent(
  event: JetstreamEvent,
  profileData: Map<string, ProfileData>,
  logPrefix?: string,
): Promise<void> {
  if (event.kind !== "identity") return;

  // Only process identity events carrying handle info; ignore others
  const identity = event.identity;
  if (!identity) return;

  // DID of the actor whose identity event we received
  const did = event.did;
  // New handle value from the identity payload (empty string when missing)
  const newHandle = identity.handle || "";

  // Retrieve previously observed profile snapshot from cache
  const oldProfile = profileData.get(did);
  let oldHandle = oldProfile?.handle !== undefined ? oldProfile.handle : null;

  // If cache has no entry (first time seeing this DID), check DB for last known handle
  if (oldHandle === null) {
    const dbHandle = await getLastKnownHandle(did);
    if (dbHandle) {
      oldHandle = dbHandle;
    }
  }

  // If still no handle, try to get previous handle from PLC audit log
  if (oldHandle === null) {
    const auditHandle = await getPreviousHandleFromAuditLog(did);
    if (auditHandle) {
      oldHandle = auditHandle;
    }
  }

  // If still no handle, resolve current handle via PLC Directory
  if (oldHandle === null) {
    const resolvedHandle = await resolveHandle(did);
    if (resolvedHandle) {
      oldHandle = resolvedHandle;
    }
  }

  // Convert null to empty string for comparison
  if (oldHandle === null) {
    oldHandle = "";
  }

  // Detect whether handle actually changed (only log true handle-to-handle changes).
  const handleChanged =
    newHandle !== oldHandle && oldHandle !== "" && newHandle !== "";

  // Update cache with latest known handle.
  const currentProfile = profileData.get(did);
  profileData.set(did, {
    displayName: currentProfile?.displayName || "",
    avatarRef: currentProfile?.avatarRef || "",
    handle: newHandle,
  });

  // No actual handle change detected; skip persisting/logging
  if (!handleChanged) {
    return;
  }

  // Check for duplicate BEFORE logging the change details
  const changeData = {
    did,
    handle: newHandle || undefined,
    old_handle: oldHandle || undefined,
    new_handle: newHandle || undefined,
  };

  // Only log the duplicate warning with the handle change details from DB
  // If oldHandle from DB is empty, try to resolve it from PLC Audit Log
  const duplicate = await isDuplicateChange(changeData);
  if (duplicate) {
    let displayOldHandle = duplicate.oldHandle;
    if (!displayOldHandle) {
      const plcHandle = await getPreviousHandleFromAuditLog(did);
      if (plcHandle) {
        displayOldHandle = plcHandle;
      }
    }

    // If newHandle from DB is empty, try to resolve current handle
    let displayNewHandle = duplicate.newHandle;
    if (!displayNewHandle) {
      const currentHandle = await resolveHandle(did);
      if (currentHandle) {
        displayNewHandle = currentHandle;
      }
    }

    // Only log duplicates from temporary streams (not main stream)
    if (logPrefix) {
      const oldHandleDisplay = displayOldHandle
        ? `@${displayOldHandle}`
        : "(none)";
      const newHandleDisplay = displayNewHandle
        ? `@${displayNewHandle}`
        : "(none)";
      console.log(
        `⚠️  ${logPrefix} Duplicate handle change for ${did} (${oldHandleDisplay} → ${newHandleDisplay}), skipping`,
      );
    }
    return;
  }

  // Prefix logs when invoked from temporary streams.
  const prefix = logPrefix ? `${logPrefix} ` : "";
  const cursorTime = event.time_us
    ? cursorToHumanReadable(event.time_us)
    : "unknown";

  // Show the most meaningful handle (prefer non-empty handle)
  const displayHandle = newHandle || oldHandle || did;
  const handleInfo = newHandle || oldHandle ? `(@${displayHandle})` : "";
  console.log(`📝 ${prefix}Handle change detected for ${did} ${handleInfo}:`);
  console.log(
    `   Handle: "${oldHandle || "(none)"}" → "${newHandle || "(none)"}"`,
  );
  console.log(`   Cursor: ${cursorTime}`);

  // Insert handle change (will also log duplicate if found in DB)
  await insertChange(changeData, logPrefix);
}

/**
 * Persist profile mutations triggered by Jetstream commits.
 *
 * @param event - Jetstream event payload from the socket.
 * @param profileData - Mutable cache of prior profile snapshots.
 * @param logPrefix - Optional prefix for log output (used by temp streams).
 */
async function handleProfileCommit(
  event: JetstreamEvent,
  profileData: Map<string, ProfileData>,
  logPrefix?: string,
): Promise<void> {
  if (event.kind !== "commit") return;

  // Only persist commits targeting the actor profile collection.
  const commit = event.commit;
  if (!commit || commit.collection !== "app.bsky.actor.profile") return;

  // Abort when the commit carries no record payload to inspect.
  const record = commit.record;
  if (!record) return;
  const did = event.did;

  // Normalize missing values so comparisons behave predictably.
  const newDisplayName = record.displayName || "";
  const newAvatarRef = record.avatar?.ref?.$link || "";

  // Retrieve previously observed profile snapshot, if any.
  const oldProfile = profileData.get(did);
  const oldDisplayName = oldProfile?.displayName || "";
  const oldAvatarRef = oldProfile?.avatarRef || "";
  let currentHandle = oldProfile?.handle || "";

  // If cache is empty (e.g., temporary stream just started), check DB for last known handle
  if (!currentHandle) {
    const dbHandle = await getLastKnownHandle(did);
    if (dbHandle) {
      currentHandle = dbHandle;
    }
  }

  // If still no handle, resolve it via PLC Directory
  if (!currentHandle) {
    const resolvedHandle = await resolveHandle(did);
    if (resolvedHandle) {
      currentHandle = resolvedHandle;
    }
  }

  // Detect whether either tracked field actually changed.
  const displayNameChanged = newDisplayName !== oldDisplayName;
  const avatarChanged = newAvatarRef !== oldAvatarRef;

  // No effective profile field change detected (and we already had cache state);
  // skip logging/persisting to avoid noisy duplicates.
  if (!displayNameChanged && !avatarChanged && oldProfile) {
    return;
  }

  // Update cache with latest known profile state.
  profileData.set(did, {
    displayName: newDisplayName,
    avatarRef: newAvatarRef,
    handle: currentHandle,
  });

  // No profile field changed; nothing to persist/log
  if (!displayNameChanged && !avatarChanged) {
    return;
  }

  // Skip logging and storing initial events (first capture without previous cache)
  // These are not real changes, just first-time profile discovery
  if (!oldProfile) {
    return;
  }

  // Check for duplicate BEFORE logging the change details
  const changeData = {
    did,
    handle: currentHandle || undefined,
    old_display_name: oldDisplayName || undefined,
    new_display_name: newDisplayName || undefined,
    old_avatar: oldAvatarRef || undefined,
    new_avatar: newAvatarRef || undefined,
  };

  // Only log the duplicate warning via insertChange, not the full change details here
  const isDuplicate = await isDuplicateChange(changeData);
  if (isDuplicate) {
    await insertChange(changeData, logPrefix);
    return;
  }

  // Prefix logs when invoked from temporary streams.
  const prefix = logPrefix ? `${logPrefix} ` : "";
  const cursorTime = event.time_us
    ? cursorToHumanReadable(event.time_us)
    : "unknown";
  const handleInfo = currentHandle ? ` (@${currentHandle})` : "";
  console.log(`📝 ${prefix}Change detected for ${did}${handleInfo}:`);

  // Log only the fields that actually changed (display name)
  if (displayNameChanged) {
    console.log(`   DisplayName: "${oldDisplayName}" → "${newDisplayName}"`);
  }

  // Only log meaningful avatar changes (from one avatar to another, or removal)
  // Don't log when first setting an avatar (oldAvatarRef is empty)
  if (avatarChanged) {
    if (oldAvatarRef) {
      if (newAvatarRef) {
        console.log(`   Avatar: changed`);
      } else {
        console.log(`   Avatar: removed`);
      }
    }
  }
  console.log(`   Cursor: ${cursorTime}`);

  // Insert Changes
  await insertChange(changeData, logPrefix);
}

/**
 * Handle follow/unfollow events to automatically add/remove follows from monitoring.
 *
 * @param event - Jetstream event payload from the socket.
 * @param jetstreamService - Reference to main Jetstream service for DID reload.
 * @param logPrefix - Optional prefix for log output (used by temp streams).
 * @returns Promise resolving once processing is complete.
 */
async function handleFollowEvent(
  event: JetstreamEvent,
  jetstreamService: JetstreamService,
  logPrefix?: string,
  isInBackfill: boolean = false,
): Promise<void> {
  if (event.kind !== "commit") return;

  // Only handle commits for the follow graph collection
  const commit = event.commit;
  if (!commit || commit.collection !== "app.bsky.graph.follow") return;

  // DID of the actor performing the follow/unfollow
  const followerDID = event.did;
  // Commit operation type: "create" (follow) or "delete" (unfollow)
  const operation = commit.operation;
  // Record key identifying the follow record (used for deletions)
  const rkey = commit.rkey;

  // Handle both "create" (follow) and "delete" (unfollow) operations
  if (operation !== "create" && operation !== "delete") return;

  // Check if the follower has monitoring enabled
  const hasMonitoring = await hasMonitoringEnabled(followerDID);
  if (!hasMonitoring) {
    return; // Skip silently if user doesn't have monitoring
  }

  // Main stream: Only process follow events when live (not during backfill)
  // Temp stream: Always process follow events (logPrefix is set)
  if (isInBackfill && !logPrefix) {
    return;
  }

  // Convert microsecond cursor timestamp to human-readable string (or "unknown")
  const cursorTime = event.time_us
    ? cursorToHumanReadable(event.time_us)
    : "unknown";
  // Resolve follower's handle for clearer logging (best-effort)
  const followerHandle = await resolveHandle(followerDID);

  // Follow event: extract followed subject from commit record
  if (operation === "create") {
    const record = commit.record;
    // Guard against malformed commits without a subject DID
    if (!record || !record.subject) return;

    // DID of the account being followed (subject of the follow)
    const followedDID = record.subject;
    // Resolve handle for clearer logs and DB consistency (best-effort)
    const followedHandle = await resolveHandle(followedDID);

    // Check if we already have the handle (resolved above for debug)
    if (!followedHandle) {
      console.warn(
        `⚠️  Could not resolve handle for ${followedDID}, skipping auto-add`,
      );
      return;
    }

    // Check if this follow already exists in DB (e.g., from fetchFollows)
    const existingFollows = await getMonitoredFollows(followerDID);
    const alreadyExists = existingFollows.some(
      (f) => f.follow_did === followedDID,
    );

    // Only log in temp streams (backfill), not in main stream
    if (alreadyExists) {
      if (logPrefix) {
        console.log(
          `${logPrefix} ℹ️  Already monitoring @${followedHandle}, skipping (backfill event)`,
        );
      }
      // Don't update the rkey - the current one from fetchFollows is the correct one
      return;
    }

    // Only log when we actually add something new AND (not in backfill OR in temp stream)
    if (!isInBackfill || logPrefix) {
      const prefix = logPrefix ? `${logPrefix} ` : "";
      console.log(`${prefix}🔍 Follow event detected (${operation}):`);
      console.log(
        `   From: ${followerDID}${followerHandle ? ` (@${followerHandle})` : ""}`,
      );
      console.log(
        `   To: ${followedDID}${followedHandle ? ` (@${followedHandle})` : ""}`,
      );
      console.log(`   Time: ${cursorTime}`);
      console.log(`   RKey: ${rkey || "unknown"}`);
      console.log(`   ➕ Auto-adding to monitoring: @${followedHandle}`);
    }

    // Add to monitored follows with rkey for future unfollow tracking
    await addMonitoredFollows(followerDID, [
      { did: followedDID, handle: followedHandle, rkey: rkey },
    ]);

    // Trigger DID reload to start monitoring this new follow
    await jetstreamService.reloadDIDsNow("auto");

    // Log confirmation only when live (not in main backfill) or in temp streams
    if (!isInBackfill || logPrefix) {
      console.log(
        `   ✅ Now monitoring profile changes for ${followedDID} - @${followedHandle}`,
      );
    }

    // For delete events, use rkey to find and remove the follow
  } else if (operation === "delete") {
    if (!rkey) {
      console.warn(`⚠️  Delete event without rkey, cannot process`);
      return;
    }

    // First, look up the DID BEFORE removing it
    const removedDID = await getFollowDIDByRkey(followerDID, rkey);

    // Unfollow target identified via rkey; resolve handle for clearer logs
    if (removedDID) {
      const removedHandle = await resolveHandle(removedDID);

      // Only log when we actually remove something AND (not in backfill OR in temp stream)
      if (!isInBackfill || logPrefix) {
        const prefix = logPrefix ? `${logPrefix} ` : "";
        console.log(`${prefix}🔍 Unfollow event detected (${operation}):`);
        console.log(
          `   From: ${followerDID}${followerHandle ? ` (@${followerHandle})` : ""}`,
        );
        console.log(
          `   To: ${removedDID}${removedHandle ? ` (@${removedHandle})` : ""}`,
        );
        console.log(`   Time: ${cursorTime}`);
        console.log(`   RKey: ${rkey}`);
      }

      // Remove the follow from DB
      await removeMonitoredFollowByRkey(followerDID, rkey);

      // Log removal when live or in temp stream; prefer handle, fallback to DID
      if (!isInBackfill || logPrefix) {
        console.log(
          `   ➖ Removed from monitoring: ${removedHandle ? `@${removedHandle}` : removedDID}`,
        );
      }

      // Check if DID is still monitored AFTER removal (by any user, including this one with another rkey)
      const allMonitoredDIDs = await getAllMonitoredDIDs();
      const stillMonitored = allMonitoredDIDs.includes(removedDID);

      // If the DID remains in the follower's list, avoid reloading main stream
      if (stillMonitored) {
        // Only log this optimization in live or temp-stream contexts
        if (!isInBackfill || logPrefix) {
          console.log(
            `   ℹ️  DID still in current follows, skipping DID reload`,
          );
        }

        // Trigger DID reload to stop monitoring this follow
      } else {
        await jetstreamService.reloadDIDsNow("auto");
        if (!isInBackfill || logPrefix) {
          console.log(
            `   ✅ Stopped monitoring profile changes for ${removedDID} - @${removedHandle}`,
          );
        }
      }

      // Only log in temp streams (backfill), not in main stream
    } else {
      if (logPrefix) {
        console.log(
          `${logPrefix} 🔍 Unfollow event detected but no match found:`,
        );
        console.log(
          `   From: ${followerDID}${followerHandle ? ` (@${followerHandle})` : ""}`,
        );
        console.log(`   RKey: ${rkey}`);
        console.log(`   Time: ${cursorTime}`);
        console.log(
          `   ⚠️  No matching follow found for rkey ${rkey}, skipping (backfill event)`,
        );
      }
    }
  }
}

/**
 * Partial representation of relevant Jetstream event payload fields.
 *
 * Fields
 * - kind: Event kind (e.g., "commit", "identity").
 * - did: Actor DID the event refers to.
 * - time_us: Cursor timestamp in microseconds.
 * - commit: Present for repo commit events; carries operation, collection,
 *   optional rkey and the record payload.
 * - identity: Present for identity events; contains DID, optional handle,
 *   sequence number and event time.
 */
interface JetstreamEvent {
  kind: string;
  did: string;
  time_us: number;
  commit?: {
    operation: string;
    collection: string;
    rkey?: string;
    record?: {
      displayName?: string;
      avatar?: {
        ref?: {
          $link?: string;
        };
      };
      subject?: string;
    };
  };
  identity?: {
    did: string;
    handle?: string;
    seq: number;
    time: string;
  };
}

/**
 * Snapshot of profile fields cached for change comparisons.
 *
 * Fields
 * - displayName: Last observed display name
 * - avatarRef: Last observed avatar CID/link
 * - handle: Last observed handle
 */
interface ProfileData {
  displayName: string;
  avatarRef: string;
  handle: string;
}

/**
 * JetstreamService maintains the long‑lived Jetstream WebSocket connection
 * and coordinates monitoring of DIDs stored in the database.
 *
 * Responsibilities
 * - Connects to Jetstream and keeps the connection alive with exponential backoff.
 * - Sends options updates (wanted DIDs/collections) and handles resume via cursor.
 * - Caches profile snapshots in memory to detect and persist handle/profile changes.
 * - Reacts to follow/unfollow events to auto‑add/remove monitored DIDs.
 * - Exposes control hooks (start/stop/reload) and status queries for the admin UI.
 */
class JetstreamService {
  private ws: WebSocket | null = null;
  private profileData = new Map<string, ProfileData>();
  private reconnectAttempts = 0;
  private shouldRun = true;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private currentDIDs: string[] = [];
  private lastCursor: number | null = null;
  private startTime: Date | null = null;
  private isInActualBackfill = false;
  // Stores backfill lag (in seconds) computed at start() for logging on completion
  private actualBackfillLagSeconds: number | null = null;
  private lastHost: string | undefined;
  private stoppedAt: Date | null = null;
  private cursorAtStop: number | null = null;

  /**
   * Broadcast the current cursor information to connected WebSocket clients.
   *
   * @returns void
   */
  private broadcastCursorUpdate() {
    const cursorInfo = this.getCursorInfo();

    // Import broadcastCursorUpdate dynamically to avoid circular dependency
    import("./server.js").then(({ broadcastCursorUpdate }) => {
      broadcastCursorUpdate(cursorInfo);
    });
  }

  /**
   * Synchronize follows for all monitoring users from Bluesky API.
   * This ensures we have the latest follows before starting to monitor.
   * Also removes unfollowed accounts from the database.
   *
   * @returns Promise resolving once all follows are synchronized.
   */
  private async syncFollowsForAllUsers() {
    try {
      console.log("🔄 Synchronizing follows for all monitoring users...");

      // Get all users who have monitoring enabled
      const userDIDs = await withDBRetry(
        () => getMonitoringUsers(),
        "Loading monitoring users for follow sync",
      );

      // No monitoring users registered: skip expensive follow synchronization
      if (userDIDs.length === 0) {
        console.log("⏭️  No monitoring users, skipping follow sync");
        return;
      }
      // Begin parallel fetch of follows per user for synchronization
      console.log(`📥 Fetching follows for ${userDIDs.length} user(s)...`);

      // Fetch follows for all users in parallel
      const followsMap = await fetchFollowsForUsers(userDIDs);

      // Get all existing follows from database in a single batch query
      const { getMonitoredFollowsBatch } = await import("./db.js");
      const dbFollowsMap = await withDBRetry(
        () => getMonitoredFollowsBatch(userDIDs),
        "Getting DB follows for all users (batch)",
      );

      // Update database with latest follows
      for (const [userDID, currentFollows] of followsMap) {
        // Get existing follows from batch result
        const dbFollows = dbFollowsMap.get(userDID) || [];

        // Build quick lookup sets for API (current) and DB (stored) follow DIDs
        const currentFollowDIDs = new Set(currentFollows.map((f) => f.did));
        const dbFollowDIDs = new Set(dbFollows.map((f) => f.follow_did));

        // Find unfollowed accounts (in DB but not in current follows)
        const unfollowed = dbFollows.filter(
          (f) => !currentFollowDIDs.has(f.follow_did),
        );

        // Resolve handle for clearer logs and announce removal summary
        if (unfollowed.length > 0) {
          const userHandle = await resolveHandle(userDID);
          console.log(
            `🗑️  Removing ${unfollowed.length} unfollowed account(s) for ${userDID}${userHandle ? ` (@${userHandle})` : ""}`,
          );

          // Remove each unfollowed DID from monitoring with DB retry protection
          for (const unfollow of unfollowed) {
            await withDBRetry(
              () => removeMonitoredFollow(userDID, unfollow.follow_did),
              `Removing unfollowed ${unfollow.follow_did}`,
            );
          }
        }

        // Add/update current follows
        // Find new follows (not in DB yet)
        const newFollows = currentFollows.filter(
          (f) => !dbFollowDIDs.has(f.did),
        );

        // Find updated follows (handle or rkey changed)
        const updatedFollows = currentFollows.filter((f) => {
          const existing = dbFollows.find((dbf) => dbf.follow_did === f.did);
          if (!existing) return false; // Not an update, it's new
          return (
            existing.follow_handle !== f.handle ||
            existing.rkey !== (f.rkey || null)
          );
        });

        // Announce newly discovered follows before syncing to DB
        if (newFollows.length > 0) {
          const userHandle = await resolveHandle(userDID);
          console.log(
            `➕ Adding ${newFollows.length} new follow(s) for ${userDID}${userHandle ? ` (@${userHandle})` : ""}`,
          );
        }

        // Announce follow records that require updating (handle or rkey changed)
        if (updatedFollows.length > 0) {
          const userHandle = await resolveHandle(userDID);
          console.log(
            `💾 Updating ${updatedFollows.length} follow(s) for ${userDID}${userHandle ? ` (@${userHandle})` : ""}`,
          );
        }

        // Update all current follows (UPSERT handles new + updates)
        if (currentFollows.length > 0) {
          await withDBRetry(
            () => addMonitoredFollows(userDID, currentFollows),
            `Syncing follows for ${userDID}`,
          );
        }
      }
      console.log("✅ Follow synchronization complete");
    } catch (error) {
      console.error("❌ Error synchronizing follows:", error);
      // Don't throw - we want to continue even if sync fails
    }
  }

  /**
   * Start the Jetstream service: load DIDs, connect and begin polling.
   *
   * @param cursor - Optional cursor timestamp in microseconds to start from.
   * @returns Promise resolving once the initial connection attempt is made.
   */
  async start(cursor?: number) {
    console.log("🚀 Starting Jetstream Service...");

    // Ensure service should run
    this.shouldRun = true;

    // Set start time
    this.startTime = new Date();

    // If cursor is provided, use it instead of loading from DB
    if (cursor !== undefined) {
      this.lastCursor = cursor;
      // Check if cursor is in the past (backfill mode)
      const cursorTime = cursor / 1000; // Convert microseconds to milliseconds
      const now = Date.now();
      const timeDiff = now - cursorTime;
      // If cursor is more than 1 minute old, we're doing a backfill
      this.isInActualBackfill = timeDiff > 60000;
      if (this.isInActualBackfill) {
        this.actualBackfillLagSeconds = Math.floor(timeDiff / 1000);
        console.log(
          `⏪ Starting in backfill mode (cursor is ${this.actualBackfillLagSeconds}s behind)`,
        );
      }
    }

    // Sync follows from Bluesky API before loading DIDs
    await this.syncFollowsForAllUsers();

    // Load DIDs and connect
    await this.reloadDIDs();

    // Connect to Jetstream
    this.connect();
  }

  /**
   * Public hook to reload monitored DIDs immediately.
   *
   * @param source - Source of the reload: 'manual' (API call) or 'auto' (follow/unfollow event)
   * @returns Promise that resolves once the DID list has been refreshed.
   */
  async reloadDIDsNow(source: "manual" | "auto" = "manual") {
    const emoji = source === "manual" ? "📡" : "🔄";
    const label = source === "manual" ? "Manual" : "Auto";
    console.log(`${emoji} ${label} DID reload triggered`);
    await this.reloadDIDs();
  }

  /**
   * Refresh in-memory DID list and reconnect if it changed.
   *
   * @returns Promise resolving after DID state has been reconciled.
   */
  private async reloadDIDs() {
    try {
      let stateChanged = false;

      // Get all monitored DIDs (the people being followed)
      const followedDIDs = await withDBRetry(
        () => getAllMonitoredDIDs(),
        "Loading monitored DIDs",
      );

      // Get all user DIDs (the people who have monitoring enabled)
      // We need these to receive follow events FROM these users
      const userDIDs = await withDBRetry(
        () => getMonitoringUsers(),
        "Loading monitoring users",
      );

      // Get ignored DIDs to exclude them from monitoring (applies to both user + followed DIDs)
      const { getIgnoredUsers } = await import("./db.js");
      const ignoredUsers = await withDBRetry(
        () => getIgnoredUsers(),
        "Loading ignored users",
      );
      const ignoredSet = new Set(ignoredUsers.map((u) => u.did));

      // IMPORTANT: Put user DIDs FIRST to ensure they're always in the first 160 DIDs
      // (Jetstream has a limit). Also exclude any DID on the ignore list from BOTH groups.
      const userDIDsFiltered = userDIDs.filter((did) => !ignoredSet.has(did));
      const followedDIDsFiltered = followedDIDs.filter(
        (did) => !ignoredSet.has(did),
      );

      // Concatenate with user DIDs first; remove duplicates
      const dids = [
        ...userDIDsFiltered,
        ...followedDIDsFiltered.filter(
          (did) => !userDIDsFiltered.includes(did),
        ),
      ];

      // Nothing to monitor
      if (dids.length === 0) {
        console.log("⚠️  No DIDs to monitor yet");

        // If we had DIDs before but now have none, close the connection
        if (this.currentDIDs.length > 0) {
          console.log(
            "🛑 All users stopped monitoring, disconnecting Jetstream",
          );
          if (this.ws) {
            this.ws.close();
            this.ws = null;
          }
          stateChanged = true;
        }

        // Clear in-memory DID set; notify listeners if monitoring state changed
        this.currentDIDs = [];
        if (stateChanged) {
          triggerMonitoringStatusBroadcast();
        }
        return;
      }

      // Check if DIDs changed
      const didsChanged =
        dids.length !== this.currentDIDs.length ||
        dids.some((did, i) => did !== this.currentDIDs[i]);

      // Get current monitoring user count with retry for robust logging
      if (didsChanged) {
        const userCount = await withDBRetry(
          () => getMonitoringUserCount(),
          "Loading monitoring user count",
        );
        console.log(
          `📊 DIDs updated: ${dids.length} DIDs to monitor (from ${userCount} users)`,
        );

        // Persist new DID set and flag state change
        this.currentDIDs = dids;
        stateChanged = true;

        // Reconnect with new DIDs immediately to avoid event loss
        if (this.ws) {
          console.log("🔄 Reconnecting with updated DID list...");
          this.reconnectAttempts = 0; // Reset attempts for clean reconnect
          this.ws.close();
          // connect() will be called by onclose handler without delay (attempt = 0)
        }
      }

      // Broadcast monitoring status only if something actually changed
      if (stateChanged) {
        triggerMonitoringStatusBroadcast();
      }
    } catch (error) {
      // Log and continue; next scheduled reload will attempt again
      console.error("❌ Error reloading DIDs:", error);
    }
  }

  /**
   * Process incoming Jetstream event, persisting profile changes as needed.
   *
   * @param event - Jetstream event payload received from the socket.
   * @returns Promise resolving once persistence has finished.
   */
  private async processEvent(event: JetstreamEvent): Promise<void> {
    try {
      const hadValidCursor = this.isRunningWithCursor();
      const eventCursor = event.time_us;

      // Persist identity changes (handle changes).
      if (event.kind === "identity") {
        await withDBRetry(
          () => handleIdentityEvent(event, this.profileData),
          "Persisting Jetstream identity event",
        );
      }

      // Persist profile changes when relevant fields are updated.
      if (event.kind === "commit") {
        await withDBRetry(
          () => handleProfileCommit(event, this.profileData),
          "Persisting Jetstream commit event",
        );

        // Auto-add new follows to monitoring
        await withDBRetry(
          () =>
            handleFollowEvent(event, this, undefined, this.isInActualBackfill),
          "Processing follow event for auto-add",
        );
      }

      // Update cursor position and notify listeners only after successful persistence.
      this.lastCursor = eventCursor;
      this.broadcastCursorUpdate();

      // Check if backfill is complete (event timestamp is after service start time)
      if (this.isInActualBackfill && this.startTime) {
        const eventTime = eventCursor / 1000; // Convert microseconds to milliseconds
        const startTimeMs = this.startTime.getTime();
        if (eventTime >= startTimeMs) {
          if (this.actualBackfillLagSeconds != null) {
            console.log(
              `✅ Backfill complete (cursor was ${this.actualBackfillLagSeconds}s behind), now processing live events`,
            );
          } else {
            console.log("✅ Backfill complete, now processing live events");
          }
          this.isInActualBackfill = false;
          this.actualBackfillLagSeconds = null;
        }
      }

      // Broadcast when we transition from no cursor → valid cursor (entering live mode)
      const hasValidCursor = this.isRunningWithCursor();
      if (hasValidCursor && !hadValidCursor) {
        triggerMonitoringStatusBroadcast();
      }
    } catch (error) {
      // Per-event failure: log and continue processing subsequent events
      console.error("❌ Error processing event:", error);
    }
  }

  /**
   * Initiate or re-establish Jetstream WebSocket connection.
   *
   * @returns void
   */
  private connect() {
    this.lastHost = undefined;
    if (this.currentDIDs.length === 0) {
      console.log(
        "⏳ No DIDs to monitor - waiting for users to enable monitoring",
      );
      // Don't set a timeout here - wait for reloadDIDsNow() to be called when monitoring is enabled
      return;
    }

    // Use last cursor if available, otherwise start live (no cursor = latest events)
    const cursor = this.lastCursor || undefined;
    if (this.lastCursor) {
      console.log(
        `📍 Resuming from cursor position: ${cursorToHumanReadable(this.lastCursor)}`,
      );
      // Don't override isInActualBackfill here - it was set in start() based on cursor age
    } else {
      const nowCursor = Date.now() * 1000;
      console.log(`📍 Starting live from: ${cursorToHumanReadable(nowCursor)}`);
      this.isInActualBackfill = false;
      this.actualBackfillLagSeconds = null;
    }

    // Build URL (without DIDs, using requireHello mode)
    const { url, host } = buildJetstreamRequest(cursor);
    this.lastHost = host;

    // Connect to Jetstream
    try {
      console.log(`🔌 Connecting to Jetstream (${host})`);
      // Establish the websocket connection to the selected host.
      this.ws = new WebSocket(url);
      this.ws.on("open", () => {
        console.log("✅ Jetstream connected");
        this.reconnectAttempts = 0;

        // Send message with all DIDs to Jetstream
        const optionsMessage = buildOptionsUpdateMessage(this.currentDIDs);
        this.ws?.send(optionsMessage);
        console.log(
          `📤 Sent to Jetstream with ${this.currentDIDs.length} DIDs`,
        );

        // Only broadcast if we have a real cursor (from previous events)
        if (this.lastCursor) {
          this.broadcastCursorUpdate();
        }
        triggerMonitoringStatusBroadcast();
      });

      // Parse incoming events and hand them to the persistence helper.
      this.ws.on("message", (data: WebSocket.Data) => {
        try {
          const event: JetstreamEvent = JSON.parse(data.toString());
          this.processEvent(event);
        } catch (error) {
          console.error("❌ Error parsing message:", error);
        }
      });

      // Surface websocket level failures for observability.
      this.ws.on("error", (error) => {
        console.error("❌ Jetstream error:", error.message);
      });

      // On close schedule a reconnect attempt (with exponential backoff).
      this.ws.on("close", (code, reason) => {
        const reasonText =
          reason?.toString("utf8") || "No close reason provided";
        console.log(
          `🔌 Jetstream disconnected from ${this.lastHost ?? "unknown host"} (code: ${code}, reason: ${reasonText})`,
        );

        // If attempts is 0, this is a manual reconnect (e.g., DID reload) - connect immediately
        if (this.shouldRun) {
          const isManualReconnect = this.reconnectAttempts === 0;

          // Increment attempt counter only for backoff-driven reconnects (not manual reloads)
          if (!isManualReconnect) {
            this.reconnectAttempts++;
          }

          // Compute reconnect delay: immediate for manual reloads,
          // otherwise exponential backoff capped at 30s
          const delay = isManualReconnect
            ? 0
            : Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);

          // Log scheduled reconnect delay only when > 0 (backoff path)
          if (delay > 0) {
            console.log(
              `🔄 Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts})...`,
            );
          }
          // No log for immediate reconnect (DID reload) - already logged by the action that triggered it

          this.reconnectTimeout = setTimeout(() => this.connect(), delay);
        }
        triggerMonitoringStatusBroadcast();
      });

      // Schedule a conservative retry in 5s to avoid tight reconnect loops
    } catch (error) {
      console.error("❌ Failed to connect:", error);
      this.reconnectTimeout = setTimeout(() => this.connect(), 5000);
    }
  }

  /**
   * Stop Jetstream processing and cleanup timers.
   *
   * @returns Promise that resolves after the socket has been closed.
   */
  async stop() {
    console.log("🛑 Stopping Jetstream Service...");
    this.shouldRun = false;

    // Save cursor for potential resume (if stopped <24h, can continue from here)
    this.cursorAtStop = this.lastCursor;
    this.stoppedAt = new Date();

    // Persist to database so it survives server restarts
    if (this.cursorAtStop && this.stoppedAt) {
      const { saveSetting } = await import("./db.js");
      await saveSetting("jetstream_stop_cursor", this.cursorAtStop);
      await saveSetting("jetstream_stop_time", this.stoppedAt.toISOString());
    }

    // Reset active state
    this.lastCursor = null;
    this.startTime = null;
    this.isInActualBackfill = false;
    this.actualBackfillLagSeconds = null;

    // Timeout & Close
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null; // Immediately set to null
    }
    triggerMonitoringStatusBroadcast();
  }

  /**
   * Expose current cursor info for admin panel consumption.
   *
   * @returns Cursor metadata or null when no cursor is known.
   */
  getCursorInfo() {
    let timestamp: string | null = null;

    // Convert internal microsecond cursor to ISO8601 when available
    if (this.lastCursor) {
      const cursorDate = new Date(this.lastCursor / 1000);
      timestamp = cursorDate.toISOString();
    }

    // Provide ISO timestamp (or null) and whether we're still backfilling
    return {
      timestamp,
      isInBackfill: this.isInActualBackfill,
    };
  }

  /**
   * Get recommended cursor for starting Jetstream.
   * If stopped <24h ago, returns cursor at stop time. Otherwise returns current time (live).
   *
   * @returns Cursor in microseconds, or null to start live.
   */
  async getRecommendedStartCursor(): Promise<number> {
    // Load from memory first
    let cursor = this.cursorAtStop;
    let stoppedAt = this.stoppedAt;

    // If not in memory, try loading from database
    if (!cursor || !stoppedAt) {
      const { loadSetting } = await import("./db.js");
      cursor = await loadSetting("jetstream_stop_cursor");
      const stopTimeStr = await loadSetting("jetstream_stop_time");
      if (stopTimeStr) {
        stoppedAt = new Date(stopTimeStr);
      }

      // Cache in memory for future calls
      if (cursor && stoppedAt) {
        this.cursorAtStop = cursor;
        this.stoppedAt = stoppedAt;
      }
    }

    // If we have a cursor from when we stopped, and it's <24h old, use it
    if (cursor && stoppedAt) {
      const stopAge = Date.now() - stoppedAt.getTime();
      const twentyFourHours = 24 * 60 * 60 * 1000;

      // If the service stopped less than 24h ago, resume from the saved cursor
      if (stopAge < twentyFourHours) {
        return cursor;
      }
    }

    // Default: current time (live start)
    return Date.now() * 1000;
  }

  /**
   * Expose uptime metrics for admin panel.
   *
   * @returns Uptime details or null if service never started.
   */
  getUptimeInfo() {
    if (!this.startTime || !this.shouldRun) {
      return null;
    }

    // Calculate uptime
    const uptimeMs = Date.now() - this.startTime.getTime();
    const uptimeSeconds = Math.floor(uptimeMs / 1000);
    const uptimeMinutes = Math.floor(uptimeSeconds / 60);
    const uptimeHours = Math.floor(uptimeMinutes / 60);
    const uptimeDays = Math.floor(uptimeHours / 24);

    // Structured uptime snapshot for admin UI
    return {
      startTime: this.startTime.toISOString(),
      uptimeSeconds,
      uptimeMinutes,
      uptimeHours,
      uptimeDays,
    };
  }

  /**
   * Determine whether Jetstream is currently running with a valid cursor.
   *
   * @returns True when the service has an established cursor and sufficient uptime.
   */
  isRunningWithCursor() {
    // Has cursor AND it's not brand new (running for at least 30 seconds)
    const hasValidCursor = this.lastCursor !== null;
    const hasUptime = this.startTime !== null;
    const runningSinceMs = hasUptime
      ? Date.now() - this.startTime!.getTime()
      : 0;
    const runningForAtLeast30s = runningSinceMs > 30000;
    return hasValidCursor && runningForAtLeast30s;
  }

  /**
   * Provide summary of main Jetstream status for monitoring endpoint.
   *
   * @returns Snapshot describing running state, DID count and cursor validity.
   */
  getMainStreamStatus() {
    const isRunning =
      this.shouldRun && this.ws !== null && this.currentDIDs.length > 0;

    // Summarize current main stream status for consumption by APIs/UI
    return {
      isRunning,
      // Count of DIDs currently fed to the main stream
      monitoredDIDs: this.currentDIDs.length,
      // Cursor is only valid if stream is actually running
      hasValidCursor: isRunning && this.isRunningWithCursor(),
    };
  }
}

// Singleton instance shared across the backend.
const jetstreamService = new JetstreamService();

/**
 * Build a TemporaryJetstreamManager instance with injected dependencies.
 *
 * Injects cursor helpers, request builders, DB retry wrapper, backfill markers,
 * identity/profile/follow handlers, a broadcast hook, an ignore-list provider,
 * and the main Jetstream service reference. This avoids circular imports and
 * centralizes configuration of temp-stream behavior and limits.
 */
export const temporaryJetstreamManager = createTemporaryJetstreamManager({
  getCursor24hAgo,
  buildJetstreamRequest,
  cursorToHumanReadable,
  withDBRetry,
  markBackfillStarted,
  markBackfillCompleted,
  resolveHandle,
  handleIdentityEvent,
  handleProfileCommit,
  handleFollowEvent,
  triggerMonitoringStatusBroadcast,
  getIgnoredUsers: async () => {
    const { getIgnoredUsers } = await import("./db.js");
    return getIgnoredUsers();
  },
  maxConcurrentTempStreams: 50,
  mainJetstreamService: jetstreamService,
});

// Shutdown handling
process.on("SIGTERM", () => jetstreamService.stop());
process.on("SIGINT", () => jetstreamService.stop());

export default jetstreamService;
