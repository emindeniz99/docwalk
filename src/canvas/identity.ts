import type { DocumentSource } from "../inputs/types";

/**
 * Which document a sketch belongs to (decision 54). A document loaded from
 * a link is that link, so its sketches come back whenever the link is
 * opened again. Documents with no address of their own (the sample, a paste,
 * a share fragment) share one key per kind; the diagram hash still keeps
 * their sketches apart.
 */
export function documentKey(source: DocumentSource): string {
  switch (source.kind) {
    case "url":
      return `url:${source.url}`;
    case "repo":
      return `repo:${source.repo}:${source.ref ?? ""}:${source.path}`;
    case "file":
      return `file:${source.name}`;
    // A local file's key names its folder, as its comments' key does (src/comments/identity.ts).
    case "workspace":
      return source.root === "folder"
        ? `workspace:folder:${source.folder}:${source.path}`
        : `workspace:opfs:${source.path}`;
    default:
      return source.kind;
  }
}

/**
 * SHA-256 of a diagram's source, hex. Keyed by content, not by position: a
 * diagram inserted above another does not hand its sketch to the wrong one,
 * and an edited diagram converts afresh while the old sketch stays stored.
 */
export async function diagramHash(source: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The IndexedDB key of one diagram's sketch in one document. */
export function sketchKey(document: string, hash: string): string {
  return `${document}\n${hash}`;
}

/**
 * The document a sketch key belongs to. A document's key can hold a line
 * break (a file name may), the hash never does, so the last one divides them.
 */
export function sketchKeyDocument(key: string): string {
  const divider = key.lastIndexOf("\n");
  return divider < 0 ? key : key.slice(0, divider);
}

/**
 * The lowest and highest key any sketch of `document` can have, for a key
 * range over all of them. Hashes are hex, so `\uffff` sorts after each; the
 * newline keeps `a.md` from matching `a.md.bak` or `a.md/x`.
 */
export function sketchKeyBounds(document: string): [lower: string, upper: string] {
  return [sketchKey(document, ""), sketchKey(document, "\uffff")];
}
