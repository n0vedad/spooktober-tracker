import { render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LABEL_DEFINITIONS } from "../../shared/labels";
import { setLang } from "./i18n";
import { LabelerOptIn } from "./LabelerOptIn";

const LABELER = {
  enabled: true,
  did: "did:plc:labeler",
  handle: "spooktober-labeler.test",
};

afterEach(() => setLang("en"));

describe("LabelerOptIn", () => {
  it("explains how to opt in and links to the labeler", async () => {
    render(() => (
      <LabelerOptIn load={async () => ({ ...LABELER, optedInVia: null })} />
    ));

    expect(
      await screen.findByText("🎃 Get your Spooktober labels"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Open the labeler's profile" }),
    ).toHaveAttribute(
      "href",
      "https://bsky.app/profile/spooktober-labeler.test",
    );
  });

  it("lists the labels in the page language", async () => {
    setLang("de");
    render(() => (
      <LabelerOptIn load={async () => ({ ...LABELER, optedInVia: null })} />
    ));

    for (const def of LABEL_DEFINITIONS) {
      const german = def.locales.find((l) => l.lang === "de")!;
      expect(await screen.findByTitle(german.description)).toHaveTextContent(
        german.name,
      );
    }
  });

  it("notices a withdrawn opt-in without a reload", async () => {
    let via: string | null = "follow";
    const onStatus = vi.fn();
    render(() => (
      <LabelerOptIn
        load={async () => ({ ...LABELER, optedInVia: via })}
        refreshMs={20}
        waitingRefreshMs={20}
        onStatus={onStatus}
      />
    ));
    expect(await screen.findByText(/You're in/)).toBeInTheDocument();

    via = null;

    expect(
      await screen.findByText("🎃 Get your Spooktober labels"),
    ).toBeInTheDocument();
    expect(onStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ optedInVia: null }),
    );
  });

  it("confirms an existing opt-in", async () => {
    render(() => (
      <LabelerOptIn load={async () => ({ ...LABELER, optedInVia: "follow" })} />
    ));

    expect(await screen.findByText(/You're in/)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "@spooktober-labeler.test" }),
    ).toHaveAttribute(
      "href",
      "https://bsky.app/profile/spooktober-labeler.test",
    );
  });

  it("switches to the confirmation as soon as the opt-in arrives", async () => {
    let via: string | null = null;
    render(() => (
      <LabelerOptIn
        load={async () => ({ ...LABELER, optedInVia: via })}
        waitingRefreshMs={10}
      />
    ));
    expect(
      await screen.findByText("🎃 Get your Spooktober labels"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();

    via = "like";

    expect(await screen.findByText(/You're in/)).toBeInTheDocument();
  });

  it("renders nothing when the backend runs no labeler", async () => {
    const load = vi.fn(async () => ({ enabled: false }));
    const { container } = render(() => <LabelerOptIn load={load} />);

    await vi.waitFor(() => expect(load).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
