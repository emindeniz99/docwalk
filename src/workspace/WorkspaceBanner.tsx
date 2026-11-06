import { FileText, HardDrive } from "lucide-react";
import { Button } from "react-aria-components";
import { m } from "../paraglide/messages.js";
import type { SaveState, Workspace } from "./useWorkspace";
import "./workspace.css";

const LABEL: Record<"opfs" | "folder", Record<SaveState, () => string>> = {
  opfs: {
    saved: m.ws_saved_browser,
    saving: m.ws_saving,
    unsaved: m.ws_saving,
    missing: m.ws_deleted_other_tab,
    error: m.ws_not_saved,
  },
  folder: {
    saved: m.ws_saved_disk,
    saving: m.ws_saving,
    unsaved: m.ws_unsaved,
    missing: m.ws_missing_disk,
    error: m.ws_not_saved,
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
        <span className="docwalk-ws-root">
          {`${folder ? (w.folderName ?? m.ws_folder_fallback()) : m.ws_workspace()} · `}
        </span>
        <strong>{source.path}</strong>
      </span>
      {/* Only a local folder's state is announced: autosave would speak after every pause in typing. */}
      <span className="docwalk-ws-state" data-state={state} {...(folder ? { role: "status" } : {})}>
        {LABEL[source.root][state]()}
      </span>
      {folder && (
        <Button
          className="docwalk-button docwalk-ws-save"
          isDisabled={state === "saved"}
          onPress={() => void w.save()}
        >
          {m.ws_save()}
        </Button>
      )}
    </p>
  );
}
