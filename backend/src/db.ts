/**
 * Postgres database connection and initialization utilities.
 */

import pg from "pg";
import type { ProfileChange } from "../../shared/types.js";
import { DATABASE_URL } from "./config.js";

// Database row for `profile_changes` table.
// Extends the shared ProfileChange with primary key and timestamp.
export interface ProfileChangeRow extends ProfileChange {
  id: number;
  created_at: string;
}

// Last known profile state of an account, used as the "before" value.
export interface ProfileSnapshot {
  did: string;
  // null = handle not observed yet
  handle: string | null;
  display_name: string | null;
  avatar_cid: string | null;
  // false = only the handle is known; display_name/avatar_cid are placeholders
  profile_seen: boolean;
}

// A detected change ready to be persisted.
export interface NewProfileChange {
  did: string;
  handle: string | null;
  old_handle?: string | null;
  new_handle?: string | null;
  old_display_name?: string | null;
  new_display_name?: string | null;
  old_avatar?: string | null;
  new_avatar?: string | null;
  changed_at: Date;
  // Jetstream sequence number; makes re-processing after a crash idempotent
  source_seq: number;
}

// Row from `ignored_users` table storing DIDs that should be skipped.
interface IgnoredUserRow {
  did: string;
  added_at: string;
}

// Pagination options for change listings.
export interface PageOptions {
  limit: number;
  // Only return changes strictly older than this id (keyset pagination)
  beforeId?: number;
}

// Connection Pool
const { Pool } = pg;
const connectionString = DATABASE_URL;
const AS_LOCALHOST = /(localhost|127\.0\.0\.1)/;
const isLocalhost = AS_LOCALHOST.test(connectionString);

// New connection
export const pool = new Pool({
  connectionString,
  ssl: isLocalhost ? false : { rejectUnauthorized: false },
  // Optional cap on pool size (tests use 1 because PGlite is single-connection)
  max: process.env.DATABASE_POOL_MAX
    ? Number(process.env.DATABASE_POOL_MAX)
    : undefined,
});

// Prevent the Node process from crashing when Postgres drops idle connections.
pool.on("error", (error) => {
  console.error("❌ Unexpected Postgres error on idle client:", error);
});

/**
 * Initialise database schema, creating tables and indexes on first run and
 * migrating databases created by earlier versions.
 *
 * @returns Promise that resolves once migrations complete.
 */
export async function initDB() {
  const client = await pool.connect();

  try {
    // Profile change history
    await client.query(`
      CREATE TABLE IF NOT EXISTS profile_changes (
        id SERIAL PRIMARY KEY,
        did TEXT NOT NULL,
        handle TEXT,
        old_handle TEXT,
        new_handle TEXT,
        old_display_name TEXT,
        new_display_name TEXT,
        old_avatar TEXT,
        new_avatar TEXT,
        change_type TEXT,
        changed_at TIMESTAMPTZ DEFAULT NOW(),
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_did ON profile_changes(did);
      CREATE INDEX IF NOT EXISTS idx_changed_at ON profile_changes(changed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_handle ON profile_changes(handle);
      CREATE INDEX IF NOT EXISTS idx_change_type ON profile_changes(change_type);
    `);

    // Migration: databases from 2025 store changed_at without time zone (UTC)
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'profile_changes' AND column_name = 'changed_at'
            AND data_type = 'timestamp without time zone'
        ) THEN
          ALTER TABLE profile_changes
            ALTER COLUMN changed_at TYPE TIMESTAMPTZ USING changed_at AT TIME ZONE 'UTC';
        END IF;
      END $$;
    `);

    // Migration: idempotency key for changes detected from Jetstream
    await client.query(`
      ALTER TABLE profile_changes ADD COLUMN IF NOT EXISTS source_seq BIGINT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_profile_changes_source
        ON profile_changes(did, source_seq);
    `);

    // Last known profile state per account
    await client.query(`
      CREATE TABLE IF NOT EXISTS profile_snapshots (
        did TEXT PRIMARY KEY,
        handle TEXT,
        display_name TEXT,
        avatar_cid TEXT,
        profile_seen BOOLEAN NOT NULL DEFAULT FALSE,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Create ignored_users table
    await client.query(`
      CREATE TABLE IF NOT EXISTS ignored_users (
        did TEXT PRIMARY KEY,
        added_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Create system_settings table for persistent configuration
    await client.query(`
      CREATE TABLE IF NOT EXISTS system_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    console.log("✅ Database schema initialized");

    // Error handling
  } catch (error) {
    console.error("❌ Database initialization failed:", error);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Fetch the newest profile changes, excluding ignored DIDs.
 *
 * @param page - Page size and optional keyset cursor.
 * @returns Promise that resolves with change rows, newest first.
 */
export async function getChanges(
  page: PageOptions,
): Promise<ProfileChangeRow[]> {
  const result = await pool.query<ProfileChangeRow>(
    `SELECT pc.* FROM profile_changes pc
     WHERE ($2::int IS NULL OR pc.id < $2)
     AND NOT EXISTS (
       SELECT 1 FROM ignored_users iu WHERE iu.did = pc.did
     )
     ORDER BY pc.id DESC
     LIMIT $1`,
    [page.limit, page.beforeId ?? null],
  );
  return result.rows;
}

/**
 * Fetch profile changes for a set of DIDs, excluding ignored DIDs.
 *
 * @param dids - DIDs to query for.
 * @param page - Page size and optional keyset cursor.
 * @returns Promise resolving with change rows, newest first.
 */
export async function getChangesByDIDs(
  dids: string[],
  page: PageOptions,
): Promise<ProfileChangeRow[]> {
  if (dids.length === 0) return [];
  const result = await pool.query<ProfileChangeRow>(
    `SELECT pc.* FROM profile_changes pc
     WHERE pc.did = ANY($1)
     AND ($3::int IS NULL OR pc.id < $3)
     AND NOT EXISTS (
       SELECT 1 FROM ignored_users iu WHERE iu.did = pc.did
     )
     ORDER BY pc.id DESC
     LIMIT $2`,
    [dids, page.limit, page.beforeId ?? null],
  );
  return result.rows;
}

/**
 * Determine the type of change based on which fields changed.
 */
function getChangeType(
  change: NewProfileChange,
): "handle" | "profile" | "combined" {
  const hasHandleChange =
    change.old_handle !== undefined || change.new_handle !== undefined;
  const hasProfileChange =
    change.old_display_name !== undefined ||
    change.new_display_name !== undefined ||
    change.old_avatar !== undefined ||
    change.new_avatar !== undefined;

  // Prefer 'combined' when both handle and profile fields changed
  if (hasHandleChange && hasProfileChange) return "combined";
  if (hasHandleChange) return "handle";
  return "profile";
}

/**
 * Persist a detected change. Re-processing the same Jetstream event is a
 * no-op thanks to the (did, source_seq) unique index.
 *
 * @param change - Detected change including its source sequence number.
 * @returns Promise resolving with the inserted row, or null if it already existed.
 */
export async function recordChange(
  change: NewProfileChange,
): Promise<ProfileChangeRow | null> {
  const result = await pool.query<ProfileChangeRow>(
    `INSERT INTO profile_changes
      (did, handle, old_handle, new_handle, old_display_name, new_display_name,
       old_avatar, new_avatar, change_type, changed_at, source_seq)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (did, source_seq) DO NOTHING
     RETURNING *`,
    [
      change.did,
      change.handle,
      change.old_handle ?? null,
      change.new_handle ?? null,
      change.old_display_name ?? null,
      change.new_display_name ?? null,
      change.old_avatar ?? null,
      change.new_avatar ?? null,
      getChangeType(change),
      change.changed_at,
      change.source_seq,
    ],
  );
  return result.rows[0] ?? null;
}

/**
 * Return entire change history for a DID (empty for ignored DIDs).
 *
 * @param did - DID whose change history to fetch.
 * @returns Promise resolving with change rows sorted newest first.
 */
export async function getChangeHistory(
  did: string,
): Promise<ProfileChangeRow[]> {
  const result = await pool.query<ProfileChangeRow>(
    `SELECT pc.* FROM profile_changes pc
     WHERE pc.did = $1
     AND NOT EXISTS (
       SELECT 1 FROM ignored_users iu WHERE iu.did = pc.did
     )
     ORDER BY pc.id DESC`,
    [did],
  );
  return result.rows;
}

/**
 * Load the last known profile state of an account.
 *
 * @param did - Account DID.
 * @returns Promise resolving with the snapshot, or null if never seen.
 */
export async function getSnapshot(
  did: string,
): Promise<ProfileSnapshot | null> {
  const result = await pool.query<ProfileSnapshot>(
    `SELECT did, handle, display_name, avatar_cid, profile_seen
       FROM profile_snapshots WHERE did = $1`,
    [did],
  );
  return result.rows[0] ?? null;
}

/**
 * Store the latest known profile state of an account.
 *
 * @param snapshot - Full snapshot to persist.
 * @returns Promise that resolves once the row is written.
 */
export async function saveSnapshot(snapshot: ProfileSnapshot): Promise<void> {
  await pool.query(
    `INSERT INTO profile_snapshots
       (did, handle, display_name, avatar_cid, profile_seen, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (did) DO UPDATE SET
       handle = EXCLUDED.handle,
       display_name = EXCLUDED.display_name,
       avatar_cid = EXCLUDED.avatar_cid,
       profile_seen = EXCLUDED.profile_seen,
       updated_at = NOW()`,
    [
      snapshot.did,
      snapshot.handle,
      snapshot.display_name,
      snapshot.avatar_cid,
      snapshot.profile_seen,
    ],
  );
}

/**
 * Count stored profile snapshots (accounts seen so far).
 *
 * @returns Promise resolving with the number of snapshots.
 */
export async function countSnapshots(): Promise<number> {
  const result = await pool.query<{ count: string }>(
    "SELECT COUNT(*) AS count FROM profile_snapshots",
  );
  return parseInt(result.rows[0].count, 10);
}

/**
 * Check whether a DID is on the ignore list.
 *
 * @param did - DID to check.
 * @returns Promise resolving with true when ignored.
 */
export async function isIgnored(did: string): Promise<boolean> {
  const result = await pool.query(
    "SELECT 1 FROM ignored_users WHERE did = $1 LIMIT 1",
    [did],
  );
  return result.rows.length > 0;
}

/**
 * Retrieve every ignored DID row.
 *
 * @returns Promise resolving with ignored user rows ordered newest first.
 */
export async function getIgnoredUsers(): Promise<IgnoredUserRow[]> {
  const result = await pool.query<IgnoredUserRow>(
    "SELECT * FROM ignored_users ORDER BY added_at DESC",
  );
  return result.rows;
}

/**
 * Add DID to ignore list and purge its changes and snapshot in a transaction.
 *
 * @param did - DID to ignore.
 * @returns Promise resolving with deletion metadata for the ignored DID.
 */
export async function addIgnoredUser(
  did: string,
): Promise<{ did: string; deletedChanges: number }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Insert into ignored_users
    await client.query(
      `INSERT INTO ignored_users (did) VALUES ($1) ON CONFLICT (did) DO NOTHING`,
      [did],
    );

    // Delete all profile changes and the stored snapshot for this DID
    const deleteResult = await client.query(
      `DELETE FROM profile_changes WHERE did = $1`,
      [did],
    );
    await client.query(`DELETE FROM profile_snapshots WHERE did = $1`, [did]);
    console.log(
      `🗑️  Deleted ${deleteResult.rowCount ?? 0} profile change(s) for ignored DID: ${did}`,
    );

    // Commit transaction and return deletion summary
    await client.query("COMMIT");
    return { did, deletedChanges: deleteResult.rowCount ?? 0 };

    // On failure, roll back the transaction and propagate the error
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Remove DID from ignore list.
 *
 * @param did - DID to unignore.
 * @returns Promise that resolves when the deletion is complete.
 */
export async function removeIgnoredUser(did: string): Promise<void> {
  await pool.query("DELETE FROM ignored_users WHERE did = $1", [did]);
}

/**
 * Delete everything stored about one account (its changes and snapshot).
 *
 * @param did - Account DID.
 * @returns Promise resolving with the number of deleted change rows.
 */
export async function purgeAccount(did: string): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const deleted = await client.query(
      "DELETE FROM profile_changes WHERE did = $1",
      [did],
    );
    await client.query("DELETE FROM profile_snapshots WHERE did = $1", [did]);
    await client.query("COMMIT");
    return deleted.rowCount ?? 0;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Save a system setting to the database.
 *
 * @param key - Setting key.
 * @param value - Setting value (will be JSON stringified).
 * @returns Promise that resolves when saved.
 */
export async function saveSetting(key: string, value: unknown): Promise<void> {
  const valueStr = JSON.stringify(value);
  await pool.query(
    `INSERT INTO system_settings (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [key, valueStr],
  );
}

/**
 * Load a system setting from the database.
 *
 * @param key - Setting key.
 * @returns Promise resolving with the parsed value, or null if not found.
 */
export async function loadSetting(key: string): Promise<any | null> {
  const result = await pool.query<{ value: string }>(
    "SELECT value FROM system_settings WHERE key = $1",
    [key],
  );

  // Key not found in settings table
  if (result.rows.length === 0) {
    return null;
  }

  // Parse stored JSON value; return null on malformed content
  try {
    return JSON.parse(result.rows[0].value);
  } catch {
    return null;
  }
}
