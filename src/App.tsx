import {
  Cast,
  Command as CommandIcon,
  Download,
  KeyRound,
  LayoutGrid,
  LogIn,
  Moon,
  Monitor,
  MonitorPlay,
  Play,
  Search,
  Share2,
  Sun,
  X,
} from "lucide-react";
import {
  AnnotationToolbar,
  PEN_COLORS,
  resolvePenColor,
  type PenColor,
} from "./annotate/AnnotationToolbar";
import type { AnnotationLayer, AnnotationMode } from "./annotate/types";
import { useAnnotationShortcuts } from "./annotate/useAnnotationShortcuts";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from "react";
import { Button, ToggleButton, ToggleButtonGroup } from "react-aria-components";
import { useSketchRequest } from "./canvas/request";
import { useCommentsUi } from "./comments/useCommentsUi";
import { clonePages, type DeckController, type SlideInfo } from "./deck/controller";
import { Deck, SLIDE_SIZE, type DeckReport } from "./deck/Deck";
import { useOverviewShortcut } from "./deck/useOverviewShortcut";
import { useEditorChoice } from "./editor/choice";
import type { EditorDiagnostic } from "./editor/types";
import type { ExportOptions } from "./export/types";
import { OpenFileButton } from "./inputs/OpenFileButton";
import type { HealthResponse } from "./api/types";
import { SourceBanner } from "./inputs/SourceBanner";
import { startPresenterBridge } from "./presenter/bridge";
import { openPresenterWindow } from "./presenter/window";
import type { RemoteStatus } from "./remote/client";
import { parseMarkdown, sectionize, type LevelOption } from "./sectioning/sectionize";
import { useDraftAutosave } from "./share/draft";
import { CommandPalette, type Command } from "./shell/CommandPalette";
import { DocumentView } from "./shell/DocumentView";
import { documentTitle } from "./shell/documentTitle";
import { IconButton } from "./shell/IconButton";
import { LevelSelect } from "./shell/LevelSelect";
import { MoreMenu, type MoreAction } from "./shell/MoreMenu";
import { Outline } from "./shell/Outline";
import { useTheme, type ThemeChoice } from "./shell/theme";
import { useBlockSizeProperty } from "./shell/useBlockSizeProperty";
import { useDocument } from "./shell/useDocument";
import { useMediaQuery } from "./shell/useMediaQuery";
import type { FollowUpdate } from "./shell/RemoteFollower";
import { useUrlSync } from "./url/useUrlSync";
import { workspaceCommands } from "./workspace/commands";
import { FilesPanel } from "./workspace/FilesPanel";
import { useWorkspace } from "./workspace/useWorkspace";
import { WorkspaceBanner } from "./workspace/WorkspaceBanner";
import { WorkspaceDialogs } from "./workspace/WorkspaceDialogs";

type View = "edit" | "document" | "present";

// CodeMirror is the largest single dependency; load it after the deck is up.
const SourceEditor = lazy(() =>
  import("./editor/SourceEditor").then((m) => ({ default: m.SourceEditor })),
);
// Monaco (decision 53) is larger still and loads only for viewers who pick it.
const MonacoEditor = lazy(() =>
  import("./editor/monaco/MonacoEditor").then((m) => ({ default: m.MonacoEditor })),
);
// Dialogs and the exporters (modern-screenshot, the HTML sanitizer, the QR
// encoder) stay out of the first-load bundle (decision 43).
const ShareDialog = lazy(() =>
  import("./share/ShareDialog").then((m) => ({ default: m.ShareDialog })),
);
const TokenDialog = lazy(() =>
  import("./inputs/TokenDialog").then((m) => ({ default: m.TokenDialog })),
);
// Remote control (decision 8) loads only once a presenter turns it on, or on a follower page.
const RemotePresenter = lazy(() =>
  import("./shell/RemotePresenter").then((m) => ({ default: m.RemotePresenter })),
);
const RemoteFollower = lazy(() =>
  import("./shell/RemoteFollower").then((m) => ({ default: m.RemoteFollower })),
);
const ExportMenu = lazy(() =>
  import("./export/ExportMenu").then((m) => ({ default: m.ExportMenu })),
);
const SlideOverview = lazy(() =>
  import("./deck/SlideOverview").then((m) => ({ default: m.SlideOverview })),
);
// Canvas mode pulls in Excalidraw (several MB); it loads when a diagram is opened as a sketch.
const SketchDialog = lazy(() =>
  import("./canvas/SketchDialog").then((m) => ({ default: m.SketchDialog })),
);

const LEVELS: { label: string; value: LevelOption }[] = [
  { label: "Auto", value: "auto" },
  { label: "H1", value: 1 },
  { label: "H2", value: 2 },
  { label: "H3", value: 3 },
];

const NEXT_THEME: Record<ThemeChoice, ThemeChoice> = {
  system: "light",
  light: "dark",
  dark: "system",
};

const FOLLOW_STATUS: Record<RemoteStatus, string> = {
  connecting: "Connecting to the presenter…",
  open: "Following the presenter",
  reconnecting: "Reconnecting to the presenter…",
  closed: "Not connected",
};

/** Narrow screens move the palette trigger and theme into the overflow menu. */
const PHONE = "(max-width: 640px)";

/** Mounts a lazily loaded dialog on first open and keeps it mounted, so closing animates and restores focus. */
function useLazyDialog() {
  const [isOpen, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const onOpenChange = useCallback((open: boolean) => {
    if (open) setMounted(true);
    setOpen(open);
  }, []);
  return { isOpen, mounted, onOpenChange, open: () => onOpenChange(true) };
}

export function App() {
  // ?view=follow: a read-only screen that follows a presenter (decision 8).
  const [follow] = useState(() => new URLSearchParams(location.search).get("view") === "follow");

  const inputs = useDocument({ follow });
  const { doc, notice, setNotice } = inputs;
  // Files in OPFS or a local folder (decisions 57, 58); an empty workspace changes nothing else.
  const workspace = useWorkspace({ inputs, enabled: !follow });
  const markdown = doc?.markdown ?? "";

  const [level, setLevel] = useState<LevelOption>("auto");
  const [view, setView] = useState<View>("edit");
  // On a phone the edit view shows the source or the slide preview, not both.
  const [phonePane, setPhonePane] = useState<"source" | "preview">("source");
  // Leaving present mode on a phone lands on the deck just presented (and on
  // the focus Exit and Escape keep there), not on the source pane.
  const [lastView, setLastView] = useState(view);
  const paneSwitchRef = useRef<HTMLDivElement>(null);
  if (lastView !== view) {
    setLastView(view);
    if (lastView === "present") setPhonePane("preview");
  }
  const [theme, setTheme] = useTheme();
  const [report, setReport] = useState<DeckReport | null>(null);
  const [controller, setController] = useState<DeckController | null>(null);
  const [current, setCurrent] = useState<SlideInfo | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [revealLine, setRevealLine] = useState<number | null>(null);
  const [presenterRequested, setPresenterRequested] = useState(false);
  const [mode, setMode] = useState<AnnotationMode>("off");
  const [penColor, setPenColor] = useState<PenColor>(PEN_COLORS[0].variable);
  const share = useLazyDialog();
  const join = useLazyDialog();
  const overview = useLazyDialog();
  const [remoteOn, setRemoteOn] = useState(false);
  const sketch = useSketchRequest(!follow);
  const phone = useMediaQuery(PHONE);
  // The update prompt (src/pwa/update.css) sits above the status bar, whose height varies.
  const statusbarRef = useBlockSizeProperty<HTMLElement>("--docwalk-statusbar-size");
  const Editor = useEditorChoice() === "monaco" ? MonacoEditor : SourceEditor;
  // Static mode has no /api: health stays null and every Worker feature stays hidden (rule 6).
  const [health, setHealth] = useState<HealthResponse | null>(null);
  useEffect(() => {
    let live = true;
    void import("./inputs/oauth")
      .then((m) => m.fetchApiHealth())
      .then((h) => {
        if (live) setHealth(h);
      });
    return () => {
      live = false;
    };
  }, []);
  const deckRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<AnnotationLayer | null>(null);
  const startedAt = useRef(0);
  // The presenter bridge reads the latest document through refs, so it is not restarted on every keystroke.
  const markdownRef = useRef(markdown);
  const levelRef = useRef(level);
  useLayoutEffect(() => {
    markdownRef.current = markdown;
    levelRef.current = level;
  });

  // reveal.js lays out on window resize, so nudge it whenever the deck's pane changes size.
  const show = useCallback((next: View | ((v: View) => View)) => {
    setView(next);
    requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
  }, []);

  const root = useMemo(() => parseMarkdown(markdown), [markdown]);
  const plan = useMemo(() => sectionize(root, level), [root, level]);
  const resolved = plan.levels.length > 0 ? `H${plan.levels.join(", H")}` : "breaks only";
  const docTitle = !doc ? "Loading document…" : documentTitle(root, plan) || "Untitled";
  const slides = useMemo(() => controller?.slides() ?? [], [controller]);

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

  // ---- Remote control (decision 8): only when the Worker offers it -------
  // Feature-detected through /api/health and hidden in static mode (AGENTS.md rule 6).
  const remoteAvailable = !follow && health?.features.includes("remote") === true;

  const [followUpdate, setFollowUpdate] = useState<FollowUpdate>({
    status: "connecting",
    state: null,
    incomplete: false,
  });
  const { loadFromLink } = inputs;
  // Called once for each document the presenter announces, so a follower
  // picks up an edit or a newly opened document; null when there is no link.
  const onFollowDocument = useCallback(
    (link: string | null) => {
      if (link) void loadFromLink(link);
      else
        setNotice({
          message: "The presenter's document is too long to send here. Open it yourself.",
          tone: "error",
        });
    },
    [loadFromLink, setNotice],
  );
  const onFollowUpdate = useCallback((update: FollowUpdate) => {
    setFollowUpdate(update);
    // Section ids, and so the presenter's slide addresses, depend on the slide level.
    const next = update.state?.level;
    if (next !== undefined)
      setLevel((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  }, []);
  useEffect(() => {
    if (followUpdate.incomplete)
      setNotice({
        message: "This follow link is incomplete. Ask the presenter for the link again.",
        tone: "error",
      });
  }, [followUpdate.incomplete, setNotice]);

  // Source line of every section, for the editor's reveal, cursor sync and notes.
  const sectionLines = useMemo(
    () => new Map(plan.sections.map((sec) => [sec.id, sec.line] as const)),
    [plan],
  );

  useUrlSync({
    // A follower shows the presenter's slide (RemoteFollower), never one the URL or a rebuild remembers.
    controller: follow ? null : controller,
    level,
    view,
    onLevel: setLevel,
    // Present needs a user gesture for fullscreen, so a link can open edit or document only.
    onView: (v) => {
      if (v === "edit" || v === "document") show(v);
    },
  });

  // Presenter bridge: only in the tab that opened the presenter window, so two
  // open docwalk tabs never both answer it.
  useEffect(() => {
    if (!controller || !presenterRequested) return;
    return startPresenterBridge({
      getState: () => ({
        markdown: markdownRef.current,
        level: typeof levelRef.current === "object" ? [...levelRef.current] : levelRef.current,
        current: controller.current()?.address ?? "",
        addresses: controller.slides().map((sl) => sl.address),
        startedAt: startedAt.current,
      }),
      goTo: (address) => controller.goTo(address),
      step: (d) => (d === 1 ? controller.next() : controller.prev()),
      subscribe: (onChange) => controller.onChange(() => onChange()),
    });
  }, [controller, presenterRequested]);

  // Pen and laser over the slides; each slide keeps its own marks while the deck is open.
  // The layer (drauu, perfect-freehand) loads after the deck is up, outside the first-load bundle.
  const [layerReady, setLayerReady] = useState(0);
  useEffect(() => {
    if (!controller) return;
    let cancelled = false;
    let stop: (() => void) | undefined;
    void import("./annotate/layer").then(({ createAnnotationLayer }) => {
      if (cancelled) return;
      const layer = createAnnotationLayer(controller.stage());
      layerRef.current = layer;
      stop = controller.onChange((sl) => layer.setKey(sl.address));
      setLayerReady((n) => n + 1);
    });
    return () => {
      cancelled = true;
      stop?.();
      layerRef.current?.destroy();
      layerRef.current = null;
    };
  }, [controller]);
  useEffect(() => {
    if (layerReady) layerRef.current?.setMode(mode);
  }, [mode, layerReady]);
  // The pen colour is a CSS variable whose value changes with the theme, so
  // `theme` re-resolves it even though the body does not read it.
  useEffect(() => {
    if (layerReady) layerRef.current?.setColor(resolvePenColor(penColor));
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [penColor, theme, layerReady]);
  useAnnotationShortcuts(
    {
      mode,
      setMode,
      undo: () => layerRef.current?.undo(),
      redo: () => layerRef.current?.redo(),
    },
    // Presenting, the keys work anywhere. In the edit view the toolbar is on screen
    // too, so they work while focus is in the deck pane (the slide or the toolbar).
    // A sketch owns its keys (P, A, E are Excalidraw tools too).
    !follow && !sketch.request,
    view === "present" ? undefined : deckRef,
  );

  // O opens the slide overview: anywhere while presenting, from the deck pane while editing.
  useOverviewShortcut(
    overview.open,
    !follow && controller !== null && view !== "document",
    view === "present" ? undefined : deckRef,
  );

  // Notes on slides become editor diagnostics at their section's source line.
  const diagnostics = useMemo<EditorDiagnostic[]>(
    () =>
      slides
        .filter((sl) => sl.flagged)
        .map((sl) => ({
          line: sectionLines.get(sl.sectionId) ?? 1,
          message: `Slide ${sl.index + 1} (${sl.address}): ${sl.note ?? "has a note"}`,
          severity: "warning" as const,
        })),
    [slides, sectionLines],
  );

  // The preview follows the cursor while editing.
  const onCursorLine = useCallback(
    (line: number) => {
      if (!controller) return;
      let target: string | null = null;
      for (const sec of plan.sections) if (sec.line <= line) target = sec.id;
      if (target && controller.current()?.sectionId !== target) controller.goTo(target);
    },
    [controller, plan],
  );

  const openPresenter = useCallback(() => {
    if (!openPresenterWindow()) {
      setNotice({
        message:
          "The browser blocked the presenter window. Allow pop-ups for this site and try again.",
        tone: "error",
      });
      return;
    }
    startedAt.current = Date.now();
    setPresenterRequested(true);
    setNotice(null);
  }, [setNotice]);

  const present = useCallback(async () => {
    show("present");
    try {
      // The whole page goes fullscreen, not just the deck: dialogs such as the
      // command palette render outside the deck and would be invisible.
      await document.documentElement.requestFullscreen?.();
    } catch {
      // Fullscreen can be refused (iOS, iframes); present mode still fills the window.
    }
    deckRef.current?.querySelector<HTMLElement>(".reveal")?.focus();
  }, [show]);

  useEffect(() => {
    const onFullscreen = () => {
      if (document.fullscreenElement) return;
      // Browsers keep Escape for leaving fullscreen and the page never sees
      // the key. With a dialog open (slide overview, sketch, palette) that
      // Escape was meant for the dialog: hand it over and keep presenting,
      // windowed, as a page without fullscreen would.
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && focused.closest('[role="dialog"]')) {
        focused.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );
        return;
      }
      show((v) => (v === "present" ? "edit" : v));
    };
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => document.removeEventListener("fullscreenchange", onFullscreen);
  }, [show]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!follow && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      // Without fullscreen (refused on iOS, in iframes, or headless) Escape is
      // the only way out of present mode, so handle it here too. The pen and
      // laser claim Escape first while a tool is active.
      // reveal marks Escape as handled (its binding is a no-op), so do not test defaultPrevented here.
      if (e.key === "Escape") {
        if (document.fullscreenElement) void document.exitFullscreen();
        else show((v) => (v === "present" ? "edit" : v));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [show, follow]);

  const goTo = useCallback(
    (address: string) => {
      if (view === "document") show("edit");
      controller?.goTo(address);
      // Reset first, so revealing the same section twice scrolls again.
      const line = sectionLines.get(address.split("/")[0] ?? "");
      setRevealLine(null);
      if (line) requestAnimationFrame(() => setRevealLine(line));
    },
    [controller, view, show, sectionLines],
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
  const onEdit = useCallback(
    (next: string) => {
      markEdit(next);
      edit(next);
    },
    [markEdit, edit],
  );

  // The exporters work from the paginated pages the audience sees, as copies they may change.
  const getExportOptions = useCallback((): ExportOptions | null => {
    if (!controller) return null;
    return {
      title: docTitle,
      size: SLIDE_SIZE,
      slides: clonePages(controller).map(({ info, element }) => ({
        address: info.address,
        title: info.title,
        element,
      })),
    };
  }, [controller, docTitle]);

  const oauthClientId = health?.features.includes("oauth") ? health.githubClientId : undefined;
  const signIn = useCallback(() => {
    if (!oauthClientId) return;
    import("./inputs/oauth")
      .then((m) => m.startLogin(oauthClientId))
      .catch(() =>
        setNotice({
          message: "Sign-in needs session storage, which this browser blocks.",
          tone: "error",
        }),
      );
  }, [oauthClientId, setNotice]);
  const openRemote = useCallback(() => {
    setRemoteOn(true);
    join.onOpenChange(true);
  }, [join]);

  const commands: Command[] = [
    { id: "present", label: "Present", run: () => void present() },
    { id: "presenter", label: "Open presenter view", run: openPresenter },
    { id: "overview", label: "Slide overview", hint: "O", run: overview.open },
    { id: "view-edit", label: "Show editor", run: () => show("edit") },
    { id: "view-document", label: "Show document", run: () => show("document") },
    { id: "share", label: "Share link", run: share.open },
    ...(comments.command ? [comments.command] : []),
    { id: "token", label: "GitHub token…", run: () => inputs.setTokenOpen(true) },
    ...(oauthClientId ? [{ id: "sign-in", label: "Sign in with GitHub", run: signIn }] : []),
    ...(remoteAvailable ? [{ id: "remote", label: "Remote and followers…", run: openRemote }] : []),
    {
      id: "theme",
      label: `Theme: switch to ${NEXT_THEME[theme]}`,
      run: () => setTheme(NEXT_THEME[theme]),
    },
    ...LEVELS.map((l) => ({
      id: `level-${String(l.value)}`,
      label: `Slides start at ${l.value === "auto" ? `auto (${resolved})` : l.label}`,
      run: () => setLevel(l.value),
    })),
    ...workspaceCommands(workspace),
  ];

  const ThemeIcon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;
  const moreActions: MoreAction[] = [
    ...(phone
      ? [
          {
            id: "palette",
            label: "Jump to slide or command",
            Icon: Search,
            run: () => setPaletteOpen(true),
          },
        ]
      : []),
    { id: "token", label: "GitHub token…", Icon: KeyRound, run: () => inputs.setTokenOpen(true) },
    ...(oauthClientId
      ? [{ id: "sign-in", label: "Sign in with GitHub", Icon: LogIn, run: signIn }]
      : []),
    ...(remoteAvailable
      ? [{ id: "remote", label: "Remote and followers…", Icon: Cast, run: openRemote }]
      : []),
    { id: "presenter", label: "Open presenter view", Icon: MonitorPlay, run: openPresenter },
    ...(comments.moreAction ? [comments.moreAction] : []),
    ...(phone
      ? [
          {
            id: "theme",
            label: `Theme: switch to ${NEXT_THEME[theme]}`,
            Icon: ThemeIcon,
            run: () => setTheme(NEXT_THEME[theme]),
          },
        ]
      : []),
  ];

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file && !follow) workspace.guard(() => void inputs.openFile(file));
  };

  const subline = follow ? (
    <p className="docwalk-source-banner" role="status">
      {followUpdate.incomplete ? FOLLOW_STATUS.closed : FOLLOW_STATUS[followUpdate.status]}
    </p>
  ) : !doc ? null : doc.source.kind === "workspace" ? (
    <WorkspaceBanner workspace={workspace} />
  ) : doc.source.kind === "sample" ? (
    <p className="docwalk-source-banner">Sample document · nothing uploaded</p>
  ) : (
    <SourceBanner source={doc.source} />
  );

  return (
    <div
      className="docwalk-app"
      data-view={follow ? "follow" : view}
      data-pane={phone && view === "edit" && !follow ? phonePane : undefined}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      <header className="docwalk-toolbar">
        <div className="docwalk-wordmark" role="img" aria-label="docwalk">
          doc<span>walk</span>
        </div>
        <div className="docwalk-doc-title">
          <strong>{docTitle}</strong>
          {subline}
        </div>
        {!follow && !phone && (
          <Button className="docwalk-palette-trigger" onPress={() => setPaletteOpen(true)}>
            Jump to slide or command…
            <kbd>
              <CommandIcon size={11} aria-hidden="true" />K
            </kbd>
          </Button>
        )}
        {!follow && (
          <div className="docwalk-toolbar-actions">
            <ToggleButtonGroup
              aria-label="View"
              selectionMode="single"
              disallowEmptySelection
              selectedKeys={[view === "present" ? "edit" : view]}
              onSelectionChange={(keys) => {
                const [k] = [...keys];
                if (k === "edit" || k === "document") show(k);
              }}
              className="docwalk-segmented"
            >
              <ToggleButton id="edit">Edit</ToggleButton>
              <ToggleButton id="document">Document</ToggleButton>
            </ToggleButtonGroup>
            <OpenFileButton onLoad={(r) => workspace.guard(() => inputs.apply(r))} />
            <Button className="docwalk-button" isDisabled={!doc} onPress={share.open}>
              <Share2 size={16} aria-hidden="true" />
              <span className="docwalk-button-label">Share</span>
            </Button>
            <Suspense
              fallback={
                <Button className="docwalk-button docwalk-export-trigger" isDisabled>
                  <Download size={16} aria-hidden="true" />
                  <span className="docwalk-button-label">Export</span>
                </Button>
              }
            >
              <ExportMenu getOptions={getExportOptions} isDisabled={!controller} />
            </Suspense>
            {comments.toggle}
            <MoreMenu actions={moreActions} />
            {!phone && (
              <IconButton
                label={`Theme: ${theme}. Switch to ${NEXT_THEME[theme]}`}
                onPress={() => setTheme(NEXT_THEME[theme])}
              >
                <ThemeIcon size={18} aria-hidden="true" />
              </IconButton>
            )}
          </div>
        )}
        {follow ? (
          <IconButton
            label={`Theme: ${theme}. Switch to ${NEXT_THEME[theme]}`}
            onPress={() => setTheme(NEXT_THEME[theme])}
          >
            <ThemeIcon size={18} aria-hidden="true" />
          </IconButton>
        ) : (
          <Button
            className="docwalk-button docwalk-present"
            data-variant="primary"
            isDisabled={!doc}
            onPress={() => void present()}
          >
            <Play size={16} aria-hidden="true" /> Present
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
              <IconButton label="Dismiss" onPress={() => setNotice(null)}>
                <X size={16} aria-hidden="true" />
              </IconButton>
            </div>
          )}
        </div>
      </div>

      <main className="docwalk-main">
        {view !== "present" && !follow && (
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
            </div>
          </aside>
        )}
        {phone && view === "edit" && !follow && (
          <div ref={paneSwitchRef} className="docwalk-pane-switch">
            <ToggleButtonGroup
              aria-label="Pane"
              selectionMode="single"
              disallowEmptySelection
              selectedKeys={[phonePane]}
              onSelectionChange={(keys) => {
                const [k] = [...keys];
                if (k !== "source" && k !== "preview") return;
                setPhonePane(k);
                requestAnimationFrame(() => {
                  // Scroll the outline away until the sticky switch reaches the
                  // top, so the chosen pane fills the screen under it and the
                  // slide is on screen, not below the outline.
                  const main = paneSwitchRef.current?.parentElement;
                  const bar = paneSwitchRef.current?.getBoundingClientRect();
                  if (main && bar) main.scrollTop += bar.top - main.getBoundingClientRect().top;
                  // The deck was display: none; reveal.js lays out again on resize.
                  window.dispatchEvent(new Event("resize"));
                });
              }}
              className="docwalk-segmented"
            >
              <ToggleButton id="source">Source</ToggleButton>
              <ToggleButton id="preview">Preview</ToggleButton>
            </ToggleButtonGroup>
          </div>
        )}
        {view === "edit" && !follow && (
          <section className="docwalk-source" aria-label="Markdown source">
            {doc ? (
              <Suspense fallback={<p className="docwalk-loading">Loading editor…</p>}>
                <Editor
                  value={markdown}
                  onChange={onEdit}
                  onCursorLine={onCursorLine}
                  revealLine={revealLine}
                  diagnostics={diagnostics}
                  label="Markdown source"
                />
              </Suspense>
            ) : (
              <p className="docwalk-loading">Loading document…</p>
            )}
          </section>
        )}
        {view === "document" && !follow && (
          <section className="docwalk-document-pane" aria-label="Document">
            <DocumentView root={root} onRendered={comments.onDocumentRendered} />
          </section>
        )}
        <div ref={deckRef} className="docwalk-deck-pane" hidden={view === "document" && !follow}>
          <div className="docwalk-preview-head">
            <strong>{current ? `${current.index + 1} / ${slides.length}` : "…"}</strong>
            <span className="docwalk-preview-address">{current?.address ?? ""}</span>
            {!follow && (
              <IconButton
                label="Slide overview"
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
              <Button
                className="docwalk-button docwalk-exit"
                onPress={() => {
                  // This button unmounts on exit; keep focus on the deck, as Escape does.
                  deckRef.current?.querySelector<HTMLElement>(".reveal")?.focus();
                  if (document.fullscreenElement) void document.exitFullscreen();
                  else show("edit");
                }}
              >
                Exit <kbd>Esc</kbd>
              </Button>
            )}
            {!follow && (
              <div className="docwalk-stage-tools">
                <AnnotationToolbar
                  mode={mode}
                  onModeChange={setMode}
                  color={penColor}
                  onColorChange={setPenColor}
                  onUndo={() => layerRef.current?.undo()}
                  onClear={() => layerRef.current?.clear()}
                />
              </div>
            )}
          </div>
          {doc ? (
            <Deck plan={plan} onReport={onReport} onReady={onReady} />
          ) : (
            <p className="docwalk-stage-wait">
              {follow ? "Waiting for the presenter…" : "Loading document…"}
            </p>
          )}
        </div>
        {comments.panel}
      </main>

      <footer ref={statusbarRef} className="docwalk-statusbar" aria-label="Status">
        <span>Slides at {level === "auto" ? `auto (${resolved})` : `H${String(level)}`}</span>
        <span>{report ? `${report.slides} slides` : "Rendering…"}</span>
        <span>{report ? `${slides.filter((s) => s.flagged).length} notes` : ""}</span>
        <span>{report ? `${report.diagramErrors} diagram errors` : ""}</span>
        <span className="docwalk-statusbar-end">Nothing uploaded · works offline</span>
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
        {remoteAvailable && remoteOn && (
          <RemotePresenter
            controller={controller}
            doc={doc}
            level={level}
            isOpen={join.isOpen}
            onOpenChange={join.onOpenChange}
            edit={onEdit}
            setNotice={setNotice}
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
