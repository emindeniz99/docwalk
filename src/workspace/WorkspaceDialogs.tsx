import { AlertTriangle, FilePlus, FolderPlus, LayoutTemplate, Pencil, Trash } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  Button,
  Dialog,
  FieldError,
  Form,
  Heading,
  Input,
  Label,
  Modal,
  ModalOverlay,
  Radio,
  RadioGroup,
  Text,
  TextField,
} from "react-aria-components";
import { TEMPLATES, type ProjectTemplate } from "./templates";
import type { Workspace } from "./useWorkspace";
import "./workspace.css";

function Shell({
  label,
  role = "dialog",
  onClose,
  dismissable = true,
  children,
}: {
  label?: string;
  role?: "dialog" | "alertdialog";
  onClose: () => void;
  dismissable?: boolean;
  children: (close: () => void) => ReactNode;
}) {
  return (
    <ModalOverlay
      isOpen
      onOpenChange={(open) => !open && onClose()}
      isDismissable={dismissable}
      className="docwalk-ws-overlay"
    >
      <Modal className="docwalk-ws-modal">
        <Dialog
          role={role}
          className="docwalk-ws-dialog"
          {...(label ? { "aria-label": label } : {})}
        >
          {({ close }) => children(close)}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

function NameForm({
  title,
  Icon,
  label,
  initial,
  submitLabel,
  hint,
  selectStem,
  onSubmit,
  close,
}: {
  title: string;
  Icon: typeof FilePlus;
  label: string;
  initial: string;
  submitLabel: string;
  hint?: string;
  /** Select the name without its extension, so typing replaces only the name. */
  selectStem?: boolean;
  onSubmit: (name: string) => Promise<string | null>;
  close: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    const dot = initial.lastIndexOf(".");
    el.setSelectionRange(0, selectStem && dot > 0 ? dot : initial.length);
  }, [initial, selectStem]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    const problem = await onSubmit(value);
    setBusy(false);
    if (problem) setError(problem);
    else close();
  };

  return (
    <>
      <Heading slot="title">
        <Icon size={20} aria-hidden="true" />
        {title}
      </Heading>
      <Form onSubmit={(e) => void submit(e)} className="docwalk-ws-form">
        <TextField
          value={value}
          onChange={(next) => {
            setValue(next);
            setError(null);
          }}
          isInvalid={error !== null}
          autoFocus
          className="docwalk-ws-field"
        >
          <Label>{label}</Label>
          <Input ref={input} spellCheck={false} autoCapitalize="off" autoComplete="off" />
          {hint && (
            <Text slot="description" className="docwalk-ws-hint">
              {hint}
            </Text>
          )}
          <FieldError className="docwalk-ws-error">{error}</FieldError>
        </TextField>
        <div className="docwalk-ws-actions">
          <Button type="submit" data-variant="primary" className="docwalk-button" isDisabled={busy}>
            {submitLabel}
          </Button>
          <Button slot="close" className="docwalk-button">
            Cancel
          </Button>
        </div>
      </Form>
    </>
  );
}

function ProjectForm({
  onSubmit,
  close,
}: {
  onSubmit: (name: string, template: ProjectTemplate["id"]) => Promise<string | null>;
  close: () => void;
}) {
  const [name, setName] = useState("New project");
  const [template, setTemplate] = useState<ProjectTemplate["id"]>("design");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    const problem = await onSubmit(name, template);
    setBusy(false);
    if (problem) setError(problem);
    else close();
  };
  return (
    <>
      <Heading slot="title">
        <LayoutTemplate size={20} aria-hidden="true" />
        New project
      </Heading>
      <Form onSubmit={(e) => void submit(e)} className="docwalk-ws-form">
        <TextField
          value={name}
          onChange={(next) => {
            setName(next);
            setError(null);
          }}
          isInvalid={error !== null}
          autoFocus
          className="docwalk-ws-field"
        >
          <Label>Project name</Label>
          <Input spellCheck={false} autoComplete="off" />
          <Text slot="description" className="docwalk-ws-hint">
            A new folder with this name.
          </Text>
          <FieldError className="docwalk-ws-error">{error}</FieldError>
        </TextField>
        <RadioGroup
          value={template}
          onChange={(v) => setTemplate(v as ProjectTemplate["id"])}
          className="docwalk-ws-templates"
        >
          <Label>Template</Label>
          {TEMPLATES.map((t) => (
            <Radio key={t.id} value={t.id} className="docwalk-ws-template">
              <span className="docwalk-ws-template-label">{t.label}</span>
              <span className="docwalk-ws-template-description">{t.description}</span>
            </Radio>
          ))}
        </RadioGroup>
        <div className="docwalk-ws-actions">
          <Button type="submit" data-variant="primary" className="docwalk-button" isDisabled={busy}>
            Create project
          </Button>
          <Button slot="close" className="docwalk-button">
            Cancel
          </Button>
        </div>
      </Form>
    </>
  );
}

function Confirm({
  title,
  children,
  actions,
}: {
  title: string;
  children: ReactNode;
  actions: ReactNode;
}) {
  return (
    <>
      <Heading slot="title">
        <AlertTriangle size={20} aria-hidden="true" />
        {title}
      </Heading>
      <div className="docwalk-ws-body">{children}</div>
      <div className="docwalk-ws-actions">{actions}</div>
    </>
  );
}

/** Every dialog the workspace asks, rendered by App so a disk conflict shows in any view. */
export function WorkspaceDialogs({ workspace: w }: { workspace: Workspace }) {
  const d = w.dialog;
  if (!d) return null;
  const dismiss = () => w.setDialog(null);
  const where = (dir: string) =>
    dir
      ? `In ${dir}/`
      : `At the top of ${w.root === "folder" ? (w.folderName ?? "the folder") : "the workspace"}`;

  switch (d.kind) {
    case "new-file":
      return (
        <Shell onClose={dismiss}>
          {(close) => (
            <NameForm
              title="New file"
              Icon={FilePlus}
              label="File name"
              initial="untitled.md"
              selectStem
              submitLabel="Create file"
              hint={`${where(d.dir)}. Without an extension it becomes a .md file.`}
              onSubmit={(name) => w.newFile(d.dir, name)}
              close={close}
            />
          )}
        </Shell>
      );
    case "new-folder":
      return (
        <Shell onClose={dismiss}>
          {(close) => (
            <NameForm
              title="New folder"
              Icon={FolderPlus}
              label="Folder name"
              initial="New folder"
              submitLabel="Create folder"
              hint={`${where(d.dir)}.`}
              onSubmit={(name) => w.newFolder(d.dir, name)}
              close={close}
            />
          )}
        </Shell>
      );
    case "new-project":
      return (
        <Shell onClose={dismiss}>
          {(close) => <ProjectForm onSubmit={(n, t) => w.newProject(n, t)} close={close} />}
        </Shell>
      );
    case "rename":
      return (
        <Shell onClose={dismiss}>
          {(close) => (
            <NameForm
              title={`Rename ${d.node.name}`}
              Icon={Pencil}
              label="New name"
              initial={d.node.name}
              selectStem={d.node.kind === "file"}
              submitLabel="Rename"
              onSubmit={(name) => w.renameEntry(d.node, name)}
              close={close}
            />
          )}
        </Shell>
      );
    case "delete": {
      const folder = d.node.kind === "directory";
      return (
        <Shell role="alertdialog" onClose={dismiss}>
          {(close) => (
            <Confirm
              title={`Delete ${d.node.name}?`}
              actions={
                <>
                  <Button
                    data-variant="primary"
                    className="docwalk-button"
                    onPress={() => void w.removeEntry(d.node).then(close)}
                  >
                    <Trash size={16} aria-hidden="true" />
                    Delete
                  </Button>
                  <Button slot="close" className="docwalk-button" autoFocus>
                    Cancel
                  </Button>
                </>
              }
            >
              <p>
                {folder
                  ? `The folder ${d.node.path} and everything in it will be deleted`
                  : `${d.node.path} will be deleted`}
                {w.root === "folder" ? " from your disk." : " from this browser."} This cannot be
                undone.
              </p>
            </Confirm>
          )}
        </Shell>
      );
    }
    case "discard":
      return (
        <Shell role="alertdialog" onClose={dismiss}>
          {(close) => (
            <Confirm
              title={`Save changes to ${d.path}?`}
              actions={
                <>
                  <Button
                    data-variant="primary"
                    className="docwalk-button"
                    autoFocus
                    onPress={() =>
                      void w.save().then(() => {
                        close();
                        d.proceed();
                      })
                    }
                  >
                    Save
                  </Button>
                  <Button
                    className="docwalk-button"
                    onPress={() => {
                      close();
                      d.proceed();
                    }}
                  >
                    Discard changes
                  </Button>
                  <Button slot="close" className="docwalk-button">
                    Cancel
                  </Button>
                </>
              }
            >
              <p>The file has edits that are not saved to disk yet.</p>
            </Confirm>
          )}
        </Shell>
      );
    case "conflict":
      // Escape and a click outside keep the edits: the choice that loses nothing.
      return (
        <Shell role="alertdialog" onClose={() => w.resolveConflict("mine")}>
          {() => (
            <Confirm
              title={`${d.path} changed on disk`}
              actions={
                <>
                  <Button
                    data-variant="primary"
                    className="docwalk-button"
                    autoFocus
                    onPress={() => w.resolveConflict("mine")}
                  >
                    Keep my edits
                  </Button>
                  <Button className="docwalk-button" onPress={() => w.resolveConflict("disk")}>
                    Load the disk version
                  </Button>
                </>
              }
            >
              <p>
                Another program changed this file while you have unsaved edits here. Keep your edits
                (saving then replaces the disk version), or load the version on disk (your edits are
                lost).
              </p>
            </Confirm>
          )}
        </Shell>
      );
  }
}
