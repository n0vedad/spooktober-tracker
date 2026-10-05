import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDB } from "../../test/db-helpers.js";
import {
  addIgnoredUser,
  getChangeHistory,
  getSnapshot,
  isIgnored,
  pool,
  recordChange,
  saveSnapshot,
} from "../db.js";
import {
  createProfileTracker,
  ONBOARDING_WINDOW_MS,
  readProfileRecord,
} from "./profile-tracker.js";

const DID = "did:plc:alice";
const T0 = new Date("2026-10-05T12:00:00Z");
// Profile record created long before the events under test
const OLD_PROFILE = new Date("2024-01-01T00:00:00Z");

beforeEach(resetDB);
afterAll(() => pool.end());

function makeTracker(previousHandle: string | null = null) {
  const lookupPreviousHandle = vi.fn(async () => previousHandle);
  const tracker = createProfileTracker({
    getSnapshot,
    saveSnapshot,
    recordChange,
    isIgnored,
    lookupPreviousHandle,
  });
  return { ...tracker, lookupPreviousHandle };
}

const profile = (
  seq: number,
  displayName: string | null,
  avatarCid: string | null = "bafyavatar1",
) => ({
  did: DID,
  seq,
  time: T0,
  displayName,
  avatarCid,
  recordCreatedAt: OLD_PROFILE,
});

describe("trackProfile", () => {
  it("stores the first sighting as baseline without recording a change", async () => {
    const { trackProfile } = makeTracker();

    expect(await trackProfile(profile(1, "Alice"))).toBe("baseline");
    expect(await getChangeHistory(DID)).toEqual([]);
    expect(await getSnapshot(DID)).toMatchObject({
      display_name: "Alice",
      avatar_cid: "bafyavatar1",
      profile_seen: true,
    });
  });

  it("records a display-name change with old and new value", async () => {
    const { trackProfile } = makeTracker();
    await trackProfile(profile(1, "Alice"));

    expect(await trackProfile(profile(2, "Alice 🎃"))).toBe("changed");

    const [change] = await getChangeHistory(DID);
    expect(change).toMatchObject({
      old_display_name: "Alice",
      new_display_name: "Alice 🎃",
      old_avatar: null,
      new_avatar: null,
      change_type: "profile",
    });
    expect(new Date(change.changed_at)).toEqual(T0);
  });

  it("records avatar changes and removals", async () => {
    const { trackProfile } = makeTracker();
    await trackProfile(profile(1, "Alice", "bafyold"));
    await trackProfile(profile(2, "Alice", "bafynew"));
    await trackProfile(profile(3, "Alice", null));

    const history = await getChangeHistory(DID);
    expect(history.map((c) => [c.old_avatar, c.new_avatar])).toEqual([
      ["bafynew", null],
      ["bafyold", "bafynew"],
    ]);
  });

  it("ignores updates that only touch untracked fields", async () => {
    const { trackProfile } = makeTracker();
    await trackProfile(profile(1, "Alice"));

    expect(await trackProfile(profile(2, "Alice"))).toBe("unchanged");
    expect(await getChangeHistory(DID)).toEqual([]);
  });

  it("detects a revert to an earlier name (A → B → A)", async () => {
    const { trackProfile } = makeTracker();
    await trackProfile(profile(1, "Alice"));
    await trackProfile(profile(2, "Ghost"));
    await trackProfile(profile(3, "Alice"));

    expect(await getChangeHistory(DID)).toHaveLength(2);
  });

  it("is idempotent when the same event is processed twice", async () => {
    const { trackProfile } = makeTracker();
    await trackProfile(profile(1, "Alice"));
    await recordChange({
      did: DID,
      handle: null,
      old_display_name: "Alice",
      new_display_name: "Ghost",
      changed_at: T0,
      source_seq: 2,
    });

    // Crash happened after recording but before the snapshot update
    await trackProfile(profile(2, "Ghost"));

    expect(await getChangeHistory(DID)).toHaveLength(1);
    expect((await getSnapshot(DID))?.display_name).toBe("Ghost");
  });

  it("treats a handle-only snapshot as baseline for the profile", async () => {
    const { trackProfile, trackHandle } = makeTracker();
    await trackHandle({ did: DID, seq: 1, time: T0, handle: "alice.test" });

    expect(await trackProfile(profile(2, "Alice"))).toBe("baseline");
    expect(await getSnapshot(DID)).toMatchObject({
      handle: "alice.test",
      display_name: "Alice",
      profile_seen: true,
    });
  });

  it("does not report profile setup of brand-new accounts as renames", async () => {
    const { trackProfile } = makeTracker();
    const justCreated = new Date(T0.getTime() - 60_000);
    // Sign-up first writes the handle as display name, then the real one
    await trackProfile({
      ...profile(1, "newbie.bsky.social", null),
      recordCreatedAt: justCreated,
    });

    expect(
      await trackProfile({
        ...profile(2, "Newbie", "bafyavatar1"),
        recordCreatedAt: justCreated,
      }),
    ).toBe("baseline");
    expect(await getChangeHistory(DID)).toEqual([]);
    expect((await getSnapshot(DID))?.display_name).toBe("Newbie");
  });

  it("reports renames once the onboarding window has passed", async () => {
    const { trackProfile } = makeTracker();
    const created = new Date(T0.getTime() - ONBOARDING_WINDOW_MS - 1);
    await trackProfile({ ...profile(1, "Newbie"), recordCreatedAt: created });

    expect(
      await trackProfile({ ...profile(2, "Ghost"), recordCreatedAt: created }),
    ).toBe("changed");
  });

  it("skips ignored accounts entirely", async () => {
    const { trackProfile } = makeTracker();
    await addIgnoredUser(DID);

    expect(await trackProfile(profile(1, "Alice"))).toBe("ignored");
    expect(await getSnapshot(DID)).toBeNull();
  });
});

describe("trackHandle", () => {
  const handle = (seq: number, h: string) => ({
    did: DID,
    seq,
    time: T0,
    handle: h,
  });

  it("records a handle change against the stored snapshot", async () => {
    const { trackHandle, lookupPreviousHandle } = makeTracker();
    await trackHandle(handle(1, "alice.test"));

    expect(await trackHandle(handle(2, "spooky.test"))).toBe("changed");

    const [change] = await getChangeHistory(DID);
    expect(change).toMatchObject({
      handle: "spooky.test",
      old_handle: "alice.test",
      new_handle: "spooky.test",
      change_type: "handle",
    });
    // Baseline lookup only happened for the very first event
    expect(lookupPreviousHandle).toHaveBeenCalledTimes(1);
  });

  it("uses the PLC lookup for accounts without a snapshot", async () => {
    const { trackHandle, lookupPreviousHandle } = makeTracker("alice.test");

    expect(await trackHandle(handle(1, "spooky.test"))).toBe("changed");
    expect(lookupPreviousHandle).toHaveBeenCalledWith(DID, "spooky.test", T0);
    expect((await getChangeHistory(DID))[0].old_handle).toBe("alice.test");
  });

  it("treats re-announcements of the same handle as unchanged", async () => {
    const { trackHandle } = makeTracker();
    await trackHandle(handle(1, "alice.test"));

    expect(await trackHandle(handle(2, "alice.test"))).toBe("unchanged");
    expect(await getChangeHistory(DID)).toEqual([]);
  });

  it("never records handle.invalid", async () => {
    const { trackHandle } = makeTracker();
    await trackHandle(handle(1, "alice.test"));

    expect(await trackHandle(handle(2, "handle.invalid"))).toBe("unchanged");
    expect((await getSnapshot(DID))?.handle).toBe("alice.test");
  });

  it("keeps the known profile fields when the handle changes", async () => {
    const { trackProfile, trackHandle } = makeTracker();
    await trackProfile(profile(1, "Alice"));
    await trackHandle(handle(2, "alice.test"));
    await trackHandle(handle(3, "spooky.test"));

    // A later profile update must still compare against "Alice"
    expect(await trackProfile(profile(4, "Ghost"))).toBe("changed");
    const [latest] = await getChangeHistory(DID);
    expect(latest).toMatchObject({
      handle: "spooky.test",
      old_display_name: "Alice",
    });
  });
});

describe("readProfileRecord", () => {
  it("reads display name and current-style avatar refs", () => {
    expect(
      readProfileRecord({
        $type: "app.bsky.actor.profile",
        displayName: "にーろ",
        avatar: { $type: "blob", ref: { $link: "bafkreiav" }, size: 1 },
      }),
    ).toEqual({
      displayName: "にーろ",
      avatarCid: "bafkreiav",
      recordCreatedAt: null,
    });
  });

  it("reads legacy avatar refs and normalises empty values", () => {
    expect(
      readProfileRecord({
        displayName: "",
        avatar: { cid: "bafylegacy" },
        createdAt: "2025-12-24T17:17:40.089Z",
      }),
    ).toEqual({
      displayName: null,
      avatarCid: "bafylegacy",
      recordCreatedAt: new Date("2025-12-24T17:17:40.089Z"),
    });
  });

  it("returns nulls for deleted records", () => {
    expect(readProfileRecord(undefined)).toEqual({
      displayName: null,
      avatarCid: null,
      recordCreatedAt: null,
    });
  });
});
