/**
 * Production wiring of the bubble service.
 */

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
  fetchFollowList: (did) => fetchFollowList(did),
  getCachedFollowLists,
  saveFollowList,
  getBubbleInfo,
  saveBubble,
});
