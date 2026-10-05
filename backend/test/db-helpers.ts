/**
 * Helpers for tests that hit the PGlite-backed database.
 */

import { initDB, pool } from "../src/db.js";

let initialized = false;

/**
 * Ensure the schema exists and empty every application table.
 */
export async function resetDB(): Promise<void> {
  if (!initialized) {
    await initDB();
    initialized = true;
  }
  const { rows } = await pool.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
  );
  if (rows.length === 0) return;
  const tables = rows.map((r) => `"${r.tablename}"`).join(", ");
  await pool.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
}
