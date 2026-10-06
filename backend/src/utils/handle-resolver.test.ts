import { describe, expect, it, vi } from "vitest";
import { fetchCurrentHandle, findPreviousHandle } from "./handle-resolver.js";

const DID = "did:plc:alice";

// Build a fake fetch that serves the given audit log
function auditLog(entries: Array<[createdAt: string, handle: string]>) {
  const body = entries.map(([createdAt, handle]) => ({
    createdAt,
    nullified: false,
    operation: { alsoKnownAs: [`at://${handle}`] },
  }));
  return vi.fn(async () => Response.json(body));
}

describe("findPreviousHandle", () => {
  it("returns the handle before the latest switch when it matches the event", async () => {
    const fetchFn = auditLog([
      ["2024-01-01T00:00:00Z", "alice.test"],
      ["2025-03-01T00:00:00Z", "alice.test"],
      ["2026-10-05T12:00:05Z", "spooky.test"],
    ]);

    const prev = await findPreviousHandle(
      DID,
      "spooky.test",
      new Date("2026-10-05T12:00:30Z"),
      fetchFn,
    );

    expect(prev).toBe("alice.test");
    // Short timeout: ingestion waits for these lookups
    expect(fetchFn).toHaveBeenCalledWith(
      "https://plc.directory/did:plc:alice/log/audit",
      undefined,
      3000,
    );
  });

  it("ignores old renames (identity event is just a resync)", async () => {
    const fetchFn = auditLog([
      ["2024-01-01T00:00:00Z", "alice.test"],
      ["2025-01-01T00:00:00Z", "spooky.test"],
    ]);

    expect(
      await findPreviousHandle(DID, "spooky.test", new Date(), fetchFn),
    ).toBeNull();
  });

  it("returns null when the log does not end on the new handle yet", async () => {
    const fetchFn = auditLog([["2026-10-05T12:00:00Z", "alice.test"]]);

    expect(
      await findPreviousHandle(
        DID,
        "spooky.test",
        new Date("2026-10-05T12:00:00Z"),
        fetchFn,
      ),
    ).toBeNull();
  });

  it("skips non-plc DIDs without fetching", async () => {
    const fetchFn = vi.fn();

    expect(
      await findPreviousHandle("did:web:x.test", "x.test", new Date(), fetchFn),
    ).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("supports legacy create operations with a plain handle field", async () => {
    const fetchFn = vi.fn(async () =>
      Response.json([
        {
          createdAt: "2023-01-01T00:00:00Z",
          operation: { handle: "old.test" },
        },
        {
          createdAt: "2026-10-05T12:00:00Z",
          operation: { alsoKnownAs: ["at://new.test"] },
        },
      ]),
    );

    expect(
      await findPreviousHandle(
        DID,
        "new.test",
        new Date("2026-10-05T12:01:00Z"),
        fetchFn,
      ),
    ).toBe("old.test");
  });
});

describe("fetchCurrentHandle", () => {
  it("reads the handle from a did:plc document", async () => {
    const fetchFn = vi.fn(async () =>
      Response.json({ alsoKnownAs: ["at://alice.test"] }),
    );

    expect(await fetchCurrentHandle(DID, fetchFn)).toBe("alice.test");
    expect(fetchFn).toHaveBeenCalledWith(
      "https://plc.directory/did:plc:alice",
      undefined,
      3000,
    );
  });

  it("reads did:web documents from the well-known path", async () => {
    const fetchFn = vi.fn(async () =>
      Response.json({ alsoKnownAs: ["at://example.com"] }),
    );

    expect(await fetchCurrentHandle("did:web:example.com", fetchFn)).toBe(
      "example.com",
    );
    // Short timeout: ingestion waits for these lookups
    expect(fetchFn).toHaveBeenCalledWith(
      "https://example.com/.well-known/did.json",
      undefined,
      3000,
    );
  });

  it("returns null for unknown DIDs", async () => {
    const fetchFn = vi.fn(async () => new Response("", { status: 404 }));
    expect(await fetchCurrentHandle(DID, fetchFn)).toBeNull();
  });
});
