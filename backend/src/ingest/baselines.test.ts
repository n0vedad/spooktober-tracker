import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetDB } from "../../test/db-helpers.js";
import { saveBubble, saveFollowList } from "../bubble/store.js";
import {
  findMissingBaselines,
  getSnapshot,
  listWatchedAccounts,
  purgeAccount,
  saveSnapshot,
} from "../db.js";
import { saveOptIn } from "../labeler/store.js";
import { createBaselineSweeper } from "./baselines.js";
import { fetchProfiles, seedFromViews, type ProfileViewLike } from "./seed.js";

const ALICE = "did:plc:alice";
const BOB = "did:plc:bob";
const CAROL = "did:plc:carol";

const quiet = { log: () => {}, warn: () => {} };
const view = (did: string): ProfileViewLike => ({
  did,
  handle: `${did.slice(8)}.test`,
  displayName: did.slice(8),
});

beforeEach(resetDB);

describe("baseline sweeper", () => {
  it("loads only the accounts without a baseline", async () => {
    await saveSnapshot({
      did: ALICE,
      handle: "alice.test",
      display_name: "Alice",
      avatar_cid: null,
      profile_seen: true,
    });
    const fetch = vi.fn(async (dids: readonly string[]) => dids.map(view));
    const sweeper = createBaselineSweeper({
      findMissing: findMissingBaselines,
      fetchProfiles: fetch,
      seed: seedFromViews,
      log: quiet,
    });

    const loaded = await sweeper.ensure([ALICE, BOB, CAROL, BOB], "test");

    expect(loaded).toBe(2);
    expect(fetch).toHaveBeenCalledWith([BOB, CAROL]);
    expect((await getSnapshot(BOB))?.display_name).toBe("bob");
    expect((await getSnapshot(ALICE))?.display_name).toBe("Alice");
    expect(await findMissingBaselines([ALICE, BOB, CAROL])).toEqual([]);
  });

  it("completes handle-only snapshots", async () => {
    await saveSnapshot({
      did: BOB,
      handle: "bob.test",
      display_name: null,
      avatar_cid: null,
      profile_seen: false,
    });
    const sweeper = createBaselineSweeper({
      findMissing: findMissingBaselines,
      fetchProfiles: async (dids) => dids.map(view),
      seed: seedFromViews,
      log: quiet,
    });

    await sweeper.ensure([BOB], "test");

    expect(await getSnapshot(BOB)).toMatchObject({
      handle: "bob.test",
      display_name: "bob",
      profile_seen: true,
    });
  });

  it("splits into batches of 25 and keeps going when one fails", async () => {
    const dids = Array.from({ length: 60 }, (_, i) => `did:plc:user${i}`);
    const fetch = vi
      .fn(async (batch: readonly string[]) => batch.map(view))
      .mockRejectedValueOnce(new Error("getProfiles failed: 502"));
    const sweeper = createBaselineSweeper({
      findMissing: findMissingBaselines,
      fetchProfiles: fetch,
      seed: seedFromViews,
      concurrency: 1,
      log: quiet,
    });

    const loaded = await sweeper.ensure(dids, "test");

    expect(fetch.mock.calls.map(([batch]) => batch.length)).toEqual([
      25, 25, 10,
    ]);
    expect(loaded).toBe(35);
    // The failed batch stays missing and is picked up by the next sweep
    expect(await findMissingBaselines(dids)).toHaveLength(25);
  });

  it("runs overlapping sweeps one after another", async () => {
    const fetch = vi.fn(async (dids: readonly string[]) => dids.map(view));
    const sweeper = createBaselineSweeper({
      findMissing: findMissingBaselines,
      fetchProfiles: fetch,
      seed: seedFromViews,
      log: quiet,
    });

    const [first, second] = await Promise.all([
      sweeper.ensure([BOB, CAROL], "first"),
      sweeper.ensure([BOB, CAROL], "second"),
    ]);

    expect([first, second]).toEqual([2, 0]);
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe("listWatchedAccounts", () => {
  it("collects bubble owners, their follows and members, and opt-ins", async () => {
    await saveFollowList(ALICE, [BOB]);
    await saveFollowList(BOB, ["did:plc:unrelated"]);
    await saveBubble(ALICE, 1, [
      { did: BOB, commonCount: 0 },
      { did: CAROL, commonCount: 1 },
    ]);
    await saveOptIn("did:plc:fan", "like");

    expect((await listWatchedAccounts()).sort()).toEqual(
      [ALICE, BOB, CAROL, "did:plc:fan"].sort(),
    );
  });

  it("leaves out accounts that are not tracked", async () => {
    await saveOptIn("did:plc:fan", "like");
    await saveOptIn("did:plc:gone", "like");
    await purgeAccount("did:plc:gone");

    expect(await listWatchedAccounts()).toEqual(["did:plc:fan"]);
    expect(await findMissingBaselines(["did:plc:gone"])).toEqual([]);
  });
});

describe("fetchProfiles", () => {
  it("waits and retries when rate-limited", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("slow down", {
          status: 429,
          headers: { "retry-after": "2" },
        }),
      )
      .mockResolvedValueOnce(Response.json({ profiles: [view(BOB)] }));
    const sleep = vi.fn(async () => {});

    const views = await fetchProfiles([BOB], fetchFn, sleep);

    expect(sleep).toHaveBeenCalledWith(2000);
    expect(views).toEqual([view(BOB)]);
  });
});
