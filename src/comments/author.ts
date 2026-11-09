/**
 * The display name a writer puts on their comments (decision 97). It lives
 * in this browser's `localStorage` and nowhere else: docwalk has no accounts
 * and asks for none. It leaves the browser only as part of a comment, in a
 * sidecar or a share link.
 */
import { cleanAuthor } from "./schema";
import { MAX_AUTHOR_CHARS } from "./types";

export const AUTHOR_KEY = "docwalk-author";

/** The saved name as typed, or an empty string. Site data can be blocked, so every access is guarded. */
export function readAuthor(): string {
  try {
    return (globalThis.localStorage.getItem(AUTHOR_KEY) ?? "").slice(0, MAX_AUTHOR_CHARS);
  } catch {
    return "";
  }
}

/** Saves the name as typed; a name that is empty or not valid removes the saved one. */
export function writeAuthor(name: string): void {
  try {
    if (cleanAuthor(name) === null) globalThis.localStorage.removeItem(AUTHOR_KEY);
    else globalThis.localStorage.setItem(AUTHOR_KEY, name);
  } catch {
    // Blocked site data: the name lasts for this page only.
  }
}
