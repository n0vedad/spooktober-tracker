/**
 * Generate the labeler's secp256k1 signing key.
 *
 * Prints JSON: { "privateKeyHex": ..., "didKey": ... }. The private key goes
 * into LABELER_SIGNING_KEY (secret, Railway only); the public did:key is what
 * `pnpm labeler-setup` publishes in the labeler's DID document.
 */

import { Secp256k1PrivateKeyExportable } from "@atcute/crypto";

const key = await Secp256k1PrivateKeyExportable.createKeypair();
console.log(
  JSON.stringify({
    privateKeyHex: await key.exportPrivateKey("rawHex"),
    didKey: await key.exportPublicKey("did"),
  }),
);
