/**
 * The workspace (decisions 57, 58): Markdown files and folders kept either in
 * the origin private file system (OPFS) or in a local folder the user picked.
 * Both are `FileSystemDirectoryHandle`s, so one set of file operations
 * (src/workspace/fs.ts) serves both; what differs is the policy around them:
 * the browser workspace autosaves, a local folder saves only when asked and
 * reloads when the file changes on disk.
 */

import type { DocumentSource } from "../inputs/types";

/** Where workspace files live: the browser's private file system, or a folder on disk. */
export type WorkspaceRoot = "opfs" | "folder";

/** A workspace file as a document source; a local one names its folder. */
export type WorkspaceSource = Extract<DocumentSource, { kind: "workspace" }>;

export interface WorkspaceNode {
  /** Slash-separated path from the root, e.g. `notes/plan.md`. Also the tree key. */
  path: string;
  name: string;
  kind: "file" | "directory";
  children?: WorkspaceNode[];
}

/** A listing, and whether it stopped early because the folder is very large. */
export interface WorkspaceListing {
  nodes: WorkspaceNode[];
  truncated: boolean;
}

/** Most entries a listing walks; a picked folder can be a whole repository. */
export const MAX_LISTED_ENTRIES = 5000;
