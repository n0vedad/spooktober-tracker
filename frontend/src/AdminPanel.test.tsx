import { fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminPanel } from "./AdminPanel";
import * as api from "./api";

vi.mock("./api", () => ({
  getAdminStats: vi.fn(),
  getNoisyAccounts: vi.fn(async () => [
    {
      did: "did:plc:clock",
      handle: "clock.test",
      reason: "frequent-changes",
      flagged_at: "2026-10-06T10:00:00Z",
    },
  ]),
  getOptIns: vi.fn(async () => [
    {
      did: "did:plc:fan",
      handle: "fan.test",
      via: "like",
      opted_in_at: "2026-10-06T10:00:00Z",
    },
  ]),
  getIgnoredUsers: vi.fn(async () => []),
  unflagNoisyAccount: vi.fn(async () => "Bot flag removed"),
  getRecommendedStartCursor: vi.fn(),
  startJetstream: vi.fn(),
  stopJetstream: vi.fn(),
  addIgnoredUser: vi.fn(),
  removeIgnoredUser: vi.fn(),
}));

// Captures the status socket so tests can push messages
let socket: {
  onmessage?: (event: { data: string }) => void;
  close: () => void;
};
class FakeWebSocket {
  onopen?: () => void;
  onclose?: () => void;
  onmessage?: (event: { data: string }) => void;
  constructor() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    socket = this as typeof socket;
  }
  close() {}
}

const STATS: api.AdminStats = {
  trackedAccounts: 1234,
  ingestion: {
    state: "live",
    running: true,
    startedAt: "2026-10-06T10:00:00Z",
    lastSeq: 1,
    lastEventTime: "2026-10-06T11:59:59Z",
    eventsProcessed: 500,
    changesDetected: 7,
    consecutiveFailures: 0,
    lagMs: 1000,
    uptimeSeconds: 7200,
  },
  labeler: { enabled: true, optIns: 1, activeLabels: 2, labeledAccounts: 1 },
};

beforeEach(() => {
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.mocked(api.getAdminStats).mockResolvedValue(STATS);
});
afterEach(() => vi.unstubAllGlobals());

describe("AdminPanel", () => {
  it("shows the ingestion state and key figures", async () => {
    render(() => <AdminPanel />);

    expect(await screen.findByRole("status")).toHaveTextContent(
      "🟢 Live · 1 s behind",
    );
    expect(screen.getByText((1234).toLocaleString())).toBeInTheDocument();
    expect(screen.getByText("2 on 1 accounts")).toBeInTheDocument();
    expect(screen.getByText("Stop ingestion")).toBeInTheDocument();
  });

  it("updates the state from WebSocket messages", async () => {
    render(() => <AdminPanel />);
    await screen.findByRole("status");

    socket.onmessage?.({
      data: JSON.stringify({
        type: "ingestion",
        data: { ...STATS.ingestion, state: "stalled", consecutiveFailures: 3 },
      }),
    });

    expect(await screen.findByRole("status")).toHaveTextContent(
      "🔴 Stalled · 3 failed attempts",
    );
  });

  it("lists bots and lets the admin unflag them", async () => {
    render(() => <AdminPanel />);

    expect(await screen.findByText("@clock.test")).toBeInTheDocument();
    expect(
      screen.getByText(/more than 10 changes in 24 h/),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByText("Unflag"));
    await vi.waitFor(() =>
      expect(api.unflagNoisyAccount).toHaveBeenCalledWith("did:plc:clock"),
    );
  });

  it("switches to the opt-in list", async () => {
    render(() => <AdminPanel />);
    await screen.findByRole("status");

    fireEvent.click(screen.getByRole("tab", { name: "🎃 Opt-ins" }));

    // Switching tabs reloads the list, which re-renders its rows
    await vi.waitFor(() =>
      expect(screen.getByText("@fan.test")).toBeInTheDocument(),
    );
    expect(api.getOptIns).toHaveBeenCalledTimes(2);
  });

  it("reloads the lists in the background", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(() => <AdminPanel />);
    await screen.findByText("@clock.test");
    const calls = vi.mocked(api.getNoisyAccounts).mock.calls.length;

    await vi.advanceTimersByTimeAsync(30_000);

    expect(api.getNoisyAccounts).toHaveBeenCalledTimes(calls + 1);
    vi.useRealTimers();
  });
});
