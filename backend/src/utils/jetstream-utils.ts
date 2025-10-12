/**
 * Jetstream utility helpers shared across the backend.
 */

import { JETSTREAM_HOSTS } from "../config.js";

// 24h lookback window in milliseconds.
export const LOOKBACK_MS_24H = 24 * 60 * 60 * 1000;

/**
 * Return the Jetstream cursor for "24 hours ago".
 * Cursor unit is microseconds.
 * @returns Cursor timestamp in microseconds.
 */
export const getCursor24hAgo = (): number =>
  (Date.now() - LOOKBACK_MS_24H) * 1000;

/**
 * Pick a Jetstream host at random to distribute load.
 * @returns One hostname from JETSTREAM_HOSTS.
 */
const selectHost = (): string =>
  JETSTREAM_HOSTS[Math.floor(Math.random() * JETSTREAM_HOSTS.length)];

/**
 * Build the WebSocket URL using requireHello mode for large DID lists.
 *
 * @param cursor Optional cursor to resume from (microseconds).
 * @returns Hostname + outbound URL tuple.
 */
export const buildJetstreamRequest = (cursor?: number) => {
  // Randomly pick one configured Jetstream host to spread load.
  const host = selectHost();

  // Build query parameters for the websocket subscribe endpoint.
  const params = new URLSearchParams();

  // Require the server to wait for our initial "options_update" (wantedDids)
  // before streaming events. This is needed for large DID lists.
  params.set("requireHello", "true");

  // Attach resume cursor (microseconds) when provided to continue from a point in time.
  if (cursor) params.set("cursor", cursor.toString());

  // Compose the final wss URL. Return both the chosen host (for logging/metrics)
  // and the computed URL used to establish the websocket connection.
  return {
    host,
    url: `wss://${host}/subscribe?${params.toString()}`,
  } as const; // Keep literal types for host/url
};

/**
 * Convert a Jetstream cursor (microseconds) to a localized timestamp.
 * @param cursorMicroseconds Cursor in microseconds.
 * @returns Localized timestamp string (de-DE, Europe/Berlin).
 */
export const cursorToHumanReadable = (cursorMicroseconds: number): string => {
  const date = new Date(cursorMicroseconds / 1000);
  return date.toLocaleString("de-DE", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
};
