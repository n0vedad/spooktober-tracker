/**
 * Login sessions of this app, identified by an opaque cookie token.
 *
 * Only a SHA-256 hash of the token is stored, so a database leak does not
 * expose usable session cookies.
 */

import { createHash, randomBytes } from "node:crypto";
import { pool } from "../db.js";

export const SESSION_COOKIE = "spooky_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");

/**
 * Start a session for an authenticated account.
 *
 * @param did Account DID verified via OAuth.
 * @returns Token to put into the session cookie.
 */
export async function createSession(did: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await pool.query(
    `INSERT INTO app_sessions (token_hash, did, expires_at)
     VALUES ($1, $2, $3)`,
    [hashToken(token), did, new Date(Date.now() + SESSION_TTL_MS)],
  );
  return token;
}

/**
 * Look up the account of a session token.
 *
 * @param token Cookie token.
 * @returns DID of the signed-in account, or null if unknown/expired.
 */
export async function getSessionDid(token: string): Promise<string | null> {
  const result = await pool.query<{ did: string }>(
    `SELECT did FROM app_sessions
     WHERE token_hash = $1 AND expires_at > NOW()`,
    [hashToken(token)],
  );
  return result.rows[0]?.did ?? null;
}

/**
 * End a session.
 *
 * @param token Cookie token.
 */
export async function deleteSession(token: string): Promise<void> {
  await pool.query("DELETE FROM app_sessions WHERE token_hash = $1", [
    hashToken(token),
  ]);
}

/**
 * Remove expired sessions and OAuth store entries.
 *
 * @returns Number of removed rows.
 */
export async function purgeExpiredSessions(): Promise<number> {
  const sessions = await pool.query(
    "DELETE FROM app_sessions WHERE expires_at <= NOW()",
  );
  const states = await pool.query(
    "DELETE FROM oauth_store WHERE expires_at IS NOT NULL AND expires_at <= NOW()",
  );
  return (sessions.rowCount ?? 0) + (states.rowCount ?? 0);
}
