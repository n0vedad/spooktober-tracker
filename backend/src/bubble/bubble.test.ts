import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDB } from "../../test/db-helpers.js";
import { pool, recordChange } from "../db.js";
import { fetchFollowList } from "./follow-lists.js";
import { createBubbleService } from "./service.js";
import {
  getBubbleInfo,
  getCachedFollowLists,
  getChangesInScope,
  saveBubble,
  saveFollowList,
} from "./store.js";

const ME = "did:plc:me";
const A = "did:plc:a";
const B = "did:plc:b";
const X = "did:plc:x";
const Y = "did:plc:y";
const quiet = { log: () => {}, warn: () => {}, error: () => {} };

beforeEach(resetDB);
afterAll(() => pool.end());

// The follow graph used by the fake API: I follow A and B
const GRAPH: Record<string, string[]> = {
  [ME]: [A, B],
  [A]: [X, Y, ME],
  [B]: [X],
};

function makeService(graph = GRAPH) {
  const fetch = vi.fn(async (did: string) => graph[did] ?? []);
  const service = createBubbleService({
    fetchFollowList: fetch,
    getCachedFollowLists,
    saveFollowList,
    getBubbleInfo,
    saveBubble,
    log: quiet,
  });
  return { service, fetch };
}

describe("bubble service", () => {
  it("computes and stores the bubble in the background", async () => {
    const { service } = makeService();

    const started = await service.ensure(ME);
    expect(started.state).toBe("computing");
    await service.settle(ME);

    expect(await service.status(ME)).toMatchObject({
      state: "ready",
      followsCount: 2,
    });
    const { rows } = await pool.query(
      "SELECT did, common_count FROM bubble_members WHERE user_did = $1 ORDER BY did",
      [ME],
    );
    expect(rows).toEqual([
      { did: X, common_count: 2 },
      { did: Y, common_count: 1 },
    ]);
  });

  it("reuses cached follow lists across users and runs", async () => {
    const { service, fetch } = makeService();
    await service.ensure(ME);
    await service.settle(ME);
    expect(fetch).toHaveBeenCalledTimes(3);

    // A second user who also follows A only needs their own list fetched
    const other = makeService({ ...GRAPH, "did:plc:other": [A] });
    await other.service.ensure("did:plc:other");
    await other.service.settle("did:plc:other");
    expect(other.fetch).toHaveBeenCalledTimes(1);
    expect(other.fetch).toHaveBeenCalledWith("did:plc:other");
  });

  it("does not recompute a fresh bubble unless forced", async () => {
    const { service, fetch } = makeService();
    await service.ensure(ME);
    await service.settle(ME);

    expect((await service.ensure(ME)).state).toBe("ready");
    await pool.query("DELETE FROM follow_lists");
    expect((await service.ensure(ME, true)).state).toBe("computing");
    await service.settle(ME);
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  it("skips follow lists that cannot be loaded", async () => {
    const fetch = vi.fn(async (did: string) => {
      if (did === B) throw new Error("timeout");
      return GRAPH[did] ?? [];
    });
    const service = createBubbleService({
      fetchFollowList: fetch,
      getCachedFollowLists,
      saveFollowList,
      getBubbleInfo,
      saveBubble,
      log: quiet,
    });

    await service.ensure(ME);
    await service.settle(ME);

    expect(await service.status(ME)).toMatchObject({ state: "ready" });
    // B's list is not cached, so it will be retried next time
    expect((await getCachedFollowLists([A, B], 60_000)).has(B)).toBe(false);
  });

  it("reports a failure when the user's own follows cannot be loaded", async () => {
    const service = createBubbleService({
      fetchFollowList: async () => {
        throw new Error("down");
      },
      getCachedFollowLists,
      saveFollowList,
      getBubbleInfo,
      saveBubble,
      log: quiet,
    });

    await service.ensure(ME);
    await service.settle(ME);

    expect(await service.status(ME)).toEqual({
      state: "failed",
      error: "Could not load your network",
    });
  });
});

describe("getChangesInScope", () => {
  const change = (did: string, seq: number) =>
    recordChange({
      did,
      handle: null,
      old_display_name: "Before",
      new_display_name: `After ${seq}`,
      changed_at: new Date("2026-10-05T12:00:00Z"),
      source_seq: seq,
    });

  beforeEach(async () => {
    await saveBubble(ME, 2, [
      { did: X, commonCount: 2, score: 0.9 },
      { did: Y, commonCount: 1, score: 0.4 },
    ]);
    await change(A, 1);
    await change(X, 2);
    await change(Y, 3);
    await change("did:plc:stranger", 4);
  });

  it("limits the scope by common follows", async () => {
    const dids = async (minCommon: number | null) =>
      (
        await getChangesInScope(ME, [A, B], minCommon, {
          limit: 50,
          sort: "recent",
        })
      ).map((c) => c.did);

    expect(await dids(null)).toEqual([A]);
    expect(await dids(2)).toEqual([X, A]);
    expect(await dids(1)).toEqual([Y, X, A]);
  });

  it("sorts direct follows first, then by closeness", async () => {
    const rows = await getChangesInScope(ME, [A, B], 1, {
      limit: 50,
      sort: "closeness",
    });

    expect(rows.map((r) => [r.did, r.common_count])).toEqual([
      [A, null],
      [X, 2],
      [Y, 1],
    ]);
  });
});

describe("fetchFollowList", () => {
  const page = (dids: string[], cursor?: string) =>
    Response.json({ follows: dids.map((did) => ({ did })), cursor });

  it("follows the pagination cursor", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(page([X], "c1"))
      .mockResolvedValueOnce(page([Y]));

    expect(await fetchFollowList(A, { fetchFn })).toEqual([X, Y]);
    expect(fetchFn.mock.calls[1][0]).toContain("cursor=c1");
  });

  it("waits and retries when rate limited", async () => {
    const sleep = vi.fn(async () => {});
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("", { status: 429, headers: { "retry-after": "2" } }),
      )
      .mockResolvedValueOnce(page([X]));

    expect(await fetchFollowList(A, { fetchFn, sleep })).toEqual([X]);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("treats unknown accounts as following nobody", async () => {
    const fetchFn = vi.fn(async () => new Response("", { status: 400 }));
    expect(await fetchFollowList(A, { fetchFn })).toEqual([]);
  });

  it("throws on persistent server errors", async () => {
    const fetchFn = vi.fn(async () => new Response("", { status: 503 }));
    await expect(
      fetchFollowList(A, { fetchFn, sleep: async () => {} }),
    ).rejects.toThrow("503");
  });
});
