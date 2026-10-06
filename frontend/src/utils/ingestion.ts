/**
 * Display helpers for the ingestion status in the admin panel.
 */

import type { IngestionHealth } from "../api";

/**
 * Format a duration compactly ("45 s", "12 min", "3 h 12 min", "2 d 4 h").
 *
 * @param ms Duration in milliseconds.
 */
export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

/**
 * Badge text and colour for the ingestion state.
 *
 * @param health Ingestion health from the backend.
 */
export function describeState(health: IngestionHealth): {
  text: string;
  tone: "green" | "yellow" | "red" | "gray";
} {
  switch (health.state) {
    case "live":
      return {
        text: `🟢 Live · ${formatDuration(health.lagMs ?? 0)} behind`,
        tone: "green",
      };
    case "catching_up":
      return {
        text: `🟡 Catching up · ${formatDuration(health.lagMs ?? 0)} behind`,
        tone: "yellow",
      };
    case "stalled":
      return {
        text: `🔴 Stalled · ${health.consecutiveFailures} failed attempt${
          health.consecutiveFailures === 1 ? "" : "s"
        }`,
        tone: "red",
      };
    case "starting":
      return { text: "⚪ Starting…", tone: "gray" };
    case "stopped":
      return { text: "⚫ Stopped", tone: "gray" };
  }
}
