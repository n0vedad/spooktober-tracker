import { fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HandleTypeahead, SEARCH_DEBOUNCE_MS } from "./HandleTypeahead";
import { searchActors, type ActorSuggestion } from "./utils/actor-search";

const ALICE: ActorSuggestion = {
  did: "did:plc:alice",
  handle: "alice.bsky.social",
  displayName: "Alice 🎃",
  avatar: "https://cdn.example/alice.jpg",
};
const ALINA: ActorSuggestion = { did: "did:plc:alina", handle: "alina.test" };

// Render the input with real state so typing and choosing update the value
function setup(results: ActorSuggestion[] = [ALICE, ALINA]) {
  const search = vi.fn(async () => results);
  const [value, setValue] = createSignal("");
  render(() => (
    <HandleTypeahead value={value()} onInput={setValue} search={search} />
  ));
  const input = screen.getByRole("combobox") as HTMLInputElement;
  return { input, search, value };
}

// Type a value and let the debounce timer and the search promise settle
async function type(input: HTMLInputElement, text: string) {
  fireEvent.input(input, { target: { value: text } });
  await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("HandleTypeahead", () => {
  it("shows suggestions with name and handle after typing", async () => {
    const { input, search } = setup();

    await type(input, "ali");

    expect(search).toHaveBeenCalledWith("ali", expect.any(AbortSignal));
    expect(screen.getAllByRole("option")).toHaveLength(2);
    expect(screen.getByText("Alice 🎃")).toBeInTheDocument();
    expect(screen.getByText("@alina.test")).toBeInTheDocument();
    expect(input).toHaveAttribute("aria-expanded", "true");
  });

  it("debounces: only searches once typing pauses", async () => {
    const { input, search } = setup();

    fireEvent.input(input, { target: { value: "a" } });
    fireEvent.input(input, { target: { value: "al" } });
    fireEvent.input(input, { target: { value: "ali" } });
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);

    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith("ali", expect.any(AbortSignal));
  });

  it("fills the input when a suggestion is clicked", async () => {
    const { input, value } = setup();
    await type(input, "ali");

    fireEvent.mouseDown(screen.getByText("@alice.bsky.social"));

    expect(value()).toBe("alice.bsky.social");
    expect(input.value).toBe("alice.bsky.social");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("supports keyboard selection", async () => {
    const { input, value } = setup();
    await type(input, "ali");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute(
      "aria-activedescendant",
      "handle-suggestion-1",
    );

    fireEvent.keyDown(input, { key: "Enter" });
    expect(value()).toBe("alina.test");
  });

  it("closes on Escape", async () => {
    const { input } = setup();
    await type(input, "ali");

    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("shows no list when nothing matches", async () => {
    const { input } = setup([]);
    await type(input, "zzz");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});

describe("searchActors", () => {
  it("queries the public typeahead endpoint without the leading @", async () => {
    const fetchFn = vi.fn(async () =>
      Response.json({ actors: [{ ...ALICE, labels: [], associated: {} }] }),
    );

    const result = await searchActors("@ali", undefined, fetchFn);

    expect(fetchFn).toHaveBeenCalledWith(
      "https://public.api.bsky.app/xrpc/app.bsky.actor.searchActorsTypeahead?q=ali&limit=8",
      { signal: undefined },
    );
    // Only the fields the UI needs are kept
    expect(result).toEqual([ALICE]);
  });

  it("does not search for fewer than two characters", async () => {
    const fetchFn = vi.fn();
    expect(await searchActors("a", undefined, fetchFn)).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("returns no suggestions when the API fails", async () => {
    const fetchFn = vi.fn(async () => new Response("", { status: 502 }));
    expect(await searchActors("alice", undefined, fetchFn)).toEqual([]);
  });
});
