/**
 * Resume from the oldest available event when the stored cursor is too old.
 *
 * Jetstream v2 keeps a lookback of 36 hours (default, matching v1). A seq
 * cursor below that floor is rejected before the websocket upgrade with an
 * HTTP 400 (`CursorTooOld`); retrying with it would fail forever. A
 * unix-microsecond timestamp cursor below the floor is clamped to the oldest
 * event instead (announced as an `OutdatedCursor` info), so that is the
 * fallback. Events between the stored cursor and the floor are lost.
 */

import type { EventSource } from "./ingester.js";

// Jetstream's default cursor lookback
export const LOOKBACK_MS = 36 * 60 * 60 * 1000;
// Values from here on are read as unix microseconds instead of a seq
const TIMESTAMP_CURSOR_MIN = 1e15;
// ws reports a refused upgrade only as "Unexpected server response: <status>"
const HANDSHAKE_REJECTION = /Unexpected server response: (\d{3})/;

/**
 * Whether an error is the 400 Jetstream answers a below-floor seq cursor with.
 * The error body (`CursorTooOld`) is not readable through ws, only the status.
 */
export function isCursorTooOld(error: unknown): boolean {
  for (let e = error; e instanceof Error; e = e.cause) {
    if (e.message.includes("CursorTooOld")) return true;
    if (HANDSHAKE_REJECTION.exec(e.message)?.[1] === "400") return true;
  }
  return false;
}

/**
 * Wrap an event source so a too-old seq cursor falls back to the oldest
 * event Jetstream still has.
 *
 * @param open The underlying source.
 * @param log Where the gap is reported.
 * @param now Clock (tests).
 */
export function withCursorFallback(
  open: EventSource,
  log: Pick<Console, "warn"> = console,
  now: () => number = Date.now,
): EventSource {
  return async function* ({ cursor, signal }) {
    try {
      yield* open({ cursor, signal });
    } catch (error) {
      const isSeq = cursor !== undefined && cursor < TIMESTAMP_CURSOR_MIN;
      if (!isSeq || signal.aborted || !isCursorTooOld(error)) throw error;
      log.warn(
        `⚠️  Cursor ${cursor} is older than Jetstream's 36 h lookback; resuming at the oldest available event. Changes in between are lost.`,
      );
      yield* open({ cursor: (now() - LOOKBACK_MS) * 1000, signal });
    }
  };
}
