/**
 * Spooktober Tracker Component
 * The backend tracks the whole network 24/7; this view shows the results.
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
import { formatGermanDateTime } from "./utils/date-formatter";
import { TIER_OPTIONS, tierEmoji, type Tier } from "./utils/tiers";
import { showError, showSuccess } from "./utils/toast-helpers";

/**
 * Props required to render the tracker for the signed-in user.
 *
 * @property {{ did: string; handle: string }[]} follows Accounts the user follows, with handles.
 * @property {() => Promise<void> | void} [onLogout] Optional logout routine provided by parent (App) to terminate session.
 */
interface Props {
  follows: { did: string; handle: string }[];
  onLogout?: () => Promise<void> | void;
}

/**
 * Render the tracker interface: changes among the user's follows and bubble.
 *
 * @param props.follows List of follow records of the signed-in user.
 * @returns JSX Fragment for the tracker.
 */
export const SpooktoberTracker = (props: Props) => {
  // True while the "changes of my follows" view is shown
  const [monitoringEnabled, setMonitoringEnabled] = createSignal(false);
  const [changes, setChanges] = createSignal<ProfileChange[]>([]);
  // How far into the bubble the list reaches, and its order
  const [scope, setScope] = createSignal<Tier>("bubble");
  const [sort, setSort] = createSignal<"recent" | "closeness">("recent");
  const [bubble, setBubble] = createSignal<BubbleStatus | null>(null);
  const [isLoadingChanges, setIsLoadingChanges] = createSignal(false);
  const [expandedDID, setExpandedDID] = createSignal<string | null>(null);
  const [history, setHistory] = createSignal<Map<string, ProfileChange[]>>(
    new Map(),
  );

  // Controls "Delete all my data" confirmation UI
  const [showDeleteConfirmation, setShowDeleteConfirmation] =
    createSignal(false);

  // Tracks purge request progress (disables buttons while deleting)
  const [isDeleting, setIsDeleting] = createSignal(false);
  const [secondsUntilRefresh, setSecondsUntilRefresh] = createSignal(30);
  const [serverDisconnected, setServerDisconnected] = createSignal(false);
  const [autoRefreshActive, setAutoRefreshActive] = createSignal(false);
  const [visibleCount, setVisibleCount] = createSignal(50);

  // Pagination
  const ITEMS_PER_PAGE = 50;

  // Intervals for periodic data refresh and countdown display
  let refreshInterval: number | null = null;
  let countdownInterval: number | null = null;
  // Polls the bubble computation progress
  let bubblePoll: number | null = null;

  // Delete all user data (stop monitoring, purge DB rows)
  const requestDeleteAllData = () => setShowDeleteConfirmation(true);
  const cancelDeleteAllData = () => setShowDeleteConfirmation(false);
  const confirmDeleteAllData = async () => {
    setIsDeleting(true);
    try {
      const result = await purgeMyData();
      setMonitoringEnabled(false);
      setChanges([]);
      showSuccess(
        `Deleted your data${result.deletedChanges ? ` (${result.deletedChanges} change(s))` : ""}`,
        { duration: 4000 },
      );

      // Prefer the parent-provided logout routine to ensure consistent sign-out
      if (props.onLogout) {
        await props.onLogout();
      }
    } catch (err) {
      // Log unexpected errors and inform the user via toast
      console.error(err);
      showError("Failed to delete your data");
    } finally {
      // Always reset deletion state and close the confirmation dialog
      setIsDeleting(false);
      setShowDeleteConfirmation(false);
    }
  };

  /**
   * Deduplicate profile changes by DID, keeping only the latest change with old values.
   *
   * @param changes - Array of profile changes to deduplicate.
   * @returns Array of deduplicated changes.
   */
  const deduplicateChanges = (changes: ProfileChange[]): ProfileChange[] => {
    // Track the most recent qualifying change per DID
    const latestByDID = new Map<string, ProfileChange>();

    // Walk all changes and keep only those with an old value (a real change)
    changes.forEach((change) => {
      if (change.old_display_name || change.old_avatar || change.old_handle) {
        // Check the previously kept change for this DID
        const existing = latestByDID.get(change.did);

        // Keep if first occurrence or if this change is newer
        if (
          !existing ||
          new Date(change.changed_at) > new Date(existing.changed_at)
        ) {
          latestByDID.set(change.did, change);
        }
      }
    });
    // Return the deduplicated set ordered by map insertion
    return Array.from(latestByDID.values());
  };

  /**
   * Retrieve latest monitored changes for current user.
   *
   * @returns Promise resolving after the latest change snapshot is stored.
   */
  const loadChanges = async () => {
    setIsLoadingChanges(true);

    // Watch for changes
    try {
      const result = await getMyChanges(scope(), sort());

      // Server is connected
      setServerDisconnected(false);

      // Follow the bubble computation until it is ready
      setBubble(result.bubble);
      if (result.bubble?.state === "computing") startBubblePoll();

      // Group by DID and keep only latest change with old values
      const deduplicated = deduplicateChanges(result.changes);

      // Set changes
      setChanges(deduplicated);

      // Reload history for currently expanded DID, invalidate all others
      const currentlyExpanded = expandedDID();
      if (currentlyExpanded) {
        try {
          const changeHistory = await getChangeHistory(currentlyExpanded);
          // Keep only the refreshed history for the expanded DID
          const newMap = new Map();
          newMap.set(currentlyExpanded, changeHistory);
          setHistory(newMap);
        } catch (error) {
          console.error(
            `Failed to reload history for ${currentlyExpanded}:`,
            error,
          );
          // On error, just clear the history to avoid showing stale data
          setHistory(new Map());
        }
      } else {
        // No DID is expanded, clear all cached history
        setHistory(new Map());
      }
    } catch (err) {
      // Mark server as disconnected
      setServerDisconnected(true);
      // Stop auto-refresh if server is down
      stopAutoRefresh();
      // Inform the user about the lost connection and suggest next steps
      showError(
        "Connection lost. Please check your internet connection and refresh the page.",
        {
          duration: 6000,
        },
      );
    } finally {
      // Always clear the loading flag when leaving this routine
      setIsLoadingChanges(false);
    }
  };

  /**
   * Expand or collapse change history for a given DID, fetching on demand.
   *
   * @param did DID whose history should be toggled.
   * @returns Promise that resolves once any required history fetch completes.
   */
  const toggleHistory = async (did: string) => {
    if (expandedDID() === did) {
      setExpandedDID(null);
    } else {
      setExpandedDID(did);

      // Fetch history if not already loaded
      if (!history().has(did)) {
        try {
          const changeHistory = await getChangeHistory(did);
          setHistory((prev) => {
            const newMap = new Map(prev);
            newMap.set(did, changeHistory);
            return newMap;
          });
        } catch (error) {
          console.error(`Failed to load history for ${did}:`, error);
        }
      }
    }
  };

  /**
   * Reset view state to initial screen while keeping monitoring flag.
   *
   * @returns void
   */
  const reset = () => {
    stopAutoRefresh(); // Stop auto-refresh when going back
    stopBubblePoll();
    setMonitoringEnabled(false);
    setChanges([]);
    setHistory(new Map());
    setExpandedDID(null);
    setVisibleCount(50); // Reset visible count
  };

  // Load more helpers
  const visibleChanges = () => changes().slice(0, visibleCount());
  const hasMore = () => changes().length > visibleCount();
  const loadMore = () => setVisibleCount(visibleCount() + ITEMS_PER_PAGE);

  /**
   * Begin auto-refresh loop that keeps monitored changes up to date.
   *
   * @returns void
   */
  const startAutoRefresh = () => {
    // Clear any existing intervals
    if (refreshInterval) clearInterval(refreshInterval);
    if (countdownInterval) clearInterval(countdownInterval);

    // Reset countdown
    setSecondsUntilRefresh(30);
    setAutoRefreshActive(true);

    // Countdown timer (every second)
    countdownInterval = window.setInterval(() => {
      setSecondsUntilRefresh((prev) => {
        if (prev <= 1) {
          return 30; // Reset to 30 when it hits 0
        }
        return prev - 1;
      });
    }, 1000);

    // Refresh data every 30 seconds
    refreshInterval = window.setInterval(() => {
      loadChanges();
    }, 30000);
  };

  /**
   * Tear down auto-refresh intervals.
   *
   * @returns void
   */
  const stopAutoRefresh = () => {
    // Refresh
    if (refreshInterval) {
      clearInterval(refreshInterval);
      refreshInterval = null;
    }

    // Countdown
    if (countdownInterval) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }
    setAutoRefreshActive(false);
  };

  /**
   * Poll the bubble computation and reload the list once it is done.
   *
   * @returns void
   */
  const startBubblePoll = () => {
    if (bubblePoll) return;
    bubblePoll = window.setInterval(async () => {
      try {
        const status = await getBubbleStatus();
        setBubble(status);
        if (status.state !== "computing") {
          stopBubblePoll();
          if (status.state === "ready") await loadChanges();
        }
      } catch {
        stopBubblePoll();
      }
    }, 2000);
  };

  const stopBubblePoll = () => {
    if (bubblePoll) clearInterval(bubblePoll);
    bubblePoll = null;
  };

  /**
   * Switch the scope or order and reload the list.
   */
  const changeView = async (next: {
    scope?: Tier;
    sort?: "recent" | "closeness";
  }) => {
    if (next.scope) setScope(next.scope);
    if (next.sort) setSort(next.sort);
    setVisibleCount(ITEMS_PER_PAGE);
    await loadChanges();
  };

  /**
   * Jump directly into change view when monitoring already active.
   *
   * @returns Promise resolving after change data is loaded.
   */
  const viewChanges = async () => {
    await loadChanges(); // Load changes first
    setMonitoringEnabled(true); // Then switch UI
    startAutoRefresh(); // Start auto-refresh when viewing changes
  };

  // Cleanup intervals on component unmount
  onCleanup(() => {
    stopAutoRefresh();
    stopBubblePoll();
  });

  // JSX Frontend
  return (
    <div class="mt-6 w-full overflow-hidden">
      {/* Initial State - Enable Monitoring or View Changes Button */}
      <Show when={!monitoringEnabled()}>
        <div class="mb-4">
          <button
            onclick={viewChanges}
            disabled={props.follows.length === 0 || isLoadingChanges()}
            class="w-full rounded bg-orange-600 px-4 py-3 font-bold text-white hover:bg-orange-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isLoadingChanges()
              ? "Loading Changes..."
              : props.follows.length === 0
                ? "You don't follow anyone yet"
                : "🎃 View Spooky Changes"}
          </button>

          {/* Delete confirmation shown directly above the delete button */}
          <Show when={showDeleteConfirmation()}>
            <div class="mt-4 rounded-lg border border-red-400 bg-red-50 p-4 dark:border-red-600 dark:bg-red-900/20">
              <h3 class="mb-2 font-bold text-red-800 dark:text-red-300">
                ⚠️ Delete all your data?
              </h3>
              <p class="mb-4 text-sm text-red-700 dark:text-red-400">
                This removes your own profile change history from the community
                database and logs you out. This action cannot be undone.
              </p>
              <div class="flex flex-col gap-2 sm:flex-row">
                <button
                  onclick={confirmDeleteAllData}
                  disabled={isDeleting()}
                  class="flex-1 rounded bg-red-700 px-4 py-2 font-bold text-white hover:bg-red-800 disabled:opacity-50"
                >
                  {isDeleting() ? "Deleting..." : "Yes, delete all my data"}
                </button>
                <button
                  onclick={cancelDeleteAllData}
                  disabled={isDeleting()}
                  class="flex-1 rounded bg-gray-600 px-4 py-2 font-bold text-white hover:bg-gray-700 disabled:opacity-50"
                >
                  Cancel
                </button>
              </div>
            </div>
          </Show>

          {/* Purge button directly under the CTA */}
          <button
            onclick={requestDeleteAllData}
            class="mt-4 w-full rounded bg-red-600 px-4 py-3 font-bold text-white hover:bg-red-700"
          >
            Delete all my data
          </button>
        </div>
      </Show>

      {/* Monitoring Enabled - Show Changes */}
      <Show when={monitoringEnabled()}>
        <div class="mb-4">
          {/* Auto-Refresh Timer */}
          <Show when={autoRefreshActive()}>
            <div class="mb-3 rounded-lg border border-blue-200 bg-blue-50 p-2 text-center text-sm dark:border-blue-700 dark:bg-blue-900/20">
              <span class="text-blue-700 dark:text-blue-300">
                🔄 Auto-refresh in {secondsUntilRefresh()}s
              </span>
            </div>
          </Show>

          {/* Action Buttons */}
          <div class="mb-4">
            <button
              onclick={reset}
              class="w-full rounded bg-red-600 px-4 py-2 font-bold text-white hover:bg-red-700"
            >
              Back
            </button>
          </div>

          {/* Scope selector: how far into the bubble */}
          <div class="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <For each={TIER_OPTIONS}>
              {(option) => (
                <button
                  onclick={() => changeView({ scope: option.tier })}
                  title={option.hint}
                  aria-pressed={scope() === option.tier}
                  class={`rounded-lg border px-2 py-2 text-sm font-semibold ${
                    scope() === option.tier
                      ? "border-orange-500 bg-orange-600 text-white"
                      : "border-gray-300 bg-white hover:bg-orange-50 dark:border-gray-600 dark:bg-gray-800 dark:hover:bg-gray-700"
                  }`}
                >
                  {option.emoji} {option.label}
                </button>
              )}
            </For>
          </div>
          <div class="mb-3 flex items-center justify-between gap-2 text-sm">
            <span class="text-gray-600 dark:text-gray-400">
              {TIER_OPTIONS.find((o) => o.tier === scope())?.hint}
            </span>
            <button
              onclick={() =>
                changeView({
                  sort: sort() === "recent" ? "closeness" : "recent",
                })
              }
              class="shrink-0 rounded border border-gray-300 px-2 py-1 hover:bg-gray-100 dark:border-gray-600 dark:hover:bg-gray-700"
            >
              {sort() === "recent" ? "🕒 Newest first" : "🫂 Closest first"}
            </button>
          </div>

          {/* Bubble computation progress */}
          <Show when={bubble()?.state === "computing" && bubble()}>
            {(status) => {
              const computing = () =>
                status() as Extract<BubbleStatus, { state: "computing" }>;
              const percent = () =>
                computing().total
                  ? Math.round((computing().done / computing().total) * 100)
                  : 0;
              return (
                <div class="mb-3 rounded-lg border border-purple-300 bg-purple-50 p-3 text-sm dark:border-purple-700 dark:bg-purple-900/30">
                  <div class="mb-2">
                    👻 Mapping your bubble… {computing().done} /{" "}
                    {computing().total} follows checked
                    <Show when={!computing().previous}>
                      {" "}
                      - showing your follows until it is done.
                    </Show>
                  </div>
                  <div class="h-2 w-full overflow-hidden rounded bg-purple-200 dark:bg-purple-800">
                    <div
                      class="h-2 bg-purple-600 transition-all"
                      style={{ width: `${percent()}%` }}
                    />
                  </div>
                </div>
              );
            }}
          </Show>
          <Show when={bubble()?.state === "failed"}>
            <div class="mb-3 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-700 dark:bg-red-900/30 dark:text-red-200">
              Could not map your bubble right now - showing your follows only.
            </div>
          </Show>

          {/* Changes Display */}
          <Show
            when={changes().length > 0 || isLoadingChanges()}
            fallback={
              <div class="rounded-lg border border-gray-300 bg-gray-50 p-4 text-center dark:border-gray-700 dark:bg-gray-800">
                <Show
                  when={!serverDisconnected()}
                  fallback={
                    <p class="text-red-600 dark:text-red-400">
                      ⚠️ Server disconnected. Unable to check for changes.
                    </p>
                  }
                >
                  <p class="text-gray-600 dark:text-gray-400">
                    No changes here yet. The whole network is tracked 24/7 -
                    check back later!
                  </p>
                </Show>
              </div>
            }
          >
            <h3 class="mb-3 text-xl font-bold">
              🎃 Detected Changes ({changes().length})
            </h3>
            <div class="mb-4 space-y-3">
              <For each={visibleChanges()}>
                {(change) => {
                  const follow = props.follows.find(
                    (f) => f.did === change.did,
                  );
                  const isExpanded = () => expandedDID() === change.did;
                  const changeHistory = () => history().get(change.did) || [];

                  return (
                    <div class="w-full min-w-0 rounded-lg border border-orange-300 bg-orange-50 dark:border-orange-700 dark:bg-orange-900/20">
                      <div
                        class="cursor-pointer p-4"
                        onclick={() => toggleHistory(change.did)}
                      >
                        <div class="mb-2 flex min-w-0 items-center justify-between gap-2">
                          <span class="break-all font-bold">
                            {tierEmoji(change.tier)}{" "}
                            {follow?.handle || change.handle
                              ? `@${follow?.handle || change.handle}`
                              : change.did}
                          </span>
                          <span class="text-sm text-gray-500">
                            {isExpanded() ? "▼" : "▶"}
                          </span>
                        </div>
                        <Show when={change.common_follows}>
                          {(count) => (
                            <div class="mb-2 text-xs text-gray-600 dark:text-gray-400">
                              followed by {count()} of your follows
                            </div>
                          )}
                        </Show>

                        {/* Handle Change */}
                        <Show
                          when={
                            change.old_handle &&
                            change.old_handle !== change.new_handle
                          }
                        >
                          <div class="mb-1">
                            <span class="text-sm text-gray-600 dark:text-gray-400">
                              Handle changed:
                            </span>
                            <div class="ml-2">
                              <div class="text-gray-500 line-through">
                                @{change.old_handle}
                              </div>
                              <div class="font-semibold text-orange-700 dark:text-orange-400">
                                @{change.new_handle}
                              </div>
                            </div>
                          </div>
                        </Show>

                        {/* DisplayName Change */}
                        <Show
                          when={
                            change.old_display_name &&
                            change.old_display_name !== change.new_display_name
                          }
                        >
                          <div class="mb-1">
                            <span class="text-sm text-gray-600 dark:text-gray-400">
                              DisplayName changed:
                            </span>
                            <div class="ml-2">
                              <div class="text-gray-500 line-through">
                                {change.old_display_name}
                              </div>
                              <div class="font-semibold text-orange-700 dark:text-orange-400">
                                {change.new_display_name}
                              </div>
                            </div>
                          </div>
                        </Show>

                        {/* Avatar Change */}
                        <Show
                          when={
                            change.old_avatar &&
                            change.old_avatar !== change.new_avatar
                          }
                        >
                          <div class="mb-1">
                            <span class="text-sm text-gray-600 dark:text-gray-400">
                              Avatar changed 🖼️
                            </span>
                            <Show when={change.new_avatar}>
                              <img
                                src={`https://cdn.bsky.app/img/avatar/plain/${change.did}/${change.new_avatar}@jpeg`}
                                alt="New avatar"
                                class="mt-1 h-16 w-16 rounded-full border-2 border-orange-400"
                              />
                            </Show>
                          </div>
                        </Show>

                        {/* Timestamp */}
                        <div class="mt-2 text-xs text-gray-500">
                          {formatGermanDateTime(
                            change.changed_at,
                            "short",
                            "medium",
                          )}
                        </div>
                      </div>

                      {/* History expansion */}
                      <Show when={isExpanded()}>
                        <div class="border-t border-orange-200 bg-orange-100/50 p-4 dark:border-orange-600 dark:bg-orange-900/10">
                          <h4 class="mb-2 text-sm font-bold text-orange-800 dark:text-orange-300">
                            Change History
                          </h4>
                          <Show
                            when={changeHistory().length > 0}
                            fallback={
                              <p class="text-sm text-gray-500">
                                Loading history...
                              </p>
                            }
                          >
                            <div class="space-y-2">
                              <For
                                each={changeHistory().filter(
                                  (h) =>
                                    h.old_display_name ||
                                    h.old_avatar ||
                                    h.old_handle,
                                )}
                              >
                                {(historyItem) => (
                                  <div class="rounded border border-orange-200 bg-white p-2 text-xs dark:border-orange-600 dark:bg-gray-800">
                                    <div class="mb-1 text-gray-500">
                                      {formatGermanDateTime(
                                        historyItem.changed_at,
                                        "short",
                                        "medium",
                                      )}
                                    </div>
                                    <Show
                                      when={
                                        historyItem.old_handle &&
                                        historyItem.old_handle !==
                                          historyItem.new_handle
                                      }
                                    >
                                      <div>
                                        <span class="font-semibold">
                                          Handle:
                                        </span>{" "}
                                        <span class="line-through">
                                          @{historyItem.old_handle}
                                        </span>{" "}
                                        → @{historyItem.new_handle}
                                      </div>
                                    </Show>
                                    <Show
                                      when={
                                        historyItem.old_display_name &&
                                        historyItem.old_display_name !==
                                          historyItem.new_display_name
                                      }
                                    >
                                      <div>
                                        <span class="font-semibold">
                                          DisplayName:
                                        </span>{" "}
                                        <span class="line-through">
                                          {historyItem.old_display_name}
                                        </span>{" "}
                                        → {historyItem.new_display_name}
                                      </div>
                                    </Show>
                                    <Show
                                      when={
                                        historyItem.old_avatar &&
                                        historyItem.old_avatar !==
                                          historyItem.new_avatar
                                      }
                                    >
                                      <div>
                                        <span class="font-semibold">
                                          Avatar:
                                        </span>{" "}
                                        changed
                                      </div>
                                    </Show>
                                  </div>
                                )}
                              </For>
                            </div>
                          </Show>
                        </div>
                      </Show>
                    </div>
                  );
                }}
              </For>
            </div>

            {/* Load More Button */}
            <Show when={hasMore()}>
              <div class="text-center">
                <button
                  onclick={loadMore}
                  class="rounded bg-orange-600 px-6 py-2 text-sm font-bold text-white hover:bg-orange-700"
                >
                  Load More ({changes().length - visibleCount()} remaining)
                </button>
              </div>
            </Show>
          </Show>
        </div>
      </Show>
    </div>
  );
};
