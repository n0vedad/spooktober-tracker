/**
 * API routes for monitoring management
 */

import express from "express";
import type { APIResponse } from "../../../shared/types.js";
import {
  addMonitoredFollows,
  getBackfillState,
  getChangesForUser,
  getMonitoredFollows,
  getMonitoringUserCounts,
  removeMonitoredFollows,
} from "../db.js";
import jetstreamService, {
  LOOKBACK_MS_24H,
  temporaryJetstreamManager,
} from "../jetstream-service.js";
import { requireAdmin, requireAuth } from "../middleware/auth.js";
import { resolveHandles } from "../utils/handle-resolver.js";

const router = express.Router();

// Lock window to avoid re-triggering backfill within the last 24 hours.
const BACKFILL_LOCK_WINDOW_MS = LOOKBACK_MS_24H;

/**
 * Structured snapshot describing the current monitoring system state.
 *
 * Fields
 * - mainStream: Status of the long‑running main Jetstream stream, including
 *   `isRunning` (connected/processing), `monitoredDIDs` (DIDs in stream) and
 *   `hasValidCursor` (whether processing from a valid cursor rather than cold start).
 * - tempStreams: Count of active short‑lived backfill streams.
 * - maxStreams: Maximum number of concurrent temporary streams allowed.
 * - queueLength: Users currently queued waiting for a temporary stream.
 * - availableSlots: Number of free slots available for new temporary streams.
 * - activeUsers: Per‑user summary for active/monitored users with
 *   `did`, `handle`, `monitoredCount`, `lastStartedAt`, `lastCompletedAt`,
 *   and `hasCompletedBackfill`.
 * - tempStreamUsers: Users currently owning a temporary stream (for display).
 */
export interface MonitoringStatusSnapshot {
  mainStream: {
    isRunning: boolean;
    monitoredDIDs: number;
    hasValidCursor: boolean;
  };
  tempStreams: number;
  maxStreams: number;
  queueLength: number;
  availableSlots: number;
  activeUsers: Array<{
    did: string;
    handle: string | null;
    monitoredCount: number;
    lastStartedAt: string | null;
    lastCompletedAt: string | null;
    hasCompletedBackfill: boolean;
  }>;
  tempStreamUsers: Array<{ did: string; handle: string | null }>;
}

// Callback signature for monitoring status updates
type MonitoringStatusBroadcaster = (snapshot: MonitoringStatusSnapshot) => void;
let monitoringStatusBroadcaster: MonitoringStatusBroadcaster | null = null;

/**
 * Compute a full monitoring snapshot combining Jetstream state,
 * temporary stream information and per-user backfill metadata.
 *
 * @returns Promise resolving with the aggregated monitoring status.
 */
export async function getMonitoringStatusSnapshot(): Promise<MonitoringStatusSnapshot> {
  const tempStatus = temporaryJetstreamManager.getStatus();
  const mainStatus = jetstreamService.getMainStreamStatus();
  const userCounts = await getMonitoringUserCounts();
  const resolvedUsers = await resolveHandles(
    userCounts.map((entry) => entry.user_did),
  );

  // Map DID -> resolved handle for quick access
  const handleMap = new Map(
    resolvedUsers.map((entry) => [entry.did, entry.handle]),
  );

  // Assemble per-user activity summary with resolved handles
  const activeUsers = userCounts.map((entry) => ({
    did: entry.user_did,
    handle: handleMap.get(entry.user_did) ?? null,
    monitoredCount: entry.did_count,
    lastStartedAt: entry.last_started_at,
    lastCompletedAt: entry.last_completed_at,
    hasCompletedBackfill: entry.last_completed_at !== null,
  }));

  // Resolve handles for users currently assigned a temporary stream
  const tempStreamUsers = await resolveHandles(tempStatus.activeUsers);

  // Final aggregated monitoring snapshot returned to callers
  return {
    mainStream: mainStatus,
    tempStreams: tempStatus.activeStreams,
    maxStreams: tempStatus.maxStreams,
    queueLength: tempStatus.queueLength,
    availableSlots: tempStatus.availableSlots,
    activeUsers,
    tempStreamUsers,
  };
}

/**
 * Register a callback that will receive real-time monitoring status updates.
 *
 * @param broadcaster Callback invoked whenever the snapshot changes.
 */
export function registerMonitoringStatusBroadcaster(
  broadcaster: MonitoringStatusBroadcaster,
) {
  monitoringStatusBroadcaster = broadcaster;
}

/**
 * Emit the latest monitoring snapshot to the registered broadcaster, if any.
 *
 * @returns Promise that resolves after the update has been dispatched.
 */
export async function broadcastMonitoringStatusUpdate(): Promise<void> {
  if (!monitoringStatusBroadcaster) return;
  try {
    const snapshot = await getMonitoringStatusSnapshot();
    monitoringStatusBroadcaster(snapshot);
  } catch (error) {
    console.error("❌ Failed to broadcast monitoring status:", error);
  }
}

/**
 * POST /api/monitoring/enable
 * Enable monitoring for a user's follows (requires login)
 * Body: { user_did: string, follows: Array<{ did: string, handle: string }> }
 */
router.post("/enable", requireAuth, async (req, res) => {
  try {
    const { user_did, follows } = req.body as {
      user_did?: string;
      follows?: Array<{ did: string; handle: string }>;
    };

    // Validate that a requesting user DID accompanies the payload.
    if (!user_did) {
      const response: APIResponse<never> = {
        success: false,
        error: "user_did is required",
      };
      return res.status(400).json(response);
    }

    // Require at least one follow entry to enable monitoring.
    if (!follows || !Array.isArray(follows) || follows.length === 0) {
      const response: APIResponse<never> = {
        success: false,
        error: "follows array is required and must not be empty",
      };
      return res.status(400).json(response);
    }

    // Check global 10,000 DID limit
    const { getAllMonitoredDIDs, getMonitoredFollows } = await import(
      "../db.js"
    );
    const currentMonitoredDIDs = await getAllMonitoredDIDs();
    const currentCount = currentMonitoredDIDs.length;

    // Get user's current follows to calculate net new DIDs
    const userCurrentFollows = await getMonitoredFollows(user_did);
    const userCurrentDIDs = new Set(
      userCurrentFollows.map((f) => f.follow_did),
    );
    const requestedDIDs = new Set(follows.map((f) => f.did));
    const newDIDs = [...requestedDIDs].filter(
      (did) => !userCurrentDIDs.has(did),
    );
    const netNewCount = newDIDs.length;
    const totalAfterAdd = currentCount + netNewCount;

    // Enforce global cap of 10,000 monitored DIDs to protect resources
    if (totalAfterAdd > 10000) {
      const response: APIResponse<never> = {
        success: false,
        error: `Cannot enable monitoring: would exceed 10,000 DID limit. Currently monitoring ${currentCount} DIDs globally, your request would add ${netNewCount} new DIDs (total: ${totalAfterAdd}). Please try again later or reduce your follow count.`,
      };
      return res.status(429).json(response);
    }

    // Check if temporary stream can be started
    // Check capacity before starting a temporary stream; return queue position when not allowed
    const canStart = temporaryJetstreamManager.canStartStream(user_did);
    if (!canStart.allowed) {
      const response: APIResponse<{
        queued: boolean;
        position?: number;
        reason?: string;
      }> = {
        success: true,
        data: {
          queued: Boolean(canStart.queuePosition),
          position: canStart.queuePosition,
          reason: canStart.reason,
        },
      };
      return res.json(response);
    }

    // Add monitored follows
    await addMonitoredFollows(user_did, follows);

    // Trigger immediate main Jetstream DID reload
    const { resolveHandle } = await import("../utils/handle-resolver.js");
    const userHandle = await resolveHandle(user_did);
    const userLabel = userHandle ? `${userHandle} (${user_did})` : user_did;
    console.log(
      `➕ User ${userLabel} enabled monitoring - reloading ${follows.length} DIDs`,
    );
    await jetstreamService.reloadDIDsNow();

    // Only start temporary Jetstream if main Jetstream is already running with a valid cursor
    // If main Jetstream just started (from 24h ago), it will catch everything itself
    let tempResult: { queued: boolean; position?: number } | null = null;
    let backfillTriggered = false;
    let backfillSkipReason: string | undefined;

    // Main Jetstream has an active cursor - need temporary stream for 24h backfill
    if (jetstreamService.isRunningWithCursor()) {
      const backfillState = await getBackfillState(user_did);
      const lastStartedAt = backfillState?.last_started_at
        ? new Date(backfillState.last_started_at)
        : null;
      const withinLockWindow =
        lastStartedAt !== null &&
        Date.now() - lastStartedAt.getTime() < BACKFILL_LOCK_WINDOW_MS;

      // Respect lock window: don't start another temp stream if a backfill began recently
      if (withinLockWindow) {
        console.log(
          `⏭️  Skipping temporary Jetstream for ${userLabel}; last backfill started ${lastStartedAt?.toISOString()}`,
        );
        backfillSkipReason = "recent_backfill";
      } else {
        const followDIDs = follows.map((f) => f.did);

        // Spin up a temporary stream to process recent history while main stream keeps pace.
        tempResult = await temporaryJetstreamManager.startForUser(
          user_did,
          followDIDs,
        );
        backfillTriggered = true;
      }
    } else {
      console.log(
        `ℹ️  Main Jetstream will handle 24h backfill for ${userLabel} (starting from 24h ago)`,
      );
      backfillSkipReason = "main_stream_catching_up";
    }

    // Summarize how many follows were registered and whether a temp stream was started/queued.
    const response: APIResponse<{
      count: number;
      temporaryStream: { queued: boolean; position?: number } | null;
      backfillTriggered: boolean;
      backfillSkipReason?: string;
    }> = {
      success: true,
      data: {
        count: follows.length,
        temporaryStream: tempResult,
        backfillTriggered,
        backfillSkipReason,
      },
    };

    // Broadcast latest monitoring status to live WebSocket clients
    await broadcastMonitoringStatusUpdate();
    res.json(response);

    // Fall back to a generic error payload when enabling fails unexpectedly.
  } catch (error) {
    console.error("Error enabling monitoring:", error);
    const response: APIResponse<never> = {
      success: false,
      error: "Failed to enable monitoring",
    };
    res.status(500).json(response);
  }
});

/**
 * GET /api/monitoring/status
 * Get Jetstream status (admin only)
 */
router.get("/status", requireAdmin, async (req, res) => {
  try {
    const snapshot = await getMonitoringStatusSnapshot();
    const response: APIResponse<typeof snapshot> = {
      success: true,
      data: snapshot,
    };

    res.json(response);

    // Error handling
  } catch (error) {
    console.error("Error getting monitoring status:", error);
    const response: APIResponse<never> = {
      success: false,
      error: "Failed to get monitoring status",
    };
    res.status(500).json(response);
  }
});

/**
 * POST /api/monitoring/backfill/:user_did
 * Manually trigger a temporary 24h backfill for an active user (admin only)
 */
router.post("/backfill/:user_did", requireAdmin, async (req, res) => {
  try {
    const { user_did } = req.params;
    const wantsRestart = Boolean((req.body as any)?.restart);
    const follows = await getMonitoredFollows(user_did);

    // Validate user has monitored follows before starting a backfill
    if (!follows || follows.length === 0) {
      const response: APIResponse<never> = {
        success: false,
        error: "User has no monitored follows",
      };
      return res.status(400).json(response);
    }

    // Resolve target identity and prepare human‑readable log/response labels
    const resolvedIdentity = await resolveHandles([user_did]);
    const identityHandle = resolvedIdentity[0]?.handle ?? null;
    const identityLabel = identityHandle
      ? `@${resolvedIdentity[0].handle} (${user_did})`
      : user_did;
    const formatMessage = (base: string, position?: number | undefined) =>
      position !== undefined
        ? `${identityLabel}: ${base} (#${position})`
        : `${identityLabel}: ${base}`;

    // Check capacity before starting a temporary stream; return queue position when not allowed
    const canStart = temporaryJetstreamManager.canStartStream(user_did);
    if (!canStart.allowed) {
      if (wantsRestart) {
        // Stop current temp stream and prepare to restart
        await temporaryJetstreamManager.stopForUser(user_did);
        // Wait briefly until the active entry is removed
        const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
        for (let i = 0; i < 50; i++) {
          const check = temporaryJetstreamManager.canStartStream(user_did);
          if (check.allowed) break;
          await wait(100);
        }
        // fallthrough to start below
      } else {
        const response: APIResponse<{
          queued: boolean;
          position?: number;
          message: string;
        }> = {
          success: true,
          data: {
            queued: Boolean(canStart.queuePosition),
            position: canStart.queuePosition,
            message: formatMessage(
              canStart.reason ?? "Temporary stream already active",
              canStart.queuePosition,
            ),
          },
        };
        return res.json(response);
      }
    }

    // Gather user's current follow DIDs and start a temporary backfill stream
    const followDIDs = follows.map((follow) => follow.follow_did);
    const result = await temporaryJetstreamManager.startForUser(
      user_did,
      followDIDs,
    );

    // Summarize temporary backfill start/queue outcome for admin UI
    const response: APIResponse<{
      queued: boolean;
      position?: number;
      message: string;
    }> = {
      success: true,
      data: {
        queued: result.queued,
        position: result.position,
        message: result.queued
          ? formatMessage(
              wantsRestart
                ? "Temporary 24h backfill restart queued"
                : "User queued for temporary 24h backfill",
              result.position,
            )
          : formatMessage(
              wantsRestart
                ? "Temporary 24h backfill restarted"
                : "Temporary 24h backfill started",
            ),
      },
    };

    await broadcastMonitoringStatusUpdate();

    // Error handling
    res.json(response);
  } catch (error) {
    console.error("Error starting manual backfill:", error);
    const response: APIResponse<never> = {
      success: false,
      error: "Failed to start manual backfill",
    };
    res.status(500).json(response);
  }
});

/**
 * GET /api/monitoring/follows/:user_did
 * Get monitored follows for a user (requires login)
 */
router.get("/follows/:user_did", requireAuth, async (req, res) => {
  try {
    const { user_did } = req.params;

    // Retrieve the stored follow list for the specified user DID.
    const follows = await getMonitoredFollows(user_did);

    // Return the follows payload so clients can render monitoring state.
    const response: APIResponse<{ follows: typeof follows }> = {
      success: true,
      data: { follows },
    };

    res.json(response);

    // Surface a generic failure response on unexpected backend errors.
  } catch (error) {
    console.error("Error fetching monitored follows:", error);
    const response: APIResponse<never> = {
      success: false,
      error: "Failed to fetch monitored follows",
    };
    res.status(500).json(response);
  }
});

/**
 * GET /api/monitoring/changes/:user_did
 * Get all changes for a user's monitored follows (requires login)
 */
router.get("/changes/:user_did", requireAuth, async (req, res) => {
  try {
    const { user_did } = req.params;

    // Load monitored changes specific to the requested user DID.
    const changes = await getChangesForUser(user_did);

    // Include both the change list and the aggregated total for clients.
    const response: APIResponse<{ changes: typeof changes; total: number }> = {
      success: true,
      data: {
        changes,
        total: changes.length,
      },
    };

    res.json(response);

    // Expose a generic server failure to callers when retrieval fails.
  } catch (error) {
    console.error("Error fetching user changes:", error);
    const response: APIResponse<never> = {
      success: false,
      error: "Failed to fetch changes",
    };
    res.status(500).json(response);
  }
});

/**
 * DELETE /api/monitoring/disable/:user_did
 * Disable monitoring for a user (requires login)
 */
router.delete("/disable/:user_did", requireAuth, async (req, res) => {
  try {
    const { user_did } = req.params;

    await temporaryJetstreamManager.stopForUser(user_did);
    await removeMonitoredFollows(user_did);

    // Trigger immediate Jetstream DID reload (don't wait 5 minutes!)
    const { resolveHandle } = await import("../utils/handle-resolver.js");
    const userHandle = await resolveHandle(user_did);
    const userLabel = userHandle ? `${userHandle} (${user_did})` : user_did;
    console.log(
      `➖ User ${userLabel} disabled monitoring - removing DIDs from stream`,
    );
    await jetstreamService.reloadDIDsNow();

    // Confirm to the caller that monitoring is no longer active.
    const response: APIResponse<{ message: string }> = {
      success: true,
      data: { message: "Monitoring disabled" },
    };

    await broadcastMonitoringStatusUpdate();
    res.json(response);

    // Provide a generic failure response when disable fails unexpectedly.
  } catch (error) {
    console.error("Error disabling monitoring:", error);
    const response: APIResponse<never> = {
      success: false,
      error: "Failed to disable monitoring",
    };
    res.status(500).json(response);
  }
});

/**
 * DELETE /api/monitoring/purge/:user_did
 * Stop monitoring for a user and delete their own profile changes.
 *
 * Permanently removes a user's monitoring footprint and all related data,
 * and stops any temporary stream for that user.
 * This deletes:
 * - All profile_changes for the user's own DID
 * - All profile_changes for the DIDs the user was monitoring (their follows)
 * - All monitored_follows rows owned by the user
 * - Any backfill state rows for the user
 */
router.delete("/purge/:user_did", requireAuth, async (req, res) => {
  try {
    const { user_did } = req.params;

    // Stop any temporary stream for this user to avoid race conditions
    await temporaryJetstreamManager.stopForUser(user_did);

    // Connect and perform a transactional purge for consistency
    const { pool } = await import("../db.js");
    const client = await pool.connect();
    let deletedOwn = 0;
    let deletedForFollows = 0;
    let removedFollows = 0;
    try {
      await client.query("BEGIN");

      // Gather all DIDs that this user was monitoring (before removing the rows)
      const followedRes = await client.query<{ follow_did: string }>(
        "SELECT follow_did FROM monitored_follows WHERE user_did = $1",
        [user_did],
      );
      const followedDIDs = followedRes.rows.map((r) => r.follow_did);

      // Delete all profile changes for those followed DIDs (global contribution)
      if (followedDIDs.length > 0) {
        const deleteFollowsRes = await client.query(
          "DELETE FROM profile_changes WHERE did = ANY($1)",
          [followedDIDs],
        );
        deletedForFollows = deleteFollowsRes.rowCount ?? 0;
      }

      // Delete all profile changes for the user's own DID
      const deleteOwnRes = await client.query(
        "DELETE FROM profile_changes WHERE did = $1",
        [user_did],
      );
      deletedOwn = deleteOwnRes.rowCount ?? 0;

      // Remove all follows the user is monitoring
      const removeFollowsRes = await client.query(
        "DELETE FROM monitored_follows WHERE user_did = $1",
        [user_did],
      );
      removedFollows = removeFollowsRes.rowCount ?? 0;

      // Clear backfill state rows for this user
      await client.query(
        "DELETE FROM monitoring_backfill_state WHERE user_did = $1",
        [user_did],
      );

      await client.query("COMMIT");
    } catch (txnError) {
      await client.query("ROLLBACK");
      throw txnError;
    } finally {
      client.release();
    }

    // Trigger immediate DID reload so main Jetstream drops the user from the stream
    await jetstreamService.reloadDIDsNow();
    await broadcastMonitoringStatusUpdate();

    // Return counts for client feedback
    const totalDeleted = deletedOwn + deletedForFollows;
    const response: APIResponse<{
      message: string;
      deletedChanges: number;
      deletedOwnChanges: number;
      deletedFollowChanges: number;
      removedFollows: number;
    }> = {
      success: true,
      data: {
        message: "User data purged",
        deletedChanges: totalDeleted,
        deletedOwnChanges: deletedOwn,
        deletedFollowChanges: deletedForFollows,
        removedFollows,
      },
    };
    res.json(response);
  } catch (error) {
    console.error("Error purging user data:", error);
    const response: APIResponse<never> = {
      success: false,
      error: "Failed to purge user data",
    };
    res.status(500).json(response);
  }
});

export default router;
