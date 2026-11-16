import type { Root } from "mdast";
import { useEffect, useMemo, useRef } from "react";
import { FOCUS_ATTR } from "../deck/focusTargets";
import { useLocale } from "../i18n/locale";
import { m } from "../paraglide/messages.js";
import { useLoadRemoteImages } from "../render/remoteImages";
import type { SectionPlan } from "../sectioning/sectionize";
import {
  type Camera,
  cameraTransform,
  clamp,
  FIT_MARGIN,
  fitFrame,
  framesNear,
  pan,
  pinch,
  type Size,
  wheel,
  zoomAt,
} from "./camera";
import { renderFrames, type MapFrames } from "./frames";
import {
  type FrameRect,
  mapColumns,
  mapPlan,
  type MapFrame,
  type MapPlacement,
  MIN_FRAME_HEIGHT,
  placeFrames,
} from "./layout";
import "./map.css";

export interface MapViewProps {
  /**
   * The parsed document. The map sections it itself with `mapPlan`, so the
   * level override and the choice of sections do not change it (decision 142).
   */
  root: Root;
}

interface Point {
  x: number;
  y: number;
}

/** Safari's `GestureEvent`, which the DOM types do not have. */
type GestureLike = Event & { scale?: number; clientX?: number; clientY?: number };

/**
 * A box in a frame that scrolls gets a tab stop, so a keyboard user can
 * scroll it (WCAG 2.1.1), as the document view does: wide tables, code and
 * equations, and the frame's body when a wide table makes it scroll
 * sideways. A focus target is a tab stop already. Frames near the view
 * gain focus targets once drawn (frames.ts); far frames rely on this.
 */
function markScrollable(frame: HTMLElement): void {
  for (const box of frame.querySelectorAll<HTMLElement>(
    ".docwalk-slide-body, table, pre, .docwalk-math-display",
  )) {
    if (box.hasAttribute(FOCUS_ATTR)) continue;
    if (box.scrollWidth > box.clientWidth || box.scrollHeight > box.clientHeight) box.tabIndex = 0;
    else box.removeAttribute("tabindex");
  }
}

interface MapController {
  /** Draws `plan`'s frames in place of the current ones; the camera stays where it is. */
  render: (plan: SectionPlan, loadRemoteImages: boolean) => void;
  /** Stops everything and empties the layer. */
  dispose: () => void;
}

/**
 * The map's frames on `layer`, placed by `placeFrames` and moved by one
 * camera transform (decision 142). The camera lives here, outside React:
 * input changes it at once and the layer is written at most once per
 * animation frame.
 *
 * Rules this view chose (step 2):
 * - The frames stay hidden until the first full set of heights is placed
 *   and the pane has a size; then the camera opens on the first frame.
 * - A height change re-places the frames and leaves the camera alone,
 *   only clamped to the new bounds: the frames after the changed one in
 *   its column move, the rest of the screen does not.
 * - "Empty map" for a mouse drag is the pane, the layer and a frame's own
 *   box outside its `.docwalk-slide-body`; inside the body the mouse
 *   selects text and follows links.
 */
function mountMap(pane: HTMLElement, layer: HTMLElement): MapController {
  layer.style.setProperty("--map-min-frame-height", `${MIN_FRAME_HEIGHT}px`);
  /** Null until the opening view. */
  let camera: Camera | null = null;
  let paneSize: Size = { width: pane.clientWidth, height: pane.clientHeight };
  let columns: MapFrame[][] = [];
  let heights = new Map<string, number>();
  let placement: MapPlacement = placeFrames([], heights);
  let rects = new Map<string, FrameRect>();
  let handle: MapFrames | null = null;
  /** The current render's first full set of heights has arrived. */
  let measured = false;
  /** Each frame element's written place, so a placement writes only what moved. */
  const written = new WeakMap<HTMLElement, string>();
  let raf = 0;

  const write = () => {
    raf = 0;
    if (!handle) return;
    for (const rect of placement.frames) {
      const el = handle.frames.get(rect.id);
      const at = `${rect.x},${rect.y}`;
      if (!el || written.get(el) === at) continue;
      el.style.left = `${rect.x}px`;
      el.style.top = `${rect.y}px`;
      written.set(el, at);
    }
    layer.style.width = `${placement.bounds.width}px`;
    layer.style.height = `${placement.bounds.height}px`;
    if (!camera) return;
    layer.style.transform = cameraTransform(camera);
    layer.dataset["placed"] = "";
    // Frames drawn later are measured again by frames.ts and re-placed below.
    if (measured) void handle.drawDiagrams(framesNear(placement, camera, paneSize));
  };
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(write);
  };
  /** Writes a pending change now, so the layer's boxes show the camera held here. */
  const writeNow = () => {
    if (!raf) return;
    cancelAnimationFrame(raf);
    write();
  };
  const setCamera = (next: Camera) => {
    camera = next;
    schedule();
  };

  /** The opening view: the first frame fitted to the pane's width (decision 142). */
  const open = () => {
    if (camera || !measured || paneSize.width <= 0 || paneSize.height <= 0) return;
    const first = placement.frames[0];
    setCamera(
      first
        ? fitFrame(first, placement.bounds, paneSize)
        : clamp({ x: 0, y: 0, scale: 1 }, placement.bounds, paneSize),
    );
  };

  const place = () => {
    placement = placeFrames(columns, heights);
    rects = new Map(placement.frames.map((rect) => [rect.id, rect]));
    if (camera) camera = clamp(camera, placement.bounds, paneSize);
    else open();
    schedule();
  };

  /**
   * Brings `el`, inside a frame, into view: the frame fitted as at opening,
   * then moved up if `el` would still be below the pane. With `force` false
   * nothing moves while `el` is whole in the pane, or partly in it after a
   * pointer moved focus there, so a click never makes the map jump.
   */
  const reveal = (el: HTMLElement, force: boolean) => {
    const id = el.closest<HTMLElement>("[data-map-frame]")?.dataset["mapFrame"];
    const rect = id === undefined ? undefined : rects.get(id);
    if (!camera || !rect) return;
    writeNow();
    const p = pane.getBoundingClientRect();
    const b = el.getBoundingClientRect();
    const left = b.left - p.left - pane.clientLeft;
    const top = b.top - p.top - pane.clientTop;
    const inside =
      left >= 0 &&
      top >= 0 &&
      left + b.width <= paneSize.width &&
      top + b.height <= paneSize.height;
    const seen =
      left + b.width > 0 && top + b.height > 0 && left < paneSize.width && top < paneSize.height;
    if (!force && (inside || (seen && !el.matches(":focus-visible")))) return;
    const mapTop = (top - camera.y) / camera.scale;
    const mapHeight = b.height / camera.scale;
    let next = fitFrame(rect, placement.bounds, paneSize);
    const screenTop = mapTop * next.scale + next.y;
    if (screenTop < 0 || screenTop + mapHeight * next.scale > paneSize.height) {
      const margin = Math.min(FIT_MARGIN, paneSize.height / 4);
      next = clamp({ ...next, y: margin - mapTop * next.scale }, placement.bounds, paneSize);
    }
    setCamera(next);
  };

  const local = (event: { clientX?: number; clientY?: number }): Point => {
    const p = pane.getBoundingClientRect();
    return {
      x: (event.clientX ?? Number.NaN) - p.left - pane.clientLeft,
      y: (event.clientY ?? Number.NaN) - p.top - pane.clientTop,
    };
  };

  // The pane takes every wheel event: a plain wheel pans, Ctrl/Cmd + wheel zooms (decision 127).
  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    if (!camera) return;
    const at = local(event);
    setCamera(
      wheel(
        camera,
        {
          deltaX: event.deltaX,
          deltaY: event.deltaY,
          deltaMode: event.deltaMode,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
          x: at.x,
          y: at.y,
        },
        placement.bounds,
        paneSize,
      ),
    );
  };

  // Touch pointers down on the pane, in pane coordinates.
  const touches = new Map<number, Point>();
  /** One pointer panning: a finger, or a mouse or pen drag that began on empty map. */
  let drag: { id: number; last: Point } | null = null;
  /** Two fingers: the camera and their places when the second came down. */
  let pinching: { ids: [number, number]; camera: Camera; points: [Point, Point] } | null = null;

  const onPointerDown = (event: PointerEvent) => {
    if (!camera) return;
    const at = local(event);
    if (event.pointerType === "touch") {
      touches.set(event.pointerId, at);
      const down = [...touches];
      if (down.length === 1) drag = { id: event.pointerId, last: at };
      else if (down.length === 2) {
        const [[a, pa], [b, pb]] = down as [[number, Point], [number, Point]];
        drag = null;
        pinching = { ids: [a, b], camera, points: [pa, pb] };
      }
      return;
    }
    if (event.button !== 0) return;
    const target = event.target as Element;
    if (target.closest(".docwalk-slide-body")) return;
    // No text selection starts from the frame's chrome; focus goes to the pane as a click would send it.
    event.preventDefault();
    pane.focus({ preventScroll: true });
    drag = { id: event.pointerId, last: at };
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!camera) return;
    const at = local(event);
    if (touches.has(event.pointerId)) touches.set(event.pointerId, at);
    if (pinching) {
      const a = touches.get(pinching.ids[0]);
      const b = touches.get(pinching.ids[1]);
      if (a && b)
        setCamera(pinch(pinching.camera, pinching.points, [a, b], placement.bounds, paneSize));
      return;
    }
    if (drag?.id !== event.pointerId) return;
    const dx = at.x - drag.last.x;
    const dy = at.y - drag.last.y;
    drag.last = at;
    setCamera(pan(camera, dx, dy, placement.bounds, paneSize));
  };
  // On the window: a finger or the mouse can be released outside the pane.
  const onPointerUp = (event: PointerEvent) => {
    if (drag?.id === event.pointerId) drag = null;
    if (!touches.delete(event.pointerId)) return;
    if (pinching && pinching.ids.includes(event.pointerId)) {
      pinching = null;
      // The finger left down pans on from where it is.
      const [rest] = touches;
      if (rest) drag = { id: rest[0], last: rest[1] };
    }
  };

  // Safari's pinch (decisions 127 and 128): judged at its start, ignored while two fingers are down.
  let gesture: { from: number; ignored: boolean } | null = null;
  const onGesture = (event: GestureLike) => {
    event.preventDefault();
    if (event.type === "gesturestart") {
      gesture = camera ? { from: camera.scale, ignored: touches.size > 1 } : null;
      return;
    }
    if (!camera || !gesture || gesture.ignored) return;
    const target = gesture.from * (event.scale ?? 1);
    setCamera(zoomAt(camera, target / camera.scale, local(event), placement.bounds, paneSize));
  };

  // A keyboard user never tabs into something off screen (WCAG 2.4.11).
  const onFocusIn = (event: FocusEvent) => {
    if (event.target instanceof HTMLElement) reveal(event.target, false);
  };

  const resize = new ResizeObserver(() => {
    paneSize = { width: pane.clientWidth, height: pane.clientHeight };
    if (camera) setCamera(clamp(camera, placement.bounds, paneSize));
    else open();
  });
  resize.observe(pane);

  pane.addEventListener("wheel", onWheel, { passive: false });
  pane.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);
  pane.addEventListener("gesturestart", onGesture);
  pane.addEventListener("gesturechange", onGesture);
  layer.addEventListener("focusin", onFocusIn);

  return {
    render(plan, loadRemoteImages) {
      handle?.dispose();
      columns = mapColumns(plan);
      measured = false;
      handle = renderFrames(layer, plan, {
        loadRemoteImages,
        onHeights: (changed) => {
          // The first report has every frame: heights of frames no longer in the plan go.
          if (measured) for (const [id, height] of changed) heights.set(id, height);
          else heights = new Map(changed);
          measured = true;
          // A height changes when the content does, which may make a box scroll or stop.
          for (const id of changed.keys()) {
            const el = handle?.frames.get(id);
            if (el) markScrollable(el);
          }
          place();
        },
        onNavigate: (_frameId, target) => reveal(target, true),
      });
      // Placed at once with the heights known so far, so new frames never show stacked at the origin.
      place();
    },
    dispose() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      handle?.dispose();
      handle = null;
      layer.replaceChildren();
      resize.disconnect();
      pane.removeEventListener("wheel", onWheel);
      pane.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      pane.removeEventListener("gesturestart", onGesture);
      pane.removeEventListener("gesturechange", onGesture);
      layer.removeEventListener("focusin", onFocusIn);
    },
  };
}

/**
 * The map view (decision 142): the frames of the map's plan on one layer in
 * a named, focusable pane, in document order whatever their place, so a
 * screen reader and Tab read the document in order.
 */
export default function MapView({ root }: MapViewProps) {
  const plan = useMemo(() => mapPlan(root), [root]);
  const loadRemoteImages = useLoadRemoteImages();
  // Footnote labels and image buttons are rendered in the UI language.
  const locale = useLocale();
  const paneRef = useRef<HTMLElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const controller = useRef<MapController | null>(null);
  useEffect(() => {
    const map = mountMap(paneRef.current!, layerRef.current!);
    controller.current = map;
    return () => {
      map.dispose();
      controller.current = null;
    };
  }, []);
  useEffect(() => {
    controller.current?.render(plan, loadRemoteImages);
    // `locale` is read through Paraglide while rendering; it is here to re-render on a switch.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [plan, loadRemoteImages, locale]);
  return (
    <section ref={paneRef} className="docwalk-map-pane" aria-label={m.map_region()} tabIndex={0}>
      <div ref={layerRef} className="docwalk-map-layer" />
    </section>
  );
}
