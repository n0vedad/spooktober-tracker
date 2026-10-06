import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetDB } from "../test/db-helpers.js";
import {
  addIgnoredUser,
  getChangeHistory,
  getChanges,
  getChangesByDIDs,
  getSnapshot,
  initDB,
  pool,
  purgeAccount,
  recordChange,
  saveSnapshot,
  type NewProfileChange,
} from "./db.js";

const ALICE = "did:plc:alice";
const BOB = "did:plc:bob";
const T0 = new Date("2026-10-05T12:00:00Z");

beforeEach(resetDB);
afterAll(() => pool.end());

const nameChange = (
  did: string,
  seq: number,
  name = "Ghost",
): NewProfileChange => ({
  did,
  handle: null,
  old_display_name: "Before",
  new_display_name: name,
  changed_at: T0,
  source_seq: seq,
});

describe("recordChange", () => {
  it("stores a display-name change as type 'profile'", async () => {
    const row = await recordChange(nameChange(ALICE, 1, "Alice 🎃"));

    expect(row).toMatchObject({
      did: ALICE,
      old_display_name: "Before",
      new_display_name: "Alice 🎃",
      change_type: "profile",
    });
  });

  it("classifies handle-only and combined changes", async () => {
    const handle = await recordChange({
      did: ALICE,
      handle: "spooky-alice.test",
      old_handle: "alice.test",
      new_handle: "spooky-alice.test",
      changed_at: T0,
      source_seq: 1,
    });
    const combined = await recordChange({
      ...nameChange(BOB, 2),
      old_handle: "bob.test",
      new_handle: "boo.test",
    });

    expect(handle?.change_type).toBe("handle");
    expect(combined?.change_type).toBe("combined");
  });

  it("ignores a second insert for the same source event", async () => {
    expect(await recordChange(nameChange(ALICE, 7))).not.toBeNull();
    expect(await recordChange(nameChange(ALICE, 7))).toBeNull();
    expect(await getChangeHistory(ALICE)).toHaveLength(1);
  });
});

describe("change listings", () => {
  it("pages through all changes newest first", async () => {
    for (let seq = 1; seq <= 5; seq++) {
      await recordChange(nameChange(ALICE, seq, `Name ${seq}`));
    }

    const first = await getChanges({ limit: 2 });
    const second = await getChanges({ limit: 2, beforeId: first.at(-1)!.id });

    expect(first.map((c) => c.new_display_name)).toEqual(["Name 5", "Name 4"]);
    expect(second.map((c) => c.new_display_name)).toEqual(["Name 3", "Name 2"]);
  });

  it("filters by DID list and hides ignored accounts", async () => {
    await recordChange(nameChange(ALICE, 1));
    await recordChange(nameChange(BOB, 2));
    await recordChange(nameChange("did:plc:stranger", 3));

    const changes = await getChangesByDIDs([ALICE, BOB], { limit: 10 });
    expect(changes.map((c) => c.did).sort()).toEqual([ALICE, BOB]);

    await addIgnoredUser(ALICE);
    expect(
      (await getChangesByDIDs([ALICE, BOB], { limit: 10 })).map((c) => c.did),
    ).toEqual([BOB]);
    expect(await getChangeHistory(ALICE)).toEqual([]);
  });

  it("returns nothing for an empty DID list", async () => {
    await recordChange(nameChange(ALICE, 1));
    expect(await getChangesByDIDs([], { limit: 10 })).toEqual([]);
  });
});

describe("initDB", () => {
  it("removes the data of the 2025 per-user monitoring", async () => {
    await pool.query(`
      CREATE TABLE monitored_follows (user_did TEXT, follow_did TEXT);
      CREATE TABLE monitoring_backfill_state (user_did TEXT);
      INSERT INTO system_settings (key, value)
        VALUES ('jetstream_stop_cursor', '1'), ('jetstream_v2_cursor', '2');
      INSERT INTO profile_changes (did, new_display_name, changed_at)
        VALUES ('${ALICE}', 'Old 2025 entry', '2025-10-10');
    `);
    await recordChange(nameChange(ALICE, 1));

    await initDB();

    const { rows: tables } = await pool.query(
      "SELECT tablename FROM pg_tables WHERE tablename LIKE 'monitor%'",
    );
    expect(tables).toEqual([]);
    expect(
      (await getChangeHistory(ALICE)).map((c) => c.new_display_name),
    ).toEqual(["Ghost"]);
    const { rows: settings } = await pool.query(
      "SELECT key FROM system_settings ORDER BY key",
    );
    expect(settings.map((r) => r.key)).toEqual(["jetstream_v2_cursor"]);
  });
});

describe("account removal", () => {
  const snapshot = {
    did: ALICE,
    handle: "alice.test",
    display_name: "Alice",
    avatar_cid: null,
    profile_seen: true,
  };

  it("ignoring an account deletes its changes and snapshot", async () => {
    await recordChange(nameChange(ALICE, 1));
    await saveSnapshot(snapshot);

    const result = await addIgnoredUser(ALICE);

    expect(result.deletedChanges).toBe(1);
    expect(await getSnapshot(ALICE)).toBeNull();
  });

  it("purging an account only touches that account", async () => {
    await recordChange(nameChange(ALICE, 1));
    await recordChange(nameChange(BOB, 2));
    await saveSnapshot(snapshot);

    await pool.query(
      "INSERT INTO bubbles (user_did, follows_count) VALUES ($1, 1)",
      [ALICE],
    );
    await pool.query("INSERT INTO bubble_members VALUES ($1, $2, 1)", [
      ALICE,
      BOB,
    ]);

    expect(await purgeAccount(ALICE)).toBe(1);
    expect(await getSnapshot(ALICE)).toBeNull();
    const { rows } = await pool.query(
      "SELECT (SELECT count(*) FROM bubbles)::int + (SELECT count(*) FROM bubble_members)::int AS n",
    );
    expect(rows[0].n).toBe(0);
    expect(await getChangeHistory(BOB)).toHaveLength(1);
  });
});
