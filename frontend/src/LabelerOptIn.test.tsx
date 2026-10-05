import { fireEvent, render, screen } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import type { LabelerStatus } from "./api";
import { LabelerOptIn } from "./LabelerOptIn";

const LABELER = {
  enabled: true,
  did: "did:plc:labeler",
  handle: "spooktober-labeler.test",
};

describe("LabelerOptIn", () => {
  it("explains how to opt in and links to the labeler", async () => {
    render(() => (
      <LabelerOptIn load={async () => ({ ...LABELER, optedInVia: null })} />
    ));

    expect(
      await screen.findByText("🎃 Get your own Spooktober labels"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Open the labeler on Bluesky" }),
    ).toHaveAttribute(
      "href",
      "https://bsky.app/profile/spooktober-labeler.test",
    );
  });

  it("confirms an existing opt-in", async () => {
    render(() => (
      <LabelerOptIn load={async () => ({ ...LABELER, optedInVia: "follow" })} />
    ));

    expect(
      await screen.findByText(/you follow the labeler/),
    ).toBeInTheDocument();
  });

  it("switches to the confirmation after checking again", async () => {
    const refresh = vi.fn(async (): Promise<LabelerStatus> => ({
      ...LABELER,
      optedInVia: "like",
    }));
    render(() => (
      <LabelerOptIn
        load={async () => ({ ...LABELER, optedInVia: null })}
        refresh={refresh}
      />
    ));

    fireEvent.click(await screen.findByText("Done - check again"));

    expect(await screen.findByText(/you like the labeler/)).toBeInTheDocument();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("renders nothing when the backend runs no labeler", async () => {
    const load = vi.fn(async () => ({ enabled: false }));
    const { container } = render(() => <LabelerOptIn load={load} />);

    await vi.waitFor(() => expect(load).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
