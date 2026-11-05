import {
  ChevronRight,
  Download,
  Ellipsis,
  FilePlus,
  FileText,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  FolderX,
  Globe,
  HardDrive,
  LayoutTemplate,
  Pencil,
  Trash,
  Upload,
  type LucideIcon,
} from "lucide-react";
import { useId, useMemo, useState, type ReactNode } from "react";
import {
  Button,
  Collection,
  Disclosure,
  DisclosurePanel,
  Heading,
  Menu,
  MenuItem,
  MenuTrigger,
  Popover,
  Separator,
  Tree,
  TreeItem,
  TreeItemContent,
} from "react-aria-components";
import { IconButton } from "../shell/IconButton";
import type { WorkspaceNode } from "./types";
import type { Workspace } from "./useWorkspace";
import "./workspace.css";

interface Action {
  id: string;
  label: string;
  Icon: LucideIcon;
  run: () => void;
  disabled?: boolean;
}

function ActionMenu({
  label,
  actions,
  trigger,
}: {
  label: string;
  actions: Action[];
  trigger: ReactNode;
}) {
  return (
    <MenuTrigger>
      {trigger}
      <Popover className="docwalk-popover" placement="bottom end">
        <Menu
          aria-label={label}
          className="docwalk-menu"
          disabledKeys={actions.filter((a) => a.disabled).map((a) => a.id)}
          onAction={(key) => actions.find((a) => a.id === key)?.run()}
        >
          {actions.map(({ id, label: text, Icon }) =>
            id.startsWith("---") ? (
              <Separator key={id} className="docwalk-files-separator" />
            ) : (
              <MenuItem key={id} id={id} textValue={text} className="docwalk-menu-item">
                <Icon size={16} aria-hidden="true" />
                {text}
              </MenuItem>
            ),
          )}
        </Menu>
      </Popover>
    </MenuTrigger>
  );
}

const SEPARATOR = (id: string): Action => ({
  id: `---${id}`,
  label: "",
  Icon: Folder,
  run: () => {},
});

function index(nodes: WorkspaceNode[], into = new Map<string, WorkspaceNode>()) {
  for (const n of nodes) {
    into.set(n.path, n);
    if (n.children) index(n.children, into);
  }
  return into;
}

/**
 * The file tree beside the outline (decision 57): the browser workspace or a
 * local folder (decision 58), with New file, New folder, New project, rename,
 * delete, and zip import and export. It starts collapsed while the workspace
 * is empty, so the sidebar of a single-document session looks as before.
 */
export function FilesPanel({ workspace: w }: { workspace: Workspace }) {
  const [choice, setChoice] = useState<boolean | null>(null);
  const zipInputId = useId();
  const listing = w.listing;
  const nodes = useMemo(() => listing?.nodes ?? [], [listing]);
  const byPath = useMemo(() => index(nodes), [nodes]);
  const needsPermission = w.root === "folder" && w.folderPermission !== "granted";
  const usable = w.listing !== null;
  const isExpanded = choice ?? (nodes.length > 0 || w.root === "folder");
  const rootLabel = w.folderName ?? "Local folder";

  const hasFolder = w.folderName !== null;
  const menu: Action[] = [
    {
      id: "project",
      label: "New project…",
      Icon: LayoutTemplate,
      run: () => w.setDialog({ kind: "new-project" }),
      disabled: !usable,
    },
    {
      id: "import",
      label: "Import zip…",
      Icon: Upload,
      run: () => document.getElementById(zipInputId)?.click(),
      disabled: !usable,
    },
    {
      id: "export",
      label: "Export as zip",
      Icon: Download,
      run: () => void w.exportZip(),
      disabled: !usable,
    },
    ...(w.supported.folder
      ? [
          SEPARATOR("roots"),
          ...(!hasFolder
            ? []
            : w.root === "folder"
              ? [
                  {
                    id: "browser",
                    label: "Show the browser workspace",
                    Icon: Globe,
                    run: w.useBrowserWorkspace,
                    disabled: !w.supported.opfs,
                  },
                ]
              : [
                  {
                    id: "folder",
                    label: `Show folder ${w.folderName}`,
                    Icon: HardDrive,
                    run: w.useFolder,
                  },
                ]),
          {
            id: "open-folder",
            label: hasFolder ? "Open another folder…" : "Open local folder…",
            Icon: FolderInput,
            run: () => void w.openFolder(),
          },
          ...(hasFolder
            ? [{ id: "close-folder", label: "Close folder", Icon: FolderX, run: w.closeFolder }]
            : []),
        ]
      : []),
  ];

  const rowActions = (node: WorkspaceNode): Action[] => [
    ...(node.kind === "directory"
      ? [
          {
            id: "new-file",
            label: "New file here…",
            Icon: FilePlus,
            run: () => w.setDialog({ kind: "new-file", dir: node.path }),
          },
          {
            id: "new-folder",
            label: "New folder here…",
            Icon: FolderPlus,
            run: () => w.setDialog({ kind: "new-folder", dir: node.path }),
          },
        ]
      : []),
    {
      id: "rename",
      label: "Rename…",
      Icon: Pencil,
      run: () => w.setDialog({ kind: "rename", node }),
    },
    {
      id: "delete",
      label: "Delete…",
      Icon: Trash,
      run: () => w.setDialog({ kind: "delete", node }),
    },
  ];

  const unsaved = w.saveState === "unsaved";
  const rowDependencies = [unsaved, w.openPath];
  const renderNode = (node: WorkspaceNode) => (
    <TreeItem
      id={node.path}
      textValue={node.name}
      hasChildItems={node.kind === "directory"}
      className="docwalk-files-item"
    >
      <TreeItemContent>
        {({ isExpanded: open }) => {
          const Icon = node.kind === "file" ? FileText : open ? FolderOpen : Folder;
          return (
            <div className="docwalk-files-row">
              {node.kind === "directory" ? (
                <Button slot="chevron" className="docwalk-files-chevron">
                  <ChevronRight size={14} aria-hidden="true" />
                </Button>
              ) : (
                <span className="docwalk-files-chevron" aria-hidden="true" />
              )}
              <Icon size={15} aria-hidden="true" className="docwalk-files-icon" />
              <span className="docwalk-files-name">{node.name}</span>
              {unsaved && node.path === w.openPath && (
                <span className="docwalk-files-dirty" role="img" aria-label="Unsaved changes" />
              )}
              <ActionMenu
                label={`Actions for ${node.name}`}
                actions={rowActions(node)}
                trigger={
                  <Button
                    className="docwalk-files-row-menu"
                    aria-label={`Actions for ${node.name}`}
                  >
                    <Ellipsis size={15} aria-hidden="true" />
                  </Button>
                }
              />
            </div>
          );
        }}
      </TreeItemContent>
      {node.children && (
        <Collection items={node.children} dependencies={rowDependencies}>
          {renderNode}
        </Collection>
      )}
    </TreeItem>
  );

  return (
    <Disclosure className="docwalk-files" isExpanded={isExpanded} onExpandedChange={setChoice}>
      <div className="docwalk-files-head">
        <Heading level={2} className="docwalk-files-heading">
          <Button slot="trigger" className="docwalk-files-trigger">
            <ChevronRight size={14} aria-hidden="true" className="docwalk-files-caret" />
            <span className="docwalk-overline">Files</span>
            {/* The browser workspace needs no name here; a folder's name says which folder. */}
            {w.root === "folder" && <span className="docwalk-files-root">{rootLabel}</span>}
          </Button>
        </Heading>
        <IconButton
          label="New file"
          className="docwalk-icon-button docwalk-files-action"
          isDisabled={!usable}
          onPress={() => {
            setChoice(true);
            w.setDialog({ kind: "new-file", dir: w.currentDir });
          }}
        >
          <FilePlus size={16} aria-hidden="true" />
        </IconButton>
        <IconButton
          label="New folder"
          className="docwalk-icon-button docwalk-files-action"
          isDisabled={!usable}
          onPress={() => {
            setChoice(true);
            w.setDialog({ kind: "new-folder", dir: w.currentDir });
          }}
        >
          <FolderPlus size={16} aria-hidden="true" />
        </IconButton>
        <ActionMenu
          label="Workspace actions"
          actions={menu}
          trigger={
            <IconButton
              label="Workspace actions"
              className="docwalk-icon-button docwalk-files-action"
            >
              <Ellipsis size={16} aria-hidden="true" />
            </IconButton>
          }
        />
        <input
          id={zipInputId}
          type="file"
          accept=".zip,application/zip"
          hidden
          aria-hidden="true"
          tabIndex={-1}
          onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            e.currentTarget.value = "";
            if (file) {
              setChoice(true);
              void w.importZip(file);
            }
          }}
        />
      </div>
      <DisclosurePanel className="docwalk-files-panel">
        {needsPermission ? (
          <div className="docwalk-files-note">
            <p>
              Allow docwalk to open <strong>{w.folderName}</strong> again to see its files.
            </p>
            <Button className="docwalk-button" onPress={() => void w.reconnect()}>
              <HardDrive size={16} aria-hidden="true" />
              Reconnect
            </Button>
          </div>
        ) : w.listing === null ? (
          <p className="docwalk-files-note">
            {w.supported.opfs ? "Loading files…" : "This browser cannot keep files for docwalk."}
          </p>
        ) : nodes.length === 0 ? (
          <div className="docwalk-files-note">
            <p>
              {w.root === "folder"
                ? `No Markdown files in ${w.folderName ?? "this folder"}.`
                : "Keep Markdown files in this browser. Nothing is uploaded."}
            </p>
            <Button className="docwalk-button" onPress={() => w.setDialog({ kind: "new-project" })}>
              <LayoutTemplate size={16} aria-hidden="true" />
              New project
            </Button>
          </div>
        ) : (
          <>
            <Tree
              aria-label={w.root === "folder" ? `Files in ${rootLabel}` : "Files in this browser"}
              className="docwalk-files-tree"
              items={nodes}
              // React Aria caches rows by item; the unsaved dot depends on more than the item.
              dependencies={rowDependencies}
              selectionMode="single"
              selectedKeys={w.openPath ? [w.openPath] : []}
              expandedKeys={w.expanded}
              onExpandedChange={(keys) => w.setExpanded(new Set([...keys].map(String)))}
              // With a selection mode, React Aria reports presses and Enter as selection changes.
              onSelectionChange={(keys) => {
                const [key] = keys === "all" ? [] : [...keys];
                const node = key === undefined ? undefined : byPath.get(String(key));
                if (!node) return;
                if (node.kind === "file") w.openFile(node.path);
                else
                  w.setExpanded((prev) => {
                    const next = new Set(prev);
                    if (!next.delete(node.path)) next.add(node.path);
                    return next;
                  });
              }}
            >
              {renderNode}
            </Tree>
            {w.listing.truncated && (
              <p className="docwalk-files-note">
                This folder is very large: only the first entries are listed.
              </p>
            )}
          </>
        )}
      </DisclosurePanel>
    </Disclosure>
  );
}
