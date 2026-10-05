/**
 * Admin-only dashboard for inspecting Jetstream status, ignored users,
 * and issuing maintenance actions such as reconnecting streams.
 */

import { createSignal, For, onMount, Show } from "solid-js";
import toast from "solid-toast";
import {
  addIgnoredUser,
  getAdminStats,
  getIgnoredUsers,
  getRecommendedStartCursor,
  removeIgnoredUser,
  startJetstream,
  stopJetstream,
} from "./api";
import { formatGermanDateTime } from "./utils/date-formatter";
import { ENV } from "./utils/env";
import { showError, showSuccess } from "./utils/toast-helpers";

/**
 * Renders the privileged dashboard for monitoring Jetstream state and
 * performing maintenance actions against the backend.
 *
 * @returns JSX element containing admin controls and live status panels.
 */
export const AdminPanel = () => {
  const [stats, setStats] = createSignal<{
    totalMonitoredDIDs: number;
    jetstreamStatus: string;
    cursorTimestamp: string | null;
    uptimeSeconds: number | null;
    isInBackfill: boolean;
  } | null>(null);

  /**
   * Reactive signals for uptime, connection lifecycle, and view toggles.
   *
   * - uptime: Formatted uptime string (e.g., "1h 2m 3s").
   * - uptimeBaseSeconds: Server‑reported uptime seconds at last refresh.
   * - uptimeBaseTime: Local timestamp (ms) when the baseline was captured.
   * - isStopping: Loading state while stopping Jetstream.
   * - isStarting: Loading state while starting Jetstream.
   * - showStartModal: Visibility toggle for the start‑Jetstream modal.
   * - startCursor: Cursor input (µs) to start Jetstream from.
   * - showIgnoredUsersView: Toggle for ignored‑users management view.
   * - ignoredUsers: List of ignored DIDs with metadata for the UI.
   * - newIgnoredDID: Input value to add an ignored DID.
   * - isAddingIgnored: Loading state while adding an ignored DID.
   * - cursorTimestamp: Latest Jetstream cursor timestamp (ISO).
   */
  const [uptime, setUptime] = createSignal<string>("0s");
  const [uptimeBaseSeconds, setUptimeBaseSeconds] = createSignal<number>(0);
  const [uptimeBaseTime, setUptimeBaseTime] = createSignal<number>(Date.now());
  const [isStopping, setIsStopping] = createSignal(false);
  const [isStarting, setIsStarting] = createSignal(false);
  const [showStartModal, setShowStartModal] = createSignal(false);
  const [startCursor, setStartCursor] = createSignal("");
  const [showIgnoredUsersView, setShowIgnoredUsersView] = createSignal(false);
  const [ignoredUsers, setIgnoredUsers] = createSignal<
    { did: string; added_at: string; handle: string | null }[]
  >([]);
  const [newIgnoredDID, setNewIgnoredDID] = createSignal("");
  const [isAddingIgnored, setIsAddingIgnored] = createSignal(false);
  const [cursorTimestamp, setCursorTimestamp] = createSignal<string | null>(
    null,
  );
  // Track WebSocket connection and reconnection bookkeeping state.
  let ws: WebSocket | null = null;
  let reconnectAttempts = 0;
  let reconnectTimeout: number | null = null;
  let lastActivationAt = 0; // pageshow/visibility activation timestamp
  let suppressToastsUntil = 0; // absolute timestamp to suppress notifications
  const activationGraceMs = 3000; // suppress noisy toasts right after activation

  // Mark activation and set a short grace period to suppress noisy toasts
  const setActivationWindow = () => {
    lastActivationAt = Date.now();
    suppressToastsUntil = lastActivationAt + activationGraceMs;
  };

  // Only notify when the page is visible and we're past the grace window
  const canNotify = () =>
    document.visibilityState === "visible" && Date.now() >= suppressToastsUntil;

  /**
   * Convert seconds into a condensed uptime string (e.g. 1h 2m 3s).
   *
   * @param seconds Duration in seconds.
   * @returns Human readable uptime representation.
   */
  const formatUptime = (seconds: number): string => {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    // Human readable
    if (days > 0) return `${days}d ${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h ${minutes}m ${secs}s`;
    if (minutes > 0) return `${minutes}m ${secs}s`;
    return `${secs}s`;
  };

  /**
   * Retrieve admin stats and merge them with existing reactive state.
   *
   * @returns Promise resolving after the stats signals are updated.
   */
  const loadStats = async () => {
    try {
      // Load stats
      const data = await getAdminStats();

      // Merge with existing stats to preserve WebSocket-updated cursor info.
      const previous = stats();
      const previousCursor = previous?.cursorTimestamp ?? null;
      const nextCursor = data.cursorTimestamp ?? null;
      let cursorTimestamp: string | null;

      // Keep the most recent cursor timestamp to avoid regressing on stale values
      if (previousCursor && nextCursor) {
        cursorTimestamp =
          previousCursor > nextCursor ? previousCursor : nextCursor;
      } else {
        cursorTimestamp = previousCursor ?? nextCursor ?? null;
      }

      // Merge API stats with the resolved cursor timestamp for display
      const merged = {
        totalMonitoredDIDs: data.totalMonitoredDIDs,
        jetstreamStatus: data.jetstreamStatus,
        cursorTimestamp,
        uptimeSeconds: data.uptimeSeconds,
        isInBackfill: data.isInBackfill,
      };

      // Commit merged stats into reactive state
      setStats(merged);

      // Update uptime base for live counting
      if (data.uptimeSeconds !== null) {
        setUptimeBaseSeconds(data.uptimeSeconds);
        setUptimeBaseTime(Date.now());
        setUptime(formatUptime(data.uptimeSeconds));
      } else {
        // Jetstream stopped - reset uptime display
        setUptime("-");
      }
      setCursorTimestamp(cursorTimestamp);
    } catch (error) {
      console.error("Failed to load admin stats:", error);
    }
  };

  /**
   * Stop Jetstream and show toast feedback.
   *
   * @returns Promise resolving once the stop request finishes.
   */
  const handleStop = async () => {
    setIsStopping(true);
    try {
      const msg = await stopJetstream();
      showSuccess(msg, { duration: 3000 });
      await loadStats();
    } catch (error) {
      console.error("Failed to stop Jetstream:", error);
      showError("Failed to stop Jetstream", { duration: 5000 });
    } finally {
      setIsStopping(false);
    }
  };

  // Open modal for starting Jetstream with cursor selection.
  const openStartModal = async () => {
    try {
      // Get recommended cursor from backend (resumes from stop if <24h, else live)
      const recommendedCursor = await getRecommendedStartCursor();
      setStartCursor(recommendedCursor.toString());
    } catch (error) {
      console.error(
        "Failed to get recommended cursor, using current time:",
        error,
      );

      // Fallback to current time if API call fails
      const nowCursor = Date.now() * 1000;
      setStartCursor(nowCursor.toString());
    }
    setShowStartModal(true);
  };

  // Start Jetstream with selected cursor.
  const handleStart = async () => {
    // Disable submit button while starting
    setIsStarting(true);

    // Parse microsecond cursor from input
    try {
      const cursor = parseInt(startCursor());
      // Validate cursor input
      if (isNaN(cursor)) {
        showError("Invalid cursor value", { duration: 3000 });
        return;
      }

      // Request backend to start Jetstream from the provided cursor
      const msg = await startJetstream(cursor);

      // Inform user and close modal
      showSuccess(msg, { duration: 3000 });
      setShowStartModal(false);

      // Refresh stats after a successful start
      await loadStats();

      // Log error for debugging and surface a toast to the user
    } catch (error) {
      console.error("Failed to start Jetstream:", error);
      showError("Failed to start Jetstream", { duration: 5000 });
    } finally {
      // Re-enable submit button
      setIsStarting(false);
    }
  };

  /**
   * Fetch ignored users list and display the dedicated view.
   *
   * @returns Promise resolving after ignored users have been fetched.
   */
  const loadIgnoredUsers = async () => {
    try {
      const users = await getIgnoredUsers();
      setIgnoredUsers(users);
      setShowIgnoredUsersView(true);
    } catch (error) {
      console.error("Failed to load ignored users:", error);
      showError("Failed to load ignored users", { duration: 5000 });
    }
  };

  /**
   * Validate and submit a DID to the ignore list.
   *
   * @returns Promise resolving once the DID has been processed.
   */
  const handleAddIgnoredUser = async () => {
    const did = newIgnoredDID().trim();
    if (!did) {
      showError("Please enter a DID", { duration: 3000 });
      return;
    }

    // Syntax check
    if (!/^did:(plc|web):/.test(did)) {
      showError("Invalid DID format (must be did:plc:… or did:web:…)", {
        duration: 3000,
      });
      return;
    }

    // Add to ignore listz
    setIsAddingIgnored(true);
    try {
      const result = await addIgnoredUser(did);
      showSuccess(result.message, { duration: 5000 });
      setNewIgnoredDID("");

      // Reload ignored users list
      const users = await getIgnoredUsers();
      setIgnoredUsers(users);
    } catch (error) {
      console.error("Failed to add ignored user:", error);
      showError("Failed to add ignored user", { duration: 5000 });
    } finally {
      setIsAddingIgnored(false);
    }
  };

  /**
   * Remove a DID from the ignore list.
   *
   * @param did DID to un-ignore.
   * @returns Promise resolving once the removal request is complete.
   */
  const handleRemoveIgnoredUser = async (did: string) => {
    try {
      const msg = await removeIgnoredUser(did);
      showSuccess(msg, { duration: 3000 });

      // Reload ignored users list
      const users = await getIgnoredUsers();
      setIgnoredUsers(users);
    } catch (error) {
      console.error("Failed to remove ignored user:", error);
      showError("Failed to remove ignored user", { duration: 5000 });
    }
  };

  /**
   * Establish and maintain a WebSocket for live Jetstream cursor updates.
   *
   * @returns void
   */
  const connectWebSocket = () => {
    // Only attempt to connect when page is visible
    if (document.visibilityState !== "visible") return;

    // Avoid attempts while offline; wait for 'online'
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      // schedule a short retry; online listener will also trigger
      if (!reconnectTimeout) {
        reconnectTimeout = window.setTimeout(connectWebSocket, 1500);
      }
      return;
    }

    // Skip if already open or connecting
    if (
      ws &&
      (ws.readyState === WebSocket.OPEN ||
        ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    // The admin session cookie authenticates the WebSocket upgrade
    const wsUrl = ENV.WS_URL;

    // Clear any existing reconnect timeout
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }

    // Register new WebSocket
    ws = new WebSocket(wsUrl);

    // Connect
    ws.onopen = () => {
      reconnectAttempts = 0; // Reset reconnect attempts on successful connection
      showSuccess("WebSocket connected", { duration: 2000 });
    };

    // Handle events
    ws.onmessage = (event) => {
      try {
        // Decode JSON payload from WebSocket
        const data = JSON.parse(event.data);

        // Cursor update: sync stats and human‑readable timestamp (avoid no‑ops)
        if (data.type === "cursor_update" && data.data?.cursor) {
          const cursorUpdate = data.data.cursor;

          // Update cursor info in stats while keeping existing values when unchanged.
          setStats((prev) => {
            if (!prev) return prev;
            const nextCursor = cursorUpdate.timestamp ?? null;
            const nextInBackfill =
              cursorUpdate.isInBackfill ?? prev.isInBackfill;
            if (
              prev.cursorTimestamp === nextCursor &&
              prev.isInBackfill === nextInBackfill
            ) {
              // No changes detected; keep previous stats to avoid re-render
              return prev;
            }
            return {
              ...prev,
              cursorTimestamp: nextCursor,
              isInBackfill: nextInBackfill,
            };
          });

          // Keep a dedicated display timestamp in parallel
          setCursorTimestamp(cursorUpdate.timestamp ?? null);
        }

        // Keep the socket alive even on malformed messages
      } catch (error) {
        console.error("Failed to parse WebSocket message:", error);
      }
    };

    // Handle connection errors
    ws.onclose = (event) => {
      // Stop trying after 5 attempts
      if (reconnectAttempts >= 5) {
        if (reconnectAttempts === 5 && canNotify()) {
          showError("WebSocket: Max reconnect attempts reached", {
            duration: 5000,
          });
        }
        reconnectAttempts++;
        return;
      }

      // Exponential backoff: 1s, 2s, 4s, 8s, 16s, max 30s
      reconnectAttempts++;
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), 30000);

      // Only notify on first disconnect and when visible (not in grace window)
      const clean =
        event && typeof event === "object" && "wasClean" in event
          ? (event as CloseEvent).wasClean ||
            (event as CloseEvent).code === 1000 ||
            (event as CloseEvent).code === 1001
          : false;
      if (reconnectAttempts === 1 && canNotify() && !clean) {
        toast("WebSocket disconnected, reconnecting...", { duration: 3000 });
      }

      // Set timeout; defer actual connect until page is visible
      const attempt = () => {
        // Skip while tab is hidden; retry shortly
        if (document.visibilityState !== "visible") {
          reconnectTimeout = window.setTimeout(attempt, 1000);
          return;
        }

        // Skip while offline; retry with a slightly longer delay
        if (typeof navigator !== "undefined" && navigator.onLine === false) {
          reconnectTimeout = window.setTimeout(attempt, 1500);
          return;
        }
        // Environment OK: attempt to (re)connect now
        connectWebSocket();
      };

      // Schedule the deferred attempt using computed backoff delay
      reconnectTimeout = window.setTimeout(attempt, delay);
    };

    // Only surface an error toast for the initial connection (not retries)
    ws.onerror = () => {
      if (reconnectAttempts === 0 && canNotify()) {
        showError("WebSocket connection failed", { duration: 3000 });
      }
    };
  };

  // Load stats on mount and connect WebSocket
  onMount(() => {
    loadStats();
    // Track activation and connect only when visible
    const handlePageShow = () => {
      setActivationWindow();

      // Slight delay to let iOS Safari warm up the network stack
      if (document.visibilityState === "visible") {
        window.setTimeout(connectWebSocket, 800);
      }
    };

    // React to tab visibility changes: on visible, reconnect after a short delay;
    // on hidden, extend the toast suppression window to avoid noise
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        setActivationWindow();
        window.setTimeout(connectWebSocket, 200);

        // Hidden: suppress toasts briefly and avoid reconnect storms
      } else {
        suppressToastsUntil = Date.now() + activationGraceMs;
      }
    };

    // iOS Safari bfcache path: close cleanly and suppress toasts
    const handlePageHide = () => {
      suppressToastsUntil = Date.now() + activationGraceMs;
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
      }
      if (ws) {
        try {
          ws.close();
        } catch {}
        ws = null;
      }
    };

    // Attempt reconnect promptly when connectivity returns
    const handleOnline = () => {
      window.setTimeout(connectWebSocket, 100);
    };

    // Close socket and suppress warnings while offline
    const handleOffline = () => {
      suppressToastsUntil = Date.now() + activationGraceMs;
      if (ws) {
        try {
          ws.close();
        } catch {}
        ws = null;
      }
    };

    // Event Listener
    window.addEventListener("pageshow", handlePageShow);
    window.addEventListener("pagehide", handlePageHide);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    // Attempt initial connect if already visible
    handlePageShow();

    // Update uptime display every second (live counter) - only if Jetstream is running
    // Note: Stats (DIDs/users count) are pushed via WebSocket monitoring_status_update
    const uptimeInterval = setInterval(() => {
      if (stats()?.jetstreamStatus === "connected") {
        const elapsedSeconds = Math.floor(
          (Date.now() - uptimeBaseTime()) / 1000,
        );
        const totalUptime = uptimeBaseSeconds() + elapsedSeconds;
        setUptime(formatUptime(totalUptime));
      }
    }, 1000);

    // Tear down interval and socket when unmounting the panel.
    return () => {
      clearInterval(uptimeInterval);
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
      }
      if (ws) {
        ws.close();
      }

      // Event Listener
      window.removeEventListener("pageshow", handlePageShow);
      window.removeEventListener("pagehide", handlePageHide);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  });

  // JSX Frontend
  return (
    <div class="mt-6 w-full">
      <div class="rounded-lg border-2 border-yellow-400 bg-yellow-50 p-4 dark:border-yellow-600 dark:bg-yellow-900/20">
        <h3 class="mb-3 text-lg font-bold text-yellow-800 sm:text-xl dark:text-yellow-300">
          🔧 Admin Panel
        </h3>

        {/* Stats */}
        <Show
          when={stats()}
          fallback={<div class="text-sm">Loading stats...</div>}
        >
          <div class="mb-4 space-y-2 text-xs sm:text-sm">
            <div class="flex justify-between">
              <span class="font-semibold">Tracked Accounts:</span>
              <span>{stats()?.totalMonitoredDIDs.toLocaleString()}</span>
            </div>
            <div class="flex justify-between">
              <span class="font-semibold">Jetstream Status:</span>
              <span
                class={
                  stats()?.jetstreamStatus === "connected"
                    ? "font-bold text-green-600"
                    : stats()?.jetstreamStatus === "disconnected"
                      ? "text-red-500"
                      : "text-gray-500"
                }
              >
                {stats()?.jetstreamStatus === "connected"
                  ? "🟢 Connected"
                  : stats()?.jetstreamStatus === "disconnected"
                    ? "🔴 Disconnected"
                    : "⚪ Unknown"}
              </span>
            </div>
            <div class="flex justify-between">
              <span class="font-semibold">Uptime:</span>
              <span>{uptime()}</span>
            </div>
            <div class="flex justify-between">
              <span class="font-semibold">Last Event:</span>
              <span class="text-xs">
                {stats()?.cursorTimestamp
                  ? formatGermanDateTime(
                      stats()!.cursorTimestamp!,
                      "short",
                      "medium",
                    )
                  : "-"}
              </span>
            </div>
            <Show
              when={
                cursorTimestamp() && stats()?.jetstreamStatus === "connected"
              }
            >
              <div class="mt-3 rounded border border-blue-300 bg-blue-50 p-2 dark:border-blue-700 dark:bg-blue-900/30">
                <div class="text-xs">
                  <span class="font-bold text-blue-800 dark:text-blue-300">
                    📊 Backlog:
                  </span>
                  <Show
                    when={!stats()?.isInBackfill}
                    fallback={
                      <span class="ml-2 font-semibold text-yellow-600 dark:text-yellow-400">
                        Catching up...
                      </span>
                    }
                  >
                    <span class="ml-2 font-semibold text-green-600 dark:text-green-400">
                      Live
                    </span>
                  </Show>
                </div>
              </div>
            </Show>
          </div>
        </Show>

        {/* Actions */}
        <div class="space-y-2">
          {/* Stop/Start Jetstream Button - changes based on status */}
          <button
            onclick={
              stats()?.jetstreamStatus === "connected"
                ? handleStop
                : openStartModal
            }
            disabled={isStopping() || isStarting()}
            class={`w-full rounded-lg px-4 py-3 text-base font-bold text-white disabled:opacity-50 ${
              stats()?.jetstreamStatus === "connected"
                ? "bg-red-600 hover:bg-red-700 active:bg-red-800"
                : "bg-green-600 hover:bg-green-700 active:bg-green-800"
            }`}
          >
            {stats()?.jetstreamStatus === "connected"
              ? isStopping()
                ? "Stopping..."
                : "Stop Jetstream"
              : isStarting()
                ? "Starting..."
                : "Start Jetstream"}
          </button>
          <button
            onclick={loadIgnoredUsers}
            class="w-full rounded-lg bg-blue-600 px-4 py-3 text-base font-bold text-white hover:bg-blue-700 active:bg-blue-800"
          >
            Ignored Users
          </button>
        </div>
      </div>

      {/* Ignored Users View */}
      <Show when={showIgnoredUsersView()}>
        <div class="mt-4 rounded-lg border-2 border-red-400 bg-red-50 p-4 dark:border-red-600 dark:bg-red-900/20">
          <h3 class="mb-3 text-lg font-bold text-red-800 sm:text-xl dark:text-red-300">
            🚫 Ignored Users
          </h3>

          {/* Add New Ignored User */}
          <div class="mb-4 space-y-2">
            <label class="block text-sm font-semibold text-red-800 sm:text-base dark:text-red-300">
              Add DID to Ignore List
            </label>
            <div class="flex flex-col gap-2 sm:flex-row">
              <input
                type="text"
                value={newIgnoredDID()}
                onInput={(e) => setNewIgnoredDID(e.currentTarget.value)}
                placeholder="did:plc:xxxxxxxxxxxxx"
                class="flex-1 rounded-lg border border-red-300 px-3 py-2.5 text-base dark:border-red-700 dark:bg-red-950 dark:text-white"
              />
              <button
                onclick={handleAddIgnoredUser}
                disabled={isAddingIgnored()}
                class="rounded-lg bg-red-600 px-4 py-3 text-base font-bold text-white hover:bg-red-700 active:bg-red-800 disabled:opacity-50 sm:w-auto"
              >
                {isAddingIgnored() ? "Adding..." : "Add"}
              </button>
            </div>
            <p class="text-xs text-red-700 sm:text-sm dark:text-red-400">
              Adding a user will permanently delete all their profile changes
              from the database.
            </p>
          </div>

          {/* Ignored Users List */}
          <div class="mb-4">
            <h4 class="mb-2 text-sm font-semibold text-red-800 dark:text-red-300">
              Currently Ignored ({ignoredUsers().length})
            </h4>
            <div class="max-h-60 space-y-2 overflow-y-auto">
              <Show when={ignoredUsers().length > 0}>
                <For each={ignoredUsers()}>
                  {(user) => (
                    <div class="flex items-center justify-between rounded border border-red-300 bg-white p-2 dark:border-red-700 dark:bg-red-950">
                      <div class="flex-1">
                        <div class="truncate text-sm font-bold">
                          {user.handle ? `@${user.handle}` : user.did}
                        </div>
                        <Show when={user.handle}>
                          <div class="text-xs text-gray-500 dark:text-gray-400">
                            {user.did}
                          </div>
                        </Show>
                        <div class="text-xs text-gray-500 dark:text-gray-400">
                          Added:{" "}
                          {formatGermanDateTime(
                            user.added_at,
                            "short",
                            "medium",
                          )}
                        </div>
                      </div>
                      <button
                        onclick={() => handleRemoveIgnoredUser(user.did)}
                        class="ml-2 rounded bg-green-600 px-3 py-1 text-xs font-bold text-white hover:bg-green-700"
                      >
                        Remove
                      </button>
                    </div>
                  )}
                </For>
              </Show>
              <Show when={ignoredUsers().length === 0}>
                <div class="text-sm text-gray-500">No ignored users</div>
              </Show>
            </div>
          </div>

          {/* Back Button */}
          <button
            onclick={() => setShowIgnoredUsersView(false)}
            class="mt-4 w-full rounded-lg bg-red-600 px-4 py-3 text-base font-bold text-white hover:bg-red-700 active:bg-red-800"
          >
            ← Back
          </button>
        </div>
      </Show>

      {/* Start Jetstream Modal */}
      <Show when={showStartModal()}>
        <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div class="w-full max-w-md rounded-lg bg-white p-6 dark:bg-gray-800">
            <h3 class="mb-4 text-lg font-bold text-gray-900 sm:text-xl dark:text-gray-100">
              Start Jetstream
            </h3>
            <p class="mb-4 text-sm text-gray-600 dark:text-gray-400">
              Set the cursor timestamp (in microseconds) to start from. Default
              is current time (live). Copy from "24h ago" to backfill.
            </p>
            <div class="mb-4">
              <label class="mb-2 block text-sm font-bold text-gray-700 dark:text-gray-300">
                Cursor (microseconds)
              </label>
              <input
                type="text"
                value={startCursor()}
                onInput={(e) => setStartCursor(e.currentTarget.value)}
                class="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-base dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
                placeholder="e.g. 1730000000000000"
              />
              <div class="mt-2 flex justify-between gap-4 text-xs">
                <div class="flex-1">
                  <span class="font-semibold text-gray-700 dark:text-gray-300">
                    Current value:
                  </span>
                  <br />
                  <span class="break-all font-mono text-gray-500 dark:text-gray-400">
                    {startCursor()}
                  </span>
                  <br />
                  <span class="text-[10px] text-gray-400 dark:text-gray-500">
                    {formatGermanDateTime(
                      parseInt(startCursor()) / 1000,
                      "short",
                      "medium",
                    )}
                  </span>
                </div>
                <div class="flex-1 text-right">
                  <span class="font-semibold text-gray-700 dark:text-gray-300">
                    24h ago:
                  </span>
                  <br />
                  <span class="break-all font-mono text-gray-500 dark:text-gray-400">
                    {(() => {
                      const twentyFourHoursAgo =
                        Date.now() - 24 * 60 * 60 * 1000;
                      return (twentyFourHoursAgo * 1000).toString();
                    })()}
                  </span>
                  <br />
                  <span class="text-[10px] text-gray-400 dark:text-gray-500">
                    {(() => {
                      const twentyFourHoursAgo =
                        Date.now() - 24 * 60 * 60 * 1000;
                      return formatGermanDateTime(
                        twentyFourHoursAgo,
                        "short",
                        "medium",
                      );
                    })()}
                  </span>
                </div>
              </div>
            </div>
            <div class="flex flex-col gap-2 sm:flex-row">
              <button
                onclick={handleStart}
                disabled={isStarting()}
                class="flex-1 rounded-lg bg-green-600 px-4 py-3 text-base font-bold text-white hover:bg-green-700 active:bg-green-800 disabled:opacity-50"
              >
                {isStarting() ? "Starting..." : "Connect"}
              </button>
              <button
                onclick={() => setShowStartModal(false)}
                disabled={isStarting()}
                class="flex-1 rounded-lg bg-gray-600 px-4 py-3 text-base font-bold text-white hover:bg-gray-700 active:bg-gray-800 disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
};
