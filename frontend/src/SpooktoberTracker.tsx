/**
 * Spooktober Tracker Component
 * The backend tracks the whole network 24/7; this view shows the changes of
 * the user's follows and, by closeness tier, of their wider network. Right
 * after the first login only the bubble computation is shown, the list
 * appears once it is done.
 */

import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { ProfileChange } from "../../shared/types";
import {
  getBubbleStatus,
  getChangeHistory,
  getMyChanges,
  type BubbleStatus,
} from "./api";
import { ChangeCard } from "./ChangeCard";
import { t } from "./i18n";
import { Spinner } from "./Spinner";
import { formatDuration } from "./utils/ingestion";
import { TIER_OPTIONS, tierHint, tierLabel, type Tier } from "./utils/tiers";
import { showError } from "./utils/toast-helpers";

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
 * Render the tracker: bubble progress until the first bubble exists, then the
 * change list.
 */
export const SpooktoberTracker = () => {
  // "starting" until the bubble state is known, "waiting" while the first
  // bubble is computed, "ready" once the list is shown
  const [phase, setPhase] = createSignal<"starting" | "waiting" | "ready">(
    "starting",
  );
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

  let refreshTimer: number | undefined;
  let clockTimer: number | undefined;
  let bubblePoll: number | undefined;
  let highlightTimer: number | undefined;

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

  // Follow the bubble computation, then show or reload the list
  const startBubblePoll = () => {
    if (bubblePoll) return;
    bubblePoll = window.setInterval(async () => {
      try {
        const status = await getBubbleStatus();
        setBubble(status);
        if (status.state !== "computing") {
          stopBubblePoll();
          if (phase() !== "ready") await showList();
          else if (status.state === "ready") await loadChanges(true);
        }
      } catch {
        stopBubblePoll();
        if (phase() !== "ready") await showList();
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

  const showList = async () => {
    await loadChanges();
    setPhase("ready");
    if (!disconnected()) startRefresh();
  };

  // Wait for the first bubble; a recomputation keeps the previous one usable
  onMount(async () => {
    try {
      const status = await getBubbleStatus();
      setBubble(status);
      if (status.state === "computing" && !status.previous) {
        setPhase("waiting");
        startBubblePoll();
        return;
      }
    } catch {
      // The list request below reports the connection problem
    }
    await showList();
  });

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
      <Show when={phase() === "starting"}>
        <Spinner class="m-3" />
      </Show>

      {/* Change list */}
      <Show when={phase() === "waiting"}>
        <BubbleProgress status={computing()} waiting />
      </Show>

      <Show when={phase() === "ready"}>
        <div class="mb-4">
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

          {/* Bubble recomputation progress */}
          <Show when={computing()}>
            <BubbleProgress status={computing()} />
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
            <div
              class={`mb-4 space-y-3 transition-opacity ${loading() ? "opacity-50" : ""}`}
              aria-busy={loading()}
            >
              <For each={changes().slice(0, visibleCount())}>
                {(change) => (
                  <ChangeCard
                    change={change}
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

/**
 * Progress of the bubble computation.
 */
const BubbleProgress = (props: {
  status: Extract<BubbleStatus, { state: "computing" }> | null;
  // First computation: nothing to show until it is done
  waiting?: boolean;
}) => {
  const done = () => props.status?.done ?? 0;
  const total = () => props.status?.total ?? 0;
  return (
    <div class="mb-3 rounded-lg border border-purple-300 bg-purple-50 p-3 text-sm dark:border-purple-700 dark:bg-purple-900/30">
      <div class="mb-2">
        {t("bubble.computing", { done: done(), total: total() })}
      </div>
      <div class="h-2 w-full overflow-hidden rounded bg-purple-200 dark:bg-purple-800">
        <div
          class="h-2 bg-purple-600 transition-all"
          style={{
            width: `${total() ? Math.round((done() / total()) * 100) : 0}%`,
          }}
        />
      </div>
      <Show when={props.waiting}>
        <p class="mt-2 text-xs text-purple-900 dark:text-purple-200">
          {t("bubble.waiting")}
        </p>
      </Show>
    </div>
  );
};
