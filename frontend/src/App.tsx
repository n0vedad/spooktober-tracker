/**
 * Root Solid component that wires together authentication, admin controls,
 * and the main Spooktober tracking experience.
 */

// Base
import { createEffect, createSignal, onMount, Show } from "solid-js";

// Needed for Declaration Merging
import type {} from "@atcute/atproto";
import type {} from "@atcute/bluesky";

// Bluesky
import { Client, CredentialManager } from "@atcute/client";
import { ActorIdentifier, Did, Handle } from "@atcute/lexicons";
import {
  configureOAuth,
  createAuthorizationUrl,
  deleteStoredSession,
  finalizeAuthorization,
  getSession,
  OAuthUserAgent,
  resolveFromIdentity,
  type Session,
} from "@atcute/oauth-browser-client";
import { Toaster } from "solid-toast";
import { AdminPanel } from "./AdminPanel";
import { resolveHandle as resolveDidToHandle } from "./api";
import { SpooktoberTracker } from "./SpooktoberTracker";
import { ENV } from "./utils/env";

// Admin DID
const ADMIN_DID = ENV.ADMIN_DID;

// Configure the OAuth metadata using project-specific environment values.
configureOAuth({
  metadata: {
    client_id: ENV.OAUTH_CLIENT_ID,
    redirect_uri: ENV.OAUTH_REDIRECT_URL,
  },
});

// Pairing of a DID with its corresponding handle returned from follow lookups.
type FollowResult = {
  did: string;
  handle: string;
};

// Transient UI notice with message text and severity tone
type Notice = {
  message: string;
  tone: "info" | "error";
};

let rpc: Client; // AT Protocol client configured after authentication.
let agent: OAuthUserAgent | undefined; // OAuth agent managing token refresh and requests.
let agentDID = ""; // DID of the currently authenticated user.
let credentialManager: CredentialManager | undefined; // App-password credential manager.

/**
 * Encapsulates login state, handles OAuth redirect flow and app-password login.
 *
 * @returns Signals and actions exposed to the UI for authentication.
 */
const Login = () => {
  const [loginInput, setLoginInput] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [handle, setHandle] = createSignal("");
  const [notice, setNotice] = createSignal<Notice | null>(null);
  const [loginState, setLoginState] = createSignal(false);
  const APP_PASSWORD_REGEX = /^[a-z0-9]{4}(?:-[a-z0-9]{4}){3}$/i;

  // Loading Follows
  onMount(async () => {
    setNotice({ message: "Loading...", tone: "info" });

    /**
     * Attempt to hydrate a session, either via OAuth callback hash or cached DID.
     *
     * @returns Active session when found, otherwise undefined.
     */
    const init = async (): Promise<Session | undefined> => {
      const params = new URLSearchParams(location.hash.slice(1));

      // Handle OAuth callback by finalizing the authorization code exchange.
      if (params.has("state") && (params.has("code") || params.has("error"))) {
        history.replaceState(null, "", "/");

        // Complete OAuth exchange and extract the authenticated user's DID
        const session = await finalizeAuthorization(params);
        const did = session.info.sub;

        // Cache the last signed-in DID for session rehydration on reload
        localStorage.setItem("lastSignedIn", did);
        return session;

        // Fall back to any cached DID-based session stored locally.
      } else {
        const lastSignedIn = localStorage.getItem("lastSignedIn");

        // Attempt to rehydrate a stored session using the cached DID
        if (lastSignedIn) {
          try {
            // Load session from browser storage; on failure we clear the cache below
            return await getSession(lastSignedIn as Did);

            // Clear stale session entries when rehydration fails.
          } catch (err) {
            localStorage.removeItem("lastSignedIn");
            throw err;
          }
        }
      }
    };

    // Ignore initialization failures so the login UI stays usable.
    const session = await init().catch(() => {});

    // Hydrate authenticated client state from the recovered session.
    if (session) {
      credentialManager = undefined;
      agent = new OAuthUserAgent(session);
      rpc = new Client({ handler: agent });
      agentDID = agent.sub;

      // Mark the UI as authenticated and resolve the user's handle for display
      setLoginState(true);
      setHandle((await resolveDidToHandle(agent.sub)) ?? "");
    }

    setNotice(null);
  });

  /**
   * Lookup PDS endpoint for a DID.
   *
   * @param did DID that needs a PDS host.
   * @returns PDS URL or undefined.
   */
  const getPDS = async (did: string) => {
    const res = await fetch(
      did.startsWith("did:web")
        ? `https://${did.split(":")[2]}/.well-known/did.json`
        : "https://plc.directory/" + did,
    );

    // Parse the DID document to locate the PDS service endpoint.
    return res.json().then((doc: any) => {
      for (const service of doc.service) {
        if (service.id === "#atproto_pds") return service.serviceEndpoint;
      }
    });
  };

  /**
   * Resolve a handle to DID via public Bluesky API.
   *
   * @param handle Bluesky handle.
   * @returns DID string on success.
   */
  const resolveHandleToDid = async (handle: string) => {
    const rpc = new Client({
      handler: new CredentialManager({
        service: "https://public.api.bsky.app",
      }),
    });

    // Query the public identity service to resolve the handle.
    const res = await rpc.get("com.atproto.identity.resolveHandle", {
      params: { handle: handle as Handle },
    });

    // Surface API errors as thrown exceptions for the caller.
    if (!res.ok) throw new Error(res.data.error);
    return res.data.did;
  };

  /**
   * Execute login flow depending on whether an app password was supplied.
   *
   * @param login Handle or DID supplied by the user.
   * @returns Promise resolving once the login flow completes or redirects.
   */
  const loginBsky = async (login: string) => {
    setNotice(null);
    if (password()) {
      if (!APP_PASSWORD_REGEX.test(password())) {
        setNotice({
          message: "That's not a valid app password!",
          tone: "error",
        });
        return;
      }

      // Switch to app‑password flow (no OAuth agent)
      agent = undefined;
      // Resolve DID from handle when necessary
      agentDID = login.startsWith("did:")
        ? login
        : await resolveHandleToDid(login);

      // Create credential manager pointing at the user's PDS
      const manager = new CredentialManager({
        service: await getPDS(agentDID),
      });

      // Store manager and bind AT client to it
      credentialManager = manager;
      rpc = new Client({ handler: manager });

      // App-password flow: authenticate explicitly against the user's PDS.
      await manager.login({
        identifier: agentDID,
        password: password(),
      });

      // Mark the UI as authenticated and resolve the user's handle for display
      setLoginState(true);
      setHandle((await resolveDidToHandle(agentDID)) ?? "");

      // Begin OAuth flow by resolving whatever identity string was provided.
    } else {
      credentialManager = undefined;
      try {
        setNotice({ message: `Resolving your identity...`, tone: "info" });
        const resolved = await resolveFromIdentity(login);

        // Exchange resolved identity for an authorization URL from the user's PDS.
        setNotice({
          message: `Contacting your data server...`,
          tone: "info",
        });
        const authUrl = await createAuthorizationUrl({
          scope: ENV.OAUTH_SCOPE,
          ...resolved,
        });

        // Provide a short UX pause before redirecting to OAuth consent.
        setNotice({ message: `Redirecting...`, tone: "info" });
        await new Promise((resolve) => setTimeout(resolve, 250));
        location.assign(authUrl);

        // Notify user when OAuth bootstrap fails (e.g., network issues).
      } catch (err) {
        if (err instanceof Error) {
          const message = err.message.toLowerCase();
          if (
            message.includes("domain handle not found") ||
            message.includes("invalid identifier") ||
            message.includes("handle must be a valid handle")
          ) {
            setNotice({ message: "Invalid Handle!", tone: "error" });
            return;
          }

          // Show specific backend error message when available
          setNotice({
            message: err.message || "Error during OAuth login",
            tone: "error",
          });
          return;
        }

        // Fallback: generic error when error shape is unknown
        setNotice({ message: "Error during OAuth login", tone: "error" });
      }
    }
  };

  /**
   * Sign out the current OAuth agent and reset state.
   *
   * @returns Promise resolving after the agent signs out.
   */
  const logoutBsky = async () => {
    try {
      if (credentialManager?.session) {
        const refreshJwt = credentialManager.session.refreshJwt;
        await rpc.post("com.atproto.server.deleteSession", {
          headers: { authorization: `Bearer ${refreshJwt}` },
          as: null,
        });

        // Bluesky’s public revoke endpoint fails for browsers with `use_dpop_nonce`,
        // so we clear the cached session locally instead of attempting a remote revoke.
      } else if (agent) {
        deleteStoredSession(agent.sub);
      }
    } catch (err) {
      // Log and surface a non-blocking notice; local state is cleared below
      setNotice({
        message: "Logout completed locally (remote revoke failed)",
        tone: "info",
      });
    } finally {
      credentialManager = undefined;
      agent = undefined;
      agentDID = "";
      localStorage.removeItem("lastSignedIn");
      setLoginState(false);
    }
  };

  // Return states
  return {
    loginState,
    handle,
    notice,
    loginInput,
    setLoginInput,
    password,
    setPassword,
    loginBsky,
    logoutBsky,
  };
};

/**
 * Handles retrieval of the authenticated user's follow list.
 *
 * @returns Signals and action for follow fetching logic.
 */
const Fetch = () => {
  const [follows, setFollows] = createSignal<FollowResult[]>([]);
  const [loading, setLoading] = createSignal(false);

  /**
   * Pull paginated follow data via app.bsky.graph.getFollows.
   *
   * @returns Promise resolving once all follow pages have been loaded.
   */
  const fetchFollows = async () => {
    setLoading(true);
    const PAGE_LIMIT = 100;
    const fetchPage = async (cursor?: string) => {
      const MAX_ATTEMPTS = 4;
      let attempt = 0;

      // Retry when Bluesky requests a fresh DPoP nonce.
      while (true) {
        const response = await rpc.get("app.bsky.graph.getFollows", {
          params: {
            actor: agentDID as ActorIdentifier,
            limit: PAGE_LIMIT,
            cursor: cursor,
          },
        });

        // Success: break the retry loop by returning the response
        if (response.ok) return response;
        // Bump attempt counter after a failed request
        attempt += 1;

        // Bluesky requires a fresh DPoP nonce occasionally; retry a few times
        if (
          response.data.error === "use_dpop_nonce" &&
          attempt < MAX_ATTEMPTS
        ) {
          // Short incremental backoff (200ms, 400ms, 600ms, ...)
          await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
          continue;
        }

        return response;
      }
    };

    // Ensure the first page resolved successfully before proceeding.
    try {
      let res = await fetchPage();
      if (!res.ok) {
        throw new Error(res.data.error);
      }
      let allFollows = res.data.follows;

      // Continue fetching while the API supplies a pagination cursor.
      while (res.data.cursor) {
        res = await fetchPage(res.data.cursor);
        if (!res.ok) {
          throw new Error(res.data.error);
        }
        allFollows = allFollows.concat(res.data.follows);
      }

      // Shape the aggregated follow list into DID/handle pairs.
      setFollows(
        allFollows.map((f: any) => ({
          did: f.did,
          handle: f.handle,
        })),
      );

      // Reset loading state regardless of success or failure.
    } catch {
      // Ignore follow fetch errors
    } finally {
      setLoading(false);
    }
  };

  // Return states
  return {
    follows,
    loading,
    fetchFollows,
  };
};

/**
 * Main application component that orchestrates login, fetching and tracker rendering.
 *
 * @returns JSX markup for the application shell.
 */
const App = () => {
  const [theme, setTheme] = createSignal(
    localStorage.theme === "dark" ||
      (!("theme" in localStorage) &&
        globalThis.matchMedia("(prefers-color-scheme: dark)").matches)
      ? "dark"
      : "light",
  );

  // Set variables
  const login = Login();
  const fetch = Fetch();

  // Auto-fetch follows when logged in
  createEffect(() => {
    if (
      login.loginState() &&
      fetch.follows().length === 0 &&
      !fetch.loading()
    ) {
      fetch.fetchFollows();
    }
  });

  // JSX Frontend
  return (
    <>
      <Toaster
        position="top-right"
        toastOptions={{
          style: {
            background: "#363636",
            color: "#fff",
          },
        }}
      />
      <div class="min-h-screen flex flex-col text-slate-900 dark:text-slate-100">
        <main class="flex-1">
          <div class="m-5 flex flex-col items-center">
            <div class="w-full max-w-2xl px-4">
          <div class="mb-2 flex items-center">
            <div class="basis-1/3">
              <div
                class="flex w-fit cursor-pointer items-center"
                title="Theme"
                onclick={() => {
                  setTheme(theme() === "light" ? "dark" : "light");
                  if (theme() === "dark")
                    document.documentElement.classList.add("dark");
                  else document.documentElement.classList.remove("dark");
                  localStorage.theme = theme();
                }}
              >
                {theme() === "dark" ? (
                  <div class="icon-[lucide--moon] text-lg sm:text-xl" />
                ) : (
                  <div class="icon-[lucide--sun] text-lg sm:text-xl" />
                )}
              </div>
            </div>
            <div class="basis-1/3 text-center text-lg font-bold sm:text-xl">
              🎃 Spooktober Tracker
            </div>
            <div class="flex basis-1/3 justify-end gap-x-2">
              <Show when={login.loginState()}>
                <button
                  class="flex cursor-pointer items-center justify-center rounded px-2 py-1 text-slate-700 dark:text-slate-100"
                  title="Logout"
                  onclick={login.logoutBsky}
                >
                  <div class="icon-[lucide--door-open] text-lg sm:text-xl" />
                </button>
              </Show>
            </div>
          </div>
          <div class="mb-4 flex flex-col items-center">
            <Show
              when={
                !login.loginState() && login.notice()?.message !== "Loading..."
              }
            >
              <form
                class="flex w-full max-w-md flex-col px-4"
                onsubmit={(e) => e.preventDefault()}
              >
                <label for="handle" class="ml-0.5 text-sm">
                  Handle
                </label>
                <input
                  type="text"
                  id="handle"
                  placeholder="user.bsky.social"
                  class="dark:bg-dark-100 mb-3 w-full rounded-lg border border-gray-400 px-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-blue-500"
                  onInput={(e) => login.setLoginInput(e.currentTarget.value)}
                />
                <label for="password" class="ml-0.5 text-sm">
                  App Password
                </label>
                <input
                  type="password"
                  id="password"
                  placeholder="supersecretpassword"
                  class="dark:bg-dark-100 mb-4 w-full rounded-lg border border-gray-400 px-3 py-2.5 text-base focus:outline-none focus:ring-2 focus:ring-blue-500"
                  onInput={(e) => login.setPassword(e.currentTarget.value)}
                />
                <button
                  onclick={() => login.loginBsky(login.loginInput())}
                  class="w-full rounded-lg bg-blue-600 py-3 text-base font-bold text-slate-100 hover:bg-blue-700 active:bg-blue-800"
                >
                  Login
                </button>
              </form>

              {(() => {
                const current = login.notice();
                if (!current || current.message === "Loading...") return null;

                const isInfo = current.tone === "info";
                const base =
                  "mx-4 mt-3 max-w-2xl rounded-lg border px-3 py-2 text-sm font-medium text-center";
                const info =
                  " border-emerald-400 bg-emerald-50 text-emerald-900 dark:border-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-200";
                const error =
                  " border-red-400 bg-red-50 text-red-900 dark:border-red-600 dark:bg-red-900/30 dark:text-red-200";

                return (
                  <div class={base + (isInfo ? info : error)}>
                    {current.message}
                  </div>
                );
              })()}

              {/* Login Info Note */}
              <div class="mx-4 mt-4 max-w-2xl rounded-lg border border-blue-300 bg-blue-50 p-4 dark:border-blue-700 dark:bg-blue-900/30">
                <h4 class="mb-2 text-sm font-bold text-blue-800 sm:text-base dark:text-blue-300">
                  ℹ️ How to Login
                </h4>
                <div class="space-y-2 text-xs text-blue-900 sm:text-sm dark:text-blue-200">
                  <p>
                    <strong>Option 1: App Password</strong>
                    <br />
                    Enter your Bluesky handle and an app password. You can
                    create an app password in your Bluesky settings under "App
                    Passwords". This is safer than using your main password.
                  </p>
                  <p>
                    <strong>Option 2: OAuth Login (Recommended)</strong>
                    <br />
                    Leave the password field empty and click "Login". You'll be
                    redirected to Bluesky to authorize this app. This is the
                    most secure option as you never share your password.
                  </p>
                </div>
              </div>
              <div class="mx-4 mt-3 max-w-2xl rounded-lg border border-purple-300 bg-purple-50 p-4 dark:border-purple-700 dark:bg-purple-900/30">
                <h4 class="mb-2 text-sm font-bold text-purple-800 sm:text-base dark:text-purple-300">
                  ❓ FAQ
                </h4>
                <div class="space-y-2 text-xs text-purple-900 sm:text-sm dark:text-purple-200">
                  <p>
                    <strong>What is Spooktober Tracker?</strong>
                    <br />A community tool that monitors Bluesky profile changes
                    during spooky season (October). When you enable monitoring,
                    we track changes to handles, display names, and avatars for
                    all the accounts you follow - helping everyone see who's
                    getting spooky! 🎃
                  </p>
                  <p>
                    <strong>How does monitoring work?</strong>
                    <br />
                    After enabling monitoring, our server watches your follows
                    in real-time via Bluesky's Jetstream API.{" "}
                    <strong>
                      Due limitations on Bluesky side only last 24 hours per
                      user could be catched up.
                    </strong>{" "}
                    When someone changes their profile, it's logged instantly.
                    The server runs 24/7, so you don't need to keep this page
                    open - changes are tracked automatically!
                  </p>
                  <p>
                    <strong>What data is collected?</strong>
                    <br />
                    We only store <em>publicly visible</em> profile changes:
                    handles (e.g., @user.bsky.social), display names, and avatar
                    references. We never store passwords, private posts, or
                    OAuth tokens. All monitoring data is shared across the
                    community - when you enable monitoring, you help everyone
                    track spooky changes!
                  </p>
                  <p>
                    <strong>Can I see changes even without monitoring?</strong>
                    <br />
                    Yes! Click "Load Known Spooktober Changes" to see all
                    profile changes tracked by the community. You only need to
                    enable monitoring if you want to contribute your follows to
                    the tracking database.
                  </p>
                  <p>
                    <strong>How do I stop monitoring?</strong>
                    <br />
                    Click the "Stop Monitoring" button anytime. Your follows
                    will no longer be tracked, but existing change history stays
                    in the database to help the community. You can re-enable
                    monitoring later if you want!
                  </p>
                  <p>
                    <strong>Is this safe?</strong>
                    <br />
                    Yes! We use Bluesky's official OAuth for login (if you dont
                    use app passwords) - your password never touches our
                    servers. OAuth tokens stay in your browser's secure storage.
                    We only read public profile data that anyone on Bluesky can
                    see.
                  </p>
                </div>
              </div>
            </Show>
            <Show when={login.loginState() && login.handle()}>
              <div class="mb-4 text-center text-sm sm:text-base">
                Logged in as @{login.handle()}
              </div>
            </Show>
            <Show when={login.notice()?.message === "Loading..."}>
              <div class="mx-4 my-3 max-w-md rounded-lg border border-emerald-400 bg-emerald-50 px-3 py-2 text-center text-sm font-medium text-emerald-900 dark:border-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-200">
                {login.notice()?.message}
              </div>
            </Show>
          </div>

          <Show when={login.loginState()}>
            <div class="flex flex-col items-center">
              {/* Admin Panel */}
              <Show when={agentDID === ADMIN_DID}>
                <AdminPanel userDID={agentDID} />
              </Show>

              <Show when={fetch.loading()}>
                <div class="m-3">Loading follows...</div>
              </Show>

              {/* Spooktober Tracker */}
              <Show when={!fetch.loading() && fetch.follows().length > 0}>
                <SpooktoberTracker
                  userDID={agentDID}
                  follows={fetch.follows()}
                  // Provide logout routine so children can terminate session cleanly
                  onLogout={login.logoutBsky}
                />
              </Show>
            </div>
          </Show>
          </div>
          {/* Close outer content wrapper */}
        </div>
        </main>
        <footer class="mt-auto w-full border-t border-gray-200 bg-white/70 dark:border-gray-700 dark:bg-black/40">
          <div class="mx-auto max-w-2xl px-4 py-3 text-center">
            <a
              href="https://github.com/n0vedad/spooktober-tracker"
              target="_blank"
              rel="noopener noreferrer"
              class="text-sm text-slate-600 hover:text-slate-800 hover:underline dark:text-slate-300 dark:hover:text-white"
              title="View source on GitHub"
            >
              Source
            </a>
          </div>
        </footer>
      </div>
    </>
  );
};

export default App;
