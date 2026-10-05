/**
 * Persistence for emitted labels and labeler opt-ins.
 */

import { pool } from "../db.js";
import type { SignedLabel } from "./labels.js";

/**
 * A stored label with its stream sequence number.
 */
export interface LabelEvent {
  seq: number;
  label: SignedLabel;
}

interface LabelRow {
  seq: string;
  src: string;
  uri: string;
  cid: string | null;
  val: string;
  neg: boolean;
  cts: string;
  exp: string | null;
  sig: Buffer;
}

// Rebuild exactly the object that was signed (optional fields omitted)
function toEvent(row: LabelRow): LabelEvent {
  return {
    seq: Number(row.seq),
    label: {
      ver: 1,
      src: row.src,
      uri: row.uri,
      ...(row.cid && { cid: row.cid }),
      val: row.val,
      ...(row.neg && { neg: true as const }),
      cts: row.cts,
      ...(row.exp && { exp: row.exp }),
      sig: new Uint8Array(row.sig),
    },
  };
}

/**
 * Append a signed label.
 *
 * @param label Signed label.
 * @returns The stored event with its sequence number.
 */
export async function insertLabel(label: SignedLabel): Promise<LabelEvent> {
  const result = await pool.query<LabelRow>(
    `INSERT INTO labels (src, uri, cid, val, neg, cts, exp, sig)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      label.src,
      label.uri,
      label.cid ?? null,
      label.val,
      label.neg === true,
      label.cts,
      label.exp ?? null,
      Buffer.from(label.sig),
    ],
  );
  return toEvent(result.rows[0]);
}

/**
 * Labels emitted after a sequence number, oldest first (stream backfill).
 *
 * @param afterSeq Exclusive lower bound.
 * @param limit Maximum number of labels.
 * @returns Label events.
 */
export async function getLabelsAfter(
  afterSeq: number,
  limit: number,
): Promise<LabelEvent[]> {
  const result = await pool.query<LabelRow>(
    "SELECT * FROM labels WHERE seq > $1 ORDER BY seq LIMIT $2",
    [afterSeq, limit],
  );
  return result.rows.map(toEvent);
}

/**
 * Highest emitted sequence number (0 when nothing was emitted yet).
 */
export async function getLatestSeq(): Promise<number> {
  const result = await pool.query<{ seq: string | null }>(
    "SELECT MAX(seq) AS seq FROM labels",
  );
  return Number(result.rows[0].seq ?? 0);
}

/**
 * Currently effective labels: the latest label per (src, uri, val) that is
 * neither a negation nor expired.
 *
 * @param options Subjects (exact or with a trailing `*` prefix wildcard),
 *   optional labeler DIDs, page size and cursor (sequence number).
 * @returns Matching labels, oldest first, and the cursor for the next page.
 */
export async function queryActiveLabels(options: {
  uriPatterns: readonly string[];
  sources?: readonly string[];
  limit: number;
  cursor?: number;
}): Promise<{ events: LabelEvent[]; cursor?: number }> {
  // Translate `prefix*` patterns to SQL LIKE (escaping LIKE metacharacters)
  const likes = options.uriPatterns.map((pattern) => {
    const escaped = pattern.replace(/[\\%_]/g, (c) => `\\${c}`);
    return escaped.endsWith("*") ? `${escaped.slice(0, -1)}%` : escaped;
  });

  const result = await pool.query<LabelRow>(
    `SELECT * FROM (
       SELECT DISTINCT ON (src, uri, val) *
       FROM labels
       WHERE uri LIKE ANY($1)
         AND ($2::text[] IS NULL OR src = ANY($2))
       ORDER BY src, uri, val, seq DESC
     ) latest
     WHERE NOT neg
       AND (exp IS NULL OR exp > $3)
       AND seq > $4
     ORDER BY seq
     LIMIT $5`,
    [
      likes,
      options.sources?.length ? options.sources : null,
      new Date().toISOString(),
      options.cursor ?? 0,
      options.limit,
    ],
  );
  const events = result.rows.map(toEvent);
  return {
    events,
    cursor: events.length === options.limit ? events.at(-1)!.seq : undefined,
  };
}

/**
 * Accounts that opted in to being labeled.
 *
 * @returns Map of DID to the way they opted in.
 */
export async function getOptIns(): Promise<Map<string, string>> {
  const result = await pool.query<{ did: string; via: string }>(
    "SELECT did, via FROM labeler_optins",
  );
  return new Map(result.rows.map((row) => [row.did, row.via]));
}

/**
 * How an account opted in ("like", "follow", "like+follow"), or null.
 *
 * @param did Account DID.
 */
export async function getOptIn(did: string): Promise<string | null> {
  const result = await pool.query<{ via: string }>(
    "SELECT via FROM labeler_optins WHERE did = $1",
    [did],
  );
  return result.rows[0]?.via ?? null;
}

/**
 * Whether an account opted in to being labeled.
 *
 * @param did Account DID.
 */
export async function isOptedIn(did: string): Promise<boolean> {
  const result = await pool.query(
    "SELECT 1 FROM labeler_optins WHERE did = $1",
    [did],
  );
  return result.rows.length > 0;
}

/**
 * Record or update an opt-in.
 *
 * @param did Account DID.
 * @param via How the account opted in ("like", "follow" or "like+follow").
 */
export async function saveOptIn(did: string, via: string): Promise<void> {
  await pool.query(
    `INSERT INTO labeler_optins (did, via) VALUES ($1, $2)
     ON CONFLICT (did) DO UPDATE SET via = EXCLUDED.via`,
    [did, via],
  );
}

/**
 * Remove an opt-in.
 *
 * @param did Account DID.
 */
export async function removeOptIn(did: string): Promise<void> {
  await pool.query("DELETE FROM labeler_optins WHERE did = $1", [did]);
}
