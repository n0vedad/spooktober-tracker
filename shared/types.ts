/**
 * Shared types for spooktober_tracker
 * Used by both frontend and backend
 */

export interface ProfileChange {
  /** DID whose profile changed. */
  did: string;
  /** Most recent handle for this DID (used for all change types). */
  handle: string | null;
  /** Previous handle (only set for handle changes, otherwise null). */
  old_handle: string | null;
  /** New handle (only set for handle changes, otherwise null). */
  new_handle: string | null;
  /** Previous display name. */
  old_display_name: string | null;
  /** Updated display name. */
  new_display_name: string | null;
  /** Previous avatar CID. */
  old_avatar: string | null;
  /** Updated avatar CID. */
  new_avatar: string | null;
  /** Type of change: handle, profile, or combined. */
  change_type: 'handle' | 'profile' | 'combined';
  changed_at: string; // ISO timestamp
}

export interface APIResponse<T> {
  /** Indicates whether the request succeeded. */
  success: boolean;
  data?: T;
  error?: string;
}

export interface GetChangesResponse {
  /** List of matching profile-change entries. */
  changes: ProfileChange[];
}

export interface SubmitChangeRequest {
  /** DID whose profile change is being submitted. */
  did: string;
  handle?: string;
  old_handle?: string;
  new_handle?: string;
  old_display_name?: string;
  new_display_name?: string;
  old_avatar?: string;
  new_avatar?: string;
}
