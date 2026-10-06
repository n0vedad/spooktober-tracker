/**
 * Closeness tiers of the per-user change view.
 */

import { t, type MessageKey } from "../i18n";

export type Tier = "follows" | "inner" | "bubble" | "edge";

// Display order (closest first) with the emoji shown in badges and buttons
export const TIER_OPTIONS: ReadonlyArray<{ tier: Tier; emoji: string }> = [
  { tier: "follows", emoji: "🎃" },
  { tier: "inner", emoji: "🕯️" },
  { tier: "bubble", emoji: "👻" },
  { tier: "edge", emoji: "🕸️" },
];

/**
 * Translated name of a tier.
 */
export const tierLabel = (tier: Tier): string =>
  t(`tier.${tier}` as MessageKey);

/**
 * Translated one-line explanation of a tier.
 */
export const tierHint = (tier: Tier): string =>
  t(`tier.${tier}.hint` as MessageKey);

/**
 * Emoji for a tier badge.
 *
 * @param tier Tier of a change.
 * @returns Emoji, or an empty string for unknown tiers.
 */
export const tierEmoji = (tier: Tier | undefined): string =>
  TIER_OPTIONS.find((option) => option.tier === tier)?.emoji ?? "";
