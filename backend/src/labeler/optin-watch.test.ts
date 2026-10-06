import { describe, expect, it, vi } from "vitest";
import type { LiveEvent } from "../ingest/ingester.js";
import {
  createOptInWatch,
  FOLLOW_COLLECTION,
  LIKE_COLLECTION,
} from "./optin-watch.js";

const quiet = { log: () => {}, warn: () => {} };

const commit = (did: string, collection: string, operation: string) =>
  ({ kind: "commit", did, commit: { collection, operation } }) as LiveEvent;

// A source that emits the given events, then stays open until aborted
function source(events: LiveEvent[]) {
  return vi.fn(async function* (_dids: string[], signal: AbortSignal) {
    yield* events;
    await new Promise((resolve) => signal.addEventListener("abort", resolve));
  });
}

describe("opt-in watch", () => {
  it("reports deleted likes and follows of opted-in accounts", async () => {
    const open = source([
      commit("did:plc:alice", LIKE_COLLECTION, "delete"),
      commit("did:plc:alice", LIKE_COLLECTION, "create"),
      commit("did:plc:bob", FOLLOW_COLLECTION, "delete"),
    ]);
    const onWithdrawal = vi.fn();
    const watch = createOptInWatch({
      open,
      getOptIns: async () =>
        new Map([
          ["did:plc:bob", "follow"],
          ["did:plc:alice", "like"],
        ]),
      onWithdrawal,
      log: quiet,
    });

    await watch.update();
    await vi.waitFor(() => expect(onWithdrawal).toHaveBeenCalledTimes(2));
    watch.stop();

    expect(open).toHaveBeenCalledWith(
      ["did:plc:alice", "did:plc:bob"],
      expect.any(AbortSignal),
    );
    expect(onWithdrawal.mock.calls).toEqual([
      ["did:plc:alice"],
      ["did:plc:bob"],
    ]);
  });

  it("reconnects only when the opt-ins change", async () => {
    const open = source([]);
    let optIns = new Map([["did:plc:alice", "like"]]);
    const watch = createOptInWatch({
      open,
      getOptIns: async () => optIns,
      onWithdrawal: () => {},
      log: quiet,
    });

    await watch.update();
    await watch.update();
    expect(open).toHaveBeenCalledOnce();

    optIns = new Map([
      ["did:plc:alice", "like"],
      ["did:plc:bob", "follow"],
    ]);
    await watch.update();
    expect(open).toHaveBeenCalledTimes(2);
    expect(open.mock.calls[0][1].aborted).toBe(true);

    // Nobody left: no connection at all
    optIns = new Map();
    await watch.update();
    expect(open).toHaveBeenCalledTimes(2);
    expect(open.mock.calls[1][1].aborted).toBe(true);
  });

  it("reconnects after the stream fails", async () => {
    let calls = 0;
    const open = vi.fn(async function* (_dids: string[], signal: AbortSignal) {
      if (++calls === 1) throw new Error("socket closed");
      yield commit("did:plc:alice", FOLLOW_COLLECTION, "delete");
      await new Promise((resolve) => signal.addEventListener("abort", resolve));
    });
    const onWithdrawal = vi.fn();
    const watch = createOptInWatch({
      open,
      getOptIns: async () => new Map([["did:plc:alice", "follow"]]),
      onWithdrawal,
      retryMs: 5,
      log: quiet,
    });

    await watch.update();
    await vi.waitFor(() => expect(onWithdrawal).toHaveBeenCalled());
    watch.stop();
    expect(open).toHaveBeenCalledTimes(2);
  });
});
