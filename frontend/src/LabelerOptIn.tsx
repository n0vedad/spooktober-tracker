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
import { t, type MessageKey } from "./i18n";
import { showError } from "./utils/toast-helpers";

// Ways to opt in that have a translated description
const VIA_KEYS = new Set(["like", "follow", "like+follow"]);

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
        showError(t("optin.notFound"), { duration: 4000 });
      }
    } catch (error) {
      showError(
        error instanceof Error ? error.message : t("optin.checkFailed"),
      );
    } finally {
      setChecking(false);
    }
  };

  const labelerName = (handle: string | null | undefined) =>
    handle ? `@${handle}` : t("optin.theLabeler");

  return (
    <Show when={status()?.enabled && status()}>
      {(current) => (
        <Show
          when={current().optedInVia}
          fallback={
            <div class="mb-4 w-full rounded-lg border border-orange-300 bg-orange-50 p-4 text-sm dark:border-orange-700 dark:bg-orange-900/20">
              <h4 class="mb-1 font-bold text-orange-800 dark:text-orange-300">
                {t("optin.title")}
              </h4>
              <p class="mb-3 text-orange-900 dark:text-orange-200">
                {t("optin.textBefore")}{" "}
                <span class="font-semibold">
                  {labelerName(current().handle)}
                </span>{" "}
                {t("optin.textAfter")}
              </p>
              <div class="flex flex-col gap-2 sm:flex-row">
                <a
                  href={profileUrl()}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="flex-1 rounded bg-orange-600 px-4 py-2 text-center font-bold text-white hover:bg-orange-700"
                >
                  {t("optin.open")}
                </a>
                <button
                  onclick={checkAgain}
                  disabled={checking()}
                  class="flex-1 rounded border border-orange-400 px-4 py-2 font-semibold hover:bg-orange-100 disabled:opacity-50 dark:hover:bg-orange-900/40"
                >
                  {checking() ? t("optin.checking") : t("optin.check")}
                </button>
              </div>
            </div>
          }
        >
          {(via) => (
            <div class="mb-4 w-full rounded-lg border border-green-300 bg-green-50 p-3 text-sm text-green-900 dark:border-green-700 dark:bg-green-900/20 dark:text-green-200">
              {t("optin.confirmed", {
                via: VIA_KEYS.has(via())
                  ? t(`optin.via.${via()}` as MessageKey)
                  : via(),
              })}{" "}
              <a
                href={profileUrl()}
                target="_blank"
                rel="noopener noreferrer"
                class="font-semibold underline"
              >
                {t("optin.remove", { labeler: labelerName(current().handle) })}
              </a>
            </div>
          )}
        </Show>
      )}
    </Show>
  );
};
