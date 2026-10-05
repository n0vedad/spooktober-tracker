import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDB } from "../../test/db-helpers.js";
import { fetchFollowList } from "../bubble/follow-lists.js";
import {
  getChangeHistory,
  getSnapshot,
  isIgnored,
  isNoisy,
  flagNoisy,
  countRecentChanges,
  pool,
  recordChange,
  saveSnapshot,
  seedSnapshots,
} from "../db.js";
import { createProfileTracker } from "./profile-tracker.js";
import { avatarCidFromUrl, fetchProfiles, snapshotFromView } from "./seed.js";

const ALICE = "did:plc:alice";
const AVATAR =
  "https://cdn.bsky.app/img/avatar/plain/did:plc:alice/bafkreidqpgdxkvr5b4sm2gd76hxdea533rjvbajhxswksbg2qvid6xrrza";

beforeEach(resetDB);
afterAll(() => pool.end());

describe("profile views", () => {
  it("extracts the avatar CID from CDN URLs", () => {
    expect(avatarCidFromUrl(AVATAR)).toBe(
      "bafkreidqpgdxkvr5b4sm2gd76hxdea533rjvbajhxswksbg2qvid6xrrza",
    );
    expect(avatarCidFromUrl(`${AVATAR}@jpeg`)).toBe(
      "bafkreidqpgdxkvr5b4sm2gd76hxdea533rjvbajhxswksbg2qvid6xrrza",
    );
    expect(avatarCidFromUrl(undefined)).toBeNull();
  });

  it("normalises views like Jetstream records", () => {
    expect(
      snapshotFromView({
        did: ALICE,
        handle: "handle.invalid",
        displayName: "",
      }),
    ).toEqual({
      did: ALICE,
      handle: null,
      display_name: null,
      avatar_cid: null,
      profile_seen: true,
    });
  });

  it("loads profiles in batches of 25", async () => {
    const dids = Array.from({ length: 30 }, (_, i) => `did:plc:u${i}`);
    const fetchFn = vi.fn(async (url: string) =>
      Response.json({
        profiles: new URL(url).searchParams
          .getAll("actors")
          .map((did) => ({ did })),
      }),
    );

    const views = await fetchProfiles(dids, fetchFn);

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(views).toHaveLength(30);
  });
});

describe("seedSnapshots", () => {
  it("adds missing snapshots but never overwrites known ones", async () => {
    await saveSnapshot({
      did: ALICE,
      handle: "alice.test",
      display_name: "Known",
      avatar_cid: null,
      profile_seen: true,
    });

    const inserted = await seedSnapshots([
      snapshotFromView({ did: ALICE, displayName: "Stale" }),
      snapshotFromView({ did: "did:plc:bob", displayName: "Bob" }),
    ]);

    expect(inserted).toBe(1);
    expect((await getSnapshot(ALICE))?.display_name).toBe("Known");
    expect((await getSnapshot("did:plc:bob"))?.display_name).toBe("Bob");
  });

  it("lets the first change after seeding be detected", async () => {
    const tracker = createProfileTracker({
      getSnapshot,
      saveSnapshot,
      recordChange,
      isIgnored,
      isNoisy,
      flagNoisy,
      countRecentChanges,
      resolveHandle: async () => null,
      lookupPreviousHandle: async () => null,
    });
    await seedSnapshots([
      snapshotFromView({
        did: ALICE,
        handle: "alice.test",
        displayName: "Alice",
      }),
    ]);

    const result = await tracker.trackProfile({
      did: ALICE,
      seq: 1,
      time: new Date("2026-10-06T12:00:00Z"),
      displayName: "Alice 🎃",
      avatarCid: null,
      recordCreatedAt: new Date("2024-01-01T00:00:00Z"),
      selfLabels: [],
    });

    expect(result).toBe("changed");
    expect((await getChangeHistory(ALICE))[0]).toMatchObject({
      handle: "alice.test",
      old_display_name: "Alice",
    });
  });
});

describe("fetchFollowList", () => {
  it("passes each page of profile views to onPage", async () => {
    const onPage = vi.fn();
    const fetchFn = vi.fn(async () =>
      Response.json({ follows: [{ did: ALICE, displayName: "Alice" }] }),
    );

    await fetchFollowList("did:plc:me", { fetchFn, onPage });

    expect(onPage).toHaveBeenCalledWith([{ did: ALICE, displayName: "Alice" }]);
  });
});
