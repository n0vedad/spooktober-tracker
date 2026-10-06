/**
 * Explains the labeler opt-in to signed-in users: how to get labeled (like or
 * follow the labeler account) and whether they already are.
 */

import { createEffect, createResource, onCleanup, For, Show } from "solid-js";
import { LABEL_DEFINITIONS } from "../../shared/labels";
import { getLabelerStatus, type LabelerStatus } from "./api";
import { lang, t } from "./i18n";
import { withHandleLinks } from "./utils/handle-links";

interface Props {
  // Status loader (tests)
  load?: () => Promise<LabelerStatus>;
  // How often the status is reloaded while waiting for an opt-in, and once
  // opted in (likes and follows can change anytime)
  waitingRefreshMs?: number;
  refreshMs?: number;
  // Called with every loaded or refreshed status
  onStatus?: (status: LabelerStatus) => void;
}

/**
 * Opt-in hint or confirmation for the Spooktober labeler.
 */
export const LabelerOptIn = (props: Props) => {
  const [status, { refetch }] = createResource(props.load ?? getLabelerStatus);

  // Notice new or withdrawn opt-ins without a page reload (a database read).
  // The backend learns of a new like/follow within seconds, so the hint is
  // checked often while it is shown.
  let timer: number | undefined;
  const scheduleRefetch = () => {
    // Until the first status is loaded, the short interval applies too
    const current = status();
    const waiting = !current || (current.enabled && !current.optedInVia);
    timer = window.setTimeout(
      async () => {
        await refetch();
        scheduleRefetch();
      },
      waiting ? (props.waitingRefreshMs ?? 5_000) : (props.refreshMs ?? 30_000),
    );
  };
  scheduleRefetch();
  onCleanup(() => clearTimeout(timer));

  createEffect(() => {
    const current = status();
    if (current) props.onStatus?.(current);
  });

  const profileUrl = () =>
    `https://bsky.app/profile/${status()?.handle ?? status()?.did}`;

  // Label names and descriptions in the page language (as the apps show them)
  const labels = () =>
    LABEL_DEFINITIONS.map(
      (def) => def.locales.find((l) => l.lang === lang()) ?? def.locales[0],
    );

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
              <p class="mb-3 whitespace-pre-line text-orange-900 dark:text-orange-200">
                {withHandleLinks(
                  t("optin.text", { labeler: labelerName(current().handle) }),
                )}
              </p>
              <p class="mb-1 text-xs font-semibold text-orange-800 dark:text-orange-300">
                {t("optin.labels")}
              </p>
              <ul class="mb-3 flex flex-wrap gap-1.5">
                <For each={labels()}>
                  {(label) => (
                    <li
                      class="rounded-full border border-orange-300 bg-white px-2 py-0.5 text-xs dark:border-orange-700 dark:bg-orange-950"
                      title={label.description}
                    >
                      {label.name}
                    </li>
                  )}
                </For>
              </ul>
              <div class="flex flex-col gap-2 sm:flex-row">
                <a
                  href={profileUrl()}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="flex-1 rounded bg-orange-600 px-4 py-2 text-center font-bold text-white hover:bg-orange-700"
                >
                  {t("optin.open")}
                </a>
              </div>
            </div>
          }
        >
          <div class="mb-4 w-full rounded-lg border border-green-300 bg-green-50 p-3 text-sm text-green-900 dark:border-green-700 dark:bg-green-900/20 dark:text-green-200">
            {t("optin.confirmed")}{" "}
            {/* Only the labeler's handle is a link, like elsewhere */}
            {withHandleLinks(
              t("optin.remove", { labeler: labelerName(current().handle) }),
            )}
          </div>
        </Show>
      )}
    </Show>
  );
};
