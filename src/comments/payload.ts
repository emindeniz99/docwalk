/**
 * Comments inside a share link (decision 55). They use the share
 * fragment's own encoding (deflate-raw + base64url, src/share/fragment.ts)
 * and the sidecar's JSON shape, so a link and a file carry exactly the same
 * thing and pass the same validation. The value sits after the document as
 * `#doc=…&c=…`, or alone as `#c=…` on a `?src=` / `?repo=` link; a link
 * without it opens as before.
 */
import { COMMENTS_PARAM, decodeDoc, encodeDoc } from "../share/fragment";
import { parseCommentsText, type ParseResult } from "./schema";
import { SIDECAR_FORMAT, SIDECAR_VERSION, type DocComment } from "./types";

export const DAMAGED_COMMENTS = "The comments in this link are damaged and were not imported.";

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

/** The link value for a list of comments (compact JSON; deflate does the rest). */
export async function encodeComments(comments: readonly DocComment[]): Promise<string> {
  return encodeDoc(JSON.stringify({ format: SIDECAR_FORMAT, version: SIDECAR_VERSION, comments }));
}

/** Comments from a link value; the same caps as the share fragment apply before any parsing. */
export async function decodeComments(value: string): Promise<ParseResult> {
  const text = await decodeDoc(value);
  if (text === null) return { ok: false, message: DAMAGED_COMMENTS };
  const result = parseCommentsText(text);
  return result.ok ? result : { ok: false, message: DAMAGED_COMMENTS };
}
