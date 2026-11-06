import { m } from "../paraglide/messages.js";
import type { Command } from "../shell/CommandPalette";
import type { Workspace } from "./useWorkspace";

/**
 * Workspace entries for the ⌘K palette; none when the browser has neither
 * OPFS nor the folder picker. "Open draft" comes first and stays even then:
 * an opened file or a link can stand in front of the draft too.
 */
export function workspaceCommands(w: Workspace): Command[] {
  const draft = w.draftAvailable
    ? [{ id: "open-draft", label: m.ws_open_draft(), run: w.openDraft }]
    : [];
  if (!w.available) return draft;
  const usable = w.listing !== null;
  return [
    ...draft,
    ...(w.source ? [{ id: "ws-save", label: m.ws_cmd_save(), run: () => void w.save() }] : []),
    ...(usable
      ? [
          {
            id: "ws-new-file",
            label: m.ws_cmd_new_file(),
            run: () => w.setDialog({ kind: "new-file", dir: w.currentDir }),
          },
          {
            id: "ws-new-folder",
            label: m.ws_cmd_new_folder(),
            run: () => w.setDialog({ kind: "new-folder", dir: w.currentDir }),
          },
          {
            id: "ws-new-project",
            label: m.ws_cmd_new_project(),
            run: () => w.setDialog({ kind: "new-project" }),
          },
          { id: "ws-export", label: m.ws_cmd_export(), run: () => void w.exportZip() },
        ]
      : []),
    ...(w.supported.folder
      ? [{ id: "ws-open-folder", label: m.ws_cmd_open_folder(), run: () => void w.openFolder() }]
      : []),
  ];
}
