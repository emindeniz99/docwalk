/**
 * Contract for pen and laser annotation (decision 29). The layer sits over
 * an element (the slide stage, or the diagram focus canvas) and draws
 * ephemeral marks: nothing is saved to the document.
 */

export type AnnotationMode = "off" | "pen" | "laser" | "arrow" | "eraser";

export interface AnnotationLayer {
  setMode(mode: AnnotationMode): void;
  mode(): AnnotationMode;
  /** Pen colour; one of the palette swatches from the design tokens. */
  setColor(color: string): void;
  undo(): void;
  redo(): void;
  clear(): void;
  /**
   * Drawings belong to a slide: switching to another key stores the current
   * drawing and shows the one saved for the new key (empty when none).
   */
  setKey(key: string): void;
  /**
   * Move the overlay, with every slide's marks and undo history, onto a new
   * host: a deck rebuild replaces the stage element mid-talk.
   */
  moveTo(host: HTMLElement): void;
  /** Drop the marks of every key not listed; the current slide's stay until the key changes. */
  retain(keys: Iterable<string>): void;
  destroy(): void;
}

/** Implemented in ./layer.ts as `createAnnotationLayer(host)`. */
export type CreateAnnotationLayer = (host: HTMLElement) => AnnotationLayer;
