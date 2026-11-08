/**
 * Contract for pen and laser annotation (decision 29). The layer sits over
 * an element (the slide stage, or the diagram focus canvas) and draws
 * ephemeral marks: nothing is saved to the document.
 */

import type { MarkColor, MarkEvent } from "./mirrorTypes";

export type AnnotationMode = "off" | "pen" | "laser" | "arrow" | "eraser";

export interface AnnotationLayer {
  setMode(mode: AnnotationMode): void;
  mode(): AnnotationMode;
  /**
   * Pen colour; one of the palette swatches from the design tokens. `key` names
   * the swatch for the mirror (decision 88), which sends the key and never the colour.
   */
  setColor(color: string, key?: MarkColor): void;
  undo(): void;
  redo(): void;
  clear(): void;
  /**
   * Drawings belong to a slide: switching to another key stores the current
   * drawing and shows the one saved for the new key (empty when none).
   */
  setKey(key: string, address?: string): void;
  /**
   * Move the overlay, with every slide's marks and undo history, onto a new
   * host: a deck rebuild replaces the stage element mid-talk.
   */
  moveTo(host: HTMLElement): void;
  /** Drop the marks of every key not listed; the current slide's stay until the key changes. */
  retain(keys: Iterable<string>): void;
  /**
   * Hears the laser, strokes and visible marks in slide units (decision 88).
   * `setKey`'s `address` names the slide in events; it defaults to the key.
   * Returns the function that stops listening.
   */
  observe(listener: (event: MarkEvent) => void): () => void;
  destroy(): void;
}

/** Implemented in ./layer.ts as `createAnnotationLayer(host)`. */
export type CreateAnnotationLayer = (host: HTMLElement) => AnnotationLayer;
