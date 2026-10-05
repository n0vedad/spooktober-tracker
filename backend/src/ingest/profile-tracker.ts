/**
 * Change detection for profile records and handles.
 *
 * Compares each incoming event against the last stored snapshot of the
 * account. The first event seen for an account only establishes the baseline,
 * because Jetstream delivers the new state but never the previous one.
 */

import type {
  NewProfileChange,
  ProfileChangeRow,
  ProfileSnapshot,
} from "../db.js";

// Placeholder Bluesky shows when a handle fails verification; never a real change
const INVALID_HANDLE = "handle.invalid";

// Profiles younger than this are still being set up during sign-up
// (the app first writes the handle as display name, then the real values)
export const ONBOARDING_WINDOW_MS = 60 * 60 * 1000;

/**
 * Storage and lookup operations the tracker depends on.
 */
export interface TrackerDeps {
  getSnapshot(did: string): Promise<ProfileSnapshot | null>;
  saveSnapshot(snapshot: ProfileSnapshot): Promise<void>;
  recordChange(change: NewProfileChange): Promise<ProfileChangeRow | null>;
  isIgnored(did: string): Promise<boolean>;
  /**
   * Resolve the handle an account had right before switching to `newHandle`,
   * used when no snapshot exists yet. Returns null when unknown.
   */
  lookupPreviousHandle(
    did: string,
    newHandle: string,
    eventTime: Date,
  ): Promise<string | null>;
}

// New state of an actor profile (`app.bsky.actor.profile/self`).
export interface ProfileState {
  did: string;
  seq: number;
  time: Date;
  displayName: string | null;
  avatarCid: string | null;
  // `createdAt` of the profile record (kept across updates); null if unknown
  recordCreatedAt: Date | null;
}

// New handle announced by an identity event.
export interface HandleState {
  did: string;
  seq: number;
  time: Date;
  handle: string;
}

// What the tracker did with an event (useful for logging and tests).
export type TrackResult = "ignored" | "baseline" | "unchanged" | "changed";

/**
 * Create tracker functions bound to the given dependencies.
 *
 * @param deps Storage and lookup operations.
 * @returns Handlers for profile and handle updates.
 */
export function createProfileTracker(deps: TrackerDeps) {
  /**
   * Process a new profile state (create, update or delete of the record).
   */
  async function trackProfile(state: ProfileState): Promise<TrackResult> {
    if (await deps.isIgnored(state.did)) return "ignored";

    const snapshot = await deps.getSnapshot(state.did);
    const next: ProfileSnapshot = {
      did: state.did,
      handle: snapshot?.handle ?? null,
      display_name: state.displayName,
      avatar_cid: state.avatarCid,
      profile_seen: true,
    };

    // First sighting of this profile: nothing to compare against
    if (!snapshot?.profile_seen) {
      await deps.saveSnapshot(next);
      return "baseline";
    }

    // Brand-new account still filling in its profile: not a rename
    if (
      state.recordCreatedAt &&
      state.time.getTime() - state.recordCreatedAt.getTime() <
        ONBOARDING_WINDOW_MS
    ) {
      await deps.saveSnapshot(next);
      return "baseline";
    }

    const nameChanged = snapshot.display_name !== state.displayName;
    const avatarChanged = snapshot.avatar_cid !== state.avatarCid;

    // Other profile fields (bio, banner, ...) changed; nothing we track
    if (!nameChanged && !avatarChanged) return "unchanged";

    // Record before updating the snapshot, so a crash in between is replayed
    await deps.recordChange({
      did: state.did,
      handle: snapshot.handle,
      ...(nameChanged && {
        old_display_name: snapshot.display_name,
        new_display_name: state.displayName,
      }),
      ...(avatarChanged && {
        old_avatar: snapshot.avatar_cid,
        new_avatar: state.avatarCid,
      }),
      changed_at: state.time,
      source_seq: state.seq,
    });
    await deps.saveSnapshot(next);
    return "changed";
  }

  /**
   * Process a handle announced by an identity event.
   */
  async function trackHandle(state: HandleState): Promise<TrackResult> {
    if (state.handle === INVALID_HANDLE) return "unchanged";
    if (await deps.isIgnored(state.did)) return "ignored";

    const snapshot = await deps.getSnapshot(state.did);
    const next: ProfileSnapshot = {
      did: state.did,
      handle: state.handle,
      display_name: snapshot?.display_name ?? null,
      avatar_cid: snapshot?.avatar_cid ?? null,
      profile_seen: snapshot?.profile_seen ?? false,
    };

    // Same handle re-announced (key rotation, PDS move, resync, ...)
    if (snapshot?.handle === state.handle) return "unchanged";

    // Unknown previous handle: ask the PLC audit log whether this is a fresh rename
    const oldHandle =
      snapshot?.handle ??
      (await deps.lookupPreviousHandle(state.did, state.handle, state.time));

    if (!oldHandle || oldHandle === state.handle) {
      await deps.saveSnapshot(next);
      return "baseline";
    }

    await deps.recordChange({
      did: state.did,
      handle: state.handle,
      old_handle: oldHandle,
      new_handle: state.handle,
      changed_at: state.time,
      source_seq: state.seq,
    });
    await deps.saveSnapshot(next);
    return "changed";
  }

  return { trackProfile, trackHandle };
}

/**
 * Extract the tracked fields from a raw (wire JSON) profile record.
 *
 * @param record Raw record from a Jetstream commit, or undefined for deletes.
 * @returns Display name and avatar CID (null when absent).
 */
export function readProfileRecord(record: unknown): {
  displayName: string | null;
  avatarCid: string | null;
  recordCreatedAt: Date | null;
} {
  if (!record || typeof record !== "object") {
    return { displayName: null, avatarCid: null, recordCreatedAt: null };
  }
  const r = record as {
    displayName?: unknown;
    avatar?: { ref?: { $link?: unknown }; cid?: unknown };
    createdAt?: unknown;
  };

  const displayName =
    typeof r.displayName === "string" && r.displayName !== ""
      ? r.displayName
      : null;

  // Current blob refs use { ref: { $link } }; legacy ones use { cid }
  const link = r.avatar?.ref?.$link ?? r.avatar?.cid;
  const avatarCid = typeof link === "string" && link !== "" ? link : null;

  const created =
    typeof r.createdAt === "string" ? new Date(r.createdAt) : null;
  const recordCreatedAt =
    created && !Number.isNaN(created.getTime()) ? created : null;

  return { displayName, avatarCid, recordCreatedAt };
}
