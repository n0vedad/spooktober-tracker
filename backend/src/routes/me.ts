/**
 * Routes scoped to the signed-in account: its follows, the changes among
 * them, and deletion of its own data.
 */

import express from "express";
import type { APIResponse } from "../../../shared/types.js";
import { getChangesByDIDs, purgeAccount } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { getFollows, invalidateFollows } from "../utils/follows.js";

const router = express.Router();

// Newest changes returned for a user's follows
const FOLLOWS_CHANGES_LIMIT = 500;

router.use(requireAuth);

/**
 * GET /api/me/follows
 * Accounts the signed-in user follows (DID + handle).
 */
router.get("/follows", async (req, res) => {
  try {
    const follows = await getFollows(req.did!);
    const response: APIResponse<{
      follows: Array<{ did: string; handle: string }>;
    }> = {
      success: true,
      data: { follows: follows.map(({ did, handle }) => ({ did, handle })) },
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
});

/**
 * GET /api/me/changes
 * Newest changes among the accounts the signed-in user follows.
 */
router.get("/changes", async (req, res) => {
  try {
    const follows = await getFollows(req.did!);
    const changes = await getChangesByDIDs(
      follows.map((f) => f.did),
      { limit: FOLLOWS_CHANGES_LIMIT },
    );

    const response: APIResponse<{ changes: typeof changes; total: number }> = {
      success: true,
      data: { changes, total: changes.length },
    };
    res.json(response);
  } catch (error) {
    console.error("Error fetching changes for follows:", error);
    const response: APIResponse<never> = {
      success: false,
      error: "Failed to fetch changes",
    };
    res.status(500).json(response);
  }
});

/**
 * DELETE /api/me/data
 * Delete the signed-in user's own profile changes and stored profile state.
 */
router.delete("/data", async (req, res) => {
  try {
    const deletedChanges = await purgeAccount(req.did!);
    invalidateFollows(req.did!);

    const response: APIResponse<{ message: string; deletedChanges: number }> = {
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
});

export default router;
