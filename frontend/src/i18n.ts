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
  "login.enterHandle": "Please enter your handle",
  "login.redirecting": "Redirecting you to sign in...",
  "login.loggedInAs": "Logged in as",
  "login.serverDown":
    "The server isn't responding right now. Please try again later",
  "login.logoutFailed":
    "Logging out on the server didn't work, but you are logged out in this browser",
  "login.error.resolve_failed":
    "We couldn't find an account for this handle. Is it spelled correctly?",
  "login.error.denied": "You cancelled the login",
  "login.error.callback_failed": "Login didn't work. Please try again",
  "login.error.session_failed":
    "Something went wrong on our side. Please try again",
  "login.error.unknown": "Login didn't work. No one knows why",
  "login.howTitle": "ℹ️ How logging in works",
  "login.howText":
    "Enter your handle and click \"Login\". You'll be sent to your provider (the server your account lives on) to confirm \n\n You only need type your password there, never here! We only learn who you are - we can't post or change anything for you",

  "faq.title": "❓ FAQ",
  "faq.whatQ": "What is Spooktober Tracker?",
  "faq.whatA":
    "A community project for spooky season: throughout October it shows you who changes their handle, display name or avatar - so you can see who's getting spooky! 🎃",
  "faq.howQ": "How does it work?",
  "faq.howA":
    "Our server reads all public profile changes across the network around the clock. You don't need to switch anything on or keep this page open. After logging in you see the changes of the accounts you follow - and, if you like, of your bubble",
  "faq.dataQ": "What data is stored?",
  "faq.dataA":
    "Only what is public anyway: handles, display names and avatars. We never store passwords, private messages or login tokens. Bots, brand-new accounts and spammers are filtered out",
  "faq.removeQ": "Can I remove my data?",
  "faq.removeA":
    'Yes. After logging in, click your avatar at the top right and choose "Delete all my data". Everything stored about you is deleted, your labels are removed and nothing is recorded about you from then on. If you change your mind, log in again and rejoin.',

  "tracker.heading": "🎃 Spooky changes ({count})",
  "tracker.loadMore": "Show more ({count} left)",
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
    "Everything stored about you is deleted, your labels are removed and nothing is recorded about you from now on \n\n You have to remove your like, follow and/or subscription of the labeler yourself in your app if you want. You can rejoin by logging in again",
  "account.deleteConfirm": "Yes, delete for good",
  "account.deleting": "Deleting...",
  "account.cancel": "Cancel",
  "account.deleted": "Your data has been deleted and you have been logged out",
  "account.deleteFailed": "Deleting didn't work",

  "paused.title": "⏸️ Nothing is recorded about you",
  "paused.text":
    "You deleted your data recently, which means until you rejoin, your profile changes are neither recorded nor labeled, and you won't see any spooky changes here",
  "paused.resume": "Rejoin",
  "paused.resuming": "Rejoining...",
  "paused.failed": "Rejoining didn't work",
  "paused.admin":
    "⛔ Your account is excluded from the tracker. Please contact admin under @hello.its.katerstrophal.me",

  "bubble.computing":
    "👻 Mapping your bubble… {done} / {total} follows checked",
  "bubble.waiting":
    "The changes from your network show up here as soon as this is done. It only takes a while the first time",
  "bubble.stale":
    "Your bubble couldn't be updated right now - showing the one from {date}. Trying again shortly",
  "bubble.failed":
    "Your bubble couldn't be mapped right now - you only see your follows for the time being. Trying again shortly",

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
  "change.avatarGone": "not available",
  "change.oldAvatar": "Previous avatar",
  "change.newAvatar": "New avatar",
  "change.followedBy": "followed by {count} of your follows",
  "change.history": "Change history",

  "optin.title": "🎃 Get your Spooktober labels",
  "optin.text":
    "Your profile changes only get a label, and you only see the detailed changes here, if you opt in: just like {labeler} or follow it to help build a community database \n\n To see the labels in your app, subscribe to it as well. Without opting in, a subscription still shows you other people's labels, but you get none yourself and no list here",
  "optin.labels": "Labels you can get:",
  "optin.theLabeler": "the labeler",
  "optin.open": "Open the labeler's profile",
  "optin.confirmed":
    "✅ You're in: your profile changes get Spooktober labels and you see the changes here. To see the labels in your app, subscribe to the labeler as well (we can't tell whether you did).",
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
    "Ja. Klick nach dem Login oben rechts auf dein Profilbild und wähle „Alle meine Daten löschen“. Dann wird alles über dich Gespeicherte gelöscht, deine Labels verschwinden und ab da wird nichts mehr über dich erfasst. Überlegst du es dir anders, melde dich wieder an und mach wieder mit.",

  "tracker.heading": "🎃 Änderungen ({count})",
  "tracker.loadMore": "Mehr anzeigen (noch {count})",
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
    "Alles über dich Gespeicherte wird gelöscht, deine Labels verschwinden und ab sofort wird nichts mehr über dich erfasst. Like, Follow und Abo des Labelers entfernst du bitte selbst in deiner App. Mit einem neuen Login kannst du wieder mitmachen.",
  "account.deleteConfirm": "Ja, endgültig löschen",
  "account.deleting": "Wird gelöscht…",
  "account.cancel": "Abbrechen",
  "account.deleted": "Deine Daten sind gelöscht",
  "account.deleteFailed": "Das Löschen hat nicht geklappt",

  "paused.title": "⏸️ Über dich wird nichts erfasst",
  "paused.text":
    "Du hast deine Daten gelöscht. Bis du wieder mitmachst, werden deine Profiländerungen weder erfasst noch gelabelt, und du siehst hier keine Änderungen.",
  "paused.resume": "Wieder mitmachen",
  "paused.resuming": "Einen Moment…",
  "paused.failed": "Das hat nicht geklappt",
  "paused.admin":
    "⛔ Dein Account ist vom Tracker ausgeschlossen. Wende dich bitte an den Admin: @hello.its.katerstrophal.me",

  "bubble.computing":
    "👻 Wir vermessen deine Bubble… {done} von {total} Follows geprüft",
  "bubble.waiting":
    "Sobald das fertig ist, erscheinen hier die Änderungen aus deinem Umfeld. Das dauert nur beim ersten Mal etwas.",
  "bubble.stale":
    "Deine Bubble ließ sich gerade nicht aktualisieren – du siehst die vom {date}. Wir versuchen es gleich noch mal.",
  "bubble.failed":
    "Deine Bubble ließ sich gerade nicht vermessen – du siehst vorerst nur deine Follows. Wir versuchen es gleich noch mal.",

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
  "optin.text":
    "Deine Profiländerungen bekommen nur ein Label, wenn du zustimmst. Gib dazu einfach {labeler} ein Like (das Herz auf dem Profil) oder folge ihm. Abonnierst du den Labeler außerdem, siehst du die Labels überall.",
  "optin.labels": "Diese Labels kannst du bekommen:",
  "optin.theLabeler": "dem Labeler",
  "optin.open": "Zum Profil des Labelers",
  "optin.confirmed":
    "✅ Du machst mit: Deine Profiländerungen bekommen Spooktober-Labels und du siehst hier die Änderungen. Um die Labels in deiner App zu sehen, abonniere den Labeler außerdem (ob du das getan hast, können wir nicht sehen).",
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
