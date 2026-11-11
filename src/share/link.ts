/**
 * Share links (decision 7). A document that came from a URL or a repo shares
 * as that link, so the recipient loads the current file; anything else
 * shares as a `#doc=` fragment that carries the text itself.
 *
 * No token ever goes into a link: the link starts from the page's origin and
 * path only (never its query or hash), takes no token input, and strips
 * credentials from a `?src=` URL (private raw.githubusercontent.com links
 * carry `?token=`).
 */
import type { DocumentSource } from "../inputs/types";
import { m } from "../paraglide/messages.js";
import { COMMENTS_PARAM, DOC_HASH_PREFIX, encodeDoc } from "./fragment";
import { FRAGMENT_MAX_CHARS, FRAGMENT_WARN_CHARS, type ShareLink } from "./types";

export type ShareLinkResult = { ok: true; link: ShareLink } | { ok: false; message: string };

interface ShareLinkInput {
  source: DocumentSource;
  markdown: string;
  /** The page's own URL; only its origin and path are used. */
  base: string | URL;
  /**
   * Encoded comments (src/comments/payload.ts), sent as `&c=` after the
   * document or as `#c=` on a source link. Left out, with
   * `commentsDropped`, when the link would pass the length cap. Several
   * values may be given, fullest first: the first that fits is used, so
   * the deletions a link carries (decision 95) never cost it its comments.
   */
  comments?: string | readonly string[] | null;
}

// Message functions: a link's text is read in the UI language when the link is built.
export const LONG_LINK_WARNING = m.share_long_link;

export const TOO_LONG_MESSAGE = m.share_too_long;

export const TOKEN_REMOVED_WARNING = m.share_token_removed;

/** Query parameters that grant access and must not be shared. */
const SECRET_PARAM =
  /token|key|secret|signature|password|passwd|credential|session|jwt|^sig$|^auth|^pwd$|^pass$/i;

function appRoot(base: string | URL): URL {
  // Clear the parts rather than rebuilding from `origin`: a file:// page has
  // the opaque origin "null", and `new URL("null/…")` throws.
  const root = new URL(base);
  root.username = "";
  root.password = "";
  root.search = "";
  root.hash = "";
  return root;
}

/** The `?src=` URL without user info or access parameters, plus whether any were removed. */
export function publicSourceUrl(raw: string): { url: string; stripped: boolean } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { url: raw, stripped: false };
  }
  let stripped = url.username !== "" || url.password !== "";
  url.username = "";
  url.password = "";
  // A fetch never sends the hash, so dropping it changes nothing the recipient
  // loads, and an implicit-flow `#access_token=` cannot ride along.
  url.hash = "";
  for (const name of new Set(url.searchParams.keys())) {
    if (SECRET_PARAM.test(name)) {
      url.searchParams.delete(name);
      stripped = true;
    }
  }
  return { url: url.href, stripped };
}

function sourceLink(root: URL, source: Extract<DocumentSource, { kind: "url" | "repo" }>) {
  if (source.kind === "url") {
    const { url, stripped } = publicSourceUrl(source.url);
    root.searchParams.set("src", url);
    return { url: root.href, warning: stripped ? TOKEN_REMOVED_WARNING() : null };
  }
  root.searchParams.set("repo", source.repo);
  root.searchParams.set("path", source.path);
  if (source.ref !== null) root.searchParams.set("ref", source.ref);
  return { url: root.href, warning: null };
}

export async function buildShareLink({
  source,
  markdown,
  base,
  comments = null,
}: ShareLinkInput): Promise<ShareLinkResult> {
  const root = appRoot(base);
  // Comments ride in the fragment, which never reaches a server, and only
  // while the whole link stays under the cap.
  const withComments = (url: string, separator: string) => {
    const options = (typeof comments === "string" ? [comments] : (comments ?? [])).filter(Boolean);
    for (const value of options) {
      const longer = `${url}${separator}${COMMENTS_PARAM}=${value}`;
      if (longer.length <= FRAGMENT_MAX_CHARS) return { url: longer, commentsDropped: false };
    }
    return { url, commentsDropped: options.length > 0 };
  };
  if (source.kind === "url" || source.kind === "repo") {
    const { url, warning } = sourceLink(root, source);
    return { ok: true, link: { kind: "source", warning, ...withComments(url, "#") } };
  }
  const docUrl = `${root.href}${DOC_HASH_PREFIX}${await encodeDoc(markdown)}`;
  if (docUrl.length > FRAGMENT_MAX_CHARS) return { ok: false, message: TOO_LONG_MESSAGE() };
  const { url, commentsDropped } = withComments(docUrl, "&");
  const warning = url.length > FRAGMENT_WARN_CHARS ? LONG_LINK_WARNING() : null;
  return { ok: true, link: { kind: "fragment", url, warning, commentsDropped } };
}
