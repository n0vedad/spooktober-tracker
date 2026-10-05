/**
 * Zod validation schemas for API request validation
 */

import { z } from "zod";

// DID format validation (did:plc:* or did:web:*)
const didSchema = z
  .string()
  .regex(/^did:(plc|web):[a-z0-9.-]+$/, "Invalid DID format");

// Handle format validation (@handle or handle)
const handleSchema = z
  .string()
  .regex(/^@?[a-zA-Z0-9.-]+$/, "Invalid handle format");

// Cursor validation (microseconds timestamp)
const cursorSchema = z.number().int().positive();

// Common query parameters
export const didParamSchema = z.object({
  did: didSchema,
});

export const userDidParamSchema = z.object({
  user_did: didSchema,
});

// Changes endpoints (keyset pagination: `before` is the oldest id already seen)
export const changesPageQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).default(50),
  before: z.coerce.number().int().positive().optional(),
});

// Monitoring endpoints
export const enableMonitoringBodySchema = z.object({
  user_did: didSchema,
  follows: z
    .array(
      z.object({
        did: didSchema,
        handle: handleSchema,
        rkey: z.string().optional(),
      }),
    )
    .min(1, "At least one follow is required"),
});

// Admin endpoints
export const jetstreamStartBodySchema = z.object({
  cursor: cursorSchema.optional(),
});

export const addIgnoredUserBodySchema = z.object({
  did: didSchema,
});
