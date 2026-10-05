/**
 * Closeness tiers of the per-user change view.
 */

export type Tier = "follows" | "inner" | "bubble" | "edge";

// Display order (closest first) with labels shown in the scope selector
export const TIER_OPTIONS: ReadonlyArray<{
  tier: Tier;
  emoji: string;
  label: string;
  hint: string;
}> = [
  {
    tier: "follows",
    emoji: "🎃",
    label: "Follows",
    hint: "Accounts you follow",
  },
  {
    tier: "inner",
    emoji: "🕯️",
    label: "Inner circle",
    hint: "Followed by many of your follows",
  },
  {
    tier: "bubble",
    emoji: "👻",
    label: "Bubble",
    hint: "Followed by 3 or more of your follows",
  },
  {
    tier: "edge",
    emoji: "🕸️",
    label: "Edge",
    hint: "Followed by at least one of your follows",
  },
];

/**
 * Emoji for a tier badge.
 *
 * @param tier Tier of a change.
 * @returns Emoji, or an empty string for unknown tiers.
 */
export const tierEmoji = (tier: Tier | undefined): string =>
  TIER_OPTIONS.find((option) => option.tier === tier)?.emoji ?? "";
