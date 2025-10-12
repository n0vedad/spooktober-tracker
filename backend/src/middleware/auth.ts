/**
 * Authentication and authorization middleware for API routes.
 */

import express from "express";
import type { APIResponse } from "../../../shared/types.js";
import { ADMIN_DID } from "../config.js";

/**
 * Ensure that the requester has a valid DID before continuing.
 *
 * @param req - Express request object.
 * @param res - Express response object.
 * @param next - Next middleware callback.
 * @returns void
 */
export const requireAuth = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) => {
  const userDID = req.headers["x-user-did"] as string;

  // Auth check
  if (!userDID || !userDID.startsWith("did:")) {
    const response: APIResponse<never> = {
      success: false,
      error: "Unauthorized: Valid DID required",
    };
    return res.status(401).json(response);
  }
  next();
};

/**
 * Ensure that the requester is the configured admin DID before continuing.
 *
 * @param req - Express request object.
 * @param res - Express response object.
 * @param next - Next middleware callback.
 * @returns void
 */
export const requireAdmin = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) => {
  const userDID = req.headers["x-user-did"] as string;

  // Auth check
  if (userDID !== ADMIN_DID) {
    const response: APIResponse<never> = {
      success: false,
      error: "Unauthorized: Admin access required",
    };
    return res.status(403).json(response);
  }
  next();
};
