import { describe, expect, it, vi } from "vitest";
import { createOptInStream, linkAuthor } from "./optin-stream.js";

const LABELER = "did:plc:labeler";

const link = (author: string, operation = "create") =>
  JSON.stringify({
    kind: "link",
    origin: "live",
    link: {
      operation,
      source: "app.bsky.graph.follow:subject",
      source_record: `at://${author}/app.bsky.graph.follow/3abc`,
      source_rev: "3abc",
      subject: LABELER,
    },
  });

// Records the sockets the stream opens so tests can drive them
function fakeSockets() {
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    onclose?: () => void;
    closed = false;
    constructor(public url: string) {
      sockets.push(this);
    }
    close() {
      this.closed = true;
      this.onclose?.();
    }
  }
  return { sockets, WebSocket: FakeSocket as unknown as typeof WebSocket };
}

describe("linkAuthor", () => {
  it("reads the author of created links only", () => {
    expect(linkAuthor(link("did:plc:alice"))).toBe("did:plc:alice");
    expect(linkAuthor(link("did:plc:alice", "delete"))).toBeNull();
    expect(linkAuthor("not json")).toBeNull();
  });
});

describe("opt-in stream", () => {
  it("subscribes to links targeting the labeler and reports their authors", () => {
    const { sockets, WebSocket } = fakeSockets();
    const onLink = vi.fn();
    const stream = createOptInStream({
      url: "wss://spacedust.test/",
      labelerDid: LABELER,
      onLink,
      WebSocket,
    });

    stream.start();
    const url = new URL(sockets[0].url);
    expect(url.origin + url.pathname).toBe("wss://spacedust.test/subscribe");
    expect(url.searchParams.getAll("wantedSources")).toEqual([
      "app.bsky.graph.follow:subject",
      "app.bsky.feed.like:subject.uri",
    ]);
    expect(url.searchParams.get("wantedSubjectDids")).toBe(LABELER);

    sockets[0].onmessage?.({ data: link("did:plc:alice") });
    sockets[0].onmessage?.({ data: link(LABELER) });
    expect(onLink.mock.calls).toEqual([["did:plc:alice"]]);
    stream.stop();
  });

  it("reconnects after a disconnect until stopped", async () => {
    const { sockets, WebSocket } = fakeSockets();
    const stream = createOptInStream({
      url: "wss://spacedust.test",
      labelerDid: LABELER,
      onLink: () => {},
      WebSocket,
      retryDelays: [1],
      log: { log: () => {}, warn: () => {} },
    });

    stream.start();
    sockets[0].onclose?.();
    await vi.waitFor(() => expect(sockets).toHaveLength(2));

    stream.stop();
    expect(sockets[1].closed).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sockets).toHaveLength(2);
  });
});
