import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDB } from "../../test/db-helpers.js";
import { pool } from "../db.js";
import { PgStore } from "./pg-store.js";
import {
  SESSION_TTL_MS,
  createSession,
  deleteSession,
  getSessionDid,
  purgeExpiredSessions,
} from "./sessions.js";

const ALICE = "did:plc:alice";

beforeEach(async () => {
  vi.useRealTimers();
  await resetDB();
});
afterAll(() => pool.end());

describe("sessions", () => {
  it("resolves a token to its account", async () => {
    const token = await createSession(ALICE);

    expect(await getSessionDid(token)).toBe(ALICE);
    expect(await getSessionDid(token + "x")).toBeNull();
  });

  it("stores only a hash of the token", async () => {
    const token = await createSession(ALICE);

    const { rows } = await pool.query("SELECT token_hash FROM app_sessions");
    expect(rows[0].token_hash).not.toContain(token);
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("ends a session on logout", async () => {
    const token = await createSession(ALICE);
    await deleteSession(token);

    expect(await getSessionDid(token)).toBeNull();
  });

  it("expires sessions and purges them", async () => {
    const token = await createSession(ALICE);
    await pool.query(
      "UPDATE app_sessions SET expires_at = NOW() - INTERVAL '1 second'",
    );

    expect(await getSessionDid(token)).toBeNull();
    expect(await purgeExpiredSessions()).toBe(1);
    expect(SESSION_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });
});

describe("PgStore", () => {
  it("stores, reads and deletes JSON values per namespace", async () => {
    const states = new PgStore<string, { verifier: string }>("state");
    const sessions = new PgStore<string, { verifier: string }>("session");

    await states.set("abc", { verifier: "v1" });
    await sessions.set("abc", { verifier: "other" });

    expect(await states.get("abc")).toEqual({ verifier: "v1" });
    await states.delete("abc");
    expect(await states.get("abc")).toBeUndefined();
    expect(await sessions.get("abc")).toEqual({ verifier: "other" });
  });

  it("treats expired entries as missing", async () => {
    const store = new PgStore<string, number>("state", 60_000);
    await store.set("k", 1);
    await pool.query(
      "UPDATE oauth_store SET expires_at = NOW() - INTERVAL '1 second'",
    );

    expect(await store.get("k")).toBeUndefined();
    expect(await purgeExpiredSessions()).toBe(1);
  });

  it("overwrites existing keys and clears a namespace", async () => {
    const store = new PgStore<string, number>("state");
    await store.set("k", 1);
    await store.set("k", 2);
    expect(await store.get("k")).toBe(2);

    await store.clear();
    expect(await store.get("k")).toBeUndefined();
  });
});
