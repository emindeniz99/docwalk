// Sets Excalidraw's font path; imported for that side effect, before the package is evaluated.
// oxlint-disable-next-line import/no-unassigned-import
import "./assets";
import {
  CaptureUpdateAction,
  Excalidraw,
  MainMenu,
  exportToBlob,
  exportToSvg,
  restore,
  serializeAsJSON,
} from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { Download, FileImage, FileJson, Image as ImageIcon, X } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState, type ComponentProps } from "react";
import {
  Button,
  Dialog,
  Heading,
  Menu,
  MenuItem,
  MenuTrigger,
  Modal,
  ModalOverlay,
  Popover,
  type Key,
} from "react-aria-components";
import { prepareDiagramSource } from "../deck/mermaid";
import { downloadBlob } from "../export/download";
import { slugify } from "../export/filename";
import { IconButton } from "../shell/IconButton";
import { useMediaQuery } from "../shell/useMediaQuery";
import "./canvas.css";
import { convertDiagram } from "./convert";
import type { DocumentSource } from "../inputs/types";
import { diagramHash, documentKey, sketchKey } from "./identity";
import { loadSketch, saveSketch } from "./store";

type ExcalidrawProps = ComponentProps<typeof Excalidraw>;
type Api = Parameters<NonNullable<ExcalidrawProps["excalidrawAPI"]>>[0];
type InitialData = NonNullable<Awaited<ExcalidrawProps["initialData"]>>;
type OnChange = NonNullable<ExcalidrawProps["onChange"]>;
type Scene = Parameters<OnChange>;

/** Typing and dragging fire onChange constantly; a save waits for this pause. */
export const SAVE_DELAY_MS = 400;

export interface SketchDialogProps {
  /** The diagram's Mermaid source as written in the document. */
  source: string;
  /** 1-based position among the document's diagrams, for the title and file names. */
  index: number | null;
  /** Where the open document came from; sketches are kept per document. */
  documentSource: DocumentSource;
  /** The document's title, for export file names. */
  documentTitle: string;
  onClose: () => void;
}

type Load =
  | { status: "loading" }
  /** Excalidraw is mounted on an empty scene; the diagram converts into it. */
  | { status: "converting"; data: InitialData }
  | { status: "ready"; data: InitialData }
  | { status: "error"; message: string };

type Saved = "saved" | "unsaved" | "blocked";

const EXPORTS = [
  { id: "excalidraw", label: "Excalidraw file (.excalidraw)", Icon: FileJson },
  { id: "png", label: "PNG image", Icon: ImageIcon },
  { id: "svg", label: "SVG image", Icon: FileImage },
] as const;

/** The diagram type from its first line (`flowchart`, `sequenceDiagram`, …), for the title. */
export function diagramKind(source: string): string {
  const first = prepareDiagramSource(source)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== "" && !line.startsWith("%%"));
  return first?.split(/\s+/)[0] ?? "diagram";
}

/**
 * Canvas mode (decision 54): one Mermaid diagram as an editable Excalidraw
 * sketch, full screen. It reopens the sketch saved for this document and
 * diagram, or converts the diagram when there is none, and saves every
 * change to IndexedDB. Nothing goes back into the Markdown (rule 1).
 *
 * Keys: inside the canvas, Escape and every other key belong to Excalidraw
 * (Escape cancels a tool there), so the dialog closes with Escape only from
 * its header, and with the Close button. Key presses never travel past the
 * dialog to the app, whose shortcuts (⌘K, P, Escape) would otherwise fire
 * underneath it.
 */
export function SketchDialog(props: SketchDialogProps) {
  const { onClose } = props;
  return (
    <ModalOverlay
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      isKeyboardDismissDisabled
      className="docwalk-sketch-overlay"
    >
      <Modal className="docwalk-sketch">
        <Dialog className="docwalk-sketch-dialog" aria-labelledby="docwalk-sketch-title">
          <SketchBody {...props} />
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

function SketchBody({ source, index, documentSource, documentTitle, onClose }: SketchDialogProps) {
  const docKey = documentKey(documentSource);
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [saved, setSaved] = useState<Saved>("saved");
  const [exportStatus, setExportStatus] = useState("");
  const api = useRef<Api | null>(null);
  const key = useRef<string | null>(null);
  const pending = useRef<{ timer: ReturnType<typeof setTimeout>; scene: Scene } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  /** False until the scene is the sketch: an empty canvas waiting for its conversion is never saved. */
  const canSave = useRef(false);
  /** True while a fresh conversion waits for Excalidraw to mount. */
  const fresh = useRef(false);
  const live = useRef(true);
  const dark = useResolvedDark();
  const kind = diagramKind(source);
  const name = `${slugify(documentTitle) || "docwalk"}-diagram-${index ?? kind}`;

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const k = sketchKey(docKey, await diagramHash(source));
      key.current = k;
      let stored = null;
      try {
        stored = await loadSketch(k);
      } catch {
        // Private windows and blocked site data: the sketch works, it just is not kept.
        if (!cancelled) setSaved("blocked");
      }
      if (cancelled) return;
      if (stored) {
        // restore() validates every element, as for any file Excalidraw opens.
        const data = restore(stored as Parameters<typeof restore>[0], null, null);
        canSave.current = true;
        setLoad({ status: "ready", data });
      } else {
        // Converted once Excalidraw is up (onApi): see convertInto.
        fresh.current = true;
        setLoad({ status: "converting", data: { elements: [] } });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [docKey, source]);

  /**
   * Converts the diagram into the mounted canvas. It waits for Excalifont:
   * Excalidraw adds its fonts to the page only when it mounts, and the
   * converter sizes every node for its label as measured in that font, so a
   * conversion before it loads gets boxes too narrow for their text.
   */
  const convertInto = useCallback(
    async (excalidraw: Api) => {
      try {
        await excalifontReady();
        const { elements, files } = await convertDiagram(source);
        if (!live.current) return;
        excalidraw.addFiles(Object.values(files));
        // Not an undoable step: undo must not take the diagram away again.
        excalidraw.updateScene({ elements, captureUpdate: CaptureUpdateAction.NEVER });
        // Fit the window, but never below half size (on a phone, pan instead of squinting)
        // nor above full size (a two-node diagram is not blown up).
        excalidraw.scrollToContent(undefined, {
          fitToViewport: true,
          viewportZoomFactor: 0.8,
          minZoom: 0.5,
          maxZoom: 1,
          animate: false,
        });
        canSave.current = true;
        setLoad((l) => (l.status === "converting" ? { status: "ready", data: l.data } : l));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (live.current) setLoad({ status: "error", message: message.split("\n")[0] ?? message });
      }
    },
    [source],
  );

  const persist = useCallback((scene: Scene) => {
    const k = key.current;
    if (!k || !canSave.current) return;
    const [elements, appState, files] = scene;
    const json = JSON.parse(serializeAsJSON(elements, appState, files, "local")) as {
      elements: unknown[];
      appState: Record<string, unknown>;
      files: Record<string, unknown>;
    };
    saveSketch({ key: k, ...json, savedAt: Date.now() }).then(
      () => setSaved((s) => (s === "blocked" ? s : "saved")),
      () => setSaved("blocked"),
    );
  }, []);

  // Stable, so the memoised canvas does not re-render when the header's save state changes.
  const onChange = useCallback<OnChange>(
    (...scene) => {
      if (!canSave.current) return;
      if (pending.current) clearTimeout(pending.current.timer);
      setSaved((s) => (s === "blocked" ? s : "unsaved"));
      const timer = setTimeout(() => {
        pending.current = null;
        persist(scene);
      }, SAVE_DELAY_MS);
      pending.current = { timer, scene };
    },
    [persist],
  );
  const onApi = useCallback(
    (a: Api) => {
      api.current = a;
      if (!fresh.current) return;
      fresh.current = false;
      void convertInto(a);
    },
    [convertInto],
  );

  // A change still waiting for its pause is saved when the dialog closes.
  useEffect(
    () => () => {
      if (!pending.current) return;
      clearTimeout(pending.current.timer);
      persist(pending.current.scene);
    },
    [persist],
  );

  // On document, bubble phase: after React (Excalidraw's keys are React handlers, dispatched
  // from the portal's container, <body>), before the app's own listeners on window.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      // The export menu portals to <body>, outside the dialog's subtree.
      if (target?.closest(".docwalk-sketch-popover") || root.current?.contains(target)) {
        event.stopPropagation();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const runExport = async (job: Key) => {
    const excalidraw = api.current;
    if (!excalidraw) return;
    const elements = excalidraw.getSceneElements();
    const appState = excalidraw.getAppState();
    const files = excalidraw.getFiles();
    try {
      if (job === "excalidraw") {
        const json = serializeAsJSON(elements, appState, files, "local");
        downloadBlob(new Blob([json], { type: "application/json" }), `${name}.excalidraw`);
        setExportStatus(`Downloaded ${name}.excalidraw.`);
      } else if (job === "png") {
        setExportStatus("Rendering the PNG image…");
        const blob = await exportToBlob({
          elements,
          appState: { ...appState, exportBackground: true },
          files,
          mimeType: "image/png",
        });
        downloadBlob(blob, `${name}.png`);
        setExportStatus(`Downloaded ${name}.png.`);
      } else if (job === "svg") {
        setExportStatus("Rendering the SVG image…");
        const svg = await exportToSvg({
          elements,
          appState: { ...appState, exportBackground: true },
          files,
        });
        downloadBlob(new Blob([svg.outerHTML], { type: "image/svg+xml" }), `${name}.svg`);
        setExportStatus(`Downloaded ${name}.svg.`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setExportStatus(`Export failed: ${message}`);
    }
  };

  const subtitle = [
    index ? `Diagram ${index}` : null,
    kind,
    saved === "blocked"
      ? "not saved: this browser blocks storage"
      : saved === "unsaved"
        ? "saving…"
        : "saved in this browser only",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div ref={root} className="docwalk-sketch-body">
      {/* Escape closes from the header; in the canvas it belongs to Excalidraw. */}
      <div
        className="docwalk-sketch-header"
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          // Closing unmounts the document listener below, so stop the key here:
          // the app's Escape would also leave present mode.
          event.stopPropagation();
          onClose();
        }}
      >
        <div className="docwalk-sketch-heading">
          <Heading id="docwalk-sketch-title" slot="title" className="docwalk-sketch-title">
            Sketch
          </Heading>
          <span
            className="docwalk-sketch-subtitle"
            data-tone={saved === "blocked" ? "note" : undefined}
          >
            {subtitle}
          </span>
        </div>
        <span className="docwalk-sketch-status" role="status">
          {exportStatus}
        </span>
        <MenuTrigger>
          <Button className="docwalk-button" isDisabled={load.status !== "ready"}>
            <Download size={16} aria-hidden="true" />
            Export
          </Button>
          <Popover className="docwalk-popover docwalk-sketch-popover" placement="bottom end">
            <Menu
              aria-label="Export sketch"
              className="docwalk-menu"
              onAction={(job) => void runExport(job)}
            >
              {EXPORTS.map(({ id, label, Icon }) => (
                <MenuItem key={id} id={id} textValue={label} className="docwalk-menu-item">
                  <Icon size={16} aria-hidden="true" />
                  {label}
                </MenuItem>
              ))}
            </Menu>
          </Popover>
        </MenuTrigger>
        <IconButton label="Close sketch" onPress={onClose}>
          <X size={18} aria-hidden="true" />
        </IconButton>
      </div>
      <div className="docwalk-sketch-canvas">
        {load.status === "error" && (
          <p className="docwalk-diagnostic docwalk-sketch-wait">
            This diagram could not be converted into a sketch: {load.message}
          </p>
        )}
        {/* One element for both states, so Excalidraw stays mounted when the conversion lands. */}
        {(load.status === "converting" || load.status === "ready") && (
          <SketchCanvas
            data={load.data}
            dark={dark}
            name={name}
            onChange={onChange}
            onApi={onApi}
          />
        )}
        {(load.status === "loading" || load.status === "converting") && (
          <p className="docwalk-sketch-wait" role="status">
            Converting the diagram…
          </p>
        )}
      </div>
    </div>
  );
}

const UI_OPTIONS: ExcalidrawProps["UIOptions"] = {
  canvasActions: { toggleTheme: false, saveToActiveFile: false },
};

/** No embeds: an embedded page would be a request to a third party (rule 8). */
const noEmbeds = () => false;

interface SketchCanvasProps {
  data: InitialData;
  dark: boolean;
  name: string;
  onChange: OnChange;
  onApi: (api: Api) => void;
}

/** Excalidraw itself, memoised: it re-renders when the theme changes, never on a save. */
const SketchCanvas = memo(function SketchCanvas({
  data,
  dark,
  name,
  onChange,
  onApi,
}: SketchCanvasProps) {
  return (
    <Excalidraw
      initialData={data}
      excalidrawAPI={onApi}
      onChange={onChange}
      theme={dark ? "dark" : "light"}
      name={name}
      autoFocus
      aiEnabled={false}
      validateEmbeddable={noEmbeds}
      UIOptions={UI_OPTIONS}
    >
      {/* The default menu, less the theme toggle (the app's theme rules) and the social links. */}
      <MainMenu>
        <MainMenu.DefaultItems.LoadScene />
        <MainMenu.DefaultItems.Export />
        <MainMenu.DefaultItems.SaveAsImage />
        <MainMenu.DefaultItems.ClearCanvas />
        <MainMenu.DefaultItems.Help />
        <MainMenu.Separator />
        <MainMenu.DefaultItems.ChangeCanvasBackground />
      </MainMenu>
    </Excalidraw>
  );
});

const excalifontRegistered = () => [...document.fonts].some((face) => face.family === "Excalifont");

/**
 * Resolves once Excalifont, Excalidraw's hand-drawn font, is usable for
 * measuring. Excalidraw registers its font faces as it mounts; give it a
 * second, then measure with whatever is there rather than never converting.
 */
async function excalifontReady(): Promise<void> {
  for (let frame = 0; frame < 60 && !excalifontRegistered(); frame++) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  try {
    await document.fonts.load("20px Excalifont");
  } catch {
    // A font that fails to load leaves the fallback font's widths: boxes a little off, still usable.
  }
}

/** The app's resolved theme: the viewer's choice on `<html data-theme>`, else the system's. */
function useResolvedDark(): boolean {
  const systemDark = useMediaQuery("(prefers-color-scheme: dark)");
  const choice = document.documentElement.dataset["theme"];
  return choice === "dark" || (choice !== "light" && systemDark);
}
