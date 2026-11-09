import { MATH_DISPLAY_CLASS } from "../render/math";

/** Pixels of overflow ignored, so sub-pixel rounding never raises a diagnostic. */
export const OVERFLOW_TOLERANCE_PX = 4;

export interface Overflow {
  x: number;
  y: number;
}

export interface SlideMeasurement {
  /** Overflow of the slide body as a whole. */
  body: Overflow;
  /** Overflow of each diagram host, in document order. Hosts clip their own content, so the body check alone misses them. */
  diagrams: Overflow[];
  /** Overflow of each code block, in document order. A slide's `<pre>` scrolls inside itself, so the body check alone misses a line wider than the slide. */
  code: Overflow[];
  /** Overflow of each display equation, in document order. A block scrolls its own equation (decision 101), so the body check alone misses one wider than the slide. */
  math: Overflow[];
  /** Diagrams scaled below `READABLE_SCALE` to fit the slide. */
  tooSmall: number;
  overflows: boolean;
}

/**
 * Below this scale, Mermaid's 16 px labels render under ~10 px: too small to
 * read from across a room. A design choice, not a sourced standard.
 */
export const READABLE_SCALE = 0.65;

/** Share of the slide body a diagram may take, so the text around it stays on the slide. */
export const DIAGRAM_HEIGHT_SHARE = 0.6;

function overflowOf(el: HTMLElement): Overflow {
  const x = el.scrollWidth - el.clientWidth;
  const y = el.scrollHeight - el.clientHeight;
  return {
    x: x > OVERFLOW_TOLERANCE_PX ? x : 0,
    y: y > OVERFLOW_TOLERANCE_PX ? y : 0,
  };
}

/** Diagrams under `root` that `fitDiagrams` scaled below `READABLE_SCALE`. Needs no layout. */
export function tooSmallDiagrams(root: ParentNode): number {
  return [...root.querySelectorAll<HTMLElement>(".docwalk-diagram")].filter(
    (h) => Number(h.dataset["scale"] ?? 1) < READABLE_SCALE,
  ).length;
}

const clipped = (o: Overflow) => o.x > 0 || o.y > 0;

/** Measure a slide body that is laid out (not `display: none`). */
export function measureBody(body: HTMLElement): SlideMeasurement {
  const bodyOverflow = overflowOf(body);
  const diagrams = [...body.querySelectorAll<HTMLElement>(".docwalk-diagram")].map(overflowOf);
  const code = [...body.querySelectorAll<HTMLElement>("pre")].map(overflowOf);
  const math = [...body.querySelectorAll<HTMLElement>(`.${MATH_DISPLAY_CLASS}`)].map(overflowOf);
  const tooSmall = tooSmallDiagrams(body);
  const overflows =
    clipped(bodyOverflow) || diagrams.some(clipped) || code.some(clipped) || math.some(clipped);
  return { body: bodyOverflow, diagrams, code, math, tooSmall, overflows };
}

/** The content box of an empty slide body at `size`, measured off-screen. */
export function slideBodySize(size: { width: number; height: number }): {
  width: number;
  height: number;
} {
  const slide = document.createElement("div");
  slide.className = "docwalk-slide";
  const body = document.createElement("div");
  body.className = "docwalk-slide-body";
  slide.append(body);
  const [result] = withOffscreenBox(size, (box) => {
    box.replaceChildren(slide);
    return [{ width: body.clientWidth, height: body.clientHeight }];
  });
  return result ?? size;
}

/**
 * Scale every rendered diagram to fit the slide body: never wider than the
 * body, never taller than `DIAGRAM_HEIGHT_SHARE` of it, never enlarged. The
 * scale is recorded in `data-scale` so measurement can flag diagrams that
 * became too small to read. Works on hidden slides: it needs only the
 * viewBox, not layout.
 */
export function fitDiagrams(root: ParentNode, body: { width: number; height: number }): void {
  for (const host of root.querySelectorAll<HTMLElement>(".docwalk-diagram")) {
    const svg = host.querySelector("svg");
    const width = Number(host.dataset["naturalWidth"]);
    const height = Number(host.dataset["naturalHeight"]);
    if (!svg || !width || !height) continue;
    const scale = Math.min(1, body.width / width, (body.height * DIAGRAM_HEIGHT_SHARE) / height);
    svg.style.width = `${Math.floor(width * scale)}px`;
    svg.style.height = `${Math.floor(height * scale)}px`;
    svg.style.maxWidth = "none";
    host.dataset["scale"] = scale.toFixed(3);
  }
}

function withOffscreenBox<T>(
  size: { width: number; height: number },
  run: (box: HTMLElement) => T[],
): T[] {
  const box = document.createElement("div");
  box.className = "docwalk-measure";
  Object.assign(box.style, {
    position: "fixed",
    left: "-100000px",
    top: "0",
    visibility: "hidden",
    pointerEvents: "none",
    width: `${size.width}px`,
    height: `${size.height}px`,
    contain: "strict",
  });
  document.body.append(box);
  try {
    return run(box);
  } finally {
    box.remove();
  }
}

/**
 * Wait until measurements mean something (decision 22): fonts loaded, every
 * image under `root` decoded (or failed) and its size pinned for the copies
 * pagination measures, then one animation frame so layout has run. Diagrams
 * must already be rendered by the caller; `releaseImageSizes` follows the
 * last measurement.
 */
export async function settled(root: ParentNode): Promise<void> {
  await document.fonts.ready;
  const images = [...root.querySelectorAll<HTMLImageElement>("img[src]")];
  await Promise.all(images.map((img) => img.decode().catch(() => undefined)));
  for (const img of images) pinSize(img);
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

/** What `pinSize` set on an image: "ratio", or "size" for the ratio and both attributes. */
const PINNED = "data-docwalk-pinned";

/**
 * Pagination and the overflow note measure copies of a slide at once, and a
 * copy of an image may have to load it again: Firefox does when its cache will
 * not answer. Until then the copy has no size, so a page could take the
 * blocks that the image pushes off it. A loaded image therefore keeps its size
 * where a copy reads it before loading: its ratio, and its width and height
 * when the author set neither. `releaseImageSizes` takes the pin off again.
 */
function pinSize(img: HTMLImageElement): void {
  const { naturalWidth: width, naturalHeight: height } = img;
  if (!img.complete || width === 0 || height === 0) return;
  img.style.aspectRatio = `auto ${width} / ${height}`;
  if (img.hasAttribute("width") || img.hasAttribute("height")) {
    img.setAttribute(PINNED, "ratio");
    return;
  }
  img.setAttribute("width", String(width));
  img.setAttribute("height", String(height));
  img.setAttribute(PINNED, "size");
}

/**
 * Takes the pins `settled` put on images off the pages under `roots`, once
 * pagination and the overflow note have measured their copies. A fixed width
 * and height would outlive the image: in an HTML export, which blocks every
 * image, the placeholder took the image's full size.
 */
export function releaseImageSizes(roots: Iterable<ParentNode>): void {
  for (const root of roots) {
    for (const img of root.querySelectorAll<HTMLImageElement>(`img[${PINNED}]`)) {
      if (img.getAttribute(PINNED) === "size") {
        img.removeAttribute("width");
        img.removeAttribute("height");
      }
      img.style.removeProperty("aspect-ratio");
      if (!img.getAttribute("style")) img.removeAttribute("style");
      img.removeAttribute(PINNED);
    }
  }
}

/**
 * Measure slide bodies that reveal.js may be hiding: clone each into an
 * off-screen box with the slide's size, so hidden slides measure like
 * visible ones. `visibility: hidden` keeps layout; `display: none` would
 * measure every slide as empty.
 */
export function measureOffscreen(
  bodies: HTMLElement[],
  size: { width: number; height: number },
): SlideMeasurement[] {
  return withOffscreenBox(size, (box) =>
    bodies.map((body) => {
      const slide = body.closest(".docwalk-slide") ?? body;
      const clone = slide.cloneNode(true) as HTMLElement;
      box.replaceChildren(clone);
      const cloneBody = clone.matches(".docwalk-slide-body")
        ? clone
        : (clone.querySelector<HTMLElement>(".docwalk-slide-body") ?? clone);
      return measureBody(cloneBody);
    }),
  );
}
