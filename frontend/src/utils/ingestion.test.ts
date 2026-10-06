import { describe, expect, it } from "vitest";
import type { IngestionHealth } from "../api";
import { describeState, formatDuration } from "./ingestion";

const health = (patch: Partial<IngestionHealth>): IngestionHealth => ({
  state: "live",
  running: true,
  startedAt: null,
  lastSeq: 1,
  lastEventTime: null,
  eventsProcessed: 0,
  changesDetected: 0,
  consecutiveFailures: 0,
  lagMs: 0,
  uptimeSeconds: 0,
  ...patch,
});

describe("formatDuration", () => {
  it("picks a readable unit", () => {
    expect(formatDuration(1_500)).toBe("1 s");
    expect(formatDuration(12 * 60_000)).toBe("12 min");
    expect(formatDuration((3 * 60 + 12) * 60_000)).toBe("3 h 12 min");
    expect(formatDuration(2 * 3_600_000)).toBe("2 h");
    expect(formatDuration((2 * 24 + 4) * 3_600_000)).toBe("2 d 4 h");
  });
});

describe("describeState", () => {
  it("shows how far behind the stream is", () => {
    expect(describeState(health({ lagMs: 800 })).text).toBe(
      "🟢 Live · 0 s behind",
    );
    expect(
      describeState(health({ state: "catching_up", lagMs: 3 * 3_600_000 })),
    ).toEqual({ text: "🟡 Catching up · 3 h behind", tone: "yellow" });
  });

  it("reports stalls with the number of failed attempts", () => {
    expect(
      describeState(health({ state: "stalled", consecutiveFailures: 1 })).text,
    ).toBe("🔴 Stalled · 1 failed attempt");
  });
});
