import type { Command } from "../shell/CommandPalette";
import type { Workspace } from "./useWorkspace";

/** Workspace entries for the ⌘K palette; none when the browser has neither OPFS nor the folder picker. */
export function workspaceCommands(w: Workspace): Command[] {
  if (!w.available) return [];
  const usable = w.listing !== null;
  return [
    ...(w.source ? [{ id: "ws-save", label: "Save file", run: () => void w.save() }] : []),
    ...(usable
      ? [
          {
            id: "ws-new-file",
            label: "New file…",
            run: () => w.setDialog({ kind: "new-file", dir: w.currentDir }),
          },
          {
            id: "ws-new-folder",
            label: "New folder…",
            run: () => w.setDialog({ kind: "new-folder", dir: w.currentDir }),
          },
          {
            id: "ws-new-project",
            label: "New project…",
            run: () => w.setDialog({ kind: "new-project" }),
          },
          { id: "ws-export", label: "Export workspace as zip", run: () => void w.exportZip() },
        ]
      : []),
    ...(w.supported.folder
      ? [{ id: "ws-open-folder", label: "Open local folder…", run: () => void w.openFolder() }]
      : []),
  ];
}
