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
    case "workspace":
      return `workspace:${source.root}:${source.path}`;
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
