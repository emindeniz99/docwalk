/**
 * Sharing (decision 7). A document loaded from a URL or repo shares as that
 * link (`?src=` / `?repo=`); a pasted document shares as a compressed
 * fragment `#doc=<base64url(deflate-raw(utf8))>`, which never reaches a
 * server but stays in browser history. Drafts autosave to localStorage.
 */

/** Above this many URL characters, warn that some apps truncate long links. */
export const FRAGMENT_WARN_CHARS = 8_000;
/** Above this, refuse to build a fragment link and suggest exporting or hosting the file. */
export const FRAGMENT_MAX_CHARS = 60_000;

export const DRAFT_STORAGE_KEY = "docwalk.draft";

export interface ShareLink {
  url: string;
  kind: "source" | "fragment";
  /** Present when the link is long enough that some chat apps may cut it. */
  warning: string | null;
  /** True when comments were asked for but left out because the link would be too long. */
  commentsDropped?: boolean;
}
