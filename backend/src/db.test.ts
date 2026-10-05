import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetDB } from "../test/db-helpers.js";
import {
  addIgnoredUser,
  addMonitoredFollows,
  getChangesForUser,
  insertChange,
  pool,
} from "./db.js";

const ALICE = "did:plc:alice";
const BOB = "did:plc:bob";

beforeEach(resetDB);
afterAll(() => pool.end());

describe("insertChange", () => {
  it("stores a display-name change as type 'profile'", async () => {
    const row = await insertChange({
      did: ALICE,
      old_display_name: "Alice",
      new_display_name: "Alice 🎃",
    });

    expect(row).toMatchObject({
      did: ALICE,
      old_display_name: "Alice",
      new_display_name: "Alice 🎃",
      change_type: "profile",
    });
  });

  it("classifies handle-only and combined changes", async () => {
    const handle = await insertChange({
      did: ALICE,
      old_handle: "alice.bsky.social",
      new_handle: "spooky-alice.bsky.social",
    });
    const combined = await insertChange({
      did: BOB,
      old_handle: "bob.bsky.social",
      new_handle: "boo-b.bsky.social",
      new_display_name: "Boo",
    });

    expect(handle?.change_type).toBe("handle");
    expect(combined?.change_type).toBe("combined");
  });

  it("returns the existing row instead of inserting a duplicate", async () => {
    const change = {
      did: ALICE,
      old_display_name: "Alice",
      new_display_name: "Ghost",
    };
    const first = await insertChange(change);
    const second = await insertChange(change);

    expect(second?.id).toBe(first?.id);
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM profile_changes",
    );
    expect(rows[0].n).toBe(1);
  });

  it("skips ignored DIDs", async () => {
    await addIgnoredUser(ALICE);

    const row = await insertChange({ did: ALICE, new_display_name: "X" });

    expect(row).toBeNull();
  });
});

describe("getChangesForUser", () => {
  it("returns only changes of monitored follows that are not ignored", async () => {
    await addMonitoredFollows(BOB, [
      { did: ALICE, handle: "alice.bsky.social" },
    ]);
    await insertChange({ did: ALICE, new_display_name: "Alice 🎃" });
    await insertChange({ did: "did:plc:stranger", new_display_name: "Nope" });

    const changes = await getChangesForUser(BOB);

    expect(changes.map((c) => c.did)).toEqual([ALICE]);

    await addIgnoredUser(ALICE);
    expect(await getChangesForUser(BOB)).toEqual([]);
  });
});
