/**
 * com.atproto.label.subscribeLabels: WebSocket event stream of labels.
 *
 * Each message is a DAG-CBOR header ({op: 1, t: "#labels"}) followed by the
 * body ({seq, labels}). With a cursor, all labels after it are replayed first
 * and the stream then continues live without gaps or duplicates.
 */

import type { EventEmitter } from "node:events";
import { encode } from "@atcute/cbor";
import type { WebSocket } from "ws";
import { labelToCbor } from "./labels.js";
import type { LabelEvent } from "./store.js";

// Labels per database page while replaying
const BACKFILL_PAGE = 500;

export interface SubscriptionDeps {
  events: EventEmitter;
  getLabelsAfter: (seq: number, limit: number) => Promise<LabelEvent[]>;
  getLatestSeq: () => Promise<number>;
}

/**
 * Encode one stream frame (header + body as concatenated CBOR objects).
 */
export function encodeFrame(
  header: Record<string, unknown>,
  body: Record<string, unknown>,
): Uint8Array {
  const head = encode(header);
  const payload = encode(body);
  const frame = new Uint8Array(head.length + payload.length);
  frame.set(head, 0);
  frame.set(payload, head.length);
  return frame;
}

const labelsFrame = (event: LabelEvent) =>
  encodeFrame(
    { op: 1, t: "#labels" },
    { seq: event.seq, labels: [labelToCbor(event.label)] },
  );

/**
 * Serve one subscriber.
 *
 * @param ws Connected WebSocket.
 * @param cursor Last sequence number the subscriber has seen, or undefined
 *   to receive only new labels.
 * @param deps Live events and stored labels.
 */
export async function serveLabelSubscription(
  ws: WebSocket,
  cursor: number | undefined,
  deps: SubscriptionDeps,
): Promise<void> {
  // Highest sequence number delivered; null = live-only, nothing sent yet
  let lastSent: number | null = cursor ?? null;
  let replaying = cursor !== undefined;
  const pending: LabelEvent[] = [];

  const send = (event: LabelEvent) => {
    if (lastSent !== null && event.seq <= lastSent) return;
    if (ws.readyState !== ws.OPEN) return;
    ws.send(labelsFrame(event));
    lastSent = event.seq;
  };

  // Listen before replaying, so labels emitted meanwhile are not lost
  const onLabel = (event: LabelEvent) => {
    if (replaying) pending.push(event);
    else send(event);
  };
  deps.events.on("label", onLabel);
  ws.on("close", () => deps.events.off("label", onLabel));

  if (cursor === undefined) return;

  try {
    if (cursor > (await deps.getLatestSeq())) {
      ws.send(
        encodeFrame(
          { op: -1 },
          { error: "FutureCursor", message: "Cursor is ahead of the stream" },
        ),
      );
      ws.close();
      return;
    }

    // Stop replaying once the subscriber is gone (the cursor would not advance)
    while (ws.readyState === ws.OPEN) {
      const page = await deps.getLabelsAfter(lastSent ?? cursor, BACKFILL_PAGE);
      for (const event of page) send(event);
      if (page.length < BACKFILL_PAGE) break;
    }
  } finally {
    // Flush labels that arrived during the replay, then switch to live
    replaying = false;
    for (const event of pending) send(event);
    pending.length = 0;
  }
}
