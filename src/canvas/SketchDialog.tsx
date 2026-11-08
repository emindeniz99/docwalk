// Sets Excalidraw's font path; imported for that side effect, before the package is evaluated.
// oxlint-disable-next-line import/no-unassigned-import
import "./assets";
import {
  CaptureUpdateAction,
  Excalidraw,
  MainMenu,
  exportToBlob,
  exportToSvg,
  loadFromBlob,
  restore,
  serializeAsJSON,
} from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import {
  Archive,
  Download,
  FileImage,
  FileJson,
  FolderOpen,
  Image as ImageIcon,
  X,
} from "lucide-react";
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
import { getAppLocale, useLocale } from "../i18n/locale";
import { m } from "../paraglide/messages.js";
import { IconButton } from "../shell/IconButton";
import { useMediaQuery } from "../shell/useMediaQuery";
import "./canvas.css";
import { keepExcalidrawControlsNamed } from "./controls";
import { convertDiagram } from "./convert";
import { inlineFiles } from "./files";
import type { DocumentSource } from "../inputs/types";
import { diagramHash, documentKey, sketchKey } from "./identity";
import { sketchFileName } from "./names";
import { SavedSketches } from "./SavedSketches";
import { loadSketch, saveSketch } from "./store";

type ExcalidrawProps = ComponentProps<typeof Excalidraw>;
type Api = Parameters<NonNullable<ExcalidrawProps["excalidrawAPI"]>>[0];
type InitialData = NonNullable<Awaited<ExcalidrawProps["initialData"]>>;
type OnChange = NonNullable<ExcalidrawProps["onChange"]>;
type OnPaste = NonNullable<ExcalidrawProps["onPaste"]>;
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
  /** `message` is the whole sentence shown, so a failed open and a failed conversion read differently. */
  | { status: "error"; message: string };

/**
 * `blocked` and `unkept` last for the whole session (no storage, no
 * `crypto.subtle`); `full` ends with the next write that succeeds, for
 * instance after the viewer deleted a sketch.
 */
type Saved = "saved" | "unsaved" | "blocked" | "full" | "unkept";

const SAVED_TEXT: Record<Saved, () => string> = {
  saved: m.sketch_saved,
  unsaved: m.sketch_saving,
  blocked: m.sketch_blocked,
  full: m.sketch_full,
  unkept: m.sketch_unkept,
};

/** Storage is not gone, it has no room: the browser's quota error, by name or by legacy code. */
function isQuotaError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "QuotaExceededError" || error.code === 22 || error.code === 1014)
  );
}

const EXPORTS = [
  { id: "excalidraw", label: m.sketch_export_excalidraw, Icon: FileJson },
  { id: "png", label: m.sketch_export_png, Icon: ImageIcon },
  { id: "svg", label: m.sketch_export_svg, Icon: FileImage },
] as const;

/** Excalidraw ships its own translations; it follows the UI language too. */
const EXCALIDRAW_LANG = { en: "en", tr: "tr-TR" } as const;

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
  const [storeOpen, setStoreOpen] = useState(false);
  /** The key of the stored sketch on the canvas: the one the Saved sketches panel never offers to delete. */
  const [openKey, setOpenKey] = useState<string | null>(null);
  const storeButton = useRef<HTMLButtonElement>(null);
  const api = useRef<Api | null>(null);
  const key = useRef<string | null>(null);
  const pending = useRef<{ timer: ReturnType<typeof setTimeout>; scene: Scene } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  /** False until the scene is the sketch: an empty canvas waiting for its conversion is never saved. */
  const canSave = useRef(false);
  /** True while a fresh conversion waits for Excalidraw to mount. */
  const fresh = useRef(false);
  const live = useRef(true);
  /** What the last successful write held, so a change that leaves the scene as it is writes nothing. */
  const lastWritten = useRef<string | null>(null);
  const dark = useResolvedDark();
  const locale = useLocale();
  const kind = diagramKind(source);
  const name = sketchFileName(documentTitle, index, kind);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let k: string | null = null;
      try {
        k = sketchKey(docKey, await diagramHash(source));
      } catch {
        // No crypto.subtle (plain http outside localhost): the sketch opens, it just is not kept.
      }
      key.current = k;
      let stored = null;
      if (k === null) {
        if (!cancelled) setSaved("unkept");
      } else {
        try {
          stored = await loadSketch(k);
        } catch {
          // Private windows and blocked site data: the sketch works, it just is not kept.
          if (!cancelled) setSaved("blocked");
        }
      }
      if (cancelled) return;
      if (stored) {
        let data;
        try {
          // restore() validates every element, as for any file Excalidraw opens.
          data = restore(stored as Parameters<typeof restore>[0], null, null);
        } catch {
          // The record stays as it is: nothing is saved over a sketch that was never shown.
          setLoad({ status: "error", message: m.sketch_open_failed() });
          return;
        }
        canSave.current = true;
        setOpenKey(k);
        setLoad({ status: "ready", data });
      } else {
        // Converted once Excalidraw is up (onApi): see convertInto.
        fresh.current = true;
        setOpenKey(k);
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
        if (live.current) {
          const reason = message.split("\n")[0] ?? message;
          setLoad({ status: "error", message: m.sketch_convert_failed({ reason }) });
        }
      }
    },
    [source],
  );

  const persist = useCallback((scene: Scene) => {
    const k = key.current;
    if (!k || !canSave.current) return;
    const [elements, appState, files] = scene;
    const text = serializeAsJSON(elements, appState, files, "local");
    // Choosing a tool or moving the pointer changes Excalidraw's state, not the sketch, and every
    // write rewrites the record with all its images.
    if (text === lastWritten.current) {
      setSaved((s) => (s === "unsaved" ? "saved" : s));
      return;
    }
    const json = JSON.parse(text) as {
      elements: unknown[];
      appState: Record<string, unknown>;
      files: Record<string, unknown>;
    };
    saveSketch({ key: k, ...json, savedAt: Date.now() }).then(
      () => {
        lastWritten.current = text;
        setSaved((s) => (s === "blocked" || s === "unkept" ? s : "saved"));
      },
      (error: unknown) => setSaved(isQuotaError(error) ? "full" : "blocked"),
    );
  }, []);

  // Stable, so the memoised canvas does not re-render when the header's save state changes.
  const onChange = useCallback<OnChange>(
    (...scene) => {
      // No key, no sketch to keep: the header already says so.
      if (!canSave.current || !key.current) return;
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

  /**
   * Puts a scene from a file on the canvas with only its inline images
   * (files.ts). Excalidraw's own Open and file drop would hand every image
   * URL in the file to the browser. Undo takes the scene back off.
   */
  const openSceneFile = useCallback(async (file: Blob): Promise<boolean> => {
    const excalidraw = api.current;
    if (!excalidraw) return false;
    let scene;
    try {
      scene = await loadFromBlob(file, excalidraw.getAppState(), excalidraw.getSceneElements());
    } catch {
      return false;
    }
    excalidraw.addFiles(Object.values(inlineFiles(scene.files)));
    excalidraw.updateScene({
      elements: scene.elements,
      appState: { viewBackgroundColor: scene.appState.viewBackgroundColor },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    excalidraw.scrollToContent(undefined, { fitToViewport: true, animate: false });
    return true;
  }, []);

  const openScene = useCallback(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".excalidraw,.json,application/json,application/vnd.excalidraw+json";
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (file) void openSceneFile(file);
    });
    input.click();
  }, [openSceneFile]);

  // A dropped file reaches Excalidraw only when it is not a scene (an image,
  // a library): a scene is opened here, without its remote images. The drop
  // is caught on the way down and handed on again as a copy, which this
  // listener lets through.
  useEffect(() => {
    const body = root.current;
    if (!body) return;
    const handedOn = new WeakSet<Event>();
    const onDrop = (event: DragEvent) => {
      const file = event.dataTransfer?.files[0];
      if (handedOn.has(event) || !file) return;
      event.preventDefault();
      event.stopPropagation();
      const { target, clientX, clientY } = event;
      void openSceneFile(file).then((opened) => {
        if (opened || !(target instanceof Node) || !target.isConnected) return;
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);
        const copy = new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
          dataTransfer,
        });
        handedOn.add(copy);
        target.dispatchEvent(copy);
      });
    };
    body.addEventListener("drop", onDrop, true);
    return () => body.removeEventListener("drop", onDrop, true);
  }, [openSceneFile]);

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

  // Names for two Excalidraw controls it leaves unnamed or mislabelled (controls.ts).
  const menuLabel = m.sketch_menu_label();
  useEffect(() => {
    const body = root.current;
    return body ? keepExcalidrawControlsNamed(body, menuLabel) : undefined;
  }, [menuLabel]);

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
        setExportStatus(m.export_downloaded({ name: `${name}.excalidraw` }));
      } else if (job === "png") {
        setExportStatus(m.sketch_rendering_png());
        const blob = await exportToBlob({
          elements,
          appState: { ...appState, exportBackground: true },
          files,
          mimeType: "image/png",
        });
        downloadBlob(blob, `${name}.png`);
        setExportStatus(m.export_downloaded({ name: `${name}.png` }));
      } else if (job === "svg") {
        setExportStatus(m.sketch_rendering_svg());
        const svg = await exportToSvg({
          elements,
          appState: { ...appState, exportBackground: true },
          files,
        });
        downloadBlob(new Blob([svg.outerHTML], { type: "image/svg+xml" }), `${name}.svg`);
        setExportStatus(m.export_downloaded({ name: `${name}.svg` }));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setExportStatus(m.export_failed({ reason: message }));
    }
  };

  const subtitle = [index ? m.sketch_diagram({ number: index }) : null, kind, SAVED_TEXT[saved]()]
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
            {m.sketch_title()}
          </Heading>
          <span
            className="docwalk-sketch-subtitle"
            data-tone={saved === "saved" || saved === "unsaved" ? undefined : "note"}
          >
            {subtitle}
          </span>
        </div>
        <span className="docwalk-sketch-status" role="status">
          {exportStatus}
        </span>
        <Button
          ref={storeButton}
          className="docwalk-button"
          aria-expanded={storeOpen}
          onPress={() => setStoreOpen((open) => !open)}
        >
          <Archive size={16} aria-hidden="true" />
          {m.sketch_store_button()}
        </Button>
        <MenuTrigger>
          <Button className="docwalk-button" isDisabled={load.status !== "ready"}>
            <Download size={16} aria-hidden="true" />
            {m.app_export()}
          </Button>
          <Popover className="docwalk-popover docwalk-sketch-popover" placement="bottom end">
            <Menu
              aria-label={m.sketch_export_label()}
              className="docwalk-menu"
              onAction={(job) => void runExport(job)}
            >
              {EXPORTS.map(({ id, label, Icon }) => (
                <MenuItem key={id} id={id} textValue={label()} className="docwalk-menu-item">
                  <Icon size={16} aria-hidden="true" />
                  {label()}
                </MenuItem>
              ))}
            </Menu>
          </Popover>
        </MenuTrigger>
        <IconButton label={m.sketch_close()} onPress={onClose}>
          <X size={18} aria-hidden="true" />
        </IconButton>
      </div>
      <div className="docwalk-sketch-canvas">
        {storeOpen && (
          <SavedSketches
            openKey={openKey}
            onClose={() => {
              setStoreOpen(false);
              storeButton.current?.focus();
            }}
          />
        )}
        {load.status === "error" && (
          <p className="docwalk-diagnostic docwalk-sketch-wait">{load.message}</p>
        )}
        {/* One element for both states, so Excalidraw stays mounted when the conversion lands. */}
        {(load.status === "converting" || load.status === "ready") && (
          <SketchCanvas
            data={load.data}
            dark={dark}
            langCode={EXCALIDRAW_LANG[locale]}
            name={name}
            onChange={onChange}
            onApi={onApi}
            onOpenScene={openScene}
          />
        )}
        {(load.status === "loading" || load.status === "converting") && (
          <p className="docwalk-sketch-wait" role="status">
            {m.sketch_converting()}
          </p>
        )}
      </div>
    </div>
  );
}

/** `loadScene: false` also turns off Excalidraw's ⌘O; Open goes through `openSceneFile` instead. */
const UI_OPTIONS: ExcalidrawProps["UIOptions"] = {
  canvasActions: { toggleTheme: false, saveToActiveFile: false, loadScene: false },
};

/**
 * A pasted scene keeps only its inline images (files.ts); pasting a copied
 * image file is unaffected, as Excalidraw reads that one into a data URL.
 */
const pasteInlineFiles: OnPaste = (data) => {
  if (data.files) data.files = inlineFiles(data.files);
  return true;
};

/** No embeds: an embedded page would be a request to a third party (rule 8). */
const noEmbeds = () => false;

interface SketchCanvasProps {
  data: InitialData;
  dark: boolean;
  langCode: string;
  name: string;
  onChange: OnChange;
  onApi: (api: Api) => void;
  onOpenScene: () => void;
}

/** Excalidraw itself, memoised: it re-renders when the theme changes, never on a save. */
const SketchCanvas = memo(function SketchCanvas({
  data,
  dark,
  langCode,
  name,
  onChange,
  onApi,
  onOpenScene,
}: SketchCanvasProps) {
  // Excalidraw writes its own language code ("tr-TR") into <html lang> and
  // leaves it there; the page's language is the app's, so put it back.
  useEffect(() => () => void (document.documentElement.lang = getAppLocale()), []);
  return (
    <Excalidraw
      initialData={data}
      excalidrawAPI={onApi}
      onChange={onChange}
      theme={dark ? "dark" : "light"}
      langCode={langCode}
      name={name}
      autoFocus
      aiEnabled={false}
      validateEmbeddable={noEmbeds}
      UIOptions={UI_OPTIONS}
      onPaste={pasteInlineFiles}
    >
      {/* The default menu, less the theme toggle (the app's theme rules) and the social links. */}
      <MainMenu>
        <MainMenu.Item icon={<FolderOpen size={16} aria-hidden="true" />} onSelect={onOpenScene}>
          {m.sketch_open_scene()}
        </MainMenu.Item>
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
