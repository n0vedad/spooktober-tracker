import { Secp256k1PrivateKeyExportable } from "@atcute/crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { resetDB } from "../../test/db-helpers.js";
import {
  getChangesSince,
  isIgnored,
  pool,
  purgeAccount,
  recordChange,
} from "../db.js";
import { verifyLabel } from "./labels.js";
import { createOptInSync } from "./optins.js";
import { LABELER_DESCRIPTION, labelsForChange, seasonOf } from "./policy.js";
import { createLabeler } from "./service.js";
import {
  getLabelsAfter,
  getLatestSeq,
  getOptIns,
  insertLabel,
  isOptedIn,
  queryActiveLabels,
  removeOptIn,
  saveOptIn,
} from "./store.js";

const LABELER = "did:plc:labeler";
const ALICE = "did:plc:alice";
const BOB = "did:plc:bob";
const OCT = new Date("2026-10-15T12:00:00Z");
const quiet = { log: () => {}, warn: () => {}, error: () => {} };

let key: Secp256k1PrivateKeyExportable;
beforeAll(async () => {
  key = await Secp256k1PrivateKeyExportable.createKeypair();
});
beforeEach(resetDB);
afterAll(() => pool.end());

function makeLabeler(now = OCT) {
  return createLabeler({
    did: LABELER,
    key,
    insertLabel,
    queryActiveLabels,
    isOptedIn,
    getChangesSince,
    now: () => now,
  });
}

async function nameChange(did: string, seq: number, at = OCT) {
  return (await recordChange({
    did,
    handle: null,
    old_display_name: "Before",
    new_display_name: "👻",
    changed_at: at,
    source_seq: seq,
  }))!;
}

const activeVals = async (did: string) =>
  (await queryActiveLabels({ uriPatterns: [did], limit: 50 })).events
    .map((e) => e.label.val)
    .sort();

describe("policy", () => {
  it("only treats October as the season", () => {
    expect(seasonOf(OCT)).toEqual({
      start: new Date("2026-10-01T00:00:00Z"),
      end: new Date("2026-11-01T00:00:00Z"),
    });
    expect(seasonOf(new Date("2026-11-01T00:00:00Z"))).toBeNull();
    expect(seasonOf(new Date("2026-09-30T23:59:59Z"))).toBeNull();
  });

  it("keeps the labeler description within Bluesky's 256 graphemes", () => {
    const graphemes = [
      ...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(
        LABELER_DESCRIPTION,
      ),
    ];
    expect(graphemes.length).toBeLessThanOrEqual(256);
    expect(LABELER_DESCRIPTION).toMatch(/Like or follow/);
  });

  it("derives label values from the changed fields", () => {
    expect(
      labelsForChange({
        old_display_name: "A",
        new_display_name: "B",
        old_avatar: "x",
        new_avatar: "y",
        old_handle: null,
        new_handle: null,
      }),
    ).toEqual(["spooky-name", "spooky-avatar"]);
    expect(
      labelsForChange({
        old_display_name: null,
        new_display_name: null,
        old_avatar: null,
        new_avatar: null,
        old_handle: "a.test",
        new_handle: "b.test",
      }),
    ).toEqual(["spooky-handle"]);
  });
});

describe("labeler", () => {
  it("labels changes of opted-in accounts only, with expiry at season end", async () => {
    const labeler = makeLabeler();
    await saveOptIn(ALICE, "like");

    await labeler.onChange(await nameChange(ALICE, 1));
    await labeler.onChange(await nameChange(BOB, 2));

    const [event] = await getLabelsAfter(0, 10);
    expect(event.label).toMatchObject({
      src: LABELER,
      uri: ALICE,
      val: "spooky-name",
      exp: "2026-11-01T00:00:00.000Z",
    });
    expect(
      await verifyLabel(event.label, await key.exportPublicKey("did")),
    ).toBe(true);
    expect(await activeVals(BOB)).toEqual([]);
  });

  it("does not label outside October", async () => {
    const labeler = makeLabeler();
    await saveOptIn(ALICE, "like");

    await labeler.onChange(
      await nameChange(ALICE, 1, new Date("2026-11-03T12:00:00Z")),
    );

    expect(await getLatestSeq()).toBe(0);
  });

  it("does not re-emit a label that is already active", async () => {
    const labeler = makeLabeler();
    await saveOptIn(ALICE, "like");

    await labeler.onChange(await nameChange(ALICE, 1));
    await labeler.onChange(await nameChange(ALICE, 2));

    expect(await getLatestSeq()).toBe(1);
  });

  it("labels earlier changes of the season when an account opts in", async () => {
    const labeler = makeLabeler();
    await nameChange(ALICE, 1);
    // Last season's change does not count
    await nameChange(ALICE, 2, new Date("2025-10-10T12:00:00Z"));

    await saveOptIn(ALICE, "follow");
    const emitted = await labeler.onOptIn(ALICE);

    expect(emitted.map((e) => e.label.val)).toEqual(["spooky-name"]);
  });

  it("retracts all labels when an account opts out", async () => {
    const labeler = makeLabeler();
    await saveOptIn(ALICE, "like");
    await labeler.onChange(await nameChange(ALICE, 1));

    const emitted = await labeler.onOptOut(ALICE);

    expect(emitted.map((e) => [e.label.val, e.label.neg])).toEqual([
      ["spooky-name", true],
    ]);
    expect(await activeVals(ALICE)).toEqual([]);
  });

  it("notifies live subscribers", async () => {
    const labeler = makeLabeler();
    const listener = vi.fn();
    labeler.events.on("label", listener);
    await saveOptIn(ALICE, "like");

    await labeler.onChange(await nameChange(ALICE, 1));

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        seq: 1,
        label: expect.objectContaining({ uri: ALICE }),
      }),
    );
  });
});

describe("queryActiveLabels", () => {
  it("supports prefix patterns and hides expired labels", async () => {
    const labeler = makeLabeler();
    await saveOptIn(ALICE, "like");
    await labeler.onChange(await nameChange(ALICE, 1));
    // An already expired label (from a past season)
    await insertLabel({
      ...(await getLabelsAfter(0, 1))[0].label,
      uri: "did:plc:alicia",
      exp: "2020-01-01T00:00:00.000Z",
    });

    const result = await queryActiveLabels({
      uriPatterns: ["did:plc:ali*"],
      limit: 50,
    });

    expect(result.events.map((e) => e.label.uri)).toEqual([ALICE]);
  });
});

describe("opt-in sync", () => {
  function makeSync(followers: string[], likers: string[]) {
    const labeler = {
      did: LABELER,
      onOptIn: vi.fn(async () => []),
      onOptOut: vi.fn(async () => []),
    };
    const onNewOptIn = vi.fn();
    const sync = createOptInSync({
      labeler,
      fetchFollowers: async () => followers,
      fetchLikers: async () => likers,
      getOptIns,
      saveOptIn,
      removeOptIn,
      isIgnored,
      onNewOptIn,
      log: quiet,
    });
    return { sync, labeler, onNewOptIn };
  }

  it("records likes and follows as opt-ins and reacts to new ones", async () => {
    const { sync, labeler, onNewOptIn } = makeSync(
      [ALICE, LABELER],
      [ALICE, BOB],
    );

    await sync.sync();

    expect(await getOptIns()).toEqual(
      new Map([
        [ALICE, "like+follow"],
        [BOB, "like"],
      ]),
    );
    expect(labeler.onOptIn).toHaveBeenCalledTimes(2);
    expect(onNewOptIn).toHaveBeenCalledWith(BOB);
  });

  it("retracts labels of accounts that withdrew", async () => {
    await saveOptIn(ALICE, "like");
    await saveOptIn(BOB, "like");
    const { sync, labeler } = makeSync([], [BOB]);

    await sync.sync();

    expect(labeler.onOptOut).toHaveBeenCalledWith(ALICE);
    expect([...(await getOptIns()).keys()]).toEqual([BOB]);
  });

  it("ignores likes of accounts that deleted their data", async () => {
    await purgeAccount(ALICE);
    const { sync, labeler, onNewOptIn } = makeSync([], [ALICE, BOB]);

    await sync.sync();

    expect([...(await getOptIns()).keys()]).toEqual([BOB]);
    expect(labeler.onOptIn).toHaveBeenCalledOnce();
    expect(onNewOptIn).not.toHaveBeenCalledWith(ALICE);
  });

  it("reports every completed pass", async () => {
    const onSynced = vi.fn();
    const sync = createOptInSync({
      labeler: {
        did: LABELER,
        onOptIn: vi.fn(async () => []),
        onOptOut: vi.fn(async () => []),
      },
      fetchFollowers: async () => [ALICE],
      fetchLikers: async () => [],
      getOptIns,
      saveOptIn,
      removeOptIn,
      onSynced,
      log: quiet,
    });

    await sync.sync();

    expect(onSynced).toHaveBeenCalledOnce();
  });

  it("never mass-retracts on an empty API answer", async () => {
    for (let i = 0; i < 6; i++) await saveOptIn(`did:plc:u${i}`, "like");
    const { sync, labeler } = makeSync([], []);

    await sync.sync();

    expect(labeler.onOptOut).not.toHaveBeenCalled();
    expect((await getOptIns()).size).toBe(6);
  });

  it("keeps the previous state when fetching fails", async () => {
    await saveOptIn(ALICE, "like");
    const sync = createOptInSync({
      labeler: { did: LABELER, onOptIn: vi.fn(), onOptOut: vi.fn() },
      fetchFollowers: async () => {
        throw new Error("AppView down");
      },
      fetchLikers: async () => [],
      getOptIns,
      saveOptIn,
      removeOptIn,
      log: quiet,
    });

    await expect(sync.sync()).rejects.toThrow("AppView down");
    expect(await isOptedIn(ALICE)).toBe(true);
  });
});
