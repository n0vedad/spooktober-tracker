import { describe, expect, it } from "vitest";
import { didParamSchema } from "./schemas.js";

const valid = (did: string) => didParamSchema.safeParse({ did }).success;

describe("DID validation", () => {
  it("accepts did:plc and did:web, including ports", () => {
    expect(valid("did:plc:ciul6zkjqvao5uv4cpyoijdp")).toBe(true);
    expect(valid("did:web:example.com")).toBe(true);
    expect(valid("did:web:localhost%3A8080")).toBe(true);
  });

  it("rejects other methods and malformed values", () => {
    expect(valid("did:key:zQ3sh")).toBe(false);
    expect(valid("did:web:example.com/path")).toBe(false);
    expect(valid("did:plc:")).toBe(false);
    expect(valid("alice.bsky.social")).toBe(false);
  });
});
