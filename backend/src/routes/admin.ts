/**
 * Admin API routes - Only accessible for the configured admin DID.
 */

import express from "express";
import type { APIResponse } from "../../../shared/types.js";
import {
  addIgnoredUser,
  countSnapshots,
  getIgnoredUsers,
  getNoisyAccounts,
  removeIgnoredUser,
  unflagNoisy,
} from "../db.js";
import { ingester } from "../ingest/index.js";
import { requireAdmin } from "../middleware/auth.js";
import { resolveHandles } from "../utils/handle-resolver.js";
import { validate } from "../validation/middleware.js";
import {
  addIgnoredUserBodySchema,
  didParamSchema,
  jetstreamStartBodySchema,
} from "../validation/schemas.js";

// Create Router
const router = express.Router();

// Last event older than this counts as "catching up" rather than live
const LIVE_THRESHOLD_MS = 60_000;

/**
 * GET /api/admin/stats
 * Ingestion statistics
 */
router.get("/stats", requireAdmin, async (_req, res) => {
  try {
    const status = ingester.status();
    const trackedAccounts = await countSnapshots();
    const lastEventMs = status.lastEventTime
      ? Date.parse(status.lastEventTime)
      : null;

    // Field names kept compatible with the current admin panel
    const response: APIResponse<{
      totalMonitoredDIDs: number;
      totalMonitoringUsers: number;
      jetstreamStatus: string;
      cursorTimestamp: string | null;
      isInBackfill: boolean;
      uptimeSeconds: number | null;
      ingestion: typeof status;
    }> = {
      success: true,
      data: {
        totalMonitoredDIDs: trackedAccounts,
        totalMonitoringUsers: 0,
        jetstreamStatus: status.running ? "connected" : "disconnected",
        cursorTimestamp: status.lastEventTime,
        isInBackfill:
          lastEventMs !== null && Date.now() - lastEventMs > LIVE_THRESHOLD_MS,
        uptimeSeconds: status.startedAt
          ? Math.floor((Date.now() - Date.parse(status.startedAt)) / 1000)
          : null,
        ingestion: status,
      },
    };

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
 * Stop ingestion (persists the cursor for a later resume)
 */
router.post("/jetstream/stop", requireAdmin, async (_req, res) => {
  try {
    console.log("🛑 Admin triggered Jetstream stop");
    await ingester.stop();
    const response: APIResponse<{ message: string }> = {
      success: true,
      data: { message: "Jetstream stopped successfully" },
    };
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
 * Unix-microsecond cursor of the last processed event (or now)
 */
router.get("/jetstream/recommended-cursor", requireAdmin, (_req, res) => {
  const { lastEventTime } = ingester.status();
  const cursor =
    (lastEventTime ? Date.parse(lastEventTime) : Date.now()) * 1000;
  const response: APIResponse<{ cursor: number }> = {
    success: true,
    data: { cursor },
  };
  res.json(response);
});

/**
 * POST /api/admin/jetstream/start
 * Start ingestion. Optional cursor: v2 seq or unix microseconds (>= 1e15);
 * without one, ingestion resumes from the stored cursor.
 */
router.post(
  "/jetstream/start",
  requireAdmin,
  validate(jetstreamStartBodySchema),
  async (req, res) => {
    try {
      if (ingester.status().running) {
        const response: APIResponse<never> = {
          success: false,
          error: "Jetstream is already running",
        };
        res.status(409).json(response);
        return;
      }

      const { cursor } = req.body as { cursor?: number };
      console.log(
        `🚀 Admin triggered Jetstream start${cursor ? ` with cursor ${cursor}` : ""}`,
      );
      await ingester.start(cursor);

      const response: APIResponse<{ message: string }> = {
        success: true,
        data: { message: "Jetstream started successfully" },
      };
      res.json(response);
    } catch (error) {
      console.error("Error starting Jetstream:", error);
      const response: APIResponse<never> = {
        success: false,
        error: "Failed to start Jetstream",
      };
      res.status(500).json(response);
    }
  },
);

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
router.post(
  "/ignored-users",
  requireAdmin,
  validate(addIgnoredUserBodySchema),
  async (req, res) => {
    try {
      const { did } = req.body;

      // Add to ignore list
      const result = await addIgnoredUser(did);

      console.log(`🚫 Admin added ${did} to ignore list`);

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
  },
);

/**
 * DELETE /api/admin/ignored-users/:did
 * Remove a user from the ignored list
 */
router.delete(
  "/ignored-users/:did",
  requireAdmin,
  validate(didParamSchema, "params"),
  async (req, res) => {
    try {
      const { did } = req.params;

      // Remove from ignore list
      await removeIgnoredUser(did);

      console.log(`✅ Admin removed ${did} from ignore list`);

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
  },
);

/**
 * GET /api/admin/noisy-accounts
 * Accounts auto-flagged as bots
 */
router.get("/noisy-accounts", requireAdmin, async (_req, res) => {
  try {
    const accounts = await getNoisyAccounts();
    const resolved = await resolveHandles(accounts.map((a) => a.did));
    const handleMap = new Map(resolved.map((r) => [r.did, r.handle]));

    const response: APIResponse<
      Array<{
        did: string;
        reason: string;
        flagged_at: string;
        handle: string | null;
      }>
    > = {
      success: true,
      data: accounts.map((a) => ({
        ...a,
        handle: handleMap.get(a.did) ?? null,
      })),
    };
    res.json(response);
  } catch (error) {
    console.error("Error fetching noisy accounts:", error);
    const response: APIResponse<never> = {
      success: false,
      error: "Failed to fetch noisy accounts",
    };
    res.status(500).json(response);
  }
});

/**
 * DELETE /api/admin/noisy-accounts/:did
 * Remove the bot flag (e.g. a false positive); its changes become visible again
 */
router.delete(
  "/noisy-accounts/:did",
  requireAdmin,
  validate(didParamSchema, "params"),
  async (req, res) => {
    try {
      const { did } = req.params;
      await unflagNoisy(did);
      console.log(`✅ Admin removed bot flag from ${did}`);

      const response: APIResponse<{ message: string }> = {
        success: true,
        data: { message: `Bot flag removed from ${did}` },
      };
      res.json(response);
    } catch (error) {
      console.error("Error removing bot flag:", error);
      const response: APIResponse<never> = {
        success: false,
        error: "Failed to remove bot flag",
      };
      res.status(500).json(response);
    }
  },
);

export default router;
