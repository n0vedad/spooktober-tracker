/**
 * Social-graph "bubble" of a user: accounts followed by the user's follows
 * (second degree), scored by how strongly they are connected to the user.
 */

/**
 * Closeness tiers, from closest to farthest. `follows` are the accounts the
 * user follows directly; the others are second-degree accounts.
 */
export const TIERS = ["follows", "inner", "bubble", "edge"] as const;
export type Tier = (typeof TIERS)[number];

// Second-degree accounts followed by at least this many follows are "bubble"
export const BUBBLE_MIN_COMMON = 3;
// "Inner circle": followed by this share of the user's follows ...
export const INNER_SHARE = 0.1;
// ... but never by fewer than this many (keeps tiers apart for small accounts)
export const INNER_MIN_COMMON = 5;

/**
 * Connection of one second-degree account to the user.
 */
export interface BubbleMember {
  did: string;
  // How many of the user's follows follow this account
  commonCount: number;
  // Adamic-Adar score: common follows weighted by 1 / log(1 + their follow count)
  score: number;
}

/**
 * Compute the second-degree accounts of a user.
 *
 * @param userDid The user.
 * @param followLists Follow list of each account the user follows
 *   (key: followed account, value: the DIDs it follows).
 * @returns Every account followed by at least one of the user's follows,
 *   excluding the user and the user's direct follows.
 */
export function computeBubble(
  userDid: string,
  followLists: ReadonlyMap<string, readonly string[]>,
): BubbleMember[] {
  const direct = new Set(followLists.keys());
  const members = new Map<string, BubbleMember>();

  for (const follows of followLists.values()) {
    // Following few accounts makes each of them a stronger signal
    const weight = 1 / Math.log(1 + follows.length);
    for (const did of new Set(follows)) {
      if (did === userDid || direct.has(did)) continue;
      const member = members.get(did);
      if (member) {
        member.commonCount++;
        member.score += weight;
      } else {
        members.set(did, { did, commonCount: 1, score: weight });
      }
    }
  }

  return [...members.values()];
}

/**
 * Minimum number of common follows for each second-degree tier.
 *
 * @param followsCount Number of accounts the user follows.
 * @returns Thresholds for the inner, bubble and edge tiers.
 */
export function tierThresholds(
  followsCount: number,
): Record<Exclude<Tier, "follows">, number> {
  return {
    inner: Math.max(INNER_MIN_COMMON, Math.ceil(followsCount * INNER_SHARE)),
    bubble: BUBBLE_MIN_COMMON,
    edge: 1,
  };
}

/**
 * Tier of a second-degree account.
 *
 * @param commonCount Number of the user's follows following the account.
 * @param followsCount Number of accounts the user follows.
 * @returns The account's tier.
 */
export function tierOf(commonCount: number, followsCount: number): Tier {
  const t = tierThresholds(followsCount);
  if (commonCount >= t.inner) return "inner";
  if (commonCount >= t.bubble) return "bubble";
  return "edge";
}
