import { decode, encode } from "@atcute/cbor";
import { Secp256k1PrivateKeyExportable } from "@atcute/crypto";
import { describe, expect, it } from "vitest";
import {
  createLabel,
  importSigningKey,
  labelToCbor,
  labelToJson,
  signLabel,
  verifyLabel,
} from "./labels.js";

const SRC = "did:plc:labeler";
const CTS = new Date("2026-10-06T12:00:00.000Z");

describe("labels", () => {
  it("omits unset optional fields", () => {
    expect(
      createLabel({ src: SRC, uri: "did:plc:a", val: "x", cts: CTS }),
    ).toEqual({
      ver: 1,
      src: SRC,
      uri: "did:plc:a",
      val: "x",
      cts: CTS.toISOString(),
    });
    expect(
      createLabel({
        src: SRC,
        uri: "did:plc:a",
        val: "x",
        neg: true,
        exp: new Date("2026-11-01T00:00:00Z"),
        cts: CTS,
      }),
    ).toMatchObject({ neg: true, exp: "2026-11-01T00:00:00.000Z" });
  });

  it("signs labels verifiably and detects tampering", async () => {
    const key = await Secp256k1PrivateKeyExportable.createKeypair();
    const didKey = await key.exportPublicKey("did");
    const label = await signLabel(
      createLabel({ src: SRC, uri: "did:plc:a", val: "spooky-name", cts: CTS }),
      key,
    );

    expect(label.sig).toHaveLength(64);
    expect(await verifyLabel(label, didKey)).toBe(true);
    expect(await verifyLabel({ ...label, val: "other" }, didKey)).toBe(false);
  });

  it("produces wire formats whose signature still verifies", async () => {
    const key = await Secp256k1PrivateKeyExportable.createKeypair();
    const didKey = await key.exportPublicKey("did");
    const label = await signLabel(
      createLabel({ src: SRC, uri: "did:plc:a", val: "spooky-name", cts: CTS }),
      key,
    );

    // JSON: sig as base64 {$bytes}
    const json = labelToJson(label);
    expect(json.sig.$bytes).toBe(Buffer.from(label.sig).toString("base64"));

    // CBOR: decodes to the same fields; the signature is a byte string
    const { sig: cborSig, ...cborRest } = decode(
      encode(labelToCbor(label)),
    ) as { sig: { buf: Uint8Array } } & Record<string, unknown>;
    const { sig: _sig, ...unsigned } = label;
    expect(cborRest).toEqual(unsigned);
    expect(Buffer.from(cborSig.buf)).toEqual(Buffer.from(label.sig));
    expect(await verifyLabel({ ...unsigned, sig: cborSig.buf }, didKey)).toBe(
      true,
    );
  });

  it("imports the signing key from hex and rejects malformed keys", async () => {
    const key = await Secp256k1PrivateKeyExportable.createKeypair();
    const hex = await key.exportPrivateKey("rawHex");

    const imported = await importSigningKey(hex);
    expect(await imported.exportPublicKey("did")).toBe(
      await key.exportPublicKey("did"),
    );
    await expect(importSigningKey("nope")).rejects.toThrow("64 hex");
  });
});
