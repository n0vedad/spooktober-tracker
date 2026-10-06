/**
 * Admin dashboard: ingestion health (live over WebSocket), start/stop of the
 * Jetstream ingestion, and lists of bot-flagged accounts, labeler opt-ins
 * and ignored accounts.
 */

import {
  createResource,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import {
  addIgnoredUser,
  getAdminStats,
  getIgnoredUsers,
  getNoisyAccounts,
  getOptIns,
  getRecommendedStartCursor,
  removeIgnoredUser,
  startJetstream,
  stopJetstream,
  unflagNoisyAccount,
  type AdminStats,
  type IngestionHealth,
} from "./api";
import { formatDateTime } from "./utils/date-formatter";
import { ENV } from "./utils/env";
import { describeState, formatDuration } from "./utils/ingestion";
import { showError, showSuccess } from "./utils/toast-helpers";

type Tab = "bots" | "optins" | "ignored";

// Reconnect delays for the status WebSocket (ms), capped at the last value
const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000];

const TONE_CLASSES = {
  green:
    "border-green-400 bg-green-50 text-green-900 dark:border-green-700 dark:bg-green-900/30 dark:text-green-200",
  yellow:
    "border-yellow-400 bg-yellow-50 text-yellow-900 dark:border-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-200",
  red: "border-red-400 bg-red-50 text-red-900 dark:border-red-700 dark:bg-red-900/30 dark:text-red-200",
  gray: "border-gray-300 bg-gray-50 text-gray-800 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200",
};

const REASON_TEXT: Record<string, string> = {
  "frequent-changes": "more than 10 changes in 24 h",
  "bot-self-label": "self-labeled as bot",
};

// Account label: @handle (with the DID as tooltip) or the DID
const AccountName = (props: { did: string; handle: string | null }) => (
  <a
    href={`https://bsky.app/profile/${props.handle ?? props.did}`}
    target="_blank"
    rel="noopener noreferrer"
    title={props.did}
    class="truncate font-semibold hover:underline"
  >
    {props.handle ? `@${props.handle}` : props.did}
  </a>
);

/**
 * Renders the admin dashboard.
 */
export const AdminPanel = () => {
  const [stats, { refetch: refetchStats, mutate: mutateStats }] =
    createResource(getAdminStats);
  const [tab, setTab] = createSignal<Tab>("bots");
  const [bots, { refetch: refetchBots }] = createResource(getNoisyAccounts);
  const [optIns] = createResource(getOptIns);
  const [ignored, { refetch: refetchIgnored }] =
    createResource(getIgnoredUsers);

  const [busy, setBusy] = createSignal(false);
  const [showStart, setShowStart] = createSignal(false);
  const [startCursor, setStartCursor] = createSignal("");
  const [newIgnored, setNewIgnored] = createSignal("");

  // Live ingestion health pushed by the backend every 2 s
  let ws: WebSocket | null = null;
  let attempts = 0;
  let reconnectTimer: number | undefined;
  let closed = false;

  const connect = () => {
    ws = new WebSocket(ENV.WS_URL);
    ws.onopen = () => (attempts = 0);
    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type !== "ingestion") return;
        mutateStats((prev) =>
          prev ? { ...prev, ingestion: message.data as IngestionHealth } : prev,
        );
      } catch {
        // Ignore malformed messages
      }
    };
    ws.onclose = () => {
      if (closed) return;
      const delay =
        RECONNECT_DELAYS[Math.min(attempts++, RECONNECT_DELAYS.length - 1)];
      reconnectTimer = window.setTimeout(connect, delay);
    };
  };

  onMount(connect);
  onCleanup(() => {
    closed = true;
    clearTimeout(reconnectTimer);
    ws?.close();
  });

  const ingestion = (): IngestionHealth | undefined => stats()?.ingestion;

  const stop = async () => {
    setBusy(true);
    try {
      showSuccess(await stopJetstream());
      await refetchStats();
    } catch (error) {
      showError(error instanceof Error ? error.message : "Stop failed");
    } finally {
      setBusy(false);
    }
  };

  const openStart = async () => {
    try {
      setStartCursor(String(await getRecommendedStartCursor()));
    } catch {
      setStartCursor(String(Date.now() * 1000));
    }
    setShowStart(true);
  };

  const start = async () => {
    const cursor = Number(startCursor());
    if (!Number.isInteger(cursor) || cursor <= 0) {
      showError("The cursor must be a positive whole number");
      return;
    }
    setBusy(true);
    try {
      showSuccess(await startJetstream(cursor));
      setShowStart(false);
      await refetchStats();
    } catch (error) {
      showError(error instanceof Error ? error.message : "Start failed");
    } finally {
      setBusy(false);
    }
  };

  const unflag = async (did: string) => {
    try {
      showSuccess(await unflagNoisyAccount(did));
      await refetchBots();
    } catch (error) {
      showError(error instanceof Error ? error.message : "Unflag failed");
    }
  };

  const ignore = async () => {
    const did = newIgnored().trim();
    if (!/^did:(plc|web):/.test(did)) {
      showError("Enter a DID (did:plc:… or did:web:…)");
      return;
    }
    try {
      showSuccess((await addIgnoredUser(did)).message, { duration: 5000 });
      setNewIgnored("");
      await refetchIgnored();
    } catch (error) {
      showError(error instanceof Error ? error.message : "Ignore failed");
    }
  };

  const unignore = async (did: string) => {
    try {
      showSuccess(await removeIgnoredUser(did));
      await refetchIgnored();
    } catch (error) {
      showError(error instanceof Error ? error.message : "Remove failed");
    }
  };

  // Cursor (unix microseconds) as a readable date, if it is one
  const cursorDate = (value: string) => {
    const n = Number(value);
    return n >= 1e15 ? formatDateTime(n / 1000, "short", "medium") : "-";
  };

  return (
    <div class="mt-6 w-full rounded-lg border-2 border-yellow-400 bg-yellow-50 p-4 dark:border-yellow-600 dark:bg-yellow-900/20">
      <h3 class="mb-3 text-lg font-bold text-yellow-800 sm:text-xl dark:text-yellow-300">
        🔧 Admin
      </h3>

      <Show when={stats()} fallback={<div class="text-sm">Loading…</div>}>
        {(current) => <StatusCard stats={current()} ingestion={ingestion()!} />}
      </Show>

      {/* Start / stop */}
      <Show when={ingestion()}>
        {(health) => (
          <button
            onclick={health().running ? stop : openStart}
            disabled={busy()}
            class={`mt-3 w-full rounded-lg px-4 py-2.5 font-bold text-white disabled:opacity-50 ${
              health().running
                ? "bg-red-600 hover:bg-red-700"
                : "bg-green-600 hover:bg-green-700"
            }`}
          >
            {health().running ? "Stop ingestion" : "Start ingestion…"}
          </button>
        )}
      </Show>

      {/* Lists */}
      <div class="mt-4 flex gap-2" role="tablist">
        <For
          each={
            [
              ["bots", "🤖 Bots"],
              ["optins", "🎃 Opt-ins"],
              ["ignored", "🚫 Ignored"],
            ] as const
          }
        >
          {([id, label]) => (
            <button
              role="tab"
              aria-selected={tab() === id}
              onclick={() => setTab(id)}
              class={`flex-1 rounded border px-2 py-1.5 text-sm font-semibold ${
                tab() === id
                  ? "border-yellow-600 bg-yellow-500 text-white"
                  : "border-yellow-300 bg-white hover:bg-yellow-100 dark:border-yellow-700 dark:bg-gray-800 dark:hover:bg-gray-700"
              }`}
            >
              {label}
            </button>
          )}
        </For>
      </div>

      <div class="mt-3 max-h-80 space-y-2 overflow-y-auto text-sm">
        <Show when={tab() === "bots"}>
          <ListState items={bots()} empty="No accounts flagged as bots." />
          <For each={bots()}>
            {(bot) => (
              <div class="flex items-center justify-between gap-2 rounded bg-white p-2 dark:bg-gray-800">
                <div class="min-w-0">
                  <AccountName did={bot.did} handle={bot.handle} />
                  <div class="text-xs text-gray-500 dark:text-gray-400">
                    {REASON_TEXT[bot.reason] ?? bot.reason} ·{" "}
                    {formatDateTime(bot.flagged_at, "short", "short")}
                  </div>
                </div>
                <button
                  onclick={() => unflag(bot.did)}
                  class="shrink-0 rounded bg-green-600 px-2 py-1 text-xs font-bold text-white hover:bg-green-700"
                  title="Not a bot: show its changes again"
                >
                  Unflag
                </button>
              </div>
            )}
          </For>
        </Show>

        <Show when={tab() === "optins"}>
          <ListState items={optIns()} empty="Nobody opted in yet." />
          <For each={optIns()}>
            {(optIn) => (
              <div class="flex items-center justify-between gap-2 rounded bg-white p-2 dark:bg-gray-800">
                <AccountName did={optIn.did} handle={optIn.handle} />
                <span class="shrink-0 text-xs text-gray-500 dark:text-gray-400">
                  {optIn.via} ·{" "}
                  {formatDateTime(optIn.opted_in_at, "short", "short")}
                </span>
              </div>
            )}
          </For>
        </Show>

        <Show when={tab() === "ignored"}>
          <div class="flex gap-2">
            <input
              type="text"
              value={newIgnored()}
              onInput={(e) => setNewIgnored(e.currentTarget.value)}
              placeholder="did:plc:…"
              class="min-w-0 flex-1 rounded border border-gray-300 px-2 py-1.5 dark:border-gray-600 dark:bg-gray-800"
            />
            <button
              onclick={ignore}
              class="rounded bg-red-600 px-3 py-1.5 font-bold text-white hover:bg-red-700"
              title="Deletes all stored changes of this account"
            >
              Ignore
            </button>
          </div>
          <ListState items={ignored()} empty="No ignored accounts." />
          <For each={ignored()}>
            {(user) => (
              <div class="flex items-center justify-between gap-2 rounded bg-white p-2 dark:bg-gray-800">
                <div class="min-w-0">
                  <AccountName did={user.did} handle={user.handle} />
                  <div class="text-xs text-gray-500 dark:text-gray-400">
                    since {formatDateTime(user.added_at, "short", "short")}
                  </div>
                </div>
                <button
                  onclick={() => unignore(user.did)}
                  class="shrink-0 rounded bg-green-600 px-2 py-1 text-xs font-bold text-white hover:bg-green-700"
                >
                  Remove
                </button>
              </div>
            )}
          </For>
        </Show>
      </div>

      {/* Start dialog */}
      <Show when={showStart()}>
        <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div class="w-full max-w-md rounded-lg bg-white p-5 dark:bg-gray-800">
            <h4 class="mb-2 text-lg font-bold">Start ingestion</h4>
            <p class="mb-3 text-sm text-gray-600 dark:text-gray-400">
              Cursor in unix microseconds. The suggestion continues where the
              ingestion stopped; Jetstream keeps about 36 hours.
            </p>
            <input
              type="text"
              value={startCursor()}
              onInput={(e) => setStartCursor(e.currentTarget.value)}
              class="w-full rounded border border-gray-300 px-2 py-1.5 font-mono dark:border-gray-600 dark:bg-gray-700"
            />
            <div class="mt-1 text-xs text-gray-500">
              = {cursorDate(startCursor())}
            </div>
            <div class="mt-2 flex gap-2 text-xs">
              <button
                class="underline"
                onclick={() => setStartCursor(String(Date.now() * 1000))}
              >
                now
              </button>
              <button
                class="underline"
                onclick={() =>
                  setStartCursor(String((Date.now() - 24 * 3_600_000) * 1000))
                }
              >
                24 h ago
              </button>
            </div>
            <div class="mt-4 flex gap-2">
              <button
                onclick={start}
                disabled={busy()}
                class="flex-1 rounded bg-green-600 px-3 py-2 font-bold text-white hover:bg-green-700 disabled:opacity-50"
              >
                Start
              </button>
              <button
                onclick={() => setShowStart(false)}
                class="flex-1 rounded bg-gray-500 px-3 py-2 font-bold text-white hover:bg-gray-600"
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

/**
 * Ingestion state badge and key figures.
 */
const StatusCard = (props: {
  stats: AdminStats;
  ingestion: IngestionHealth;
}) => {
  const state = () => describeState(props.ingestion);
  const row = (label: string, value: string | number) => (
    <div class="flex justify-between gap-2">
      <span class="text-gray-600 dark:text-gray-400">{label}</span>
      <span class="font-semibold">{value}</span>
    </div>
  );
  return (
    <div class="space-y-3">
      <div
        class={`rounded-lg border px-3 py-2 text-sm font-bold ${TONE_CLASSES[state().tone]}`}
        role="status"
      >
        {state().text}
      </div>
      <div class="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        {row("Tracked accounts", props.stats.trackedAccounts.toLocaleString())}
        {row(
          "Uptime",
          props.ingestion.uptimeSeconds === null
            ? "-"
            : formatDuration(props.ingestion.uptimeSeconds * 1000),
        )}
        {row(
          "Events since start",
          props.ingestion.eventsProcessed.toLocaleString(),
        )}
        {row(
          "Changes since start",
          props.ingestion.changesDetected.toLocaleString(),
        )}
        {row(
          "Last event",
          props.ingestion.lastEventTime
            ? formatDateTime(props.ingestion.lastEventTime, "short", "medium")
            : "-",
        )}
        <Show when={props.stats.labeler.enabled}>
          {row("Labeler opt-ins", props.stats.labeler.optIns)}
          {row(
            "Active labels",
            `${props.stats.labeler.activeLabels} on ${props.stats.labeler.labeledAccounts} accounts`,
          )}
        </Show>
      </div>
    </div>
  );
};

/**
 * Loading / empty hint for a list.
 */
const ListState = (props: { items: unknown[] | undefined; empty: string }) => (
  <Show when={props.items} fallback={<div class="text-gray-500">Loading…</div>}>
    <Show when={props.items!.length === 0}>
      <div class="text-gray-500">{props.empty}</div>
    </Show>
  </Show>
);
