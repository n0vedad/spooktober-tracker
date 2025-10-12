/**
 * Postgres database connection and initialization utilities.
 */

import pg from "pg";
import type { ProfileChange, SubmitChangeRequest } from "../../shared/types.js";
import { DATABASE_URL } from "./config.js";

// Database row for `profile_changes` table.
// Extends the shared ProfileChange with primary key and timestamp.
interface ProfileChangeRow extends ProfileChange {
  id: number;
  created_at: string;
}

// Row stored in `monitored_follows` mapping a user to a followed DID.
interface MonitoredFollowRow {
  user_did: string;
  follow_did: string;
  follow_handle: string | null;
  rkey: string | null;
  added_at: string;
}

// Helper row listing distinct monitoring users.
interface MonitoringUserRow {
  user_did: string;
}

// Aggregated per-user monitoring stats (counts and last backfill times).
interface MonitoringUserCountRow {
  user_did: string;
  did_count: number;
  last_started_at: string | null;
  last_completed_at: string | null;
}

// Row from `ignored_users` table storing DIDs that should be skipped.
interface IgnoredUserRow {
  did: string;
  added_at: string;
}

// Row tracking the last backfill start/completion per user.
interface BackfillStateRow {
  user_did: string;
  last_started_at: string | null;
  last_completed_at: string | null;
}

// Minimal projection used to check for duplicate changes by timestamp/id.
interface DuplicateCheckRow {
  id: number;
  changed_at: string;
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
});

// Prevent the Node process from crashing when Postgres drops idle connections.
pool.on("error", (error) => {
  console.error("❌ Unexpected Postgres error on idle client:", error);
});

/**
 * Initialise database schema, creating tables and indexes on first run.
 *
 * @returns Promise that resolves once migrations complete.
 */
export async function initDB() {
  const client = await pool.connect();

  // Create profile_changes table with history support
  try {
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
        changed_at TIMESTAMP DEFAULT NOW(),
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_did ON profile_changes(did);
      CREATE INDEX IF NOT EXISTS idx_changed_at ON profile_changes(changed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_handle ON profile_changes(handle);
      CREATE INDEX IF NOT EXISTS idx_change_type ON profile_changes(change_type);
    `);

    // Create monitored_follows table for tracking which follows to monitor
    await client.query(`
      CREATE TABLE IF NOT EXISTS monitored_follows (
        user_did TEXT NOT NULL,
        follow_did TEXT NOT NULL,
        follow_handle TEXT,
        rkey TEXT,
        added_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (user_did, follow_did)
      );

      CREATE INDEX IF NOT EXISTS idx_follow_did ON monitored_follows(follow_did);
      CREATE INDEX IF NOT EXISTS idx_user_did ON monitored_follows(user_did);
    `);

    // Migration: Add rkey column if it doesn't exist
    await client.query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'monitored_follows' AND column_name = 'rkey'
        ) THEN
          ALTER TABLE monitored_follows ADD COLUMN rkey TEXT;
        END IF;
      END $$;
    `);

    // Create index after ensuring column exists
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_monitored_follows_rkey ON monitored_follows(user_did, rkey);
    `);

    // Migration: Add change_type column if it doesn't exist
    await client.query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'profile_changes' AND column_name = 'change_type'
        ) THEN
          ALTER TABLE profile_changes ADD COLUMN change_type TEXT;
          
          -- Tag existing entries
          UPDATE profile_changes SET change_type = CASE
            WHEN (old_handle IS NOT NULL AND old_handle != '' AND new_handle IS NOT NULL AND new_handle != '') 
                 AND (old_display_name IS NOT NULL OR new_display_name IS NOT NULL OR old_avatar IS NOT NULL OR new_avatar IS NOT NULL)
              THEN 'combined'
            WHEN old_handle IS NOT NULL AND old_handle != '' AND new_handle IS NOT NULL AND new_handle != ''
              THEN 'handle'
            ELSE 'profile'
          END
          WHERE change_type IS NULL;
        END IF;
      END $$;
    `);

    // Track per-user backfill start/completion timestamps
    await client.query(`
      CREATE TABLE IF NOT EXISTS monitoring_backfill_state (
        user_did TEXT PRIMARY KEY,
        last_started_at TIMESTAMP,
        last_completed_at TIMESTAMP,
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Create ignored_users table
    await client.query(`
      CREATE TABLE IF NOT EXISTS ignored_users (
        did TEXT PRIMARY KEY,
        added_at TIMESTAMP DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_ignored_did ON ignored_users(did);
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
 * Fetch all profile changes excluding ignored DIDs.
 *
 * @returns Promise that resolves with ordered profile-change rows.
 */
export async function getAllChanges(): Promise<ProfileChangeRow[]> {
  const result = await pool.query<ProfileChangeRow>(
    `SELECT pc.* FROM profile_changes pc
     WHERE NOT EXISTS (
       SELECT 1 FROM ignored_users iu WHERE iu.did = pc.did
     )
     ORDER BY pc.changed_at DESC`,
  );
  return result.rows;
}

/**
 * Fetch profile changes filtered by DID list while respecting ignore list.
 *
 * @param dids - Array of DIDs to query for.
 * @returns Promise resolving with change rows ordered by timestamp.
 */
export async function getChangesByDIDs(
  dids: string[],
): Promise<ProfileChangeRow[]> {
  const result = await pool.query<ProfileChangeRow>(
    `SELECT pc.* FROM profile_changes pc
     WHERE pc.did = ANY($1)
     AND NOT EXISTS (
       SELECT 1 FROM ignored_users iu WHERE iu.did = pc.did
     )
     ORDER BY pc.changed_at DESC`,
    [dids],
  );
  return result.rows;
}

/**
 * Check if a change already exists in the database (for duplicate detection).
 *
 * @param change - Change details to check.
 * @returns Promise resolving with true if duplicate exists.
 */
export async function isDuplicateChange(
  change: SubmitChangeRequest,
): Promise<{ oldHandle: string | null; newHandle: string | null } | null> {
  const duplicateCheck = await pool.query<ProfileChangeRow>(
    `SELECT old_handle, new_handle FROM profile_changes
     WHERE did = $1
       AND old_display_name IS NOT DISTINCT FROM $2
       AND new_display_name IS NOT DISTINCT FROM $3
       AND old_avatar IS NOT DISTINCT FROM $4
       AND new_avatar IS NOT DISTINCT FROM $5
       AND old_handle IS NOT DISTINCT FROM $6
       AND new_handle IS NOT DISTINCT FROM $7
     LIMIT 1`,
    [
      change.did,
      change.old_display_name ?? null,
      change.new_display_name ?? null,
      change.old_avatar ?? null,
      change.new_avatar ?? null,
      change.old_handle ?? null,
      change.new_handle ?? null,
    ],
  );

  // Duplicate exists: return the stored old/new handle for context
  if (duplicateCheck.rows.length > 0) {
    return {
      oldHandle: duplicateCheck.rows[0].old_handle ?? null,
      newHandle: duplicateCheck.rows[0].new_handle ?? null,
    };
  }
  return null;
}

/**
 * Determine the type of change based on which fields are present.
 */
function getChangeType(
  change: SubmitChangeRequest,
): "handle" | "profile" | "combined" {
  const hasHandleChange = change.old_handle && change.new_handle;
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
 * Insert a profile change unless an identical row already exists historically.
 *
 * @param change - Change payload containing DID + before/after fields.
 * @param logPrefix - Optional prefix for log messages (e.g., temp stream identifier).
 * @returns Promise resolving with the inserted row or the existing duplicate row.
 */
export async function insertChange(
  change: SubmitChangeRequest,
  logPrefix?: string,
): Promise<ProfileChangeRow | null> {
  // Check if DID is ignored - skip insert silently
  const ignoredCheck = await pool.query(
    `SELECT 1 FROM ignored_users WHERE did = $1 LIMIT 1`,
    [change.did],
  );

  // Return null when DID is ignored - caller should handle this gracefully
  if (ignoredCheck.rows.length > 0) {
    return null;
  }

  // Null-safe duplicate detection using IS NOT DISTINCT FROM on all fields
  const duplicateCheck = await pool.query<DuplicateCheckRow>(
    `SELECT id, changed_at FROM profile_changes
     WHERE did = $1
       AND old_display_name IS NOT DISTINCT FROM $2
       AND new_display_name IS NOT DISTINCT FROM $3
       AND old_avatar IS NOT DISTINCT FROM $4
       AND new_avatar IS NOT DISTINCT FROM $5
       AND old_handle IS NOT DISTINCT FROM $6
       AND new_handle IS NOT DISTINCT FROM $7
     LIMIT 1`,
    [
      change.did,
      change.old_display_name ?? null,
      change.new_display_name ?? null,
      change.old_avatar ?? null,
      change.new_avatar ?? null,
      change.old_handle ?? null,
      change.new_handle ?? null,
    ],
  );

  // Only log duplicates from temporary streams (not main stream)
  if (duplicateCheck.rows.length > 0) {
    if (logPrefix) {
      const handleInfo = change.handle ? ` (@${change.handle})` : "";
      const existingTime = new Date(
        duplicateCheck.rows[0].changed_at,
      ).toLocaleString("de-DE", {
        timeZone: "Europe/Berlin",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });
      console.log(
        `⚠️  ${logPrefix} Duplicate change detected for ${change.did}${handleInfo} (existing from ${existingTime}), skipping insert`,
      );
    }

    // Return the originally stored row instead of inserting a duplicate
    const existing = await pool.query<ProfileChangeRow>(
      `SELECT * FROM profile_changes WHERE id = $1`,
      [duplicateCheck.rows[0].id],
    );
    return existing.rows[0];
  }

  const changeType = getChangeType(change);

  // Insert a new change row with normalized nulls and computed change_type
  const result = await pool.query<ProfileChangeRow>(
    `INSERT INTO profile_changes
      (did, handle, old_handle, new_handle, old_display_name, new_display_name, old_avatar, new_avatar, change_type, changed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
     RETURNING *`,
    [
      change.did,
      change.handle ?? null,
      change.old_handle ?? null,
      change.new_handle ?? null,
      change.old_display_name ?? null,
      change.new_display_name ?? null,
      change.old_avatar ?? null,
      change.new_avatar ?? null,
      changeType,
    ],
  );
  return result.rows[0];
}

/**
 * Return entire change history for a DID.
 *
 * @param did - DID whose change history to fetch.
 * @returns Promise resolving with change rows sorted newest first.
 */
export async function getChangeHistory(
  did: string,
): Promise<ProfileChangeRow[]> {
  const result = await pool.query<ProfileChangeRow>(
    "SELECT * FROM profile_changes WHERE did = $1 ORDER BY changed_at DESC",
    [did],
  );
  return result.rows;
}

/**
 * Get the last known handle for a DID from the database.
 *
 * @param did - DID whose last known handle to fetch.
 * @returns Promise resolving with the handle or null if not found.
 */
export async function getLastKnownHandle(did: string): Promise<string | null> {
  const result = await pool.query<{
    handle: string | null;
    new_handle: string | null;
  }>(
    `SELECT handle, new_handle FROM profile_changes 
     WHERE did = $1 
     AND (handle IS NOT NULL OR new_handle IS NOT NULL)
     ORDER BY changed_at DESC 
     LIMIT 1`,
    [did],
  );

  // No handle record found for the requested DID
  // Key not found in settings table
  if (result.rows.length === 0) {
    return null;
  }

  // Prefer the most recent explicit new_handle; otherwise fall back to handle
  return result.rows[0].new_handle || result.rows[0].handle;
}

/**
 * Add or update monitored follows for a user inside a transaction.
 *
 * @param userDID - Owning user DID.
 * @param follows - Array of follow DID + handle pairs.
 * @returns Promise that settles after the operation completes.
 */
export async function addMonitoredFollows(
  userDID: string,
  follows: Array<{ did: string; handle: string; rkey?: string }>,
): Promise<void> {
  const client = await pool.connect();

  // Wrap inserts in a transaction to ensure atomic updates.
  try {
    await client.query("BEGIN");

    // Bulk upsert all follows in a single query for better performance
    if (follows.length > 0) {
      const values: any[] = [];
      const valuePlaceholders: string[] = [];

      // Build VALUES placeholders and flat values array for bulk upsert
      follows.forEach((follow, index) => {
        const base = index * 4;
        valuePlaceholders.push(
          `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`,
        );
        values.push(userDID, follow.did, follow.handle, follow.rkey || null);
      });

      // Bulk upsert into monitored_follows; update handle and rkey (only when provided)
      await client.query(
        `INSERT INTO monitored_follows (user_did, follow_did, follow_handle, rkey)
         VALUES ${valuePlaceholders.join(", ")}
         ON CONFLICT (user_did, follow_did) DO UPDATE SET
           follow_handle = EXCLUDED.follow_handle,
           rkey = COALESCE(EXCLUDED.rkey, monitored_follows.rkey)`,
        values,
      );
    }

    await client.query("COMMIT");

    // Roll back the transaction if any insert fails.
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;

    // Release the connection back to the pool.
  } finally {
    client.release();
  }
}

/**
 * Retrieve all monitored follows for a user.
 *
 * @param userDID - User DID whose follow list should be fetched.
 * @returns Promise resolving with follow rows ordered by creation time.
 */
export async function getMonitoredFollows(
  userDID: string,
): Promise<MonitoredFollowRow[]> {
  const result = await pool.query<MonitoredFollowRow>(
    "SELECT * FROM monitored_follows WHERE user_did = $1 ORDER BY added_at DESC",
    [userDID],
  );
  return result.rows;
}

/**
 * Get monitored follows for multiple users in a single query (batch).
 *
 * @param userDIDs Array of user DIDs to fetch follows for.
 * @returns Promise resolving with a Map of userDID -> follows array.
 */
export async function getMonitoredFollowsBatch(
  userDIDs: string[],
): Promise<Map<string, MonitoredFollowRow[]>> {
  if (userDIDs.length === 0) {
    return new Map();
  }

  // Batch-fetch all monitored_follows rows for the given user DID list
  const result = await pool.query<MonitoredFollowRow>(
    "SELECT * FROM monitored_follows WHERE user_did = ANY($1) ORDER BY added_at DESC",
    [userDIDs],
  );

  // Group by user_did
  const map = new Map<string, MonitoredFollowRow[]>();
  for (const row of result.rows) {
    const existing = map.get(row.user_did) || [];
    existing.push(row);
    map.set(row.user_did, existing);
  }

  // Ensure all userDIDs have an entry (even if empty)
  for (const userDID of userDIDs) {
    if (!map.has(userDID)) {
      map.set(userDID, []);
    }
  }
  return map;
}

/**
 * Collect distinct DIDs currently monitored.
 *
 * @returns Promise resolving with an array of DID strings.
 */
export async function getAllMonitoredDIDs(): Promise<string[]> {
  const result = await pool.query<{ follow_did: string }>(
    "SELECT DISTINCT follow_did FROM monitored_follows",
  );
  return result.rows.map((row) => row.follow_did);
}

/**
 * Get count of distinct users who have monitoring enabled.
 *
 * @returns Promise resolving with the number of users.
 */
export async function getMonitoringUserCount(): Promise<number> {
  const result = await pool.query<{ count: string }>(
    "SELECT COUNT(DISTINCT user_did) as count FROM monitored_follows",
  );
  return parseInt(result.rows[0].count, 10);
}

/**
 * Get all DIDs of users who have monitoring enabled.
 *
 * @returns Promise resolving with an array of user DIDs.
 */
export async function getMonitoringUsers(): Promise<string[]> {
  const result = await pool.query<{ user_did: string }>(
    "SELECT DISTINCT user_did FROM monitored_follows",
  );
  return result.rows.map((row) => row.user_did);
}

/**
 * Check if a user has monitoring enabled.
 *
 * @param userDID - User DID to check.
 * @returns Promise resolving with true if user has monitoring enabled.
 */
export async function hasMonitoringEnabled(userDID: string): Promise<boolean> {
  const result = await pool.query<{ count: string }>(
    "SELECT COUNT(*) as count FROM monitored_follows WHERE user_did = $1",
    [userDID],
  );
  return parseInt(result.rows[0].count, 10) > 0;
}

/**
 * Fetch profile changes limited to a user's monitored follows.
 *
 * @param userDID - User whose feed to load.
 * @returns Promise resolving with change rows sorted by recency.
 */
export async function getChangesForUser(
  userDID: string,
): Promise<ProfileChangeRow[]> {
  const result = await pool.query<ProfileChangeRow>(
    `SELECT pc.*
     FROM profile_changes pc
     JOIN monitored_follows mf ON pc.did = mf.follow_did
     WHERE mf.user_did = $1
     AND NOT EXISTS (
       SELECT 1 FROM ignored_users iu WHERE iu.did = pc.did
     )
     ORDER BY pc.changed_at DESC`,
    [userDID],
  );
  return result.rows;
}

/**
 * Remove all monitored follow rows for a user.
 *
 * @param userDID - User DID to clear.
 * @returns Promise that resolves once rows are deleted.
 */
export async function removeMonitoredFollows(userDID: string): Promise<void> {
  await pool.query("DELETE FROM monitored_follows WHERE user_did = $1", [
    userDID,
  ]);
}

/**
 * Remove a single monitored follow for a user (used when unfollowing).
 *
 * @param userDID - User DID.
 * @param followDID - DID to stop monitoring.
 * @returns Promise that resolves once row is deleted.
 */
export async function removeMonitoredFollow(
  userDID: string,
  followDID: string,
): Promise<void> {
  await pool.query(
    "DELETE FROM monitored_follows WHERE user_did = $1 AND follow_did = $2",
    [userDID, followDID],
  );
}

/**
 * Look up the follow DID for a given user and rkey without deleting.
 *
 * @param userDID - User DID who owns the follow.
 * @param rkey - The rkey identifying the follow record.
 * @returns Promise resolving with the follow DID or null if not found.
 */
export async function getFollowDIDByRkey(
  userDID: string,
  rkey: string,
): Promise<string | null> {
  const result = await pool.query<{ follow_did: string }>(
    "SELECT follow_did FROM monitored_follows WHERE user_did = $1 AND rkey = $2",
    [userDID, rkey],
  );
  return result.rows.length > 0 ? result.rows[0].follow_did : null;
}

/**
 * Find and remove a monitored follow by rkey (used for delete events).
 *
 * @param userDID - User DID.
 * @param rkey - The rkey from the delete event.
 * @returns Promise that resolves with the removed DID or null if not found.
 */
export async function removeMonitoredFollowByRkey(
  userDID: string,
  rkey: string,
): Promise<string | null> {
  const result = await pool.query<{ follow_did: string }>(
    "DELETE FROM monitored_follows WHERE user_did = $1 AND rkey = $2 RETURNING follow_did",
    [userDID, rkey],
  );
  return result.rows.length > 0 ? result.rows[0].follow_did : null;
}

/**
 * Mark that a user's 24h backfill has started.
 *
 * Upserts a row in `monitoring_backfill_state` for the user, setting
 * `last_started_at` to NOW, clearing `last_completed_at`, and updating
 * the `updated_at` timestamp.
 *
 * @param userDID - DID of the user whose backfill started.
 * @returns Promise that resolves once the state has been persisted.
 */
export async function markBackfillStarted(userDID: string): Promise<void> {
  await pool.query(
    `INSERT INTO monitoring_backfill_state (user_did, last_started_at, last_completed_at, updated_at)
     VALUES ($1, NOW(), NULL, NOW())
     ON CONFLICT (user_did)
     DO UPDATE SET last_started_at = NOW(), last_completed_at = NULL, updated_at = NOW()`,
    [userDID],
  );
}

/**
 * Mark that a user's 24h backfill has completed.
 *
 * Upserts a row in `monitoring_backfill_state` for the user, setting
 * `last_completed_at` to NOW and updating the `updated_at` timestamp.
 *
 * @param userDID - DID of the user whose backfill finished.
 * @returns Promise that resolves once the state has been persisted.
 */
export async function markBackfillCompleted(userDID: string): Promise<void> {
  await pool.query(
    `INSERT INTO monitoring_backfill_state (user_did, last_completed_at, updated_at)
     VALUES ($1, NOW(), NOW())
     ON CONFLICT (user_did)
     DO UPDATE SET last_completed_at = NOW(), updated_at = NOW()`,
    [userDID],
  );
}

/**
 * Load the backfill state for a user (last_started_at/last_completed_at).
 *
 * @param userDID - DID whose backfill state should be queried.
 * @returns Promise resolving with the state row or null if none exists.
 */
export async function getBackfillState(
  userDID: string,
): Promise<BackfillStateRow | null> {
  const result = await pool.query<BackfillStateRow>(
    `SELECT user_did, last_started_at::text, last_completed_at::text
       FROM monitoring_backfill_state
       WHERE user_did = $1`,
    [userDID],
  );
  return result.rows[0] ?? null;
}

/**
 * Return list of unique user DIDs currently monitoring followers.
 *
 * @returns Promise resolving with an array of user DID strings.
 */
export async function getAllMonitoringUsers(): Promise<string[]> {
  const result = await pool.query<MonitoringUserRow>(
    "SELECT DISTINCT user_did FROM monitored_follows ORDER BY user_did",
  );
  return result.rows.map((row) => row.user_did);
}

/**
 * Return monitoring users alongside how many DIDs they watch.
 *
 * @returns Promise resolving with user DID + monitored DID counts.
 */
export async function getMonitoringUserCounts(): Promise<
  MonitoringUserCountRow[]
> {
  const result = await pool.query<MonitoringUserCountRow>(
    `SELECT mf.user_did,
            COUNT(*)::int AS did_count,
            mbs.last_started_at::text AS last_started_at,
            mbs.last_completed_at::text AS last_completed_at
       FROM monitored_follows mf
       LEFT JOIN monitoring_backfill_state mbs
              ON mf.user_did = mbs.user_did
       GROUP BY mf.user_did, mbs.last_started_at, mbs.last_completed_at
       ORDER BY mf.user_did`,
  );
  return result.rows;
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
 * Add DID to ignore list and purge related profile changes in a transaction.
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

    // Delete all profile changes for this DID
    const deleteResult = await client.query(
      `DELETE FROM profile_changes WHERE did = $1`,
      [did],
    );
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
 * Save a system setting to the database.
 *
 * @param key - Setting key.
 * @param value - Setting value (will be JSON stringified).
 * @returns Promise that resolves when saved.
 */
export async function saveSetting(key: string, value: any): Promise<void> {
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

  // No handle record found for the requested DID
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
