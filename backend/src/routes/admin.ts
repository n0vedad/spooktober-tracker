/**
 * Admin API routes - Only accessible for the configured admin DID.
 */

import express from "express";
import type { APIResponse } from "../../../shared/types.js";
import {
  addIgnoredUser,
  getAllMonitoredDIDs,
  getIgnoredUsers,
  removeIgnoredUser,
} from "../db.js";
import jetstreamService from "../jetstream-service.js";
import { requireAdmin } from "../middleware/auth.js";
import { resolveHandles } from "../utils/handle-resolver.js";

const router = express.Router();

/**
 * GET /api/admin/stats
 * Get monitoring statistics
 */
router.get("/stats", requireAdmin, async (req, res) => {
  try {
    const monitoredDIDs = await getAllMonitoredDIDs();

    // Get user count
    const { pool } = await import("../db.js");
    const userCountResult = await pool.query(
      "SELECT COUNT(DISTINCT user_did) as count FROM monitored_follows",
    );

    // Get cursor info
    const cursorInfo = jetstreamService.getCursorInfo();
    const uptimeInfo = jetstreamService.getUptimeInfo();
    const mainStreamStatus = jetstreamService.getMainStreamStatus();

    // Compose admin stats snapshot payload for the client.
    const response: APIResponse<{
      totalMonitoredDIDs: number;
      totalMonitoringUsers: number;
      jetstreamStatus: string;
      cursorTimestamp: string | null;
      isInBackfill: boolean;
      uptimeSeconds: number | null;
    }> = {
      success: true,
      data: {
        totalMonitoredDIDs: monitoredDIDs.length,
        totalMonitoringUsers: parseInt(userCountResult.rows[0].count),
        jetstreamStatus: mainStreamStatus.isRunning
          ? "connected"
          : "disconnected",
        cursorTimestamp: cursorInfo?.timestamp || null,
        isInBackfill: cursorInfo?.isInBackfill ?? false,
        uptimeSeconds: uptimeInfo?.uptimeSeconds || null,
      },
    };

    // Response & error handling
    res.json(response);
  } catch (error) {
    console.error("Error fetching admin stats:", error);
    const response: APIResponse<never> = {
      success: false,
      error: "Failed to fetch admin stats",
    };
    res.status(500).json(response);
  }
});

/**
 * POST /api/admin/jetstream/stop
 * Stop Jetstream (emergency stop)
 */
router.post("/jetstream/stop", requireAdmin, async (req, res) => {
  try {
    console.log("🛑 Admin triggered Jetstream stop");
    await jetstreamService.stop();

    // Acknowledge successful Jetstream shutdown for admin UI feedback.
    const response: APIResponse<{ message: string }> = {
      success: true,
      data: {
        message: "Jetstream stopped successfully",
      },
    };

    // Response & error handling
    res.json(response);
  } catch (error) {
    console.error("Error stopping Jetstream:", error);
    const response: APIResponse<never> = {
      success: false,
      error: "Failed to stop Jetstream",
    };
    res.status(500).json(response);
  }
});

/**
 * GET /api/admin/jetstream/recommended-cursor
 * Get recommended cursor for starting Jetstream
 */
router.get("/jetstream/recommended-cursor", requireAdmin, async (req, res) => {
  try {
    const recommendedCursor =
      await jetstreamService.getRecommendedStartCursor();

    // Return recommended start cursor for Jetstream startup.
    const response: APIResponse<{ cursor: number }> = {
      success: true,
      data: {
        cursor: recommendedCursor,
      },
    };

    // Response & error handling
    res.json(response);
  } catch (error) {
    console.error("Error getting recommended cursor:", error);
    const response: APIResponse<never> = {
      success: false,
      error: "Failed to get recommended cursor",
    };
    res.status(500).json(response);
  }
});

/**
 * POST /api/admin/jetstream/start
 * Start Jetstream with optional cursor
 */
router.post("/jetstream/start", requireAdmin, async (req, res) => {
  try {
    const { cursor } = req.body;

    // Format cursor for logging
    let logMessage = "🚀 Admin triggered Jetstream start";
    if (cursor) {
      const cursorDate = new Date(cursor / 1000);
      const formattedDate = cursorDate.toLocaleString("de-DE", {
        timeZone: "Europe/Berlin",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });
      logMessage += ` with cursor: ${cursor} (${formattedDate})`;
    }
    console.log(logMessage);

    await jetstreamService.start(cursor);

    // Acknowledge successful Jetstream startup for admin UI feedback.
    const response: APIResponse<{ message: string }> = {
      success: true,
      data: {
        message: "Jetstream started successfully",
      },
    };

    // Response & error handling
    res.json(response);
  } catch (error) {
    console.error("Error starting Jetstream:", error);
    const response: APIResponse<never> = {
      success: false,
      error: "Failed to start Jetstream",
    };
    res.status(500).json(response);
  }
});

/**
 * GET /api/admin/ignored-users
 * Get all ignored users
 */
router.get("/ignored-users", requireAdmin, async (req, res) => {
  try {
    const ignoredUsers = await getIgnoredUsers();
    const resolved = await resolveHandles(ignoredUsers.map((user) => user.did));
    const handleMap = new Map(
      resolved.map((entry) => [entry.did, entry.handle]),
    );

    // Return ignored-user records augmented with their latest handle if available.
    const response: APIResponse<
      { did: string; added_at: string; handle: string | null }[]
    > = {
      success: true,
      data: ignoredUsers.map((user) => ({
        ...user,
        // Populate handle from map fallbacking to null when unresolved.
        handle: handleMap.get(user.did) ?? null,
      })),
    };

    // Response & error handling
    res.json(response);
  } catch (error) {
    console.error("Error fetching ignored users:", error);
    const response: APIResponse<never> = {
      success: false,
      error: "Failed to fetch ignored users",
    };
    res.status(500).json(response);
  }
});

/**
 * POST /api/admin/ignored-users
 * Add a user to the ignored list (also deletes their profile changes)
 */
router.post("/ignored-users", requireAdmin, async (req, res) => {
  try {
    const { did } = req.body;

    // Validate DID format
    if (!did || !did.startsWith("did:plc:")) {
      const response: APIResponse<never> = {
        success: false,
        error: "Invalid DID format (must be did:plc:xxxxx)",
      };
      return res.status(400).json(response);
    }

    // Add to ignore list
    const result = await addIgnoredUser(did);

    // Trigger immediate Jetstream DID reload to stop monitoring this DID
    const { resolveHandle } = await import("../utils/handle-resolver.js");
    const userHandle = await resolveHandle(did);
    const userLabel = userHandle ? `${userHandle} (${did})` : did;
    console.log(
      `🚫 Admin added ${userLabel} to ignore list - removing from Jetstream`,
    );
    await jetstreamService.reloadDIDsNow();

    // Report the DID, deleted change count, and a human-readable summary.
    const response: APIResponse<{
      did: string;
      deletedChanges: number;
      message: string;
    }> = {
      success: true,
      data: {
        did: result.did,
        deletedChanges: result.deletedChanges ?? 0,
        message: `User ${did} added to ignore list. Deleted ${result.deletedChanges ?? 0} profile change(s).`,
      },
    };

    // Response & error handling
    res.json(response);
  } catch (error) {
    console.error("Error adding ignored user:", error);
    const response: APIResponse<never> = {
      success: false,
      error: "Failed to add ignored user",
    };
    res.status(500).json(response);
  }
});

/**
 * DELETE /api/admin/ignored-users/:did
 * Remove a user from the ignored list
 */
router.delete("/ignored-users/:did", requireAdmin, async (req, res) => {
  try {
    const { did } = req.params;

    // Remove from ignore list
    await removeIgnoredUser(did);

    // Trigger immediate Jetstream DID reload to start monitoring this DID again (if followed)
    const { resolveHandle } = await import("../utils/handle-resolver.js");
    const userHandle = await resolveHandle(did);
    const userLabel = userHandle ? `${userHandle} (${did})` : did;
    console.log(
      `✅ Admin removed ${userLabel} from ignore list - adding back to Jetstream if followed`,
    );
    await jetstreamService.reloadDIDsNow();

    // Confirm ignored-user removal with a simple success message payload.
    const response: APIResponse<{ message: string }> = {
      success: true,
      data: {
        message: `User ${did} removed from ignore list`,
      },
    };

    // Response & error handling
    res.json(response);
  } catch (error) {
    console.error("Error removing ignored user:", error);
    const response: APIResponse<never> = {
      success: false,
      error: "Failed to remove ignored user",
    };
    res.status(500).json(response);
  }
});

export default router;
