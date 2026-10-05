/**
 * atproto OAuth client used only to verify who a user is.
 *
 * The app never acts on the user's behalf (follows come from the public
 * API), so it requests just the `atproto` scope and revokes the tokens right
 * after login.
 */

import {
  CompositeDidDocumentResolver,
  CompositeHandleResolver,
  LocalActorResolver,
  PlcDidDocumentResolver,
  WebDidDocumentResolver,
  WellKnownHandleResolver,
} from "@atcute/identity-resolver";
import { NodeDnsHandleResolver } from "@atcute/identity-resolver-node";
import {
  OAuthClient,
  type ClientAssertionPrivateJwk,
  type StoredSession,
  type StoredState,
} from "@atcute/oauth-node-client";
import { IS_LOOPBACK, OAUTH_PRIVATE_KEY_JWK, PUBLIC_URL } from "../config.js";
import { PgStore } from "./pg-store.js";

export const OAUTH_SCOPE = "atproto";
export const REDIRECT_URI = `${PUBLIC_URL}/oauth/callback`;
export const CLIENT_METADATA_PATH = "/oauth-client-metadata.json";
export const JWKS_PATH = "/jwks.json";

// Authorization requests must complete within this time
const STATE_TTL_MS = 10 * 60 * 1000;

const stores = {
  sessions: new PgStore<`did:${string}:${string}`, StoredSession>("session"),
  states: new PgStore<string, StoredState>("state", STATE_TTL_MS),
};

const actorResolver = new LocalActorResolver({
  handleResolver: new CompositeHandleResolver({
    methods: {
      dns: new NodeDnsHandleResolver(),
      http: new WellKnownHandleResolver(),
    },
  }),
  didDocumentResolver: new CompositeDidDocumentResolver({
    methods: {
      plc: new PlcDidDocumentResolver(),
      web: new WebDidDocumentResolver(),
    },
  }),
});

/**
 * Build the OAuth client: a public loopback client in local development, a
 * confidential client (private_key_jwt) everywhere else.
 */
function createOAuthClient(): OAuthClient {
  if (IS_LOOPBACK) {
    return new OAuthClient({
      metadata: { redirect_uris: [REDIRECT_URI], scope: OAUTH_SCOPE },
      stores,
      actorResolver,
    });
  }

  return new OAuthClient({
    metadata: {
      client_id: `${PUBLIC_URL}${CLIENT_METADATA_PATH}`,
      client_name: "Spooktober Tracker",
      client_uri: PUBLIC_URL,
      redirect_uris: [REDIRECT_URI],
      scope: OAUTH_SCOPE,
      jwks_uri: `${PUBLIC_URL}${JWKS_PATH}`,
    },
    keyset: [JSON.parse(OAUTH_PRIVATE_KEY_JWK!) as ClientAssertionPrivateJwk],
    stores,
    actorResolver,
  });
}

export const oauthClient = createOAuthClient();
