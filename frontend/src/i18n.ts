/**
 * Minimal translations (English / German) for the user-facing pages.
 *
 * `t(key, vars)` reads the current language signal, so components re-render
 * when the language is switched. The choice is stored in localStorage; the
 * first visit follows the browser language.
 */

import { createSignal } from "solid-js";

export type Lang = "en" | "de";

const en = {
  "theme.title": "Theme",
  "lang.switch": "Deutsch",
  "footer.source": "Source",

  "login.handle": "Handle",
  "login.button": "Login",
  "login.enterHandle": "Please enter your handle.",
  "login.redirecting": "Redirecting to Bluesky...",
  "login.loading": "Loading...",
  "login.loggedInAs": "Logged in as @{handle}",
  "login.serverDown": "Could not reach the server. Please try again later.",
  "login.logoutFailed":
    "Logout failed on the server; you are logged out locally.",
  "login.error.resolve_failed":
    "Could not find that account. Check the handle and try again.",
  "login.error.denied": "Login was cancelled.",
  "login.error.callback_failed": "Login failed. Please try again.",
  "login.error.session_failed": "Login failed on our side. Please try again.",
  "login.error.unknown": "Login failed.",
  "login.howTitle": "ℹ️ How to Login",
  "login.howText":
    'Enter your Bluesky handle and click "Login". You\'ll be redirected to your Bluesky server to confirm. Your password never touches this site, and we only ask for proof of who you are - no permission to post or change anything.',

  "faq.title": "❓ FAQ",
  "faq.whatQ": "What is Spooktober Tracker?",
  "faq.whatA":
    "A community tool that shows Bluesky profile changes during spooky season (October): new handles, display names and avatars - so you can see who's getting spooky! 🎃",
  "faq.howQ": "How does it work?",
  "faq.howA":
    "Our server watches public profile updates across the whole network in real time via Bluesky's Jetstream. You don't need to enable anything or keep this page open. After logging in you see the changes of the accounts you follow and of your wider network.",
  "faq.dataQ": "What data is collected?",
  "faq.dataA":
    "Only publicly visible profile data: handles, display names and avatar references. We never store passwords, private posts or OAuth tokens. Bots and brand-new accounts setting up their profile are filtered out.",
  "faq.removeQ": "Can I remove my data?",
  "faq.removeA":
    'Yes. After logging in, click "Delete all my data" to remove your own profile change history.',

  "follows.loading": "Loading follows...",

  "tracker.view": "🎃 View Spooky Changes",
  "tracker.noFollows": "You don't follow anyone yet",
  "tracker.loading": "Loading changes...",
  "tracker.back": "Back",
  "tracker.heading": "🎃 Detected Changes ({count})",
  "tracker.loadMore": "Load more ({count} remaining)",
  "tracker.newest": "🕒 Newest first",
  "tracker.closest": "🫂 Closest first",
  "tracker.updatedAgo": "Updated {ago} ago",
  "tracker.updatedJustNow": "Updated just now",
  "tracker.empty":
    "No changes here yet. The whole network is tracked 24/7 - check back later!",
  "tracker.disconnected":
    "⚠️ Server disconnected. Unable to check for changes.",
  "tracker.connectionLost":
    "Connection lost. Please check your internet connection and refresh the page.",
  "tracker.delete": "Delete all my data",
  "tracker.deleteTitle": "⚠️ Delete all your data?",
  "tracker.deleteText":
    "This removes your own profile change history from the community database and logs you out. This action cannot be undone.",
  "tracker.deleteConfirm": "Yes, delete all my data",
  "tracker.deleting": "Deleting...",
  "tracker.cancel": "Cancel",
  "tracker.deleted": "Deleted your data ({count} changes)",
  "tracker.deleteFailed": "Failed to delete your data",

  "bubble.computing":
    "👻 Mapping your bubble… {done} / {total} follows checked",
  "bubble.followsOnly": " - showing your follows until it is done.",
  "bubble.failed":
    "Could not map your bubble right now - showing your follows only.",

  "tier.follows": "Follows",
  "tier.follows.hint": "Accounts you follow",
  "tier.inner": "Inner circle",
  "tier.inner.hint": "Followed by many of your follows",
  "tier.bubble": "Bubble",
  "tier.bubble.hint": "Followed by 3 or more of your follows",
  "tier.edge": "Edge",
  "tier.edge.hint": "Followed by at least one of your follows",

  "change.handle": "Handle",
  "change.name": "Display name",
  "change.avatar": "Avatar",
  "change.noName": "(no name)",
  "change.noAvatar": "no avatar",
  "change.avatarGone": "no longer available",
  "change.oldAvatar": "Previous avatar",
  "change.newAvatar": "New avatar",
  "change.followedBy": "followed by {count} of your follows",
  "change.history": "Change history",
  "change.historyLoading": "Loading history...",

  "optin.title": "🎃 Get your own Spooktober labels",
  "optin.textBefore":
    "Your profile changes are only labeled if you agree: like or follow",
  "optin.textAfter":
    "on Bluesky. Subscribe to it as well to see the labels everywhere.",
  "optin.theLabeler": "the labeler",
  "optin.open": "Open the labeler on Bluesky",
  "optin.check": "Done - check again",
  "optin.checking": "Checking...",
  "optin.notFound":
    "No like or follow found yet - it can take a moment to show up.",
  "optin.checkFailed": "Check failed",
  "optin.confirmed": "✅ You get Spooktober labels, because {via}.",
  "optin.via.like": "you like the labeler",
  "optin.via.follow": "you follow the labeler",
  "optin.via.like+follow": "you like and follow the labeler",
  "optin.remove": "Unlike and unfollow {labeler} to remove them.",
} as const;

export type MessageKey = keyof typeof en;

const de: Record<MessageKey, string> = {
  "theme.title": "Design",
  "lang.switch": "English",
  "footer.source": "Quellcode",

  "login.handle": "Handle",
  "login.button": "Login",
  "login.enterHandle": "Bitte gib deinen Handle ein.",
  "login.redirecting": "Weiterleitung zu Bluesky…",
  "login.loading": "Lädt…",
  "login.loggedInAs": "Angemeldet als @{handle}",
  "login.serverDown":
    "Der Server ist nicht erreichbar. Bitte versuch es später noch einmal.",
  "login.logoutFailed":
    "Abmelden auf dem Server fehlgeschlagen; lokal bist du abgemeldet.",
  "login.error.resolve_failed":
    "Account nicht gefunden. Prüf den Handle und versuch es noch einmal.",
  "login.error.denied": "Anmeldung abgebrochen.",
  "login.error.callback_failed":
    "Anmeldung fehlgeschlagen. Bitte versuch es noch einmal.",
  "login.error.session_failed":
    "Anmeldung bei uns fehlgeschlagen. Bitte versuch es noch einmal.",
  "login.error.unknown": "Anmeldung fehlgeschlagen.",
  "login.howTitle": "ℹ️ So meldest du dich an",
  "login.howText":
    "Gib deinen Bluesky-Handle ein und klick auf „Login“. Du wirst zu deinem Bluesky-Server weitergeleitet und bestätigst dort. Dein Passwort berührt diese Seite nie, und wir fragen nur nach dem Nachweis, wer du bist - ohne Recht, etwas zu posten oder zu ändern.",

  "faq.title": "❓ FAQ",
  "faq.whatQ": "Was ist der Spooktober Tracker?",
  "faq.whatA":
    "Ein Community-Tool, das Bluesky-Profiländerungen in der Gruselsaison (Oktober) zeigt: neue Handles, Anzeigenamen und Profilbilder - damit du siehst, wer gerade spooky wird! 🎃",
  "faq.howQ": "Wie funktioniert das?",
  "faq.howA":
    "Unser Server verfolgt öffentliche Profiländerungen im ganzen Netzwerk in Echtzeit über Blueskys Jetstream. Du musst nichts einschalten und die Seite nicht offen lassen. Nach dem Login siehst du die Änderungen der Accounts, denen du folgst, und deines weiteren Umfelds.",
  "faq.dataQ": "Welche Daten werden erfasst?",
  "faq.dataA":
    "Nur öffentlich sichtbare Profildaten: Handles, Anzeigenamen und Verweise auf Profilbilder. Wir speichern nie Passwörter, private Posts oder OAuth-Tokens. Bots und brandneue Accounts, die gerade ihr Profil einrichten, werden herausgefiltert.",
  "faq.removeQ": "Kann ich meine Daten löschen?",
  "faq.removeA":
    "Ja. Klick nach dem Login auf „Alle meine Daten löschen“, um deinen eigenen Änderungsverlauf zu entfernen.",

  "follows.loading": "Follows werden geladen…",

  "tracker.view": "🎃 Gruselige Änderungen ansehen",
  "tracker.noFollows": "Du folgst noch niemandem",
  "tracker.loading": "Änderungen werden geladen…",
  "tracker.back": "Zurück",
  "tracker.heading": "🎃 Erkannte Änderungen ({count})",
  "tracker.loadMore": "Mehr laden (noch {count})",
  "tracker.newest": "🕒 Neueste zuerst",
  "tracker.closest": "🫂 Nächste zuerst",
  "tracker.updatedAgo": "Aktualisiert vor {ago}",
  "tracker.updatedJustNow": "Gerade aktualisiert",
  "tracker.empty":
    "Hier gibt es noch keine Änderungen. Das ganze Netzwerk wird rund um die Uhr verfolgt - schau später wieder vorbei!",
  "tracker.disconnected":
    "⚠️ Keine Verbindung zum Server. Änderungen können nicht geprüft werden.",
  "tracker.connectionLost":
    "Verbindung verloren. Prüf deine Internetverbindung und lade die Seite neu.",
  "tracker.delete": "Alle meine Daten löschen",
  "tracker.deleteTitle": "⚠️ Alle deine Daten löschen?",
  "tracker.deleteText":
    "Das entfernt deinen eigenen Änderungsverlauf aus der Community-Datenbank und meldet dich ab. Das lässt sich nicht rückgängig machen.",
  "tracker.deleteConfirm": "Ja, alle meine Daten löschen",
  "tracker.deleting": "Wird gelöscht…",
  "tracker.cancel": "Abbrechen",
  "tracker.deleted": "Deine Daten wurden gelöscht ({count} Änderungen)",
  "tracker.deleteFailed": "Löschen fehlgeschlagen",

  "bubble.computing":
    "👻 Deine Bubble wird vermessen… {done} / {total} Follows geprüft",
  "bubble.followsOnly": " - bis dahin siehst du deine Follows.",
  "bubble.failed":
    "Deine Bubble konnte gerade nicht vermessen werden - du siehst nur deine Follows.",

  "tier.follows": "Follows",
  "tier.follows.hint": "Accounts, denen du folgst",
  "tier.inner": "Enger Kreis",
  "tier.inner.hint": "Vielen deiner Follows folgen ihnen",
  "tier.bubble": "Bubble",
  "tier.bubble.hint": "Mindestens 3 deiner Follows folgen ihnen",
  "tier.edge": "Rand",
  "tier.edge.hint": "Mindestens einer deiner Follows folgt ihnen",

  "change.handle": "Handle",
  "change.name": "Anzeigename",
  "change.avatar": "Profilbild",
  "change.noName": "(kein Name)",
  "change.noAvatar": "kein Profilbild",
  "change.avatarGone": "nicht mehr verfügbar",
  "change.oldAvatar": "Vorheriges Profilbild",
  "change.newAvatar": "Neues Profilbild",
  "change.followedBy": "{count} deiner Follows folgen diesem Account",
  "change.history": "Änderungsverlauf",
  "change.historyLoading": "Verlauf wird geladen…",

  "optin.title": "🎃 Hol dir deine eigenen Spooktober-Labels",
  "optin.textBefore":
    "Deine Profiländerungen werden nur gelabelt, wenn du zustimmst: Like oder folge",
  "optin.textAfter":
    "auf Bluesky. Abonniere ihn zusätzlich, um die Labels überall zu sehen.",
  "optin.theLabeler": "dem Labeler",
  "optin.open": "Labeler auf Bluesky öffnen",
  "optin.check": "Erledigt - nochmal prüfen",
  "optin.checking": "Wird geprüft…",
  "optin.notFound":
    "Noch kein Like oder Follow gefunden - es kann einen Moment dauern.",
  "optin.checkFailed": "Prüfung fehlgeschlagen",
  "optin.confirmed": "✅ Du bekommst Spooktober-Labels, weil {via}.",
  "optin.via.like": "du den Labeler likest",
  "optin.via.follow": "du dem Labeler folgst",
  "optin.via.like+follow": "du den Labeler likest und ihm folgst",
  "optin.remove":
    "Nimm Like und Follow bei {labeler} zurück, um sie zu entfernen.",
};

const MESSAGES: Record<Lang, Record<MessageKey, string>> = { en, de };
const STORAGE_KEY = "lang";

function initialLang(): Lang {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "en" || stored === "de") return stored;
  } catch {
    // Storage may be unavailable (private mode); fall back to the browser
  }
  return typeof navigator !== "undefined" &&
    navigator.language.toLowerCase().startsWith("de")
    ? "de"
    : "en";
}

const [lang, setLangSignal] = createSignal<Lang>(initialLang());

export { lang };

/**
 * Switch the language and remember the choice.
 */
export function setLang(next: Lang): void {
  setLangSignal(next);
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Not persisted; the choice still applies for this visit
  }
  document.documentElement.lang = next;
}

/**
 * Translate a message, filling `{name}` placeholders.
 *
 * @param key Message key.
 * @param vars Placeholder values.
 */
export function t(
  key: MessageKey,
  vars: Record<string, string | number> = {},
): string {
  return MESSAGES[lang()][key].replace(/\{(\w+)\}/g, (match, name) =>
    name in vars ? String(vars[name]) : match,
  );
}

/**
 * Locale for dates and numbers in the current language.
 */
export const locale = (): string => (lang() === "de" ? "de-DE" : "en-GB");
