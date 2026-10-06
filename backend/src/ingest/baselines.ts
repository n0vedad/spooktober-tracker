/**
 * Makes sure every account someone looks at has a baseline snapshot.
 *
 * A change can only be detected against a known previous state. Baselines
 * come from Jetstream (first event of an account) and, as a side effect,
 * from the follow lists loaded for a bubble - but cached lists add nothing.
 * The sweeper closes the remaining gaps: it looks up which of the given
 * accounts have no baseline and loads exactly those via getProfiles.
 */

import type { ProfileViewLike } from "./seed.js";

// Accounts per getProfiles request (AppView maximum)
const BATCH_SIZE = 25;
// Parallel requests; the public AppView rate-limits per IP
const DEFAULT_CONCURRENCY = 4;

interface Deps {
  findMissing: (dids: readonly string[]) => Promise<string[]>;
  fetchProfiles: (dids: readonly string[]) => Promise<ProfileViewLike[]>;
  seed: (views: readonly ProfileViewLike[]) => Promise<void>;
  concurrency?: number;
  log?: Pick<Console, "log" | "warn">;
}

export function createBaselineSweeper(deps: Deps) {
  const concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;
  const log = deps.log ?? console;
  // Sweeps run one after another, so overlapping triggers don't double up
  let chain: Promise<unknown> = Promise.resolve();

  async function sweep(dids: readonly string[], reason: string) {
    const missing = await deps.findMissing(dids);
    if (missing.length === 0) return 0;

    const startedAt = Date.now();
    const batches: string[][] = [];
    for (let i = 0; i < missing.length; i += BATCH_SIZE) {
      batches.push(missing.slice(i, i + BATCH_SIZE));
    }
    log.log(`🌱 Loading ${missing.length} missing baselines (${reason})`);

    let seeded = 0;
    let failed = 0;
    let next = 0;
    const worker = async () => {
      while (next < batches.length) {
        const batch = batches[next++];
        try {
          const views = await deps.fetchProfiles(batch);
          await deps.seed(views);
          seeded += views.length;
        } catch (error) {
          // One failing batch must not stop the rest
          failed += batch.length;
          log.warn(
            "⚠️  Could not load baselines:",
            error instanceof Error ? error.message : error,
          );
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));

    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    // Accounts the AppView doesn't return are deleted or deactivated
    log.log(
      `🌱 Baselines (${reason}): ${seeded} of ${missing.length} loaded in ${seconds}s` +
        (failed ? ` (${failed} failed)` : ""),
    );
    return seeded;
  }

  return {
    /**
     * Load baselines for those of the accounts that have none.
     *
     * @param dids Accounts that must be comparable.
     * @param reason Shown in the log.
     * @returns Number of baselines loaded.
     */
    ensure(dids: readonly string[], reason: string): Promise<number> {
      const run = chain.then(() => sweep(dids, reason));
      chain = run.catch(() => {});
      return run;
    },
  };
}

export type BaselineSweeper = ReturnType<typeof createBaselineSweeper>;
