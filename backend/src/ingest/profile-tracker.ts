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

// Accounts with more recorded changes than this within the window are
// treated as bots (clocks, "now playing", ...) and suppressed from then on
export const MAX_CHANGES_PER_WINDOW = 10;
export const NOISE_WINDOW_MS = 24 * 60 * 60 * 1000;

// Self-label Bluesky accounts can set on their own profile to mark a bot
const BOT_SELF_LABEL = "bot";

/**
 * Storage and lookup operations the tracker depends on.
 */
export interface TrackerDeps {
  getSnapshot(did: string): Promise<ProfileSnapshot | null>;
  saveSnapshot(snapshot: ProfileSnapshot): Promise<void>;
  recordChange(change: NewProfileChange): Promise<ProfileChangeRow | null>;
  isIgnored(did: string): Promise<boolean>;
  isNoisy(did: string): Promise<boolean>;
  flagNoisy(did: string, reason: string): Promise<void>;
  countRecentChanges(did: string, since: Date): Promise<number>;
  /**
   * Current handle from the DID document, used when a profile changes before
   * any identity event revealed the handle. May throw; failures yield null.
   */
  resolveHandle(did: string): Promise<string | null>;
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
  // Self-labels set on the profile record (e.g. "bot")
  selfLabels: string[];
}

// New handle announced by an identity event.
export interface HandleState {
  did: string;
  seq: number;
  time: Date;
  handle: string;
}

// What the tracker did with an event (useful for logging and tests).
export type TrackResult =
  | "ignored"
  | "baseline"
  | "unchanged"
  | "changed"
  // A change happened, but the account is (now) flagged as a bot
  | "suppressed";

/**
 * Create tracker functions bound to the given dependencies.
 *
 * @param deps Storage and lookup operations.
 * @returns Handlers for profile and handle updates.
 */
export function createProfileTracker(deps: TrackerDeps) {
  /**
   * Decide whether a change of this account may be recorded, flagging the
   * account as noisy once it exceeds the change rate limit.
   */
  async function mayRecord(did: string, time: Date): Promise<boolean> {
    if (await deps.isNoisy(did)) return false;
    const since = new Date(time.getTime() - NOISE_WINDOW_MS);
    if ((await deps.countRecentChanges(did, since)) >= MAX_CHANGES_PER_WINDOW) {
      await deps.flagNoisy(did, "frequent-changes");
      return false;
    }
    return true;
  }

  /**
   * Resolve the current handle, treating lookup failures as unknown.
   */
  async function resolveHandleSafely(did: string): Promise<string | null> {
    try {
      return await deps.resolveHandle(did);
    } catch {
      return null;
    }
  }

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

    // Self-declared bots are never tracked
    if (state.selfLabels.includes(BOT_SELF_LABEL)) {
      await deps.flagNoisy(state.did, "bot-self-label");
      await deps.saveSnapshot(next);
      return "suppressed";
    }

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

    if (!(await mayRecord(state.did, state.time))) {
      await deps.saveSnapshot(next);
      return "suppressed";
    }

    // Changes are listed by handle, so look it up once if still unknown
    next.handle = snapshot.handle ?? (await resolveHandleSafely(state.did));

    // Record before updating the snapshot, so a crash in between is replayed
    await deps.recordChange({
      did: state.did,
      handle: next.handle,
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

    if (!(await mayRecord(state.did, state.time))) {
      await deps.saveSnapshot(next);
      return "suppressed";
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
  selfLabels: string[];
} {
  if (!record || typeof record !== "object") {
    return {
      displayName: null,
      avatarCid: null,
      recordCreatedAt: null,
      selfLabels: [],
    };
  }
  const r = record as {
    displayName?: unknown;
    avatar?: { ref?: { $link?: unknown }; cid?: unknown };
    createdAt?: unknown;
    labels?: { values?: Array<{ val?: unknown }> };
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

  const selfLabels = Array.isArray(r.labels?.values)
    ? r.labels.values
        .map((label) => label?.val)
        .filter((val): val is string => typeof val === "string")
    : [];

  return { displayName, avatarCid, recordCreatedAt, selfLabels };
}
