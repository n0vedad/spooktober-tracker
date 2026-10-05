/**
 * Routes scoped to the signed-in account: its follows, the changes among
 * them, and deletion of its own data.
 */

import express from "express";
import type { APIResponse } from "../../../shared/types.js";
import { tierOf, tierThresholds, type Tier } from "../bubble/compute.js";
import { bubbleService } from "../bubble/index.js";
import type { BubbleStatus } from "../bubble/service.js";
import { getChangesInScope } from "../bubble/store.js";
import { purgeAccount } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { getFollows, invalidateFollows } from "../utils/follows.js";
import { validate } from "../validation/middleware.js";
import {
  bubbleQuerySchema,
  scopedChangesQuerySchema,
} from "../validation/schemas.js";

const router = express.Router();

// Changes returned per request for the per-user view
const CHANGES_LIMIT = 500;

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
 * GET /api/me/bubble?refresh=false
 * State of the user's bubble; starts computing it when missing or stale.
 */
router.get(
  "/bubble",
  validate(bubbleQuerySchema, "query"),
  async (req, res) => {
    try {
      const { refresh } = req.query as unknown as { refresh: boolean };
      const status = await bubbleService.ensure(req.did!, refresh);
      const response: APIResponse<BubbleStatus> = {
        success: true,
        data: status,
      };
      res.json(response);
    } catch (error) {
      console.error("Error loading bubble:", error);
      const response: APIResponse<never> = {
        success: false,
        error: "Failed to load your bubble",
      };
      res.status(500).json(response);
    }
  },
);

/**
 * GET /api/me/changes?scope=follows|inner|bubble|edge&sort=recent|closeness
 * Newest changes among the user's follows, optionally extended into the
 * bubble up to the given tier. While the bubble is still being computed,
 * only the follows (or the previous bubble) are included.
 */
router.get(
  "/changes",
  validate(scopedChangesQuerySchema, "query"),
  async (req, res) => {
    try {
      const { scope, sort } = req.query as unknown as {
        scope: Tier;
        sort: "recent" | "closeness";
      };
      const did = req.did!;
      const follows = await getFollows(did);

      // Bubble members need a computed bubble (current or previous one)
      let bubble: BubbleStatus | null = null;
      let followsCount = follows.length;
      let minCommon: number | null = null;
      if (scope !== "follows") {
        bubble = await bubbleService.ensure(did);
        const info =
          bubble.state === "ready"
            ? bubble
            : bubble.state === "computing"
              ? bubble.previous
              : null;
        if (info) {
          followsCount = info.followsCount;
          minCommon = tierThresholds(followsCount)[scope];
        }
      }

      const rows = await getChangesInScope(
        did,
        follows.map((f) => f.did),
        minCommon,
        { limit: CHANGES_LIMIT, sort },
      );
      const changes = rows.map(
        ({ common_count, score: _score, ...change }) => ({
          ...change,
          tier: (common_count === null
            ? "follows"
            : tierOf(common_count, followsCount)) as Tier,
          common_follows: common_count,
        }),
      );

      const response: APIResponse<{
        changes: typeof changes;
        total: number;
        bubble: BubbleStatus | null;
      }> = {
        success: true,
        data: { changes, total: changes.length, bubble },
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
  },
);

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
