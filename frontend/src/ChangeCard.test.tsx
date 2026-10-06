import { fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import type { ProfileChange } from "../../shared/types";
import { avatarUrl, ChangeCard } from "./ChangeCard";
import { setLang, t } from "./i18n";
import { latestPerAccount } from "./SpooktoberTracker";

const change = (patch: Partial<ProfileChange>): ProfileChange => ({
  id: 1,
  did: "did:plc:alice",
  handle: "alice.test",
  old_handle: null,
  new_handle: null,
  old_display_name: null,
  new_display_name: null,
  old_avatar: null,
  new_avatar: null,
  change_type: "profile",
  changed_at: "2026-10-06T12:00:00Z",
  ...patch,
});

const renderCard = (c: ProfileChange) =>
  render(() => (
    <ChangeCard
      change={c}
      expanded={false}
      history={undefined}
      onToggle={() => {}}
    />
  ));

afterEach(() => setLang("en"));

describe("ChangeCard", () => {
  it("shows a first display name as (no name) → new name", () => {
    renderCard(change({ new_display_name: "Ghost 👻" }));

    expect(screen.getByText("(no name)")).toBeInTheDocument();
    expect(screen.getByText("Ghost 👻")).toBeInTheDocument();
  });

  it("shows avatars before (faded) and after", () => {
    renderCard(change({ old_avatar: "bafyold", new_avatar: "bafynew" }));

    const before = screen.getByAltText("Previous avatar");
    const after = screen.getByAltText("New avatar");
    expect(before).toHaveAttribute(
      "src",
      avatarUrl("did:plc:alice", "bafyold"),
    );
    expect(before).toHaveClass("grayscale");
    expect(after).toHaveAttribute("src", avatarUrl("did:plc:alice", "bafynew"));
  });

  it("replaces avatars that are gone from the CDN with a placeholder", () => {
    renderCard(change({ old_avatar: "bafyold", new_avatar: "bafynew" }));

    fireEvent.error(screen.getByAltText("Previous avatar"));

    expect(screen.getByText("no longer available")).toBeInTheDocument();
    expect(screen.queryByAltText("Previous avatar")).not.toBeInTheDocument();
  });

  it("remembers gone avatars when the card is rendered again", () => {
    const gone = change({ old_avatar: "bafygone", new_avatar: "bafynew" });
    const first = renderCard(gone);
    fireEvent.error(screen.getByAltText("Previous avatar"));
    first.unmount();

    renderCard(gone);

    expect(screen.queryByAltText("Previous avatar")).not.toBeInTheDocument();
    expect(screen.getByText("no longer available")).toBeInTheDocument();
  });

  it("marks a removed avatar", () => {
    renderCard(change({ old_avatar: "bafyold", new_avatar: null }));
    expect(screen.getByText("no avatar")).toBeInTheDocument();
  });

  it("shows handle changes and how close the account is", () => {
    renderCard(
      change({
        old_handle: "alice.test",
        new_handle: "boo.test",
        change_type: "handle",
        tier: "bubble",
        common_follows: 4,
      }),
    );

    expect(screen.getByText("@alice.test")).toBeInTheDocument();
    expect(screen.getByText("@boo.test")).toBeInTheDocument();
    expect(
      screen.getByText("followed by 4 of your follows"),
    ).toBeInTheDocument();
  });

  it("switches language", () => {
    setLang("de");
    renderCard(change({ new_display_name: "Ghost" }));

    expect(screen.getByText("(kein Name)")).toBeInTheDocument();
    expect(screen.getByText("Anzeigename:")).toBeInTheDocument();
  });
});

describe("i18n", () => {
  it("fills placeholders and remembers the language", () => {
    expect(t("tracker.heading", { count: 3 })).toBe("🎃 Detected Changes (3)");
    setLang("de");
    expect(t("tracker.heading", { count: 3 })).toBe(
      "🎃 Erkannte Änderungen (3)",
    );
    expect(localStorage.getItem("lang")).toBe("de");
    expect(document.documentElement.lang).toBe("de");
  });
});

describe("latestPerAccount", () => {
  it("keeps the first (newest) change per account in server order", () => {
    const rows = [
      change({ id: 5, did: "did:plc:b" }),
      change({ id: 4, did: "did:plc:a", new_display_name: "First name" }),
      change({ id: 3, did: "did:plc:b" }),
    ];

    expect(latestPerAccount(rows).map((c) => c.id)).toEqual([5, 4]);
  });
});
