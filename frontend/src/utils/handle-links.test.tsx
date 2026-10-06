import { render, screen } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import { withHandleLinks } from "./handle-links";

describe("withHandleLinks", () => {
  it("links handles and keeps the rest of the text", () => {
    const { container } = render(() => (
      <p>{withHandleLinks("Ask @admin.example.com, or mail at@ home.")}</p>
    ));

    expect(
      screen.getByRole("link", { name: "@admin.example.com" }),
    ).toHaveAttribute("href", "https://bsky.app/profile/admin.example.com");
    expect(container).toHaveTextContent(
      "Ask @admin.example.com, or mail at@ home.",
    );
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });
});
