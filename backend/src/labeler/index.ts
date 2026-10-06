/**
 * Production wiring of the labeler (disabled unless configured).
 */

import { Jetstream } from "@bsky/jetstream";
import { bubbleService } from "../bubble/index.js";
import {
  JETSTREAM_URL,
  LABELER_DID,
  LABELER_SIGNING_KEY,
  SPACEDUST_URL,
} from "../config.js";
import { getChangesSince, isIgnored } from "../db.js";
import { seedAccounts } from "../ingest/seed.js";
import { importSigningKey } from "./labels.js";
import {
  createOptInWatch,
  FOLLOW_COLLECTION,
  LIKE_COLLECTION,
} from "./optin-watch.js";
import { createOptInStream } from "./optin-stream.js";
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
// Delay between a new or deleted like/follow and the sync that checks it
// (the AppView needs a moment to reflect it; further events join that sync)
const NEW_OPT_IN_SYNC_DELAY_MS = 5_000;
const WITHDRAWAL_SYNC_DELAY_MS = 15_000;

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
      isIgnored,
      // Know their profile (so the first change counts) and map the bubble
      // right away, so it is ready if they log in
      onNewOptIn: (did) => {
        void seedAccounts([did]);
        bubbleService.ensure(did).catch((error) => {
          console.error(`❌ Could not start bubble for ${did}:`, error);
        });
      },
      onSynced: () => {
        void optInWatch?.update().catch((error) => {
          console.warn("⚠️  Could not update the opt-in watch:", error);
        });
      },
    })
  : null;

let syncTimer: NodeJS.Timeout | null = null;

/**
 * Run an opt-in sync after `delayMs`, unless one is already scheduled.
 */
function scheduleSync(delayMs: number) {
  if (syncTimer || !optInSync) return;
  const sync = optInSync;
  syncTimer = setTimeout(() => {
    syncTimer = null;
    sync.sync().catch((error) => {
      console.error("❌ Opt-in sync failed:", error);
    });
  }, delayMs);
  syncTimer.unref();
}

// Likes and follows of opted-in accounts, to notice withdrawals right away
export const optInWatch = optInSync
  ? createOptInWatch({
      open: (dids, signal) =>
        new Jetstream(JETSTREAM_URL).live({
          collections: [LIKE_COLLECTION, FOLLOW_COLLECTION],
          kinds: ["commit"],
          dids: dids as `did:${string}:${string}`[],
          signal,
          raw: true,
        }),
      getOptIns,
      onWithdrawal: () => scheduleSync(WITHDRAWAL_SYNC_DELAY_MS),
    })
  : null;

// New likes and follows of the labeler, to notice opt-ins right away
export const optInStream =
  labeler && optInSync
    ? createOptInStream({
        url: SPACEDUST_URL,
        labelerDid: labeler.did,
        onLink: () => scheduleSync(NEW_OPT_IN_SYNC_DELAY_MS),
      })
    : null;
