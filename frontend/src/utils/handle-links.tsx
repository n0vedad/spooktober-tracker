/**
 * Render a text with every `@handle` in it as a link to that profile.
 */

import { For } from "solid-js";
import type { JSX } from "solid-js";

// @ followed by a domain-style handle (at least one dot)
const HANDLE = /@([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi;

export function withHandleLinks(text: string): JSX.Element {
  const parts: Array<string | { handle: string }> = [];
  let last = 0;
  for (const match of text.matchAll(HANDLE)) {
    parts.push(text.slice(last, match.index));
    parts.push({ handle: match[1] });
    last = match.index + match[0].length;
  }
  parts.push(text.slice(last));

  return (
    <For each={parts}>
      {(part) =>
        typeof part === "string" ? (
          part
        ) : (
          <a
            href={`https://bsky.app/profile/${part.handle}`}
            target="_blank"
            rel="noopener noreferrer"
            class="font-semibold underline"
          >
            @{part.handle}
          </a>
        )
      }
    </For>
  );
}
