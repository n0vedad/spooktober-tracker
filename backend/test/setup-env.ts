/**
 * Populates the environment required by `src/config.ts` before any module
 * under test is imported.
 */

import { inject } from "vitest";

process.env.DATABASE_URL = inject("databaseUrl");
process.env.DATABASE_POOL_MAX = "1";
process.env.PORT ??= "3999";
process.env.ADMIN_DID ??= "did:plc:testadmin";
process.env.JETSTREAM_URL ??= "https://jetstream.invalid";
process.env.DEV_CORS_ORIGINS ??= "http://localhost";
