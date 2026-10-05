/**
 * Authentication and authorization middleware for API routes.
 *
 * The signed-in account is identified by the session cookie set after the
 * OAuth login, never by anything the client claims about itself.
 */

import { parseCookie } from "cookie";
import express from "express";
import type { APIResponse } from "../../../shared/types.js";
import { SESSION_COOKIE, getSessionDid } from "../auth/sessions.js";
import { ADMIN_DID } from "../config.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** DID of the signed-in account (set by loadSession) */
      did?: string;
      /** Raw session token from the cookie (set by loadSession) */
      sessionToken?: string;
    }
  }
}

/**
 * Read the session token from a Cookie header.
 *
 * @param header Raw Cookie header value.
 * @returns Session token, or undefined when absent.
 */
export function readSessionToken(
  header: string | undefined,
): string | undefined {
  if (!header) return undefined;
  return parseCookie(header)[SESSION_COOKIE] || undefined;
}

/**
 * Resolve the session cookie into `req.did` (if valid). Never rejects.
 */
export const loadSession: express.RequestHandler = async (req, _res, next) => {
  try {
    const token = readSessionToken(req.headers.cookie);
    if (token) {
      const did = await getSessionDid(token);
      if (did) {
        req.did = did;
        req.sessionToken = token;
      }
    }
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Ensure that the request belongs to a signed-in account.
 */
export const requireAuth: express.RequestHandler = (req, res, next) => {
  if (!req.did) {
    const response: APIResponse<never> = {
      success: false,
      error: "Unauthorized: please log in",
    };
    res.status(401).json(response);
    return;
  }
  next();
};

/**
 * Ensure that the request belongs to the configured admin account.
 */
export const requireAdmin: express.RequestHandler = (req, res, next) => {
  if (req.did !== ADMIN_DID) {
    const response: APIResponse<never> = {
      success: false,
      error: req.did
        ? "Forbidden: admin access required"
        : "Unauthorized: please log in",
    };
    res.status(req.did ? 403 : 401).json(response);
    return;
  }
  next();
};

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Reject state-changing requests coming from other sites (CSRF protection on
 * top of SameSite=Lax cookies).
 *
 * @param allowedOrigins Origins the frontend is served from.
 * @returns Middleware.
 */
export function rejectCrossSite(
  allowedOrigins: readonly string[],
): express.RequestHandler {
  const allowed = new Set(allowedOrigins);
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();

    const origin = req.headers.origin;
    const crossSite = origin
      ? !allowed.has(origin)
      : req.headers["sec-fetch-site"] === "cross-site";

    if (crossSite) {
      const response: APIResponse<never> = {
        success: false,
        error: "Forbidden: cross-site request",
      };
      res.status(403).json(response);
      return;
    }
    next();
  };
}
