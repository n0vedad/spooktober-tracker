/**
 * Zod validation schemas for API request validation
 */

import { z } from "zod";

// DID format validation: did:plc:<id> or did:web:<host>, where the host
// may carry a percent-encoded port (did:web:localhost%3A8080)
export const DID_PATTERN =
  /^did:(plc:[a-z0-9]+|web:[a-zA-Z0-9.-]+(%3[aA][0-9]+)?)$/;
const didSchema = z.string().regex(DID_PATTERN, "Invalid DID format");

// Cursor validation (microseconds timestamp)
const cursorSchema = z.number().int().positive();

// Common query parameters
export const didParamSchema = z.object({
  did: didSchema,
});

// Changes endpoints (keyset pagination: `before` is the oldest id already seen)
export const changesPageQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).default(50),
  before: z.coerce.number().int().positive().optional(),
});

// Per-user change view: how far into the bubble
export const scopedChangesQuerySchema = z.object({
  scope: z.enum(["follows", "inner", "bubble", "edge"]).default("follows"),
});

// Bubble status (refresh=true recomputes even a fresh bubble)
export const bubbleQuerySchema = z.object({
  refresh: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});

// Admin endpoints
export const jetstreamStartBodySchema = z.object({
  cursor: cursorSchema.optional(),
});

export const addIgnoredUserBodySchema = z.object({
  did: didSchema,
});
