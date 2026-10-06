/**
 * Shown instead of the changes to accounts that are not tracked: after
 * deleting their own data (with a way back) or when excluded by the admin.
 */

import { createSignal, Show } from "solid-js";
import { resumeTracking } from "./api";
import { t } from "./i18n";
import { withHandleLinks } from "./utils/handle-links";
import { showError } from "./utils/toast-helpers";

interface Props {
  reason: "self" | "admin";
  // Called once tracking runs again (reloads the session)
  onResumed: () => Promise<void> | void;
  // Rejoin request (tests)
  resume?: () => Promise<void>;
}

export const PausedNotice = (props: Props) => {
  const [busy, setBusy] = createSignal(false);

  const rejoin = async () => {
    setBusy(true);
    try {
      await (props.resume ?? resumeTracking)();
      await props.onResumed();
    } catch (error) {
      console.error(error);
      showError(t("paused.failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="mb-4 w-full rounded-lg border border-gray-300 bg-gray-50 p-4 text-sm dark:border-gray-600 dark:bg-gray-800">
      <Show
        when={props.reason === "self"}
        fallback={
          <p class="font-semibold">{withHandleLinks(t("paused.admin"))}</p>
        }
      >
        <h4 class="mb-1 font-bold">{t("paused.title")}</h4>
        <p class="mb-3 text-gray-700 dark:text-gray-300">{t("paused.text")}</p>
        <button
          onclick={rejoin}
          disabled={busy()}
          class="w-full cursor-pointer rounded bg-orange-600 px-4 py-2 font-bold text-white hover:bg-orange-700 disabled:opacity-50"
        >
          {busy() ? t("paused.resuming") : t("paused.resume")}
        </button>
      </Show>
    </div>
  );
};
