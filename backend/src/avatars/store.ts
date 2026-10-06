/**
 * Persistence for archived avatar thumbnails.
 */

import { pool } from "../db.js";

export interface AvatarThumb {
  data: Buffer;
  content_type: string;
}

/**
 * Whether the thumbnail of an avatar is already archived.
 */
export async function hasThumb(did: string, cid: string): Promise<boolean> {
  const result = await pool.query(
    "SELECT 1 FROM avatar_thumbs WHERE did = $1 AND cid = $2",
    [did, cid],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Archive the thumbnail of an avatar (first fetch wins).
 */
export async function saveThumb(
  did: string,
  cid: string,
  thumb: AvatarThumb,
): Promise<void> {
  await pool.query(
    `INSERT INTO avatar_thumbs (did, cid, data, content_type)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (did, cid) DO NOTHING`,
    [did, cid, thumb.data, thumb.content_type],
  );
}

/**
 * Load an archived thumbnail.
 *
 * @returns The thumbnail, or null if it was never archived.
 */
export async function getThumb(
  did: string,
  cid: string,
): Promise<AvatarThumb | null> {
  const result = await pool.query<AvatarThumb>(
    "SELECT data, content_type FROM avatar_thumbs WHERE did = $1 AND cid = $2",
    [did, cid],
  );
  return result.rows[0] ?? null;
}
