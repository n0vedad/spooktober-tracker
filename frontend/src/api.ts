/**
 * API Client for backend endpoints
 * Uses relative URLs (same-origin, no CORS needed)
 */

import type {
  APIResponse,
  GetChangesResponse,
  ProfileChange,
} from "../../shared/types";
import { ENV } from "./utils/env";

// API Path
const API_BASE = ENV.API_BASE_URL;

/**
 * Compose request headers including optional DID authentication header.
 *
 * @param userDID - DID used for auth-protected endpoints.
 * @param extraHeaders - Additional header key/value pairs to merge.
 * @returns Prepared headers object.
 */
const buildHeaders = (
  userDID?: string,
  extraHeaders: Record<string, string> = {},
): Record<string, string> => {
  const headers = { ...extraHeaders };
  if (userDID) {
    headers["X-User-DID"] = userDID;
  }
  return headers;
};

/**
 * Get change history for a specific DID.
 *
 * @param did DID whose history will be retrieved.
 * @param userDID Authenticated user DID for authorization header.
 * @returns Array of profile-change entries.
 */
export async function getChangeHistory(
  did: string,
  userDID: string,
): Promise<ProfileChange[]> {
  const response = await fetch(
    `${API_BASE}/changes/${encodeURIComponent(did)}/history`,
    {
      headers: buildHeaders(userDID),
    },
  );

  // Interpret JSON payload containing detailed change history.
  const data: APIResponse<GetChangesResponse> = await response.json();

  // Ensure a successful payload with data before accessing changes
  if (!data.success || !data.data) {
    throw new Error(data.error || "Failed to fetch history");
  }
  return data.data.changes;
}
/**
 * Resolve handle from DID via PLC directory or did:web.
 *
 * @param did DID to resolve.
 * @returns Resolved handle or null when unavailable.
 */
export async function resolveHandle(did: string): Promise<string | null> {
  try {
    const url = did.startsWith("did:web")
      ? `https://${did.split(":")[2]}/.well-known/did.json`
      : `https://plc.directory/${did}`;

    // Resolve handle
    const response = await fetch(url);
    if (!response.ok) return null;
    const doc = await response.json();

    // Find handle in alsoKnownAs array
    for (const alias of doc.alsoKnownAs || []) {
      if (alias.includes("at://")) {
        return alias.split("//")[1];
      }
    }
    return null;

    // Error handling
  } catch (error) {
    console.error("Failed to resolve handle:", error);
    return null;
  }
}

/**
 * Enable monitoring for a user's follows.
 *
 * @param userDID Authenticated user DID.
 * @param follows List of follows to register with the backend.
 * @returns Counts and potential queue placement metadata.
 */
type EnableMonitoringPayload = {
  count?: number;
  temporaryStream?: { queued: boolean; position?: number } | null;
  queued?: boolean;
  position?: number;
  backfillTriggered?: boolean;
  backfillSkipReason?: string;
};

/**
 * Enable monitoring for a user's follows (server-side Jetstream).
 *
 * Sends the user's DID and follow list to the backend. The backend may start
 * monitoring immediately or queue the request if capacity is full.
 *
 * @param userDID DID used for auth and ownership of the monitoring session.
 * @param follows Array of follow records (DID + handle) to register.
 * @returns Payload containing counts and optional queue metadata.
 */
export async function enableMonitoring(
  userDID: string,
  follows: Array<{ did: string; handle: string }>,
): Promise<EnableMonitoringPayload> {
  // Submit follow list and DID to the monitoring enable endpoint.
  const response = await fetch(`${API_BASE}/monitoring/enable`, {
    method: "POST",
    headers: buildHeaders(userDID, {
      "Content-Type": "application/json",
    }),
    body: JSON.stringify({ user_did: userDID, follows }),
  });

  // Parse structured API response to inspect queue metadata.
  const data: APIResponse<EnableMonitoringPayload> = await response.json();

  // Ensure backend acknowledged success before consuming the response
  if (!data.success) {
    throw new Error(data.error || "Failed to enable monitoring");
  }

  // Some responses may include only queue flags; normalize to empty object when undefined
  return data.data ?? {};
}

/**
 * Get monitoring status (for admin panel/UI limits/queue display).
 *
 * @param userDID Admin DID header value.
 * @returns Queue and stream snapshot.
 */
export async function getMonitoringStatus(userDID: string): Promise<{
  mainStream: {
    isRunning: boolean;
    monitoredDIDs: number;
    hasValidCursor: boolean;
  };
  tempStreams: number;
  maxStreams: number;
  queueLength: number;
  availableSlots: number;
  activeUsers: Array<{
    did: string;
    handle: string | null;
    monitoredCount: number;
    lastStartedAt: string | null;
    lastCompletedAt: string | null;
    hasCompletedBackfill: boolean;
  }>;
  tempStreamUsers: Array<{ did: string; handle: string | null }>;

  // Fetch a fresh monitoring snapshot from the backend.
}> {
  const response = await fetch(`${API_BASE}/monitoring/status`, {
    headers: buildHeaders(userDID),
  });
  // Parse JSON payload containing admin metrics
  const data: APIResponse<{
    mainStream: {
      isRunning: boolean;
      monitoredDIDs: number;
      hasValidCursor: boolean;
    };
    tempStreams: number;
    maxStreams: number;
    queueLength: number;
    availableSlots: number;
    activeUsers: Array<{
      did: string;
      handle: string | null;
      monitoredCount: number;
      lastStartedAt: string | null;
      lastCompletedAt: string | null;
      hasCompletedBackfill: boolean;
    }>;
    tempStreamUsers: Array<{ did: string; handle: string | null }>;
  }> = await response.json();

  if (!data.success || !data.data) {
    throw new Error(data.error || "Failed to get monitoring status");
  }
  return data.data;
}

/**
 * Trigger a manual 24h backfill for a monitored user (admin only).
 *
 * @param adminDID Admin DID header value.
 * @param targetDID User DID whose backfill should start.
 * @returns Queue/start metadata.
 */
export async function triggerManualBackfill(
  adminDID: string,
  targetDID: string,
): Promise<{ queued: boolean; position?: number; message: string }> {
  // Issue POST to trigger a temporary 24h backfill for the target user
  const response = await fetch(
    `${API_BASE}/monitoring/backfill/${encodeURIComponent(targetDID)}`,
    {
      method: "POST",
      headers: buildHeaders(adminDID),
    },
  );

  // Decode structured API response (includes queue metadata/message)
  const data: APIResponse<{
    queued: boolean;
    position?: number;
    message: string;
  }> = await response.json();

  // Validate success before returning payload to caller
  if (!data.success || !data.data) {
    throw new Error(data.error || "Failed to start manual backfill");
  }
  return data.data;
}

/**
 * Get changes for a user's monitored follows.
 *
 * @param userDID DID whose monitored changes should be retrieved.
 * @returns Profile-change array.
 */
export async function getMonitoredChanges(
  userDID: string,
): Promise<ProfileChange[]> {
  // Request monitored changes for the user's follow set
  const response = await fetch(
    `${API_BASE}/monitoring/changes/${encodeURIComponent(userDID)}`,
    {
      headers: buildHeaders(userDID),
    },
  );

  // Parse backend payload listing monitored follow changes.
  const data: APIResponse<GetChangesResponse> = await response.json();

  // Validate success before accessing changes array
  if (!data.success || !data.data) {
    throw new Error(data.error || "Failed to fetch monitored changes");
  }
  return data.data.changes;
}

/**
 * Get all changes from global database (community-wide, all users).
 *
 * @param userDID Auth DID.
 * @returns List of known profile changes.
 */
export async function getGlobalChanges(
  userDID: string,
): Promise<ProfileChange[]> {
  // Request global profile changes (community-wide)
  const response = await fetch(`${API_BASE}/changes`, {
    headers: buildHeaders(userDID),
  });

  // Parse backend payload listing global change records.
  const data: APIResponse<GetChangesResponse> = await response.json();

  // Validate success before returning global change list
  if (!data.success || !data.data) {
    throw new Error(data.error || "Failed to fetch global changes");
  }
  return data.data.changes;
}

/**
 * Check if user has any monitored follows.
 *
 * @param userDID DID to check.
 * @returns True when user already has monitored entries.
 */
export async function hasMonitoredFollows(userDID: string): Promise<boolean> {
  const response = await fetch(
    `${API_BASE}/monitoring/follows/${encodeURIComponent(userDID)}`,
    {
      headers: buildHeaders(userDID),
    },
  );

  // Inspect response body for existing monitored follow entries.
  const data: APIResponse<{ follows: any[] }> = await response.json();

  // Treat missing/unsuccessful responses as "no monitored follows"
  if (!data.success || !data.data) {
    return false;
  }
  // Return true only when the backend reports at least one follow row
  return data.data.follows.length > 0;
}

/**
 * Disable monitoring for a user (removes DIDs from monitored_follows).
 *
 * @param userDID Current user DID.
 */
export async function disableMonitoring(userDID: string): Promise<void> {
  const response = await fetch(
    `${API_BASE}/monitoring/disable/${encodeURIComponent(userDID)}`,
    {
      method: "DELETE",
      headers: buildHeaders(userDID),
    },
  );

  // Evaluate backend acknowledgement for monitoring disable request.
  const data: APIResponse<{ message: string }> = await response.json();

  // Verify backend acknowledged the delete operation
  if (!data.success) {
    throw new Error(data.error || "Failed to disable monitoring");
  }
}

/**
 * Purge all data for the current user DID:
 * - stop any temporary stream
 * - remove monitored_follows entries
 * - delete the user's own profile_changes
 * - clear backfill state
 */
export async function purgeMyData(userDID: string): Promise<{ deletedChanges: number }> {
  const response = await fetch(
    `${API_BASE}/monitoring/purge/${encodeURIComponent(userDID)}`,
    {
      method: "DELETE",
      headers: buildHeaders(userDID),
    },
  );

  // Expect backend acknowledgement with optional deleted change count
  const data: APIResponse<{ message: string; deletedChanges: number }> = await response.json();
  if (!data.success || !data.data) {
    throw new Error(data.error || "Failed to purge user data");
  }
  return { deletedChanges: data.data.deletedChanges };
}

/**
 * Get admin statistics (admin only).
 *
 * @param userDID Admin DID header value.
 * @returns Aggregate monitoring stats payload.
 */
export async function getAdminStats(userDID: string): Promise<{
  totalMonitoredDIDs: number;
  totalMonitoringUsers: number;
  jetstreamStatus: string;
  cursorTimestamp: string | null;
  isInBackfill: boolean;
  uptimeSeconds: number | null;
}> {
  // Request aggregate admin stats with the privileged DID header.
  const response = await fetch(`${API_BASE}/admin/stats`, {
    headers: {
      "X-User-DID": userDID,
    },
  });

  // Parse JSON payload containing admin metrics
  // Fields: totals, main stream status, cursor/backfill, uptime
  const data: APIResponse<{
    totalMonitoredDIDs: number;
    totalMonitoringUsers: number;
    jetstreamStatus: string;
    cursorTimestamp: string | null;
    isInBackfill: boolean;
    uptimeSeconds: number | null;
  }> = await response.json();

  // Validate success before returning the admin stats object
  if (!data.success || !data.data) {
    throw new Error(data.error || "Failed to fetch admin stats");
  }
  return data.data;
}

/**
 * Stop Jetstream (admin only).
 *
 * @param userDID Admin DID header value.
 * @returns Success message from backend.
 */
export async function stopJetstream(userDID: string): Promise<string> {
  // Issue admin request to stop the main Jetstream service
  const response = await fetch(`${API_BASE}/admin/jetstream/stop`, {
    method: "POST",
    headers: {
      "X-User-DID": userDID,
    },
  });

  // Extract success message returned by the stop endpoint.
  const data: APIResponse<{ message: string }> = await response.json();

  // Validate success before returning the confirmation
  if (!data.success || !data.data) {
    throw new Error(data.error || "Failed to stop Jetstream");
  }
  // Return human‑readable confirmation message
  return data.data.message;
}

/**
 * Get recommended cursor for starting Jetstream (admin only).
 *
 * @param userDID Admin DID header value.
 * @returns Recommended cursor timestamp in microseconds.
 */
export async function getRecommendedStartCursor(
  userDID: string,
): Promise<number> {
  // Request a recommended start cursor for Jetstream (resume if <24h, else live)
  const response = await fetch(
    `${API_BASE}/admin/jetstream/recommended-cursor`,
    {
      method: "GET",
      headers: {
        "X-User-DID": userDID,
      },
    },
  );

  // Parse backend response containing the suggested cursor
  const data: APIResponse<{ cursor: number }> = await response.json();

  // Validate success before returning the microsecond cursor
  if (!data.success || !data.data) {
    throw new Error(data.error || "Failed to get recommended cursor");
  }
  return data.data.cursor;
}

/**
 * Start Jetstream with optional cursor (admin only).
 *
 * @param userDID Admin DID header value.
 * @param cursor Optional cursor timestamp in microseconds.
 * @returns Success message from backend.
 */
export async function startJetstream(
  userDID: string,
  cursor?: number,
): Promise<string> {
  // Request backend to start Jetstream; include microsecond cursor when provided
  const response = await fetch(`${API_BASE}/admin/jetstream/start`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-User-DID": userDID,
    },
    body: JSON.stringify({ cursor }),
  });

  // Extract success message returned by the start endpoint.
  const data: APIResponse<{ message: string }> = await response.json();

  // Validate success before returning confirmation
  if (!data.success || !data.data) {
    throw new Error(data.error || "Failed to start Jetstream");
  }
  // Return human‑readable confirmation
  return data.data.message;
}

/**
 * Get ignored users (admin only).
 *
 * @param userDID Admin DID header value.
 * @returns Array of ignored DID records.
 */
export async function getIgnoredUsers(
  userDID: string,
): Promise<{ did: string; added_at: string; handle: string | null }[]> {
  // Request admin-only ignored users list
  const response = await fetch(`${API_BASE}/admin/ignored-users`, {
    headers: {
      "X-User-DID": userDID,
    },
  });

  // Parse admin-only ignored user list payload.
  const data: APIResponse<
    { did: string; added_at: string; handle: string | null }[]
  > = await response.json();

  // Validate success before returning the ignored users array
  if (!data.success || !data.data) {
    throw new Error(data.error || "Failed to fetch ignored users");
  }
  return data.data;
}

/**
 * Add ignored user (admin only).
 *
 * @param userDID Admin DID header value.
 * @param did DID to ignore.
 * @returns Backend response summarizing deletions.
 */
export async function addIgnoredUser(
  userDID: string,
  did: string,
): Promise<{ did: string; deletedChanges: number; message: string }> {
  // Request to add a DID to the admin-only ignore list
  const response = await fetch(`${API_BASE}/admin/ignored-users`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-User-DID": userDID,
    },
    body: JSON.stringify({ did }),
  });

  // Interpret backend summary for the newly ignored DID.
  const data: APIResponse<{
    did: string;
    deletedChanges: number;
    message: string;
  }> = await response.json();

  // Validate success before returning the operation summary
  if (!data.success || !data.data) {
    throw new Error(data.error || "Failed to add ignored user");
  }
  // Return DID + deleted change count + confirmation message
  return data.data;
}

/**
 * Remove ignored user (admin only).
 *
 * @param userDID Admin DID header value.
 * @param did DID to remove.
 * @returns Confirmation message.
 */
export async function removeIgnoredUser(
  userDID: string,
  did: string,
): Promise<string> {
  // Request to remove a DID from the admin-only ignore list
  const response = await fetch(
    `${API_BASE}/admin/ignored-users/${encodeURIComponent(did)}`,
    {
      method: "DELETE",
      headers: {
        "X-User-DID": userDID,
      },
    },
  );

  // Extract confirmation message from ignored-user removal.
  const data: APIResponse<{ message: string }> = await response.json();

  // Validate success before returning the confirmation message
  if (!data.success || !data.data) {
    throw new Error(data.error || "Failed to remove ignored user");
  }
  // Return human‑readable confirmation
  return data.data.message;
}
