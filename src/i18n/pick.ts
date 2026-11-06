import { baseLocale, isLocale, type Locale } from "../paraglide/runtime.js";

/**
 * Which language a visit opens in (decision 56): a stored choice if it names
 * a locale docwalk has, else the first of the browser's languages that does
 * (by full tag, then by language), else English. Kept apart from
 * `locale.ts`, which touches `window` and `document`, so a Node test can
 * import it.
 */
export function pickLocale(stored: string | null, languages: readonly string[]): Locale {
  if (stored && isLocale(stored)) return stored;
  for (const tag of languages) {
    const lower = tag.toLowerCase();
    if (isLocale(lower)) return lower;
    const language = lower.split("-")[0] ?? "";
    if (isLocale(language)) return language;
  }
  return baseLocale;
}
