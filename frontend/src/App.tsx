/**
 * Root Solid component that wires together authentication, admin controls,
 * and the main Spooktober tracking experience.
 */

// Base
import { createEffect, createSignal, onMount, Show } from "solid-js";
import { Toaster } from "solid-toast";
import { AdminPanel } from "./AdminPanel";
import { getMe, getMyFollows, logout, startLogin, type Me } from "./api";
import { HandleTypeahead } from "./HandleTypeahead";
import { SpooktoberTracker } from "./SpooktoberTracker";

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

// Messages for the error codes the backend appends after a failed login
const LOGIN_ERRORS: Record<string, string> = {
  resolve_failed:
    "Could not find that account. Check the handle and try again.",
  denied: "Login was cancelled.",
  callback_failed: "Login failed. Please try again.",
  session_failed: "Login failed on our side. Please try again.",
};

/**
 * Encapsulates login state: session lookup, OAuth redirect and logout.
 *
 * @returns Signals and actions exposed to the UI for authentication.
 */
const Login = () => {
  const [loginInput, setLoginInput] = createSignal("");
  const [me, setMe] = createSignal<Me | null>(null);
  const [notice, setNotice] = createSignal<Notice | null>(null);
  const [checking, setChecking] = createSignal(true);

  // Restore the session (cookie) and surface errors from a failed login
  onMount(async () => {
    const params = new URLSearchParams(location.search);
    const loginError = params.get("login_error");
    if (loginError) {
      history.replaceState(null, "", "/");
      setNotice({
        message: LOGIN_ERRORS[loginError] ?? "Login failed.",
        tone: "error",
      });
    }

    try {
      setMe(await getMe());
    } catch {
      setNotice({
        message: "Could not reach the server. Please try again later.",
        tone: "error",
      });
    } finally {
      setChecking(false);
    }
  });

  /**
   * Start the OAuth login for the entered handle.
   *
   * @param login Handle or DID supplied by the user.
   */
  const loginBsky = (login: string) => {
    const handle = login.trim();
    if (!handle) {
      setNotice({ message: "Please enter your handle.", tone: "error" });
      return;
    }
    setNotice({ message: "Redirecting to Bluesky...", tone: "info" });
    startLogin(handle);
  };

  /**
   * End the session and reset state.
   *
   * @returns Promise resolving after the backend session is closed.
   */
  const logoutBsky = async () => {
    try {
      await logout();
    } catch {
      setNotice({
        message: "Logout failed on the server; you are logged out locally.",
        tone: "info",
      });
    } finally {
      setMe(null);
    }
  };

  // Return states
  return {
    me,
    checking,
    notice,
    loginInput,
    setLoginInput,
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
  const [loaded, setLoaded] = createSignal(false);

  /**
   * Load the follow list from the backend.
   *
   * @returns Promise resolving once the follows have been loaded.
   */
  const fetchFollows = async () => {
    setLoading(true);
    try {
      setFollows(await getMyFollows());
    } catch {
      // Ignore follow fetch errors; the tracker shows an empty state
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  };

  // Return states
  return {
    follows,
    loading,
    loaded,
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
    if (login.me() && !fetch.loaded() && !fetch.loading()) {
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
      <div class="flex min-h-screen flex-col text-slate-900 dark:text-slate-100">
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
                  <Show when={login.me()}>
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
                <Show when={!login.me() && !login.checking()}>
                  <form
                    class="flex w-full max-w-md flex-col px-4"
                    onsubmit={(e) => {
                      e.preventDefault();
                      login.loginBsky(login.loginInput());
                    }}
                  >
                    <label for="handle" class="ml-0.5 text-sm">
                      Handle
                    </label>
                    <HandleTypeahead
                      value={login.loginInput()}
                      onInput={login.setLoginInput}
                    />
                    <button
                      type="submit"
                      class="w-full rounded-lg bg-blue-600 py-3 text-base font-bold text-slate-100 hover:bg-blue-700 active:bg-blue-800"
                    >
                      Login
                    </button>
                  </form>

                  {(() => {
                    const current = login.notice();
                    if (!current) return null;

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
                        Enter your Bluesky handle and click "Login". You'll be
                        redirected to your Bluesky server to confirm. Your
                        password never touches this site, and we only ask for
                        proof of who you are - no permission to post or change
                        anything.
                      </p>
                    </div>
                  </div>

                  {/* FAQ */}
                  <div class="mx-4 mt-3 max-w-2xl rounded-lg border border-purple-300 bg-purple-50 p-4 dark:border-purple-700 dark:bg-purple-900/30">
                    <h4 class="mb-2 text-sm font-bold text-purple-800 sm:text-base dark:text-purple-300">
                      ❓ FAQ
                    </h4>
                    <div class="space-y-2 text-xs text-purple-900 sm:text-sm dark:text-purple-200">
                      <p>
                        <strong>What is Spooktober Tracker?</strong>
                        <br />A community tool that shows Bluesky profile
                        changes during spooky season (October): new handles,
                        display names and avatars - so you can see who's getting
                        spooky! 🎃
                      </p>
                      <p>
                        <strong>How does it work?</strong>
                        <br />
                        Our server watches public profile updates across the
                        whole network in real time via Bluesky's Jetstream. You
                        don't need to enable anything or keep this page open.
                        After logging in you see the changes of the accounts you
                        follow.
                      </p>
                      <p>
                        <strong>What data is collected?</strong>
                        <br />
                        Only <em>publicly visible</em> profile data: handles,
                        display names and avatar references. We never store
                        passwords, private posts or OAuth tokens. Bots and
                        brand-new accounts setting up their profile are filtered
                        out.
                      </p>
                      <p>
                        <strong>Can I remove my data?</strong>
                        <br />
                        Yes. After logging in, click "Delete all my data" to
                        remove your own profile change history.
                      </p>
                    </div>
                  </div>
                </Show>
                <Show when={login.me()?.handle}>
                  <div class="mb-4 text-center text-sm sm:text-base">
                    Logged in as @{login.me()?.handle}
                  </div>
                </Show>
                <Show when={login.checking()}>
                  <div class="mx-4 my-3 max-w-md rounded-lg border border-emerald-400 bg-emerald-50 px-3 py-2 text-center text-sm font-medium text-emerald-900 dark:border-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-200">
                    Loading...
                  </div>
                </Show>
              </div>

              <Show when={login.me()}>
                <div class="flex flex-col items-center">
                  {/* Admin Panel */}
                  <Show when={login.me()?.isAdmin}>
                    <AdminPanel />
                  </Show>

                  <Show when={fetch.loading()}>
                    <div class="m-3">Loading follows...</div>
                  </Show>

                  {/* Spooktober Tracker */}
                  <Show when={fetch.loaded() && !fetch.loading()}>
                    <SpooktoberTracker
                      follows={fetch.follows()}
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
