/**
 * One profile change: what changed (handle, display name, avatar before and
 * after) plus the account's expandable change history.
 */

import { createSignal, For, Show } from "solid-js";
import type { ProfileChange } from "../../shared/types";
import { t } from "./i18n";
import { Spinner } from "./Spinner";
import { formatDateTime } from "./utils/date-formatter";
import { tierEmoji } from "./utils/tiers";

/**
 * URL of an avatar: the backend serves its archived thumbnail or redirects
 * to the Bluesky CDN.
 */
export const avatarUrl = (did: string, cid: string) =>
  `/api/avatars/${did}/${cid}`;

// Avatar URLs that failed to load. Kept across re-renders (the list refresh
// recreates the cards), so a gone avatar doesn't flash its alt text again.
const failedAvatars = new Set<string>();

/**
 * One avatar, or a placeholder when there is none or it can't be loaded.
 * The PDS deletes a replaced avatar right away, so an old avatar is only
 * shown if the backend archived it in time or the CDN still has it cached.
 */
const Avatar = (props: {
  did: string;
  cid: string | null;
  alt: string;
  faded?: boolean;
}) => {
  const url = () => (props.cid ? avatarUrl(props.did, props.cid) : null);
  const [failed, setFailed] = createSignal(
    url() !== null && failedAvatars.has(url()!),
  );
  const placeholder = (text: string) => (
    <div
      class="flex h-14 w-14 shrink-0 items-center justify-center rounded-full border-2 border-dashed border-gray-300 text-center text-[10px] leading-tight text-gray-500 dark:border-gray-600"
      title={text}
    >
      {text}
    </div>
  );
  return (
    <Show when={props.cid} fallback={placeholder(t("change.noAvatar"))}>
      {(cid) => (
        <Show when={!failed()} fallback={placeholder(t("change.avatarGone"))}>
          <img
            src={avatarUrl(props.did, cid())}
            alt={props.alt}
            loading="lazy"
            onError={() => {
              failedAvatars.add(avatarUrl(props.did, cid()));
              setFailed(true);
            }}
            // Transparent text: no alt text flashes up while loading
            class={`h-14 w-14 shrink-0 rounded-full border-2 object-cover text-transparent ${
              props.faded
                ? "border-gray-300 opacity-50 grayscale dark:border-gray-600"
                : "border-orange-400"
            }`}
          />
        </Show>
      )}
    </Show>
  );
};

/**
 * The fields that changed, each as "old → new".
 */
export const ChangeDetails = (props: { change: ProfileChange }) => {
  const c = () => props.change;
  const handleChanged = () =>
    (c().old_handle || c().new_handle) && c().old_handle !== c().new_handle;
  const nameChanged = () => c().old_display_name !== c().new_display_name;
  const avatarChanged = () => c().old_avatar !== c().new_avatar;

  const oldValue = (value: string) => (
    <span class="text-gray-500 line-through">{value}</span>
  );
  const newValue = (value: string) => (
    <span class="font-semibold break-all text-orange-700 dark:text-orange-400">
      {value}
    </span>
  );

  return (
    <div class="space-y-1.5 text-sm">
      <Show when={handleChanged()}>
        <div>
          <span class="text-gray-600 dark:text-gray-400">
            {t("change.handle")}:
          </span>{" "}
          {oldValue(c().old_handle ? `@${c().old_handle}` : "-")} →{" "}
          {newValue(c().new_handle ? `@${c().new_handle}` : "-")}
        </div>
      </Show>
      <Show when={nameChanged()}>
        <div>
          <span class="text-gray-600 dark:text-gray-400">
            {t("change.name")}:
          </span>{" "}
          {oldValue(c().old_display_name ?? t("change.noName"))} →{" "}
          {newValue(c().new_display_name ?? t("change.noName"))}
        </div>
      </Show>
      <Show when={avatarChanged()}>
        <div class="flex items-center gap-2">
          <span class="text-gray-600 dark:text-gray-400">
            {t("change.avatar")}:
          </span>
          <Avatar
            did={c().did}
            cid={c().old_avatar}
            alt={t("change.oldAvatar")}
            faded
          />
          <span aria-hidden="true">→</span>
          <Avatar
            did={c().did}
            cid={c().new_avatar}
            alt={t("change.newAvatar")}
          />
        </div>
      </Show>
    </div>
  );
};

interface Props {
  change: ProfileChange;
  expanded: boolean;
  history: ProfileChange[] | undefined;
  onToggle: () => void;
  // Briefly highlighted after it appeared in a refresh
  highlight?: boolean;
}

/**
 * Card for the latest change of an account, with its history on demand.
 */
export const ChangeCard = (props: Props) => {
  const name = () => {
    const handle = props.change.handle;
    return handle ? `@${handle}` : props.change.did;
  };

  return (
    <div
      class={`w-full min-w-0 rounded-lg border bg-orange-50 transition-shadow duration-1000 dark:bg-orange-900/20 ${
        props.highlight
          ? "border-orange-500 ring-2 ring-orange-400"
          : "border-orange-300 dark:border-orange-700"
      }`}
    >
      <button
        type="button"
        onclick={() => props.onToggle()}
        aria-expanded={props.expanded}
        class="block w-full p-4 text-left"
      >
        <div class="mb-2 flex min-w-0 items-center justify-between gap-2">
          <span class="font-bold break-all">
            {tierEmoji(props.change.tier)} {name()}
          </span>
          <span class="text-sm text-gray-500">
            {props.expanded ? "▼" : "▶"}
          </span>
        </div>
        <Show when={props.change.common_follows}>
          {(count) => (
            <div class="mb-2 text-xs text-gray-600 dark:text-gray-400">
              {t("change.followedBy", { count: count() })}
            </div>
          )}
        </Show>
        <ChangeDetails change={props.change} />
        <div class="mt-2 text-xs text-gray-500">
          {formatDateTime(props.change.changed_at, "short", "medium")}
        </div>
      </button>

      <Show when={props.expanded}>
        <div class="border-t border-orange-200 bg-orange-100/50 p-4 dark:border-orange-600 dark:bg-orange-900/10">
          <h4 class="mb-2 text-sm font-bold text-orange-800 dark:text-orange-300">
            {t("change.history")}
          </h4>
          <Show when={props.history} fallback={<Spinner small />}>
            <div class="space-y-2">
              <For each={props.history}>
                {(entry) => (
                  <div class="rounded border border-orange-200 bg-white p-2 dark:border-orange-600 dark:bg-gray-800">
                    <div class="mb-1 text-xs text-gray-500">
                      {formatDateTime(entry.changed_at, "short", "medium")}
                    </div>
                    <ChangeDetails change={entry} />
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
};
