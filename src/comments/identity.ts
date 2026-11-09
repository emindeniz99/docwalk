/**
 * Which document a set of comments belongs to (decision 55: "keyed by
 * document identity").
 *
 * - A document with a home keeps that home as its identity: `?src=` URL
 *   (origin and path only, so no token in its query is ever stored;
 *   decision 120), `?repo=`
 *   path, an opened file's name, or a workspace file's root (and folder) and path. The file at that home can change
 *   upstream and the comments stay with it; a comment whose heading went
 *   away shows as orphaned rather than vanishing with a new hash.
 * - A document that is only text (a share link, the sample) has no home,
 *   so its identity is a SHA-256 of the text as it was opened. Two people
 *   opening the same share link get the same key.
 * - Editing never changes identity: the caller keeps the key it had. The
 *   one draft slot (decision 7) is remembered through the `draft` alias, so
 *   a pasted or edited document finds its comments again after a reload.
 */
import type { DocumentSource } from "../inputs/types";
import { publicSourceUrl } from "../share/link";

/** The alias that names the identity of the document in the draft slot. */
export const DRAFT_ALIAS = "draft";

/** The key for a document with a home, or `null` when only its text identifies it. */
export function sourceKey(source: DocumentSource): string | null {
  switch (source.kind) {
    case "url":
      return `url:${addressOnly(source.url)}`;
    case "repo":
      return `repo:${source.repo}@${source.ref ?? ""}:${source.path}`;
    case "file":
      return `file:${source.name}`;
    // A workspace file is saved under its path and never through the draft
    // slot, so a content hash would lose its comments at the first edit. A
    // local file's key names its folder too: two projects' README.md are two
    // documents.
    case "workspace":
      return source.root === "folder"
        ? `workspace:folder:${source.folder}:${source.path}`
        : `workspace:opfs:${source.path}`;
    default:
      return null;
  }
}

/** A `?src=` URL as origin and path: any query parameter can be a credential, and so can user info. */
function addressOnly(raw: string): string {
  try {
    const url = new URL(raw);
    return url.origin === "null" ? `${url.protocol}${url.pathname}` : url.origin + url.pathname;
  } catch {
    return raw.replace(/[?#].*$/s, "");
  }
}

/**
 * The key a `?src=` document had before decision 120 (the address with only
 * its access parameters and fragment removed), when it differs from today's.
 * Comments and saved marks under it are moved to the new key once, then deleted.
 */
export function legacySourceKey(source: DocumentSource): string | null {
  if (source.kind !== "url") return null;
  const old = `url:${publicSourceUrl(source.url).url}`;
  return old === sourceKey(source) ? null : old;
}

/** `sha256:<hex>` of the document text. */
export async function contentKey(markdown: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(markdown));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}
