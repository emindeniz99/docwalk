import Panzoom, { type PanzoomObject } from "@panzoom/panzoom";
import { requestSketch } from "../canvas/request";
import { m } from "../paraglide/messages.js";
import { FOCUS_VIEW_CLASS } from "./focusView";
import { focusKind, isLoadedImage, unmarkFocusTargets, type FocusKind } from "./focusTargets";

/**
 * Focus view: a full-window view of one diagram, code block, table or image.
 * Escape closes it and returns focus to the block on the slide. While it is
 * open the rest of the page is inert, Tab cycles through the view, and no
 * key reaches the app behind it.
 *
 * Diagrams and images are drawn on a canvas with fit, zoom, pan, reset and
 * fullscreen (wheel zoom needs Ctrl/Cmd so scrolling past never zooms it by
 * accident; pinch zoom works on touch screens). Code and tables are text:
 * they scroll natively and zoom by type size, so selection, touch scroll and
 * line marks keep working (decision 87).
 */

type ViewKind = "diagram" | FocusKind;

/** What a stage hands the shell: how it zooms, and what else its toolbar holds. */
interface Stage {
  zoomOut(): void;
  zoomIn(): void;
  fit(): void;
  wheel(event: WheelEvent): void;
  /** Called once the view is in the page and its toolbar is built. */
  start(): void;
  /** Extra toolbar buttons, between Fullscreen and Close. */
  extras?(add: AddButton): void;
  dispose(): void;
}
type AddButton = (label: string, title: string, action: () => void) => HTMLButtonElement;

let current: { kind: ViewKind; close: () => void } | null = null;

/**
 * Closes an open code, table or image view. A rebuild or a change of slide
 * calls it: the copy comes from a slide that is gone. The diagram view is
 * left as it was (decision 87).
 */
export function closeContentFocus(): void {
  if (current && current.kind !== "diagram") current.close();
}

function mountView(
  origin: HTMLElement,
  kind: ViewKind,
  label: string,
  makeStage: (stage: HTMLElement, close: () => void) => Stage,
): () => void {
  // React keeps this element across deck rebuilds; the `.reveal` inside it is replaced.
  const deckHost = origin.closest(".docwalk-deck-host");

  const overlay = document.createElement("div");
  overlay.className = FOCUS_VIEW_CLASS;
  overlay.dataset["kind"] = kind;
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", label);
  // A click on the stage focuses the overlay rather than <body>, so its keys still work.
  overlay.tabIndex = -1;

  const stage = document.createElement("div");
  stage.className = "docwalk-focus-stage";
  const toolbar = document.createElement("div");
  toolbar.className = "docwalk-focus-toolbar";
  overlay.append(stage, toolbar);
  // aria-modal only informs screen readers; inert keeps Tab and clicks off the page behind.
  const madeInert = [...document.body.children].filter(
    (el): el is HTMLElement => el instanceof HTMLElement && !el.inert,
  );
  for (const el of madeInert) el.inert = true;
  document.body.append(overlay);

  const view = makeStage(stage, () => close());

  const button: AddButton = (text, title, action) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.title = title;
    b.setAttribute("aria-label", title);
    b.addEventListener("click", action);
    toolbar.append(b);
    return b;
  };
  button("−", m.focus_zoom_out(), () => view.zoomOut());
  button("+", m.focus_zoom_in(), () => view.zoomIn());
  button(m.focus_fit(), m.focus_fit_title(), () => view.fit());
  button("⛶", m.focus_fullscreen(), () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void overlay.requestFullscreen?.();
  });
  view.extras?.(button);
  const closeButton = button("✕", m.close(), () => close());

  const onWheel = (event: WheelEvent) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    view.wheel(event);
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Tab") {
      // Keep focus in the view: past the last stop comes the first, and back.
      const stops = [
        ...overlay.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]'),
      ];
      const first = stops[0];
      const last = stops.at(-1);
      const active = document.activeElement as HTMLElement | null;
      let target: HTMLElement | undefined;
      if (!active || !stops.includes(active)) target = event.shiftKey ? last : first;
      else if (event.shiftKey && active === first) target = last;
      else if (!event.shiftKey && active === last) target = first;
      if (target) {
        event.preventDefault();
        target.focus();
      }
    } else if (event.key === "Escape") close();
    else if (event.key === "+" || event.key === "=") view.zoomIn();
    else if (event.key === "-") view.zoomOut();
    else if (event.key === "0") view.fit();
    // The page behind is inert, but its shortcuts listen on the window: O, the pen
    // letters, Ctrl+K and the clicker keys must not reach it from here.
    event.stopPropagation();
  };
  stage.addEventListener("wheel", onWheel, { passive: false });
  overlay.addEventListener("keydown", onKey);

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    stage.removeEventListener("wheel", onWheel);
    overlay.removeEventListener("keydown", onKey);
    view.dispose();
    if (document.fullscreenElement === overlay) void document.exitFullscreen();
    overlay.remove();
    for (const el of madeInert) el.inert = false;
    if (current?.close === close) current = null;
    // A rebuild while the view was open detached the origin, and focusing it would
    // leave focus on <body>, where reveal.js ignores the arrow keys and the clicker.
    // The same goes for a slide that is no longer shown (reveal.js marks it hidden and inert):
    // the deck takes focus instead.
    if (
      origin.isConnected &&
      origin.checkVisibility?.() !== false &&
      !origin.closest("[inert], [hidden]")
    )
      origin.focus();
    else deckHost?.querySelector<HTMLElement>(".reveal")?.focus({ preventScroll: true });
  }

  current = { kind, close };
  view.start();
  closeButton.focus();
  return close;
}

/** Fit, zoom and pan of a picture on a canvas: Panzoom, as for the diagram since decision 28. */
function canvasStage(
  stage: HTMLElement,
  copy: SVGSVGElement | HTMLImageElement,
  naturalWidth: number,
  naturalHeight: number,
): Stage {
  const canvas = document.createElement("div");
  canvas.className = "docwalk-focus-canvas";
  canvas.append(copy);
  stage.append(canvas);

  const panzoom: PanzoomObject = Panzoom(canvas, {
    maxScale: 12,
    minScale: 0.1,
    step: 0.25,
  });

  // Fit by sizing the picture itself (it stays sharp) and let CSS centre it in the
  // stage; Panzoom then starts from scale 1 at the centre.
  const fit = () => {
    const scale =
      Math.min(stage.clientWidth / naturalWidth, stage.clientHeight / naturalHeight) * 0.95;
    copy.setAttribute("width", String(Math.floor(naturalWidth * scale)));
    copy.setAttribute("height", String(Math.floor(naturalHeight * scale)));
    panzoom.reset({ animate: false });
  };

  return {
    zoomOut: () => panzoom.zoomOut(),
    zoomIn: () => panzoom.zoomIn(),
    fit,
    wheel: (event) => panzoom.zoomWithWheel(event),
    start: () => requestAnimationFrame(fit),
    dispose: () => panzoom.destroy(),
  };
}

function diagramStage(stage: HTMLElement, diagram: HTMLElement, close: () => void): Stage {
  const svg = diagram.querySelector("svg") as SVGSVGElement;
  const copy = svg.cloneNode(true) as SVGSVGElement;
  // The slide copy carries its fitted size; the focus view sizes the diagram itself.
  copy.removeAttribute("style");
  copy.removeAttribute("width");
  copy.removeAttribute("height");
  const naturalWidth = Number(diagram.dataset["naturalWidth"]) || svg.viewBox.baseVal.width || 800;
  const naturalHeight =
    Number(diagram.dataset["naturalHeight"]) || svg.viewBox.baseVal.height || 600;
  const base = canvasStage(stage, copy, naturalWidth, naturalHeight);
  // Canvas mode (decision 54): the app opens the sketch dialog, lazily, in place of this view.
  const source = diagram.dataset["source"];
  if (source === undefined) return base;
  return {
    ...base,
    extras(add) {
      // A short label keeps the toolbar on one row at 390 px; the name says what it does.
      add(m.focus_sketch(), m.focus_sketch_title(), () => {
        const hosts = [
          ...(diagram.closest(".slides") ?? document).querySelectorAll(".docwalk-diagram"),
        ];
        const at = hosts.indexOf(diagram);
        close();
        requestSketch({ source, index: at >= 0 ? at + 1 : null });
      });
    },
  };
}

/** Type scale of the text kinds: the range of the buttons, and where Fit may land (decision 87). */
const SCALE_MIN = 0.5;
const SCALE_MAX = 4;
const SCALE_STEP = 0.25;
const FIT_MIN = 0.75;
const FIT_MAX = 3;

/**
 * The copy of a slide element that goes into the view, taken from the
 * sanitized DOM with `cloneNode`: no HTML is parsed (rule 5). Everything that
 * would repeat or dangle beside the slide is removed: ids, tab stops and
 * marks, references to ids, and links to ids the copy does not have.
 */
function cleanCopy<T extends HTMLElement>(origin: T): T {
  const copy = origin.cloneNode(true) as T;
  unmarkFocusTargets(copy);
  for (const el of [copy, ...copy.querySelectorAll("*")]) {
    el.removeAttribute("id");
    el.removeAttribute("aria-labelledby");
    el.removeAttribute("aria-describedby");
    if (el.localName === "a" && el.getAttribute("href")?.startsWith("#")) {
      el.removeAttribute("href");
    }
  }
  return copy;
}

const LINE_CLASS = "docwalk-code-line";

/**
 * Splits the children of a `<code>` into one block per line. A line holds
 * its own newline, so the text of the lines joined is the text of the code.
 * Colour spans keep their place: an element that spans a line break is
 * opened again on the next line. Only text nodes and shells of the copy are
 * used, so nothing in a listing can become markup.
 */
function intoLines(code: Element): HTMLElement[] {
  const lines: HTMLElement[] = [];
  let line: HTMLElement | null = null;
  const place = (text: string, shells: Element[]) => {
    if (!line) {
      line = document.createElement("span");
      line.className = LINE_CLASS;
      lines.push(line);
    }
    let parent: Element = line;
    for (const shell of shells) {
      const again = shell.cloneNode(false) as Element;
      parent.append(again);
      parent = again;
    }
    parent.append(text);
  };
  const walk = (node: Node, shells: Element[]) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const parts = (node.textContent ?? "").split("\n");
      parts.forEach((part, i) => {
        const last = i === parts.length - 1;
        const text = last ? part : `${part}\n`;
        if (text !== "") place(text, shells);
        if (!last) line = null;
      });
    } else if (node instanceof Element) {
      for (const child of node.childNodes) walk(child, [...shells, node]);
    }
  };
  for (const child of code.childNodes) walk(child, []);
  return lines;
}

const lineOf = (event: Event) =>
  event.target instanceof Element
    ? (event.target.closest<HTMLElement>(`.${LINE_CLASS}`) ?? null)
    : null;

function textStage(stage: HTMLElement, origin: HTMLElement, kind: "code" | "table"): Stage {
  stage.dataset["mode"] = "sheet";
  // The class brings the slide's own table, code and colour rules; the sheet only sets size.
  const sheet = document.createElement("div");
  sheet.className = "docwalk-focus-sheet docwalk-slide-body";
  const copy = cleanCopy(origin);
  sheet.append(copy);
  stage.append(sheet);

  let scale = 1;
  const apply = (next: number) => {
    scale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, next));
    sheet.style.setProperty("--focus-scale", String(scale));
  };
  // The largest size that needs no sideways scroll and, above 1, no vertical scroll. A
  // line or column that is wider than the screen at FIT_MIN scrolls; smaller is not readable.
  const fit = () => {
    for (let next = FIT_MAX; next >= FIT_MIN; next -= SCALE_STEP) {
      apply(next);
      const sideways = stage.scrollWidth > stage.clientWidth + 1;
      const tall = stage.scrollHeight > stage.clientHeight + 1;
      if (!sideways && (next <= 1 || !tall)) return;
    }
    apply(FIT_MIN);
  };

  const base: Stage = {
    zoomOut: () => apply(scale - SCALE_STEP),
    zoomIn: () => apply(scale + SCALE_STEP),
    fit,
    wheel: (event) => apply(scale + (event.deltaY < 0 ? SCALE_STEP : -SCALE_STEP)),
    start: fit,
    dispose: () => undefined,
  };
  if (kind === "table") {
    // Nothing inside a table takes focus, and axe wants a scrolling region to be reachable.
    stage.tabIndex = 0;
    stage.setAttribute("role", "region");
    stage.setAttribute("aria-label", m.focus_label_table());
    return base;
  }

  copy.setAttribute("role", "group");
  copy.setAttribute("aria-label", m.focus_code_lines());
  const code = copy.querySelector("code") ?? copy;
  const rows = intoLines(code);
  code.replaceChildren(...rows);
  rows.forEach((row, i) => {
    const text = (row.textContent ?? "").replace(/\n$/, "");
    row.setAttribute("role", "button");
    row.setAttribute("aria-pressed", "false");
    row.setAttribute(
      "aria-label",
      text.trim() === ""
        ? m.focus_line_empty({ number: i + 1 })
        : m.focus_line({ number: i + 1, text }),
    );
    row.tabIndex = i === 0 ? 0 : -1;
  });
  let clear: HTMLButtonElement | null = null;
  const anyMarked = () => rows.some((row) => row.getAttribute("aria-pressed") === "true");
  const rove = (to: number) => {
    const next = rows[Math.min(rows.length - 1, Math.max(0, to))];
    if (!next) return;
    for (const row of rows) row.tabIndex = row === next ? 0 : -1;
    next.focus();
  };
  const toggle = (row: HTMLElement) => {
    row.setAttribute("aria-pressed", String(row.getAttribute("aria-pressed") !== "true"));
    if (clear) clear.disabled = !anyMarked();
  };
  copy.addEventListener("click", (event) => {
    const row = lineOf(event);
    if (!row) return;
    // A drag that selects text ends in a click; it is not a mark.
    const selection = getSelection();
    if (selection && !selection.isCollapsed && selection.containsNode(row, true)) return;
    for (const other of rows) other.tabIndex = other === row ? 0 : -1;
    toggle(row);
  });
  copy.addEventListener("keydown", (event) => {
    const row = lineOf(event);
    if (!row) return;
    const at = rows.indexOf(row);
    if (event.key === "ArrowDown") rove(at + 1);
    else if (event.key === "ArrowUp") rove(at - 1);
    else if (event.key === "Home") rove(0);
    else if (event.key === "End") rove(rows.length - 1);
    else if (event.key === "Enter" || event.key === " ") toggle(row);
    else return;
    event.preventDefault();
  });
  return {
    ...base,
    extras(add) {
      clear = add(m.focus_clear(), m.focus_clear_title(), () => {
        for (const row of rows) row.setAttribute("aria-pressed", "false");
        if (clear) clear.disabled = true;
      });
      clear.disabled = true;
    },
  };
}

function imageStage(stage: HTMLElement, origin: HTMLImageElement): Stage {
  // A new <img> for the address the slide already loaded: `currentSrc` is a cache hit,
  // and a blocked image never gets here because it has no `src` (decision 33).
  const copy = document.createElement("img");
  copy.alt = origin.alt;
  copy.src = origin.currentSrc;
  return canvasStage(stage, copy, origin.naturalWidth, origin.naturalHeight);
}

export function openDiagramFocus(diagram: HTMLElement): () => void {
  if (!diagram.querySelector("svg")) return () => undefined;
  return mountView(diagram, "diagram", m.focus_label(), (stage, close) =>
    diagramStage(stage, diagram, close),
  );
}

/**
 * Opens the focus view for a marked code block, table or image. An image
 * opens only once it has loaded; anything else, including a click on a
 * block that was never marked, does nothing.
 */
export function openBlockFocus(block: HTMLElement): () => void {
  const kind = focusKind(block);
  if (kind === "image" && block instanceof HTMLImageElement && isLoadedImage(block)) {
    return mountView(block, kind, m.focus_label_image(), (stage) => imageStage(stage, block));
  }
  if (kind === "code" || kind === "table") {
    const label = kind === "code" ? m.focus_label_code() : m.focus_label_table();
    return mountView(block, kind, label, (stage) => textStage(stage, block, kind));
  }
  return () => undefined;
}
