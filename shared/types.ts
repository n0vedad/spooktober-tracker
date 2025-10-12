/**
 * Shared types for spooktober_tracker
 * Used by both frontend and backend
 */

/**
 * Profile-change event for a DID.
 *
 * Captures handle and profile updates with old/new values when applicable.
 * The `change_type` distinguishes handle vs profile vs combined changes.
 * `changed_at` is an ISO-8601 timestamp of observation.
 */
export interface ProfileChange {
  did: string;
  handle: string | null;
  old_handle: string | null;
  new_handle: string | null;
  old_display_name: string | null;
  new_display_name: string | null;
  old_avatar: string | null;
  new_avatar: string | null;
  change_type: 'handle' | 'profile' | 'combined';
  changed_at: string;
}

/**
 * Generic API response envelope.
 * Includes a success flag, with optional data or error message.
 */
export interface APIResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * Response body for listing profile changes.
 */
export interface GetChangesResponse {
  changes: ProfileChange[];
}

/**
 * Request body to submit a profile-change record.
 * Only include fields that changed; `did` is required.
 */
export interface SubmitChangeRequest {
  did: string;
  handle?: string;
  old_handle?: string;
  new_handle?: string;
  old_display_name?: string;
  new_display_name?: string;
  old_avatar?: string;
  new_avatar?: string;
}
