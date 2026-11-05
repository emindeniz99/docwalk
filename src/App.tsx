import { Command as CommandIcon, Moon, Monitor, Play, Sun } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { Button, ToggleButton, ToggleButtonGroup } from "react-aria-components";
import sample from "../fixtures/ledger-redesign.md?raw";
import type { DeckController, SlideInfo } from "./deck/controller";
import { Deck, type DeckReport } from "./deck/Deck";
import { SourceEditor } from "./editor/SourceEditor";
import { parseMarkdown, sectionize, type LevelOption } from "./sectioning/sectionize";
import { CommandPalette, type Command } from "./shell/CommandPalette";
import { DocumentView } from "./shell/DocumentView";
import { Outline } from "./shell/Outline";
import { useTheme, type ThemeChoice } from "./shell/theme";

type View = "edit" | "document" | "present";

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
  const deckRef = useRef<HTMLDivElement>(null);

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
  const slides = controller?.slides() ?? [];

  const onReport = useCallback((r: DeckReport) => setReport(r), []);
  const onReady = useCallback((c: DeckController | null) => setController(c), []);

  useEffect(() => controller?.onChange(setCurrent), [controller]);

  const present = useCallback(async () => {
    show("present");
    try {
      await deckRef.current?.requestFullscreen?.();
    } catch {
      // Fullscreen can be refused (iOS, iframes); present mode still fills the window.
    }
    deckRef.current?.querySelector<HTMLElement>(".docwalk-deck-host")?.focus();
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
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const goTo = useCallback(
    (address: string) => {
      if (view === "document") show("edit");
      controller?.goTo(address);
    },
    [controller, view, show],
  );

  const commands: Command[] = [
    { id: "present", label: "Present", run: () => void present() },
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
        <Button
          className="docwalk-icon-button"
          aria-label={`Theme: ${theme}. Switch to ${NEXT_THEME[theme]}.`}
          onPress={() => setTheme(NEXT_THEME[theme])}
        >
          <ThemeIcon size={18} aria-hidden="true" />
        </Button>
        <Button className="docwalk-button" data-variant="primary" onPress={() => void present()}>
          <Play size={16} aria-hidden="true" /> Present
        </Button>
      </header>

      <main className="docwalk-main">
        {view !== "present" && (
          <aside className="docwalk-sidebar">
            <Outline slides={slides} current={current} onSelect={goTo} />
            <label className="docwalk-level">
              <span className="docwalk-overline">Slides start at</span>
              <select
                value={String(level)}
                onChange={(e) => {
                  const found = LEVELS.find((l) => String(l.value) === e.target.value);
                  if (found) setLevel(found.value);
                }}
              >
                {LEVELS.map((l) => (
                  <option key={l.label} value={String(l.value)}>
                    {l.value === "auto" ? `Auto · ${resolved}` : l.label}
                  </option>
                ))}
              </select>
            </label>
          </aside>
        )}
        {view === "edit" && (
          <section className="docwalk-source" aria-label="Markdown source">
            <SourceEditor value={markdown} onChange={setMarkdown} label="Markdown source" />
          </section>
        )}
        {view === "document" && (
          <section className="docwalk-document-pane">
            <DocumentView root={root} />
          </section>
        )}
        <div ref={deckRef} className="docwalk-deck-pane" hidden={view === "document"}>
          <div className="docwalk-preview-head" hidden={view === "present"}>
            <strong>{current ? `${current.index + 1} / ${slides.length}` : "…"}</strong>
            <span>{current?.address ?? ""}</span>
          </div>
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
