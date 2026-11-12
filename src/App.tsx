import {
  Download,
  LayoutGrid,
  Moon,
  Monitor,
  Play,
  Share2,
  Sun,
  TableOfContents,
  X,
} from "lucide-react";
import { AnnotationToolbar } from "./annotate/AnnotationToolbar";
import { useAnnotationLayer } from "./annotate/useAnnotationLayer";
import { useSavedMarksLayer } from "./annotate/useSavedMarksLayer";
import { MirrorFeed } from "./annotate/mirrorFeed";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from "react";
import { Button, ToggleButton, ToggleButtonGroup, Tooltip } from "react-aria-components";
import { useSketchRequest } from "./canvas/request";
import { useCommentsUi } from "./comments/useCommentsUi";
import type { DeckController, SlideInfo } from "./deck/controller";
import { Deck, type DeckReport } from "./deck/Deck";
import { observeFocus } from "./deck/focusEvents";
import { COARSE_POINTER, useEditorChoice, useStoredEditorChoice } from "./editor/choice";
import { EditorSlot } from "./editor/EditorSlot";
import { useEditorSync } from "./editor/useEditorSync";
import { getAppLocale, useLocale } from "./i18n/locale";
import { useExportOptions } from "./export/useExportOptions";
import { OpenFileButton } from "./inputs/OpenFileButton";
import type { HealthResponse } from "./api/types";
import { SourceBanner } from "./inputs/SourceBanner";
import { usePresenterWindow } from "./presenter/usePresenterWindow";
import type { RemoteStatus } from "./remote/client";
import { useRemoteRoom } from "./remote/useRemoteRoom";
import { applySelection } from "./sectioning/selection";
import { parseMarkdown, sectionize, type LevelOption } from "./sectioning/sectionize";
import { useDraftAutosave } from "./share/draft";
import { appCommands, appMoreActions, NEXT_THEME } from "./shell/appCommands";
import { CommandPalette } from "./shell/CommandPalette";
import {
  DocumentView,
  linkedTarget,
  sectionAnchor,
  type DocumentTarget,
} from "./shell/DocumentView";
import { documentTitle } from "./shell/documentTitle";
import { IconButton } from "./shell/IconButton";
import { LevelSelect } from "./shell/LevelSelect";
import { ModShortcut } from "./shell/ModShortcut";
import { MoreMenu } from "./shell/MoreMenu";
import { Outline, OutlineSheet } from "./shell/Outline";
import { QuietTooltipTrigger } from "./shell/QuietTooltipTrigger";
import { useTheme } from "./shell/theme";
import { useAppKeys } from "./shell/useAppKeys";
import { useBlockSizeProperty } from "./shell/useBlockSizeProperty";
import { useDocument } from "./shell/useDocument";
import { useLazyDialog } from "./shell/useLazyDialog";
import { useMediaQuery } from "./shell/useMediaQuery";
import { usePhonePane } from "./shell/usePhonePane";
import { usePresenting } from "./shell/usePresenting";
import type { View } from "./shell/view";
import { readInitialSections, useUrlSync } from "./url/useUrlSync";
import { m } from "./paraglide/messages.js";
import { FilesPanel } from "./workspace/FilesPanel";
import { useWorkspace } from "./workspace/useWorkspace";
import { WorkspaceBanner } from "./workspace/WorkspaceBanner";
import { WorkspaceDialogs } from "./workspace/WorkspaceDialogs";

// CodeMirror is the largest single dependency; load it after the deck is up.
const SourceEditor = lazy(() =>
  import("./editor/SourceEditor").then((mod) => ({ default: mod.SourceEditor })),
);
// Monaco (decision 53) is larger still and loads only for viewers who pick it.
// Its own text (find panel, context menu) comes from a table that its modules
// read as they run, so a Turkish viewer's table loads first (decision 102).
const MonacoEditor = lazy(async () => {
  if (getAppLocale() === "tr") await import("monaco-editor/nls/lang/tr");
  const mod = await import("./editor/monaco/MonacoEditor");
  return { default: mod.MonacoEditor };
});
// Dialogs and the exporters (modern-screenshot, the HTML sanitizer, the QR
// encoder) stay out of the first-load bundle (decision 43).
const ShareDialog = lazy(() =>
  import("./share/ShareDialog").then((mod) => ({ default: mod.ShareDialog })),
);
const TokenDialog = lazy(() =>
  import("./inputs/TokenDialog").then((mod) => ({ default: mod.TokenDialog })),
);
// Remote control (decision 8) loads only once a presenter turns it on, or on a follower page.
const RemotePresenter = lazy(() =>
  import("./shell/RemotePresenter").then((mod) => ({ default: mod.RemotePresenter })),
);
const RemoteFollower = lazy(() =>
  import("./shell/RemoteFollower").then((mod) => ({ default: mod.RemoteFollower })),
);
const ExportMenu = lazy(() =>
  import("./export/ExportMenu").then((mod) => ({ default: mod.ExportMenu })),
);
const SlideOverview = lazy(() =>
  import("./deck/SlideOverview").then((mod) => ({ default: mod.SlideOverview })),
);
const SectionPicker = lazy(() =>
  import("./shell/SectionPicker").then((mod) => ({ default: mod.SectionPicker })),
);
// Asks before deleting a document's saved marks (decision 105).
const ClearMarksDialog = lazy(() =>
  import("./annotate/ClearMarksDialog").then((mod) => ({ default: mod.ClearMarksDialog })),
);
// Canvas mode pulls in Excalidraw (several MB); it loads when a diagram is opened as a sketch.
const SketchDialog = lazy(() =>
  import("./canvas/SketchDialog").then((mod) => ({ default: mod.SketchDialog })),
);

const FOLLOW_STATUS: Record<RemoteStatus, () => string> = {
  connecting: m.follow_connecting,
  open: m.follow_open,
  reconnecting: m.follow_reconnecting,
  closed: m.follow_closed,
};

/** Narrow screens move the palette trigger and theme into the overflow menu. */
const PHONE = "(max-width: 640px)";

/**
 * Exit, while presenting. On a head too narrow for one row it is an icon
 * (decision 133, styles.css): its word and Esc leave the eye, stay its
 * accessible name, and show in a tooltip. A wide head shows them on the
 * button, so the tooltip opens only while the label is out of sight.
 */
function ExitButton({ onPress }: { onPress: () => void }) {
  const label = useRef<HTMLSpanElement>(null);
  const [iconOnly, setIconOnly] = useState(false);
  useEffect(() => {
    const el = label.current;
    if (!el) return;
    // The visually hidden label is 1 px wide; the shown one is a word wide.
    const observer = new ResizeObserver(([entry]) =>
      setIconOnly((entry?.contentRect.width ?? 0) < 2),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <QuietTooltipTrigger delay={500} isDisabled={!iconOnly}>
      <Button className="docwalk-button docwalk-exit" onPress={onPress}>
        <X size={18} aria-hidden="true" className="docwalk-exit-icon" />
        <span ref={label} className="docwalk-exit-label">
          {m.app_exit()} <kbd>Esc</kbd>
        </span>
      </Button>
      <Tooltip className="docwalk-tooltip" offset={6}>
        {m.app_exit()} <kbd>Esc</kbd>
      </Tooltip>
    </QuietTooltipTrigger>
  );
}

export function App() {
  // ?view=follow: a read-only screen that follows a presenter (decision 8).
  const [follow] = useState(() => new URLSearchParams(location.search).get("view") === "follow");

  // Every string below follows the UI language; a switch re-renders from here
  // down and keeps the draft, the deck and the open panels (decision 30).
  const locale = useLocale();
  const inputs = useDocument({ follow });
  const { doc, notice, setNotice } = inputs;
  // Files in OPFS or a local folder (decisions 57, 58); an empty workspace changes nothing else.
  const workspace = useWorkspace({ inputs, enabled: !follow });
  const markdown = doc?.markdown ?? "";

  const [level, setLevel] = useState<LevelOption>("auto");
  const [view, setView] = useState<View>("edit");
  const [theme, setTheme] = useTheme();
  const [report, setReport] = useState<DeckReport | null>(null);
  const [controller, setController] = useState<DeckController | null>(null);
  const [current, setCurrent] = useState<SlideInfo | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [revealLine, setRevealLine] = useState<number | null>(null);
  const share = useLazyDialog();
  const overview = useLazyDialog();
  const sectionPicker = useLazyDialog();
  const sketch = useSketchRequest(!follow);
  const phone = useMediaQuery(PHONE);
  const { phonePane, setPhonePane, paneSwitchRef, showPhonePane } = usePhonePane({ view, phone });
  // The update prompt (src/pwa/update.css) sits above the status bar, whose height varies.
  const statusbarRef = useBlockSizeProperty<HTMLElement>("--docwalk-statusbar-size");
  const Editor = useEditorChoice() === "monaco" ? MonacoEditor : SourceEditor;
  // The palette offers the editor not in use, as the More menu does (decisions 53, 102).
  const storedEditor = useStoredEditorChoice();
  const coarse = useMediaQuery(COARSE_POINTER);
  // Static mode has no /api: health stays null and every Worker feature stays hidden (rule 6).
  const [health, setHealth] = useState<HealthResponse | null>(null);
  useEffect(() => {
    let live = true;
    void import("./inputs/health")
      .then((mod) => mod.fetchApiHealth())
      .then((h) => {
        if (live) setHealth(h);
      });
    return () => {
      live = false;
    };
  }, []);
  const deckRef = useRef<HTMLDivElement>(null);
  // What this tab mirrors: the laser, pen marks and diagram focus view. Followers (through
  // RemotePresenter) and the presenter window (through the bridge) subscribe (decision 88).
  const [mirrorFeed] = useState(() => new MirrorFeed());
  useEffect(() => observeFocus((event) => mirrorFeed.focus(event)), [mirrorFeed]);

  // reveal.js lays out on window resize, so nudge it whenever the deck's pane changes size.
  const show = useCallback((next: View | ((v: View) => View)) => {
    setView(next);
    requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
  }, []);

  const root = useMemo(() => parseMarkdown(markdown), [markdown]);
  // Every section of the document: document mode, the editor and the comments keep all of them.
  const plan = useMemo(() => sectionize(root, level), [root, level]);
  // The sections to present, from the link (decision 100). A follower ignores it, so it counts
  // every slide and always has the presenter's current address.
  const [sections, setSections] = useState<string[] | null>(() =>
    follow ? null : readInitialSections(),
  );
  // Another document than the page's first one starts without a choice: ids such as `summary` repeat.
  const [shownDocument, setShownDocument] = useState({ id: inputs.openedId, loaded: doc !== null });
  if (shownDocument.id !== inputs.openedId) {
    setShownDocument({ id: inputs.openedId, loaded: doc !== null });
    if (shownDocument.loaded) setSections(null);
  }
  const selection = useMemo(() => applySelection(plan, sections), [plan, sections]);
  const pickerSections = useMemo(
    () =>
      plan.sections.map((sec) => ({
        id: sec.id,
        label:
          sec.heading === null && sec.title !== ""
            ? m.sections_continued({ title: sec.title }, { locale })
            : sec.title || sec.id,
      })),
    [plan, locale],
  );
  const resolved = plan.levels.length > 0 ? `H${plan.levels.join(", H")}` : m.app_breaks_only();
  const docTitle = !doc ? m.app_loading_document() : documentTitle(root, plan) || m.app_untitled();
  const slides = useMemo(() => controller?.slides() ?? [], [controller]);

  // Document mode reads the whole file: the outline scrolls it to a section,
  // and entering it opens at the section the outline marks as current. A
  // link that opens in document mode does so before the deck has a current
  // slide; its hash names the place instead.
  const [documentTarget, setDocumentTarget] = useState<DocumentTarget | null>(null);
  const [inDocument, setInDocument] = useState(view === "document");
  // On a phone the reading view takes the screen and the outline is a sheet.
  const outlineSheet = phone && view === "document" && !follow;
  const [outlineOpen, setOutlineOpen] = useState(false);
  if (inDocument !== (view === "document")) {
    setInDocument(view === "document");
    setOutlineOpen(false);
    setDocumentTarget(
      view !== "document"
        ? null
        : current
          ? { anchor: sectionAnchor(plan, current.sectionId) }
          : linkedTarget(plan, new URL(window.location.href)),
    );
  }

  const onReport = useCallback((r: DeckReport) => setReport(r), []);
  const onReady = useCallback((c: DeckController | null) => {
    setController(c);
    // While the deck rebuilds, the old slide position and counts describe a deck that is gone.
    if (!c) {
      setCurrent(null);
      setReport(null);
    }
  }, []);

  useEffect(() => controller?.onChange(setCurrent), [controller]);

  // Pasted and opened documents exist nowhere else; App never unmounts, so no debounced save is lost.
  useDraftAutosave(markdown, doc?.source ?? { kind: "sample" });

  // Remote control (decision 8): only when the Worker offers it.
  const { loadFromLink } = inputs;
  const {
    join,
    remoteOn,
    remoteAvailable,
    openRemote,
    followUpdate,
    followOpen,
    onFollowUpdate,
    onFollowDocument,
  } = useRemoteRoom({ follow, health, loadFromLink, setNotice, setLevel });

  // Source line of every section, for the editor's reveal, cursor sync and notes.
  const sectionLines = useMemo(
    () => new Map(plan.sections.map((sec) => [sec.id, sec.line] as const)),
    [plan],
  );

  useUrlSync({
    // A follower shows the presenter's slide (RemoteFollower), never one the URL or a rebuild remembers.
    controller: follow ? null : controller,
    documentId: inputs.openedId,
    level,
    view,
    sections: follow ? undefined : sections,
    onLevel: setLevel,
    // Present needs a user gesture for fullscreen, so a link can open edit or document only.
    onView: (v) => {
      if (v === "edit" || v === "document") show(v);
    },
  });

  const { presenterCountdown, openPresenter } = usePresenterWindow({
    controller,
    markdown,
    level,
    mirrorFeed,
    setNotice,
  });

  const {
    layerRef,
    mode,
    setMode,
    penColor,
    setPenColor,
    boardPage,
    boardStatus,
    setBoardState,
    layerReady,
    setLayerReady,
    toggleBoard,
  } = useAnnotationLayer({
    follow,
    controller,
    view,
    theme,
    slides,
    sketchOpen: sketch.request !== null,
    deckRef,
    setNotice,
  });

  const { frame, staged, fill, chrome, present } = usePresenting({
    view,
    follow,
    followOpen,
    mode,
    deckRef,
    layerRef,
    show,
  });

  const { diagnostics, onCursorLine } = useEditorSync({
    controller,
    plan,
    slides,
    sectionLines,
    view,
    locale,
  });

  useAppKeys({
    follow,
    controller,
    view,
    deckRef,
    openOverview: overview.open,
    setPaletteOpen,
    show,
  });

  const goTo = useCallback(
    (address: string) => {
      controller?.goTo(address);
      if (view === "document") {
        // A reader stays in the reading view, which scrolls to the section.
        setDocumentTarget({ anchor: sectionAnchor(plan, address.split("/")[0] ?? "") });
        setOutlineOpen(false);
        return;
      }
      // Reset first, so revealing the same section twice scrolls again.
      const line = sectionLines.get(address.split("/")[0] ?? "");
      setRevealLine(null);
      if (line) requestAnimationFrame(() => setRevealLine(line));
    },
    [controller, view, plan, sectionLines, setOutlineOpen],
  );

  // Comments (decision 55): App only places the pieces the hook builds.
  const comments = useCommentsUi({
    doc: follow ? null : doc,
    title: docTitle,
    root,
    plan,
    controller,
    current,
    enabled: !follow && view !== "present",
    phone,
    setNotice,
    goTo,
  });
  const { markEdit } = comments;
  const { edit } = inputs;

  // Saved marks (decision 105) and the annotation layer that draws them.
  const { saved, savedMarks, clearMarks, deleteSavedMarks } = useSavedMarksLayer({
    comments,
    follow,
    controller,
    mirrorFeed,
    layerRef,
    setBoardState,
    setLayerReady,
    setNotice,
  });
  const onEdit = useCallback(
    (next: string) => {
      markEdit(next);
      edit(next);
    },
    [markEdit, edit],
  );

  const { chosenNotes, getExportOptions } = useExportOptions({
    controller,
    plan,
    chosen: selection.chosen,
    docTitle,
    savedMarks,
  });

  const oauthClientId = health?.features.includes("oauth") ? health.githubClientId : undefined;
  const signIn = useCallback(() => {
    if (!oauthClientId) return;
    import("./inputs/oauth")
      .then((mod) => mod.startLogin(oauthClientId))
      .catch(() => setNotice({ message: m.app_sign_in_storage(), tone: "error" }));
  }, [oauthClientId, setNotice]);

  const commands = appCommands({
    present,
    openPresenter,
    overview,
    sectionPicker,
    layerReady,
    view,
    boardPage,
    toggleBoard,
    show,
    coarse,
    storedEditor,
    share,
    comments,
    saved,
    clearMarks,
    inputs,
    oauthClientId,
    signIn,
    remoteAvailable,
    openRemote,
    theme,
    setTheme,
    frame,
    resolved,
    setLevel,
    locale,
    workspace,
  });

  const ThemeIcon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;
  const moreActions = appMoreActions({
    phone,
    setPaletteOpen,
    inputs,
    oauthClientId,
    signIn,
    remoteAvailable,
    openRemote,
    openPresenter,
    sectionPicker,
    comments,
    saved,
    clearMarks,
    theme,
    setTheme,
    ThemeIcon,
  });

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file && !follow) workspace.guard(() => void inputs.openFile(file));
  };

  const subline = follow ? (
    <p className="docwalk-source-banner" role="status">
      {followUpdate.incomplete ? FOLLOW_STATUS.closed() : FOLLOW_STATUS[followUpdate.status]()}
    </p>
  ) : !doc ? null : doc.source.kind === "workspace" ? (
    <WorkspaceBanner workspace={workspace} />
  ) : doc.source.kind === "sample" ? (
    <p className="docwalk-source-banner">
      {/* Truncated like every other source line, so a longer translation never wraps the header. */}
      <span className="docwalk-source-label">{m.app_sample_banner()}</span>
    </p>
  ) : (
    <SourceBanner source={doc.source} />
  );

  return (
    <div
      className="docwalk-app"
      data-view={follow ? "follow" : view}
      data-pane={phone && view === "edit" && !follow ? phonePane : undefined}
      data-chrome={chrome.hidden ? "hidden" : chrome.hides ? "shown" : undefined}
      data-frame={staged ? frame : undefined}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      <header className="docwalk-toolbar">
        <div className="docwalk-wordmark" role="img" aria-label="docwalk">
          doc<span>walk</span>
        </div>
        <div className="docwalk-doc-title">
          <strong>{docTitle}</strong>
          {!follow && subline}
        </div>
        {!follow && !phone && (
          <Button className="docwalk-palette-trigger" onPress={() => setPaletteOpen(true)}>
            {m.cmd_palette_trigger()}
            <kbd>
              <ModShortcut keyName="K" />
            </kbd>
          </Button>
        )}
        {!follow && (
          <div className="docwalk-toolbar-actions">
            <ToggleButtonGroup
              aria-label={m.app_view_group()}
              selectionMode="single"
              disallowEmptySelection
              selectedKeys={[view === "present" ? "edit" : view]}
              onSelectionChange={(keys) => {
                const [k] = [...keys];
                if (k === "edit" || k === "document") show(k);
              }}
              className="docwalk-segmented"
            >
              <ToggleButton id="edit">{m.app_view_edit()}</ToggleButton>
              <ToggleButton id="document">{m.app_document()}</ToggleButton>
            </ToggleButtonGroup>
            <OpenFileButton onLoad={(r) => workspace.guard(() => inputs.apply(r))} />
            <Button className="docwalk-button" isDisabled={!doc} onPress={share.open}>
              <Share2 size={16} aria-hidden="true" />
              <span className="docwalk-button-label">{m.app_share()}</span>
            </Button>
            <Suspense
              fallback={
                <Button className="docwalk-button docwalk-export-trigger" isDisabled>
                  <Download size={16} aria-hidden="true" />
                  <span className="docwalk-button-label">{m.app_export()}</span>
                </Button>
              }
            >
              <ExportMenu
                getOptions={getExportOptions}
                hasMarks={saved.count > 0}
                hasNotes={chosenNotes}
                isDisabled={!controller}
              />
            </Suspense>
            {comments.toggle}
            <MoreMenu actions={moreActions} />
            {!phone && (
              <IconButton
                label={m.theme_button({ theme, next: NEXT_THEME[theme] })}
                onPress={() => setTheme(NEXT_THEME[theme])}
              >
                <ThemeIcon size={18} aria-hidden="true" />
              </IconButton>
            )}
          </div>
        )}
        {!follow && (
          <Button
            className="docwalk-button docwalk-present"
            data-variant="primary"
            isDisabled={!doc}
            onPress={() => void present()}
          >
            <Play size={16} aria-hidden="true" /> {m.app_present()}
          </Button>
        )}
      </header>

      <div className="docwalk-banners">
        {inputs.confirm && (
          <SourceBanner
            source={null}
            confirm={inputs.confirm}
            onLoad={() => void inputs.confirmLoad()}
            onCancel={inputs.cancelConfirm}
          />
        )}
        {/* Always mounted, so a new notice is announced (WCAG 4.1.3). */}
        <div role="status" className="docwalk-notice-region">
          {notice && (
            <div className="docwalk-notice" data-tone={notice.tone}>
              <span>{notice.message}</span>
              {notice.action && (
                <Button className="docwalk-button" onPress={notice.action.run}>
                  {notice.action.label}
                </Button>
              )}
              <IconButton label={m.app_dismiss()} onPress={() => setNotice(null)}>
                <X size={16} aria-hidden="true" />
              </IconButton>
            </div>
          )}
        </div>
      </div>

      <main className="docwalk-main">
        {view !== "present" && !follow && !outlineSheet && (
          <aside className="docwalk-sidebar">
            {workspace.available && <FilesPanel workspace={workspace} />}
            <Outline
              slides={slides}
              current={current}
              onSelect={goTo}
              commentCounts={comments.outlineCounts}
            />
            <div className="docwalk-level">
              <LevelSelect value={level} onChange={setLevel} resolved={resolved} />
              <Button
                className="docwalk-button docwalk-sections-trigger"
                isDisabled={!doc}
                onPress={sectionPicker.open}
              >
                {selection.status === "some"
                  ? m.sections_button_some({
                      chosen: selection.chosen.size,
                      total: selection.total,
                    })
                  : m.sections_button_all()}
              </Button>
              {/* Always mounted, so a choice that matches nothing is announced (WCAG 4.1.3). */}
              <p role="status" className="docwalk-sections-status">
                {doc && selection.status === "unknown"
                  ? m.sections_unknown({ count: selection.total })
                  : null}
              </p>
            </div>
          </aside>
        )}
        {outlineSheet && (
          <div className="docwalk-document-bar">
            <Button className="docwalk-button" onPress={() => setOutlineOpen(true)}>
              <TableOfContents size={16} aria-hidden="true" />
              {m.outline_label()}
            </Button>
            <span className="docwalk-document-bar-section">{current?.title ?? ""}</span>
            <OutlineSheet isOpen={outlineOpen} onOpenChange={setOutlineOpen}>
              {workspace.available && <FilesPanel workspace={workspace} />}
              <Outline
                slides={slides}
                current={current}
                onSelect={goTo}
                commentCounts={comments.outlineCounts}
              />
            </OutlineSheet>
          </div>
        )}
        {phone && view === "edit" && !follow && (
          <div ref={paneSwitchRef} className="docwalk-pane-switch">
            <ToggleButtonGroup
              aria-label={m.app_pane_group()}
              selectionMode="single"
              disallowEmptySelection
              selectedKeys={[phonePane]}
              onSelectionChange={(keys) => {
                const [k] = [...keys];
                if (k !== "source" && k !== "preview") return;
                setPhonePane(k);
                requestAnimationFrame(showPhonePane);
              }}
              className="docwalk-segmented"
            >
              <ToggleButton id="source">{m.app_pane_source()}</ToggleButton>
              <ToggleButton id="preview">{m.app_pane_preview()}</ToggleButton>
            </ToggleButtonGroup>
          </div>
        )}
        {view === "edit" && !follow && (
          <section className="docwalk-source" aria-label={m.app_markdown_source()}>
            {doc ? (
              <Suspense fallback={<p className="docwalk-loading">{m.app_loading_editor()}</p>}>
                <EditorSlot
                  Editor={Editor}
                  value={markdown}
                  documentId={inputs.docId}
                  onChange={onEdit}
                  onCursorLine={onCursorLine}
                  revealLine={revealLine}
                  diagnostics={diagnostics}
                  label={m.app_markdown_source()}
                />
              </Suspense>
            ) : (
              <p className="docwalk-loading">{m.app_loading_document()}</p>
            )}
          </section>
        )}
        {view === "document" && !follow && (
          <section className="docwalk-document-pane" aria-label={m.app_document()}>
            <DocumentView
              root={root}
              onRendered={comments.onDocumentRendered}
              scrollTarget={documentTarget}
            />
          </section>
        )}
        <div ref={deckRef} className="docwalk-deck-pane" hidden={view === "document" && !follow}>
          <div className="docwalk-preview-head">
            <strong>
              {current
                ? `${current.index + 1} / ${slides.length}`
                : report?.slides === 0
                  ? "0 / 0"
                  : "…"}
            </strong>
            <span className="docwalk-preview-address">{current?.address ?? ""}</span>
            {/* The header is gone on a follow screen (decision 113): its status and theme button live here. */}
            {follow && subline}
            {follow && (
              <IconButton
                className="docwalk-icon-button docwalk-follow-theme"
                label={m.theme_button({ theme, next: NEXT_THEME[theme] })}
                onPress={() => setTheme(NEXT_THEME[theme])}
              >
                <ThemeIcon size={18} aria-hidden="true" />
              </IconButton>
            )}
            {!follow && (
              <IconButton
                label={m.cmd_overview()}
                aria-keyshortcuts="O"
                className="docwalk-annotate-button docwalk-overview-trigger"
                isDisabled={!controller}
                onPress={overview.open}
              >
                <LayoutGrid size={18} aria-hidden="true" />
              </IconButton>
            )}
            {comments.chip}
            {view === "present" && (
              <ExitButton
                onPress={() => {
                  // This button unmounts on exit; keep focus on the deck, as Escape does.
                  deckRef.current?.querySelector<HTMLElement>(".reveal")?.focus();
                  // Exit leaves the talk, board and all.
                  layerRef.current?.setBoard(null);
                  if (document.fullscreenElement) void document.exitFullscreen();
                  else show("edit");
                }}
              />
            )}
            {!follow && (
              <div className="docwalk-stage-tools">
                <AnnotationToolbar
                  mode={mode}
                  onModeChange={setMode}
                  color={penColor}
                  onColorChange={setPenColor}
                  board={boardPage !== null}
                  onBoardToggle={toggleBoard}
                  onUndo={() => layerRef.current?.undo()}
                  onClear={() => layerRef.current?.clear()}
                />
              </div>
            )}
          </div>
          {doc ? (
            <Deck
              plan={selection.plan}
              locale={locale}
              onReport={onReport}
              onReady={onReady}
              fill={fill}
            />
          ) : (
            <p className="docwalk-stage-wait">
              {follow ? m.follow_waiting() : m.app_loading_document()}
            </p>
          )}
          {report?.slides === 0 && <p className="docwalk-stage-empty">{m.app_stage_empty()}</p>}
          {/* Mounted for the whole session, so the board opening and closing is announced (WCAG 4.1.3). */}
          {!follow && (
            <p role="status" className="docwalk-board-status">
              {boardStatus}
            </p>
          )}
          {/* Mounted for the whole talk, so the first-time hint is announced (WCAG 4.1.3). */}
          {staged && (
            <p role="status" className="docwalk-chrome-hint" data-shown={chrome.hint || undefined}>
              {chrome.hint ? m.present_controls_hint() : null}
            </p>
          )}
        </div>
        {comments.panel}
      </main>

      <footer ref={statusbarRef} className="docwalk-statusbar" aria-label={m.app_status()}>
        <span>
          {m.app_status_level({
            level: level === "auto" ? m.level_auto_resolved({ resolved }) : `H${String(level)}`,
          })}
        </span>
        <span>{report ? m.count_slides({ count: report.slides }) : m.app_status_rendering()}</span>
        <span>
          {report ? m.app_status_notes({ count: slides.filter((s) => s.flagged).length }) : ""}
        </span>
        <span>{report ? m.app_status_diagram_errors({ count: report.diagramErrors }) : ""}</span>
        <span className="docwalk-statusbar-end">{m.app_status_offline()}</span>
      </footer>

      {!follow && (
        <CommandPalette
          isOpen={paletteOpen}
          onOpenChange={setPaletteOpen}
          slides={slides}
          commands={commands}
          onGoTo={goTo}
        />
      )}
      {!follow && <WorkspaceDialogs workspace={workspace} />}
      <Suspense fallback={null}>
        {share.mounted && doc && (
          <ShareDialog
            isOpen={share.isOpen}
            onOpenChange={share.onOpenChange}
            source={doc.source}
            markdown={doc.markdown}
            comments={comments.share}
          />
        )}
        {inputs.tokenOpen && (
          <TokenDialog
            isOpen={inputs.tokenOpen}
            onOpenChange={inputs.setTokenOpen}
            onTokenChange={inputs.tokenChanged}
          />
        )}
        {overview.mounted && (
          <SlideOverview
            isOpen={overview.isOpen}
            onOpenChange={overview.onOpenChange}
            controller={controller}
            current={current?.address ?? null}
            onGoTo={goTo}
          />
        )}
        {sectionPicker.mounted && (
          <SectionPicker
            isOpen={sectionPicker.isOpen}
            onOpenChange={sectionPicker.onOpenChange}
            sections={pickerSections}
            chosen={selection.chosen}
            onApply={setSections}
          />
        )}
        {remoteAvailable && remoteOn && (
          <RemotePresenter
            controller={controller}
            doc={doc}
            level={level}
            mirror={mirrorFeed}
            countdown={presenterCountdown}
            isOpen={join.isOpen}
            onOpenChange={join.onOpenChange}
            edit={onEdit}
            setNotice={setNotice}
          />
        )}
        {clearMarks.mounted && (
          <ClearMarksDialog
            isOpen={clearMarks.isOpen}
            onOpenChange={clearMarks.onOpenChange}
            count={saved.count}
            onConfirm={deleteSavedMarks}
          />
        )}
        {sketch.request && doc && (
          <SketchDialog
            source={sketch.request.source}
            index={sketch.request.index}
            documentSource={doc.source}
            documentTitle={docTitle}
            onClose={sketch.close}
          />
        )}
        {follow && (
          <RemoteFollower
            controller={controller}
            onUpdate={onFollowUpdate}
            onDocument={onFollowDocument}
          />
        )}
      </Suspense>
    </div>
  );
}
