/**
 * Avatar of the signed-in account in the header. Clicking it opens a small
 * menu with logout and the deletion of one's own data.
 */

import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { purgeMyData, type Me } from "./api";
import { avatarUrl } from "./ChangeCard";
import { t } from "./i18n";
import { showError, showSuccess } from "./utils/toast-helpers";

interface Props {
  me: Me;
  onLogout: () => Promise<void> | void;
  // Data deletion (tests)
  purge?: () => Promise<{ deletedChanges: number }>;
}

export const AccountMenu = (props: Props) => {
  const [open, setOpen] = createSignal(false);
  const [confirmDelete, setConfirmDelete] = createSignal(false);
  const [deleting, setDeleting] = createSignal(false);
  const [avatarFailed, setAvatarFailed] = createSignal(false);
  let root: HTMLDivElement | undefined;

  const close = () => {
    setOpen(false);
    setConfirmDelete(false);
  };

  // Close on clicks outside the menu and on Escape. The event path is used
  // because a clicked item may already be replaced (delete -> confirmation).
  const onDocumentClick = (event: MouseEvent) => {
    if (root && !event.composedPath().includes(root)) close();
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") close();
  };
  onMount(() => {
    document.addEventListener("click", onDocumentClick);
    document.addEventListener("keydown", onKey);
  });
  onCleanup(() => {
    document.removeEventListener("click", onDocumentClick);
    document.removeEventListener("keydown", onKey);
  });

  const deleteAllData = async () => {
    setDeleting(true);
    try {
      const result = await (props.purge ?? purgeMyData)();
      showSuccess(t("account.deleted", { count: result.deletedChanges }), {
        duration: 4000,
      });
      close();
      await props.onLogout();
    } catch (error) {
      console.error(error);
      showError(t("account.deleteFailed"));
    } finally {
      setDeleting(false);
    }
  };

  const itemClass =
    "block w-full cursor-pointer rounded px-3 py-2 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700";

  return (
    <div class="relative" ref={root}>
      <button
        type="button"
        class="flex cursor-pointer items-center rounded-full focus-visible:ring-2 focus-visible:ring-orange-400"
        title={t("account.menu")}
        aria-label={t("account.menu")}
        aria-haspopup="menu"
        aria-expanded={open()}
        onclick={() => (open() ? close() : setOpen(true))}
      >
        <Show
          when={props.me.avatar && !avatarFailed() && props.me.avatar}
          fallback={
            <div class="flex h-8 w-8 items-center justify-center rounded-full bg-orange-200 text-orange-900 dark:bg-orange-800 dark:text-orange-100">
              <div class="icon-[lucide--user] text-lg" />
            </div>
          }
        >
          {(cid) => (
            <img
              src={avatarUrl(props.me.did, cid())}
              alt=""
              class="h-8 w-8 rounded-full border-2 border-orange-400 object-cover"
              onError={() => setAvatarFailed(true)}
            />
          )}
        </Show>
      </button>

      <Show when={open()}>
        <div
          role="menu"
          class="absolute right-0 z-20 mt-2 w-64 rounded-lg border border-gray-200 bg-white p-1 text-left shadow-lg dark:border-gray-700 dark:bg-gray-800"
        >
          <Show when={props.me.handle}>
            <div class="truncate border-b border-gray-200 px-3 py-2 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
              {t("login.loggedInAs", { handle: props.me.handle ?? "" })}
            </div>
          </Show>
          <button
            role="menuitem"
            class={itemClass}
            onclick={() => {
              close();
              void props.onLogout();
            }}
          >
            {t("account.logout")}
          </button>
          <Show
            when={confirmDelete()}
            fallback={
              <button
                role="menuitem"
                class={`${itemClass} text-red-700 dark:text-red-400`}
                onclick={() => setConfirmDelete(true)}
              >
                {t("account.delete")}
              </button>
            }
          >
            <div class="m-1 rounded border border-red-400 bg-red-50 p-3 dark:border-red-600 dark:bg-red-900/20">
              <p class="mb-1 text-sm font-bold text-red-800 dark:text-red-300">
                {t("account.deleteTitle")}
              </p>
              <p class="mb-3 text-xs text-red-700 dark:text-red-400">
                {t("account.deleteText")}
              </p>
              <div class="flex gap-2">
                <button
                  onclick={deleteAllData}
                  disabled={deleting()}
                  class="flex-1 cursor-pointer rounded bg-red-700 px-2 py-1.5 text-xs font-bold text-white hover:bg-red-800 disabled:opacity-50"
                >
                  {deleting()
                    ? t("account.deleting")
                    : t("account.deleteConfirm")}
                </button>
                <button
                  onclick={() => setConfirmDelete(false)}
                  disabled={deleting()}
                  class="flex-1 cursor-pointer rounded bg-gray-600 px-2 py-1.5 text-xs font-bold text-white hover:bg-gray-700 disabled:opacity-50"
                >
                  {t("account.cancel")}
                </button>
              </div>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
};
