import { decodeFirst } from "@atcute/cbor";
import { Secp256k1PrivateKeyExportable } from "@atcute/crypto";
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { resetDB } from "../../test/db-helpers.js";
import { pool } from "../db.js";
import { createLabel, signLabel } from "./labels.js";
import { getLabelsAfter, getLatestSeq, insertLabel } from "./store.js";
import { serveLabelSubscription } from "./subscription.js";

const LABELER = "did:plc:labeler";

// The XRPC route only needs to know the labeler is enabled
vi.mock("./index.js", () => ({ labeler: { did: "did:plc:labeler" } }));

let key: Secp256k1PrivateKeyExportable;
let server: Server;
let port: number;
const events = new EventEmitter();

beforeAll(async () => {
  key = await Secp256k1PrivateKeyExportable.createKeypair();
  const wss = new WebSocketServer({ noServer: true });
  server = createServer();
  server.on("upgrade", (req, socket, head) => {
    const raw = new URL(req.url!, "http://x").searchParams.get("cursor");
    wss.handleUpgrade(req, socket, head, (ws) => {
      void serveLabelSubscription(ws, raw === null ? undefined : Number(raw), {
        events,
        getLabelsAfter,
        getLatestSeq,
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
beforeEach(resetDB);
afterAll(async () => {
  server.close();
  await pool.end();
});

// Store a label and announce it like the labeler service does
async function emit(uri: string, val = "spooky-name") {
  const event = await insertLabel(
    await signLabel(createLabel({ src: LABELER, uri, val }), key),
  );
  events.emit("label", event);
  return event;
}

// Connect and collect decoded frames until `count` arrived
function subscribe(cursor?: number) {
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/` +
      (cursor === undefined ? "" : `?cursor=${cursor}`),
  );
  const frames: Array<{ header: any; body: any }> = [];
  ws.on("message", (data: Buffer) => {
    const [header, rest] = decodeFirst(new Uint8Array(data));
    const [body] = decodeFirst(rest);
    frames.push({ header, body });
  });
  const opened = new Promise<void>((r) => ws.on("open", () => r()));
  return { ws, frames, opened };
}

describe("subscribeLabels", () => {
  it("replays from the cursor, then continues live without gaps", async () => {
    await emit("did:plc:a");
    await emit("did:plc:b");
    await emit("did:plc:c");

    const sub = subscribe(1);
    await sub.opened;
    await vi.waitFor(() => expect(sub.frames).toHaveLength(2));
    await emit("did:plc:d");
    await vi.waitFor(() => expect(sub.frames).toHaveLength(3));
    sub.ws.close();

    expect(sub.frames.map((f) => f.body.seq)).toEqual([2, 3, 4]);
    expect(sub.frames[0].header).toEqual({ op: 1, t: "#labels" });
    expect(sub.frames[0].body.labels[0]).toMatchObject({
      src: LABELER,
      uri: "did:plc:b",
      val: "spooky-name",
    });
  });

  it("streams only new labels without a cursor", async () => {
    await emit("did:plc:old");

    const sub = subscribe();
    await sub.opened;
    await emit("did:plc:new");
    await vi.waitFor(() => expect(sub.frames).toHaveLength(1));
    sub.ws.close();

    expect(sub.frames[0].body.labels[0].uri).toBe("did:plc:new");
  });

  it("rejects a cursor ahead of the stream", async () => {
    await emit("did:plc:a");

    const sub = subscribe(99);
    const closed = new Promise<void>((r) => sub.ws.on("close", () => r()));
    await closed;

    expect(sub.frames[0]).toEqual({
      header: { op: -1 },
      body: { error: "FutureCursor", message: "Cursor is ahead of the stream" },
    });
  });
});

describe("GET /xrpc/com.atproto.label.queryLabels", () => {
  it("returns active labels with base64 signatures", async () => {
    const { createApp } = await import("../app.js");
    await emit("did:plc:a");
    await emit("did:plc:b", "spooky-avatar");

    const res = await request(createApp())
      .get("/xrpc/com.atproto.label.queryLabels")
      .query({ uriPatterns: "did:plc:a" })
      .expect(200);

    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.body.labels).toEqual([
      expect.objectContaining({
        uri: "did:plc:a",
        val: "spooky-name",
        sig: { $bytes: expect.any(String) },
      }),
    ]);
  });

  it("requires uriPatterns", async () => {
    const { createApp } = await import("../app.js");
    await request(createApp())
      .get("/xrpc/com.atproto.label.queryLabels")
      .expect(400);
  });
});
