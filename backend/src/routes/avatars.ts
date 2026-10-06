/**
 * Avatar thumbnails of profile changes: archived copy if we have one,
 * otherwise a redirect to the Bluesky CDN.
 */

import express from "express";
import { z } from "zod";
import { thumbnailUrl } from "../avatars/archive.js";
import { getThumb } from "../avatars/store.js";
import { validate } from "../validation/middleware.js";
import { DID_PATTERN } from "../validation/schemas.js";

// Blob CIDs are base32 CIDv1 ("b" prefix)
const avatarParamsSchema = z.object({
  did: z.string().regex(DID_PATTERN),
  cid: z.string().regex(/^b[a-z2-7]{20,100}$/),
});

// A CID names its content, so the response never changes
const IMMUTABLE = "public, max-age=31536000, immutable";

const router = express.Router();

/**
 * GET /api/avatars/:did/:cid
 */
router.get(
  "/:did/:cid",
  validate(avatarParamsSchema, "params"),
  async (req, res) => {
    const { did, cid } = req.params as { did: string; cid: string };
    try {
      const thumb = await getThumb(did, cid);
      if (thumb) {
        res.set("Cache-Control", IMMUTABLE);
        res.type(thumb.content_type).send(thumb.data);
        return;
      }
    } catch (error) {
      console.error(`❌ Could not load avatar ${cid} of ${did}:`, error);
    }
    // Not archived (yet): the CDN may still have it
    res.set("Cache-Control", "public, max-age=300");
    res.redirect(302, thumbnailUrl(did, cid));
  },
);

export default router;
