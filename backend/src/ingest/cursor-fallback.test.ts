import { describe, expect, it, vi } from "vitest";
import {
  isCursorTooOld,
  LOOKBACK_MS,
  withCursorFallback,
} from "./cursor-fallback.js";
import type { LiveEvent } from "./ingester.js";

const NOW = Date.parse("2026-10-06T12:00:00Z");
const quiet = { warn: vi.fn() };

// The error ws-client raises for a refused upgrade (wrapped once)
const refused = (status: number) =>
  new Error("socket error", {
    cause: new Error(`Unexpected server response: ${status}`),
  });

const event = (seq: number) => ({ seq }) as unknown as LiveEvent;

async function collect(source: AsyncIterable<LiveEvent>) {
  const seqs: number[] = [];
  for await (const e of source)
    seqs.push((e as unknown as { seq: number }).seq);
  return seqs;
}

describe("isCursorTooOld", () => {
  it("recognises the 400 handshake and the error name", () => {
    expect(isCursorTooOld(refused(400))).toBe(true);
    expect(isCursorTooOld(new Error("CursorTooOld: floor is 17"))).toBe(true);
    expect(isCursorTooOld(refused(503))).toBe(false);
    expect(isCursorTooOld(new Error("network down"))).toBe(false);
  });
});

describe("withCursorFallback", () => {
  it("resumes at the oldest event when the seq cursor is too old", async () => {
    const open = vi.fn(async function* ({ cursor }: { cursor?: number }) {
      if (cursor === 5) throw refused(400);
      yield event(100);
    });
    const source = withCursorFallback(open, quiet, () => NOW);

    const seqs = await collect(
      source({ cursor: 5, signal: new AbortController().signal }),
    );

    expect(seqs).toEqual([100]);
    // Timestamp cursor at the lookback floor, which the server clamps
    expect(open).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: (NOW - LOOKBACK_MS) * 1000 }),
    );
    expect(quiet.warn).toHaveBeenCalled();
  });

  it("passes other errors on", async () => {
    const open = vi.fn(async function* () {
      yield event(1);
      throw refused(503);
    });
    const source = withCursorFallback(open, quiet, () => NOW);

    await expect(
      collect(source({ cursor: 5, signal: new AbortController().signal })),
    ).rejects.toThrow("socket error");
    expect(open).toHaveBeenCalledOnce();
  });

  it("leaves timestamp cursors to the server's clamping", async () => {
    const open = vi.fn(async function* () {
      throw refused(400);
    });
    const source = withCursorFallback(open, quiet, () => NOW);

    await expect(
      collect(
        source({ cursor: NOW * 1000, signal: new AbortController().signal }),
      ),
    ).rejects.toThrow();
    expect(open).toHaveBeenCalledOnce();
  });
});
