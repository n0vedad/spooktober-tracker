/**
 * Validation middleware for request validation using Zod
 */

import type { NextFunction, Request, Response } from "express";
import { type ZodError, type ZodSchema } from "zod";

/**
 * Generic validation middleware factory for request validation.
 *
 * @param schema - Zod schema to validate against
 * @param target - Which part of the request to validate ('body', 'params', 'query')
 * @returns Express middleware function
 */
export const validate =
  (schema: ZodSchema, target: "body" | "params" | "query" = "body") =>
  (req: Request, res: Response, next: NextFunction) => {
    try {
      // Parse and validate the target part of the request
      const validated = schema.parse(req[target]);
      // Replace the original with validated data (with type coercion applied)
      req[target] = validated;
      next();
    } catch (error) {
      // Format Zod validation errors into a readable response
      if (error && typeof error === "object" && "issues" in error) {
        const zodError = error as ZodError;
        const errorMessages = zodError.issues.map((err) => ({
          path: err.path.join("."),
          message: err.message,
        }));

        return res.status(400).json({
          success: false,
          error: "Validation failed",
          details: errorMessages,
        });
      }

      // Fallback for unexpected errors
      return res.status(400).json({
        success: false,
        error: "Invalid request data",
      });
    }
  };
