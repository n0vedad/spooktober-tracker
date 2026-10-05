/**
 * Print a new ES256 private JWK for the confidential OAuth client.
 *
 * Usage: pnpm --filter backend gen-key
 * Store the output as OAUTH_PRIVATE_KEY_JWK (e.g. a Railway variable); never commit it.
 */

import { generateClientAssertionKey } from "@atcute/oauth-node-client";

const jwk = await generateClientAssertionKey(`key-${Date.now()}`, "ES256");
console.log(JSON.stringify(jwk));
