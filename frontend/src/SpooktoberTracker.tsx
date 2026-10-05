/**
 * Spooktober Tracker Component
 * The backend tracks the whole network 24/7; this view shows the results.
 */

import { createSignal, For, onCleanup, Show } from "solid-js";
import type { ProfileChange } from "../../shared/types";
import {
  getChangeHistory,
  getGlobalChanges,
  getMyChanges,
  purgeMyData,
} from "./api";
import { formatGermanDateTime } from "./utils/date-formatter";
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
 * Render the tracker interface: known changes and changes among the user's follows.
 *
 * @param props.follows List of follow records of the signed-in user.
 * @returns JSX Fragment for the tracker.
 */
export const SpooktoberTracker = (props: Props) => {
  // True while the "changes of my follows" view is shown
  const [monitoringEnabled, setMonitoringEnabled] = createSignal(false);
  const [changes, setChanges] = createSignal<ProfileChange[]>([]);
  const [knownChangesLoaded, setKnownChangesLoaded] = createSignal(false);
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

  // Delete all user data (stop monitoring, purge DB rows)
  const requestDeleteAllData = () => setShowDeleteConfirmation(true);
  const cancelDeleteAllData = () => setShowDeleteConfirmation(false);
  const confirmDeleteAllData = async () => {
    setIsDeleting(true);
    try {
      const result = await purgeMyData();
      setMonitoringEnabled(false);
      setChanges([]);
      setKnownChangesLoaded(false);
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
   * Load known changes from the global community cache.
   *
   * @returns Promise resolving after changes state has been updated.
   */
  const loadKnownChanges = async () => {
    setIsLoadingChanges(true);

    // Group by DID and keep only latest change with old values
    try {
      const globalChanges = await getGlobalChanges();
      const deduplicated = deduplicateChanges(globalChanges);

      // Commit the deduplicated change set into local state.
      setChanges(deduplicated);

      // Invalidate cached history to ensure fresh data on next expand
      setHistory(new Map());

      // Mark known changes as loaded to toggle UI state
      setKnownChangesLoaded(true);
    } catch (err) {
      showError(
        err instanceof Error
          ? err.message
          : "Could not load profile changes. Please try again.",
        { duration: 5000 },
      );

      // Always clear the loading flag regardless of outcome.
    } finally {
      setIsLoadingChanges(false);
    }
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
      const monitoredChanges = await getMyChanges();

      // Server is connected
      setServerDisconnected(false);

      // Group by DID and keep only latest change with old values
      const deduplicated = deduplicateChanges(monitoredChanges);

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
    setMonitoringEnabled(false);
    setKnownChangesLoaded(false);
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
  });

  // JSX Frontend
  return (
    <div class="mt-6 w-full overflow-hidden">
      {/* Load Known Changes Button */}
      <Show when={!knownChangesLoaded() && !monitoringEnabled()}>
        <button
          onclick={loadKnownChanges}
          disabled={props.follows.length === 0 || isLoadingChanges()}
          class="mb-4 w-full rounded-lg bg-purple-600 px-4 py-3 text-base font-bold text-white hover:bg-purple-700 active:bg-purple-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isLoadingChanges()
            ? "Loading..."
            : props.follows.length === 0
              ? "No Follows to Load Changes For"
              : "Load Known Spooktober Changes"}
        </button>
      </Show>

      {/* Delete confirmation is colocated near the delete button in the initial section */}
      {/* Known Changes Display */}
      <Show when={knownChangesLoaded() && !monitoringEnabled()}>
        <div class="mb-4">
          <Show when={changes().length > 0}>
            <h3 class="mb-3 text-lg font-bold sm:text-xl">
              📚 Known Changes ({changes().length})
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
                    <div class="w-full min-w-0 rounded-lg border border-purple-300 bg-purple-50 dark:border-purple-700 dark:bg-purple-900/20">
                      <div
                        class="cursor-pointer p-4"
                        onclick={() => toggleHistory(change.did)}
                      >
                        <div class="flex min-w-0 items-center justify-between gap-2">
                          <span class="break-all font-bold">
                            @
                            {follow?.handle ||
                              change.handle ||
                              change.did.slice(0, 20) + "..."}
                          </span>
                          <span class="text-sm text-gray-500">
                            {isExpanded() ? "▼" : "▶"}
                          </span>
                        </div>
                      </div>

                      {/* History expansion */}
                      <Show when={isExpanded()}>
                        <div class="border-t border-purple-200 bg-purple-100/50 p-4 dark:border-purple-600 dark:bg-purple-900/10">
                          <h4 class="mb-2 text-sm font-bold text-purple-800 dark:text-purple-300">
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
                                  <div class="rounded border border-purple-200 bg-white p-2 text-xs dark:border-purple-600 dark:bg-gray-800">
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
              <div class="mb-4 text-center">
                <button
                  onclick={loadMore}
                  class="rounded bg-purple-600 px-6 py-2 text-sm font-bold text-white hover:bg-purple-700"
                >
                  Load More ({changes().length - visibleCount()} remaining)
                </button>
              </div>
            </Show>
          </Show>

          {/* Empty state when no known changes are available */}
          <Show when={changes().length === 0}>
            <div class="mb-4 rounded-lg border border-purple-400 bg-purple-50 p-4 dark:border-purple-600 dark:bg-purple-900/20">
              <p class="text-sm text-purple-700 dark:text-purple-400">
                No known changes found in database yet. Start checking to
                populate the database!
              </p>
            </div>
          </Show>

          {/* Back button: reset view to initial state */}
          <button
            onclick={reset}
            class="w-full rounded bg-red-600 px-4 py-3 font-bold text-white hover:bg-red-700"
          >
            Back
          </button>
        </div>
      </Show>

      {/* Initial State - Enable Monitoring or View Changes Button */}
      <Show when={!monitoringEnabled() && !knownChangesLoaded()}>
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
                : `🎃 View Changes of Your ${props.follows.length} Follows`}
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
                    No changes among your follows yet. The whole network is
                    tracked 24/7 - check back later!
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
                            @
                            {follow?.handle ||
                              change.handle ||
                              change.did.slice(0, 20) + "..."}
                          </span>
                          <span class="text-sm text-gray-500">
                            {isExpanded() ? "▼" : "▶"}
                          </span>
                        </div>

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
