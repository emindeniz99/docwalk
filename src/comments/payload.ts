/**
 * Comments inside a share link (decision 55). They use the share
 * fragment's own encoding (deflate-raw + base64url, src/share/fragment.ts)
 * and the sidecar's JSON shape, so a link and a file carry exactly the same
 * thing and pass the same validation. The value sits after the document as
 * `#doc=…&c=…`, or alone as `#c=…` on a `?src=` / `?repo=` link; a link
 * without it opens as before.
 */
import { m } from "../paraglide/messages.js";
import { COMMENTS_PARAM, decodeDoc, encodeDoc } from "../share/fragment";
import { commentsFile, parseCommentsText, type ParseResult } from "./schema";
import type { DocComment, Tombstone } from "./types";

export const DAMAGED_COMMENTS = m.comments_damaged_link;

function params(hash: string): string[] {
  return (hash.startsWith("#") ? hash.slice(1) : hash).split("&");
}

/** The raw comments value in a location hash, or `null` when it has none. */
export function commentsParam(hash: string): string | null {
  const prefix = `${COMMENTS_PARAM}=`;
  for (const part of params(hash)) if (part.startsWith(prefix)) return part.slice(prefix.length);
  return null;
}

/**
 * The hash without its comments, for after an import: a reload must not
 * bring back a comment deleted since, and a bare `#c=` would keep the slide
 * address out of the URL.
 */
export function hashWithoutComments(hash: string): string {
  const rest = params(hash).filter((p) => p !== "" && !p.startsWith(`${COMMENTS_PARAM}=`));
  return rest.length > 0 ? `#${rest.join("&")}` : "";
}

/**
 * The link value for a list of comments and the deletions that go with them
 * (compact JSON; deflate does the rest). Without deletions the value is
 * exactly what a build before decision 95 wrote.
 */
export async function encodeComments(
  comments: readonly DocComment[],
  deleted: readonly Tombstone[] = [],
): Promise<string> {
  return encodeDoc(JSON.stringify(commentsFile(comments, deleted)));
}

/** Comments from a link value; the same caps as the share fragment apply before any parsing. */
export async function decodeComments(value: string): Promise<ParseResult> {
  const text = await decodeDoc(value);
  if (text === null) return { ok: false, message: DAMAGED_COMMENTS() };
  const result = parseCommentsText(text);
  return result.ok ? result : { ok: false, message: DAMAGED_COMMENTS() };
}
