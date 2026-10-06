/**
 * Routes scoped to the signed-in account: its follows, the changes among
 * them, and deletion of its own data.
 */

import express from "express";
import type { APIResponse } from "../../../shared/types.js";
import { tierOf, tierThresholds, type Tier } from "../bubble/compute.js";
import { bubbleService } from "../bubble/index.js";
import { BUBBLE_MAX_AGE_MS, type BubbleStatus } from "../bubble/service.js";
import { getCachedFollowLists, getChangesInScope } from "../bubble/store.js";
import {
  getIgnoreReason,
  getKnownHandles,
  purgeAccount,
  releaseSelfIgnored,
} from "../db.js";
import { seedAccounts } from "../ingest/seed.js";
import { labeler, optInSync } from "../labeler/index.js";
import { getOptIn } from "../labeler/store.js";
import { resolveHandle } from "../utils/handle-resolver.js";
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
 * Accounts the user follows, with their current handles. The follow list
 * stored with the bubble (refreshed daily) saves the AppView requests; only
 * before the first bubble is it loaded live.
 */
async function followsOf(
  did: string,
): Promise<{ did: string; handle: string | null }[]> {
  const stored = (await getCachedFollowLists([did], BUBBLE_MAX_AGE_MS)).get(
    did,
  );
  if (!stored) return getFollows(did);
  const handles = await getKnownHandles(stored);
  return stored
    .filter((follow) => follow !== did)
    .map((follow) => ({ did: follow, handle: handles.get(follow) ?? null }));
}

/**
 * Accounts that deleted their data (or were excluded) get no bubble and no
 * changes until they rejoin.
 */
const requireTracked: express.RequestHandler = async (req, res, next) => {
  try {
    if ((await getIgnoreReason(req.did!)) === null) return next();
    const response: APIResponse<never> = {
      success: false,
      error: "Your account is not tracked",
    };
    res.status(403).json(response);
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/me/bubble?refresh=false
 * State of the user's bubble; starts computing it when missing or stale.
 */
router.get(
  "/bubble",
  requireTracked,
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
 * GET /api/me/changes?scope=follows|inner|bubble|edge
 * Newest changes among the user's follows, optionally extended into the
 * bubble up to the given tier. While the bubble is still being computed,
 * only the follows (or the previous bubble) are included.
 */
router.get(
  "/changes",
  requireTracked,
  validate(scopedChangesQuerySchema, "query"),
  async (req, res) => {
    try {
      const { scope } = req.query as unknown as { scope: Tier };
      const did = req.did!;
      const follows = await followsOf(did);

      // Bubble members need a computed bubble (current or previous one)
      let bubble: BubbleStatus | null = null;
      let followsCount = follows.length;
      let minCommon: number | null = null;
      if (scope !== "follows") {
        bubble = await bubbleService.ensure(did);
        const info = bubble.state === "ready" ? bubble : bubble.previous;
        if (info) {
          followsCount = info.followsCount;
          minCommon = tierThresholds(followsCount)[scope];
        }
      }

      const rows = await getChangesInScope(
        did,
        follows.map((f) => f.did),
        minCommon,
        { limit: CHANGES_LIMIT },
      );
      // Current handles of follows beat the one stored with the change
      const handleOf = new Map(
        follows.flatMap((f) => (f.handle ? [[f.did, f.handle] as const] : [])),
      );
      const changes = rows.map(({ common_count, ...change }) => ({
        ...change,
        handle: handleOf.get(change.did) ?? change.handle,
        tier: (common_count === null
          ? "follows"
          : tierOf(common_count, followsCount)) as Tier,
        common_follows: common_count,
      }));

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
 * Opt-in state of the signed-in user for the labeler.
 */
interface LabelerStatus {
  enabled: boolean;
  did?: string;
  handle?: string | null;
  // How the user opted in, or null when not opted in
  optedInVia?: string | null;
}

async function labelerStatus(did: string): Promise<LabelerStatus> {
  if (!labeler) return { enabled: false };
  return {
    enabled: true,
    did: labeler.did,
    handle: await resolveHandle(labeler.did),
    optedInVia: await getOptIn(did),
  };
}

/**
 * GET /api/me/labeler
 * Whether the signed-in user opted in to the labeler (like or follow).
 */
router.get("/labeler", async (req, res) => {
  try {
    const response: APIResponse<LabelerStatus> = {
      success: true,
      data: await labelerStatus(req.did!),
    };
    res.json(response);
  } catch (error) {
    console.error("Error loading labeler status:", error);
    const response: APIResponse<never> = {
      success: false,
      error: "Failed to load labeler status",
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
    const did = req.did!;
    const deletedChanges = await purgeAccount(did);
    invalidateFollows(did);
    // Labels are public; withdraw them like an opt-out
    await labeler?.onOptOut(did);

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

/**
 * POST /api/me/resume
 * Track an account again after it deleted its own data.
 */
router.post("/resume", async (req, res) => {
  try {
    const did = req.did!;
    if (!(await releaseSelfIgnored(did))) {
      const response: APIResponse<never> = {
        success: false,
        error: "Nothing to resume",
      };
      res.status(409).json(response);
      return;
    }
    // Same as a first login: know the profile, map the bubble
    await seedAccounts([did]);
    bubbleService.ensure(did).catch((error) => {
      console.error(`❌ Could not start bubble for ${did}:`, error);
    });
    const response: APIResponse<{ resumed: true }> = {
      success: true,
      data: { resumed: true },
    };
    res.json(response);
  } catch (error) {
    console.error("Error resuming account:", error);
    const response: APIResponse<never> = {
      success: false,
      error: "Failed to resume",
    };
    res.status(500).json(response);
  }
});

export default router;
