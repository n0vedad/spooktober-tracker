/**
 * Production wiring of the ingester: Jetstream v2 live tail, Postgres-backed
 * tracker and cursor storage.
 */

import { Jetstream, websocketTransport } from "@bsky/jetstream";
import { JETSTREAM_URL } from "../config.js";
import {
  getSnapshot,
  isIgnored,
  loadSetting,
  recordChange,
  saveSetting,
  saveSnapshot,
} from "../db.js";
import {
  fetchCurrentHandle,
  findPreviousHandle,
} from "../utils/handle-resolver.js";
import { Ingester, PROFILE_COLLECTION, type EventSource } from "./ingester.js";
import { createProfileTracker } from "./profile-tracker.js";

// system_settings key holding the last processed Jetstream v2 seq
const CURSOR_KEY = "jetstream_v2_cursor";

/**
 * Event source reading profile commits and identity events from Jetstream v2.
 *
 * @param url Jetstream instance base URL.
 * @returns EventSource for the Ingester.
 */
export function createJetstreamSource(url: string): EventSource {
  const jetstream = new Jetstream(url);
  return ({ cursor, signal }) =>
    jetstream.live({
      collections: [PROFILE_COLLECTION],
      kinds: ["commit", "identity"],
      // live() only loads the start position; the Ingester persists progress
      cursor: { load: async () => cursor, save: async () => {} },
      signal,
      raw: true,
      onInfo: (info) =>
        console.log(`ℹ️  Jetstream: ${info.name} ${info.message ?? ""}`),
      liveTransport: websocketTransport({
        onReconnect: (_err, { attempt }) =>
          console.warn(`🔄 Jetstream reconnecting (attempt ${attempt})`),
      }),
    });
}

// Singleton ingester shared across the backend
export const ingester = new Ingester({
  source: createJetstreamSource(JETSTREAM_URL),
  tracker: createProfileTracker({
    getSnapshot,
    saveSnapshot,
    recordChange,
    isIgnored,
    lookupPreviousHandle: findPreviousHandle,
  }),
  resolveHandle: (did) => fetchCurrentHandle(did),
  loadCursor: async () => {
    const value = await loadSetting(CURSOR_KEY);
    return typeof value === "number" ? value : undefined;
  },
  saveCursor: (seq) => saveSetting(CURSOR_KEY, seq),
});
