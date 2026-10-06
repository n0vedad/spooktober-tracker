/**
 * Texts of the Spooktober labeler, shared by the backend (published by
 * `pnpm labeler-setup`) and the frontend (shown on the opt-in hint).
 */

/**
 * Label values and their public definitions (published in the labeler's
 * app.bsky.labeler.service record). Apps show `name` on profiles and
 * `description` when the label is tapped.
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
        description: "Hat im Spooktober den Anzeigenamen geändert.",
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
        description: "Hat im Spooktober das Profilbild geändert.",
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
        description: "Hat im Spooktober den Handle geändert.",
      },
    ],
  },
] as const;

/**
 * Profile description of the labeler account (published by
 * `pnpm labeler-setup`). It explains the opt-in, which the app cannot show
 * otherwise. A profile has one description (no translations); at most 256
 * graphemes.
 */
export const LABELER_DESCRIPTION = [
  "🎃 Spooktober labels for profile changes in October.",
  "Like or follow this account to get labeled - unlike/unfollow removes your labels.",
  "Subscribe to see the labels everywhere. 👻",
].join("\n");

export type LabelValue = (typeof LABEL_DEFINITIONS)[number]["identifier"];
