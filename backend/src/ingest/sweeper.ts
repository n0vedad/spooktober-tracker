/**
 * Production wiring of the baseline sweeper.
 */

import { findMissingBaselines } from "../db.js";
import { createBaselineSweeper } from "./baselines.js";
import { fetchProfiles, seedFromViews } from "./seed.js";

export const baselineSweeper = createBaselineSweeper({
  findMissing: findMissingBaselines,
  fetchProfiles: (dids) => fetchProfiles(dids),
  seed: seedFromViews,
});
