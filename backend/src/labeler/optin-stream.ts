/**
 * Notices new opt-ins right away.
 *
 * Jetstream can't filter likes and follows by their target, so new opt-ins
 * come from Spacedust (microcosm.blue), a link firehose that can: it sends
 * only follows of the labeler and likes of its records. Spacedust drops
 * delete events and has no replay, so withdrawals come from the opt-in watch
 * and the periodic sync covers any outage. A link event only triggers a
 * sync, which checks the AppView; it is never trusted as an opt-in itself.
 */

import { FOLLOW_COLLECTION, LIKE_COLLECTION } from "./optin-watch.js";

// Link sources: the subject of a follow, the subject URI of a like
const SOURCES = [
  `${FOLLOW_COLLECTION}:subject`,
  `${LIKE_COLLECTION}:subject.uri`,
];

// Reconnect delays (ms), capped at the last value
const RETRY_DELAYS = [1_000, 5_000, 15_000, 60_000];

interface Deps {
  url: string;
  labelerDid: string;
  // An account liked or followed the labeler (or liked one of its records)
  onLink: (did: string) => void;
  WebSocket?: typeof WebSocket;
  retryDelays?: number[];
  log?: Pick<Console, "log" | "warn">;
}

/**
 * Author DID of a link event, from its source record URI
 * (at://<did>/<collection>/<rkey>).
 */
export function linkAuthor(data: string): string | null {
  try {
    const event = JSON.parse(data) as {
      kind?: string;
      link?: { operation?: string; source_record?: string };
    };
    if (event.kind !== "link" || event.link?.operation !== "create")
      return null;
    const match = /^at:\/\/(did:[^/]+)\//.exec(event.link.source_record ?? "");
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

export function createOptInStream(deps: Deps) {
  const Socket = deps.WebSocket ?? WebSocket;
  const delays = deps.retryDelays ?? RETRY_DELAYS;
  const log = deps.log ?? console;
  let socket: WebSocket | null = null;
  let timer: NodeJS.Timeout | null = null;
  let attempts = 0;
  let stopped = true;

  const url = () => {
    const query = new URLSearchParams();
    for (const source of SOURCES) query.append("wantedSources", source);
    query.append("wantedSubjectDids", deps.labelerDid);
    // No 21 s debounce: the sync checks the AppView anyway
    query.append("instant", "true");
    return `${deps.url.replace(/\/$/, "")}/subscribe?${query}`;
  };

  function connect() {
    socket = new Socket(url());
    socket.onopen = () => {
      attempts = 0;
    };
    socket.onmessage = (event) => {
      const did = linkAuthor(String(event.data));
      if (did && did !== deps.labelerDid) deps.onLink(did);
    };
    socket.onclose = () => {
      socket = null;
      if (stopped) return;
      const delay = delays[Math.min(attempts++, delays.length - 1)];
      if (attempts === 2) log.warn("⚠️  Spacedust disconnected, retrying");
      timer = setTimeout(connect, delay);
      timer.unref();
    };
  }

  return {
    start(): void {
      if (!stopped) return;
      stopped = false;
      connect();
    },
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      socket?.close();
      socket = null;
    },
  };
}
