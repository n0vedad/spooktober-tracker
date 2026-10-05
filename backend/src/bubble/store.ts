/**
 * Persistence for cached follow lists and computed bubbles.
 */

import { pool, VISIBLE_CHANGE, type ProfileChangeRow } from "../db.js";
import type { BubbleMember } from "./compute.js";

// Rows per INSERT when writing bubble members
const INSERT_CHUNK = 5000;

/**
 * Load cached follow lists that are younger than `maxAgeMs`.
 *
 * @param dids Accounts whose lists are wanted.
 * @param maxAgeMs Maximum age of a usable list.
 * @returns Map of account DID to the DIDs it follows (fresh entries only).
 */
export async function getCachedFollowLists(
  dids: readonly string[],
  maxAgeMs: number,
): Promise<Map<string, string[]>> {
  if (dids.length === 0) return new Map();
  const result = await pool.query<{ did: string; follows: string[] }>(
    `SELECT did, follows FROM follow_lists
     WHERE did = ANY($1) AND fetched_at > $2`,
    [dids, new Date(Date.now() - maxAgeMs)],
  );
  return new Map(result.rows.map((row) => [row.did, row.follows]));
}

/**
 * Cache a complete follow list.
 *
 * @param did Account DID.
 * @param follows DIDs it follows.
 */
export async function saveFollowList(
  did: string,
  follows: readonly string[],
): Promise<void> {
  await pool.query(
    `INSERT INTO follow_lists (did, follows, fetched_at) VALUES ($1, $2, NOW())
     ON CONFLICT (did) DO UPDATE SET follows = EXCLUDED.follows, fetched_at = NOW()`,
    [did, follows],
  );
}

/**
 * Metadata of a user's stored bubble.
 */
export interface BubbleInfo {
  followsCount: number;
  computedAt: Date;
}

/**
 * Load the metadata of a user's stored bubble.
 *
 * @param userDid User DID.
 * @returns Bubble metadata, or null when none was computed yet.
 */
export async function getBubbleInfo(
  userDid: string,
): Promise<BubbleInfo | null> {
  const result = await pool.query<{ follows_count: number; computed_at: Date }>(
    "SELECT follows_count, computed_at FROM bubbles WHERE user_did = $1",
    [userDid],
  );
  const row = result.rows[0];
  return row
    ? { followsCount: row.follows_count, computedAt: row.computed_at }
    : null;
}

/**
 * Replace a user's bubble atomically.
 *
 * @param userDid User DID.
 * @param followsCount Number of accounts the user follows.
 * @param members Second-degree accounts with their scores.
 */
export async function saveBubble(
  userDid: string,
  followsCount: number,
  members: readonly BubbleMember[],
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM bubble_members WHERE user_did = $1", [
      userDid,
    ]);
    for (let i = 0; i < members.length; i += INSERT_CHUNK) {
      const chunk = members.slice(i, i + INSERT_CHUNK);
      await client.query(
        `INSERT INTO bubble_members (user_did, did, common_count, score)
         SELECT $1, * FROM unnest($2::text[], $3::int[], $4::real[])`,
        [
          userDid,
          chunk.map((m) => m.did),
          chunk.map((m) => m.commonCount),
          chunk.map((m) => m.score),
        ],
      );
    }
    await client.query(
      `INSERT INTO bubbles (user_did, follows_count, computed_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_did) DO UPDATE SET
         follows_count = EXCLUDED.follows_count, computed_at = NOW()`,
      [userDid, followsCount],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * A change together with the account's connection to the viewing user.
 */
export interface ScopedChangeRow extends ProfileChangeRow {
  // null for accounts the user follows directly
  common_count: number | null;
  score: number | null;
}

/**
 * Changes of the user's follows plus bubble members with at least
 * `minCommon` common follows.
 *
 * @param userDid Viewing user.
 * @param followDids Accounts the user follows directly.
 * @param minCommon Minimum common follows for bubble members, or null for
 *   direct follows only.
 * @param options Page size and sort order (newest first, or closest first).
 * @returns Matching changes.
 */
export async function getChangesInScope(
  userDid: string,
  followDids: readonly string[],
  minCommon: number | null,
  options: { limit: number; sort: "recent" | "closeness" },
): Promise<ScopedChangeRow[]> {
  // Direct follows first, then by Adamic-Adar score; newest first within ties
  const order =
    options.sort === "closeness"
      ? "m.common_count IS NULL DESC, m.score DESC, pc.id DESC"
      : "pc.id DESC";

  const result = await pool.query<ScopedChangeRow>(
    `WITH members AS (
       SELECT unnest($2::text[]) AS did, NULL::int AS common_count, NULL::real AS score
       UNION ALL
       SELECT did, common_count, score FROM bubble_members
       WHERE user_did = $1 AND $3::int IS NOT NULL AND common_count >= $3
     )
     SELECT pc.*, m.common_count, m.score
     FROM profile_changes pc
     JOIN members m ON m.did = pc.did
     WHERE ${VISIBLE_CHANGE}
     ORDER BY ${order}
     LIMIT $4`,
    [userDid, followDids, minCommon, options.limit],
  );
  return result.rows;
}
