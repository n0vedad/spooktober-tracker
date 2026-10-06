/**
 * Human-meaningful state of the ingestion, for the admin panel.
 */

import type { IngesterStatus } from "./ingester.js";

// Last event older than this means the stream is catching up, not live
export const LIVE_THRESHOLD_MS = 60_000;

export type IngestionState =
  | "stopped"
  // Running, but the stream keeps failing (e.g. database or network down)
  | "stalled"
  // Running, no event processed yet
  | "starting"
  | "catching_up"
  | "live";

export interface IngestionHealth extends IngesterStatus {
  state: IngestionState;
  // How far the last processed event is behind now (null before the first)
  lagMs: number | null;
  uptimeSeconds: number | null;
}

/**
 * Classify the ingester status.
 *
 * @param status Raw ingester status.
 * @param now Current time.
 * @returns Status with state, lag and uptime.
 */
export function describeIngestion(
  status: IngesterStatus,
  now: Date = new Date(),
): IngestionHealth {
  const lagMs = status.lastEventTime
    ? Math.max(0, now.getTime() - Date.parse(status.lastEventTime))
    : null;
  const uptimeSeconds = status.startedAt
    ? Math.floor((now.getTime() - Date.parse(status.startedAt)) / 1000)
    : null;

  let state: IngestionState;
  if (!status.running) state = "stopped";
  else if (status.consecutiveFailures > 0) state = "stalled";
  else if (lagMs === null) state = "starting";
  else if (lagMs > LIVE_THRESHOLD_MS) state = "catching_up";
  else state = "live";

  return { ...status, state, lagMs, uptimeSeconds };
}
