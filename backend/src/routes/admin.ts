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
import { describeIngestion, type IngestionHealth } from "../ingest/health.js";
import { ingester } from "../ingest/index.js";
import { labeler } from "../labeler/index.js";
import { countActiveLabels, listOptIns } from "../labeler/store.js";
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

/**
 * GET /api/admin/stats
 * Ingestion health, tracked accounts and labeler figures
 */
router.get("/stats", requireAdmin, async (_req, res) => {
  try {
    const [trackedAccounts, optIns, labels] = await Promise.all([
      countSnapshots(),
      labeler ? listOptIns().then((rows) => rows.length) : 0,
      labeler ? countActiveLabels() : { labels: 0, accounts: 0 },
    ]);

    const response: APIResponse<{
      ingestion: IngestionHealth;
      trackedAccounts: number;
      labeler: {
        enabled: boolean;
        optIns: number;
        activeLabels: number;
        labeledAccounts: number;
      };
    }> = {
      success: true,
      data: {
        ingestion: describeIngestion(ingester.status()),
        trackedAccounts,
        labeler: {
          enabled: labeler !== null,
          optIns,
          activeLabels: labels.labels,
          labeledAccounts: labels.accounts,
        },
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
 * GET /api/admin/optins
 * Accounts that opted in to the labeler, newest first
 */
router.get("/optins", requireAdmin, async (_req, res) => {
  try {
    const optIns = labeler ? await listOptIns() : [];
    const resolved = await resolveHandles(optIns.map((o) => o.did));
    const handles = new Map(resolved.map((r) => [r.did, r.handle]));

    const response: APIResponse<
      Array<{
        did: string;
        handle: string | null;
        via: string;
        opted_in_at: Date;
      }>
    > = {
      success: true,
      data: optIns.map((o) => ({ ...o, handle: handles.get(o.did) ?? null })),
    };
    res.json(response);
  } catch (error) {
    console.error("Error fetching opt-ins:", error);
    const response: APIResponse<never> = {
      success: false,
      error: "Failed to fetch opt-ins",
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
    if (!ingester.status().running) {
      const response: APIResponse<never> = {
        success: false,
        error: "Jetstream is not running",
      };
      res.status(409).json(response);
      return;
    }
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
      {
        did: string;
        added_at: string;
        self_service: boolean;
        handle: string | null;
      }[]
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
      // Validated by didParamSchema above
      const { did } = req.params as { did: string };

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
      // Validated by didParamSchema above
      const { did } = req.params as { did: string };
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
