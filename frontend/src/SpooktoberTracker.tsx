/**
 * Spooktober Tracker Component
 * The backend tracks the whole network 24/7; this view shows the changes of
 * the user's follows and, by closeness tier, of their wider network.
 */

import { createSignal, For, onCleanup, Show } from "solid-js";
import type { ProfileChange } from "../../shared/types";
import {
  getBubbleStatus,
  getChangeHistory,
  getMyChanges,
  purgeMyData,
  type BubbleStatus,
} from "./api";
import { ChangeCard } from "./ChangeCard";
import { t } from "./i18n";
import { formatDuration } from "./utils/ingestion";
import { TIER_OPTIONS, tierHint, tierLabel, type Tier } from "./utils/tiers";
import { showError, showSuccess } from "./utils/toast-helpers";

interface Props {
  // Accounts the user follows, with handles
  follows: { did: string; handle: string }[];
  // Logout routine of the parent (used after deleting one's data)
  onLogout?: () => Promise<void> | void;
}

// Changes shown per "load more" step
const PAGE_SIZE = 50;
// Silent background refresh of the list
const REFRESH_INTERVAL_MS = 30_000;
// How long newly appeared changes stay highlighted
const HIGHLIGHT_MS = 6_000;

/**
 * Keep the newest change per account, preserving the server's order. Older
 * changes of the account are available in its history.
 */
export function latestPerAccount(changes: ProfileChange[]): ProfileChange[] {
  const seen = new Set<string>();
  return changes.filter((change) => {
    if (seen.has(change.did)) return false;
    seen.add(change.did);
    return true;
  });
}

/**
 * Render the tracker: entry screen, then the change list.
 */
export const SpooktoberTracker = (props: Props) => {
  const [viewing, setViewing] = createSignal(false);
  const [changes, setChanges] = createSignal<ProfileChange[]>([]);
  const [scope, setScope] = createSignal<Tier>("bubble");
  const [sort, setSort] = createSignal<"recent" | "closeness">("recent");
  const [bubble, setBubble] = createSignal<BubbleStatus | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [disconnected, setDisconnected] = createSignal(false);
  const [visibleCount, setVisibleCount] = createSignal(PAGE_SIZE);
  const [expanded, setExpanded] = createSignal<string | null>(null);
  const [history, setHistory] = createSignal(
    new Map<string, ProfileChange[]>(),
  );
  const [highlighted, setHighlighted] = createSignal(new Set<number>());
  const [updatedAt, setUpdatedAt] = createSignal<number | null>(null);
  const [now, setNow] = createSignal(Date.now());
  const [confirmDelete, setConfirmDelete] = createSignal(false);
  const [deleting, setDeleting] = createSignal(false);

  let refreshTimer: number | undefined;
  let clockTimer: number | undefined;
  let bubblePoll: number | undefined;
  let highlightTimer: number | undefined;

  const handleOf = new Map(props.follows.map((f) => [f.did, f.handle]));

  /**
   * Load the list. A silent load (background refresh) keeps the current
   * list on screen and highlights changes that were not there before.
   */
  const loadChanges = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const result = await getMyChanges(scope(), sort());
      setDisconnected(false);
      setBubble(result.bubble);
      if (result.bubble?.state === "computing") startBubblePoll();

      const next = latestPerAccount(result.changes);
      if (silent) {
        const known = new Set(changes().map((c) => c.id));
        const fresh = next.filter((c) => !known.has(c.id)).map((c) => c.id);
        if (fresh.length > 0) {
          setHighlighted(new Set(fresh));
          clearTimeout(highlightTimer);
          highlightTimer = window.setTimeout(
            () => setHighlighted(new Set<number>()),
            HIGHLIGHT_MS,
          );
        }
      }
      setChanges(next);
      setUpdatedAt(Date.now());

      // Keep the open history current; drop the others
      const open = expanded();
      setHistory(new Map());
      if (open) void loadHistory(open);
    } catch {
      setDisconnected(true);
      stopRefresh();
      showError(t("tracker.connectionLost"), { duration: 6000 });
    } finally {
      setLoading(false);
    }
  };

  const loadHistory = async (did: string) => {
    try {
      const entries = await getChangeHistory(did);
      setHistory((prev) => new Map(prev).set(did, entries));
    } catch (error) {
      console.error(`Failed to load history for ${did}:`, error);
    }
  };

  const toggleHistory = (did: string) => {
    if (expanded() === did) {
      setExpanded(null);
      return;
    }
    setExpanded(did);
    if (!history().has(did)) void loadHistory(did);
  };

  const startRefresh = () => {
    stopRefresh();
    refreshTimer = window.setInterval(
      () => void loadChanges(true),
      REFRESH_INTERVAL_MS,
    );
    clockTimer = window.setInterval(() => setNow(Date.now()), 5_000);
  };

  const stopRefresh = () => {
    clearInterval(refreshTimer);
    clearInterval(clockTimer);
  };

  // Follow the bubble computation, then reload once it is done
  const startBubblePoll = () => {
    if (bubblePoll) return;
    bubblePoll = window.setInterval(async () => {
      try {
        const status = await getBubbleStatus();
        setBubble(status);
        if (status.state !== "computing") {
          stopBubblePoll();
          if (status.state === "ready") await loadChanges(true);
        }
      } catch {
        stopBubblePoll();
      }
    }, 2000);
  };

  const stopBubblePoll = () => {
    clearInterval(bubblePoll);
    bubblePoll = undefined;
  };

  const changeView = async (next: {
    scope?: Tier;
    sort?: "recent" | "closeness";
  }) => {
    if (next.scope) setScope(next.scope);
    if (next.sort) setSort(next.sort);
    setVisibleCount(PAGE_SIZE);
    await loadChanges();
  };

  const open = async () => {
    await loadChanges();
    setViewing(true);
    startRefresh();
  };

  const back = () => {
    stopRefresh();
    stopBubblePoll();
    setViewing(false);
    setChanges([]);
    setHistory(new Map());
    setExpanded(null);
    setVisibleCount(PAGE_SIZE);
  };

  const deleteAllData = async () => {
    setDeleting(true);
    try {
      const result = await purgeMyData();
      showSuccess(t("tracker.deleted", { count: result.deletedChanges }), {
        duration: 4000,
      });
      await props.onLogout?.();
    } catch (error) {
      console.error(error);
      showError(t("tracker.deleteFailed"));
    } finally {
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  onCleanup(() => {
    stopRefresh();
    stopBubblePoll();
    clearTimeout(highlightTimer);
  });

  const updatedText = () => {
    const at = updatedAt();
    if (at === null) return "";
    const ago = now() - at;
    return ago < 10_000
      ? t("tracker.updatedJustNow")
      : t("tracker.updatedAgo", { ago: formatDuration(ago) });
  };

  const computing = () => {
    const status = bubble();
    return status?.state === "computing" ? status : null;
  };

  return (
    <div class="mt-6 w-full overflow-hidden">
      {/* Entry screen */}
      <Show when={!viewing()}>
        <div class="mb-4">
          <button
            onclick={open}
            disabled={props.follows.length === 0 || loading()}
            class="w-full rounded bg-orange-600 px-4 py-3 font-bold text-white hover:bg-orange-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading()
              ? t("tracker.loading")
              : props.follows.length === 0
                ? t("tracker.noFollows")
                : t("tracker.view")}
          </button>

          <Show when={confirmDelete()}>
            <div class="mt-4 rounded-lg border border-red-400 bg-red-50 p-4 dark:border-red-600 dark:bg-red-900/20">
              <h3 class="mb-2 font-bold text-red-800 dark:text-red-300">
                {t("tracker.deleteTitle")}
              </h3>
              <p class="mb-4 text-sm text-red-700 dark:text-red-400">
                {t("tracker.deleteText")}
              </p>
              <div class="flex flex-col gap-2 sm:flex-row">
                <button
                  onclick={deleteAllData}
                  disabled={deleting()}
                  class="flex-1 rounded bg-red-700 px-4 py-2 font-bold text-white hover:bg-red-800 disabled:opacity-50"
                >
                  {deleting()
                    ? t("tracker.deleting")
                    : t("tracker.deleteConfirm")}
                </button>
                <button
                  onclick={() => setConfirmDelete(false)}
                  disabled={deleting()}
                  class="flex-1 rounded bg-gray-600 px-4 py-2 font-bold text-white hover:bg-gray-700 disabled:opacity-50"
                >
                  {t("tracker.cancel")}
                </button>
              </div>
            </div>
          </Show>

          <button
            onclick={() => setConfirmDelete(true)}
            class="mt-4 w-full rounded bg-red-600 px-4 py-3 font-bold text-white hover:bg-red-700"
          >
            {t("tracker.delete")}
          </button>
        </div>
      </Show>

      {/* Change list */}
      <Show when={viewing()}>
        <div class="mb-4">
          <button
            onclick={back}
            class="mb-4 w-full rounded bg-red-600 px-4 py-2 font-bold text-white hover:bg-red-700"
          >
            {t("tracker.back")}
          </button>

          {/* How far into the bubble */}
          <div class="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <For each={TIER_OPTIONS}>
              {(option) => (
                <button
                  onclick={() => changeView({ scope: option.tier })}
                  title={tierHint(option.tier)}
                  aria-pressed={scope() === option.tier}
                  class={`rounded-lg border px-2 py-2 text-sm font-semibold ${
                    scope() === option.tier
                      ? "border-orange-500 bg-orange-600 text-white"
                      : "border-gray-300 bg-white hover:bg-orange-50 dark:border-gray-600 dark:bg-gray-800 dark:hover:bg-gray-700"
                  }`}
                >
                  {option.emoji} {tierLabel(option.tier)}
                </button>
              )}
            </For>
          </div>
          <div class="mb-3 flex items-center justify-between gap-2 text-sm">
            <span class="text-gray-600 dark:text-gray-400">
              {tierHint(scope())}
            </span>
            <button
              onclick={() =>
                changeView({
                  sort: sort() === "recent" ? "closeness" : "recent",
                })
              }
              class="shrink-0 rounded border border-gray-300 px-2 py-1 hover:bg-gray-100 dark:border-gray-600 dark:hover:bg-gray-700"
            >
              {sort() === "recent" ? t("tracker.newest") : t("tracker.closest")}
            </button>
          </div>

          {/* Bubble computation progress */}
          <Show when={computing()}>
            {(status) => (
              <div class="mb-3 rounded-lg border border-purple-300 bg-purple-50 p-3 text-sm dark:border-purple-700 dark:bg-purple-900/30">
                <div class="mb-2">
                  {t("bubble.computing", {
                    done: status().done,
                    total: status().total,
                  })}
                  <Show when={!status().previous}>
                    {t("bubble.followsOnly")}
                  </Show>
                </div>
                <div class="h-2 w-full overflow-hidden rounded bg-purple-200 dark:bg-purple-800">
                  <div
                    class="h-2 bg-purple-600 transition-all"
                    style={{
                      width: `${status().total ? Math.round((status().done / status().total) * 100) : 0}%`,
                    }}
                  />
                </div>
              </div>
            )}
          </Show>
          <Show when={bubble()?.state === "failed"}>
            <div class="mb-3 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-700 dark:bg-red-900/30 dark:text-red-200">
              {t("bubble.failed")}
            </div>
          </Show>

          <Show
            when={changes().length > 0}
            fallback={
              <div class="rounded-lg border border-gray-300 bg-gray-50 p-4 text-center text-gray-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">
                {disconnected()
                  ? t("tracker.disconnected")
                  : t("tracker.empty")}
              </div>
            }
          >
            <div class="mb-3 flex items-baseline justify-between gap-2">
              <h3 class="text-xl font-bold">
                {t("tracker.heading", { count: changes().length })}
              </h3>
              <span class="text-xs text-gray-500" aria-live="polite">
                {updatedText()}
              </span>
            </div>
            <div class="mb-4 space-y-3">
              <For each={changes().slice(0, visibleCount())}>
                {(change) => (
                  <ChangeCard
                    change={change}
                    handle={handleOf.get(change.did)}
                    expanded={expanded() === change.did}
                    history={history().get(change.did)}
                    onToggle={() => toggleHistory(change.did)}
                    highlight={highlighted().has(change.id)}
                  />
                )}
              </For>
            </div>
            <Show when={changes().length > visibleCount()}>
              <div class="text-center">
                <button
                  onclick={() => setVisibleCount((n) => n + PAGE_SIZE)}
                  class="rounded bg-orange-600 px-6 py-2 text-sm font-bold text-white hover:bg-orange-700"
                >
                  {t("tracker.loadMore", {
                    count: changes().length - visibleCount(),
                  })}
                </button>
              </div>
            </Show>
          </Show>
        </div>
      </Show>
    </div>
  );
};
