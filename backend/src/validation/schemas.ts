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

// Changes endpoints
export const getChangesQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(1000).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

// Monitoring endpoints
export const enableMonitoringBodySchema = z.object({
  follows: z.array(
    z.object({
      did: didSchema,
      handle: handleSchema,
      rkey: z.string().optional(),
    }),
  ),
});

export const getFollowsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(1000).optional(),
});

// Admin endpoints
export const jetstreamStartBodySchema = z.object({
  cursor: cursorSchema.optional(),
});

export const addIgnoredUserBodySchema = z.object({
  did: didSchema,
});

// WebSocket query parameters (from URL query string)
export const wsQuerySchema = z.object({
  did: didSchema,
});

// Profile change submission
export const submitChangeSchema = z.object({
  did: didSchema,
  handle: handleSchema.optional(),
  old_handle: handleSchema.optional(),
  new_handle: handleSchema.optional(),
  old_display_name: z.string().optional(),
  new_display_name: z.string().optional(),
  old_avatar: z.string().optional(),
  new_avatar: z.string().optional(),
});
