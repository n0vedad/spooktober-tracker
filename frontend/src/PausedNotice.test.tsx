import { fireEvent, render, screen } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { PausedNotice } from "./PausedNotice";

describe("PausedNotice", () => {
  it("lets accounts that deleted their data rejoin", async () => {
    const resume = vi.fn(async () => {});
    const onResumed = vi.fn();
    render(() => (
      <PausedNotice reason="self" resume={resume} onResumed={onResumed} />
    ));

    expect(
      screen.getByText("⏸️ Nothing is recorded about you"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Rejoin" }));

    await vi.waitFor(() => expect(onResumed).toHaveBeenCalled());
    expect(resume).toHaveBeenCalledOnce();
  });

  it("offers no way back to accounts excluded by the admin", () => {
    render(() => <PausedNotice reason="admin" onResumed={() => {}} />);

    expect(screen.getByText(/excluded from the tracker/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
