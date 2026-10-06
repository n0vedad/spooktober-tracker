/**
 * OAuth login/logout routes and the current-account endpoint.
 */

import type { ActorIdentifier, Did } from "@atcute/lexicons";
import express from "express";
import { z } from "zod";
import type { APIResponse } from "../../../shared/types.js";
import { CLIENT_METADATA_PATH, JWKS_PATH, oauthClient } from "../auth/oauth.js";
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  createSession,
  deleteSession,
} from "../auth/sessions.js";
import { bubbleService } from "../bubble/index.js";
import { seedAccounts } from "../ingest/seed.js";
import { ADMIN_DID, FRONTEND_URL, PUBLIC_URL } from "../config.js";
import { getSnapshot } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { resolveHandle } from "../utils/handle-resolver.js";
import { validate } from "../validation/middleware.js";

// Longest the login waits for the user's own profile
const SEED_WAIT_MS = 3000;

const router = express.Router();

// Cookies only need `Secure` when served over https
const SECURE_COOKIES = PUBLIC_URL.startsWith("https://");

const cookieOptions: express.CookieOptions = {
  httpOnly: true,
  secure: SECURE_COOKIES,
  sameSite: "lax",
  path: "/",
};

// Handle (with optional leading @) or DID entered on the login form
const loginQuerySchema = z.object({
  handle: z
    .string()
    .trim()
    .transform((value) => value.replace(/^@/, "").toLowerCase())
    .pipe(
      z
        .string()
        .regex(
          /^(did:(plc:[a-z0-9]+|web:[a-z0-9.-]+(%3a[0-9]+)?)|[a-z0-9-]+(\.[a-z0-9-]+)+)$/,
          "Invalid handle",
        ),
    ),
});

// Send the browser back to the frontend with an error code
const failLogin = (res: express.Response, code: string) =>
  res.redirect(`${FRONTEND_URL}/?login_error=${encodeURIComponent(code)}`);

/**
 * GET /oauth-client-metadata.json and /jwks.json
 * Published client metadata (confidential client only)
 */
router.get(CLIENT_METADATA_PATH, (_req, res) => {
  res.json(oauthClient.metadata);
});
router.get(JWKS_PATH, (_req, res) => {
  const jwks = oauthClient.jwks;
  if (!jwks) {
    res.status(404).end();
    return;
  }
  res.json(jwks);
});

/**
 * GET /oauth/login?handle=alice.bsky.social
 * Start the OAuth flow at the user's PDS.
 */
router.get(
  "/oauth/login",
  validate(loginQuerySchema, "query"),
  async (req, res) => {
    const { handle } = req.query as unknown as { handle: string };
    try {
      const { url } = await oauthClient.authorize({
        target: { type: "account", identifier: handle as ActorIdentifier },
      });
      res.redirect(url.toString());
    } catch (error) {
      console.warn(`⚠️  OAuth login failed for ${handle}:`, error);
      failLogin(res, "resolve_failed");
    }
  },
);

/**
 * GET /oauth/callback
 * Finish the OAuth flow, then start an app session for the verified DID.
 */
router.get("/oauth/callback", async (req, res) => {
  const params = new URL(req.originalUrl, PUBLIC_URL).searchParams;
  let did: Did;
  try {
    const { session } = await oauthClient.callback(params);
    did = session.did;
  } catch (error) {
    console.warn("⚠️  OAuth callback failed:", error);
    failLogin(res, params.has("error") ? "denied" : "callback_failed");
    return;
  }

  // We only needed proof of identity: drop the tokens right away
  void oauthClient.revoke(did).catch((error) => {
    console.warn(`⚠️  Could not revoke OAuth session for ${did}:`, error);
  });

  try {
    const token = await createSession(did);

    // Know the user's own profile, so their first change is detected and the
    // page can show their avatar. Waited for briefly: one AppView request
    await Promise.race([
      seedAccounts([did]).catch((error) => {
        console.warn(`⚠️  Could not seed profile of ${did}:`, error);
      }),
      new Promise((resolve) => setTimeout(resolve, SEED_WAIT_MS)),
    ]);

    // Map the user's bubble right away, so it is ready when they look at it
    bubbleService.ensure(did).catch((error) => {
      console.error(`❌ Could not start bubble for ${did}:`, error);
    });

    res.cookie(SESSION_COOKIE, token, {
      ...cookieOptions,
      maxAge: SESSION_TTL_MS,
    });
    res.redirect(`${FRONTEND_URL}/`);
  } catch (error) {
    console.error("❌ Could not create session:", error);
    failLogin(res, "session_failed");
  }
});

/**
 * POST /api/auth/logout
 * End the current session.
 */
router.post("/api/auth/logout", async (req, res) => {
  try {
    if (req.sessionToken) await deleteSession(req.sessionToken);
    res.clearCookie(SESSION_COOKIE, cookieOptions);
    const response: APIResponse<{ message: string }> = {
      success: true,
      data: { message: "Logged out" },
    };
    res.json(response);
  } catch (error) {
    console.error("Error logging out:", error);
    const response: APIResponse<never> = {
      success: false,
      error: "Failed to log out",
    };
    res.status(500).json(response);
  }
});

/**
 * GET /api/me
 * The signed-in account.
 */
router.get("/api/me", requireAuth, async (req, res) => {
  const did = req.did!;
  const [handle, snapshot] = await Promise.all([
    resolveHandle(did),
    getSnapshot(did),
  ]);
  const response: APIResponse<{
    did: string;
    handle: string | null;
    // Avatar blob CID from the profile seeded at login
    avatar: string | null;
    isAdmin: boolean;
  }> = {
    success: true,
    data: {
      did,
      handle,
      avatar: snapshot?.profile_seen ? snapshot.avatar_cid : null,
      isAdmin: did === ADMIN_DID,
    },
  };
  res.json(response);
});

export default router;
