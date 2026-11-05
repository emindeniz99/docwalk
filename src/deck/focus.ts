import Panzoom, { type PanzoomObject } from "@panzoom/panzoom";
import { requestSketch } from "../canvas/request";

/**
 * Diagram focus: a full-window view of one diagram with fit, zoom, pan,
 * reset and fullscreen. Wheel zoom needs Ctrl/Cmd so scrolling past a
 * diagram never zooms it by accident; pinch zoom works on touch screens.
 * Escape closes it and returns focus to the diagram on the slide. While it
 * is open the rest of the page is inert and Tab cycles through its toolbar.
 */
export function openDiagramFocus(diagram: HTMLElement): () => void {
  const svg = diagram.querySelector("svg");
  if (!svg) return () => undefined;

  const overlay = document.createElement("div");
  overlay.className = "docwalk-focus";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Diagram, full screen");
  // A click on the stage focuses the overlay rather than <body>, so its keys still work.
  overlay.tabIndex = -1;

  const stage = document.createElement("div");
  stage.className = "docwalk-focus-stage";
  const canvas = document.createElement("div");
  canvas.className = "docwalk-focus-canvas";
  const copy = svg.cloneNode(true) as SVGSVGElement;
  // The slide copy carries its fitted size; the focus view sizes the diagram itself.
  copy.removeAttribute("style");
  copy.removeAttribute("width");
  copy.removeAttribute("height");
  canvas.append(copy);
  const naturalWidth = Number(diagram.dataset["naturalWidth"]) || svg.viewBox.baseVal.width || 800;
  const naturalHeight =
    Number(diagram.dataset["naturalHeight"]) || svg.viewBox.baseVal.height || 600;
  stage.append(canvas);

  const toolbar = document.createElement("div");
  toolbar.className = "docwalk-focus-toolbar";
  overlay.append(stage, toolbar);
  // aria-modal only informs screen readers; inert keeps Tab and clicks off the page behind.
  const madeInert = [...document.body.children].filter(
    (el): el is HTMLElement => el instanceof HTMLElement && !el.inert,
  );
  for (const el of madeInert) el.inert = true;
  document.body.append(overlay);

  const panzoom: PanzoomObject = Panzoom(canvas, {
    maxScale: 12,
    minScale: 0.1,
    step: 0.25,
  });

  // Fit by sizing the SVG itself (it stays vector-sharp) and let CSS centre
  // it in the stage; Panzoom then starts from scale 1 at the centre.
  const fit = () => {
    const scale =
      Math.min(stage.clientWidth / naturalWidth, stage.clientHeight / naturalHeight) * 0.95;
    copy.setAttribute("width", String(Math.floor(naturalWidth * scale)));
    copy.setAttribute("height", String(Math.floor(naturalHeight * scale)));
    panzoom.reset({ animate: false });
  };

  const button = (label: string, title: string, action: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.title = title;
    b.setAttribute("aria-label", title);
    b.addEventListener("click", action);
    toolbar.append(b);
    return b;
  };
  button("−", "Zoom out", () => panzoom.zoomOut());
  button("+", "Zoom in", () => panzoom.zoomIn());
  button("Fit", "Fit to screen", fit);
  button("⛶", "Fullscreen", () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void overlay.requestFullscreen?.();
  });
  // Canvas mode (decision 54): the app opens the sketch dialog, lazily, in place of this view.
  const source = diagram.dataset["source"];
  if (source !== undefined) {
    // A short label keeps the toolbar on one row at 390 px; the name says what it does.
    button("Sketch", "Open as sketch", () => {
      const hosts = [
        ...(diagram.closest(".slides") ?? document).querySelectorAll(".docwalk-diagram"),
      ];
      const at = hosts.indexOf(diagram);
      close();
      requestSketch({ source, index: at >= 0 ? at + 1 : null });
    });
  }
  const closeButton = button("✕", "Close", () => close());

  const onWheel = (event: WheelEvent) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    panzoom.zoomWithWheel(event);
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Tab") {
      // Keep focus in the toolbar: past the last button comes the first, and back.
      const buttons = [...toolbar.querySelectorAll("button")];
      const first = buttons[0];
      const last = buttons.at(-1);
      const active = document.activeElement;
      let target: HTMLButtonElement | undefined;
      if (!toolbar.contains(active)) target = event.shiftKey ? last : first;
      else if (event.shiftKey && active === first) target = last;
      else if (!event.shiftKey && active === last) target = first;
      else return;
      event.preventDefault();
      target?.focus();
    } else if (event.key === "Escape") close();
    else if (event.key === "+" || event.key === "=") panzoom.zoomIn();
    else if (event.key === "-") panzoom.zoomOut();
    else if (event.key === "0") fit();
    else return;
    event.stopPropagation();
  };
  stage.addEventListener("wheel", onWheel, { passive: false });
  overlay.addEventListener("keydown", onKey);

  function close() {
    stage.removeEventListener("wheel", onWheel);
    overlay.removeEventListener("keydown", onKey);
    panzoom.destroy();
    if (document.fullscreenElement === overlay) void document.exitFullscreen();
    overlay.remove();
    for (const el of madeInert) el.inert = false;
    diagram.focus();
  }

  requestAnimationFrame(fit);
  closeButton.focus();
  return close;
}
