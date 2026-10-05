import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDB } from "../test/db-helpers.js";
import { createApp } from "./app.js";
import { oauthClient } from "./auth/oauth.js";
import {
  SESSION_COOKIE,
  createSession,
  getSessionDid,
} from "./auth/sessions.js";
import { flagNoisy, getChangeHistory, pool, recordChange } from "./db.js";

const ALICE = "did:plc:alice";
const BOB = "did:plc:bob";
const ADMIN = process.env.ADMIN_DID!;

// Never hit the public Bluesky API from tests: everyone follows Alice
vi.mock("./utils/follows.js", () => ({
  getFollows: vi.fn(async () => [{ did: ALICE, handle: "alice.test" }]),
  invalidateFollows: vi.fn(),
}));

// No PLC directory lookups from tests
vi.mock("./utils/handle-resolver.js", () => ({
  resolveHandle: vi.fn(async () => null),
  resolveHandles: vi.fn(async (dids: string[]) =>
    dids.map((did) => ({ did, handle: null })),
  ),
}));

// The OAuth flow itself talks to real PDSes; stub the client
vi.mock("./auth/oauth.js", () => ({
  CLIENT_METADATA_PATH: "/oauth-client-metadata.json",
  JWKS_PATH: "/jwks.json",
  oauthClient: {
    metadata: { client_id: "http://localhost?scope=atproto" },
    jwks: undefined,
    authorize: vi.fn(async () => ({
      url: new URL("https://pds.example/oauth/authorize?request_uri=x"),
    })),
    callback: vi.fn(async () => ({ session: { did: ALICE }, state: null })),
    revoke: vi.fn(async () => {}),
  },
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

// Cookie header for a fresh session of the given account
async function loginAs(did: string): Promise<string> {
  return `${SESSION_COOKIE}=${await createSession(did)}`;
}

beforeEach(async () => {
  vi.clearAllMocks();
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

describe("authentication", () => {
  it("rejects requests without a session", async () => {
    await request(app).get("/api/changes").expect(401);
    await request(app).get("/api/me").expect(401);
  });

  it("ignores the old X-User-DID header", async () => {
    await request(app).get("/api/me").set("X-User-DID", ALICE).expect(401);
  });

  it("rejects unknown session tokens", async () => {
    await request(app)
      .get("/api/me")
      .set("Cookie", `${SESSION_COOKIE}=forged`)
      .expect(401);
  });

  it("reports the signed-in account", async () => {
    const res = await request(app)
      .get("/api/me")
      .set("Cookie", await loginAs(ADMIN))
      .expect(200);

    expect(res.body.data).toMatchObject({ did: ADMIN, isAdmin: true });
  });

  it("logs out and invalidates the session", async () => {
    const cookie = await loginAs(BOB);

    const res = await request(app)
      .post("/api/auth/logout")
      .set("Cookie", cookie)
      .expect(200);

    expect(res.headers["set-cookie"]?.[0]).toMatch(/spooky_session=;/);
    await request(app).get("/api/me").set("Cookie", cookie).expect(401);
  });

  it("blocks state-changing requests from other sites", async () => {
    await request(app)
      .delete("/api/me/data")
      .set("Cookie", await loginAs(ALICE))
      .set("Origin", "https://evil.example")
      .expect(403);
    expect(await getChangeHistory(ALICE)).toHaveLength(1);
  });
});

describe("OAuth flow", () => {
  it("redirects to the user's authorization server", async () => {
    const res = await request(app)
      .get("/oauth/login?handle=@Alice.Test")
      .expect(302);

    expect(res.headers.location).toBe(
      "https://pds.example/oauth/authorize?request_uri=x",
    );
    expect(oauthClient.authorize).toHaveBeenCalledWith({
      target: { type: "account", identifier: "alice.test" },
    });
  });

  it("rejects malformed handles", async () => {
    await request(app).get("/oauth/login?handle=not%20a%20handle").expect(400);
  });

  it("creates a session on callback and revokes the OAuth tokens", async () => {
    const res = await request(app)
      .get("/oauth/callback?code=abc&state=xyz&iss=https://pds.example")
      .expect(302);

    const cookie = res.headers["set-cookie"]![0];
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    const token = cookie.split(";")[0].split("=")[1];
    expect(await getSessionDid(token)).toBe(ALICE);
    expect(oauthClient.revoke).toHaveBeenCalledWith(ALICE);
  });

  it("sends failed logins back to the frontend with an error code", async () => {
    vi.mocked(oauthClient.callback).mockRejectedValueOnce(new Error("denied"));

    const res = await request(app)
      .get("/oauth/callback?error=access_denied&state=xyz")
      .expect(302);

    expect(res.headers.location).toMatch(/\?login_error=denied$/);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("serves the client metadata", async () => {
    const res = await request(app)
      .get("/oauth-client-metadata.json")
      .expect(200);
    expect(res.body.client_id).toBe("http://localhost?scope=atproto");
  });
});

describe("GET /api/changes", () => {
  it("returns a page of changes", async () => {
    const res = await request(app)
      .get("/api/changes?limit=10")
      .set("Cookie", await loginAs(BOB))
      .expect(200);

    expect(res.body.data.changes).toHaveLength(1);
    expect(res.body.data.changes[0].new_display_name).toBe("Alice 🎃");
  });

  it("rejects an invalid limit", async () => {
    await request(app)
      .get("/api/changes?limit=5000")
      .set("Cookie", await loginAs(BOB))
      .expect(400);
  });

  it("no longer accepts change submissions", async () => {
    await request(app)
      .post("/api/changes")
      .set("Cookie", await loginAs(BOB))
      .send({ did: ALICE, new_display_name: "fake" })
      .expect(404);
  });
});

describe("/api/me", () => {
  it("lists the user's follows", async () => {
    const res = await request(app)
      .get("/api/me/follows")
      .set("Cookie", await loginAs(BOB))
      .expect(200);

    expect(res.body.data.follows).toEqual([
      { did: ALICE, handle: "alice.test" },
    ]);
  });

  it("returns the changes of the user's follows", async () => {
    const res = await request(app)
      .get("/api/me/changes")
      .set("Cookie", await loginAs(BOB))
      .expect(200);

    expect(res.body.data.changes.map((c: { did: string }) => c.did)).toEqual([
      ALICE,
    ]);
  });

  it("deletes only the signed-in user's own data", async () => {
    // Bob purging his data leaves Alice's changes alone
    await request(app)
      .delete("/api/me/data")
      .set("Cookie", await loginAs(BOB))
      .expect(200);
    expect(await getChangeHistory(ALICE)).toHaveLength(1);

    const res = await request(app)
      .delete("/api/me/data")
      .set("Cookie", await loginAs(ALICE))
      .expect(200);
    expect(res.body.data.deletedChanges).toBe(1);
  });
});

describe("/api/admin", () => {
  it("is restricted to the admin account", async () => {
    await request(app)
      .get("/api/admin/stats")
      .set("Cookie", await loginAs(BOB))
      .expect(403);
    await request(app)
      .get("/api/admin/stats")
      .set("X-User-DID", ADMIN)
      .expect(401);
  });

  it("reports ingestion stats", async () => {
    const res = await request(app)
      .get("/api/admin/stats")
      .set("Cookie", await loginAs(ADMIN))
      .expect(200);

    expect(res.body.data).toMatchObject({
      jetstreamStatus: "connected",
      isInBackfill: false,
      ingestion: { lastSeq: 42, changesDetected: 1 },
    });
  });

  it("lists and unflags bot-flagged accounts", async () => {
    const admin = await loginAs(ADMIN);
    const bob = await loginAs(BOB);
    await flagNoisy(ALICE, "frequent-changes");

    const list = await request(app)
      .get("/api/admin/noisy-accounts")
      .set("Cookie", admin)
      .expect(200);
    expect(list.body.data).toMatchObject([
      { did: ALICE, reason: "frequent-changes" },
    ]);

    // Hidden while flagged, visible again after unflagging
    const hidden = await request(app)
      .get("/api/changes")
      .set("Cookie", bob)
      .expect(200);
    expect(hidden.body.data.changes).toEqual([]);

    await request(app)
      .delete(`/api/admin/noisy-accounts/${ALICE}`)
      .set("Cookie", admin)
      .expect(200);
    const visible = await request(app)
      .get("/api/changes")
      .set("Cookie", bob)
      .expect(200);
    expect(visible.body.data.changes).toHaveLength(1);
  });

  it("refuses to start ingestion twice", async () => {
    await request(app)
      .post("/api/admin/jetstream/start")
      .set("Cookie", await loginAs(ADMIN))
      .send({})
      .expect(409);
  });
});
