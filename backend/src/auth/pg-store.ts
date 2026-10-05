/**
 * Postgres-backed key-value store for the OAuth client.
 */

import type { Store } from "@atcute/oauth-node-client";
import { pool } from "../db.js";

/**
 * Store implementation persisting JSON values in `oauth_store`, namespaced by
 * `kind`. Entries can expire; expired entries are treated as missing.
 */
export class PgStore<K extends string, V> implements Store<K, V> {
  /**
   * @param kind Namespace for this store's keys.
   * @param ttlMs Lifetime of new entries, or undefined for no expiry.
   */
  constructor(
    private readonly kind: string,
    private readonly ttlMs?: number,
  ) {}

  async get(key: K): Promise<V | undefined> {
    const result = await pool.query<{ value: V }>(
      `SELECT value FROM oauth_store
       WHERE kind = $1 AND key = $2
         AND (expires_at IS NULL OR expires_at > NOW())`,
      [this.kind, key],
    );
    return result.rows[0]?.value;
  }

  async set(key: K, value: V): Promise<void> {
    const expiresAt =
      this.ttlMs === undefined ? null : new Date(Date.now() + this.ttlMs);
    await pool.query(
      `INSERT INTO oauth_store (kind, key, value, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (kind, key) DO UPDATE SET
         value = EXCLUDED.value, expires_at = EXCLUDED.expires_at`,
      [this.kind, key, JSON.stringify(value), expiresAt],
    );
  }

  async delete(key: K): Promise<void> {
    await pool.query("DELETE FROM oauth_store WHERE kind = $1 AND key = $2", [
      this.kind,
      key,
    ]);
  }

  async clear(): Promise<void> {
    await pool.query("DELETE FROM oauth_store WHERE kind = $1", [this.kind]);
  }
}
