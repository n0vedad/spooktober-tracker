import { fireEvent, render, screen } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { AccountMenu } from "./AccountMenu";
import { avatarUrl } from "./ChangeCard";

const ME = {
  did: "did:plc:alice",
  handle: "alice.test",
  avatar: "bafyavatar",
  isAdmin: false,
  paused: null,
};

describe("AccountMenu", () => {
  it("shows the avatar and opens the menu on click", () => {
    render(() => <AccountMenu me={ME} onLogout={() => {}} />);

    const button = screen.getByRole("button", { name: "Account menu" });
    expect(button.querySelector("img")).toHaveAttribute(
      "src",
      avatarUrl(ME.did, ME.avatar),
    );
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    fireEvent.click(button);

    expect(screen.getByText("Logged in as")).toBeInTheDocument();
    expect(screen.getByText("@alice.test")).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Logout" }),
    ).toBeInTheDocument();
  });

  it("logs out", () => {
    const onLogout = vi.fn();
    render(() => <AccountMenu me={ME} onLogout={onLogout} />);

    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Logout" }));

    expect(onLogout).toHaveBeenCalled();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("deletes the data only after confirming in a dialog, then logs out", async () => {
    const onLogout = vi.fn();
    const purge = vi.fn(async () => ({ deletedChanges: 2 }));
    render(() => <AccountMenu me={ME} onLogout={onLogout} purge={purge} />);

    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Delete all my data" }),
    );

    // The menu closes, a modal dialog asks for confirmation
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    const dialog = screen.getByRole("dialog", {
      name: "⚠️ Really delete all your data?",
    });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(purge).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Yes, delete for good"));

    await vi.waitFor(() => expect(onLogout).toHaveBeenCalled());
    expect(purge).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes the dialog only through its cancel button", () => {
    const purge = vi.fn();
    render(() => <AccountMenu me={ME} onLogout={() => {}} purge={purge} />);
    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Delete all my data" }),
    );
    const dialog = screen.getByRole("dialog");

    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(dialog.parentElement!);
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(purge).not.toHaveBeenCalled();
  });

  it("closes on a click outside", () => {
    render(() => <AccountMenu me={ME} onLogout={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    fireEvent.click(document.body);

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("falls back to an icon without an avatar", () => {
    render(() => (
      <AccountMenu me={{ ...ME, avatar: null }} onLogout={() => {}} />
    ));

    expect(
      screen.getByRole("button", { name: "Account menu" }).querySelector("img"),
    ).toBeNull();
  });
});
