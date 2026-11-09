import {
  Cast,
  Download,
  KeyRound,
  LayoutGrid,
  ListChecks,
  LogIn,
  Moon,
  Monitor,
  MonitorPlay,
  Play,
  Search,
  Share2,
  Sun,
  TableOfContents,
  Trash,
  X,
} from "lucide-react";
import {
  AnnotationToolbar,
  PEN_COLORS,
  resolvePenColor,
  type PenColor,
} from "./annotate/AnnotationToolbar";
import { markKeys, slideFingerprint, slideFingerprints } from "./annotate/markKeys";
import { MirrorFeed } from "./annotate/mirrorFeed";
import { markColorOf } from "./annotate/mirrorTypes";
import { marksSaver } from "./annotate/savedMarks";
import type { AnnotationLayer, AnnotationMode } from "./annotate/types";
import { useAnnotationShortcuts } from "./annotate/useAnnotationShortcuts";
import { useSavedMarks } from "./annotate/useSavedMarks";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type DragEvent,
} from "react";
import { Button, ToggleButton, ToggleButtonGroup } from "react-aria-components";
import { useSketchRequest } from "./canvas/request";
import { useCommentsUi } from "./comments/useCommentsUi";
import { clonePages, type DeckController, type SlideInfo } from "./deck/controller";
import { Deck, SLIDE_SIZE, type DeckReport } from "./deck/Deck";
import { observeFocus } from "./deck/focusEvents";
import { useOverviewShortcut } from "./deck/useOverviewShortcut";
import {
  COARSE_POINTER,
  setEditorChoice,
  useEditorChoice,
  useStoredEditorChoice,
} from "./editor/choice";
import {
  chooseLocale,
  getAppLocale,
  localeName,
  locales,
  useLocale,
  type Locale,
} from "./i18n/locale";
import type { EditorDiagnostic, SourceEditorProps } from "./editor/types";
import type { ExportOptions } from "./export/types";
import { OpenFileButton } from "./inputs/OpenFileButton";
import type { HealthResponse } from "./api/types";
import { SourceBanner } from "./inputs/SourceBanner";
import { startPresenterBridge } from "./presenter/bridge";
import { openPresenterWindow } from "./presenter/window";
import type { RemoteStatus } from "./remote/client";
import { speakerNotes } from "./sectioning/notes";
import { applySelection } from "./sectioning/selection";
import { parseMarkdown, sectionize, type LevelOption } from "./sectioning/sectionize";
import { useDraftAutosave } from "./share/draft";
import { CommandPalette, type Command } from "./shell/CommandPalette";
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
import { MoreMenu, type MoreAction } from "./shell/MoreMenu";
import { setPresentFrame, usePresentChrome, usePresentFrame } from "./shell/presentChrome";
import { Outline, OutlineSheet } from "./shell/Outline";
import { useTheme, type ThemeChoice } from "./shell/theme";
import { useBlockSizeProperty } from "./shell/useBlockSizeProperty";
import { useDocument } from "./shell/useDocument";
import { useMediaQuery } from "./shell/useMediaQuery";
import { useWakeLock } from "./shell/wakeLock";
import type { FollowUpdate } from "./shell/RemoteFollower";
import { readInitialSections, useUrlSync } from "./url/useUrlSync";
import { m } from "./paraglide/messages.js";
import { workspaceCommands } from "./workspace/commands";
import { FilesPanel } from "./workspace/FilesPanel";
import { useWorkspace } from "./workspace/useWorkspace";
import { WorkspaceBanner } from "./workspace/WorkspaceBanner";
import { WorkspaceDialogs } from "./workspace/WorkspaceDialogs";

type View = "edit" | "document" | "present";

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

const LEVELS: { label: string; value: LevelOption }[] = [
  { label: "H1", value: 1 },
  { label: "H2", value: 2 },
  { label: "H3", value: 3 },
];

const NEXT_THEME: Record<ThemeChoice, ThemeChoice> = {
  system: "light",
  light: "dark",
  dark: "system",
};

const FOLLOW_STATUS: Record<RemoteStatus, () => string> = {
  connecting: m.follow_connecting,
  open: m.follow_open,
  reconnecting: m.follow_reconnecting,
  closed: m.follow_closed,
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

/**
 * The editor in the Edit view. A switch of editor mounts the other one on the
 * line where this document's cursor last was (decision 102). The line lives
 * here rather than in App, so a cursor move re-renders the editor only; this
 * slot unmounts with the Edit view, so coming back starts on line 1.
 */
function EditorSlot({
  Editor,
  onCursorLine,
  ...props
}: Omit<SourceEditorProps, "initialLine"> & { Editor: ComponentType<SourceEditorProps> }) {
  const [cursor, setCursor] = useState<{ line: number; doc: number | undefined } | null>(null);
  const { documentId } = props;
  const report = useCallback(
    (line: number) => {
      setCursor({ line, doc: documentId });
      onCursorLine?.(line);
    },
    [documentId, onCursorLine],
  );
  return (
    <Editor
      {...props}
      onCursorLine={report}
      initialLine={cursor && cursor.doc === documentId ? cursor.line : null}
    />
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
  const sectionPicker = useLazyDialog();
  const [remoteOn, setRemoteOn] = useState(false);
  const sketch = useSketchRequest(!follow);
  const phone = useMediaQuery(PHONE);
  // Scroll the outline away until the sticky pane switch reaches the top, so
  // the chosen pane fills the screen under it and the slide is on screen, not
  // below the outline.
  const showPhonePane = useCallback(() => {
    const main = paneSwitchRef.current?.parentElement;
    const bar = paneSwitchRef.current?.getBoundingClientRect();
    if (main && bar) main.scrollTop += bar.top - main.getBoundingClientRect().top;
    // The deck was display: none; reveal.js lays out again on resize.
    window.dispatchEvent(new Event("resize"));
  }, []);
  // Present unmounts the outline and the pane switch, and Chromium resets the
  // page's scroll: the preview pane came back selected but below the fold.
  const viewBefore = useRef(view);
  useEffect(() => {
    const was = viewBefore.current;
    viewBefore.current = view;
    if (phone && was === "present" && view === "edit") requestAnimationFrame(showPhonePane);
  }, [view, phone, showPhonePane]);
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
    void import("./inputs/oauth")
      .then((mod) => mod.fetchApiHealth())
      .then((h) => {
        if (live) setHealth(h);
      });
    return () => {
      live = false;
    };
  }, []);
  const deckRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<AnnotationLayer | null>(null);
  // What this tab mirrors: the laser, pen marks and diagram focus view. Followers (through
  // RemotePresenter) and the presenter window (through the bridge) subscribe (decision 88).
  const [mirrorFeed] = useState(() => new MirrorFeed());
  useEffect(() => observeFocus((event) => mirrorFeed.focus(event)), [mirrorFeed]);
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
      else setNotice({ message: m.follow_doc_too_long(), tone: "error" });
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
    if (followUpdate.incomplete) setNotice({ message: m.follow_link_incomplete(), tone: "error" });
  }, [followUpdate.incomplete, setNotice]);

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
      mirror: mirrorFeed,
    });
  }, [controller, presenterRequested, mirrorFeed]);

  // Set when the annotation layer is up (below, after the saved marks it draws are known).
  const [layerReady, setLayerReady] = useState(0);
  useEffect(
    () => () => {
      layerRef.current?.destroy();
      layerRef.current = null;
    },
    [],
  );
  useEffect(() => {
    if (layerReady) layerRef.current?.setMode(mode);
  }, [mode, layerReady]);
  // The pen colour is a CSS variable whose value changes with the theme, so
  // `theme` re-resolves it even though the body does not read it.
  useEffect(() => {
    if (layerReady) {
      layerRef.current?.setColor(resolvePenColor(penColor), markColorOf(penColor) ?? undefined);
    }
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

  // Presenting, and on a follow screen (decision 113), the slide fills the
  // screen unless the viewer chose the card frame (decision 77).
  const frame = usePresentFrame();
  const presenting = view === "present" && !follow;
  const staged = presenting || follow;
  const fill = staged && frame === "fill";
  // A follow screen hides its bar like a presenting one, but only while the
  // slide can be trusted: anything but an open connection, or an incomplete
  // link, keeps the bar (and the status in it) up.
  const followOpen = follow && followUpdate.status === "open" && !followUpdate.incomplete;
  // The screen stays on while presenting (decision 80).
  useWakeLock(view === "present");
  // Presenting, the bar and tools step aside after a few idle seconds so the
  // slide can take the whole stage (decision 75); usePresentChrome has the rules.
  const chrome = usePresentChrome({
    active: presenting || followOpen,
    pane: deckRef,
    toolActive: mode !== "off",
    barIsStage: fill,
  });

  // O opens the slide overview: anywhere while presenting, from the deck pane while editing.
  useOverviewShortcut(
    overview.open,
    !follow && controller !== null && view !== "document",
    view === "present" ? undefined : deckRef,
  );

  // Notes on slides become editor diagnostics at their section's source line.
  // Until the deck rebuilds, its slides are those of the text before the last
  // edit: a slide whose section the edit removed has no line, and its note
  // waits for the rebuild instead of landing on line 1.
  const diagnostics = useMemo<EditorDiagnostic[]>(
    () =>
      slides.flatMap((sl) => {
        const line = sectionLines.get(sl.sectionId);
        if (!sl.flagged || line === undefined) return [];
        const note = sl.note ?? m.app_slide_has_note();
        return [
          {
            line,
            message: m.app_slide_diagnostic(
              { number: sl.index + 1, address: sl.address, note },
              { locale },
            ),
            severity: "warning" as const,
          },
        ];
      }),
    [slides, sectionLines, locale],
  );

  // The preview follows the cursor while editing. The editor reports a line
  // only when it changes, and a heading just typed is not a section until the
  // edit has been paginated and the deck rebuilt: the last line is matched
  // again then, and followed if its section is not the one followed last
  // (so a level switch or a write elsewhere leaves a browsed preview alone).
  const cursor = useRef<{ line: number; section: string | null } | null>(null);
  const followCursor = useCallback(
    (moved: boolean) => {
      const at = cursor.current;
      if (!controller || !at) return;
      let target: string | null = null;
      for (const sec of plan.sections) if (sec.line <= at.line) target = sec.id;
      if (!target || (!moved && target === at.section)) return;
      if (controller.current()?.sectionId === target || controller.goTo(target)) {
        at.section = target;
      }
    },
    [controller, plan],
  );
  const onCursorLine = useCallback(
    (line: number) => {
      cursor.current = { line, section: cursor.current?.section ?? null };
      followCursor(true);
    },
    [followCursor],
  );
  useEffect(() => {
    if (view === "edit") followCursor(false);
    // The editor remounts on return to Edit and reports its line again.
    else cursor.current = null;
  }, [view, followCursor]);

  const openPresenter = useCallback(() => {
    if (!openPresenterWindow()) {
      setNotice({ message: m.app_presenter_blocked(), tone: "error" });
      return;
    }
    startedAt.current = Date.now();
    setPresenterRequested(true);
    setNotice(null);
  }, [setNotice]);

  // Whether this fullscreen session's exit has been acted on; see onFullscreen.
  const fullscreenLeft = useRef(false);
  const present = useCallback(async () => {
    show("present");
    fullscreenLeft.current = false;
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
      if (document.fullscreenElement) {
        fullscreenLeft.current = false;
        return;
      }
      // One exit, one action. An Escape during WebKit's enter animation
      // delays the enter's change event until the exit has begun, so two
      // events in a row find no fullscreen element; acting on both would
      // close a dialog and then leave present mode on the same key.
      if (fullscreenLeft.current) return;
      fullscreenLeft.current = true;
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

  // Pen and arrow marks saved per document and slide (decision 105), under the comments' identity.
  const saved = useSavedMarks({
    documentKey: comments.documentKey,
    unidentified: comments.documentUnidentified,
    enabled: !follow,
    setNotice,
  });
  const { marks: savedMarks } = saved;

  // Pen and laser over the slides; each slide keeps its own marks while the deck is open, and
  // its saved marks come back on its first visit. The layer (drauu, perfect-freehand) loads
  // after the deck and the document's saved marks are up, outside the first-load bundle.
  // A rebuild (an edit, an agent write, a disk reload, a language switch) brings a new stage:
  // the layer moves onto it, and only slides whose text changed lose their marks. Another
  // document brings other saved marks: the layer starts again from those.
  /** The saved marks the current layer was made for. */
  const layerMarks = useRef<typeof savedMarks>(null);
  const fingerprints = useRef(new Map<string, string>());
  useEffect(() => {
    if (!controller || !savedMarks) return;
    let cancelled = false;
    let stop: (() => void) | undefined;
    void import("./annotate/layer").then(({ createAnnotationLayer }) => {
      if (cancelled) return;
      if (layerRef.current && layerMarks.current !== savedMarks) {
        layerRef.current.destroy();
        layerRef.current = null;
      }
      let layer = layerRef.current;
      if (!layer) {
        layer = createAnnotationLayer(controller.stage(), {
          saved: (key, address) => savedMarks.forKey(key, address),
        });
        // What it draws goes to the mirror (decision 88) and into the saved marks (decision
        // 105). It keeps its observers across rebuilds, so this runs once per document.
        layer.observe((event) => mirrorFeed.ingest(event));
        layer.observe(
          marksSaver(
            () => savedMarks,
            (address) => fingerprints.current.get(address),
          ),
        );
        layerMarks.current = savedMarks;
      }
      const shown = layer;
      shown.moveTo(controller.stage());
      layerRef.current = shown;
      fingerprints.current = slideFingerprints(controller.stage());
      const keys = markKeys(controller.stage());
      stop = controller.onChange((sl) =>
        shown.setKey(keys.get(sl.address) ?? sl.address, sl.address),
      );
      shown.retain(keys.values());
      setLayerReady((n) => n + 1);
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [controller, mirrorFeed, savedMarks]);

  // "Delete saved marks": the records, then every slide's marks and their undo history.
  const clearMarks = useLazyDialog();
  const deleteSavedMarks = useCallback(() => {
    if (!savedMarks) return;
    layerRef.current?.retain([]);
    layerRef.current?.clear();
    void savedMarks.clear().then((done) => {
      if (done) setNotice({ message: m.marks_cleared(), tone: "info" });
    });
  }, [savedMarks, setNotice]);
  const onEdit = useCallback(
    (next: string) => {
      markEdit(next);
      edit(next);
    },
    [markEdit, edit],
  );

  // The exporters work from the paginated pages the audience sees, as copies they may change.
  // Each slide takes the saved marks drawn on its present text (decision 105), unless left out.
  // A section's speaker notes go on its last slide (decision 114), for the print that asks.
  const notes = useMemo(() => speakerNotes(selection.plan), [selection.plan]);
  const getExportOptions = useCallback(
    (withMarks: boolean, withNotes: boolean): ExportOptions | null => {
      if (!controller) return null;
      const pages = clonePages(controller);
      return {
        title: docTitle,
        size: SLIDE_SIZE,
        slides: pages.map(({ info, element }, index) => {
          const marks = withMarks
            ? (savedMarks?.strokes(info.address, slideFingerprint(element)) ?? [])
            : [];
          const isLast = pages[index + 1]?.info.sectionId !== info.sectionId;
          const sectionNotes = withNotes && isLast ? notes.get(info.sectionId) : undefined;
          return {
            address: info.address,
            title: info.title,
            element,
            ...(marks.length > 0 ? { marks } : {}),
            ...(sectionNotes ? { notes: [...sectionNotes] } : {}),
          };
        }),
      };
    },
    [controller, docTitle, savedMarks, notes],
  );

  const oauthClientId = health?.features.includes("oauth") ? health.githubClientId : undefined;
  const signIn = useCallback(() => {
    if (!oauthClientId) return;
    import("./inputs/oauth")
      .then((mod) => mod.startLogin(oauthClientId))
      .catch(() => setNotice({ message: m.app_sign_in_storage(), tone: "error" }));
  }, [oauthClientId, setNotice]);
  const openRemote = useCallback(() => {
    setRemoteOn(true);
    join.onOpenChange(true);
  }, [join]);

  const commands: Command[] = [
    { id: "present", label: m.cmd_present(), run: () => void present() },
    { id: "presenter", label: m.cmd_presenter(), run: openPresenter },
    { id: "overview", label: m.cmd_overview(), hint: "O", run: overview.open },
    { id: "sections", label: m.cmd_sections(), run: sectionPicker.open },
    { id: "view-edit", label: m.cmd_show_editor(), run: () => show("edit") },
    { id: "view-document", label: m.cmd_show_document(), run: () => show("document") },
    // Touch screens keep CodeMirror and are not offered Monaco.
    ...(coarse
      ? []
      : [
          storedEditor === "monaco"
            ? {
                id: "editor-codemirror",
                label: m.cmd_editor({ editor: "CodeMirror" }),
                run: () => setEditorChoice("codemirror"),
              }
            : {
                id: "editor-monaco",
                label: m.cmd_editor({ editor: "Monaco" }),
                run: () => setEditorChoice("monaco"),
              },
        ]),
    { id: "share", label: m.cmd_share(), run: share.open },
    ...(comments.command ? [comments.command] : []),
    ...(saved.count > 0
      ? [{ id: "delete-marks", label: m.marks_clear_command(), run: clearMarks.open }]
      : []),
    { id: "token", label: m.cmd_token(), run: () => inputs.setTokenOpen(true) },
    ...(oauthClientId ? [{ id: "sign-in", label: m.cmd_sign_in(), run: signIn }] : []),
    ...(remoteAvailable ? [{ id: "remote", label: m.cmd_remote(), run: openRemote }] : []),
    {
      id: "theme",
      label: m.theme_switch({ next: NEXT_THEME[theme] }),
      run: () => setTheme(NEXT_THEME[theme]),
    },
    frame === "fill"
      ? { id: "frame-card", label: m.cmd_present_card(), run: () => setPresentFrame("card") }
      : { id: "frame-fill", label: m.cmd_present_fill(), run: () => setPresentFrame("fill") },
    {
      id: "level-auto",
      label: m.level_command({ level: m.level_auto_resolved({ resolved }) }),
      run: () => setLevel("auto"),
    },
    ...LEVELS.map((l) => ({
      id: `level-${String(l.value)}`,
      label: m.level_command({ level: l.label }),
      run: () => setLevel(l.value),
    })),
    // The language switch (decision 56) offers the languages not in use, each named in itself.
    ...locales
      .filter((l) => l !== locale)
      .map((l: Locale) => ({
        id: `locale-${l}`,
        label: m.cmd_language({ language: localeName(l) }),
        run: () => chooseLocale(l),
      })),
    ...workspaceCommands(workspace),
  ];

  const ThemeIcon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;
  const moreActions: MoreAction[] = [
    ...(phone
      ? [
          {
            id: "palette",
            label: m.cmd_palette(),
            Icon: Search,
            run: () => setPaletteOpen(true),
          },
        ]
      : []),
    { id: "token", label: m.cmd_token(), Icon: KeyRound, run: () => inputs.setTokenOpen(true) },
    ...(oauthClientId ? [{ id: "sign-in", label: m.cmd_sign_in(), Icon: LogIn, run: signIn }] : []),
    ...(remoteAvailable
      ? [{ id: "remote", label: m.cmd_remote(), Icon: Cast, run: openRemote }]
      : []),
    { id: "presenter", label: m.cmd_presenter(), Icon: MonitorPlay, run: openPresenter },
    { id: "sections", label: m.cmd_sections(), Icon: ListChecks, run: sectionPicker.open },
    ...(comments.moreAction ? [comments.moreAction] : []),
    ...(saved.count > 0
      ? [{ id: "delete-marks", label: m.marks_clear_command(), Icon: Trash, run: clearMarks.open }]
      : []),
    ...(phone
      ? [
          {
            id: "theme",
            label: m.theme_switch({ next: NEXT_THEME[theme] }),
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
                hasNotes={notes.size > 0}
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
              <Button
                className="docwalk-button docwalk-exit"
                onPress={() => {
                  // This button unmounts on exit; keep focus on the deck, as Escape does.
                  deckRef.current?.querySelector<HTMLElement>(".reveal")?.focus();
                  if (document.fullscreenElement) void document.exitFullscreen();
                  else show("edit");
                }}
              >
                {m.app_exit()} <kbd>Esc</kbd>
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
