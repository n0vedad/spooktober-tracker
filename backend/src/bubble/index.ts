/**
 * Production wiring of the bubble service.
 */

import { seedFromViews } from "../ingest/seed.js";
import { fetchFollowList } from "./follow-lists.js";
import { createBubbleService } from "./service.js";
import {
  getBubbleInfo,
  getCachedFollowLists,
  saveBubble,
  saveFollowList,
} from "./store.js";

// Singleton shared across the backend
export const bubbleService = createBubbleService({
  // The listed profiles double as baseline snapshots, at no extra cost
  fetchFollowList: (did) => fetchFollowList(did, { onPage: seedFromViews }),
  getCachedFollowLists,
  saveFollowList,
  getBubbleInfo,
  saveBubble,
});
