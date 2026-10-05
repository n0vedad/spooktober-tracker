/**
 * atproto labels: construction, signing and wire formats.
 *
 * A label is signed over its deterministic DAG-CBOR encoding without the
 * `sig` field (see https://atproto.com/specs/label). The exact object that was
 * signed must be what clients receive, so optional fields are omitted rather
 * than set to null/false.
 */

import { encode, toBytes } from "@atcute/cbor";
import {
  Secp256k1PrivateKeyExportable,
  verifySigWithDidKey,
  type DidKeyString,
} from "@atcute/crypto";

/**
 * Label as signed and distributed (sig excluded).
 */
export interface UnsignedLabel {
  ver: 1;
  // DID of the labeler
  src: string;
  // Subject: an account DID or an at:// record URI
  uri: string;
  cid?: string;
  val: string;
  // Present (true) only for negations that retract an earlier label
  neg?: true;
  // Creation time, ISO 8601
  cts: string;
  // Expiry time, ISO 8601
  exp?: string;
}

export interface SignedLabel extends UnsignedLabel {
  sig: Uint8Array;
}

/**
 * Build a label, leaving out unset optional fields.
 */
export function createLabel(input: {
  src: string;
  uri: string;
  val: string;
  neg?: boolean;
  cid?: string;
  exp?: Date;
  cts?: Date;
}): UnsignedLabel {
  return {
    ver: 1,
    src: input.src,
    uri: input.uri,
    ...(input.cid && { cid: input.cid }),
    val: input.val,
    ...(input.neg && { neg: true as const }),
    cts: (input.cts ?? new Date()).toISOString(),
    ...(input.exp && { exp: input.exp.toISOString() }),
  };
}

/**
 * Sign a label with the labeler's `#atproto_label` key.
 *
 * @param label Label without signature.
 * @param key Private signing key.
 * @returns Label including its signature.
 */
export async function signLabel(
  label: UnsignedLabel,
  key: Secp256k1PrivateKeyExportable,
): Promise<SignedLabel> {
  const sig = await key.sign(encode(label));
  return { ...label, sig };
}

/**
 * Verify a label signature (used in tests and for self-checks).
 *
 * @param label Signed label.
 * @param didKey Public key as did:key.
 * @returns Whether the signature is valid.
 */
export async function verifyLabel(
  label: SignedLabel,
  didKey: DidKeyString,
): Promise<boolean> {
  const { sig, ...unsigned } = label;
  return verifySigWithDidKey(didKey, new Uint8Array(sig), encode(unsigned));
}

/**
 * JSON representation for XRPC query responses (bytes as {$bytes}).
 */
export function labelToJson(label: SignedLabel) {
  const { sig, ...rest } = label;
  return { ...rest, sig: { $bytes: Buffer.from(sig).toString("base64") } };
}

/**
 * Value for CBOR event streams (bytes as a CBOR byte string).
 */
export function labelToCbor(label: SignedLabel) {
  const { sig, ...rest } = label;
  return { ...rest, sig: toBytes(new Uint8Array(sig)) };
}

/**
 * Load the signing key from its hex-encoded raw private key.
 *
 * @param hex 32-byte secp256k1 private key as hex.
 * @returns Key usable for signing and exporting the public did:key.
 */
export async function importSigningKey(
  hex: string,
): Promise<Secp256k1PrivateKeyExportable> {
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error("LABELER_SIGNING_KEY must be 64 hex characters");
  }
  return Secp256k1PrivateKeyExportable.importRaw(Buffer.from(hex, "hex"));
}
