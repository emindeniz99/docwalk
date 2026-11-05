/** A workspace failure whose message the UI can show as it is. */
export class WorkspaceError extends Error {
  override name = "WorkspaceError";
}
