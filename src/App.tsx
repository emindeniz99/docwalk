import { Command as CommandIcon, Moon, Monitor, Play, Sun } from "lucide-react";
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
import sample from "../fixtures/ledger-redesign.md?raw";
import type { DeckController, SlideInfo } from "./deck/controller";
import { Deck, type DeckReport } from "./deck/Deck";
import type { EditorDiagnostic } from "./editor/types";
import { startPresenterBridge } from "./presenter/bridge";
import { openPresenterWindow } from "./presenter/window";
import { parseMarkdown, sectionize, type LevelOption } from "./sectioning/sectionize";
import { CommandPalette, type Command } from "./shell/CommandPalette";
import { DocumentView } from "./shell/DocumentView";
import { IconButton } from "./shell/IconButton";
import { LevelSelect } from "./shell/LevelSelect";
import { Outline } from "./shell/Outline";
import { useTheme, type ThemeChoice } from "./shell/theme";
import { useUrlSync } from "./url/useUrlSync";

type View = "edit" | "document" | "present";

// CodeMirror is the largest single dependency; load it after the deck is up.
const SourceEditor = lazy(() =>
  import("./editor/SourceEditor").then((m) => ({ default: m.SourceEditor })),
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

export function App() {
  const [markdown, setMarkdown] = useState(sample);
  const [level, setLevel] = useState<LevelOption>("auto");
  const [view, setView] = useState<View>("edit");
  const [theme, setTheme] = useTheme();
  const [report, setReport] = useState<DeckReport | null>(null);
  const [controller, setController] = useState<DeckController | null>(null);
  const [current, setCurrent] = useState<SlideInfo | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [revealLine, setRevealLine] = useState<number | null>(null);
  const [presenterRequested, setPresenterRequested] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [mode, setMode] = useState<AnnotationMode>("off");
  const [penColor, setPenColor] = useState<PenColor>(PEN_COLORS[0].variable);
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
  const docTitle = plan.titleHeading
    ? (plan.sections[0]?.title ?? "")
    : (plan.sections[0]?.title ?? "Untitled");
  const slides = useMemo(() => controller?.slides() ?? [], [controller]);

  const onReport = useCallback((r: DeckReport) => setReport(r), []);
  const onReady = useCallback((c: DeckController | null) => setController(c), []);

  useEffect(() => controller?.onChange(setCurrent), [controller]);

  // Source line of every section, for the editor's reveal, cursor sync and notes.
  const sectionLines = useMemo(
    () => new Map(plan.sections.map((sec) => [sec.id, sec.line] as const)),
    [plan],
  );

  useUrlSync({
    controller,
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
    view === "present",
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
      setNotice(
        "The browser blocked the presenter window. Allow pop-ups for this site and try again.",
      );
      return;
    }
    startedAt.current = Date.now();
    setPresenterRequested(true);
    setNotice(null);
  }, []);

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
      if (!document.fullscreenElement) show((v) => (v === "present" ? "edit" : v));
    };
    document.addEventListener("fullscreenchange", onFullscreen);
    return () => document.removeEventListener("fullscreenchange", onFullscreen);
  }, [show]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
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
  }, [show]);

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

  const commands: Command[] = [
    { id: "present", label: "Present", run: () => void present() },
    { id: "presenter", label: "Open presenter view", run: openPresenter },
    { id: "view-edit", label: "Show editor", run: () => show("edit") },
    { id: "view-document", label: "Show document", run: () => show("document") },
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
  ];

  const onDrop = async (event: DragEvent) => {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file && /\.(md|markdown|txt)$/i.test(file.name)) setMarkdown(await file.text());
  };

  const ThemeIcon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;

  return (
    <div
      className="docwalk-app"
      data-view={view}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      <header className="docwalk-toolbar">
        <div className="docwalk-wordmark" role="img" aria-label="docwalk">
          doc<span>walk</span>
        </div>
        <div className="docwalk-doc-title">
          <strong>{docTitle}</strong>
          <span>Pasted · saved in this browser</span>
        </div>
        <Button className="docwalk-palette-trigger" onPress={() => setPaletteOpen(true)}>
          Jump to slide, command or setting…
          <kbd>
            <CommandIcon size={11} aria-hidden="true" />K
          </kbd>
        </Button>
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
        <IconButton
          label={`Theme: ${theme}. Switch to ${NEXT_THEME[theme]}`}
          onPress={() => setTheme(NEXT_THEME[theme])}
        >
          <ThemeIcon size={18} aria-hidden="true" />
        </IconButton>
        <Button className="docwalk-button" data-variant="primary" onPress={() => void present()}>
          <Play size={16} aria-hidden="true" /> Present
        </Button>
      </header>

      <main className="docwalk-main">
        {view !== "present" && (
          <aside className="docwalk-sidebar">
            <Outline slides={slides} current={current} onSelect={goTo} />
            <div className="docwalk-level">
              <LevelSelect value={level} onChange={setLevel} resolved={resolved} />
            </div>
          </aside>
        )}
        {view === "edit" && (
          <section className="docwalk-source" aria-label="Markdown source">
            <Suspense fallback={<p className="docwalk-loading">Loading editor…</p>}>
              <SourceEditor
                value={markdown}
                onChange={setMarkdown}
                onCursorLine={onCursorLine}
                revealLine={revealLine}
                diagnostics={diagnostics}
                label="Markdown source"
              />
            </Suspense>
          </section>
        )}
        {view === "document" && (
          <section className="docwalk-document-pane">
            <DocumentView root={root} />
          </section>
        )}
        <div ref={deckRef} className="docwalk-deck-pane" hidden={view === "document"}>
          <div className="docwalk-preview-head">
            <strong>{current ? `${current.index + 1} / ${slides.length}` : "…"}</strong>
            <span>{current?.address ?? ""}</span>
            {view === "present" && (
              <Button
                className="docwalk-button docwalk-exit"
                onPress={() => {
                  if (document.fullscreenElement) void document.exitFullscreen();
                  else show("edit");
                }}
              >
                Exit <kbd>Esc</kbd>
              </Button>
            )}
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
          </div>
          {notice && (
            <p className="docwalk-notice" role="alert">
              {notice}
            </p>
          )}
          <Deck plan={plan} onReport={onReport} onReady={onReady} />
        </div>
      </main>

      <footer className="docwalk-statusbar" aria-label="Status">
        <span>Slides at {level === "auto" ? `auto (${resolved})` : `H${String(level)}`}</span>
        <span>{report ? `${report.slides} slides` : "Rendering…"}</span>
        <span>{report ? `${slides.filter((s) => s.flagged).length} notes` : ""}</span>
        <span>{report ? `${report.diagramErrors} diagram errors` : ""}</span>
        <span className="docwalk-statusbar-end">Nothing uploaded · works offline</span>
      </footer>

      <CommandPalette
        isOpen={paletteOpen}
        onOpenChange={setPaletteOpen}
        slides={slides}
        commands={commands}
        onGoTo={goTo}
      />
    </div>
  );
}
