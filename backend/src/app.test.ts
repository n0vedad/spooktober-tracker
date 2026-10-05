import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDB } from "../test/db-helpers.js";
import { createApp } from "./app.js";
import { flagNoisy, pool, recordChange } from "./db.js";

const ALICE = "did:plc:alice";
const BOB = "did:plc:bob";
const ADMIN = process.env.ADMIN_DID!;

// Never hit the public Bluesky API from tests: Bob follows Alice
vi.mock("./utils/follows.js", () => ({
  getFollowDIDs: vi.fn(async () => [ALICE]),
  invalidateFollows: vi.fn(),
}));

// No PLC directory lookups from tests
vi.mock("./utils/handle-resolver.js", () => ({
  resolveHandles: vi.fn(async (dids: string[]) =>
    dids.map((did) => ({ did, handle: null })),
  ),
}));

// Keep the real Jetstream client out of route tests
vi.mock("./ingest/index.js", () => ({
  ingester: {
    status: () => ({
      running: true,
      startedAt: new Date(Date.now() - 5000).toISOString(),
      lastSeq: 42,
      lastEventTime: new Date().toISOString(),
      eventsProcessed: 3,
      changesDetected: 1,
      consecutiveFailures: 0,
    }),
    start: vi.fn(),
    stop: vi.fn(),
  },
}));

const app = createApp();

beforeEach(async () => {
  await resetDB();
  await recordChange({
    did: ALICE,
    handle: "alice.test",
    old_display_name: "Alice",
    new_display_name: "Alice 🎃",
    changed_at: new Date("2026-10-05T12:00:00Z"),
    source_seq: 1,
  });
});
afterAll(() => pool.end());

describe("GET /api/changes", () => {
  it("requires a DID header", async () => {
    await request(app).get("/api/changes").expect(401);
  });

  it("returns a page of changes", async () => {
    const res = await request(app)
      .get("/api/changes?limit=10")
      .set("X-User-DID", BOB)
      .expect(200);

    expect(res.body.data.changes).toHaveLength(1);
    expect(res.body.data.changes[0].new_display_name).toBe("Alice 🎃");
  });

  it("rejects an invalid limit", async () => {
    await request(app)
      .get("/api/changes?limit=5000")
      .set("X-User-DID", BOB)
      .expect(400);
  });

  it("no longer accepts unauthenticated change submissions", async () => {
    await request(app)
      .post("/api/changes")
      .send({ did: ALICE, new_display_name: "fake" })
      .expect(404);
  });
});

describe("/api/monitoring", () => {
  it("returns the changes of the user's follows", async () => {
    const res = await request(app)
      .get(`/api/monitoring/changes/${BOB}`)
      .set("X-User-DID", BOB)
      .expect(200);

    expect(res.body.data.changes.map((c: { did: string }) => c.did)).toEqual([
      ALICE,
    ]);
  });

  it("refuses access to another user's data", async () => {
    await request(app)
      .get(`/api/monitoring/changes/${ALICE}`)
      .set("X-User-DID", BOB)
      .expect(403);
    await request(app)
      .delete(`/api/monitoring/purge/${ALICE}`)
      .set("X-User-DID", BOB)
      .expect(403);
  });

  it("purges only the requesting user's own changes", async () => {
    const res = await request(app)
      .delete(`/api/monitoring/purge/${ALICE}`)
      .set("X-User-DID", ALICE)
      .expect(200);

    expect(res.body.data.deletedChanges).toBe(1);
  });
});

describe("/api/admin", () => {
  it("is restricted to the admin DID", async () => {
    await request(app)
      .get("/api/admin/stats")
      .set("X-User-DID", BOB)
      .expect(403);
  });

  it("reports ingestion stats", async () => {
    const res = await request(app)
      .get("/api/admin/stats")
      .set("X-User-DID", ADMIN)
      .expect(200);

    expect(res.body.data).toMatchObject({
      jetstreamStatus: "connected",
      isInBackfill: false,
      ingestion: { lastSeq: 42, changesDetected: 1 },
    });
  });

  it("lists and unflags bot-flagged accounts", async () => {
    await flagNoisy(ALICE, "frequent-changes");
    const list = await request(app)
      .get("/api/admin/noisy-accounts")
      .set("X-User-DID", ADMIN)
      .expect(200);
    expect(list.body.data).toMatchObject([
      { did: ALICE, reason: "frequent-changes" },
    ]);

    // Hidden while flagged, visible again after unflagging
    const hidden = await request(app)
      .get("/api/changes")
      .set("X-User-DID", BOB)
      .expect(200);
    expect(hidden.body.data.changes).toEqual([]);

    await request(app)
      .delete(`/api/admin/noisy-accounts/${ALICE}`)
      .set("X-User-DID", ADMIN)
      .expect(200);
    const visible = await request(app)
      .get("/api/changes")
      .set("X-User-DID", BOB)
      .expect(200);
    expect(visible.body.data.changes).toHaveLength(1);
  });

  it("refuses to start ingestion twice", async () => {
    await request(app)
      .post("/api/admin/jetstream/start")
      .set("X-User-DID", ADMIN)
      .send({})
      .expect(409);
  });
});
