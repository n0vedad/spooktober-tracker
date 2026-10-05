/**
 * Which labels the Spooktober labeler emits, and when.
 */

import type { ProfileChange } from "../../../shared/types.js";

/**
 * Label values and their public definitions (published in the labeler's
 * app.bsky.labeler.service record).
 */
export const LABEL_DEFINITIONS = [
  {
    identifier: "spooky-name",
    locales: [
      {
        lang: "en",
        name: "🎃 Spooky name",
        description: "Changed their display name this Spooktober.",
      },
      {
        lang: "de",
        name: "🎃 Gruseliger Name",
        description: "Hat diesen Spooktober den Anzeigenamen geändert.",
      },
    ],
  },
  {
    identifier: "spooky-avatar",
    locales: [
      {
        lang: "en",
        name: "🎃 Spooky avatar",
        description: "Changed their avatar this Spooktober.",
      },
      {
        lang: "de",
        name: "🎃 Gruseliges Profilbild",
        description: "Hat diesen Spooktober das Profilbild geändert.",
      },
    ],
  },
  {
    identifier: "spooky-handle",
    locales: [
      {
        lang: "en",
        name: "🎃 Spooky handle",
        description: "Changed their handle this Spooktober.",
      },
      {
        lang: "de",
        name: "🎃 Gruseliger Handle",
        description: "Hat diesen Spooktober den Handle geändert.",
      },
    ],
  },
] as const;

export type LabelValue = (typeof LABEL_DEFINITIONS)[number]["identifier"];
export const LABEL_VALUES = LABEL_DEFINITIONS.map((d) => d.identifier);

/**
 * The season a point in time belongs to: October of that year (UTC).
 *
 * @param at Point in time.
 * @returns Season start and end (labels expire at the end), or null outside October.
 */
export function seasonOf(at: Date): { start: Date; end: Date } | null {
  if (at.getUTCMonth() !== 9) return null;
  const year = at.getUTCFullYear();
  return {
    start: new Date(Date.UTC(year, 9, 1)),
    end: new Date(Date.UTC(year, 10, 1)),
  };
}

/**
 * Label values a recorded change earns.
 *
 * @param change A profile change.
 * @returns Values for the changed fields.
 */
export function labelsForChange(
  change: Pick<
    ProfileChange,
    | "old_display_name"
    | "new_display_name"
    | "old_avatar"
    | "new_avatar"
    | "old_handle"
    | "new_handle"
  >,
): LabelValue[] {
  const values: LabelValue[] = [];
  if (change.old_display_name !== change.new_display_name) {
    values.push("spooky-name");
  }
  if (change.old_avatar !== change.new_avatar) values.push("spooky-avatar");
  if (change.old_handle !== change.new_handle) values.push("spooky-handle");
  return values;
}
