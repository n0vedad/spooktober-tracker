/**
 * Avatar of the signed-in account in the header. Clicking it opens a small
 * menu with logout and the deletion of one's own data, which is confirmed
 * in a modal dialog over the page.
 */

import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
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
  let cancelButton: HTMLButtonElement | undefined;

  const close = () => setOpen(false);

  const askDelete = () => {
    close();
    setConfirmDelete(true);
    // The harmless choice gets the focus
    queueMicrotask(() => cancelButton?.focus());
  };
  const cancelDelete = () => {
    if (!deleting()) setConfirmDelete(false);
  };

  // Close the menu on clicks outside it and on Escape. The dialog only
  // closes through its cancel button.
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
      await (props.purge ?? purgeMyData)();
      showSuccess(t("account.deleted"), { duration: 4000 });
      setConfirmDelete(false);
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
            <div class="border-b border-gray-200 px-3 py-2 dark:border-gray-700">
              <div class="text-xs text-gray-500 dark:text-gray-400">
                {t("login.loggedInAs")}
              </div>
              {/* Full handle, wrapped at any point if it is very long */}
              <div class="text-sm font-semibold break-all">
                @{props.me.handle}
              </div>
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
          <button
            role="menuitem"
            class={`${itemClass} text-red-700 dark:text-red-400`}
            onclick={askDelete}
          >
            {t("account.delete")}
          </button>
        </div>
      </Show>

      <Show when={confirmDelete()}>
        <Portal>
          <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="delete-title"
              class="w-full max-w-md rounded-lg border border-red-400 bg-white p-5 shadow-xl dark:border-red-600 dark:bg-gray-800"
            >
              <h3
                id="delete-title"
                class="mb-2 text-lg font-bold text-red-800 dark:text-red-300"
              >
                {t("account.deleteTitle")}
              </h3>
              <p class="mb-5 text-sm whitespace-pre-line text-gray-700 dark:text-gray-300">
                {t("account.deleteText")}
              </p>
              <div class="flex flex-col gap-2 sm:flex-row-reverse">
                <button
                  onclick={deleteAllData}
                  disabled={deleting()}
                  class="flex-1 cursor-pointer rounded bg-red-700 px-4 py-2 text-sm font-bold text-white hover:bg-red-800 disabled:opacity-50"
                >
                  {deleting()
                    ? t("account.deleting")
                    : t("account.deleteConfirm")}
                </button>
                <button
                  ref={cancelButton}
                  onclick={cancelDelete}
                  disabled={deleting()}
                  class="flex-1 cursor-pointer rounded bg-gray-600 px-4 py-2 text-sm font-bold text-white hover:bg-gray-700 disabled:opacity-50"
                >
                  {t("account.cancel")}
                </button>
              </div>
            </div>
          </div>
        </Portal>
      </Show>
    </div>
  );
};
