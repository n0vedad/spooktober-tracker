import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDB } from "../../test/db-helpers.js";
import {
  countRecentChanges,
  flagNoisy,
  getChangeHistory,
  getSnapshot,
  isIgnored,
  isNoisy,
  pool,
  recordChange,
  saveSnapshot,
} from "../db.js";
import { Ingester, type EventSource, type LiveEvent } from "./ingester.js";
import { createProfileTracker } from "./profile-tracker.js";

const DID = "did:plc:alice";

beforeEach(resetDB);
afterAll(() => pool.end());

const tracker = () =>
  createProfileTracker({
    getSnapshot,
    saveSnapshot,
    recordChange,
    isIgnored,
    isNoisy,
    flagNoisy,
    countRecentChanges,
    lookupPreviousHandle: async () => null,
  });

// Recorded-shape events as delivered by Jetstream.live({ raw: true })
const profileEvent = (seq: number, displayName: string): LiveEvent =>
  ({
    did: DID,
    seq,
    time: "2026-10-05T12:00:00.000Z",
    kind: "commit",
    commit: {
      operation: "update",
      collection: "app.bsky.actor.profile",
      rkey: "self",
      rev: "3mx5njdu7eq2z",
      cid: "bafyreihlisgda7noirmd4b4kbkrnqxbv735g76eszzvneefcbwdi7rv25a",
      record: {
        $type: "app.bsky.actor.profile",
        displayName,
        createdAt: "2024-01-01T00:00:00.000Z",
      },
    },
  }) as LiveEvent;

// Jetstream v2 identity events usually carry no handle
const identityEvent = (seq: number, handle?: string): LiveEvent =>
  ({
    did: DID,
    seq,
    time: "2026-10-05T12:00:00.000Z",
    kind: "identity",
    identity: { did: DID, ...(handle && { handle }) },
  }) as LiveEvent;

const postEvent = (seq: number): LiveEvent =>
  ({
    did: DID,
    seq,
    time: "2026-10-05T12:00:00.000Z",
    kind: "commit",
    commit: {
      operation: "create",
      collection: "app.bsky.feed.post",
      rkey: "3abc",
      rev: "3abc",
      cid: "bafypost",
      record: { $type: "app.bsky.feed.post", text: "hi" },
    },
  }) as LiveEvent;

/**
 * Fake source: yields the events after the requested cursor, then blocks until
 * aborted (like a live stream with no new traffic). Records each cursor it was
 * opened with.
 */
function fakeSource(events: LiveEvent[], failAtSeq?: number) {
  const opened: Array<number | undefined> = [];
  let failed = false;
  const source: EventSource = async function* ({ cursor, signal }) {
    opened.push(cursor);
    for (const event of events) {
      if (cursor !== undefined && event.seq <= cursor) continue;
      if (event.seq === failAtSeq && !failed) {
        failed = true;
        throw new Error("connection reset");
      }
      yield event;
    }
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
  };
  return { source, opened };
}

function makeIngester(
  source: EventSource,
  initialCursor?: number,
  resolveHandle: (did: string) => Promise<string | null> = async () =>
    "resolved.test",
) {
  const saved: number[] = [];
  const ingester = new Ingester({
    source,
    tracker: tracker(),
    resolveHandle,
    loadCursor: async () => initialCursor,
    saveCursor: async (seq) => {
      saved.push(seq);
    },
    cursorSaveIntervalMs: 0,
    retryDelayMs: () => 0,
    log: { log: () => {}, error: () => {} },
  });
  return { ingester, saved };
}

describe("Ingester", () => {
  it("detects changes from a stream and persists the cursor", async () => {
    const { source } = fakeSource([
      profileEvent(10, "Alice"),
      postEvent(11),
      profileEvent(12, "Alice 🎃"),
      identityEvent(13, "alice.test"),
    ]);
    const { ingester, saved } = makeIngester(source);

    await ingester.start();
    await vi.waitFor(() => expect(ingester.status().lastSeq).toBe(13));
    await ingester.stop();

    const history = await getChangeHistory(DID);
    expect(history).toHaveLength(1);
    expect(history[0].new_display_name).toBe("Alice 🎃");
    expect((await getSnapshot(DID))?.handle).toBe("alice.test");
    expect(saved.at(-1)).toBe(13);
    expect(ingester.status()).toMatchObject({
      running: false,
      eventsProcessed: 4,
      changesDetected: 1,
    });
  });

  it("resumes from the persisted cursor", async () => {
    const { source, opened } = fakeSource([
      profileEvent(10, "Alice"),
      profileEvent(12, "Ghost"),
    ]);
    const { ingester } = makeIngester(source, 10);

    await ingester.start();
    await vi.waitFor(() => expect(ingester.status().lastSeq).toBe(12));
    await ingester.stop();

    expect(opened).toEqual([10]);
    // Event 10 was skipped, so "Ghost" is only the baseline
    expect(await getChangeHistory(DID)).toEqual([]);
  });

  it("restarts after a failure from the last processed event", async () => {
    const { source, opened } = fakeSource(
      [profileEvent(10, "Alice"), profileEvent(11, "Ghost")],
      11,
    );
    const { ingester } = makeIngester(source);

    await ingester.start();
    await vi.waitFor(() => expect(ingester.status().lastSeq).toBe(11));
    await ingester.stop();

    expect(opened).toEqual([undefined, 10]);
    expect(await getChangeHistory(DID)).toHaveLength(1);
  });

  it("resolves the handle for identity events that carry none", async () => {
    const { source } = fakeSource([identityEvent(10)]);
    const resolveHandle = vi.fn(async () => "alice.test");
    const { ingester } = makeIngester(source, undefined, resolveHandle);

    await ingester.start();
    await vi.waitFor(() => expect(ingester.status().lastSeq).toBe(10));
    await ingester.stop();

    expect(resolveHandle).toHaveBeenCalledWith(DID);
    expect((await getSnapshot(DID))?.handle).toBe("alice.test");
  });

  it("skips an identity event when the handle lookup fails", async () => {
    const { source } = fakeSource([
      identityEvent(10),
      profileEvent(11, "Alice"),
    ]);
    const { ingester } = makeIngester(source, undefined, async () => {
      throw new Error("plc.directory down");
    });

    await ingester.start();
    await vi.waitFor(() => expect(ingester.status().lastSeq).toBe(11));
    await ingester.stop();

    expect(await getSnapshot(DID)).toMatchObject({
      handle: null,
      display_name: "Alice",
    });
  });

  it("accepts an explicit start cursor overriding the stored one", async () => {
    const { source, opened } = fakeSource([]);
    const { ingester } = makeIngester(source, 10);

    await ingester.start(1_790_000_000_000_000);
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    await ingester.stop();

    expect(opened).toEqual([1_790_000_000_000_000]);
  });
});
