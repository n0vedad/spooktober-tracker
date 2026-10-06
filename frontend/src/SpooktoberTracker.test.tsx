import { render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BubbleStatus } from "./api";
import * as api from "./api";
import { SpooktoberTracker } from "./SpooktoberTracker";

vi.mock("./api", () => ({
  getBubbleStatus: vi.fn(),
  getMyChanges: vi.fn(),
  getChangeHistory: vi.fn(async () => []),
}));

const READY: BubbleStatus = {
  state: "ready",
  followsCount: 3,
  computedAt: "2026-10-06T12:00:00Z",
};
const COMPUTING: BubbleStatus = {
  state: "computing",
  done: 1,
  total: 3,
  previous: null,
};

const CHANGE = {
  id: 1,
  did: "did:plc:bob",
  handle: "bob.test",
  old_handle: null,
  new_handle: null,
  old_display_name: "Bob",
  new_display_name: "Boo",
  old_avatar: null,
  new_avatar: null,
  change_type: "profile" as const,
  changed_at: "2026-10-06T12:00:00Z",
};

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("SpooktoberTracker", () => {
  it("shows the changes right away once the bubble exists", async () => {
    vi.mocked(api.getBubbleStatus).mockResolvedValue(READY);
    vi.mocked(api.getMyChanges).mockResolvedValue({
      changes: [CHANGE],
      bubble: READY,
    });

    render(() => <SpooktoberTracker />);

    expect(await screen.findByText("Boo")).toBeInTheDocument();
  });

  it("only shows the progress until the first bubble is done", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(api.getBubbleStatus)
      .mockResolvedValueOnce(COMPUTING)
      .mockResolvedValue(READY);
    vi.mocked(api.getMyChanges).mockResolvedValue({
      changes: [CHANGE],
      bubble: READY,
    });

    render(() => <SpooktoberTracker />);

    expect(
      await screen.findByText(/1 \/ 3 follows checked/),
    ).toBeInTheDocument();
    expect(api.getMyChanges).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2000);

    expect(await screen.findByText("Boo")).toBeInTheDocument();
    expect(screen.queryByText(/follows checked/)).not.toBeInTheDocument();
  });
});
