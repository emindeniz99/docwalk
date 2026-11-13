import {
  Check,
  ChevronDown,
  Download,
  Pencil,
  RotateCcw,
  Trash2,
  TriangleAlert,
  Upload,
  X,
} from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Button,
  Dialog,
  FileTrigger,
  Header,
  Input,
  Label,
  ListBox,
  ListBoxItem,
  ListBoxSection,
  Modal,
  ModalOverlay,
  Popover,
  Select,
  SelectValue,
  Text,
  TextArea,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
} from "react-aria-components";
import { downloadBlob } from "../export/download";
import { ariaLocale, useLocale, type Locale } from "../i18n/locale";
import { m } from "../paraglide/messages.js";
import { IconButton } from "../shell/IconButton";
import {
  anchorKey,
  currentKey,
  diagramKey,
  resolveAnchor,
  type AnchorIndex,
  type DiagramNodes,
} from "./anchors";
import { serializeComments } from "./schema";
import { MAX_AUTHOR_CHARS, MAX_COMMENT_CHARS, type Anchor, type DocComment } from "./types";
import type { CommentNotice, CommentsApi } from "./useComments";
import "./comments.css";

interface CommentsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  /** Phone and narrow layouts show the panel as a modal sheet. */
  sheet: boolean;
  api: CommentsApi;
  index: AnchorIndex;
  nodes: DiagramNodes;
  /** What a new comment is about unless the user picks something else: the current slide's heading. */
  defaultAnchor: Anchor | null;
  /** Set when the panel opens from a marker: preselects that anchor. */
  focusAnchor: Anchor | null;
  onGoTo: (sectionId: string) => void;
  /** `<name>.comments.json` */
  sidecarName: string;
}

interface Option {
  key: string;
  anchor: Anchor;
  label: string;
  detail: string | null;
  depth: number;
}

/** Comment times in the UI language's format, one formatter per locale. */
const DATES = new Map<Locale, Intl.DateTimeFormat>();
function dateFormat(locale: Locale): Intl.DateTimeFormat {
  let format = DATES.get(locale);
  if (!format) {
    format = new Intl.DateTimeFormat(ariaLocale(locale), {
      dateStyle: "medium",
      timeStyle: "short",
    });
    DATES.set(locale, format);
  }
  return format;
}

/** Every heading, then every node of every rendered diagram, as anchor choices. */
function anchorOptions(
  index: AnchorIndex,
  nodes: DiagramNodes,
  locale: Locale,
): { headings: Option[]; diagramNodes: Option[] } {
  const headings = index.headings.map((h) => {
    const anchor: Anchor = { kind: "heading", slug: h.slug };
    return {
      key: anchorKey(anchor),
      anchor,
      label: h.title || h.slug,
      detail: null,
      depth: h.depth,
    };
  });
  const titles = new Map(index.headings.map((h) => [h.slug, h.title]));
  const diagramNodes: Option[] = [];
  for (const d of index.diagrams) {
    for (const n of nodes.get(diagramKey(d.heading, d.diagram)) ?? []) {
      // The signature goes on the comment, so it can follow this diagram if diagrams are reordered (decision 96).
      const anchor: Anchor = {
        kind: "node",
        heading: d.heading,
        diagram: d.diagram,
        node: n.id,
        sig: d.sig,
      };
      const number = d.diagram + 1;
      diagramNodes.push({
        key: anchorKey(anchor),
        anchor,
        label: n.label === n.id ? n.id : `${n.label} (${n.id})`,
        detail: d.heading
          ? m.comments_diagram_under(
              { number, heading: titles.get(d.heading) ?? d.heading },
              { locale },
            )
          : m.comments_diagram_at_start({ number }, { locale }),
        depth: 0,
      });
    }
  }
  return { headings, diagramNodes };
}

/** The key of the new comment's text in `Drafts`; comment ids are strings, so it cannot clash. */
const NEW_COMMENT = Symbol("new comment");

/**
 * Text typed into the panel and not yet added or saved (decision 135): the
 * new comment's text, and each open edit's text by comment id. Closing the
 * panel unmounts the forms; this outlives them, in memory only, for one
 * document. The forms own the live text and copy it here as it changes.
 */
type Drafts = Map<string | typeof NEW_COMMENT, string>;

const noDrafts = (): Drafts => new Map();

/**
 * The comments panel (decision 55): add, edit, resolve and delete comments,
 * import and export the sidecar. A side panel beside the deck on wide
 * screens, a modal sheet on narrow ones. Comment text is rendered as React
 * text, never as HTML.
 */
export function CommentsPanel(props: CommentsPanelProps) {
  const titleId = useId();
  // This component stays mounted while the panel is closed, so drafts kept
  // here survive a close. Another document drops them; a key that arrives
  // while the panel is already open is this document's first, and keeps them.
  const [drafts, setDrafts] = useState(noDrafts);
  const [draftKey, setDraftKey] = useState(props.api.key);
  if (draftKey !== props.api.key) {
    setDraftKey(props.api.key);
    if (draftKey !== null) setDrafts(noDrafts());
  }
  if (props.sheet) {
    return (
      <ModalOverlay
        isOpen={props.isOpen}
        onOpenChange={(open) => !open && props.onClose()}
        isDismissable
        className="docwalk-comments-overlay"
      >
        <Modal className="docwalk-comments docwalk-comments-sheet">
          <Dialog className="docwalk-comments-dialog" aria-labelledby={titleId}>
            <PanelBody {...props} titleId={titleId} drafts={drafts} />
          </Dialog>
        </Modal>
      </ModalOverlay>
    );
  }
  if (!props.isOpen) return null;
  return <SidePanel {...props} titleId={titleId} drafts={drafts} />;
}

/** Wide screens: a column beside the deck, not modal, so the deck stays usable while commenting. */
function SidePanel(props: CommentsPanelProps & { titleId: string; drafts: Drafts }) {
  const { titleId } = props;
  // The deck pane narrows when this column mounts and widens when it goes;
  // reveal.js lays the slide out again only on a window resize.
  useLayoutEffect(() => {
    const nudge = () => window.dispatchEvent(new Event("resize"));
    nudge();
    return () => {
      requestAnimationFrame(nudge);
    };
  }, []);
  return (
    <aside
      className="docwalk-comments docwalk-comments-side"
      aria-labelledby={titleId}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented) {
          e.preventDefault();
          props.onClose();
        }
      }}
    >
      <PanelBody {...props} titleId={titleId} focusTitle />
    </aside>
  );
}

function PanelBody({
  api,
  index,
  nodes,
  defaultAnchor,
  focusAnchor,
  onGoTo,
  onClose,
  sidecarName,
  titleId,
  drafts,
  focusTitle = false,
}: CommentsPanelProps & { titleId: string; drafts: Drafts; focusTitle?: boolean }) {
  const [status, setStatus] = useState<CommentNotice | null>(null);
  const [show, setShow] = useState<"open" | "resolved">("open");
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusTitle) titleRef.current?.focus();
  }, [focusTitle]);

  // Option details and anchor labels are in the UI language.
  const locale = useLocale();
  const { headings, diagramNodes } = useMemo(
    () => anchorOptions(index, nodes, locale),
    [index, nodes, locale],
  );
  const options = useMemo(
    () => new Map([...headings, ...diagramNodes].map((o) => [o.key, o] as const)),
    [headings, diagramNodes],
  );

  // Not memoised: anchor labels are in the UI language, and resolving is a
  // lookup per comment.
  const resolved = api.comments.map((c) => ({
    comment: c,
    where: resolveAnchor(c.anchor, index, nodes),
    key: currentKey(c.anchor, index),
  }));
  const orphaned = resolved.filter((r) => r.where.status === "orphaned");
  // Every node of one diagram has the same order: the anchor key keeps each
  // node's comments together, one group per node (decision 132).
  const attached = resolved
    .filter((r) => r.where.status === "attached")
    .toSorted(
      (a, b) =>
        (a.where.status === "attached" ? a.where.order : 0) -
          (b.where.status === "attached" ? b.where.order : 0) ||
        (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) ||
        a.comment.created - b.comment.created,
    );
  const openCount = attached.filter((r) => !r.comment.resolved).length;
  const resolvedCount = attached.length - openCount;
  const shown = attached.filter((r) => r.comment.resolved === (show === "resolved"));

  const groups: { key: string; label: string; sectionId: string | null; items: DocComment[] }[] =
    [];
  for (const { comment, where, key } of shown) {
    if (where.status !== "attached") continue;
    const last = groups.at(-1);
    if (last?.key === key) last.items.push(comment);
    else groups.push({ key, label: where.label, sectionId: where.sectionId, items: [comment] });
  }

  const announce = (notice: CommentNotice) => setStatus(notice);
  // A deleted, resolved or reopened comment leaves the list it was in; its
  // buttons go with it, so focus moves to the panel title instead of the page.
  const removed = (notice: CommentNotice) => {
    announce(notice);
    titleRef.current?.focus();
  };

  return (
    <div className="docwalk-comments-body">
      <div className="docwalk-comments-head">
        <div className="docwalk-comments-heading">
          <h2 id={titleId} ref={titleRef} tabIndex={-1} className="docwalk-comments-title">
            {m.comments_title()}
          </h2>
          <span className="docwalk-comments-count">
            {m.comments_open_count({ count: openCount })}
          </span>
        </div>
        <div className="docwalk-comments-tools">
          <FileTrigger
            acceptedFileTypes={[".json", "application/json"]}
            onSelect={(files) => {
              const file = files?.[0];
              if (file) void api.importFile(file).then(announce);
            }}
          >
            <IconButton label={m.comments_import()} isDisabled={!api.ready}>
              <Upload size={16} aria-hidden="true" />
            </IconButton>
          </FileTrigger>
          <IconButton
            label={m.comments_export({ name: sidecarName })}
            isDisabled={api.comments.length === 0}
            onPress={() => {
              downloadBlob(
                new Blob([serializeComments(api.comments, api.deleted)], {
                  type: "application/json",
                }),
                sidecarName,
              );
              // A name is part of the comment: the file carries it in the clear (decision 97).
              const named = api.comments.some((c) => c.author !== undefined);
              announce({
                message: (named ? m.comments_saved_file_named : m.comments_saved_file)({
                  name: sidecarName,
                }),
                tone: "info",
              });
            }}
          >
            <Download size={16} aria-hidden="true" />
          </IconButton>
          <IconButton label={m.comments_close()} onPress={onClose}>
            <X size={16} aria-hidden="true" />
          </IconButton>
        </div>
      </div>

      {!api.persistent && (
        <p className="docwalk-comments-warning">
          <TriangleAlert size={16} aria-hidden="true" />
          <span>{api.unreadable ? m.comments_unreadable() : m.comments_not_persistent()}</span>
        </p>
      )}

      <AuthorField api={api} />

      <AddComment
        api={api}
        headings={headings}
        diagramNodes={diagramNodes}
        options={options}
        initial={focusAnchor ?? defaultAnchor}
        drafts={drafts}
        onAdded={() => {
          setShow("open");
          announce({ message: m.comments_added(), tone: "info" });
        }}
      />

      <ToggleButtonGroup
        aria-label={m.comments_show()}
        selectionMode="single"
        disallowEmptySelection
        selectedKeys={[show]}
        onSelectionChange={(keys) => {
          const [k] = [...keys];
          if (k === "open" || k === "resolved") setShow(k);
        }}
        className="docwalk-segmented docwalk-comments-filter"
      >
        <ToggleButton id="open">{m.comments_filter_open({ count: openCount })}</ToggleButton>
        <ToggleButton id="resolved">
          {m.comments_filter_resolved({ count: resolvedCount })}
        </ToggleButton>
      </ToggleButtonGroup>

      <div className="docwalk-comments-list">
        {!api.ready ? (
          <p className="docwalk-comments-empty">{m.comments_loading()}</p>
        ) : groups.length === 0 ? (
          <p className="docwalk-comments-empty">
            {show === "open" ? m.comments_none_open() : m.comments_none_resolved()}
          </p>
        ) : (
          groups.map((g) => (
            <section key={g.key} className="docwalk-comments-group" aria-label={g.label}>
              <h3 className="docwalk-comments-anchor">
                {g.sectionId === null ? (
                  g.label
                ) : (
                  <Button
                    className="docwalk-comments-goto"
                    onPress={() => onGoTo(g.sectionId as string)}
                    aria-label={m.comments_show_on_slide({ label: g.label })}
                  >
                    {g.label}
                  </Button>
                )}
              </h3>
              <ul className="docwalk-comments-items">
                {g.items.map((c) => (
                  <CommentItem
                    key={c.id}
                    comment={c}
                    api={api}
                    drafts={drafts}
                    announce={announce}
                    removed={removed}
                  />
                ))}
              </ul>
            </section>
          ))
        )}

        {orphaned.length > 0 && (
          <section
            className="docwalk-comments-group docwalk-comments-orphaned"
            aria-labelledby={`${titleId}-orphaned`}
          >
            <h3 id={`${titleId}-orphaned`} className="docwalk-comments-anchor">
              {m.comments_orphaned({ count: orphaned.length })}
            </h3>
            <p className="docwalk-comments-note">{m.comments_orphaned_note()}</p>
            <ul className="docwalk-comments-items">
              {orphaned.map(({ comment, where }) => (
                <CommentItem
                  key={comment.id}
                  comment={comment}
                  api={api}
                  drafts={drafts}
                  announce={announce}
                  removed={removed}
                  anchorLabel={where.label}
                />
              ))}
            </ul>
          </section>
        )}
      </div>

      <p role="status" className="docwalk-comments-status" data-tone={status?.tone}>
        {status?.message ?? ""}
      </p>
      {status?.action && (
        // The file would delete comments here: they stay until this is pressed (decision 119).
        <Button
          className="docwalk-button docwalk-comments-status-action"
          onPress={() => {
            const next = status.action!.run();
            // A notice without an action takes this button away with it.
            (next.action ? announce : removed)(next);
          }}
        >
          {status.action.label}
        </Button>
      )}
    </div>
  );
}

/** The writer's display name (decision 97): kept in this browser, shown on the comments written under it. */
function AuthorField({ api }: { api: CommentsApi }) {
  return (
    <TextField
      className="docwalk-comments-author-field"
      value={api.author}
      onChange={api.setAuthor}
      maxLength={MAX_AUTHOR_CHARS}
      autoComplete="off"
    >
      <Label className="docwalk-overline">{m.comments_name()}</Label>
      <Input
        className="docwalk-comments-author-input"
        placeholder={m.comments_name_placeholder()}
      />
      <Text slot="description" className="docwalk-comments-note">
        {m.comments_name_note()}
      </Text>
    </TextField>
  );
}

function AddComment({
  api,
  headings,
  diagramNodes,
  options,
  initial,
  drafts,
  onAdded,
}: {
  api: CommentsApi;
  headings: Option[];
  diagramNodes: Option[];
  options: Map<string, Option>;
  initial: Anchor | null;
  drafts: Drafts;
  onAdded: () => void;
}) {
  const initialKey = initial ? anchorKey(initial) : null;
  const [picked, setPicked] = useState<string | null>(null);
  const [text, setTextState] = useState(drafts.get(NEW_COMMENT) ?? "");
  const setText = (next: string) => {
    setTextState(next);
    drafts.set(NEW_COMMENT, next);
  };
  // Another document's panel starts empty, also when it stays open across the switch.
  const [seenDrafts, setSeenDrafts] = useState(drafts);
  if (seenDrafts !== drafts) {
    setSeenDrafts(drafts);
    setTextState(drafts.get(NEW_COMMENT) ?? "");
  }
  const textRef = useRef<HTMLTextAreaElement>(null);
  // A marker or a new slide changes the default and drops an earlier pick
  // (adjusted during render, React's pattern for state that follows a prop).
  const [seenInitial, setSeenInitial] = useState(initialKey);
  if (seenInitial !== initialKey) {
    setSeenInitial(initialKey);
    setPicked(null);
  }
  const key =
    (picked && options.has(picked) ? picked : null) ??
    (initialKey && options.has(initialKey) ? initialKey : null) ??
    headings[0]?.key ??
    diagramNodes[0]?.key ??
    null;
  const target = key ? options.get(key) : undefined;

  if (options.size === 0) {
    return <p className="docwalk-comments-note">{m.comments_no_anchors()}</p>;
  }

  const submit = () => {
    if (!target || text.trim() === "") return;
    if (api.add(target.anchor, text)) {
      setText("");
      // The Add button disables once the text clears, and a disabled button
      // drops focus to <body> (outside the sheet's dialog): keep it here,
      // ready for the next comment.
      textRef.current?.focus();
      onAdded();
    }
  };

  return (
    <form
      className="docwalk-comments-add"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Select
        className="docwalk-select"
        selectedKey={key}
        onSelectionChange={(k) => setPicked(k === null ? null : String(k))}
      >
        <Label className="docwalk-overline">{m.comments_about()}</Label>
        <Button className="docwalk-select-button">
          {/* The label only: a node's "Diagram 1 under …" detail belongs to the list. */}
          <SelectValue>{({ selectedText }) => selectedText}</SelectValue>
          <ChevronDown size={16} aria-hidden="true" />
        </Button>
        <Popover className="docwalk-popover docwalk-comments-popover">
          <ListBox className="docwalk-menu">
            <ListBoxSection>
              <Header className="docwalk-overline docwalk-comments-popover-head">
                {m.comments_headings()}
              </Header>
              {headings.map((o) => (
                <ListBoxItem
                  key={o.key}
                  id={o.key}
                  textValue={o.label}
                  className="docwalk-menu-item docwalk-comments-option"
                  data-depth={o.depth}
                >
                  {o.label}
                </ListBoxItem>
              ))}
            </ListBoxSection>
            {diagramNodes.length > 0 && (
              <ListBoxSection>
                <Header className="docwalk-overline docwalk-comments-popover-head">
                  {m.comments_diagram_nodes()}
                </Header>
                {diagramNodes.map((o) => (
                  <ListBoxItem
                    key={o.key}
                    id={o.key}
                    textValue={o.label}
                    className="docwalk-menu-item docwalk-comments-option"
                  >
                    <span>{o.label}</span>
                    <span className="docwalk-comments-option-detail">{o.detail}</span>
                  </ListBoxItem>
                ))}
              </ListBoxSection>
            )}
          </ListBox>
        </Popover>
      </Select>
      <TextField
        className="docwalk-comments-field"
        value={text}
        onChange={setText}
        maxLength={MAX_COMMENT_CHARS}
        aria-label={m.comments_new()}
      >
        <TextArea
          ref={textRef}
          className="docwalk-comments-textarea"
          placeholder={m.comments_placeholder()}
          rows={3}
          onKeyDown={(e) => {
            // ⌘/Ctrl+Enter posts, like most review tools.
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
        />
      </TextField>
      <Button
        type="submit"
        className="docwalk-button docwalk-comments-submit"
        data-variant="primary"
        isDisabled={!api.ready || text.trim() === "" || !target}
      >
        {m.comments_add()}
      </Button>
    </form>
  );
}

function CommentItem({
  comment,
  api,
  drafts,
  announce,
  removed,
  anchorLabel,
}: {
  comment: DocComment;
  api: CommentsApi;
  drafts: Drafts;
  announce: (n: CommentNotice) => void;
  /** Announces a change that takes the comment out of its list, and moves focus. */
  removed: (n: CommentNotice) => void;
  /** Shown for an orphaned comment: what it used to point at. */
  anchorLabel?: string;
}) {
  // An edit left open when the panel closed opens again with its text.
  const kept = drafts.get(comment.id);
  const [mode, setMode] = useState<"view" | "edit" | "delete">(
    kept === undefined ? "view" : "edit",
  );
  const [draft, setDraftState] = useState(kept ?? comment.text);
  const setDraft = (next: string) => {
    setDraftState(next);
    drafts.set(comment.id, next);
  };
  const edited = comment.updated > comment.created && !comment.resolved;
  const locale = useLocale();

  // Save and Cancel take the focused button away: focus goes to the button
  // that replaces it, so Escape still reaches the panel (decision 135).
  // Escape out of an edit lands on the comment itself: the Edit button's
  // tooltip would open on keyboard focus and take the next Escape.
  const itemRef = useRef<HTMLLIElement>(null);
  const focusNext = useRef<"edit" | "delete" | "item" | null>(null);
  useEffect(() => {
    const target = focusNext.current;
    if (target === null) return;
    focusNext.current = null;
    if (target === "item") itemRef.current?.focus();
    else itemRef.current?.querySelector<HTMLElement>(`[data-comment-action="${target}"]`)?.focus();
  });
  const view = (focus: "edit" | "delete" | "item") => {
    focusNext.current = focus;
    setMode("view");
  };
  const endEdit = (focus: "edit" | "item" = "edit") => {
    drafts.delete(comment.id);
    view(focus);
  };

  let body: ReactNode;
  if (mode === "edit") {
    body = (
      <form
        className="docwalk-comments-edit"
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim() === "") return;
          api.update(comment.id, draft);
          endEdit();
          announce({ message: m.comments_saved(), tone: "info" });
        }}
        onKeyDown={(e) => {
          // Escape cancels the edit first; the next one closes the panel. Stopped
          // here, so neither the side panel nor the sheet's dialog sees this one.
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            setDraftState(comment.text);
            endEdit("item");
          }
        }}
      >
        <TextField
          value={draft}
          onChange={setDraft}
          maxLength={MAX_COMMENT_CHARS}
          aria-label={m.comments_edit()}
          autoFocus
        >
          <TextArea className="docwalk-comments-textarea" rows={3} />
        </TextField>
        <div className="docwalk-comments-actions">
          <Button type="submit" className="docwalk-button" isDisabled={draft.trim() === ""}>
            {m.ws_save()}
          </Button>
          <Button
            className="docwalk-button"
            onPress={() => {
              setDraftState(comment.text);
              endEdit();
            }}
          >
            {m.cancel()}
          </Button>
        </div>
      </form>
    );
  } else {
    body = (
      <>
        <p className="docwalk-comments-text">{comment.text}</p>
        <p className="docwalk-comments-meta">
          {comment.author !== undefined && (
            <>
              {/* Plain text in its own bidi isolate: a name cannot reorder the text around it. */}
              <bdi className="docwalk-comments-author">{comment.author}</bdi>
              <span> · </span>
            </>
          )}
          <time dateTime={new Date(comment.created).toISOString()}>
            {dateFormat(locale).format(comment.created)}
          </time>
          {edited && <span> · {m.comments_edited()}</span>}
          {comment.resolved && <span> · {m.comments_resolved_mark()}</span>}
        </p>
        {mode === "delete" ? (
          <div
            className="docwalk-comments-actions"
            role="group"
            aria-label={m.comments_delete_confirm()}
          >
            <span className="docwalk-comments-confirm">{m.comments_delete_confirm()}</span>
            <Button
              className="docwalk-button docwalk-comments-danger"
              autoFocus
              onPress={() => {
                api.remove(comment.id);
                removed({ message: m.comments_deleted(), tone: "info" });
              }}
            >
              {m.ws_delete()}
            </Button>
            <Button className="docwalk-button" onPress={() => view("delete")}>
              {m.cancel()}
            </Button>
          </div>
        ) : (
          <div className="docwalk-comments-actions">
            <IconButton
              label={m.comments_edit()}
              data-comment-action="edit"
              onPress={() => {
                setDraft(comment.text);
                setMode("edit");
              }}
            >
              <Pencil size={16} aria-hidden="true" />
            </IconButton>
            <IconButton
              label={comment.resolved ? m.comments_reopen() : m.comments_resolve()}
              onPress={() => {
                api.setResolved(comment.id, !comment.resolved);
                // An orphaned comment stays where it is; any other moves to the other filter.
                (anchorLabel ? announce : removed)({
                  message: comment.resolved ? m.comments_reopened() : m.comments_resolved_notice(),
                  tone: "info",
                });
              }}
            >
              {comment.resolved ? (
                <RotateCcw size={16} aria-hidden="true" />
              ) : (
                <Check size={16} aria-hidden="true" />
              )}
            </IconButton>
            <IconButton
              label={m.comments_delete()}
              data-comment-action="delete"
              onPress={() => setMode("delete")}
            >
              <Trash2 size={16} aria-hidden="true" />
            </IconButton>
          </div>
        )}
      </>
    );
  }

  return (
    <li
      ref={itemRef}
      tabIndex={-1}
      className="docwalk-comments-item"
      data-resolved={comment.resolved || undefined}
    >
      {anchorLabel && <p className="docwalk-comments-was">{anchorLabel}</p>}
      {body}
    </li>
  );
}
