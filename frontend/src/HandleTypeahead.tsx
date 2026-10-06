/**
 * Handle input with account suggestions while typing.
 */

import { createSignal, For, onCleanup, Show } from "solid-js";
import { searchActors, type ActorSuggestion } from "./utils/actor-search";

// Wait this long after the last keystroke before searching
export const SEARCH_DEBOUNCE_MS = 200;

interface Props {
  value: string;
  onInput: (value: string) => void;
  // Optional search implementation (tests)
  search?: typeof searchActors;
}

/**
 * Text input for a Bluesky handle with a keyboard-accessible suggestion list.
 *
 * @param props Current value, change handler and optional search override.
 * @returns JSX input with suggestion dropdown.
 */
export const HandleTypeahead = (props: Props) => {
  const [suggestions, setSuggestions] = createSignal<ActorSuggestion[]>([]);
  const [open, setOpen] = createSignal(false);
  const [active, setActive] = createSignal(-1);

  let timer: number | undefined;
  let controller: AbortController | undefined;

  // Cancel any pending or running search
  const cancelSearch = () => {
    clearTimeout(timer);
    controller?.abort();
  };
  onCleanup(cancelSearch);

  // Search after a short pause in typing; only the latest request wins
  const scheduleSearch = (query: string) => {
    cancelSearch();
    timer = window.setTimeout(async () => {
      const current = new AbortController();
      controller = current;
      try {
        const results = await (props.search ?? searchActors)(
          query,
          current.signal,
        );
        if (current.signal.aborted) return;
        setSuggestions(results);
        setActive(-1);
        setOpen(results.length > 0);
      } catch {
        // Suggestions are optional; typing the full handle still works
        if (!current.signal.aborted) setOpen(false);
      }
    }, SEARCH_DEBOUNCE_MS);
  };

  // Fill the input with the chosen handle and close the list
  const choose = (suggestion: ActorSuggestion) => {
    cancelSearch();
    props.onInput(suggestion.handle);
    setOpen(false);
    setActive(-1);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const count = suggestions().length;
    if (!open() || count === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % count);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i <= 0 ? count - 1 : i - 1));
    } else if (e.key === "Enter" && active() >= 0) {
      // Pick the highlighted account instead of submitting the form
      e.preventDefault();
      choose(suggestions()[active()]);
    } else if (e.key === "Escape") {
      setOpen(false);
      setActive(-1);
    }
  };

  return (
    <div class="relative mb-4 w-full">
      <input
        type="text"
        id="handle"
        placeholder="handle.example.com"
        autocomplete="off"
        autocapitalize="off"
        spellcheck={false}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open()}
        aria-controls="handle-suggestions"
        aria-activedescendant={
          active() >= 0 ? `handle-suggestion-${active()}` : undefined
        }
        value={props.value}
        class="dark:bg-dark-100 w-full rounded-lg border border-gray-400 px-3 py-2.5 text-base focus:ring-2 focus:ring-blue-500 focus:outline-none"
        onInput={(e) => {
          props.onInput(e.currentTarget.value);
          scheduleSearch(e.currentTarget.value);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => setOpen(false)}
      />
      <Show when={open()}>
        <ul
          id="handle-suggestions"
          role="listbox"
          class="dark:bg-dark-300 absolute z-10 mt-1 max-h-80 w-full overflow-y-auto rounded-lg border border-gray-300 bg-white py-1 shadow-lg dark:border-gray-600"
        >
          <For each={suggestions()}>
            {(suggestion, index) => (
              <li
                id={`handle-suggestion-${index()}`}
                role="option"
                aria-selected={active() === index()}
                class={`flex cursor-pointer items-center gap-3 px-3 py-2 ${
                  active() === index()
                    ? "bg-blue-100 dark:bg-blue-900/40"
                    : "hover:bg-gray-100 dark:hover:bg-gray-700"
                }`}
                // mousedown fires before the input's blur closes the list
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(suggestion);
                }}
                onMouseEnter={() => setActive(index())}
              >
                <Show
                  when={suggestion.avatar}
                  fallback={
                    <div class="h-8 w-8 shrink-0 rounded-full bg-gray-300 dark:bg-gray-600" />
                  }
                >
                  <img
                    src={suggestion.avatar}
                    alt=""
                    loading="lazy"
                    class="h-8 w-8 shrink-0 rounded-full object-cover"
                  />
                </Show>
                <div class="min-w-0">
                  <Show when={suggestion.displayName}>
                    <div class="truncate text-sm font-semibold">
                      {suggestion.displayName}
                    </div>
                  </Show>
                  <div class="truncate text-xs text-gray-600 dark:text-gray-300">
                    @{suggestion.handle}
                  </div>
                </div>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
};
