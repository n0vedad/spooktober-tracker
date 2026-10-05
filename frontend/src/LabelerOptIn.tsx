/**
 * Explains the labeler opt-in to signed-in users: how to get labeled (like or
 * follow the labeler account) and whether they already are.
 */

import { createResource, createSignal, Show } from "solid-js";
import {
  getLabelerStatus,
  refreshLabelerStatus,
  type LabelerStatus,
} from "./api";
import { showError } from "./utils/toast-helpers";

// Human-readable form of how the user opted in
const VIA_TEXT: Record<string, string> = {
  like: "you like the labeler",
  follow: "you follow the labeler",
  "like+follow": "you like and follow the labeler",
};

interface Props {
  // Status loader (tests)
  load?: () => Promise<LabelerStatus>;
  refresh?: () => Promise<LabelerStatus>;
}

/**
 * Opt-in hint or confirmation for the Spooktober labeler.
 */
export const LabelerOptIn = (props: Props) => {
  const [status, { mutate }] = createResource(props.load ?? getLabelerStatus);
  const [checking, setChecking] = createSignal(false);

  const profileUrl = () =>
    `https://bsky.app/profile/${status()?.handle ?? status()?.did}`;

  const checkAgain = async () => {
    setChecking(true);
    try {
      const next = await (props.refresh ?? refreshLabelerStatus)();
      mutate(next);
      if (!next.optedInVia) {
        showError(
          "No like or follow found yet - it can take a moment to show up.",
          { duration: 4000 },
        );
      }
    } catch (error) {
      showError(error instanceof Error ? error.message : "Check failed");
    } finally {
      setChecking(false);
    }
  };

  return (
    <Show when={status()?.enabled && status()}>
      {(current) => (
        <Show
          when={current().optedInVia}
          fallback={
            <div class="mb-4 w-full rounded-lg border border-orange-300 bg-orange-50 p-4 text-sm dark:border-orange-700 dark:bg-orange-900/20">
              <h4 class="mb-1 font-bold text-orange-800 dark:text-orange-300">
                🎃 Get your own Spooktober labels
              </h4>
              <p class="mb-3 text-orange-900 dark:text-orange-200">
                Your profile changes are only labeled if you agree: like or
                follow{" "}
                <span class="font-semibold">
                  @{current().handle ?? "the labeler"}
                </span>{" "}
                on Bluesky. Subscribe to it as well to see the labels
                everywhere.
              </p>
              <div class="flex flex-col gap-2 sm:flex-row">
                <a
                  href={profileUrl()}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="flex-1 rounded bg-orange-600 px-4 py-2 text-center font-bold text-white hover:bg-orange-700"
                >
                  Open the labeler on Bluesky
                </a>
                <button
                  onclick={checkAgain}
                  disabled={checking()}
                  class="flex-1 rounded border border-orange-400 px-4 py-2 font-semibold hover:bg-orange-100 disabled:opacity-50 dark:hover:bg-orange-900/40"
                >
                  {checking() ? "Checking..." : "Done - check again"}
                </button>
              </div>
            </div>
          }
        >
          {(via) => (
            <div class="mb-4 w-full rounded-lg border border-green-300 bg-green-50 p-3 text-sm text-green-900 dark:border-green-700 dark:bg-green-900/20 dark:text-green-200">
              ✅ You get Spooktober labels, because {VIA_TEXT[via()] ?? via()}.
              Unlike and unfollow{" "}
              <a
                href={profileUrl()}
                target="_blank"
                rel="noopener noreferrer"
                class="font-semibold underline"
              >
                @{current().handle ?? "the labeler"}
              </a>{" "}
              to remove them.
            </div>
          )}
        </Show>
      )}
    </Show>
  );
};
