/**
 * Production wiring of the labeler (disabled unless configured).
 */

import { bubbleService } from "../bubble/index.js";
import { LABELER_DID, LABELER_SIGNING_KEY } from "../config.js";
import { getChangesSince } from "../db.js";
import { importSigningKey } from "./labels.js";
import { createOptInSync, fetchFollowers, fetchLikers } from "./optins.js";
import { createLabeler } from "./service.js";
import {
  getOptIns,
  insertLabel,
  isOptedIn,
  queryActiveLabels,
  removeOptIn,
  saveOptIn,
} from "./store.js";

// How often likes/follows of the labeler are checked
export const OPT_IN_SYNC_INTERVAL_MS = 2 * 60 * 1000;

export const labeler =
  LABELER_DID && LABELER_SIGNING_KEY
    ? createLabeler({
        did: LABELER_DID,
        key: await importSigningKey(LABELER_SIGNING_KEY),
        insertLabel,
        queryActiveLabels,
        isOptedIn,
        getChangesSince,
      })
    : null;

export const optInSync = labeler
  ? createOptInSync({
      labeler,
      fetchFollowers: (did) => fetchFollowers(did),
      fetchLikers: (did) => fetchLikers(did),
      getOptIns,
      saveOptIn,
      removeOptIn,
      // Map the bubble right away, so it is ready if they log in
      onNewOptIn: (did) => {
        bubbleService.ensure(did).catch((error) => {
          console.error(`❌ Could not start bubble for ${did}:`, error);
        });
      },
    })
  : null;
