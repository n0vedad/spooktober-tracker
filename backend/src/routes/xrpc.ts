/**
 * Public XRPC endpoints of the labeler.
 */

import cors from "cors";
import express from "express";
import { z } from "zod";
import { labelToJson } from "../labeler/labels.js";
import { labeler } from "../labeler/index.js";
import { queryActiveLabels } from "../labeler/store.js";
import { validate } from "../validation/middleware.js";

const router = express.Router();

// Labels are public: any origin may read them
router.use(cors({ origin: "*" }));

// A single query value arrives as string, repeated ones as an array
const stringList = z.preprocess(
  (value) => (value === undefined || Array.isArray(value) ? value : [value]),
  z.array(z.string().min(1)),
);

const queryLabelsSchema = z.object({
  uriPatterns: stringList,
  sources: stringList.optional(),
  limit: z.coerce.number().int().min(1).max(250).default(50),
  cursor: z.coerce.number().int().nonnegative().optional(),
});

/**
 * GET /xrpc/com.atproto.label.queryLabels
 * Currently effective labels for the given subjects.
 */
router.get(
  "/com.atproto.label.queryLabels",
  (_req, res, next) => {
    if (labeler) return next();
    res.status(501).json({
      error: "MethodNotImplemented",
      message: "This service does not run a labeler",
    });
  },
  validate(queryLabelsSchema, "query"),
  async (req, res) => {
    const { uriPatterns, sources, limit, cursor } =
      req.query as unknown as z.infer<typeof queryLabelsSchema>;
    const result = await queryActiveLabels({
      uriPatterns,
      sources,
      limit,
      cursor,
    });
    res.json({
      ...(result.cursor !== undefined && { cursor: String(result.cursor) }),
      labels: result.events.map((e) => labelToJson(e.label)),
    });
  },
);

export default router;
