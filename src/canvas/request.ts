import { useCallback, useEffect, useState } from "react";

/**
 * How a rendered diagram asks for canvas mode (decision 54). The diagram
 * focus view is plain DOM (src/deck/focus.ts) and must not import React or
 * Excalidraw, so it dispatches this event and the app opens the sketch
 * dialog. This module stays tiny: it is part of the first load, the dialog
 * and Excalidraw are not.
 */
export const OPEN_SKETCH_EVENT = "docwalk:open-sketch";

interface SketchRequest {
  /** The diagram's Mermaid source as the document has it (before the security pre-pass). */
  source: string;
  /** 1-based position among the deck's diagrams, or null when unknown. */
  index: number | null;
}

export function requestSketch(request: SketchRequest): void {
  document.dispatchEvent(new CustomEvent<SketchRequest>(OPEN_SKETCH_EVENT, { detail: request }));
}

/** The sketch the user asked for, or null; `close` clears it. */
export function useSketchRequest(enabled = true): {
  request: SketchRequest | null;
  close: () => void;
} {
  const [request, setRequest] = useState<SketchRequest | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const onRequest = (event: Event) => {
      const detail = (event as CustomEvent<Partial<SketchRequest> | null>).detail;
      if (typeof detail?.source !== "string") return;
      const index = typeof detail.index === "number" ? detail.index : null;
      setRequest({ source: detail.source, index });
    };
    document.addEventListener(OPEN_SKETCH_EVENT, onRequest);
    return () => document.removeEventListener(OPEN_SKETCH_EVENT, onRequest);
  }, [enabled]);
  const close = useCallback(() => setRequest(null), []);
  return { request, close };
}
