/**
 * API Client for backend endpoints
 * Uses relative URLs (same origin); the session cookie authenticates requests.
 */

import type {
  APIResponse,
  GetChangesResponse,
  ProfileChange,
} from "../../shared/types";
import { ENV } from "./utils/env";
import type { Tier } from "./utils/tiers";

// API Path
const API_BASE = ENV.API_BASE_URL;

/**
 * Error for requests rejected because the session is missing or expired.
 */
export class UnauthorizedError extends Error {}

/**
 * Perform an API request and unwrap the response envelope.
 *
 * @param path Path below the API base (e.g. "/me").
 * @param init Optional fetch options.
 * @param fallbackError Message used when the backend sends none.
 * @returns The response's `data` payload.
 */
async function request<T>(
  path: string,
  init: RequestInit = {},
  fallbackError = "Request failed",
): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: "same-origin",
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });

  if (response.status === 401) {
    throw new UnauthorizedError("Please log in again");
  }

  // Parse structured API response
  const data: APIResponse<T> = await response.json();
  if (!data.success || data.data === undefined) {
    throw new Error(data.error || fallbackError);
  }
  return data.data;
}

/**
 * Signed-in account.
 */
export interface Me {
  did: string;
  handle: string | null;
  isAdmin: boolean;
}

/**
 * Get the signed-in account, or null when not logged in.
 *
 * @returns Account info or null.
 */
export async function getMe(): Promise<Me | null> {
  try {
    return await request<Me>("/me", {}, "Failed to load session");
  } catch (error) {
    if (error instanceof UnauthorizedError) return null;
    throw error;
  }
}

/**
 * Start the OAuth login for a handle (full-page redirect via the backend).
 *
 * @param handle Bluesky handle or DID.
 */
export function startLogin(handle: string): void {
  location.assign(`${ENV.LOGIN_URL}?handle=${encodeURIComponent(handle)}`);
}

/**
 * End the current session.
 */
export async function logout(): Promise<void> {
  await request<{ message: string }>(
    "/auth/logout",
    { method: "POST" },
    "Failed to log out",
  );
}

/**
 * Accounts the signed-in user follows.
 *
 * @returns Follow records (DID + handle).
 */
export async function getMyFollows(): Promise<
  Array<{ did: string; handle: string }>
> {
  const data = await request<{
    follows: Array<{ did: string; handle: string }>;
  }>("/me/follows", {}, "Failed to load follows");
  return data.follows;
}

/**
 * State of the signed-in user's bubble (second-degree network).
 */
export type BubbleStatus =
  | { state: "ready"; followsCount: number; computedAt: string }
  | {
      state: "computing";
      done: number;
      total: number;
      previous: { followsCount: number; computedAt: string } | null;
    }
  | { state: "failed"; error: string };

/**
 * Get (and start computing, if missing or stale) the user's bubble.
 *
 * @param refresh Recompute even if the bubble is fresh.
 * @returns Bubble state.
 */
export async function getBubbleStatus(refresh = false): Promise<BubbleStatus> {
  return request<BubbleStatus>(
    `/me/bubble?refresh=${refresh}`,
    {},
    "Failed to load your bubble",
  );
}

/**
 * Changes among the user's follows, optionally extended into the bubble.
 *
 * @param scope Farthest tier to include.
 * @param sort Newest first, or closest accounts first.
 * @returns Changes plus the bubble state (null for scope "follows").
 */
export async function getMyChanges(
  scope: Tier = "follows",
  sort: "recent" | "closeness" = "recent",
): Promise<{ changes: ProfileChange[]; bubble: BubbleStatus | null }> {
  return request(
    `/me/changes?scope=${scope}&sort=${sort}`,
    {},
    "Failed to fetch changes",
  );
}

/**
 * Opt-in state of the signed-in user for the labeler.
 */
export interface LabelerStatus {
  enabled: boolean;
  did?: string;
  handle?: string | null;
  // "like", "follow" or "like+follow"; null when not opted in
  optedInVia?: string | null;
}

/**
 * Whether the signed-in user liked or follows the labeler.
 */
export async function getLabelerStatus(): Promise<LabelerStatus> {
  return request<LabelerStatus>("/me/labeler", {}, "Failed to load labeler");
}

/**
 * Check likes/follows of the labeler now (instead of at the next poll).
 */
export async function refreshLabelerStatus(): Promise<LabelerStatus> {
  return request<LabelerStatus>(
    "/me/labeler/refresh",
    { method: "POST" },
    "Could not check right now, please try again in a minute",
  );
}

/**
 * Get change history for a specific DID.
 *
 * @param did DID whose history will be retrieved.
 * @returns Array of profile-change entries.
 */
export async function getChangeHistory(did: string): Promise<ProfileChange[]> {
  const data = await request<GetChangesResponse>(
    `/changes/${encodeURIComponent(did)}/history`,
    {},
    "Failed to fetch history",
  );
  return data.changes;
}

/**
 * Delete the signed-in user's own profile changes.
 *
 * @returns Number of deleted change rows.
 */
export async function purgeMyData(): Promise<{ deletedChanges: number }> {
  return request<{ message: string; deletedChanges: number }>(
    "/me/data",
    { method: "DELETE" },
    "Failed to purge user data",
  );
}

/**
 * Admin statistics.
 */
export interface AdminStats {
  totalMonitoredDIDs: number;
  jetstreamStatus: string;
  cursorTimestamp: string | null;
  isInBackfill: boolean;
  uptimeSeconds: number | null;
}

/**
 * Get admin statistics (admin only).
 *
 * @returns Aggregate ingestion stats payload.
 */
export async function getAdminStats(): Promise<AdminStats> {
  return request<AdminStats>("/admin/stats", {}, "Failed to fetch admin stats");
}

/**
 * Stop Jetstream ingestion (admin only).
 *
 * @returns Success message from backend.
 */
export async function stopJetstream(): Promise<string> {
  const data = await request<{ message: string }>(
    "/admin/jetstream/stop",
    { method: "POST" },
    "Failed to stop Jetstream",
  );
  return data.message;
}

/**
 * Get recommended cursor for starting Jetstream (admin only).
 *
 * @returns Recommended cursor timestamp in microseconds.
 */
export async function getRecommendedStartCursor(): Promise<number> {
  const data = await request<{ cursor: number }>(
    "/admin/jetstream/recommended-cursor",
    {},
    "Failed to get recommended cursor",
  );
  return data.cursor;
}

/**
 * Start Jetstream ingestion with optional cursor (admin only).
 *
 * @param cursor Optional cursor timestamp in microseconds.
 * @returns Success message from backend.
 */
export async function startJetstream(cursor?: number): Promise<string> {
  const data = await request<{ message: string }>(
    "/admin/jetstream/start",
    { method: "POST", body: JSON.stringify({ cursor }) },
    "Failed to start Jetstream",
  );
  return data.message;
}

/**
 * Get ignored users (admin only).
 *
 * @returns Array of ignored DID records.
 */
export async function getIgnoredUsers(): Promise<
  { did: string; added_at: string; handle: string | null }[]
> {
  return request("/admin/ignored-users", {}, "Failed to fetch ignored users");
}

/**
 * Add ignored user (admin only).
 *
 * @param did DID to ignore.
 * @returns Backend response summarizing deletions.
 */
export async function addIgnoredUser(
  did: string,
): Promise<{ did: string; deletedChanges: number; message: string }> {
  return request(
    "/admin/ignored-users",
    { method: "POST", body: JSON.stringify({ did }) },
    "Failed to add ignored user",
  );
}

/**
 * Remove ignored user (admin only).
 *
 * @param did DID to remove.
 * @returns Confirmation message.
 */
export async function removeIgnoredUser(did: string): Promise<string> {
  const data = await request<{ message: string }>(
    `/admin/ignored-users/${encodeURIComponent(did)}`,
    { method: "DELETE" },
    "Failed to remove ignored user",
  );
  return data.message;
}
