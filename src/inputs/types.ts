/**
 * Where a document comes from (decisions 5, 6, 35, 36). Every loader returns
 * the Markdown text plus a description of its source for the banner and the
 * share link. Nothing here renders HTML: loaded text goes through the same
 * sanitizing pipeline as pasted text.
 */

export type DocumentSource =
  | { kind: "sample" }
  | { kind: "paste" }
  | { kind: "file"; name: string }
  /** `?src=<url>`: raw.githubusercontent.com and gist load directly; other origins need a confirmation. */
  | { kind: "url"; url: string; trusted: boolean }
  /** `?repo=<owner>/<name>&path=<path>[&ref=<ref>]`: GitHub contents API, with a token for private repos. */
  | { kind: "repo"; repo: string; path: string; ref: string | null }
  /** `#doc=...`: a share fragment (src/share). */
  | { kind: "fragment" }
  /** A file in the workspace (decisions 57, 58): the browser's private file system or a picked folder. */
  | { kind: "workspace"; root: "opfs"; path: string }
  /** `folder`: which picked folder, by its id in this browser (src/workspace/store.ts `folderId`). */
  | { kind: "workspace"; root: "folder"; folder: string; path: string };

export interface LoadedDocument {
  markdown: string;
  source: DocumentSource;
}

export type LoadError =
  | { kind: "needs-confirmation"; url: string; host: string }
  | { kind: "not-found"; from: "url" | "repo" }
  | { kind: "unauthorized" }
  | { kind: "too-large"; bytes: number }
  | { kind: "network"; message: string }
  | { kind: "invalid"; message: string };

export type LoadResult = { ok: true; doc: LoadedDocument } | { ok: false; error: LoadError };

/** Largest document docwalk loads: big enough for any design doc, small enough to stay responsive. */
export const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;

/** Where tokens live: sessionStorage only, never localStorage or logs (decision 35). */
export const TOKEN_STORAGE_KEY = "docwalk.github-token";
