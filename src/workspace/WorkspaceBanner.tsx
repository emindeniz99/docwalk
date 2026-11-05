import { FileText, HardDrive } from "lucide-react";
import { Button } from "react-aria-components";
import type { SaveState, Workspace } from "./useWorkspace";
import "./workspace.css";

const LABEL: Record<"opfs" | "folder", Record<SaveState, string>> = {
  opfs: {
    saved: "Saved in this browser",
    saving: "Saving…",
    unsaved: "Saving…",
    missing: "Deleted in another tab",
    error: "Not saved",
  },
  folder: {
    saved: "Saved to disk",
    saving: "Saving…",
    unsaved: "Unsaved changes",
    missing: "Deleted or moved on disk · Save writes it back",
    error: "Not saved",
  },
};

/** Says which workspace file is open and whether its edits are saved; a local file gets a Save button. */
export function WorkspaceBanner({ workspace: w }: { workspace: Workspace }) {
  const source = w.source;
  if (!source) return null;
  const state = w.saveState ?? "saved";
  const folder = source.root === "folder";
  const Icon = folder ? HardDrive : FileText;
  return (
    <p className="docwalk-source-banner docwalk-ws-banner">
      <Icon size={14} aria-hidden="true" />
      <span className="docwalk-source-label">
        {folder ? `${w.folderName ?? "Folder"} · ` : "Workspace · "}
        <strong>{source.path}</strong>
      </span>
      {/* Only a local folder's state is announced: autosave would speak after every pause in typing. */}
      <span className="docwalk-ws-state" data-state={state} {...(folder ? { role: "status" } : {})}>
        {LABEL[source.root][state]}
      </span>
      {folder && (
        <Button
          className="docwalk-button docwalk-ws-save"
          isDisabled={state === "saved"}
          onPress={() => void w.save()}
        >
          Save
        </Button>
      )}
    </p>
  );
}
