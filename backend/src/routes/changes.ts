/**
 * API routes for profile changes
 */

import express from "express";
import type {
  APIResponse,
  GetChangesResponse,
  SubmitChangeRequest,
} from "../../../shared/types.js";
import {
  getAllChanges,
  getChangeHistory,
  getChangesByDIDs,
  insertChange,
} from "../db.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

/**
 * GET /api/changes
 * Get all profile changes (requires login)
 */
router.get("/", requireAuth, async (req, res) => {
  try {
    const changes = await getAllChanges();

    // Respond with complete change list.
    const response: APIResponse<GetChangesResponse> = {
      success: true,
      data: {
        changes,
      },
    };

    // Auth check
    res.json(response);
  } catch (error) {
    console.error("Error fetching changes:", error);
    const response: APIResponse<never> = {
      success: false,
      error: "Failed to fetch changes",
    };
    res.status(500).json(response);
  }
});

/**
 * POST /api/changes/query
 * Query profile changes by DIDs (use POST to avoid URL length limits)
 * Body: { dids: string[] }
 */
router.post("/query", async (req, res) => {
  try {
    const { dids } = req.body as { dids?: string[] };

    // Fetch only the requested DIDs when a filter is provided.
    let changes;
    if (dids && dids.length > 0) {
      changes = await getChangesByDIDs(dids);

      // Otherwise return the complete change history.
    } else {
      changes = await getAllChanges();
    }

    // Send back the assembled change payload.
    const response: APIResponse<GetChangesResponse> = {
      success: true,
      data: {
        changes,
      },
    };

    res.json(response);

    // Surface a generic failure response to callers on unexpected errors.
  } catch (error) {
    console.error("Error querying changes:", error);
    const response: APIResponse<never> = {
      success: false,
      error: "Failed to query changes",
    };
    res.status(500).json(response);
  }
});

/**
 * POST /api/changes
 * Submit a new profile change
 * Body: SubmitChangeRequest
 */
router.post("/", async (req, res) => {
  try {
    const change: SubmitChangeRequest = req.body;

    // Reject malformed payloads missing the DID identifier.
    if (!change.did) {
      const response: APIResponse<never> = {
        success: false,
        error: "DID is required",
      };
      return res.status(400).json(response);
    }

    // Validate that at least one change field is provided
    const hasHandleChange = change.old_handle || change.new_handle;
    const hasDisplayNameChange =
      change.old_display_name || change.new_display_name;
    const hasAvatarChange = change.old_avatar || change.new_avatar;

    if (!hasHandleChange && !hasDisplayNameChange && !hasAvatarChange) {
      const response: APIResponse<never> = {
        success: false,
        error:
          "At least one change field must be provided (handle, display_name, or avatar)",
      };
      return res.status(400).json(response);
    }

    // Insert the new change record into persistence layer.
    const result = await insertChange(change);

    // If result is null, the DID was ignored
    if (!result) {
      const response: APIResponse<never> = {
        success: false,
        error: "DID is on the ignored list",
      };
      return res.status(403).json(response);
    }

    // Echo back the stored change (including generated metadata).
    const response: APIResponse<typeof result> = {
      success: true,
      data: result,
    };

    res.json(response);

    // Unhandled issues result in a generic server error for the client.
  } catch (error) {
    console.error("Error submitting change:", error);
    const response: APIResponse<never> = {
      success: false,
      error: "Failed to submit change",
    };
    res.status(500).json(response);
  }
});

/**
 * GET /api/changes/:did/history
 * Get change history for a specific DID (requires login)
 */
router.get("/:did/history", requireAuth, async (req, res) => {
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
});

export default router;
