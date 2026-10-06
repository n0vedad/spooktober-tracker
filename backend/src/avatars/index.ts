/**
 * Production wiring of the avatar archive.
 */

import { createAvatarArchive } from "./archive.js";
import { hasThumb, saveThumb } from "./store.js";

export const avatarArchive = createAvatarArchive({
  has: hasThumb,
  save: saveThumb,
});
