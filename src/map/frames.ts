import { markFocusTargets } from "../deck/focusTargets";
import { renderDiagrams } from "../deck/mermaid";
import { purifyHtml } from "../deck/purify";
import "../render/content.css";
import { renderEmoji } from "../render/emoji";
import { anchorTarget, focusTarget, fragmentTarget } from "../render/fragments";
import { highlightCode } from "../render/highlight";
import { renderMath } from "../render/math";
import { enableClickToLoad } from "../render/remoteImages";
import { nodesToHtml } from "../render/toHtml";
import type { Section, SectionPlan } from "../sectioning/sectionize";
import { FRAME_WIDTH } from "./layout";

/**
 * The map's frames (decision 142, Frames, Measuring and Diagrams): one
 * `<section>` per section of `mapPlan`, drawn with the pipeline of the
 * slides and the document view, measured once rendered (rule 4) and again
 * when a frame's height changes. Placing, scaling and styling the layer is
 * the view's job.
 */

export interface FramesOptions {
  /** Load remote images directly (the "always load images" setting). Default: blocked. */
  loadRemoteImages?: boolean;
  /**
   * Heights in frame units (CSS px at `FRAME_WIDTH`). Called first with every
   * frame once all have rendered, then with only the frames whose height
   * changed, at most once per animation frame. Never called after `dispose`.
   */
  onHeights?: (changed: Map<string, number>) => void;
  /** A link took focus to `target` inside frame `frameId`, for the camera to bring it into view. */
  onNavigate?: (frameId: string, target: HTMLElement) => void;
}

export interface MapFrames {
  /** Every frame element by section id, in document order. */
  frames: ReadonlyMap<string, HTMLElement>;
  /** A frame's height now, in frame units; null for an unknown id. */
  measure: (frameId: string) => number | null;
  /**
   * Draws Mermaid in these frames, each at most once per render, then marks
   * their focus targets. Frames are drawn one after another, in call order.
   */
  drawDiagrams: (frameIds: Iterable<string>) => Promise<void>;
  /** Stops pending work and reporting and removes the listeners; the DOM stays. */
  dispose: () => void;
}

/**
 * One frame: the section's heading and nodes as `buildSlide` (src/deck/slides.ts)
 * renders them, in the slide's own classes so the text has its slide size
 * (decision 139). No breadcrumb and no "continued" title: the map's columns
 * show where a frame belongs, and a part is named by its section's title.
 */
function buildFrame(section: Section, plan: SectionPlan, loadRemoteImages: boolean): HTMLElement {
  const frame = document.createElement("section");
  frame.className = "docwalk-map-frame docwalk-slide";
  frame.dataset["mapFrame"] = section.id;
  // Heights mean something only at this width; the view's scale does not change it.
  frame.style.width = `${FRAME_WIDTH}px`;
  const body = document.createElement("div");
  body.className = "docwalk-slide-body";
  const nodes = section.heading ? [section.heading, ...section.nodes] : section.nodes;
  body.append(
    purifyHtml(
      nodesToHtml(nodes, {
        loadRemoteImages,
        headingIds: plan.headingIds,
        definitions: plan.definitions,
        // Footnotes per frame, as per slide: two frames citing one note never share an id.
        footnotePrefix: `${section.id}-`,
      }),
    ),
  );
  frame.append(body);
  const anchor = section.heading ? plan.headingIds.get(section.heading) : undefined;
  const heading = anchor ? anchorTarget(body, anchor) : null;
  if (heading) frame.setAttribute("aria-labelledby", heading.id);
  else if (section.title) frame.setAttribute("aria-label", section.title);
  return frame;
}

/**
 * Layout height, untouched by an ancestor's transform, with its fraction
 * (`placeFrames` rounds up, so nothing is cut). Zero when not laid out.
 */
function heightOf(frame: HTMLElement): number {
  const height = Number.parseFloat(getComputedStyle(frame).height);
  return Number.isFinite(height) ? height : frame.offsetHeight;
}

/**
 * `settled` in src/deck/measure.ts without its image pins, which only
 * pagination's copies need: fonts loaded, every image decoded or failed,
 * then one animation frame so layout has run.
 */
async function settled(root: ParentNode): Promise<void> {
  await document.fonts.ready;
  const images = [...root.querySelectorAll<HTMLImageElement>("img[src]")];
  await Promise.all(images.map((img) => img.decode().catch(() => undefined)));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

/** Fills `host` with the plan's frames in document order and starts rendering them. */
export function renderFrames(
  host: HTMLElement,
  plan: SectionPlan,
  { loadRemoteImages = false, onHeights, onNavigate }: FramesOptions = {},
): MapFrames {
  const frames = new Map<string, HTMLElement>();
  for (const section of plan.sections) {
    frames.set(section.id, buildFrame(section, plan, loadRemoteImages));
  }
  host.replaceChildren(...frames.values());
  let live = true;
  const stop = () => !live;

  const stopClickToLoad = enableClickToLoad(host);
  // As in the document view: content ids carry GitHub's `user-content-`
  // prefix and links do not. A link with no target here keeps its default.
  const onClick = (event: MouseEvent) => {
    const link = (event.target as Element).closest<HTMLAnchorElement>('a[href^="#"]');
    const target = link && fragmentTarget(host, link.getAttribute("href") ?? "");
    if (!target) return;
    event.preventDefault();
    focusTarget(target);
    const frameId = target.closest<HTMLElement>("[data-map-frame]")?.dataset["mapFrame"];
    if (frameId !== undefined) onNavigate?.(frameId, target);
  };
  host.addEventListener("click", onClick);

  // Heights reported so far. Until the first full report, changes are not
  // reported on their own: that report reads every frame.
  const reported = new Map<string, number>();
  let ready = false;
  const dirty = new Set<string>();
  let pending = 0;
  const flush = () => {
    pending = 0;
    if (!live) return;
    const changed = new Map<string, number>();
    for (const id of dirty) {
      const el = frames.get(id);
      if (!el) continue;
      const height = heightOf(el);
      if (reported.get(id) === height) continue;
      reported.set(id, height);
      changed.set(id, height);
    }
    dirty.clear();
    if (changed.size > 0) onHeights?.(changed);
  };
  const ids = new Map<Element, string>();
  const observer = new ResizeObserver((entries) => {
    if (!live || !ready) return;
    for (const entry of entries) {
      const id = ids.get(entry.target);
      if (id !== undefined) dirty.add(id);
    }
    if (dirty.size > 0 && !pending) pending = requestAnimationFrame(flush);
  });
  for (const [id, el] of frames) {
    const body = el.querySelector(".docwalk-slide-body") ?? el;
    ids.set(body, id);
    observer.observe(body);
  }

  // Rule 4's order. Diagrams are not part of it: the view draws them by frame.
  void (async () => {
    await Promise.all([
      highlightCode(host, { stop }),
      renderMath(host, { stop }),
      renderEmoji(host, { stop }),
    ]);
    if (!live) return;
    await settled(host);
    if (!live) return;
    for (const [id, el] of frames) reported.set(id, heightOf(el));
    ready = true;
    onHeights?.(new Map(reported));
  })();

  // One `seen` set for the render, so a diagram that repeats in another frame gets its own SVG ids.
  const seen = new Set<string>();
  const requested = new Set<string>();
  let queue: Promise<void> = Promise.resolve();
  const drawDiagrams = (frameIds: Iterable<string>): Promise<void> => {
    const fresh = [...frameIds].filter((id) => frames.has(id) && !requested.has(id));
    for (const id of fresh) requested.add(id);
    const run = queue.then(async () => {
      for (const id of fresh) {
        if (!live) return;
        const el = frames.get(id) as HTMLElement;
        await renderDiagrams(el, stop, { seen });
        if (!live) return;
        // Marked once drawn, as the document view does: a diagram's source is no code block.
        markFocusTargets(el);
      }
    });
    queue = run.catch(() => undefined);
    return run;
  };

  return {
    frames,
    measure: (frameId) => {
      const el = frames.get(frameId);
      return el ? heightOf(el) : null;
    },
    drawDiagrams,
    dispose: () => {
      live = false;
      observer.disconnect();
      if (pending) cancelAnimationFrame(pending);
      pending = 0;
      host.removeEventListener("click", onClick);
      stopClickToLoad();
    },
  };
}
