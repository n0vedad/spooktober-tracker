/**
 * API routes for the per-user view of profile changes.
 *
 * The whole network is tracked continuously, so "monitoring" no longer needs
 * to be enabled per user: a user's view is simply the changes of the accounts
 * they follow. The enable/disable endpoints remain as no-ops so the current
 * frontend keeps working until it is rebuilt.
 */

import express from "express";
import type { APIResponse } from "../../../shared/types.js";
import { getChangesByDIDs, purgeAccount } from "../db.js";
import { ingester } from "../ingest/index.js";
import { requireAdmin, requireAuth } from "../middleware/auth.js";
import { getFollowDIDs, invalidateFollows } from "../utils/follows.js";
import { validate } from "../validation/middleware.js";
import {
  enableMonitoringBodySchema,
  userDidParamSchema,
} from "../validation/schemas.js";

const router = express.Router();

// Newest changes returned for a user's follows
const USER_CHANGES_LIMIT = 500;

/**
 * Reject requests where the path DID differs from the requesting user.
 * (Still header-based until OAuth sessions replace X-User-DID.)
 */
const requireSelf: express.RequestHandler = (req, res, next) => {
  if (req.params.user_did !== req.headers["x-user-did"]) {
    const response: APIResponse<never> = {
      success: false,
      error: "Forbidden: you can only access your own data",
    };
    res.status(403).json(response);
    return;
  }
  next();
};

/**
 * POST /api/monitoring/enable
 * Compatibility no-op: every account is tracked network-wide.
 */
router.post(
  "/enable",
  requireAuth,
  validate(enableMonitoringBodySchema),
  (req, res) => {
    const { follows } = req.body as { follows: unknown[] };
    const response: APIResponse<{
      count: number;
      temporaryStream: null;
      backfillTriggered: false;
      backfillSkipReason: string;
    }> = {
      success: true,
      data: {
        count: follows.length,
        temporaryStream: null,
        backfillTriggered: false,
        backfillSkipReason: "main_stream_catching_up",
      },
    };
    res.json(response);
  },
);

/**
 * GET /api/monitoring/status
 * Ingestion status (admin only)
 */
router.get("/status", requireAdmin, (_req, res) => {
  const response: APIResponse<ReturnType<typeof ingester.status>> = {
    success: true,
    data: ingester.status(),
  };
  res.json(response);
});

/**
 * GET /api/monitoring/follows/:user_did
 * DIDs the user follows (requires login)
 */
router.get(
  "/follows/:user_did",
  requireAuth,
  validate(userDidParamSchema, "params"),
  requireSelf,
  async (req, res) => {
    try {
      const dids = await getFollowDIDs(req.params.user_did);
      const response: APIResponse<{ follows: Array<{ follow_did: string }> }> =
        {
          success: true,
          data: { follows: dids.map((did) => ({ follow_did: did })) },
        };
      res.json(response);
    } catch (error) {
      console.error("Error fetching follows:", error);
      const response: APIResponse<never> = {
        success: false,
        error: "Failed to fetch follows",
      };
      res.status(500).json(response);
    }
  },
);

/**
 * GET /api/monitoring/changes/:user_did
 * Newest changes among the accounts the user follows (requires login)
 */
router.get(
  "/changes/:user_did",
  requireAuth,
  validate(userDidParamSchema, "params"),
  requireSelf,
  async (req, res) => {
    try {
      const dids = await getFollowDIDs(req.params.user_did);
      const changes = await getChangesByDIDs(dids, {
        limit: USER_CHANGES_LIMIT,
      });

      const response: APIResponse<{ changes: typeof changes; total: number }> =
        {
          success: true,
          data: { changes, total: changes.length },
        };
      res.json(response);
    } catch (error) {
      console.error("Error fetching user changes:", error);
      const response: APIResponse<never> = {
        success: false,
        error: "Failed to fetch changes",
      };
      res.status(500).json(response);
    }
  },
);

/**
 * DELETE /api/monitoring/disable/:user_did
 * Compatibility no-op; only forgets the cached follow list.
 */
router.delete(
  "/disable/:user_did",
  requireAuth,
  validate(userDidParamSchema, "params"),
  requireSelf,
  (req, res) => {
    invalidateFollows(req.params.user_did);
    const response: APIResponse<{ message: string }> = {
      success: true,
      data: { message: "Monitoring disabled" },
    };
    res.json(response);
  },
);

/**
 * DELETE /api/monitoring/purge/:user_did
 * Delete the requesting user's own profile changes and snapshot.
 */
router.delete(
  "/purge/:user_did",
  requireAuth,
  validate(userDidParamSchema, "params"),
  requireSelf,
  async (req, res) => {
    try {
      const { user_did } = req.params;
      const deletedChanges = await purgeAccount(user_did);
      invalidateFollows(user_did);

      const response: APIResponse<{
        message: string;
        deletedChanges: number;
      }> = {
        success: true,
        data: { message: "User data purged", deletedChanges },
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
  },
);

export default router;
