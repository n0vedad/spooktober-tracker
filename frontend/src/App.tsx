/**
 * Root Solid component that wires together authentication, admin controls,
 * and the main Spooktober tracking experience.
 */

// Base
import { createEffect, createSignal, For, onMount, Show } from "solid-js";
import { Toaster } from "solid-toast";
import { AccountMenu } from "./AccountMenu";
import { AdminPanel } from "./AdminPanel";
import { getMe, logout, startLogin, type LabelerStatus, type Me } from "./api";
import { HandleTypeahead } from "./HandleTypeahead";
import { lang, setLang, t, type MessageKey } from "./i18n";
import { LabelerOptIn } from "./LabelerOptIn";
import { Spinner } from "./Spinner";
import { SpooktoberTracker } from "./SpooktoberTracker";

// Transient UI notice (a message key, so it follows language switches)
type Notice = {
  key: MessageKey;
  tone: "info" | "error";
};

// Error codes the backend appends after a failed login
const LOGIN_ERRORS = new Set([
  "resolve_failed",
  "denied",
  "callback_failed",
  "session_failed",
]);

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
        key: LOGIN_ERRORS.has(loginError)
          ? (`login.error.${loginError}` as MessageKey)
          : "login.error.unknown",
        tone: "error",
      });
    }

    try {
      setMe(await getMe());
    } catch {
      setNotice({ key: "login.serverDown", tone: "error" });
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
      setNotice({ key: "login.enterHandle", tone: "error" });
      return;
    }
    setNotice({ key: "login.redirecting", tone: "info" });
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
      setNotice({ key: "login.logoutFailed", tone: "info" });
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
 * Main application component that orchestrates login and tracker rendering.
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

  // Labeler opt-in of the signed-in user; the changes are shown once the
  // labeler is liked or followed (or when no labeler is configured)
  const [labeler, setLabeler] = createSignal<LabelerStatus | null>(null);
  const labelerActive = () => {
    const status = labeler();
    return status !== null && (!status.enabled || !!status.optedInVia);
  };
  createEffect(() => {
    if (!login.me()) setLabeler(null);
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
        <main class="flex flex-1 flex-col">
          <div class="m-5 flex flex-1 flex-col items-center">
            <div class="flex w-full max-w-2xl flex-1 flex-col px-4">
              <div class="mb-2 flex items-center">
                <div class="flex basis-1/3 items-center gap-x-3">
                  <div
                    class="flex w-fit cursor-pointer items-center"
                    title={t("theme.title")}
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
                  {/* Language: shows the flag of the language to switch to */}
                  <button
                    class="cursor-pointer text-lg leading-none sm:text-xl"
                    title={t("lang.switch")}
                    aria-label={t("lang.switch")}
                    onclick={() => setLang(lang() === "de" ? "en" : "de")}
                  >
                    {lang() === "de" ? "🇬🇧" : "🇩🇪"}
                  </button>
                </div>
                <div class="basis-1/3 text-center text-lg font-bold sm:text-xl">
                  🎃 Spooktober Tracker
                </div>
                <div class="flex basis-1/3 items-center justify-end gap-x-2">
                  <Show when={login.me()}>
                    {(me) => (
                      <AccountMenu me={me()} onLogout={login.logoutBsky} />
                    )}
                  </Show>
                </div>
              </div>
              {/* Content: the login page is centered between header and
                  footer; signed in, it starts at the top so changing lists
                  only grow downwards */}
              <div
                class={`flex flex-1 flex-col ${login.me() ? "" : "justify-center"}`}
              >
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
                        {t("login.handle")}
                      </label>
                      <HandleTypeahead
                        value={login.loginInput()}
                        onInput={login.setLoginInput}
                      />
                      <button
                        type="submit"
                        class="w-full rounded-lg bg-blue-600 py-3 text-base font-bold text-slate-100 hover:bg-blue-700 active:bg-blue-800"
                      >
                        {t("login.button")}
                      </button>
                    </form>

                    {/* Status line: fixed height, so the boxes below never move */}
                    <div
                      class="mx-4 flex h-12 w-full max-w-md items-center justify-center px-4 text-center text-xs font-medium sm:text-sm"
                      role="status"
                      aria-live="polite"
                    >
                      <Show when={login.notice()}>
                        {(current) => (
                          <span
                            class={`line-clamp-2 ${
                              current().tone === "info"
                                ? "text-emerald-700 dark:text-emerald-300"
                                : "text-red-700 dark:text-red-400"
                            }`}
                          >
                            {t(current().key)}
                          </span>
                        )}
                      </Show>
                    </div>

                    {/* Login Info Note */}
                    <div class="mx-4 max-w-2xl rounded-lg border border-blue-300 bg-blue-50 p-4 dark:border-blue-700 dark:bg-blue-900/30">
                      <h4 class="mb-2 text-sm font-bold text-blue-800 sm:text-base dark:text-blue-300">
                        {t("login.howTitle")}
                      </h4>
                      <p class="text-xs text-blue-900 sm:text-sm dark:text-blue-200">
                        {t("login.howText")}
                      </p>
                    </div>

                    {/* FAQ */}
                    <div class="mx-4 mt-3 max-w-2xl rounded-lg border border-purple-300 bg-purple-50 p-4 dark:border-purple-700 dark:bg-purple-900/30">
                      <h4 class="mb-2 text-sm font-bold text-purple-800 sm:text-base dark:text-purple-300">
                        {t("faq.title")}
                      </h4>
                      <div class="space-y-2 text-xs text-purple-900 sm:text-sm dark:text-purple-200">
                        <For each={["what", "how", "data", "remove"] as const}>
                          {(topic) => (
                            <p>
                              <strong>{t(`faq.${topic}Q`)}</strong>
                              <br />
                              {t(`faq.${topic}A`)}
                            </p>
                          )}
                        </For>
                      </div>
                    </div>
                  </Show>
                  <Show when={login.checking()}>
                    <Spinner class="my-3" />
                  </Show>
                </div>

                <Show when={login.me()}>
                  <div class="flex flex-col items-center">
                    {/* Labeler opt-in hint or confirmation */}
                    <LabelerOptIn onStatus={setLabeler} />

                    {/* Admin Panel */}
                    <Show when={login.me()?.isAdmin}>
                      <AdminPanel />
                    </Show>

                    {/* Spooktober Tracker, once the labeler is subscribed */}
                    <Show when={labelerActive()}>
                      <SpooktoberTracker />
                    </Show>
                  </div>
                </Show>
              </div>
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
              {t("footer.source")}
            </a>
          </div>
        </footer>
      </div>
    </>
  );
};

export default App;
