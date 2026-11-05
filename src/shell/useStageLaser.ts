import { useEffect, useRef } from "react";
import type { DeckController } from "../deck/controller";

/**
 * Draws a phone remote's laser point on the stage. The dot lives inside
 * `controller.stage()`, the 1280x720 box reveal.js scales, so slide
 * coordinates (0..1) map to the same spot at any window size. React does
 * not own that subtree (decision 27), so the dot is a plain element.
 */
export function useStageLaser(
  controller: DeckController | null,
  point: { x: number; y: number } | null,
): void {
  const dot = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!controller) return;
    const el = document.createElement("div");
    el.className = "docwalk-remote-laser";
    el.hidden = true;
    el.setAttribute("aria-hidden", "true");
    controller.stage().append(el);
    dot.current = el;
    return () => {
      el.remove();
      dot.current = null;
    };
  }, [controller]);

  useEffect(() => {
    const el = dot.current;
    if (!el) return;
    el.hidden = point === null;
    if (point) {
      el.style.left = `${point.x * 100}%`;
      el.style.top = `${point.y * 100}%`;
    }
    // `controller`: a rebuilt deck gets a new dot, which must take the current point at once.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [point, controller]);
}
