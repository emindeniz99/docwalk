/**
 * Who owns a touch of the slide once a stylus is around (decision 110). No
 * DOM and no import from `types.ts`, so the layer, the present chrome and the
 * tests share one table.
 *
 * A pen (Apple Pencil, Surface Pen, S Pen) draws with no tool chosen. After
 * the first pen of the visit a finger draws nothing and moves no laser: a
 * swipe changes slide and a tap shows or hides the presenting controls (75).
 * Until a pen appears fingers draw as before, and a mouse works as before.
 * With the setting off a pen acts as a mouse.
 */

export type PointerKind = "mouse" | "pen" | "touch";

interface StylusState {
  /** The pen, arrow, shape or eraser tool is chosen (drauu is in a drawing mode). */
  drawingTool: boolean;
  /** The laser is chosen. */
  laser: boolean;
  /** "Stylus draws, fingers change slides" is on. */
  stylusDraws: boolean;
  /** A pen has touched the stage since the page loaded. */
  penInUse: boolean;
}

/**
 * The pointer types the active drauu accepts, for its `acceptsInputTypes`
 * option; `undefined` means all of them. With a drawing tool chosen, the
 * setting on and a pen in use, drauu takes a pen or a mouse and leaves a
 * finger's touch events alone, so they bubble to reveal.js, which swipes.
 * Every other state accepts everything: with no tool the surface takes no
 * pointer anyway, and the laser has handlers of its own.
 */
export function acceptedInput(state: StylusState): readonly string[] | undefined {
  return state.drawingTool && state.stylusDraws && state.penInUse ? ["pen", "mouse"] : undefined;
}

/**
 * Whether a pointer of this type on the slide belongs to the tool, so the
 * present chrome treats it as a stroke or a laser move and not as a tap on
 * the page.
 */
export function slideOwner(state: StylusState & { pointerType: PointerKind }): boolean {
  if (state.stylusDraws) {
    if (state.pointerType === "pen") return true;
    if (state.pointerType === "touch" && state.penInUse) return false;
  }
  return state.drawingTool || state.laser;
}
