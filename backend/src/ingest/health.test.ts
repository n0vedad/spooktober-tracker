import { describe, expect, it } from "vitest";
import { describeIngestion } from "./health.js";
import type { IngesterStatus } from "./ingester.js";

const NOW = new Date("2026-10-06T12:00:00Z");
const base: IngesterStatus = {
  running: true,
  startedAt: "2026-10-06T11:00:00Z",
  lastSeq: 1,
  lastEventTime: "2026-10-06T11:59:59Z",
  eventsProcessed: 10,
  changesDetected: 1,
  consecutiveFailures: 0,
};

describe("describeIngestion", () => {
  it("is live when the last event is recent", () => {
    expect(describeIngestion(base, NOW)).toMatchObject({
      state: "live",
      lagMs: 1000,
      uptimeSeconds: 3600,
    });
  });

  it("is catching up when the last event is old", () => {
    const status = { ...base, lastEventTime: "2026-10-06T09:00:00Z" };
    expect(describeIngestion(status, NOW)).toMatchObject({
      state: "catching_up",
      lagMs: 3 * 3600 * 1000,
    });
  });

  it("reports a stall instead of catching up while the stream fails", () => {
    const status = {
      ...base,
      lastEventTime: "2026-10-06T09:00:00Z",
      consecutiveFailures: 3,
    };
    expect(describeIngestion(status, NOW).state).toBe("stalled");
  });

  it("distinguishes starting and stopped", () => {
    expect(describeIngestion({ ...base, lastEventTime: null }, NOW).state).toBe(
      "starting",
    );
    expect(
      describeIngestion({ ...base, running: false, startedAt: null }, NOW),
    ).toMatchObject({ state: "stopped", uptimeSeconds: null });
  });
});
