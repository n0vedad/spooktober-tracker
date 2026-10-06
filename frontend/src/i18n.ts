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
  loading: "Loading",
  "theme.title": "Theme",
  "lang.switch": "Deutsch",
  "footer.source": "Source",

  "login.handle": "Handle",
  "login.button": "Login",
  "login.enterHandle": "Please enter your handle.",
  "login.redirecting": "Redirecting you to sign in...",
  "login.loggedInAs": "Logged in as",
  "login.serverDown":
    "The server isn't responding right now. Please try again later.",
  "login.logoutFailed":
    "Logging out on the server didn't work, but you are logged out in this browser.",
  "login.error.resolve_failed":
    "We couldn't find an account for this handle. Is it spelled correctly?",
  "login.error.denied": "You cancelled the login.",
  "login.error.callback_failed": "Login didn't work. Please try again.",
  "login.error.session_failed":
    "Something went wrong on our side. Please try again.",
  "login.error.unknown": "Login didn't work.",
  "login.howTitle": "ℹ️ How logging in works",
  "login.howText":
    "Enter your handle and click \"Login\". You'll be sent to your provider - the server your account lives on - to confirm. You only type your password there, never here. We only learn who you are; we can't post or change anything for you.",

  "faq.title": "❓ FAQ",
  "faq.whatQ": "What is Spooktober Tracker?",
  "faq.whatA":
    "A community project for spooky season: throughout October it shows you who on ATProto changes their handle, display name or avatar - so you can see who's getting spooky! 🎃",
  "faq.howQ": "How does it work?",
  "faq.howA":
    "Our server reads all public profile changes across the network around the clock. You don't need to switch anything on or keep this page open. After logging in you see the changes of the accounts you follow - and, if you like, of your wider network.",
  "faq.dataQ": "What data is stored?",
  "faq.dataA":
    "Only what is public anyway: handles, display names and avatars. We never store passwords, private messages or login tokens. Bots and brand-new accounts still setting up their profile are filtered out.",
  "faq.removeQ": "Can I remove my data?",
  "faq.removeA":
    'Yes. After logging in, click your avatar at the top right and choose "Delete all my data". This removes your own change history.',

  "tracker.heading": "🎃 Changes ({count})",
  "tracker.loadMore": "Show more ({count} left)",
  "tracker.newest": "🕒 Newest first",
  "tracker.closest": "🫂 Closest first",
  "tracker.updatedAgo": "Updated {ago} ago",
  "tracker.updatedJustNow": "Updated just now",
  "tracker.empty":
    "Nothing has changed here yet. We keep watching around the clock - check back later!",
  "tracker.disconnected":
    "⚠️ No connection to the server - new changes can't be loaded right now.",
  "tracker.connectionLost":
    "Connection lost. Check your internet connection and reload the page.",
  "account.menu": "Account menu",
  "account.logout": "Logout",
  "account.delete": "Delete all my data",
  "account.deleteTitle": "⚠️ Really delete all your data?",
  "account.deleteText":
    "Your own change history will be deleted for good and you'll be logged out.",
  "account.deleteConfirm": "Yes, delete for good",
  "account.deleting": "Deleting...",
  "account.cancel": "Cancel",
  "account.deleted": "Your data has been deleted ({count} changes)",
  "account.deleteFailed": "Deleting didn't work",

  "bubble.computing":
    "👻 Mapping your bubble… {done} / {total} follows checked",
  "bubble.waiting":
    "The changes from your network show up here as soon as this is done. It only takes a while the first time.",
  "bubble.failed":
    "Your bubble couldn't be mapped right now - you only see your follows for the time being.",

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

  "optin.title": "🎃 Get your Spooktober labels",
  "optin.textBefore":
    "Your profile changes only get a label if you agree. Just like or follow",
  "optin.textAfter":
    "to opt in. Subscribe to it as well to see the labels everywhere.",
  "optin.theLabeler": "the labeler",
  "optin.open": "Open the labeler's profile",
  "optin.check": "Done - check again",
  "optin.checking": "Checking...",
  "optin.notFound":
    "No like or follow found yet - it can take a moment to show up.",
  "optin.checkFailed": "Checking didn't work",
  "optin.confirmed": "✅ You get Spooktober labels, because {via}.",
  "optin.via.like": "you like the labeler",
  "optin.via.follow": "you follow the labeler",
  "optin.via.like+follow": "you like and follow the labeler",
  "optin.remove":
    "Don't want them anymore? Just unlike and unfollow {labeler}.",
} as const;

export type MessageKey = keyof typeof en;

const de: Record<MessageKey, string> = {
  loading: "Wird geladen",
  "theme.title": "Design",
  "lang.switch": "English",
  "footer.source": "Quellcode",

  "login.handle": "Handle",
  "login.button": "Login",
  "login.enterHandle": "Bitte gib deinen Handle ein.",
  "login.redirecting": "Du wirst zur Anmeldung weitergeleitet…",
  "login.loggedInAs": "Angemeldet als",
  "login.serverDown":
    "Der Server antwortet gerade nicht. Versuch es bitte später noch mal.",
  "login.logoutFailed":
    "Auf dem Server hat das Abmelden nicht geklappt, in diesem Browser bist du aber abgemeldet.",
  "login.error.resolve_failed":
    "Zu diesem Handle haben wir keinen Account gefunden. Ist er richtig geschrieben?",
  "login.error.denied": "Du hast die Anmeldung abgebrochen.",
  "login.error.callback_failed":
    "Die Anmeldung hat nicht geklappt. Versuch es bitte noch mal.",
  "login.error.session_failed":
    "Bei uns ist etwas schiefgegangen. Versuch es bitte noch mal.",
  "login.error.unknown": "Die Anmeldung hat nicht geklappt.",
  "login.howTitle": "ℹ️ So funktioniert die Anmeldung",
  "login.howText":
    "Gib deinen Handle ein und klick auf „Login“. Du landest bei deinem Anbieter – dem Server, auf dem dein Account liegt – und bestätigst dort. Dein Passwort gibst du nur dort ein, nie hier. Wir erfahren nur, wer du bist; posten oder etwas ändern können wir in deinem Namen nicht.",

  "faq.title": "❓ Häufige Fragen",
  "faq.whatQ": "Was ist der Spooktober Tracker?",
  "faq.whatA":
    "Ein Community-Projekt für die Gruselzeit: Den ganzen Oktober über zeigt es dir, wer im ATProto-Netzwerk Handle, Anzeigenamen oder Profilbild ändert – so siehst du, wer sich gerade für Halloween verkleidet! 🎃",
  "faq.howQ": "Wie funktioniert das?",
  "faq.howA":
    "Unser Server liest rund um die Uhr alle öffentlichen Profiländerungen im Netzwerk mit. Du musst dafür nichts einschalten und die Seite auch nicht offen lassen. Nach dem Login siehst du die Änderungen der Accounts, denen du folgst – und auf Wunsch auch die aus deinem weiteren Umfeld.",
  "faq.dataQ": "Welche Daten werden gespeichert?",
  "faq.dataA":
    "Nur, was ohnehin öffentlich ist: Handles, Anzeigenamen und Profilbilder. Passwörter, private Nachrichten oder Zugangsschlüssel speichern wir nie. Bots und frisch angelegte Accounts, die gerade noch ihr Profil einrichten, filtern wir heraus.",
  "faq.removeQ": "Kann ich meine Daten löschen?",
  "faq.removeA":
    "Ja. Klick nach dem Login oben rechts auf dein Profilbild und wähle „Alle meine Daten löschen“. Damit verschwindet dein eigener Änderungsverlauf.",

  "tracker.heading": "🎃 Änderungen ({count})",
  "tracker.loadMore": "Mehr anzeigen (noch {count})",
  "tracker.newest": "🕒 Neueste zuerst",
  "tracker.closest": "🫂 Engste Kontakte zuerst",
  "tracker.updatedAgo": "Aktualisiert vor {ago}",
  "tracker.updatedJustNow": "Gerade aktualisiert",
  "tracker.empty":
    "Hier hat sich noch nichts getan. Wir schauen rund um die Uhr hin – komm einfach später noch mal vorbei!",
  "tracker.disconnected":
    "⚠️ Keine Verbindung zum Server – neue Änderungen lassen sich gerade nicht laden.",
  "tracker.connectionLost":
    "Die Verbindung ist weg. Prüf deine Internetverbindung und lade die Seite neu.",
  "account.menu": "Kontomenü",
  "account.logout": "Abmelden",
  "account.delete": "Alle meine Daten löschen",
  "account.deleteTitle": "⚠️ Wirklich alle Daten löschen?",
  "account.deleteText":
    "Dein eigener Änderungsverlauf wird endgültig gelöscht und du wirst abgemeldet.",
  "account.deleteConfirm": "Ja, endgültig löschen",
  "account.deleting": "Wird gelöscht…",
  "account.cancel": "Abbrechen",
  "account.deleted": "Deine Daten sind gelöscht ({count} Änderungen)",
  "account.deleteFailed": "Das Löschen hat nicht geklappt",

  "bubble.computing":
    "👻 Wir vermessen deine Bubble… {done} von {total} Follows geprüft",
  "bubble.waiting":
    "Sobald das fertig ist, erscheinen hier die Änderungen aus deinem Umfeld. Das dauert nur beim ersten Mal etwas.",
  "bubble.failed":
    "Deine Bubble ließ sich gerade nicht vermessen – du siehst vorerst nur deine Follows.",

  "tier.follows": "Follows",
  "tier.follows.hint": "Accounts, denen du folgst",
  "tier.inner": "Enger Kreis",
  "tier.inner.hint": "Viele deiner Follows folgen ihnen",
  "tier.bubble": "Bubble",
  "tier.bubble.hint": "Mindestens 3 deiner Follows folgen ihnen",
  "tier.edge": "Umfeld",
  "tier.edge.hint": "Mindestens einer deiner Follows folgt ihnen",

  "change.handle": "Handle",
  "change.name": "Anzeigename",
  "change.avatar": "Profilbild",
  "change.noName": "(kein Name)",
  "change.noAvatar": "kein Profilbild",
  "change.avatarGone": "nicht mehr verfügbar",
  "change.oldAvatar": "Vorheriges Profilbild",
  "change.newAvatar": "Neues Profilbild",
  "change.followedBy": "Gemeinsame Follows: {count}",
  "change.history": "Änderungsverlauf",

  "optin.title": "🎃 Hol dir deine Spooktober-Labels",
  "optin.textBefore":
    "Deine Profiländerungen bekommen nur ein Label, wenn du zustimmst. Dazu einfach",
  "optin.textAfter":
    "liken oder folgen. Abonnierst du den Labeler außerdem, siehst du die Labels überall.",
  "optin.theLabeler": "den Labeler",
  "optin.open": "Zum Profil des Labelers",
  "optin.check": "Erledigt – noch mal prüfen",
  "optin.checking": "Wird geprüft…",
  "optin.notFound":
    "Noch kein Like oder Follow gefunden – das kann einen Moment dauern.",
  "optin.checkFailed": "Das Prüfen hat nicht geklappt",
  "optin.confirmed": "✅ Du bekommst Spooktober-Labels, weil {via}.",
  "optin.via.like": "du den Labeler likest",
  "optin.via.follow": "du dem Labeler folgst",
  "optin.via.like+follow": "du den Labeler likest und ihm folgst",
  "optin.remove":
    "Willst du sie nicht mehr? Nimm einfach Like und Follow bei {labeler} zurück.",
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
