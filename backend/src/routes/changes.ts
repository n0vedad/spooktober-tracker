/**
 * API routes for profile changes
 */

import express from "express";
import type { APIResponse, GetChangesResponse } from "../../../shared/types.js";
import { getChangeHistory, getChanges } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { validate } from "../validation/middleware.js";
import {
  changesPageQuerySchema,
  didParamSchema,
} from "../validation/schemas.js";

const router = express.Router();

/**
 * GET /api/changes?limit=50&before=<id>
 * Newest profile changes across the network (requires login)
 */
router.get(
  "/",
  requireAuth,
  validate(changesPageQuerySchema, "query"),
  async (req, res) => {
    try {
      const { limit, before } = req.query as unknown as {
        limit: number;
        before?: number;
      };
      const changes = await getChanges({ limit, beforeId: before });

      // Respond with one page of changes, newest first.
      const response: APIResponse<GetChangesResponse> = {
        success: true,
        data: {
          changes,
        },
      };

      res.json(response);
    } catch (error) {
      console.error("Error fetching changes:", error);
      const response: APIResponse<never> = {
        success: false,
        error: "Failed to fetch changes",
      };
      res.status(500).json(response);
    }
  },
);

/**
 * GET /api/changes/:did/history
 * Get change history for a specific DID (requires login)
 */
router.get(
  "/:did/history",
  requireAuth,
  validate(didParamSchema, "params"),
  async (req, res) => {
    try {
      const { did } = req.params;
      const changes = await getChangeHistory(did);

      // Return the assembled change history data for the client.
      const response: APIResponse<GetChangesResponse> = {
        success: true,
        data: {
          changes,
        },
      };

      res.json(response);

      // Propagate a generic server error when history retrieval fails unexpectedly.
    } catch (error) {
      console.error("Error fetching history:", error);
      const response: APIResponse<never> = {
        success: false,
        error: "Failed to fetch history",
      };
      res.status(500).json(response);
    }
  },
);

export default router;
