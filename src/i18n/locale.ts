import { useSyncExternalStore } from "react";
import { m } from "../paraglide/messages.js";
import { baseLocale, locales, setLocale, type Locale } from "../paraglide/runtime.js";
import { pickLocale } from "./pick";

/**
 * The UI language (decisions 30, 56). The viewer's explicit choice wins and
 * is kept in `localStorage`; until there is one, the browser's language list
 * decides on every visit, so a changed system language is followed. Paraglide
 * gets the result through its global variable; messages read it per call, so
 * a component that renders text re-renders through `useLocale()` (App and the
 * other page roots subscribe, and everything they render follows).
 *
 * Switching never reloads the page: the draft, the slide and every open
 * panel stay as they are (decision 30).
 */
export type { Locale };
export { locales, pickLocale };

export const LOCALE_KEY = "docwalk.locale";

/** React Aria formats dates, numbers and its own labels for these (vite.config.ts keeps only them). */
const ARIA_LOCALES: Record<Locale, string> = { en: "en-US", tr: "tr-TR" };

/** `localStorage` itself, which throws on access where site data is blocked. */
function localStore(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function readStored(): string | null {
  try {
    return localStore()?.getItem(LOCALE_KEY) ?? null;
  } catch {
    return null;
  }
}

const listeners = new Set<() => void>();
let current: Locale = baseLocale;

function apply(locale: Locale): void {
  current = locale;
  setLocale(locale, { reload: false });
  if (typeof document !== "undefined") document.documentElement.lang = locale;
  for (const listener of listeners) listener();
}

if (typeof window !== "undefined") {
  apply(pickLocale(readStored(), navigator.languages ?? [navigator.language]));
  // The presenter window, a follower tab and the main tab follow one switch.
  window.addEventListener("storage", (event) => {
    if (event.key !== LOCALE_KEY && event.key !== null) return;
    const next = pickLocale(readStored(), navigator.languages ?? [navigator.language]);
    if (next !== current) apply(next);
  });
}

/** The viewer's explicit choice: applied at once and remembered in this browser. */
export function chooseLocale(locale: Locale): void {
  try {
    localStore()?.setItem(LOCALE_KEY, locale);
  } catch {
    // Storage can be unavailable (private mode); the language still applies for this visit.
  }
  if (locale !== current) apply(locale);
}

export function getAppLocale(): Locale {
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The current UI locale; a component calling this re-renders when it changes. */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, getAppLocale, getAppLocale);
}

/** A language's name in that language (an endonym), the same in every UI locale. */
export function localeName(locale: Locale): string {
  return locale === "tr" ? m.language_name_tr() : m.language_name_en();
}

/** The locale tag React Aria's I18nProvider gets for a UI locale. */
export function ariaLocale(locale: Locale): string {
  return ARIA_LOCALES[locale];
}
