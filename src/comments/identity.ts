/**
 * Which document a set of comments belongs to (decision 55: "keyed by
 * document identity").
 *
 * - A document with a home keeps that home as its identity: `?src=` URL
 *   (with access parameters removed, so no token is ever stored), `?repo=`
 *   path, or an opened file's name. The file at that home can change
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
      return `url:${publicSourceUrl(source.url).url}`;
    case "repo":
      return `repo:${source.repo}@${source.ref ?? ""}:${source.path}`;
    case "file":
      return `file:${source.name}`;
    default:
      return null;
  }
}

/** `sha256:<hex>` of the document text. */
export async function contentKey(markdown: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(markdown));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}
